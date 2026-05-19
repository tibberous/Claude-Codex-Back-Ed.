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

Every turn you get ONE PNG screenshot of the current viewport (~1400x1000) plus a
short text summary of the goal and your most recent actions.

You drive the browser by CALLING ONE OF YOUR TOOLS each turn (OpenAI function/tool
calling). You always have these tools available — use them; do not write prose.

EACH TURN you receive THREE things, not just one:
  1. A SCREENSHOT with a labeled coordinate GRID overlaid (red labels at every
     200px showing exact x,y) — read coords directly off the labels rather
     than estimating visually. If your PREVIOUS turn was a click, you'll
     also see a CYAN CROSSHAIR + label "YOU CLICKED HERE (x,y)" at the
     exact spot your last click landed. USE this: if the crosshair is on
     empty page space or the wrong element, your click missed — escalate.
     If it's on the right element but the page still didn't change, the
     element ignored the click — escalate to run_js.
  2. The CDP PACKET LOG of recent wire traffic — every Input.dispatchMouseEvent
     you fired, every Network.requestWillBeSent/responseReceived/loadingFinished
     the page emitted in response. Use this to tell whether your last action
     actually had an effect on the page.
  3. The LIVE PAGE HTML (scripts/styles stripped) — structural ground truth. If
     the screenshot is ambiguous about an element's bounds, the HTML has exact
     text/aria-label/placeholder/role/id. Cross-reference the three.

PRIMARY tools (try these first):
  click(x,y[,button]) — click viewport pixel coords; (0,0) is top-left
  type(text)          — type at the currently focused element
  key(name)           — press a named key: Enter, Tab, Esc, Backspace, Delete,
                         Up/Down/Left/Right, F1..F12, Home, End, PgUp, PgDn
  scroll(dy)          — positive=down, negative=up, pixels
  navigate(url)       — hard navigation to an absolute URL
  wait(ms)            — 100..5000ms; let React/the page reconcile
  screenshot()        — get a FRESH screenshot (use freely — no penalty)

REDUNDANT / FALLBACK tools (second chance when the primary path didn't land):
  click_text(text)    — click the first visible element whose text matches.
                         Use when a coord-click missed (CDP packet log shows
                         no Network activity after your click, OR next
                         screenshot looks identical), or when the HTML shows
                         clear button text but the screenshot bounds are
                         ambiguous. e.g. click_text("Sign in"), click_text("Send").
  run_js(code)        — POWER TOOL: execute arbitrary JavaScript via
                         Runtime.evaluate. The universal escape hatch when
                         click/type/key/click_text all fail. You CAN use CSS
                         selectors here — querySelector/closest/etc. — they're
                         allowed in JS you write per-page, the rule is only
                         that WE never hardcode them. Examples:
                           • Force-focus a React contenteditable:
                             `var el=document.querySelector('[contenteditable]'); el.focus(); el.textContent='hi'; el.dispatchEvent(new InputEvent('input',{bubbles:true}))`
                           • Submit a stubborn form: `document.querySelector('form').submit()`
                           • Read the assistant reply from a specific DOM region.
                         Return value comes back to you in the next turn.

TERMINATORS:
  done(summary,extracted) — TASK COMPLETE; put the answer in `extracted`
  fail(reason)            — only if you genuinely cannot proceed (hard
                             captcha or 2FA, never a blank/loading frame)

REDUNDANCY PATTERN — this is critical, AND ENFORCED:
  Every action has TWO ways. After EACH action, check:
    1. Did the screenshot visibly change?
    2. Did the CDP log show Network.requestWillBeSent / responseReceived
       events fired BY the page in response (not your own click dispatch)?
    3. Did the HTML change (new elements, text, classes)?
  If NONE of those changed, your action HAD NO EFFECT. Do NOT repeat the
  same shape — ESCALATE to the next path:
    click(x,y) missed       → click_text("the visible label on the button")
    click_text missed       → run_js: focus + dispatch the right event
    type(text) didn't stick → run_js: el.focus(); el.value=X (or textContent
                              for contenteditable); el.dispatchEvent(new
                              InputEvent('input',{bubbles:true}))
    key('Enter') ignored    → run_js: form.submit() OR querySelector send-btn click()

  HARD TWO-STRIKES RULE: if the SAME tool with SIMILAR coords/text/code ran
  twice and the page state was unchanged both times — you MUST switch tool
  type the third turn. Repeating a non-working click 10 times wastes the
  whole session. Escalate.

