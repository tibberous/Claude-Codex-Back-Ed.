"""
gpt_vision_pilot.py — GPT-4o drives a MiniComputer end-to-end.

User's exact framing (CLAUDE.md, 2026-05-15):
    "they need to create offscreen terminals, take a screenshot, send to GTP
    with the gtp hook, GTP needs the webpage + NN browser + instructions +
    mouse/keystrokes + a way to repull screenshots. We're basically building
    him a mini computer."

How it works:
    1. We screenshot the live page via CDP.
    2. We POST to OpenAI Chat Completions (gpt-4o) with the image + a system
       prompt describing the JSON action protocol below + the user's goal +
       a truncated action-history summary.
    3. GPT replies with one JSON action. We parse it, execute it on the
       MiniComputer, append the (action, result) to history.
    4. Repeat until GPT emits {action:'done', ...} or {action:'fail', ...} or
       we hit max_steps.

Action protocol (the system prompt sent to GPT):
    {action: 'screenshot'}                       # re-pull screen
    {action: 'click', x: int, y: int}            # click at viewport pixel coords
    {action: 'type', text: str}                  # type text at focused element
    {action: 'key', name: str}                   # named key: Enter/Tab/Esc/...
    {action: 'scroll', dy: int}                  # mouse-wheel by dy pixels
    {action: 'navigate', url: str}               # Page.navigate
    {action: 'wait', ms: int}                    # let React reconcile
    {action: 'done', summary: str, extracted: any}    # SUCCESS terminator
    {action: 'fail', reason: str}                # CANNOT-COMPLETE terminator

History bloat:
    Truncated to last 5 actions + only the last 2 screenshots kept inline so
    a 20-step pilot doesn't drag the token bill into the sky.

Auth:
    Reads OpenAI key from config.ini under [api_keys] openai_api_key (matches
    inlined _InlineChatGPTHook in start.py). 401 returns a clean error.
"""
from __future__ import annotations

import base64
import configparser
import json
import re
import time
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

# Local sibling import
from cdp_minicomputer import MiniComputer  # noqa: E402

_ROOT = Path(__file__).resolve().parent.parent  # …\Claude Codex Black\
_CONFIG_PATH = _ROOT / "config.ini"

OPENAI_URL = "https://api.openai.com/v1/chat/completions"

SYSTEM_PROMPT = """You are an autonomous web-pilot driving a real Chromium tab.
On every turn you receive ONE PNG screenshot of the current viewport (size ~1400x1000) plus a short text summary of the goal and the most recent actions you took.

You drive the browser by emitting exactly ONE JSON action per turn, with no surrounding text, no markdown fence, no explanation. Just a single JSON object. The next turn will reflect the new state.

Action protocol (one of these per turn):
  {"action": "screenshot"}                          // re-pull screen, no state change
  {"action": "click",     "x": <int>, "y": <int>}   // viewport pixel coords; (0,0) is top-left
  {"action": "type",      "text": "<string>"}       // typed at currently focused element
  {"action": "key",       "name": "Enter|Tab|Esc|Backspace|Delete|Up|Down|Left|Right|F1..F12|Home|End|PgUp|PgDn"}
  {"action": "scroll",    "dy": <int>}              // positive=down, negative=up, pixels
  {"action": "navigate",  "url": "<absolute url>"}  // hard navigation
  {"action": "wait",      "ms": <int>}              // 100..5000 ms; let React reconcile
  {"action": "done",      "summary": "<str>",   "extracted": <any>}   // TASK COMPLETE
  {"action": "fail",      "reason": "<str>"}                          // CANNOT COMPLETE — give specific reason

Rules:
- Output ONE JSON object. No prose, no code-fence.
- Coordinates are viewport pixels — read them visually from the screenshot.
- Click the actual input box before typing.
- After typing, press Enter (or click submit) to send.
- If a page is loading, emit {"action":"wait","ms":1500} before the next screenshot.
- If you're blocked by a login wall, captcha, or 2FA: emit {"action":"fail","reason":"login required"} so the operator can step in.
- When the GOAL is satisfied: emit {"action":"done","summary":"...","extracted":<the answer the operator asked for>}.
- Never invent a URL — only navigate to URLs the goal or the page surface explicitly mentioned.
- Never inject credentials. If asked to log in, fail with reason "login required" so the operator logs in manually.
"""


