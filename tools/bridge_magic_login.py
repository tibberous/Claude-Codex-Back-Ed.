#!/usr/bin/env python3
"""bridge_magic_login.py — orchestrate a magic-link login for a CBE bridge.

Glue between [[imap_read.py]] (already shipped, stdlib-only inbox reader) and
a CBE-Bridge-<Target>.exe tray (offscreen QtWebEngine that holds the
claude.ai / chatgpt.com / etc. session). Sequence:

    1. Tell the bridge to navigate to <login_url>.
    2. Tell the bridge to fill the email field + click Continue
       (the provider's "sign-in" form sends a one-time magic-link email).
    3. Poll the IMAP inbox via imap_read.py until a matching email arrives,
       extract the first link that matches --link-regex.
    4. Tell the bridge to navigate to that link -- user is signed in.
    5. (Optional) Tell the bridge to persist cookies to its profile dir so
       subsequent rotations don't have to repeat steps 1-4.

The orchestrator is provider-agnostic — pass the URL, the email-input
selector, the continue-button selector, the IMAP filter, and the link
regex. Defaults match claude.ai's sign-in flow.

----------------------------------------------------------------------
Bridge protocol (newline-delimited JSON over TCP, one action per conn):


    out: {"action":"navigate","target":"claude","url":"https://..."}\n
    in : {"ok":true,"final_url":"..."}\n

    out: {"action":"eval_js","target":"claude","code":"<JS>"}\n
    in : {"ok":true,"result":<json>}\n

    out: {"action":"wait_for","target":"claude",
          "selector":"input[type=email]","timeout_ms":15000}\n
    in : {"ok":true,"found":true,"elapsed_ms":1234}\n

Today the tray exe (bridges_cpp/bridge_server.cpp) only handles
action="chat". The other three are NEW actions this orchestrator needs;
see ROADMAP at bottom of this file for the C++ patch outline.

Until the tray supports them, use --dry-run to exercise the loop without
touching the bridge — only IMAP polling runs for real. That proves the
link extraction half end-to-end (the half that's already buildable).
----------------------------------------------------------------------

Usage examples:

    # Dry-run: IMAP polling is real, bridge calls are printed
    python bridge_magic_login.py --dry-run \\
        --provider yahoo --email me@yahoo.com --password-env IMAP_PWD \\
        --bridge-target claude

    # Real run (once the bridge supports the new actions)
    python bridge_magic_login.py \\
        --provider gmail --email me@gmail.com --password-env IMAP_PWD \\
        --bridge-target claude --bridge-port 9701

Output: a single JSON object on stdout (same shape as imap_read.py).
    {"ok": true, "stage": "done", "magic_link": "https://...", "elapsed_s": 14.2}
    {"ok": false, "stage": "<which>", "error": "<reason>"}

Exit codes: 0 = ok, 1 = bad args, 2 = IMAP failure, 3 = bridge failure,
            4 = magic-link timeout (no matching email arrived).
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IMAP_READ = REPO_ROOT / "tools" / "imap_read.py"

# claude.ai's sign-in DOM at time of writing (2026-05-24). Confirmed by
# the user — yahoo/hotmail/gmail all use the same magic-link path. The
# regex matches the one-time login URL in the email body.
DEFAULTS = {
    "login_url":         "https://claude.ai/login",
    "email_selector":    'input[type="email"], input[name="email"]',
    "continue_selector": 'button[type="submit"], button:has-text("Continue")',
    "from_filter":       "anthropic.com",
    "subject_filter":    "sign in",
    "link_regex":        r"https://claude\.ai/magic-link\?token=[A-Za-z0-9_\-]+",
}

# Default TCP port per bridge target (mirrors extension.js BRIDGE_PORTS at :92).
BRIDGE_PORTS = {
    "claude":   9701,
    "chatgpt":  9702,
    "grok":     9703,
    "gemini":   9704,
    "copilot":  9705,
    "ollama":   9706,
}


def _emit(payload: dict) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if payload.get("ok") else 1


def _bridge_send(host: str, port: int, action: dict, timeout_s: float = 30.0) -> dict:
    """Send one newline-delimited JSON action to the bridge tray exe + read
    the single JSON response. Mirrors extension.js _spawnBridge chat path."""
    payload = (json.dumps(action) + "\n").encode("utf-8")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout_s)
    try:
        sock.connect((host, port))
        sock.sendall(payload)
        # Read until newline or EOF (responses are single-line JSON).
        buf = b""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            if b"\n" in buf:
                break
        line = buf.split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
        if not line:
            return {"ok": False, "error": "empty response from bridge"}
        try:
            return json.loads(line)
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"bad JSON from bridge: {e}; first 300 chars: {line[:300]!r}"}
    except (OSError, socket.timeout) as e:
        return {"ok": False, "error": f"bridge connect/send failed: {type(e).__name__}: {e}"}
    finally:
        try: sock.close()
        except Exception: pass


def _bridge_call(args, action: dict) -> dict:
    """Send an action to the bridge or, in --dry-run mode, print + simulate
    success. Returns the bridge's response dict."""
    if args.dry_run:
        sys.stderr.write(f"[DRY-RUN bridge] -> {json.dumps(action)}\n")
        sys.stderr.flush()
        return {"ok": True, "dry_run": True}
    return _bridge_send(args.bridge_host, args.bridge_port, action)


