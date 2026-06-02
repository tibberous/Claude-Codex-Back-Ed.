#!/usr/bin/env python
"""render_skin_preview.py — render panel/index.html with a skin applied.

Differs from the older `render_skin.py` (which renders fully-baked
`skins/<name>.skin/index.html` skin pages). This script targets the simpler
manifest-only skin pattern in `skins/<id>/` — i.e. a `manifest.xml` + a
`styles.css`, no full HTML — and composes them onto the canonical
`panel/index.html` at render time:

  1. Read panel/index.html.
  2. Substitute {{ASSETS_BASE}}, {{SKIN_BASE}}, {{HELP_URI}}, prism + tamagotchi
     URIs, etc. with file:// URLs.
  3. Strip the webview-only CSP meta tag so cross-directory file:// fetches work.
  4. Read `skins/<skin-id>/manifest.xml`, translate every `<colors>/<modal-*>`
     and `<highlight-color>` / `<code-bar-*>` element into `--cbe-*` CSS
     variables on `:root` via an injected <style> block.
  5. Append `skins/<skin-id>/styles.css` as a second injected <style> block
     (overrides default panel styles).
  6. Write to a temp HTML next to panel/index.html and load it in a
     headless browser (Playwright → Selenium → QtWebEngine fallback).
  7. Screenshot to --out at 700×900.

CLI:
    python tools/render_skin_preview.py --skin codex-black --out preview.png
    python tools/render_skin_preview.py --list

The PNG path is printed to stdout on success (for easy piping into other
tools / agents). Exit code 0 on success, 1 on failure.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT       = Path(__file__).resolve().parent.parent
SKINS_DIR  = ROOT / "skins"
PANEL_DIR  = ROOT / "panel"
ASSETS_DIR = ROOT / "assets"
LIB_DIR    = ROOT / "lib"
SOUNDS_DIR = ROOT / "sounds"

VIEWPORT_W = 700
VIEWPORT_H = 900

# Settle delay after DOMContentLoaded to let panel.js + fonts finish.
SETTLE_MS  = 700


# ─── token substitution ───────────────────────────────────────────────────

def _file_url(p: Path) -> str:
    return p.resolve().as_uri()


_CSP_RE = re.compile(
    r'<meta\s+http-equiv\s*=\s*["\']Content-Security-Policy["\'][^>]*/?>',
    re.IGNORECASE,
)


def _build_token_map(skin_dir: Path) -> Dict[str, str]:
    """Mirror the substitution table extension.js applies at runtime, but
    using file:// URLs since we're loading from disk in a headless browser."""
    return {
        "{{ASSETS_BASE}}":         _file_url(ASSETS_DIR),
        "{{SKIN_BASE}}":           _file_url(skin_dir),
        "{{SOUNDS_BASE}}":         _file_url(SOUNDS_DIR),
        "{{LABEL_ALPHA_URI}}":     _file_url(ASSETS_DIR / "label-alpha.png"),
        "{{BLANK_URI}}":           _file_url(ASSETS_DIR / "blank.png"),
        "{{BLANK_OVER_URI}}":      _file_url(ASSETS_DIR / "blank_over.png"),
        "{{BLANK_CLICK_URI}}":     _file_url(ASSETS_DIR / "blank_click.png"),
        "{{PRISM_JS_URI}}":        _file_url(LIB_DIR / "prism.min.js"),
        "{{PRISM_LANGS_URI}}":     _file_url(LIB_DIR / "prism-langs.min.js"),
        "{{PRISM_CSS_URI}}":       _file_url(LIB_DIR / "prism-dark.min.css"),
        "{{HELP_URI}}":            _file_url(PANEL_DIR / "help.html"),
        "{{PANEL_JS_URI}}":        _file_url(PANEL_DIR / "panel.js"),
        "{{DOTMATRIX_JS_URI}}":    _file_url(PANEL_DIR / "dotmatrix.js"),
        "{{TAMA_SPRITES_JS_URI}}": _file_url(PANEL_DIR / "dotmatrix-tamagotchi-sprites.js"),
        "{{TAMA_GAME_JS_URI}}":    _file_url(PANEL_DIR / "dotmatrix-tamagotchi-game.js"),
        "{{CSP_SOURCE}}":          "file://",
    }


def substitute_tokens(html: str, skin_dir: Path) -> str:
    out = html
    for k, v in _build_token_map(skin_dir).items():
        out = out.replace(k, v)
    # Drop CSP so cross-dir file:// loads work in the headless harness.
    out = _CSP_RE.sub("<!-- CSP stripped for headless render -->", out)
    return out


# ─── manifest → CSS variables ─────────────────────────────────────────────

