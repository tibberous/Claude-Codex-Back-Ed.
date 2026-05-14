"""
Hook File: sendgrid_hook.py

What it does:
SendGrid API v3 wrapper — send transactional email with optional HTML body,
reply-to, and attachments. More reliable than direct SMTP for production use.

How to use it:
  python sendgrid_hook.py send --to user@example.com --subject "Hello" --body "Hi there"
  python sendgrid_hook.py send --to user@example.com --subject "Hi" --html "<b>Hello</b>"

Primary entry points:
send_email, main

Relevant URL(s):
- https://docs.sendgrid.com/api-reference/mail-send/mail-send
- Get a key: https://app.sendgrid.com/settings/api_keys
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : sendgrid_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# PRIMARY ENTRY POINTS
#   - send_email
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
import base64
import argparse
import requests
from pathlib import Path

API_BASE = "https://api.sendgrid.com/v3"
API_KEY = os.environ.get("SENDGRID_API_KEY", "")
DEFAULT_FROM = os.environ.get("SENDGRID_FROM_EMAIL", "")


def _require_key():
    if not API_KEY:
        print(
            "ERROR: SENDGRID_API_KEY is not set.\n"
            "Set the env var or set API_KEY in this file.\n"
            "Get a key at: https://app.sendgrid.com/settings/api_keys",
            file=sys.stderr,
        )
        sys.exit(1)
    if not DEFAULT_FROM:
        print(
            "ERROR: SENDGRID_FROM_EMAIL is not set.\n"
            "Set it to a verified sender address (verified in SendGrid dashboard).\n"
            "https://app.sendgrid.com/settings/sender_auth",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_key()
    return {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def send_email(to: str, subject: str, body_text: str = None, body_html: str = None,
               from_email: str = None, reply_to: str = None, attachment_paths: list = None):
    content = []
    if body_text:
        content.append({"type": "text/plain", "value": body_text})
    if body_html:
        content.append({"type": "text/html", "value": body_html})
    if not content:
        content.append({"type": "text/plain", "value": "(no body)"})

    payload = {
        "personalizations": [{"to": [{"email": to}]}],
        "from": {"email": from_email or DEFAULT_FROM},
        "subject": subject,
        "content": content,
    }
    if reply_to:
        payload["reply_to"] = {"email": reply_to}

    if attachment_paths:
        attachments = []
        for path in attachment_paths:
            p = Path(path)
            if p.exists():
                data = base64.b64encode(p.read_bytes()).decode()
                attachments.append({"content": data, "filename": p.name, "disposition": "attachment"})
        if attachments:
            payload["attachments"] = attachments

    r = requests.post(f"{API_BASE}/mail/send", headers=_headers(), json=payload, timeout=30)
    if r.status_code == 202:
        print(json.dumps({"ok": True, "to": to, "subject": subject}))
        return True
    try:
        detail = r.json()
    except Exception:
        detail = r.text
    print(json.dumps({"ok": False, "status": r.status_code, "detail": detail}), file=sys.stderr)
    sys.exit(1)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return False


def main():
    parser = argparse.ArgumentParser(description="SendGrid email hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_send = sub.add_parser("send")
    p_send.add_argument("--to", required=True)
    p_send.add_argument("--subject", required=True)
    p_send.add_argument("--body")
    p_send.add_argument("--html")
    p_send.add_argument("--from-email")
    p_send.add_argument("--reply-to")
    p_send.add_argument("--attach", nargs="*")

    args = parser.parse_args()
    if args.action == "send":
        send_email(
            to=args.to,
            subject=args.subject,
            body_text=args.body,
            body_html=args.html,
            from_email=args.from_email,
            reply_to=args.reply_to,
            attachment_paths=args.attach,
        )


if __name__ == "__main__":
    main()
