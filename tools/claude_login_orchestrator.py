#!/usr/bin/env python3
"""claude_login_orchestrator.py — vision-pilot claude.ai login for every
account in the user's roster, persisting cookies into per-account
QtWebEngine profile dirs under `bridge_profiles/claude/<slug>/`.

End goal: subsequent CBE bridge launches that point at one of those
profile dirs come up already signed in, so the user never has to
manually rotate accounts again. This script implements the v1 cut:

    for each account:
        spawn nn4_agent_browser pointed at bridge_profiles/claude/<slug>/
        navigate to claude.ai/login
        loop:  screenshot -> GPT-4o (vision) -> {click,type,wait,done}
        if "magic link sent" page:  IMAP-poll inbox for the link
        navigate the SAME view to the magic link
        confirm logged-in via one more vision check
        write .last-login marker (timestamp + cookie names)
        tear down the harness

Pieces reused (do NOT reimplement):
  - tools/nn4_agent_browser.py      — the QtWebEngine harness (NN4_PROFILE_DIR env)
  - tools/imap_read.py              — magic-link IMAP polling
  - hooks/chatgtp_hook.py vision()  — pattern only; we hit the same
                                      /v1/responses endpoint inline to
                                      avoid pulling trio_hook_orm here

Output: one JSON object per line on stdout (newline-delimited, so the
extension.js host can stream the progress straight into the panel).

  {"event":"account_start","email":"...","slug":"...","ts":"..."}
  {"event":"step","email":"...","step":"navigate","ok":true}
  {"event":"vision","email":"...","action":"click","selector":"...","reason":"..."}
  {"event":"imap","email":"...","status":"polling","attempt":3}
  {"event":"account_done","email":"...","ok":true,"durationSeconds":12.3}
  {"event":"summary","ok":N,"fail":M,"skipped":K,"durationSeconds":...}

Usage:
  py -3 tools/claude_login_orchestrator.py [--only EMAIL] [--dry-run]
      [--profile-root DIR] [--openai-key sk-...]
      [--account ACCOUNT_JSON ...]

If --account is not passed, the orchestrator reads the same address
list extension.js owns (ALL_GMAILS + EXTRA_CLAUDE_EMAILS) from a
companion JSON file: tools/claude_accounts.json. The host extension
materialises that file at startup (so we don't have to parse JS here).

Constraints:
- Only accounts with a real app password in EMAIL_APP_PASSWORDS can
  complete the magic-link step. Others get skipped with a clear reason.
- v1: serial, one account at a time. Concurrent logins would race the
  same OpenAI Responses endpoint and double the cost — not worth it.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import urllib.request
import urllib.error

REPO_ROOT      = Path(__file__).resolve().parent.parent
NN4_SCRIPT     = REPO_ROOT / "tools" / "nn4_agent_browser.py"
IMAP_READ      = REPO_ROOT / "tools" / "imap_read.py"
ACCOUNTS_JSON  = REPO_ROOT / "tools" / "claude_accounts.json"
CONFIG_INI     = REPO_ROOT / "config.ini"
DEFAULT_PROFILE_ROOT = REPO_ROOT / "bridge_profiles" / "claude"
DEBUG_DIR      = REPO_ROOT / "logs" / "claude_login_debug"

NN4_BASE_PORT  = 9785  # action port; devtools = port+1
LOGIN_URL      = "https://claude.ai/login"
MAX_VISION_ITERS  = 8
LOAD_SETTLE_MS    = 1500
IMAP_POLL_S       = 5
IMAP_TIMEOUT_S    = 60

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
OPENAI_MODEL         = os.environ.get("CHATGTP_DEFAULT_MODEL", "gpt-4o")

# Magic-link regex — claude.ai sends a Login Code style URL; orchestrator
# accepts both /magic-link and /sign-in-code paths to be future-proof.
MAGIC_LINK_RX = r"https://claude\.ai/(?:magic-link|sign-in-code)\S*"


# ─── tiny helpers ──────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def _emit(event: str, **fields) -> None:
    """Stream a single JSON event to stdout. Host parses these line-by-line."""
    payload = {"event": event, "ts": _now_iso()}
    payload.update(fields)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _slugify(email: str) -> str:
    """trenttompkins@gmail.com -> trenttompkins-at-gmail. Keeps it path-safe
    and human-readable so the user can spot the right profile dir."""
    s = email.lower().strip()
    s = s.replace("@", "-at-")
    # drop the TLD; we keep the provider name (gmail / yahoo / hotmail)
    s = re.sub(r"\.com$", "", s)
    s = re.sub(r"[^a-z0-9._-]+", "-", s).strip("-")
    return s or hashlib.md5(email.encode("utf-8")).hexdigest()[:12]


def _provider_for(email: str) -> Optional[str]:
    """Map an address to imap_read.py's --provider value. None means we can't
    poll this inbox (e.g. exotic domain) — caller will skip step 7."""
    dom = (email.split("@", 1)[-1] or "").lower()
    if dom == "gmail.com":         return "gmail"
    if dom == "yahoo.com":         return "yahoo"
    if dom in ("hotmail.com", "outlook.com", "live.com"): return "outlook"
    # Google Workspace domains route through gmail's IMAP, but we can only
    # know that from outside data. The host passes provider explicitly when
    # it has a workspace-domain hint; default to gmail here as the safest.
    if dom == "acquisitioninvest.com": return "gmail"
    return None


def _read_openai_key(cli_value: str = "") -> str:
    """Resolve the OpenAI key: --openai-key > env > config.ini [openai_api_key].
    config.ini has a flat top-level [DEFAULT]-ish layout in this project, so
    we parse it manually rather than pulling configparser semantics."""
    if cli_value:
        return cli_value.strip()
    for env_name in ("OPENAI_API_KEY", "OPENAI_KEY", "API_KEY"):
        v = os.environ.get(env_name, "").strip()
        if v:
            return v
    try:
        if CONFIG_INI.is_file():
            for line in CONFIG_INI.read_text(encoding="utf-8", errors="replace").splitlines():
                m = re.match(r"^\s*openai_api_key\s*=\s*(\S+)\s*$", line)
                if m:
                    return m.group(1).strip()
    except Exception:
        pass
    return ""


def _read_accounts(only: str, account_args: list[str]) -> list[dict]:
    """Build the account roster. --account ACCOUNT_JSON wins; else read
    tools/claude_accounts.json shipped by the host. Each row needs:
      { email, provider, label?, imap_password_env?, imap_password? }
    """
    rows: list[dict] = []
    if account_args:
        for raw in account_args:
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict) and obj.get("email"):
                    rows.append(obj)
            except Exception as exc:
                _emit("warn", message=f"--account JSON parse failed: {exc}")
    elif ACCOUNTS_JSON.is_file():
        try:
            data = json.loads(ACCOUNTS_JSON.read_text(encoding="utf-8"))
            if isinstance(data, list):
                rows = [r for r in data if isinstance(r, dict) and r.get("email")]
        except Exception as exc:
            _emit("warn", message=f"claude_accounts.json parse failed: {exc}")
    if only:
        only_lc = only.lower().strip()
        rows = [r for r in rows if str(r.get("email", "")).lower() == only_lc]
    return rows


# ─── nn4_agent_browser RPC ────────────────────────────────────────────

class Nn4Client:
    """Newline-JSON client to nn4_agent_browser. One process per account."""

    def __init__(self, profile_dir: Path, port: int, devtools_port: int) -> None:
        self.profile_dir = profile_dir
        self.port = port
        self.devtools_port = devtools_port
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["NN4_PROFILE_DIR"]            = str(self.profile_dir)
        env["NN4_AGENT_DEVTOOLS_PORT"]    = str(self.devtools_port)
        env["QTWEBENGINE_REMOTE_DEBUGGING"] = str(self.devtools_port)
        cmd = [sys.executable, str(NN4_SCRIPT),
               "--port", str(self.port),
               "--devtools-port", str(self.devtools_port),
               "--start-url", "about:blank"]
        # Inherit stdout/stderr so the agent logs interleave with ours — useful
        # when debugging "page wouldn't load" symptoms.
        self.proc = subprocess.Popen(cmd, env=env,
                                     stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        # Wait for the action port to accept connections (up to 25 s — Qt+
        # Chromium boot is slow on Windows).
        deadline = time.time() + 25.0
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=1.0):
                    return
            except OSError:
                time.sleep(0.3)
        raise RuntimeError(f"nn4_agent_browser did not bind 127.0.0.1:{self.port} within 25s")

    def call(self, action: dict, timeout_s: float = 60.0) -> dict:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout_s)
        try:
            sock.connect(("127.0.0.1", self.port))
            sock.sendall((json.dumps(action) + "\n").encode("utf-8"))
            buf = b""
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buf += chunk
                if b"\n" in buf:
                    break
            line = buf.split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
            if not line:
                return {"ok": False, "error": "empty response"}
            try:
                return json.loads(line)
            except json.JSONDecodeError as e:
                return {"ok": False, "error": f"bad JSON: {e}"}
        except (OSError, socket.timeout) as e:
            return {"ok": False, "error": f"connect/send failed: {type(e).__name__}: {e}"}
        finally:
            try: sock.close()
            except Exception: pass

    def shutdown(self) -> None:
        try:
            self.call({"action": "shutdown"}, timeout_s=5.0)
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                try: self.proc.wait(timeout=5.0)
                except Exception:
                    self.proc.kill()
            except Exception:
                pass


# ─── OpenAI vision call ────────────────────────────────────────────────

VISION_SYSTEM = """\
You are driving a browser through claude.ai/login on behalf of the user.
You receive a screenshot. Output ONE next action as a single JSON object
on a single line, no prose, no code fences. Schema:

  {"action":"type","selector":"<CSS>","text":"<TEXT>","reason":"..."}
  {"action":"click","selector":"<CSS>","reason":"..."}
  {"action":"wait","reason":"..."}
  {"action":"done","reason":"logged in"}
  {"action":"magic_link_sent","reason":"check email page"}

