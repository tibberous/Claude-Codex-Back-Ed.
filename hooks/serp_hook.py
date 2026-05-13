"""
Hook File: serp_hook.py

What it does:
SerpAPI wrapper — Google search results, organic links, featured snippets,
and related searches. Returns structured JSON you can feed to other hooks.

How to use it:
  python serp_hook.py search "python tutorials" --num 10
  python serp_hook.py search "site:example.com keyword" --engine bing
  python serp_hook.py links "buy laptops" --num 5

Primary entry points:
search, get_links, main

Relevant URL(s):
- https://serpapi.com/search-api
- Get a key: https://serpapi.com/manage-api-key
"""

import os
import sys
import json
import argparse
import requests

API_BASE = "https://serpapi.com"
API_KEY = os.environ.get("SERPAPI_KEY", "")


def _require_key():
    if not API_KEY:
        print(
            "ERROR: SERPAPI_KEY is not set.\n"
            "Set the env var or set API_KEY in this file.\n"
            "Get a key at: https://serpapi.com/manage-api-key",
            file=sys.stderr,
        )
        sys.exit(1)


def search(query: str, engine: str = "google", num: int = 10, location: str = None):
    _require_key()
    params = {
        "q": query,
        "engine": engine,
        "num": num,
        "api_key": API_KEY,
    }
    if location:
        params["location"] = location
    r = requests.get(f"{API_BASE}/search", params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        print(json.dumps({"ok": False, "error": data["error"]}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(data, indent=2))
    return data


def get_links(query: str, num: int = 10):
    data = search(query, num=num)
    results = data.get("organic_results", [])
    links = [{"title": r.get("title", ""), "link": r.get("link", ""), "snippet": r.get("snippet", "")} for r in results]
    print(json.dumps(links, indent=2))
    return links


def main():
    parser = argparse.ArgumentParser(description="SerpAPI search hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("--engine", default="google")
    p_search.add_argument("--num", type=int, default=10)
    p_search.add_argument("--location")

    p_links = sub.add_parser("links")
    p_links.add_argument("query")
    p_links.add_argument("--num", type=int, default=10)

    args = parser.parse_args()
    if args.action == "search":
        search(args.query, args.engine, args.num, getattr(args, "location", None))
    elif args.action == "links":
        get_links(args.query, args.num)


if __name__ == "__main__":
    main()
