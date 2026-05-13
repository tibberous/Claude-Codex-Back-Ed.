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