# Mapping from manifest <colors>/<token> element name to the CSS variable
# the panel reads at runtime. Kept in sync with extension.js'
# applySkinColors() so the headless preview matches the live webview.
MANIFEST_TO_CSSVAR = {
    "modal-bg":         "--cbe-modal-bg",
    "modal-fg":         "--cbe-modal-fg",
    "modal-border":     "--cbe-modal-border",
    "modal-title-bg-1": "--cbe-modal-title-bg-1",
    "modal-title-bg-2": "--cbe-modal-title-bg-2",
    "modal-title-fg":   "--cbe-modal-title-fg",
    "modal-foot-bg":    "--cbe-modal-foot-bg",
    "modal-accent":     "--cbe-modal-accent",
    "highlight-color":  "--cbe-highlight-color",
    "code-bar-bg":      "--cbe-code-bar-bg",
    "code-bar-fg":      "--cbe-code-bar-fg",
}


_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _strip_xml_comments(raw: str) -> str:
    """The CBE manifests use double-dash sequences inside <!-- ... -->
    comments (e.g. '--cbe-modal-*'), which is invalid XML 1.0. Rather than
    error out, strip every comment before parsing — we only care about the
    element data."""
    return _HTML_COMMENT_RE.sub("", raw)


def manifest_to_css(skin_dir: Path) -> str:
    """Parse manifest.xml and emit a `:root { --cbe-*: … }` block. Skips
    elements not in MANIFEST_TO_CSSVAR. Also reads the top-level <accent>
    element if present and maps it to --cbe-accent (mirroring the same
    behavior in extension.js).

    Tolerant parser: strips XML comments first because the CBE manifests
    embed `--cbe-…` token names in their comments, which is invalid XML."""
    manifest = skin_dir / "manifest.xml"
    if not manifest.exists():
        return ""
    raw = manifest.read_text(encoding="utf-8")
    cleaned = _strip_xml_comments(raw)
    try:
        root = ET.fromstring(cleaned)
    except ET.ParseError as e:
        print(f"  [warn] manifest.xml parse error: {e}", file=sys.stderr)
        return ""
    decls: List[str] = []
    accent_el = root.find("accent")
    if accent_el is not None and accent_el.text:
        decls.append(f"  --cbe-accent: {accent_el.text.strip()};")
    colors = root.find("colors")
    if colors is not None:
        for child in colors:
            tag = (child.tag or "").lower()
            if tag in MANIFEST_TO_CSSVAR and child.text:
                cssvar = MANIFEST_TO_CSSVAR[tag]
                decls.append(f"  {cssvar}: {child.text.strip()};")
    if not decls:
        return ""
    return ":root {\n" + "\n".join(decls) + "\n}\n"


def inject_skin(html: str, skin_dir: Path) -> str:
    """Append the manifest-derived CSS variables and the skin's styles.css
    as two <style> blocks at the end of <head>, so they win over panel
    defaults."""
    css_vars = manifest_to_css(skin_dir)
    styles_path = skin_dir / "styles.css"
    styles_css  = styles_path.read_text(encoding="utf-8") if styles_path.exists() else ""
    if not css_vars and not styles_css:
        return html
    injected = "\n<!-- skin: " + skin_dir.name + " -->\n"
    if css_vars:
        injected += "<style id=\"cbe-skin-vars\">\n" + css_vars + "</style>\n"
    if styles_css:
        injected += "<style id=\"cbe-skin-styles\">\n" + styles_css + "\n</style>\n"
    # Insert before </head>; fall back to start of <body> if no </head>.
    lower = html.lower()
    idx = lower.rfind("</head>")
    if idx >= 0:
        return html[:idx] + injected + html[idx:]
    idx = lower.find("<body")
    if idx >= 0:
        return html[:idx] + injected + html[idx:]
    return html + injected


# ─── render backends ──────────────────────────────────────────────────────

def render_with_playwright(html_path: Path, out_path: Path) -> bool:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except Exception as e:
        print(f"  playwright import failed: {e}", file=sys.stderr)
        return False
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--allow-file-access-from-files",
                    "--disable-web-security",
                ],
            )
            ctx = browser.new_context(
                viewport={"width": VIEWPORT_W, "height": VIEWPORT_H},
                device_scale_factor=1.0,
            )
            page = ctx.new_page()
            page.goto(html_path.as_uri(), wait_until="domcontentloaded", timeout=20_000)
            try:
                page.wait_for_load_state("networkidle", timeout=4_000)
            except Exception:
                pass
            page.wait_for_timeout(SETTLE_MS)
            page.screenshot(path=str(out_path), full_page=False)
            ctx.close()
            browser.close()
        return True
    except Exception as e:
        print(f"  playwright render failed: {e}", file=sys.stderr)
        return False


