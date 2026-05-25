"""Snapshot every skin's panel HTML at 600px wide and save a PNG per skin.

Why 600px: that's where skin layouts crack (cut-off labels, overflowing
buttons, blown margins). The screenshots are then handed to a polish agent
that reviews each one and proposes per-skin CSS fixes.

What it does:
  1. Walks skins/*.skin/ — every new-format skin.
  2. Reads its index.html, substitutes the {{...}} template tokens to
     local file:// URIs so the page renders standalone (Prism, panel.js,
     assets, sounds, tama scripts all resolve).
  3. Strips the CSP meta (file:// + CSP is brittle) and injects a tiny
     acquireVsCodeApi shim so panel.js doesn't crash on `vscode.postMessage`.
  4. Seeds the conversation with a few demo messages so the chat thread
     isn't empty (so we see the bubble + scroll styling).
  5. Loads each prepared HTML in an offscreen QWebEngineView at 600x900,
     waits 2.5s for fonts/CSS to settle, view.grab() -> PNG.
  6. Writes tools/skin_snapshots/<id>.png. Also writes a contact-sheet
     tools/skin_snapshots/_contact_sheet.png at the end so a reviewer can
     scan all skins side-by-side.

Reuses the offscreen-Qt trick from tools/nn4_screenshot.py: do NOT use
QT_QPA_PLATFORM=offscreen (Chromium paints nothing under it). Instead
keep a real native window but move it off-screen and skip the taskbar.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from PySide6.QtCore import QUrl, QTimer, Qt
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

REPO_ROOT   = Path(__file__).resolve().parent.parent
SKINS_DIR   = REPO_ROOT / "skins"
OUT_DIR     = REPO_ROOT / "tools" / "skin_snapshots"
WIDTH       = 600
HEIGHT      = 900
RENDER_MS   = 2500


def _file_uri(p: Path) -> str:
    return p.resolve().as_uri()


def prepare_skin_html(skin_dir: Path, tmp_path: Path) -> Path:
    """Read skin_dir/index.html, substitute every template token to a local
    file:// URI, strip CSP, inject vscode-api shim + sample messages, write
    to tmp_path and return it."""
    src = (skin_dir / "index.html").read_text(encoding="utf-8")

    panel_dir   = REPO_ROOT / "panel"
    lib_dir     = REPO_ROOT / "lib"
    assets_dir  = REPO_ROOT / "assets"
    sounds_dir  = REPO_ROOT / "sounds"

    subs = {
        "{{CSP_SOURCE}}":       "",
        "{{SKIN_BASE}}":        _file_uri(skin_dir),
        "{{ASSETS_BASE}}":      _file_uri(assets_dir),
        "{{SOUNDS_BASE}}":      _file_uri(sounds_dir),
        "{{PANEL_JS_URI}}":     _file_uri(panel_dir / "panel.js"),
        "{{HELP_URI}}":         _file_uri(panel_dir / "help.html"),
        "{{PRISM_JS_URI}}":     _file_uri(lib_dir / "prism.min.js"),
        "{{PRISM_LANGS_URI}}":  _file_uri(lib_dir / "prism-langs.min.js"),
        "{{PRISM_CSS_URI}}":    _file_uri(lib_dir / "prism-dark.min.css"),
        "{{DOTMATRIX_JS_URI}}":     _file_uri(panel_dir / "dotmatrix.js"),
        "{{TAMA_SPRITES_JS_URI}}":  _file_uri(panel_dir / "dotmatrix-tamagotchi-sprites.js"),
        "{{TAMA_GAME_JS_URI}}":     _file_uri(panel_dir / "dotmatrix-tamagotchi-game.js"),
    }
    for tok, val in subs.items():
        src = src.replace(tok, val)

    # Strip the entire CSP meta tag — file:// loads inside the webview
    # rendered offscreen don't tolerate the {{CSP_SOURCE}}-flavored CSP.
    import re as _re
    src = _re.sub(
        r'<meta\s+http-equiv="Content-Security-Policy"[^>]*>',
        "<!-- csp stripped for offscreen snapshot -->",
        src,
        count=1,
        flags=_re.IGNORECASE,
    )

    # Inject the vscode-api shim + DOM seed BEFORE panel.js executes. The
    # panel.js bundle calls acquireVsCodeApi() at top level; without the
    # shim it throws ReferenceError and the chat thread never renders.
    shim = """
