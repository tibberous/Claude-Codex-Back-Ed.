"""
Hook File: winscp_hook.py

What it does:
Full WinSCP.com automation hook for remote put/get/list/stat/mkdir/rm/mv/pwd operations using either saved sessions or explicit connection data.

How to use it:
Pass a JSON payload with action and connection details to the run function or CLI entrypoint described in the file.

Primary entry points:
_md5_bytes, _md5_file, _find_winscp, _quote_script_arg, _build_open_target, _normalize_remote_target, _write_inline_temp_file, _build_script_lines, run

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : winscp_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Full WinSCP.com automation hook for remote put/get/list/stat/mkdir/rm/mv/pwd operations using either saved sessions or explicit connection data.
#
# HOW TO INVOKE
#   Pass a JSON payload with action and connection details to the run function or CLI entrypoint described in the file.
#
# PRIMARY ENTRY POINTS
#   - _md5_bytes
#   - _md5_file
#   - _find_winscp
#   - _quote_script_arg
#   - _build_open_target
#   - _normalize_remote_target
#   - _write_inline_temp_file
#   - _build_script_lines
#   - run
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
import os
import json
import base64
import hashlib
import tempfile
from trio_hook_lifecycle import runHookCommand
import shlex
from pathlib import Path
from typing import Any, Dict, List, Optional

HOOK_NAME = "winscp_hook"
DESCRIPTION = """
WinSCP remote file operations hook.

USAGE OVERVIEW
- action: one of put, get, ls, mkdir, rm, mv, pwd, stat, call
- connection: either a saved session name or explicit connection details
- Supports WinSCP.com scripting with machine-local saved sessions or explicit URLs.

INPUT SHAPE
{
  "action": "put|get|ls|mkdir|rm|mv|pwd|stat|call",
  "connection": {
    "session": "vps"
  },
  "remote_dir": "/home/fullpriceexit/tmp",
  "remote_name": "hello.txt",
  "local_path": "C:\\temp\\hello.txt",
  "data_text": "hello world",
  "data_base64": "aGVsbG8=",
  "timeout": 120,
  "transfer_mode": "binary|ascii",
  "preserve_time": false,
  "raw_transfer_settings": {"PreserveTimeDirs": "1"}
}

CONNECTION OPTIONS
1) Saved session:
{
  "connection": { "session": "vps" }
}

2) Explicit connection:
{
  "connection": {
    "protocol": "sftp",
    "host": "example.com",
    "username": "trent",
    "password": "secret",
    "port": 22,
    "hostkey": "ssh-ed25519 255 xx:xx:xx..."
  }
}

ACTION EXAMPLES
PUT a local file:
{
  "action": "put",
  "connection": {"session": "vps"},
  "local_path": "C:\\temp\\deploy.txt",
  "remote_dir": "/home/fullpriceexit/tmp",
  "remote_name": "deploy.txt"
}

PUT inline text:
{
  "action": "put",
  "connection": {"session": "vps"},
  "remote_dir": "/home/fullpriceexit/tmp",
  "remote_name": "hello.txt",
  "data_text": "hello world"
}

GET a file:
{
  "action": "get",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/tmp/secret.txt",
  "local_path": "C:\\temp\\secret.txt"
}

LIST a directory:
{
  "action": "ls",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/tmp"
}

MAKE DIRECTORY:
{
  "action": "mkdir",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/releases"
}

REMOVE FILE OR DIRECTORY:
{
  "action": "rm",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/tmp/old.txt"
}

MOVE/RENAME:
{
  "action": "mv",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/tmp/a.txt",
  "remote_path_to": "/home/fullpriceexit/tmp/b.txt"
}

PRINT WORKING DIRECTORY:
{
  "action": "pwd",
  "connection": {"session": "vps"}
}

STAT PATH:
{
  "action": "stat",
  "connection": {"session": "vps"},
  "remote_path": "/home/fullpriceexit/tmp/secret.txt"
}

RUN RAW REMOTE COMMAND:
{
  "action": "call",
  "connection": {"session": "vps"},
  "command": "cat /home/fullpriceexit/tmp/secret.txt"
}

