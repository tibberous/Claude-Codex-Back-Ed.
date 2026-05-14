"""
Hook File: selenium_hook.py

What it does:
Local Selenium browser automation — screenshot, scrape text, click elements,
fill forms, and extract links. Uses Chrome + ChromeDriver (auto-managed via
selenium-manager bundled with Selenium 4.6+).

How to use it:
  pip install selenium
  python selenium_hook.py screenshot https://example.com out.png
  python selenium_hook.py scrape https://example.com
  python selenium_hook.py links https://example.com

Primary entry points:
screenshot, scrape, get_links, click_element, fill_form, main

Relevant URL(s):
- https://selenium-python.readthedocs.io/
- Install: pip install selenium
- ChromeDriver auto-managed by Selenium 4.6+ (no manual download needed)
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : selenium_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# PRIMARY ENTRY POINTS
#   - screenshot
#   - scrape
#   - get_links
#   - click_element
#   - fill_form
#   - main
#
# CREDENTIALS
#   API keys, tokens, and remote endpoints live in config.ini at
#   the repo root. Hooks read them via hooks/_config.py. Do NOT
#   hardcode keys in source. Do NOT push config.ini to the server
#   (it is on the auto-update exclude list in extension.js).
#
# SIDE EFFECTS
#   May make outbound network calls, may write to disk under the
#   repo root (logs/, chats/, reports/), may spawn subprocesses,
#   may touch the journaling DB through trio_hook_orm. Inspect
#   the function before running it on production data.
#
# THINGS THIS HOOK WILL NOT DO
#   - It will not reload the VSCode window. Nothing in this repo
#     reloads the window. See handbook.txt Section 8.
#   - It will not push files to the server. Pushing is gated on
#     config.ini [updates] is_admin=true and is handled by the
#     extension, not by individual hooks. See handbook.txt §17.
#   - It will not silently swallow errors. If it fails it raises
#     or returns a structured error; check the trace channel.
#
# RELATED HANDBOOK SECTIONS
#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library
#   §22 Trace channel   §24 Troubleshooting
#
# === LLM-USAGE: END ===
import sys
import json
import time


def _require_selenium():
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        return webdriver, Options, Service, By, WebDriverWait, EC
    except ImportError:
        print(
            "ERROR: selenium is not installed.\n"
            "Install it with:\n"
            "  pip install selenium\n"
            "Selenium 4.6+ manages ChromeDriver automatically.\n"
            "Docs: https://selenium-python.readthedocs.io/",
            file=sys.stderr,
        )
        sys.exit(1)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None


def _make_driver(headless=True):
    webdriver, Options, Service, By, WebDriverWait, EC = _require_selenium()
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1280,900")
    return webdriver.Chrome(options=opts), By, WebDriverWait, EC


def screenshot(page_url: str, out_path: str = "screenshot.png"):
    driver, By, WebDriverWait, EC = _make_driver()
    try:
        driver.get(page_url)
        time.sleep(2)
        driver.save_screenshot(out_path)
        print(f"Saved screenshot → {out_path}")
    finally:
        driver.quit()
    return out_path


def scrape(page_url: str, selector: str = "body"):
    driver, By, WebDriverWait, EC = _make_driver()
    try:
        driver.get(page_url)
        time.sleep(2)
        el = driver.find_element(By.CSS_SELECTOR, selector)
        text = el.text
        title = driver.title
    finally:
        driver.quit()
    result = {"url": page_url, "title": title, "text": text.strip()}
    print(json.dumps(result, indent=2))
    return result


def get_links(page_url: str):
    driver, By, WebDriverWait, EC = _make_driver()
    try:
        driver.get(page_url)
        time.sleep(2)
        elements = driver.find_elements(By.CSS_SELECTOR, "a[href]")
        links = [{"text": e.text.strip(), "href": e.get_attribute("href")} for e in elements]
    finally:
        driver.quit()
    print(json.dumps(links, indent=2))
    return links


def click_element(page_url: str, selector: str, headless: bool = False):
    driver, By, WebDriverWait, EC = _make_driver(headless=headless)
    try:
        driver.get(page_url)
        el = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
        )
        el.click()
        time.sleep(2)
        result_url = driver.current_url
    finally:
        driver.quit()
    print(json.dumps({"clicked": selector, "result_url": result_url}))
    return result_url


def fill_form(page_url: str, fields: dict, submit_selector: str = None):
    """fields: {"#username": "admin", "#password": "secret"}"""
    driver, By, WebDriverWait, EC = _make_driver()
    try:
        driver.get(page_url)
        time.sleep(1)
        for selector, value in fields.items():
            el = driver.find_element(By.CSS_SELECTOR, selector)
            el.clear()
            el.send_keys(value)
        if submit_selector:
            driver.find_element(By.CSS_SELECTOR, submit_selector).click()
            time.sleep(2)
        result_url = driver.current_url
    finally:
        driver.quit()
    print(json.dumps({"filled": list(fields.keys()), "result_url": result_url}))
    return result_url


def main():
    if len(sys.argv) < 3:
        print(
            "Usage:\n"
            "  python selenium_hook.py screenshot <url> [out.png]\n"
            "  python selenium_hook.py scrape <url> [selector]\n"
            "  python selenium_hook.py links <url>",
            file=sys.stderr,
        )
        sys.exit(1)

    action = sys.argv[1].lower()
    url = sys.argv[2]

    if action == "screenshot":
        out = sys.argv[3] if len(sys.argv) > 3 else "screenshot.png"
        screenshot(url, out)
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