<script>
  // Mock the VSCode webview API so panel.js can boot offscreen.
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function () {},
      getState:   function () { return {}; },
      setState:   function () {},
    };
  };
  // Synthesize a tiny conversation right after panel.js initializes so the
  // chat-thread styles are visible. We retry until the renderer is ready.
  window.__snapshotSeed = function () {
    try {
      var thread = document.querySelector('#chatThread, .chat-thread, .messages, #messages');
      if (!thread) return false;
      if (thread.querySelector('.snap-seeded')) return true;
      var demo = [
        { role: 'user',      body: 'How tall is Mount Everest?' },
        { role: 'assistant', body: 'About 8,849 meters (29,032 ft). The summit elevation is measured above mean sea level.' },
        { role: 'user',      body: 'And the deepest ocean trench?' },
        { role: 'assistant', body: 'The Mariana Trench bottoms out at roughly 10,994 m at Challenger Deep — deeper than Everest is tall.' },
      ];
      demo.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant') + ' snap-seeded';
        row.setAttribute('data-role', m.role);
        var name = document.createElement('div');
        name.className = 'msg-name';
        name.textContent = m.role === 'user' ? 'You' : 'Claude';
        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = m.body;
        row.appendChild(name); row.appendChild(bubble);
        thread.appendChild(row);
      });
      return true;
    } catch (e) { return false; }
  };
  // Try a few times in case panel.js builds the thread async.
  setTimeout(function poke() {
    if (!window.__snapshotSeed()) setTimeout(poke, 200);
  }, 300);
