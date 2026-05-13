"""
Hook File: cloudflare_hook.py

What it does:
Cloudflare API v4 wrapper — list zones, create/delete/list DNS records,
purge cache, and get zone analytics.

How to use it:
  python cloudflare_hook.py zones
  python cloudflare_hook.py dns list <zone_id>
  python cloudflare_hook.py dns add <zone_id> --type A --name sub.example.com --content 1.2.3.4
  python cloudflare_hook.py dns delete <zone_id> <record_id>
  python cloudflare_hook.py purge <zone_id> --urls https://example.com/page

Primary entry points:
list_zones, list_dns, add_dns, delete_dns, purge_cache, main

Relevant URL(s):
- https://developers.cloudflare.com/api/
- Get a token: https://dash.cloudflare.com/profile/api-tokens
"""

import os
import sys
import json
import argparse
import requests

API_BASE = "https://api.cloudflare.com/client/v4"
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")


def _require_token():
    if not API_TOKEN:
        print(
            "ERROR: CLOUDFLARE_API_TOKEN is not set.\n"
            "Set the env var or set API_TOKEN in this file.\n"
            "Get a token at: https://dash.cloudflare.com/profile/api-tokens",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_token()
    return {"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}


def _get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        print(json.dumps(data.get("errors", [])), file=sys.stderr)
        sys.exit(1)
    return data["result"]


def _post(path, payload):
    r = requests.post(f"{API_BASE}{path}", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        print(json.dumps(data.get("errors", [])), file=sys.stderr)
        sys.exit(1)
    return data["result"]


def _delete(path):
    r = requests.delete(f"{API_BASE}{path}", headers=_headers(), timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        print(json.dumps(data.get("errors", [])), file=sys.stderr)
        sys.exit(1)
    return data["result"]


def list_zones():
    zones = _get("/zones", {"per_page": 50})
    result = [{"id": z["id"], "name": z["name"], "status": z["status"]} for z in zones]
    print(json.dumps(result, indent=2))
    return result


def list_dns(zone_id: str):
    records = _get(f"/zones/{zone_id}/dns_records", {"per_page": 100})
    print(json.dumps(records, indent=2))
    return records


def add_dns(zone_id: str, record_type: str, name: str, content: str, ttl: int = 1, proxied: bool = False):
    payload = {"type": record_type.upper(), "name": name, "content": content, "ttl": ttl, "proxied": proxied}
    result = _post(f"/zones/{zone_id}/dns_records", payload)
    print(json.dumps({"ok": True, "id": result["id"], "name": result["name"], "type": result["type"]}, indent=2))
    return result


def delete_dns(zone_id: str, record_id: str):
    result = _delete(f"/zones/{zone_id}/dns_records/{record_id}")
    print(json.dumps({"ok": True, "deleted_id": record_id}))
    return result


def purge_cache(zone_id: str, urls: list = None):
    payload = {"purge_everything": True} if not urls else {"files": urls}
    result = _post(f"/zones/{zone_id}/purge_cache", payload)
    print(json.dumps({"ok": True, "result": result}))
    return result


def main():
    parser = argparse.ArgumentParser(description="Cloudflare API hook")
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("zones")

    p_dns = sub.add_parser("dns")
    dns_sub = p_dns.add_subparsers(dest="dns_action", required=True)

    p_dns_list = dns_sub.add_parser("list")
    p_dns_list.add_argument("zone_id")

    p_dns_add = dns_sub.add_parser("add")
    p_dns_add.add_argument("zone_id")
    p_dns_add.add_argument("--type", required=True)
    p_dns_add.add_argument("--name", required=True)
    p_dns_add.add_argument("--content", required=True)
    p_dns_add.add_argument("--ttl", type=int, default=1)
    p_dns_add.add_argument("--proxied", action="store_true")

    p_dns_del = dns_sub.add_parser("delete")
    p_dns_del.add_argument("zone_id")
    p_dns_del.add_argument("record_id")

    p_purge = sub.add_parser("purge")
    p_purge.add_argument("zone_id")
    p_purge.add_argument("--urls", nargs="*")

    args = parser.parse_args()
    if args.action == "zones":
        list_zones()
    elif args.action == "dns":
        if args.dns_action == "list":
            list_dns(args.zone_id)
        elif args.dns_action == "add":
            add_dns(args.zone_id, args.type, args.name, args.content, args.ttl, args.proxied)
        elif args.dns_action == "delete":
            delete_dns(args.zone_id, args.record_id)
    elif args.action == "purge":
        purge_cache(args.zone_id, args.urls)


if __name__ == "__main__":
    main()
