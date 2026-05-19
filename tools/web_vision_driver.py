"""Web-based vision driver — uses the user's logged-in chatgpt.com Plus
session (via CDP) as the pilot's brain instead of api.openai.com.

Why: api.openai.com requires a separately-funded API tier. The user pays
for ChatGPT Plus on the website, which has its own quota and no rate
limits for normal use. Pointing the pilot at chatgpt.com costs zero API
spend and never 429s as long as the user is logged in.

Architecture:
    driveOneTurn(driver_mini, target_screenshot_b64, system_prompt, user_text)
      → parses chatgpt.com's reply into the same {action, x, y, why} shape
        the existing gpt_vision_pilot expected from api.openai.com

`driver_mini` is a MiniComputer instance attached to a chatgpt.com tab
that is ALREADY logged in. Caller is responsible for ensuring login (use
tools/sign_in_helper.py or the persistent profile cookies).

This module knows nothing about which TARGET is being driven; it just
sends one screenshot+question to chatgpt and returns the reply text.
"""
from __future__ import annotations

import base64
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# Selectors for chatgpt.com's composer / attach / response. Subject to
# DOM rotation; if these break we'll see "composer not found" in logs.
CHATGPT_COMPOSER = "#prompt-textarea"
CHATGPT_FILE_INPUT = 'input[type="file"]'
CHATGPT_SEND_BUTTON = 'button[data-testid="send-button"], button[aria-label="Send prompt"]'
CHATGPT_LAST_ASSISTANT = '[data-message-author-role="assistant"]:last-of-type'


def _eval(mini, js: str) -> Any:
    try:
        return mini.eval_js(js)
    except Exception:
        return None


def _waitForSelector(mini, selector: str, timeout_s: float = 10.0) -> bool:
    """True if `selector` matches a visible element within `timeout_s`."""
    js = f"""(function(){{
        var el = document.querySelector('{selector}');
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    }})()"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if bool(_eval(mini, js)):
            return True
        time.sleep(0.3)
    return False


def _attachImageViaFileInput(mini, png_path: Path) -> tuple[bool, str]:
    """Attach an image to chatgpt.com's composer via CDP DOM.setFileInputFiles.

    Returns (ok, diag) so the caller can surface why a failure happened.
    """
    try:
        # 1) Get the document root node first — many setFileInputFiles
        #    flows require an explicit DOM.getDocument before the tree is
        #    walkable.
        try:
            mini._send("DOM.getDocument", {})
        except Exception:
            pass
        # 2) Get objectId for the file input element.
        result = mini._send("Runtime.evaluate", {
            "expression": f"document.querySelector('{CHATGPT_FILE_INPUT}')",
            "returnByValue": False,
        })
        obj = (result or {}).get("result", {}) or {}
        object_id = obj.get("objectId")
        if not object_id:
            return False, f"no objectId for {CHATGPT_FILE_INPUT}; result={result}"
        # 3) setFileInputFiles works directly with objectId in newer CDP.
        try:
            mini._send("DOM.setFileInputFiles", {
                "files": [str(png_path.resolve())],
                "objectId": object_id,
            })
            return True, "uploaded via objectId"
        except Exception as e_obj:
            # 4) Fallback: convert to nodeId via DOM.requestNode then retry.
            try:
                req = mini._send("DOM.requestNode", {"objectId": object_id})
                node_id = (req or {}).get("nodeId")
                if not node_id:
                    return False, f"DOM.requestNode returned no nodeId; req={req}"
                mini._send("DOM.setFileInputFiles", {
                    "files": [str(png_path.resolve())],
                    "nodeId": node_id,
                })
                return True, "uploaded via nodeId fallback"
            except Exception as e_node:
                return False, f"objectId-path err: {e_obj}; nodeId-path err: {e_node}"
    except Exception as e:
        return False, f"setFileInputFiles outer: {type(e).__name__}: {e}"


def driveOneTurn(driver_mini, screenshot_path: Path, system_prompt: str, user_text: str,
                 timeout_s: int = 180) -> dict:
    """Send a single turn to the logged-in chatgpt.com tab and return the
    reply text. The reply is the raw text — caller parses it into the
    pilot action schema (CLICK / TYPE / DONE / FAIL / etc.).

    Returns {ok, reply, error}.
    """
    if driver_mini is None:
        return {"ok": False, "error": "driver_mini is None — caller must pass a chatgpt MiniComputer"}

    if not _waitForSelector(driver_mini, CHATGPT_COMPOSER, timeout_s=15.0):
        return {"ok": False, "error": "chatgpt.com composer not found — driver tab is logged out or wrong page"}

    # Count existing assistant messages so we know when a new reply lands.
    before = int(_eval(driver_mini, f"document.querySelectorAll('{CHATGPT_LAST_ASSISTANT}').length") or 0)

    # Focus the composer.
    _eval(driver_mini, f"document.querySelector('{CHATGPT_COMPOSER}').focus();")
    time.sleep(0.2)

    # Paste the screenshot.
    ok, diag = _attachImageViaFileInput(driver_mini, screenshot_path)
    if not ok:
        return {"ok": False, "error": f"failed to paste screenshot into chatgpt.com composer: {diag}"}
    time.sleep(1.2)  # let chatgpt upload + preview the image

    # Type the prompt text (system + user concatenated for simplicity).
    # Give chatgpt time to finish processing the uploaded image before we
    # type — uploading a 1400x1000 PNG can take a couple seconds, and the
    # send button stays disabled in React state until the upload completes.
    full_text = f"{system_prompt}\n\n{user_text}".strip()
    driver_mini.type_text(full_text)
    time.sleep(1.0)

    # Submit. Try Enter key FIRST (most reliable for chatgpt composer),
    # then fall back to clicking the send button. After either, wait a
    # beat for chatgpt to process the request before polling for a reply.
    driver_mini.press_key("enter")
    time.sleep(0.5)
    # Belt-and-suspenders: if Enter didn't take, click the send button.
    _eval(driver_mini, f"""(function(){{
        var btn = document.querySelector('{CHATGPT_SEND_BUTTON}');
        if (btn && !btn.disabled) btn.click();
    }})()""")

    # Wait for a new assistant message + for it to stop growing.
    deadline = time.time() + timeout_s
    last_text = ""
    stable_count = 0
    while time.time() < deadline:
        try:
            after = int(_eval(driver_mini, f"document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
            if after > before:
                txt = str(_eval(driver_mini,
                    "(function(){var els=document.querySelectorAll('[data-message-author-role=\"assistant\"]');"
                    "if(!els.length) return ''; var last=els[els.length-1];"
                    "return (last.innerText||last.textContent||'').trim();})()") or "").strip()
                if txt and txt == last_text:
                    stable_count += 1
                    if stable_count >= 2:  # ~2 seconds of no change → stream done
                        return {"ok": True, "reply": txt}
                else:
                    stable_count = 0
                last_text = txt
        except Exception:
            pass
        time.sleep(1.0)

    if last_text:
        return {"ok": True, "reply": last_text, "warn": "stream may have been incomplete at timeout"}
    return {"ok": False, "error": "chatgpt.com never produced an assistant reply within timeout"}
