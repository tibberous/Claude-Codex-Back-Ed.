#!/usr/bin/env python3
"""Generate the marketplace README banner.

GPT image-gen models butcher short stacked text but excel at imagery, so this
is a two-stage pipeline:

  1. gpt-image-1 paints the BACKDROP only (no text in the prompt, so it can't
     misspell anything).
  2. Pillow overlays the brand wordmark "CLAUDE CODEX BLACK" + tagline in
     pixel-perfect bold type on the left third.

Output: resources/banner.png  (1280x320, what GitHub / VS Marketplace render
at full width on a listing page).

Cost: ONE gpt-image-1 call, high quality, 1536x1024 transparent-opt PNG.
       ~$0.17 (per CLAUDE.md: this is a one-off UI piece → high quality OK).

Run:   python tools/gen_banner.py            # generates new image
       python tools/gen_banner.py --reuse    # skip API call, re-overlay text
                                             #   on the cached backdrop
"""
import base64, configparser, io, json, sys, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT     = Path(__file__).resolve().parent.parent
CFG      = ROOT / "config.ini"
OUT_RAW  = ROOT / "resources" / "banner_backdrop.png"   # raw GPT output (cache)
OUT_FINAL= ROOT / "resources" / "banner.png"            # with text overlay
W, H     = 1280, 320

# ─── The GPT prompt (edit me — this is the whole "look" of the banner) ────────
PROMPT = (
    "A wide cinematic horizontal banner for a software-developer extension. "
    "Dark academia, wizardly aesthetic. Background: deep charcoal-to-black "
    "gradient (#3a3a3c fading to #0a0a0c) with subtle warm-orange glow on "
    "the right side. RIGHT THIRD: an ancient open spellbook with worn "
    "leather cover, parchment pages glowing softly, scattered glowing "
    "orange embers and sparkles drifting upward, a single bright orange "
    "8-pointed sparkle / sigil hovering above the open book. LEFT TWO "
    "THIRDS: mostly empty dark space (will be overlaid with text later), "
    "with faint atmospheric haze / smoke and a few drifting orange "
    "particles. Volumetric lighting, dramatic chiaroscuro, photorealistic "
    "rendering, deep blacks, warm amber highlights. Composition is "
    "16:5 widescreen, designed for a 1280x320 banner crop. "
    "NO TEXT, NO LETTERS, NO TYPOGRAPHY anywhere in the image."
)

# Where the headline + tagline land, in absolute pixels of the final 1280x320:
TITLE    = "CLAUDE CODEX BLACK"
TAGLINE  = "Claude  ·  ChatGPT  ·  Grok  ·  Gemini  ·  Copilot  ·  DeepSeek  ·  Azure"

ORANGE   = (227, 99, 26, 255)
WHITE    = (245, 245, 245, 255)
SHADOW   = (0, 0, 0, 200)


def load_openai_key():
    cp = configparser.ConfigParser()
    cp.read(CFG, encoding="utf-8")
    try:
        k = cp["api_keys"]["openai_api_key"].strip()
    except KeyError:
        sys.exit("config.ini [api_keys] openai_api_key missing")
    if not k or k.lower().startswith(("placeholder", "sk-xxx")):
        sys.exit("openai_api_key looks unset")
    return k


def call_image_gen(prompt, key):
    """POST to /v1/images/generations directly (no openai-python dependency)."""
    body = json.dumps({
        "model":   "gpt-image-1",
        "prompt":  prompt,
        "size":    "1536x1024",   # widest landscape gpt-image-1 supports
        "quality": "high",
        "n":       1,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type":  "application/json",
        },
        method="POST",
    )
    print(f"  calling gpt-image-1 (1536x1024, high, ~$0.17) ...")
    with urllib.request.urlopen(req, timeout=180) as resp:
        out = json.loads(resp.read())
    b64 = out["data"][0]["b64_json"]
    return base64.b64decode(b64)


def load_bold_font(size):
    for fp in [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\Tahomabd.ttf",
    ]:
        try:
            return ImageFont.truetype(fp, size)
        except OSError:
            continue
    return ImageFont.load_default()


def load_regular_font(size):
    for fp in [
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\Tahoma.ttf",
    ]:
        try:
            return ImageFont.truetype(fp, size)
        except OSError:
            continue
    return ImageFont.load_default()


def crop_and_resize_to_banner(src_bytes):
    src = Image.open(io.BytesIO(src_bytes)).convert("RGBA")
    sw, sh = src.size
    # Crop the middle horizontal slice with 1280x320 == 4:1 aspect.
    crop_h = int(sw / 4)
    if crop_h > sh:
        # source is narrower than 4:1 — crop vertical strip instead
        crop_w = sh * 4
        x = (sw - crop_w) // 2
        cropped = src.crop((x, 0, x + crop_w, sh))
    else:
        y = (sh - crop_h) // 2
        cropped = src.crop((0, y, sw, y + crop_h))
    return cropped.resize((W, H), Image.Resampling.LANCZOS)


def overlay_text(img):
    draw = ImageDraw.Draw(img)
    # Title — big bold orange, with a soft black shadow for legibility on the
    # dark backdrop (even with a bright spot under the text it stays readable).
    title_font   = load_bold_font(58)
    tagline_font = load_regular_font(20)

    # Position title in the left 60% of the banner
    title_x, title_y = 48, 90
    # shadow first (4 px offset, semi-transparent)
    for ox, oy in [(2, 2), (3, 3), (4, 4)]:
        draw.text((title_x + ox, title_y + oy), TITLE, font=title_font, fill=SHADOW)
    draw.text((title_x, title_y), TITLE, font=title_font, fill=ORANGE)

    # Tagline — white, smaller, under the title
    tagline_y = title_y + 78
    for ox, oy in [(1, 1), (2, 2)]:
        draw.text((title_x + ox, tagline_y + oy), TAGLINE, font=tagline_font, fill=SHADOW)
    draw.text((title_x, tagline_y), TAGLINE, font=tagline_font, fill=WHITE)
    return img


def main():
    reuse = "--reuse" in sys.argv
    OUT_RAW.parent.mkdir(parents=True, exist_ok=True)

    if reuse and OUT_RAW.exists():
        print(f"  --reuse: skipping API call, using cached {OUT_RAW.name}")
        raw_bytes = OUT_RAW.read_bytes()
    else:
        key = load_openai_key()
        raw_bytes = call_image_gen(PROMPT, key)
        OUT_RAW.write_bytes(raw_bytes)
        print(f"  saved raw backdrop -> {OUT_RAW.relative_to(ROOT)} ({len(raw_bytes):,}B)")

    banner = crop_and_resize_to_banner(raw_bytes)
    banner = overlay_text(banner)
    banner.save(OUT_FINAL, "PNG", optimize=True)
    print(f"  wrote {OUT_FINAL.relative_to(ROOT)}  {W}x{H}  {OUT_FINAL.stat().st_size:,}B")
    print("done. Re-overlay text without burning a new API call: --reuse")


if __name__ == "__main__":
    main()
