"""
Hook File: twilio_hook.py

What it does:
Twilio REST API wrapper — send SMS, check message status, and list
recent messages. Uses Basic Auth (AccountSid:AuthToken).

How to use it:
  python twilio_hook.py send --to +15551234567 --body "Hello"
  python twilio_hook.py status <MessageSid>
  python twilio_hook.py list

Primary entry points:
send_sms, get_status, list_messages, main

Relevant URL(s):
- https://www.twilio.com/docs/messaging/api/message-resource
- Get credentials: https://console.twilio.com/
"""

import os
import sys
import json
import argparse
import requests

ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "")


def _require_credentials():
    missing = [n for n, v in [("TWILIO_ACCOUNT_SID", ACCOUNT_SID), ("TWILIO_AUTH_TOKEN", AUTH_TOKEN)] if not v]
    if missing:
        print(
            f"ERROR: Missing Twilio credentials: {', '.join(missing)}\n"
            "Set them as environment variables or in this file.\n"
            "Get credentials at: https://console.twilio.com/",
            file=sys.stderr,
        )
        sys.exit(1)
    if not FROM_NUMBER:
        print(
            "ERROR: TWILIO_FROM_NUMBER is not set.\n"
            "Set it to your Twilio phone number (e.g. +15551234567).\n"
            "Buy a number at: https://console.twilio.com/us1/develop/phone-numbers/search",
            file=sys.stderr,
        )
        sys.exit(1)


def _base_url():
    return f"https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}"


def send_sms(to: str, body: str, from_number: str = None):
    _require_credentials()
    r = requests.post(
        f"{_base_url()}/Messages.json",
        auth=(ACCOUNT_SID, AUTH_TOKEN),
        data={"To": to, "From": from_number or FROM_NUMBER, "Body": body},
        timeout=30,
    )
    data = r.json()
    if not r.ok:
        print(json.dumps({"ok": False, "error": data}, indent=2), file=sys.stderr)
        sys.exit(1)
    result = {"ok": True, "sid": data["sid"], "status": data["status"], "to": data["to"]}
    print(json.dumps(result, indent=2))
    return result


def get_status(message_sid: str):
    _require_credentials()
    r = requests.get(
        f"{_base_url()}/Messages/{message_sid}.json",
        auth=(ACCOUNT_SID, AUTH_TOKEN),
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    print(json.dumps({"sid": data["sid"], "status": data["status"], "error_code": data.get("error_code")}, indent=2))
    return data


def list_messages(limit: int = 20):
    _require_credentials()
    r = requests.get(
        f"{_base_url()}/Messages.json",
        auth=(ACCOUNT_SID, AUTH_TOKEN),
        params={"PageSize": limit},
        timeout=30,
    )
    r.raise_for_status()
    msgs = r.json().get("messages", [])
    result = [{"sid": m["sid"], "to": m["to"], "from": m["from"], "status": m["status"], "body": m["body"][:80]} for m in msgs]
    print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="Twilio SMS hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_send = sub.add_parser("send")
    p_send.add_argument("--to", required=True)
    p_send.add_argument("--body", required=True)
    p_send.add_argument("--from-number")

    p_status = sub.add_parser("status")
    p_status.add_argument("sid")

    p_list = sub.add_parser("list")
    p_list.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()
    if args.action == "send":
        send_sms(args.to, args.body, getattr(args, "from_number", None))
    elif args.action == "status":
        get_status(args.sid)
    elif args.action == "list":
        list_messages(args.limit)


if __name__ == "__main__":
    main()
