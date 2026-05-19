"""nn4_screenshot.py — render the NN4-themed browser chrome offscreen + PNG it.

Loads `panel/nn4-browser.html` in a hidden QWebEngineView, lets the page
render for a couple seconds, then `view.grab()` -> PNG to disk. Used to
verify the NN4 chrome looks right before wiring it as the visible host
for a GPT-driven agent loop.

Usage:
    python tools/nn4_screenshot.py
    -> writes C:/Users/moren/Desktop/Claude Codex Black/logs/nn4_preview.png
"""
from __future__ import annotations

import sys
from pathlib import Path

# Note: do NOT use QT_QPA_PLATFORM=offscreen here. QtWebEngine paints
# nothing under the `offscreen` platform — view.grab() returns a blank
# image. Use the default Windows platform but never call view.show();
# the WA_DontShowOnScreen flag below keeps the window off the taskbar
# while still letting Chromium paint into the backing store so grab()
# captures the real rendered chrome.

from PySide6.QtCore import QUrl, QTimer, Qt
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

REPO_ROOT  = Path(__file__).resolve().parent.parent
NN4_HTML   = REPO_ROOT / "panel" / "nn4-browser.html"
OUT_PNG    = REPO_ROOT / "logs" / "nn4_preview.png"
WIDTH      = 1024
HEIGHT     = 768
RENDER_MS  = 3000     # how long to let the SPA inside settle before grab

def main() -> int:
    if not NN4_HTML.is_file():
        print(f"[nn4-screenshot] missing {NN4_HTML}", file=sys.stderr)
        return 2

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)

    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(WIDTH, HEIGHT)
    # WA_DontShowOnScreen + setAttribute keeps the window off the taskbar
    # but lets the windowing system create a backing store Chromium can
    # paint into. Without this, grab() returns a blank pixmap.
    view.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen, True)
    view.show()

    grabbed = {"done": False, "ok": False}

    def grab_now() -> None:
        try:
            pix = view.grab()
            ok = pix.save(str(OUT_PNG), "PNG")
            grabbed["ok"] = bool(ok)
            sz = OUT_PNG.stat().st_size if OUT_PNG.exists() else 0
            print(f"[nn4-screenshot] saved {OUT_PNG}  ok={ok}  bytes={sz}")
        except Exception as exc:
            print(f"[nn4-screenshot] grab failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        finally:
            grabbed["done"] = True
            QTimer.singleShot(50, app.quit)

    def on_loaded(ok: bool) -> None:
        print(f"[nn4-screenshot] loadFinished ok={ok}  url={view.url().toString()}")
        # Let the page finish painting (NN4 has CSS gradients + fake widgets).
        QTimer.singleShot(RENDER_MS, grab_now)

    view.loadFinished.connect(on_loaded)
    view.load(QUrl.fromLocalFile(str(NN4_HTML)))

    # Hard time-out — if loadFinished never fires we still bail.
    QTimer.singleShot(RENDER_MS + 5000, lambda: (grab_now() if not grabbed["done"] else None))

    app.exec()
    return 0 if grabbed["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
