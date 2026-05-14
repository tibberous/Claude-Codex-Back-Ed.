"""
Hook File: _journal.py

What it does:
Seeds or journals hook-system reference text into MariaDB so the hook table and its usage notes can be restored or reloaded.

How to use it:
Run the script directly after adjusting the database credentials and target text. It is a maintenance helper, not a runtime app hook.

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : _journal.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Seeds or journals hook-system reference text into MariaDB so the hook table and its usage notes can be restored or reloaded.
#
# HOW TO INVOKE
#   Run the script directly after adjusting the database credentials and target text. It is a maintenance helper, not a runtime app hook.
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
from trio_hook_orm import upsert_journal_contains

entry = """[HOOKS SYSTEM - Full Reference]
Table: hooks | Columns: id, name, code, version (datetime, default NOW()), usage_info, man, created (datetime, default NOW()), newest (tinyint, default 1), author (varchar)
Versioning: flip newest=0 on old row, INSERT new row with newest=1
Hook path: C:\\Users\\moren\\Desktop\\hooks\\
PWD is always: C:\\Users\\moren\\Desktop
Environment: Windows 10, Python 3.12, PowerShell 5
Author field: model that wrote the hook (e.g. claude, gpt-4o)
Insert method: always use Python + parameterized queries (never mysql.exe -e for code)
MD5 verify: after inserting, read back from DB, md5 file vs db_code, confirm match

Log table for gtp_hook: gtp_hook_log | Columns: id, data (longtext), isError (tinyint default 0), sent (datetime default NOW())
All hook errors go in try/except -> logged to gtp_hook_log, nothing raised to caller

gtp_hook: COMPLETE. File at C:\\Users\\moren\\Desktop\\hooks\\gtp_hook.py. DB copy inserted. MD5 match confirmed (894e04e25dd4277e37c31ad476ddbf25).
Actions: chat(prompt, model, system, history) | send_file(filepath, purpose) | generate_image(prompt, model, size, quality, save_to) | get_file(file_id, save_to)
API key pulled at runtime from settings table key=openai_api_key. No hardcoded credentials."""

row_id = upsert_journal_contains("HOOKS SYSTEM", entry)
print(f"Upserted journal row {row_id}")
