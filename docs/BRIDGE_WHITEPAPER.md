# CBE Browser Bridge — Architecture v2

**Status:** design doc, supersedes v1.
**Author:** Trent + Claude, 2026-05-23.
**Audience:** anyone touching `bridges_cpp/`, `tools/gpt_vision_pilot.py`,
or `extension.js` bridge code.

---

## 0. What a "bridge" is, in one sentence

A bridge is a piece of software that drives **the actual chatgpt.com (or
claude.ai / gemini / grok / copilot / deepseek) website** from outside
the browser, so the CBE panel can pretend the web UI is just another
chat completion endpoint. It is **NOT** an API client. The whole point is
to use the free / paid-flat-rate web UI instead of paying per-token API
fees.

The user already has a paid ChatGPT Plus / Claude Pro account. The bridge
turns that monthly fee into "unlimited API access" by automating the
button-clicking a human would otherwise do.

The OpenAI API is involved **only** as the brain that figures out which
buttons to click. And v2 exists because in v1 we call that brain on
**every single message**, which burns more API credits than we save.

---

## 1. Why v1 is broken (the bug we are fixing)

Today, every chat through `bridge_chat` does this:

```
user types message
  -> bridge_pilot.py spawned by CBE-Bridge-<Target>.exe
  -> Page.captureScreenshot via CDP
  -> POST api.openai.com/v1/chat/completions  (gpt-4o vision)  ← API HIT
  -> gpt-4o returns "click selector X, type Y"
  -> bridge executes
  -> Page.captureScreenshot again
  -> POST api.openai.com/v1/chat/completions  ← API HIT
  -> gpt-4o returns "the reply text is …"
  -> bridge returns answer to panel
```

Per message we make **2–6 vision-API calls** (screenshot + decide + verify
reply landed + sometimes re-check during streaming). At gpt-4o-mini vision
prices that's already $0.01–$0.05 per chat. At gpt-4o it's $0.05–$0.20.

For a power user that's $5–$50/day routed through OpenAI just to drive
chatgpt.com. **Defeats the entire purpose of having a Plus subscription.**

The page layout doesn't change between messages. We are paying gpt-4o to
re-discover the same `<button class="send-button">` over and over. The fix
is obvious: discover it once, write down what we found, and stop asking.

---

## 2. The v2 insight

> **Use gpt-4o once to write the automation script, then run the script.
> Only call gpt-4o again when the script breaks.**

Concretely, every target gets a small JavaScript "contract" injected into
the page that the bridge calls directly. The contract is **authored by
gpt-4o on first contact** and persisted to disk. After that, every chat
turn is a pair of in-page `eval_js` calls — no API hit at all.

When the page layout changes (chatgpt.com pushes a redesign, a selector
breaks, a CAPTCHA appears) the bridge detects it and re-invokes gpt-4o to
patch the script. The script lives in `bridge_scripts/<target>.js` and is
version-controlled per target.

Expected cost: **2 API hits per session** (login + first message) plus
~1 hit per layout-break event (weeks apart in practice). Down from
**2–6 hits per message**. ~100× cheaper.

---

## 3. The bridge state machine

A target has four states. Transitions are driven by what the JS contract
returns or fails to return.

```
                         ┌─────────────┐
                         │   COLD      │  no profile cookies, no script
                         └──────┬──────┘
                            login flow
                                ▼
                         ┌─────────────┐
                         │   WARM      │  logged in, no script yet
                         └──────┬──────┘
                            first chat
                                ▼
                         ┌─────────────┐
                         │   HOT       │  script installed, zero API hits
                         └──────┬──────┘
                            script error
                                ▼
                         ┌─────────────┐
                         │   PATCHING  │  one API hit to repair, back to HOT
                         └─────────────┘
```

### COLD → WARM (login)
1. Open target URL in headless chrome (`--headless=new`, per-target
   profile dir at `~/.cbe/profiles/<target>/`).
