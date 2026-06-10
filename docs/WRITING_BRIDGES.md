# Writing CBE Bridges — Developer Whitepaper

**Audience:** anyone who wants to add a new AI chat target to Codex Black (CBE) without modifying the core extension.

**Status:** v1.0 — 2026-05-19. Reflects the post-pivot architecture where the pilot's brain is the user's logged-in chatgpt.com Plus session (NOT api.openai.com).

---

## TL;DR

A CBE bridge is a `.bridge` file — a zip with:

```
chatgpt.bridge/
├── manifest.xml      <-- declarative metadata + capabilities
├── bridge.py         <-- SPEC + SELECTORS + LOGIN_STRATEGY (and optional hooks)
├── icon.ico          <-- Windows tray icon
└── icon.png          <-- Panel toolbar icon
```

Drop the file into `bridges/` next to the extension and CBE picks it up on next launch. No core-extension changes needed. Anyone can ship a third-party bridge.

The smallest possible bridge is ~30 lines of Python — the rest is just data.

---

## 1. Architecture overview

CBE talks to AI services in one of two modes:

| Mode | When to use | Cost |
|---|---|---|
| **web** | The user has a logged-in browser session on the service (ChatGPT Plus, Grok Premium, Claude Pro, etc.) | $0 — rides the user's subscription |
| **api** | The service has a public HTTP API (Ollama, OpenRouter, local LM Studio) | Whatever the API charges; Ollama is free local |

Most useful bridges are `web` — they reuse the user's existing browser cookies via CDP (Chrome DevTools Protocol). This is the architectural pivot from earlier versions of CBE that tried to pay api.openai.com to drive chatgpt.com — see `GPT_VISION_PILOT_WHITEPAPER.md` for why that approach was abandoned.

```
                  ┌─────────────────────┐
                  │ CBE VSCode extension│
                  └───────────┬─────────┘
                              │ HTTP/JSON  127.0.0.1:<bridgePort>
                              ▼
                  ┌─────────────────────┐
                  │  CBE-Bridge-<X>.exe │  ◄── one tray per bridge
                  │   (C++ system tray) │      (rebuilt from bridge_server.cpp;
                  └───────────┬─────────┘      not part of the .bridge plugin)
                              │ spawns
                              ▼
                  ┌─────────────────────┐
                  │ bridges_cpp/        │
                  │  bridge_pilot.py    │  ◄── universal shim (NOT per-bridge)
                  └───────────┬─────────┘
                              │ imports
                              ▼
                  ┌─────────────────────┐
                  │ tools/bridge_runner │  ◄── this is the engine
                  │  Bridge.drive_chat  │     reads YOUR bridge.py
                  └───────────┬─────────┘
                              │ CDP
                              ▼
                  ┌─────────────────────┐
                  │   chrome.exe        │  ◄── user's logged-in tab
                  │  --user-data-dir    │      data/minicomputer/<X>-profile
                  └─────────────────────┘
```

**The bridge plugin only owns the contents of bridge.py + manifest.xml + icons.** The C++ tray, the python shim, the CDP client (`tools/cdp_minicomputer.py`), and the runner are all shared infrastructure.

---

## 2. manifest.xml schema