</script>
"""
    # Place the shim immediately after <head> so it runs before any panel.js
    # bundle the skin includes.
    src = _re.sub(r'(<head[^>]*>)', r'\1' + shim, src, count=1, flags=_re.IGNORECASE)

    tmp_path.write_text(src, encoding="utf-8")
    return tmp_path


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    skin_dirs = sorted([d for d in SKINS_DIR.iterdir()
                        if d.is_dir() and d.name.endswith(".skin")
                        and (d / "index.html").is_file()
                        and (d / "manifest.xml").is_file()])
    print(f"[snap] found {len(skin_dirs)} skins to snapshot")

    app = QApplication.instance() or QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(WIDTH, HEIGHT)
    view.setWindowFlag(Qt.WindowType.Tool, True)
    view.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
    view.move(-32000, -32000)
    view.show()

    state = {"idx": 0, "ok": 0, "fail": 0, "done": False}

    def run_one():
        i = state["idx"]
        if i >= len(skin_dirs):
            state["done"] = True
            QApplication.quit()
            return
        skin_dir = skin_dirs[i]
        skin_id = skin_dir.name[:-len(".skin")]
        tmp_html = skin_dir / "_snap_index.html"
        try:
            prepare_skin_html(skin_dir, tmp_html)
        except Exception as e:
            print(f"[snap] {skin_id}: prepare failed: {e}")
            state["fail"] += 1
            state["idx"] += 1
            QTimer.singleShot(50, run_one)
            return

        out_png = OUT_DIR / f"{skin_id}.png"
        url = QUrl.fromLocalFile(str(tmp_html))
        print(f"[snap] {i+1:2d}/{len(skin_dirs)} {skin_id:24s} loading {tmp_html.name}")

        def after_load(ok: bool, sid=skin_id, dst=out_png, tmp=tmp_html):
            try: view.loadFinished.disconnect(after_load)
            except Exception: pass
            if not ok:
                print(f"[snap]   {sid}: load failed")
                state["fail"] += 1
            else:
                pix = view.grab()
                if pix.save(str(dst), "PNG"):
                    print(f"[snap]   {sid}: saved {dst.name} ({dst.stat().st_size//1024} KB)")
                    state["ok"] += 1
                else:
                    print(f"[snap]   {sid}: grab/save failed")
                    state["fail"] += 1
            try: tmp.unlink(missing_ok=True)
            except Exception: pass
            state["idx"] += 1
            QTimer.singleShot(100, run_one)

        view.loadFinished.connect(after_load)
        view.load(url)
        # Safety net: if loadFinished never fires within RENDER_MS + 4s
        # (broken skin html), still try to grab + move on.
        def safety_grab(sid=skin_id, dst=out_png, tmp=tmp_html):
            if state["idx"] != i: return  # already moved on
            print(f"[snap]   {sid}: safety grab (load slow)")
            try: view.loadFinished.disconnect(after_load)
            except Exception: pass
            pix = view.grab()
            pix.save(str(dst), "PNG")
            state["fail"] += 1
            try: tmp.unlink(missing_ok=True)
            except Exception: pass
            state["idx"] += 1
            QTimer.singleShot(100, run_one)
        QTimer.singleShot(RENDER_MS + 8000, safety_grab)

    # Defer the actual rendering to after loadFinished fires — and we want to
    # WAIT after load before grabbing, so wrap after_load to settle.
    orig_run = run_one
    def run_one_with_settle():
        i = state["idx"]
        if i >= len(skin_dirs):
            state["done"] = True
            QApplication.quit()
            return
        skin_dir = skin_dirs[i]
        skin_id = skin_dir.name[:-len(".skin")]
        tmp_html = skin_dir / "_snap_index.html"
        try:
            prepare_skin_html(skin_dir, tmp_html)
        except Exception as e:
            print(f"[snap] {skin_id}: prepare failed: {e}")
            state["fail"] += 1
            state["idx"] += 1
            QTimer.singleShot(50, run_one_with_settle)
            return

        out_png = OUT_DIR / f"{skin_id}.png"
        url = QUrl.fromLocalFile(str(tmp_html))
        print(f"[snap] {i+1:2d}/{len(skin_dirs)} {skin_id:24s}")

        captured = {"done": False}
        def do_grab(label):
            if captured["done"]: return
            captured["done"] = True
            pix = view.grab()
            if pix.save(str(out_png), "PNG"):
                kb = out_png.stat().st_size // 1024
                print(f"[snap]   {skin_id}: saved ({label}) {kb} KB")
                state["ok"] += 1
            else:
                print(f"[snap]   {skin_id}: save failed ({label})")
                state["fail"] += 1
            try: tmp_html.unlink(missing_ok=True)
            except Exception: pass
            state["idx"] += 1
            QTimer.singleShot(150, run_one_with_settle)

        def after_load(ok: bool):
            try: view.loadFinished.disconnect(after_load)
            except Exception: pass
            if not ok:
                print(f"[snap]   {skin_id}: load failed")
                do_grab("load-failed")
                return
            QTimer.singleShot(RENDER_MS, lambda: do_grab("settled"))

        view.loadFinished.connect(after_load)
        view.load(url)
        QTimer.singleShot(RENDER_MS + 10000, lambda: do_grab("safety"))

    QTimer.singleShot(500, run_one_with_settle)
    app.exec()

    print(f"\n[snap] ok={state['ok']} fail={state['fail']}")
    if state["ok"] > 0:
        build_contact_sheet()
    return 0 if state["fail"] == 0 else 1


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw, ImageFont
    pngs = sorted(OUT_DIR.glob("*.png"))
    pngs = [p for p in pngs if not p.name.startswith("_")]
    if not pngs: return
    cols = 4
    cell_w, cell_h = 620, 940
    pad = 12
    rows = (len(pngs) + cols - 1) // cols
    W = pad + cols * (cell_w + pad)
    H = pad + rows * (cell_h + pad)
    sheet = Image.new("RGB", (W, H), (28, 28, 32))
    draw = ImageDraw.Draw(sheet)
    try: font = ImageFont.truetype("arial.ttf", 18)
    except OSError: font = ImageFont.load_default()
    for i, p in enumerate(pngs):
        r, c = divmod(i, cols)
        x = pad + c * (cell_w + pad)
        y = pad + r * (cell_h + pad)
        try:
            im = Image.open(p)
            im.thumbnail((cell_w - 4, cell_h - 40))
            sheet.paste(im, (x + (cell_w - im.width) // 2, y + 30))
        except Exception:
            draw.text((x + 8, y + 30), f"FAIL {p.name}", fill=(255, 80, 80), font=font)
        draw.text((x + 8, y + 4), p.stem, fill=(220, 220, 220), font=font)
    out = OUT_DIR / "_contact_sheet.png"
    sheet.save(out, quality=88)
    print(f"[snap] contact sheet: {out.relative_to(REPO_ROOT)}  ({W}x{H})")


if __name__ == "__main__":
    sys.exit(main())
