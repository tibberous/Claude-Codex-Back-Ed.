# CBE Browser Bridge — Architecture v2

**Status:** design doc, supersedes v1.
**Author:** Trent + Claude, 2026-05-23.
**Audience:** anyone touching `bridges_py/`, `providers/`, `start.py`'s
offscreen pipeline, or `extension.js` bridge code.

---

## 0. What a "bridge" is, in one sentence

A bridge is a piece of software that drives **the actual chatgpt.com (or
claude.ai / gemini / grok / copilot / deepseek / qwen) website** from
outside the browser, so the CBE panel can pretend the web UI is just
another chat completion endpoint. It is **NOT** an API client. The whole
point is to use the free / paid-flat-rate web UI instead of paying
per-token API fees.

The user already has a paid ChatGPT Plus / Claude Pro account. The bridge
turns that monthly fee into "unlimited API access" by automating the
button-clicking a human would otherwise do.

The OpenAI API is involved **only** as the brain that figures out which
buttons to click, and only on first contact per session. After that, the
hot path is pure in-page JavaScript — zero API hits.

---

## 1. Why v1 was broken (the bug we are fixing)

The old design (v1) was a fleet of per-target C++ tray exes
(`bridges_cpp/CBE-Bridge-*.exe`), each spawning a headless Chrome via
`--headless=new` and driving it through CDP. Every chat through
`bridge_chat` did this:

```
user types message
  -> bridge_pilot.py spawned by CBE-Bridge-<Target>.exe
  -> chrome.exe --headless=new on its own CDP port
  -> Page.captureScreenshot via CDP
  -> POST api.openai.com/v1/chat/completions  (gpt-4o vision)  ← API HIT
  -> gpt-4o returns "click selector X, type Y"
  -> bridge executes
  -> Page.captureScreenshot again
  -> POST api.openai.com/v1/chat/completions  ← API HIT
  -> gpt-4o returns "the reply text is …"
  -> bridge returns answer to panel
```

Per message: **2–6 vision-API calls** (screenshot + decide + verify reply
landed + sometimes re-check during streaming). At gpt-4o vision prices
that's $0.05–$0.20 per chat. For a power user that's $5–$50/day routed
through OpenAI just to drive chatgpt.com. **Defeats the entire purpose
of having a Plus subscription.**

Worse, the layout doesn't change between messages. We were paying gpt-4o
to re-discover the same `<button data-testid="send">` over and over.
And every target needed its own C++ binary, its own .rc file, its own
build line in `build_bridges.ps1`. Adding a provider was a code change.

v2 fixes all of this.

---

## 2. The v2 insight (two-part)

> **(a) Use gpt-4o once to write the automation script, then run the
> script. Only call gpt-4o again when the script breaks.**
>
> **(b) Targets are data, not code. One unified Python service drives
> every target. Each target is one XML manifest in `providers/`.**

Concretely:

1. Every target gets a small JavaScript "contract" injected into the page
   that the bridge calls directly. The contract is **authored by gpt-4o
   on first contact** and persisted to disk. After that, every chat turn
   is a pair of in-page `runJavaScript()` calls — no API hit at all.

2. Adding a new provider = dropping `providers/<key>.xml` into the repo
   and shipping. The unified Python service picks it up; the help docs,
   marketplace UI, and asset materialiser all read the manifest. No
   recompile, no second binary, no .rc file.

When the page layout changes (chatgpt.com pushes a redesign, a selector
breaks, a CAPTCHA appears) the bridge detects it and re-invokes gpt-4o
to patch the script. Patched script is saved to
`state/providers/<key>.script.js` and reused on next session.

Expected cost: **2 API hits per session** (login + first message)
plus ~1 hit per layout-break event (weeks apart in practice). Down from
**2–6 hits per message**. ~33× cheaper — see § 11.

---

## 3. Process topology

**One unified Python+PySide6 service.** `bridges_py/bridge_service.py`
handles all targets. The C++ tray (`bridges_cpp/`) is **deprecated** and
will be removed once v2 ships.

The service delegates browser work to `start.py`'s existing offscreen
QWebEngine pipeline. `start.py` already implements 8 offscreen modes
(constants at lines 857–864: `AUTO`, `HIDDEN`, `OFFSCREEN_WINDOW`,
`MINIMIZED`, `QT`, `XVFB`, `XDUMMY`, `XPRA`) and a factory
`getMiniComputer(target, offscreen=True, autostart=True)`. The bridge
service shells into:

```
py start.py --serve-bridge --target <key> --offscreen --offscreen-mode=auto
```

