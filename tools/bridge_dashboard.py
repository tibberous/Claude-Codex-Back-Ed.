#!/usr/bin/env python3
"""CBE bridge service dashboard.

One view for every LLM bridge: is the exe present, is the process running, is
the TCP port listening, and a live heartbeat (status probe round-trip).

Pure Python stdlib. psutil is used opportunistically for the process check; if
it is not installed the dashboard falls back to `tasklist` (Windows) / `ps`.

Launch (no window pops — you open the URL yourself):

    python tools\\bridge_dashboard.py
    # then browse to http://127.0.0.1:8799

Flags:
    --port N        dashboard HTTP port (default 8799)
    --probe-once    run one probe pass, print a text table, exit (no server)
    --json          with --probe-once, emit JSON instead of a table

The wire format for the heartbeat mirrors start.py's bridgeRequest():
a UTF-8 JSON object + "\\n", TCP to 127.0.0.1:<bridgePort>, reply is a
newline-delimited JSON object whose `ok` field reports health.
"""

from __future__ import annotations

import argparse
import enum
import json
import socket
import subprocess
import sys
import time
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

# --- repo geometry ---------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent  # tools/ -> repo root
BIN = ROOT / "bin"
BRIDGE_HOST = "127.0.0.1"

# Fallback only — start.py's BRIDGE_PORTS is the source of truth. See loadBridgePorts().
FALLBACK_BRIDGE_PORTS: dict[str, int] = {
    "chatgpt": 8788,
    "grok": 8789,
    "copilot": 8790,
    "gemini": 8791,
    "claude": 8792,
    "ollama": 8793,
    "deepseek": 8794,
}


class Health(enum.Enum):
    """Row health -> CSS class. Ordered worst-known to best so the worst
    failing check decides the row color via a registered severity walk."""

    DOWN = "down"      # red    — exe missing or nothing listening
    DEGRADED = "degraded"  # amber  — port up but probe not ok, or proc/exe mismatch
    HEALTHY = "healthy"    # green  — exe + process + port + ok heartbeat


# Severity order for the row-color reducer (higher index = healthier).
HEALTH_RANK = {Health.DOWN: 0, Health.DEGRADED: 1, Health.HEALTHY: 2}


def loadBridgePorts() -> tuple[dict[str, int], str]:
    """Return (ports, source). Prefer importing start.py's BRIDGE_PORTS so the
    dashboard never drifts from the app. Fall back to the built-in map only if
    the import fails."""
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import start  # type: ignore
        ports = getattr(start, "BRIDGE_PORTS", None)
        if isinstance(ports, dict) and ports:
            return {str(k).lower(): int(v) for k, v in ports.items()}, "start.py:BRIDGE_PORTS"
    except Exception as error:  # noqa: BLE001 — surface why we fell back
        sys.stderr.write(f"[bridge_dashboard] could not import start.BRIDGE_PORTS ({error!r}); using fallback map\n")
    return dict(FALLBACK_BRIDGE_PORTS), "fallback (start.py unavailable)"


def resolveExe(provider: str) -> Optional[Path]:
    """bin/CBE-Bridge-<provider>.exe resolved to its real on-disk casing.

    start.py title-cases as Chatgpt/Deepseek but the files on disk are
    CBE-Bridge-ChatGPT.exe / CBE-Bridge-DeepSeek.exe. Windows is case-
    insensitive so a constructed path would `is_file()` True yet echo back the
    wrong name. Scan bin/ and return the actual directory entry so the UI shows
    the true filename."""
    if not BIN.is_dir():
        return None
    want = f"cbe-bridge-{provider.lower()}.exe"
    for candidate in BIN.glob("CBE-Bridge-*.exe"):
        if candidate.name.lower() == want:
            return candidate
    return None


# --- process check ---------------------------------------------------------
def _processNamesRunning() -> set[str]:
    """Lowercased set of running process image names. psutil if present, else
    `tasklist` (Windows) or `ps` (POSIX)."""
    try:
        import psutil  # type: ignore
        return {(p.info["name"] or "").lower() for p in psutil.process_iter(["name"])}
    except Exception:  # noqa: BLE001 — psutil optional; fall through to CLI
        pass
    names: set[str] = set()
    try:
        if sys.platform.startswith("win"):
            out = subprocess.run(
                ["tasklist", "/fo", "csv", "/nh"],
                capture_output=True, text=True, timeout=10,
            ).stdout
            for line in out.splitlines():
                line = line.strip()
                if line.startswith('"'):
                    names.add(line.split('","', 1)[0].strip('"').lower())
        else:
            out = subprocess.run(
                ["ps", "-eo", "comm"], capture_output=True, text=True, timeout=10
            ).stdout
            for line in out.splitlines()[1:]:
                names.add(Path(line.strip()).name.lower())
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(f"[bridge_dashboard] process listing failed: {error!r}\n")
    return names


