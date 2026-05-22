#!/usr/bin/env python3
"""Apply user-preferred send-button styling globally: smaller + 80% opacity.

User said it twice this session (2026-05-22):
  "the send button is too big and should be like 80% opacity"
  "button should be smaller and 80% opacity"
on different skins → it's a global preference, not a per-skin tweak.

For every skins/*/styles.css that overrides `.send-button { width: ... }`:
  • width:<N>px / height:<N>px → 38px
  • add `opacity: 0.8 !important;` to the base block (if not present)
  • add `opacity: 1 !important;` to `.send-button:hover / .is-hover` blocks
Idempotent. Run: python tools/fix_send_button_size.py
"""
import re, sys
from pathlib import Path

SKINS = Path(__file__).resolve().parent.parent / "skins"
TARGET_SIZE = "38px"

def patch_size(text):
    """Replace any width/height numeric in the .send-button {} base block to 38px."""
    def repl(m):
        block = m.group(0)
        block2 = re.sub(r'(width|height)\s*:\s*\d+px\s*!important;',
                        lambda mm: f'{mm.group(1)}: {TARGET_SIZE} !important;', block)
        if 'opacity:' not in block2:
            # insert opacity:0.8 right after the opening '{'
            block2 = re.sub(r'\{\s*\n', '{\n  opacity: 0.8 !important;\n', block2, count=1)
        return block2
    # `.send-button {` block — match only when not preceded by `:` (i.e., not :hover/:active)
    # Use a simple regex catching the FIRST `.send-button {` immediately followed by props
    return re.sub(r'(?<![:.\w])\.send-button\s*\{[^}]*\}', repl, text, count=1)

def patch_hover(text):
    """Add opacity:1 to .send-button:hover / .send-button.is-hover blocks."""
    def repl(m):
        block = m.group(0)
        if 'opacity:' in block:
            return block
        return re.sub(r'\{\s*\n', '{\n  opacity: 1 !important;\n', block, count=1)
    pattern = r'\.send-button(?::hover|\.is-hover)[^{]*\{[^}]*\}'
    return re.sub(pattern, repl, text)

def main():
    files = sorted(SKINS.glob("*/styles.css"))
    if not files:
        print("No skin CSS found at", SKINS); sys.exit(1)
    changed, skipped = 0, 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        if '.send-button' not in text:
            skipped += 1
            continue
        new = patch_hover(patch_size(text))
        if new != text:
            f.write_text(new, encoding="utf-8")
            changed += 1
            print("  patched", f.relative_to(SKINS.parent))
        else:
            skipped += 1
    print(f"\nUpdated {changed} skin(s); {skipped} unchanged/no-send-button.")

if __name__ == "__main__":
    main()