…which returns a handle the service uses to call `runJavaScript()`,
`QWidget.grab()`, navigate, and read the URL bar.

**Hard rules:**

- **No `chrome.exe` spawning.** No Chrome subprocess of any kind.
- **No `--headless=new` flag.** That's a v1 ghost — gone.
- **No CDP wire.** Qt's `runJavaScript()` for JS, `QWidget.grab()` for
  screenshots, `QWebEngineUrlRequestInterceptor` for network capture.
- **One process, many tabs.** Each target is a `QWebEngineView` inside
  the unified service, isolated by a per-target `QWebEngineProfile`
  pointed at `bridge_profiles/<key>/`.

---

## 4. The bridge state machine

A target moves through **six** states. Transitions are driven by what
the JS contract returns, what the page URL says, or what the page DOM
shows.

```
                       ┌─────────────────────────┐
                       │         COLD            │  no profile, no script
                       └──────────┬──────────────┘
                          launched, no cookies
                                  ▼
                       ┌─────────────────────────┐
                       │      REGISTERING        │  no account; signup flow
                       └──────────┬──────────────┘
                            account created
                                  ▼
                       ┌─────────────────────────┐
                       │         WARM            │  logged in, no script yet
                       └──────────┬──────────────┘
                              first chat
                                  ▼
                       ┌─────────────────────────┐
                       │          HOT            │  script installed, 0 API hits
                       └──────────┬──────────────┘
                            script error
                                  ▼
                       ┌─────────────────────────┐
                       │       PATCHING          │  1 API hit to repair, → HOT
                       └──────────┬──────────────┘
                          hard human-touch wall
                                  ▼
                       ┌─────────────────────────┐
                       │  BLOCKED_NEEDS_HUMAN    │  toast user, await "I did it"
                       └─────────────────────────┘
```

### 4.1 COLD → REGISTERING (no account yet)

Triggered when the user enables a provider for the first time AND the
login page is reached AND no saved credentials exist in
`config.ini` `[bridge_credentials.<key>]`.

1. Bridge generates a random username + 32-char strong password.
2. Persists immediately to `config.ini`:

   ```ini
   [bridge_credentials.chatgpt]
   username = cbe_a7f3@trentontompkins.com
   password = <random 32 chars>
   created  = 2026-05-23T14:22:01Z
   ```

3. Opens `<urls><create_account>` from the manifest.
4. Calls gpt-4o with the **signup prompt** (§ 7.1) and the new
   credentials in the system message. gpt-4o drives the signup form via
   the standard tool set.
5. If verification email is required, gpt-4o calls `read_verification_email(<addr>)`,
   which polls IMAP via `hooks/gmail_api_hook.py` for up to 90 s,
   returning the verification URL once it arrives. Bridge navigates to
   the URL and continues the flow.
6. Success → WARM. Failure (phone verification, CAPTCHA, geo-block) →
   BLOCKED_NEEDS_HUMAN.

### 4.2 COLD → WARM (login, credentials exist)

1. Service opens `<urls><login>` in the per-target offscreen view.
2. Screenshot.
3. Single API call with the **login prompt** (§ 7.2). gpt-4o drives the
   login form using the credentials from `config.ini`, or — if the page
   already shows the chat UI because cookies survived — replies
   `LOGIN_OK` immediately and we transition with zero typing.
4. On success, cookies persist in the per-target Qt profile under
   `bridge_profiles/<key>/`. Next launch skips this state entirely.

### 4.3 WARM → HOT (script bootstrap)

1. User sends first message of session.
2. Source-capture pipeline (§ 6) is already streaming page network
   responses into `bridge_sources/<key>/<session_id>/`.
3. Screenshot.
4. Single API call with the **bootstrap prompt** (§ 7.3). gpt-4o is told
   to do all of this in ONE shot:

   - Read the page (and the captured sources — JS bundles especially).
   - **Discover models** by `grep_sources` over the JS bundles for
     hardcoded model arrays. Call `register_models(<list>)` once.
   - Type the user's message into the input, submit, watch the reply
     stream to completion, capture the final text.
   - Author `window.__cbeBridge` (§ 5) and call
     `install_bridge_script(<source>)`.

5. Script is saved to `state/providers/<key>.script.js`.

### 4.4 HOT (no API hits, the hot path)

On every subsequent message of every subsequent session:

1. `runJavaScript("window.__cbeBridge.send(<json-quoted-text>)")`
2. Poll `runJavaScript("window.__cbeBridge.poll()")` every 250 ms until
   it returns `{state: "done", text: "..."}` or
   `{state: "error", reason: "..."}`.