2. Screenshot.
3. Single API call to gpt-4o vision with the **login system prompt**
   (§ 6.1) — gpt-4o either drives the login form or says "magic-link
   sent, waiting for user to click email link" (then we surface a toast).
4. On success, cookies persist in the profile dir. Next launch reuses
   them and skips this state entirely.

### WARM → HOT (script bootstrap)
1. User sends first message of session.
2. Screenshot.
3. Single API call with the **bootstrap system prompt** (§ 6.2) +
   embedded screenshot. gpt-4o is told to:
   - Read the page
   - Type the user's message into the input
   - Submit
   - Watch the reply stream until done
   - Capture the final reply text
   - **Then write a `window.__cbeBridge` object containing the four
     functions in § 4 and call `install_bridge_script(<source>)`**
4. We save the script to `bridge_scripts/<target>.js`.

### HOT (no API hits)
On every subsequent message:
1. Eval `window.__cbeBridge.send(<user_message>)` in the page.
2. Poll `window.__cbeBridge.poll()` every 250 ms until it returns
   `{state: "done", text: "..."}` or `{state: "error", reason: "..."}`.
3. Return the text. **Zero API hits.**

### HOT → PATCHING (error recovery)
Trigger conditions (any of):
- `poll()` returns `{state: "error", reason: …}` for >2 consecutive polls
- `poll()` returns `{state: "loading"}` for >120 s with no progress
- `send()` throws (e.g. selector not found)
- Page URL changed unexpectedly (likely auth expired or redesign)

When triggered:
1. Screenshot.
2. Single API call with the **patch system prompt** (§ 6.3) — gives
   gpt-4o the current script source, the failing call, and the error.
3. gpt-4o returns a patched script.
4. Validate (syntax check + smoke test: `__cbeBridge.healthCheck()`).
5. Save and re-enter HOT for the original message.

If patching fails 3× in a row, give up: drop the saved script, return
the original error to the user with "Bridge needs manual attention. See
`feedback.log`".

---

## 4. The JavaScript contract

Every target script MUST install `window.__cbeBridge` with exactly these
methods. gpt-4o is given this shape as the bootstrap target.

```js
window.__cbeBridge = {
    // Version of THIS script. Bump on any breaking change.
    version: "1.0.0",

    // Stamp of when gpt-4o wrote it (ISO). Used to age out very old
    // scripts that may have drifted from current page layout.
    bornAt: "2026-05-23T...",

    // Smoke test — verify the page is in a state this script can drive.
    // Return {ok: true} or {ok: false, reason: "..."}.
    healthCheck() { ... },

    // Submit a user message. Synchronous DOM ops only — DO NOT await
    // the assistant reply here. Returns {ok: true} or throws.
    send(messageText) { ... },

    // Poll for assistant progress. Called every 250 ms after send().
    // Return one of:
    //   {state: "loading"}                          — still streaming
    //   {state: "done", text: "<final reply>"}     — complete
    //   {state: "error", reason: "<why>"}          — UI error visible
    poll() { ... },

    // Optional: get the conversation as the page sees it. Used by the
    // panel's "import history" feature.
    getHistory() { ... },
};
```

That's it. No DOM-specific helpers, no per-target shape, no inheritance.
Every target gets ONE file at `bridge_scripts/<target>.js` whose only
job is to define this object. gpt-4o is the author; the bridge runtime
is the consumer.

---

## 5. Tools exposed to gpt-4o

When we call the OpenAI API in COLD / WARM / PATCHING states, gpt-4o
needs to actually drive the browser. We give it real OpenAI **function
calling** tools — not a chat-fiction "describe the click" pattern.
Every tool below maps to a real CDP call on the per-target headless
chrome.

### `get_offscreen_screenshot()`
Return the current page as a base64 PNG. gpt-4o uses this to see what
the page looks like RIGHT NOW (after an action). No params.

