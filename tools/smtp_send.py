#!/usr/bin/env python3
"""smtp_send.py — send email via SMTP SSL/STARTTLS (gmail / yahoo / outlook).

The send-side counterpart to imap_read.py. Same provider table shape, same
JSON-on-stdout convention. Built for CBE's multi-account email client
(2026-05-24 pivot) — supports attachments, plain + HTML bodies, multiple
recipients via comma-separated CLI args.

Stdlib only — `smtplib`, `email.message`, `ssl`, `mimetypes`, `os`, `pathlib`.
No pip install.

App-password note: gmail/yahoo/outlook all require an APP PASSWORD (not the
account password) for SMTP submission when 2FA is enabled. Generate at:
  gmail   : https://myaccount.google.com/apppasswords
  yahoo   : https://login.yahoo.com/account/security/app-passwords
  outlook : https://account.live.com/proofs/AppPassword

Usage:
    # Plain text, single recipient
    python smtp_send.py --provider gmail --email me@gmail.com \\
        --password-env SMTP_PWD --to alice@example.com \\
        --subject "hello" --body "first body line"

    # HTML + multiple to/cc/bcc + attachments
    python smtp_send.py --provider yahoo --email me@yahoo.com \\
        --password-env SMTP_PWD \\
        --to "a@b.com,c@d.com" --cc admin@e.com --bcc me2@yahoo.com \\
        --subject "report" --body-html "<h1>Hi</h1><p>see attached</p>" \\
        --attach report.pdf --attach chart.png

Output (stdout): one JSON object
    {"ok": true, "accepted": [...], "refused": {...}, "message_id": "..."}
    or {"ok": false, "error": "<reason>"}

Exit codes:
    0 = ok (all recipients accepted)
    1 = bad args
    2 = SMTP login/send failed (or some recipients refused)
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import smtplib
import ssl
import sys
import uuid
from email.message import EmailMessage
from pathlib import Path

# Provider → (host, ssl_port, starttls_port). ssl_port uses smtplib.SMTP_SSL;
# starttls_port uses smtplib.SMTP + .starttls(). Submission ports per
# RFC 6409 (587 STARTTLS) and RFC 8314 (465 implicit-SSL).
PROVIDERS = {
    "gmail":   ("smtp.gmail.com",        465, 587),
    "yahoo":   ("smtp.mail.yahoo.com",   465, 587),
    "outlook": ("smtp-mail.outlook.com",   0, 587),  # outlook only does STARTTLS
    "hotmail": ("smtp-mail.outlook.com",   0, 587),
}


def _split_addrs(s: str) -> list[str]:
    """Split a comma-or-semicolon-separated address list; trim whitespace;
    drop empties. Preserves order and de-dupes while keeping first occurrence."""
    if not s:
        return []
    raw = [x.strip() for x in s.replace(";", ",").split(",")]
    seen: set[str] = set()
    out: list[str] = []
    for a in raw:
        if a and a not in seen:
            seen.add(a); out.append(a)
    return out


def _build_message(
    sender: str,
    to: list[str], cc: list[str], bcc: list[str],
    subject: str, body: str = "", body_html: str = "",
    attachments: list[Path] | None = None,
    reply_to: str = "",
) -> EmailMessage:
    """Construct a multipart/alternative + multipart/mixed message. Plain
    body is always present (auto-derived from HTML if not provided) so
    spam filters don't penalize the message. BCC is NOT added to headers —
    it goes only into the smtplib `to_addrs` list."""
    msg = EmailMessage()
    msg["From"]    = sender
    msg["To"]      = ", ".join(to)
    if cc: msg["Cc"] = ", ".join(cc)
    if reply_to: msg["Reply-To"] = reply_to
    msg["Subject"] = subject or ""
    # Stable, RFC 5322-style Message-ID so the caller can correlate.
    domain = sender.partition("@")[2] or "localhost"
    mid = f"<{uuid.uuid4()}@{domain}>"
    msg["Message-ID"] = mid

    if body_html:
        # If no plain body supplied, fall back to a stripped-tags version
        # of the HTML rather than leaving plain empty.
        if not body:
            import re as _re
            body = _re.sub(r"<[^>]+>", "", body_html).strip()
        msg.set_content(body or " ")
        msg.add_alternative(body_html, subtype="html")
    else:
        msg.set_content(body or " ")

    for path in (attachments or []):
        ctype, encoding = mimetypes.guess_type(str(path))
        if ctype is None or encoding is not None:
            ctype = "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        with open(path, "rb") as f:
            msg.add_attachment(
                f.read(),
                maintype=maintype, subtype=subtype,
                filename=path.name,
            )
    return msg


def smtp_send(
    provider: str, email_addr: str, password: str,
    msg: EmailMessage, recipients: list[str],
    prefer: str = "ssl",
) -> dict:
    """Send `msg` to `recipients` using `provider`'s SMTP. `prefer` is
    "ssl" (try implicit-SSL :465 first) or "starttls" (try :587 first).
    Returns smtplib's refused dict (empty on full success)."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider: {provider!r}")
    host, ssl_port, tls_port = PROVIDERS[provider]
    ctx = ssl.create_default_context()
    last_err: Exception | None = None
    attempts: list[tuple[str, int]] = []
    if prefer == "ssl" and ssl_port:
        attempts.append(("ssl", ssl_port))
    if tls_port:
        attempts.append(("starttls", tls_port))
    if prefer == "starttls" and ssl_port:
        attempts.append(("ssl", ssl_port))
    for mode, port in attempts:
        try:
            if mode == "ssl":
                with smtplib.SMTP_SSL(host=host, port=port, context=ctx,
                                       timeout=30) as s:
                    s.login(email_addr, password)
                    refused = s.send_message(msg, from_addr=email_addr,
                                             to_addrs=recipients)
            else:
                with smtplib.SMTP(host=host, port=port, timeout=30) as s:
                    s.ehlo()
                    s.starttls(context=ctx)
                    s.ehlo()
                    s.login(email_addr, password)
                    refused = s.send_message(msg, from_addr=email_addr,
                                             to_addrs=recipients)
            return refused
        except (smtplib.SMTPException, OSError) as e:
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("no SMTP attempts made")


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    ap.add_argument("--email", required=True, help="From: address (also the login).")
    ap.add_argument("--password", default="")
    ap.add_argument("--password-env", default="",
                    help="Env var name holding the SMTP password (preferred).")
    ap.add_argument("--to", required=True, help="Comma- or semicolon-separated.")
    ap.add_argument("--cc", default="")
    ap.add_argument("--bcc", default="")
    ap.add_argument("--reply-to", default="")
    ap.add_argument("--subject", default="")
    ap.add_argument("--body", default="", help="Plain text body.")
    ap.add_argument("--body-html", default="", help="HTML body (optional).")
    ap.add_argument("--attach", action="append", default=[],
                    help="Path to an attachment. May be repeated.")
    ap.add_argument("--prefer", choices=("ssl", "starttls"), default="ssl",
                    help="Which submission port to try first.")
    args = ap.parse_args()

    pw = ""
    if args.password_env:
        pw = os.environ.get(args.password_env, "")
        if not pw:
            _emit({"ok": False, "error": f"env var {args.password_env!r} empty/unset"}); return 1
    elif args.password:
        pw = args.password
    else:
        _emit({"ok": False, "error": "no password (use --password or --password-env)"}); return 1

    to  = _split_addrs(args.to)
    cc  = _split_addrs(args.cc)
    bcc = _split_addrs(args.bcc)
    if not to:
        _emit({"ok": False, "error": "no valid --to recipients"}); return 1
    recipients = list(dict.fromkeys(to + cc + bcc))   # de-dupe, preserve order

    attachments: list[Path] = []
    for p in args.attach:
        path = Path(p).expanduser().resolve()
        if not path.is_file():
            _emit({"ok": False, "error": f"attachment not found: {p}"}); return 1
        attachments.append(path)

    try:
        msg = _build_message(
            sender=args.email, to=to, cc=cc, bcc=bcc,
            subject=args.subject, body=args.body, body_html=args.body_html,
            attachments=attachments, reply_to=args.reply_to,
        )
    except Exception as e:
        _emit({"ok": False, "error": f"build_message failed: {type(e).__name__}: {e}"}); return 1

    try:
        refused = smtp_send(args.provider, args.email, pw, msg, recipients, prefer=args.prefer)
    except smtplib.SMTPAuthenticationError as e:
        _emit({"ok": False, "error": f"auth failed: {e.smtp_code} {e.smtp_error!r}"}); return 2
    except smtplib.SMTPException as e:
        _emit({"ok": False, "error": f"SMTP error: {type(e).__name__}: {e}"}); return 2
    except OSError as e:
        _emit({"ok": False, "error": f"network: {type(e).__name__}: {e}"}); return 2

    accepted = [r for r in recipients if r not in (refused or {})]
    _emit({
        "ok":          not refused,
        "accepted":    accepted,
        "refused":     refused or {},
        "message_id":  msg["Message-ID"],
        "provider":    args.provider,
    })
    return 0 if not refused else 2


if __name__ == "__main__":
    raise SystemExit(main())
