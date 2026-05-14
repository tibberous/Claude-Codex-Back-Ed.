"""
Hook File: mouse_hook.py

What it does:
Minimal Windows mouse helper for reading the cursor position and moving it to absolute coordinates.

How to use it:
Run it from the command line for quick mouse get or move operations.

Primary entry points:
get_position, move_mouse, main

Primary classes:
POINT

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : mouse_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Minimal Windows mouse helper for reading the cursor position and moving it to absolute coordinates.
#
# HOW TO INVOKE
#   Run it from the command line for quick mouse get or move operations.
#
# PRIMARY ENTRY POINTS
#   - get_position
#   - move_mouse
#   - main
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
import ctypes
import json
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)

class POINT(ctypes.Structure):
    _fields_ = [('x', wintypes.LONG), ('y', wintypes.LONG)]


def get_position():
    pt = POINT()
    if not user32.GetCursorPos(ctypes.byref(pt)):
        raise ctypes.WinError(ctypes.get_last_error())
    return {'x': int(pt.x), 'y': int(pt.y)}


def move_mouse(x, y):
    if not user32.SetCursorPos(int(x), int(y)):
        raise ctypes.WinError(ctypes.get_last_error())
    return {'ok': True, 'x': int(x), 'y': int(y)}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: mouse_hook.py get|move [x] [y]'}))
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == 'get':
        print(json.dumps(get_position()))
    elif cmd == 'move':
        if len(sys.argv) != 4:
            print(json.dumps({'error': 'usage: mouse_hook.py move x y'}))
            sys.exit(1)
        print(json.dumps(move_mouse(sys.argv[2], sys.argv[3])))
    else:
        print(json.dumps({'error': f'unknown command: {cmd}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
