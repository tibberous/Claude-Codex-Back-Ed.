"""bridge_runner — the universal engine that runs ANY .bridge plugin.

A `.bridge` file is a zip containing:
    manifest.xml   — declarative metadata + ports + capabilities
    bridge.py      — Python module exposing SPEC + SELECTORS + LOGIN_STRATEGY
                     (+ optional TOOL_CALL_PRIMER and custom_* hooks)
    icon.ico       — Windows tray icon
    icon.png       — panel toolbar icon

This module loads a bridge's source dir (during development) or unpacked
.bridge archive (at runtime) and exposes:

    load_bridge(path)            -> Bridge instance
    Bridge.drive_chat(mini, msg) -> {ok, answer, error?}
    Bridge.is_logged_in(mini)    -> bool
    Bridge.login(mini, email, password) -> {ok, error?}
    Bridge.primer_for_new_conversation() -> str | None

Per-bridge code only needs to declare DATA (selectors, URLs, strategy
strings). The 90% case is zero Python beyond the SPEC dict + SELECTORS
dict. Override hooks exist for sites with non-standard flows (custom
login dance, weird composer mechanics, etc.) — see docs/WRITING_BRIDGES.md.
"""
from __future__ import annotations

import importlib.util
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# --- Manifest parsing --------------------------------------------------------
@dataclass
class BridgeManifest:
    name: str = ""
    display_name: str = ""
    version: str = "0.0.0"
    author: str = ""
    description: str = ""
    homepage: str = ""
    license: str = ""
    kind: str = "web"                # web | api
    home_url: str = ""
    login_url: str = ""
    bridge_port: int = 0             # 0 == auto-assign
    cdp_port: int = 0                # 0 == bridge_port + 1000
    fast_path: bool = False
    aliases: list[str] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    icon: str = "icon.ico"
    icon_png: str = "icon.png"
    capabilities: dict[str, dict[str, str]] = field(default_factory=dict)


def _parse_manifest(xml_text: str) -> BridgeManifest:
    """Parse a manifest.xml string into a BridgeManifest. Robust to
    missing fields — undeclared elements just leave their default."""
    root = ET.fromstring(xml_text)
    m = BridgeManifest()
    text = lambda tag, default="": (root.findtext(tag) or default).strip()
    m.name         = text("name")
    m.display_name = text("displayName", m.name)
    m.version      = text("version", "0.0.0")
    m.author       = text("author")
    m.description  = text("description")
    m.homepage     = text("homepage")
    m.license      = text("license")
    m.kind         = text("kind", "web")
    m.home_url     = text("homeUrl")
    m.login_url    = text("loginUrl")
    try:
        m.bridge_port = int(text("bridgePort", "0") or 0)
    except ValueError:
        m.bridge_port = 0
    try:
        m.cdp_port = int(text("cdpPort", "0") or 0)
    except ValueError:
        m.cdp_port = 0
    m.fast_path = text("fastPath", "false").lower() in ("true", "1", "yes")
    m.icon      = text("icon", "icon.ico")
    m.icon_png  = text("iconPng", "icon.png")

    aliases_el = root.find("aliases")
    if aliases_el is not None:
        m.aliases = [(a.text or "").strip() for a in aliases_el.findall("alias") if (a.text or "").strip()]

    models_el = root.find("models")
    if models_el is not None:
        m.models = [(m_el.text or "").strip() for m_el in models_el.findall("model") if (m_el.text or "").strip()]

    caps_el = root.find("capabilities")
    if caps_el is not None:
        for cap in caps_el:
            attrs = dict(cap.attrib)
            m.capabilities[cap.tag] = attrs

    return m


