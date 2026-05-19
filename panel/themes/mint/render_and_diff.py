"""
Render mint-theme.html -> PDF (WeasyPrint) -> PNG (ImageMagick),
plus a direct Playwright PNG render at the reference image's
exact dimensions, then diff against C:\\Users\\moren\\Desktop\\img.webp.

Requires:
    pip install weasyprint pdf2image Pillow numpy playwright
    playwright install chromium
    (ImageMagick "magick" on PATH for PDF->PNG fallback)
"""
import os, sys, subprocess
from pathlib import Path
from PIL import Image
import numpy as np

HERE = Path(r"C:\Users\moren\Desktop\Claude Codex Black\panel\themes\mint")
HTML_PATH = HERE / "mint-theme.html"
PDF  = HERE / "mint-theme.pdf"
PNG  = HERE / "mint-theme-render.png"
REF  = Path(r"C:\Users\moren\Desktop\img.webp")
DIFF = HERE / "mint-theme-diff.png"

# Reference image dimensions
ref = Image.open(REF).convert("RGB")
RW, RH = ref.size
print(f"[ref] {REF} = {RW}x{RH}")

# ───────────────── 1. PDF via WeasyPrint ─────────────────
print("[1/4] WeasyPrint HTML -> PDF")
from weasyprint import HTML, CSS
# Force the page size to match the reference aspect so the PDF render
# isn't letterboxed in default A4.
pt_per_px = 0.75  # 96dpi CSS px -> pt
page_w_pt = RW * pt_per_px
page_h_pt = RH * pt_per_px
page_css = CSS(string=f"@page {{ size: {page_w_pt}pt {page_h_pt}pt; margin: 0; }}")
HTML(filename=str(HTML_PATH)).write_pdf(str(PDF), stylesheets=[page_css])
print(f"      -> {PDF}")

# ───────────────── 2. PNG via Playwright (preferred — sharper) ────
print("[2/4] Playwright HTML -> PNG @ ref size")
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": RW, "height": RH},
                                  device_scale_factor=1)
        page = ctx.new_page()
        page.goto(HTML_PATH.as_uri())
        page.wait_for_load_state("networkidle")
        page.screenshot(path=str(PNG), full_page=False)
        browser.close()
    print(f"      -> {PNG} (Playwright)")
except Exception as e:
    print(f"      Playwright failed ({e}); falling back to ImageMagick from PDF")
    # ImageMagick PDF->PNG fallback
    cmd = ["magick", "-density", "150", str(PDF), "-resize",
           f"{RW}x{RH}!", str(PNG)]
    subprocess.run(cmd, check=True)
    print(f"      -> {PNG} (ImageMagick)")

# ───────────────── 3. Load + normalize sizes ─────────────────
print("[3/4] Load render + ref")
rendered = Image.open(PNG).convert("RGB")
if rendered.size != ref.size:
    rendered = rendered.resize(ref.size, Image.LANCZOS)
print(f"      ref={ref.size}  render={rendered.size}")

# ───────────────── 4. Compute simple similarity ──────────────
print("[4/4] Compute similarity")
a = np.asarray(ref, dtype=np.float32) / 255.0
b = np.asarray(rendered, dtype=np.float32) / 255.0

# Per-channel diff
diff = np.abs(a - b)
mean_err = float(diff.mean())
similarity = 1.0 - mean_err  # 1.0 = identical
print(f"      mean abs pixel diff: {mean_err:.4f}")
print(f"      visual similarity:   {similarity*100:.1f}%")

# Save a side-by-side diff visualization
diff_u8 = (diff * 255).clip(0, 255).astype(np.uint8)
Image.fromarray(diff_u8).save(DIFF)
print(f"      diff -> {DIFF}")

# Region-wise mean color diff (top-left / center / bottom-strip)
def region_mean(img, y0, y1, x0, x1):
    return np.asarray(img.crop((x0, y0, x1, y1)), dtype=np.float32).mean(axis=(0, 1)) / 255.0

regions = {
    "top-strip":   (0,            int(RH*0.12), 0, RW),
    "center":      (int(RH*0.30), int(RH*0.70), int(RW*0.30), int(RW*0.70)),
    "bottom-dock": (int(RH*0.85), RH,           int(RW*0.20), int(RW*0.80)),
    "wallpaper":   (int(RH*0.20), int(RH*0.80), 0, int(RW*0.20)),
}
print("\nRegion-wise color (R,G,B) — ref vs render:")
for name, (y0,y1,x0,x1) in regions.items():
    rmean = region_mean(ref, y0, y1, x0, x1)
    smean = region_mean(rendered, y0, y1, x0, x1)
    delta = np.abs(rmean - smean).mean()
    print(f"  {name:12s} ref={rmean.round(2).tolist()}  render={smean.round(2).tolist()}  d={delta:.3f}")

print(f"\nDONE.  Open the render:  {PNG}")
print(f"Open the HTML live in browser:  {HTML_PATH}")
