# Claude Codex — Black Edition
## Webview Injection Architecture for VSCode Extensions
### A Technical Whitepaper

---

## Overview

This document describes a live-reload injection system built on top of Claude Code (the Anthropic VSCode extension). The system allows arbitrary JavaScript and CSS to be injected into Claude Code's Chromium-based webview at runtime — with zero window reloads after initial setup. It also adds a voice input pipeline, a Super Stop button, and a visual "Black Edition" identity layer.

---

## The Problem

Claude Code renders its chat UI inside a VSCode WebviewPanel — a sandboxed Chromium iframe. The webview loads a minified React bundle from `webview/index.js` inside the extension directory. There is no official plugin API for adding buttons, changing styles, or intercepting user input.

The naive approach — editing `index.js` and reloading — works once, but breaks every time Claude Code auto-updates. It also requires a full window reload for every change during development.

The goal: **patch once, then never reload again.**

---

## Architecture

### Layer 1 — The One-Time Patch (`patch-webview.js`)

A Node.js script that edits Claude Code's `webview/index.js` on disk. It injects two things:

**1. The Injector Bootstrap** — a self-contained polling engine baked into the webview at startup:

```
webview starts
  → bootstrap runs
  → polls http://127.0.0.1:57837/injects/manifest every 2s
  → if manifest version changed, fetches each file
  → executes JS via nonce'd <script> tags (CSP-safe)
  → applies CSS via <style> tags
```

**2. The VoiceMicBtn React Component** — inserted next to the existing toolbar buttons using React's own createElement API, found by locating the internal `Kt1` component marker.

The patcher creates a `.original.bak` backup and restores it before re-patching, so it is always idempotent.

### Layer 2 — The Control Server (`extension.js`, port 57837)

A plain Node.js `http.createServer` running inside the VSCode extension process. It serves:

| Route | Purpose |
|---|---|
| `GET /injects/manifest` | Returns `{ version, files[] }` — version bumps on any file change |
| `GET /injects/file/:name` | Returns raw JS or CSS content |
| `POST /hook/:name` | Dynamically `require()`s `hooks/<name>.js` with live context |
| `POST /speech/submit` | (Legacy) — now intercepted client-side by `speech-fix.js` |
| `POST /speech/start` | Starts ffmpeg audio recording |
| `POST /terminal/run` | Runs shell commands, returns stdout/stderr |
| `POST /input` | Types text into the active editor |
| *(+ 10 more)* | Editor read/replace, clipboard, focus, open file, search |

A companion log server runs on port 57836, receiving `console.error` messages forwarded from inside the webview.

### Layer 3 — The Injector (in-page, `patch-webview.js` bootstrap)

Once the bootstrap is running in the page:

- Polls the manifest endpoint every 2 seconds
- Compares `version` integer — only fetches files when something changed
- For `.css` files: upserts a `<style id="__cv_css_*">` tag in `<head>`
- For `.js` files: removes old `<script id="__cv_s_*">` tag, creates a new one with the page's current CSP nonce

The nonce is extracted from the first existing `<script nonce="...">` on the page — this is what makes script injection work despite `script-src 'nonce-...'` in the Content Security Policy.

### Layer 4 — The Injects (`injects/` folder)

Each file in `injects/` is a self-contained module. Edit the file on disk — it's live in the browser within 2 seconds.

**`paste-submit.js`** — defines `window.__cvPaste(text)`:
- Uses `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set` to write text into React's controlled textarea without React blocking it
- Dispatches synthetic `input` and `change` events so React state updates
- Fires a `keydown` Enter event 150ms later to submit

**`speech-fix.js`** — monkey-patches `window.fetch`:
- Intercepts any fetch to `/speech/submit`
- Extracts the text from the request body
- Calls `window.__cvPaste(text)` directly
- Returns a fake `{ok:true}` response so the mic button doesn't throw
- This eliminates the broken `editor.action.clipboardPasteAction` path in the extension

