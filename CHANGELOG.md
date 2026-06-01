# Changelog

All notable changes to **Claude Codex — Black Edition** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] — 2026-06-01

### Added — Bridge Operator (the new big one)

- **Provider-selectable Bridge Operator.** The vision pilot that drives the browser bridges (reads screenshots of the offscreen Chromium, emits click/type actions to chatgpt / grok / gemini / claude / copilot / deepseek) is now provider-selectable instead of hard-wired. Pick the operator LLM in **Settings → Bridge Operator**: **Azure OpenAI (default)**, **OpenAI**, **Anthropic**, or **Google (Gemini API key)**.
- **Google Vertex (Cloud / ADC) operator provider.** A fifth operator option that authenticates via Google Cloud Application Default Credentials — no API key in `config.ini`, it uses your local `gcloud` ADC login.
- **Operator model / deployment loader.** The Bridge Operator pane has a **Load** button that fetches the selected provider's live model list (Azure surfaces deployments, the others surface models) into the dropdown, with a status line. Selection is stored per-provider so switching back and forth keeps each one's chosen model.

### Added — skins

- **15 skins** ship in the box (codex-black, claude-default, glassy, office, aqua-dock, macos-color-dock, mint-dock, tamagotchi, terminal, arch, kde, gnome, xfce, ubuntu, redhat).
- **Edit-Skin editor light syntax highlighting** — the in-modal skin source editor now applies lightweight token highlighting so CSS reads more clearly while editing.

### Fixed — skins

- **Prompt-row label position is now a single shared rule per skin** (center / left / right), replacing the scattered per-skin overrides that drifted out of sync.
- **Settings-modal contrast fixed per skin** — light-chrome skins no longer rendered low-contrast (washed-out) text in the Settings modal.

---

## [1.2.1] — 2026-05-31

### Added

- **Paste & drag-drop image attachments** in the composer. Pasting a screenshot or dragging an image file onto the prompt box now queues an `image.png` attachment chip and ships the image natively to vision-capable providers via the existing out-of-band `images[]` channel. Non-image content falls through to default behavior.
- **Daily live model-list fetch per provider.** On first use each day the Settings model dropdown is refreshed from each provider's live models endpoint (cached once/day, silent-fail back to built-in defaults on error, no dialog). Fixes the dropdown showing a stale newest model (e.g. it listed `claude-opus-4-7` after `claude-opus-4-8` shipped).

### Fixed

