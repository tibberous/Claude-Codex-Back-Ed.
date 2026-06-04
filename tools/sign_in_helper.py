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

# Targets whose login is a native email+password form we CAN drive headlessly
# via the bridge_runner.login() CDP path (no fragile JS injection — it uses
# Input.insertText into focused fields). Anything NOT in here (gemini=Google
# SSO, copilot=Microsoft account, claude=magic-link) requires a human in the
# loop and is DEGRADED to a clear "sign in manually" message by autoSignIn —
# we never spawn a second visible chrome that would fight the profile lock.
NATIVE_FORM_TARGETS = {"chatgpt", "deepseek", "grok"}

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


def _needsVisibleLogin(target: str) -> bool:
    """True for SSO / magic-link targets that cannot complete unattended."""
    return target not in NATIVE_FORM_TARGETS


def autoSignIn(target: str, visible: bool = True, timeout_s: int = 180) -> dict:
    """Programmatic, NON-INTERACTIVE sign-in for a bridge target.

    Reuses the SAME persistent profile dir + CDP port the vision-pilot
    attaches to (`_miniComputerProfileDir` / `MINICOMPUTER_CDP_PORTS`). For
    native-form targets (chatgpt / deepseek / grok) it drives the login via
    the bridge_runner.Bridge.login() CDP path — no fragile JS injection, no
    second chrome (it ATTACHES to the already-running tray chrome via
    MiniComputer.launch()'s idempotent _cdpAlive() check, then navigates that
    SAME tab to the login URL).

    For SSO / magic-link targets (gemini=Google, copilot=Microsoft,
    claude=magic-link) an unattended login almost always trips a CAPTCHA /
    account-picker / inbox-code wall. Rather than spawn a second VISIBLE chrome
    that would fight the single-writer profile lock, this DEGRADES to a clear
    manual-signin message — the caller surfaces it, no loop.

    Returns {ok, target, method, error?}. Does NOT call input().

    NOTE: untested at runtime here (requires a live Chrome + real login walls).
    """
    target = normalizeChatTarget(target)
    if target not in MINICOMPUTER_START_URLS:
        return {"ok": False, "target": target, "method": "none",
                "error": f"unknown target {target!r}"}

    # claude is being removed as a browser bridge — never attempt auto-login.
    if target == "claude":
        return {"ok": False, "target": target, "method": "skip-claude",
                "error": "claude browser bridge is being removed — no auto-login. "
                         "If needed, sign in manually: python tools/sign_in_helper.py claude"}

    # SSO / magic-link → cannot complete unattended. Degrade to manual, no loop.
    if _needsVisibleLogin(target):
        return {"ok": False, "target": target, "method": "degrade-manual",
                "error": f"{target} uses SSO / magic-link login that can't complete "
                         f"unattended — sign in manually: python tools/sign_in_helper.py {target}"}

    # Native email+password targets: drive the login headlessly via the runner.
    try:
        import start as _start  # type: ignore
        creds = _start._gptVisionPilotReadCredentials(target)
    except Exception as e:
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"credential read failed: {type(e).__name__}: {e}"}
    email = (creds.get("email") or "").strip()
    password = (creds.get("password") or "").strip()
    if not (email and password):
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"no creds in config.ini for {target} — add an [{target}] "
                         f"email/password section (or a usable [chatgpt] fallback)"}

    # Attach to the EXISTING per-target chrome (idempotent launch → _cdpAlive
    # attaches instead of spawning a second writer on the locked profile).
    mini = _start.getMiniComputer(target, offscreen=True, autostart=True)
    if mini is None:
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"MiniComputer unavailable for {target!r} (Chrome / deps?)"}

    # Resolve the plugin so we reuse its declared selectors + login_url.
    try:
        plugins = _start._loadBridgePlugins()
        plugin = plugins.get(target)
        if plugin is None:
            for _name, b in plugins.items():
                if target in (b.manifest.aliases or []):
                    plugin = b
                    break
    except Exception as e:
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"plugin load failed: {type(e).__name__}: {e}"}
    if plugin is None:
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"no bridge plugin registered for {target!r}"}

    # Make sure we're parked on the login surface before driving the form.
    login_url = LOGIN_URLS.get(target, MINICOMPUTER_START_URLS[target])
    try:
        if not plugin.is_logged_in(mini):
            mini.navigate(login_url)
    except Exception:  # navigate best-effort; login() re-navigates anyway
        pass

    try:
        r = plugin.login(mini, email, password, timeout_s=min(timeout_s, 60)) or {}
    except Exception as e:
        return {"ok": False, "target": target, "method": "native-form",
                "error": f"login() crashed: {type(e).__name__}: {e}"}
    if r.get("ok"):
        return {"ok": True, "target": target, "method": "native-form"}
    return {"ok": False, "target": target, "method": "native-form",
            "error": r.get("error") or "login did not complete"}


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