```json
{"type": "function", "function": {
  "name": "get_offscreen_screenshot",
  "description": "Capture a fresh PNG of the current target page state. Use this AFTER every send_click / send_key / eval_js to verify the action took effect. Returns a base64-encoded PNG attached as an image in the next turn.",
  "parameters": {"type": "object", "properties": {}, "required": []}
}}
```

### `send_click(target)`
Click. `target` is either `{selector: "..."}` (preferred — survives
zoom/layout) or `{x: N, y: N}` (fallback — pixel coords from the
screenshot).

```json
{"type": "function", "function": {
  "name": "send_click",
  "description": "Click an element. Prefer 'selector' (CSS selector) when you can identify the element by class/id/data attribute — it survives zoom and minor layout shifts. Use 'xy' (viewport pixel coordinates from the latest screenshot) only when no stable selector exists.",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": {"type": "string", "description": "CSS selector, e.g. 'button[data-testid=\"send\"]'"},
      "x": {"type": "integer"},
      "y": {"type": "integer"}
    }
  }
}}
```

### `send_key(key)`
Press a non-character key. `key` is one of: `Enter`, `Tab`, `Escape`,
`Backspace`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Space`.

```json
{"type": "function", "function": {
  "name": "send_key",
  "description": "Press a single non-character key (Enter, Tab, Escape, Backspace, arrow keys, Space). For typing text, use send_text instead.",
  "parameters": {
    "type": "object",
    "properties": {
      "key": {"type": "string", "enum": ["Enter","Tab","Escape","Backspace","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"]}
    },
    "required": ["key"]
  }
}}
```

### `send_text(text)`
Type literal text into the currently focused element. Faster than
sending each character as a key.

```json
{"type": "function", "function": {
  "name": "send_text",
  "description": "Type a string of text into whatever element currently has focus. Click the input first with send_click if focus isn't already there.",
  "parameters": {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"]
  }
}}
```

### `eval_js(code)`
Run arbitrary JS in the page context. Returns the JSON-serialized result
of the last expression. This is the tool gpt-4o uses to test
candidate `__cbeBridge` implementations and to introspect the DOM
(`document.querySelectorAll('button').length` and so on).

```json
{"type": "function", "function": {
  "name": "eval_js",
  "description": "Evaluate JavaScript in the page. Returns the JSON-serialized result of the last expression. Use this to probe the DOM (e.g. document.querySelector('...').outerHTML) and to test candidate __cbeBridge functions before you install them.",
  "parameters": {
    "type": "object",
    "properties": {"code": {"type": "string"}},
    "required": ["code"]
  }
}}
```

### `install_bridge_script(source)`
Persist the final `__cbeBridge` implementation to
`bridge_scripts/<target>.js` and inject it into the page. This is how
you exit the bootstrap loop and put the bridge into HOT state.

```json
{"type": "function", "function": {
  "name": "install_bridge_script",
  "description": "Persist a __cbeBridge implementation to disk and inject it into the page. Call this ONCE at the end of bootstrap, after you have verified all four methods (healthCheck, send, poll, getHistory) work via eval_js. The script you pass MUST be a complete self-contained JavaScript file that defines window.__cbeBridge.",
  "parameters": {
    "type": "object",
    "properties": {"source": {"type": "string"}},
    "required": ["source"]
  }
}}
```

### `leave_feedback(message)`
Append a line to `feedback.log`. Yes — this is functionally identical to
the bridge runtime doing `fs.appendFileSync('feedback.log', message)`
after the model returns. We expose it as a real tool anyway because:
1. It's a clear, named affordance gpt-4o sees in the tool list — it
   doesn't have to guess that "leave feedback" is even an option.
2. It can be called mid-task without ending the response (a free-text
   "note to self" pattern works differently in tool-calling agents).
3. Telemetry: we log every feedback call with the surrounding context
   automatically. A bare `echo` wouldn't carry that.

```json
{"type": "function", "function": {
  "name": "leave_feedback",
  "description": "Append a note to feedback.log for the human to read later. Use this for: questions you would have asked if a human were here, suggestions for improving the bridge, edge cases you noticed, anything else you would normally say in a conversation. The human will NOT respond — just write it down and keep working.",
  "parameters": {
    "type": "object",
    "properties": {
      "message": {"type": "string"},
      "severity": {"type": "string", "enum": ["info", "concern", "question", "idea"], "default": "info"}
    },
    "required": ["message"]
  }
}}
```

---

## 6. System prompts (verbatim)

These are the ACTUAL strings that go in `messages[0]` of the API call.
Not paraphrased — what gpt-4o reads.

### 6.1 Login prompt (COLD → WARM)

```
You are an automation assistant helping your buddy automate a logged-in
session on {target_label} ({target_url}). You're alone — there is no
human watching this run and no one to answer questions. Any attempt to
ask a question to the user will break the script. If you have questions,
concerns, or improvement ideas, use the leave_feedback tool — your
buddy will read them later.

