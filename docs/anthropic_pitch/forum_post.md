# 15 swappable skins for Claude Code (MIT)

Built a skin pack for Claude Code as part of a side extension I've been working on (Claude Codex Black Edition). Shipping the skin layer on its own here because it's the bit most people will care about.

## The skins

- **claude-default** — pure white panel, soft borders, coral send button. Mirrors stock Claude Code.
- **codex-black** — the project's namesake; deep black with accent highlights.
- **arch** — dark with Arch cyan; the "btw" skin.
- **terminal** — green-on-black, monospaced everywhere.
- **ubuntu** — aubergine purple with orange accents.
- **redhat** — fedora red, slab serifs.
- **office** — Word-blue chrome, ribbon-era nostalgia.
- **gnome** — flat grey, Adwaita feel.
- **kde** — Breeze blue, more polished gradients.
- **xfce** — neutral mouse-grey, lightweight.
- **mint-dock** — Linux Mint green with a docked toolbar.
- **macos-color-dock** — translucent dock, traffic-light buttons.
- **aqua-dock** — early-OSX aqua gels.
- **glassy** — frosted-glass blur over an accent color.
- **tamagotchi** — pastel pixel-art, just because.

## The claude-default skin

Worth calling out on its own. It exists so first-time installs don't lose the Anthropic visual identity — pure white, soft borders, coral up-arrow send, same proportions. If you install the pack and don't pick a skin, this is what you get. The other 14 are opt-in personality.

## Dynamic-discovery contract (for forking your own)

Zero hardcoded skin list. To add one:

1. Drop a folder named `<your-id>.skin/` into `skins/`.
2. Put a `manifest.xml`, `index.html` (full HTML per skin), `styles.css`, and an `icons/` subdir inside.
3. Restart the panel. Done.

The runtime scans `skins/` in two passes — legacy `<id>/` then new `<id>.skin/` — and the new form wins on conflicts. No code change, no rebuild.

## One invariant worth stealing

Every skin's `index.html` was rendered offscreen at **600px wide** during the polish pass. That's the panel-narrow break point and it surfaces things normal-width testing hides. The pass caught 12 bugs across clipping, invisible placeholders, and unreadable Stop labels. If you fork a skin, render it at 600px before you ship it.

The textarea auto-grows as you type across all 15 — the one Anthropic behavior nobody should mess with.

MIT licensed, repo + marketplace listing in the comments. Take what you want.
