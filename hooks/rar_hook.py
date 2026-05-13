"""
Hook File: rar_hook.py

What it does:
WinRAR helper for listing, testing, extracting, and adding to RAR archives while logging command results.

How to use it:
Run the supported archive actions after confirming WinRAR or UnRAR exists at the configured path.

Primary entry points:
pick, run, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import argparse, json, os
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\rar_hook.log"
RAR = r"C:\Program Files\WinRAR\Rar.exe"
UNRAR = r"C:\Program Files\WinRAR\UnRAR.exe"

def pick():
    if os.path.exists(RAR): return RAR
    if os.path.exists(UNRAR): return UNRAR
    return None

def run(cmd):
    p = runHookCommand(cmd, phaseName="rar", capture_output=True, text=True)
    out = {"returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": datetime.now().isoformat(), "cmd": cmd, "result": out})+"\n")
    print(json.dumps(out, indent=2))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["list","extract","create"])
    ap.add_argument("archive")
    ap.add_argument("target", nargs='?')
    args = ap.parse_args()
    exe = pick()
    if not exe:
        print(json.dumps({"error":"WinRAR not found at C:\\Program Files\\WinRAR\\Rar.exe or UnRAR.exe"}, indent=2))
        return
    if args.action == "list":
        run([exe, "lb", args.archive])
    elif args.action == "extract":
        if not args.target: raise SystemExit("target dir required")
        run([exe, "x", "-o+", args.archive, args.target])
    else:
        if not args.target: raise SystemExit("target path/file required")
        run([exe, "a", args.archive, args.target])

if __name__ == "__main__":
    main()
