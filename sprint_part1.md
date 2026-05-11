CBE Sprint — 2026-05-10 PM (Part 1 of 2)
=========================================

## Overview

Claude Codex Black Ed. (CBE) is a VSCode extension forked from `claude-voice` (Web Speech API mic input) and grown over two days into a full UI surface: STT/TTS (Whisper + Gemini + Web Speech), Prism-highlighted code blocks, an orange-glass footer, ghostwhite monospace prompt, an orb panel, a monitor/watchdog, a hot-reload subsystem, and (until 2026-05-10 17:26) a deep patcher that rewrote Anthropic's `webview/index.js` and `extension.js` on every Claude Code update. **At 17:26 the user pivoted to "ZERO interaction with antropics"** — the patcher was renamed `.removed`, twelve surgical edits stripped the Anthropic touchpoints from `extension.js`, and CBE is now intended to be a standalone extension whose UI lives in its own `codexBlackEd.panel` webview tab. The previous version of this sprint was 89 lines and the user said it was a trash job because "prism isnt on there... That should be like 4 pages long." This document covers 2026-05-09 22:54 → 2026-05-10 18:48. Source tree: [C:\Users\moren\Desktop\Claude Codex Black\](C:\Users\moren\Desktop\Claude Codex Black\). Installed VSIX: `C:\Users\moren\.vscode\extensions\trentontompkins.codex-black-ed-1.0.0\`.

## Timeline (chronological)

