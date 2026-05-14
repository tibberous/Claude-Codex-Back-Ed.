"""
Hook File: env_audit_hook.py

What it does:
Audits the local Python and Torch environment, including executable paths, pip state, and CUDA availability, and logs the results.

How to use it:
Run it directly when diagnosing Python, pip, Torch, or CUDA environment problems on the local machine.

Primary entry points:
cmd, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : env_audit_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Audits the local Python and Torch environment, including executable paths, pip state, and CUDA availability, and logs the results.
#
# HOW TO INVOKE
#   Run it directly when diagnosing Python, pip, Torch, or CUDA environment problems on the local machine.
#
# PRIMARY ENTRY POINTS
#   - cmd
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
import json, os, shutil, sys
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\env_audit_hook.log"

def cmd(c):
    p = runHookCommand(c, phaseName="env-audit", capture_output=True, text=True, shell=True)
    return {"returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

def main():
    data = {
        "time": datetime.now().isoformat(),
        "python_executable": sys.executable,
        "python_version": sys.version,
        "where_python": cmd("where python"),
        "where_pip": cmd("where pip"),
        "pip_show_torch": cmd(f'"{sys.executable}" -m pip show torch'),
        "pip_list_torch": cmd(f'"{sys.executable}" -m pip list | findstr torch'),
    }
    try:
        import torch
        data["torch_import"] = {"ok": True, "version": getattr(torch, "__version__", None), "cuda": getattr(torch.cuda, "is_available", lambda: False)()}
    except Exception as e:
        data["torch_import"] = {"ok": False, "error": repr(e)}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
