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




# === LLM-USAGE: BEGIN ===
#
# Hook        : process_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   PowerShell process-management hook for listing, killing, and inspecting Windows processes.
#
# HOW TO INVOKE
#   Run the argparse actions defined in the file to inspect or control local processes from PowerShell.
#
# PRIMARY ENTRY POINTS
#   - run_ps
#   - log
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
