"""
Hook File: curl_verify_hook.py

What it does:
Runs curl.exe against a URL, captures headers and body output, and appends the result to a local verification log.

How to use it:
Run `python curl_verify_hook.py <url>` when you want a quick logged fetch test from the local machine.

Primary entry points:
main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import argparse, json
from trio_hook_lifecycle import runHookCommand
from datetime import datetime
LOG = r"C:\Users\moren\Desktop\hooks\curl_verify_hook.log"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    args = ap.parse_args()
    p = runHookCommand(["curl.exe","-i","-L",args.url], phaseName="curl-verify", capture_output=True, text=True)
    data = {"time": datetime.now().isoformat(), "url": args.url, "returncode": p.returncode, "stdout": p.stdout[:4000], "stderr": p.stderr}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
