"""
Hook File: x_hook.py

What it does:
X / Twitter API helper that builds OAuth1 headers, checks the current account, posts tweets, and tests bearer or client-credential flows.

How to use it:
Configure valid X credentials first, then call get_me_oauth1, post_tweet_oauth1, get_me_bearer, or client_credentials_test.

Primary entry points:
_enc, _oauth1_header, get_me_oauth1, post_tweet_oauth1, get_me_bearer, client_credentials_test

Relevant URL(s):
- https://api.x.com/2
- https://api.x.com/2/oauth2/token

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : x_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   X / Twitter API helper that builds OAuth1 headers, checks the current account, posts tweets, and tests bearer or client-credential flows.
#
# HOW TO INVOKE
#   Configure valid X credentials first, then call get_me_oauth1, post_tweet_oauth1, get_me_bearer, or client_credentials_test.
#
# PRIMARY ENTRY POINTS
#   - _enc
#   - _oauth1_header
#   - get_me_oauth1
#   - post_tweet_oauth1
#   - get_me_bearer
#   - client_credentials_test
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
import json, time, hmac, hashlib, base64, secrets
from urllib.parse import quote

import requests
from _config import cfg

# X / Twitter credentials — all loaded from config.ini [x] section.
# config.ini is .gitignore'd; no live tokens live in source.
CONSUMER_KEY               = cfg("x", "consumer_key",               env="X_CONSUMER_KEY")
CONSUMER_SECRET            = cfg("x", "consumer_secret",            env="X_CONSUMER_SECRET")
BEARER_TOKEN               = cfg("x", "bearer_token",               env="X_BEARER_TOKEN")
OAUTH1_ACCESS_TOKEN        = cfg("x", "oauth1_access_token",        env="X_OAUTH1_ACCESS_TOKEN")
OAUTH1_ACCESS_TOKEN_SECRET = cfg("x", "oauth1_access_token_secret", env="X_OAUTH1_ACCESS_TOKEN_SECRET")
CLIENT_ID                  = cfg("x", "client_id",                  env="X_CLIENT_ID")
CLIENT_SECRET              = cfg("x", "client_secret",              env="X_CLIENT_SECRET")

API_V2    = cfg("x", "api_base",  default="https://api.x.com/2")
TOKEN_URL = cfg("x", "token_url", default="https://api.x.com/2/oauth2/token")


def _enc(s):
    return quote(str(s), safe='~-._')


def _oauth1_header(method, url, token=None, token_secret='', extra_params=None):
    oauth = {
        'oauth_consumer_key': CONSUMER_KEY,
        'oauth_nonce': secrets.token_hex(16),
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': str(int(time.time())),
        'oauth_version': '1.0',
    }
    if token:
        oauth['oauth_token'] = token

    sig_params = dict(oauth)
    if extra_params:
        for k, v in extra_params.items():
            sig_params[k] = v

    items = []
    for k in sorted(sig_params):
        items.append(f"{_enc(k)}={_enc(sig_params[k])}")
    param_str = '&'.join(items)
    base_str = '&'.join([method.upper(), _enc(url), _enc(param_str)])
    signing_key = f"{_enc(CONSUMER_SECRET)}&{_enc(token_secret)}"
    sig = base64.b64encode(hmac.new(signing_key.encode(), base_str.encode(), hashlib.sha1).digest()).decode()
    oauth['oauth_signature'] = sig
    parts = ', '.join(f'{_enc(k)}="{_enc(v)}"' for k, v in sorted(oauth.items()))
    return 'OAuth ' + parts


def get_me_oauth1():
    url = f'{API_V2}/users/me'
    headers = {
        'Authorization': _oauth1_header('GET', url, OAUTH1_ACCESS_TOKEN, OAUTH1_ACCESS_TOKEN_SECRET),
        'User-Agent': 'gtp-x-hook/1.1'
    }
    r = requests.get(url, headers=headers, timeout=30)
    return {'status': r.status_code, 'body': r.text}


def post_tweet_oauth1(text):
    url = f'{API_V2}/tweets'
    headers = {
        'Authorization': _oauth1_header('POST', url, OAUTH1_ACCESS_TOKEN, OAUTH1_ACCESS_TOKEN_SECRET),
        'Content-Type': 'application/json',
        'User-Agent': 'gtp-x-hook/1.1'
    }
    r = requests.post(url, headers=headers, json={'text': text}, timeout=30)
    return {'status': r.status_code, 'body': r.text}


def get_me_bearer():
    url = f'{API_V2}/users/me'
    headers = {
        'Authorization': f'Bearer {BEARER_TOKEN}',
        'User-Agent': 'gtp-x-hook/1.1'
    }
    r = requests.get(url, headers=headers, timeout=30)
    return {'status': r.status_code, 'body': r.text}


def client_credentials_test():
    basic = base64.b64encode(f'{CLIENT_ID}:{CLIENT_SECRET}'.encode()).decode()
    headers = {
        'Authorization': f'Basic {basic}',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'gtp-x-hook/1.1'
    }
    data = {
        'grant_type': 'client_credentials',
    }
    r = requests.post(TOKEN_URL, headers=headers, data=data, timeout=30)
    return {'status': r.status_code, 'body': r.text}


if __name__ == '__main__':
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    results = {
        'oauth1_get_me': get_me_oauth1(),
        'bearer_get_me': get_me_bearer(),
        'oauth1_post_test': post_tweet_oauth1('GTP test post via OAuth 1.0a at ' + stamp),
        'client_credentials_test': client_credentials_test(),
    }
    print(json.dumps(results, indent=2))