The manifest is the *first* thing CBE reads. The runner can decide whether to load you at all from the manifest alone.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bridge>
  <!-- Identity -->
  <name>chatgpt</name>             <!-- machine name, lowercase, no spaces -->
  <displayName>ChatGPT</displayName>
  <version>1.0.0</version>
  <author>Your Name</author>
  <description>One-line pitch.</description>
  <homepage>https://yoursite.com/</homepage>
  <license>MIT</license>

  <!-- Runtime contract -->
  <kind>web</kind>                  <!-- web | api -->
  <homeUrl>https://chatgpt.com/</homeUrl>
  <loginUrl>https://chatgpt.com/auth/login</loginUrl>
  <bridgePort>8788</bridgePort>     <!-- 0 = let CBE auto-assign -->
  <cdpPort>9788</cdpPort>           <!-- 0 = bridgePort + 1000 -->
  <fastPath>true</fastPath>         <!-- bypass vision pilot, use selectors -->

  <!-- CLI / extension addressing -->
  <aliases>
    <alias>chatgpt</alias>
    <alias>gpt</alias>              <!-- so users can type `--prompt gpt` -->
    <alias>openai</alias>
  </aliases>

  <!-- Static model list (UI display only — actual model is whatever the
       site uses; this just populates the Settings dropdown) -->
  <models>
    <model>gpt-4o</model>
    <model>gpt-4o-mini</model>
  </models>

  <!-- Declared capabilities. The runner ONLY wires features listed as
       supported=true. Missing/false capability = feature is silently
       no-op for this bridge — CBE won't try to call file-send code
       paths on a bridge that doesn't support files, for example. -->
  <capabilities>
    <chat supported="true"/>
    <streaming supported="true"/>
    <fileSend supported="true"/>
    <fileReceive supported="true"/>
    <toolCalls supported="true" protocol="fenced-exec"/>
    <vision supported="true"/>
    <memory supported="true"/>
  </capabilities>

  <icon>icon.ico</icon>
  <iconPng>icon.png</iconPng>
</bridge>
```

### Capability semantics

| Capability | What it means | Required selectors | Output dir |
|---|---|---|---|
| **chat** | Universal. Your bridge can do a text round-trip. Every bridge declares this. | `composer`, `send_button`, `assistant_msg` | — |
| **streaming** | Reply text streams; runner surfaces incremental updates to the caller (otherwise we wait for the message to stop changing for 2 seconds). | — | — |
| **fileSend** | Client can upload files (images, PDFs, code) to the chat. | `file_input` (hidden `<input type="file">` somewhere in the composer) | — |
| **fileReceive** | Bridge can extract files the assistant emits (images, generated code as files). | Site-specific; usually a custom hook | `images/<bridge>/` |
| **toolCalls** | Supports the `# !exec` fenced-block tool-call convention (see §5). | Just `TOOL_CALL_PRIMER` string | — |
| **vision** | Accepts image inputs (image-attached + asks "what is this?"). Implies fileSend. | `file_input` | — |
| **memory** | Site has persistent conversations across runs (chatgpt.com, claude.ai). For ephemeral sites (raw API endpoints) leave as false. | — | — |
| **imageGen** | Bridge generates images (DALL-E in chatgpt, Imagen in gemini, Midjourney bridges, etc.). The runner downloads emitted PNGs/JPGs. | site-specific | `images/<bridge>/` |
| **videoGen** | Bridge generates video (Sora, Veo, Runway, Pika, Luma, Kling, MiniMax). Async — submit → poll for asset URL → download. | `submit_button`, `result_video` (or custom poll hook) | `videos/<bridge>/` |
| **audioGen** | Bridge generates audio (TTS, music, voice clone — ElevenLabs, Suno, Udio). | site-specific | `audio/<bridge>/` |

### Asset save contract

When a bridge declares `imageGen`, `videoGen`, `audioGen`, or `fileReceive`, the runner automatically downloads every emitted asset and saves it to disk. The path convention:

```
<repo>/
├── videos/<bridge>/<YYYYMMDD-HHMMSS>_<prompt-slug>.<ext>
├── images/<bridge>/<YYYYMMDD-HHMMSS>_<prompt-slug>.<ext>
└── audio/<bridge>/<YYYYMMDD-HHMMSS>_<prompt-slug>.<ext>
```

Examples:

```
videos/sora/20260519-094215_a_cat_riding_a_skateboard.mp4
images/chatgpt/20260519-094800_pixel_art_dragon.png
audio/elevenlabs/20260519-095100_robot_voice_say_pong.mp3
```

These directories are in `.gitignore` — they're per-user output, not source. The runner creates them on demand (`mkdir -p`). Caller receives both the local path AND the original URL so it can either re-render or re-fetch.

For async outputs (every videoGen bridge), the manifest declares:

```xml
<capabilities>
  <chat supported="false"/>           <!-- not a chat -->
  <videoGen supported="true"
            mode="async"
            pollMaxSeconds="600"/>    <!-- give it up to 10 minutes -->
  <fileSend supported="true"/>         <!-- reference image input -->
  <fileReceive supported="true"/>
</capabilities>
```