3. Return the text. **Zero API hits.** Hot path is O(1) DOM ops, target
   <50 ms per chat turn.

### 4.5 HOT → PATCHING (error recovery)

Trigger conditions (any of):

- `poll()` returns `{state: "error", reason: …}` for >2 consecutive polls
- `poll()` returns `{state: "loading"}` for >120 s with no progress
- `send()` throws (selector not found)
- Page URL changed unexpectedly (auth expired? redesign?)

When triggered:

1. Screenshot + fresh source capture for the current page.
2. Single API call with the **patch prompt** (§ 7.4) — gives gpt-4o the
   current script, the failing call, the error, and the new sources.
3. gpt-4o returns a patched script. Validate (syntax check + smoke test:
   `__cbeBridge.healthCheck()`).
4. Save and re-enter HOT for the original message.

If patching fails 3× in a row, drop to BLOCKED_NEEDS_HUMAN.

### 4.6 PATCHING → BLOCKED_NEEDS_HUMAN

Some failures are not script bugs:

- Hard CAPTCHA (Cloudflare Turnstile, hCaptcha image grid).
- Magic-link that requires the user touching their phone (Authenticator
  app, SMS, push prompt).
- Account suspension banner.
- Hard rate-limit with a multi-hour cooldown.

When detected (gpt-4o calls `leave_feedback(severity="blocked", ...)`
during PATCHING, or three patch attempts fail), the service:

1. Sets the target's state to `BLOCKED_NEEDS_HUMAN`.
2. Pushes a toast to the panel via the extension WebSocket:
   *"Claude (claude.ai) needs your attention — tap to handle."*
3. Surfaces an **"I did it"** button. When the user clicks it, the
   service transitions back to PATCHING for one more try (or directly to
   HOT if the script smoke-test passes).

The user is the unblocker. The bridge never burns more API calls
guessing past a wall.

---

## 5. The JavaScript contract

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
    healthCheck() { ... },                       // -> {ok: true} | {ok: false, reason}

    // Submit a user message. Synchronous DOM ops only — do NOT await
    // the assistant reply here. Returns {ok: true} or throws.
    send(messageText) { ... },

    // Poll for assistant progress. Called every 250 ms after send().
    poll() { ... },                              // -> {state: "loading"}
                                                 //  | {state: "done", text}
                                                 //  | {state: "error", reason}

    // Optional: get the conversation as the page sees it.
    getHistory() { ... },                        // -> [{role, text}, ...]

    // Optional: switch the active model. text matches one of the strings
    // GPT-4o passed to register_models() at bootstrap.
    selectModel(modelName) { ... },              // -> {ok: true} | {ok: false}
};
```

That's it. No DOM-specific helpers, no per-target shape, no inheritance.
Every target gets ONE file at `state/providers/<key>.script.js` whose
only job is to define this object.

**Distillation discipline.** The bootstrap prompt (§ 7.3) is explicit:
the functions GPT-4o writes MUST be hardcoded distillations of what it
learned during bootstrap. They must NOT do runtime re-discovery. No
`fetch()` calls. No broad `document.querySelectorAll('*')` scans. No
greps. If the cached selector breaks, that's PATCHING's problem — not a
runtime fallback.

---

## 6. Source-capture pipeline

The biggest reliability win in v2: gpt-4o doesn't squint at screenshots
to guess at model names. It reads the actual JavaScript bundles.

When a target's offscreen view first navigates to the chat URL, we
install a `QWebEngineUrlRequestInterceptor` (or hook the response
profile, depending on what Qt 6.x exposes cleanly) that tees every
response body to disk:

```
bridge_sources/<key>/<session_id>/
    manifest.json          # url -> file mapping, mime, status, ts
    01_index.html
    02_main.<hash>.js
    03_chunk.<hash>.js
    04_models.json
    05_styles.<hash>.css
    ...
