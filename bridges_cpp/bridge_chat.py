#!/usr/bin/env python3
"""bridge_chat.py — single-shot LOCAL chat caller for the Ollama bridge.

Cloud providers (ChatGPT / Grok / Gemini / Claude / Copilot) are intentionally
NOT handled here. They run through the QtWebEngine bridge (`app.py
--serve-bridge --target <X>`) which drives the actual logged-in web pages.
That gets us real browser-bridge chat: no API keys to leak, no rate limits,
and the user's existing Google/Anthropic/OpenAI/xAI sessions are reused.

Ollama is a special case — it's a local HTTP daemon on 127.0.0.1:11434 with
no auth at all, so spinning up a QtWebEngine window for it would be silly.
This script POSTs to /api/chat directly.

Invocation by CBE-Bridge-Ollama.exe:
    python bridge_chat.py --target ollama --message "..."
Output: a single JSON line on stdout.
    {"ok": true,  "answer": "...",  "target": "ollama", "model": "..."}
    {"ok": false, "error": "...",  "target": "ollama", "model": "..."}

Configuration: model name comes from config.ini's [ollama] section (written
by the tray exe's Settings menu) and falls back to the script default.
"""
from __future__ import annotations

import argparse
import configparser
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Force stdout to UTF-8 so non-ASCII chars (em-dashes, emoji, quotes) survive
# the C++ tray's pipe capture (Bug 4 — magic-box replacement chars).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ["PYTHONIOENCODING"] = "utf-8"

REPO_ROOT  = Path(__file__).resolve().parent.parent
CONFIG_INI = REPO_ROOT / "config.ini"
DEFAULT_OLLAMA_MODEL = "llama3.2:3b"


def emit(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0 if payload.get("ok") else 1


def get_ollama_model(override: str) -> str:
    if override:
        return override
    cfg = configparser.ConfigParser(interpolation=None)
    try:
        cfg.read(CONFIG_INI, encoding="utf-8")
    except Exception:
        return DEFAULT_OLLAMA_MODEL
    return (cfg.get("ollama", "model", fallback="") or "").strip() or DEFAULT_OLLAMA_MODEL


def call_ollama(message: str, model: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120.0) as resp:
            raw = resp.read()
    except urllib.error.URLError as url_err:
        raise RuntimeError(
            f"can't reach ollama daemon at 127.0.0.1:11434 — is `ollama serve` running? ({url_err})"
        ) from url_err
    return json.loads(raw.decode("utf-8", errors="replace")).get("message", {}).get("content", "")


def main() -> int:
    parser = argparse.ArgumentParser(description="CBE Ollama bridge: single chat call")
    parser.add_argument("--target",  required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--model",   default="")
    args = parser.parse_args()

    if args.target != "ollama":
        # Defensive: the C++ exe shouldn't even spawn us for non-ollama
        # targets (those are routed through the QtWebEngine bridge), but
        # surface a clean error instead of crashing if someone re-purposes
        # this script later.
        return emit({"ok": False, "target": args.target, "error":
                     "bridge_chat.py only handles 'ollama'; "
                     "other targets use the QtWebEngine bridge"})

    model = get_ollama_model(args.model)
    try:
        answer = call_ollama(args.message, model)
        return emit({"ok": True, "target": "ollama", "model": model, "answer": answer})
    except Exception as exc:
        return emit({"ok": False, "target": "ollama", "model": model,
                     "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    sys.exit(main())
