#!/usr/bin/env python
"""render_skin.py — headless renderer for the polish pipeline (2026-05-25).

Loads `skins/<name>.skin/index.html` in a headless browser, performs the
same {{TOKEN}} substitutions extension.js does at runtime (so the page
actually paints with real icons + the right URIs), waits for fonts to
settle, and saves `preview.png` INSIDE the skin's .skin/ folder.

Renderer selection (best available wins):
  1. Playwright (chromium)            — preferred, true Blink + fonts
  2. Selenium + Chrome                — works if chrome.exe is on PATH
  3. tools/nn4_agent_browser.py       — offscreen QtWebEngine harness
                                        (fallback for headless-restricted runs)

Window size: 1100x900 (matches the typical chat panel column width).

CLI:
    python tools/render_skin.py [--all | <name> [<name> …]] [--quality low|medium|high]
    python tools/render_skin.py --list

`--quality` controls device-scale-factor (low=1.0 default; medium=1.5; high=2.0).
Default is low per the user's repo-wide image-gen guideline (cost reads as
zero for headless render, but the convention applies to "is this a thumbnail
or a one-off UI piece"). Most polish-loop runs should stay on low.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

ROOT       = Path(__file__).resolve().parent.parent
SKINS_DIR  = ROOT / "skins"
PANEL_DIR  = ROOT / "panel"
ASSETS_DIR = ROOT / "assets"
LIB_DIR    = ROOT / "lib"
SOUNDS_DIR = ROOT / "sounds"

WINDOW_W = 1100
WINDOW_H = 900


# ─── token substitution (mirror of getPanelHtml in extension.js) ──────────

def _file_url(p: Path) -> str:
    return p.resolve().as_uri()


_CSP_RE = __import__("re").compile(
    r'<meta\s+http-equiv\s*=\s*["\']Content-Security-Policy["\'][^>]*>',
    __import__("re").IGNORECASE,
)


def substitute_tokens(html: str, skin_dir: Path) -> str:
    """Replace the {{TOKEN}} placeholders in a panel/skin HTML the same way
    extension.js does at runtime, but using file:// URLs (since we're
    loading the page directly from disk in a headless browser, not through
    asWebviewUri). The skin folder is also exposed as {{SKIN_BASE}} so the
    skin's own icons/styles resolve.

    Also strips the panel's <meta http-equiv="Content-Security-Policy">
    directive, which was authored for the webview sandbox and blocks
    cross-directory file:// loads when the page is served from disk."""
    tokens = {
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
    out = html
    for k, v in tokens.items():
        out = out.replace(k, v)
    # Drop CSP so cross-dir file:// loads work in the headless harness.
    out = _CSP_RE.sub("<!-- CSP stripped for headless render -->", out)
    return out


# ─── render backends ──────────────────────────────────────────────────────

def render_with_playwright(html_path: Path, out_path: Path, scale: float) -> bool:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except Exception as e:
        print(f"  playwright import failed: {e}")
        return False
    try:
        with sync_playwright() as p:
            # Chromium blocks cross-directory file:// fetches by default —
            # the panel HTML lives in skins/<name>.skin/ but its scripts +
            # assets live in panel/ and assets/. Without these flags every
            # icon renders as a broken-image placeholder.
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--allow-file-access-from-files",
                    "--disable-web-security",
                ],
            )
            ctx = browser.new_context(
                viewport={"width": WINDOW_W, "height": WINDOW_H},
                device_scale_factor=scale,
            )
            page = ctx.new_page()
            page.goto(html_path.as_uri(), wait_until="domcontentloaded", timeout=20_000)
            # Give panel.js + fonts a beat to settle. The panel posts `ready`
            # to the host that never arrives in this harness, which means the
            # init-payload-dependent branches stay in their default state —
            # acceptable for a static thumbnail.
            try:
                page.wait_for_load_state("networkidle", timeout=5_000)
            except Exception:
                pass
            page.wait_for_timeout(750)
            page.screenshot(path=str(out_path), full_page=False)
            ctx.close()
            browser.close()
        return True
    except Exception as e:
        print(f"  playwright render failed: {e}")
        return False


def render_with_selenium(html_path: Path, out_path: Path, scale: float) -> bool:
    try:
        from selenium import webdriver  # type: ignore
        from selenium.webdriver.chrome.options import Options  # type: ignore
    except Exception as e:
        print(f"  selenium import failed: {e}")
        return False
    try:
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument(f"--window-size={WINDOW_W},{WINDOW_H}")
        opts.add_argument(f"--force-device-scale-factor={scale}")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--allow-file-access-from-files")
        drv = webdriver.Chrome(options=opts)
        try:
            drv.get(html_path.as_uri())
            time.sleep(1.0)
            drv.save_screenshot(str(out_path))
            return True
        finally:
            drv.quit()
    except Exception as e:
        print(f"  selenium render failed: {e}")
        return False


