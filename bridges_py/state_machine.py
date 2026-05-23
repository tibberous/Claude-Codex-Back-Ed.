"""state_machine.py — the 6-state bridge FSM.

Per `docs/BRIDGE_WHITEPAPER.md` §4. Each provider target moves through:

    COLD -> REGISTERING -> WARM -> HOT -> PATCHING -> BLOCKED_NEEDS_HUMAN

State per target is held in-memory in `TargetState`. The HOT-state script
(window.__cbeBridge source) is persisted to `state/providers/<key>.script.js`;
discovered models persist to `state/providers/<key>.json`.

v1 scaffold: enum + transition methods + persistence helpers. No real
state-machine driving yet (that's the next agent — needs the OpenAI tool
dispatcher and the per-target QWebEngineView running).
"""

from __future__ import annotations

import enum
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class BridgeState(enum.Enum):
    """Six states per whitepaper §4. Always uppercase, persisted as the .name."""

    COLD                 = "COLD"                  # no profile, no script
    REGISTERING          = "REGISTERING"           # no account; signup flow
    WARM                 = "WARM"                  # logged in, no script yet
    HOT                  = "HOT"                   # script installed, 0 API hits
    PATCHING             = "PATCHING"              # 1 API hit to repair -> HOT
    BLOCKED_NEEDS_HUMAN  = "BLOCKED_NEEDS_HUMAN"   # toast user, await "I did it"


# Legal transitions. Anything not in here is a programmer error and will
# raise from TargetState.transition().
LEGAL_TRANSITIONS = {
    BridgeState.COLD: {
        BridgeState.REGISTERING,
        BridgeState.WARM,
        BridgeState.BLOCKED_NEEDS_HUMAN,
    },
    BridgeState.REGISTERING: {
        BridgeState.WARM,
        BridgeState.BLOCKED_NEEDS_HUMAN,
        BridgeState.COLD,
    },
    BridgeState.WARM: {
        BridgeState.HOT,
        BridgeState.PATCHING,
        BridgeState.BLOCKED_NEEDS_HUMAN,
        BridgeState.COLD,
    },
    BridgeState.HOT: {
        BridgeState.PATCHING,
        BridgeState.WARM,
        BridgeState.BLOCKED_NEEDS_HUMAN,
        BridgeState.COLD,
    },
    BridgeState.PATCHING: {
        BridgeState.HOT,
        BridgeState.BLOCKED_NEEDS_HUMAN,
        BridgeState.WARM,
    },
    BridgeState.BLOCKED_NEEDS_HUMAN: {
        # User clicked "I did it" — back to PATCHING for one retry, or directly
        # to HOT if the existing script smoke-test passes.
        BridgeState.PATCHING,
        BridgeState.HOT,
        BridgeState.WARM,
        BridgeState.COLD,
    },
}


class TargetState:
    """Per-provider runtime state. Thread-safe via internal lock.

    The state machine itself is dumb — transitions are caused by external
    drivers (openai_tools dispatch, source_capture results, JS contract poll
    returns). This class is just the bookkeeping.
    """

    def __init__(self, key: str, state_dir: Path):
        self.key = key
        self.state_dir = state_dir
        self.state: BridgeState = BridgeState.COLD
        self.lastTransitionAt: float = time.time()
        self.lastError: Optional[str] = None
        self.patchAttempts: int = 0           # increments on each PATCHING entry; reset on HOT
        self.session_id: Optional[str] = None # bridge_sources/<key>/<session_id>/
        self.script_path = state_dir / f"{key}.script.js"
        self.models_path = state_dir / f"{key}.json"
        self._lock = threading.RLock()

    # ── Transitions ─────────────────────────────────────────────────────────

    def transition(self, to: BridgeState, *, reason: str = "") -> None:
        """Move to `to`. Raises if the transition isn't in LEGAL_TRANSITIONS."""
        with self._lock:
            if to not in LEGAL_TRANSITIONS.get(self.state, set()):
                raise ValueError(
                    f"[{self.key}] illegal transition {self.state.name} -> {to.name}"
                )
            prev = self.state
            self.state = to
            self.lastTransitionAt = time.time()
            if to == BridgeState.HOT:
                self.patchAttempts = 0
            elif to == BridgeState.PATCHING:
                self.patchAttempts += 1
            if reason:
                self.lastError = reason if to == BridgeState.BLOCKED_NEEDS_HUMAN else None
            print(f"[bridges_py] [{self.key}] {prev.name} -> {to.name}"
                  + (f"  ({reason})" if reason else ""))

    # ── Persistence helpers ─────────────────────────────────────────────────

    def loadFromDisk(self) -> None:
        """If `state/providers/<key>.script.js` exists, advance COLD -> WARM
        (we have a cached script — login may still be needed but we're past
        first contact). v1 scaffold is conservative: only flip to WARM if BOTH
        the script AND models files exist, since either alone is suspect."""
        with self._lock:
            if self.script_path.exists() and self.models_path.exists():
                # Don't auto-flip to HOT — the cookies in bridge_profiles/<key>/
                # may have expired. Caller will probe via runJavaScript().
                if self.state == BridgeState.COLD:
                    try:
                        self.transition(BridgeState.WARM, reason="cached script found")
                    except ValueError:
                        pass

    def saveScript(self, source: str) -> None:
        """Persist the GPT-4o-authored __cbeBridge script. Called by
        install_bridge_script tool."""
        with self._lock:
            self.script_path.parent.mkdir(parents=True, exist_ok=True)
            self.script_path.write_text(source, encoding="utf-8")
            print(f"[bridges_py] [{self.key}] saved {len(source)} bytes -> {self.script_path}")

    def loadScript(self) -> Optional[str]:
        with self._lock:
            if not self.script_path.exists():
                return None
            return self.script_path.read_text(encoding="utf-8")

    def saveModels(self, models: List[Dict[str, Any]]) -> None:
        """Persist GPT-4o's discovered model list. Format:
            [{"name": "GPT-5", "id": "gpt-5"}, ...]
        """
        with self._lock:
            self.models_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "models": models,
            }
            self.models_path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            print(f"[bridges_py] [{self.key}] saved {len(models)} models -> {self.models_path}")

    def loadModels(self) -> List[Dict[str, Any]]:
        with self._lock:
            if not self.models_path.exists():
                return []
            try:
                return json.loads(self.models_path.read_text(encoding="utf-8")).get("models", [])
            except Exception as e:
                print(f"[bridges_py] [{self.key}] models load failed: {e}")
                return []

    def asDict(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "key":               self.key,
                "state":             self.state.name,
                "lastTransitionAt":  self.lastTransitionAt,
                "lastError":         self.lastError,
                "patchAttempts":     self.patchAttempts,
                "session_id":        self.session_id,
                "has_script":        self.script_path.exists(),
                "has_models":        self.models_path.exists(),
            }