# --- config / api-key --------------------------------------------------------
def _readApiKey() -> str:
    cfg = configparser.RawConfigParser()
    try:
        cfg.read(str(_CONFIG_PATH), encoding="utf-8")
    except Exception:
        return ""
    for section in cfg.sections():
        if cfg.has_option(section, "openai_api_key"):
            v = (cfg.get(section, "openai_api_key") or "").strip()
            if v:
                return v
        if cfg.has_option(section, "api_key") and section.lower() == "openai":
            v = (cfg.get(section, "api_key") or "").strip()
            if v:
                return v
    return ""


# --- JSON action parser ------------------------------------------------------
_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})", re.DOTALL)


def _parseAction(raw: str) -> dict[str, Any]:
    """Pull the FIRST JSON object out of GPT's reply. Strip fences if present."""
    text = (raw or "").strip()
    if not text:
        return {"action": "fail", "reason": "empty GPT response"}
    # Prefer a fenced ```json block if present.
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1)
    try:
        return json.loads(text)
    except Exception:
        pass
    # Last resort — find first balanced JSON object.
    m2 = _OBJ_RE.search(text)
    if m2:
        try:
            return json.loads(m2.group(1))
        except Exception:
            pass
    return {"action": "fail", "reason": f"could not parse JSON from GPT: {text[:300]!r}"}


# --- OpenAI POST -------------------------------------------------------------
def _postOpenAI(api_key: str, messages: list[dict[str, Any]], model: str, max_tokens: int = 800) -> tuple[int, dict[str, Any]]:
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": 0.2,
    }
    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body[:2000]}
        return e.code, parsed
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


# --- history compression -----------------------------------------------------
def _summarizeHistory(history: list[dict[str, Any]], keep_actions: int = 5) -> str:
    """Render the last N actions as a numbered text summary (no images)."""
    if not history:
        return "(no actions yet)"
    tail = history[-keep_actions:]
    lines = []
    for i, h in enumerate(tail, start=max(1, len(history) - len(tail) + 1)):
        act = h.get("action", {})
        atype = act.get("action", "?")
        if atype == "click":
            lines.append(f"  {i}. click({act.get('x')},{act.get('y')})")
        elif atype == "type":
            lines.append(f"  {i}. type({(act.get('text') or '')[:60]!r})")
        elif atype == "key":
            lines.append(f"  {i}. key({act.get('name')!r})")
        elif atype == "scroll":
            lines.append(f"  {i}. scroll(dy={act.get('dy')})")
        elif atype == "navigate":
            lines.append(f"  {i}. navigate({act.get('url')!r})")
        elif atype == "wait":
            lines.append(f"  {i}. wait({act.get('ms')}ms)")
        elif atype == "screenshot":
            lines.append(f"  {i}. screenshot()")
        else:
            lines.append(f"  {i}. {atype}({json.dumps(act, default=str)[:100]})")
        note = h.get("note") or ""
        if note:
            lines.append(f"     -> {note}")
    return "\n".join(lines)


