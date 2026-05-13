#!/usr/bin/env python3
"""
Hook File: namesilo_hook.py

What it does:
NameSilo API wrapper for listing domains, reading domain info, and checking whether a domain appears registerable.

How to use it:
Configure the NameSilo API key and then call the API-backed helper functions or the CLI main function.

Primary entry points:
call, list_domains, get_domain_info, check_registerability, main

Relevant URL(s):
- https://www.namesilo.com/api

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import sys
import json
import requests
from _config import cfg

API_KEY  = cfg("namesilo", "api_key",  env="NAMESILO_API_KEY")
BASE_URL = cfg("namesilo", "base_url", default="https://www.namesilo.com/api")


def call(endpoint, **params):
    q = {"version": "1", "type": "json", "key": API_KEY}
    q.update(params)
    r = requests.get(f"{BASE_URL}/{endpoint}", params=q, timeout=30)
    r.raise_for_status()
    data = r.json()
    reply = data.get("reply", {})
    code = str(reply.get("code", ""))
    detail = reply.get("detail", "")
    if code != "300":
        raise RuntimeError(f"NameSilo API error {code}: {detail}")
    return data


def list_domains():
    return call("listDomains").get("reply", {}).get("domains", [])


def get_domain_info(domain):
    return call("getDomainInfo", domain=domain)


def check_registerability(domain):
    return call("checkRegisterAvailability", domains=domain)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "usage": "python namesilo_hook.py <list|info|check> [domain]"}, indent=2))
        sys.exit(1)
    action = sys.argv[1].lower()
    if action == "list":
        print(json.dumps({"ok": True, "domains": list_domains()}, indent=2))
    elif action == "info":
        if len(sys.argv) < 3:
            raise ValueError("domain required for info")
        print(json.dumps({"ok": True, "result": get_domain_info(sys.argv[2])}, indent=2))
    elif action == "check":
        if len(sys.argv) < 3:
            raise ValueError("domain required for check")
        print(json.dumps({"ok": True, "result": check_registerability(sys.argv[2])}, indent=2))
    else:
        raise ValueError(f"unknown action: {action}")


if __name__ == "__main__":
    main()