```

`manifest.json` looks like:

```json
{
  "session_id": "2026-05-23T142201-chatgpt",
  "captured_at": "2026-05-23T14:22:01Z",
  "entries": [
    {"file": "01_index.html",        "url": "https://chatgpt.com/",                "mime": "text/html",        "status": 200},
    {"file": "02_main.a1b2c3.js",    "url": "https://chatgpt.com/_next/static/...","mime": "application/js",   "status": 200},
    {"file": "04_models.json",       "url": "https://chatgpt.com/backend-api/...", "mime": "application/json", "status": 200}
  ]
}
```

GPT-4o gets three new tools to work with the capture:

- `list_sources(glob)` — list files matching a glob.
- `grep_sources(pattern)` — ripgrep across all captured files, returns
  filename + line.
- `read_source(path)` — read one file from the capture.

This is how **model discovery** works in v2. Instead of asking GPT-4o
to look at a dropdown screenshot and guess, the bootstrap prompt tells
it to:

```
grep_sources('"gpt-[45]')         # ChatGPT hardcoded model strings
grep_sources('"claude-')          # Claude Pro model strings
grep_sources('"qwen[-\\d]')       # Qwen
```

Find the JS module that hardcodes the model array, read it, call
`register_models([...])`. Done in one shot — far more reliable than
DOM-querying a dropdown that may not even be open.

**Hygiene.** `bridge_sources/<key>/` keeps the **last 2 sessions** per
target. Older sessions are deleted on bridge boot.

---

## 7. System prompts (verbatim)

These are the ACTUAL strings that go in `messages[0]` of the API call.
Not paraphrased — what gpt-4o reads.

### 7.1 Signup prompt (COLD → REGISTERING → WARM)

```
You are an automation assistant helping your buddy create a brand-new
account on {target_label} ({create_account_url}). You're alone — no human
is watching this run. Any attempt to ask a question to the user will
break the script. Concerns / ideas / questions go in leave_feedback.

Credentials your buddy has already chosen for this account (use exactly
these — do NOT invent your own):

    username / email : {username}
    password         : {password}

Your job RIGHT NOW: drive the signup form using those credentials. Click
the email field, type the username, click the password field, type the
password, accept any terms checkbox, submit.

If {target_label} sends a verification email, call
read_verification_email(<the username/email above>) — it will block up
to 90 seconds waiting for the email to arrive and return the
verification URL. Navigate to that URL and continue.

If signup requires a phone number, payment method, CAPTCHA, or any other
human-only input, STOP immediately. Reply: BLOCKED: <one-line reason>
and call leave_feedback(severity="blocked", ...). The bridge will
surface a toast to the user.

When the signup is complete and the chat UI is visible, reply: SIGNUP_OK
and stop.

Finish the task. Don't narrate. Use the tools.
```

### 7.2 Login prompt (COLD → WARM)

```
You are an automation assistant helping your buddy automate a logged-in
session on {target_label} ({login_url}). You're alone — no human is
watching. Asking will break the script. Concerns / ideas / questions go
in leave_feedback.

Credentials (use exactly these — do NOT invent or substitute):

    username / email : {username}
    password         : {password}

Your job RIGHT NOW: get this browser session into a state where
{target_label} considers the user logged in. The user's profile cookies
are persistent — once you succeed, future runs skip this state entirely.

What you have:
  - A real offscreen QWebEngine view pointed at {login_url}.
  - The tools: get_offscreen_screenshot, send_click, send_key, send_text,
    eval_js, read_source, grep_sources, list_sources, leave_feedback.
  - The page may already be logged in if cookies survived. Screenshot
    first — if you see the chat UI, just reply LOGIN_OK and stop.

What you don't have:
  - A human. Don't ask questions.
  - The ability to satisfy 2FA that requires a phone. If the page asks
    for a code from an authenticator app or SMS, reply:
        BLOCKED: 2fa-human-required
    and stop. The bridge will toast the user.

When the session is logged in, reply LOGIN_OK and stop.
If the page is a CAPTCHA wall or hard rate-limit, reply
LOGIN_BLOCKED: <reason> and stop.

Finish the task. Don't narrate. Use the tools.
```

### 7.3 Bootstrap prompt (WARM → HOT)

```
You are an automation assistant helping your buddy automate sending chat
messages to {target_label}. You are alone. No human. Asking breaks the
script. Concerns / ideas / questions → leave_feedback.

═══════════════════════════════════════════════════════════════════════
READ THIS TWICE. IT IS THE WHOLE JOB.

You are doing model discovery and structural analysis EXACTLY NOW, ONCE
PER LOGIN. The functions you write below MUST be HARDCODED DISTILLATIONS
of what you learn here — NOT runtime re-discovery.

The hot path that runs after you finish is O(1) DOM ops, target <50 ms
per chat turn. Your script will be called for EVERY chat message the
user sends, possibly thousands of times. It MUST:

    - Use cached selectors. No re-greps. No broad DOM scans.
    - NOT call fetch().
    - NOT call document.querySelectorAll('*') or similar broad queries.
    - Read ONE DOM subtree by a stable selector you discovered today.

If a selector you cache stops working tomorrow, the PATCHING flow will
re-invoke me to fix it. That is the contract. Don't try to be clever and
add runtime fallbacks — they will mask real breakage and inflate cost.
═══════════════════════════════════════════════════════════════════════

PART A — discover what models {target_label} offers.

