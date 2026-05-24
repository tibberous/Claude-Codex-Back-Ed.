#!/usr/bin/env python3
"""imap_read.py — read recent email via IMAP SSL (gmail / yahoo / hotmail / outlook).

Built for the CBE bridge magic-link auto-rotation flow: when claude.ai sends a
sign-in email to a yahoo/hotmail/gmail inbox, this script polls the inbox,
finds the email, extracts the magic-link URL, and prints it as JSON so
extension.js / a bridge tray exe can click it inside the bridge's QtWebEngine.

Stdlib only — `imaplib`, `email`, `ssl`, `re`. No pip install required.

App-password note: gmail/yahoo/hotmail all require an APP PASSWORD (not the
account password) for IMAP access when 2FA is enabled. Generate at:
  gmail   : https://myaccount.google.com/apppasswords
  yahoo   : https://login.yahoo.com/account/security/app-passwords
  hotmail : https://account.live.com/proofs/AppPassword

Usage examples:
    # Watch for a claude.ai magic-link email from the last 5 minutes
    python imap_read.py --provider yahoo --email user@yahoo.com \\
        --password "APP_PWD" --since-minutes 5 \\
        --from-filter "anthropic.com" \\
        --extract-links "https://claude\\.ai/[A-Za-z0-9_\\-./?=&]+"

    # Same idea for hotmail, with a subject filter
    python imap_read.py --provider hotmail --email user@hotmail.com \\
        --password "APP_PWD" --since-minutes 5 \\
        --subject-filter "sign in" \\
        --extract-links "https://claude\\.ai/[A-Za-z0-9_\\-./?=&]+"

Output (stdout): one JSON object
    {"ok": true, "count": N, "emails": [
        {"from": "...", "subject": "...", "date": "...", "links": [...], "body_preview": "..."},
        ...
    ]}
    Or on error: {"ok": false, "error": "<reason>"}

Exit codes:
    0 = ok (count may be 0 — no matching emails yet)
    1 = bad args
    2 = IMAP login or fetch failed

Security:
- Password is read from --password OR from --password-env (preferred —
  set IMAP_PASSWORD in env so it never hits the process command line).
- Never echoes the password back. Never writes the password anywhere.
- Body preview is capped at 500 chars to avoid leaking secrets in logs.
"""
from __future__ import annotations

import argparse
import email
import imaplib
import json
import os
import re
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.policy import default as email_policy

# Provider → (IMAP host, port). All use implicit SSL on 993.
PROVIDERS = {
    "gmail":   ("imap.gmail.com",        993),
    "yahoo":   ("imap.mail.yahoo.com",   993),
    "hotmail": ("outlook.office365.com", 993),
    "outlook": ("outlook.office365.com", 993),
}


