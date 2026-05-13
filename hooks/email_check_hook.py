"""
Hook File: email_check_hook.py

What it does:
Connects to IMAP, decodes message headers and bodies, and returns a compact list of recent inbox messages.

How to use it:
Run it as a mailbox inspection helper after setting valid IMAP credentials in the file.

Primary entry points:
decode_mime, get_text_from_message, list_latest

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import imaplib
import email
from email.header import decode_header
from email.utils import parsedate_to_datetime
import json
import re

from _config import cfg

IMAP_SERVER    = cfg("email", "imap_server",   default="imap.gmail.com")
IMAP_PORT      = int(cfg("email", "imap_port", default="993"))
EMAIL_ACCOUNT  = cfg("email", "account",       env="EMAIL_ACCOUNT")
EMAIL_PASSWORD = cfg("email", "password",      env="EMAIL_PASSWORD")

def decode_mime(value):
    if not value:
        return ''
    parts = decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            out.append(text.decode(enc or 'utf-8', errors='replace'))
        else:
            out.append(text)
    return ''.join(out)

def get_text_from_message(msg):
    texts = []
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get('Content-Disposition', ''))
            if 'attachment' in content_disposition.lower():
                continue
            if content_type == 'text/plain':
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or 'utf-8'
                    texts.append(payload.decode(charset, errors='replace'))
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or 'utf-8'
            texts.append(payload.decode(charset, errors='replace'))
    text = '\n'.join(texts).strip()
    text = re.sub(r'\s+', ' ', text)
    return text[:400]

def list_latest(limit=20):
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_ACCOUNT, EMAIL_PASSWORD)
    mail.select('INBOX')
    status, data = mail.search(None, 'ALL')
    if status != 'OK':
        raise Exception('Failed to search inbox')
    ids = data[0].split()
    ids = ids[-limit:][::-1]
    results = []
    for msg_id in ids:
        status, msg_data = mail.fetch(msg_id, '(RFC822)')
        if status != 'OK':
            continue
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        subject = decode_mime(msg.get('Subject', ''))
        sender = decode_mime(msg.get('From', ''))
        date_raw = msg.get('Date', '')
        try:
            date_iso = parsedate_to_datetime(date_raw).isoformat()
        except Exception:
            date_iso = date_raw
        results.append({
            'id': msg_id.decode(),
            'from': sender,
            'subject': subject,
            'date': date_iso,
            'snippet': get_text_from_message(msg)
        })
    mail.logout()
    return results

if __name__ == '__main__':
    print(json.dumps(list_latest(20), indent=2))
