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

from PySide6.QtCore import (
    QUrl, QTimer, Qt, QObject, QPoint, Slot, Signal,
)
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtTest import QTest

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_W = 1280
DEFAULT_H = 800

# Shared cookie jar location with the bridge service. `start.py --library
# auth-save` writes here after decrypting Chrome's v10 DPAPI cookies. The
# bridge seeds its profile from this file at boot; the NN4 harness now does
# the same so a single auth-save unlocks both paths.
_LIBRARY_CACHE_DIR = Path.home() / ".claude" / "projects" / "C--Users-moren" / "library-cache"
_AUTH_COOKIES_PATH = _LIBRARY_CACHE_DIR / "auth_cookies.json"
# NN4_PROFILE_DIR env var lets the claude_login_orchestrator point each
# spawn at its own per-account profile dir (bridge_profiles/claude/<slug>/).
# Without it we fall back to the original shared library-cache profile.
_NN4_PROFILE_DIR_ENV = os.environ.get("NN4_PROFILE_DIR", "").strip()
if _NN4_PROFILE_DIR_ENV:
    _NN4_PROFILE_DIR = Path(_NN4_PROFILE_DIR_ENV)
else:
    _NN4_PROFILE_DIR = _LIBRARY_CACHE_DIR / "nn4-profile"


def _seedChatgptCookiesFromJson(profile, cookies_json_path) -> tuple[int, int]:
    """Inject cookies from auth_cookies.json into a QWebEngineProfile.

    Mirrors app.py:_seedChatgptCookiesFromJson but inlined to avoid pulling
    the heavy bridge-service module into this lightweight harness. Returns
    (injected, total). Never raises.
    """
    if profile is None or cookies_json_path is None:
        return (0, 0)
    try:
        path = Path(str(cookies_json_path))
        if not path.is_file():
            return (0, 0)
        try:
            jar = json.loads(path.read_text(encoding="utf-8"))
        except Exception as err:
            print(f"[nn4:cookie-seed] malformed {path.name}: {type(err).__name__}: {err}", flush=True)
            return (0, 0)
        if not isinstance(jar, list) or not jar:
            return (0, 0)
        from PySide6.QtNetwork import QNetworkCookie
        from PySide6.QtCore import QByteArray, QDateTime
        store = profile.cookieStore()
        injected = 0
        for entry in jar:
            try:
                name = str(entry.get("name") or "")
                val = str(entry.get("value") or "")
                if not name or not val:
                    continue
                ck = QNetworkCookie(QByteArray(name.encode("utf-8")), QByteArray(val.encode("utf-8")))
                dom = str(entry.get("domain") or "")
                if dom:
                    ck.setDomain(dom)
                ck.setPath(str(entry.get("path") or "/"))
                ck.setSecure(bool(entry.get("secure", False)))
                ck.setHttpOnly(bool(entry.get("httpOnly", False)))
                exp = entry.get("expires", -1)
                try:
                    exp = float(exp)
                except Exception:
                    exp = -1
                if exp and exp > 0:
                    ck.setExpirationDate(QDateTime.fromSecsSinceEpoch(int(exp)))
                host = dom.lstrip(".") or "chatgpt.com"
                store.setCookie(ck, QUrl(f"https://{host}/"))
                injected += 1
            except Exception:
                continue
        print(f"[nn4:cookie-seed] injected {injected}/{len(jar)} cookies from {path.name}", flush=True)
        return (injected, len(jar))
    except Exception as err:
        print(f"[nn4:cookie-seed] unexpected: {type(err).__name__}: {err}", flush=True)
        return (0, 0)


