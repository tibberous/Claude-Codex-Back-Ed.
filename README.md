# Claude Codex Black Ed.

Black Edition voice + UI layer for Claude Code. Adds mic input, read-aloud, black borders, and a hot-reload inject system — all running alongside (not replacing) the standard Claude Code extension.

**Coded by Claude. Copyright 2026 Trenton Tompkins — trentontompkins.com**

---

## Features

- **Voice input** — click the mic button or press `Ctrl+Shift+B`, speak, text pastes into Claude automatically
- **Black Edition UI** — black borders, drop shadow on input box, "Claude Codex — Black Edition" label in toolbar
- **Read-aloud button** — single click reads last Claude response, double-click toggles auto-read mode
- **Hot-reload inject system** — drop any `.js` file in `injects/` and it runs in Claude Code's webview within 2 seconds, no reload needed
- **Control server** on port 57837 — HTTP API for terminal control, clipboard, editor, speech

---

## Install

```powershell
# Install the extension
code --install-extension "path\to\Claude Codex Black"

# Patch Claude Code's webview (required once, re-run after Claude Code updates)
node "path\to\Claude Codex Black\patch-webview.js"

# Then: Ctrl+Shift+P → Developer: Reload Window
```

Or launch as dev extension (no install, live from folder):
```powershell
code --extensionDevelopmentPath="path\to\Claude Codex Black"
```

---

## Requirements

- **ffmpeg** — for voice recording. Install via [Chocolatey](https://chocolatey.org/): `choco install ffmpeg`, [Scoop](https://scoop.sh/): `scoop install ffmpeg`, or any method that puts it in PATH.
- VSCode 1.85+
- Claude Code extension installed

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `codexBlackEd.language` | `en-US` | Speech language (BCP-47) |
| `codexBlackEd.autoSend` | `false` | Auto-submit after transcription (off by default — edit before sending) |

---

## Ports

| Port | Purpose |
|---|---|
| 57836 | Log server — receives console messages from webview |
| 57837 | Control server — HTTP API for all extension features |

---

## Inject System

Drop any `.js` or `.css` file in the `injects/` folder. It will be picked up and executed in Claude Code's chat webview within 2 seconds. No reload, no reinstall.

Log output: `~/codex-black-errors.log`
