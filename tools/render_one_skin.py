#!/usr/bin/env python
"""render_one_skin.py — quick headless screenshot of a single flat skin file
(skins/<name>.html) for the 2026-06-03 prompt-row overlap debugging.

Bakes the same {{TOKEN}} substitutions extension.js does, drops CSP, loads in
headless chromium at a chosen viewport, saves a PNG. Lets us actually SEE the
overlap instead of reasoning blind.

    python tools/render_one_skin.py tamagotchi --width 520 --height 900 --out _tama.png
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
SKINS_DIR  = ROOT / "skins"
PANEL_DIR  = ROOT / "panel"
ASSETS_DIR = ROOT / "assets"
LIB_DIR    = ROOT / "lib"
SOUNDS_DIR = ROOT / "sounds"

_CSP_RE = re.compile(
    r'<meta\s+http-equiv\s*=\s*["\']Content-Security-Policy["\'][^>]*>',
    re.IGNORECASE,
)

def _u(p: Path) -> str:
    return p.resolve().as_uri()

def bake(html: str) -> str:
    tokens = {
        "{{ASSETS_BASE}}":         _u(ASSETS_DIR),
        "{{SKIN_BASE}}":           _u(SKINS_DIR),
        "{{SOUNDS_BASE}}":         _u(SOUNDS_DIR),
        "{{PRISM_JS_URI}}":        _u(LIB_DIR / "prism.min.js"),
        "{{PRISM_LANGS_URI}}":     _u(LIB_DIR / "prism-langs.min.js"),
        "{{PRISM_CSS_URI}}":       _u(LIB_DIR / "prism-dark.min.css"),
        "{{HELP_URI}}":            _u(PANEL_DIR / "help.html"),
        "{{PANEL_JS_URI}}":        _u(PANEL_DIR / "panel.js"),
        "{{DOTMATRIX_JS_URI}}":    _u(PANEL_DIR / "dotmatrix.js"),
        "{{TAMA_SPRITES_JS_URI}}": _u(PANEL_DIR / "dotmatrix-tamagotchi-sprites.js"),
        "{{TAMA_GAME_JS_URI}}":    _u(PANEL_DIR / "dotmatrix-tamagotchi-game.js"),
        "{{CSP_SOURCE}}":          "file://",
    }
    for k, v in tokens.items():
        html = html.replace(k, v)
    return _CSP_RE.sub("<!-- CSP stripped -->", html)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--width", type=int, default=520)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--out", default=None)
    ap.add_argument("--show-tama", action="store_true",
                    help="force-show the pet shell (it is hidden by default)")
    a = ap.parse_args()

    src = SKINS_DIR / (a.name if a.name.endswith(".html") else a.name + ".html")
    if not src.exists():
        print("no such skin:", src); return 1
    baked = bake(src.read_text(encoding="utf-8"))
    tmp = SKINS_DIR / ".render.tmp.html"
    out = Path(a.out) if a.out else (ROOT / f"_render_{a.name}.png")
    tmp.write_text(baked, encoding="utf-8")
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True,
                                  args=["--allow-file-access-from-files",
                                        "--disable-web-security"])
            ctx = b.new_context(viewport={"width": a.width, "height": a.height},
                                device_scale_factor=1.0)
            pg = ctx.new_page()
            pg.goto(tmp.as_uri(), wait_until="domcontentloaded", timeout=20000)
            try: pg.wait_for_load_state("networkidle", timeout=4000)
            except Exception: pass
            pg.wait_for_timeout(600)
            if a.show_tama:
                # reveal the pet + stamp data-skin (the host normally does this)
                pg.evaluate("""() => {
                    document.body.setAttribute('data-skin','%s');
                    var s = document.getElementById('cbe-tama-shell');
                    if (s) s.hidden = false;
                }""" % a.name)
                pg.wait_for_timeout(400)
            else:
                pg.evaluate("""() => { document.body.setAttribute('data-skin','%s'); }""" % a.name)
                pg.wait_for_timeout(300)
            pg.screenshot(path=str(out), full_page=False)
            ctx.close(); b.close()
        print("saved", out)
        return 0
    finally:
        try: tmp.unlink()
        except Exception: pass

if __name__ == "__main__":
    sys.exit(main())