Your job RIGHT NOW: get this browser session into a state where
{target_label} considers the user logged in. The user's profile cookies
are persistent — once you successfully log in, you will not have to do
this again on future runs.

What you have:
  - A real, off-screen, headless chromium pointed at {target_url}.
  - The tools: get_offscreen_screenshot, send_click, send_key, send_text,
    eval_js, leave_feedback.
  - The user's saved credentials are in the page's password manager IF
    they have used this browser before. Try clicking the email field
    first to see if autofill offers anything.

What you don't have:
  - A human. Don't ask questions. Don't say "let me know if..." —
    there's no one to tell you.
  - Magic-link access. If {target_label} sends a code/link to email,
    leave_feedback("magic-link required: <details>") and stop. The
    bridge runtime will surface a toast to the user.

When you believe the session is logged in:
  1. Take a fresh screenshot to confirm you see the main chat UI
     (not a login form).
  2. Reply with the literal text: LOGIN_OK
  3. Stop.

If you cannot log in (CAPTCHA, magic link, 2FA without an authenticator
the user must touch), reply: LOGIN_BLOCKED: <one-line reason> and stop.

Finish the task. Don't narrate. Use the tools.
```

### 6.2 Bootstrap prompt (WARM → HOT)

```
You are an automation assistant helping your buddy automate sending
chat messages to {target_label}. You are alone — no human is watching
and no one can answer questions. Asking will break the script.
Concerns / ideas / questions go in leave_feedback.

Your job has two parts:

