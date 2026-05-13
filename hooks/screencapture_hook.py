"""
Hook File: screencapture_hook.py

What it does:
Primary screen-capture hook that can grab the full screen, a region, or a window and return files, raw bytes, or base64 payloads.

How to use it:
Use capture, capture_window, capture_blob, or capture_b64 when another tool needs a screenshot saved to disk or passed onward.

Primary entry points:
db_connect, ensure_log_table, log, ensure_dir, auto_path, _find_window_rect, _grab, capture, capture_blob, capture_b64, list_windows, capture_window

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import io
import json
import base64
import datetime
import traceback
from PIL import ImageGrab  # badimport-ok: import name provided by Pillow
from trio_hook_orm import ensure_log_table as orm_ensure_log_table, log_hook


def ensure_log_table():
    orm_ensure_log_table("screencapture_hook_log")

def log(message, is_error=0):
    try:
        log_hook("screencapture_hook_log", str(message), int(is_error))
    except Exception:
        pass


DEFAULT_DIR = r"C:\Temp\screenshots"


def ensure_dir(path):
    if path:
        os.makedirs(path, exist_ok=True)


def auto_path(ext="png"):
    ensure_dir(DEFAULT_DIR)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(DEFAULT_DIR, f"screenshot_{ts}.{ext}")


def _find_window_rect(title_fragment, padding=8):
    import ctypes
    import ctypes.wintypes
    user32 = ctypes.windll.user32
    found_hwnd = None

    def enum_cb(hwnd, _lParam):
        nonlocal found_hwnd
        if found_hwnd:
            return True
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                if title_fragment.lower() in buf.value.lower():
                    found_hwnd = hwnd
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    cb = WNDENUMPROC(enum_cb)
    user32.EnumWindows(cb, 0)
    if not found_hwnd:
        raise RuntimeError(f"No visible window found matching: '{title_fragment}'")
    rect = ctypes.wintypes.RECT()
    user32.GetWindowRect(found_hwnd, ctypes.byref(rect))
    x1 = max(0, rect.left - padding)
    y1 = max(0, rect.top - padding)
    x2 = rect.right + padding
    y2 = rect.bottom + padding
    return (x1, y1, x2, y2)


def _grab(region=None, window_title=None, padding=8):
    bbox = region
    if window_title:
        bbox = _find_window_rect(window_title, padding=padding)
    return ImageGrab.grab(bbox=bbox, all_screens=True)


def capture(save_to=None, region=None):
    try:
        ensure_log_table()
        if save_to is None:
            save_to = auto_path("png")
        ensure_dir(os.path.dirname(save_to))
        img = _grab(region=region)
        img.save(save_to, format="PNG")
        log(f"capture OK -> {save_to}")
        return save_to
    except Exception:
        log(f"capture ERROR: {traceback.format_exc()}", is_error=1)
        raise


def capture_blob(region=None, window_title=None, padding=8, compress_level=6):
    try:
        ensure_log_table()
        img = _grab(region=region, window_title=window_title, padding=padding)
        bio = io.BytesIO()
        img.save(bio, format="PNG", compress_level=compress_level)
        data = bio.getvalue()
        log(f"capture_blob OK bytes={len(data)} region={region} window_title={window_title}")
        return data
    except Exception:
        log(f"capture_blob ERROR: {traceback.format_exc()}", is_error=1)
        raise


def capture_b64(region=None, window_title=None, padding=8, compress_level=6):
    data = capture_blob(region=region, window_title=window_title, padding=padding, compress_level=compress_level)
    img = _grab(region=region, window_title=window_title, padding=padding)
    return {
        "format": "PNG",
        "mode": img.mode,
        "width": img.size[0],
        "height": img.size[1],
        "bytes": len(data),
        "b64": base64.b64encode(data).decode("ascii")
    }


def list_windows():
    import ctypes
    import ctypes.wintypes
    user32 = ctypes.windll.user32
    titles = []

    def enum_cb(hwnd, _lParam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                titles.append(buf.value)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    cb = WNDENUMPROC(enum_cb)
    user32.EnumWindows(cb, 0)
    return titles


def capture_window(title_fragment, save_to=None, padding=8):
    try:
        ensure_log_table()
        region = _find_window_rect(title_fragment, padding=padding)
        if save_to is None:
            save_to = auto_path("png")
        ensure_dir(os.path.dirname(save_to))
        img = _grab(region=region)
        img.save(save_to, format="PNG")
        log(f"capture_window OK title='{title_fragment}' -> {save_to}")
        return save_to
    except Exception:
        log(f"capture_window ERROR: {traceback.format_exc()}", is_error=1)
        raise


def capture_to_model(prompt, model="gpt-4.1-mini", save_to=None, region=None, window_title=None, padding=8):
    try:
        from file_to_model import analyze
        path = capture_window(window_title, save_to=save_to, padding=padding) if window_title else capture(save_to=save_to, region=region)
        result = analyze(path, prompt, model=model)
        if isinstance(result, dict):
            result["captured_file"] = path
            result["flow"] = "screencapture_hook -> file_to_model.analyze"
        log({"action": "capture_to_model", "captured_file": path, "model": model, "prompt": str(prompt)[:200]})
        return result
    except Exception:
        log(f"capture_to_model ERROR: {traceback.format_exc()}", is_error=1)
        raise


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    action = args[0].lower()
    if action == "capture":
        save_to = args[1] if len(args) > 1 else None
        region = None
        if len(args) >= 6:
            region = (int(args[2]), int(args[3]), int(args[4]), int(args[5]))
        path = capture(save_to=save_to, region=region)
        print(f"Saved: {path}")

    elif action == "capture_window":
        if len(args) < 2:
            print("Usage: screencapture_hook.py capture_window <title_fragment> [save_to]")
            sys.exit(1)
        title_fragment = args[1]
        save_to = args[2] if len(args) > 2 else None
        path = capture_window(title_fragment, save_to=save_to)
        print(f"Saved: {path}")

    elif action == "capture_b64":
        region = None
        if len(args) == 5:
            region = (int(args[1]), int(args[2]), int(args[3]), int(args[4]))
        result = capture_b64(region=region)
        print(json.dumps(result))

    elif action == "capture_to_model":
        prompt = args[1] if len(args) > 1 else "Describe what is on this screen."
        model = args[2] if len(args) > 2 else "gpt-4.1-mini"
        result = capture_to_model(prompt=prompt, model=model)
        print(json.dumps(result, indent=2))

    elif action == "list_windows":
        print(json.dumps(list_windows(), indent=2))

    else:
        print(f"Unknown action: {action}")
        sys.exit(1)
