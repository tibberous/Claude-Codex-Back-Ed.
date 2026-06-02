#!/usr/bin/env python3
"""bridge_notify.py — pop a message to the user from a bridge tray exe.

Tries the CBE extension's /bridge/notify endpoint first (so the popup shows
inside VSCode via vscode.window.showXMessage); falls back to a native Windows
MessageBox via PowerShell if the endpoint isn't reachable.

Usage:
    python bridge_notify.py --bridge chatgpt --level error \
        --title "Login failed" \
        --message "chatgpt.com rejected the password."

Exit codes:
    0 = popup shown (via extension OR via fallback MessageBox)
    1 = bad args
    2 = both delivery paths failed
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request

NOTIFY_URL = "http://127.0.0.1:57835/bridge/notify"
LEVELS = ("info", "warn", "error")


def tryExtension(level: str, title: str, message: str, bridge: str) -> bool:
    body = json.dumps({
        "level": level, "title": title,
        "message": message, "bridge_id": bridge,
    }).encode("utf-8")
    req = urllib.request.Request(
        NOTIFY_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return 200 <= r.status < 300
    except urllib.error.URLError:
        return False
    except OSError:
        return False


def fallbackMessageBox(level: str, title: str, message: str, bridge: str) -> bool:
    """Native Windows MessageBox via PowerShell. Blocks until user clicks OK."""
    icon = {"error": "Error", "warn": "Warning", "info": "Information"}.get(level, "Information")
    full_title = f"[{bridge}] {title}"
    # PowerShell here-string to safely embed multi-line messages.
    safe_title = full_title.replace("'", "''")
    safe_message = message.replace("'", "''")
    ps = (
        "Add-Type -AssemblyName PresentationFramework; "
        f"[System.Windows.MessageBox]::Show('{safe_message}','{safe_title}','OK','{icon}') | Out-Null"
    )
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            timeout=60, capture_output=True, text=True)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", required=True,
                    choices=("chatgpt", "claude", "grok", "gemini", "copilot", "ollama"),
                    help="Which bridge this notification is from.")
    ap.add_argument("--level", required=True, choices=LEVELS,
                    help="Severity — picks the right icon + handler.")
    ap.add_argument("--title", required=True, help="Short one-line title.")
    ap.add_argument("--message", required=True, help="Longer detail (one paragraph).")
    args = ap.parse_args()

    if tryExtension(args.level, args.title, args.message, args.bridge):
        return 0
    if fallbackMessageBox(args.level, args.title, args.message, args.bridge):
        return 0
    print(f"[bridge_notify] both delivery paths failed for [{args.bridge}] {args.title}",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
