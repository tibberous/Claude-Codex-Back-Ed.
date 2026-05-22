"""Run a chat against every chat-capable plugin and report ok/answer/time.

Uses the new driveBridgeChat() entry point so we exercise the plugin
registry, not the legacy hardcoded driveBridgeChatViaVisionPilot path.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from start import driveBridgeChat  # type: ignore

TARGETS = ["ollama", "chatgpt", "grok", "gemini", "claude", "copilot", "deepseek"]
PROMPT = "Reply with one word: pong"

rows = []
for t in TARGETS:
    print(f"\n=== {t} ===", flush=True)
    t0 = time.time()
    try:
        r = driveBridgeChat(t, PROMPT, max_steps=15)
    except Exception as e:
        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    elapsed = round(time.time() - t0, 1)
    r["target"] = t
    r["elapsed"] = elapsed
    rows.append(r)
    print(f"  ok={r.get('ok')} time={elapsed}s answer={r.get('response') or r.get('answer') or '<empty>'!r}"
          f" err={r.get('error') or ''!r}")

print("\n========== SUMMARY ==========")
for r in rows:
    v = "PASS" if r.get("ok") else "FAIL"
    ans = (r.get("response") or r.get("answer") or "")[:60]
    print(f"  {v:4s} {r['target']:9s} {r['elapsed']!s:>5}s  {ans!r}")
