"""
Hook File: gd_placeholder_hook.py

What it does:
Manifest or reminder hook that explains GD is a PHP extension and not a standalone Windows CLI tool.

How to use it:
Run it with `status` or `man` when you want a logged placeholder response for GD-related tasks.

Primary entry points:
main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : gd_placeholder_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Manifest or reminder hook that explains GD is a PHP extension and not a standalone Windows CLI tool.
#
# HOW TO INVOKE
#   Run it with `status` or `man` when you want a logged placeholder response for GD-related tasks.
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
import argparse, json
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\gd_placeholder_hook.log"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["status","man"])
    args = ap.parse_args()
    data = {"time": datetime.now().isoformat(), "message": "GD is a PHP extension, not a standalone Windows CLI. Use this hook as a manifest/reminder hook for server-side GD tasks.", "action": args.action}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(data)+"\n")
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
