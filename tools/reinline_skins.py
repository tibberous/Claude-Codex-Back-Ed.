"""Re-inline every skin's styles.css into its index.html's
<style data-cbe-skin="..."> block.

The new-format skins (per migration cac84f0) carry the skin CSS twice:
 - styles.css           — the editable source-of-truth
 - index.html <style …> — what the runtime actually paints

When styles.css changes (manual edits or polish-agent runs), the inline
block in index.html stays stale and the panel renders the old CSS. This
script syncs them in one pass.

Idempotent — safe to re-run any time. Skips skins whose index.html does
not contain a data-cbe-skin block (legacy skins that don't need this).
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKINS_DIR = REPO_ROOT / "skins"
PAT = re.compile(
    r'<style data-cbe-skin="([^"]+)">.*?</style>',
    re.DOTALL,
)


def main() -> int:
    total = synced = skipped = errored = 0
    for sd in sorted(SKINS_DIR.iterdir()):
        if not (sd.is_dir() and sd.name.endswith(".skin")): continue
        idx = sd / "index.html"
        css = sd / "styles.css"
        if not idx.is_file() or not css.is_file():
            print(f"[reinline] skip {sd.name} (missing files)")
            skipped += 1
            continue
        total += 1
        html = idx.read_text(encoding="utf-8")
        css_text = css.read_text(encoding="utf-8")
        m = PAT.search(html)
        if not m:
            print(f"[reinline] skip {sd.name} (no <style data-cbe-skin> block)")
            skipped += 1
            continue
        skin_id = m.group(1)
        new_block = f'<style data-cbe-skin="{skin_id}">\n{css_text}\n</style>'
        new_html, n = PAT.subn(new_block, html, count=1)
        if n != 1:
            print(f"[reinline] WARN {sd.name}: expected 1 replacement, did {n}")
            errored += 1
            continue
        if new_html == html:
            print(f"[reinline] OK   {sd.name:32s} (already in sync, {len(css_text)} chars)")
        else:
            idx.write_text(new_html, encoding="utf-8")
            print(f"[reinline] SYNC {sd.name:32s} ({len(css_text)} chars)")
        synced += 1

    print(f"\n[reinline] synced={synced} skipped={skipped} errored={errored} (of {total} new-format skins)")
    return 0 if errored == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