def render_with_qtwebengine(html_path: Path, out_path: Path, scale: float) -> bool:
    """Fallback: minimal offscreen QtWebEngine renderer using PySide6. Doesn't
    use tools/nn4_agent_browser.py directly to keep this script standalone
    (no port wrangling), but the basic technique is the same."""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    try:
        from PySide6.QtCore import QUrl, QSize, QTimer, QEventLoop  # type: ignore
        from PySide6.QtGui import QPixmap  # type: ignore
        from PySide6.QtWidgets import QApplication  # type: ignore
        from PySide6.QtWebEngineCore import QWebEngineSettings  # type: ignore
        from PySide6.QtWebEngineWidgets import QWebEngineView  # type: ignore
    except Exception as e:
        print(f"  PySide6 import failed: {e}")
        return False
    try:
        app = QApplication.instance() or QApplication(sys.argv)
        view = QWebEngineView()
        view.resize(QSize(WINDOW_W, WINDOW_H))
        view.setZoomFactor(float(scale))
        settings = view.settings()
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        loaded = {"ok": False}
        def on_load(success: bool):
            loaded["ok"] = bool(success)
        view.loadFinished.connect(on_load)
        view.load(QUrl.fromLocalFile(str(html_path)))
        view.show()
        # Pump events until loadFinished, with a hard cap
        deadline = time.time() + 15.0
        while not loaded["ok"] and time.time() < deadline:
            app.processEvents()
            time.sleep(0.05)
        # Extra settle time for fonts / async assets
        settle_deadline = time.time() + 1.2
        while time.time() < settle_deadline:
            app.processEvents()
            time.sleep(0.04)
        pix = view.grab()
        pix.save(str(out_path), "PNG")
        view.deleteLater()
        return True
    except Exception as e:
        print(f"  qtwebengine render failed: {e}")
        return False


def render(html_path: Path, out_path: Path, scale: float) -> Tuple[bool, str]:
    """Try renderers in order; return (ok, which)."""
    for name, fn in [
        ("playwright",  render_with_playwright),
        ("selenium",    render_with_selenium),
        ("qtwebengine", render_with_qtwebengine),
    ]:
        if fn(html_path, out_path, scale):
            return True, name
    return False, ""


# ─── orchestration ────────────────────────────────────────────────────────

def list_skin_dirs() -> List[Path]:
    if not SKINS_DIR.exists():
        return []
    return sorted([p for p in SKINS_DIR.iterdir() if p.is_dir() and p.name.endswith(".skin")])


def resolve_targets(args_names: List[str], wants_all: bool) -> List[Path]:
    all_dirs = list_skin_dirs()
    if wants_all or not args_names:
        return all_dirs
    out: List[Path] = []
    for n in args_names:
        # accept "gnome" or "gnome.skin"
        candidate = n if n.endswith(".skin") else n + ".skin"
        match = next((d for d in all_dirs if d.name == candidate), None)
        if match is None:
            print(f"  unknown skin: {n}")
            continue
        out.append(match)
    return out


def render_one(skin_dir: Path, scale: float) -> Tuple[bool, str]:
    """Substitute tokens, write a tmp HTML next to index.html, render it, then
    clean up. Tmp file is needed because we have to bake the substituted
    tokens before the browser loads — there's no asWebviewUri equivalent
    when running from file://."""
    src_html = skin_dir / "index.html"
    if not src_html.exists():
        return False, f"no index.html in {skin_dir.name}"
    raw = src_html.read_text(encoding="utf-8")
    baked = substitute_tokens(raw, skin_dir)
    tmp = skin_dir / ".render.tmp.html"
    out = skin_dir / "preview.png"
    try:
        tmp.write_text(baked, encoding="utf-8")
        ok, which = render(tmp, out, scale)
        if ok:
            return True, which
        return False, "all renderers failed"
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Render headless previews of CBE skins.")
    parser.add_argument("names", nargs="*", help="skin id(s) to render (omit for all)")
    parser.add_argument("--all", action="store_true", help="render every .skin/ in skins/")
    parser.add_argument("--quality", choices=["low", "medium", "high"], default="low",
                        help="device scale factor (low=1.0, medium=1.5, high=2.0). Default low.")
    parser.add_argument("--list", action="store_true", help="list discovered skin folders and exit")
    args = parser.parse_args()

    if args.list:
        for d in list_skin_dirs():
            print(d.name)
        return 0

    scale_map = {"low": 1.0, "medium": 1.5, "high": 2.0}
    scale = scale_map[args.quality]

    targets = resolve_targets(args.names, args.all or not args.names)
    if not targets:
        print("No .skin folders found under skins/.")
        return 1

    ok = 0
    fail = 0
    for d in targets:
        print(f"[{d.name}] rendering @ scale={scale} …")
        success, which = render_one(d, scale)
        if success:
            preview = d / "preview.png"
            size = preview.stat().st_size if preview.exists() else 0
            print(f"  OK via {which} -> {preview} ({size} bytes)")
            ok += 1
        else:
            print(f"  FAIL: {which}")
            fail += 1

    print(f"\nRendered {ok} ok / {fail} failed (of {len(targets)} skins).")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
