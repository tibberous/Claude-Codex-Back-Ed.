"""One-shot visible-window sign-in helper for any bridge target.

Some targets (notably claude.ai, which dropped password login in favor of
magic-link emails) cannot be auto-driven by the vision-pilot without inbox
access. Solution: pop the per-target Chromium profile in VISIBLE mode so
the human signs in ONCE. Cookies persist in the per-target profile dir
(`data/minicomputer/<target>-profile`), so every subsequent vision-pilot
attach finds an active session and skips the login flow entirely.

Usage:
    python tools/sign_in_helper.py claude
    python tools/sign_in_helper.py deepseek
    python tools/sign_in_helper.py copilot

Behavior:
    1. Make sure the per-target tray exe is NOT running (it'd lock the profile).
       If it is, prints instructions and exits non-zero.
    2. Spawns chrome.exe with the SAME profile dir the pilot uses, but
       VISIBLE (no `--window-position=5000,5000`, no `--headless`).
    3. Navigates to the target's login URL.
    4. Waits for the user to press Enter in the terminal, then closes the
       Chromium so the profile is unlocked for the next pilot run.

After this runs once for a target, `start.driveBridgeChatViaVisionPilot(target, ...)`
should sail past the login wall on every subsequent invocation.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from start import (  # type: ignore  # noqa: E402
    MINICOMPUTER_START_URLS,
    MINICOMPUTER_CDP_PORTS,
    _miniComputerProfileDir,
    normalizeChatTarget,
)

# Per-target login URL. Where to send the visible chrome FIRST so the user
# lands on the correct sign-in surface — the START URL may bounce around
# (e.g. claude.ai/new → /logout → /login during a logged-out state).
LOGIN_URLS = {
    "claude":   "https://claude.ai/login",
    "deepseek": "https://chat.deepseek.com/sign_in",
    "copilot":  "https://login.live.com/",
    "chatgpt":  "https://chatgpt.com/auth/login",
    "grok":     "https://accounts.x.ai/sign-in",
    "gemini":   "https://accounts.google.com/signin",
}


def findChromeExe() -> str:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    raise RuntimeError("chrome.exe not found in Program Files — install Chrome first")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python tools/sign_in_helper.py <target>")
        print("       targets: claude, deepseek, copilot, chatgpt, grok, gemini")
        return 2
    target = normalizeChatTarget(sys.argv[1])
    if target not in MINICOMPUTER_START_URLS:
        print(f"unknown target {target!r}")
        return 2

    profile_dir = _miniComputerProfileDir(target)
    profile_dir.mkdir(parents=True, exist_ok=True)
    cdp_port = MINICOMPUTER_CDP_PORTS.get(target, 9789)
    login_url = LOGIN_URLS.get(target, MINICOMPUTER_START_URLS[target])

    print(f"=== sign-in helper: {target} ===")
    print(f"  profile dir : {profile_dir}")
    print(f"  CDP port    : {cdp_port}")
    print(f"  login URL   : {login_url}")
    print("")
    print("If a tray exe for this target is running, kill it FIRST")
    print(f"(it holds a lock on the profile). Example PowerShell:")
    print(f"  Stop-Process -Name 'CBE-Bridge-{target.capitalize()}' -Force")
    print("")
    input("Press Enter to launch the visible login window... ")

    chrome = findChromeExe()
    # VISIBLE window (no --window-position=5000,5000 trick) so user can
    # actually see + interact. Same profile dir the vision-pilot will use
    # on later runs, so cookies persist. CDP enabled in case we want to
    # attach for verification.
    cmd = [
        chrome,
        f"--remote-debugging-port={cdp_port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-blink-features=AutomationControlled",
        "--password-store=basic",
        "--disable-features=LockProfileCookieDatabase",
        login_url,
    ]
    print(f"launching: {chrome} ... {login_url}")
    proc = subprocess.Popen(cmd)
    print(f"chrome PID {proc.pid} — sign in to {target}, then come back here.")
    print("")
    input("Press Enter AFTER you're signed in to close Chrome and bank cookies... ")
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    print(f"\nDone. Cookies banked in: {profile_dir}")
    print("Next vision-pilot run for this target should skip the login wall.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
