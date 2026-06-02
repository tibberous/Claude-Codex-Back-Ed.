# Changelog

All notable changes to **Claude Codex — Black Edition** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### CCLS — session-limit → auto account-switch (output-stream detector)

- **CBE now catches the weekly-cap sentence directly in the wrapped Claude
  output stream** and fires the local account switcher (`GET
  http://127.0.0.1:3333/switch`, override via `CCLS_SWITCH_URL`). This is the
  CBE-side counterpart to the Claude-Code-side hook
  (`C:\hooks\ccls_limit_switch.py`); the two are independent so whichever sees
  the cap first rotates the account. CBE's tap catches the message even when it
  arrives as plain assistant **text** (not a thrown 429), which the existing
  `classifyRateLimit` error-path would miss.
- Tapped the streaming chokepoints in `handleSendText` / `chatStream` (the
  `assembled += delta` loop) **and** the wrapped `claude` CLI subprocess path
  (`text_delta`, terminal `result`, and `stderr`). Tolerant case-insensitive
  matcher mirrors `ccls_limit_switch.py`'s `LIMIT_RE`. Self-throttled (60s) and
  fully fault-isolated — a detector fault can never break the chat stream.

## [1.0.2] — 2026-06-01

The current Marketplace release. It bundles the Bridge Operator, the full
voice / speech-to-text subsystem, image paste, the 15-skin system, and the
Settings redesign. (The internal development milestones once labelled
1.1.0–1.3.0 all ship together as **1.0.2** — the version reset for the
Marketplace launch.)

### Bridge Operator — provider-selectable vision pilot

- **Pick the operator LLM in Settings → Bridge Operator.** The vision pilot that drives the browser bridges (reads screenshots of the offscreen Chromium and emits click/type actions to chatgpt / grok / gemini / claude / copilot / deepseek) is now provider-selectable instead of hard-wired: **Azure OpenAI (default)**, **OpenAI**, **Anthropic**, **Google (Gemini API key)**, or **Google Vertex (Cloud / ADC)** — the Vertex option authenticates via your local `gcloud` Application Default Credentials, no API key in `config.ini`.
- **Model / deployment loader.** A **Load** button fetches the selected provider's live list (Azure surfaces deployments; the others surface models) into the dropdown; the choice is stored per-provider.

### Skins

- **15 skins** ship in the box (codex-black, claude-default, glassy, office, aqua-dock, macos-color-dock, mint-dock, tamagotchi, terminal, arch, kde, gnome, xfce, ubuntu, redhat).
- **Single shared prompt-row label rule per skin** (center / left / right), replacing scattered per-skin overrides that drifted out of sync.
- **Edit-Skin editor** now applies lightweight light-theme syntax highlighting so the skin source reads clearly while editing.
- **Settings-modal contrast fixed per skin** — light-chrome skins no longer render washed-out text in the Settings modal.
- **Modal close buttons + "tofu" glyphs converted to SVG** across the panel + all 15 skins (the missing-mask "magic box" close buttons, the `×` / `✓` / `✗` / paperclip glyphs).
- **aqua-dock / xfce prompt-row polish** — readable prompt text, text-only SEND (no leftover glow box), label + folder pills relocated into the dock chrome, full-width input.

### Composer

- **Paste & drag-drop image attachments** — pasting a screenshot or dragging an image onto the prompt queues an attachment chip and ships it natively to vision-capable providers.
- **Daily live model-list fetch** per provider (cached once/day, silent-fall-back to built-ins) so the model dropdown isn't stale when a new model ships.

### Voice — Read-aloud (TTS) & Speech-to-text (STT)

- **Keyless out of the box.** WebSpeech (browser-native) drives read-aloud + dictation with no API keys; premium engines plug in when you want them.
- **Realtime local STT** — `whisper-cpp-stream` and `faster-whisper-stream`: keyless, offline, ~500 ms partial-transcript cadence (nothing leaves your machine).
- **Deepgram Nova-3 (direct)**, **Anthropic streaming STT** (via your Claude login), **ElevenLabs Scribe**, and **OpenAI gpt-4o-transcribe** as additional STT options.
- **Settings page redesign** — categorized left-nav (Provider & Model / Read Aloud / Speech to Text / Appearance / Tool Calls) with per-provider voice + vocabulary controls and a keyless first-run explainer.

### Fixes & cleanup

- **`/switch` (Switch Account)** now opens CBE's 3-option auth picker (a dead logout-only handler was shadowing it).
- **STT false-failure toast** removed — the error path is console-only now that defaults are keyless.
- **Settings dropdown validator** no longer silently re-pins new-provider selections back to ElevenLabs on open.
- **Spinner consolidation** to two (blue general + green VSCode-monitor).
- **Removed** the whisper-local batch HTTP server and the legacy host-side SAPI TTS/STT scaffolding (auto-migration handles stored settings).

## Earlier

See the git log: <https://github.com/tibberous/Claude-Codex-Back-Ed./commits/main>.
