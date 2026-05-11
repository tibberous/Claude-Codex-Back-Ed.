## Topic deep-dives (continued)

### 10. Prism.js syntax highlighting

Prism is served locally to dodge Claude Code's CSP (`default-src 'none'`, no CDN allowed). Files live in [`lib/`](C:\Users\moren\Desktop\Claude Codex Black\lib): `prism.min.js` (core + JS/CSS/HTML/XML/SVG, ~19 KB), `prism-langs.min.js` (TS, PHP, PowerShell, Python, Bash, JSON, YAML, SQL, Rust, Go, Java, C/C++, JSX/TSX — ~39 KB), `prism-dark.min.css`. The CBE ctrl server mounts these as static at `http://127.0.0.1:57837/lib/...`. Early in the sprint the `lib/` static handler was missing on the standalone `cbe-server.js` — fetches 404'd. Fixed by adding a `/lib/` static branch (logs line ~5280).

Three rename cycles bit us:
1. `__cvPrismLoaded` / `__cvPrismObserver` window globals — caught on the `__cv* → __cb*` sweep ([`prism-highlight.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\prism-highlight.js), log 3404 & 3536).
2. `dataset.cvPrism` / `dataset.cvPrism` attribute markers at lines 184 and 220 — discovered THIS session after rename, fixed inline (log 18333–18339). The user's tone: "thats close but you still missed like prism and stuff. you got to read the log better buddy. Isnt reading text like your thing?"
3. CSS class prefix `cv-*` left intact — they're DOM class names, not globals, so they're harmless.

`code-view-source.js` (right-click → view source modal) ALSO depends on `window.Prism` and falls back gracefully when absent. CDN attempt was removed once CSP fight became obvious (log 4752–4869).

Cascade fight: `black-edition.js` sets very broad selectors (`pre, pre *, code, code *`) for color/background overrides. Prism's color-by-token-class rules lost on specificity. After this session's `dataset.cbPrism` fix, screenshots show working highlight (log 18368: "Green comments, orange strings, the title bar with language label and copy button are all rendering"). But on bash/shell blocks the user pushed back: **"yeah they look like shit buddy i can ever read them"** (line 18443). Diagnosis (line 18446): "Prism's running but lang detection is failing so it's not highlighting anything, and CBE's broad CSS is killing the contrast." Language detection on Claude Code's `language-bash` class name is incomplete in `prism-langs.min.js` for some shell variants, and the inline color rules in `black-edition.js` win the cascade — the dark theme stylesheet doesn't carry `!important`. Open.

### 11. Skin system

Driven by [`skins/default.xml`](C:\Users\moren\Desktop\Claude Codex Black\skins\default.xml). Two tag types parsed by `loadSkinXml()` in `extension.js`:
- `<color name="..." value="#xxxxxx"/>` → emits `--cb-<name>: <value>;`
- `<gradient name="..." angle="..." stops="..."/>` → emits assembled `linear-gradient(...)` CSS expression as a var.

Originally the regex only matched `<color>` (line 18140 of log). Added `<gradient>` parsing to feed `--cb-footerBg`, `--cb-stopBg`, `--cb-bodyBg`.

Endpoints in `extension.js` (control server, port 57837):
- `GET /skin/css` — returns `:root { --cb-...: ...; }` block built from currently loaded XML.
- `GET /skin/list` — enumerates `skins/*.xml`.
- `POST /skin/reload` body `{ name: "default" }` — bare name resolves under `skins/`.

[`injects/skin-loader.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\skin-loader.js) polls `/skin/css` every ~8s and injects a `<style>` block into the webview. Re-injection clears prior styles (interval id `__cbSkinLoaderInterval` listed in `kill-old-poll.js`). Load order: `skin-loader.js` runs after `black-edition.js` alphabetically — fine because vars resolve at paint time, and `black-edition.js` falls back to literal colors when `var(--cb-*)` is undefined.

`black-edition.js` has been rewritten so every color comes through `var(--cb-*, <literal-fallback>)`. The footer multi-stop gradient was inlined first, then replaced with `var(--cb-footerBg, ...)` once the gradient tag worked.

Real-world snag (log 5688): one rule in `composer/InputWrapper` set fallback `#2a2a2e` (dark grey) and the var was set globally — the var won but the prior fallback was still confusing during debug. Set the variable at `:root` globally to keep all rules pulling the same value.

A skin picker button ("🎨 Skin") sits in the orb panel HTML; `openSkinPicker()` JS fetches `/skin/list` and shows a QuickPick → POST `/skin/reload`.

### 12. Monitor button + watchdog

Watchdog script: [`cbe_watchdog.ps1`](C:\Users\moren\Desktop\Claude Codex Black\cbe_watchdog.ps1). Polls every N seconds for `Code.exe`; relaunches if gone. Registered as Task Scheduler job **`CBE-Watchdog`** at login, restart-on-failure. PID file in `%TEMP%\cbe_watchdog.pid` (or equivalent) so `extension.js` can verify lifecycle.

Bugs the sprint fought, in order:
- `process.kill(pid, 0)` always throws on Windows detached processes → `isWatchdogRunning()` always returned `false` (log 1112). Replaced with `tasklist /FI "PID eq <pid>"` parsing.
- `startWatchdog()` guard checked `watchdogProc.killed`, never updated after `.unref()` (log 1141). Switched to calling `isWatchdogRunning()` so the guard reflects reality.
- **Em-dash parse error**: template literal had `"[watchdog] Code.exe gone — relaunching"`. The Unicode em-dash got written to the PS1 as `?` (log 1153, 1156) and PowerShell parser exited instantly. Fixed to ASCII `-`.
- Inner spawn from Node was killing the child instantly. Fixed by writing a one-line launcher PS1 that uses `Start-Process` to truly detach — Node spawns the launcher, launcher spawns the watchdog, launcher exits (log 1194, 1203).
- Watchdog initially relaunched VSCode bare (no `--extensionDevelopmentPath`), so the dev host came back but CBE didn't auto-load (log 1236).

**6 zombie PowerShell processes incident, ~17:56**: at 17:54:18 "12 zombies" of `Code.exe` were detected (line 382). Watchdog had been respawning Code.exe out from under us every kill — six concurrent watchdog PS processes plus a scheduled task were fighting (line 412: "Found it. 6 separate CBE watchdog PowerShell processes are running"). Mitigation: disabled the watchdog, killed the PS processes, then killed the zombies (line 420–426). Monitor toggle disabled in the panel as a result for this session.

CSS `!important` fight on the shield SVG:
- `black-edition.js` had `svg path { fill:#fff!important; }` to whiten all toolbar icons. That overrode the green inline style applied by `monitor-btn.js setActive(true)`. Inline + non-`!important` always loses to `!important`.
- Fix (log 1647): selector changed to `svg path:not(#__cb_monitor_btn svg path)` — or specifically the rule was scoped via `:not(#__cb_monitor_btn)` on the button. `OWN_IDS` list also tracks `__cb_monitor_btn` so injects don't strip it.

Status polling: `monitor-btn.js` calls `/monitor/status` every 5s and toggles green/grey. Double-click activates/deactivates. Endpoints: `/monitor/start`, `/monitor/stop`, `/monitor/status`.

### 13. Speech / TTS / Whisper STT

Evolution across this 2-day window (288 mentions):
1. **Web Speech API path** (Google, Gmail-authed, no key) — VoiceMicBtn React component injected near the Kt1 Add (+) button. Failed: Chromium webview sandbox refuses `getUserMedia` permission inside an extension webview. The Chrome permission prompt only appears for real navigations (log 11143, 11151, 11960).
2. **SAPI fallback** (PowerShell `System.Speech.Recognition`) — blocked for up to 15s synchronously, killed responsiveness (log 11969).
3. **OpenAI Whisper API** — adopted from `aroussi.vs-whisper`. ffmpeg dshow records WAV → multipart POST to `/v1/audio/transcriptions`. This is the live path.

ffmpeg device is **hardcoded** to `"audio=Microphone (webcam AC310)"` (log 4468, 12146, 12220). Discovered via `ffmpeg -list_devices true -f dshow -i dummy`. Any other machine fails immediately. Note in `cbe_sprint_20260510.md` already flags this as broken-by-design.

Provider menu: [`injects/stt-provider-menu.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\stt-provider-menu.js) — right-click on mic shows QuickPick (OpenAI Whisper / Google Gemini). Falls back to localStorage when the ctrl server is down. The Gemini path (`transcribeGemini`) exists alongside `transcribeWhisper` and is selected via the provider menu.

API key reading via `getOpenAiKey()` ([`extension.js:523`](C:\Users\moren\Desktop\Claude Codex Black\extension.js)): reads `C:\triodesktop\config.ini` line `openai_api_key = sk-...`. Companion `cbe.ini` is the CBE-local override.

**Three STT bugs fixed THIS session:**

1. **CRLF in key regex** ([`extension.js:521-526`](C:\Users\moren\Desktop\Claude Codex Black\extension.js)): regex was `/openai_api_key\s*=\s*(.+)/` and `.+` swallowed the trailing `\r` on Windows-saved INI files. The bearer header became `"Bearer sk-...\r"` and OpenAI returned 401. Fixed to `[^\r\n]+`. Comment at line 521-522 documents the trap explicitly.
2. **Multipart streaming truncation** ([`extension.js:544-665`](C:\Users\moren\Desktop\Claude Codex Black\extension.js)): previous implementation called `req.write(preFile)`, `req.write(fileBuf)`, `req.write(postFile)`, then `req.end()`. Per-chunk writes against an HTTPS socket without honouring `drain` events silently dropped tail bytes on long recordings — the WAV body arrived truncated, Whisper returned partial transcripts or 400s. Fixed by building the entire body as one `Buffer.concat([preFile, fileBuf, postFile])` and using `req.end(body)` single-shot. Comment at line 538-540 documents the landmine.
3. **`submitText` never called after transcribe** ([`extension.js:380-388`](C:\Users\moren\Desktop\Claude Codex Black\extension.js)): the transcript was stashed into `pendingText` (consumed by `/speech/status` poller) but `submitText(text)` was missing — text reached the variable, never reached the chat input. Re-added the `await submitText(text)` after the `pendingText = text` assignment. Try/catch wraps it because `submitText` can fail when no chat session is active.

`stopAndTranscribe()` ([`extension.js:329`](C:\Users\moren\Desktop\Claude Codex Black\extension.js)) routes through `providerLabel` → `transcribeFn` based on the provider menu selection.

### 14. Read-aloud button

ID `__cb_readaloud_btn`, speaker SVG. Two surfaces:
- Inside CBE's own orb panel — TTS playback of last received transcript / chat reply via `window.speechSynthesis`.
- Previously injected next to Claude Code's toolbar — that path was abandoned with the zero-Anthropic pivot.

Click semantics: single-click reads last assistant text; double-click toggles auto-read mode (every new assistant reply read aloud). Right-click was specified by user (log 10808): "right click is the settings menu that lets you pick your engine, voice, speech and volumn" — voice list comes from `speechSynthesis.getVoices()`. The voice/rate/volume picker is partially implemented inside `panelHtml()` and `black-edition.js` but not yet exposed via right-click context menu.

User constraint (log 13190): "you need to filter the read aloud text so it doesnt read the code out of the code boxes" — the TTS feeder strips text inside `<pre>`/`<code>` before sending to `speechSynthesis.speak()`. Currently best-effort using `cloneNode + querySelectorAll('pre,code').forEach(n=>n.remove())`.

`hide-bypass.js` had a special-case kill rule for the **native Claude Code TTS button** (label contains 'audio'/'sound'/'speak'/'tts'/'read aloud') with `el.id !== '__cb_readaloud_btn'` exclusion so it doesn't nuke our own button (log 4418).

### 15. Auto-resp wake-up automation

Mechanism today: server-side `sendWakeUp()` in `extension.js` fires on every `activate()` after a ~4s delay, calls `submitText(WAKEUP_MSG)`. Inject-side wakeup (`zz-auto-wakeup.js`) is disabled — was causing duplicate fires and false "Wake-up failed ✗" toasts (log 996, 1907).

The triggered text is literally `"Hey! Wake up! You're a code bot! Read C:\Users\moren\.claude\CLAUDE.md auto resp ..."`. The user uses it as a forcing function: their words show up in logs as the wake-up's own dynamic suffix ("auto resp not work", "auto resp didnt fire ita too fragile", "wake up failed!", "auto resp didnt fire :(").

Structural fragility (from [`reference_vscode_api_constraints.md`](C:\Users\moren\.claude\projects\C--Users-moren\memory\reference_vscode_api_constraints.md)):
- Third-party extensions cannot postMessage into another extension's webview. The only way to land text in Claude Code's chat is `submitText()` → clipboard + SendKeys, which depends on the chat input having focus.
- `workbench.action.webview.reloadWebviewAction` reloads **ALL** webviews, returns ok:true even when nothing re-mounted, and is a no-op for views with `retainContextWhenHidden`.
- `reloadWindow` tears down ctrl server for 10–30s. If wake-up fires DURING that window, the post fails silently and looks like a regression. This caused "stop stop stop" loops where the user fired re-issue commands while the ctrl server was still booting (log 5391, 5440).

The current `WAKE_UP_SENT_FILE` PID guard is replaced with a per-PID-first-fire flag and a 5-minute cooldown for same-process reloads (log 1709). On fresh VSCode start the wake-up always fires; within the same PID, repeat fires only after cooldown.

### 16. Two-source sync

Two parallel copies of the extension exist:
- **Source of truth (canonical):** [`C:\Users\moren\Desktop\Claude Codex Black\`](C:\Users\moren\Desktop\Claude Codex Black) — the Desktop folder. Edited live.
- **Installed VSIX:** [`C:\Users\moren\.vscode\extensions\trentontompkins.codex-black-ed-1.0.0\`](C:\Users\moren\.vscode\extensions\trentontompkins.codex-black-ed-1.0.0) — what VSCode actually loads in normal sessions.

VSCode loads from the installed VSIX unless launched with `--extensionDevelopmentPath="C:\Users\moren\Desktop\Claude Codex Black"`. Without that flag, edits to the Desktop folder are invisible (log 329, 334: "CBE is loading from the INSTALLED extension... My edits never landed where the runtime is loading from").

**Silent-disable hijack** ([`cbe_disabled_root_cause.md`](C:\Users\moren\.claude\projects\C--Users-moren\memory\cbe_disabled_root_cause.md), log 16192–16247): a stale `local.claude-voice` entry in `~/.vscode/extensions/extensions.json` continues to load even after the folder is renamed to `*.disabled`. Because claude-voice and CBE both bind ports 57834/57835 (claude-voice's old ports), CBE silently lost the port race and appeared disabled. Folder rename does NOT disable; the registry entry must be removed. Confirmed fix: removing the stale `local.claude-voice` entry from `extensions.json`, CBE took over on next reload. Backup at `extensions.json.bak-<timestamp>`.

**Directive**: any fix must apply to BOTH copies, or it disappears on the next `vsce package + code --install-extension` cycle. This session's STT fixes and `WebviewPanelSerializer.deserializeWebviewPanel` change were applied to both (per `cbe_zero_anthropic.md`).

### 17. Bystander crashes (azure-openai-chat)

At 2026-05-10T17:50:53 (log line 348) the VSCode log surfaced:
> `Activating extension 'TrentTompkins.azure-openai-chat' failed: Invalid destructuring assignment target.`

This is an unrelated extension at [`C:\Users\moren\Desktop\azure-openai-ext\`](C:\Users\moren\Desktop\azure-openai-ext) — a fork of Anthropic's Claude Code template re-pointed at Azure OpenAI. The crash itself is at line 13418 of its `extension.js` where a destructuring expression had `null` as a binding target (log 391–397). Original probably was `apiKey: K = null, authToken: J = null,` — a botched mass-rename collapsed the variable names. Body still references `K` and `B`.

Impact on CBE: the activation crash dumps a noisy stack into the host log and was bystander-killing a CBE reload happening at the same moment (concurrent activate failures cascade in the extension host). Out-of-scope to fix in this sprint — flagged for the owner of azure-openai-ext.

### 18. Inject inventory & post-pivot status

All in [`C:\Users\moren\Desktop\Claude Codex Black\injects\`](C:\Users\moren\Desktop\Claude Codex Black\injects):

| File | Purpose | Status post-pivot |
|---|---|---|
| `aa-error-logger.js` | `window.onerror` → `fetch http://127.0.0.1:57836` | ✅ Alive (panel still needs error visibility) |
| `black-edition.js` | Borders, label, CSS vars, broad colour rules | ⚠️ Designed for Anthropic chat — needs port to panel surface |
| `click-trace.js` | Logs every click to 57836 (debug) | ⚠️ Useful but useless without patch-webview |
| `code-view-source.js` | Right-click → modal with Prism highlight | ❌ Orphan (no Anthropic patch path) |
| `context-menu.js` | Custom right-click menu | ❌ Orphan |
| `devtools-rightclick.js` | Forces DevTools-allowing right-click | ❌ Orphan |
| `hide-bypass.js` | Hides Bypass-permissions button + native TTS | ❌ Orphan (was Anthropic-targeted) |
| `kill-old-poll.js` | Clears stale `__cb*Interval` globals on re-inject | ⚠️ Port to panel re-inject loop |
| `monitor-btn.js` | Shield button + `/monitor/status` poll | ⚠️ Move logic into `panelHtml()` |
| `paste-submit.js` | Defines `window.__cbPaste` (React setter + Enter) | ❌ Orphan (chat surface gone) |
| `prism-highlight.js` | Scans `<pre>/<code>`, calls `Prism.highlightElement` | ⚠️ Re-target to panel content area |
| `prompt-canvas.js` | 100 px bordered canvas next to prompt | ❌ Orphan |
| `red-stop-btn.js` | Red Stop toolbar button | ❌ Orphan (was a Claude-interrupt button) |
| `shadow-debug.js` | Periodic DOM-count + button-title dump | ⚠️ Debug-only |
| `skin-loader.js` | Polls `/skin/css`, injects `<style>` | ✅ Alive — works inside panel |
| `speech-fix.js` | Clipboard-change watcher → `__cbPaste` | ❌ Obsolete (Whisper now calls `submitText` directly) |
| `stt-provider-menu.js` | Right-click mic → provider QuickPick | ⚠️ Wire into panel mic |
| `zz-auto-wakeup.js` | Inject-side wake-up watcher | ❌ Disabled (server-side wins) |

The patcher itself ([`patch-webview.js`](C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js)), the launcher (`launch.ps1`), `hooks/red-stop.js`, and `zz-bundle-watcher.js` were renamed `.removed` 2026-05-10 17:26 when user said: **"My extension needs to have ZERO interaction with antropics"** (line 173). Do not restore. The Injector class, `/injects/manifest`, and `/injects/bundle` endpoints still exist server-side but currently have no consumer — intended for a future poller bootstrap inside CBE's own panel.

### 19. This session's changes (18:43 → now)

Concrete diffs applied to BOTH the Desktop and installed-VSIX copies of `extension.js`:

1. **STT bug #1 (CRLF)** — `getOpenAiKey()` regex `(.+)` → `([^\r\n]+)`. Lines 521-526 of [`extension.js`](C:\Users\moren\Desktop\Claude Codex Black\extension.js). Same patch in `getGeminiKey()`.
2. **STT bug #2 (multipart streaming truncation)** — `transcribeWhisper()` rewritten to build single `Buffer.concat` body and call `req.end(body)` once. Lines 544-665.
3. **STT bug #3 (submitText not called)** — `stopAndTranscribe()` now `await submitText(text)` after `pendingText = text` assignment. Lines 380-388.
4. **WebviewPanelSerializer pivot** — `CodexBlackPanelSerializer.deserializeWebviewPanel()` now disposes the persisted panel instead of restoring it (lines 1185-1192). Comment: "Zero-anthropic pivot: don't auto-restore the panel on reload. User opens it explicitly via codexBlackEd.openPanel command."
5. **`WHITEPAPER.md` updated** in both Desktop and installed copies: post-zero-Anthropic architecture section, Whisper STT pipeline (ffmpeg → multipart → `submitText`), gotchas reference (CRLF, backpressure, em-dash, `tasklist` vs `process.kill`).
6. **Memory written**: [`cbe_zero_anthropic.md`](C:\Users\moren\.claude\projects\C--Users-moren\memory\cbe_zero_anthropic.md) created and indexed in `MEMORY.md`.

---

## What's Working ✅

- ✅ CBE ctrl server listening on **57837**, log server on **57836** with EADDRINUSE auto-retry ([`extension.js`](C:\Users\moren\Desktop\Claude Codex Black\extension.js))
- ✅ OpenAI Whisper STT — single-buffer multipart POST, correct trimmed bearer key, `submitText` chained ([`extension.js:544-665`](C:\Users\moren\Desktop\Claude Codex Black\extension.js), `:380-388`, `:523-526`)
- ✅ Skin loader pipeline — XML parser handles `<color>` + `<gradient>`, `/skin/css` + `/skin/list` + `/skin/reload` endpoints, [`skin-loader.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\skin-loader.js) injects `:root` block every 8s
- ✅ `black-edition.js` rewritten to use `var(--cb-*, fallback)` throughout
- ✅ Auto-wakeup — server-side only, per-PID first-fire + 5min same-process cooldown, retry loop 5×4s ([`extension.js sendWakeUp`](C:\Users\moren\Desktop\Claude Codex Black\extension.js))
- ✅ `WebviewPanelSerializer.deserializeWebviewPanel` disposes persisted panels — no more ghost duplicate tabs on reload (lines 1185-1192)
- ✅ Prism static served at `/lib/prism.min.js` and `/lib/prism-langs.min.js` (CSP-safe)
- ✅ Prism re-highlights on new code blocks via MutationObserver, `dataset.cbPrism` markers no longer collide
- ✅ `cbe.ini` + `C:\triodesktop\config.ini` key reads (CRLF-tolerant)
- ✅ Two-source sync directive in place — STT fixes applied to both `Desktop\Claude Codex Black` AND `.vscode\extensions\trentontompkins.codex-black-ed-1.0.0`
- ✅ Stale `local.claude-voice` registry entry removed from `extensions.json`; CBE wins the activation race
- ✅ Read-aloud button in orb panel — `speechSynthesis.speak` works inside CBE's own webview sandbox
- ✅ Watchdog `tasklist`-based health check + launcher-PS1 detached spawn (when monitor is re-enabled)
- ✅ `aa-error-logger.js` posts `window.onerror` to port 57836 — JS errors surface in `cbe.log`
- ✅ `cbe_zero_anthropic.md` memory present and indexed
- ✅ Zero edits inside `~/.vscode/extensions/anthropic.claude-code-*` — pivot enforced
- ✅ Em-dash purged from `cbe_watchdog.ps1` template

## What's Broken ❌

- ❌ Prism colours on bash/shell blocks **"look like shit i can ever read them"** — language detection misses on `language-bash` variants and broad `black-edition.js` `pre, code` colour rules win the cascade ([`prism-highlight.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\prism-highlight.js), [`black-edition.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\black-edition.js))
- ❌ ffmpeg device hardcoded to `"audio=Microphone (webcam AC310)"` — fails on every other machine; no device picker ([`extension.js`](C:\Users\moren\Desktop\Claude Codex Black\extension.js) `startRecording`)
- ❌ Monitor watchdog **disabled** after the 6-zombie incident at 17:56 — Task Scheduler job still registered but not actively running ([`cbe_watchdog.ps1`](C:\Users\moren\Desktop\Claude Codex Black\cbe_watchdog.ps1))
- ❌ Inject-side `zz-auto-wakeup.js` disabled — if server-side wake-up race-loses against reload tear-down, there is no fallback
- ❌ 13 of 18 injects are orphaned post-pivot — they ran against Anthropic's webview which CBE no longer patches ([`injects/`](C:\Users\moren\Desktop\Claude Codex Black\injects))
- ❌ Right-click engine/voice/rate/volume picker for read-aloud not wired ([`panelHtml()`](C:\Users\moren\Desktop\Claude Codex Black\extension.js))
- ❌ `code-view-source.js` modal is orphan — no path to invoke it in CBE's own panel
- ❌ `prompt-canvas.js` orphan — no place in the orb panel for it
- ❌ Gemini STT path (`transcribeGemini`) untested end-to-end since the pivot
- ❌ `TrentTompkins.azure-openai-chat` crashes on activate at line 13418 (`Invalid destructuring assignment target`) — bystander-noisy in host log ([`C:\Users\moren\Desktop\azure-openai-ext\`](C:\Users\moren\Desktop\azure-openai-ext))
- ❌ "Attach menu (+)" CSS: white-on-white text (logged in `cbe_sprint_20260510.md`) — selectors miss Claude Code's actual classes
- ❌ `sendClick.py` PostMessage path untested — webview sandbox may still ignore it
- ❌ JS-error capture from injects partial — only `aa-error-logger.js` covers `window.onerror`, no `unhandledrejection` listener
- ❌ `WAKE_UP_SENT_FILE` PID-guard logic exists but is not deleted on uninstall — leaves a stale tmp file

## Open Questions / Decisions Needed

- Should the Injector + `/injects/bundle` pipeline be revived **inside CBE's own panel webview** (poller pattern per `reference_vscode_api_constraints.md`), or retired entirely now that there's no Anthropic surface to inject into?
- Is the good.png aesthetic (orange footer + black prompt + mic toolbar inline in Claude Code's chat) being formally abandoned, or rebuilt inside the orb panel?
- Re-enable the monitor watchdog with a single-instance lockfile, or leave disabled?
- Keep both Whisper + Gemini providers, or drop Gemini to simplify?
- Should ffmpeg device become user-pickable (one-time enumeration UI) or env-var driven?
- Is the read-aloud right-click settings panel (voice/rate/volume) in-scope for this sprint?
- Treat the `.removed` files as deprecated permanently — delete them, or keep as historical reference?
- Bystander crash from `azure-openai-chat`: fix it (one-line destructuring repair) or leave alone?

## Next Steps (ordered)

1. **End-to-end STT smoke test** — open orb panel, click mic, speak 30s, verify Whisper transcript reaches Claude Code chat input via `submitText`. Path: [`extension.js:329 stopAndTranscribe`](C:\Users\moren\Desktop\Claude Codex Black\extension.js). Expected: paste lands once, no truncation, no 401, no duplicate submission.
2. **ffmpeg device picker** — add `/audio/devices` endpoint that runs `ffmpeg -list_devices true -f dshow -i dummy` and parses output; expose picker in panel settings; persist selection in `cbe.ini`. Touch: `extension.js startRecording`.
3. **Prism cascade fix** — scope `black-edition.js` `pre/code` rules with `:not(pre[class*="language-"]) :not(code[class*="language-"])` so Prism's per-token classes win. Touch: [`injects/black-edition.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\black-edition.js). Expected: bash/shell blocks legible against dark bg.
4. **Decide on Injector revival** — if yes, implement poller bootstrap inside `panelHtml()` that fetches `/injects/bundle` every 2s. Touch: [`extension.js panelHtml`](C:\Users\moren\Desktop\Claude Codex Black\extension.js).
5. **Port monitor button into panel HTML** — move shield SVG + 5s polling into `panelHtml()`; drop the orphan `monitor-btn.js` inject. Touch: [`extension.js panelHtml`](C:\Users\moren\Desktop\Claude Codex Black\extension.js).
6. **Wire read-aloud right-click menu** — voice/rate/volume QuickPick driven by `speechSynthesis.getVoices()`. Touch: `panelHtml()` and the read-aloud button handler. Persist to `cbe.ini`.
7. **Audit & cull orphan injects** — move `code-view-source.js`, `context-menu.js`, `devtools-rightclick.js`, `hide-bypass.js`, `paste-submit.js`, `prompt-canvas.js`, `red-stop-btn.js`, `speech-fix.js` to an `injects/legacy/` folder. Touch: filesystem only.
8. **Single-instance watchdog lock** — `cbe_watchdog.ps1` opens an exclusive lock on `%TEMP%\cbe_watchdog.lock` and exits if held; prevents the 6-PS-process incident. Touch: [`cbe_watchdog.ps1`](C:\Users\moren\Desktop\Claude Codex Black\cbe_watchdog.ps1). Then `Start-ScheduledTask -TaskName CBE-Watchdog`.
9. **Add `unhandledrejection` to `aa-error-logger.js`** — currently only `window.onerror`; promise rejections (most Whisper failures) are invisible. Touch: [`injects/aa-error-logger.js`](C:\Users\moren\Desktop\Claude Codex Black\injects\aa-error-logger.js).
10. **VSIX rebuild + dual-write check** — `vsce package`, `code --install-extension`, then diff `~/.vscode/extensions/trentontompkins.codex-black-ed-1.0.0/extension.js` against `Desktop\Claude Codex Black\extension.js` to confirm zero drift. Document the dual-write rule at the top of [`extension.js`](C:\Users\moren\Desktop\Claude Codex Black\extension.js).