**`red-stop-btn.js`** — Super Stop button:
- Finds `button[type="submit"][data-permission-mode]` (the send button)
- Inserts a red Stop button before it
- On click: calls `POST /hook/red-stop`
- Re-mounts every 1s in case React re-renders the toolbar away
- The hook (`hooks/red-stop.js`) sends ESC, kills Claude terminals, calls `claude-vscode.newConversation`

**`black-edition.js`** — Visual identity:
- Injects CSS: black 1.5px borders on input container, toolbar, send button
- Mounts a "Claude Codex — Black Edition" label badge
- Anchor: finds the compact button, falls back to the command menu (/) button (always present)
- Re-mounts every 1s

---

## Content Security Policy — How We Beat It

Claude Code's webview uses a strict CSP:

```
default-src 'none';
script-src 'nonce-<random>';
connect-src http://127.0.0.1:57837 http://127.0.0.1:57836;
```

Three CSP rules we had to work around:

| Problem | Solution |
|---|---|
| `eval()` blocked | Inject via `<script nonce="...">` tags instead |
| `fetch()` blocked (no connect-src) | Patched Claude Code's `extension.js` to add `connect-src 127.0.0.1:57837 57836` to the CSP meta tag |
| Nonce rotates each load | Extract from existing `document.querySelector('script[nonce]')` at runtime |

---

## Voice Input Pipeline

```
User clicks mic button (VoiceMicBtn)
  → tries window.SpeechRecognition (Web Speech API, Google, uses Gmail session)
  → on result: calls pasteAndSubmit(text)
      → pasteAndSubmit calls window.__cvPaste(text)  [via speech-fix.js intercept]
          → React native setter + Enter keydown → text submitted

  → if SpeechRecognition unavailable or denied:
      → falls back to SAPI (Windows Speech Recognition)
      → POST /speech/start → ffmpeg records WAV → PowerShell SAPI transcribes
      → POST /speech/status poll → on done: pasteAndSubmit(text)
```

---

## Auto-Patch and Cache Clearing

The extension does two things on every VSCode startup:

1. **Clears VSCode cache** (`%APPDATA%\Code\Cache`, `CachedData`, `GPUCache`) — prevents the webview from loading a stale pre-patch version of `index.js` from disk cache

2. **Watches Claude Code's `webview/index.js`** — if Claude Code auto-updates and overwrites the patched file, the extension detects the change, automatically re-runs `patch-webview.js`, and prompts to reload

---

## Hook System

Hooks are Node.js modules in `hooks/` loaded dynamically via:

```javascript
delete require.cache[require.resolve(hookFile)];
const hookFn = require(hookFile);
const result = await hookFn({ vscode, cvLog, delay, submitText, ... });
```

The `delete require.cache` line means every POST to `/hook/:name` gets a fresh module — edit the hook file, the next button press runs the new code. No reload, no restart.

---

## File Map

```
[Claude Codex Black Ed. install folder]\
  extension.js          — VSCode extension: servers, Injector, recording, submitText
  patch-webview.js      — One-time patcher: injects bootstrap + VoiceMicBtn into index.js
  package.json          — Extension manifest, contributes claude-codex-black.startRecording
  WHITEPAPER.md         — This document

  injects\
    paste-submit.js     — window.__cvPaste() — React textarea native setter + Enter
    speech-fix.js       — fetch() interceptor + clipboard watcher for SAPI transcript delivery
    red-stop-btn.js     — Red Stop button DOM injection + /hook/red-stop call
    black-edition.js    — Black borders CSS + label + 🔊 read-aloud button (double-click = auto-read)
    prompt-canvas.js    — 100px canvas mounted to the right of the input box
    zz-joke.js          — Example one-shot popup inject (delete when done)

  hooks\
    red-stop.js         — Super Stop: ESC + kill terminals + newConversation

  lib\
    wavesurfer.min.js   — WaveSurfer.js v7, bundled locally for audio visualization
```

---

## Popup Injects — How to Show Anything in the Page

