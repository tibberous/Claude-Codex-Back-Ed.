"""stack_promptrow.py — update the v2 prompt-row block (propagate_promptrow.py
output) in every skins/<id>.html so the brand label + project-folder STACK
vertically (folder directly UNDER the label) instead of sitting side-by-side
(Trent 2026-06-02: "the project-folder indicator must ALWAYS sit directly under
the label").

This is the SKIN-side base layout. panel.js's shared `#cbe-promptrow-shared`
sheet (higher specificity, body[data-cbe-label-pos="left|center|right"]) still
anchors the whole stacked column to one of the 3 allowed spots at runtime — this
just makes the base column correct so there is no row→column flash before
panel.js runs, and so the folder is never hidden on narrow panels.

Two replacements per skin:
  1. the `.prompt-meta-row { ... }` rule  → flex-direction:column (centered base)
  2. the `@media (max-width:620px){ #project-path { display:none } }` folder-hide
     → KEEP the folder visible (it must always sit under the label).

CRLF-aware + idempotent (skips files already carrying the column marker).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKINS = ROOT / "skins"

OLD_ROW = """.prompt-meta-row {
  flex: 1 1 100% !important;
  width: 100% !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 10px !important;
}"""

NEW_ROW = """.prompt-meta-row {
  /* STACKED column (Trent 2026-06-02): brand label on top, project-folder
     directly UNDER it — never side-by-side. panel.js's #cbe-promptrow-shared
     sheet re-anchors this whole column to one of the 3 allowed spots
     (left / center / right) via body[data-cbe-label-pos]; centered is the
     base default below. */
  flex: 1 1 100% !important;
  width: 100% !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 3px !important;
  margin-top: 10px !important;
}"""

OLD_MEDIA = """@media (max-width: 620px) {
  .toolbar-meta--inline #project-path { display: none !important; }"""

NEW_MEDIA = """@media (max-width: 620px) {
  /* Folder stays UNDER the label even on narrow panels (Trent 2026-06-02 —
     it must ALWAYS sit directly under the label). Keep it visible; the
     stacked column already keeps the row height tiny. */
  .toolbar-meta--inline #project-path,
  .prompt-meta-row #project-path { display: flex !important; }"""

SKINS_ALL = sorted(p.stem for p in SKINS.glob("*.html"))

for name in SKINS_ALL:
    p = SKINS / f"{name}.html"
    raw = p.read_bytes()
    use_crlf = raw.count(b"\r\n") > raw.count(b"\n") - raw.count(b"\r\n")
    html = raw.decode("utf-8").replace("\r\n", "\n")
    notes = []
    if "STACKED column (Trent 2026-06-02)" in html:
        print(f"{name:20s} -> already stacked"); continue
    if OLD_ROW in html:
        html = html.replace(OLD_ROW, NEW_ROW, 1); notes.append("row")
    else:
        notes.append("ROW-MISS")
    if OLD_MEDIA in html:
        html = html.replace(OLD_MEDIA, NEW_MEDIA, 1); notes.append("media")
    else:
        notes.append("MEDIA-MISS")
    if use_crlf:
        html = html.replace("\n", "\r\n")
    p.write_bytes(html.encode("utf-8"))
    print(f"{name:20s} -> {' '.join(notes)}")
