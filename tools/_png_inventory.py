#!/usr/bin/env python3
"""Quick inventory of every PNG in assets/ — dimensions + file size."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
rows = []
for p in (ROOT / "assets").rglob("*.png"):
    try:
        with Image.open(p) as im:
            w, h = im.size
    except Exception:
        continue
    rows.append((p.stat().st_size, w, h, p.relative_to(ROOT).as_posix()))

rows.sort(reverse=True)
print(f'{"KB":>7}  {"px":>11}  path')
print("-" * 80)
for sz, w, h, path in rows[:40]:
    print(f"{sz//1024:>7}  {w}x{h:<6}  {path}")
print()

# Categorize by likely "max display size needed"
def cap_for(path):
    s = path.lower()
    if "_bg" in s or "background" in s or "skin_" in s and "bg" in s:
        return 1024
    if "/models/" in s or s.endswith("models/"):
        return 256
    if ".color." in s:
        return 128         # toolbar icon color variants (UI shows them 20-40 px)
    if "/labels/" in s:
        return None        # label SVGs are pulled via {{ASSETS_BASE}}; cap higher
    return 256

oversized = []
for sz, w, h, path in rows:
    cap = cap_for(path)
    if cap is None:
        continue
    if max(w, h) > cap:
        oversized.append((sz, w, h, path, cap))

over_bytes = sum(r[0] for r in oversized)
print(f"== {len(rows)} PNGs, {sum(r[0] for r in rows)/1024/1024:.1f} MB total ==")
print(f"== {len(oversized)} files exceed their display cap, {over_bytes/1024/1024:.1f} MB ==")
print()
print("== TOP 15 OVERSIZED (current px -> cap px) ==")
for sz, w, h, path, cap in oversized[:15]:
    print(f"  {sz//1024:>6} KB  {w}x{h}  ->  cap {cap}  {path}")