PART A — Send this one message and get the reply:
  ---
  {user_message}
  ---
  Take a screenshot. Use send_click + send_text + send_key to put the
  message in the input box and submit it. Watch the page until
  {target_label} finishes streaming the assistant reply. Capture the
  final reply text (use eval_js on the assistant message's container).

PART B — Write a __cbeBridge script so we never have to call you for a
plain message again:

  Author a JavaScript object literal `window.__cbeBridge` with exactly
  these methods:

    healthCheck() -> {ok: true} OR {ok: false, reason: "..."}
       Verify the page is in the chat UI (not login, not error page).

    send(messageText) -> {ok: true}
       Put messageText into the input and submit. Synchronous DOM ops
       only. Do NOT wait for the reply here.

    poll() -> {state: "loading"} | {state: "done", text: "..."} | {state: "error", reason: "..."}
       Read the page state. Return the FINAL assistant reply text when
       streaming is done. Return "loading" while streaming. Return
       "error" if the page is in an error state (rate limit, network
       failure, etc).

    getHistory() -> [{role: "user"|"assistant", text: "..."}, ...]
       Optional. Return the conversation as the page renders it.

  Test EACH method via eval_js before installing. Specifically:
  1. eval_js("window.__cbeBridge.healthCheck()") must return ok:true
  2. eval_js("window.__cbeBridge.poll()") on the just-completed chat
     must return {state: "done", text: "<the reply from Part A>"}.
  3. eval_js("window.__cbeBridge.getHistory()") must include the user
     message from Part A and the assistant reply.

When all three tests pass, call install_bridge_script(source) with the
COMPLETE self-contained script. Then reply with the assistant text
from Part A, prefixed with "REPLY: ".

If you cannot author a reliable script (page is too dynamic, selectors
change per render, etc.), reply "REPLY: <text>" with just Part A's
answer, then leave_feedback("script-author-failed: <reason>"). The
bridge will fall back to using you on every message — expensive, but
functional. Try to avoid this.

Finish the task. Don't narrate. Use the tools.
```

### 6.3 Patch prompt (HOT → PATCHING → HOT)

```
You are repairing a broken bridge script for {target_label}. You're
alone — no human, no questions, leave_feedback for anything you can't
do silently.

The current script lives in window.__cbeBridge and was written
{age_human} ago. It broke. Details:

  Last call:        {failing_method}({args})
  Returned:         {actual_return}
  Expected shape:   {expected_shape}
  User message:     {user_message}

The current script source is:
  ```
  {current_script_source}
  ```

A fresh screenshot of the page is attached.

Your job: figure out what changed (page redesigned? selector renamed?
the user got logged out? rate-limit screen? CAPTCHA?), and either:

  (a) PATCH — fix the script. eval_js to verify the fix works on the
      current page state. install_bridge_script(<new source>) to
      persist. Reply: "PATCHED: <one-line summary of what changed>".

  (b) BLOCK — if the page is in a state no script can drive (CAPTCHA,
      account suspended, hard rate-limit with a cooldown), don't patch.
      Reply: "BLOCKED: <one-line reason>" and leave_feedback with the
      full context. The bridge runtime will surface a toast to the user.

If (a) and you do install, also retry the user's original message: call
window.__cbeBridge.send({user_message}), poll until done, include the
result text in your reply as "PATCHED: ... | REPLY: <text>".

Finish the task. Don't narrate.
```

---

## 7. How screenshots actually move around

1. **Capture**: bridge runtime sends CDP `Page.captureScreenshot
   {format: "png"}` to the per-target chrome on its CDP port
   (9788–9794). Returns base64.

2. **Send to gpt-4o**: embedded in the OpenAI API call as a multimodal
   user message:

   ```json
   {
     "role": "user",
     "content": [
       {"type": "text", "text": "<rendered prompt or tool result>"},
       {"type": "image_url", "image_url": {
         "url": "data:image/png;base64,<base64>",
         "detail": "high"
       }}
     ]
   }
   ```

3. **`get_offscreen_screenshot` tool**: when gpt-4o calls the tool, the
   bridge runtime captures fresh, then includes the result image in the
   tool message:

   ```json
   {
     "role": "tool",
     "tool_call_id": "<id>",
     "content": [
       {"type": "text", "text": "Screenshot captured at <ts>, 1400x1000."},
       {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
     ]
   }
   ```

   Note: tool result messages with image content are supported on
   `gpt-4o` and `gpt-4o-mini` (verified working as of 2026-05).

4. **No retention on disk**. Screenshots are passed through memory. We
   write them to `bridge_logs/screenshots/<ts>.png` only when
   `BRIDGE_TRACE=1` is set, for debugging.

---

## 8. `leave_feedback` script

Yes, this is the silly part. The user explicitly called it out, so:

The model COULD trivially do this with `eval_js("...")` or by us just
parsing free text out of the model's reply. We expose it as a real tool
anyway because:

- Named tools in the tool list make the affordance visible. A model
  that doesn't see a `leave_feedback` tool will not know that "write a
  note to your buddy" is something it's allowed to do. It will instead
  try to ask the user — which we explicitly forbid in the prompt.
- Tool calls give us a clean structured log (timestamp, severity,
  surrounding tool call sequence) that we can grep later. A free-text
  "I have a concern about X" buried in a `REPLY:` would never get
  surfaced.
- It costs zero extra prompt tokens to expose. The tool list lives in
  the API payload either way.

The actual implementation in the bridge runtime is one line:

```python
def leave_feedback(message: str, severity: str = "info") -> dict:
    """Append a line to feedback.log for the human to read later."""
    stamp = datetime.now(timezone.utc).isoformat()
    line = f"[{stamp}] [{severity}] [{TARGET}] {message}\n"
    with open(FEEDBACK_LOG, "a", encoding="utf-8") as f:
        f.write(line)
    return {"ok": True, "logged_to": str(FEEDBACK_LOG)}
```

That's it. The "script" is the same eight lines.

We also ship a CLI version at `tools/leave_feedback.py` so a developer
can manually log a note in the same format:

```bash
py tools/leave_feedback.py --target claude --severity concern "the share dialog stopped opening"
```

Identical effect to gpt-4o calling the tool — same file, same line
format. Keeps the on-disk log uniform whether the entry came from the
model or a human.

---

## 9. Cost analysis (back-of-envelope)

Assume a heavy user: 200 chat turns/day, evenly across 3 bridge targets.

### v1 (today)
- ~3 API calls per turn (screenshot in, decide, sometimes verify)
- gpt-4o at vision pricing: ~$0.04 per call avg
- **600 calls/day × $0.04 = $24/day = $720/month**

### v2 (this proposal)
- ~2 API calls per session per target (login if needed + first message)
- Sessions: ~3/day per target (morning, afternoon, evening), 3 targets
- = 9 sessions × 2 calls = 18 calls/day at $0.04 = $0.72/day
- Plus occasional patching: assume 1 break/week/target = ~0.4 calls/day at $0.04
- **~$0.75/day = $22/month**

**~33× cheaper.** The math is approximate but the order of magnitude is
the point.

---

## 10. Files this changes

```
NEW:
  bridges_cpp/bridge_pilot_v2.py        runtime that implements the state machine
  bridge_scripts/                       per-target __cbeBridge sources
  bridge_scripts/.gitkeep
  feedback.log                          appended-to by leave_feedback tool
  tools/leave_feedback.py               CLI version of the tool
  docs/BRIDGE_WHITEPAPER.md             this file

MODIFIED:
  bridges_cpp/bridge_server.cpp         shell out to bridge_pilot_v2.py
                                        instead of bridge_pilot.py
  extension.js                          surface PATCHING toasts + BLOCKED toasts
  tools/gpt_vision_pilot.py             gutted — superseded by bridge_pilot_v2
  panel/panel.js                        no change — same wire shape

DELETED (after migration verified):
  tools/gpt_vision_pilot.py
  bridges_cpp/bridge_pilot.py
```

---

## 11. Open questions for the implementer

Not blockers; flag in `feedback.log` if you hit them:

1. **gpt-4o vs gpt-4o-mini for patching.** Mini is 1/15th the price and
   probably adequate for "the selector changed from `.foo` to `.bar`".
   Default to mini, escalate to full only if mini's patch fails its
   own healthCheck.

2. **Script invalidation on Chrome major version updates.** Chrome
   pushes monthly. Some patches change DOM. Should we automatically
   invalidate all scripts and re-bootstrap on detected Chrome version
   change? Probably yes — adds at most 6 API calls/month/target.

3. **Multi-conversation state.** Today `poll()` reads the last
   assistant message. If the user is in a SHARED session in another
   tab, that read could pick up content the user typed elsewhere. v2
   should namespace conversations by giving each chat its own
   `data-cbe-msg-id` injected at send time. Defer until someone hits it.

4. **Streaming chunks to the panel.** v1 returns the final reply only.
   v2 could stream by having `poll()` return cumulative text and the
   bridge runtime forwarding the diff. Nice-to-have, not v2-blocking.
