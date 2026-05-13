"""
Hook File: local_internet_hook.py

What it does:
Local HTTP utility that can fetch URLs, report status, download files, and do simple search queries against DuckDuckGo or Bing.

How to use it:
Run the main entrypoint with the requested action when you need a local-network web fetch outside the model APIs.

Primary entry points:
_request, fetch_url, get_status, download_file, search_duckduckgo, search_bing, post_json, _print, main

Relevant URL(s):
- https://html.duckduckgo.com/html/?q={q}
- https://www.bing.com/search?q={q}

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import sys
import os
import json
import urllib.parse
import urllib.request
import urllib.error

DEFAULT_TIMEOUT = 20
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36 GTP-LocalInternet/1.0"


def _request(url, method="GET", headers=None, data=None, timeout=DEFAULT_TIMEOUT, decode=True):
    headers = headers or {}
    if "User-Agent" not in headers:
        headers["User-Agent"] = DEFAULT_UA

    if isinstance(data, dict):
        data = urllib.parse.urlencode(data).encode("utf-8")
    elif isinstance(data, str):
        data = data.encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        info = {
            "url": resp.geturl(),
            "status": getattr(resp, "status", None) or resp.getcode(),
            "headers": dict(resp.info().items()),
            "body": body.decode("utf-8", errors="replace") if decode else body,
        }
        return info
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return {}


def fetch_url(url, timeout=DEFAULT_TIMEOUT, headers=None):
    return _request(url, method="GET", headers=headers, timeout=timeout)


def get_status(url, timeout=DEFAULT_TIMEOUT, headers=None):
    out = _request(url, method="GET", headers=headers, timeout=timeout)
    return {"url": out["url"], "status": out["status"], "headers": out["headers"]}


def download_file(url, path, timeout=DEFAULT_TIMEOUT, headers=None):
    out = _request(url, method="GET", headers=headers, timeout=timeout, decode=False)
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with open(path, "wb") as f:
        f.write(out["body"])
    return {"url": out["url"], "status": out["status"], "path": path, "bytes": os.path.getsize(path)}


def search_duckduckgo(query, timeout=DEFAULT_TIMEOUT):
    q = urllib.parse.quote(query)
    url = f"https://html.duckduckgo.com/html/?q={q}"
    return fetch_url(url, timeout=timeout)


def search_bing(query, timeout=DEFAULT_TIMEOUT):
    q = urllib.parse.quote(query)
    url = f"https://www.bing.com/search?q={q}"
    return fetch_url(url, timeout=timeout)


def post_json(url, payload, timeout=DEFAULT_TIMEOUT, headers=None):
    headers = headers or {}
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload)
    return _request(url, method="POST", headers=headers, data=data, timeout=timeout)


def _print(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        print("Usage: python local_internet_hook.py <action> <target> [extra]")
        print("Actions: fetch_url, get_status, download_file, search_ddg, search_bing")
        sys.exit(1)

    action = sys.argv[1]
    target = sys.argv[2]

    try:
        if action == "fetch_url":
            _print(fetch_url(target))
        elif action == "get_status":
            _print(get_status(target))
        elif action == "download_file":
            if len(sys.argv) < 4:
                raise ValueError("download_file requires a destination path")
            _print(download_file(target, sys.argv[3]))
        elif action == "search_ddg":
            _print(search_duckduckgo(target))
        elif action == "search_bing":
            _print(search_bing(target))
        else:
            raise ValueError(f"Unknown action: {action}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        _print({"error": "HTTPError", "status": e.code, "reason": str(e), "body": body})
        sys.exit(2)
    except Exception as e:
        _print({"error": type(e).__name__, "message": str(e)})
        sys.exit(3)


if __name__ == "__main__":
    main()