The runner's async-job loop:
1. Submit the prompt via the bridge's `custom_submitJob(mini, prompt, refs)` hook → returns `jobId`
2. Poll `custom_pollJob(mini, jobId)` every 10s until it returns `{done: true, url: "..."}`
3. Download the URL via plain HTTP, save to `videos/<bridge>/<timestamp>_<slug>.<ext>`
4. Return `{ok, local_path, original_url, duration_s}`

The `protocol` attribute on `<toolCalls>` lets bridges declare which tool-call convention they understand. Today: only `fenced-exec` exists. Future: `openai-native`, `anthropic-tool-use`, etc.

---

## 3. bridge.py — the 90% case

Most bridges are pure data. Here's a complete working bridge in ~30 lines:

```python
"""ChatGPT bridge — drives chatgpt.com via DOM selectors."""

SPEC = {
    "name": "chatgpt",
    "kind": "web",
}

SELECTORS = {
    "composer": [
        "#prompt-textarea",
        'div#prompt-textarea[contenteditable="true"]',
    ],
    "send_button": [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
    ],
    "logged_in_check": "#prompt-textarea",
    "login_email":    'input[name="email"], input[type="email"]',
    "login_password": 'input[name="password"], input[type="password"]',
    "login_submit":   'button[type="submit"]',
    "assistant_msg":  '[data-message-author-role="assistant"]',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "Click 'Log in' top-right, type email, Continue, type password, "
    "Continue. Use native OpenAI login — do NOT route through "
    "Google/Microsoft/Apple."
)
```

That's it. The runner's `Bridge.drive_chat(mini, message)` will:
1. Check `is_logged_in` → if false, navigate to `loginUrl`, fill in email/password, submit
2. Focus the first visible `composer` selector
3. `Input.insertText` the message via CDP
4. Click the first visible `send_button` (Enter as fallback)
5. Poll `assistant_msg` count to grow, then poll the last assistant message's text until it stops changing for 2 seconds
6. Return `{ok, answer, final_url}`

### Selector tips

- **Pass lists, not strings, for any selector that might rotate.** Sites redesign frequently; the runner walks the list and uses the first visible (>2px) element.
- **Prefer stable attributes:** `data-testid`, `aria-label`, semantic IDs. Avoid CSS class names — they're often hashed/minified.
- **`logged_in_check`** is the strongest tripwire. If this selector matches AND is visible, the runner assumes you're logged in and skips the login flow. Pick a selector that's ONLY present on the logged-in surface.

---

## 4. Optional hooks — the other 10%

When your site does something non-standard, override one of these. They're checked in order — the runner uses the LOWEST-LEVEL hook you provide and falls back to the default.

| Hook | Signature | When you need it |
|---|---|---|
| `custom_isLoggedIn(mini)` | `→ bool` | Site has multiple logged-in surfaces / no single tripwire selector |
| `custom_login(mini, email, pw)` | `→ {ok, error?}` | Magic-link, 2FA, SSO redirects, multi-step CAPTCHAs |
| `custom_sendChat(mini, message)` | `→ {ok, answer, error?}` | Composer needs a paste event instead of `Input.insertText`; reply lives in a non-standard element; streaming uses WebSocket frames that need decoding |
| `custom_driveChat(mini, msg, email, pw)` | `→ {ok, answer, error?}` | Top-level override. Your bridge is mostly independent of the runner. |

All hooks receive `mini` — a `MiniComputer` from `tools/cdp_minicomputer.py`. The methods you'll use most:

```python
mini.eval_js(expr)              # Runtime.evaluate with returnByValue
mini.type_text(s)               # Input.insertText
mini.press_key(name)            # Input.dispatchKeyEvent with named key (enter/tab/esc/...)
mini.navigate(url)              # Page.navigate
mini.final_url()                # current location.href
mini.page_html(max=30000)       # documentElement.outerHTML stripped of script/style
mini.screenshot_b64_gridded()   # PNG b64 with coordinate grid overlay
mini.click_xy(x, y)             # Input.dispatchMouseEvent click
```

