"""
Hook File: _md5check.py

What it does:
Writes the current gtp_hook code into the hooks table and verifies the stored copy with an MD5 comparison.

How to use it:
Run it manually when you want to confirm the database copy of gtp_hook matches the file on disk.

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

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