Because the Injector executes arbitrary JS inside Claude Code's webview, you can pop up any UI instantly — modal dialogs, toast notifications, overlays, context menus — by dropping a file in `injects/`. No reload. No extension API. Just DOM.

### Minimal modal pattern

```javascript
(function(){
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#fff;border:2px solid #000;border-radius:12px;padding:32px;max-width:420px;text-align:center;';
  box.textContent = 'Hello from an inject.';

  overlay.appendChild(box);
  overlay.onclick = function(){ document.body.removeChild(overlay); };
  document.body.appendChild(overlay);
})();
```

Drop this in `injects/my-popup.js` → appears in ~2 seconds. Delete the file → gone on next poll.

### Rules for popup injects

- **Wrap in an IIFE** `(function(){ ... })()` — re-injection runs the whole script again, guard against duplicates with an ID check on the overlay element.
- **z-index 999999** — Claude Code's own modals sit around 1000–9999; go higher to guarantee visibility.
- **Use `position:fixed` with `inset:0`** — the webview viewport is the full panel, not the browser window.
- **Self-remove on click** — `document.body.removeChild(overlay)` keeps things clean. Alternatively, delete the inject file to prevent re-injection on the next poll.
- **One-shot vs persistent** — prefix the filename with `zz-` to sort it last and remind yourself it's temporary. Persistent UI (buttons, labels) uses a re-mount interval instead.

### Toast / notification pattern

```javascript
(function(){
  var id = '__cv_toast_' + Date.now();
  var t = document.createElement('div');
  t.id = id;
  t.textContent = '✅ Done.';
  t.style.cssText = 'position:fixed;bottom:80px;right:24px;background:#000;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:999999;opacity:0;transition:opacity .2s;pointer-events:none;';
  document.body.appendChild(t);
  requestAnimationFrame(function(){ t.style.opacity='1'; });
  setTimeout(function(){ t.style.opacity='0'; setTimeout(function(){ t.remove(); },300); }, 3000);
})();
```

### Clipboard watcher pattern (used by speech-fix.js)

When the VSCode extension writes text to the clipboard (e.g. after SAPI transcription), an inject can detect it and act:

```javascript
var baseline = await navigator.clipboard.readText();
setInterval(async function(){
  var current = await navigator.clipboard.readText();
  if(current !== baseline){ baseline = current; window.__cvPaste(current); }
}, 400);
```

This is how `speech-fix.js` bridges the gap between the Node.js transcription process and the webview input — no server changes, no reload.

---

## Key Design Principles

**No reloads after initial setup.** The bootstrap is patched once. All behavior lives in `injects/` and `hooks/`. Editing a file takes effect in 2 seconds.

**CSP-first.** Every injection technique was chosen to work within the existing Content Security Policy rather than disabling it.

**Vanilla DOM over React.** Buttons and labels are injected as plain DOM elements, not React components (except VoiceMicBtn which needs React state for the recording animation). Plain DOM survives React re-renders via 1s re-mount guards.

**Dynamic require() for hooks.** Every hook call busts the module cache. Hook behavior is live-editable like inject files.

**Fetch interception over server round-trips.** `speech-fix.js` intercepts fetch calls client-side, eliminating broken server-side paths entirely. Combined with clipboard watching, the full SAPI → webview bridge runs with zero extension reloads.

**Popups are free.** Any inject file can render arbitrary UI into the page. Modal, toast, overlay, canvas — if it's DOM, it works. Drop the file, see it in 2 seconds.

---

## Relaunch Without Suicide — Critical Pattern for Claude Automation

**Problem:** When Claude (running inside VS Code) calls `taskkill /F /IM Code.exe`, it kills VS Code,
which kills the Claude Code session, which kills Claude mid-task. The relaunch never happens.

**Rule:** Never run kill+relaunch inline in a Bash/PowerShell tool call. Always write a detached script
and fire it via `cmd /c start "" /B` so the new process is fully detached from VS Code's process tree.

### The correct pattern