# --- main pilot loop ---------------------------------------------------------
def pilot(
    mini: MiniComputer,
    goal: str,
    max_steps: int = 20,
    model: str = "gpt-4o",
    on_step: callable = None,  # type: ignore[valid-type]
) -> dict[str, Any]:
    """Drive `mini` toward `goal` using GPT-4o vision.

    Returns:
        {ok, steps, action_history, final_url, extracted, summary?, error?}
    """
    api_key = _readApiKey()
    if not api_key:
        return {
            "ok": False, "steps": 0, "action_history": [],
            "final_url": mini.final_url(),
            "error": "OpenAI API key not found in config.ini [api_keys] openai_api_key",
        }

    history: list[dict[str, Any]] = []
    last_screenshot_b64: str = ""
    last_extracted: Any = None
    last_summary: str = ""
    final_action: dict[str, Any] = {}

    for step in range(1, int(max_steps) + 1):
        # 1) Pull a fresh screenshot for the current turn.
        try:
            last_screenshot_b64 = mini.screenshot_b64()
        except Exception as e:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": f"screenshot failed at step {step}: {type(e).__name__}: {e}",
            }

        # 2) Build messages — system + user (goal + history-text + image).
        history_text = _summarizeHistory(history, keep_actions=5)
        user_blocks: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    f"GOAL:\n{goal}\n\n"
                    f"STEP: {step}/{max_steps}\n"
                    f"CURRENT URL: {mini.final_url() or '(unknown)'}\n"
                    f"VIEWPORT: {'x'.join(str(v) for v in mini.viewport_size())}\n\n"
                    f"RECENT ACTIONS (most recent last):\n{history_text}\n\n"
                    "Look at the screenshot below and emit your NEXT action as one JSON object."
                ),
            },
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{last_screenshot_b64}"},
            },
        ]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_blocks},
        ]

        # 3) Ask GPT.
        status, body = _postOpenAI(api_key, messages, model=model, max_tokens=800)
        if status == 401:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": "OpenAI 401 — invalid or expired key",
                "body": body,
            }
        if status != 200:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": f"OpenAI HTTP {status}",
                "body": body,
            }
        try:
            raw_reply = body["choices"][0]["message"]["content"]
        except Exception:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": "OpenAI response missing choices[0].message.content",
                "body": body,
            }

        # 4) Parse and execute the action.
        action = _parseAction(raw_reply)
        atype = str(action.get("action") or "").strip().lower()
        note = ""
        try:
            if atype == "screenshot":
                note = "screenshot requested (next turn shows fresh image)"
            elif atype == "click":
                mini.click_xy(float(action.get("x", 0)), float(action.get("y", 0)),
                              button=str(action.get("button", "left")))
                note = f"clicked ({action.get('x')},{action.get('y')})"
            elif atype == "type":
                mini.type_text(str(action.get("text", "")))
                note = f"typed {len(str(action.get('text','')))} chars"
            elif atype == "key":
                mini.press_key(str(action.get("name", "")))
                note = f"pressed {action.get('name')}"
            elif atype == "scroll":
                mini.scroll(int(action.get("dx", 0)), int(action.get("dy", 0)))
                note = f"scrolled dy={action.get('dy')}"
            elif atype == "navigate":
                mini.navigate(str(action.get("url", "")))
                note = f"navigating to {action.get('url')}"
            elif atype == "wait":
                mini.wait_ms(int(action.get("ms", 500)))
                note = f"waited {action.get('ms')}ms"
            elif atype == "done":
                last_extracted = action.get("extracted")
                last_summary = str(action.get("summary") or "")
                final_action = action
                history.append({"action": action, "note": "DONE"})
                if callable(on_step):
                    try: on_step(step, action, "DONE")
                    except Exception: pass
                return {
                    "ok": True,
                    "steps": step,
                    "action_history": history,
                    "final_url": mini.final_url(),
                    "extracted": last_extracted,
                    "summary": last_summary,
                }
            elif atype == "fail":
                final_action = action
                history.append({"action": action, "note": "FAIL"})
                if callable(on_step):
                    try: on_step(step, action, "FAIL")
                    except Exception: pass
                return {
                    "ok": False,
                    "steps": step,
                    "action_history": history,
                    "final_url": mini.final_url(),
                    "error": f"GPT gave up: {action.get('reason')!r}",
                }
            else:
                note = f"unknown action {atype!r} — treating as no-op"
        except Exception as e:
            note = f"execute error: {type(e).__name__}: {e}"

        history.append({"action": action, "note": note})
        if callable(on_step):
            try: on_step(step, action, note)
            except Exception: pass
        # small reconcile beat so React/DOM settles before next screenshot
        time.sleep(0.4)

    return {
        "ok": False,
        "steps": max_steps,
        "action_history": history,
        "final_url": mini.final_url(),
        "error": f"max_steps={max_steps} exhausted without done/fail",
    }


__all__ = ["pilot", "SYSTEM_PROMPT"]
