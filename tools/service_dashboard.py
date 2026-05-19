"""service_dashboard.py — live HTML status board for the 6 CBE bridge exes
plus the NN4 agent browser and the ChatGPT python sidecar.

Single HTTP server on 127.0.0.1:<port> (default 57838). Periodically probes
each managed port via TCP newline-JSON `{"action":"status"}` and remembers
the last successful response so the dashboard can show a heartbeat even
when the port goes briefly dark.

  > python tools/service_dashboard.py [--port 57838] [--refresh-ms 5000]
                                      [--no-browser]

Refresh runs server-side every `refresh-ms`; the HTML page issues a meta
refresh on the same cadence so a long-running dashboard window stays live.
JSON snapshot also available at /api/status for scripted consumers.

Off the bridge port range (8788..8793), off NN4's (9785/9786), off the
extension control servers (57834..57837). Pick another --port if 57838 is
busy.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

# Copy of the BRIDGE_PORTS dict from start.py (kept in sync manually — these
# rarely change). config.ini overrides under [bridge] <target>_port are NOT
# honored by this dashboard; if the user remapped a port via config.ini they
# should pass the override via --extra-port name:port instead.
BRIDGE_PORTS = {
    "chatgpt":  8788,
    "grok":     8789,
    "copilot":  8790,
    "gemini":   8791,
    "claude":   8792,
    "ollama":   8793,
    "deepseek": 8794,
}

# Non-bridge managed services worth watching alongside the bridges.
EXTRA_PORTS = {
    "nn4-agent":         9785,  # tools/nn4_agent_browser.py action server
    "nn4-devtools":      9786,  # QtWebEngine remote debugging
    "chatgpt-sidecar":   9788,  # python --serve-bridge child of chatgpt tray
    "vscode-ctrl":       57835, # VSCode companion extension HTTP API
    "claude-voice-logs": 57834, # claude-voice extension log server
}

# In-memory probe state. Updated by the background poller, read by the HTTP
# handler. Single Python lock — probes are TCP-bounded so contention is
# negligible. Schema:
#   { 'target': {
#       'port': int, 'kind': 'bridge'|'extra',
#       'listening': bool, 'status': dict|None, 'error': str,
#       'lastOk': float|None,  # epoch seconds of last successful status
#       'latencyMs': float|None,
#       'checkedAt': float,    # epoch seconds of last probe attempt
#     } }
STATE: dict[str, dict] = {}
STATE_LOCK = threading.Lock()
SHUTDOWN = threading.Event()


def _probeStatus(host: str, port: int, timeout: float = 2.0) -> tuple[bool, dict | None, str, float | None]:
    """Open a TCP connection, send {"action":"status"}\n, parse one JSON line.

    Returns (listening, parsed_status_or_None, error_text, latency_ms_or_None).
    Distinguishes connection refused (not listening) from connected-but-no-reply
    (listening, probably wrong protocol — e.g. a raw HTTP server speaking on
    a TCP socket that expects newline-JSON).
    """
    started = time.monotonic()
    try:
        with socket.create_connection((host, int(port)), timeout=timeout) as sock:
            try:
                sock.sendall(b'{"action":"status"}\n')
                sock.settimeout(timeout)
                chunks: list[bytes] = []
                while True:
                    try:
                        data = sock.recv(65536)
                    except socket.timeout:
                        break
                    if not data:
                        break
                    chunks.append(data)
                    if b"\n" in data:
                        break
                latency = (time.monotonic() - started) * 1000.0
                raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
                if not raw:
                    return (True, None, "empty response (listening, no status reply)", round(latency, 1))
                first = raw.splitlines()[0]
                try:
                    return (True, json.loads(first), "", round(latency, 1))
                except Exception:
                    return (True, None, f"non-JSON: {first[:80]!r}", round(latency, 1))
            except Exception as inner:
                latency = (time.monotonic() - started) * 1000.0
                return (True, None, f"send/recv: {type(inner).__name__}: {inner}", round(latency, 1))
    except ConnectionRefusedError:
        return (False, None, "connection refused (port not listening)", None)
    except socket.timeout:
        return (False, None, f"timeout after {timeout:.1f}s (likely firewall or wrong port)", None)
    except OSError as exc:
        return (False, None, f"{type(exc).__name__}: {exc}", None)


def _pollOnce(host: str = "127.0.0.1") -> None:
    """Probe every managed port once. Updates STATE in place under STATE_LOCK."""
    snapshot: dict[str, dict] = {}
    for target, port in {**{k: v for k, v in BRIDGE_PORTS.items()},
                          **{k: v for k, v in EXTRA_PORTS.items()}}.items():
        kind = "bridge" if target in BRIDGE_PORTS else "extra"
        listening, status, error, latency = _probeStatus(host, port)
        now = time.time()
        # Carry previous lastOk forward so the heartbeat survives transient
        # blips. Only reset if we never had a successful probe.
        with STATE_LOCK:
            prev = STATE.get(target, {})
            prev_last_ok = prev.get("lastOk")
        last_ok = now if (listening and status is not None) else prev_last_ok
        snapshot[target] = {
            "target": target,
            "port": int(port),
            "kind": kind,
            "listening": bool(listening),
            "status": status,
            "error": str(error or ""),
            "lastOk": last_ok,
            "latencyMs": latency,
            "checkedAt": now,
        }
    with STATE_LOCK:
        STATE.clear()
        STATE.update(snapshot)


def _pollLoop(refresh_ms: int) -> None:
    delay = max(0.5, refresh_ms / 1000.0)
    while not SHUTDOWN.is_set():
        try:
            _pollOnce()
        except Exception as exc:
            print(f"[dashboard] poll error: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        SHUTDOWN.wait(delay)


def _fmtAge(epoch_or_none: float | None) -> str:
    if epoch_or_none is None:
        return "—"
    age = max(0.0, time.time() - float(epoch_or_none))
    if age < 1.0:
        return "just now"
    if age < 60.0:
        return f"{int(age)}s ago"
    if age < 3600.0:
        return f"{int(age / 60)}m {int(age) % 60}s ago"
    return f"{int(age / 3600)}h {int((age % 3600) / 60)}m ago"


def _renderHtml(refresh_ms: int) -> str:
    with STATE_LOCK:
        rows = sorted(STATE.values(), key=lambda r: (r["kind"], r["port"]))
    css = """
        body { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
        h1 { color: #e6edf3; font-size: 18px; margin: 0 0 16px 0; font-weight: 600; letter-spacing: 0.5px; }
        .meta { color: #7d8590; font-size: 11px; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        thead th { text-align: left; padding: 8px 12px; background: #161b22; color: #7d8590; font-weight: 500; border-bottom: 1px solid #30363d; }
        tbody td { padding: 10px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
        tbody tr:hover { background: #161b22; }
        .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
        .pill-up    { background: #1f6f3a; color: #e6edf3; }
        .pill-noproto { background: #6b5300; color: #f0d000; }
        .pill-down  { background: #4a1e1e; color: #ff7575; }
        .pill-kind  { background: #1f2733; color: #7d8590; font-size: 10px; }
        .err  { color: #ff7575; font-size: 11px; }
        .stat { color: #58a6ff; font-size: 11px; word-break: break-all; }
        .age  { color: #7d8590; font-size: 11px; }
        .lat  { color: #f0d000; font-size: 11px; }
        a { color: #58a6ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
    """.strip()
    refresh_seconds = max(1, int(refresh_ms / 1000))
    parts: list[str] = []
    parts.append("<!doctype html><html><head>")
    parts.append(f'<meta http-equiv="refresh" content="{refresh_seconds}">')
    parts.append('<meta charset="utf-8">')
    parts.append("<title>CBE service dashboard</title>")
    parts.append(f"<style>{css}</style>")
    parts.append("</head><body>")
    parts.append('<h1>CBE service dashboard</h1>')
    parts.append(f'<div class="meta">probes every {refresh_seconds}s · JSON at <a href="/api/status">/api/status</a> · {len(rows)} targets</div>')
    parts.append("<table><thead><tr>")
    parts.append("<th>target</th><th>kind</th><th>port</th><th>state</th><th>latency</th><th>last ok</th><th>status / error</th>")
    parts.append("</tr></thead><tbody>")
    for row in rows:
        if row["listening"] and row["status"] is not None:
            pill = '<span class="pill pill-up">UP</span>'
        elif row["listening"]:
            pill = '<span class="pill pill-noproto">LISTENING</span>'
        else:
            pill = '<span class="pill pill-down">DOWN</span>'
        status_obj = row["status"]
        if status_obj is not None:
            status_str = json.dumps(status_obj, ensure_ascii=False)
            if len(status_str) > 200:
                status_str = status_str[:200] + "…"
            status_html = f'<span class="stat">{status_str}</span>'
        elif row["error"]:
            status_html = f'<span class="err">{row["error"]}</span>'
        else:
            status_html = '<span class="age">—</span>'
        latency_html = f'<span class="lat">{row["latencyMs"]:.1f} ms</span>' if row["latencyMs"] is not None else '<span class="age">—</span>'
        parts.append("<tr>")
        parts.append(f"<td><strong>{row['target']}</strong></td>")
        parts.append(f'<td><span class="pill pill-kind">{row["kind"]}</span></td>')
        parts.append(f"<td>{row['port']}</td>")
        parts.append(f"<td>{pill}</td>")
        parts.append(f"<td>{latency_html}</td>")
        parts.append(f'<td class="age">{_fmtAge(row["lastOk"])}</td>')
        parts.append(f"<td>{status_html}</td>")
        parts.append("</tr>")
    parts.append("</tbody></table>")
    parts.append("</body></html>")
    return "".join(parts)


class _Handler(BaseHTTPRequestHandler):
    refresh_ms = 5000  # set at runtime via class attribute

    def log_message(self, _fmt, *args):
        return  # silence default access log

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = _renderHtml(self.refresh_ms).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/status":
            with STATE_LOCK:
                payload = {"refreshMs": self.refresh_ms, "targets": list(STATE.values())}
            body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


def main() -> int:
    parser = argparse.ArgumentParser(description="CBE service dashboard (live HTML status board)")
    parser.add_argument("--port", type=int, default=57838, help="HTTP server port (default 57838)")
    parser.add_argument("--refresh-ms", type=int, default=5000, help="poll + page refresh interval in ms (default 5000)")
    parser.add_argument("--no-browser", action="store_true", help="don't auto-open the dashboard in the default browser")
    args = parser.parse_args()

    refresh_ms = max(500, int(args.refresh_ms))
    _Handler.refresh_ms = refresh_ms

    # Seed STATE so the first GET isn't empty.
    _pollOnce()

    poller = threading.Thread(target=_pollLoop, args=(refresh_ms,), daemon=True)
    poller.start()

    try:
        server = HTTPServer(("127.0.0.1", int(args.port)), _Handler)
    except OSError as exc:
        print(f"[dashboard] bind failed on 127.0.0.1:{args.port}: {exc}", file=sys.stderr, flush=True)
        SHUTDOWN.set()
        return 1
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[dashboard] serving at {url}", flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[dashboard] shutdown requested", file=sys.stderr, flush=True)
    finally:
        SHUTDOWN.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