**Step 1 — Write the relaunch script to disk:**
```powershell
# Write-RelaunchScript writes relaunch.ps1, then runs it detached
$script = @'
Start-Sleep -Seconds 2
taskkill /F /IM Code.exe 2>$null
Start-Sleep -Seconds 2
node "C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js"
Start-Sleep -Seconds 1
Start-Process "code" -ArgumentList "--extensionDevelopmentPath=C:\Users\moren\Desktop\Claude Codex Black"
'@
$script | Set-Content "C:\Users\moren\AppData\Local\Temp\cbe_relaunch.ps1"
```

**Step 2 — Fire it detached (survives VS Code dying):**
```powershell
cmd /c start "" /B powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\moren\AppData\Local\Temp\cbe_relaunch.ps1"
```

The `cmd /c start "" /B` creates a new process in a NEW process group that has no parent dependency
on VS Code. When VS Code dies, this process keeps running. The 2-second initial sleep ensures
the script starts before VS Code shuts down.

**Step 3 — Auto-wakeup inject handles the new session:**
`injects/auto-wakeup.js` polls for `window.__cbPaste` and the submit button, then auto-sends the
configured wake-up message so Claude Code starts a fresh session without user intervention.

### The detached relaunch combo (use this every time):
```powershell
# 1. Write script
$s = 'Start-Sleep 2; taskkill /F /IM Code.exe 2>$null; Start-Sleep 2; node "C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js"; Start-Sleep 1; Start-Process code -ArgumentList "--extensionDevelopmentPath=C:\Users\moren\Desktop\Claude Codex Black"'
$s | Set-Content "$env:TEMP\cbe_relaunch.ps1"
# 2. Fire detached
cmd /c start "" /B powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "$env:TEMP\cbe_relaunch.ps1"
# 3. Done — VS Code will restart on its own in ~5 seconds
```

---

## Update — 2026-05-10 — Post Zero-Anthropic Pivot

The patch-webview.js layer described in earlier sections has been retired. Files now suffixed `.removed` (`patch-webview.js.removed`, `launch.ps1.removed`, `injects/zz-bundle-watcher.js.removed`, `hooks/red-stop.js.removed`) document a deliberate decision: **CBE no longer modifies any file inside the `anthropic.claude-code-*` extension folder.**

### Consequences
- `/injects/manifest` and `/injects/bundle` endpoints still serve, but currently have no consumer in Claude Code's chat webview — no bootstrap is patched in to fetch them.
- The `Injector` class still loads + watches `injects/`, but now feeds a future poller bootstrap inside CBE's own panel webview rather than Anthropic's chat.
- The orb panel (`codexBlackEd.panel` webview) is the primary UI surface.

