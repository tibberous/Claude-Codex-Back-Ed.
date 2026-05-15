"""generate_brand_labels.py — generate translated brand-label SVGs.

The original brand asset is assets/label-alpha.png — a dark rounded pill with
the orange Claude "✱" sparkle on the left, "Claude Codex — Black Edition" in
white text, and a small caret on the right.

This script:
  1. Asks Claude to translate "Claude Codex — Black Edition" into all 38
     non-English locales in a single API call.
  2. For each locale (including English), writes a self-contained SVG at
     assets/labels/<code>.svg that visually matches the original PNG:
        - Same dark-gradient pill background.
        - Same orange 8-pointed sparkle on the left.
        - The translated phrase as the middle text.
        - The same caret on the right.
        - Right-to-left direction baked in for ar / he / fa / ur.
  3. Leaves "Claude Codex" untranslated as a brand; only "Black Edition" (or
     equivalent positional descriptor) shifts per language.

Why SVG and not regenerated PNGs:
  - SVG scales crisp at every DPI without re-rendering 39 PNGs.
  - Browser handles the RTL flip natively when direction="rtl" is set.
  - Panel can swap the <img src> in pure CSS/JS at language-change time.

Run:
    python tools/generate_brand_labels.py
    python tools/generate_brand_labels.py --only ar,zh,fr  # subset
"""

from __future__ import annotations

import argparse
import configparser
import json
import re
import sys
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

ROOT          = Path(__file__).resolve().parent.parent
LABELS_DIR    = ROOT / "assets" / "labels"
CONFIG_INI    = ROOT / "config.ini"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL         = "claude-sonnet-4-6"

# Locale tuples must match build_language_files.py exactly.
LOCALES: list[tuple[str, str]] = [
    ("en", "English"), ("zh", "Mandarin Chinese (Simplified)"), ("hi", "Hindi"),
    ("es", "Spanish"), ("fr", "French"), ("ar", "Arabic"), ("bn", "Bengali"),
    ("ru", "Russian"), ("pt", "Portuguese"), ("ur", "Urdu"),
    ("id", "Indonesian"), ("de", "German"), ("ja", "Japanese"),
    ("sw", "Swahili"), ("mr", "Marathi"), ("vi", "Vietnamese"),
    ("te", "Telugu"), ("ha", "Hausa"), ("tr", "Turkish"), ("pa", "Punjabi"),
    ("tl", "Tagalog (Filipino)"), ("ta", "Tamil"),
    ("yue", "Yue Chinese (Cantonese)"), ("ko", "Korean"),
    ("fa", "Persian (Farsi)"), ("it", "Italian"), ("pl", "Polish"),
    ("uk", "Ukrainian"), ("nl", "Dutch"), ("ro", "Romanian"), ("th", "Thai"),
    ("el", "Greek"), ("cs", "Czech"), ("hu", "Hungarian"), ("sv", "Swedish"),
    ("fi", "Finnish"), ("he", "Hebrew"), ("nb", "Norwegian Bokmål"),
    ("da", "Danish"),
]
RTL_LOCALES = {"ar", "he", "fa", "ur"}
SOURCE_BRAND = "Claude Codex — Black Edition"


def _load_api_key() -> str:
    cp = configparser.ConfigParser(interpolation=None)
    cp.read(CONFIG_INI, encoding="utf-8")
    return cp.get("api_keys", "anthropic_api_key").strip()


