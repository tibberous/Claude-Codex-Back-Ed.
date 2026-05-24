# Claude Codex Black Ed.

Standalone VSCode extension for chatting with any LLM — direct API or browser bridge — without leaving your editor. Multi-account, multi-language, pluggable bridges, TTS/STT, attach-file, skins, pixel-pet, the works.

**Copyright 2026 Trenton Tompkins — [trentontompkins.com](https://trentontompkins.com)** · MIT license

## Install

Download `codex-black-ed-<version>.vsix` from the [Releases page](https://github.com/tibberous/Claude-Codex-Back-Ed./releases) and run:

```
code --install-extension codex-black-ed-1.6.0.vsix
```

Or in VSCode: Extensions panel → ⋯ menu → **Install from VSIX…** → pick the file.

## Use

Open the panel with **Claude Codex Black: Open Panel** from the command palette, or `Ctrl+Shift+B` (`Cmd+Shift+B` on macOS). Type a prompt, hit Enter. Type `/` for slash commands. Click the provider pill at the bottom-left to switch LLMs.

## Features

- **20 chat / inference / video bridges** out of the box — Claude, ChatGPT, Gemini, Grok, Copilot, DeepSeek, Ollama (enabled by default) + Perplexity, Mistral, Pi, HuggingChat, Veo, Runway, Luma, Kling, fal.ai, Replicate, OpenRouter, Groq, Pika (disabled by default; flip `<enabled>true</enabled>` to use).
- **Direct API providers** — Anthropic, OpenAI, Google, xAI, DeepSeek, Azure (drop your key in Settings).
- **Pluggable `.bridge` XML extensions** — drop a file in `extensions/`, get a new provider. See [help](panel/help.html#extensions).
- **Panel extensions (`.ext`)** — mini-apps inside the panel (calculator, emoji picker, minesweeper bundled; install more from the catalog).
- **Multi-account** — multiple API keys per provider, switch on the fly via `/switch`.
- **TTS / STT** — read replies aloud (ElevenLabs / SAPI), dictate prompts (Web Speech / SAPI).
- **Skins** — codex-black (default), tamagotchi (with pixel pet!), glassy, office, several Linux desktop themes.
- **Languages** — translated UI strings for 50+ locales.
- **Compact / compress** — summarize-and-prune the conversation to keep token costs down.
- **Hot reload** — edit `panel/*.js` or `panel/*.html` and refresh without a full VSCode reload.

## Slash commands

Type `/` at the start of the textarea, pick from:
`/help`, `/handbook`, `/clear`, `/settings`, `/prompts`, `/history`, `/font`, `/attach`, `/folder`, `/compact`, `/git`, `/github`, `/license`, `/push`, `/switch`, `/switch account`, `/email`.

## Build from source

```
git clone https://github.com/tibberous/Claude-Codex-Back-Ed..git
cd Claude-Codex-Back-Ed.
npm install
python tools/pack_release.py
```

The packed `.vsix` lands in `dist/`.

## Where to file bugs

[github.com/tibberous/Claude-Codex-Back-Ed./issues](https://github.com/tibberous/Claude-Codex-Back-Ed./issues)
