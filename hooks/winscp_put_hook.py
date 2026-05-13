"""
Hook File: winscp_put_hook.py

What it does:
Focused WinSCP uploader that writes inline payloads or files to a remote destination and verifies transfer details.

How to use it:
Use run_hook with a JSON-style payload when you only need a put-style transfer path.

Primary entry points:
_md5_bytes, _find_winscp, _require, _normalize_remote_dir, _build_open_command, _write_temp_file_from_payload, run_hook

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import json
import base64
import hashlib
import tempfile
from trio_hook_lifecycle import runHookCommand
from pathlib import Path

HOOK_NAME = "winscp_put_hook"
WINSCP_DEFAULT = r"C:\Program Files (x86)\WinSCP\WinSCP.com"


def _md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _find_winscp() -> str:
    candidates = [
        os.environ.get("WINSCP_COM"),
        WINSCP_DEFAULT,
        r"C:\Program Files\WinSCP\WinSCP.com",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(Path(candidate))
    return "WinSCP.com"


def _require(value, name: str):
    if value in (None, ""):
        raise ValueError(f"Missing required field: {name}")
    return value


def _normalize_remote_dir(remote_dir: str) -> str:
    remote_dir = remote_dir.replace("\\", "/")
    if not remote_dir.endswith("/"):
        remote_dir += "/"
    return remote_dir


def _build_open_command(cfg: dict) -> str:
    session_name = cfg.get("session") or cfg.get("saved_session")
    password = cfg.get("password")
    hostkey = cfg.get("hostkey")
    private_key = cfg.get("private_key")
    raw_settings = cfg.get("raw_settings") or {}

    if session_name:
        parts = ["open", session_name]
        if password:
            parts.append(f'-password="{password}"')
        if private_key:
            parts.append(f'-privatekey="{private_key}"')
        if hostkey:
            parts.append(f'-hostkey="{hostkey}"')
        if raw_settings:
            raw = " ".join(f'{k}={v}' for k, v in raw_settings.items())
            parts.append(f'-rawsettings {raw}')
        return " ".join(parts)

    protocol = _require(cfg.get("protocol"), "protocol")
    host = _require(cfg.get("host"), "host")
    username = _require(cfg.get("username"), "username")
    port = cfg.get("port")

    session_url = f"{protocol}://{username}@{host}"
    if port:
        session_url += f":{int(port)}"

    parts = ["open", f'"{session_url}"']
    if password:
        parts.append(f'-password="{password}"')
    if private_key:
        parts.append(f'-privatekey="{private_key}"')
    if hostkey:
        parts.append(f'-hostkey="{hostkey}"')
    elif protocol.lower() in {"sftp", "scp"}:
        raise ValueError("hostkey is required for sftp/scp for non-interactive automation")
    if raw_settings:
        raw = " ".join(f'{k}={v}' for k, v in raw_settings.items())
        parts.append(f'-rawsettings {raw}')

    return " ".join(parts)


def _write_temp_file_from_payload(payload: dict) -> str:
    file_name = payload.get("file_name") or "upload.bin"
    file_name = Path(file_name).name

    if payload.get("data_base64"):
        data = base64.b64decode(payload["data_base64"])
    elif payload.get("data_text") is not None:
        encoding = payload.get("encoding") or "utf-8"
        data = payload["data_text"].encode(encoding)
    else:
        raise ValueError("Payload must include data_base64 or data_text when local_path is not provided")

    suffix = Path(file_name).suffix
    fd, temp_path = tempfile.mkstemp(prefix="gtp_winscp_", suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return temp_path


def run_hook(payload: dict) -> dict:
    cfg = payload.get("connection") or {}
    remote_dir = _normalize_remote_dir(_require(payload.get("remote_dir"), "remote_dir"))
    remote_name = payload.get("remote_name")
    transfer_mode = payload.get("transfer_mode", "binary")
    preserve_time = bool(payload.get("preserve_time", False))
    local_path = payload.get("local_path")
    cleanup_local = False

    if local_path:
        local_path = str(Path(local_path))
        if not Path(local_path).exists():
            raise FileNotFoundError(f"Local path not found: {local_path}")
    else:
        local_path = _write_temp_file_from_payload(payload)
        cleanup_local = True

    winscp = _find_winscp()
    open_cmd = _build_open_command(cfg)

    put_switches = [f"-transfer={transfer_mode}"]
    put_switches.append("-preservetime" if preserve_time else "-nopreservetime")
    put_opts = " ".join(put_switches)

    target = remote_dir + (remote_name or Path(local_path).name)
    script_lines = [
        "option batch abort",
        "option confirm off",
        open_cmd,
        f'put {put_opts} "{local_path}" "{target}"',
        "exit",
    ]

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as script_file:
        script_file.write("\n".join(script_lines) + "\n")
        script_path = script_file.name

    log_path = script_path + ".log"
    try:
        proc = runHookCommand(
            [winscp, f"/script={script_path}", f"/log={log_path}"],
            phaseName="winscp-put",
            capture_output=True,
            text=True,
            timeout=int(payload.get("timeout", 300)),
        )
        success = proc.returncode == 0
        result = {
            "ok": success,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "winscp_path": winscp,
            "script_path": script_path,
            "log_path": log_path,
            "uploaded_from": local_path,
            "remote_target": target,
            "local_md5": _md5_bytes(Path(local_path).read_bytes()),
        }
        if Path(log_path).exists():
            result["log_tail"] = Path(log_path).read_text(encoding="utf-8", errors="replace")[-4000:]
        return result
    finally:
        if cleanup_local and Path(local_path).exists():
            try:
                Path(local_path).unlink()
            except Exception:
                pass
        if Path(script_path).exists():
            try:
                Path(script_path).unlink()
            except Exception:
                pass


if __name__ == "__main__":
    if len(sys.argv) > 1:
        payload = json.loads(sys.argv[1])
    else:
        payload = json.load(sys.stdin)
    result = run_hook(payload)
    print(json.dumps(result, indent=2))
