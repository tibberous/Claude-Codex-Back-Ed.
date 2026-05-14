"""
Hook File: _md5check.py

What it does:
Writes the current gtp_hook code into the hooks table and verifies the stored copy with an MD5 comparison.

How to use it:
Run it manually when you want to confirm the database copy of gtp_hook matches the file on disk.

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : _md5check.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Writes the current gtp_hook code into the hooks table and verifies the stored copy with an MD5 comparison.
#
# HOW TO INVOKE
#   Run it manually when you want to confirm the database copy of gtp_hook matches the file on disk.
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
import hashlib
from pathlib import Path

from trio_hook_orm import insert_hook_source, latest_hook_code

DEFAULT_PATH = Path(r"C:\\Users\\moren\\Desktop\\hooks\\gtp_hook.py")
LOCAL_PATH = Path(__file__).resolve().parent / "gtp_hook.py"
path = DEFAULT_PATH if DEFAULT_PATH.exists() else LOCAL_PATH
code = path.read_text(encoding="utf-8-sig")

inserted_id = insert_hook_source("gtp_hook", code, "claude")
db_code = latest_hook_code("gtp_hook") or ""

file_md5 = hashlib.md5(code.encode("utf-8")).hexdigest()
db_md5 = hashlib.md5(db_code.encode("utf-8")).hexdigest()

print(f"Inserted hook row: {inserted_id}")
print(f"File MD5: {file_md5}")
print(f"DB   MD5: {db_md5}")
print(f"Match:    {file_md5 == db_md5}")
