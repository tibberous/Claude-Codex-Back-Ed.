#!/usr/bin/env python
"""gen_skin_preview.py — render a flat single-file skin to a content-addressed
PNG thumbnail using offscreen QtWebEngine (real Chromium; no Playwright/Selenium).

Flat layout (post-2026-05-31): a skin is ONE file `skins/<id>.html` (the full
panel HTML with inline <style> + :root palette). Assets, if any, live in
`skins/<id>-assets/` (→ {{SKIN_BASE}}). Output goes to
`skins/previews/<id>-<md5[:6]>.png`, where <md5[:6]> = first 6 hex of the md5
of `<id>.html`. If the skin HTML changes, the md5 changes, so the cache key
changes and the preview self-refreshes; stale `<id>-*.png` are pruned.

CLI:
    python tools/gen_skin_preview.py --skin aqua-dock
    python tools/gen_skin_preview.py --all
    python tools/gen_skin_preview.py --skin aqua-dock --force

Prints the output PNG path on success. Exit 0 ok, 1 fail. Idempotent: skips
when the content-addressed PNG already exists (unless --force).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import tempfile
from pathlib import Path

REPO       = Path(__file__).resolve().parent.parent
SKINS_DIR  = REPO / "skins"
PREVIEW_DIR = SKINS_DIR / "previews"
ASSETS_DIR = REPO / "assets"
SOUNDS_DIR = REPO / "sounds"
LIB_DIR    = REPO / "lib"
PANEL_DIR  = REPO / "panel"

RENDER_W, RENDER_H = 1000, 1300       # render canvas (captures composer + chrome)
THUMB_W = 480                          # downscaled thumbnail width (height scales)
PAINT_MS = 900                         # settle time after loadFinished (fonts/blur)
TIMEOUT_MS = 20000

_CSP_RE = re.compile(r'<meta\s+http-equiv\s*=\s*["\']Content-Security-Policy["\'][^>]*/?>', re.I)

# Only non-stdlib dependency is PySide6 (the QtWebEngine renderer). Everything
# else imported above is stdlib. Auto-install it once if the user doesn't have
# it — the renderer must "just work" without a manual pip step.
def _ensure_deps() -> None:
    try:
        import PySide6  # noqa: F401
        import PySide6.QtWebEngineWidgets  # noqa: F401  (separate wheel component)
        return
    except ImportError:
        pass
    import subprocess
    print("[gen_skin_preview] PySide6 (QtWebEngine) not found — installing once "
          "(~100 MB)…", file=sys.stderr, flush=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                    "--quiet", "PySide6"], check=True)
    # Re-verify after install so a partial wheel surfaces immediately.
    import PySide6.QtWebEngineWidgets  # noqa: F401


def _file_url(p: Path) -> str:
    return p.resolve().as_uri()


def _md5_6(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()[:6]


def _token_map(assets_dir: Path) -> dict:
    """file:// substitution mirroring extension.js's runtime token table.
    SKIN_BASE → the skin's <id>-assets/ dir (or skins/ if none)."""
    return {
        "{{ASSETS_BASE}}":         _file_url(ASSETS_DIR),
        "{{SKIN_BASE}}":           _file_url(assets_dir),
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


def _prepare_html(skin_id: str) -> Path:
    """Read skins/<id>.html, substitute tokens → file:// urls, strip the CSP
    meta (so cross-dir file:// fetches work), write to a temp file. Returns it."""
    html_path = SKINS_DIR / f"{skin_id}.html"
    if not html_path.exists():
        raise FileNotFoundError(html_path)
    assets_dir = SKINS_DIR / f"{skin_id}-assets"
    if not assets_dir.exists():
        assets_dir = SKINS_DIR
    html = html_path.read_text(encoding="utf-8", errors="replace")
    for tok, url in _token_map(assets_dir).items():
        html = html.replace(tok, url)
    html = _CSP_RE.sub("", html)
    # temp file lives NEXT TO skins/ so relative file:// refs (if any) resolve
    fd, tmp = tempfile.mkstemp(suffix=f"_{skin_id}.html", dir=str(SKINS_DIR))
    os.close(fd)
    Path(tmp).write_text(html, encoding="utf-8")
    return Path(tmp)


def _out_path(skin_id: str) -> Path:
    return PREVIEW_DIR / f"{skin_id}-{_md5_6(SKINS_DIR / f'{skin_id}.html')}.png"


def _prune_stale(skin_id: str, keep: Path) -> None:
    for p in PREVIEW_DIR.glob(f"{skin_id}-*.png"):
        if p.name != keep.name:
            try: p.unlink()
            except OSError: pass


def _trim_bottom_margin(pix):
    """Crop off a solid-colour bottom band from the grabbed pixmap so a
    fixed-bottom composer sits flush at the canvas edge. Returns a (possibly
    shorter) QPixmap. Scans rows from the bottom up; the band is 'solid' while
    every sampled pixel in the row matches the very-bottom row's colour within
    a small tolerance. Always leaves at least 55% of the original height so a
    short composer doesn't get cropped to a sliver."""
    from PySide6.QtCore import QRect
    img = pix.toImage()
    w, h = img.width(), img.height()
    if w == 0 or h == 0:
        return pix
    bg = img.pixel(w // 2, h - 1)
    def row_is_bg(y):
        for x in range(0, w, max(1, w // 24)):
            p = img.pixel(x, y)
            dr = abs((p >> 16 & 0xFF) - (bg >> 16 & 0xFF))
            dg = abs((p >> 8 & 0xFF) - (bg >> 8 & 0xFF))
            db = abs((p & 0xFF) - (bg & 0xFF))
            if dr + dg + db > 24:
                return False
        return True
    y = h - 1
    min_keep = int(h * 0.55)
    while y > min_keep and row_is_bg(y):
        y -= 1
    # keep a small breathing margin below the composer
    bottom = min(h, y + 12)
    if bottom >= h - 2:
        return pix
    return pix.copy(QRect(0, 0, w, bottom))


def render(skin_id: str, force: bool = False) -> Path:
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    out = _out_path(skin_id)
    if out.exists() and not force:
        return out

    _ensure_deps()   # auto-pip-install PySide6 if missing
    # Qt imports deferred so --list / errors don't require the GUI stack.
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                          "--disable-gpu --no-sandbox --disable-software-rasterizer")
    from PySide6.QtCore import QUrl, QTimer
    from PySide6.QtWidgets import QApplication
    from PySide6.QtWebEngineWidgets import QWebEngineView

    tmp_html = _prepare_html(skin_id)
    result = {"ok": False, "err": ""}

    from PySide6.QtCore import QRect
    app = QApplication.instance() or QApplication(sys.argv[:1])
    view = QWebEngineView()
    view.resize(RENDER_W, RENDER_H)
    view.move(-32000, -32000)   # offscreen but with a real surface (NN4 pattern)
    view.show()

    def _grab_and_quit():
        try:
            # Grab an EXPLICIT RENDER_W×RENDER_H rect, not view.grab()'s default.
            # Skins whose composer is `position:fixed; bottom:0` (the macOS / dock
            # skins) only render the composer at the VIEWPORT bottom — a bare
            # view.grab() can clip to the (shorter) content height and miss the
            # composer entirely, yielding a blank preview. Forcing the full
            # resized rect guarantees the fixed-bottom composer lands on-canvas.
            view.resize(RENDER_W, RENDER_H)
            pix = view.grab(QRect(0, 0, RENDER_W, RENDER_H))
            # Trim uniform trailing rows at the BOTTOM so the composer ends up
            # flush at the canvas edge. Skins whose composer is fixed-bottom
            # anchor to the page's layout-viewport (often shorter than the full
            # RENDER_H), leaving a band of empty page colour beneath it. We grab
            # the full height (so dock/fixed composers are never clipped) then
            # crop off any solid-colour bottom margin. A top margin is kept (the
            # empty chat thread) so the composer still reads as bottom-docked.
            pix = _trim_bottom_margin(pix)
            if THUMB_W and pix.width() > THUMB_W:
                from PySide6.QtCore import Qt
                pix = pix.scaledToWidth(THUMB_W, Qt.SmoothTransformation)
            ok = pix.save(str(out), "PNG")
            result["ok"] = bool(ok)
            if not ok:
                result["err"] = "pixmap.save returned False"
        except Exception as e:  # noqa: BLE001
            result["err"] = repr(e)
        app.quit()

    def _on_load(ok: bool):
        # render even if ok is False — CSS chrome paints regardless of JS errors
        QTimer.singleShot(PAINT_MS, _grab_and_quit)

    view.loadFinished.connect(_on_load)
    QTimer.singleShot(TIMEOUT_MS, lambda: (result.__setitem__("err", "render timeout"), app.quit()))
    view.load(QUrl.fromLocalFile(str(tmp_html)))
    app.exec()

    try: tmp_html.unlink()
    except OSError: pass

    if not result["ok"]:
        raise RuntimeError(f"render failed for {skin_id}: {result['err'] or 'unknown'}")
    _prune_stale(skin_id, out)
    return out


def _list_skins() -> list:
    return sorted(p.stem for p in SKINS_DIR.glob("*.html"))


def _clean_previews(skin_id: str | None) -> int:
    """Delete preview PNGs. If skin_id is given, delete only that skin's
    content-addressed `<id>-*.png`; otherwise nuke every `previews/*.png`.
    Content-addressed names mean stale md5 hashes pile up across edits, so a
    clean pass before regen avoids confusing leftover thumbnails. Returns the
    number of files removed."""
    if not PREVIEW_DIR.exists():
        return 0
    pattern = f"{skin_id}-*.png" if skin_id else "*.png"
    removed = 0
    for p in PREVIEW_DIR.glob(pattern):
        try:
            p.unlink(); removed += 1
        except OSError:
            pass
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skin", help="skin id (basename of skins/<id>.html)")
    ap.add_argument("--all", action="store_true", help="generate for every skin")
    ap.add_argument("--force", action="store_true", help="re-render even if cached")
    ap.add_argument("--clean", action="store_true",
                    help="delete preview PNGs first, then regenerate. "
                         "With --skin <id>: cleans only that skin's stale "
                         "<id>-*.png. Without --skin: cleans previews/*.png and "
                         "regenerates --all. Implies --force for what it regens.")
    ap.add_argument("--list", action="store_true", help="list skin ids and exit")
    args = ap.parse_args()

    if args.list:
        print("\n".join(_list_skins())); return 0

    # --clean: prune stale PNGs first. Scope to the one skin if --skin is set,
    # otherwise wipe the whole previews dir. After cleaning we force-regenerate
    # (a full --all sweep when no specific skin was named).
    force = args.force
    if args.clean:
        removed = _clean_previews(args.skin)
        print(f"[clean] removed {removed} preview PNG(s)"
              + (f" for '{args.skin}'" if args.skin else " (all)"), file=sys.stderr)
        force = True
        if not args.skin:
            args.all = True

    targets = _list_skins() if args.all else ([args.skin] if args.skin else [])
    if not targets:
        print("nothing to do — pass --skin <id>, --all, or --clean", file=sys.stderr); return 1

    rc = 0
    for sid in targets:
        try:
            out = render(sid, force=force)
            print(out)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {sid}: {e}", file=sys.stderr); rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
