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
