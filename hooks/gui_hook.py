"""
Hook File: gui_hook.py

What it does:
Local Windows GUI control hook that supports screenshots, live preview, mouse position, moves, clicks, and a small interactive control window.

How to use it:
Run it with CLI actions like gui, screenshot, get, move, or click to inspect or control the desktop.

Primary entry points:
main

Primary classes:
POINT, MouseGuiHook, GuiApp

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : gui_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Local Windows GUI control hook that supports screenshots, live preview, mouse position, moves, clicks, and a small interactive control window.
#
# HOW TO INVOKE
#   Run it with CLI actions like gui, screenshot, get, move, or click to inspect or control the desktop.
#
# PRIMARY ENTRY POINTS
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
import os
import sys
import json
import time
import ctypes
from ctypes import wintypes
from PIL import ImageGrab  # badimport-ok: import name provided by Pillow
import tkinter as tk
from tkinter import ttk

user32 = ctypes.WinDLL('user32', use_last_error=True)

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_MOVE = 0x0001

class POINT(ctypes.Structure):
    _fields_ = [('x', wintypes.LONG), ('y', wintypes.LONG)]

class MouseGuiHook:
    """
    gui_hook.py
    ===========
    Combined screen + mouse control hook.

    Features
    --------
    - Live screenshot refresh
    - Get current mouse position
    - Move mouse to absolute coordinates
    - Click, double click, right click
    - Click on a preview location by clicking the image

    CLI
    ---
    python gui_hook.py gui
    python gui_hook.py screenshot [save_to]
    python gui_hook.py get
    python gui_hook.py move <x> <y>
    python gui_hook.py click [left|right|double]

    Notes
    -----
    - Coordinates are screen coordinates in pixels.
    - The GUI preview is scaled to fit. Clicking the preview maps back to real screen coordinates.
    """

    def get_position(self):
        pt = POINT()
        if not user32.GetCursorPos(ctypes.byref(pt)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'x': int(pt.x), 'y': int(pt.y)}

    def move_mouse(self, x, y):
        if not user32.SetCursorPos(int(x), int(y)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'ok': True, 'x': int(x), 'y': int(y)}

    def _mouse_event(self, flags):
        user32.mouse_event(flags, 0, 0, 0, 0)

    def left_click(self):
        self._mouse_event(MOUSEEVENTF_LEFTDOWN)
        time.sleep(0.03)
        self._mouse_event(MOUSEEVENTF_LEFTUP)
        return {'ok': True, 'button': 'left'}

    def right_click(self):
        self._mouse_event(MOUSEEVENTF_RIGHTDOWN)
        time.sleep(0.03)
        self._mouse_event(MOUSEEVENTF_RIGHTUP)
        return {'ok': True, 'button': 'right'}

    def double_click(self):
        self.left_click()
        time.sleep(0.08)
        self.left_click()
        return {'ok': True, 'button': 'double'}

    def screenshot(self, save_to=None):
        if save_to is None:
            save_to = r'C:\Temp\gui_hook_capture.png'
        img = ImageGrab.grab(all_screens=True)
        img.save(save_to, format='PNG')
        return {'ok': True, 'path': save_to, 'size': img.size}

class GuiApp:
    def __init__(self, root):
        self.root = root
        self.root.title('GUI Hook')
        self.hook = MouseGuiHook()
        self.preview_max_w = 900
        self.preview_max_h = 600
        self.current_image = None
        self.tk_image = None
        self.scale_x = 1.0
        self.scale_y = 1.0
        self.offset_x = 0
        self.offset_y = 0
        self.screen_w = 0
        self.screen_h = 0

        top = ttk.Frame(root, padding=8)
        top.pack(fill='x')

        ttk.Button(top, text='Refresh Screen', command=self.refresh_screen).pack(side='left', padx=4)
        ttk.Button(top, text='Get Mouse Position', command=self.fill_current_position).pack(side='left', padx=4)
        ttk.Button(top, text='Move', command=self.move_from_entries).pack(side='left', padx=4)
        ttk.Button(top, text='Click', command=self.click_left).pack(side='left', padx=4)
        ttk.Button(top, text='Double Click', command=self.click_double).pack(side='left', padx=4)
        ttk.Button(top, text='Right Click', command=self.click_right).pack(side='left', padx=4)

        coords = ttk.Frame(root, padding=(8,0,8,8))
        coords.pack(fill='x')
        ttk.Label(coords, text='X').pack(side='left')
        self.x_var = tk.StringVar()
        self.x_entry = ttk.Entry(coords, textvariable=self.x_var, width=8)
        self.x_entry.pack(side='left', padx=(4,10))
        ttk.Label(coords, text='Y').pack(side='left')
        self.y_var = tk.StringVar()
        self.y_entry = ttk.Entry(coords, textvariable=self.y_var, width=8)
        self.y_entry.pack(side='left', padx=(4,10))
        self.status_var = tk.StringVar(value='Click Refresh Screen to load preview.')
        ttk.Label(coords, textvariable=self.status_var).pack(side='left', padx=10)

        self.canvas = tk.Canvas(root, width=self.preview_max_w, height=self.preview_max_h, bg='black', highlightthickness=1, highlightbackground='#888')
        self.canvas.pack(padx=8, pady=8)
        self.canvas.bind('<Button-1>', self.on_canvas_click)

        self.refresh_screen()

    def refresh_screen(self):
        from PIL import Image, ImageTk
        img = ImageGrab.grab(all_screens=True)
        self.current_image = img
        self.screen_w, self.screen_h = img.size

        ratio = min(self.preview_max_w / self.screen_w, self.preview_max_h / self.screen_h)
        disp_w = max(1, int(self.screen_w * ratio))
        disp_h = max(1, int(self.screen_h * ratio))
        self.scale_x = self.screen_w / disp_w
        self.scale_y = self.screen_h / disp_h
        self.offset_x = (self.preview_max_w - disp_w) // 2
        self.offset_y = (self.preview_max_h - disp_h) // 2

        resized = img.resize((disp_w, disp_h))
        self.tk_image = ImageTk.PhotoImage(resized)
        self.canvas.delete('all')
        self.canvas.create_image(self.offset_x, self.offset_y, anchor='nw', image=self.tk_image)
        self.status_var.set(f'Screen refreshed: {self.screen_w}x{self.screen_h}. Click image to pick coordinates.')

    def fill_current_position(self):
        pos = self.hook.get_position()
        self.x_var.set(str(pos['x']))
        self.y_var.set(str(pos['y']))
        self.status_var.set(f"Mouse at ({pos['x']}, {pos['y']})")

    def move_from_entries(self):
        x = int(self.x_var.get())
        y = int(self.y_var.get())
        self.hook.move_mouse(x, y)
        self.status_var.set(f'Moved mouse to ({x}, {y})')

    def click_left(self):
        self.hook.left_click()
        self.status_var.set('Left click sent.')

    def click_double(self):
        self.hook.double_click()
        self.status_var.set('Double click sent.')

    def click_right(self):
        self.hook.right_click()
        self.status_var.set('Right click sent.')

    def on_canvas_click(self, event):
        if self.current_image is None:
            return
        x = int((event.x - self.offset_x) * self.scale_x)
        y = int((event.y - self.offset_y) * self.scale_y)
        x = max(0, min(self.screen_w - 1, x))
        y = max(0, min(self.screen_h - 1, y))
        self.x_var.set(str(x))
        self.y_var.set(str(y))
        self.status_var.set(f'Picked coordinates ({x}, {y}) from preview.')


def main():
    hook = MouseGuiHook()
    args = sys.argv[1:]
    if not args or args[0].lower() == 'gui':
        root = tk.Tk()
        GuiApp(root)
        root.mainloop()
        return

    cmd = args[0].lower()
    if cmd == 'get':
        print(json.dumps(hook.get_position()))
    elif cmd == 'move':
        if len(args) != 3:
            print(json.dumps({'error': 'usage: gui_hook.py move x y'}))
            sys.exit(1)
        print(json.dumps(hook.move_mouse(args[1], args[2])))
    elif cmd == 'click':
        kind = args[1].lower() if len(args) > 1 else 'left'
        if kind == 'left':
            print(json.dumps(hook.left_click()))
        elif kind == 'right':
            print(json.dumps(hook.right_click()))
        elif kind == 'double':
            print(json.dumps(hook.double_click()))
        else:
            print(json.dumps({'error': 'usage: gui_hook.py click [left|right|double]'}))
            sys.exit(1)
    elif cmd == 'screenshot':
        save_to = args[1] if len(args) > 1 else None
        print(json.dumps(hook.screenshot(save_to)))
    else:
        print(json.dumps({'error': f'unknown command: {cmd}'}))
        sys.exit(1)

if __name__ == '__main__':
    main()
