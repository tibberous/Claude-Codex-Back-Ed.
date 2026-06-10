# Codex Black

Standalone VS Code extension that opens its own webview panel and displays the Codex Black label.

This extension is fully self-contained. It does not modify, hook, or depend on any other VS Code extension at runtime.

**Copyright 2026 Trenton Tompkins — trentontompkins.com**

## Install

```
code --install-extension codex-black-ed-1.0.0.vsix
```

## Use

Run the command **Codex Black: Open Panel** from the command palette, or press `Ctrl+Shift+B` (`Cmd+Shift+B` on macOS).

A panel titled **Codex Black** opens in a side column and renders `assets/label-alpha.png`.

## Build

```
npm install
npx vsce package
```
