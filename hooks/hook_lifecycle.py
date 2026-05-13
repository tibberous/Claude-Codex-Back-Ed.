"""
Hook-side lifecycle execution gateway for CutiePy hooks.

Hook scripts run as small standalone processes, so they cannot safely import the
full Qt application runtime just to reach CutiePy.AppLifecycle. This module
keeps hook-controlled command execution phase-shaped and centralized instead of
letting every hook spawn ad hoc subprocesses.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import datetime
import json
import os
import subprocess
import time

try:
    from hook_orm import insert_process_record, update_process_record
except Exception:
    try:
        from hooks.hook_orm import insert_process_record, update_process_record
    except Exception:
        def insert_process_record(*args, **kwargs): return None
        def update_process_record(*args, **kwargs): return False

HOOK_LIFECYCLE_LOG = Path(os.environ.get('TRIO_HOOK_LIFECYCLE_LOG', str(Path(__file__).with_name('hook_lifecycle.log'))))


@dataclass
class HookCompletedProcess:
    args: Any
    returncode: int
    stdout: str = ''
    stderr: str = ''


@dataclass
class HookPhase:
    name: str
    command: Any
    ttlSeconds: float = 0.0
    startedAt: float = 0.0
    endedAt: float = 0.0
    pid: int = 0
    status: str = 'pending'
    returncode: int | None = None
    error: str = ''
    dbRowId: int | None = None
    meta: dict = field(default_factory=dict)

    def snapshot(self) -> dict:
        return {
            'time': datetime.datetime.now().isoformat(),
            'name': self.name,
            'command': self.command if isinstance(self.command, str) else [str(part) for part in list(self.command or [])],
            'ttlSeconds': self.ttlSeconds,
            'startedAt': self.startedAt,
            'endedAt': self.endedAt,
            'pid': self.pid,
            'status': self.status,
            'returncode': self.returncode,
            'error': self.error,
            'dbRowId': self.dbRowId,
            'meta': self.meta,
        }


def _writeLifecycleEvent(phase: HookPhase):
    try:
        HOOK_LIFECYCLE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HOOK_LIFECYCLE_LOG.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(phase.snapshot(), ensure_ascii=False, default=str) + '\n')
    except Exception:
        pass


def _phaseName(command: Any, fallback: str = 'hook-command') -> str:
    if fallback:
        return str(fallback)
    try:
        if isinstance(command, (list, tuple)) and command:
            return 'hook:' + Path(str(command[0])).name
    except Exception:
        pass
    return 'hook-command'


def runHookCommand(command, phaseName: str = 'hook-command', ttlSeconds: float | None = None, **kwargs) -> HookCompletedProcess:
    """Run a hook command through one lifecycle-shaped gateway."""
    timeout = kwargs.pop('timeout', None)
    ttl = float(ttlSeconds if ttlSeconds is not None else (timeout or 0.0) or 0.0)
    phase = HookPhase(name=_phaseName(command, phaseName), command=command, ttlSeconds=ttl, startedAt=time.monotonic(), status='running')
    _writeLifecycleEvent(phase)
    try:
        proc = subprocess.Popen(command, **_popenKwargsForRun(kwargs))
        phase.pid = int(getattr(proc, 'pid', 0) or 0)
        phase.dbRowId = insert_process_record(phase.name, phase.name, command, phase.pid, ttl, cwd=str(kwargs.get('cwd', '') or ''), meta={'hook': True})
        _writeLifecycleEvent(phase)
        stdout, stderr = proc.communicate(input=kwargs.get('input', None), timeout=timeout)
        phase.returncode = int(getattr(proc, 'returncode', 0) or 0)
        phase.status = 'complete' if phase.returncode == 0 else 'errored'
        phase.endedAt = time.monotonic()
        update_process_record(phase.dbRowId, phase.status, exit_code=phase.returncode, runtime_seconds=max(0.0, phase.endedAt - phase.startedAt), meta=phase.snapshot())
        _writeLifecycleEvent(phase)
        return HookCompletedProcess(args=command, returncode=phase.returncode, stdout=stdout or '', stderr=stderr or '')
    except subprocess.TimeoutExpired as error:
        phase.status = 'errored'
        phase.error = f'TimeoutExpired: {error}'
        try:
            if phase.pid:
                killHookPid(phase.pid, tree=True, force=True)
        except Exception:
            pass
        phase.endedAt = time.monotonic()
        update_process_record(phase.dbRowId, 'errored', fault_reason='ttl_expired', error_message=phase.error, exception=error, runtime_seconds=max(0.0, phase.endedAt - phase.startedAt), meta=phase.snapshot())
        _writeLifecycleEvent(phase)
        raise
    except Exception as error:
        phase.status = 'exception'
        phase.error = f'{type(error).__name__}: {error}'
        phase.endedAt = time.monotonic()
        update_process_record(phase.dbRowId, 'exception', error_message=phase.error, exception=error, runtime_seconds=max(0.0, phase.endedAt - phase.startedAt), meta=phase.snapshot())
        _writeLifecycleEvent(phase)
        raise


def _popenKwargsForRun(kwargs: dict) -> dict:
    data = dict(kwargs or {})
    capture_output = bool(data.pop('capture_output', False))
    text = bool(data.pop('text', False))
    if capture_output:
        data.setdefault('stdout', subprocess.PIPE)
        data.setdefault('stderr', subprocess.PIPE)
    if text:
        data.setdefault('text', True)
    return data


def startHookProcess(command, phaseName: str = 'hook-process', ttlSeconds: float | None = None, **kwargs):
    phase = HookPhase(name=_phaseName(command, phaseName), command=command, ttlSeconds=float(ttlSeconds or 0.0), startedAt=time.monotonic(), status='running')
    proc = subprocess.Popen(command, **kwargs)
    phase.pid = int(getattr(proc, 'pid', 0) or 0)
    phase.dbRowId = insert_process_record(phase.name, phase.name, command, phase.pid, phase.ttlSeconds, cwd=str(kwargs.get('cwd', '') or ''), meta={'hook': True})
    _writeLifecycleEvent(phase)
    return proc


def subprocessFlag(name: str, default: int = 0) -> int:
    return int(getattr(subprocess, str(name), default) or 0)


def hiddenStartupInfo():
    try:
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        return startup
    except Exception:
        return None


def killHookPid(pid: int, tree: bool = True, force: bool = True):
    target = int(pid or 0)
    if target <= 0:
        return HookCompletedProcess(args=[], returncode=1, stdout='', stderr='missing pid')
    if os.name == 'nt':
        cmd = ['taskkill', '/PID', str(target)]
        if tree:
            cmd.append('/T')
        if force:
            cmd.append('/F')
        return runHookCommand(cmd, phaseName='hook-taskkill', ttlSeconds=30, capture_output=True, text=True, timeout=30)
    try:
        os.kill(target, 9 if force else 15)
        return HookCompletedProcess(args=['kill', str(target)], returncode=0, stdout='', stderr='')
    except Exception as error:
        return HookCompletedProcess(args=['kill', str(target)], returncode=1, stdout='', stderr=str(error))


def hookPidRunning(pid: int) -> bool:
    target = int(pid or 0)
    if target <= 0:
        return False
    if os.name == 'nt':
        try:
            result = runHookCommand(['tasklist', '/FI', f'PID eq {target}'], phaseName='hook-tasklist', ttlSeconds=15, capture_output=True, text=True, timeout=15)
            out = (result.stdout or '') + (result.stderr or '')
            return str(target) in out and 'No tasks are running' not in out
        except Exception:
            return False
    try:
        os.kill(target, 0)
        return True
    except Exception:
        return False