The page's network responses are captured to disk. Browse them:

    list_sources("*.js")                    # find the JS bundles
    grep_sources('"gpt-')                   # or "claude-", "qwen", etc.
    read_source("02_main.a1b2c3.js")        # read the hits

Find the array of model identifiers the page uses. Call
register_models([{name: "GPT-5", id: "gpt-5"}, ...]) ONCE.

PART B — send this message and get the reply:
  ---
  {user_message}
  ---
  Screenshot. send_click + send_text + send_key the message in, submit.
  Watch the page until the assistant finishes streaming. Capture the
  final reply text via eval_js on the message container.

PART C — author window.__cbeBridge.

Write a JavaScript object literal with these methods:

    healthCheck() -> {ok: true} | {ok: false, reason: "..."}
    send(messageText) -> {ok: true}    (synchronous; no awaiting reply)
    poll() -> {state: "loading"} | {state: "done", text: "..."} | {state: "error", reason: "..."}
    getHistory() -> [{role: "user"|"assistant", text: "..."}, ...]
    selectModel(modelName) -> {ok: true} | {ok: false}   (optional)

Test EACH method via eval_js before installing:
  1. window.__cbeBridge.healthCheck() returns {ok:true}
  2. window.__cbeBridge.poll() on the just-completed chat returns
     {state:"done", text:"<reply from Part B>"}
  3. window.__cbeBridge.getHistory() includes Part B's user + assistant.

When all three pass, call install_bridge_script(source) with the
COMPLETE self-contained script. Then reply: "REPLY: <text from Part B>".

If you cannot author a reliable script, reply REPLY with the Part B text
and leave_feedback("script-author-failed: <reason>"). The bridge will
fall back to per-message GPT-4o (expensive but functional).

Finish the task. Don't narrate. Use the tools.
```

### 7.4 Patch prompt (HOT → PATCHING → HOT)

```
You are repairing a broken bridge script for {target_label}. You're
alone — no human, no questions. leave_feedback for anything else.

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

A fresh screenshot of the page is attached. A fresh source capture is
on disk — list_sources / grep_sources / read_source to investigate.

REMEMBER the distillation contract from bootstrap: the patched script
must still be O(1) DOM ops on the hot path. No runtime fallbacks. If
the page is now in a state no static script can drive (CAPTCHA, account
suspended), BLOCK — don't paper over it with a slow retry loop.

Your job: figure out what changed and either:

  (a) PATCH — fix the script. eval_js to verify the fix works on the
      current page state. install_bridge_script(<new source>) to
      persist. Reply: "PATCHED: <one-line summary of what changed>".

  (b) BLOCK — page is in a state no script can drive. Reply:
      "BLOCKED: <one-line reason>" and call leave_feedback(
      severity="blocked", ...). Bridge will toast the user.

If (a), also retry the user's original message: call
window.__cbeBridge.send({user_message}), poll until done, include the
result in your reply as "PATCHED: ... | REPLY: <text>".