# Same scraper the bridge service uses (app.py:_LIBRARY_SCRAPER_JS). Kept
# inline so the harness has zero runtime dependency on the bridge module.
# If the bridge scraper evolves, mirror the change here.
_LIBRARY_SCRAPER_JS = r"""
(function(){
    const result = { ok: true, files: [], wall: {}, debug: {} };
    try {
        const url = String(location.href || '');
        const bodyText = String(document.body ? document.body.innerText || '' : '').toLowerCase();
        const explicitAuthPath = /\/auth\/login|\/login|\/auth$/.test(url);
        const loginCtas = /(log in to chatgpt|sign up|continue with google|continue with apple|by messaging chatgpt, you agree)/.test(bodyText);
        const expectedLibrary = (window.location.pathname || '').toLowerCase().includes('library');
        const headerEl = document.querySelector('h1, h2');
        const headerText = headerEl ? String(headerEl.innerText || '').toLowerCase() : '';
        const headerSaysLibrary = /library|files/.test(headerText);
        if (explicitAuthPath || loginCtas || (!expectedLibrary && !headerSaysLibrary)) {
            result.ok = false;
            result.reason = 'login-required';
            result.wall = { url: url, hint: 'log in via SuperGrok bridge first', headerText: headerText.slice(0, 120), bodyExcerpt: bodyText.slice(0, 200) };
            return JSON.stringify(result);
        }
        const rowSelectors = [
            'main [role="row"]',
            'main [data-testid*="library" i] [role="row"]',
            'main [data-testid*="library" i] li',
            'main [data-testid*="library" i] a[href*="/c/"]',
            'main table tr',
            'main ul > li:has(a)',
            'main [class*="row" i]:has(a)',
            'main a[href^="/c/"]',
        ];
        let rows = [];
        for (const sel of rowSelectors) {
            try {
                const found = Array.from(document.querySelectorAll(sel));
                if (found.length) { rows = found; result.debug.matchedSelector = sel; break; }
            } catch (_) {}
        }
        result.debug.candidateRowCount = rows.length;
        const seen = new Set();
        for (const row of rows) {
            try {
                if (!row || !row.getBoundingClientRect) continue;
                const rect = row.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const text = String(row.innerText || row.textContent || '').trim();
                if (!text || seen.has(text)) continue;
                seen.add(text);
                let name = '';
                const titleEl = row.querySelector('[data-testid*="title" i], h1, h2, h3, h4, .text-token-text-primary, [class*="title" i]');
                if (titleEl && (titleEl.innerText || titleEl.textContent)) {
                    name = String(titleEl.innerText || titleEl.textContent).trim();
                }
                if (!name) {
                    const firstLine = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
                    name = firstLine || '';
                }
                if (!name) continue;
                const link = row.querySelector('a[href]');
                const href = link ? String(link.getAttribute('href') || '') : '';
                const sizeMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)\b/i);
                const dateMatch = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8} \d{1,2},? \d{4}|[A-Z][a-z]{2,8} \d{1,2})\b/);
                const typeMatch = text.match(/\b(pdf|docx?|xlsx?|pptx?|csv|txt|md|json|png|jpe?g|gif|webp|mp4|mov|wav|mp3|zip|html?)\b/i);
                result.files.push({
                    name: name,
                    href: href,
                    size: sizeMatch ? sizeMatch[0] : '',
                    modified: dateMatch ? dateMatch[0] : '',
                    type: typeMatch ? typeMatch[0].toLowerCase() : '',
                    rawText: text.slice(0, 400),
                });
            } catch (_) {}
        }
        result.debug.scrapedFileCount = result.files.length;
        result.url = url;
        result.title = String(document.title || '');
        return JSON.stringify(result);
    } catch (error) {
        return JSON.stringify({ ok: false, reason: 'scraper-exception', error: String(error && error.message || error) });
    }
})();
"""


