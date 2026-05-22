#!/usr/bin/env python3
"""Add target="_blank" rel="noopener" to mailto:/http(s) links in panel/help*.html.

Why: the Help modal is an <iframe srcdoc sandbox="allow-popups …">. External /
mailto links with no target navigate the IFRAME itself to the URL, which in the
webview blanks the srcdoc content (user 2026-05-22: "clicking the email link at
the bottom of help black screens it"). target="_blank" + the allow-popups
sandbox opens them outside the iframe instead. #anchor links are left alone —
the <base href="about:srcdoc"> tag already keeps those same-document.

Idempotent (skips tags that already have target=). Run:
  python tools/fix_help_external_links.py
"""
import re, sys
from pathlib import Path

PANEL = Path(__file__).resolve().parent.parent / "panel"
EXT_HREF = re.compile(r'href="(?:mailto:|https?:)', re.IGNORECASE)

def fix_tag(m):
    tag = m.group(0)
    if "target=" in tag.lower():
        return tag                      # already targeted — leave it
    if EXT_HREF.search(tag):
        return "<a target=\"_blank\" rel=\"noopener\"" + tag[2:]
    return tag                          # #anchor or other — unchanged

def main():
    files = sorted(PANEL.glob("help*.html"))
    if not files:
        print("No help*.html found at", PANEL); sys.exit(1)
    total = 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        new = re.sub(r"<a\b[^>]*>", fix_tag, text)
        if new != text:
            n = new.count('target="_blank"') - text.count('target="_blank"')
            total += n
            f.write_text(new, encoding="utf-8")
    # verify: no remaining external link without target across all files
    bad = []
    for f in files:
        for m in re.finditer(r"<a\b[^>]*>", f.read_text(encoding="utf-8")):
            t = m.group(0)
            if EXT_HREF.search(t) and "target=" not in t.lower():
                bad.append(f.name)
                break
    print("Added target=_blank to %d external/mailto link(s) across %d files." % (total, len(files)))
    if bad:
        print("STILL UNFIXED:", bad); sys.exit(2)
    print("All external/mailto links in help files now open in a new context.")

if __name__ == "__main__":
    main()