def render_with_selenium(html_path: Path, out_path: Path) -> bool:
    try:
        from selenium import webdriver  # type: ignore
        from selenium.webdriver.chrome.options import Options  # type: ignore
    except Exception as e:
        print(f"  selenium import failed: {e}", file=sys.stderr)
        return False
    try:
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument(f"--window-size={VIEWPORT_W},{VIEWPORT_H}")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--allow-file-access-from-files")
        drv = webdriver.Chrome(options=opts)
        try:
            drv.get(html_path.as_uri())
            time.sleep(1.2)
            drv.save_screenshot(str(out_path))
            return True
        finally:
            drv.quit()
    except Exception as e:
        print(f"  selenium render failed: {e}", file=sys.stderr)
        return False


def render_with_qtwebengine(html_path: Path, out_path: Path) -> bool:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    try:
        from PySide6.QtCore import QUrl, QSize  # type: ignore
        from PySide6.QtWidgets import QApplication  # type: ignore
        from PySide6.QtWebEngineCore import QWebEngineSettings  # type: ignore
        from PySide6.QtWebEngineWidgets import QWebEngineView  # type: ignore
    except Exception as e:
        print(f"  PySide6 import failed: {e}", file=sys.stderr)
        return False
    try:
        app = QApplication.instance() or QApplication(sys.argv)
        view = QWebEngineView()
        view.resize(QSize(VIEWPORT_W, VIEWPORT_H))
        settings = view.settings()
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        loaded = {"ok": False}

        def on_load(success: bool):
            loaded["ok"] = bool(success)
        view.loadFinished.connect(on_load)
        view.load(QUrl.fromLocalFile(str(html_path)))
        view.show()
        deadline = time.time() + 15.0
        while not loaded["ok"] and time.time() < deadline:
            app.processEvents()
            time.sleep(0.05)
        settle_deadline = time.time() + 1.2
        while time.time() < settle_deadline:
            app.processEvents()
            time.sleep(0.04)
        pix = view.grab()
        pix.save(str(out_path), "PNG")
        view.deleteLater()
        return True
    except Exception as e:
        print(f"  qtwebengine render failed: {e}", file=sys.stderr)
        return False


def render(html_path: Path, out_path: Path) -> Tuple[bool, str]:
    for name, fn in [
        ("playwright",  render_with_playwright),
        ("selenium",    render_with_selenium),
        ("qtwebengine", render_with_qtwebengine),
    ]:
        if fn(html_path, out_path):
            return True, name
    return False, ""


# ─── skin discovery ───────────────────────────────────────────────────────

def list_skin_ids() -> List[str]:
    """Every direct child of skins/ that has a manifest.xml. Excludes the
    .skin/ folders (those are handled by render_skin.py)."""
    if not SKINS_DIR.exists():
        return []
    ids: List[str] = []
    for p in sorted(SKINS_DIR.iterdir()):
        if not p.is_dir():
            continue
        if p.name.endswith(".skin"):
            continue
        if (p / "manifest.xml").exists():
            ids.append(p.name)
    return ids


def resolve_skin_dir(skin_id: str) -> Optional[Path]:
    candidate = SKINS_DIR / skin_id
    if candidate.is_dir() and (candidate / "manifest.xml").exists():
        return candidate
    return None


# ─── main ─────────────────────────────────────────────────────────────────

def render_preview(skin_id: str, out_path: Path) -> bool:
    skin_dir = resolve_skin_dir(skin_id)
    if skin_dir is None:
        print(f"  unknown skin: {skin_id}", file=sys.stderr)
        return False

    panel_html_path = PANEL_DIR / "index.html"
    if not panel_html_path.exists():
        print(f"  missing {panel_html_path}", file=sys.stderr)
        return False

    raw = panel_html_path.read_text(encoding="utf-8")
    baked = substitute_tokens(raw, skin_dir)
    skinned = inject_skin(baked, skin_dir)

    # Write the temp HTML INSIDE panel/ so relative resolution + the
    # absolute file:// URIs both work. Use a sentinel name we can clean up.
    tmp_html = PANEL_DIR / f".render_skin_preview.{skin_id}.tmp.html"
    out_path = out_path.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        tmp_html.write_text(skinned, encoding="utf-8")
        ok, which = render(tmp_html, out_path)
        if ok:
            print(f"  rendered via {which}", file=sys.stderr)
            return True
        print(f"  all renderers failed", file=sys.stderr)
        return False
    finally:
        try:
            tmp_html.unlink()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a CBE panel preview with a skin applied.")
    parser.add_argument("--skin", help="skin id (folder name under skins/)")
    parser.add_argument("--out", help="output PNG path")
    parser.add_argument("--list", action="store_true",
                        help="list all skin ids (folders under skins/ with a manifest.xml) and exit")
    args = parser.parse_args()

    if args.list:
        for s in list_skin_ids():
            print(s)
        return 0

    if not args.skin:
        print("error: --skin is required (or use --list)", file=sys.stderr)
        return 2
    if not args.out:
        print("error: --out is required", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    ok = render_preview(args.skin, out_path)
    if not ok:
        return 1

    # Final stdout line = the resulting PNG path, so callers can pipe.
    print(str(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
