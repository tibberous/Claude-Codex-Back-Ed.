"""
Hook File: service_hook.py

What it does:
Windows service wrapper built on PowerShell for status, start, stop, restart, and list operations.

How to use it:
Run `python service_hook.py <action> [name]` to manage Windows services.

Primary entry points:
run_ps, log, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import argparse, json
from trio_hook_lifecycle import runHookCommand
from datetime import datetime

LOG = r"C:\Users\moren\Desktop\hooks\service_hook.log"

def run_ps(cmd):
    p = runHookCommand(["powershell","-NoProfile","-Command",cmd], phaseName="powershell-hook", capture_output=True, text=True)
    return {"returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

def log(obj):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": datetime.now().isoformat(), **obj}, ensure_ascii=False) + "\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["status","start","stop","restart","list"])
    ap.add_argument("name", nargs='?')
    args = ap.parse_args()
    if args.action == "list":
        res = run_ps("Get-Service | Select-Object Name,Status,DisplayName | ConvertTo-Json -Depth 3")
    else:
        if not args.name:
            raise SystemExit("service name required")
        mapping = {
            "status": f"Get-Service -Name '{args.name}' | Select-Object Name,Status,DisplayName | ConvertTo-Json -Depth 3",
            "start": f"Start-Service -Name '{args.name}'; Get-Service -Name '{args.name}' | Select-Object Name,Status | ConvertTo-Json -Depth 3",
            "stop": f"Stop-Service -Name '{args.name}'; Get-Service -Name '{args.name}' | Select-Object Name,Status | ConvertTo-Json -Depth 3",
            "restart": f"Restart-Service -Name '{args.name}'; Get-Service -Name '{args.name}' | Select-Object Name,Status | ConvertTo-Json -Depth 3",
        }
        res = run_ps(mapping[args.action])
    log({"args": vars(args), "result": res})
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
