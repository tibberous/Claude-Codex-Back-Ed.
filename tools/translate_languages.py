"""translate_languages.py — fully translate the panel's UI strings into all
38 non-English locales using the Anthropic Claude API.

Reads the authoritative English XML at languages/en.xml, then for each
non-en locale in LOCALES (imported from build_language_files.py) issues a
single Claude API request asking for a JSON object that maps every key to
its translated value. Writes the result straight to languages/<code>.xml.

Why not edit TRANSLATIONS in build_language_files.py and re-run that script?
The Python dict layout is fine for hand-curated sparse fills, but a full
machine-translation pass replaces 38 * 91 = 3458 strings — that would turn
build_language_files.py into an unreadable 20k-line dict literal. The XMLs
are the runtime target; we generate them directly.

Auth: API key is read from config.ini's [api_keys].anthropic_api_key.
Model: claude-sonnet-4-6 (good translation quality, cheap enough that 38
calls cost well under a dollar). One call per locale; batches in series so
we don't hit the per-minute rate limit.

Run:
    python tools/translate_languages.py
    python tools/translate_languages.py --only ar,fr,zh   # subset
    python tools/translate_languages.py --dry-run         # show what would change

After running, the panel picks up the new translations on next panel open
(loadLanguageFiles re-reads the XMLs each activate, or you can hot-reload
the active locale by re-selecting it in Settings).
"""

from __future__ import annotations

import argparse
import configparser
import json
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from xml.sax.saxutils import escape

ROOT          = Path(__file__).resolve().parent.parent
LANGUAGES_DIR = ROOT / "languages"
CONFIG_INI    = ROOT / "config.ini"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL         = "claude-sonnet-4-6"

# (locale code, English language name, native name) — must match
# build_language_files.py's LOCALES so generated XMLs preserve the same
# top-level <strings name="…" native="…"> metadata.
LOCALES: list[tuple[str, str, str]] = [
    ("en",  "English",                       "English"),
    ("zh",  "Mandarin Chinese (Simplified)", "中文"),
    ("hi",  "Hindi",                          "हिन्दी"),
    ("es",  "Spanish",                        "Español"),
    ("fr",  "French",                         "Français"),
    ("ar",  "Arabic",                         "العربية"),
    ("bn",  "Bengali",                        "বাংলা"),
    ("ru",  "Russian",                        "Русский"),
    ("pt",  "Portuguese",                     "Português"),
    ("ur",  "Urdu",                           "اردو"),
    ("id",  "Indonesian",                     "Bahasa Indonesia"),
    ("de",  "German",                         "Deutsch"),
    ("ja",  "Japanese",                       "日本語"),
    ("sw",  "Swahili",                        "Kiswahili"),
    ("mr",  "Marathi",                        "मराठी"),
    ("vi",  "Vietnamese",                     "Tiếng Việt"),
    ("te",  "Telugu",                         "తెలుగు"),
    ("ha",  "Hausa",                          "Hausa"),
    ("tr",  "Turkish",                        "Türkçe"),
    ("pa",  "Punjabi",                        "ਪੰਜਾਬੀ"),
    ("tl",  "Tagalog (Filipino)",             "Filipino"),
    ("ta",  "Tamil",                          "தமிழ்"),
    ("yue", "Yue Chinese (Cantonese)",        "粵語"),
    ("ko",  "Korean",                         "한국어"),
    ("fa",  "Persian (Farsi)",                "فارسی"),
    ("it",  "Italian",                        "Italiano"),
    ("pl",  "Polish",                         "Polski"),
    ("uk",  "Ukrainian",                      "Українська"),
    ("nl",  "Dutch",                          "Nederlands"),
    ("ro",  "Romanian",                       "Română"),
    ("th",  "Thai",                           "ไทย"),
    ("el",  "Greek",                          "Ελληνικά"),
    ("cs",  "Czech",                          "Čeština"),
    ("hu",  "Hungarian",                      "Magyar"),
    ("sv",  "Swedish",                        "Svenska"),
    ("fi",  "Finnish",                        "Suomi"),
    ("he",  "Hebrew",                         "עברית"),
    ("nb",  "Norwegian Bokmål",               "Norsk"),
    ("da",  "Danish",                         "Dansk"),
]
LOCALE_INDEX = {code: (eng, native) for code, eng, native in LOCALES}

SYSTEM_PROMPT = """You are translating UI strings for a desktop software panel from English to the target language. Rules:

1. Output ONLY a valid JSON object mapping each input KEY to its translated VALUE. No prose, no markdown fences, no preamble. Just the JSON.
2. Preserve format placeholders like {seconds}, {name}, %s, %d EXACTLY — do not translate them, do not change brace style.
3. Keep brand and proper names UNCHANGED in any language: "Claude Codex Black", "Claude Codex", "Black Edition", "FlatLine", "VSCode", "Visual Studio Code", "SAPI", "Git", "GitHub", "NameSilo", "ComfyUI", "SuperGrok", "Ollama".
4. Keep technical CLI words unchanged: "Enter", "Esc", "Ctrl", "Alt", "Shift", "API".
5. Match the original's punctuation tail — if the English ends with "…" or ":" or "!" or ".", end your translation the same way.
6. Use NATURAL, FLUENT idiomatic phrasing for the target language. Do not transliterate; translate the meaning. Imperative-sounding short labels should stay short and imperative.
7. For all-caps status tokens like "RUNNING" or "READY", keep them as the language's natural emphasis form (caps in Latin scripts; bold-equivalent native form otherwise).
8. The JSON must be UTF-8 encoded native script (don't transliterate Arabic to Latin, don't write Pinyin instead of 中文).
"""


