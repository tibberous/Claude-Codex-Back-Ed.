#!/usr/bin/env python3
"""
Windows-wide mouse + keyboard control. Pure ctypes, zero extra dependencies.

Usage (all coordinates are absolute screen pixels, multi-monitor aware):
  python mouse.py pos                          # print current x,y
  python mouse.py move <x> <y>
  python mouse.py click <x> <y>               # left click
  python mouse.py click <x> <y> right         # right click
  python mouse.py click <x> <y> double        # double left click
  python mouse.py click <x> <y> middle
  python mouse.py rclick <x> <y>              # shorthand right-click
  python mouse.py scroll <x> <y> <amount>     # amount: + = up, - = down (clicks)
  python mouse.py drag <x1> <y1> <x2> <y2>   # click-drag
  python mouse.py type <text>                  # type Unicode text at cursor
  python mouse.py key <name>                   # press a key: enter esc tab back f1..f12
                                               #   or decimal VK code e.g. 13

Claude workflow:
  Bash("python C:/Users/moren/claude-tools/mouse.py click 960 540")
  Bash("python C:/Users/moren/claude-tools/mouse.py type Hello world")
"""
import sys, time, ctypes
from ctypes import wintypes

u32 = ctypes.windll.user32

# mouse_event flags
LEFTDOWN   = 0x0002
LEFTUP     = 0x0004
RIGHTDOWN  = 0x0008
RIGHTUP    = 0x0010
MIDDLEDOWN = 0x0020
MIDDLEUP   = 0x0040
WHEEL      = 0x0800

# KEYBD flags
KEYEVENTF_KEYUP    = 0x0002
KEYEVENTF_UNICODE  = 0x0004

NAMED_KEYS = {
    'enter': 0x0D, 'return': 0x0D,
    'esc': 0x1B, 'escape': 0x1B,
    'tab': 0x09,
    'back': 0x08, 'backspace': 0x08,
    'del': 0x2E, 'delete': 0x2E,
    'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'home': 0x24, 'end': 0x23, 'pgup': 0x21, 'pgdn': 0x22,
    'ctrl': 0x11, 'shift': 0x10, 'alt': 0x12, 'win': 0x5B,
    'space': 0x20, 'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73,
    'f5': 0x74, 'f6': 0x75, 'f7': 0x76, 'f8': 0x77, 'f9': 0x78,
    'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
}

class POINT(ctypes.Structure):
    _fields_ = [('x', wintypes.LONG), ('y', wintypes.LONG)]

def pos():
    p = POINT()
    u32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y

def move(x, y):
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.04)

def _mevent(flags, wheel_delta=0):
    u32.mouse_event(flags, 0, 0, wheel_delta, 0)
    time.sleep(0.04)

def click(x, y, button='left'):
    move(x, y)
    time.sleep(0.05)
    if button == 'right':
        _mevent(RIGHTDOWN); _mevent(RIGHTUP)
    elif button == 'middle':
        _mevent(MIDDLEDOWN); _mevent(MIDDLEUP)
    elif button == 'double':
        _mevent(LEFTDOWN); _mevent(LEFTUP)
        time.sleep(0.06)
        _mevent(LEFTDOWN); _mevent(LEFTUP)
    else:  # left
        _mevent(LEFTDOWN); _mevent(LEFTUP)

def scroll(x, y, amount):
    move(x, y)
    # WHEEL_DELTA = 120 per click
    u32.mouse_event(WHEEL, 0, 0, int(amount) * 120, 0)

def drag(x1, y1, x2, y2):
    move(x1, y1)
    time.sleep(0.05)
    _mevent(LEFTDOWN)
    # Move in small steps for reliability
    steps = 20
    for i in range(1, steps + 1):
        ix = int(x1 + (x2 - x1) * i / steps)
        iy = int(y1 + (y2 - y1) * i / steps)
        u32.SetCursorPos(ix, iy)
        time.sleep(0.01)
    _mevent(LEFTUP)

def press_key(vk):
    u32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.04)
    u32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

def type_text(text):
    # Use SendInput with Unicode for reliable multilingual input
    INPUT_KEYBOARD = 1
    KEYEVENTF_UNICODE = 0x0004

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD),
                    ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD),
                    ('dwExtraInfo', ctypes.POINTER(wintypes.ULONG))]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [('ki', KEYBDINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [('type', wintypes.DWORD), ('_input', _INPUT_UNION)]

    for ch in text:
        code = ord(ch)
        for flag in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inp = INPUT(type=INPUT_KEYBOARD,
                        _input=_INPUT_UNION(ki=KEYBDINPUT(wVk=0, wScan=code, dwFlags=flag,
                                                           time=0, dwExtraInfo=None)))
            ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.01)

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0].lower()

    if cmd == 'pos':
        x, y = pos()
        print(f'{x},{y}')

    elif cmd == 'move' and len(args) >= 3:
        move(int(args[1]), int(args[2]))
        print(f'moved to {args[1]},{args[2]}')

    elif cmd in ('click', 'rclick') and len(args) >= 3:
        btn = 'right' if cmd == 'rclick' else (args[3] if len(args) > 3 else 'left')
        click(int(args[1]), int(args[2]), btn)
        print(f'{btn} click at {args[1]},{args[2]}')

    elif cmd == 'scroll' and len(args) >= 4:
        scroll(int(args[1]), int(args[2]), int(args[3]))
        print(f'scrolled {args[3]} at {args[1]},{args[2]}')

    elif cmd == 'drag' and len(args) >= 5:
        drag(int(args[1]), int(args[2]), int(args[3]), int(args[4]))
        print(f'dragged ({args[1]},{args[2]}) -> ({args[3]},{args[4]})')

    elif cmd == 'type' and len(args) >= 2:
        text = ' '.join(args[1:])
        type_text(text)
        print(f'typed: {text[:60]}{"..." if len(text) > 60 else ""}')

    elif cmd == 'key' and len(args) >= 2:
        k = args[1].lower()
        vk = NAMED_KEYS.get(k) or int(k)
        press_key(vk)
        print(f'pressed key {k} (VK {vk})')

    else:
        print(f'unknown command: {cmd}')
        sys.exit(1)