- **2026-05-09 22:54** — `make_icon.py` / SVG-via-ImageMagick path failing on the orb icon; switched to PNG source + alpha mask
- **2026-05-09 23:12** — User: *"it is supposed to open to chat like the regular Claude extension it forked... Read our chat from today and rebuild it 1 change at a time"*; context-compaction restart begins
- **2026-05-09 23:13–23:18** — Rebuilding `broken` portable VSCode session: `local.claude-voice-1.0.0` was registered in `extensions.json` but the Codex Black fork was not; extracted `codex-black-ed-1.0.0.vsix` into `broken\extensions\TrentonTompkins.codex-black-ed-1.0.0\` and added an `extensions.json` entry
- **2026-05-09 23:23** — Discovered EDH was loading `local.claude-voice-1.0.0` AND Codex Black simultaneously, both fighting over panel ID `'claudeVoice'`, sentinel `__cvInjector`, and matching patch-webview markers
- **2026-05-09 23:24–23:34** — Identifier-collision rename: `__cv*` → `__cb*` across `extension.js`, `patch-webview.js`, `injects/*.js`; panel type `'claudeVoice'` → `'codexBlackEd.panel'`; React component `VoiceMicBtn` → `CodexBlackMicBtn`
- **2026-05-10 00:12–00:34** — VSCode kept restoring stub orb panels on reload (no `WebviewPanelSerializer` registered); cleared CachedData; stopped clearing `Service Worker` dirs (was triggering "Could not register service worker" errors)
- **2026-05-10 00:43–00:59** — Read-aloud button + label badge dropped from `panelHtml()` during rebuild. User: *"you forgot the lanel! And the read aloud! Stop skimming and slow down!"* Restored: speaker SVG (single-click read, double-click auto-read), "Claude Codex — Black Edition" label
- **2026-05-10 01:05** — User: *"thats close but you still missed like prism and stuff. you got to read the log better buddy. Isnt reading text like your thing? Why arent you doing it?"* Audit found `kill-old-poll.js` and `prism-highlight.js` still on `__cv*`
- **2026-05-10 01:10** — `replace_all`: `__cvPrismLoaded` → `__cbPrismLoaded`, `__cvPrismObserver` → `__cbPrismObserver`; `red-stop-btn.js` caught during sweep (`__cv_red_stop_btn`, `__cvRedStopInterval`)
- **2026-05-10 01:14** — Removed the giant "Start Recording" button from `panelHtml()` — orb itself is the click target
- **2026-05-10 01:22** — User: *"next time just run it with code --extensionDevelopmentPath='C:\Users\moren\Desktop\Claude Codex Black', take a screenshot, and if its broke taskkill it, fit it and try again. it's silly having me keep running a broken project"*
- **2026-05-10 02:09** — CBE deactivated mid-session; ctrl server became zombie on 57837 (EADDRINUSE)
- **2026-05-10 02:44–02:51** — Discovered `workbench.action.webview.reloadWebviewAction` *"isn't reaching Claude Code's webview — it's not a standard panel target"*; added `localStorage`-timestamped wakeup cooldown to survive `retainContextWhenHidden:true` (`__cbWakeupSent` was sticking forever in retained context)
- **2026-05-10 02:53** — Speaker-button triplication: `black-edition.js` injected a 🔊, panel had one, Claude Code had its own — deduplicated
- **2026-05-10 03:05–03:12** — Gemini STT path: `getGeminiKey()`, `transcribeGemini()`, `getSttProvider()`/`setSttProvider()`, `/speech/provider` ctrl endpoint, right-click provider menu (`stt-provider-menu.js`) with localStorage fallback
- **2026-05-10 03:27–03:38** — Prism-from-CDN blocked by Claude's CSP. Fix: load `lib/prism*` from `http://127.0.0.1:57837/lib/`. `code-view-source.js` now reuses `window.Prism` if present
- **2026-05-10 04:19** — User: *"auto resp is broken"* — `cbe.ini` missing, every Whisper call silently failing
- **2026-05-10 04:30** — User: *"auto resp is broken"*; added tracing to `speech-fix.js` and a test script
- **2026-05-10 04:40** — Found `zz-auto-wakeup.js` line 101: `var MAX = 8` with 1.5s delay (way too aggressive). Cut to MAX=3, delay 8s. Later cut to MAX=1
- **2026-05-10 04:42** — Auto-resp message: *"Hey! Wake up! You're a code bot! Read C:\Users\moren\.claude\CLAUDE.md auto resp does fire on reloads change what triggers it"*
- **2026-05-10 04:51** — User: *"auto resp didnt fire :( its too fragile changew hat triggesr s it"*. Decision: panel-open server-side trigger via `submitText()`, no DOM polling
- **2026-05-10 04:57** — Both server-side `sendWakeUp` AND inject-side `zz-auto-wakeup.js` firing simultaneously. Doubling bug born here, not yet diagnosed
- **2026-05-10 05:09–05:11** — Watchdog PS1 generator had an em-dash (`—`) in a string (`"watchdog] Code.exe gone — relaunching"`); PowerShell parser corrupted it to `?` and PS1 died inside 3s. Fixed at [extension.js:11936](C:\Users\moren\Desktop\Claude Codex Black\extension.js)
- **2026-05-10 05:17** — Watchdog rewrite: dedicated launcher PS1, PID file, `tasklist`-based liveness (replaces broken `process.kill(pid, 0)` which returns false for detached Windows procs)
- **2026-05-10 11:18–11:30** — User confirmed monitor green (PID 31312, `running:true`). Watchdog auto-relaunched VSCode at 07:29 after a death
- **2026-05-10 11:20** — Watchdog was relaunching bare `code`, no `--extensionDevelopmentPath`; fixed at extension.js line 305; double-backslash bug in path replace also fixed
- **2026-05-10 11:33** — `cbe.ini` finally created with OpenAI Whisper + Gemini keys, `provider=openai`
- **2026-05-10 11:44–12:03** — Toolbar button color fight: `[class*="toolbar"]` selectors weren't matching; switched to "any button inside the orange footer" + `!important` on `fill` and `color`. Compact "CBE" pill replaced the giant label
- **2026-05-10 12:06–12:07** — Monitor shield wouldn't turn green: `fill:#fff!important` in `black-edition.js` was overriding the green inline `setActive` (important beats inline). Fix: exclude `#__cb_monitor_btn` from the SVG fill rules
- **2026-05-10 12:08–12:24** — CSP investigation: webview `console.error` reaches DevTools but `fetch()` to `127.0.0.1:57836` silently dropped. Found CSP template in Anthropic's `extension.js`: `default-src 'none'; ${D}; ${M}; ${w}; script-src 'nonce-${q}'; ${G};` — patched `patch-webview.js` to splice in `connect-src http://127.0.0.1:57835 http://127.0.0.1:57836 http://127.0.0.1:57837`
- **2026-05-10 12:18** — Discovered `mouse.py click X Y` does NOT reach the sandboxed Chromium webview at all — clicks land at OS level but the webview never sees them
- **2026-05-10 12:44–12:57** — Auto-wakeup doubling root cause: `vscode.commands.executeCommand('type', { text:'\n' })` routes to active *editor*, not webview textarea. Replaced with `mouse.py key enter` (Win32 SendInput). Then disabled server-side `sendWakeUp` because `zz-auto-wakeup.js` → `__cbPaste()` → `/speech/submit` → `submitText()` was the proven path
- **2026-05-10 13:04–13:09** — Skin system shipped: `skins/default.xml`, `loadSkinXml()`, `changeSkin()`, `/skin/css` + `/skin/list` + `/skin/reload`, `injects/skin-loader.js` 8s poll, `black-edition.js` rewritten to `var(--cb-*)`
- **2026-05-10 13:14** — User: *"stop stop stop"* — Claude looped `workbench.action.reloadWindow` curls without changes between firings. `feedback_reload_loop.md` memory written
- **2026-05-10 13:18** — Prism confirmed running after `dataset.cvPrism` → `dataset.cbPrism` rename; MutationObserver picks up new code blocks
- **2026-05-10 13:19** — User: *"yeah they look like shit buddy i can ever read them"*. Prism running but lang detection failing + `black-edition.js` overriding token colors. **Unresolved at end of sprint.**
- **2026-05-10 14:09** — Wired `window.onerror` + `unhandledrejection` + wrapped `console.error/warn` to log server 57836 → `C:\Users\moren\codex-black-errors.log`
- **2026-05-10 14:12** — User: *"auto resp didnt fire :("*. CBE never activated; webview reload only refreshes chat panel, not extension host
- **2026-05-10 15:08–15:10** — `Injector` class added to `extension.js`; watches `injects/`, bumps `version` on file change. New endpoints: `/injects/manifest` + `/injects/bundle`. Designed as the poller-based hot-reload replacement
- **2026-05-10 15:15** — User: *"you broke my extension"* (echo of the later 17:07 message)
- **2026-05-10 15:23** — Two-source sync incident: installed VSIX auto-patched and OVERWROTE the Desktop-source patch with 17 injects from the VSIX folder, not 18 from Desktop
- **2026-05-10 16:17** — Skin-fallback regression: `composer/InputWrapper` used `var(--cb-footerBg, #2a2a2e)` (dark grey fallback) which beat orange. Fix: set the `:root` var globally
- **2026-05-10 16:44–16:51** — User asked about a bundle-version watcher (option 3). Implemented `zz-bundle-watcher.js` polling `/bundle/version` exposing `__cbBundleTs`. One bootstrap reload, then all subsequent inject changes hot-apply via `location.reload()`
- **2026-05-10 17:07** — User: *"you broke my extension"*. Screenshot showed CBE panel as a tiny floating UI in mostly-empty editor area, TWO tabs both labeled "Claude Codex Black Ed." (left split + right split). Claude Code chat sidebar invisible
- **2026-05-10 17:11** — User insisted on a proper recursive collision scan: *"grep the caude extensions string... do the same thing with mine, diff them, then go through and use diff again to get the strings that ARE in both (like an anti diff)"*
- **2026-05-10 17:13–17:16** — `scan_recursive.py` writes `collision_report.json`. Only `onStartupFinished` and `window.fetch` intersected. `fix_collisions.py` rename pass had already worked. Duplicate-panel bug was NOT a collision
- **2026-05-10 17:16–17:25** — Found actual cause at [patch-webview.js:217-225](C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js.removed): it deliberately rewrote `'"claudeVSCodePanel","Claude Code"'` → `'"claudeVSCodePanel","Claude Codex Black Ed."'`. Lines 232–251 injected CBE's bootstrap poller into Anthropic's HTML template as inline `<script nonce="${q}">` that fetched `/injects/bundle` and `Function()`-evaled it. Four-option triage list presented
- **2026-05-10 17:26** — User: *"1 2 4 . My extension needs to have ZERO interaction with antropics"* (verbatim)
- **2026-05-10 17:28** — Eleven-line edit plan + four file renames written and presented before any change
- **2026-05-10 17:29–17:34** — Zero-anthropic pass executed; `node --check` passed; zero refs to `claude-vscode`, `patch-webview`, `watchClaudeCode`, `clearVSCodeCache`, `sendWakeUp`, `WAKEUP_`, `anthropic.claude-code`, `"Claude Code"`, or `reloadWebviewAction` in active runtime files
- **2026-05-10 17:46** — User: *"it does even show up when you click it"*; panel didn't open in fresh window
- **2026-05-10 17:48** — Discovered CBE was running the OLD installed copy at `C:\Users\moren\.vscode\extensions\trentontompkins.codex-black-ed-1.0.0`, still calling `sendWakeUp`, `clearVSCodeCache`, `claude-vscode.focus`. Desktop edits never reached runtime
- **2026-05-10 17:50** — `Activating extension 'TrentTompkins.azure-openai-chat' failed: Invalid destructuring assignment target.` — separate project (Azure OpenAI fork of Claude Code) crashed during same reload window. Bystander damage
- **2026-05-10 17:51** — User: *"Kill every VSCode but this one"*
- **2026-05-10 17:54–17:56** — 12 zombie `Code.exe` processes; only PID 36320 (EDH) had a window. CBE on PID 36164. **6 separate CBE watchdog PowerShell processes** plus a Task Scheduler job respawning Code.exe faster than they could be killed
- **2026-05-10 17:58** — Watchdog disabled. Zombies killed. CBE confirmed up
- **2026-05-10 17:59** — Usage limit hit mid-cleanup
- **2026-05-10 18:43** — Next session: *"its broke :("*. Chat is vanilla, panel floats mid-right. `patch-webview.js.removed` confirms zero-anthropic stuck. **`extension.js.pre-zero-anthropic.bak` does NOT exist on disk**
- **2026-05-10 18:47** — `WebviewPanelSerializer` (registered at extension.js:828–838, now line ~1131) auto-restores the orb panel on every startup. Closing the tab doesn't keep it gone. `package.json:79–87` contributes `codexBlackEd.openPanel` to `editor/title`, putting an icon on every editor tab — easy to mis-click
- **2026-05-10 18:48** — Realised: with `patch-webview.js` gone, NONE of the chat injects reach Anthropic's webview. `Injector` + `/injects/bundle` exist as orphan plumbing

## Architectural State

The user pivoted hard at 17:26 from "patch Anthropic's webview" to **"ZERO interaction with antropics"**. CBE is now a standalone VSCode extension whose UI lives in its own `codexBlackEd.panel` webview tab, NOT injected into Claude Code's chat. The historical mode (deep patcher rewriting Anthropic's `extension.js` and `webview/index.js` on every Claude Code update) is dead. The mechanism that drove it — [patch-webview.js](C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js.removed) — is preserved as `.removed` only as an audit trail. Anthropic's `extension.js` and `webview/index.js` are pristine in 2.1.138 (no `__cbPoller`, no `CodexBlackMicBtn`, no `.original.bak`).

The `Injector` class in `extension.js` (~lines 97–168) plus its `/injects/manifest` and `/injects/bundle` endpoints (~lines 689–720) were originally the planned hot-reload upgrade per `cbe_hotreload_arch.md`: a poller-bootstrap that survives `retainContextWhenHidden:true` retained-context webviews where `workbench.action.webview.reloadWebviewAction` is a no-op. After the zero-anthropic pivot **those endpoints still exist but have no consumer** — Anthropic's webview is no longer patched, so nothing polls them. They are plumbing for a future feature (the orb panel itself loading injects, or some other consumer to be wired). The watcher still runs, `injector.version` still bumps on save, but no client fetches.

The orb panel is supposed to be the UI surface now. Its current `panelHtml()` holds: orb (mic), status line, prompt textarea, Send button, Monitor button, Skin button, Speaker (read-aloud) button. The polished good.png aesthetic — orange-glass footer, black monospace prompt, white toolbar icons, "CBE" pill — was the *patched-Claude-Code* look that has been deliberately abandoned. If the user wants it back it has to be re-implemented inside the orb panel webview, sourcing colors from `skins/default.xml` via `var(--cb-*)`.

The `injects/` folder (eighteen `.js` files plus two `.removed` — [click-trace.js](C:\Users\moren\Desktop\Claude Codex Black\injects\click-trace.js), [black-edition.js](C:\Users\moren\Desktop\Claude Codex Black\injects\black-edition.js), [prism-highlight.js](C:\Users\moren\Desktop\Claude Codex Black\injects\prism-highlight.js), [skin-loader.js](C:\Users\moren\Desktop\Claude Codex Black\injects\skin-loader.js), [monitor-btn.js](C:\Users\moren\Desktop\Claude Codex Black\injects\monitor-btn.js), [stt-provider-menu.js](C:\Users\moren\Desktop\Claude Codex Black\injects\stt-provider-menu.js), etc.) is currently inert — they were bundled into Claude Code's webview by the now-removed patcher. They survive as raw material to be loaded into the orb panel's own webview, or repurposed file-by-file.

Two parallel install locations exist and they drift. `Desktop\Claude Codex Black\extension.js` and `C:\Users\moren\.vscode\extensions\trentontompkins.codex-black-ed-1.0.0\extension.js` were demonstrably out of sync at the moment of pivot (Desktop newer, installed older). Earlier at 15:23 the installed VSIX auto-patched and **overwrote** Desktop with 17 injects from the VSIX folder, not 18. The right pattern is edit Desktop, then `vsce package` + `code --install-extension --force` (or `robocopy /MIR`), then exactly ONE reload window per `feedback_reload_loop.md`.

## Topic deep-dives (architecture & decisions half)

### 1. Zero-Anthropic Pivot

The pivot fired at **2026-05-10T17:26:30** when the user replied to a four-option triage with: *"1 2 4 . My extension needs to have ZERO interaction with antropics"*. Options were: (1) stop renaming Anthropic's panel title, (2) stop injecting CBE's poller into Anthropic's HTML template, (3) both 1+2, (4) add `WebviewPanelSerializer` to fix the duplicate-panel bug. User picked **1+2+4**.

The 11-line edit plan presented BEFORE any change (rare discipline — Claude listed every edit with file:line + reason and only applied after user implicit go-ahead). Applied 17:29–17:34 as **twelve surgical edits** to `extension.js`:

| # | line range | change | reason |
|---|------------|--------|--------|
| 1 | 116–136 | Strip `_scheduleLiveReload()` body to no-op (only bumps `injector.version`) | Was running patch-webview.js + focusing Anthropic + reloading its webview |
| 2 | 506–507 | Drop `claude-vscode.focus` call inside `submitText` | Direct Anthropic command call |
| 3 | 744 | Drop `chat: 'claude-vscode.focus'` from `focusMap` | Same |
| 4 | 822–854 | Delete `watchClaudeCodeExtension()` entirely | Watched Anthropic's `webview/index.js` for changes to auto-repatch |
| 5 | 1173–1209 | Delete `clearVSCodeCache()` entirely | Wiped Anthropic's CachedData + sniffed Anthropic's `extension.js` for patch state |
| 6 | 1215 | Drop `clearVSCodeCache()` call in `activate` | call site |
| 7 | 1231 | Drop `watchClaudeCodeExtension()` call in `activate` | call site |
| 8 | 1086–1110 | Delete `sendWakeUp()`, `WAKE_UP_SENT_FILE`, `WAKEUP_MSG`, `WAKEUP_COOLDOWN` | Wakeup pumped text into Anthropic's chat |
| 9 | 1258–1259 | Drop `setTimeout(() => sendWakeUp(context), 4000)` | call site |
| 10 | (new) | Add `vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', new CodexBlackPanelSerializer())` in `activate` | Fixes "two CBE panels" bug |
| 11 | line 1 comment | Update header from "for Claude Code" → "standalone voice + UI panel" | Cosmetic |
| 12 | `cbe-server.js:240–278` | Delete live-reload-via-repatch block, replace with simple Code.exe relaunch | Watchdog spawned `patch-webview.js` |

**Four files renamed `.removed`** (preserved, not deleted): [patch-webview.js](C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js.removed), `launch.ps1` (only purpose: run patch-webview.js), [hooks/red-stop.js](C:\Users\moren\Desktop\Claude Codex Black\hooks\red-stop.js.removed) (only purpose: interrupt Anthropic's chat), `injects/zz-bundle-watcher.js` (tied to patch-webview's bundle stamp).

[extension.js.pre-zero-anthropic.bak](C:\Users\moren\Desktop\Claude Codex Black\extension.js.pre-zero-anthropic.bak) was claimed in the 17:34 changelog but **does NOT exist on disk** in either Desktop or the install location. Either it was never actually written, or overwritten by a later sync. Rollback is no longer cleanly possible from the working tree — diff is recoverable only from `.claude` session JSONL.

Verification at 17:34: `node --check` passed on `extension.js` and `cbe-server.js`. Recursive collision scanner re-run after edits — still 0 real collisions. Zero references to `claude-vscode`, `claudeVSCode`, `patch-webview`, `watchClaudeCode`, `clearVSCodeCache`, `sendWakeUp`, `WAKEUP_`, `anthropic.claude-code`, `"Claude Code"`, or `workbench.action.webview.reloadWebviewAction` in any active runtime file.

### 2. Auto-wakeup pipeline

Two parallel mechanisms ran simultaneously and produced double-pasting:

1. **Server-side** `sendWakeUp()` in `extension.js`: clipboard-paste `WAKEUP_MSG`, then `vscode.commands.executeCommand('type', { text:'\n' })`, with `WAKE_UP_SENT_FILE` PID-based guard. **Bug:** `executeCommand('type',…)` routes keystrokes to the active *editor*, not a webview's textarea — the newline never reached Claude's chat input. **Fix:** shell-out to `mouse.py key enter` (Win32 SendInput).

2. **Inject-side** `zz-auto-wakeup.js`: originally `var MAX = 8; var DELAY = 1500;` — DOM-polling for the textarea, setting via React native setter (`__cbPaste`), dispatching `Enter` keydown. **Bug:** the keydown event didn't trigger Claude's submit (Claude reads the *click* on the submit button, not keydown). **Fix:** `__cbPaste()` calls `/speech/submit` → `submitText()` → real submit-button click.

The doubling bug surfaced **at 12:57** once both pipelines worked: BOTH ran, BOTH submitted. Resolution: disable server-side `sendWakeUp` entirely (keep only the inject path, which actually reaches the right submit button). At 17:30 the zero-anthropic pivot removed `sendWakeUp` permanently. `zz-auto-wakeup.js` survived the pivot but is **now orphaned** — no patcher to bundle it into Anthropic's chat. The MAX=8/1500ms aggressive retry is gone (reduced to MAX=1).

User quotes: 04:30 *"auto resp is broken"*; 04:51 *"auto resp didnt fire :( its too fragile changew hat triggesr s it"*; 12:42 *"auto resp didnt fire. you using inline javascript?"*; 14:12 *"auto resp didnt fire :("*; 14:44 *"its still too fragile why is it fralige buddy?"*. The auto-resp itself fired at 04:13, 04:28, 04:42, 04:47, 04:51, 05:13 during model idles.

### 3. CSP & nonce handling (historical)

Claude Code's webview shipped `default-src 'none'; ${D}; ${M}; ${w}; script-src 'nonce-${q}'; ${G};` with **no `connect-src`** — so every `fetch('http://127.0.0.1:578XX/...')` from inside the webview was silently dropped. Symptoms: Monitor shield never went green, log fetches to 57836 returned no body, structured logging dropped. DevTools console showed: *"Fetch API cannot load http://127.0.0.1:57835/injects/manifest"*. Discovered at 12:20.

Fix at 12:21–12:24 in `patch-webview.js`: regex onto Anthropic's CSP template, splice in `connect-src http://127.0.0.1:57835 http://127.0.0.1:57836 http://127.0.0.1:57837`. **Note:** the initial patch missed 57835 (companion server). Caught from the DevTools error and added.

Nonce handling: every script tag injected into Anthropic's webview HTML had to carry the per-load nonce that Anthropic rotates. `patch-webview.js` extracted it from the HTML template variable `${q}` and emitted `<script nonce="${q}">` for both the bootstrap poller and each inject IIFE. CSP requires nonce on all scripts — eval ban means `applyInject()` couldn't use `Function()` to eval the bundle response. Fix: `applyInject()` creates `<script nonce="...">` elements and writes the bundle into `.textContent`; nonce extracted at runtime via `document.querySelector('script[nonce]').nonce`.

**This is now historical.** With patch-webview.js `.removed`, CBE is no longer modifying Anthropic's CSP. The only CSP that matters is the one on the orb panel's own webview, and CBE controls that fully (Extension Host serves the panel HTML; the local-network ports are same-origin from `vscode-webview://...` only if explicit `connect-src` is declared in the panel's CSP meta tag).

### 4. `__cv*` → `__cb*` collision rename

When CBE was forked from `claude-voice` both extensions could be loaded simultaneously in some configurations and fought over panel ID `'claudeVoice'`, sentinel `__cvInjector`, `__cvLog`, `__cvPaste`, etc. EDH ran them side-by-side at **2026-05-09 23:23**. Automated by [fix_collisions.py](C:\Users\moren\Desktop\Claude Codex Black\fix_collisions.py).

Files renamed in the first pass: `extension.js`, `patch-webview.js`, all of `injects/`. Sentinels: `__cvInjector` → `__cbInjector`, `__cvLog` → `__cbLog`, `__cvPaste` → `__cbPaste`, etc. Panel type `'claudeVoice'` → `'codexBlackEd.panel'`. React component `VoiceMicBtn` → `CodexBlackMicBtn`. Dataset attributes `data-cv-prism` → `data-cb-prism` etc.

**Files missed by the automation**, found and fixed manually on 01:09–01:10:
- [kill-old-poll.js](C:\Users\moren\Desktop\Claude Codex Black\injects\kill-old-poll.js) — kept the `__cv*` interval names in its blacklist (would have killed the wrong intervals)
- [prism-highlight.js](C:\Users\moren\Desktop\Claude Codex Black\injects\prism-highlight.js) — `__cvPrismLoaded`, `__cvPrismObserver`, `dataset.cvPrism`
- [red-stop-btn.js](C:\Users\moren\Desktop\Claude Codex Black\injects\red-stop-btn.js) — `__cv_red_stop_btn`, `__cvRedStopInterval` (caught during sweep, not specifically targeted)

The 17:13 recursive scanner verified clean: only `onStartupFinished` (standard VS Code activation event) and `window.fetch` (JS built-in) intersected between CBE and Anthropic's 2.1.138 build. **22 identifier classes checked** (commands, viewTypes, view IDs, view containers, postMessage tags, HTTP routes, ports, status-bar IDs, when-clause contexts, register/executeCommand IDs, package.json contributions, walkthrough IDs, window globals, DOM IDs, CSS classes/selectors, sentinel vars, process.env keys, temp filenames, etc.) — **0 real collisions**.

### 5. Hot-reload architecture

Three iterations:

1. **`workbench.action.webview.reloadWebviewAction`** — fired by `Injector._scheduleLiveReload(fname)` with 600ms debounce on any `injects/*.js` change. Discovered at 02:50 to be **a no-op for `WebviewView` sidebar webviews** like Claude Code's chat. Only reloads the focused panel; if Claude's panel isn't focused it falls back to focusing it first, which often fails. Per `cbe_hotreload_arch.md`: *"VSCode's reloadWebviewAction is a no-op for CC sidebar webviews."*

2. **`zz-bundle-watcher.js` + `/bundle/version`** — implemented at 16:51 ("option 3"). Inline script in the bootstrap exposes `__cbBundleTs` (the patcher's timestamp); the inject polls `/bundle/version` every 2s, compares against `__cbBundleTs`, calls `location.reload()` from inside the webview when changed. One bootstrap reload, then all subsequent inject changes hot-apply. **This was the working hot-reload path** until 17:30 when zero-anthropic killed it (renamed `.removed`).

3. **Poller bootstrap (planned, not delivered)** — the `Injector` class + `/injects/manifest` + `/injects/bundle` were designed as the cleaner replacement: tiny inline script in bootstrap polls `/injects/manifest` for `version`, re-fetches `/injects/bundle` on change, `new Function(bundle)()`. Each inject becomes responsible for being idempotent (clear prior DOM/intervals before re-applying). No webview reload at all. Per `cbe_hotreload_arch.md` this was the architecturally clean fix. With zero-anthropic, **no consumer was ever wired up** — the manifest+bundle endpoints exist with no caller.

`retainContextWhenHidden:true` on the orb panel makes the bootstrap-guard problem worse: `if (window.__cbInjector) return` in the bootstrap means injects only run once per webview lifetime, and retained-context webviews never trigger a fresh bootstrap. That's exactly the failure mode the poller pattern was designed to solve. The `__cbWakeupSent` sticking problem at 02:51 was the same class of bug — solved with `localStorage`-timestamped cooldown.

### 6. Orb panel + WebviewPanelSerializer

Panel ID `codexBlackEd.panel`. Created with `vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }`. Retained-context flag is intentional — keeps the recording state, mic permission, and current transcript across panel hide/show.

The **duplicate-panel bug** (the symptom that triggered the zero-anthropic pivot at 17:07): VSCode persisted the panel state between sessions. On reload, with no `WebviewPanelSerializer` registered, VSCode tried to "restore" the panel by creating a stub. CBE then created its own real panel. Two tabs, both labeled "Claude Codex Black Ed.", and the chat sidebar wasn't visible because both panels grabbed editor area columns. This was compounded by `patch-webview.js:217-225` renaming Anthropic's panel title to the same string — see topic 8.

Fix at 17:30: registered `CodexBlackPanelSerializer` via `vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', new CodexBlackPanelSerializer())` in `activate`. The serializer's `deserializeWebviewPanel()` re-binds the persisted panel into the live instance instead of letting VSCode create a stub.

**But** — this same serializer is now the cause of "panel keeps coming back even after closing". Discovered at 18:47 (`extension.js:828–838` then, ~line 1131 now). User presses close, panel re-restored on next reload. Disabling the deserializer (neutering its body) is the planned fix this session.

Related trap: `package.json:79–87` contributes `codexBlackEd.openPanel` to `editor/title`, putting a panel-open icon on every editor tab — the user mis-clicks that constantly, opening new panels by accident.

### 7. Injector + /injects/bundle (orphan plumbing)

Implemented at **15:08–15:10** in `extension.js` (lines 97–168 for the class, 689–720 for the endpoints). Watches the `injects/` directory via `fs.watch`, bumps an integer `version` on any file change, exposes:
- `GET /injects/manifest` → `{version: N, files: ["prism-highlight.js", ...]}`
- `GET /injects/bundle` → concatenated IIFE-wrapped JS, all 18 active injects strung together
- `GET /bundle/version` → just `__cbBundleTs` for the `zz-bundle-watcher.js` design

**Pre-pivot consumer:** `patch-webview.js`'s bootstrap poller (inline `<script nonce="${q}">` injected into Anthropic's HTML template at lines 232–251) fetched `/injects/bundle` and `Function()`-evaled it. So Anthropic's webview executed ALL of CBE's injects on top of Anthropic's chat UI.

**Post-pivot:** Anthropic's webview is no longer being patched. The orb panel's `panelHtml()` does NOT poll these endpoints. The eight `.removed` files (including `zz-bundle-watcher.js`) prove the hot-reload path was specifically deleted. The endpoints still serve, the watcher still runs, `injector.version` still bumps on save — **but nothing fetches it**. Architecturally orphan. Either the orb panel webview gets wired to consume `/injects/bundle` (Part 2's "Next Steps" should address) or the `Injector` + endpoints should be deleted as dead code.

### 8. Duplicate-panels bug (the pivot trigger)

The 17:07 screenshot showed CBE panel rendering as a tiny floating UI (orb + Send + Monitor/Skin/Speaker) in a mostly-empty editor area, with **TWO tabs both labeled "Claude Codex Black Ed."** (one in left split, one in right split). The Claude Code chat sidebar wasn't visible at all. User: *"you broke my extension"*.

Initial hypothesis (17:11): name-collision between CBE and Anthropic. User insisted on a proper recursive scan. The 17:13–17:16 `scan_recursive.py` walked 22 identifier classes across both extension trees → only `onStartupFinished` and `window.fetch` intersected. **Not a collision bug.**

Actual cause found at 17:16 in [patch-webview.js:217-225](C:\Users\moren\Desktop\Claude Codex Black\patch-webview.js.removed):
```js
const OLD_TITLE = '"claudeVSCodePanel","Claude Code"';
const NEW_TITLE = '"claudeVSCodePanel","Claude Codex Black Ed."';
```
The patcher *deliberately* renamed Anthropic's panel title to the same string CBE used. That's why both tabs appeared identical. Compounded by missing `WebviewPanelSerializer` — VSCode restored a stub panel on reload AND CBE created a fresh one, yielding two tabs.

Additionally `patch-webview.js:232-251` injected CBE's bootstrap poller into Anthropic's HTML template as inline `<script nonce="${q}">` that fetched `/injects/bundle` and `Function()`-evaled it. Anthropic's webview was executing ALL of CBE's injects on top of Anthropic's chat UI. Two simultaneous, intentional violations of "zero interaction."

Triggered the 17:26 pivot. The four-option triage list (stop rename / stop poller / both / add serializer) gave the user the keys: *"1 2 4"*.

### 9. Dev-loop discoveries

- **`code --extensionDevelopmentPath=...` is single-instance** — the dev-host launch is a dead-end because VSCode just opens the existing window. Per `cbe_inplace_devloop.md`: *"dev-host launch is a dead-end (VSCode single-instance). Click chat to focus, save inject, auto-watcher reloads only that webview. No window reload needed."*
- **`workbench.action.webview.reloadWebviewAction` reloads only the FOCUSED webview.** Useless when you save an inject without first focusing the chat. Confirmed at 02:50.
- **`mouse.py click X Y` does NOT reach the sandboxed Chromium webview** — discovered 12:18. Clicks land at OS level but the webview never sees them. Affects every "click button at X,Y" automation against CBE's webview. Not actionable from automation — only via VSCode commands or DOM JS injection.
- **Working dev loop pre-pivot:** click chat to focus, save inject, `_scheduleLiveReload` debounces + fires the reload command. New bundle takes over within ~3s.
- **Post-pivot:** no working hot-reload at all. Edits to `panelHtml()` require a full window reload (`workbench.action.reloadWindow`), which tears down everything for 30s. Per `feedback_reload_loop.md`: *"VSCode reloadWindow: fire ONCE, wait 15-30s before checking ports."*
- **The 13:14 reload-loop incident:** Claude fired `workbench.action.reloadWindow` curls in a tight loop without changes between firings. User: *"stop stop stop"*. CLAUDE.md "fire ONCE" rule born from this.
- **Two-install drift dev hazard:** at 17:48 the runtime was demonstrably running the OLD installed copy even though Desktop edits were complete. At 15:23 the OPPOSITE — installed VSIX auto-patched and overwrote Desktop with 17 injects, not 18. Edit-discipline is not yet mechanized.
- **`--extensionDevelopmentPath` was missing from the watchdog's `code` relaunch** until 11:20 — VSCode came back without CBE loaded after every crash. Fixed at extension.js:305 with double-backslash bug in the PowerShell path also fixed.
