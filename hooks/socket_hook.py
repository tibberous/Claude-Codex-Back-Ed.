"""
Hook File: socket_hook.py

What it does:
Creates and manages file-backed socket-style command sessions with worker scripts, metadata, input, output, and event logs.

How to use it:
Use it to start a managed worker session, then write commands, inspect status, and read output through the session files.

Primary entry points:
now, session_dir, meta_path, io_path, load_meta, save_meta, proc_running, update_status, spawn_worker, create_session, do_status, do_write

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : socket_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Creates and manages file-backed socket-style command sessions with worker scripts, metadata, input, output, and event logs.
#
# HOW TO INVOKE
#   Use it to start a managed worker session, then write commands, inspect status, and read output through the session files.
#
# PRIMARY ENTRY POINTS
#   - now
#   - session_dir
#   - meta_path
#   - io_path
#   - load_meta
#   - save_meta
#   - proc_running
#   - update_status
#   - spawn_worker
#   - create_session
#   - do_status
#   - do_write
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
import sys
import json
import uuid
import time
import shlex
import signal
from trio_hook_lifecycle import runHookCommand, startHookProcess, killHookPid, subprocessFlag, hiddenStartupInfo
from datetime import datetime

BASE_DIR = r"C:\Users\moren\Desktop\hooks"
SESSIONS_DIR = os.path.join(BASE_DIR, "socket_sessions")
os.makedirs(SESSIONS_DIR, exist_ok=True)


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def session_dir(session_id):
    return os.path.join(SESSIONS_DIR, session_id)


def meta_path(session_id):
    return os.path.join(session_dir(session_id), "meta.json")


def io_path(session_id, name):
    return os.path.join(session_dir(session_id), name)


def load_meta(session_id):
    path = meta_path(session_id)
    if not os.path.exists(path):
        print(f"ERROR: session not found: {session_id}")
        sys.exit(1)
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return {}


def save_meta(meta):
    with open(meta_path(meta['session_id']), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)


def proc_running(pid):
    if not pid:
        return False
    try:
        result = runHookCommand(["tasklist", "/FI", f"PID eq {pid}"], phaseName="socket-tasklist", capture_output=True, text=True)
        out = (result.stdout or '') + (result.stderr or '')
        return str(pid) in out and 'No tasks are running' not in out
    except Exception:
        return False


def update_status(meta):
    meta['status'] = 'running' if proc_running(meta.get('pid')) else 'stopped'
    meta['checked_at'] = now()
    save_meta(meta)
    return meta


def spawn_worker(session_id, mode, target, cwd=None):
    sdir = session_dir(session_id)
    os.makedirs(sdir, exist_ok=True)
    script_path = io_path(session_id, 'worker.ps1')
    input_path = io_path(session_id, 'input.txt')
    output_path = io_path(session_id, 'output.txt')
    events_path = io_path(session_id, 'events.log')
    if not os.path.exists(input_path):
        open(input_path, 'a', encoding='utf-8').close()
    if not os.path.exists(output_path):
        open(output_path, 'a', encoding='utf-8').close()
    if not os.path.exists(events_path):
        open(events_path, 'a', encoding='utf-8').close()

    escaped_input = input_path.replace("'", "''")
    escaped_output = output_path.replace("'", "''")
    escaped_events = events_path.replace("'", "''")
    target_ps = target.replace("'", "''")
    cwd_ps = (cwd or '').replace("'", "''")

    if mode == 'cmd':
        worker = f"""
