"""Translate panel/help.html into all 38 supported locales.

Reads `panel/help.html` (English source), sends to Claude Haiku 4.5 for
each non-en locale, writes `panel/help.<code>.html`. Preserves all HTML
structure, CSS, JS, ids, classes, hrefs, and inline code blocks; only
the visible text content gets translated.

Idempotent: skips locales whose target file already exists unless --force.
Costs roughly $1 to do all 38 locales once with Haiku 4.5.

Usage:
    python tools/translate_help.py                      # all missing
    python tools/translate_help.py --only fr,de,zh      # subset
    python tools/translate_help.py --force              # re-translate all
"""
from __future__ import annotations

import argparse
import configparser
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELP_SOURCE = ROOT / "panel" / "help.html"
LANGS_DIR = ROOT / "languages"

# (locale code, English name, native name) — must match build_language_files.py
LOCALES = [
    ("ar", "Arabic",              "العربية"),
    ("bn", "Bengali",             "বাংলা"),
    ("cs", "Czech",               "čeština"),
    ("da", "Danish",              "dansk"),
    ("de", "German",              "Deutsch"),
    ("el", "Greek",               "Ελληνικά"),
    ("es", "Spanish",             "español"),
    ("fa", "Persian",             "فارسی"),
    ("fi", "Finnish",             "suomi"),
    ("fr", "French",              "français"),
    ("ha", "Hausa",               "Hausa"),
    ("he", "Hebrew",              "עברית"),
    ("hi", "Hindi",               "हिन्दी"),
    ("hu", "Hungarian",           "magyar"),
    ("id", "Indonesian",          "Indonesia"),
    ("it", "Italian",             "italiano"),
    ("ja", "Japanese",            "日本語"),
    ("ko", "Korean",              "한국어"),
    ("mr", "Marathi",             "मराठी"),
    ("nb", "Norwegian Bokmål",    "norsk bokmål"),
    ("nl", "Dutch",               "Nederlands"),
    ("pa", "Punjabi",             "ਪੰਜਾਬੀ"),
    ("pl", "Polish",              "polski"),
    ("pt", "Portuguese",          "português"),
    ("ro", "Romanian",            "română"),
    ("ru", "Russian",             "русский"),
    ("sv", "Swedish",             "svenska"),
    ("sw", "Swahili",             "Kiswahili"),
    ("ta", "Tamil",               "தமிழ்"),
    ("te", "Telugu",              "తెలుగు"),
    ("th", "Thai",                "ไทย"),
    ("tl", "Tagalog",             "Tagalog"),
    ("tr", "Turkish",             "Türkçe"),
    ("uk", "Ukrainian",           "українська"),
    ("ur", "Urdu",                "اردو"),
    ("vi", "Vietnamese",          "Tiếng Việt"),
    ("yue", "Cantonese",          "粵語"),
    ("zh", "Chinese (Simplified)", "中文"),
]

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"


def _read_api_key() -> str:
    cfg = configparser.ConfigParser(interpolation=None)
    try:
        cfg.read(ROOT / "config.ini", encoding="utf-8")
    except Exception:
        pass
    for section in cfg.sections():
        if cfg.has_option(section, "anthropic_api_key"):
            v = (cfg.get(section, "anthropic_api_key") or "").strip()
            if v:
                return v
    return os.environ.get("ANTHROPIC_API_KEY", "")


