"""
Hook File: google_sheets_hook.py

What it does:
Google Sheets API v4 wrapper — read cell ranges, append rows, update cells,
and clear ranges. Uses OAuth2 service account credentials.

How to use it:
  python google_sheets_hook.py read <spreadsheet_id> "Sheet1!A1:D10"
  python google_sheets_hook.py append <spreadsheet_id> "Sheet1" '["Alice", "30", "Engineer"]'
  python google_sheets_hook.py update <spreadsheet_id> "Sheet1!B2" '["updated value"]'
  python google_sheets_hook.py clear <spreadsheet_id> "Sheet1!A2:Z100"

Setup:
  1. Create a service account: https://console.cloud.google.com/iam-admin/serviceaccounts
  2. Enable Google Sheets API: https://console.cloud.google.com/apis/library/sheets.googleapis.com
  3. Download the service account JSON key
  4. Share your spreadsheet with the service account email (editor access)
  5. Set GOOGLE_SERVICE_ACCOUNT_JSON env var to the JSON key file path

Primary entry points:
read_range, append_row, update_range, clear_range, main

Relevant URL(s):
- https://developers.google.com/sheets/api/reference/rest
- Service account setup: https://console.cloud.google.com/iam-admin/serviceaccounts
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : google_sheets_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# PRIMARY ENTRY POINTS
#   - read_range
#   - append_row
#   - update_range
#   - clear_range
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
import os
import sys
import json
import argparse

SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"


def _require_credentials():
    if not SERVICE_ACCOUNT_JSON:
        print(
            "ERROR: GOOGLE_SERVICE_ACCOUNT_JSON is not set.\n"
            "Set it to the path of your service account key file.\n"
            "Create one at: https://console.cloud.google.com/iam-admin/serviceaccounts\n"
            "Then share your spreadsheet with the service account email.",
            file=sys.stderr,
        )
        sys.exit(1)


def _get_service():
    _require_credentials()
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build  # badimport-ok: import name provided by google-api-python-client
    except ImportError:
        print(
            "ERROR: google-auth and google-api-python-client are not installed.\n"
            "Install with:\n"
            "  pip install google-auth google-api-python-client",
            file=sys.stderr,
        )
        sys.exit(1)
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds).spreadsheets()


def read_range(spreadsheet_id: str, range_notation: str):
    svc = _get_service()
    result = svc.values().get(spreadsheetId=spreadsheet_id, range=range_notation).execute()
    values = result.get("values", [])
    print(json.dumps(values, indent=2))
    return values


def append_row(spreadsheet_id: str, sheet_name: str, row: list):
    svc = _get_service()
    body = {"values": [row]}
    result = svc.values().append(
        spreadsheetId=spreadsheet_id,
        range=sheet_name,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()
    updates = result.get("updates", {})
    print(json.dumps({"ok": True, "updatedRange": updates.get("updatedRange"), "updatedRows": updates.get("updatedRows")}))
    return result


def update_range(spreadsheet_id: str, range_notation: str, values: list):
    svc = _get_service()
    body = {"values": [values] if not isinstance(values[0], list) else values}
    result = svc.values().update(
        spreadsheetId=spreadsheet_id,
        range=range_notation,
        valueInputOption="USER_ENTERED",
        body=body,
    ).execute()
    print(json.dumps({"ok": True, "updatedRange": result.get("updatedRange"), "updatedCells": result.get("updatedCells")}))
    return result


def clear_range(spreadsheet_id: str, range_notation: str):
    svc = _get_service()
    result = svc.values().clear(spreadsheetId=spreadsheet_id, range=range_notation, body={}).execute()
    print(json.dumps({"ok": True, "clearedRange": result.get("clearedRange")}))
    return result


def main():
    parser = argparse.ArgumentParser(description="Google Sheets API hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_read = sub.add_parser("read")
    p_read.add_argument("spreadsheet_id")
    p_read.add_argument("range")

    p_append = sub.add_parser("append")
    p_append.add_argument("spreadsheet_id")
    p_append.add_argument("sheet")
    p_append.add_argument("row_json")

    p_update = sub.add_parser("update")
    p_update.add_argument("spreadsheet_id")
    p_update.add_argument("range")
    p_update.add_argument("values_json")

    p_clear = sub.add_parser("clear")
    p_clear.add_argument("spreadsheet_id")
    p_clear.add_argument("range")

    args = parser.parse_args()
    if args.action == "read":
        read_range(args.spreadsheet_id, args.range)
    elif args.action == "append":
        append_row(args.spreadsheet_id, args.sheet, json.loads(args.row_json))
    elif args.action == "update":
        update_range(args.spreadsheet_id, args.range, json.loads(args.values_json))
    elif args.action == "clear":
        clear_range(args.spreadsheet_id, args.range)


if __name__ == "__main__":
    main()
