#!/usr/bin/env python3
"""claude_oauth.py — Claude Code-style PKCE OAuth driver for CBE.

Goal: programmatically acquire an access_token + refresh_token for a Claude
account that's already signed in to claude.com in some browser session
(bridge QtWebEngine profile, system Chromium-DPAPI cookie jar, etc.). The
token is what CBE's `rotateOnRateLimit` swaps in to use the next account.

Stdlib only — `secrets`, `hashlib`, `base64`, `urllib`, `http.server`,
`threading`, `socket`, `json`, `re`. No pip install.

The 5 steps (per user 2026-05-24 session):

  1. **PKCE + URL** — Generate code_verifier, code_challenge (S256), state.
     Construct claude.com authorize URL with our redirect_uri pointing at
     a localhost listener we own.
  2. **Fetch consent page** — HTTP GET (or bridge-navigate) the authorize
     URL with the account's session cookies. Returns the "Authorize this
     app" consent HTML.
  3. **Regex the consent form** — Pull the <form action="..."> + the
     hidden inputs (authenticity_token / csrf_token / etc.) out of the
     consent HTML.
  4. **POST the approval** — Submit the form. claude.com 302s to
     redirect_uri?code=<AUTH_CODE>&state=<STATE>.
  5. **Catch + exchange** — Local listener grabs the code; we POST it to
     the /oauth/token endpoint with grant_type=authorization_code +
     code_verifier → { access_token, refresh_token, expires_in }.

OAuth constants extracted from a real authorize URL captured 2026-05-24:
  client_id    = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
  scope        = org:create_api_key user:profile user:inference
                 user:sessions:claude_code user:mcp_servers user:file_upload
  authorize    = https://claude.com/cai/oauth/authorize
  redirect_uri = http://localhost:<our_port>/callback   (we pick the port)

Unknown until probed against a live session (TODOs below):
  - exact token endpoint (likely /cai/oauth/token; needs confirmation)
  - exact consent-form HTML shape (regex placeholders below)
  - whether claude.com auto-approves repeat client_id (skips step 3 + 4)

CLI usage:
    # Step 1 only — print the authorize URL + the verifier (verifier
    # must be saved to redeem the code later).
    python claude_oauth.py build-url --port 58957

    # Full flow — bridge profile must already be signed in. Spawns a
    # local callback listener, fetches consent page through a cookie jar
    # exported by the bridge, follows the redirect chain, exchanges the
    # code, prints { access_token, refresh_token, expires_in }.
    python claude_oauth.py login --port 58957 \\
        --cookie-jar path/to/cookies.json

    # Listen-only — useful when the bridge / a human navigates the
    # consent page out-of-band. Just blocks waiting for one callback
    # hit, then exchanges + prints. Times out after --timeout seconds.
    python claude_oauth.py listen --port 58957 --timeout 300
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import re
import secrets
import socket
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import Optional

# ---------------------------------------------------------------------------
# OAuth constants — read from config.ini [oauth_anthropic] when reachable,
# else fall back to baked-in defaults extracted from a real claude.com
# authorize URL (2026-05-24). Mirrors the [oauth_google] config pattern used
# by C:/ArcoMage/. Lets the user rotate client_id / endpoints via config
# without touching code.
# ---------------------------------------------------------------------------
_DEFAULTS = {
    "client_id":           "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "authorize_endpoint":  "https://claude.com/cai/oauth/authorize",
    # TODO(probe): confirm against a real flow. Likely /cai/oauth/token on the
    # same host. Anthropic could also use api.anthropic.com — both are plausible.
    "token_endpoint":      "https://claude.com/cai/oauth/token",
    "redirect_uri_local":  "http://localhost:58957/callback",
    "scopes": ("org:create_api_key "
               "user:profile "
               "user:inference "
               "user:sessions:claude_code "
               "user:mcp_servers "
               "user:file_upload"),
}


def _load_config():
    """Read [oauth_anthropic] from the CBE repo's config.ini if present.
    Returns a dict with all _DEFAULTS keys filled in (config wins per-key)."""
    import configparser
    from pathlib import Path
    out = dict(_DEFAULTS)
    here = Path(__file__).resolve().parent.parent      # tools/.. == repo root
    cfg_path = here / "config.ini"
    if not cfg_path.is_file():
        return out
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    try: cp.read(cfg_path, encoding="utf-8")
    except Exception: return out
    if not cp.has_section("oauth_anthropic"):
        return out
    sect = cp["oauth_anthropic"]
    for k in out:
        v = sect.get(k, "").strip()
        if v: out[k] = v
    return out


_C = _load_config()
CLIENT_ID          = _C["client_id"]
AUTHORIZE_ENDPOINT = _C["authorize_endpoint"]
TOKEN_ENDPOINT     = _C["token_endpoint"]
SCOPES             = _C["scopes"]
_DEFAULT_REDIRECT_URI = _C["redirect_uri_local"]


def _default_port_from_redirect_uri(uri: str) -> int:
    """Pull the port out of redirect_uri_local so the CLI's --port default
    tracks the config without needing a second value."""
    try:
        from urllib.parse import urlsplit
        p = urlsplit(uri).port
        if p: return int(p)
    except Exception:
        pass
    return 58957


_DEFAULT_PORT = _default_port_from_redirect_uri(_DEFAULT_REDIRECT_URI)


# ---------------------------------------------------------------------------
# Step 1 — PKCE + authorize-URL construction
# ---------------------------------------------------------------------------
def gen_pkce() -> tuple[str, str]:
    """Generate (code_verifier, code_challenge_S256). Verifier is 43-128
    chars of URL-safe base64; challenge is the base64url-encoded SHA-256
    of the verifier with padding stripped (per RFC 7636 § 4)."""
    raw = secrets.token_urlsafe(64)[:96]
    verifier = re.sub(r"[^A-Za-z0-9_\-.~]", "", raw)[:96]
    h = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(h).decode("ascii").rstrip("=")
    return verifier, challenge


def build_authorize_url(port: int, verifier: str, challenge: str) -> tuple[str, str]:
    """Construct the claude.com authorize URL + the random state value.
    Returns (url, state). Caller must persist verifier + state so step 5
    can exchange the returned code and verify the round-trip."""
    state = secrets.token_urlsafe(32).rstrip("=_-")[:43]
    params = {
        "code": "true",
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": f"http://localhost:{port}/callback",
        "scope": SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{AUTHORIZE_ENDPOINT}?{urllib.parse.urlencode(params)}", state


# ---------------------------------------------------------------------------
# Step 2 — Drive the consent page (REQUIRES nn4_agent_browser running)
# ---------------------------------------------------------------------------
# IMPORTANT: claude.com sits behind Cloudflare bot-protection (verified
# 2026-05-24 — anonymous urllib request returned HTTP 403 + "Just a
# moment..." challenge page). Raw HTTP fetch will NOT work even with
# session cookies, because Cloudflare also requires the `cf_clearance`
# cookie which is only issued after JS challenge execution. The consent
# page must be loaded inside a real Chromium (the bridge's QtWebEngine,
# exposed by nn4_agent_browser.py on TCP 127.0.0.1:9785).
#
# Wire-up: spin up nn4_agent_browser with the account's persisted
# QtWebEngine profile dir, manually sign in to claude.com once (cookies
# persist), then run this orchestrator. We drive the existing logged-in
# session via the agent harness's JSON action protocol.
NN4_HOST = "127.0.0.1"
NN4_PORT_DEFAULT = 9785


class _NN4Client:
    """Newline-delimited JSON client for tools/nn4_agent_browser.py.
    The harness's protocol: send one JSON object + '\\n', read one JSON
    object back. Connection can stay open across actions."""

    def __init__(self, host: str = NN4_HOST, port: int = NN4_PORT_DEFAULT,
                 timeout: float = 30.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self._buf = b""

    def __enter__(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        return self

    def __exit__(self, *_a):
        try: self.sock.close()  # type: ignore[union-attr]
        except Exception: pass
        self.sock = None

    def call(self, action: str, **kwargs) -> dict:
        if self.sock is None:
            raise RuntimeError("NN4Client not connected — use as context manager")
        msg = json.dumps({"action": action, **kwargs}).encode("utf-8") + b"\n"
        self.sock.sendall(msg)
        while b"\n" not in self._buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("NN4 harness closed connection mid-call")
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return json.loads(line.decode("utf-8"))


def nn4_navigate_authorize(client: _NN4Client, authorize_url: str,
                           settle_ms: int = 2500) -> tuple[str, str]:
    """Navigate the harness's view to the authorize URL, wait for the
    page to settle, return (final_url, html). The final_url tells the
    caller whether claude.com auto-redirected to our /callback (i.e.
    repeat-approval flow, no consent click needed) or stopped on the
    consent screen."""
    r = client.call("navigate", url=authorize_url)
    if not r.get("ok"):
        raise RuntimeError(f"navigate failed: {r}")
    client.call("wait", ms=settle_ms)
    final = client.call("page_url").get("url", "")
    html_r = client.call("page_html", max=1_000_000)
    html = html_r.get("html", "") if html_r.get("ok") else ""
    return final, html


def nn4_click_authorize(client: _NN4Client, settle_ms: int = 3000) -> str:
    """In the consent page, locate the Authorize/Approve button and
    click it via JS. Returns the post-click page URL — caller checks
    whether it landed on /callback. The selector strategy tries
    common shapes claude.com is likely to use (button text content,
    type=submit inside the form, aria-label, etc.) without assuming a
    specific DOM until we've probed a live page once."""
    # Click first match across several selectors. document.evaluate +
    # XPath lets us match by visible text without depending on class
    # names or ids that may change.
    js = r"""
    (function(){
      var btn = null;
      var sels = [
        // Common form-submit shapes
        "form button[type='submit']",
        "form input[type='submit']",
        // Aria-labelled approval controls
        "button[aria-label*='Authorize' i]",
        "button[aria-label*='Approve' i]",
        "button[aria-label*='Allow' i]",
        // Data-attributes Anthropic apps tend to use
        "button[data-testid*='authorize' i]",
        "button[data-testid*='approve' i]",
        "button[data-action*='authorize' i]",
      ];
      for (var i = 0; i < sels.length && !btn; i++) {
        try { btn = document.querySelector(sels[i]); } catch(e) {}
      }
      if (!btn) {
        // Last resort — XPath by visible text
        var xpaths = [
          "//button[contains(translate(normalize-space(.), 'AUTHORIZE','authorize'), 'authorize')]",
          "//button[contains(translate(normalize-space(.), 'APPROVE','approve'), 'approve')]",
          "//button[contains(translate(normalize-space(.), 'ALLOW','allow'), 'allow')]",
          "//button[contains(translate(normalize-space(.), 'CONTINUE','continue'), 'continue')]",
          "//input[@type='submit' and (contains(translate(@value,'AUTHORIZE','authorize'),'authorize') or contains(translate(@value,'APPROVE','approve'),'approve'))]",
        ];
        for (var j = 0; j < xpaths.length && !btn; j++) {
          try {
            var r = document.evaluate(xpaths[j], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            btn = r && r.singleNodeValue;
          } catch(e) {}
        }
      }
      if (!btn) return {ok:false, error:"no authorize-button selector matched"};
      try { btn.scrollIntoView({block:'center'}); } catch(e) {}
      try { btn.click(); } catch(e) { return {ok:false, error:"click threw: "+e.message}; }
      return {ok:true, tag: btn.tagName, text: (btn.textContent||btn.value||"").slice(0,80)};
    })();
    """
    r = client.call("eval_js", js=js)
    if not r.get("ok"):
        raise RuntimeError(f"eval_js failed: {r}")
    res = r.get("result")
    if isinstance(res, dict) and not res.get("ok"):
        raise RuntimeError(f"click failed: {res.get('error')}")
    client.call("wait", ms=settle_ms)
    return client.call("page_url").get("url", "")


