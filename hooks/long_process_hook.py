"""
Hook File: long_process_hook.py

What it does:
Job runner for starting, tracking, tailing, waiting on, and stopping long-running PowerShell-based background tasks.

How to use it:
Use the create, status, tail, wait, and stop style actions in this file to manage long process job records under long_process_jobs.

Primary entry points:
now, job_path, load_job, save_job, proc_status, get_exit_code_if_finished, start_job, refresh_job, status_job, tail_job, wait_job, stop_job

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import json
import uuid
import time
from trio_hook_lifecycle import runHookCommand, startHookProcess, killHookPid, subprocessFlag
from datetime import datetime

BASE_DIR = r"C:\Users\moren\Desktop\hooks"
JOBS_DIR = os.path.join(BASE_DIR, "long_process_jobs")
os.makedirs(JOBS_DIR, exist_ok=True)


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def job_path(job_id):
    return os.path.join(JOBS_DIR, f"{job_id}.json")


def load_job(job_id):
    path = job_path(job_id)
    if not os.path.exists(path):
        print(f"ERROR: job not found: {job_id}")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None


def save_job(job):
    with open(job_path(job["job_id"]), "w", encoding="utf-8") as f:
        json.dump(job, f, indent=2)


def proc_status(pid):
    try:
        result = runHookCommand(
            ["tasklist", "/FI", f"PID eq {pid}"],
            phaseName="long-process-tasklist",
            capture_output=True,
            text=True,
            timeout=10,
        )
        out = (result.stdout or "") + (result.stderr or "")
        return str(pid) in out and "No tasks are running" not in out
    except Exception:
        return False


def get_exit_code_if_finished(pid):
    cmd = [
        "powershell",
        "-NoProfile",
        "-Command",
        f"$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction SilentlyContinue; if ($p) {{ 'RUNNING' }} else {{ 'NOT_FOUND' }}"
    ]
    try:
        result = runHookCommand(cmd, phaseName="long-process-exit-code", capture_output=True, text=True, timeout=15)
        txt = ((result.stdout or "") + (result.stderr or "")).strip()
        if "RUNNING" in txt:
            return None
        return "unknown"
    except Exception:
        return "unknown"


def start_job(command, cwd=None, visible=False):
    job_id = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8]
    log_path = os.path.join(JOBS_DIR, f"{job_id}.log")
    ps1_path = os.path.join(JOBS_DIR, f"{job_id}.ps1")

    wrapped = []
    wrapped.append("$ErrorActionPreference = 'Continue'")
    wrapped.append(f"Set-Location -Path '{cwd or os.getcwd()}'")
    wrapped.append(f"$cmd = @'\n{command}\n'@")
    wrapped.append(f"$log = '{log_path}'")
    wrapped.append("\"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] START\" | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("\"COMMAND:\" | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("$cmd | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("\"----- OUTPUT -----\" | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("Invoke-Expression $cmd *>&1 | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("\"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] END exit=$LASTEXITCODE\" | Out-File -FilePath $log -Encoding utf8 -Append")
    wrapped.append("exit $LASTEXITCODE")

    with open(ps1_path, "w", encoding="utf-8") as f:
        f.write("\n".join(wrapped))

    creationflags = 0
    if not visible:
        creationflags = subprocessFlag("CREATE_NO_WINDOW")

    proc = startHookProcess(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1_path],
        phaseName="long-process-job",
        cwd=cwd or os.getcwd(),
        creationflags=creationflags,
    )

    job = {
        "job_id": job_id,
        "command": command,
        "cwd": cwd or os.getcwd(),
        "visible": bool(visible),
        "pid": proc.pid,
        "created": now(),
        "updated": now(),
        "status": "running",
        "exit_code": None,
        "log_path": log_path,
        "ps1_path": ps1_path,
    }
    save_job(job)
    print(json.dumps(job, indent=2))


def refresh_job(job):
    running = proc_status(job["pid"])
    job["updated"] = now()
    if running:
        job["status"] = "running"
        job["exit_code"] = None
    else:
        job["status"] = "finished"
        if job.get("exit_code") is None:
            try:
                if os.path.exists(job["log_path"]):
                    with open(job["log_path"], "r", encoding="utf-8-sig", errors="ignore") as f:
                        lines = f.readlines()
                    for line in reversed(lines[-20:]):
                        if "END exit=" in line:
                            job["exit_code"] = line.strip().split("END exit=")[-1]
                            break
                    if job.get("exit_code") is None:
                        job["exit_code"] = get_exit_code_if_finished(job["pid"])
                else:
                    job["exit_code"] = get_exit_code_if_finished(job["pid"])
            except Exception:
                job["exit_code"] = "unknown"
    save_job(job)
    return job


def status_job(job_id):
    job = load_job(job_id)
    job = refresh_job(job)
    print(json.dumps(job, indent=2))


def tail_job(job_id, n=40):
    job = load_job(job_id)
    refresh_job(job)
    path = job["log_path"]
    if not os.path.exists(path):
        print(f"Log file not found: {path}")
        return
    with open(path, "r", encoding="utf-8-sig", errors="ignore") as f:
        lines = f.readlines()
    text = "".join(lines[-n:])
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))


def wait_job(job_id, timeout_sec=600, interval=5):
    job = load_job(job_id)
    start = time.time()
    while True:
        job = refresh_job(job)
        if job["status"] != "running":
            print(json.dumps(job, indent=2))
            return
        if time.time() - start > timeout_sec:
            print(json.dumps({
                "job_id": job_id,
                "status": "timeout",
                "pid": job["pid"],
                "log_path": job["log_path"]
            }, indent=2))
            return
        time.sleep(interval)


def stop_job(job_id):
    job = load_job(job_id)
    try:
        killHookPid(int(job["pid"]), tree=True, force=True)
    except Exception:
        pass
    job = refresh_job(job)
    print(json.dumps(job, indent=2))


def list_jobs():
    jobs = []
    for name in os.listdir(JOBS_DIR):
        if not name.endswith(".json"):
            continue
        path = os.path.join(JOBS_DIR, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                job = json.load(f)
            jobs.append(refresh_job(job))
        except Exception:
            continue
    jobs.sort(key=lambda x: x.get("created", ""), reverse=True)
    print(json.dumps(jobs, indent=2))


def usage():
    print("Usage:")
    print("  python long_process_hook.py start <command>")
    print("  python long_process_hook.py start_visible <command>")
    print("  python long_process_hook.py status <job_id>")
    print("  python long_process_hook.py tail <job_id> [lines]")
    print("  python long_process_hook.py wait <job_id> [timeout_sec] [interval_sec]")
    print("  python long_process_hook.py stop <job_id>")
    print("  python long_process_hook.py list")
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        usage()

    action = sys.argv[1].lower()

    if action == "start":
        if len(sys.argv) < 3:
            usage()
        start_job(" ".join(sys.argv[2:]), visible=False)
    elif action == "start_visible":
        if len(sys.argv) < 3:
            usage()
        start_job(" ".join(sys.argv[2:]), visible=True)
    elif action == "status":
        if len(sys.argv) != 3:
            usage()
        status_job(sys.argv[2])
    elif action == "tail":
        if len(sys.argv) < 3:
            usage()
        n = int(sys.argv[3]) if len(sys.argv) >= 4 else 40
        tail_job(sys.argv[2], n)
    elif action == "wait":
        if len(sys.argv) < 3:
            usage()
        timeout_sec = int(sys.argv[3]) if len(sys.argv) >= 4 else 600
        interval = int(sys.argv[4]) if len(sys.argv) >= 5 else 5
        wait_job(sys.argv[2], timeout_sec, interval)
    elif action == "stop":
        if len(sys.argv) != 3:
            usage()
        stop_job(sys.argv[2])
    elif action == "list":
        list_jobs()
    else:
        usage()