### Example: Ollama (api-mode bridge)

Ollama doesn't need a browser. Its bridge:

```python
import urllib.request, json

SPEC = {"name": "ollama", "kind": "api"}

def custom_driveChat(mini, message, email="", password=""):
    body = json.dumps({
        "model": "llama3.2:3b",
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat",
        data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return {"ok": True, "answer": json.loads(r.read()).get("message", {}).get("content", "")}
    except Exception as e:
        return {"ok": False, "error": str(e)}
```

`mini` is unused (Ollama is an HTTP API, not a browser). The manifest declares `<kind>api</kind>` so the runner skips chrome-spawn for this bridge.

---

## 5. Tool calls — the fenced-exec convention

CBE's tool-call mechanism is model-agnostic: a bridge teaches the model to wrap shell commands in a `# !exec`-tagged fenced code block, then CBE parses those blocks out of the reply, runs them locally, and pastes the stdout/stderr back as the next user turn.

This works on every model — it doesn't require a native function-calling API. Whether you're driving ChatGPT, Grok, Claude, Gemini, or Llama via Ollama, the convention is identical.

### Implementation

Set `TOOL_CALL_PRIMER` in your `bridge.py` and declare `<toolCalls supported="true" protocol="fenced-exec"/>` in your manifest:

```python
TOOL_CALL_PRIMER = (
    "You have shell tool-call capability. Wrap commands like this:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "The runner executes the command and feeds back stdout/stderr/rc."
)
```

The runner sends this string ONCE at the start of a new conversation (using `Bridge.primer_for_new_conversation()`). For bridges that have persistent memory (chatgpt.com remembers prior turns), it's cached so subsequent messages don't waste tokens.

### Parsing

`extension.js:parseToolCalls(text)` extracts every fenced block tagged with `# !exec` on its first line. Languages: `bash`, `powershell`, `python`. The block's content is executed by `executeToolCall(call, opts)` which returns `{rc, stdout, stderr, durationMs}`.

The loop: model emits text → bridge replies arrive → parser pulls out exec blocks → executor runs them → result is appended back to the conversation as a NEW user turn → bridge gets called again. Cap: 8 iterations per chat (configurable).

---

## 6. Packing + shipping a .bridge

Once your `bridges/_src/yourbridge/` directory has `manifest.xml + bridge.py + icon.ico + icon.png`, pack it:

```python
from tools.bridge_runner import pack_bridge
pack_bridge("bridges/_src/yourbridge")
# writes bridges/yourbridge.bridge
```

CBE's loader scans `bridges/*.bridge` on launch. Drop the file in and it appears in the Settings → Models picker, the CLI (`--prompt yourbridge "hello"`), and the panel button bar.

### Hot-reload in development

If both `bridges/yourbridge.bridge` AND `bridges/_src/yourbridge/` exist, the `_src/` version wins. So you can keep editing source and CBE picks up changes on next chat (no rebuild). When you're ready to publish, run `pack_bridge` to produce the shippable archive.

---

## 7. Common pitfalls

1. **`Input.insertText` vs `dispatchKeyEvent`**: always use `mini.type_text(s)` (which uses `Input.insertText`). Per-character `dispatchKeyEvent` caused the "ppoonngg" double-insert bug on chatgpt — see `cdp_minicomputer.py:type_text`.

2. **Selector lists, not single strings**: sites rotate DOM constantly. A bridge that ships with a single hard-coded selector breaks the first time the site redesigns.

3. **`logged_in_check`** must be UNIQUE to the logged-in surface. If your selector matches both the login page and the logged-in app, the runner will skip login and then fail to send.

4. **Send button takes time to enable** after file upload. If your bridge supports fileSend, sleep at least 1 second after the upload before clicking send — React state needs to register the file upload before un-disabling the button.

5. **Don't expect `Enter` to submit on all sites.** ChatGPT's composer specifically ignores synthetic Enter keystrokes via CDP — only the explicit send button click works. The runner tries Enter as a fallback but you should still wire `send_button`.