# ---------------------------------------------------------------------------
# Steps 3 + 4 — handled inside the browser by nn4_click_authorize above.
# The old urllib-based extract_consent_form / submit_consent_form helpers
# were removed because claude.com is behind Cloudflare and raw HTTP can't
# clear the JS challenge. See the long comment above _NN4Client.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Step 5 — Local callback listener + token exchange
# ---------------------------------------------------------------------------
class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """One-shot handler. Stores the parsed query on the server instance
    and shuts the loop down by setting `server.code_caught`."""

    def do_GET(self):  # noqa: N802 — http.server contract
        parts = urllib.parse.urlsplit(self.path)
        qs = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
        self.server.callback_qs = qs           # type: ignore[attr-defined]
        self.server.code_caught = True         # type: ignore[attr-defined]
        # Friendly response — the browser tab gets a tiny confirmation
        # page so the user / agent knows it worked.
        body = (b"<!doctype html><meta charset=utf-8>"
                b"<title>CBE OAuth</title>"
                b"<style>body{font:14px monospace;background:#000;color:#0f0;"
                b"padding:30px}</style>"
                b"<h2>CBE OAuth: code received</h2>"
                b"<p>You can close this tab.</p>")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # quiet the default request logger so JSON stdout stays clean
    def log_message(self, *_a, **_k): pass


