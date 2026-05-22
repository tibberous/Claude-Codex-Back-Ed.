#!/usr/bin/env python3
"""Add <base href="about:srcdoc"> to every panel/help*.html.

Why: the Help modal renders help.<lang>.html in an <iframe srcdoc>. A srcdoc
document inherits the PARENT's URL as its base, so the TOC's `<a href="#quick">`
links resolve to `vscode-webview://…#quick` — a *different* document — and
clicking one navigates the iframe away from the srcdoc content to a blank page
(user 2026-05-22: "clicking the left links on the help black screens"). The
in-page JS interceptor that would preventDefault is blocked by the webview's
strict CSP (no inline-script), so it never runs.

Setting the base to about:srcdoc (the srcdoc document's own URL) makes every
`#fragment` link same-document → it scrolls instead of reloading, with zero
JS/CSP dependency. Idempotent. Run: python tools/fix_help_base_href.py
"""
import re, sys
from pathlib import Path

PANEL = Path(__file__).resolve().parent.parent / "panel"
BASE_TAG = '<base href="about:srcdoc">'

def main():
    files = sorted(PANEL.glob("help*.html"))
    if not files:
        print("No help*.html found at", PANEL); sys.exit(1)
    done, skipped, problems = 0, 0, []
    for f in files:
        text = f.read_text(encoding="utf-8")
        if "<base " in text:
            skipped += 1
            continue
        # insert right after the opening <head> (case-insensitive)
        m = re.search(r"<head\s*>", text, re.IGNORECASE)
        if not m:
            problems.append(f.name + " (no <head>)")
            continue
        i = m.end()
        text = text[:i] + "\n" + BASE_TAG + text[i:]
        f.write_text(text, encoding="utf-8")
        done += 1
    # verify
    bad = [f.name for f in files if "<base " not in f.read_text(encoding="utf-8")]
    print("Added base to %d file(s); %d already had it." % (done, skipped))
    if problems:
        print("PROBLEMS:", problems)
    if bad:
        print("STILL MISSING base:", bad); sys.exit(2)
    print("All %d help files now have <base href=\"about:srcdoc\">." % len(files))

if __name__ == "__main__":
    main()
