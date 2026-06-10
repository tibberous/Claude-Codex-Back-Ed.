# CBE STT Bug Report — Whisper + Deepgram

Diagnosis only (no code edited). Repo: `C:\codexblack\`. Files inspected:
`panel\panel.js`, `extension.js`, `config.ini`.

Quick map of the STT providers (from `panel.js:1446-1510` mic dispatch):
`webspeech` (panel SpeechRecognition) · `elevenlabs` (host WS stream) ·
`whisper-cpp-stream` ("Whisper.cpp (local, realtime)") ·
`faster-whisper-stream` · `openai` (host batch) · `anthropic` (host WS) ·
`deepgram` (host WS, BYO key). The UI label "Whisper" = `whisper-cpp-stream`
(`panel.js:3311`).

---

## Bug 1 — Whisper (whisper-cpp-stream) completely non-functional

### Root cause
The realtime Whisper provider depends on whisper.cpp's **`stream` example
binary** (`whisper-stream.exe`). The bootstrap downloads the prebuilt Windows
release zip `whisper-bin-x64.zip` and then searches it for the stream binary —
**but ggerganov's prebuilt Windows release zips do NOT ship the `stream`
example** (it needs SDL2 and is excluded from the release artifacts; the zip
only contains `main.exe` / `whisper-cli.exe` / `server.exe` / `bench` /
`quantize`). So the search always fails and bootstrap throws before any audio
is ever captured.

### Exact file:line(s)
- `extension.js:3112` — `_resolveWhisperBinUrl()` resolves to
  `whisper-bin-x64.zip` (asset picker `extension.js:2956-2958`; fallback URL
  `extension.js:2864-2865` = `.../whisper-bin-x64.zip`).
- `extension.js:2974-2989` — `_findWhisperStreamExe()` only matches
  `/^(whisper-stream|whisper-cli-stream|stream)\.exe$/i`. None of these exist
  in the release zip → returns `''`.
- `extension.js:3126-3131` — `const found = _findWhisperStreamExe(extractDir);
  if (!found) { throw new Error('whisper.cpp \`stream\` binary not found inside
  the release zip…'); }` ← **the actual failure point.**
- That throw propagates: `_ensureWhisperStreamFiles` (called at
  `extension.js:4626`) → `catch` at `4666-4669` → `reportFail(e)` →
  `panel.webview.postMessage({ type:'sttResultEl', ok:false, fallback:false })`
  (`extension.js:4616-4621`).
- Panel side `sttResultEl` with `ok:false` + no `fallback` →
  `panel.js:1798-1802`: `cancelLiveDictation()` + `addMsg('Voice (…): …', 'info')`.
  It surfaces only a low-key grey info line and **never transcribes** — from the
  user's POV: click Whisper, get nothing. (Note: unlike ElevenLabs/Deepgram,
  the whisper-cpp error path passes `fallback:false`, so there is NO fallback to
  any working provider — it is a hard dead end.)

### Evidence
- The download asset is hardcoded to the prebuilt release zip
  (`extension.js:2864`, `:2957`), which is the `main/cli/server` build, not the
  examples build.
- The error string at `extension.js:3128-3130` literally documents the
  situation ("The release … may not bundle the stream example. Build
  whisper.cpp from source with -DWHISPER_BUILD_EXAMPLES=ON…").
- `faster-whisper-stream` is a separate, independent provider
  (`extension.js:4639-4662`) and is NOT affected by this — only the
  whisper.cpp `stream`-binary path is dead.

### Specific fix needed (pick one)
1. **Switch the realtime Whisper provider off the missing `stream` binary.**
   Easiest correct fix: drive `whisper-cli.exe` / `main.exe` (which IS in the
   zip) in a chunked/VAD loop instead of the `stream` example, OR route the
   "Whisper" UI choice to the already-working `faster-whisper-stream`
   implementation (it produces the same `sttDeltaEl`/`sttResultEl` protocol).
2. **OR** change `_resolveWhisperBinUrl()` / `WHISPER_BIN_FALLBACK_URL`
   (`extension.js:2864-2865`, `:2956-2958`) to fetch a build that actually
   bundles `stream.exe` (a `-sdl2` / examples artifact), and verify
   `_findWhisperStreamExe` matches its name.
3. **At minimum (not a real fix, but stops the silent dead-end):** when the
   stream binary can't be obtained, set `fallback:true` on the
   `sttResultEl` error at `extension.js:4616-4617` so the panel falls back to a
   working batch provider instead of just printing an info line. The clean
   user-facing fix is #1.

---

## Bug 2 — Deepgram accumulates the prior transcript on every new message

### Root cause
The Deepgram streaming session's final transcript is emitted **only** from
`ws.on('close')` → `succeed()` → `onFinal()` → `sttResultEl`
(`extension.js:4222-4228`, `:4287-4289`). That final is what triggers the
panel's `commitLiveDictation()`, which is the ONLY place
`liveActive/livePrefix/liveText` get reset (`panel.js:1322`).

But Deepgram's `close()` (`extension.js:4236-4240`) **only sends `CloseStream`
and then waits for the server to close the socket. It does NOT (a) clear the
keepalive interval, nor (b) force-close the WS on a timeout.** The keepalive
`setInterval` (`extension.js:4192-4194`) keeps sending `{type:'KeepAlive'}`
frames — which actively prevents Deepgram from idle-closing — and `cleanup()`
(the only thing that clears it, `extension.js:4177`) is reached **only** from
`fail()`/`succeed()`, neither of which has fired yet. Result: in practice
`ws.on('close')` is unreliable/late, `succeed()` often never fires, so
**`onFinal`/`sttResultEl` never arrives → `commitLiveDictation()` never runs →
`liveActive` stays `true` and the dictation is never committed/reset.**

Then on the NEXT mic press, `startDeepgramStreaming()` calls
`beginLiveDictation()`, which snapshots **whatever is currently in the textarea
as the new prefix** (`panel.js:1301-1303`:
`livePrefix = cur ? cur + ' ' : ''`). Because the previous utterance was never
cleared/committed out of that state, every new utterance is rendered as
`prior text + new text`, and it grows on each cycle = the reported
accumulation. (`send()` clears `ti.value` at `panel.js:507` but does **not**
reset `liveActive/livePrefix/liveText` — so a still-"active" dictation re-seeds
itself.)

### Exact file:line(s)
- Accumulator is correctly **session-local** (resets each new recording) at
  `extension.js:4171-4172` (`latest`, `finalText`) and
  `:4205` (`finalText = finalText ? (finalText + ' ' + txt) : txt`). So the
  accumulation is NOT inside the Deepgram WS parser.
- **The missing reset / stuck-open socket is the bug:**
  - `extension.js:4192-4194` — keepalive interval keeps the WS alive.
  - `extension.js:4236-4240` — `close()` sends `CloseStream` only; **no
    `cleanup()` (keepalive never cleared) and no `setTimeout(()=>ws.close(),…)`
    forced close.**
  - `extension.js:4177` — `cleanup()` (clears keepalive) is only invoked by
    `fail`/`succeed`.
  - `extension.js:4185-4189 / 4222-4228` — `succeed()` fires only on
    `ws.on('close')`; if the socket stays open it never runs, so
    `onFinal` (`:4287-4289`) never posts `sttResultEl`.
- **Where the panel should have reset but doesn't:**
  - `panel.js:1312-1322` — `commitLiveDictation()` is the only place
    `liveActive=false; livePrefix=''; liveText=''` happens; it runs only on
    `sttResultEl`/`sttFinal`.
  - `panel.js:1299-1304` — `beginLiveDictation()` re-snapshots
    `livePrefix = ti.value`; with no prior commit this carries the old text
    forward.
  - `panel.js:482-509` — `send()` clears `ti.value` (`:507`) but never resets
    the live-dictation state, so a never-committed Deepgram dictation survives
    the send and re-seeds the prefix.

### Evidence
- ElevenLabs' otherwise-identical streaming session DOES guard against exactly
  this: its `close()` clears nothing-needed-but-importantly **force-closes the
  socket on a 1.5s timeout** — `extension.js:3989-4001`:
  `setTimeout(() => { try { ws.close(); } catch(_){} }, 1500);`. whisper-cpp's
  session does the same with `setTimeout(()=>proc.kill(), 1500)`
  (`extension.js:4481-4482`). **Deepgram's `close()` is the only streaming
  session with no forced-close/cleanup**, which is why only Deepgram exhibits
  the "never commits → accumulates" behavior.
- The KeepAlive frames (`extension.js:4193`) are sent unconditionally on the
  interval and are never stopped by `close()`, so they keep the socket from
  idle-closing after `CloseStream`.

### Specific fix needed
In `createDeepgramSttSession().close()` (`extension.js:4236-4240`), mirror the
ElevenLabs pattern:
1. Call `cleanup()` (or `clearInterval(keepalive)`) immediately so KeepAlive
   stops letting the socket linger.
2. After sending `CloseStream`, add a forced fallback:
   `setTimeout(() => { succeed(); try { ws.close(); } catch(_){} }, 1500);`
   so `succeed()` → `onFinal` → `sttResultEl` is guaranteed to fire (and thus
   `commitLiveDictation()` resets the panel state) even if Deepgram doesn't
   promptly close the socket.
   (Make sure `succeed()` stays idempotent — it already guards on `settled`, so
   a later real `ws.on('close')` is a harmless no-op.)

**Belt-and-suspenders (recommended, fixes the class of bug):** in
`panel.js`, have `send()` (`:482`) reset live-dictation state when a dictation
is still active — e.g. call `cancelLiveDictation()` (or directly
`liveActive=false; livePrefix=''; liveText='';`) before/after clearing
`ti.value` at `:507`. That guarantees no provider can leak an uncommitted
transcript across a send, independent of host-side timing.

---

## Shared notes (plumbing both fixes touch)
- Both streaming providers share the **`sttDeltaEl` (partial) / `sttResultEl`
  (final)** message protocol and the panel's **live-dictation state machine**
  (`beginLiveDictation`/`updateLiveDictation`/`commitLiveDictation`/
  `cancelLiveDictation`, `panel.js:1295-1329`). The single reset point is
  `commitLiveDictation` (`:1322`). Anything that prevents a final from arriving
  (Bug 1's hard throw, Bug 2's stuck socket) leaves that state dirty — so the
  `send()`-side reset in `panel.js` hardens every provider at once.
- The Deepgram key reads fine: `[deepgram] api_key` is present in
  `C:\codexblack\config.ini:190-191`
  (`b2484edeb0977ac3ca00f11588c618ccb1cb48fd`) and `_getDeepgramKey()`
  (`extension.js:942-960`) reads config → `DEEPGRAM_API_KEY` env → TrioDesktop
  master. Bug 2 is NOT a key/auth issue.
- Bug 1 is NOT a key issue either (whisper.cpp is keyless/local); it is purely
  the missing `stream` binary in the downloaded artifact.
- The two realtime local providers are independent: `faster-whisper-stream`
  (`extension.js:4491-4592`, `:4639-4662`) is unaffected by Bug 1 and is a
  ready-made target if you want to repoint the "Whisper" UI choice at a working
  local engine.
```