### Orb-panel persistence gotcha
[extension.js:1131](extension.js#L1131) registers a `WebviewPanelSerializer`. VSCode auto-restores the panel from session state on every reload via `deserializeWebviewPanel` ([extension.js:828-838](extension.js#L828-L838)). Closing the tab does NOT keep it closed — the serializer rebinds the persisted panel on next start.

To make the panel removable, change `deserializeWebviewPanel` to call `webviewPanel.dispose()` instead of `bindPanel(webviewPanel)`, or remove the serializer registration entirely.

The `editor/title` menu contribution in `package.json` adds the panel-open icon to every editor tab title bar — easy to mis-click.

---

## OpenAI Whisper STT Pipeline

CBE transcribes recorded audio via the OpenAI Audio Transcriptions API. Configuration lives in `config.ini`:

```ini
[openai]
key=sk-...
model=whisper-1
```

### Pipeline

```
mic button → ffmpeg dshow capture → WAV file
  → POST https://api.openai.com/v1/audio/transcriptions
       Authorization: Bearer <key>
       Content-Type: multipart/form-data
       fields: file=<binary>, model=whisper-1, response_format=json, language=en
  → JSON response: { "text": "..." }
  → submitText(text) → clipboard.writeText + clipboardPasteAction → chat input
```

### Endpoint reference
- **URL:** `POST https://api.openai.com/v1/audio/transcriptions`
- **Models:** `whisper-1` (most compatible, JSON response_format), `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` (newer, JSON-only, tighter access tiers — kept `whisper-1` as the safe default)
- **File size cap:** 25 MB — enforced client-side before POST
- **Formats accepted:** mp3, mp4, mpeg, mpga, m4a, wav, webm
- **Errors:** non-200 returns `{ error: { message, type, code } }` — surface `error.message` via `vscode.window.showErrorMessage`

### Three bugs found and fixed 2026-05-10

1. **CRLF in API key.** `config.ini` regex was `(.+)` which captures the trailing `\r` on Windows-saved files, producing a malformed `Authorization: Bearer sk-...\r` header that OpenAI rejects with 401. **Fix:** regex must be `([^\r\n]+)`.

2. **Multipart streaming truncation.** Original code wrote the multipart body in chunks via `req.write(chunk)` from a file stream, violating HTTPS backpressure and silently truncating long WAVs. **Fix:** build the entire body as `Buffer.concat([prelude, fileBuf, postlude])` and send via one `req.end(body)`.

3. **Transcript never reached the chat.** `stopAndTranscribe` stashed the text in `pendingText` for `/speech/status` polling and showed it in the panel — but never called `submitText(text)`. This was the user-visible "STT broken" symptom. **Fix:** `await submitText(text)` after a successful transcript.

### Failure modes still present
- ffmpeg dshow device name is hardcoded (`Microphone (webcam AC310)`); fallback GUID is also hardcoded. New mic = recording fails before STT runs.
- `submitText` pastes via clipboard + `editor.action.clipboardPasteAction`. Whatever editor is active receives the paste — if Claude Code's chat input isn't focused, the transcript lands in the wrong window.
- A 401 from a revoked key does **not** auto-fall-back to Gemini. User must flip `provider=` in `config.ini` manually.

---

## Gotchas Reference

### Two-source sync (critical)
CBE exists in two places:
- [Desktop source](C:/Users/moren/Desktop/Claude%20Codex%20Black/) — canonical
- [Installed VSIX](C:/Users/moren/.vscode/extensions/trentontompkins.codex-black-ed-1.0.0/) — what VSCode actually loads

Every `extension.js` / `package.json` / inject change must be applied to **both** or the fix disappears on the next VSIX rebuild. Same for this whitepaper.

### Config.ini CRLF pitfall
Windows saves `config.ini` with CRLF. Greedy `(.+)` regex captures bring `\r` into the value. **Always use `([^\r\n]+)`** for any line-scoped capture group.

### `__cv*` vs `__cb*` naming
Identifiers were renamed `__cv*` → `__cb*` in a 2026-05 collision-fix pass (when CBE forked from claude-voice). Two files were missed:
- `kill-old-poll.js` still references `__cvBlackEditionInterval`
- `prism-highlight.js` still references `__cvPrismLoaded` / `__cvPrismObserver`

### `workbench.action.webview.reloadWebviewAction` is a no-op
For sidebar webviews with `retainContextWhenHidden: true`. The command resolves successfully but the webview's JS context is preserved. Use `location.reload()` from inside the webview or a full window reload instead. (Note: post-zero-anthropic, this only matters if a future bootstrap is mounted inside CBE's own panel webview.)

### `vscode.commands.executeCommand('type', { text: '\n' })` does not reach the chat webview
The `type` command routes to the active text editor, not Chromium webviews. To send a real Enter to whatever has focus (including a webview textarea), shell out:
```js
require('child_process').execSync('python C:/Users/moren/claude-tools/mouse.py key enter');
```
This was the fix for the auto-wakeup "pasted but never submitted" bug.

### reloadWindow timing
`workbench.action.reloadWindow` tears down the extension hosting the ctrl server. Port 57837 goes dark for 10–30 seconds during teardown + re-activation. **Send the reload curl once.** Do not retry just because the port hasn't returned — each new reload kills the freshly-activating extension and resets the boot timer.

