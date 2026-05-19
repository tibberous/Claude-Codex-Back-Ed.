#!/usr/bin/env python3
"""open_external.py — open a URL in a real desktop browser.

Used by the Codex Black Ed. NN4 browser About/Help modals so links do NOT
open inside the VSCode webview. Stdlib only, distributable.

Usage:  py -3 open_external.py https://example.com

Fallback order: Chrome -> Firefox -> Edge. Launches the first installed
browser detached, prints which one it used, exits 0. If none found OR the
URL is not http/https, prints a message and exits nonzero.
"""
import os
import shutil
import subprocess
import sys


def _expand(p):
    return os.path.expandvars(p)


def _candidates():
    """Return ordered list of (label, [paths...]) to probe."""
    return [
        ("chrome", [
            _expand(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            _expand(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            _expand(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
            shutil.which("chrome"),
        ]),
        ("firefox", [
            _expand(r"%ProgramFiles%\Mozilla Firefox\firefox.exe"),
            _expand(r"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"),
            shutil.which("firefox"),
        ]),
        ("edge", [
            _expand(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            _expand(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            shutil.which("msedge"),
        ]),
    ]


def _resolve(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def main(argv):
    if len(argv) < 2 or not argv[1].strip():
        print("open_external: no URL given", file=sys.stderr)
        return 2
    url = argv[1].strip()
    low = url.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        print("open_external: refusing non-http(s) URL: " + url, file=sys.stderr)
        return 3

    for label, paths in _candidates():
        exe = _resolve(paths)
        if not exe:
            continue
        try:
            kwargs = {}
            if os.name == "nt":
                # Detach so the browser outlives this helper / VSCode.
                kwargs["creationflags"] = (
                    getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
                )
            subprocess.Popen([exe, url], close_fds=True, **kwargs)
        except Exception as e:  # noqa: BLE001 - report which browser failed
            print("open_external: %s failed to launch: %s" % (label, e),
                  file=sys.stderr)
            continue
        print(label)
        return 0

    print("open_external: no browser found (chrome/firefox/edge)",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
