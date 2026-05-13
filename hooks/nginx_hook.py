#!/usr/bin/env python3
"""
Hook File: nginx_hook.py

What it does:
Local Windows nginx management hook for status, start, stop, restart, reload, config test, and simple config reads.

How to use it:
Use it to manage the machine-local nginx and PHP-CGI stack and to verify whether the local intranet server is listening.

Primary entry points:
_get_db, _log, _run, _is_running, _port_listening, start, stop, restart, status, reload, test_config, read_config

Relevant URL(s):
- http://127.0.0.1

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import sys, os, time, urllib.request
from trio_hook_lifecycle import runHookCommand, startHookProcess, subprocessFlag
from trio_hook_orm import log_hook

NGINX_DIR  = r"C:\Users\moren\AppData\Local\Microsoft\WinGet\Packages\nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe\nginx-1.29.6"
NGINX_EXE  = os.path.join(NGINX_DIR, "nginx.exe")
NGINX_CONF = os.path.join(NGINX_DIR, "conf", "nginx.conf")
NGINX_LOGS = os.path.join(NGINX_DIR, "logs")
PHP_CGI    = r"C:\xampp\php\php-cgi.exe"
WWW_ROOT   = r"C:\www"
PHP_PORT   = 9000
HTTP_PORT  = 80

def _log(msg, is_error=0):
    try:
        log_hook("nginx_hook_log", str(msg), int(is_error))
    except Exception:
        pass

def _run(cmd, cwd=None):
    r = runHookCommand(cmd, phaseName="nginx-command", capture_output=True, text=True, cwd=cwd or NGINX_DIR, shell=True)
    return r.stdout.strip() + r.stderr.strip()

def _is_running(name):
    return name.lower() in _run(f'tasklist /FI "IMAGENAME eq {name}" /NH').lower()

def _port_listening(port):
    return "LISTENING" in _run(f'netstat -ano | findstr ":{port}"')

def start():
    results = []
    if not _port_listening(PHP_PORT):
        startHookProcess([PHP_CGI, "-b", f"127.0.0.1:{PHP_PORT}"],
            phaseName="php-cgi", creationflags=subprocessFlag("DETACHED_PROCESS") | subprocessFlag("CREATE_NEW_PROCESS_GROUP"))
        time.sleep(2)
        results.append(f"PHP-CGI started on {PHP_PORT}: {_port_listening(PHP_PORT)}")
    else:
        results.append(f"PHP-CGI already on {PHP_PORT}")
    if not _is_running("nginx.exe"):
        startHookProcess([NGINX_EXE], phaseName="nginx-start", cwd=NGINX_DIR,
            creationflags=subprocessFlag("DETACHED_PROCESS") | subprocessFlag("CREATE_NEW_PROCESS_GROUP"))
        time.sleep(2)
        results.append(f"nginx started: {_is_running('nginx.exe')}")
    else:
        results.append("nginx already running")
    out = "\n".join(results)
    _log(out)
    return out

def stop():
    results = []
    if _is_running("nginx.exe"):
        _run(f'"{NGINX_EXE}" -s quit', cwd=NGINX_DIR)
        time.sleep(2)
        results.append(f"nginx stopped: {not _is_running('nginx.exe')}")
    else:
        results.append("nginx was not running")
    if _is_running("php-cgi.exe"):
        _run("taskkill /F /IM php-cgi.exe")
        results.append("PHP-CGI killed")
    else:
        results.append("PHP-CGI was not running")
    out = "\n".join(results)
    _log(out)
    return out

def restart():
    return f"--- STOP ---\n{stop()}\n--- START ---\n{start()}"

def status():
    out = (f"nginx running:       {_is_running('nginx.exe')}\n"
           f"PHP-CGI port {PHP_PORT}:   {_port_listening(PHP_PORT)}\n"
           f"HTTP port {HTTP_PORT}:      {_port_listening(HTTP_PORT)}\n"
           f"nginx.conf:          {NGINX_CONF}\n"
           f"www root:            {WWW_ROOT}\n")
    _log(out)
    return out

def reload():
    out = _run(f'"{NGINX_EXE}" -s reload') or "nginx reloaded"
    _log(out); return out

def test_config():
    out = _run(f'"{NGINX_EXE}" -t')
    _log(out); return out

def read_config():
    with open(NGINX_CONF, encoding="utf-8") as f: return f.read()
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return {}

def write_config(content):
    with open(NGINX_CONF, "w", encoding="utf-8") as f: f.write(content)
    t = test_config()
    _log(f"Config written. Test: {t}")
    return f"Written. Config test:\n{t}"

def read_vhost(name):
    for block in read_config().split("server {"):
        if name in block:
            return "server {" + block.split("}")[0] + "}"
    return f"No vhost for: {name}"

def add_vhost(block):
    conf = read_config().rstrip().rstrip("}").rstrip()
    return write_config(conf + "\n\n" + block + "\n}\n")

def phpinfo():
    try:
        with urllib.request.urlopen("http://127.0.0.1", timeout=5) as r:
            html = r.read().decode("utf-8", errors="ignore")
        for line in html.splitlines():
            if "PHP Version" in line and "<title>" in line:
                return line.strip()
        return "Server up but PHP Version title not found"
    except Exception as e:
        return f"Error: {e}"

def logs(lines=50):
    p = os.path.join(NGINX_LOGS, "error.log")
    if not os.path.exists(p): return "error.log not found"
    with open(p, encoding="utf-8", errors="ignore") as f:
        return "".join(f.readlines()[-int(lines):])
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return []

def update_nginx():
    out = _run("winget upgrade nginxinc.nginx --accept-source-agreements --accept-package-agreements")
    _log(out); return out

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["start","stop","restart","status","reload","test_config","read_config","phpinfo","logs","update_nginx"])
    p.add_argument("--lines", type=int, default=50)
    p.add_argument("--content", default="")
    p.add_argument("--name", default="")
    p.add_argument("--block", default="")
    args = p.parse_args()
    fn = {"start":start,"stop":stop,"restart":restart,"status":status,"reload":reload,
          "test_config":test_config,"read_config":read_config,"phpinfo":phpinfo,
          "logs":lambda:logs(args.lines),"update_nginx":update_nginx}
    print(fn[args.action]())