NOTES
- For automation, explicit URLs plus hostkey are stronger than saved sessions.
- For saved sessions, WinSCP itself warns not to rely on them for portable automation.
- Returns stdout/stderr, parsed script/log details, and action metadata.
""".strip()


def _md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _md5_file(path: str) -> Optional[str]:
    if not path or not os.path.exists(path):
        return None
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_winscp() -> str:
    candidates = [
        r"C:\Program Files (x86)\WinSCP\WinSCP.com",
        r"C:\Program Files\WinSCP\WinSCP.com",
        "WinSCP.com",
    ]
    for c in candidates:
        if c == "WinSCP.com":
            return c
        if os.path.exists(c):
            return c
    return "WinSCP.com"


def _quote_script_arg(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _build_open_target(connection: Dict[str, Any]) -> str:
    session = connection.get("session") or connection.get("saved_session")
    if session:
        return str(session)

    protocol = connection.get("protocol", "sftp")
    host = connection.get("host")
    username = connection.get("username")
    password = connection.get("password")
    port = connection.get("port")
    hostkey = connection.get("hostkey")

    if not host or not username:
        raise ValueError("connection.host and connection.username are required when not using connection.session")

    auth = username
    if password is not None:
        auth += ":" + password
    target = f"{protocol}://{auth}@{host}"
    if port:
        target += f":{int(port)}"
    if hostkey:
        target += f" -hostkey={_quote_script_arg(str(hostkey))}"
    return target


def _normalize_remote_target(remote_dir: Optional[str], remote_name: Optional[str], remote_path: Optional[str]) -> str:
    if remote_path:
        return remote_path
    if remote_dir and remote_name:
        return remote_dir.rstrip("/") + "/" + remote_name
    if remote_dir:
        return remote_dir
    if remote_name:
        return remote_name
    raise ValueError("remote_path or remote_dir/remote_name is required")


def _write_inline_temp_file(payload: Dict[str, Any], suggested_name: Optional[str] = None) -> Optional[str]:
    data_text = payload.get("data_text")
    data_base64 = payload.get("data_base64")
    if data_text is None and data_base64 is None:
        return None

    suffix = ""
    if suggested_name:
        suffix = Path(suggested_name).suffix

    fd, temp_path = tempfile.mkstemp(prefix="winscp_hook_", suffix=suffix)
    os.close(fd)

    if data_base64 is not None:
        data = base64.b64decode(data_base64)
        with open(temp_path, "wb") as f:
            f.write(data)
    else:
        with open(temp_path, "w", encoding="utf-8", newline="") as f:
            f.write(str(data_text))
    return temp_path


def _build_script_lines(payload: Dict[str, Any], temp_local_file: Optional[str]) -> List[str]:
    action = (payload.get("action") or "put").lower().strip()
    connection = payload.get("connection") or {}
    timeout = int(payload.get("timeout") or 120)
    transfer_mode = (payload.get("transfer_mode") or "binary").lower()
    preserve_time = payload.get("preserve_time")
    raw_transfer_settings = payload.get("raw_transfer_settings") or {}

    lines: List[str] = [
        "option batch abort",
        "option confirm off",
        f"open {_build_open_target(connection)}",
    ]

    if timeout:
        lines.append(f"option transfer {_quote_script_arg(transfer_mode)}")

    local_path = payload.get("local_path") or temp_local_file
    remote_path = payload.get("remote_path")
    remote_dir = payload.get("remote_dir")
    remote_name = payload.get("remote_name") or payload.get("file_name")

    if action == "put":
        if not local_path:
            raise ValueError("put requires local_path or inline data_text/data_base64")
        target = _normalize_remote_target(remote_dir, remote_name, remote_path)
        cmd = f"put {_quote_script_arg(local_path)} {_quote_script_arg(target)}"
        if preserve_time is False:
            raw_transfer_settings = {**raw_transfer_settings, "PreserveTime": "0"}
        if raw_transfer_settings:
            extra = " ".join(f"-rawtransfersettings {k}={v}" for k, v in raw_transfer_settings.items())
            cmd += " " + extra
        lines.append(cmd)

    elif action == "get":
        if not local_path:
            raise ValueError("get requires local_path")
        source = _normalize_remote_target(remote_dir, remote_name, remote_path)
        cmd = f"get {_quote_script_arg(source)} {_quote_script_arg(local_path)}"
        if raw_transfer_settings:
            extra = " ".join(f"-rawtransfersettings {k}={v}" for k, v in raw_transfer_settings.items())
            cmd += " " + extra
        lines.append(cmd)

    elif action == "ls":
        target = payload.get("remote_path") or payload.get("remote_dir") or "."
        lines.append(f"ls {_quote_script_arg(target)}")

    elif action == "mkdir":
        target = payload.get("remote_path") or _normalize_remote_target(remote_dir, remote_name, None)
        lines.append(f"mkdir {_quote_script_arg(target)}")

    elif action == "rm":
        target = payload.get("remote_path") or _normalize_remote_target(remote_dir, remote_name, None)
        lines.append(f"rm {_quote_script_arg(target)}")

    elif action == "mv":
        src = payload.get("remote_path")
        dst = payload.get("remote_path_to") or payload.get("destination_remote_path")
        if not src or not dst:
            raise ValueError("mv requires remote_path and remote_path_to")
        lines.append(f"mv {_quote_script_arg(src)} {_quote_script_arg(dst)}")

    elif action == "pwd":
        lines.append("pwd")

    elif action == "stat":
        target = payload.get("remote_path") or _normalize_remote_target(remote_dir, remote_name, None)
        lines.append(f"stat {_quote_script_arg(target)}")

    elif action == "call":
        cmd = payload.get("command")
        if not cmd:
            raise ValueError("call requires command")
        lines.append(f"call {_quote_script_arg(cmd)}")

    else:
        raise ValueError(f"Unsupported action: {action}")

    lines.append("exit")
    return lines


def run(payload: Dict[str, Any]) -> Dict[str, Any]:
    action = (payload.get("action") or "put").lower().strip()
    winscp = _find_winscp()
    temp_local_file = None
    script_path = None
    log_path = None

    try:
        suggested_name = payload.get("remote_name") or payload.get("file_name") or "temp.bin"
        temp_local_file = _write_inline_temp_file(payload, suggested_name=suggested_name)
        script_lines = _build_script_lines(payload, temp_local_file)

        fd, script_path = tempfile.mkstemp(prefix="winscp_hook_", suffix=".txt")
        os.close(fd)
        Path(script_path).write_text("\n".join(script_lines) + "\n", encoding="utf-8")

        fd, log_path = tempfile.mkstemp(prefix="winscp_hook_", suffix=".log")
        os.close(fd)

        timeout = int(payload.get("timeout") or 120)
        proc = runHookCommand(
            [winscp, f"/script={script_path}", f"/log={log_path}"],
            phaseName="winscp",
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        log_tail = ""
        if log_path and os.path.exists(log_path):
            text = Path(log_path).read_text(encoding="utf-8", errors="replace")
            log_tail = "\n".join(text.splitlines()[-60:])

        result = {
            "success": proc.returncode == 0,
            "hook": HOOK_NAME,
            "description": DESCRIPTION,
            "action": action,
            "winscp_path": winscp,
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "log_tail": log_tail,
            "script_lines": script_lines,
            "local_path": payload.get("local_path") or temp_local_file,
            "local_md5": _md5_file(payload.get("local_path") or temp_local_file) if action in ("put", "get") else None,
            "remote_path": payload.get("remote_path") or _normalize_remote_target(payload.get("remote_dir"), payload.get("remote_name") or payload.get("file_name"), payload.get("remote_path")) if action in ("put", "get", "mkdir", "rm", "stat") else payload.get("remote_path") or payload.get("remote_dir"),
        }
        return result
    except Exception as e:
        return {
            "success": False,
            "hook": HOOK_NAME,
            "description": DESCRIPTION,
            "action": action,
            "error": f"{type(e).__name__}: {e}",
        }
    finally:
        for p in [script_path, log_path, temp_local_file]:
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
