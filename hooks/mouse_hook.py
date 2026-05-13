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