def listen_for_callback(port: int, timeout: float) -> Optional[dict]:
    """Block until /callback is hit or `timeout` seconds elapse. Returns
    the parsed query dict (with 'code' + 'state') or None on timeout."""
    server = socketserver.TCPServer(("127.0.0.1", port), _CallbackHandler)
    server.callback_qs = {}           # type: ignore[attr-defined]
    server.code_caught = False        # type: ignore[attr-defined]
    server.timeout = 0.5
    t0 = time.monotonic()
    try:
        while not getattr(server, "code_caught", False):
            if time.monotonic() - t0 > timeout:
                return None
            server.handle_request()
        return getattr(server, "callback_qs", {})
    finally:
        try: server.server_close()
        except Exception: pass


def exchange_code_for_token(code: str, verifier: str, port: int) -> dict:
    """POST to TOKEN_ENDPOINT with the standard PKCE
    authorization_code payload. Returns the parsed JSON response, which
    on success contains {access_token, refresh_token, expires_in,
    token_type}. Raises on HTTP error.
    NOTE: TOKEN_ENDPOINT is a best guess — see TODO at top."""
    payload = urllib.parse.urlencode({
        "grant_type":    "authorization_code",
        "code":          code,
        "redirect_uri":  f"http://localhost:{port}/callback",
        "client_id":     CLIENT_ID,
        "code_verifier": verifier,
    }).encode("ascii")
    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=payload,
        method="POST",
        headers={
            "User-Agent":   "ClaudeCodexBlack/oauth (CBE bridge)",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept":       "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# CLI glue
# ---------------------------------------------------------------------------
def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _cmd_build_url(args: argparse.Namespace) -> int:
    verifier, challenge = gen_pkce()
    url, state = build_authorize_url(args.port, verifier, challenge)
    _emit({
        "ok": True,
        "authorize_url": url,
        "code_verifier": verifier,        # PERSIST THIS — needed for exchange
        "state":         state,
        "redirect_uri":  f"http://localhost:{args.port}/callback",
    })
    return 0


def _cmd_listen(args: argparse.Namespace) -> int:
    qs = listen_for_callback(args.port, args.timeout)
    if qs is None:
        _emit({"ok": False, "error": "timeout waiting for /callback"})
        return 2
    if "code" not in qs:
        _emit({"ok": False, "error": "callback had no ?code=", "qs": qs})
        return 2
    if not args.verifier:
        # listen-only: caller will exchange on their own
        _emit({"ok": True, "code": qs["code"], "state": qs.get("state", ""), "qs": qs})
        return 0
    try:
        tok = exchange_code_for_token(qs["code"], args.verifier, args.port)
    except Exception as e:
        _emit({"ok": False, "error": f"token exchange failed: {type(e).__name__}: {e}",
               "code": qs["code"]})
        return 2
    _emit({"ok": True, "token": tok, "state_returned": qs.get("state", "")})
    return 0


def _cmd_login(args: argparse.Namespace) -> int:
    """Full flow via nn4_agent_browser: build URL → drive browser to
    authorize URL → click Authorize → browser 302s to localhost callback
    → local listener catches code → exchange. The bridge harness MUST
    already be running and signed in to claude.com in its persisted
    QtWebEngine profile."""
    verifier, challenge = gen_pkce()
    url, state = build_authorize_url(args.port, verifier, challenge)
    # Start callback listener in a thread so it can catch the redirect
    # while the browser is mid-flow.
    caught: dict = {}
    def _runner():
        qs = listen_for_callback(args.port, args.timeout)
        if qs is not None:
            caught.update(qs)
    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    # Drive the bridge browser through steps 2-4.
    try:
        with _NN4Client(port=args.nn4_port) as client:
            final_url, _html = nn4_navigate_authorize(client, url)
            if "/callback" not in final_url:
                # Need to click the Authorize button on the consent page.
                final_url = nn4_click_authorize(client)
    except (ConnectionRefusedError, OSError) as e:
        _emit({"ok": False, "error": f"nn4_agent_browser not reachable on "
                                     f"127.0.0.1:{args.nn4_port}: {e}"})
        return 2
    except RuntimeError as e:
        _emit({"ok": False, "error": str(e), "phase": "browser_drive"})
        return 2
    t.join(timeout=args.timeout)
    if "code" not in caught:
        _emit({"ok": False, "error": "no /callback hit within timeout",
               "browser_final_url": final_url, "qs": caught})
        return 2
    if caught.get("state") and caught["state"] != state:
        _emit({"ok": False, "error": "state mismatch — possible CSRF",
               "state_expected": state, "state_returned": caught.get("state")})
        return 2
    try:
        tok = exchange_code_for_token(caught["code"], verifier, args.port)
    except Exception as e:
        _emit({"ok": False, "error": f"token exchange failed: {type(e).__name__}: {e}",
               "code": caught["code"]})
        return 2
    _emit({"ok": True, "token": tok, "state_returned": caught.get("state", ""),
           "state_expected": state})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    ap_b = sub.add_parser("build-url", help="Generate PKCE + authorize URL (no fetch).")
    ap_b.add_argument("--port", type=int, default=_DEFAULT_PORT)
    ap_b.set_defaults(func=_cmd_build_url)

    ap_l = sub.add_parser("listen", help="Wait for /callback hit; optionally exchange.")
    ap_l.add_argument("--port", type=int, default=_DEFAULT_PORT)
    ap_l.add_argument("--timeout", type=float, default=300.0)
    ap_l.add_argument("--verifier", default="",
                      help="PKCE code_verifier from a prior build-url call. "
                           "If given, exchange the code for tokens before printing.")
    ap_l.set_defaults(func=_cmd_listen)

    ap_lg = sub.add_parser("login",
                           help="Full flow: build URL + drive bridge browser + "
                                "click Authorize + catch callback + exchange token. "
                                "Requires nn4_agent_browser running with a "
                                "signed-in claude.com profile.")
    ap_lg.add_argument("--port", type=int, default=_DEFAULT_PORT,
                       help="Local port for the OAuth /callback listener.")
    ap_lg.add_argument("--nn4-port", type=int, default=NN4_PORT_DEFAULT,
                       help="Port nn4_agent_browser.py is listening on.")
    ap_lg.add_argument("--timeout", type=float, default=120.0)
    ap_lg.set_defaults(func=_cmd_login)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
