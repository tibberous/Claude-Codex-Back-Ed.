"""
Hook File: sd_debug_hook.py

What it does:
Stable Diffusion environment debugger that records Python, pip, Torch, and CUDA state to a local log.

How to use it:
Run it when the local Stable Diffusion or Torch environment is not behaving and you need a quick diagnostic snapshot.

Primary entry points:
sh, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : sd_debug_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Stable Diffusion environment debugger that records Python, pip, Torch, and CUDA state to a local log.
#
# HOW TO INVOKE
#   Run it when the local Stable Diffusion or Torch environment is not behaving and you need a quick diagnostic snapshot.
#
# PRIMARY ENTRY POINTS
#   - sh
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
import json, os, sys, traceback
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\sd_debug_hook.log"

def sh(cmd):
    p = runHookCommand(cmd, phaseName="sd-debug", capture_output=True, text=True, shell=True)
    return {"returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

def main():
    data = {
        "time": datetime.now().isoformat(),
        "python_executable": sys.executable,
        "python_version": sys.version,
        "cwd": os.getcwd(),
        "where_python": sh("where python"),
        "where_pip": sh("where pip"),
        "pip_show_torch": sh(f'"{sys.executable}" -m pip show torch'),
    }
    try:
        import torch
        data["torch"] = {
            "import_ok": True,
            "version": getattr(torch, "__version__", None),
            "cuda_available": torch.cuda.is_available() if hasattr(torch, "cuda") else False,
            "device_count": torch.cuda.device_count() if hasattr(torch, "cuda") and torch.cuda.is_available() else 0,
        }
    except Exception as e:
        data["torch"] = {"import_ok": False, "error": repr(e), "traceback": traceback.format_exc()}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