---

## Logging Discipline — why DevTools keeps lighting up red

DevTools "Errors" pane filling with `[codex-black]` and `[monitor-btn]` lines was **not** an actual exception. It is a self-inflicted reporting bug: every routine log line was emitted via `console.error()`, so Chromium classified routine traces as errors. Two facts conspired:

1. **Chromium splits console output by *severity*, not by *content*.** A `console.error("hello")` shows up red with a stack trace; a `console.log("hello")` shows up grey. The string is irrelevant. DevTools' "Errors" counter only ever counted `console.error` calls.
2. **CBE used `console.error` as the universal trace channel.** Both `extension.js` (`cvLog`) and `injects/monitor-btn.js` (`trace`) routed *everything* through `console.error` so it would be cheap to find. That made every status poll, every HTTP request log, every `getStatus` tick look like an exception in DevTools.

### Rules going forward

**1. Severity must reflect intent.**

| Channel | Use for |
|---|---|
| `console.debug` | Routine traces, polling, status responses, "I attempted X" |
| `console.log`   | One-shot informational events: "server up on 57836", "patch applied" |
| `console.warn`  | Recoverable anomalies: stale state, retry attempts, missing optional config |
| `console.error` | Genuine failures: thrown exceptions, fetch rejections, fatal init errors |

**2. Logger functions must take an `isErr` flag** so callers can opt-in to the error channel. The corrected pattern (now in `extension.js:cvLog` and `monitor-btn.js:trace`):

```js
function cvLog(msg, isErr) {
    fs.appendFileSync(LOG_FILE, line);
    (isErr ? console.error : console.log)('[codex-black]', msg);
}
```

Callers pass `true` only for actual failures. Everything else is silent in the Errors pane.

**3. Persistent traces go to disk, not console.** DevTools is for the moment you're debugging. The append-only files are the audit trail.

| File (`%USERPROFILE%\…`) | Contents |
|---|---|
| `debug.log` | Every `cvLog` line. Append-only across runs. |
| `chat-YYYY-MM-DD.log` | One file per day. Captures USER messages + CLAUDE responses via `injects/chat-logger.js`. |

The webview side calls `window.__cbChatLog(role, text)` (exposed by `chat-logger.js`); the inject POSTs to `http://127.0.0.1:57836/chat` with body `ROLE\tMESSAGE`. The log server (in `extension.js:startLogServer`) routes `/chat` POSTs to `cvChat()` and everything else to `cvLog()`.

**4. Never `console.error` something you're going to handle.** If a `fetch` is wrapped in `.catch(function(){})`, the rejection is not an error — it's an expected failure mode. Logging it as `console.error` is noise. Log it as `console.debug` if you log it at all.

**5. When you see DevTools red, fix the call site, not the symptom.** Don't filter DevTools to hide errors; that hides the legitimate ones too. Find the `console.error` call and re-classify it. Grep for `console.error` periodically; any new one needs a justification.

### Anti-patterns to grep for before each release

```bash
# inside injects/
grep -nP 'console\.error.*(?:status|response|tick|poll|getStatus|attempting|trying|found|attached)' injects/
# inside extension.js
grep -nP 'console\.error\([^)]*(?:up on|patched|loaded|spawning|started)' extension.js
```

A match in either grep means a routine event is being logged as an error. Re-route to `console.debug` / `console.log`.

### "Session not found: 2jdxejmolc2"

This one is **not** ours. It comes from `anthropic.claude-code-2.1.138/webview/index.js` — Claude Code's own React layer warning about a missing session ID during webview rehydration. CBE has no hook into that path; the warning is harmless and cannot be suppressed without re-patching the upstream bundle (which the patcher already does for other purposes — we deliberately leave this alone because the warning is informative if a future bug correlates with it).

---

## Naming Collisions With the Host Extension

