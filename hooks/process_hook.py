"""
Hook File: process_hook.py

What it does:
PowerShell process-management hook for listing, killing, and inspecting Windows processes.

How to use it:
Run the argparse actions defined in the file to inspect or control local processes from PowerShell.

Primary entry points:
run_ps, log, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import argparse, json
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\process_hook.log"

def run_ps(cmd):
    p = runHookCommand(["powershell","-NoProfile","-Command",cmd], phaseName="powershell-hook", capture_output=True, text=True)
    return {"returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

def log(obj):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": datetime.now().isoformat(), **obj}) + "\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["list","find","kill"])
    ap.add_argument("name", nargs='?')
    args = ap.parse_args()
    if args.action == "list":
        res = run_ps("Get-Process | Select-Object ProcessName,Id,CPU,WS | ConvertTo-Json -Depth 3")
    elif args.action == "find":
        res = run_ps(f"Get-Process -Name '{args.name}' -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,CPU,WS | ConvertTo-Json -Depth 3")
    else:
        res = run_ps(f"Get-Process -Name '{args.name}' -ErrorAction SilentlyContinue | Stop-Process -Force -PassThru | Select-Object ProcessName,Id | ConvertTo-Json -Depth 3")
    log({"args": vars(args), "result": res})
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
