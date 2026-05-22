#!/usr/bin/env python3
"""Find images that ship in the .vsix but have ZERO code references.

For every image inside dist/codex-black-ed-1.5.3.vsix:
  - search every source text file (js/html/css/py/json/md/xml) for the full
    filename (e.g. `settings.svg`) — direct/static reference.
  - if the full name doesn't match, fall back to the stem (e.g. `settings`)
    so template-string references like `${name}.svg` are still caught.
  - files with zero matches → ORPHAN (safe to delete).
  - files matching only by stem → REVIEW (probably referenced via template).
  - files matching by full name → KEEP.

Run: python tools/find_orphan_images.py
"""
import re, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VSIX = sorted((ROOT / "dist").glob("*.vsix"))
if not VSIX:
    sys.exit("no .vsix in dist/")
VSIX = VSIX[-1]  # most recent

IMG_EXTS = {".png", ".svg", ".jpg", ".jpeg", ".gif", ".ico", ".webp"}
SRC_EXTS = {".js", ".html", ".css", ".py", ".json", ".md", ".xml", ".yaml", ".yml"}
SKIP_DIRS = {".git", "node_modules", "dist", "data", "logs", "chats", "reports",
             "__pycache__", "bridges", ".claude", ".vscode-test"}

# 1) Collect every image SHIPPED in the .vsix.
shipped = {}  # basename -> archive path
with zipfile.ZipFile(VSIX) as z:
    for info in z.infolist():
        p = Path(info.filename)
        if p.suffix.lower() in IMG_EXTS:
            shipped[p.name] = (info.filename, info.file_size)

# 2) Concatenate all source text into one corpus. Fast and avoids per-file
#    grep overhead at this project size.
corpus_parts = []
for sf in ROOT.rglob("*"):
    if not sf.is_file() or sf.suffix.lower() not in SRC_EXTS:
        continue
    if any(skip in sf.parts for skip in SKIP_DIRS):
        continue
    try:
        corpus_parts.append(sf.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        pass
corpus = "\n".join(corpus_parts)

# 3) Classify.
referenced, by_stem, orphans = [], [], []
for base, (path, size) in sorted(shipped.items()):
    if base in corpus:
        referenced.append((base, path, size))
        continue
    stem = Path(base).stem
    if len(stem) >= 3 and re.search(r"\b" + re.escape(stem) + r"\b", corpus):
        by_stem.append((base, path, size))
    else:
        orphans.append((base, path, size))

print(f"Audited {VSIX.name}")
print(f"  Total images shipped:  {len(shipped)}")
print(f"  Referenced by name:    {len(referenced)}")
print(f"  Referenced by stem:    {len(by_stem)}   (template-string suspects)")
print(f"  ORPHAN (zero refs):    {len(orphans)}")
print()
orphan_bytes = sum(s for _, _, s in orphans)
print(f"  Orphan total size:     {orphan_bytes/1024:.0f} KB")
print()
if orphans:
    print("=== ORPHANS — safe to delete from source tree + .vscodeignore ===")
    for base, path, size in sorted(orphans, key=lambda r: -r[2]):
        print(f"  {size/1024:>7.1f} KB   {path}")
    print()
if by_stem:
    print("=== STEM-ONLY (review — may be template-referenced) ===")
    for base, path, size in sorted(by_stem, key=lambda r: -r[2])[:20]:
        print(f"  {size/1024:>7.1f} KB   {path}")