Finish the task. Don't narrate.
```

---

## 8. Tools exposed to gpt-4o

When we call the OpenAI API in REGISTERING / COLD / WARM / PATCHING
states, gpt-4o needs to actually drive the page. We give it real OpenAI
**function-calling** tools, not a chat-fiction "describe the click"
pattern. Every tool maps to a real `runJavaScript()` / `QWidget.grab()`
/ filesystem op on the per-target offscreen view.

### Original seven

| Tool | Purpose |
|---|---|
| `get_offscreen_screenshot()` | `QWidget.grab()` → base64 PNG. Use AFTER any action to verify. |
| `send_click({selector\|xy})` | Click an element. Prefer selector, fall back to viewport pixel coords. |
| `send_key(key)` | Press Enter / Tab / Escape / Backspace / Arrow / Space. |
| `send_text(text)` | Type literal text into the focused element. |
| `eval_js(code)` | `runJavaScript()`. Returns JSON-serialized last expression. Used for DOM probing + testing the candidate `__cbeBridge`. |
| `install_bridge_script(source)` | Persist to `state/providers/<key>.script.js` and inject. Exits bootstrap loop. |
| `leave_feedback(message, severity)` | Append a line to `feedback.log`. Severities: `info`, `concern`, `question`, `idea`, `blocked`. |

### New in v2

| Tool | Purpose |
|---|---|
| `list_sources(glob)` | List files in the current session's `bridge_sources/<key>/<session>/` matching a glob. |
| `grep_sources(pattern)` | Ripgrep across captured sources, returns `file:line:text`. |
| `read_source(path)` | Read one captured file. Honour size limit — truncate >256 KB with a note. |
| `register_models(list)` | Persist the discovered model list to `state/providers/<key>.json`. Called once during bootstrap. |
| `set_credentials(username, password)` | Write to `config.ini` `[bridge_credentials.<key>]`. Used during REGISTERING if gpt-4o decides to deviate from the defaults the bridge generated (rare — usually it just uses what it was given). |
| `read_verification_email(addr)` | Poll the IMAP inbox via `hooks/gmail_api_hook.py` for up to 90 s; return the verification URL once it arrives. Used during REGISTERING. |

All tool JSON schemas live in `bridges_py/openai_tools.py` — same shape
as v1, just expanded.

---

## 9. Provider manifest XML schema

This is the single source of truth for "what does a provider look like".
One XML file per provider, dropped in `providers/`. Everything else
(help docs, marketplace cards, asset paths, runtime config) is derived
from this file.

### 9.1 Schema

```xml
<?xml version="1.0" encoding="UTF-8"?>
<provider>
  <name>Human-readable name (shows in UI)</name>
  <key>lowercase-machine-key</key>            <!-- matches filename -->
  <core>true</core>                            <!-- optional, see § 10 -->
  <version>1.0.0</version>
  <release_date>2026-05-23</release_date>

  <author>
    <name>...</name>
    <email>...</email>
    <url>...</url>
    <phone>...</phone>                         <!-- optional -->
  </author>

  <license type="MIT"><![CDATA[
    Full license text inline.
  ]]></license>

  <readme><![CDATA[
    # Provider Name

    Markdown that renders in the help section and marketplace card.
    Mention which models the bridge typically exposes, why a bridge
    instead of an API, and any setup gotchas.
  ]]></readme>

  <urls>
    <login>https://...</login>
    <chat>https://...</chat>                   <!-- main chat URL after login -->
    <create_account>https://...</create_account>
  </urls>

  <icon mime="image/svg+xml" encoding="base64">
    <!-- base64-encoded SVG (preferred) or PNG -->
  </icon>
