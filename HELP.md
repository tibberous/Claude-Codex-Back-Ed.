# Codex Black Edition — Help

## How Codex Black Edition Works

CBE rides on top of Anthropic's Claude Code via a patcher (`patch-webview.js`) that bundles inject scripts into the existing webview. Every CBE feature renders *inside* Anthropic's chat panel — there is no separate CBE window.

The orange "label-alpha" pill, the dark theme, microphone (Whisper/Gemini STT), screenshot button, monitor watchdog, and this help system are all driven by injects bundled at activation time and hot-reloaded within ~2s of save.

A local control server on port `57837` bridges the webview to VSCode (clipboard, focus, terminal, status). All UI lives in the webview; all VSCode actions go through the server.

## Keyboard Shortcuts

| Shortcut             | Action                       |
|----------------------|------------------------------|
| `Ctrl+Shift+B`       | Focus the Claude Code chat   |
| `Ctrl+Shift+M`       | Toggle voice recording       |
| `/help`              | Open the help menu           |

## Features

- **Voice input** — ffmpeg captures audio, sent to OpenAI Whisper or Gemini for transcription, pasted into the chat.
- **Screenshot send** — capture a region of the screen and paste it directly into the chat.
- **Custom skins** — XML-driven theme system in `themes/`; switch via the command palette.
- **Hot-reload injects** — save any file in `injects/` and it re-bundles + reloads within ~2 seconds, no VSCode reload.
- **Auto wakeup** — watchdog relaunches VSCode if it crashes, and replays a wake-up prompt so the conversation resumes itself.
- **Right-click menu** — custom contextmenu inside the chat with quick access to Help.

## Triggers for This Menu

The help modal can be opened three ways:

1. Click the `?` button in the chat toolbar (next to the mic/monitor buttons).
2. Type `/help` in the chat input and press Enter.
3. Right-click anywhere in the chat input or message list and select "Help".

All three call `window.__cbShowHelp()`, which is idempotent — calling it again while open is a no-op.

## About

- **Repo**: https://github.com/tibberous/Claude-Codex-Back-Ed
- **Author**: Trenton Tompkins
- **Email**: trenttompkins@gmail.com
- **Version**: 1.0.0

The About section in the modal is populated live from `config.ini`'s `[about]` section via the extension's `/about` ctrl-server endpoint (port 57837).