def _claude_translate_brand_all(api_key: str, codes: list[str]) -> dict[str, str]:
    """One API call that returns {code: translated_brand} for every locale.
    The brand name 'Claude Codex' must remain untranslated; only 'Black
    Edition' gets the localized treatment."""
    locale_lines = "\n".join(
        f'  "{code}": "<translation of {SOURCE_BRAND} for {english_name}>"'
        for code, english_name in LOCALES if code in codes
    )
    system = (
        'You are translating a brand label. The English phrase is exactly '
        f'"{SOURCE_BRAND}".\n'
        'Output ONLY a JSON object mapping each locale code to the translated '
        'phrase. No prose, no markdown, just the JSON object.\n'
        'Rules:\n'
        '1. "Claude Codex" is a brand name — keep it in Latin script EXACTLY '
        'in every language. Never transliterate it.\n'
        '2. Keep the em dash " — " (with spaces) as a separator OR use the '
        'language\'s natural punctuation.\n'
        '3. Translate "Black Edition" into the target language naturally '
        '("Edición Negra", "Édition Noire", "黒版", "الإصدار الأسود", etc).\n'
        '4. Use native script for the descriptor part.\n'
        '5. Keep it concise — the pill is ~600px wide; phrases over ~40 chars '
        'cause layout overflow.'
    )
    user = (
        'Translate "Claude Codex — Black Edition" into every locale below. '
        'Return a JSON object with these exact keys:\n\n'
        '{\n' + locale_lines + '\n}'
    )
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ANTHROPIC_URL, data=body, method="POST",
        headers={
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
    payload = json.loads(raw)
    text = "\n".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    return json.loads(text)


def _svg_for(code: str, brand_text: str) -> str:
    """Return a self-contained SVG that visually matches assets/label-alpha.png
    with the locale-specific brand text. RTL locales flip text direction."""
    rtl = code in RTL_LOCALES
    direction   = "rtl" if rtl else "ltr"
    # Match the ORIGINAL PNG's exact aspect ratio (932 x 148 = 6.3:1) so when
    # the <img> stretches to fill .label-button's 320 x 56 box the text size
    # ends up the same as the PNG. Previous 680 x 80 was 8.5:1, so the SVG
    # was squashed vertically inside .label-button img { object-fit:contain }
    # and the text shrank to ~50% of the available height.
    W, H = 932, 148
    pill_radius = 28
    # Orange sparkle (the "✱" mark in the PNG), scaled to PNG dims.
    spark_cx, spark_cy, spark_r = 70, H / 2, 26
    star_points = []
    import math
    for i in range(16):
        angle = (i * math.pi / 8) - (math.pi / 2)
        radius = spark_r if (i % 2 == 0) else spark_r * 0.42
        star_points.append(f"{spark_cx + radius * math.cos(angle):.2f},{spark_cy + radius * math.sin(angle):.2f}")
    star_d = " ".join(star_points)
    # Caret on the right (the "⌄" dropdown indicator), scaled to PNG dims.
    caret_x = W - 58
    caret_y = H / 2
    caret_path = (
        f"M{caret_x - 14:.1f},{caret_y - 7:.1f} "
        f"L{caret_x:.1f},{caret_y + 10:.1f} "
        f"L{caret_x + 14:.1f},{caret_y - 7:.1f}"
    )
    safe_text = xml_escape(brand_text)
    # Center the text in the space BETWEEN sparkle (left) and caret (right).
    text_x = (spark_cx + spark_r + 24 + caret_x - 14 - 24) / 2
    # Font: prefer a stack that has wide language coverage.
    font_stack = (
        '"Segoe UI", "Noto Sans", "Noto Sans Arabic", "Noto Sans CJK SC", '
        '"Noto Sans Devanagari", "Noto Sans Hebrew", "Helvetica Neue", '
        'Arial, sans-serif'
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="{safe_text}">
  <defs>
    <linearGradient id="pill-grad-{code}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#3a3a3c"/>
      <stop offset="100%" stop-color="#1a1a1c"/>
    </linearGradient>
    <linearGradient id="spark-grad-{code}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#ff9a3d"/>
      <stop offset="100%" stop-color="#e3631a"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="{W - 4}" height="{H - 4}" rx="{pill_radius}" ry="{pill_radius}"
        fill="url(#pill-grad-{code})" stroke="#4a4a4c" stroke-width="2"/>
  <polygon points="{star_d}" fill="url(#spark-grad-{code})"/>
  <text x="{text_x:.1f}" y="{H / 2 + 18}" text-anchor="middle"
        direction="{direction}" unicode-bidi="plaintext"
        fill="#ffffff" font-family='{font_stack}'
        font-size="52" font-weight="600" letter-spacing="-0.2">{safe_text}</text>
  <path d="{caret_path}" fill="none" stroke="#ffffff" stroke-width="4"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def main() -> int:
    # Windows console default is cp1252; reconfigure stdout to UTF-8 so
    # logging non-Latin text doesn't crash mid-loop.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated codes (default: all 39)")
    args = ap.parse_args()
    all_codes = [c for c, _ in LOCALES]
    if args.only.strip():
        wanted = {x.strip().lower() for x in args.only.split(",") if x.strip()}
        codes = [c for c in all_codes if c in wanted]
    else:
        codes = all_codes
    print(f"will generate labels for {len(codes)} locales: {', '.join(codes)}")

    LABELS_DIR.mkdir(parents=True, exist_ok=True)

    # English is the source — no API call needed.
    translations: dict[str, str] = {"en": SOURCE_BRAND}
    non_en = [c for c in codes if c != "en"]
    if non_en:
        api_key = _load_api_key()
        print(f"translating brand into {len(non_en)} languages via Claude API…")
        result = _claude_translate_brand_all(api_key, non_en)
        for code, text in result.items():
            if isinstance(text, str) and text.strip():
                translations[code] = text.strip()
    # Fallback to English for any locale Claude didn't return.
    for code in codes:
        translations.setdefault(code, SOURCE_BRAND)

    written = 0
    for code in codes:
        svg = _svg_for(code, translations[code])
        out = LABELS_DIR / f"{code}.svg"
        out.write_text(svg, encoding="utf-8")
        print(f"  wrote {out.relative_to(ROOT)}  text='{translations[code]}'")
        written += 1
    print(f"\ndone. wrote {written} SVG label files into {LABELS_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
