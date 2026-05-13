"""
Hook File: indeed_hook.py

What it does:
Indeed search and scraping helper that builds search URLs, extracts job links, downloads job pages, and saves results locally.

How to use it:
Run the search flow with a keyword and location to collect job results into files for later review.

Primary entry points:
safe_name, get_session, build_search_url, extract_job_links, extract_title, extract_company, save_job, search, main

Relevant URL(s):
- https://www.indeed.com
- https://www.indeed.com/rc/clk?...
- https://www.indeed.com/viewjob?...

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import re
import json
import time
import argparse
from pathlib import Path
from datetime import datetime
from urllib.parse import quote_plus, urljoin

import requests

BASE_URL = "https://www.indeed.com"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def safe_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._ -]+", "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:120] if s else "job"


def get_session():
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    return sess


def build_search_url(keyword: str, zipcode: str, radius: int = 25):
    return f"{BASE_URL}/jobs?q={quote_plus(keyword)}&l={quote_plus(zipcode)}&radius={radius}"


def extract_job_links(html: str):
    links = []
    seen = set()

    patterns = [
        r'href="(/rc/clk\?[^"#]+)"',
        r'href="(/viewjob\?[^"#]+)"',
        r'"jobLink"[^>]*href="([^"]+)"',
        r'href="(https://www\.indeed\.com/rc/clk\?[^"#]+)"',
        r'href="(https://www\.indeed\.com/viewjob\?[^"#]+)"',
    ]

    for pat in patterns:
        for m in re.findall(pat, html, flags=re.I):
            full = urljoin(BASE_URL, m)
            if full not in seen:
                seen.add(full)
                links.append(full)

    return links


def extract_title(html: str):
    for pat in [r'<title>(.*?)</title>', r'<h1[^>]*>(.*?)</h1>']:
        m = re.search(pat, html, flags=re.I | re.S)
        if m:
            text = re.sub(r'<[^>]+>', ' ', m.group(1))
            text = re.sub(r'\s+', ' ', text).strip()
            if text:
                return text
    return "Untitled Job"


def extract_company(html: str):
    pats = [
        r'data-company-name="([^"]+)"',
        r'company[^>]*>\s*<span[^>]*>(.*?)</span>',
        r'Company[^<]{0,40}</*[^>]*>\s*([^<\n]+)',
    ]
    for pat in pats:
        m = re.search(pat, html, flags=re.I | re.S)
        if m:
            text = re.sub(r'<[^>]+>', ' ', m.group(1))
            text = re.sub(r'\s+', ' ', text).strip()
            if text:
                return text
    return "Unknown Company"


def save_job(out_dir: Path, idx: int, url: str, html: str):
    title = safe_name(extract_title(html))
    company = safe_name(extract_company(html))
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{idx:02d}_{company}_{title}_{stamp}"

    html_path = out_dir / f"{base}.html"
    meta_path = out_dir / f"{base}.json"

    html_path.write_text(html, encoding="utf-8")
    meta = {
        "saved_at": datetime.now().isoformat(),
        "url": url,
        "title": extract_title(html),
        "company": extract_company(html),
        "html_file": str(html_path),
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def search(keyword: str, zipcode: str, radius: int, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    sess = get_session()
    search_url = build_search_url(keyword, zipcode, radius)

    r = sess.get(search_url, timeout=30)
    r.raise_for_status()
    search_html = r.text

    (out_dir / "search_page.html").write_text(search_html, encoding="utf-8")

    links = extract_job_links(search_html)
    results = []

    for i, link in enumerate(links, 1):
        try:
            jr = sess.get(link, timeout=30)
            jr.raise_for_status()
            meta = save_job(out_dir, i, link, jr.text)
            results.append(meta)
            time.sleep(1)
        except Exception as e:
            results.append({"url": link, "error": str(e)})

    summary = {
        "saved_at": datetime.now().isoformat(),
        "keyword": keyword,
        "zipcode": zipcode,
        "radius": radius,
        "search_url": search_url,
        "jobs_found": len(links),
        "results": results,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main():
    ap = argparse.ArgumentParser(description="Indeed search hook: fetch first-page job links and save job pages.")
    sub = ap.add_subparsers(dest="action", required=True)

    s = sub.add_parser("search", help="Search Indeed and save first-page job postings")
    s.add_argument("keyword")
    s.add_argument("--zipcode", default="16052")
    s.add_argument("--radius", type=int, default=25)
    s.add_argument("--out", default=str(Path(r"C:\Users\moren\Desktop\jobs") / "indeed"))

    args = ap.parse_args()

    if args.action == "search":
        keyword_slug = safe_name(args.keyword).replace(" ", "_")
        run_dir = Path(args.out) / f"{keyword_slug}_{args.zipcode}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        summary = search(args.keyword, args.zipcode, args.radius, run_dir)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
