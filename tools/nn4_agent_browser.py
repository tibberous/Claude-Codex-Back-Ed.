"""nn4_agent_browser.py — offscreen QtWebEngine agent harness, NN4-skinned.

Long-running hidden QWebEngineView. Exposes a newline-delimited JSON TCP
protocol so any agent (GPT-4o vision, Claude computer-use, a human via
curl/telnet, etc.) can drive a real browser session:

  > python tools/nn4_agent_browser.py [--port 9785] [--start-url https://...]

Protocol — send one JSON object per request, one JSON object back, each
newline-terminated. Stay connected for multiple actions or reconnect; the
view persists across connections, so cookies/session/history survive.

  {"action":"screenshot"}             -> {"ok":true,"png_b64":"...","w":1280,"h":800,"url":"..."}
  {"action":"navigate","url":"..."}   -> {"ok":true,"url":"..."}
  {"action":"click","x":int,"y":int}  -> {"ok":true}
  {"action":"type","text":"..."}      -> {"ok":true,"chars":N}
  {"action":"scroll","dy":int}        -> {"ok":true}
  {"action":"back"} / {"action":"forward"} / {"action":"reload"}
  {"action":"wait","ms":int}          -> {"ok":true,"slept_ms":N}
  {"action":"page_url"}               -> {"ok":true,"url":"..."}
  {"action":"page_text","max":N}      -> {"ok":true,"text":"...","truncated":bool}
  {"action":"page_html","max":N}      -> {"ok":true,"html":"...","truncated":bool}
  {"action":"eval_js","js":"..."}     -> {"ok":true,"result":<any>}
  {"action":"shutdown"}               -> {"ok":true} ; then exits

Bind: 127.0.0.1:<port> (default 9785). Single global view, single-threaded
event loop. All page interactions execute on the Qt main thread.

NN4 chrome rendering: the default `screenshot` returns the LIVE view PNG so
GPT-4o sees what it's actually driving. For the "wtf is Netscape Navigator
4" effect, pass `{"action":"screenshot","frame":"nn4"}` and we composite a
Netscape chrome around the page bitmap. (TODO: chrome composite — for v1 we
return raw view; v2 layers the NN4 PNG strip.)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import sys
import threading
import time
from pathlib import Path

# Chromium DevTools remote debugging — must be set BEFORE QApplication is
# created. The agent gets a normal Chrome DevTools UI at
# http://127.0.0.1:<port>/ that can inspect / set breakpoints / poke the
# console / view the network panel. Default port 9786 to avoid colliding
# with the action TCP server on 9785.
_DEVTOOLS_DEFAULT = int(os.environ.get("NN4_AGENT_DEVTOOLS_PORT", "9786") or "9786")
os.environ.setdefault("QTWEBENGINE_REMOTE_DEBUGGING", str(_DEVTOOLS_DEFAULT))
# Chromium flags inherited by QtWebEngine. Suppress USB key prompts; allow
# all features the agent might need to drive a real session.
os.environ.setdefault(
    "QTWEBENGINE_CHROMIUM_FLAGS",
    "--disable-features=WebAuthenticationCableV2,WebAuthenticationModernUI,WebAuthentication,WebHID,WebUsb,U2F "
    "--password-store=basic "
)

from PySide6.QtCore import QUrl, QTimer, Qt, QObject, QEvent, QPoint, Slot
from PySide6.QtGui import QImage, QGuiApplication, QMouseEvent, QKeyEvent
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtTest import QTest

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_W = 1280
DEFAULT_H = 800


class AgentBrowser:
    """Holds the long-running QWebEngineView + dispatch table for actions.

    All public methods run on the Qt main thread (via the dispatch shim).
    The TCP server lives on a worker thread; each request is marshaled to
    the main thread via QTimer.singleShot(0, ...) so we never touch Qt
    objects off-thread.
    """

    def __init__(self, width: int = DEFAULT_W, height: int = DEFAULT_H,
                 start_url: str = "https://chatgpt.com/") -> None:
        self.view = QWebEngineView()
        self.view.resize(width, height)
        # WA_DontShowOnScreen lets us grab without surface visibility.
        self.view.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen, True)
        self.view.show()
        # Auto-inject jQuery into every page after load + expose a helper
        # `__cbeConsole(cmd)` that evals user JS with jQuery available, so
        # the agent's `console` action has a uniform surface across sites.
        self.view.loadFinished.connect(self._on_load_finished)
        self.view.load(QUrl(start_url))

    def _on_load_finished(self, ok: bool) -> None:
        if not ok:
            return
        inject = """
        (function(){
          if (window.__cbeJqInjected) return;
          window.__cbeJqInjected = true;
          if (typeof window.jQuery === 'undefined' || typeof window.$ === 'undefined') {
            var s = document.createElement('script');
            s.src = 'https://code.jquery.com/jquery-3.7.1.min.js';
            s.async = false;
            s.onload  = function(){ window.__cbeJqReady = true; };
            s.onerror = function(){ window.__cbeJqReady = false; window.__cbeJqError = 'jquery cdn blocked'; };
            (document.head || document.documentElement).appendChild(s);
          } else {
            window.__cbeJqReady = true;
          }
          window.__cbeConsole = function(cmd) {
            try { return (0, eval)(cmd); }
            catch (e) { return { __cbeError: String(e && e.message || e), stack: e && e.stack }; }
          };
        })();
        """
        try:
            self.view.page().runJavaScript(inject)
        except Exception:
            pass

    # ---- actions ---------------------------------------------------------

    def screenshot(self, frame: str = "raw") -> dict:
        pix = self.view.grab()
        from PySide6.QtCore import QBuffer, QIODevice
        buf = QBuffer()
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        pix.save(buf, "PNG")
        png_b64 = base64.b64encode(bytes(buf.data())).decode("ascii")
        return {
            "ok": True,
            "png_b64": png_b64,
            "w": pix.width(),
            "h": pix.height(),
            "url": self.view.url().toString(),
            "frame": frame,
        }

    def navigate(self, url: str) -> dict:
        self.view.load(QUrl(url))
        return {"ok": True, "url": url}

    def click(self, x: int, y: int) -> dict:
        # Use QTest to synthesize a real mouse click at viewport-relative
        # coordinates. Chromium picks it up via its Qt event filter.
        target = self.view.focusProxy() or self.view
        pt = QPoint(int(x), int(y))
        QTest.mouseClick(target, Qt.MouseButton.LeftButton,
                         Qt.KeyboardModifier.NoModifier, pt)
        return {"ok": True}

    def type_text(self, text: str) -> dict:
        target = self.view.focusProxy() or self.view
        for ch in text:
            QTest.keyClick(target, ch)
        return {"ok": True, "chars": len(text)}

    def scroll(self, dy: int) -> dict:
        # Use JS to scroll because Qt wheel synthesis on a focusProxy is
        # finicky; window.scrollBy works on every site.
        self.view.page().runJavaScript(f"window.scrollBy(0, {int(dy)});")
        return {"ok": True}

    def back(self) -> dict:
        self.view.back()
        return {"ok": True}

    def forward(self) -> dict:
        self.view.forward()
        return {"ok": True}

    def reload_page(self) -> dict:
        self.view.reload()
        return {"ok": True}

    def page_url(self) -> dict:
        return {"ok": True, "url": self.view.url().toString()}

    def page_text(self, max_chars: int = 8192) -> dict:
        # runJavaScript is async; we need a sync wrapper. Use a busy-loop
        # tied to an event held in a dict.
        slot = {"done": False, "text": ""}
        def _on(value):
            slot["text"] = str(value or "")[:max_chars]
            slot["done"] = True
        self.view.page().runJavaScript("document.body && document.body.innerText || ''", _on)
        deadline = time.time() + 5.0
        while not slot["done"] and time.time() < deadline:
            QApplication.processEvents()
        return {"ok": True, "text": slot["text"], "truncated": len(slot["text"]) >= max_chars}

    def page_html(self, max_chars: int = 32768) -> dict:
        slot = {"done": False, "html": ""}
        def _on(value):
            slot["html"] = str(value or "")[:max_chars]
            slot["done"] = True
        self.view.page().runJavaScript("document.documentElement && document.documentElement.outerHTML || ''", _on)
        deadline = time.time() + 5.0
        while not slot["done"] and time.time() < deadline:
            QApplication.processEvents()
        return {"ok": True, "html": slot["html"], "truncated": len(slot["html"]) >= max_chars}

    def eval_js(self, js: str) -> dict:
        slot = {"done": False, "value": None}
        def _on(value):
            slot["value"] = value
            slot["done"] = True
        self.view.page().runJavaScript(js, _on)
        deadline = time.time() + 5.0
        while not slot["done"] and time.time() < deadline:
            QApplication.processEvents()
        return {"ok": True, "result": slot["value"]}

    def wait_ms(self, ms: int) -> dict:
        # Yield to the event loop while we wait so navigation continues to
        # progress. Returns when ms elapsed.
        target = time.time() + (max(0, int(ms)) / 1000.0)
        while time.time() < target:
            QApplication.processEvents()
            time.sleep(0.01)
        return {"ok": True, "slept_ms": int(ms)}


# ----------------------------- TCP server -------------------------------

class ActionServer:
    """Threaded socket server; marshals each request onto the Qt main
    thread, waits for the result, sends it back. One connection at a time
    (browser state isn't reentrant)."""

    def __init__(self, port: int, browser: AgentBrowser) -> None:
        self.port = port
        self.browser = browser
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(4)
        self.shutdown_requested = False

    def serve_forever(self) -> None:
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self) -> None:
        while not self.shutdown_requested:
            try:
                client, _addr = self.sock.accept()
            except OSError:
                break
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        client.settimeout(60.0)
        buf = b""
        try:
            while not self.shutdown_requested:
                chunk = client.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    reply = self._dispatch(line.decode("utf-8", errors="replace"))
                    client.sendall((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception as exc:
            try:
                client.sendall((json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}) + "\n").encode())
            except Exception:
                pass
        finally:
            try: client.close()
            except Exception: pass

    def _dispatch(self, raw: str) -> dict:
        try:
            req = json.loads(raw)
        except Exception as exc:
            return {"ok": False, "error": f"bad json: {exc}"}
        action = str(req.get("action", "")).lower()

        # Marshal to main thread via a sync barrier.
        result = {"done": False, "value": None}
        def _run_on_main():
            try:
                if   action == "screenshot": result["value"] = self.browser.screenshot(str(req.get("frame", "raw")))
                elif action == "navigate":   result["value"] = self.browser.navigate(str(req.get("url", "")))
                elif action == "click":      result["value"] = self.browser.click(int(req.get("x", 0)), int(req.get("y", 0)))
                elif action == "type":       result["value"] = self.browser.type_text(str(req.get("text", "")))
                elif action == "scroll":     result["value"] = self.browser.scroll(int(req.get("dy", 0)))
                elif action == "back":       result["value"] = self.browser.back()
                elif action == "forward":    result["value"] = self.browser.forward()
                elif action == "reload":     result["value"] = self.browser.reload_page()
                elif action == "wait":       result["value"] = self.browser.wait_ms(int(req.get("ms", 0)))
                elif action == "page_url":   result["value"] = self.browser.page_url()
                elif action == "page_text":  result["value"] = self.browser.page_text(int(req.get("max", 8192)))
                elif action == "page_html":  result["value"] = self.browser.page_html(int(req.get("max", 32768)))
                elif action == "eval_js":    result["value"] = self.browser.eval_js(str(req.get("js", "")))
                elif action == "shutdown":
                    result["value"] = {"ok": True, "bye": True}
                    self.shutdown_requested = True
                    QTimer.singleShot(50, QApplication.instance().quit)
                else:
                    result["value"] = {"ok": False, "error": f"unknown action: {action!r}"}
            except Exception as exc:
                result["value"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            finally:
                result["done"] = True

        QTimer.singleShot(0, _run_on_main)
        deadline = time.time() + 90.0
        while not result["done"] and time.time() < deadline:
            time.sleep(0.02)
        if not result["done"]:
            return {"ok": False, "error": "main-thread dispatch timeout (90s)"}
        return result["value"] or {"ok": False, "error": "no value"}


def main() -> int:
    parser = argparse.ArgumentParser(description="NN4 agent browser harness")
    parser.add_argument("--port",          type=int, default=9785,             help="TCP action server port (default 9785)")
    parser.add_argument("--devtools-port", type=int, default=_DEVTOOLS_DEFAULT, help="Chromium DevTools port (default 9786)")
    parser.add_argument("--width",         type=int, default=DEFAULT_W)
    parser.add_argument("--height",        type=int, default=DEFAULT_H)
    parser.add_argument("--start-url",     default="https://chatgpt.com/")
    args = parser.parse_args()

    # Re-set env in case CLI overrode the default — must happen before
    # QApplication for the loader to honor it.
    os.environ["QTWEBENGINE_REMOTE_DEBUGGING"] = str(args.devtools_port)

    app = QApplication(sys.argv)
    browser = AgentBrowser(width=args.width, height=args.height, start_url=args.start_url)
    server = ActionServer(port=args.port, browser=browser)
    server.serve_forever()

    print(f"[nn4-agent] action server : 127.0.0.1:{args.port}  (newline-JSON protocol)", flush=True)
    print(f"[nn4-agent] devtools URL  : http://127.0.0.1:{args.devtools_port}/", flush=True)
    print(f"[nn4-agent] start URL     : {args.start_url}", flush=True)
    print(f"[nn4-agent] viewport      : {args.width}x{args.height} (offscreen, paints into backing store)", flush=True)
    # Write a port file so callers can discover us without --port races.
    try:
        (REPO_ROOT / "logs").mkdir(parents=True, exist_ok=True)
        (REPO_ROOT / "logs" / "nn4_agent_port.txt").write_text(
            json.dumps({"action_port": args.port, "devtools_port": args.devtools_port, "pid": os.getpid()}),
            encoding="utf-8",
        )
    except Exception:
        pass

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
