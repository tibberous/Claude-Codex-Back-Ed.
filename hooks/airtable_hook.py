"""
Hook File: airtable_hook.py

What it does:
Airtable REST API wrapper — list records, create records, update records,
and delete records from any Airtable base/table.

How to use it:
  python airtable_hook.py list <base_id> <table_name>
  python airtable_hook.py create <base_id> <table_name> '{"Name": "Alice", "Status": "Active"}'
  python airtable_hook.py update <base_id> <table_name> <record_id> '{"Status": "Done"}'
  python airtable_hook.py delete <base_id> <table_name> <record_id>

Primary entry points:
list_records, create_record, update_record, delete_record, main

Relevant URL(s):
- https://airtable.com/developers/web/api/introduction
- Get a token: https://airtable.com/create/tokens
- Find base ID: in the base URL — airtable.com/appXXXXXXXXXXXXXX/...
"""

import os
import sys
import json
import argparse
import requests

API_BASE = "https://api.airtable.com/v0"
API_TOKEN = os.environ.get("AIRTABLE_API_TOKEN", "")


def _require_token():
    if not API_TOKEN:
        print(
            "ERROR: AIRTABLE_API_TOKEN is not set.\n"
            "Set the env var or set API_TOKEN in this file.\n"
            "Create a personal access token at: https://airtable.com/create/tokens",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_token()
    return {"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}


def list_records(base_id: str, table: str, max_records: int = 100, filter_formula: str = None):
    params = {"maxRecords": max_records}
    if filter_formula:
        params["filterByFormula"] = filter_formula
    r = requests.get(f"{API_BASE}/{base_id}/{table}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    records = r.json().get("records", [])
    print(json.dumps(records, indent=2))
    return records


def create_record(base_id: str, table: str, fields: dict):
    payload = {"fields": fields}
    r = requests.post(f"{API_BASE}/{base_id}/{table}", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()
    record = r.json()
    print(json.dumps({"ok": True, "id": record["id"], "fields": record["fields"]}, indent=2))
    return record


def update_record(base_id: str, table: str, record_id: str, fields: dict):
    payload = {"fields": fields}
    r = requests.patch(  # monkeypatch-ok: HTTP PATCH method, not monkey patch
        f"{API_BASE}/{base_id}/{table}/{record_id}", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()
    record = r.json()
    print(json.dumps({"ok": True, "id": record["id"], "fields": record["fields"]}, indent=2))
    return record


def delete_record(base_id: str, table: str, record_id: str):
    r = requests.delete(f"{API_BASE}/{base_id}/{table}/{record_id}", headers=_headers(), timeout=30)
    r.raise_for_status()
    data = r.json()
    print(json.dumps({"ok": True, "deleted": data.get("deleted"), "id": data.get("id")}, indent=2))
    return data


def main():
    parser = argparse.ArgumentParser(description="Airtable API hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("base_id")
    p_list.add_argument("table")
    p_list.add_argument("--max", type=int, default=100)
    p_list.add_argument("--filter")

    p_create = sub.add_parser("create")
    p_create.add_argument("base_id")
    p_create.add_argument("table")
    p_create.add_argument("fields_json")

    p_update = sub.add_parser("update")
    p_update.add_argument("base_id")
    p_update.add_argument("table")
    p_update.add_argument("record_id")
    p_update.add_argument("fields_json")

    p_delete = sub.add_parser("delete")
    p_delete.add_argument("base_id")
    p_delete.add_argument("table")
    p_delete.add_argument("record_id")

    args = parser.parse_args()
    if args.action == "list":
        list_records(args.base_id, args.table, args.max, args.filter)
    elif args.action == "create":
        create_record(args.base_id, args.table, json.loads(args.fields_json))
    elif args.action == "update":
        update_record(args.base_id, args.table, args.record_id, json.loads(args.fields_json))
    elif args.action == "delete":
        delete_record(args.base_id, args.table, args.record_id)


if __name__ == "__main__":
    main()