6. **CAPTCHA / 2FA is your bridge's problem**, not the runner's. If your site requires interactive verification on every login, ship a `custom_login` that opens visible chrome and waits for the user to complete it manually (`tools/sign_in_helper.py` does this for the built-in bridges).

7. **Per-target chrome profile pollution**: every bridge gets `data/minicomputer/<name>-profile/`. If you change `<name>` between versions, the user loses their login cookies. Keep names stable.

---

## 8. Reference bridges

| Name | Mode | Style | What to learn from it |
|---|---|---|---|
| `chatgpt` | web | data-only | Cleanest minimal bridge. SPEC + SELECTORS + LOGIN_STRATEGY, no hooks. |
| `ollama` | api | `custom_driveChat` | Pure HTTP API path. mini is unused. |
| `claude` | web | partial hook | Magic-link login → `custom_login` falls back to "sign in via helper" |
| `grok` | web | data-only | Native xAI email login, watch out for anon rate limits |
| `gemini` | web | `custom_login` | Google SSO requires navigating to accounts.google.com in the same tab |
| `copilot` | web | data-only | Microsoft account flow via login.live.com |
| `deepseek` | web | data-only | Native email/password — avoid the Google SSO branch (CAPTCHA wall) |

Each lives under `bridges/_src/<name>/` in the CBE source repo and ships as `bridges/<name>.bridge` in the extension.

---

## 9. Why this architecture

**Per-bridge code size before extraction:** ~655 target-specific references scattered across 8 files (start.py, app.py, extension.js, cdp_minicomputer.py, gpt_vision_pilot.py, web_vision_driver.py, bridge_server.cpp, bridge_pilot.py + bridge_chat.py).

**Per-bridge code size after extraction:** ~30-80 lines per bridge.py, ~40 lines per manifest.xml. The vast majority of the original 655 refs were boilerplate (selector dicts, alias sets, port assignments, label maps) that the runner now handles generically from declarative data.

**Goal:** a third-party developer can write a bridge for "AnyNewLLM.com" in under an hour by:
1. Opening DevTools on the site
2. Finding 5-7 stable selectors (composer, send, assistant_msg, login fields, file_input)
3. Writing them into `bridge.py`
4. Running `pack_bridge`
5. Dropping the result into `bridges/`

The runner doesn't care which LLM is on the other end. As long as it has a chat composer, a send button, and a place where assistant replies render, it's a bridge.

---

## Appendix: capabilities cookbook

### Adding fileSend to a new bridge

1. Manifest: `<fileSend supported="true"/>`
2. bridge.py: `SELECTORS["file_input"] = 'input[type="file"]'` (or whatever the site uses)
3. The runner's `attach_file(mini, png_path)` will work automatically — uses `DOM.setFileInputFiles` via CDP.

### Adding vision (image understanding)

Vision is `fileSend + chat` — your bridge attaches an image, then asks a question about it in the SAME composer turn. Runner does this if both capabilities are declared.

### Adding fileReceive (downloading assistant-generated files)

This is the trickiest capability — sites differ wildly. Typical implementation:

```python
def custom_extract_files(mini, assistant_msg_el):
    """Find <a href="blob:..."> or <img src="data:..."> in the assistant
    message and return [(filename, bytes)]."""
    js = """(function(el){
      var out = [];
      el.querySelectorAll('a[download], img[src^="data:"]').forEach(function(n){
        out.push({name: n.download || 'asset', src: n.href || n.src});
      });
      return JSON.stringify(out);
    })(arguments[0])"""
    # ... fetch each src, b64-decode, return
```

Declare `<fileReceive supported="true"/>` in manifest. The runner calls `bridge.module.custom_extract_files(mini, msg_el)` after each chat turn and passes the results to the caller.

### Adding streaming

If your site uses HTML streaming (the assistant's message text grows as the model generates), the default runner already handles this — it polls until the text stops changing for 2 seconds.

If your site uses Server-Sent Events / WebSocket frames that don't reflect in the DOM in real-time, write a `custom_sendChat` that hooks the page's fetch/WebSocket and yields chunks.

---

## License

This whitepaper and the bridge_runner code are MIT-licensed. Your bridge can be any license you want — bridges are loaded at runtime as plugins, not statically linked.