Selectors must be plain valid CSS. Prefer stable selectors (input[name=email],
button[type=submit], button:has-text("Continue")). The page may show a Google
SSO button — DO NOT use Google SSO; we need the email/password OR magic-link
flow. The user email is provided. If the page already shows the chats UI
(side panel of conversations or a "New chat" button), output `done`.
If the page says "Check your email" or shows a code/link sent confirmation,
output `magic_link_sent`. Never output anything besides the JSON object.
"""


def _vision_decide(png_path: Path, email: str, openai_key: str) -> dict:
    """Send the PNG + a prompt to OpenAI Responses API. Returns the parsed
    action dict, or {action:'wait', reason:'<error>'} on any failure."""
    try:
        b64 = base64.b64encode(png_path.read_bytes()).decode("ascii")
    except Exception as exc:
        return {"action": "wait", "reason": f"screenshot read failed: {exc}"}
    prompt = (f"User email: {email}\n"
              f"Decide the single next action to advance the claude.ai login. "
              f"Output only the JSON object described in the system prompt.")
    payload = {
        "model": OPENAI_MODEL,
        "instructions": VISION_SYSTEM,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text",  "text": prompt},
                {"type": "input_image", "image_url": f"data:image/png;base64,{b64}"},
            ],
        }],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {openai_key}",
            "Content-Type":  "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        try: detail = e.read().decode("utf-8", errors="replace")[:400]
        except Exception: detail = ""
        return {"action": "wait", "reason": f"openai http {e.code}: {detail}"}
    except Exception as exc:
        return {"action": "wait", "reason": f"openai call failed: {exc}"}
    # Extract text — mirror chatgtp_hook._extract_text logic.
    texts: list[str] = []
    try:
        for item in data.get("output", []) or []:
            if item.get("type") != "message": continue
            for part in item.get("content", []) or []:
                if part.get("type") in ("output_text", "text"):
                    t = part.get("text") or ""
                    if t: texts.append(t)
    except Exception: pass
    raw = ("\n".join(texts).strip()
           or (data.get("choices", [{}])[0].get("message", {}).get("content") or ""))
    # Strip code fences if the model adds them anyway.
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S).strip()
    try:
        action = json.loads(raw)
        if not isinstance(action, dict) or "action" not in action:
            return {"action": "wait", "reason": f"bad model output: {raw[:200]}"}
        return action
    except Exception as exc:
        return {"action": "wait", "reason": f"model output not JSON ({exc}): {raw[:200]}"}


# ─── per-account flow ──────────────────────────────────────────────────

def _save_screenshot(client: Nn4Client, slug: str, iter_n: int) -> Optional[Path]:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    res = client.call({"action": "screenshot"}, timeout_s=20.0)
    if not res.get("ok") or not res.get("png_b64"):
        return None
    p = DEBUG_DIR / f"{slug}_{iter_n:02d}.png"
    try:
        p.write_bytes(base64.b64decode(res["png_b64"]))
        return p
    except Exception:
        return None


def _apply_action(client: Nn4Client, action: dict) -> dict:
    """Translate a vision action into nn4 RPC calls. nn4 supports
    click/type by raw coordinates, but the vision model returns CSS
    selectors — so we eval_js to focus+fill+click in one shot, which
    is more robust than measuring viewport pixels from the screenshot."""
    kind = str(action.get("action", "")).lower()
    if kind == "click":
        sel = str(action.get("selector", ""))
        if not sel:
            return {"ok": False, "error": "click without selector"}
        js = (
            "(function(){"
            f"var el=document.querySelector({json.dumps(sel)});"
            "if(!el)return{ok:false,err:'selector miss'};"
            "el.scrollIntoView({block:'center'});"
            "el.click();"
            "return{ok:true};"
            "})()"
        )
        return client.call({"action": "eval_js", "js": js}, timeout_s=20.0)
    if kind == "type":
        sel  = str(action.get("selector", ""))
        text = str(action.get("text", ""))
        if not sel:
            return {"ok": False, "error": "type without selector"}
        js = (
            "(function(){"
            f"var el=document.querySelector({json.dumps(sel)});"
            "if(!el)return{ok:false,err:'selector miss'};"
            "el.focus();"
            f"el.value={json.dumps(text)};"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));"
            "return{ok:true};"
            "})()"
        )
        return client.call({"action": "eval_js", "js": js}, timeout_s=20.0)
    if kind in ("wait", "magic_link_sent", "done"):
        return {"ok": True, "noop": True}
    return {"ok": False, "error": f"unknown action {kind!r}"}


def _poll_imap_for_link(account: dict, since_minutes: int = 5) -> Optional[str]:
    """Spawn imap_read.py in a poll loop. Returns the first matching link or
    None on timeout. Account row must carry `imap_password_env` OR
    `imap_password`. Surfaces progress via _emit('imap', ...)."""
    pw_env  = account.get("imap_password_env", "")
    pw_lit  = account.get("imap_password", "")
    provider = account.get("provider") or _provider_for(account["email"])
    if not provider:
        return None
    if not (pw_env or pw_lit):
        return None
    cmd = [sys.executable, str(IMAP_READ),
           "--provider", provider,
           "--email", account["email"],
           "--since-minutes", str(since_minutes),
           "--from-filter", "anthropic.com",
           "--extract-links", MAGIC_LINK_RX,
           "--max", "5"]
    if pw_env: cmd += ["--password-env", pw_env]
    else:      cmd += ["--password", pw_lit]
    start = time.monotonic()
    attempt = 0
    while time.monotonic() - start < IMAP_TIMEOUT_S:
        attempt += 1
        _emit("imap", email=account["email"], status="polling", attempt=attempt)
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            _emit("imap", email=account["email"], status="timeout"); break
        if proc.returncode not in (0, 2):
            _emit("imap", email=account["email"], status="error",
                  detail=(proc.stderr or proc.stdout or "")[:300])
            return None
        last_line = (proc.stdout or "").strip().split("\n")[-1] or "{}"
        try: data = json.loads(last_line)
        except Exception: data = {}
        for em in data.get("emails", []) or []:
            for link in em.get("links") or []:
                _emit("imap", email=account["email"], status="hit", link=link)
                return link
        time.sleep(IMAP_POLL_S)
    _emit("imap", email=account["email"], status="give-up")
    return None


def _write_marker(profile_dir: Path, email: str, success: bool,
                  cookie_names: list[str], reason: str = "") -> None:
    marker = profile_dir / ".last-login"
    payload = {
        "email":       email,
        "ts":          _now_iso(),
        "ok":          bool(success),
        "cookieNames": sorted(set(cookie_names or [])),
        "reason":      reason,
    }
    try:
        marker.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass


def _list_cookie_names(client: Nn4Client) -> list[str]:
    res = client.call({"action": "eval_js",
                       "js": "document.cookie.split(';').map(s=>s.trim().split('=')[0]).filter(Boolean)"},
                      timeout_s=10.0)
    val = res.get("result")
    if isinstance(val, list):
        return [str(v) for v in val if v]
    if isinstance(val, str):
        return [v for v in val.split(",") if v]
    return []


def _looks_logged_in(url: str) -> bool:
    """Best-effort URL check before bothering ChatGPT with another vision call."""
    if not url: return False
    if "/login" in url or "/magic-link" in url or "/sign-in" in url: return False
    return "claude.ai" in url


def login_one(account: dict, profile_root: Path, openai_key: str,
              port: int, dry_run: bool) -> dict:
    email = str(account["email"])
    slug  = _slugify(email)
    profile_dir = profile_root / slug
    _emit("account_start", email=email, slug=slug, profileDir=str(profile_dir))
    t0 = time.monotonic()

    if dry_run:
        plan = [
            {"step": "spawn_nn4",   "profile_dir": str(profile_dir), "port": port},
            {"step": "navigate",    "url": LOGIN_URL},
            {"step": "vision_loop", "max_iters": MAX_VISION_ITERS},
            {"step": "imap_poll",   "provider": _provider_for(email),
             "has_password": bool(account.get("imap_password_env") or account.get("imap_password"))},
            {"step": "navigate_magic_link"},
            {"step": "confirm_logged_in_via_vision"},
            {"step": "write_marker", "path": str(profile_dir / ".last-login")},
        ]
        _emit("dry_run_plan", email=email, plan=plan)
        _emit("account_done", email=email, ok=True, dryRun=True,
              durationSeconds=round(time.monotonic() - t0, 2))
        return {"ok": True, "email": email, "dryRun": True}

    if not openai_key:
        _emit("account_done", email=email, ok=False, step="config",
              reason="OPENAI_API_KEY not set (--openai-key or config.ini)")
        return {"ok": False, "email": email, "reason": "no openai key"}

    client = Nn4Client(profile_dir, port=port, devtools_port=port + 1)
    try:
        client.start()
        _emit("step", email=email, step="spawn_nn4", ok=True)
        r = client.call({"action": "navigate", "url": LOGIN_URL, "waitMs": 12000}, timeout_s=30.0)
        _emit("step", email=email, step="navigate", ok=bool(r.get("ok")), url=r.get("url"))
        client.call({"action": "wait", "ms": LOAD_SETTLE_MS}, timeout_s=5.0)

        magic_link_phase = False
        for it in range(MAX_VISION_ITERS):
            url_res = client.call({"action": "page_url"}, timeout_s=5.0)
            url     = str((url_res or {}).get("url") or "")
            if _looks_logged_in(url):
                _emit("vision", email=email, action="early-done", reason=f"url={url}")
                break
            png = _save_screenshot(client, slug, it)
            if not png:
                _emit("step", email=email, step="screenshot", ok=False, iter=it); break
            action = _vision_decide(png, email, openai_key)
            _emit("vision", email=email, iter=it, **action)
            kind = str(action.get("action", "")).lower()
            if kind == "done":
                break
            if kind == "magic_link_sent":
                magic_link_phase = True
                break
            applied = _apply_action(client, action)
            _emit("step", email=email, step="apply", iter=it, kind=kind,
                  ok=bool(applied.get("ok")), detail=applied.get("error") or applied.get("err"))
            # short settle to let SPA react before the next screenshot
            client.call({"action": "wait", "ms": 1200}, timeout_s=4.0)
        else:
            _emit("vision", email=email, action="iter-cap", reason="max_iters reached without done")

        # ── magic-link step ─────────────────────────────────────────────
        if magic_link_phase:
            provider = account.get("provider") or _provider_for(email)
            has_pw   = bool(account.get("imap_password_env") or account.get("imap_password"))
            if not (provider and has_pw):
                _emit("account_done", email=email, ok=False, step="imap",
                      reason="no IMAP app-password for this account")
                _write_marker(profile_dir, email, False, [], reason="no app-password")
                return {"ok": False, "email": email, "reason": "no app password"}
            link = _poll_imap_for_link(account)
            if not link:
                _emit("account_done", email=email, ok=False, step="imap",
                      reason="magic-link email never arrived")
                _write_marker(profile_dir, email, False, [], reason="imap timeout")
                return {"ok": False, "email": email, "reason": "imap timeout"}
            r = client.call({"action": "navigate", "url": link, "waitMs": 15000}, timeout_s=30.0)
            _emit("step", email=email, step="navigate_magic_link",
                  ok=bool(r.get("ok")), finalUrl=r.get("url"))
            client.call({"action": "wait", "ms": 2500}, timeout_s=5.0)

        # ── confirm logged in ───────────────────────────────────────────
        url_res = client.call({"action": "page_url"}, timeout_s=5.0)
        url_after = str((url_res or {}).get("url") or "")
        logged_in = _looks_logged_in(url_after)
        if not logged_in:
            # Ask ChatGPT one more time
            png = _save_screenshot(client, slug, MAX_VISION_ITERS)
            if png:
                action = _vision_decide(png, email, openai_key)
                _emit("vision", email=email, iter="confirm", **action)
                if str(action.get("action", "")).lower() == "done":
                    logged_in = True
        cookie_names = _list_cookie_names(client)
        _write_marker(profile_dir, email, logged_in, cookie_names,
                      reason="confirmed" if logged_in else f"url={url_after}")
        _emit("account_done", email=email, ok=logged_in,
              cookieCount=len(cookie_names), url=url_after,
              durationSeconds=round(time.monotonic() - t0, 2))
        return {"ok": logged_in, "email": email}
    except Exception as exc:
        _emit("account_done", email=email, ok=False, step="exception",
              reason=f"{type(exc).__name__}: {exc}")
        _write_marker(profile_dir, email, False, [], reason=f"exception: {exc}")
        return {"ok": False, "email": email, "reason": str(exc)}
    finally:
        client.shutdown()


# ─── main ──────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="",
                    help="Run for only this email (others skipped).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the planned actions; spawn nothing.")
    ap.add_argument("--profile-root", default=str(DEFAULT_PROFILE_ROOT),
                    help="Where to write per-account QtWebEngine profile dirs.")
    ap.add_argument("--openai-key", default="",
                    help="OpenAI key. Falls back to env / config.ini.")
    ap.add_argument("--account", action="append", default=[],
                    help="JSON account row (repeatable). Schema: "
                         '{"email":"...","provider":"gmail|yahoo|outlook",'
                         '"imap_password_env":"IMAP_PWD_42",...}. '
                         "If absent, reads tools/claude_accounts.json.")
    ap.add_argument("--port", type=int, default=NN4_BASE_PORT,
                    help="Base TCP port for nn4_agent_browser (devtools = port+1). "
                         f"Default {NN4_BASE_PORT}. Cycled per account if in use.")
    args = ap.parse_args()

    rows = _read_accounts(args.only, args.account)
    if not rows:
        _emit("error", message="no accounts to process — pass --account or "
                               "create tools/claude_accounts.json")
        _emit("summary", ok=0, fail=0, skipped=0, durationSeconds=0)
        return 0

    openai_key   = _read_openai_key(args.openai_key)
    profile_root = Path(args.profile_root).resolve()
    profile_root.mkdir(parents=True, exist_ok=True)
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)

    _emit("orchestrator_start",
          accounts=len(rows),
          profileRoot=str(profile_root),
          dryRun=bool(args.dry_run),
          openaiKeyPresent=bool(openai_key))

    t0 = time.monotonic()
    ok_n = fail_n = skip_n = 0
    port = args.port
    for row in rows:
        try:
            res = login_one(row, profile_root=profile_root, openai_key=openai_key,
                            port=port, dry_run=args.dry_run)
            if res.get("ok"): ok_n += 1
            else:             fail_n += 1
        except Exception as exc:
            fail_n += 1
            _emit("account_done", email=row.get("email", "?"), ok=False,
                  step="outer-exception", reason=f"{type(exc).__name__}: {exc}")
        # Use a fresh port pair per account so a hung prior process doesn't
        # block the next spawn. nn4 binds with SO_REUSEADDR but a still-running
        # process keeps the listener — incrementing avoids EADDRINUSE.
        port += 2

    _emit("summary", ok=ok_n, fail=fail_n, skipped=skip_n,
          durationSeconds=round(time.monotonic() - t0, 2))
    # Exit 0 if ANY account succeeded — the caller can inspect the summary
    # event to tell partial vs total failure.
    return 0 if (ok_n or args.dry_run) else 1


if __name__ == "__main__":
    raise SystemExit(main())
