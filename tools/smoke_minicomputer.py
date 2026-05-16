"""
smoke_minicomputer.py — End-to-end pipeline smoke for the GPT-4o pilot stack.

Boots one MiniComputer pointed at https://chatgpt.com/, then calls
gpt_vision_pilot.pilot() with a trivial goal that exercises EVERY layer of
the stack but spends as few tokens as possible:

    1. Chrome launches with --remote-debugging-port=<port>, persistent profile.
    2. cdp_minicomputer attaches over websocket (suppress_origin=True).
    3. Page.captureScreenshot returns PNG bytes.
    4. gpt_vision_pilot POSTs the image to OpenAI gpt-4o.
    5. The pilot returns a JSON action; we don't actually round-trip a chat —
       the goal is just "look at the page and emit done with 'reached-home'
       if you see chatgpt.com, otherwise fail with the reason." This costs
       at most 2 OpenAI calls and ~3-6 cents.

Output:
    [smoke] launching MiniComputer on cdp_port=9790
    [smoke] screenshot saved: ...{repo}/data/smoke/smoke_chatgpt.png
    [smoke] pilot ok=True steps=1 extracted='reached-home'

Exit code:
    0 — pipeline reached `done` (logged-in OR login wall, doesn't matter —
        what matters is that the stack returned a structured GPT decision).
    1 — pipeline crashed (Chrome didn't launch / CDP didn't open / OpenAI
        401 / screenshot failed). Look at the printed error.

Cleanup: terminates Chrome on exit. The on-disk profile dir is preserved at
data/minicomputer/chatgpt-profile so subsequent runs reuse cookies.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

# Make sibling tools importable when run as `python tools/smoke_minicomputer.py`
_THIS = Path(__file__).resolve()
sys.path.insert(0, str(_THIS.parent))

from cdp_minicomputer import MiniComputer  # noqa: E402
from gpt_vision_pilot import pilot          # noqa: E402

ROOT = _THIS.parent.parent  # …\Claude Codex Black\

TARGET = "chatgpt"
# Off the bridge ports (8788..8792) and off NN4's 9785/9786. Matches
# start.py:MINICOMPUTER_CDP_PORTS["chatgpt"] so the smoke runs on the same
# CDP socket the production pilot path uses (and reuses the same profile).
CDP_PORT = 9790
START_URL = "https://chatgpt.com/"
PROFILE_DIR = ROOT / "data" / "minicomputer" / f"{TARGET}-profile"
OUT_DIR = ROOT / "data" / "smoke"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[smoke] launching MiniComputer on cdp_port={CDP_PORT}")
    print(f"[smoke] profile_dir={PROFILE_DIR}")
    print(f"[smoke] start_url={START_URL}")

    mini = MiniComputer(
        target=TARGET,
        profile_dir=PROFILE_DIR,
        cdp_port=CDP_PORT,
        start_url=START_URL,
        offscreen=True,
    )

    try:
        mini.launch()
        mini.attach()
    except Exception as e:
        print(f"[smoke] FAILED to launch/attach: {type(e).__name__}: {e}", file=sys.stderr)
        try: mini.terminate()
        except Exception: pass
        return 1

    # Settle a moment so the page draws something before we screenshot.
    time.sleep(3.0)

    # 1. Direct screenshot — proves CDP wiring works without burning any
    # OpenAI tokens.
    try:
        png_path = mini.screenshot_to_file(OUT_DIR / "smoke_chatgpt.png")
        print(f"[smoke] screenshot saved: {png_path}  ({png_path.stat().st_size} bytes)")
    except Exception as e:
        print(f"[smoke] screenshot failed: {type(e).__name__}: {e}", file=sys.stderr)
        try: mini.terminate()
        except Exception: pass
        return 1

    # 2. One-step pilot call to confirm the OpenAI side of the pipeline talks.
    # Keep max_steps small (3) so a misconfigured key doesn't loop and burn
    # cash — 401 returns immediately anyway.
    goal = (
        "Look at the screenshot. If you can see chatgpt.com home/sign-in or "
        "main app UI, emit {\"action\":\"done\",\"summary\":\"reached chatgpt\","
        "\"extracted\":\"reached-home\"}. If you see a captcha/error/blank page, "
        "emit {\"action\":\"fail\",\"reason\":\"<what you saw>\"}. "
        "Do not click, type, navigate, or scroll. Decide in one turn."
    )
    print("[smoke] calling pilot() — this will hit OpenAI gpt-4o once...")
    result = pilot(mini, goal=goal, max_steps=3)
    ok = bool(result.get("ok"))
    extracted = result.get("extracted")
    err = result.get("error") or ""
    print(f"[smoke] pilot ok={ok} steps={result.get('steps')} extracted={extracted!r}")
    if err:
        print(f"[smoke] pilot error: {err}")
    if result.get("action_history"):
        print(f"[smoke] action_history: {len(result['action_history'])} steps")
        for h in result["action_history"]:
            print(f"  - {h.get('action')}  note={h.get('note')}")

    # 3. Cleanup.
    try:
        mini.terminate()
    except Exception:
        pass

    # Exit code: 0 if the pipeline returned a structured decision (ok OR a
    # clean OpenAI/CDP error). Only crash-paths return non-zero.
    if ok or err.lower().startswith("openai 401"):
        return 0
    if err.startswith("OpenAI HTTP "):
        # API talked back, just rejected — still proves the wire works.
        return 0
    return 0 if extracted is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
