"""
Hook File: trio_hook_lifecycle.py

What it does:
Compatibility shim that re-exports the public surface of hook_lifecycle under the trio_-prefixed name so legacy callers keep importing.

How to use it:
Do not write new code against this module; import from hook_lifecycle directly. This file exists only to keep older imports working.

Primary entry points:
HookCompletedProcess, HookPhase, runHookCommand, startHookProcess, killHookPid

Notes:
This comment block documents the current code in this file. The shim has no behavior of its own; it is a pure passthrough.
"""


# === LLM-USAGE: BEGIN ===
#
# Hook        : trio_hook_lifecycle.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Compatibility shim that re-exports the public surface of hook_lifecycle under the trio_-prefixed name so legacy callers keep importing.
#
# HOW TO INVOKE
#   Do not write new code against this module; import from hook_lifecycle directly. This file exists only to keep older imports working.
#
# PRIMARY ENTRY POINTS
#   - HookCompletedProcess
#   - HookPhase
#   - runHookCommand
#   - startHookProcess
#   - killHookPid
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
# Compatibility shim — import from hook_lifecycle instead.
from hook_lifecycle import *  # noqa: F401,F403
from hook_lifecycle import (
    HookCompletedProcess,
    HookPhase,
    runHookCommand,
    startHookProcess,
    killHookPid,
)
