# Changelog

All notable changes to **Claude Codex — Black Edition** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