def _poll_imap(args, since_minutes: int, timeout_s: int, poll_every_s: int) -> dict:
    """Poll IMAP via imap_read.py subprocess until a matching link is found
    or `timeout_s` elapses. Returns {ok, link, elapsed_s} on success or
    {ok:false, error} on failure / timeout."""
    cmd = [
        sys.executable, str(IMAP_READ),
        "--provider", args.provider,
        "--email", args.email,
        "--since-minutes", str(since_minutes),
        "--from-filter", args.from_filter,
        "--extract-links", args.link_regex,
        "--max", "5",
    ]
    if args.password_env:
        cmd += ["--password-env", args.password_env]
    elif args.password:
        cmd += ["--password", args.password]
    if args.subject_filter:
        cmd += ["--subject-filter", args.subject_filter]

    start = time.monotonic()
    deadline = start + timeout_s
    while time.monotonic() < deadline:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "imap_read.py hung past 30s"}
        if proc.returncode not in (0, 2):
            return {"ok": False,
                    "error": f"imap_read.py exit {proc.returncode}: "
                             f"{(proc.stderr or proc.stdout or '').strip()[:300]}"}
        try:
            data = json.loads((proc.stdout or "").strip().split("\n")[-1] or "{}")
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"bad JSON from imap_read.py: {e}"}
        if not data.get("ok"):
            return {"ok": False, "error": f"imap_read.py reported failure: {data.get('error')}"}
        for em in data.get("emails", []):
            for link in (em.get("links") or []):
                return {"ok": True, "link": link,
                        "elapsed_s": round(time.monotonic() - start, 2),
                        "subject": em.get("subject", "")}
        time.sleep(poll_every_s)
    return {"ok": False, "error": f"no matching email arrived within {timeout_s}s"}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # account / IMAP
    ap.add_argument("--provider", required=True, choices=["gmail", "yahoo", "hotmail", "outlook"])
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", default="")
    ap.add_argument("--password-env", default="")
    # bridge target
    ap.add_argument("--bridge-target", required=True, choices=sorted(BRIDGE_PORTS))
    ap.add_argument("--bridge-host", default="127.0.0.1")
    ap.add_argument("--bridge-port", type=int, default=0,
                    help="Override; defaults to BRIDGE_PORTS[target].")
    # login DOM (defaults to claude.ai)
    ap.add_argument("--login-url", default=DEFAULTS["login_url"])
    ap.add_argument("--email-selector", default=DEFAULTS["email_selector"])
    ap.add_argument("--continue-selector", default=DEFAULTS["continue_selector"])
    # IMAP search
    ap.add_argument("--from-filter", default=DEFAULTS["from_filter"])
    ap.add_argument("--subject-filter", default=DEFAULTS["subject_filter"])
    ap.add_argument("--link-regex", default=DEFAULTS["link_regex"])
    # polling
    ap.add_argument("--poll-timeout-s", type=int, default=120,
                    help="Max time to wait for the magic-link email (default 120s).")
    ap.add_argument("--poll-every-s", type=int, default=5,
                    help="Re-query IMAP every N seconds (default 5).")
    # mode
    ap.add_argument("--dry-run", action="store_true",
                    help="Skip bridge calls; only exercise the IMAP loop.")
    args = ap.parse_args()

    if not args.password and not args.password_env:
        return _emit({"ok": False, "stage": "args",
                      "error": "supply --password or --password-env"})
    if args.bridge_port == 0:
        args.bridge_port = BRIDGE_PORTS[args.bridge_target]

    t_start = time.monotonic()

    # Step 1: navigate to login URL
    r = _bridge_call(args, {"action": "navigate", "target": args.bridge_target,
                            "url": args.login_url})
    if not r.get("ok"):
        return _emit({"ok": False, "stage": "navigate", "error": r.get("error", "?")})

    # Step 2: wait for the email input + fill + submit
    r = _bridge_call(args, {"action": "wait_for", "target": args.bridge_target,
                            "selector": args.email_selector, "timeout_ms": 15000})
    if not r.get("ok"):
        return _emit({"ok": False, "stage": "wait_for_email", "error": r.get("error", "?")})

    fill_js = (
        f"(()=>{{const e=document.querySelector({json.dumps(args.email_selector)});"
        f"if(!e)return{{ok:false,err:'email input not found'}};"
        f"e.focus();e.value={json.dumps(args.email)};"
        f"e.dispatchEvent(new Event('input',{{bubbles:true}}));"
        f"e.dispatchEvent(new Event('change',{{bubbles:true}}));"
        f"const b=document.querySelector({json.dumps(args.continue_selector)});"
        f"if(!b)return{{ok:false,err:'continue button not found'}};"
        f"b.click();return{{ok:true}};}})()"
    )
    r = _bridge_call(args, {"action": "eval_js", "target": args.bridge_target,
                            "code": fill_js})
    if not r.get("ok"):
        return _emit({"ok": False, "stage": "fill_submit", "error": r.get("error", "?")})

    # Step 3: poll IMAP for the magic-link email. We give the inbox `since-minutes=5`
    # so a re-run within 5 minutes finds the prior magic link if the bridge crashed
    # mid-flight (rather than waiting for a new one).
    sys.stderr.write(f"[IMAP] polling {args.provider}:{args.email} every {args.poll_every_s}s "
                     f"for up to {args.poll_timeout_s}s ...\n")
    sys.stderr.flush()
    poll = _poll_imap(args, since_minutes=5,
                      timeout_s=args.poll_timeout_s,
                      poll_every_s=args.poll_every_s)
    if not poll.get("ok"):
        return _emit({"ok": False, "stage": "imap_poll", "error": poll.get("error", "?")})

    link = poll["link"]
    sys.stderr.write(f"[IMAP] found link after {poll['elapsed_s']}s "
                     f"(subject={poll.get('subject', '')!r})\n")
    sys.stderr.flush()

    # Step 4: navigate the bridge to the magic-link URL
    r = _bridge_call(args, {"action": "navigate", "target": args.bridge_target,
                            "url": link})
    if not r.get("ok"):
        return _emit({"ok": False, "stage": "navigate_magic_link",
                      "error": r.get("error", "?"), "magic_link": link})

    return _emit({
        "ok": True, "stage": "done",
        "magic_link": link,
        "imap_elapsed_s": poll["elapsed_s"],
        "total_elapsed_s": round(time.monotonic() - t_start, 2),
        "dry_run": bool(args.dry_run),
    })


if __name__ == "__main__":
    raise SystemExit(main())


# --- ROADMAP: C++ tray patches needed for the real (non-dry-run) path ------
# bridges_cpp/bridge_server.cpp's handleConnection() dispatch needs three
# new action handlers besides the existing "chat":
#
#   "navigate": call into start.py via a new bridge_nav.py one-shot script
#               that runs page.setUrl(url) on the offscreen QWebEnginePage
#               and resolves once loadFinished fires (with a 30s timeout).
#
#   "wait_for": same shape — bridge_wait.py polls page.runJavaScript(
#               "!!document.querySelector('...')") every 250ms until true
#               or timeout_ms expires.
#
#   "eval_js":  bridge_eval.py runs page.runJavaScript(code, callback) and
#               returns the callback's value (must be JSON-serializable).
#
# All three are bridge-agnostic: dispatch is by target name (which selects
# the right offscreen profile dir), and the action shape is uniform.
# Once these land, drop --dry-run and the magic-link flow runs end-to-end.
# ---------------------------------------------------------------------------