CBE rides on top of Anthropic's `claude-code` extension. Both register commands, both create webview panels, both put tabs in the editor. Any time the two pick **the same human or machine-readable name**, the user can't tell them apart and tools can't route between them correctly. Three live collisions bit us in 2026-05; this section documents them and the rule that prevents them.

### Collision 1 — duplicate panel titles

**Symptom:** User clicks the CBE icon or runs `Codex Black Ed.: Open Chat` and a tab labelled "Claude Codex Black Ed." opens. They click "Open Claude Code" and a tab labelled "Claude Codex Black Ed." also opens. They cannot tell which panel they are looking at.

**Cause:** `patch-webview.js` rewrote Anthropic's panel title in their `extension.js`:

```js
// WRONG — every Anthropic-created panel now displays CBE's title
const OLD_TITLE = '"claudeVSCodePanel","Claude Code"';
const NEW_TITLE = '"claudeVSCodePanel","Claude Codex Black Ed."';
extSrc = extSrc.replace(OLD_TITLE, NEW_TITLE);
```

CBE's own panel also used the title `"Claude Codex Black Ed.x Black Ed."` (typo'd duplicate) — visually indistinguishable from the patched Anthropic title.

**Fix:** Anthropic's panel stays `"Claude Code"`. CBE's own panel is `"Codex Black Ed."`. The patcher now *un-renames* any stale rewrite from older builds:

```js
// patch-webview.js — current
const STALE_TITLE = '"claudeVSCodePanel","Claude Codex Black Ed."';
const ORIG_TITLE  = '"claudeVSCodePanel","Claude Code"';
if (extSrc.includes(STALE_TITLE)) extSrc = extSrc.replace(STALE_TITLE, ORIG_TITLE);
```

```js
// extension.js — current
vscode.window.createWebviewPanel(
    'codexBlackEd.panel',
    'Codex Black Ed.',           // distinct from "Claude Code"
    ...
);
```

### Collision 2 — second panel rendering "CLAUDE CODEX BLACK ED.X — BLACK EDITION"

**Symptom:** Pressing `Ctrl+Shift+B` opens a second panel with a dark header reading "CLAUDE CODEX BLACK ED.X — BLACK EDITION" and an empty chat area saying "Voice or type to send to Claude Codex Black Ed.." That panel sits next to Anthropic's real Claude Code tab; the user can't tell which one is the chat they actually use.

**Cause:** An earlier iteration tried to fix collision 1 by giving CBE its own webview panel (`codexBlackEd.panel`, registered via `vscode.window.createWebviewPanel`, fed by an `openCBEPanel()` + `panelHtml()` + `CodexBlackPanelSerializer`). That panel was a parallel chat surface — but CBE's actual UI is the orange "label-alpha" pill + injects that already render *inside* Anthropic's webview. Two surfaces meant two competing UIs with the same brand and no clear ownership.

```js
// WRONG — registers a parallel CBE-owned surface
vscode.commands.registerCommand('codexBlackEd.startRecording', () => openCBEPanel());
function openCBEPanel() {
    vscode.window.createWebviewPanel('codexBlackEd.panel', 'Codex Black Ed.', ...);
}
function panelHtml() { return `<!DOCTYPE html>...<span id="header-title">Claude Codex Black Ed.x — Black Edition</span>...`; }
```

**Fix:** Delete the panel entirely (`bindPanel`, `openCBEPanel`, `CodexBlackPanelSerializer`, `panelHtml`, the `if (panel) panel.dispose()` in `deactivate`). Route every CBE command back to Anthropic's chat — that's where the label-alpha pill + dark theme + mic button live:

```js
// extension.js — current
vscode.commands.registerCommand('codexBlackEd.startRecording', () => {
    vscode.commands.executeCommand('claude-vscode.editor.open').catch(() =>
        vscode.commands.executeCommand('claude-vscode.sidebar.open').catch(() =>
            vscode.commands.executeCommand('claude-vscode.focus').catch(() => {})
        )
    );
});
```