# --- Bridge loader -----------------------------------------------------------
class Bridge:
    """Loaded plugin. Wraps manifest + bridge.py module + icon paths."""

    def __init__(self, manifest: BridgeManifest, module, root_path: Path):
        self.manifest = manifest
        self.module = module
        self.root = root_path
        # Pull declared spec fields with sensible defaults.
        self.spec = getattr(module, "SPEC", {}) or {}
        self.selectors = getattr(module, "SELECTORS", {}) or {}
        self.login_strategy = getattr(module, "LOGIN_STRATEGY", "") or ""
        self.tool_call_primer = getattr(module, "TOOL_CALL_PRIMER", None)

    # Capability convenience -----------------------------------------------
    def supports(self, cap: str) -> bool:
        """Did this bridge declare support for `cap`?

        Checks the manifest's <capabilities> block first, then falls back
        to a `capabilities` dict on the SPEC if the bridge.py exposes one
        (older bridges that pre-date the manifest format)."""
        v = self.manifest.capabilities.get(cap)
        if v is not None:
            return v.get("supported", "false").lower() in ("true", "1", "yes")
        spec_caps = self.spec.get("capabilities") or {}
        return bool(spec_caps.get(cap, False))

    # --- Logged-in check --------------------------------------------------
    def is_logged_in(self, mini) -> bool:
        """Override path: custom_isLoggedIn(mini). Default: check the
        manifest's logged_in_check selector for a visible element."""
        custom = getattr(self.module, "custom_isLoggedIn", None)
        if callable(custom):
            try:
                return bool(custom(mini))
            except Exception:
                return False
        sel = self.selectors.get("logged_in_check") or self.selectors.get("composer")
        if not sel:
            return False
        if isinstance(sel, list):
            return any(self._first_visible(mini, [s]) for s in sel)
        return self._first_visible(mini, [sel]) is not None

    # --- Login ------------------------------------------------------------
    def login(self, mini, email: str, password: str, timeout_s: int = 30) -> dict:
        """Override path: custom_login(mini, email, password). Default:
        navigate to login_url, type email, click submit, type password,
        click submit, wait for composer to appear."""
        custom = getattr(self.module, "custom_login", None)
        if callable(custom):
            try:
                return custom(mini, email, password) or {"ok": True}
            except Exception as e:
                return {"ok": False, "error": f"custom_login crashed: {type(e).__name__}: {e}"}
        if self.is_logged_in(mini):
            return {"ok": True, "skipped": "already logged in"}
        if not self.manifest.login_url:
            return {"ok": False, "error": "bridge declared no loginUrl"}
        mini.navigate(self.manifest.login_url)
        deadline = time.time() + timeout_s

        email_sel = self._wait_for(mini, self.selectors.get("login_email"), deadline)
        if not email_sel:
            return {"ok": False, "error": "login_email field not found within timeout"}
        self._set_input_value(mini, email_sel, email)
        time.sleep(0.3)
        self._click(mini, self.selectors.get("login_submit"))

        pw_sel = self._wait_for(mini, self.selectors.get("login_password"), deadline)
        if not pw_sel:
            return {"ok": False, "error": "login_password not found — magic-link / 2FA?"}
        self._set_input_value(mini, pw_sel, password)
        time.sleep(0.3)
        self._click(mini, self.selectors.get("login_submit"))

        while time.time() < deadline:
            if self.is_logged_in(mini):
                return {"ok": True}
            time.sleep(0.5)
        return {"ok": False, "error": "post-login composer never appeared (CAPTCHA / 2FA?) - "
                "sign in once by hand: python tools/sign_in_helper.py <target> "
                "(stop the target's tray exe first so it doesn't lock the profile)"}

    # --- Send chat --------------------------------------------------------
    def send_chat(self, mini, message: str, timeout_s: int = 90) -> dict:
        """Override path: custom_sendChat(mini, message). Default:
        focus composer, Input.insertText the message, click send button,
        poll assistant DOM for the new reply, return text."""
        custom = getattr(self.module, "custom_sendChat", None)
        if callable(custom):
            try:
                return custom(mini, message) or {"ok": False, "error": "custom_sendChat returned None"}
            except Exception as e:
                return {"ok": False, "error": f"custom_sendChat crashed: {type(e).__name__}: {e}"}

        composer_sel = self._first_visible(mini, self._as_list(self.selectors.get("composer")))
        if not composer_sel:
            return {"ok": False, "error": "composer not found — logged out? selectors stale?",
                    "final_url": mini.final_url()}

        assistant_sel = self.selectors.get("assistant_msg") or '[data-message-author-role="assistant"]'
        before = int(self._eval(mini,
            f"document.querySelectorAll('{assistant_sel}').length") or 0)

        self._eval(mini, f"document.querySelector('{composer_sel}').focus();")
        time.sleep(0.2)
        mini.type_text(message)
        time.sleep(0.3)
        if not self._click(mini, self.selectors.get("send_button")):
            mini.press_key("enter")

        deadline = time.time() + timeout_s
        last_text, stable = "", 0
        while time.time() < deadline:
            try:
                after = int(self._eval(mini,
                    f"document.querySelectorAll('{assistant_sel}').length") or 0)
                if after > before:
                    txt_js = (
                        "(function(){var els=document.querySelectorAll('"
                        + assistant_sel.replace("'", "\\'")
                        + "');if(!els.length)return '';"
                        + "var l=els[els.length-1];"
                        + "return (l.innerText||l.textContent||'').trim();})()"
                    )
                    txt = str(self._eval(mini, txt_js) or "").strip()
                    if txt and txt == last_text:
                        stable += 1
                        if stable >= 2:
                            return {"ok": True, "answer": txt, "final_url": mini.final_url()}
                    else:
                        stable = 0
                    last_text = txt
            except Exception:
                pass
            time.sleep(1.0)
        if last_text:
            return {"ok": True, "answer": last_text, "final_url": mini.final_url(),
                    "warn": "reply still streaming at timeout"}
        return {"ok": False, "error": "no assistant reply within timeout",
                "final_url": mini.final_url()}

    # --- End-to-end -------------------------------------------------------
    def drive_chat(self, mini, message: str, email: str = "", password: str = "") -> dict:
        """One-shot end-to-end: ensure logged in, then send. Highest-level
        override: custom_driveChat — bypasses the runner entirely."""
        custom = getattr(self.module, "custom_driveChat", None)
        if callable(custom):
            try:
                return custom(mini, message, email, password)
            except Exception as e:
                return {"ok": False, "error": f"custom_driveChat crashed: {type(e).__name__}: {e}"}
        if not self.is_logged_in(mini):
            if not (email and password):
                return {"ok": False, "error": "logged out and no creds provided; "
                        "run tools/sign_in_helper.py for this bridge first."}
            r = self.login(mini, email, password)
            if not r.get("ok"):
                return r
        return self.send_chat(mini, message)

    # --- Async-job flow (videoGen, imageGen, audioGen, fileReceive) -----
    def drive_async_job(self, mini, prompt: str, *,
                        reference_files: list[str] | None = None,
                        poll_interval_s: float = 10.0,
                        poll_max_s: int = 600,
                        output_root=None) -> dict:
        """End-to-end async job: submit prompt → poll until done → download
        the asset to <output_root>/<bridge-name>/<timestamp>_<slug>.<ext>.

        Bridges with `videoGen`, `imageGen`, or `audioGen` capability MUST
        implement custom_submitJob + custom_pollJob hooks. The runner
        handles the polling loop, asset download, and disk save.

        Returns:
            {ok, local_path, original_url, duration_s, jobId}
        """
        from pathlib import Path as _P
        import time as _t, re as _re, urllib.request as _ur

        submit = getattr(self.module, "custom_submitJob", None)
        poll = getattr(self.module, "custom_pollJob", None)
        if not callable(submit) or not callable(poll):
            return {"ok": False, "error": "bridge declared async capability but "
                    "didn't define custom_submitJob/custom_pollJob"}

        t0 = _t.time()
        sub = submit(mini, prompt, reference_files or []) or {}
        if not sub.get("ok"):
            return sub
        job_id = sub.get("jobId")
        if not job_id:
            return {"ok": False, "error": "submitJob returned no jobId"}

        deadline = t0 + poll_max_s
        result = None
        while _t.time() < deadline:
            r = poll(mini, job_id) or {}
            if r.get("done"):
                if r.get("error"):
                    return {"ok": False, "error": r["error"], "jobId": job_id,
                            "duration_s": _t.time() - t0}
                if r.get("url"):
                    result = r
                    break
            _t.sleep(poll_interval_s)
        if not result:
            return {"ok": False, "error": f"job didn't complete within {poll_max_s}s",
                    "jobId": job_id, "duration_s": _t.time() - t0}

        # Pick output dir by which media capability is declared.
        out_subdir = self._asset_subdir()
        if output_root is None:
            output_root = _P(self.root).resolve().parents[2]  # repo root
        out_dir = _P(output_root) / out_subdir / self.manifest.name
        out_dir.mkdir(parents=True, exist_ok=True)

        # Slug the prompt for a human-readable filename
        stamp = _t.strftime("%Y%m%d-%H%M%S")
        slug = _re.sub(r"[^A-Za-z0-9]+", "_", prompt.lower()).strip("_")[:60] or "asset"
        url = result["url"]
        ext = self._guess_ext(url, out_subdir)
        out_path = out_dir / f"{stamp}_{slug}.{ext}"
        try:
            with _ur.urlopen(url, timeout=120) as resp, open(out_path, "wb") as f:
                f.write(resp.read())
        except Exception as e:
            return {"ok": False, "error": f"download failed: {type(e).__name__}: {e}",
                    "original_url": url, "jobId": job_id,
                    "duration_s": _t.time() - t0}
        return {
            "ok": True,
            "local_path": str(out_path),
            "original_url": url,
            "duration_s": round(_t.time() - t0, 1),
            "jobId": job_id,
        }

    def _asset_subdir(self) -> str:
        """Pick the top-level output dir based on which media capability
        the bridge declares: video → videos, image → images, audio → audio.
        Defaults to 'videos' for unknown async-asset bridges."""
        if self.supports("videoGen"):
            return "videos"
        if self.supports("imageGen"):
            return "images"
        if self.supports("audioGen"):
            return "audio"
        return "videos"

    @staticmethod
    def _guess_ext(url: str, kind: str) -> str:
        """Best-effort file extension from URL. Falls back to a sensible
        default per media kind."""
        import re as _re
        m = _re.search(r"\.([a-zA-Z0-9]{2,5})(?:\?|$)", url)
        if m:
            return m.group(1).lower()
        defaults = {"videos": "mp4", "images": "png", "audio": "mp3"}
        return defaults.get(kind, "bin")

    def primer_for_new_conversation(self) -> str:
        """The startup system-prompt teaching this bridge's tool-call
        convention. Returned if the bridge declared toolCalls supported
        AND set TOOL_CALL_PRIMER; else empty string. The caller is
        responsible for sending this once per fresh conversation."""
        if not self.supports("toolCalls"):
            return ""
        return self.tool_call_primer or ""

    # --- Internals (JS helpers) -------------------------------------------
    @staticmethod
    def _as_list(v) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            return [v]
        return list(v)

    def _eval(self, mini, js: str):
        try:
            return mini.eval_js(js)
        except Exception:
            return None

    def _first_visible(self, mini, selectors: list[str]) -> str | None:
        if not selectors:
            return None
        js = """(function(){
            var sels = %s;
            for (var i=0;i<sels.length;i++) {
                try {
                    var el = document.querySelector(sels[i]);
                    if (!el) continue;
                    var r = el.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) continue;
                    var st = window.getComputedStyle(el);
                    if (st.display === 'none' || st.visibility === 'hidden') continue;
                    return sels[i];
                } catch(e) { continue; }
            }
            return null;
        })()""" % (selectors,)
        return self._eval(mini, js)

    def _wait_for(self, mini, selector, deadline: float) -> str | None:
        if not selector:
            return None
        sels = self._as_list(selector)
        while time.time() < deadline:
            hit = self._first_visible(mini, sels)
            if hit:
                return hit
            time.sleep(0.5)
        return None

    def _set_input_value(self, mini, selector: str, value: str):
        safe = value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        js = f"""(function(){{
            var el = document.querySelector('{selector}');
            if (!el) return 'no-element';
            try {{ el.focus(); }} catch(e) {{}}
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                var proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, '{safe}');
                el.dispatchEvent(new Event('input', {{bubbles: true}}));
                el.dispatchEvent(new Event('change', {{bubbles: true}}));
            }} else {{
                el.textContent = '{safe}';
                el.dispatchEvent(new InputEvent('input', {{bubbles: true, data: '{safe}'}}));
            }}
            return 'ok';
        }})()"""
        return self._eval(mini, js)

    def _click(self, mini, selector) -> bool:
        """Click the first visible element matching any selector.

        Polls up to ~1 second waiting for the button to become enabled —
        chatgpt and other React-based sites briefly mark the send button
        `disabled=true` while their state updates after the user types,
        and an early "skip if disabled" check meant we'd silently miss
        the click. If it's still disabled after the poll, click anyway —
        the browser will queue the click for when it enables, OR the
        click hits a non-button element where `disabled` is meaningless.
        """
        sels = self._as_list(selector)
        if not sels:
            return False
        sel = self._first_visible(mini, sels)
        if not sel:
            return False
        # Brief poll for "not disabled" — React usually enables in <500ms.
        import time as _t
        deadline = _t.time() + 1.0
        while _t.time() < deadline:
            is_disabled = bool(self._eval(mini, f"""(function(){{
                var el = document.querySelector('{sel}');
                return !!(el && el.disabled);
            }})()"""))
            if not is_disabled:
                break
            _t.sleep(0.1)
        js = f"""(function(){{
            var el = document.querySelector('{sel}');
            if (!el) return false;
            el.click();
            return true;
        }})()"""
        return bool(self._eval(mini, js))


