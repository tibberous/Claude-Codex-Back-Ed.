"""
cdp_minicomputer.py — One-class CDP harness for offscreen Chromium control.

Purpose:
    Generalize the CDP pattern already proven in start.py's --library extractor
    (chatgpt.com cookie/profile + `--remote-debugging-port=N` +
    `Page.captureScreenshot` + `Input.dispatchMouseEvent`). One class, one chrome
    instance, one CDP websocket, one persistent profile dir.

Built so the GPT-4o vision pilot (tools/gpt_vision_pilot.py) can drive ANY
chat bridge target (chatgpt.com / grok.com / gemini.google.com /
copilot.microsoft.com / claude.ai) end-to-end via screenshot + click + type
without touching the QtWebEngine bridge in app.py.

Hard rules (from CLAUDE.md memories):
    * Persistent --user-data-dir per target so login cookies survive restart.
    * Offscreen via --window-position=-32000,-32000 (NOT --headless: many
      target sites detect headless and gate features).
    * `suppress_origin=True` on the websocket — Chrome rejects WS handshakes
      from a missing/wrong Origin and gives 403 otherwise.
    * Per-instance websocket recv-timeout of 600s; CDP screenshots over a
      slow page can stall a default 30s recv.
    * NEVER inject credentials via JS — pilot drives keyboard/mouse only.

Requires: `websocket-client` (already in repo deps).
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

try:
    import websocket  # websocket-client
except ImportError as _exc:  # pragma: no cover — surfaced at construct-time
    raise SystemExit(
        "cdp_minicomputer requires websocket-client. Install: pip install websocket-client"
    ) from _exc


# --- Chrome discovery ------------------------------------------------------
_CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Users\moren\AppData\Local\Google\Chrome\Application\chrome.exe",
)


def _findChromeExe() -> str:
    for c in _CHROME_PATHS:
        if Path(c).is_file():
            return c
    raise FileNotFoundError(
        "chrome.exe not found in standard locations. Install Chrome or pass a path."
    )


# --- Virtual-key map for Input.dispatchKeyEvent ----------------------------
# Windows VK codes + W3C key names. Chrome uses windowsVirtualKeyCode +
# the `key` and `code` strings for input synthesis.
_KEY_MAP: dict[str, dict[str, Any]] = {
    "enter":     {"key": "Enter",      "code": "Enter",     "vk": 0x0D, "text": "\r"},
    "return":    {"key": "Enter",      "code": "Enter",     "vk": 0x0D, "text": "\r"},
    "tab":       {"key": "Tab",        "code": "Tab",       "vk": 0x09, "text": "\t"},
    "esc":       {"key": "Escape",     "code": "Escape",    "vk": 0x1B},
    "escape":    {"key": "Escape",     "code": "Escape",    "vk": 0x1B},
    "backspace": {"key": "Backspace",  "code": "Backspace", "vk": 0x08},
    "back":      {"key": "Backspace",  "code": "Backspace", "vk": 0x08},
    "delete":    {"key": "Delete",     "code": "Delete",    "vk": 0x2E},
    "del":       {"key": "Delete",     "code": "Delete",    "vk": 0x2E},
    "space":     {"key": " ",          "code": "Space",     "vk": 0x20, "text": " "},
    "up":        {"key": "ArrowUp",    "code": "ArrowUp",   "vk": 0x26},
    "down":      {"key": "ArrowDown",  "code": "ArrowDown", "vk": 0x28},
    "left":      {"key": "ArrowLeft",  "code": "ArrowLeft", "vk": 0x25},
    "right":     {"key": "ArrowRight", "code": "ArrowRight","vk": 0x27},
    "home":      {"key": "Home",       "code": "Home",      "vk": 0x24},
    "end":       {"key": "End",        "code": "End",       "vk": 0x23},
    "pgup":      {"key": "PageUp",     "code": "PageUp",    "vk": 0x21},
    "pgdn":      {"key": "PageDown",   "code": "PageDown",  "vk": 0x22},
}
for _i in range(1, 13):
    _KEY_MAP[f"f{_i}"] = {"key": f"F{_i}", "code": f"F{_i}", "vk": 0x70 + _i - 1}


class MiniComputer:
    """A single offscreen Chromium tab driven over CDP. One per chat target.

    Lifecycle: launch() -> attach() -> [screenshot/click/type/eval] -> close().
    Use as a context manager for guaranteed cleanup.
    """

    def __init__(
        self,
        target: str,
        profile_dir: Path,
        cdp_port: int,
        start_url: str,
        offscreen: bool = True,
        recv_timeout_s: int = 600,
    ) -> None:
        self.target = str(target or "").strip().lower() or "default"
        self.profile_dir = Path(profile_dir).resolve()
        self.cdp_port = int(cdp_port)
        self.start_url = str(start_url or "about:blank")
        self.offscreen = bool(offscreen)
        self.recv_timeout_s = int(recv_timeout_s)
        self.proc: subprocess.Popen | None = None
        self.ws: websocket.WebSocket | None = None
        self._msg_id = 0
        self._page_target_id: str = ""

    # --- launch / attach ---------------------------------------------------
    def launch(self) -> None:
        """Spawn chrome.exe with --remote-debugging-port. Idempotent: if CDP
        is already alive on the configured port, attach to it rather than
        spawning a second instance (single-profile-lock rule)."""
        if self._cdpAlive():
            return
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        chrome = _findChromeExe()
        cmd = [
            chrome,
            f"--remote-debugging-port={self.cdp_port}",
            f"--user-data-dir={self.profile_dir}",
            "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-sync",
            # Chrome 127+ App-Bound Encryption — same flags as the proven
            # --library extractor path in start.py:
            "--password-store=basic",
            "--disable-features=LockProfileCookieDatabase",
        ]
        if self.offscreen:
            cmd += ["--window-position=-32000,-32000", "--window-size=1400,1000"]
        else:
            cmd += ["--window-size=1400,1000"]
        cmd.append(self.start_url)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Wait up to 30s for CDP to come up.
        deadline = time.time() + 30
        while time.time() < deadline:
            if self._cdpAlive():
                return
            time.sleep(0.5)
        raise RuntimeError(f"Chrome launched (pid={self.proc.pid}) but CDP {self.cdp_port} never opened")

    def _cdpAlive(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json/version", timeout=2) as r:
                r.read(1)
            return True
        except Exception:
            return False

    def attach(self) -> None:
        """Connect a websocket to the first page-target."""
        if self.ws is not None:
            return
        # Find first page target
        with urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json", timeout=5) as r:
            targets = json.loads(r.read().decode("utf-8"))
        page = next((t for t in targets if t.get("type") == "page"), None)
        if page is None or not page.get("webSocketDebuggerUrl"):
            raise RuntimeError("CDP returned no page-target with a webSocketDebuggerUrl")
        self._page_target_id = page.get("id", "")
        ws = websocket.WebSocket()
        # suppress_origin avoids the 403 from chrome when Origin header is bad.
        ws.connect(page["webSocketDebuggerUrl"], suppress_origin=True)
        ws.settimeout(self.recv_timeout_s)
        self.ws = ws
        # Enable the domains we actually use.
        self._send("Network.enable")
        self._send("Page.enable")
        self._send("Runtime.enable")
        self._send("DOM.enable")

    # --- low-level RPC -----------------------------------------------------
    def _send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.ws is None:
            raise RuntimeError("MiniComputer.attach() must be called before _send")
        self._msg_id += 1
        my_id = self._msg_id
        payload = {"id": my_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(payload))
        # Drain until we find our reply (CDP interleaves events with replies).
        while True:
            raw = self.ws.recv()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("id") == my_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method} failed: {msg['error']}")
                return msg.get("result", {})
            # else: event — ignore

    # --- screenshots -------------------------------------------------------
    def screenshot(self) -> bytes:
        """Return the visible viewport as PNG bytes."""
        result = self._send("Page.captureScreenshot", {"format": "png"})
        b64 = result.get("data", "")
        if not b64:
            raise RuntimeError("Page.captureScreenshot returned empty data")
        return base64.b64decode(b64)

    def screenshot_b64(self) -> str:
        """Return the visible viewport as base64 PNG (ready for OpenAI vision)."""
        result = self._send("Page.captureScreenshot", {"format": "png"})
        return result.get("data", "")

    def screenshot_to_file(self, path: str | Path) -> Path:
        """Write a screenshot PNG to `path` and return the absolute path."""
        out = Path(path).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self.screenshot())
        return out

    # --- input synthesis ---------------------------------------------------
    def click_xy(self, x: float, y: float, button: str = "left", clicks: int = 1) -> None:
        """Move + press + release at pixel coordinates."""
        params_base = {"x": float(x), "y": float(y), "button": button, "clickCount": int(clicks)}
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mouseMoved"})
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mousePressed"})
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mouseReleased"})

    def type_text(self, text: str) -> None:
        """Type characters one-at-a-time so React's onChange handlers fire."""
        for ch in str(text):
            # rawKeyDown + char + keyUp — React inputs need the `char` event
            # to fire the synthetic onChange.
            self._send("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "text": ch,
                "key": ch,
                "unmodifiedText": ch,
            })
            self._send("Input.dispatchKeyEvent", {
                "type": "char",
                "text": ch,
                "key": ch,
                "unmodifiedText": ch,
            })
            self._send("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "key": ch,
            })

    def press_key(self, name: str) -> None:
        """Press a named key like Enter / Tab / Esc / Backspace / F5."""
        key = str(name or "").strip().lower()
        spec = _KEY_MAP.get(key)
        if spec is None:
            raise ValueError(f"Unknown key name {name!r}. Known: {sorted(_KEY_MAP.keys())}")
        down = {"type": "rawKeyDown", "key": spec["key"], "code": spec["code"],
                "windowsVirtualKeyCode": spec["vk"], "nativeVirtualKeyCode": spec["vk"]}
        up = {"type": "keyUp", "key": spec["key"], "code": spec["code"],
              "windowsVirtualKeyCode": spec["vk"], "nativeVirtualKeyCode": spec["vk"]}
        if "text" in spec:
            down["text"] = spec["text"]
            down["unmodifiedText"] = spec["text"]
        self._send("Input.dispatchKeyEvent", down)
        self._send("Input.dispatchKeyEvent", up)

    def scroll(self, dx: int, dy: int, x: int = 700, y: int = 500) -> None:
        """Mouse-wheel scroll at (x,y) by (dx,dy) pixels."""
        self._send("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": float(x), "y": float(y),
            "deltaX": float(dx), "deltaY": float(dy),
        })

    # --- navigation / introspection ----------------------------------------
    def navigate(self, url: str) -> None:
        self._send("Page.navigate", {"url": str(url)})

    def eval_js(self, expr: str, await_promise: bool = True) -> Any:
        """Runtime.evaluate with returnByValue + awaitPromise."""
        result = self._send("Runtime.evaluate", {
            "expression": str(expr),
            "returnByValue": True,
            "awaitPromise": bool(await_promise),
        })
        res = result.get("result", {}) or {}
        if res.get("type") == "undefined":
            return None
        return res.get("value")

    def final_url(self) -> str:
        try:
            return str(self.eval_js("location.href") or "")
        except Exception:
            return ""

    def page_title(self) -> str:
        try:
            return str(self.eval_js("document.title") or "")
        except Exception:
            return ""

    def body_text(self, max_chars: int = 5000) -> str:
        try:
            return str(self.eval_js(f"document.body && document.body.innerText ? document.body.innerText.slice(0, {int(max_chars)}) : ''") or "")
        except Exception:
            return ""

    def viewport_size(self) -> tuple[int, int]:
        try:
            wh = self.eval_js("[window.innerWidth, window.innerHeight]") or [0, 0]
            return int(wh[0]), int(wh[1])
        except Exception:
            return 0, 0

    def wait_ms(self, ms: int) -> None:
        time.sleep(max(0, int(ms)) / 1000.0)

    # --- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        try:
            if self.ws is not None:
                self.ws.close()
        except Exception:
            pass
        self.ws = None
        # Don't kill chrome on close — bridge wants the profile/session to
        # persist across attach/detach cycles. Only kill if WE spawned it AND
        # the caller asked via terminate().

    def terminate(self) -> None:
        """Close the websocket AND kill chrome. Use on shutdown."""
        self.close()
        if self.proc is not None:
            try:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            except Exception:
                pass
        self.proc = None

    # --- context manager ---------------------------------------------------
    def __enter__(self) -> "MiniComputer":
        self.launch()
        self.attach()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


__all__ = ["MiniComputer"]