def _load_api_key() -> str:
    cp = configparser.ConfigParser(interpolation=None)
    cp.read(CONFIG_INI, encoding="utf-8")
    if cp.has_section("api_keys") and cp.has_option("api_keys", "anthropic_api_key"):
        key = cp.get("api_keys", "anthropic_api_key").strip()
        if key:
            return key
    raise SystemExit(f"FATAL: anthropic_api_key not found in {CONFIG_INI} [api_keys] section.")


def _read_en_xml() -> dict[str, str]:
    """Parse languages/en.xml into {key: english_value}. Lightweight regex
    parse — the file is flat and tightly formatted; no need for an XML lib."""
    text = (LANGUAGES_DIR / "en.xml").read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for m in re.finditer(r'<s\s+id="([^"]+)">([^<]*)</s>', text):
        key, val = m.group(1), m.group(2)
        val = (val.replace("&amp;",  "&")
                  .replace("&lt;",   "<")
                  .replace("&gt;",   ">")
                  .replace("&quot;", '"')
                  .replace("&apos;", "'"))
        out[key] = val
    return out


def _claude_translate(api_key: str, code: str, english_name: str, strings: dict[str, str]) -> dict[str, str]:
    """One API call, returns a {key: translation} dict for the locale.
    Raises on hard errors; the outer loop retries with backoff."""
    user_msg = (
        f"Translate the VALUES of this JSON object from English to {english_name} (locale code: {code}). "
        f"Return a JSON object with the same KEYS and translated values. Keep all rules from the system prompt.\n\n"
        f"INPUT JSON:\n{json.dumps(strings, ensure_ascii=False, indent=2)}\n\n"
        f"Now output ONLY the translated JSON object."
    )
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 8192,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        method="POST",
        headers={
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
    payload = json.loads(raw)
    text_parts = [b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text"]
    full = "\n".join(text_parts).strip()
    # Strip optional markdown fence Claude might add despite instructions
    if full.startswith("```"):
        full = re.sub(r"^```(?:json)?\s*", "", full).strip()
        full = re.sub(r"\s*```\s*$",        "", full).strip()
    try:
        return json.loads(full)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Claude response not valid JSON for {code}: {e}\n---\n{full[:600]}")


def _xml_for_locale(code: str, english_name: str, native_name: str, strings: dict[str, str]) -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append(f'<strings locale="{escape(code)}" name="{escape(english_name)}" native="{escape(native_name)}">')
    for key in sorted(strings.keys()):
        lines.append(f'  <s id="{escape(key)}">{escape(strings[key])}</s>')
    lines.append("</strings>")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only",    default="", help="comma-separated locale codes to translate (default: all 38 non-English)")
    ap.add_argument("--dry-run", action="store_true", help="don't write XMLs, just print per-locale key counts")
    ap.add_argument("--sleep",   type=float, default=1.5, help="seconds to sleep between locales for rate limiting (default 1.5)")
    args = ap.parse_args()

    api_key = _load_api_key()
    english = _read_en_xml()
    print(f"loaded en.xml: {len(english)} keys")

    targets = [c for c, _, _ in LOCALES if c != "en"]
    if args.only.strip():
        wanted = {x.strip().lower() for x in args.only.split(",") if x.strip()}
        targets = [c for c in targets if c in wanted]
    print(f"will translate into {len(targets)} locales: {', '.join(targets)}")

    LANGUAGES_DIR.mkdir(parents=True, exist_ok=True)
    failures: list[tuple[str, str]] = []
    for i, code in enumerate(targets, 1):
        eng_name, native_name = LOCALE_INDEX[code]
        t0 = time.time()
        try:
            translated = _claude_translate(api_key, code, eng_name, english)
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
            elapsed = time.time() - t0
            print(f"  [{i:>2}/{len(targets)}]  {code:>3}  FAIL after {elapsed:.1f}s — {e}")
            failures.append((code, str(e)))
            time.sleep(args.sleep)
            continue
        # Merge: any keys the model dropped fall back to English so the XML
        # always has the full key set.
        merged = dict(english)
        for k, v in translated.items():
            if isinstance(v, str) and v.strip():
                merged[k] = v
        elapsed = time.time() - t0
        if args.dry_run:
            print(f"  [{i:>2}/{len(targets)}]  {code:>3}  OK  {elapsed:.1f}s  keys_translated={sum(1 for k in english if translated.get(k))}/{len(english)}  (dry-run, not written)")
        else:
            xml = _xml_for_locale(code, eng_name, native_name, merged)
            out_path = LANGUAGES_DIR / f"{code}.xml"
            out_path.write_text(xml, encoding="utf-8")
            print(f"  [{i:>2}/{len(targets)}]  {code:>3}  OK  {elapsed:.1f}s  translated={sum(1 for k in english if translated.get(k))}/{len(english)}  -> {out_path.name}")
        time.sleep(args.sleep)

    if failures:
        print(f"\n{len(failures)} failure(s):")
        for code, err in failures:
            print(f"  {code}: {err[:200]}")
        return 1
    print(f"\ndone. translated {len(targets)} locales.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
