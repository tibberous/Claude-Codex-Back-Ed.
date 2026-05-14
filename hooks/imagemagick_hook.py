"""
Hook File: imagemagick_hook.py

What it does:
ImageMagick wrapper for status checks and common image transforms such as convert, resize, square padding, crop, favicon, and montage work.

How to use it:
Run the argparse subcommands after ImageMagick is installed and discoverable by the local machine.

Primary entry points:
find_magick, log, emit, run, ensure_parent, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : imagemagick_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   ImageMagick wrapper for status checks and common image transforms such as convert, resize, square padding, crop, favicon, and montage work.
#
# HOW TO INVOKE
#   Run the argparse subcommands after ImageMagick is installed and discoverable by the local machine.
#
# PRIMARY ENTRY POINTS
#   - find_magick
#   - log
#   - emit
#   - run
#   - ensure_parent
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
import argparse, json, shutil, sys
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
from pathlib import Path

BASE = Path(r"C:\Users\moren\Desktop\hooks")
LOG = BASE / "imagemagick_hook.log"
DB_LOG = BASE / "imagemagick_hook_db.txt"
CANDIDATES = [
    shutil.which("magick"),
    r"C:\Program Files\ImageMagick-7.1.1-Q16-HDRI\magick.exe",
    r"C:\Program Files\ImageMagick-7.1.1-Q16\magick.exe",
    r"C:\Program Files\ImageMagick-7.1.0-Q16-HDRI\magick.exe",
    r"C:\Program Files\ImageMagick-7.1.0-Q16\magick.exe",
]


def find_magick():
    for c in CANDIDATES:
        if c and Path(c).exists():
            return str(c)
    return None


def log(entry):
    BASE.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def emit(obj, code=0):
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    raise SystemExit(code)


def run(cmd):
    p = runHookCommand(cmd, phaseName="imagemagick", capture_output=True, text=True)
    result = {
        "time": datetime.now().isoformat(),
        "cmd": cmd,
        "returncode": p.returncode,
        "stdout": p.stdout,
        "stderr": p.stderr,
    }
    log(result)
    return result


def ensure_parent(path_str):
    Path(path_str).parent.mkdir(parents=True, exist_ok=True)


def main():
    ap = argparse.ArgumentParser(description="ImageMagick helper hook")
    sub = ap.add_subparsers(dest="action", required=True)

    s = sub.add_parser("status", help="Show ImageMagick availability")

    v = sub.add_parser("version", help="Show ImageMagick version")

    c = sub.add_parser("convert", help="Convert file format")
    c.add_argument("src")
    c.add_argument("dest")

    r = sub.add_parser("resize", help="Resize image")
    r.add_argument("src")
    r.add_argument("dest")
    r.add_argument("size", help="e.g. 800x800 or 800x")

    p = sub.add_parser("pad_square", help="Resize and pad to square canvas")
    p.add_argument("src")
    p.add_argument("dest")
    p.add_argument("size", help="e.g. 256")
    p.add_argument("--background", default="none")

    cr = sub.add_parser("crop_center", help="Crop centered square")
    cr.add_argument("src")
    cr.add_argument("dest")
    cr.add_argument("size", help="e.g. 512")

    ico = sub.add_parser("favicon", help="Generate favicon.ico")
    ico.add_argument("src")
    ico.add_argument("dest")

    idn = sub.add_parser("identify", help="Identify image info")
    idn.add_argument("src")

    args = ap.parse_args()
    magick = find_magick()

    if args.action == "status":
        emit({
            "ok": magick is not None,
            "magick": magick,
            "log": str(LOG)
        }, 0 if magick else 1)

    if not magick:
        emit({"ok": False, "error": "ImageMagick not found", "checked": CANDIDATES, "log": str(LOG)}, 1)

    if args.action == "version":
        result = run([magick, "-version"])
        emit(result, result["returncode"])

    elif args.action == "convert":
        ensure_parent(args.dest)
        result = run([magick, args.src, args.dest])
        emit(result, result["returncode"])

    elif args.action == "resize":
        ensure_parent(args.dest)
        result = run([magick, args.src, "-resize", args.size, args.dest])
        emit(result, result["returncode"])

    elif args.action == "pad_square":
        ensure_parent(args.dest)
        extent = f"{args.size}x{args.size}"
        result = run([
            magick, args.src,
            "-thumbnail", extent,
            "-background", args.background,
            "-gravity", "center",
            "-extent", extent,
            args.dest
        ])
        emit(result, result["returncode"])

    elif args.action == "crop_center":
        ensure_parent(args.dest)
        extent = f"{args.size}x{args.size}"
        result = run([
            magick, args.src,
            "-gravity", "center",
            "-resize", extent + "^",
            "-crop", extent + "+0+0",
            "+repage",
            args.dest
        ])
        emit(result, result["returncode"])

    elif args.action == "favicon":
        ensure_parent(args.dest)
        result = run([
            magick, args.src,
            "-background", "none",
            "-gravity", "center",
            "-resize", "256x256",
            "-extent", "256x256",
            "-define", "icon:auto-resize=16,32,48,64,128,256",
            args.dest
        ])
        emit(result, result["returncode"])

    elif args.action == "identify":
        result = run([magick, "identify", "-verbose", args.src])
        emit(result, result["returncode"])

if __name__ == "__main__":
    main()