def processRunning(exe: Optional[Path], runningNames: set[str]) -> bool:
    if exe is None:
        return False
    return exe.name.lower() in runningNames


# --- port + heartbeat ------------------------------------------------------
def portListening(port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((BRIDGE_HOST, port), timeout=timeout):
            return True
    except OSError:
        return False


def heartbeat(port: int, timeout: float = 3.0) -> dict[str, Any]:
    """Send {"action":"status"}\\n and read one newline-delimited JSON reply.
    Mirrors start.py bridgeRequest() framing. Returns a dict:
        {ok, roundTripMs, raw, error}
    ok is None when the bridge could not be reached at all."""
    payload = (json.dumps({"action": "status"}) + "\n").encode("utf-8")
    started = time.monotonic()
    deadline = started + timeout
    received = b""
    try:
        with socket.create_connection((BRIDGE_HOST, port), timeout=min(2.0, timeout)) as sock:
            sock.settimeout(0.5)
            sock.sendall(payload)
            while time.monotonic() < deadline:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                received += chunk
                if b"\n" in received:
                    break
        rtt = int((time.monotonic() - started) * 1000)
        blob = received.split(b"\n", 1)[0].strip() if b"\n" in received else received.strip()
        if not blob:
            return {"ok": None, "roundTripMs": rtt, "raw": None, "error": "no reply"}
        decoded = json.loads(blob.decode("utf-8", "replace"))
        ok = bool(decoded.get("ok")) if isinstance(decoded, dict) else False
        return {"ok": ok, "roundTripMs": rtt, "raw": decoded, "error": None}
    except OSError as error:
        rtt = int((time.monotonic() - started) * 1000)
        return {"ok": None, "roundTripMs": rtt, "raw": None, "error": str(error)}
    except (ValueError, json.JSONDecodeError) as error:
        rtt = int((time.monotonic() - started) * 1000)
        return {"ok": False, "roundTripMs": rtt, "raw": None, "error": f"bad reply: {error}"}


def classify(exePresent: bool, procRunning: bool, listening: bool, hb: dict[str, Any]) -> Health:
    """Derive row health. Worst failing condition wins."""
    if not exePresent or not listening:
        return Health.DOWN
    if hb.get("ok") is True and procRunning:
        return Health.HEALTHY
    return Health.DEGRADED


def probeOne(provider: str, port: int, runningNames: set[str]) -> dict[str, Any]:
    exe = resolveExe(provider)
    exePresent = exe is not None
    procRunning = processRunning(exe, runningNames)
    listening = portListening(port)
    hb = heartbeat(port) if listening else {"ok": None, "roundTripMs": None, "raw": None, "error": "port closed"}
    health = classify(exePresent, procRunning, listening, hb)
    return {
        "provider": provider,
        "port": port,
        "exe": str(exe) if exe else None,
        "exePresent": exePresent,
        "procRunning": procRunning,
        "listening": listening,
        "heartbeatOk": hb.get("ok"),
        "roundTripMs": hb.get("roundTripMs"),
        "heartbeatError": hb.get("error"),
        "raw": hb.get("raw"),
        "health": health.value,
        "lastSeen": time.strftime("%Y-%m-%d %H:%M:%S") if hb.get("ok") else None,
        "checkedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def probeAll(ports: dict[str, int]) -> list[dict[str, Any]]:
    runningNames = _processNamesRunning()
    rows = [probeOne(provider, port, runningNames) for provider, port in sorted(ports.items(), key=lambda kv: kv[1])]
    return rows


# --- rendering -------------------------------------------------------------
def _yesNo(value: Optional[bool]) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return "n/a"


REFRESH_SECONDS = 5

_PAGE_HEAD = """<!doctype html>
<html><head><meta charset="utf-8"><title>CBE Bridge Dashboard</title>
<meta http-equiv="refresh" content="{refresh}">
<style>
 body{{background:#1e1e22;color:#e6e6e6;font-family:Segoe UI,Arial,sans-serif;margin:24px;}}
 h1{{font-size:20px;margin:0 0 4px;}}
 .meta{{color:#9a9a9a;font-size:12px;margin-bottom:16px;}}
 table{{border-collapse:collapse;width:100%;font-size:13px;}}
 th,td{{padding:8px 10px;text-align:left;border-bottom:1px solid #333;}}
 th{{color:#bdbdbd;text-transform:uppercase;font-size:11px;letter-spacing:.04em;}}
 td.prov{{font-weight:600;font-family:Consolas,monospace;}}
 tr.healthy td:first-child{{border-left:5px solid #3fb950;}}
 tr.degraded td:first-child{{border-left:5px solid #d29922;}}
 tr.down td:first-child{{border-left:5px solid #f85149;}}
 tr.healthy{{background:#16241a;}}
 tr.degraded{{background:#2a230f;}}
 tr.down{{background:#2a1414;}}
 .pill{{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;}}
 .pill.healthy{{background:#1f6f33;color:#d3ffd9;}}
 .pill.degraded{{background:#7a5a12;color:#ffe7b0;}}
 .pill.down{{background:#7a1d1d;color:#ffd2d2;}}
 .err{{color:#f08a8a;font-size:11px;}}
</style></head><body>
<h1>CBE Bridge Service Dashboard</h1>
<div class="meta">ports source: {source} &middot; auto-refresh {refresh}s &middot; checked {checked}</div>
<table>
<thead><tr>
 <th>Provider</th><th>Port</th><th>Health</th><th>Exe present</th>
 <th>Process</th><th>Port listening</th><th>Heartbeat</th>
 <th>RTT ms</th><th>Last seen</th><th>Detail</th>
</tr></thead><tbody>
"""

_PAGE_TAIL = "</tbody></table></body></html>"


def renderHtml(rows: list[dict[str, Any]], source: str) -> str:
    body = [_PAGE_HEAD.format(refresh=REFRESH_SECONDS, source=escape(source),
                              checked=time.strftime("%Y-%m-%d %H:%M:%S"))]
    for r in rows:
        health = r["health"]
        hbCell = _yesNo(r["heartbeatOk"])
        detail = r.get("heartbeatError") or ""
        if not detail and isinstance(r.get("raw"), dict):
            svc = r["raw"].get("service") or r["raw"].get("target") or ""
            detail = str(svc)
        body.append(
            f'<tr class="{health}">'
            f'<td class="prov">{escape(r["provider"])}</td>'
            f'<td>{r["port"]}</td>'
            f'<td><span class="pill {health}">{health}</span></td>'
            f'<td>{_yesNo(r["exePresent"])}</td>'
            f'<td>{_yesNo(r["procRunning"])}</td>'
            f'<td>{_yesNo(r["listening"])}</td>'
            f'<td>{hbCell}</td>'
            f'<td>{"" if r["roundTripMs"] is None else r["roundTripMs"]}</td>'
            f'<td>{escape(r["lastSeen"] or "—")}</td>'
            f'<td class="{"err" if r.get("heartbeatError") else ""}">{escape(detail)}</td>'
            f"</tr>"
        )
    body.append(_PAGE_TAIL)
    return "".join(body)


def renderText(rows: list[dict[str, Any]]) -> str:
    header = f'{"PROVIDER":<10}{"PORT":<6}{"HEALTH":<10}{"EXE":<5}{"PROC":<6}{"LISTEN":<8}{"HB":<5}{"RTT":<7}DETAIL'
    lines = [header, "-" * len(header)]
    for r in rows:
        detail = r.get("heartbeatError") or ""
        if not detail and isinstance(r.get("raw"), dict):
            detail = str(r["raw"].get("service") or r["raw"].get("target") or "")
        lines.append(
            f'{r["provider"]:<10}{r["port"]:<6}{r["health"]:<10}'
            f'{_yesNo(r["exePresent"]):<5}{_yesNo(r["procRunning"]):<6}'
            f'{_yesNo(r["listening"]):<8}{_yesNo(r["heartbeatOk"]):<5}'
            f'{("" if r["roundTripMs"] is None else r["roundTripMs"]):<7}{detail}'
        )
    return "\n".join(lines)


# --- http server -----------------------------------------------------------
def makeHandler(ports: dict[str, int], source: str):
    class DashboardHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server API name
            if self.path.rstrip("/") in ("", "/dashboard"):
                rows = probeAll(ports)
                payload = renderHtml(rows, source).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            elif self.path.rstrip("/") == "/json":
                rows = probeAll(ports)
                payload = json.dumps({"source": source, "rows": rows}, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.send_error(404, "not found")

        def log_message(self, *_args):  # silence default stderr access log
            return

    return DashboardHandler


def serve(ports: dict[str, int], source: str, dashPort: int) -> int:
    handler = makeHandler(ports, source)
    httpd = ThreadingHTTPServer((BRIDGE_HOST, dashPort), handler)
    url = f"http://{BRIDGE_HOST}:{dashPort}"
    sys.stdout.write(f"CBE bridge dashboard serving at {url}\n")
    sys.stdout.write(f"ports source: {source} — also try {url}/json — Ctrl+C to stop\n")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stdout.write("\nstopped.\n")
    finally:
        httpd.server_close()
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="CBE bridge service dashboard")
    parser.add_argument("--port", type=int, default=8799, help="dashboard HTTP port (default 8799)")
    parser.add_argument("--probe-once", action="store_true", help="probe once, print, exit (no server)")
    parser.add_argument("--json", action="store_true", help="with --probe-once: emit JSON")
    args = parser.parse_args(argv)

    ports, source = loadBridgePorts()

    if args.probe_once:
        rows = probeAll(ports)
        if args.json:
            sys.stdout.write(json.dumps({"source": source, "rows": rows}, indent=2) + "\n")
        else:
            sys.stdout.write(f"ports source: {source}\n")
            sys.stdout.write(renderText(rows) + "\n")
        return 0

    return serve(ports, source, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