def imap_login(provider: str, email_addr: str, password: str) -> imaplib.IMAP4_SSL:
    """Open an IMAP4_SSL connection + LOGIN. Raises on auth failure."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider: {provider!r} (choose: {sorted(PROVIDERS)})")
    host, port = PROVIDERS[provider]
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(host=host, port=port, ssl_context=ctx)
    conn.login(email_addr, password)
    return conn


def search_recent(conn: imaplib.IMAP4_SSL, since_minutes: int, from_filter: str = "") -> list[bytes]:
    """Return INBOX message IDs newer than `since_minutes`, optionally
    restricted to a `FROM <substring>` IMAP filter. IMAP's SINCE is
    date-granular (no time-of-day), so 'since-minutes' really means
    'since the start of the day that contains <now - N minutes>'."""
    conn.select("INBOX")
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(minutes=since_minutes))
    crit = ["SINCE", cutoff.strftime("%d-%b-%Y")]
    if from_filter:
        crit += ["FROM", from_filter]
    status, data = conn.search(None, *crit)
    if status != "OK" or not data or not data[0]:
        return []
    return data[0].split()


def fetch_msg(conn: imaplib.IMAP4_SSL, msg_id: bytes):
    """Return the parsed email.message.EmailMessage for msg_id, or None on
    fetch failure."""
    status, data = conn.fetch(msg_id, "(RFC822)")
    if status != "OK" or not data:
        return None
    raw = None
    for part in data:
        if isinstance(part, tuple) and len(part) >= 2:
            raw = part[1]; break
    if not raw:
        return None
    return email.message_from_bytes(raw, policy=email_policy)


def extract_text(msg) -> str:
    """Return the message body as plain text. Prefers text/plain, falls
    back to text/html. Returns '' if the message has no readable body."""
    if msg is None:
        return ""
    if not msg.is_multipart():
        try: return msg.get_content() or ""
        except Exception: return ""
    # multipart — prefer text/plain
    for part in msg.walk():
        if part.get_content_type() == "text/plain":
            try: return part.get_content() or ""
            except Exception: continue
    # fall back to text/html (raw HTML; caller can strip tags or grep links)
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            try: return part.get_content() or ""
            except Exception: continue
    return ""


def _emit(payload: dict) -> None:
    """Single JSON object to stdout, one line. Caller parses with json.loads.

    Writes via sys.stdout.buffer with explicit UTF-8 encoding so emojis +
    accented chars in email subjects/bodies don't crash on Windows, where
    sys.stdout is bound to cp1252 by default. Caller is Node — it reads
    bytes off the pipe + does utf-8 decoding itself, so this is the right
    layer to encode at. `errors="replace"` keeps the call from blowing up
    on the rare unpaired surrogate.
    """
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    try:
        sys.stdout.buffer.write(line.encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    except AttributeError:
        # Some embedded interpreters strip .buffer — fall back to the text
        # layer but ascii-escape everything so we can't hit a cp1252 wall.
        sys.stdout.write(json.dumps(payload, ensure_ascii=True))
        sys.stdout.write("\n")
        sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS),
                    help="Email provider (drives the IMAP host).")
    ap.add_argument("--email", required=True, help="Email address to log in as.")
    ap.add_argument("--password", default="",
                    help="App password (prefer --password-env to avoid putting "
                         "it on the command line / in shell history).")
    ap.add_argument("--password-env", default="",
                    help="Name of an env var that holds the password "
                         "(e.g. IMAP_PASSWORD). Takes precedence over --password.")
    ap.add_argument("--since-minutes", type=int, default=5,
                    help="Only consider emails newer than this many minutes "
                         "(IMAP SINCE is date-granular; this is a lower bound).")
    ap.add_argument("--from-filter", default="",
                    help="IMAP-level filter on From: header substring.")
    ap.add_argument("--subject-filter", default="",
                    help="Python-level filter on Subject: substring "
                         "(case-insensitive).")
    ap.add_argument("--extract-links", default="",
                    help="Regex applied to each email body to pull URLs out "
                         "(e.g. 'https://claude\\.ai/[^ \"<>]+').")
    ap.add_argument("--max", type=int, default=10,
                    help="Cap returned emails (most recent kept).")
    args = ap.parse_args()

    # password resolution: env var wins, then literal --password, then fail
    pw = ""
    if args.password_env:
        pw = os.environ.get(args.password_env, "")
        if not pw:
            _emit({"ok": False, "error": f"env var {args.password_env!r} is empty or unset"})
            return 1
    elif args.password:
        pw = args.password
    else:
        _emit({"ok": False, "error": "no password supplied (use --password or --password-env)"})
        return 1

    # login
    try:
        conn = imap_login(args.provider, args.email, pw)
    except imaplib.IMAP4.error as e:
        _emit({"ok": False, "error": f"IMAP login failed: {e}"})
        return 2
    except Exception as e:
        _emit({"ok": False, "error": f"connect failed: {type(e).__name__}: {e}"})
        return 2

    out: list[dict] = []
    rx = None
    if args.extract_links:
        try:
            rx = re.compile(args.extract_links)
        except re.error as e:
            try: conn.logout()
            except Exception: pass
            _emit({"ok": False, "error": f"bad --extract-links regex: {e}"})
            return 1

    try:
        ids = search_recent(conn, args.since_minutes, args.from_filter)
        # most recent first; cap at --max
        for msg_id in reversed(ids[-args.max:]):
            msg = fetch_msg(conn, msg_id)
            if msg is None:
                continue
            subj = msg.get("Subject", "") or ""
            if args.subject_filter and args.subject_filter.lower() not in subj.lower():
                continue
            body = extract_text(msg)
            links = []
            if rx is not None:
                links = list(dict.fromkeys(rx.findall(body)))[:10]
            out.append({
                "from": msg.get("From", "") or "",
                "subject": subj,
                "date": msg.get("Date", "") or "",
                "links": links,
                "body_preview": body[:500],
            })
    finally:
        try: conn.logout()
        except Exception: pass

    _emit({"ok": True, "count": len(out), "emails": out})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
