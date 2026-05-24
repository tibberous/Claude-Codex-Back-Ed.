#!/usr/bin/env python3
"""email_watch.py — poll an IMAP inbox until a matching message arrives.

The missing piece between imap_read.py (one-shot fetch) and claude_oauth.py
(needs a magic-link URL). When claude.ai sends a sign-in link to a
yahoo/hotmail/gmail address, this script:

  1. Snapshots the existing IMAP UIDs so old messages don't trigger a hit.
  2. Polls every --interval seconds for NEW UIDs matching --from-filter
     and (optionally) --subject-filter.
  3. When a hit lands, extracts the URL via --extract-links regex.
  4. Prints one JSON object and exits 0.

Long-running, --timeout-bounded, stdlib only (imaplib + email + ssl + re).
Shares the provider table with imap_read.py.

Usage examples:

  # Watch user@yahoo.com for a new anthropic.com sign-in email; quit after
  # the first matching message lands (or after 5 min idle):
  python email_watch.py --provider yahoo --email user@yahoo.com \\
      --password-env IMAP_PWD --from-filter "anthropic.com" \\
      --extract-links "https://claude\\.(?:ai|com)/[^ \\"<>]+" \\
      --timeout 300

  # Same idea but on gmail with a subject narrower:
  python email_watch.py --provider gmail --email me@gmail.com \\
      --password-env IMAP_PWD --from-filter "anthropic.com" \\
      --subject-filter "sign in" --extract-links "https://claude\\.[^ \\"<>]+"

Output (stdout, one line):
  on hit  : {"ok":true,"found":true,"from":"...","subject":"...","date":"...",
             "links":["https://claude.ai/..."], "uid":"123", "wait_seconds": N}
  timeout : {"ok":true,"found":false,"reason":"timeout","waited_seconds":N}
  error   : {"ok":false,"error":"<msg>"}

Exit codes: 0 ok, 1 bad args, 2 IMAP/network failure.
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
import time
from email.policy import default as email_policy

# Same provider table shape as imap_read.py — keep in sync if you edit one.
PROVIDERS = {
    "gmail":   ("imap.gmail.com",        993),
    "yahoo":   ("imap.mail.yahoo.com",   993),
    "hotmail": ("outlook.office365.com", 993),
    "outlook": ("outlook.office365.com", 993),
}


def _login(provider: str, email_addr: str, password: str) -> imaplib.IMAP4_SSL:
    host, port = PROVIDERS[provider]
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(host=host, port=port, ssl_context=ctx)
    conn.login(email_addr, password)
    conn.select("INBOX")
    return conn


def _uid_search(conn: imaplib.IMAP4_SSL, from_filter: str = "") -> set[bytes]:
    """UID search — UIDs are stable across sessions; sequence numbers are
    not. Returns a set so set-diff against prior snapshot is cheap."""
    crit = ["ALL"]
    if from_filter:
        crit = ["FROM", from_filter]
    status, data = conn.uid("SEARCH", None, *crit)
    if status != "OK" or not data or not data[0]:
        return set()
    return set(data[0].split())


def _fetch_one(conn: imaplib.IMAP4_SSL, uid: bytes):
    status, data = conn.uid("FETCH", uid, "(RFC822)")
    if status != "OK" or not data:
        return None
    for part in data:
        if isinstance(part, tuple) and len(part) >= 2:
            return email.message_from_bytes(part[1], policy=email_policy)
    return None


def _extract_text(msg) -> str:
    if msg is None:
        return ""
    if not msg.is_multipart():
        try: return msg.get_content() or ""
        except Exception: return ""
    for part in msg.walk():
        if part.get_content_type() == "text/plain":
            try: return part.get_content() or ""
            except Exception: continue
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            try: return part.get_content() or ""
            except Exception: continue
    return ""


def _emit(payload: dict) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if payload.get("ok") else 2


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", default="")
    ap.add_argument("--password-env", default="",
                    help="Env var name holding the IMAP password (preferred).")
    ap.add_argument("--from-filter", default="",
                    help="IMAP FROM substring filter (e.g. 'anthropic.com').")
    ap.add_argument("--subject-filter", default="",
                    help="Python-level subject substring (case-insensitive).")
    ap.add_argument("--extract-links", default="",
                    help="Regex applied to the body to pull URLs out.")
    ap.add_argument("--interval", type=float, default=5.0,
                    help="Poll interval in seconds (default 5).")
    ap.add_argument("--timeout", type=float, default=300.0,
                    help="Give up after this many seconds (default 300).")
    args = ap.parse_args()

    pw = ""
    if args.password_env:
        pw = os.environ.get(args.password_env, "")
        if not pw:
            return _emit({"ok": False, "error": f"env var {args.password_env!r} empty/unset"})
    elif args.password:
        pw = args.password
    else:
        return _emit({"ok": False, "error": "no password (use --password or --password-env)"})

    rx = None
    if args.extract_links:
        try: rx = re.compile(args.extract_links)
        except re.error as e:
            return _emit({"ok": False, "error": f"bad --extract-links regex: {e}"})

    try:
        conn = _login(args.provider, args.email, pw)
    except imaplib.IMAP4.error as e:
        return _emit({"ok": False, "error": f"IMAP login failed: {e}"})
    except Exception as e:
        return _emit({"ok": False, "error": f"connect failed: {type(e).__name__}: {e}"})

    # Snapshot existing matching UIDs so only NEW arrivals fire.
    try:
        baseline = _uid_search(conn, args.from_filter)
    except Exception as e:
        try: conn.logout()
        except Exception: pass
        return _emit({"ok": False, "error": f"baseline UID search failed: {e}"})

    t0 = time.monotonic()
    poll = max(1.0, float(args.interval))
    sub_lc = (args.subject_filter or "").lower()
    try:
        while True:
            waited = time.monotonic() - t0
            if waited >= args.timeout:
                return _emit({"ok": True, "found": False, "reason": "timeout",
                              "waited_seconds": round(waited, 1)})
            time.sleep(poll)
            # `NOOP` keeps long-lived IDLE-less sessions alive on most servers.
            try: conn.noop()
            except Exception: pass
            try:
                current = _uid_search(conn, args.from_filter)
            except Exception as e:
                return _emit({"ok": False, "error": f"poll UID search failed: {e}"})
            new_uids = sorted(current - baseline, key=lambda b: int(b))
            for uid in new_uids:
                msg = _fetch_one(conn, uid)
                if msg is None: continue
                subj = msg.get("Subject", "") or ""
                if sub_lc and sub_lc not in subj.lower():
                    continue
                body = _extract_text(msg)
                links = list(dict.fromkeys(rx.findall(body))) if rx else []
                return _emit({
                    "ok": True, "found": True,
                    "uid": uid.decode("ascii", "replace"),
                    "from": msg.get("From", "") or "",
                    "subject": subj,
                    "date": msg.get("Date", "") or "",
                    "links": links,
                    "wait_seconds": round(time.monotonic() - t0, 1),
                })
            # No matching new UID this tick — keep polling.
    finally:
        try: conn.logout()
        except Exception: pass


if __name__ == "__main__":
    raise SystemExit(main())
