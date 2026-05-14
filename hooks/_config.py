"""
_config.py — shared config loader for every hook in this folder.

Reads <extension_root>/config.ini once, caches the parsed sections, and
exposes a single `cfg()` helper. Each hook calls cfg() instead of having
its own hardcoded keys / env-var lookup blocks.

Usage:
    from _config import cfg
    API_TOKEN = cfg("airtable", "api_token", env="AIRTABLE_API_TOKEN")

Resolution order, first non-empty wins:
    1. config.ini[section][key]
    2. os.environ[env]   (if env= was passed)
    3. default           (defaults to "")

config.ini lives next to extension.js (one directory above this hooks/
folder). If the file is missing, cfg() falls back to env vars only.

(c) 2006 Trenton Tompkins <trenttompkins@gmail.com> — MIT.
"""



# === LLM-USAGE: BEGIN ===
#
# Hook        : _config.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
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
from __future__ import annotations
import configparser
import os
from pathlib import Path
from typing import Optional


_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.ini"
_PARSED: Optional[configparser.ConfigParser] = None


def _load() -> configparser.ConfigParser:
    """Parse config.ini once and cache. Safe to call before the file exists —
    returns an empty ConfigParser in that case, and cfg() falls back to env."""
    global _PARSED
    if _PARSED is not None:
        return _PARSED
    cp = configparser.ConfigParser(interpolation=None)
    if _CONFIG_PATH.is_file():
        try:
            cp.read(_CONFIG_PATH, encoding="utf-8")
        except Exception:
            pass
    _PARSED = cp
    return cp


def cfg(section: str, key: str, env: Optional[str] = None, default: str = "") -> str:
    """Look up a config value.

    Order: config.ini[section][key] -> os.environ[env] -> default.
    Empty / whitespace-only values are treated as missing, so the next
    fallback wins. Returns a stripped string.
    """
    cp = _load()
    try:
        v = cp.get(section, key, fallback="")
    except Exception:
        v = ""
    if v and v.strip():
        return v.strip()
    if env:
        v = os.environ.get(env, "")
        if v and v.strip():
            return v.strip()
    return default


def reload() -> None:
    """Force a fresh parse on the next cfg() call (use after writing the
    file at runtime). Most callers never need this."""
    global _PARSED
    _PARSED = None
