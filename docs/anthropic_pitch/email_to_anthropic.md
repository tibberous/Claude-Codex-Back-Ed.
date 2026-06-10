**Subject:** 15 community skins for Claude Code — MIT, drop-in compatible

Hi Claude Code team,

I've been using Claude Code daily and built a VSCode wrapper called Codex Black Ed. Inside it is a skin pack — 15 swappable themes for the Claude Code panel — and I wanted to put it in front of you in case any of it is useful upstream.

A few details that might matter:

- Skins are fully self-contained `<id>.skin/` folders (manifest.xml, index.html, styles.css, icons/). Dynamic discovery scans the directory at runtime — zero hardcoded list, no rebuild to add one.
- Every skin was rendered offscreen at 600px wide (panel-narrow) during the polish pass. That one invariant caught 12 layout bugs — narrow-width clipping, invisible placeholders, unreadable Stop labels.
- One of the 15 is `claude-default`: pure white panel, soft borders, coral up-arrow send. It mirrors the stock Claude Code look and is the recommended shipping default so first-time installs keep the Anthropic visual identity. The other 14 are stylized OS callbacks (Arch, Ubuntu, Redhat, Office, etc.) plus a couple of personality skins.
- The textarea auto-grows as you type, preserving the behavior from the upstream input that I think works really well.

All of it is MIT. If any individual skin (or the discovery contract itself) is something you'd want to pull into the official extension, take it — no attribution required, no strings. Equally happy to keep it as a community thing.

Screenshots attached. Repo and marketplace listing are public if it's easier to browse there — happy to send links on request.