class AgentBrowser:
    """Holds the long-running QWebEngineView + dispatch table for actions.

    All public methods run on the Qt main thread (via the dispatch shim).
    The TCP server lives on a worker thread; each request is marshaled to
    the main thread via QTimer.singleShot(0, ...) so we never touch Qt
    objects off-thread.
    """

    def __init__(self, width: int = DEFAULT_W, height: int = DEFAULT_H,
                 start_url: str = "https://chatgpt.com/",
                 persistent: bool = True) -> None:
        # Persistent QWebEngineProfile keeps cookies/localStorage across runs
        # AND lets us cookie-seed from auth_cookies.json before first nav, so
        # chatgpt.com/library loads as a logged-in DOM. See the bridge's
        # _seedChatgptCookiesFromJson for the matching path in app.py.
        if persistent:
            _NN4_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
            self.profile = QWebEngineProfile("CBE-NN4-Persistent", None)
            self.profile.setPersistentStoragePath(str(_NN4_PROFILE_DIR))
            self.profile.setCachePath(str(_NN4_PROFILE_DIR / "cache"))
            try:
                self.profile.setPersistentCookiesPolicy(
                    QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
                )
            except Exception:
                pass
            try:
                _seedChatgptCookiesFromJson(self.profile, _AUTH_COOKIES_PATH)
            except Exception as err:
                print(f"[nn4] cookie seed failed: {type(err).__name__}: {err}", flush=True)
            self.page = QWebEnginePage(self.profile)
            self.view = QWebEngineView()
            self.view.setPage(self.page)
        else:
            self.profile = None
            self.page = None
            self.view = QWebEngineView()
        self.view.resize(width, height)
        # Chromium's compositor needs a real native window surface to render
        # pages; WA_DontShowOnScreen destroys that surface and the renderer
        # process produces blank frames forever. Position the window far
        # off-screen instead so it stays invisible to the user but Qt gives
        # it a real HWND that Chromium can paint into. Tool flag + no
        # taskbar so the user never sees an icon flicker either.
        self.view.setWindowFlag(Qt.WindowType.Tool, True)
        self.view.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        self.view.move(-32000, -32000)
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

    def navigate(self, url: str, wait_ms: int = 8000) -> dict:
        """Navigate and block until loadFinished (or wait_ms elapses).

        QWebEngineView.load() is fire-and-forget; without waiting the next
        action sees a half-rendered page (or the previous page). Pump the
        Qt event loop in a tight loop and return once Chromium signals
        loadFinished or the wait_ms budget runs out. Pass wait_ms=0 to
        keep the old fire-and-forget behavior.
        """
        if wait_ms <= 0:
            self.view.load(QUrl(url))
            return {"ok": True, "url": url, "loaded": False, "waited": False}
        load_state = {"done": False, "ok": False}
        def _on(ok: bool) -> None:
            load_state["ok"] = bool(ok)
            load_state["done"] = True
        try:
            self.view.loadFinished.connect(_on)
        except Exception:
            pass
        try:
            self.view.load(QUrl(url))
            deadline = time.time() + (max(0, int(wait_ms)) / 1000.0)
            while not load_state["done"] and time.time() < deadline:
                QApplication.processEvents()
                time.sleep(0.02)
        finally:
            try:
                self.view.loadFinished.disconnect(_on)
            except Exception:
                pass
        return {
            "ok": load_state["done"] and load_state["ok"],
            "url": self.view.url().toString(),
            "loaded": load_state["done"] and load_state["ok"],
            "timedOut": not load_state["done"],
        }

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

    def library_list(self, hydrate_ms: int = 3500, timeout_s: int = 45) -> dict:
        """Drop-in for the chatgpt python sidecar's `library-list` action.

        Navigates the persistent view to chatgpt.com/library, waits for the
        SPA to hydrate, runs the same DOM scraper the bridge service uses,
        and returns the parsed JSON. Cookies were seeded at __init__ from
        auth_cookies.json, so the page should render as logged-in. If not,
        the scraper returns reason='login-required' and the caller can
        prompt the user to re-run `--library auth-save` or `--library login`.
        """
        started = time.time()
        load_done = {"done": False, "ok": False}
        def _on_loaded(ok: bool) -> None:
            load_done["ok"] = bool(ok)
            load_done["done"] = True
        try:
            self.view.loadFinished.connect(_on_loaded)
        except Exception:
            pass
        self.view.load(QUrl("https://chatgpt.com/library"))
        deadline = started + max(5.0, float(timeout_s))
        while not load_done["done"] and time.time() < deadline:
            QApplication.processEvents()
            time.sleep(0.02)
        try:
            self.view.loadFinished.disconnect(_on_loaded)
        except Exception:
            pass
        if not load_done["done"]:
            return {"ok": False, "reason": "timeout", "phase": "load", "timeoutSeconds": int(timeout_s), "url": self.view.url().toString()}
        if not load_done["ok"]:
            return {"ok": False, "reason": "page-load-failed", "url": self.view.url().toString()}
        # Let the SPA hydrate. ChatGPT's library list is rendered client-side
        # after the shell paints; the scraper finds nothing if we run too early.
        hydrate_deadline = time.time() + max(0.0, float(hydrate_ms) / 1000.0)
        while time.time() < hydrate_deadline:
            QApplication.processEvents()
            time.sleep(0.02)
        scrape_slot = {"done": False, "raw": None}
        def _on_scrape(value):
            scrape_slot["raw"] = value
            scrape_slot["done"] = True
        try:
            self.view.page().runJavaScript(_LIBRARY_SCRAPER_JS, _on_scrape)
        except Exception as exc:
            return {"ok": False, "reason": "runjs-failed", "error": f"{type(exc).__name__}: {exc}"}
        scrape_deadline = time.time() + 10.0
        while not scrape_slot["done"] and time.time() < scrape_deadline:
            QApplication.processEvents()
            time.sleep(0.02)
        if not scrape_slot["done"]:
            return {"ok": False, "reason": "scrape-timeout", "url": self.view.url().toString()}
        raw = scrape_slot["raw"]
        try:
            if isinstance(raw, str):
                parsed = json.loads(raw)
            elif isinstance(raw, dict):
                parsed = raw
            else:
                parsed = {"ok": False, "reason": "scraper-bad-return", "raw": str(raw)[:500]}
        except Exception as exc:
            parsed = {"ok": False, "reason": "scraper-parse-error", "error": f"{type(exc).__name__}: {exc}", "raw": str(raw)[:500]}
        parsed.setdefault("elapsedSeconds", round(time.time() - started, 3))
        parsed.setdefault("via", "nn4_agent_browser")
        return parsed


