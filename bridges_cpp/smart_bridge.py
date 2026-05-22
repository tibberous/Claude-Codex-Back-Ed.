#!/usr/bin/env python3
"""smart_bridge.py — real HTTP+TCP bridge for the CBE per-target bridges.

The current `CBE-Bridge-<Target>.exe` is a C++ stub that returns the same
identity JSON for every URL. This script is the working replacement: bind a
TCP port, sniff the first bytes, and either serve HTTP endpoints or drop into
a line-based chat REPL ("telnet 127.0.0.1 8791" -> conversation with Gemini).

Endpoints (HTTP):
    GET  /              identity ping  (kept for CBE compatibility)
    GET  /health        {ok, uptime, msgsTotal, tokensTotal}
    GET  /usage         per-target usage rolled up + by-day breakdown
    GET  /models        list provider's published model ids
    POST /chat          body: {"messages":[{role,content}], "model"?}
                        resp: {"ok", "answer", "model", "usage":{...}}

Raw TCP (telnet-style):
    Connect, send lines. Empty line ends turn. Each turn:
        > <user text>\\n
        <assistant reply, possibly multi-line>\\n
        > (next prompt)
    Special commands prefixed with /:
        /quit       close session
        /clear      reset conversation history
        /model X    switch model mid-session
        /usage      print usage so far
        /help       command reference

Usage persistence: `bridge_usage.db` (SQLite) in the bridges_cpp dir.

Providers wired so far: gemini (Google AI). Others (openai/anthropic/xai/
deepseek) follow the same callX() pattern — add when needed.

Invocation:
    python smart_bridge.py --target gemini --port 8791
    python smart_bridge.py --target gemini --port 8791 --model gemini-2.5-pro

Requires: Python 3.10+, stdlib only.
"""
from __future__ import annotations

import argparse
import configparser
import json
import socket
import socketserver
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_INI = REPO_ROOT / "config.ini"
USAGE_DB = Path(__file__).resolve().parent / "bridge_usage.db"

# ---------------------------------------------------------------------------
# Config + state
# ---------------------------------------------------------------------------

def loadConfig() -> configparser.ConfigParser:
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read(CONFIG_INI, encoding="utf-8")
    return cfg


def apiKey(cfg: configparser.ConfigParser, target: str) -> str:
    table = {
        "gemini": "gemini_api_key",
        "chatgpt": "openai_api_key",
        "claude": "anthropic_api_key",
        "grok": "xai_api_key",
        "deepseek": "deepseek_api_key",
    }
    name = table.get(target.lower())
    if not name:
        return ""
    return (cfg.get("api_keys", name, fallback="") or "").strip()


def defaultModel(cfg: configparser.ConfigParser, target: str) -> str:
    table = {
        "gemini": ("api_keys", "gem_model_choice", "gemini-2.5-pro"),
        "chatgpt": ("api_keys", "gpt_model_choice", "gpt-4o"),
        "openai": ("api_keys", "gpt_model_choice", "gpt-4o"),
        "claude": ("api_keys", "claude_model_choice", "claude-sonnet-4-6"),
        "grok": ("api_keys", "grok_model_choice", "grok-4.3"),
        "deepseek": ("api_keys", "deepseek_model_choice", "deepseek-chat"),
        "ollama": ("ollama", "model", "llama3.2:3b"),
        "copilot": ("api_keys", "", "gpt-4o"),
    }
    section, key, fb = table.get(target.lower(), ("api_keys", "", ""))
    if not key:
        return fb
    return (cfg.get(section, key, fallback="") or "").strip() or fb


STATE = {
    "target": "",
    "port": 0,
    "model": "",
    "started": time.time(),
    "msgsTotal": 0,
    "tokensTotal": 0,
}
STATE_LOCK = threading.Lock()