**Architectural takeaway:** if your extension's value is a *look-and-feel layer* on top of another extension, you usually do **not** want your own webview panel. The panel is two-source-of-truth incarnate. Pick one surface (theirs), inject your layer onto it, and route your commands to that surface.

### Collision 3 — reinstall wipes the patch

**Symptom:** "Reinstalling Claude Code breaks my extension." After Anthropic publishes an update, `webview/index.js` is rewritten to vanilla and the inject bootstrap is gone — but CBE's `fs.watch(...)` only fires if CBE is *running* during the rewrite. If the rewrite happens while VSCode is closed, CBE never re-patches on next start.

**Cause:** Single-trigger watcher with no startup-time idempotent check.

**Fix:** Add `ensurePatchedAtStartup()` to `activate()`. It checks whether the `__cbPoller` sentinel is present in Anthropic's bundle and re-runs `patch-webview.js` if not. Idempotent — silent no-op when already patched:

```js
function ensurePatchedAtStartup() {
    const bundle = path.join(extBase, claudeDir, 'webview', 'index.js');
    if (fs.readFileSync(bundle, 'utf8').includes('__cbPoller')) return;
    execFile('node', [path.join(__dirname, 'patch-webview.js')], (err, stdout) => {
        if (err) return cvLog('ensurePatched FAIL: ' + err.message);
        cvLog('ensurePatched OK');
    });
}
```

### The rule

**Every CBE identifier — command ID, viewType, panel title, status-bar tooltip, log tag, global variable — must contain `codexBlackEd` or `cb`/`CBE` and must not contain the substrings `claude`, `Claude`, or `claudeVSCode` *as a name*.** Using the word "Claude" in a *human-readable description* is fine ("Codex Black Ed. for Claude Code"); using it in an *identifier* is not.

| Layer | Anthropic's namespace | CBE's namespace |
|---|---|---|
| Extension ID | `anthropic.claude-code` | `TrentonTompkins.codex-black-ed` |
| Command prefix | `claude-vscode.*`, `claude-code.*` | `codexBlackEd.*` |
| Configuration key | `claudeCode.*` | `codexBlackEd.*` |
| Webview viewType | `claudeVSCodePanel`, `claudeVSCodeSidebar` | `codexBlackEd.panel` |
| Activity-bar container | `claude-sidebar` | (CBE has none — uses status bar) |
| Panel title (display) | `"Claude Code"` | `"Codex Black Ed."` |
| Webview globals | `window.__claude*` (Anthropic's, do not touch) | `window.__cb*` |
| Localhost ports | (none) | 57836 (log), 57837 (ctrl) |
| Sentinel marker | (none) | `__cbPoller` in patched files |

### Rules of engagement when patching a third-party extension

1. **Never replace a host string with a string that already means something on your side.** If you have a panel called "Codex Black Ed.", do not rename the host's panel to anything containing "Codex Black Ed.".
2. **Every patch must be reversible.** Keep `<file>.original.bak` and check it in the patcher. Provide an `unpatch` path (the `STALE_TITLE → ORIG_TITLE` revert above is the pattern).
3. **Every patch must be idempotent.** Run the patcher twice — output must be byte-identical. Check for a sentinel (`__cbPoller`) before applying.
4. **Every patch must re-apply automatically.** Host updates wipe the patch. Both `fs.watch()` and an activation-time `ensurePatchedAtStartup()` check are needed — the watcher catches updates while CBE is running, the startup check catches updates that happened while CBE was off.
5. **Never call the host's commands from your own commands.** `codexBlackEd.X` must invoke CBE code; if you also want to expose Anthropic's command, register it under a clearly-separate name like `codexBlackEd.openAnthropicChat`. Mixing them in one handler means your command's behavior breaks when the host's command changes.
6. **Pick names that grep cleanly.** `codexBlackEd` returns only CBE code. `claude` returns Anthropic + CBE + user text. Use the long name in identifiers; use `CBE`/`cb`/`cv` only as short prefixes inside CBE-owned scopes.
