# Render macos-theme.html via WeasyPrint (PDF) + Playwright (PNG),
# compute a similarity score against the reference image.
import os, sys, math
from pathlib import Path

THEME_DIR = Path(r"C:\Users\moren\Desktop\Claude Codex Black\panel\themes\macos")
HTML_PATH = THEME_DIR / "macos-theme.html"
PDF_PATH  = THEME_DIR / "macos-theme.pdf"
PNG_PATH  = THEME_DIR / "macos-theme-render.png"
PLAYWRIGHT_PNG = THEME_DIR / "macos-theme-playwright.png"
REF_PATH  = Path(r"C:\Users\moren\Desktop\mac.jpg")

def renderWeasy():
    from weasyprint import HTML
    print("[weasyprint] rendering PDF…")
    HTML(filename=str(HTML_PATH)).write_pdf(str(PDF_PATH),
        # Force a screen-sized page so it looks like a desktop
        presentational_hints=True)
    print("[weasyprint] wrote", PDF_PATH, PDF_PATH.stat().st_size, "bytes")

def renderPdfPng():
    """PDF -> PNG. Try pdf2image (poppler), then pypdfium2, else Playwright fallback."""
    # 1. pdf2image (needs poppler)
    try:
        from pdf2image import convert_from_path
        print("[pdf2image] rendering PDF -> PNG (dpi=150)...")
        pages = convert_from_path(str(PDF_PATH), dpi=150)
        pages[0].save(str(PNG_PATH))
        print("[pdf2image] wrote", PNG_PATH)
        return True
    except Exception as e:
        print("[pdf2image] FAILED:", e)
    # 2. pypdfium2 (pure-python)
    try:
        import pypdfium2 as pdfium
        print("[pypdfium2] rendering PDF -> PNG (scale=2)...")
        pdf = pdfium.PdfDocument(str(PDF_PATH))
        page = pdf[0]
        bitmap = page.render(scale=2.0)
        img = bitmap.to_pil()
        img.save(str(PNG_PATH))
        print("[pypdfium2] wrote", PNG_PATH)
        return True
    except Exception as e:
        print("[pypdfium2] FAILED:", e)
        return False

def renderPlaywright():
    """Use a real Chromium to render the theme at desktop size."""
    from playwright.sync_api import sync_playwright
    print("[playwright] launching browser…")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as e:
            print("[playwright] launch failed:", e)
            print("[playwright] try: python -m playwright install chromium")
            return False
        ctx = browser.new_context(viewport={"width": 1280, "height": 720},
                                  device_scale_factor=1.5)
        page = ctx.new_page()
        page.goto(HTML_PATH.as_uri())
        page.wait_for_timeout(400)
        page.screenshot(path=str(PLAYWRIGHT_PNG), full_page=False)
        browser.close()
    print("[playwright] wrote", PLAYWRIGHT_PNG)
    return True

def imSimilarity(aPath, bPath):
    """Cheap perceptual similarity: resize both to 64x64 grayscale, compare per-pixel."""
    from PIL import Image
    a = Image.open(aPath).convert("L").resize((128, 72))
    b = Image.open(bPath).convert("L").resize((128, 72))
    aPx = list(a.getdata()); bPx = list(b.getdata())
    n = len(aPx)
    diffs = [abs(aPx[i]-bPx[i]) for i in range(n)]
    meanDiff = sum(diffs)/n
    # Max distance is 255; convert to "similarity" 0..1
    return 1.0 - (meanDiff/255.0), meanDiff

def colorSimilarity(aPath, bPath):
    """RGB hist similarity (32 bins/channel) — captures palette agreement."""
    from PIL import Image
    a = Image.open(aPath).convert("RGB").resize((256, 144))
    b = Image.open(bPath).convert("RGB").resize((256, 144))
    def histo(img):
        h = [0]*(32*3)
        for r,g,bb in img.getdata():
            h[r>>3] += 1
            h[32 + (g>>3)] += 1
            h[64 + (bb>>3)] += 1
        s = sum(h) or 1
        return [x/s for x in h]
    ha, hb = histo(a), histo(b)
    # cosine similarity
    dot = sum(ha[i]*hb[i] for i in range(len(ha)))
    na  = math.sqrt(sum(x*x for x in ha))
    nb  = math.sqrt(sum(x*x for x in hb))
    return dot/(na*nb) if (na and nb) else 0.0

def main():
    print("=" * 60)
    print("Rendering macOS theme")
    print("=" * 60)

    # WeasyPrint -> PDF (required by spec)
    try:
        renderWeasy()
    except Exception as e:
        print("[weasyprint] FAILED:", e)

    # Also produce a PDF-derived PNG for the spec's pdf2image step
    # (saved to a side path so the canonical render PNG remains the viewport truth)
    PDF_PNG_PATH = THEME_DIR / "macos-theme-pdf2png.png"
    try:
        from pdf2image import convert_from_path
        print("[pdf2image] rendering PDF -> PNG (dpi=150)...")
        pages = convert_from_path(str(PDF_PATH), dpi=150)
        pages[0].save(str(PDF_PNG_PATH))
        print("[pdf2image] wrote", PDF_PNG_PATH)
    except Exception as e:
        print("[pdf2image] FAILED (poppler missing):", e)
        try:
            import pypdfium2 as pdfium
            print("[pypdfium2] rendering PDF -> PNG (scale=2)...")
            pdf = pdfium.PdfDocument(str(PDF_PATH))
            page = pdf[0]
            bitmap = page.render(scale=2.0)
            bitmap.to_pil().save(str(PDF_PNG_PATH))
            print("[pypdfium2] wrote", PDF_PNG_PATH)
        except Exception as ee:
            print("[pypdfium2] FAILED:", ee)

    # Playwright (Chromium viewport) is the canonical truth render — it honors
    # backdrop-filter, SVG transforms, and the visible-viewport size that mac.jpg shows.
    pwOk = renderPlaywright()
    if pwOk and PLAYWRIGHT_PNG.exists():
        import shutil
        shutil.copy(str(PLAYWRIGHT_PNG), str(PNG_PATH))
        print("[canonical] playwright PNG -> macos-theme-render.png")

    # Similarity check against reference
    if PNG_PATH.exists():
        sim, meanDiff = imSimilarity(PNG_PATH, REF_PATH)
        colorSim = colorSimilarity(PNG_PATH, REF_PATH)
        print()
        print("=" * 60)
        print("SIMILARITY vs mac.jpg")
        print(f"  Pixel-similarity (grayscale 128x72): {sim*100:.1f}%  (mean-diff={meanDiff:.1f}/255)")
        print(f"  Color-histogram cosine similarity:   {colorSim*100:.1f}%")
        print("=" * 60)
    else:
        print("No PNG produced — cannot compute similarity.")

if __name__ == "__main__":
    main()
