"""
Hook File: playwright_hook.py

What it does:
Local Playwright browser automation — screenshot, scrape text/links, fill forms,
click elements, and extract structured data. Runs Chromium locally, no API key needed.

How to use it:
  pip install playwright && playwright install chromium
  python playwright_hook.py screenshot https://example.com out.png
  python playwright_hook.py scrape https://example.com
  python playwright_hook.py links https://example.com
  python playwright_hook.py click https://example.com "#submit-btn"

Primary entry points:
screenshot, scrape, get_links, click_element, fill_form, main

Relevant URL(s):
- https://playwright.dev/python/docs/intro
- Install: pip install playwright && playwright install chromium
"""

import sys
import json


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except ImportError:
        print(
            "ERROR: playwright is not installed.\n"
            "Install it with:\n"
            "  pip install playwright\n"
            "  playwright install chromium\n"
            "Docs: https://playwright.dev/python/docs/intro",
            file=sys.stderr,
        )
        sys.exit(1)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None


def screenshot(page_url: str, out_path: str = "screenshot.png", full_page: bool = False):
    sync_playwright = _require_playwright()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(page_url, wait_until="networkidle")
        page.screenshot(path=out_path, full_page=full_page)
        browser.close()
    print(f"Saved screenshot → {out_path}")
    return out_path


def scrape(page_url: str, selector: str = "body"):
    sync_playwright = _require_playwright()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(page_url, wait_until="networkidle")
        text = page.locator(selector).inner_text()
        title = page.title()
        browser.close()
    result = {"url": page_url, "title": title, "text": text.strip()}
    print(json.dumps(result, indent=2))
    return result


def get_links(page_url: str):
    sync_playwright = _require_playwright()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(page_url, wait_until="networkidle")
        links = page.eval_on_selector_all(
            "a[href]",
            "els => els.map(e => ({text: e.innerText.trim(), href: e.href}))"
        )
        browser.close()
    print(json.dumps(links, indent=2))
    return links


def click_element(page_url: str, selector: str, wait_after: int = 2000):
    sync_playwright = _require_playwright()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        page.goto(page_url, wait_until="networkidle")
        page.click(selector)
        page.wait_for_timeout(wait_after)
        result_url = page.url
        browser.close()
    print(json.dumps({"clicked": selector, "result_url": result_url}))
    return result_url


def fill_form(page_url: str, fields: dict, submit_selector: str = None):
    """fields: {"#username": "admin", "#password": "secret"}"""
    sync_playwright = _require_playwright()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(page_url, wait_until="networkidle")
        for selector, value in fields.items():
            page.fill(selector, value)
        if submit_selector:
            page.click(submit_selector)
            page.wait_for_load_state("networkidle")
        result_url = page.url
        browser.close()
    print(json.dumps({"filled": list(fields.keys()), "result_url": result_url}))
    return result_url


def main():
    if len(sys.argv) < 3:
        print(
            "Usage:\n"
            "  python playwright_hook.py screenshot <url> [out.png] [--full]\n"
            "  python playwright_hook.py scrape <url> [selector]\n"
            "  python playwright_hook.py links <url>",
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
        sel = sys.argv[3] if len(sys.argv) > 3 else "body"
        scrape(url, sel)
    elif action == "links":
        get_links(url)
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
