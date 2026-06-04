#!/usr/bin/env python
"""fix_promptrow_overlap.py — 2026-06-03 prompt-row overlap fix, all skins.

Two surgical replacements in every skins/*.html (idempotent):

  1) Stop button position: `right: 56px; bottom: 11px;`  ->  `right: 96px ...`
     The base CSS renders SEND as the literal word "SEND" (#sendBtn::after,
     ~70px wide at right:14px → spans to ~right:84px). The old right:56px
     parked Stop INSIDE the SEND glyph so they collided (the screenshot bug).
     96px clears the widest SEND with an 8px gap; on the few skins that
     restyle SEND to a compact 44-48px round chip it just sits slightly
     further left — still bottom-right, no overlap.

  2) .prompt-meta-row layout: stacked column -> single horizontal row, so the
     brand label + project-folder share ONE row side-by-side
     (Trent 2026-06-03 — supersedes the 2026-06-02 stacked-column layout).

tamagotchi.html is already hand-fixed; the script is idempotent so re-running
it on tamagotchi is a no-op (the OLD strings are gone).
"""
from __future__ import annotations
from pathlib import Path

SKINS = Path(__file__).resolve().parent.parent / "skins"

# ── replacement 1: Stop position ─────────────────────────────────────────────
STOP_OLD = "  right: 56px; bottom: 11px;\n"
STOP_NEW = (
    "  /* Overlap fix (Trent 2026-06-03): SEND renders as the literal word\n"
    "     \"SEND\" (#sendBtn::after, width:auto+min-width:56px → ~70px wide at\n"
    "     right:14px, spanning out to ~right:84px). The old right:56px parked\n"
    "     Stop INSIDE the SEND glyph and the two collided. Anchor Stop at\n"
    "     right:96px so its right edge clears the SEND text with an 8px gap. */\n"
    "  right: 96px !important; bottom: 11px !important;\n"
)

# ── replacement 2: meta-row column -> row ────────────────────────────────────
ROW_OLD = (
    ".prompt-meta-row {\n"
    "  /* STACKED column (Trent 2026-06-02): brand label on top, project-folder\n"
    "     directly UNDER it — never side-by-side. panel.js's #cbe-promptrow-shared\n"
    "     sheet re-anchors this whole column to one of the 3 allowed spots\n"
    "     (left / center / right) via body[data-cbe-label-pos]; centered is the\n"
    "     base default below. */\n"
    "  flex: 1 1 100% !important;\n"
    "  width: 100% !important;\n"
    "  display: flex !important;\n"
    "  flex-direction: column !important;\n"
    "  align-items: center !important;\n"
    "  justify-content: center !important;\n"
    "  gap: 3px !important;\n"
    "  margin-top: 10px !important;\n"
    "}"
)
ROW_NEW = (
    ".prompt-meta-row {\n"
    "  /* SAME-ROW layout (Trent 2026-06-03): brand label + project-folder share\n"
    "     ONE horizontal row, side-by-side — supersedes the 2026-06-02 stacked\n"
    "     column. panel.js's #cbe-promptrow-shared sheet re-anchors this whole\n"
    "     row to one of the 3 allowed spots (left / center / right) via\n"
    "     body[data-cbe-label-pos]; centered is the base default below.\n"
    "     flex-wrap lets the folder drop under the label only when the panel is\n"
    "     too narrow to fit both on one line (graceful degradation). */\n"
    "  flex: 1 1 100% !important;\n"
    "  width: 100% !important;\n"
    "  display: flex !important;\n"
    "  flex-direction: row !important;\n"
    "  flex-wrap: wrap !important;\n"
    "  align-items: center !important;\n"
    "  justify-content: center !important;\n"
    "  gap: 4px 10px !important;\n"
    "  margin-top: 10px !important;\n"
    "}"
)


def main() -> int:
    total = 0
    for f in sorted(SKINS.glob("*.html")):
        txt = f.read_text(encoding="utf-8")
        orig = txt
        changed = []
        if STOP_OLD in txt:
            txt = txt.replace(STOP_OLD, STOP_NEW, 1)
            changed.append("stop")
        if ROW_OLD in txt:
            txt = txt.replace(ROW_OLD, ROW_NEW, 1)
            changed.append("row")
        if txt != orig:
            f.write_text(txt, encoding="utf-8")
            total += 1
            print(f"  patched {f.name}: {', '.join(changed)}")
        else:
            print(f"  skipped {f.name} (already fixed / no match)")
    print(f"\nPatched {total} skin file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