</provider>
```

### 9.2 Canonical examples in this repo

- `providers/qwen.xml` — third-party-style extension provider (not
  `<core>`, can be uninstalled).
- `providers/chatgpt.xml` — first-party `<core>true</core>` provider,
  preinstalled, cannot be uninstalled.

Read those two files to see a fully-fleshed manifest with real license
text, real readme prose, and a base64'd SVG icon.

### 9.3 Asset materialisation

At extension activate, the bridge service walks `providers/*.xml` and
for each manifest:

1. Decodes `<icon>` into bytes.
2. If `assets/providers/<key>.svg` (or `.png` / `.ico` per the
   declared mime) is missing, writes it.
3. For SVG icons, also rasterises a 64×64 `.png` and a 256×256 `.ico`
   for tray-icon use.

This means manifests are self-contained — `git clone` + activate → all
icons appear on disk. Third-party providers don't need to ship a
separate assets folder.

---

## 10. Two-extension-type taxonomy

The marketplace UI now has two tabs:

| Tab | Folder | Purpose | Examples |
|---|---|---|---|
| **Apps** | `extensions/` | Self-contained mini-apps in the panel. | `calculator/`, `emoji-picker/`, `minesweeper/` |
| **Providers** | `providers/` | Bridge target manifests. | `chatgpt.xml`, `qwen.xml` |

Apps are folders with their own `manifest.json` + JS/HTML. Providers
are single XML files (with the icon embedded as base64).

### Core providers

A provider with `<core>true</core>` is:

- **Preinstalled.** Ships in `providers/` in the repo.
- **Not uninstallable** from the marketplace UI — the "Uninstall" button
  is replaced with a "Core provider" badge.
- **Required for the out-of-box experience.** ChatGPT is currently the
  only one; Claude is a likely future addition.

Third-party providers (no `<core>` element) are user-installable and
user-uninstallable via the marketplace.

---

## 11. State / runtime split (on-disk layout)

Manifests are immutable distributable artifacts. Runtime state is
gpt-4o-generated and per-machine. Keep them in separate trees.

```
providers/<key>.xml                       # distributable, in git, immutable
assets/providers/<key>.{svg,png,ico}      # materialised at activate
                                          # (in git for built-in; generated for 3rd-party)

state/providers/<key>.json                # GPT-4o-discovered models
                                          # written by register_models()
state/providers/<key>.script.js           # GPT-4o-authored __cbeBridge impl
                                          # written by install_bridge_script()

bridge_sources/<key>/<session>/           # captured page network responses
                                          # last 2 sessions per target retained
bridge_profiles/<key>/                    # Qt's persistent profile
                                          # cookies, IndexedDB, Local Storage
bridge_logs/                              # debug traces when BRIDGE_TRACE=1
                                          # 7-day rotation
feedback.log                              # GPT-4o's notes to the human
```

### `.gitignore` and `.vscodeignore`

```
bridge_sources/
bridge_profiles/
bridge_logs/
state/
feedback.log
```

The `state/` folder is ignored deliberately — GPT-4o's discovered models
and authored scripts are per-machine. Two users on the same provider
may get different `__cbeBridge` implementations (selector hashes vary
by A/B bucket), and that's fine.

### Disk hygiene

- `bridge_sources/`: prune to the last 2 sessions per target on bridge
  boot. A single session can be 20–50 MB of JS bundles; we don't need
  more than the two most recent for debugging + PATCHING context.
- `bridge_profiles/<key>/Cache/`, `Code Cache/`, `GPUCache/`: cleared
  when the per-profile cache exceeds **500 MB**. Cookies, IndexedDB,
  and Local Storage are **preserved** — losing those triggers a fresh
  login.
- `bridge_logs/`: 7-day rotation. Stamps in filenames; delete anything
  older.

---

## 12. Help docs auto-generation

`panel/help.html` has a `#providers` section. Its contents are
generated at panel load from `providers/*.xml`, one card per manifest:

```
┌─────────────────────────────────────────────────────────────────┐
│ [icon]  ChatGPT                                                 │
│         OpenAI's flagship chat web UI at chatgpt.com...         │
│         (rendered from <readme>)                                │
│                                                                  │
│         Login:  https://chatgpt.com/auth/login                  │
│         Chat:   https://chatgpt.com                             │
│                                                                  │
│         Discovered models (from state/providers/chatgpt.json):  │
│           - GPT-5                                                │
│           - GPT-4o                                               │
│           - o3 / o3-mini                                         │
└─────────────────────────────────────────────────────────────────┘
```

The card is **static across all 39 language files** — the readme is in
the manifest, not localised. Only the **live model list** at the bottom
is dynamic (read from `state/providers/<key>.json`).

This keeps localisation cheap and the help docs honest. The list of
models the user actually sees in the dropdown matches the list shown
in help, because they read the same file.

---

## 13. How screenshots actually move around

1. **Capture**: bridge service calls `widget.grab()` on the per-target
   `QWebEngineView`, gets a `QPixmap`, saves to PNG bytes in memory,
   base64-encodes.

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

3. **`get_offscreen_screenshot` tool**: when gpt-4o calls it, the
   service captures fresh and returns the result image in the tool
   message:

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

   Tool result messages with image content are supported on `gpt-4o`
   and `gpt-4o-mini` (verified working as of 2026-05).

4. **No retention on disk** by default. Screenshots flow through memory.
   We write to `bridge_logs/screenshots/<ts>.png` only when
   `BRIDGE_TRACE=1` is set, for debugging.

---

## 14. `leave_feedback` — yes, it's a real tool

The model COULD trivially do this with `eval_js("...")` or by us
parsing free text out of the model's reply. We expose it as a real tool
anyway because:

- **Named tools are visible affordances.** A model that doesn't see a
  `leave_feedback` tool will not know that "write a note to your buddy"
  is something it's allowed to do. It will instead try to ask the user
  — which we explicitly forbid in the prompts.
- **Structured logs.** Tool calls give us timestamp + severity +
  surrounding tool sequence we can grep later. A free-text "I have a
  concern about X" buried in a `REPLY:` would never surface.
- **Zero token cost.** The tool list lives in the API payload either
  way.

The implementation is one function:

```python
def leave_feedback(message: str, severity: str = "info") -> dict:
    """Append a line to feedback.log for the human to read later."""
    stamp = datetime.now(timezone.utc).isoformat()
    line = f"[{stamp}] [{severity}] [{TARGET}] {message}\n"
    with open(FEEDBACK_LOG, "a", encoding="utf-8") as f:
        f.write(line)
    return {"ok": True, "logged_to": str(FEEDBACK_LOG)}
```

CLI mirror at `tools/leave_feedback.py` for humans writing notes in the
same format:

```bash
py tools/leave_feedback.py --target claude --severity concern "the share dialog stopped opening"
```

Identical effect — same file, same line format.

---

## 15. Cost analysis (back-of-envelope)

Assume a heavy user: 200 chat turns/day, evenly across 3 bridge targets.

### v1 (deprecated)
- ~3 API calls per turn (screenshot in, decide, sometimes verify)
- gpt-4o at vision pricing: ~$0.04 per call avg
- **600 calls/day × $0.04 = $24/day = $720/month**

### v2 (this design)
- ~2 API calls per session per target (login if needed + bootstrap)
- Sessions: ~3/day per target (morning, afternoon, evening) × 3 targets
- = 9 sessions × 2 calls = 18 calls/day @ $0.04 = $0.72/day
- Plus occasional patching: ~1 break/week/target = ~0.4 calls/day @ $0.04
- Plus one-time REGISTERING per new target: amortises to ~0 over time
- **~$0.75/day = $22/month**

**~33× cheaper.** The math is approximate but the order of magnitude is
the point. Cost is **per session, not per message** — that's the whole
v2 thesis.

---

## 16. Files this changes

```
NEW:
  bridges_py/bridge_service.py          unified PySide6 service, replaces all bridges_cpp exes
  bridges_py/openai_tools.py            OpenAI function-calling tool definitions
  bridges_py/source_capture.py          QWebEngineUrlRequestInterceptor + tee-to-disk
  bridges_py/state_machine.py           the 6-state FSM
  bridges_py/imap_verifier.py           wraps hooks/gmail_api_hook.py for read_verification_email
  providers/                            XML manifests (one per provider)
  providers/chatgpt.xml                 first-party core provider
  providers/qwen.xml                    third-party-style provider
  state/                                runtime state, gitignored
  state/providers/<key>.json            discovered models per provider
  state/providers/<key>.script.js       authored __cbeBridge per provider
  bridge_sources/                       captured page responses, gitignored
  bridge_profiles/                      Qt profiles, gitignored
  bridge_logs/                          debug traces, gitignored
  feedback.log                          gitignored
  tools/leave_feedback.py               CLI version of leave_feedback tool
  docs/BRIDGE_WHITEPAPER.md             this file

MODIFIED:
  start.py                              expose --serve-bridge entrypoint, reuse offscreen pipeline
  extension.js                          surface PATCHING + BLOCKED_NEEDS_HUMAN toasts
                                        wire "I did it" button
  panel/help.html                       #providers section auto-generates from providers/*.xml
  panel/marketplace.html                two tabs: Apps + Providers
  .gitignore                            add: bridge_sources/, bridge_profiles/, bridge_logs/,
                                             state/, feedback.log
  .vscodeignore                         same additions

DEPRECATED (delete after v2 ships and the C++ tray is unused):
  bridges_cpp/                          entire directory — gone
  tools/gpt_vision_pilot.py             superseded by bridges_py/bridge_service.py
```

---

## 17. Open questions for the implementer

Not blockers; flag in `feedback.log` if you hit them:

1. **gpt-4o vs gpt-4o-mini for patching.** Mini is 1/15th the price and
   probably adequate for "the selector changed from `.foo` to `.bar`".
   Default to mini for PATCHING + REGISTERING form-filling, escalate to
   full only if mini's patch fails its own healthCheck.

2. **Script invalidation on Qt / Chromium upgrades.** Qt 6 bumps its
   bundled Chromium with each minor. Some bumps change DOM. Should we
   automatically invalidate all scripts and re-bootstrap on detected
   Chromium-version change? Probably yes — adds at most 6 API
   calls/upgrade-cycle/target.

3. **Multi-conversation state.** Today `poll()` reads the last assistant
   message. If the user has the same provider open in another window,
   that read could pick up content typed elsewhere. v2 should namespace
   conversations by giving each chat its own `data-cbe-msg-id` injected
   at send time. Defer until someone hits it.

4. **Streaming chunks to the panel.** v2 returns the final reply only.
   v3 could stream by having `poll()` return cumulative text and the
   bridge runtime forwarding the diff. Nice-to-have, not v2-blocking.

5. **REGISTERING email provider strategy.** First implementation polls
   the IMAP inbox via `hooks/gmail_api_hook.py`. If the user doesn't
   have a Gmail / Google Workspace account configured, REGISTERING falls
   through to BLOCKED_NEEDS_HUMAN. Reasonable for v2; v3 could add
   plus-addressing tricks or disposable-mail providers.

6. **Source-capture privacy.** The captured JS bundles include
   localStorage-bound user-state in some cases. We gitignore
   `bridge_sources/` but if a user posts a traceback that includes the
   path, they might leak. Worth a one-line `[redacted]` filter for
   anything that looks like a session token.

7. **`<core>` provider list growth.** Today only ChatGPT is core. As
   more provider manifests get added, the "preinstalled and required"
   list will grow. Need a clear policy — probably "the bridge ships
   working out of the box with at least one provider", so whichever
   provider best satisfies that gets the badge.