OUTPUT FORMAT (avoid the weird stuff):
  - `run_js` takes a STRING of raw JavaScript. NO backticks, NO ```js fences,
    NO markdown. Just the code. Bad: `` `document.querySelector('x').click()` ``
    Good: document.querySelector('x').click()
  - Inside that JS string, use single quotes for selectors so you don't have
    to escape outer double quotes.
  - One tool call per turn. Don't try to batch.

WHAT YOU CANNOT DO (so you don't try):
  - You CANNOT upload files. There is no file/attachment endpoint. If you
    "want to upload login.js" — instead, just pass that JS as a string to
    run_js. The page state is what matters; we don't need files on disk.
  - You CANNOT navigate the OS, open new browser tabs/windows, or talk to
    anything outside this one Chromium tab.
  - You CANNOT ask the operator a question. There's no human in the loop
    to answer — the operator is asleep. Solve it or fail() with a precise
    technical reason.

UNBREAK loop: A blank/loading/half-rendered screenshot is NEVER fail — it's
just an early frame. Call screenshot() or wait(2000) and try again.

Rules:
- Call exactly ONE tool per turn. Never reply with prose or JSON text — use the
  tool-call mechanism. (If you ever can't, a single JSON object is tolerated as
  a fallback, but tools are strongly preferred.)
- Coordinates are viewport pixels read visually from the screenshot.
- Click the actual input box before typing. After typing, press Enter (key) or
  click the submit/send control to send.
- The mere presence of a Sign in / Sign up / Log in button is NOT a login wall
  and NOT a reason to fail. If a usable chat input is visible, USE IT.
- Only fail() for a hard full-page modal login form, a captcha, or 2FA/email
  code — never for a blank/loading frame (screenshot/wait instead).
- Dismiss cookie/consent banners with a click, then continue.
- Never invent a URL.
- If a login is required, USE THE CREDENTIALS the GOAL text gives you (the
  operator's spec is "I don't log in, you do"). Strongly prefer the
  "Continue with Google" / Google SSO path — the same Gmail is logged in
  across all these chat sites. Only type the email/password into a real
  password form as a last resort. Treat the persistent browser profile as
  yours: once you log in here, future runs are already logged in.
- When the GOAL is satisfied, call done() with the answer in `extracted`.
"""

# OpenAI tool/function schemas. Passed as `tools=` with tool_choice="required"
# so GPT MUST emit a structured tool_call every turn — no free-text JSON
# extraction, no regex fragility. Mirrors the executor dispatch exactly.
TOOLS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "click", "description": "Click at viewport pixel coordinates (origin top-left).",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "integer"}, "y": {"type": "integer"},
            "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
        }, "required": ["x", "y"]}}},
    {"type": "function", "function": {
        "name": "type", "description": "Type text at the currently focused element.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "key", "description": "Press a single named key (Enter to send, Tab to move fields, etc.).",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"}}, "required": ["name"]}}},
    {"type": "function", "function": {
        "name": "scroll", "description": "Scroll the page vertically. Positive dy = down.",
        "parameters": {"type": "object", "properties": {
            "dy": {"type": "integer"}, "dx": {"type": "integer", "default": 0}}, "required": ["dy"]}}},
    {"type": "function", "function": {
        "name": "navigate", "description": "Hard-navigate to an absolute URL.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "wait", "description": "Pause to let the page/React reconcile, then a fresh screenshot is taken.",
        "parameters": {"type": "object", "properties": {
            "ms": {"type": "integer", "minimum": 100, "maximum": 5000}}, "required": ["ms"]}}},
    {"type": "function", "function": {
        "name": "screenshot", "description": "Get a FRESH screenshot of the current page state. Use freely to unbreak/recover from a blank, stale, or unclear frame — there is no penalty.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "click_text", "description": "REDUNDANT path to click(x,y): click the first visible element whose visible text contains the given string (case-insensitive). Use this when a coord-click missed, or when the HTML shows you a clear button/link text but the screenshot bounding is ambiguous. Returns the tag + bounding rect of what got clicked.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "exact": {"type": "boolean", "default": False},
        }, "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "run_js", "description": "POWER TOOL — execute arbitrary JavaScript in the page context (Runtime.evaluate, returnByValue=true, awaitPromise=true). The universal escape hatch when click/type/key/click_text aren't enough — e.g. typing into a React-controlled input that swallows raw keys: `var el=document.querySelector('[contenteditable]'); el.focus(); el.textContent='hi'; el.dispatchEvent(new InputEvent('input',{bubbles:true}))`. The return value comes back to you in the next turn's context.",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string"}}, "required": ["code"]}}},
    {"type": "function", "function": {
        "name": "done", "description": "Task complete. Put the answer the operator asked for in `extracted`.",
        "parameters": {"type": "object", "properties": {
            "summary": {"type": "string"}, "extracted": {"type": "string"}}, "required": ["extracted"]}}},
    {"type": "function", "function": {
        "name": "fail", "description": "Only when genuinely blocked (hard login modal / captcha / 2FA). Never for a blank or loading frame.",
        "parameters": {"type": "object", "properties": {
            "reason": {"type": "string"}}, "required": ["reason"]}}},
]


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
def _postOpenAI(api_key: str, messages: list[dict[str, Any]], model: str, max_tokens: int = 800,
                tools: list[dict[str, Any]] | None = None) -> tuple[int, dict[str, Any]]:
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": 0.2,
    }
    if tools:
        # Force a structured tool_call every turn — no free-text JSON to
        # regex-extract. This is the robustness upgrade: GPT literally
        # cannot reply with un-parseable prose when tool_choice=required.
        payload["tools"] = tools
        payload["tool_choice"] = "required"
    body_bytes = json.dumps(payload).encode("utf-8")

    # Retry on 429 (rate limit) and 5xx with exponential backoff. We honor
    # Retry-After if OpenAI sends it; otherwise back off 10/30/60/120/180
    # seconds (~6.5min total) so the retry budget actually outlasts a real
    # tier-1 rate-limit cooldown rather than burning out in 37s.
    backoffs = [10, 30, 60, 120, 180]
    for attempt, extra_sleep in enumerate([0] + backoffs):
        if extra_sleep:
            time.sleep(extra_sleep)
        req = urllib.request.Request(
            OPENAI_URL,
            data=body_bytes,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = r.read().decode("utf-8", "replace")
                return r.status, json.loads(resp)
        except urllib.error.HTTPError as e:
            resp = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
            try:
                parsed = json.loads(resp)
            except Exception:
                parsed = {"raw": resp[:2000]}
            retry_status = (e.code == 429) or (500 <= e.code < 600)
            last_attempt = (attempt == len(backoffs))
            if retry_status and not last_attempt:
                # Prefer server-sent Retry-After when available — it tells us
                # exactly how long to wait. Fall back to backoff table.
                try:
                    ra = e.headers.get("Retry-After")
                    if ra:
                        wait = max(int(float(ra)), backoffs[attempt])
                        backoffs[attempt] = wait
                except Exception:
                    pass
                continue
            return e.code, parsed
        except Exception as e:
            return 0, {"error": f"{type(e).__name__}: {e}"}
    return 0, {"error": "_postOpenAI: retry loop exhausted unexpectedly"}


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
    driver_mini: MiniComputer = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """Drive `mini` toward `goal` using web-based vision (chatgpt.com Plus).

    `driver_mini` is a MiniComputer attached to a logged-in chatgpt.com
    tab. The pilot uploads its target screenshots there and parses
    chatgpt's text reply into actions. NO api.openai.com calls — the
    user's Plus subscription is the brain, free of API rate limits.

    Falls back to api.openai.com only if `driver_mini` is None or the
    chatgpt tab is logged out (with a clear error pointing the operator
    at tools/sign_in_helper.py).

    Returns:
        {ok, steps, action_history, final_url, extracted, summary?, error?}
    """
    # Resolve driver: caller can pass one explicitly, otherwise auto-attach
    # to the chatgpt MiniComputer (per-target chrome at CDP port 9788).
    if driver_mini is None:
        try:
            from start import getMiniComputer as _getMini, normalizeChatTarget as _norm  # type: ignore
            target_canon = ""
            try:
                from urllib.parse import urlparse as _urlparse
                host = (_urlparse(mini.final_url() or "").hostname or "").lower()
                if "chatgpt.com" in host or "chat.openai.com" in host:
                    target_canon = "chatgpt"
            except Exception:
                pass
            if target_canon != "chatgpt":  # don't drive chatgpt with itself (recursion)
                driver_mini = _getMini("chatgpt", offscreen=True, autostart=True)
        except Exception:
            driver_mini = None  # will fall back to api path

    # Only need the API key if we're falling back to api.openai.com.
    api_key = _readApiKey() if driver_mini is None else ""

    history: list[dict[str, Any]] = []
    last_screenshot_b64: str = ""
    last_extracted: Any = None
    last_summary: str = ""

    for step in range(1, int(max_steps) + 1):
        # 1) Pull a fresh screenshot for the current turn — with the labeled
        #    coordinate grid overlay so GPT reads pixel coords directly off
        #    the image (instead of guessing visually and landing 50px off).
        try:
            last_screenshot_b64 = mini.screenshot_b64_gridded()
        except Exception as e:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": f"screenshot failed at step {step}: {type(e).__name__}: {e}",
            }

        # 2) Build messages — system + user (goal + history-text + image + CDP log).
        history_text = _summarizeHistory(history, keep_actions=5)
        # Pull the CDP packet-log tail so GPT can see the CAUSAL context of
        # the last few turns — clicks dispatched, network events that fired,
        # replies from the page — not just the static screenshot. This is
        # how GPT can tell a click landed but didn't focus anything (vs.
        # truly hit a button), what URLs the page is loading mid-chain, etc.
        try:
            cdp_tail = mini.read_packet_log_tail(max_lines=80, max_chars=8000)
        except Exception:
            cdp_tail = ""
        # User-stated requirement: send the HTML too. Structural ground truth
        # alongside the screenshot. If the screenshot is ambiguous about an
        # element's bounds, GPT reads exact text/aria-label/id from the HTML.
        try:
            page_html = mini.page_html(max_chars=24000)
        except Exception:
            page_html = ""
        user_blocks: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    f"GOAL:\n{goal}\n\n"
                    f"STEP: {step}/{max_steps}\n"
                    f"CURRENT URL: {mini.final_url() or '(unknown)'}\n"
                    f"VIEWPORT: {'x'.join(str(v) for v in mini.viewport_size())}\n\n"
                    f"RECENT ACTIONS (most recent last):\n{history_text}\n\n"
                    "Look at the screenshot below AND the CDP packet log that follows. "
                    "The log shows EXACTLY what hit Chromium (Input.dispatchMouseEvent + "
                    "coords) and what the page did in response (Network.requestWillBeSent, "
                    "responseReceived, loadingFinished). Use it to tell whether your last "
                    "click actually focused anything or hit empty page space, whether the "
                    "page is mid-navigation, etc. Then call the appropriate tool."
                ),
            },
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{last_screenshot_b64}"},
            },
            {
                "type": "text",
                "text": (
                    "=== CDP PACKET LOG (last ~80 lines, this session only) ===\n"
                    + (cdp_tail or "(empty)")
                ),
            },
            {
                "type": "text",
                "text": (
                    "=== LIVE PAGE HTML (scripts/styles/svg/meta stripped) ===\n"
                    + (page_html or "(empty)")
                ),
            },
        ]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_blocks},
        ]

        # 3) Get the next action from the driver. PRIMARY path: web-driven
        # via the user's logged-in chatgpt.com Plus session (no API key,
        # no 429). FALLBACK path: api.openai.com (only if no driver_mini).
        if driver_mini is not None:
            try:
                from web_vision_driver import driveOneTurn as _webTurn  # type: ignore
                # Persist screenshot to a temp file for the web driver.
                import tempfile as _tf
                import base64 as _b64
                _png = Path(_tf.mkdtemp()) / f"pilot-step-{step}.png"
                _png.write_bytes(_b64.b64decode(last_screenshot_b64))
                user_text = (
                    f"GOAL:\n{goal}\n\nSTEP: {step}/{max_steps}\n"
                    f"CURRENT URL: {mini.final_url() or '(unknown)'}\n"
                    f"VIEWPORT: {'x'.join(str(v) for v in mini.viewport_size())}\n\n"
                    f"RECENT ACTIONS:\n{history_text}\n\n"
                    "Reply with ONE JSON object on a single line, no markdown, no prose:\n"
                    '  {"action":"CLICK","x":<int>,"y":<int>,"why":"<reason>"}\n'
                    '  {"action":"TYPE","text":"<string>","why":"<reason>"}\n'
                    '  {"action":"KEY","key":"enter|tab|esc|...","why":"<reason>"}\n'
                    '  {"action":"NAVIGATE","url":"<url>","why":"<reason>"}\n'
                    '  {"action":"WAIT","ms":<int>,"why":"<reason>"}\n'
                    '  {"action":"DONE","extracted":"<the chat reply>","why":"<reason>"}\n'
                    '  {"action":"FAIL","why":"<reason>"}\n'
                    "Look at the attached screenshot."
                )
                web_result = _webTurn(driver_mini, _png, SYSTEM_PROMPT, user_text, timeout_s=90)
                if web_result.get("ok"):
                    # Parse the chatgpt-text reply into the action shape.
                    import json as _json, re as _re
                    raw = str(web_result.get("reply") or "")
                    m = _re.search(r"\{[^{}]*\"action\"[^{}]*\}", raw, _re.DOTALL)
                    if m:
                        try:
                            parsed_action = _json.loads(m.group(0))
                            # Synthesize the same body shape api.openai.com would have returned.
                            body = {"choices": [{"message": {"tool_calls": [{
                                "id": f"call_{step}",
                                "type": "function",
                                "function": {
                                    "name": parsed_action.get("action", "wait").lower(),
                                    "arguments": _json.dumps({k: v for k, v in parsed_action.items() if k != "action"}),
                                },
                            }]}}]}
                            status = 200
                        except Exception as _pe:
                            status, body = 599, {"error": f"web driver reply unparseable: {_pe}", "raw": raw[:500]}
                    else:
                        status, body = 599, {"error": "web driver reply had no JSON action", "raw": raw[:500]}
                else:
                    status, body = 599, {"error": web_result.get("error", "web driver failed"), "_raw": web_result}
            except Exception as e:
                status, body = 599, {"error": f"web_vision_driver crashed: {type(e).__name__}: {e}"}
        else:
            # Fallback to api.openai.com — only when no driver is available.
            status, body = _postOpenAI(api_key, messages, model=model, max_tokens=800, tools=TOOLS)
        if status == 401:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": "OpenAI 401 — invalid or expired key",
                "body": body,
            }
        if status != 200:
            err_detail = ""
            if isinstance(body, dict):
                err_detail = str(body.get("error") or body.get("raw") or "")[:300]
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": f"HTTP {status}: {err_detail}" if err_detail else f"HTTP {status}",
                "body": body,
            }

        # 4) Read the structured tool_call → action dict. Fall back to
        #    free-text JSON only if the model somehow didn't emit a tool_call
        #    (shouldn't happen with tool_choice=required, but be robust).
        action: dict[str, Any]
        try:
            msg = body["choices"][0]["message"]
        except Exception:
            return {
                "ok": False, "steps": step, "action_history": history,
                "final_url": mini.final_url(),
                "error": "OpenAI response missing choices[0].message",
                "body": body,
            }
        tool_calls = msg.get("tool_calls") or []
        if tool_calls:
            tc = tool_calls[0]
            fn = (tc.get("function") or {})
            name = str(fn.get("name") or "").strip().lower()
            try:
                args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(args, dict):
                    args = {}
            except Exception:
                args = {}
            action = {"action": name, **args}
        else:
            # Fallback path — old free-text JSON extraction.
            action = _parseAction(str(msg.get("content") or ""))
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
            elif atype == "click_text":
                ct = mini.click_text(str(action.get("text", "")), exact=bool(action.get("exact", False)))
                note = f"click_text -> {json.dumps(ct, default=str)[:160]}"
            elif atype == "run_js":
                code = str(action.get("code", "")) or "''"
                try:
                    r2 = mini._send("Runtime.evaluate", {"expression": code, "returnByValue": True, "awaitPromise": True})
                    val = ((r2 or {}).get("result") or {}).get("value")
                    exc = (r2 or {}).get("exceptionDetails")
                    if exc:
                        note = f"run_js EXCEPTION: {json.dumps(exc, default=str)[:200]}"
                    else:
                        note = f"run_js result: {json.dumps(val, default=str)[:200]}"
                except Exception as _e:
                    note = f"run_js failed: {type(_e).__name__}: {_e}"
            elif atype == "done":
                last_extracted = action.get("extracted")
                last_summary = str(action.get("summary") or "")
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
