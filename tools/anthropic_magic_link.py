#!/usr/bin/env python3
"""anthropic_magic_link.py — scan cached .eml files for Anthropic magic-login
links and (optionally) fetch them to obtain a claude.ai session cookie.

Pairs with the email cache the extension keeps at <ext>/emails/<md5>.eml
(populated by cacheRecentEmails -> tools/imap_read.py --dump-eml). The
extension's panel button or a slash-command can spawn this script when the
user wants to consume an unconsumed magic link.

Magic-link format (from Anthropic's transactional mail):

    https://claude.ai/magic-link#<32-hex token>:<base64-encoded email>

The base64 portion decodes to the address the link was sent to. SendGrid
tracking redirects (https://url8792.mail.anthropic.com/ls/click?upn=...)
also resolve to the same final URL via 302 — we prefer the direct
claude.ai/magic-link form because it doesn't burn a tracking pixel.

Usage:

    py -3 tools/anthropic_magic_link.py --eml-dir <dir> [--for-email <addr>] [--fetch]

Prints JSON to stdout: {"matches": [...], "fetched": {...}?}.

The --fetch flag CONSUMES the magic-link (claude.ai marks the token used),
so callers should only pass it when the user explicitly triggers the
auto-login path. Without --fetch this script is read-only.
"""
from __future__ import annotations

import argparse
import base64
import email
import glob
import http.cookiejar
import json
import os
import quopri
import re
import sys
import urllib.request
from email import policy
from email.parser import BytesParser


MAGIC_RE = re.compile(
    r'https://claude\.ai/magic-link#([0-9a-fA-F]{32}):([A-Za-z0-9+/=_-]+)'
)


def scan_eml_dir(eml_dir: str, for_email: str | None = None) -> list[dict]:
    """Return list of magic-link matches as dicts, newest-first by file mtime.

    Each match: {token, email, url, eml_path, msg_date}. for_email filters
    matches to those whose decoded base64 address case-insensitively equals
    the supplied address (useful when the user has multiple Anthropic
    accounts and only wants the link for a specific one).
    """
    out: list[dict] = []
    for path in glob.glob(os.path.join(eml_dir, '*.eml')):
        try:
            with open(path, 'rb') as f:
                raw_bytes = f.read()
            msg = BytesParser(policy=policy.default).parsebytes(raw_bytes)
        except Exception:
            continue

        # Build a permissive text blob: the raw bytes (quoted-printable
        # decoded) PLUS every walked body part. SendGrid wraps long URLs
        # across lines with '=\r\n', so quopri decoding is mandatory to
        # rejoin them before regex.
        body_parts: list[str] = []
        try:
            body_parts.append(quopri.decodestring(raw_bytes).decode('utf-8', 'replace'))
        except Exception:
            pass
        try:
            for part in msg.walk():
                try:
                    content = part.get_content() if hasattr(part, 'get_content') else ''
                    body_parts.append(str(content))
                except Exception:
                    continue
        except Exception:
            pass
        text = '\n'.join(body_parts)

        for m in MAGIC_RE.finditer(text):
            token = m.group(1).lower()
            try:
                # base64 module needs proper padding; '==' is safe over-pad.
                decoded_email = base64.b64decode(m.group(2) + '==', validate=False) \
                    .decode('utf-8', 'replace').strip()
            except Exception:
                decoded_email = ''
            if for_email and for_email.lower() != decoded_email.lower():
                continue
            out.append({
                'token':    token,
                'email':    decoded_email,
                'url':      m.group(0),
                'eml_path': path,
                'msg_date': msg.get('Date', '') or '',
            })

    # Newest first by file mtime (Message-Date parsing is messy across providers).
    out.sort(key=lambda r: os.path.getmtime(r['eml_path']), reverse=True)
    # De-duplicate on token while preserving order — same email may yield the
    # direct + SendGrid forms but they share the token.
    seen: set[str] = set()
    deduped: list[dict] = []
    for row in out:
        if row['token'] in seen:
            continue
        seen.add(row['token'])
        deduped.append(row)
    return deduped


def fetch_magic_link(url: str) -> tuple[int, str, dict]:
    """GET the magic-link URL, follow redirects, return (status, final_url, cookies).

    claude.ai responds with a 302 + Set-Cookie session token on success. We
    persist cookies via http.cookiejar so the caller can hand them off to
    the bridge profile or write them to disk.
    """
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [('User-Agent', 'Mozilla/5.0 (CBE-AutoLogin)')]
    with opener.open(url, timeout=15) as resp:
        status = resp.status
        final_url = resp.geturl()
    cookies = {c.name: c.value for c in cj}
    return status, final_url, cookies


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description='Scan cached .eml files for Anthropic magic-login links.',
    )
    ap.add_argument('--eml-dir', required=True,
                    help='directory containing cached *.eml files')
    ap.add_argument('--for-email', default=None,
                    help='filter to links sent to this address (case-insensitive)')
    ap.add_argument('--fetch', action='store_true',
                    help='fetch the newest match and dump session cookies '
                         '(WARNING: consumes the magic-link token)')
    ap.add_argument('--max', type=int, default=10,
                    help='cap displayed matches (newest-first); default 10')
    args = ap.parse_args(argv)

    hits = scan_eml_dir(args.eml_dir, args.for_email)
    payload: dict = {'matches': hits[:max(1, args.max)]}

    if args.fetch:
        if not hits:
            payload['fetched'] = {'ok': False, 'error': 'no magic-link matches found'}
        else:
            try:
                status, final_url, cookies = fetch_magic_link(hits[0]['url'])
                payload['fetched'] = {
                    'ok':         True,
                    'status':     status,
                    'final_url':  final_url,
                    'cookies':    cookies,
                    'token':      hits[0]['token'],
                    'email':      hits[0]['email'],
                }
            except Exception as e:
                payload['fetched'] = {
                    'ok':    False,
                    'error': f'{type(e).__name__}: {e}',
                }

    print(json.dumps(payload, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
