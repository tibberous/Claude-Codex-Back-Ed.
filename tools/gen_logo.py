#!/usr/bin/env python3
"""Generate the 128x128 extension logo: "CODEX" / "BLACK" stacked.

Why Pillow (not gpt-image-1): image-gen models butcher short stacked text;
direct vector text rendering gives crisp letterforms. Colors taken from the
brand label en.svg (Anthropic orange #e3631a + white) so the icon matches the
in-app label pill.

Backs up the prior resources/icon.png so the change is reversible. Run:
  python tools/gen_logo.py
"""
import math, sys, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "resources" / "icon.png"
W = H = 128

BG       = (0, 0, 0, 0)            # fully transparent
ORANGE   = (227, 99, 26, 255)      # #e3631a — brand splat
WHITE    = (245, 245, 245, 255)
SPLAT_HI = (255, 154, 61, 255)     # #ff9a3d — splat highlight

def load_bold_font(size):
    """Find a bold sans on Windows — fall back to default if none."""
    for fp in [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\Tahomabd.ttf",
        r"C:\Windows\Fonts\verdanab.ttf",
    ]:
        try:
            return ImageFont.truetype(fp, size)
        except OSError:
            continue
    return ImageFont.load_default()

def draw_splat(draw, cx, cy, R, r=None):
    """Anthropic-style 5-bladed Claude sparkle: five elongated lozenges
    radiating at 72° apart (pentagonal symmetry). The PREVIOUS version had
    8 blades (4 cardinal + 4 diagonal) which read as a generic 16-point
    asterisk — user 2026-05-22: '5 blade, its like 16'. Five-fold symmetry
    is the actual Claude mark silhouette."""
    blade_w  = R * 0.22         # half-width of each blade at its widest
    bulge_at = R * 0.32         # how far from center the widest point sits
    for axis in range(5):
        angle = axis * math.pi * 2 / 5 - math.pi / 2   # 5 blades, first one straight up
        ux, uy = math.cos(angle), math.sin(angle)
        px, py = -uy, ux                                # perpendicular for side bulges
        tip   = (cx + R        * ux,             cy + R        * uy)
        side1 = (cx + bulge_at * ux + blade_w * px,
                 cy + bulge_at * uy + blade_w * py)
        side2 = (cx + bulge_at * ux - blade_w * px,
                 cy + bulge_at * uy - blade_w * py)
        center = (cx, cy)
        draw.polygon([tip, side1, center, side2], fill=ORANGE)
    # Small center highlight where the five blades overlap
    hl = max(2, R // 6)
    draw.ellipse([cx - hl, cy - hl, cx + hl, cy + hl], fill=SPLAT_HI)

def center_text(draw, y, text, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) / 2 - bbox[0], y), text, font=font, fill=fill)

def pick_font(text, max_w):
    """Largest bold size that fits text within max_w px."""
    for size in range(40, 14, -1):
        f = load_bold_font(size)
        bbox = ImageDraw.Draw(Image.new("RGBA", (W, H))).textbbox((0, 0), text, font=f)
        if (bbox[2] - bbox[0]) <= max_w:
            return f, size
    return load_bold_font(16), 16

def main():
    if OUT.exists():
        bak = OUT.with_suffix(".png.bak")
        if not bak.exists():
            shutil.copy2(OUT, bak)
            print(f"  backed up prior icon -> {bak.name}")

    img = Image.new("RGBA", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Dark rounded-square plate so the icon reads on BOTH the light marketplace
    # listing and the dark Extensions sidebar. 4px transparent inset gives the
    # rounded corners breathing room. Slight border in #4a4a4c matches the
    # brand label pill from en.svg.
    PAD = 4
    RAD = 22
    PLATE_FILL = (26, 26, 28, 255)        # #1a1a1c — bottom of pill-grad-en
    PLATE_TOP  = (58, 58, 60, 255)        # #3a3a3c — top of pill-grad-en
    PLATE_BORDER = (74, 74, 76, 255)      # #4a4a4c
    # vertical gradient fill
    plate = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(plate)
    for y in range(PAD, H - PAD):
        t = (y - PAD) / (H - 2 * PAD - 1)
        r = round(PLATE_TOP[0] * (1 - t) + PLATE_FILL[0] * t)
        g = round(PLATE_TOP[1] * (1 - t) + PLATE_FILL[1] * t)
        b = round(PLATE_TOP[2] * (1 - t) + PLATE_FILL[2] * t)
        pdraw.line([(PAD, y), (W - PAD - 1, y)], fill=(r, g, b, 255))
    # round the corners via an alpha mask
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [PAD, PAD, W - PAD - 1, H - PAD - 1], radius=RAD, fill=255
    )
    img.paste(plate, (0, 0), mask)
    # subtle border
    draw.rounded_rectangle(
        [PAD, PAD, W - PAD - 1, H - PAD - 1], radius=RAD,
        outline=PLATE_BORDER, width=1,
    )

    # Both words use the same bold size for visual rhythm. Plate inset gives
    # us ~108px usable width.
    inner_w = W - 2 * (PAD + 6)
    font_top, _ = pick_font("CODEX", max_w=inner_w)
    font_bot, _ = pick_font("BLACK", max_w=inner_w)
    size = min(font_top.size, font_bot.size)
    font = load_bold_font(size)

    # Layout: CODEX hugs the top edge, BLACK hugs the bottom edge, the
    # Claude-style splat fills the entire middle gap (previous version had
    # the splat at R=12, ~24 px, which looked like a stray asterisk in a
    # sea of dead space — user 2026-05-22: "vertical spacing is off, its
    # an asterisk not a Claude"). The splat radius is now derived from the
    # gap between the two text baselines so it fully fills the middle band.
    bbox = draw.textbbox((0, 0), "CODEX", font=font)
    th = bbox[3] - bbox[1]
    top_y = PAD + 2
    bot_y = H - PAD - 2 - th
    gap   = bot_y - (top_y + th)                    # empty middle height
    mid_y = (top_y + th + bot_y) // 2
    splat_R = max(18, gap // 2 + 4)                 # fill the gap + slight overlap

    # Use the saved on-brand splat image (chunky-petal orange splash from
    # ChatGPT, lives at assets/claude-splat.png). Falls back to the
    # procedural draw_splat if the image is missing. The image is the
    # single source of truth for the Claude splat anywhere we need one;
    # update assets/claude-splat.png to change the splat everywhere.
    splat_path = ROOT / "assets" / "claude-splat.png"
    if splat_path.exists():
        splat = Image.open(splat_path).convert("RGBA")
        # Trim the transparent margin so the visible orange shape is the
        # actual bounding box we resize against. Without this the source
        # PNG's ~25% transparent border pushes the visible mark larger
        # than the gap, overlapping the text.
        bbox = splat.getbbox()
        if bbox:
            splat = splat.crop(bbox)
        # Leave 4 px breathing room above + below so the splat sits cleanly
        # between the two text rows instead of overlapping them.
        target = max(28, min(gap - 8, 44))
        splat.thumbnail((target, target), Image.Resampling.LANCZOS)
        sx = (W - splat.width) // 2
        sy = mid_y - splat.height // 2
        img.paste(splat, (sx, sy), splat)             # alpha-composite
    else:
        draw_splat(draw, W // 2, mid_y, R=splat_R)
    center_text(draw, top_y, "CODEX", font, WHITE)
    center_text(draw, bot_y, "BLACK", font, WHITE)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    sz = OUT.stat().st_size
    print(f"  wrote {OUT.relative_to(ROOT)}  {W}x{H}  {sz:,}B  font={size}pt")
    print("done.")

if __name__ == "__main__":
    main()