# --- Plugin loaders ----------------------------------------------------------
def _load_module_from_path(name: str, py_path: Path):
    spec = importlib.util.spec_from_file_location(f"cbe_bridges.{name}", py_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"can't import {py_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"cbe_bridges.{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


def load_bridge_from_dir(src_dir: Path) -> Bridge:
    """Load a bridge from an UNPACKED source directory (e.g. during
    development from bridges/_src/<name>/). Looks for manifest.xml +
    bridge.py at the root."""
    src_dir = Path(src_dir)
    manifest_path = src_dir / "manifest.xml"
    bridge_path = src_dir / "bridge.py"
    if not manifest_path.exists() or not bridge_path.exists():
        raise FileNotFoundError(f"bridge dir missing manifest.xml or bridge.py: {src_dir}")
    manifest = _parse_manifest(manifest_path.read_text(encoding="utf-8"))
    module = _load_module_from_path(manifest.name or src_dir.name, bridge_path)
    return Bridge(manifest, module, src_dir)


def load_bridge_from_archive(zip_path: Path, extract_to: Path | None = None) -> Bridge:
    """Load a .bridge zip. Extracts into `extract_to` (or sibling dir)."""
    zip_path = Path(zip_path)
    if extract_to is None:
        extract_to = zip_path.parent / f".unpacked_{zip_path.stem}"
    extract_to.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(extract_to)
    return load_bridge_from_dir(extract_to)


def pack_bridge(src_dir: Path, out_path: Path | None = None) -> Path:
    """Pack a bridges/_src/<name>/ directory into bridges/<name>.bridge zip."""
    src_dir = Path(src_dir)
    if not src_dir.is_dir():
        raise NotADirectoryError(src_dir)
    name = src_dir.name
    if out_path is None:
        out_path = src_dir.parent.parent / f"{name}.bridge"
    out_path = Path(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src_dir.rglob("*"):
            if f.is_file() and "__pycache__" not in f.parts:
                zf.write(f, f.relative_to(src_dir))
    return out_path


def discover_bridges(bridges_dir: Path) -> dict[str, Bridge]:
    """Scan `bridges/` for both .bridge archives AND `_src/<name>/`
    development dirs. Returns {name: Bridge}.

    Order of resolution: if both a .bridge AND a _src/ exist for the
    same name, the _src/ wins (live editing during development)."""
    bridges_dir = Path(bridges_dir)
    out: dict[str, Bridge] = {}
    archives = list(bridges_dir.glob("*.bridge"))
    for arc in archives:
        try:
            b = load_bridge_from_archive(arc)
            out[b.manifest.name] = b
        except Exception as e:
            print(f"[bridge_runner] failed to load {arc}: {e}", file=sys.stderr)
    src_root = bridges_dir / "_src"
    if src_root.is_dir():
        for sub in src_root.iterdir():
            if sub.is_dir() and (sub / "manifest.xml").exists():
                try:
                    b = load_bridge_from_dir(sub)
                    out[b.manifest.name] = b   # _src overrides archive
                except Exception as e:
                    print(f"[bridge_runner] failed to load {sub}: {e}", file=sys.stderr)
    return out
