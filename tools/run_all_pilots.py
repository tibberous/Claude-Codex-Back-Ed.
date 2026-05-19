"""End-to-end vision-pilot runner across every browser target.

For each target, calls start.driveBridgeChatViaVisionPilot() with a tight one-word
prompt. Records ok/answer/steps/final_url/summary/error per target and prints a
single-line summary at the end. Ollama is exercised through bridge_chat.py.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from start import driveBridgeChatViaVisionPilot  # type: ignore  # noqa: E402

TARGETS = ["grok", "chatgpt", "gemini", "claude", "copilot", "deepseek"]
PROMPT = "Reply with exactly one word: pong"
MAX_STEPS = 50
LOGS = ROOT / "logs"


def wipeLogs(target: str) -> None:
    """Wipe per-target log surfaces so each run starts forensically clean.

    Deletes: logs/chat.log, logs/cdp/*, logs/gpt-pilot/*, logs/<Target>_child.log.
    Leaves logs/matrix_run.log alone (the runner itself writes to it).
    """
    paths_to_truncate = [
        LOGS / "chat.log",
        LOGS / f"{target.capitalize()}_child.log",
    ]
    for p in paths_to_truncate:
        try:
            if p.exists():
                p.write_text("", encoding="utf-8")
        except Exception as e:
            print(f"  [wipe] truncate {p.name} failed: {e}", flush=True)

    dirs_to_clear = [LOGS / "cdp", LOGS / "gpt-pilot"]
    for d in dirs_to_clear:
        if not d.exists():
            continue
        for entry in d.iterdir():
            try:
                if entry.is_file():
                    entry.unlink()
                elif entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
            except Exception as e:
                print(f"  [wipe] rm {entry.name} failed: {e}", flush=True)


def runOne(target: str) -> dict:
    t0 = time.time()
    print(f"\n=== {target} ===", flush=True)
    wipeLogs(target)
    try:
        result = driveBridgeChatViaVisionPilot(target, PROMPT, max_steps=MAX_STEPS)
    except Exception as e:
        return {"target": target, "ok": False, "error": f"{type(e).__name__}: {e}", "elapsed": time.time() - t0}
    result = dict(result or {})
    result["target"] = target
    result["elapsed"] = round(time.time() - t0, 1)
    return result


def main() -> int:
    # Optional subset: `python run_all_pilots.py --targets grok,claude,...`
    selected = TARGETS
    for i, a in enumerate(sys.argv[1:]):
        if a == "--targets" and i + 1 < len(sys.argv[1:]):
            selected = [t.strip().lower() for t in sys.argv[i + 2].split(",") if t.strip()]
            break
        if a.startswith("--targets="):
            selected = [t.strip().lower() for t in a.split("=", 1)[1].split(",") if t.strip()]
            break
    rows: list[dict] = []
    for t in selected:
        row = runOne(t)
        rows.append(row)
        ans = (row.get("response") or row.get("answer") or "")[:80]
        print(
            f"[{t}] ok={row.get('ok')} steps={row.get('steps')} elapsed={row.get('elapsed')}s "
            f"final_url={row.get('final_url')!r} answer={ans!r} err={row.get('error') or ''!r}",
            flush=True,
        )
    print("\n========== SUMMARY ==========")
    for r in rows:
        verdict = "PASS" if r.get("ok") else "FAIL"
        print(f"  {verdict:4s} {r['target']:9s} steps={r.get('steps')!s:>3} {r.get('elapsed')}s -> {(r.get('response') or r.get('answer') or '')[:60]!r}")
    out = ROOT / "logs" / "vision_pilot_matrix.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=2, default=str), encoding="utf-8")
    print(f"\nFull JSON: {out}")
    return 0 if all(r.get("ok") for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