# ----------------------------- TCP server -------------------------------

class MainThreadDispatcher(QObject):
    """Live on the Qt main thread; receive a callable + result-box via a
    cross-thread Signal, run the callable on the main thread.

    Why this exists: `QTimer.singleShot(0, fn)` invoked from a non-Qt
    worker thread does NOT marshal `fn` onto the main thread — it queues
    onto the *calling* thread's event loop, which is the worker (which has
    no event loop), so `fn` never runs. The action server then waits 90s
    and times out forever. This was the actual "pages not loading" bug
    seen from the caller's perspective: pages load fine in Chromium, but
    every action request just hangs.

    Using a `Signal` declared on a QObject that lives on the main thread
    gives us Qt's auto-connection semantics: cross-thread emit → queued
    connection → slot runs on the dispatcher's (main) thread.
    """
    runRequested = Signal(object, object)  # (fn, resultBox)

    def __init__(self) -> None:
        super().__init__()
        # Qt picks `QueuedConnection` automatically because emitter and
        # receiver live on different threads — but we declare it explicitly
        # so the intent is obvious to anyone reading.
        self.runRequested.connect(self._onRun, Qt.ConnectionType.QueuedConnection)

    @Slot(object, object)
    def _onRun(self, fn, box):
        try:
            box["value"] = fn()
        except Exception as exc:
            box["value"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            box["done"] = True


class ActionServer:
    """Threaded socket server; marshals each request onto the Qt main
    thread, waits for the result, sends it back. One connection at a time
    (browser state isn't reentrant)."""

    def __init__(self, port: int, browser: AgentBrowser, dispatcher: "MainThreadDispatcher") -> None:
        self.port = port
        self.browser = browser
        self.dispatcher = dispatcher
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

        # Build the actual work as a zero-arg callable; the dispatcher will
        # invoke it on the Qt main thread via a queued Signal connection.
        # Closures capture `req` / `action` / `self` by reference.
        browser = self.browser
        server_self = self
        def _work():
            if   action == "screenshot": return browser.screenshot(str(req.get("frame", "raw")))
            elif action == "navigate":
                return browser.navigate(
                    str(req.get("url", "")),
                    wait_ms=int(req.get("waitMs", req.get("wait_ms", 8000))),
                )
            elif action == "click":      return browser.click(int(req.get("x", 0)), int(req.get("y", 0)))
            elif action == "type":       return browser.type_text(str(req.get("text", "")))
            elif action == "scroll":     return browser.scroll(int(req.get("dy", 0)))
            elif action == "back":       return browser.back()
            elif action == "forward":    return browser.forward()
            elif action == "reload":     return browser.reload_page()
            elif action == "wait":       return browser.wait_ms(int(req.get("ms", 0)))
            elif action == "page_url":   return browser.page_url()
            elif action == "page_text":  return browser.page_text(int(req.get("max", 8192)))
            elif action == "page_html":  return browser.page_html(int(req.get("max", 32768)))
            elif action == "eval_js":    return browser.eval_js(str(req.get("js", "")))
            elif action == "library-list":
                return browser.library_list(
                    hydrate_ms=int(req.get("hydrateMs", 3500)),
                    timeout_s=int(req.get("timeoutSeconds", 45)),
                )
            elif action == "shutdown":
                server_self.shutdown_requested = True
                QTimer.singleShot(50, QApplication.instance().quit)
                return {"ok": True, "bye": True}
            else:
                return {"ok": False, "error": f"unknown action: {action!r}"}

        result = {"done": False, "value": None}
        # Cross-thread emit → queued connection → slot runs on main thread.
        self.dispatcher.runRequested.emit(_work, result)
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
    # The dispatcher MUST be constructed on the main (Qt) thread so its
    # `runRequested` Signal queues onto the main thread when emitted from
    # the socket worker threads. Do not move it.
    dispatcher = MainThreadDispatcher()
    server = ActionServer(port=args.port, browser=browser, dispatcher=dispatcher)
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