- **`/switch` (Switch Account) opened nothing** — a duplicate, earlier `claudeCodeSwitchAccount` handler that only called `claude-vscode.logout` shadowed the intended one, so the in-app auth picker never showed. Removed the dead logout-only handler; `/switch` / `/switch account` now open CBE's own 3-option auth picker (Claude.ai subscription / Anthropic Console / Bedrock·Foundry·Vertex) as documented.
- **Modal close buttons rendered as solid "magic boxes"** in every skin. The shared `.cbe-x` close button used `mask: url("icons/close-x.svg")`, but that file never existed and the relative path doesn't resolve in a webview — so the mask 404'd and `background-color: currentColor` filled the whole button. Created `assets/close-x.svg` and repointed every mask (`panel/index.html` + 15 skins) to `{{ASSETS_BASE}}/close-x.svg`.
- **Webview "tofu" icon glyphs converted to SVG.** Inline modal close `×` (11 sites), the About + Tamagotchi close buttons, the attachment/download paperclip, tool-confirm Allow/Deny `✓`/`✗`, Saved/Installed `✓`, image-result, and nag-card icons now render as SVG (mask-reuse for close buttons, inline `<svg>` elsewhere) instead of font-dependent Unicode.
- **aqua-dock: prompt text was white-on-white** (invisible until selected) — `#promptBox` forced `--aq-text` (#f1f8ff) over the light glass input bar. Now dark slate (`#243240`) with a readable placeholder.
- **aqua-dock: SEND button** no longer shows a leftover blue-glow box from `.send-button` bleeding through the text-only `#sendBtn` lock — `box-shadow`/focus-ring killed; it's just the word "SEND".

### Changed

- **aqua-dock: label + project-folder pills moved out of the prompt bar** back into the dock panel chrome (centered row atop the toolbar). The prompt bar's inline cluster keeps only Stop.
- **aqua-dock: prompt input now spans the full panel width** (was capped at `max-width: 720px` and centered).
- **xfce (Classic GTK) skin — prompt-row polish.** Reversed the Stop/Send order (Send left, Stop pinned to the right edge); SEND is now text-only (killed the leftover `.send-button` box-shadow box bleeding through the `#sendBtn` lock); equal ~14px margins on all four sides of the white prompt box + a matching gap under the toolbar; all toolbar glyphs forced solid black (the trailing terminal/git/branch icons were light-grey-on-light-grey and nearly invisible); neutralized the orange-theme inset bevel that bled onto the grey shell as a gold/maroon hairline.

---

## [1.2.0] — 2026-05-30

### Added — realtime local STT (the new big one)

- **whisper-cpp-stream** — Local realtime STT via the `whisper.cpp` `stream` example binary. Keyless, offline, ~75 MB GitHub release download on first use. Sliding-window VAD with ~500ms partial-transcript cadence. Windows-first (ffmpeg dshow capture).
- **faster-whisper-stream** — Local realtime STT via faster-whisper (CTranslate2) + webrtcvad. Keyless, offline, ~150 MB one-time Python venv bootstrap (`faster-whisper`, `webrtcvad`, `numpy`). int8 quantization on CPU, optional float16 on CUDA. Windows-first.
- **Deepgram Nova-3 (direct)** — Surfaced as its own first-class STT provider in Settings, separate from the Anthropic proxy. Uses `[deepgram] api_key` in `config.ini`.

### Fixed

- **OpenAI STT routed through working host-side ffmpeg capture** instead of sandbox-blocked webview `getUserMedia` — the prior path always threw `NotAllowedError → "microphone access denied"` even with the OS mic grant correct. ElevenLabs already used the host path; OpenAI now matches.
- **Settings dropdown validator** no longer silently re-pins new-provider selections back to `elevenlabs` on every Settings open. Auto-migrates stale `whisper-local` values to `whisper-cpp-stream`.
- **Stale "Voice (elevenlabs):" error strings** now read the actual provider from the message payload.
- **Spinner consolidation** — now 2 spinners (blue for general + green for VSCode monitor only). `loading_orange.svg` and `auto_read_spinner.svg` removed; 4 main-panel refs + 15 skin overrides updated.

### Changed

- **STT default order** — ElevenLabs Scribe v2 stays first; whisper-cpp-stream + faster-whisper-stream replace the old whisper-local batch path; Deepgram added; WebSpeech moved to last-resort fallback.

### Removed

- **whisper-local batch HTTP server** — ~300 lines of bundled whisper.cpp server bootstrap + handler. Replaced by the two realtime providers above. Auto-migration handles stored `whisper-local` settings values.

---

## [1.1.0] — 2026-05-26

### Added — voice subsystem (the big one)

CBE now works out of the box with **no API keys**. Read-aloud and dictation default to keyless providers, with premium upgrades when you want them.

- **WebSpeech (default)** — browser-native `SpeechSynthesis` for read-aloud and `SpeechRecognition` for dictation. STT streams partial transcripts as you speak (the same engine gemini.com uses).
- **whisper-local** — Windows-only offline STT via a bundled whisper.cpp server. One-time ~75 MB model download on first use; nothing leaves your machine after that.
- **Anthropic streaming STT** — uses your Claude Code OAuth login (from `~/.claude/.credentials.json`), so it's included with a Claude subscription with no separate API key. Under the hood it's a Deepgram-Nova-3-backed streaming endpoint with IDE-vocabulary keyterm tuning.
- **ElevenLabs Scribe** and **OpenAI gpt-4o-transcribe** as premium STT options (require keys in `config.ini`).

### Added — Settings page redesign

- **Categorized left-nav layout.** The Settings modal is now a left vertical category list + right scrollable values pane. Categories: **Provider & Model**, **Read Aloud (TTS)**, **Speech to Text**, **Appearance**, **Tool Calls**.
- **Voice controls** — pick a TTS provider, voice, speech rate, and volume; pick an STT provider, language, and a custom dictionary / vocabulary (the label adapts: *Keyterms* on Anthropic, *Vocabulary prompt* on Whisper/OpenAI).
- **First-run popup** explains the keyless-out-of-the-box behavior and where to add optional keys.

### Changed

- **Defaults flipped to keyless.** TTS = WebSpeech everywhere. STT = whisper-local on Windows, WebSpeech on macOS/Linux.
- **claude-default skin** — toolbar icons lightened to Claude's medium grey; subtle divider restored above the toolbar row to match the official Claude Code look.
- **codex-black skin** — clean dark composer matching the Claude Code chrome (sans-serif input, lighter monochrome icons, killed the colored bevel lines).

### Fixed

- **TTS/STT false-failure** — the panel used to default to ElevenLabs and surface a "TTS failed" toast before silently falling back to working WebSpeech. The error path is now console-only and defaults are keyless, so nothing scary appears for users without keys.

### Removed

- **Host-side SAPI TTS/STT** — deprecated and replaced by the higher-quality keyless paths above. Around 640 lines of legacy PowerShell-driven SAPI scaffolding went with it.

---

## [1.0.2] and earlier

See git log: <https://github.com/tibberous/Claude-Codex-Back-Ed./commits/main>.
