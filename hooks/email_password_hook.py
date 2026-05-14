"""
Hook File: email_password_hook.py

What it does:
Combined SMTP and IMAP utility for sending mail, listing messages, reading message bodies, trashing messages, and toggling read state.

How to use it:
Import the helper functions or run it with valid mailbox credentials configured in the constants section.

Primary entry points:
decode_mime, _extract_text, send_email, _connect_imap, list_messages, read_message, move_to_trash, mark_read, mark_unread

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : email_password_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Combined SMTP and IMAP utility for sending mail, listing messages, reading message bodies, trashing messages, and toggling read state.
#
# HOW TO INVOKE
#   Import the helper functions or run it with valid mailbox credentials configured in the constants section.
#
# PRIMARY ENTRY POINTS
#   - decode_mime
#   - _extract_text
#   - send_email
#   - _connect_imap
#   - list_messages
#   - read_message
#   - move_to_trash
#   - mark_read
#   - mark_unread
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
import smtplib
import imaplib
import email
import json
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.header import decode_header
from email.utils import parsedate_to_datetime

from _config import cfg

SMTP_SERVER    = cfg("email", "smtp_server",    default="smtp.gmail.com")
SMTP_PORT      = int(cfg("email", "smtp_port",  default="587"))
IMAP_SERVER    = cfg("email", "imap_server",    default="imap.gmail.com")
IMAP_PORT      = int(cfg("email", "imap_port",  default="993"))
EMAIL_ACCOUNT  = cfg("email", "account",        env="EMAIL_ACCOUNT")
EMAIL_PASSWORD = cfg("email", "password",       env="EMAIL_PASSWORD")


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


def _extract_text(msg):
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
    return text


def send_email(to_email, subject, body_text, from_email=None):
    msg = MIMEMultipart()
    msg['From'] = from_email or EMAIL_ACCOUNT
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body_text, 'plain', 'utf-8'))

    server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
    server.starttls()
    server.login(EMAIL_ACCOUNT, EMAIL_PASSWORD)
    server.send_message(msg)
    server.quit()
    return {'ok': True, 'to': to_email, 'subject': subject}


def _connect_imap():
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_ACCOUNT, EMAIL_PASSWORD)
    return mail


def list_messages(limit=20, mailbox='INBOX', criteria='ALL'):
    mail = _connect_imap()
    mail.select(mailbox)
    status, data = mail.search(None, criteria)
    if status != 'OK':
        raise Exception('Failed to search mailbox')
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
        snippet = _extract_text(msg)[:400]
        results.append({
            'id': msg_id.decode(),
            'from': sender,
            'subject': subject,
            'date': date_iso,
            'snippet': snippet
        })
    mail.logout()
    return results


def read_message(message_id, mailbox='INBOX'):
    mail = _connect_imap()
    mail.select(mailbox)
    status, msg_data = mail.fetch(str(message_id), '(RFC822)')
    if status != 'OK':
        mail.logout()
        raise Exception(f'Failed to fetch message {message_id}')
    raw = msg_data[0][1]
    msg = email.message_from_bytes(raw)
    result = {
        'id': str(message_id),
        'from': decode_mime(msg.get('From', '')),
        'to': decode_mime(msg.get('To', '')),
        'subject': decode_mime(msg.get('Subject', '')),
        'date': msg.get('Date', ''),
        'body': _extract_text(msg)
    }
    mail.logout()
    return result


def move_to_trash(message_id, mailbox='INBOX', trash_mailbox='[Gmail]/Trash'):
    mail = _connect_imap()
    mail.select(mailbox)
    copy_status, _ = mail.copy(str(message_id), trash_mailbox)
    if copy_status != 'OK':
        mail.logout()
        raise Exception(f'Failed to copy message {message_id} to trash')
    store_status, _ = mail.store(str(message_id), '+FLAGS', r'(\\Deleted)')
    if store_status != 'OK':
        mail.logout()
        raise Exception(f'Failed to mark message {message_id} deleted')
    mail.expunge()
    mail.logout()
    return {'id': str(message_id), 'trashed': True}


def mark_read(message_id, mailbox='INBOX'):
    mail = _connect_imap()
    mail.select(mailbox)
    status, _ = mail.store(str(message_id), '+FLAGS', r'(\\Seen)')
    mail.logout()
    return {'id': str(message_id), 'ok': status == 'OK', 'read': True}


def mark_unread(message_id, mailbox='INBOX'):
    mail = _connect_imap()
    mail.select(mailbox)
    status, _ = mail.store(str(message_id), '-FLAGS', r'(\\Seen)')
    mail.logout()
    return {'id': str(message_id), 'ok': status == 'OK', 'read': False}


if __name__ == '__main__':
    print(json.dumps(list_messages(limit=10), indent=2))