SYSTEM_PROMPT = """You are translating an HTML help document for desktop software from English to the target language. Strict rules:

1. Output ONLY the translated HTML. No preamble, no markdown fences, no commentary — just the HTML, starting with <!doctype html> exactly as the input does.
2. Preserve ALL HTML structure EXACTLY: tag names, attributes, ids, classes, hrefs, data-* attributes, comments, whitespace, indentation, CSS blocks (<style>...</style>), and JavaScript blocks (<script>...</script>). Do not translate or modify anything inside <style> or <script>.
3. Translate ONLY visible text content (text between tags), title text, alt text, aria-label values, and placeholder values.
4. Brand names and proper nouns stay UNCHANGED in every language:
   "Claude Codex Black", "Black Edition", "Claude", "OpenAI", "ChatGPT", "Anthropic", "Gemini", "Google", "Grok", "xAI", "Azure", "Ollama", "Sora", "Veo", "Runway", "Bing Video Creator", "Microsoft", "Copilot", "DeepSeek", "VSCode", "Visual Studio Code", "GitHub", "Git", "NameSilo", "ComfyUI", "SuperGrok", "SAPI", "Web Speech API", "Tamagotchi", "FlatLine".
5. Inline <code>...</code> elements that contain identifiers, file paths, config keys, CLI flags, URLs, or shell snippets stay UNCHANGED. Translate <code> contents ONLY if it's a natural-language word like a button label.
6. Keyboard shortcuts inside <kbd>...</kbd> stay UNCHANGED in every language.
7. Update the <html lang="en"> attribute to the target locale code.
8. Use NATURAL, FLUENT idiomatic phrasing for the target language. Imperative short labels stay short.
9. If the input contains "{placeholder}" style template tokens, preserve them EXACTLY."""


def _post_claude(api_key: str, target_lang_english: str, target_code: str, html_in: str) -> str:
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 16000,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": f"Translate this help HTML document from English to {target_lang_english} (locale code: {target_code}). "
                       f"Remember: output ONLY the translated HTML, no preamble.\n\n{html_in}",
        }],
    }).encode("utf-8")
    req = urllib.request.Request(
        CLAUDE_URL,
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    parsed = json.loads(raw)
    blocks = parsed.get("content") or []
    for b in blocks:
        if b.get("type") == "text":
            return b.get("text", "")
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="Comma-separated locale codes to translate (default: all missing)")
    parser.add_argument("--force", action="store_true", help="Re-translate even if target file exists")
    parser.add_argument("--dry-run", action="store_true", help="List which files would be written; don't call API")
    args = parser.parse_args()

    if not HELP_SOURCE.exists():
        print(f"FATAL: {HELP_SOURCE} not found", file=sys.stderr)
        return 2

    html_in = HELP_SOURCE.read_text(encoding="utf-8")
    print(f"Source: {HELP_SOURCE} ({len(html_in)} chars)")

    selected = [code.strip().lower() for code in args.only.split(",") if code.strip()] if args.only else None

    targets: list[tuple[str, str]] = []
    for code, eng_name, _native in LOCALES:
        if selected and code not in selected:
            continue
        out_path = ROOT / "panel" / f"help.{code}.html"
        if out_path.exists() and not args.force:
            print(f"  skip {code} (exists; --force to overwrite)")
            continue
        targets.append((code, eng_name))

    if not targets:
        print("Nothing to do.")
        return 0
    print(f"Translating to {len(targets)} locale(s)...")

    if args.dry_run:
        for code, eng in targets:
            print(f"  would translate -> panel/help.{code}.html ({eng})")
        return 0

    api_key = _read_api_key()
    if not api_key:
        print("FATAL: no anthropic_api_key in config.ini [api_keys] or ANTHROPIC_API_KEY env", file=sys.stderr)
        return 3

    ok_count = 0
    for code, eng in targets:
        out_path = ROOT / "panel" / f"help.{code}.html"
        t0 = time.time()
        print(f"  [{code}] {eng}...", end=" ", flush=True)
        try:
            translated = _post_claude(api_key, eng, code, html_in)
            if not translated.strip():
                print(f"FAIL (empty response)")
                continue
            # Sanity check: must start with <!doctype or <html
            stripped = translated.lstrip()
            if not (stripped.startswith("<!doctype") or stripped.lower().startswith("<!doctype") or stripped.startswith("<html") or stripped.startswith("<!DOCTYPE")):
                # try to find the doc start
                idx = stripped.lower().find("<!doctype")
                if idx >= 0:
                    translated = stripped[idx:]
                else:
                    print(f"FAIL (response didn't start with doctype): {stripped[:80]!r}")
                    continue
            out_path.write_text(translated, encoding="utf-8")
            elapsed = time.time() - t0
            print(f"OK ({len(translated)} chars, {elapsed:.1f}s)")
            ok_count += 1
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
        except Exception as e:
            print(f"FAIL: {type(e).__name__}: {e}")

    print(f"\nDone: {ok_count}/{len(targets)} translated.")
    return 0 if ok_count == len(targets) else 1


if __name__ == "__main__":
    sys.exit(main())