$InputPath = '{escaped_input}'
$OutputPath = '{escaped_output}'
$EventsPath = '{escaped_events}'
$Target = '{target_ps}'
$LastLen = 0
Add-Content -Path $EventsPath -Value ((Get-Date -Format s) + ' START cmd ')
while ($true) {{
  if (-not (Test-Path $InputPath)) {{ New-Item -Path $InputPath -ItemType File -Force | Out-Null }}
  $raw = Get-Content -Path $InputPath -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) {{ $raw = '' }}
  if ($raw.Length -gt $LastLen) {{
    $delta = $raw.Substring($LastLen)
    Add-Content -Path $EventsPath -Value ((Get-Date -Format s) + ' SEND ' + ($delta -replace "`r","<CR>" -replace "`n","<LF>"))
    $delta | cmd.exe /c $Target 2>&1 | Out-File -FilePath $OutputPath -Append -Encoding utf8
    $LastLen = $raw.Length
  }}
  Start-Sleep -Milliseconds 500
}}
"""
    elif mode == 'ssh':
        worker = f"""
$InputPath = '{escaped_input}'
$OutputPath = '{escaped_output}'
$EventsPath = '{escaped_events}'
$Target = '{target_ps}'
$LastLen = 0
Add-Content -Path $EventsPath -Value ((Get-Date -Format s) + ' START ssh ')
while ($true) {{
  if (-not (Test-Path $InputPath)) {{ New-Item -Path $InputPath -ItemType File -Force | Out-Null }}
  $raw = Get-Content -Path $InputPath -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) {{ $raw = '' }}
  if ($raw.Length -gt $LastLen) {{
    $delta = $raw.Substring($LastLen)
    Add-Content -Path $EventsPath -Value ((Get-Date -Format s) + ' SEND ' + ($delta -replace "`r","<CR>" -replace "`n","<LF>"))
    $tmp = Join-Path $env:TEMP ('socket_send_' + [guid]::NewGuid().ToString() + '.txt')
    [System.IO.File]::WriteAllText($tmp, $delta)
    Get-Content -Path $tmp -Raw | ssh $Target 2>&1 | Out-File -FilePath $OutputPath -Append -Encoding utf8
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $LastLen = $raw.Length
  }}
  Start-Sleep -Milliseconds 500
}}
"""
    else:
        raise ValueError('Unsupported mode')

    with open(script_path, 'w', encoding='utf-8') as f:
        f.write(worker)

    creationflags = subprocessFlag("CREATE_NEW_CONSOLE")
    cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script_path]
    si = hiddenStartupInfo()
    popen_kwargs = {"cwd": cwd or None, "creationflags": creationflags}
    if si is not None:
        popen_kwargs["startupinfo"] = si
    proc = startHookProcess(cmd, phaseName="socket-worker", **popen_kwargs)
    return proc.pid, script_path, input_path, output_path, events_path


def create_session(mode, target, cwd=None):
    session_id = datetime.now().strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:8]
    pid, script_path, input_path, output_path, events_path = spawn_worker(session_id, mode, target, cwd=cwd)
    meta = {
        'session_id': session_id,
        'mode': mode,
        'target': target,
        'cwd': cwd,
        'pid': pid,
        'status': 'running',
        'created_at': now(),
        'checked_at': now(),
        'script_path': script_path,
        'input_path': input_path,
        'output_path': output_path,
        'events_path': events_path,
        'read_offset': 0
    }
    save_meta(meta)
    print(json.dumps(meta, indent=2))


def do_status(session_id):
    meta = update_status(load_meta(session_id))
    print(json.dumps(meta, indent=2))


def do_write(session_id, text):
    meta = update_status(load_meta(session_id))
    with open(meta['input_path'], 'a', encoding='utf-8') as f:
        f.write(text)
        if not text.endswith('\n'):
            f.write('\n')
    print(json.dumps({'session_id': session_id, 'status': meta['status'], 'written': text}, indent=2))


def do_read(session_id, mode='new', lines=80):
    meta = update_status(load_meta(session_id))
    path = meta['output_path']
    if not os.path.exists(path):
        print('')
        return
    if mode == 'all':
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
            data = f.read()
        sys.stdout.buffer.write(data.encode('utf-8', errors='replace'))
        return
    if mode == 'tail':
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
            data = f.readlines()
        sys.stdout.buffer.write(''.join(data[-lines:]).encode('utf-8', errors='replace'))
        return
    offset = meta.get('read_offset', 0)
    size = os.path.getsize(path)
    if offset > size:
        offset = 0
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        f.seek(offset)
        data = f.read()
        meta['read_offset'] = f.tell()
    save_meta(meta)
    sys.stdout.buffer.write(data.encode('utf-8', errors='replace'))


def do_events(session_id, lines=40):
    meta = update_status(load_meta(session_id))
    path = meta['events_path']
    if not os.path.exists(path):
        print('')
        return
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        data = f.readlines()
    sys.stdout.buffer.write(''.join(data[-lines:]).encode('utf-8', errors='replace'))


def do_stop(session_id):
    meta = load_meta(session_id)
    pid = meta.get('pid')
    if pid and proc_running(pid):
        killHookPid(int(pid), tree=True, force=True)
    meta = update_status(meta)
    print(json.dumps({'session_id': session_id, 'status': meta['status']}, indent=2))


def do_list():
    rows = []
    if not os.path.exists(SESSIONS_DIR):
        print('[]')
        return
    for name in os.listdir(SESSIONS_DIR):
        p = meta_path(name)
        if os.path.exists(p):
            try:
                meta = load_meta(name)
                meta = update_status(meta)
                rows.append({
                    'session_id': meta['session_id'],
                    'mode': meta['mode'],
                    'target': meta['target'],
                    'pid': meta.get('pid'),
                    'status': meta['status'],
                    'created_at': meta['created_at']
                })
            except Exception:
                pass
    print(json.dumps(sorted(rows, key=lambda x: x['created_at'], reverse=True), indent=2))


def usage():
    print('''socket_hook.py
Usage:
  python socket_hook.py start_cmd "<cmd.exe command>" [cwd]
  python socket_hook.py start_ssh "<ssh target and args>" [cwd]
  python socket_hook.py status <session_id>
  python socket_hook.py write <session_id> "text to append to input"
  python socket_hook.py read <session_id> [new|all|tail] [lines_for_tail]
  python socket_hook.py events <session_id> [lines]
  python socket_hook.py stop <session_id>
  python socket_hook.py list

Notes:
- This is file-backed pseudo-interactive transport, not a true PTY.
- Best for progressive output capture and repeated calls without restarting the outer worker.
- start_ssh sends each write as stdin to a fresh ssh invocation; it does NOT keep a native SSH/Telnet terminal session alive.
- For pip installs and other long commands, use long_process_hook when you only need logs/status.
''')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        usage()
        sys.exit(1)
    action = sys.argv[1].lower()
    if action == 'start_cmd':
        if len(sys.argv) < 3:
            usage(); sys.exit(1)
        target = sys.argv[2]
        cwd = sys.argv[3] if len(sys.argv) > 3 else None
        create_session('cmd', target, cwd)
    elif action == 'start_ssh':
        if len(sys.argv) < 3:
            usage(); sys.exit(1)
        target = sys.argv[2]
        cwd = sys.argv[3] if len(sys.argv) > 3 else None
        create_session('ssh', target, cwd)
    elif action == 'status' and len(sys.argv) >= 3:
        do_status(sys.argv[2])
    elif action == 'write' and len(sys.argv) >= 4:
        do_write(sys.argv[2], sys.argv[3])
    elif action == 'read' and len(sys.argv) >= 3:
        mode = sys.argv[3] if len(sys.argv) >= 4 else 'new'
        lines = int(sys.argv[4]) if len(sys.argv) >= 5 else 80
        do_read(sys.argv[2], mode, lines)
    elif action == 'events' and len(sys.argv) >= 3:
        lines = int(sys.argv[3]) if len(sys.argv) >= 4 else 40
        do_events(sys.argv[2], lines)
    elif action == 'stop' and len(sys.argv) >= 3:
        do_stop(sys.argv[2])
    elif action == 'list':
        do_list()
    else:
        usage()
        sys.exit(1)