def initUsageDb() -> None:
    con = sqlite3.connect(USAGE_DB)
    try:
        con.execute("""
            CREATE TABLE IF NOT EXISTS usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_iso TEXT NOT NULL,
                target TEXT NOT NULL,
                model TEXT NOT NULL,
                tokens_in INTEGER NOT NULL DEFAULT 0,
                tokens_out INTEGER NOT NULL DEFAULT 0,
                ok INTEGER NOT NULL,
                err TEXT
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_usage_date ON usage(ts_iso DESC)")
        con.commit()
    finally:
        con.close()


def recordUsage(target: str, model: str, tokens_in: int, tokens_out: int,
                ok: bool, err: str | None) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(USAGE_DB)
    try:
        cur = con.execute(
            "INSERT INTO usage(ts_iso,target,model,tokens_in,tokens_out,ok,err) VALUES(?,?,?,?,?,?,?)",
            (ts, target, model, tokens_in, tokens_out, 1 if ok else 0, err)
        )
        if cur.rowcount != 1:
            print(f"[WARN] usage insert affected {cur.rowcount} rows", file=sys.stderr)
        con.commit()
    finally:
        con.close()
    with STATE_LOCK:
        STATE["msgsTotal"] += 1
        STATE["tokensTotal"] += tokens_in + tokens_out


def usageSummary(target: str) -> dict:
    con = sqlite3.connect(USAGE_DB)
    try:
        rows_total = con.execute(
            "SELECT COUNT(*), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0) "
            "FROM usage WHERE target=?", (target,)
        ).fetchone()
        rows_by_day = con.execute(
            "SELECT substr(ts_iso,1,10) AS d, COUNT(*), "
            "       COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0) "
            "FROM usage WHERE target=? GROUP BY d ORDER BY d DESC LIMIT 30",
            (target,)
        ).fetchall()
    finally:
        con.close()
    return {
        "target": target,
        "messages": rows_total[0],
        "tokensIn": rows_total[1],
        "tokensOut": rows_total[2],
        "byDay": [
            {"date": r[0], "messages": r[1], "tokensIn": r[2], "tokensOut": r[3]}
            for r in rows_by_day
        ]
    }

# ---------------------------------------------------------------------------
# Provider calls
# ---------------------------------------------------------------------------

class ProviderError(Exception):
    pass


def callGemini(messages: list[dict], model: str, key: str) -> dict:
    """Call Google's generativelanguage API. Returns {answer, usage}."""
    # NOTE: The bridge-chat path is meant to drive logged-in browser sessions
    # (web bridge) and should NOT gate on an api key in config.ini. If a key
    # happens to be present we'll send it as a Google AI REST fallback; if
    # not, the call will fail with a real HTTP error rather than a misleading
    # "api key empty in config.ini" message.
    # Convert OpenAI-style messages to Gemini's content array.
    contents = []
    for m in messages:
        role = "user" if m.get("role") in ("user", "system") else "model"
        contents.append({
            "role": role,
            "parts": [{"text": m.get("content", "")}]
        })
    body = json.dumps({"contents": contents}).encode("utf-8")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    req = urllib.request.Request(url, data=body, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise ProviderError(f"HTTP {e.code}: {body}") from e
    cands = data.get("candidates") or []
    if not cands:
        raise ProviderError(f"no candidates in response: {json.dumps(data)[:300]}")
    parts = cands[0].get("content", {}).get("parts", [])
    answer = "".join(p.get("text", "") for p in parts).strip()
    um = data.get("usageMetadata") or {}
    return {
        "answer": answer,
        "tokens_in": int(um.get("promptTokenCount", 0)),
        "tokens_out": int(um.get("candidatesTokenCount", 0)),
    }


def callOpenAICompatible(messages: list[dict], model: str, key: str,
                         base_url: str, label: str) -> dict:
    """OpenAI-style /chat/completions — covers OpenAI, xAI/Grok, DeepSeek."""
    # NOTE: Bridge-chat is a web-bridge path (logged-in browser session) and
    # should NOT hard-fail on a missing config.ini api key. If a key is
    # present we'll forward it as a REST fallback; if not, the call goes out
    # unauthenticated and surfaces a real HTTP error instead of the
    # misleading "api key empty in config.ini" message.
    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(base_url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ProviderError(f"HTTP {e.code}: "
                            f"{e.read().decode('utf-8', errors='replace')[:500]}") from e
    choices = data.get("choices") or []
    if not choices:
        raise ProviderError(f"no choices: {json.dumps(data)[:300]}")
    answer = (choices[0].get("message") or {}).get("content", "").strip()
    um = data.get("usage") or {}
    return {"answer": answer,
            "tokens_in": int(um.get("prompt_tokens", 0)),
            "tokens_out": int(um.get("completion_tokens", 0))}


def callAnthropic(messages: list[dict], model: str, key: str) -> dict:
    """Anthropic /v1/messages — system goes in its own field, not the array."""
    # NOTE: Bridge-chat is a web-bridge path (logged-in browser session) and
    # should NOT hard-fail on a missing config.ini api key. If a key is
    # present we'll forward it as a REST fallback; if not, the call goes out
    # unauthenticated and surfaces a real HTTP error instead of the
    # misleading "api key empty in config.ini" message.
    system = " ".join(m.get("content", "") for m in messages if m.get("role") == "system")
    convo = [{"role": ("assistant" if m.get("role") == "assistant" else "user"),
              "content": m.get("content", "")}
             for m in messages if m.get("role") != "system"]
    payload = {"model": model, "max_tokens": 2048, "messages": convo}
    if system.strip():
        payload["system"] = system.strip()
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"), method="POST",
        headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ProviderError(f"HTTP {e.code}: "
                            f"{e.read().decode('utf-8', errors='replace')[:500]}") from e
    blocks = data.get("content") or []
    answer = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    um = data.get("usage") or {}
    return {"answer": answer,
            "tokens_in": int(um.get("input_tokens", 0)),
            "tokens_out": int(um.get("output_tokens", 0))}


def callOllama(messages: list[dict], model: str) -> dict:
    """Local Ollama daemon at 127.0.0.1:11434 — no key, no rate limit."""
    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat", data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ProviderError(f"HTTP {e.code}: "
                            f"{e.read().decode('utf-8', errors='replace')[:300]}") from e
    except urllib.error.URLError as e:
        raise ProviderError(f"ollama daemon unreachable on :11434 ({e.reason})") from e
    answer = (data.get("message") or {}).get("content", "").strip()
    return {"answer": answer,
            "tokens_in": int(data.get("prompt_eval_count", 0)),
            "tokens_out": int(data.get("eval_count", 0))}


def callProvider(target: str, messages: list[dict], model: str, cfg) -> dict:
    target = target.lower()
    key = apiKey(cfg, target)
    if target == "gemini":
        return callGemini(messages, model, key)
    if target in ("chatgpt", "openai"):
        return callOpenAICompatible(messages, model, key,
                                    "https://api.openai.com/v1/chat/completions", "openai")
    if target == "grok":
        return callOpenAICompatible(messages, model, key,
                                    "https://api.x.ai/v1/chat/completions", "xai")
    if target == "deepseek":
        return callOpenAICompatible(messages, model, key,
                                    "https://api.deepseek.com/v1/chat/completions", "deepseek")
    if target == "claude":
        return callAnthropic(messages, model, key)
    if target == "ollama":
        return callOllama(messages, model)
    if target == "copilot":
        raise ProviderError("copilot has no public REST API — use the browser bridge")
    raise ProviderError(f"provider '{target}' not wired yet in smart_bridge.py")

# ---------------------------------------------------------------------------
# HTTP server (manual parsing — single-connection at a time per handler)
# ---------------------------------------------------------------------------

def buildHttpResponse(status: int, body: str | bytes,
                      content_type: str = "application/json") -> bytes:
    if isinstance(body, str):
        body = body.encode("utf-8")
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found",
              405: "Method Not Allowed", 500: "Internal Server Error"}.get(status, "OK")
    headers = (
        f"HTTP/1.1 {status} {reason}\r\n"
        f"Content-Type: {content_type}; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode("ascii")
    return headers + body


def identityJson() -> str:
    with STATE_LOCK:
        return json.dumps({
            "ok": True,
            "target": STATE["target"].capitalize(),
            "port": STATE["port"],
            "model": STATE["model"],
            "server": f"CBE-Bridge-{STATE['target'].capitalize()}/2.0-smart"
        })


def healthJson() -> str:
    with STATE_LOCK:
        return json.dumps({
            "ok": True,
            "uptimeSec": round(time.time() - STATE["started"], 1),
            "msgsTotal": STATE["msgsTotal"],
            "tokensTotal": STATE["tokensTotal"],
            "target": STATE["target"],
            "model": STATE["model"],
        })


def handleHttp(conn: socket.socket, first_chunk: bytes, cfg) -> None:
    # Read until end of headers, then optionally a JSON body.
    buf = first_chunk
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    if not lines:
        conn.sendall(buildHttpResponse(400, '{"ok":false,"err":"empty request"}'))
        return
    try:
        method, path, _ = lines[0].decode("ascii", errors="replace").split(" ", 2)
    except ValueError:
        conn.sendall(buildHttpResponse(400, '{"ok":false,"err":"bad request line"}'))
        return
    headers = {}
    for ln in lines[1:]:
        if b":" in ln:
            k, _, v = ln.partition(b":")
            headers[k.decode("ascii", "replace").strip().lower()] = v.decode("ascii", "replace").strip()
    body_len = int(headers.get("content-length", "0") or 0)
    body = rest
    while len(body) < body_len:
        chunk = conn.recv(min(4096, body_len - len(body)))
        if not chunk:
            break
        body += chunk

    if method == "GET" and path in ("/", "/identity"):
        conn.sendall(buildHttpResponse(200, identityJson())); return
    if method == "GET" and path == "/health":
        conn.sendall(buildHttpResponse(200, healthJson())); return
    if method == "GET" and path == "/usage":
        conn.sendall(buildHttpResponse(200, json.dumps(usageSummary(STATE["target"]))))
        return
    if method == "GET" and path == "/models":
        conn.sendall(buildHttpResponse(200, json.dumps({
            "ok": True, "target": STATE["target"], "default": STATE["model"],
            "note": "list-from-provider not yet wired; use default model"
        }))); return
    if method == "POST" and path == "/chat":
        try:
            payload = json.loads(body or b"{}")
            messages = payload.get("messages") or [{"role": "user",
                                                   "content": payload.get("prompt", "")}]
            model = payload.get("model") or STATE["model"]
            result = callProvider(STATE["target"], messages, model, cfg)
            recordUsage(STATE["target"], model, result["tokens_in"], result["tokens_out"],
                        True, None)
            conn.sendall(buildHttpResponse(200, json.dumps({
                "ok": True, "answer": result["answer"], "model": model,
                "usage": {"tokensIn": result["tokens_in"], "tokensOut": result["tokens_out"]}
            })))
        except Exception as e:
            recordUsage(STATE["target"], STATE["model"], 0, 0, False, str(e))
            conn.sendall(buildHttpResponse(500, json.dumps({
                "ok": False, "err": str(e), "target": STATE["target"]
            })))
        return

    conn.sendall(buildHttpResponse(404, '{"ok":false,"err":"unknown endpoint"}'))

# ---------------------------------------------------------------------------
# Telnet-style REPL
# ---------------------------------------------------------------------------

TELNET_BANNER = (
    "============================================================\n"
    "  CBE smart bridge — telnet REPL\n"
    "  target: {target}  model: {model}  port: {port}\n"
    "  /help for commands. Empty line submits multi-line input.\n"
    "============================================================\n"
)

TELNET_HELP = (
    "  /quit            close session\n"
    "  /clear           reset conversation history\n"
    "  /model <id>      switch model for this session\n"
    "  /usage           show usage so far\n"
    "  /history         dump current conversation\n"
    "  /help            this list\n"
)


def telnetSend(conn: socket.socket, text: str) -> None:
    try:
        conn.sendall(text.encode("utf-8", errors="replace"))
    except OSError:
        pass


def handleTelnet(conn: socket.socket, first_chunk: bytes, cfg) -> None:
    conn.settimeout(600)  # 10 min idle kick
    with STATE_LOCK:
        target = STATE["target"]
    model = STATE["model"]
    history: list[dict] = []
    telnetSend(conn, TELNET_BANNER.format(target=target, model=model, port=STATE["port"]))
    buf = first_chunk
    pending = []  # multi-line user input
    telnetSend(conn, "> ")

    while True:
        try:
            if b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
                continue
            line, _, buf = buf.partition(b"\n")
            ln = line.rstrip(b"\r").decode("utf-8", errors="replace")
        except socket.timeout:
            telnetSend(conn, "\n[idle timeout]\n")
            return

        if ln.startswith("/"):
            cmd, _, arg = ln[1:].partition(" ")
            cmd = cmd.strip().lower()
            arg = arg.strip()
            if cmd == "quit":
                telnetSend(conn, "bye.\n"); return
            elif cmd == "clear":
                history.clear(); pending.clear()
                telnetSend(conn, "[history cleared]\n> "); continue
            elif cmd == "model":
                if arg:
                    model = arg
                    telnetSend(conn, f"[model -> {model}]\n> ")
                else:
                    telnetSend(conn, f"[current model: {model}]\n> ")
                continue
            elif cmd == "usage":
                telnetSend(conn, json.dumps(usageSummary(target), indent=2) + "\n> ")
                continue
            elif cmd == "history":
                for m in history:
                    telnetSend(conn, f"[{m['role']}] {m['content']}\n")
                telnetSend(conn, "> "); continue
            elif cmd == "help":
                telnetSend(conn, TELNET_HELP + "> "); continue
            else:
                telnetSend(conn, f"[unknown command: /{cmd}]\n> "); continue

        if ln == "":
            # Empty line submits whatever's pending.
            if not pending:
                telnetSend(conn, "> "); continue
            user_text = "\n".join(pending).strip()
            pending = []
            if not user_text:
                telnetSend(conn, "> "); continue
            history.append({"role": "user", "content": user_text})
            try:
                result = callProvider(target, history, model, cfg)
                history.append({"role": "assistant", "content": result["answer"]})
                recordUsage(target, model, result["tokens_in"], result["tokens_out"], True, None)
                telnetSend(conn, result["answer"] + "\n> ")
            except Exception as e:
                # Roll back the user turn we just appended so the next try starts clean.
                history.pop()
                recordUsage(target, model, 0, 0, False, str(e))
                telnetSend(conn, f"[error: {e}]\n> ")
            continue

        # Accumulate non-empty lines into the pending user message.
        pending.append(ln)

# ---------------------------------------------------------------------------
# Server entry
# ---------------------------------------------------------------------------

class Handler(socketserver.BaseRequestHandler):
    cfg = None  # set by main()

    def handle(self):
        conn: socket.socket = self.request
        try:
            first = conn.recv(4096)
            if not first:
                return
            # HTTP requests start with a method token (GET/POST/PUT/etc) followed by space.
            head = first[:8].decode("ascii", errors="replace")
            if head.split(" ", 1)[0].upper() in {
                "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"
            }:
                handleHttp(conn, first, self.cfg)
            else:
                handleTelnet(conn, first, self.cfg)
        except Exception as e:
            print(f"[handler error] {e}", file=sys.stderr)


class ThreadedTCP(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True,
                    help="gemini | chatgpt | claude | grok | deepseek")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default="", help="override default model from config.ini")
    args = ap.parse_args()

    cfg = loadConfig()
    initUsageDb()

    target = args.target.lower()
    model = args.model or defaultModel(cfg, target)

    with STATE_LOCK:
        STATE["target"] = target
        STATE["port"] = args.port
        STATE["model"] = model

    Handler.cfg = cfg
    srv = ThreadedTCP((args.host, args.port), Handler)
    print(f"[smart_bridge] target={target} model={model} listening on "
          f"{args.host}:{args.port}", flush=True)
    print(f"[smart_bridge] HTTP: GET / /health /usage /models  POST /chat", flush=True)
    print(f"[smart_bridge] Telnet: connect raw + type, /help for commands", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[smart_bridge] shutting down")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
