#!/usr/bin/env python3
"""Resize oversized PNG assets to sensible caps, preserving alpha + quality.

The toolbar `*.color.png` icons were shipping at 1024x1024 but the UI shows
them at ~38 px (per skin/glassy.css `.tool-button img { width: 20px }`).
That's a ~25x linear overshoot → ~625x pixel-count overshoot → most of the
60 MB VSIX size. This script Lanczos-downsamples each PNG to its display
ceiling and re-saves with PIL's max compression.

Per-bucket caps (max dim, in pixels) — chosen so HiDPI 2x display still
samples from a source bigger than display:

  *_bg / skin_*_bg / *background* → 1024  (panel backgrounds)
  label*                          →  720  (label pill is 360 px wide in UI)
  *.color.png                     →  128  (toolbar/send icons, 38 px UI)
  models/*.png                    →  256  (model-picker thumbnails)
  everything else                 →  256  (safe default)

Idempotent: files at or below their cap are skipped. Reports before/after.
Run: python tools/shrink_png_assets.py            # actually resize
     python tools/shrink_png_assets.py --dry-run  # report only
"""
import sys
from pathlib import Path
from PIL import Image

ROOT   = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
DRY    = "--dry-run" in sys.argv


def cap_for(rel_path: str) -> int:
    s = rel_path.lower()
    if "_bg" in s or "background" in s:
        return 1024
    if "/labels/" in s or s.startswith("labels/") or "label-" in s:
        return 720
    if "/models/" in s:
        return 256
    if s.endswith(".color.png"):
        return 128
    return 256


def main():
    if not ASSETS.exists():
        sys.exit(f"no {ASSETS}")
    pngs = sorted(ASSETS.rglob("*.png"))
    before_total = 0
    after_total  = 0
    shrunk = 0
    skipped = 0
    for p in pngs:
        rel = p.relative_to(ROOT).as_posix()
        try:
            with Image.open(p) as im:
                im.load()
                w, h = im.size
                mode = im.mode
                src_bytes = p.stat().st_size
                before_total += src_bytes
                cap = cap_for(rel)
                if max(w, h) <= cap:
                    after_total += src_bytes
                    skipped += 1
                    continue
                # Lanczos resize preserving aspect ratio + alpha
                scale = cap / max(w, h)
                nw = max(1, round(w * scale))
                nh = max(1, round(h * scale))
                if DRY:
                    print(f"  WOULD shrink  {w}x{h} -> {nw}x{nh}  {src_bytes//1024} KB  {rel}")
                    shrunk += 1
                    after_total += src_bytes
                    continue
                out = im.resize((nw, nh), Image.Resampling.LANCZOS)
                # Keep RGBA if source had alpha; else convert sensibly
                if mode in ("RGBA", "LA") and "A" in out.getbands():
                    pass
                elif mode == "P" and "transparency" in im.info:
                    out = out.convert("RGBA")
                out.save(p, format="PNG", optimize=True, compress_level=9)
            new_bytes = p.stat().st_size
            after_total += new_bytes
            shrunk += 1
            saved_kb = (src_bytes - new_bytes) // 1024
            print(f"  shrunk {w}x{h} -> {nw}x{nh}   {src_bytes//1024:>5} -> {new_bytes//1024:<5} KB  (-{saved_kb} KB)  {rel}")
        except Exception as e:
            print(f"  SKIP {rel}: {e}")
            after_total += p.stat().st_size

    print()
    print(f"== shrunk {shrunk} / skipped {skipped} / {len(pngs)} PNGs ==")
    print(f"== before: {before_total/1024/1024:7.2f} MB ==")
    print(f"== after : {after_total/1024/1024:7.2f} MB ==")
    print(f"== saved : {(before_total - after_total)/1024/1024:7.2f} MB ==")
    if DRY:
        print("(dry run — no files modified)")


if __name__ == "__main__":
    main()
