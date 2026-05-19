#!/usr/bin/env python3
"""bridge_pilot.py — single-shot vision-pilot caller for browser bridges.

Sibling to bridge_chat.py. While that one talks to Ollama's local daemon,
this one drives the per-target offscreen Chromium (already launched by
CBE-Bridge-<Target>.exe on g_childPort = g_port + 1000) through
start.driveBridgeChatViaVisionPilot — i.e. GPT-4o screenshots + tool-calls
the live chatgpt.com / grok.com / gemini.google.com / claude.ai /
copilot.microsoft.com / chat.deepseek.com surface and scrapes the reply.

Invocation by CBE-Bridge-<Target>.exe (any browser target):
    python bridge_pilot.py --target chatgpt --message "..." [--max-steps 30]
Output: a single JSON line on stdout.
    {"ok": true,  "answer": "...", "target": "chatgpt", "steps": 4,
     "final_url": "https://chatgpt.com/"}
    {"ok": false, "error": "...",  "target": "chatgpt"}

Blocks until the pilot finishes (typically 10-60s). The C++ tray's
runChatScript timeout (90s default) is the upper bound; if you bump it
upstream, bump the matching timeout in start.py too.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# Make `import start` work no matter where python is launched from.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def emit(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0 if payload.get("ok") else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="CBE browser-target vision-pilot one-shot")
    parser.add_argument("--target",    required=True)
    parser.add_argument("--message",   required=True)
    parser.add_argument("--model",     default="")
    parser.add_argument("--max-steps", type=int, default=30)
    args = parser.parse_args()

    try:
        from start import driveBridgeChat, normalizeChatTarget  # type: ignore
    except Exception as exc:
        return emit({"ok": False, "target": args.target,
                     "error": f"failed to import start.py: {type(exc).__name__}: {exc}"})

    canon = normalizeChatTarget(args.target)
    # NOTE: post bridge-plugin refactor, this handler is no longer
    # restricted to browser targets. driveBridgeChat() routes through
    # the plugin registry, which knows whether each bridge is api-mode
    # (ollama: no chrome) or web-mode. The C++ tray can shell to
    # bridge_pilot.py for EVERY target uniformly. bridge_chat.py is now
    # legacy; kept around for compatibility but no longer needed.

    try:
        result = driveBridgeChat(canon, args.message, max_steps=int(args.max_steps))
    except Exception as exc:
        return emit({"ok": False, "target": canon,
                     "error": f"bridge dispatch crashed: {type(exc).__name__}: {exc}"})

    return emit({
        "ok":        bool(result.get("ok")),
        "target":    canon,
        "model":     args.model or "vision-pilot",
        "answer":    str(result.get("response") or ""),
        "steps":     int(result.get("steps") or 0),
        "final_url": str(result.get("final_url") or ""),
        "summary":   str(result.get("summary") or ""),
        "error":     str(result.get("error") or ""),
    })


if __name__ == "__main__":
    sys.exit(main())
