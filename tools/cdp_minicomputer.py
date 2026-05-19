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
        # CDP packet log — every wire message in/out, timestamped + flushed
        # per line so it can be tailed live. Set up lazily on first _send.
        self._pkt_log: Any = None
        self._pkt_log_path: Path | None = None
        # Last-click feedback — drawn as a cyan crosshair + "you clicked here"
        # label on the NEXT gridded screenshot so GPT can see whether its
        # last action landed where it intended. None until the first click.
        self._last_click: tuple[float, float] | None = None
        self._last_click_kind: str = ""  # 'click', 'click_text', etc.

    def _openPacketLog(self) -> None:
        """Create the per-session CDP packet log under logs/cdp/."""
        if self._pkt_log is not None:
            return
        try:
            log_dir = Path(__file__).resolve().parent.parent / "logs" / "cdp"
            log_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            self._pkt_log_path = log_dir / f"{self.target}-{stamp}.log"
            self._pkt_log = open(self._pkt_log_path, "a", encoding="utf-8", buffering=1)
            self._pkt_log.write(f"# CDP packet log target={self.target} port={self.cdp_port} pid={getattr(self.proc,'pid','?')} start={stamp}\n")
            self._pkt_log.flush()
        except Exception:
            self._pkt_log = None

    def page_html(self, max_chars: int = 30000) -> str:
        """Return the live DOM HTML (scripts/styles/svg/meta stripped for
        signal). Sent to GPT alongside the screenshot+log so it has visual
        + structural ground truth — if the screenshot is ambiguous about
        an element's bounds, GPT can read exact text/aria-labels from HTML."""
        js = (
            "(function(){try{var d=document.documentElement.cloneNode(true);"
            "d.querySelectorAll('script,style,svg,noscript,link,meta').forEach(function(e){e.remove()});"
            "return d.outerHTML;}catch(e){return '';}})()"
        )
        try:
            result = self._send("Runtime.evaluate", {"expression": js, "returnByValue": True, "awaitPromise": True})
            html = str(((result or {}).get("result") or {}).get("value") or "")
        except Exception:
            return ""
        if len(html) > max_chars:
            html = html[:max_chars] + f"\n<!-- truncated, total {len(html)} chars -->"
        return html

    def click_text(self, text: str, exact: bool = False) -> dict[str, Any]:
        """Redundant path to click_xy: find the FIRST visible element whose
        text content matches `text` (case-insensitive contains by default,
        exact match if exact=True), JS-click it. Returns {ok, tag, rect}.
        Used as the fallback when coord-click misses — GPT picks whichever
        path the screenshot+HTML makes more reliable."""
        t = text.replace("\\", "\\\\").replace("'", "\\'")
        mode = "===" if exact else ".indexOf("
        if exact:
            cond = f"el.textContent.trim() === '{t}'"
        else:
            cond = f"el.textContent.toLowerCase().indexOf('{t.lower()}') >= 0"
        js = (
            "(function(){"
            "var all=document.querySelectorAll('button,a,input,textarea,[role=button],[contenteditable],[tabindex]');"
            "var hit=null;"
            f"for(var i=0;i<all.length;i++){{var el=all[i];if(!el)continue;"
            "var r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;"
            f"if({cond}){{hit=el;break;}}}}"
            "if(!hit){"
            "  var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT,null);"
            f"  var n;while((n=walker.nextNode())){{var rr=n.getBoundingClientRect();if(rr.width<2||rr.height<2)continue;if(n.children.length===0&&{cond.replace('el.','n.')}){{hit=n;break;}}}}"
            "}"
            "if(!hit) return JSON.stringify({ok:false,reason:'no element matched'});"
            "try{hit.focus&&hit.focus();}catch(e){}"
            "try{hit.click();}catch(e){return JSON.stringify({ok:false,reason:'click threw: '+e});}"
            "var rect=hit.getBoundingClientRect();"
            "return JSON.stringify({ok:true,tag:hit.tagName,rect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height},text:(hit.textContent||'').trim().slice(0,80)});"
            "})()"
        )
        try:
            r = self._send("Runtime.evaluate", {"expression": js, "returnByValue": True, "awaitPromise": True})
            val = ((r or {}).get("result") or {}).get("value") or ""
            try:
                parsed = json.loads(val) if val else {"ok": False, "reason": "empty result"}
            except Exception:
                return {"ok": False, "reason": f"unparseable: {val[:120]}"}
            # If we found + clicked an element, mark the center on the next
            # screenshot so GPT can see where click_text landed.
            if parsed.get("ok") and isinstance(parsed.get("rect"), dict):
                rect = parsed["rect"]
                cx = float(rect.get("x", 0)) + float(rect.get("w", 0)) / 2.0
                cy = float(rect.get("y", 0)) + float(rect.get("h", 0)) / 2.0
                self._last_click = (cx, cy)
                self._last_click_kind = "click_text"
            return parsed
        except Exception as e:
            return {"ok": False, "reason": f"{type(e).__name__}: {e}"}

    def read_packet_log_tail(self, max_lines: int = 80, max_chars: int = 8000) -> str:
        """Return the last N lines of THIS session's CDP packet log, trimmed
        to max_chars. Fed to GPT each turn alongside the screenshot so it can
        see causal context (clicks dispatched, network events that fired,
        replies from the page) — not just the visual frame."""
        if self._pkt_log_path is None or not self._pkt_log_path.exists():
            return ""
        try:
            try:
                if self._pkt_log is not None:
                    self._pkt_log.flush()
            except Exception:
                pass
            with open(self._pkt_log_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            tail = lines[-int(max_lines):] if len(lines) > max_lines else lines
            blob = "".join(tail)
            if len(blob) > max_chars:
                blob = "...[truncated]...\n" + blob[-max_chars:]
            return blob
        except Exception:
            return ""

    # Network events fire by the THOUSAND on chat SPAs (every JS chunk fetch,
    # every telemetry POST, every prefetch). Writing+flushing each one inside
    # _send's drain loop turned a sub-second drain into a multi-minute stall
    # on Gemini. We still consume them on the WS (wait_network_idle needs
    # them in memory), we just don't disk-log the request/response detail.
    # Lifecycle/error events stay logged — those are the diagnostic gold.
    _PKT_SKIP_EVENTS = {
        "EVENT Network.requestWillBeSent",
        "EVENT Network.responseReceived",
        "EVENT Network.responseReceivedExtraInfo",
        "EVENT Network.requestWillBeSentExtraInfo",
        "EVENT Network.dataReceived",
        "EVENT Network.loadingFinished",
        "EVENT Network.resourceChangedPriority",
        "EVENT Network.requestServedFromCache",
    }

    def _pkt(self, direction: str, kind: str, payload: Any) -> None:
        """Log one CDP packet. direction = →/← ; kind = method or event name.

        Skips high-volume Network.* events so disk I/O doesn't dominate the
        _send drain loop on chatty SPAs (Gemini, Copilot).
        """
        if kind in self._PKT_SKIP_EVENTS:
            return
        if self._pkt_log is None:
            self._openPacketLog()
        if self._pkt_log is None:
            return
        try:
            line = f"[{time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d}] {direction} {kind} {json.dumps(payload, default=str)[:1500]}\n"
            self._pkt_log.write(line)
            self._pkt_log.flush()
        except Exception:
            pass

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
            # 2026-05-19: was --window-position=-32000,-32000. That value triggers
            # Chromium's "fully off-screen on all monitors" path which suspends
            # rendering AND input-event processing — clicks/types dispatched via
            # CDP go nowhere, screenshots stay stale. Same lesson SuperGrok app.py
            # learned in its "round 6" invisible-window stack: position the
            # window past the visible desktop but at a finite positive coord so
            # Chromium still treats it as a live displayed window. 5000,5000
            # works on a normal multi-monitor desktop; the user never sees it.
            cmd += ["--window-position=5000,5000", "--window-size=1400,1000"]
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
        self._pkt("→", f"#{my_id} {method}", params or {})
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
                    self._pkt("←", f"#{my_id} ERROR {method}", msg.get("error"))
                    raise RuntimeError(f"CDP {method} failed: {msg['error']}")
                self._pkt("←", f"#{my_id} OK {method}", msg.get("result", {}))
                return msg.get("result", {})
            # CDP event interleaved on the same socket. Log every one — this
            # is how we see the 20-forward startup chain on grok, the network
            # requests for a chat send, the page-frame lifecycle, etc.
            ev_method = msg.get("method", "")
            if ev_method:
                self._pkt("←", f"EVENT {ev_method}", msg.get("params", {}))
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

    def screenshot_b64_gridded(self, step_px: int = 100, major_every: int = 2) -> str:
        """Same as screenshot_b64 but with a labeled coordinate grid overlaid
        so GPT can read pixel coords directly off the image instead of
        estimating visually. Minor lines every `step_px`, bolder/labeled
        lines every `major_every * step_px`. Falls back to plain screenshot
        if PIL isn't installed."""
        try:
            from PIL import Image, ImageDraw, ImageFont  # depcheck-ok
            import io as _io
        except Exception:
            return self.screenshot_b64()
        raw = self.screenshot()  # PNG bytes
        try:
            img = Image.open(_io.BytesIO(raw)).convert("RGBA")
        except Exception:
            return base64.b64encode(raw).decode("ascii")
        w, h = img.size
        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # Minor gridlines — semi-transparent gray.
        minor = (80, 80, 80, 70)
        major = (220, 30, 30, 180)   # red so it pops against any UI
        # Vertical lines
        for x in range(0, w, step_px):
            is_major = (x % (step_px * major_every) == 0)
            draw.line([(x, 0), (x, h)], fill=major if is_major else minor, width=1)
        # Horizontal lines
        for y in range(0, h, step_px):
            is_major = (y % (step_px * major_every) == 0)
            draw.line([(0, y), (w, y)], fill=major if is_major else minor, width=1)
        # Labels at major intersections — drawn with a small white box behind
        # so the digits stay readable over any underlying pixels.
        try:
            font = ImageFont.load_default()
        except Exception:
            font = None
        for x in range(0, w, step_px * major_every):
            for y in range(0, h, step_px * major_every):
                txt = f"{x},{y}"
                # tiny background box for legibility
                tx, ty = x + 2, y + 2
                draw.rectangle([(tx - 1, ty - 1), (tx + 6 * len(txt), ty + 10)], fill=(255, 255, 255, 200))
                draw.text((tx, ty), txt, fill=(180, 0, 0, 255), font=font)
        # Last-click marker — cyan crosshair + label "you clicked here" so GPT
        # can verify visually whether its previous click landed where it
        # intended (closes the missed-click feedback loop).
        if self._last_click is not None:
            cx, cy = self._last_click
            # Bounded to image dims so an off-canvas coord still draws an edge marker.
            cx = max(0, min(w - 1, int(round(cx))))
            cy = max(0, min(h - 1, int(round(cy))))
            cyan = (0, 200, 255, 255)
            ring = (0, 200, 255, 110)
            # Outer faded ring
            draw.ellipse([(cx - 22, cy - 22), (cx + 22, cy + 22)], outline=cyan, width=3)
            draw.ellipse([(cx - 12, cy - 12), (cx + 12, cy + 12)], outline=cyan, width=2, fill=ring)
            # Crosshair
            draw.line([(cx - 28, cy), (cx + 28, cy)], fill=cyan, width=2)
            draw.line([(cx, cy - 28), (cx, cy + 28)], fill=cyan, width=2)
            # Label — pick a side that fits in-frame
            label = f"YOU CLICKED HERE ({int(cx)},{int(cy)}) via {self._last_click_kind}"
            lx, ly = (cx + 30, cy - 8) if cx + 280 < w else (cx - 280, cy - 8)
            ly = max(2, min(h - 14, ly))
            try:
                tw = draw.textlength(label, font=font) if hasattr(draw, "textlength") else 6 * len(label)
            except Exception:
                tw = 6 * len(label)
            draw.rectangle([(lx - 2, ly - 2), (lx + int(tw) + 4, ly + 12)], fill=(0, 0, 0, 220))
            draw.text((lx, ly), label, fill=cyan, font=font)

        composited = Image.alpha_composite(img, overlay).convert("RGB")
        out = _io.BytesIO()
        composited.save(out, format="PNG", optimize=False)
        return base64.b64encode(out.getvalue()).decode("ascii")

    def screenshot_to_file(self, path: str | Path) -> Path:
        """Write a screenshot PNG to `path` and return the absolute path."""
        out = Path(path).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self.screenshot())
        return out

    # --- input synthesis ---------------------------------------------------
    def snapshot_post_action(self) -> dict[str, Any]:
        """Capture page-side state RIGHT AFTER an action. CDP "OK" on a click
        dispatch only proves the wire-level event fired; this answers the
        thing the agent actually needs to know — did the action have the
        intended page effect? Returns activeElement (tag/role/aria/text),
        url, body text length. Cheap (~1ms JS eval)."""
        js = (
            "(function(){try{var a=document.activeElement||document.body;"
            "var ae={tag:(a.tagName||''), id:(a.id||''), cls:(a.className||'').toString().slice(0,80),"
            "role:(a.getAttribute&&a.getAttribute('role'))||'',"
            "aria:(a.getAttribute&&(a.getAttribute('aria-label')||a.getAttribute('placeholder')))||'',"
            "text:(a.innerText||a.value||a.textContent||'').toString().trim().slice(0,120),"
            "type:(a.getAttribute&&a.getAttribute('type'))||''};"
            "return JSON.stringify({activeElement:ae,url:location.href,bodyLen:(document.body?document.body.innerText.length:0)});"
            "}catch(e){return JSON.stringify({error:String(e)});}})()"
        )
        try:
            r = self._send("Runtime.evaluate", {"expression": js, "returnByValue": True, "awaitPromise": True})
            val = ((r or {}).get("result") or {}).get("value") or ""
            return json.loads(val) if val else {}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}

    def click_xy(self, x: float, y: float, button: str = "left", clicks: int = 1) -> None:
        """Move + press + release at pixel coordinates."""
        params_base = {"x": float(x), "y": float(y), "button": button, "clickCount": int(clicks)}
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mouseMoved"})
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mousePressed"})
        self._send("Input.dispatchMouseEvent", {**params_base, "type": "mouseReleased"})
        # Remember coords so the NEXT gridded screenshot can show GPT exactly
        # where this click landed — closes the feedback loop on missed clicks.
        self._last_click = (float(x), float(y))
        self._last_click_kind = "click"
        # Capture page-side state so GPT sees the EFFECT of the click, not
        # just that CDP said OK. Most missed clicks are diagnosed instantly
        # from activeElement (e.g. "you clicked at (400,400), activeElement
        # is now BUTTON 'Imagine' — you missed the composer").
        self._post_action_snapshot = self.snapshot_post_action()

    def type_text(self, text: str) -> None:
        """Insert text into the focused input via CDP's Input.insertText.

        This is the ONLY reliable cross-site path. Earlier versions used
        per-character Input.dispatchKeyEvent which:
          - With `text` on keyDown + a separate `char` event → doubled on
            sites like chatgpt.com whose React handlers process BOTH the
            native keydown-text-insert AND the synthetic char/input event
            ("ppoonngg" bug).
          - Without `text` on keyDown → grok.com's input listener never
            received the character at all (max_steps exhausted).
        Input.insertText sidesteps both: Chromium inserts the text into the
        focused editable element in ONE atomic step and fires a single
        `input` event, which is what React/Vue/Angular/ProseMirror all
        listen for. Behaves identically on textarea / contenteditable /
        input fields.
        """
        if not text:
            return
        self._send("Input.insertText", {"text": str(text)})

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

    def wait_network_idle(self, idle_ms: int = 3000, timeout_ms: int = 25000) -> bool:
        """Block until the page network has been quiet for `idle_ms`.

        The ONLY reliable "page/reply settled" signal for these chat SPAs:
        readyState/onload are useless because the apps lazy-load long chains
        of content-hashed JS chunks (a1b2c3.js, d4e5f6.js, ...) and the
        assistant reply itself streams over fetch/SSE. We watch CDP
        Network.* events and declare done when no network activity has
        happened for `idle_ms`. Returns True if idle was reached, False if
        `timeout_ms` elapsed first (caller proceeds anyway — a screenshot of
        a still-loading page just means GPT emits another WAIT).

        Network.enable is already on (attach()). Events are normally
        discarded by _send's drain; here we read them directly. Safe to call
        only BETWEEN _send calls (after navigate / after send) — never
        concurrently — so there's no recv reentrancy.
        """
        if self.ws is None:
            return False
        NET_EVENTS = (
            "Network.requestWillBeSent",
            "Network.responseReceived",
            "Network.loadingFinished",
            "Network.loadingFailed",
            "Network.dataReceived",
            "Network.webSocketFrameReceived",
        )
        start = time.monotonic()
        last_activity = time.monotonic()
        prev_timeout = self.recv_timeout_s
        try:
            self.ws.settimeout(0.4)  # short poll so idle gaps are detectable
            while True:
                now = time.monotonic()
                if (now - last_activity) * 1000.0 >= idle_ms:
                    return True
                if (now - start) * 1000.0 >= timeout_ms:
                    return False
                try:
                    raw = self.ws.recv()
                except Exception:
                    # recv timeout (no message) — that IS the idle signal;
                    # loop back and the elapsed-since-last_activity check fires.
                    continue
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("method") in NET_EVENTS:
                    last_activity = time.monotonic()
                # non-network events (Page/DOM/Runtime) are ignored for idle
                # purposes but still consumed so the buffer doesn't back up.
        finally:
            try:
                if self.ws is not None:
                    self.ws.settimeout(prev_timeout)
            except Exception:
                pass

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
