"""
Hook File: browserless_hook.py

What it does:
Browserless.io REST API wrapper — screenshot a URL, scrape page content/text,
and fetch rendered HTML. No local browser or driver required.

How to use it:
Set BROWSERLESS_TOKEN env var or set TOKEN below.
  python browserless_hook.py screenshot https://example.com out.png
  python browserless_hook.py scrape https://example.com
  python browserless_hook.py html https://example.com

Primary entry points:
screenshot, scrape, get_html, main

Relevant URL(s):
- https://docs.browserless.io/rest-apis/intro
- Get a token: https://browserless.io/sign-up
"""

import os
import sys
import json
import requests
from pathlib import Path

API_BASE = "https://production-sfo.browserless.io"
TOKEN = os.environ.get("BROWSERLESS_TOKEN", "")


def _require_token():
    if not TOKEN:
        print(
            "ERROR: BROWSERLESS_TOKEN is not set.\n"
            "Set the env var or set TOKEN in this file.\n"
            "Get a token at: https://browserless.io/sign-up",
            file=sys.stderr,
        )
        sys.exit(1)


def _url(path):
    _require_token()
    return f"{API_BASE}{path}?token={TOKEN}"


def screenshot(page_url: str, out_path: str = "screenshot.png", full_page: bool = False):
    payload = {
        "url": page_url,
        "options": {"fullPage": full_page, "type": "png"},
    }
    r = requests.post(_url("/screenshot"), json=payload, timeout=60)
    r.raise_for_status()
    Path(out_path).write_bytes(r.content)
    print(f"Saved {len(r.content)} bytes → {out_path}")
    return out_path


def scrape(page_url: str, selectors: list = None):
    payload = {
        "url": page_url,
        "elements": [{"selector": s} for s in (selectors or ["body"])],
    }
    r = requests.post(_url("/scrape"), json=payload, timeout=60)
    r.raise_for_status()
    data = r.json()
    print(json.dumps(data, indent=2))
    return data


def get_html(page_url: str):
    payload = {"url": page_url}
    r = requests.post(_url("/content"), json=payload, timeout=60)
    r.raise_for_status()
    html = r.text
    print(html)
    return html


def main():
    if len(sys.argv) < 3:
        print(
            "Usage:\n"
            "  python browserless_hook.py screenshot <url> [out.png] [--full]\n"
            "  python browserless_hook.py scrape <url> [selector1 selector2 ...]\n"
            "  python browserless_hook.py html <url>",
            file=sys.stderr,
        )
        sys.exit(1)

    action = sys.argv[1].lower()
    url = sys.argv[2]

    if action == "screenshot":
        out = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else "screenshot.png"
        full = "--full" in sys.argv
        screenshot(url, out, full)
    elif action == "scrape":
        sels = sys.argv[3:] if len(sys.argv) > 3 else None
        scrape(url, sels)
    elif action == "html":
        get_html(url)
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
