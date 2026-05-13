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
