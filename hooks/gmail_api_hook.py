"""
Hook File: gmail_api_hook.py

What it does:
Gmail API helper that can send email, list messages, fetch a message, trash or delete mail, and toggle read state.

How to use it:
Set up Google API credentials and token flow first, then import and call the exported Gmail actions.

Primary entry points:
_get_service, _mime_message, send_email, list_messages, get_message, trash_message, delete_message, mark_read, mark_unread

Relevant URL(s):
- https://www.googleapis.com/auth/gmail.modify

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import json
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build  # badimport-ok: import name provided by google-api-python-client
except Exception as e:
    raise RuntimeError("Missing Google API packages. Install: google-api-python-client google-auth-httplib2 google-auth-oauthlib") from e

SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify'
]
BASE_DIR = Path(__file__).resolve().parent
TOKEN_FILE = BASE_DIR / 'gmail_token.json'
CREDENTIALS_FILE = BASE_DIR / 'gmail_credentials.json'


def _get_service():
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not CREDENTIALS_FILE.exists():
                raise FileNotFoundError(f'Missing {CREDENTIALS_FILE}. Put your Google OAuth desktop client JSON there.')
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json(), encoding='utf-8')
    return build('gmail', 'v1', credentials=creds)


def _mime_message(to_email, subject, body_text, from_email=None):
    msg = MIMEMultipart()
    if from_email:
        msg['From'] = from_email
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body_text, 'plain', 'utf-8'))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode('utf-8')
    return {'raw': raw}


def send_email(to_email, subject, body_text, from_email='me'):
    service = _get_service()
    message = _mime_message(to_email, subject, body_text, None if from_email == 'me' else from_email)
    sent = service.users().messages().send(userId='me', body=message).execute()
    return sent


def list_messages(limit=20, query=None, include_spam_trash=False):
    service = _get_service()
    resp = service.users().messages().list(
        userId='me',
        maxResults=limit,
        q=query,
        includeSpamTrash=include_spam_trash
    ).execute()
    msgs = resp.get('messages', [])
    results = []
    for m in msgs:
        full = service.users().messages().get(userId='me', id=m['id'], format='metadata', metadataHeaders=['From','Subject','Date']).execute()
        headers = {h['name']: h['value'] for h in full.get('payload', {}).get('headers', [])}
        results.append({
            'id': full.get('id'),
            'threadId': full.get('threadId'),
            'labelIds': full.get('labelIds', []),
            'from': headers.get('From', ''),
            'subject': headers.get('Subject', ''),
            'date': headers.get('Date', ''),
            'snippet': full.get('snippet', '')
        })
    return results


def get_message(message_id, format='full'):
    service = _get_service()
    return service.users().messages().get(userId='me', id=message_id, format=format).execute()


def trash_message(message_id):
    service = _get_service()
    return service.users().messages().trash(userId='me', id=message_id).execute()


def delete_message(message_id):
    service = _get_service()
    service.users().messages().delete(userId='me', id=message_id).execute()
    return {'id': message_id, 'deleted': True}


def mark_read(message_id):
    service = _get_service()
    return service.users().messages().modify(userId='me', id=message_id, body={'removeLabelIds': ['UNREAD']}).execute()


def mark_unread(message_id):
    service = _get_service()
    return service.users().messages().modify(userId='me', id=message_id, body={'addLabelIds': ['UNREAD']}).execute()


if __name__ == '__main__':
    print(json.dumps(list_messages(limit=10), indent=2))
