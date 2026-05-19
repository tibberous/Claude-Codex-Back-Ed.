"""Ollama bridge — pure HTTP API path, no browser.

Reference example of an api-mode bridge: `mini` is passed in but unused
(the manifest's kind=api tells the runner not to spawn chrome). Every
chat is a synchronous /api/chat POST to the local Ollama daemon.

Model discovery: /api/tags lists what's installed locally. The runner
calls discover_models() at tray startup if it exists, otherwise falls
back to the static models in manifest.xml.
"""
from __future__ import annotations

import configparser
import json
import urllib.request
import urllib.error
from pathlib import Path

SPEC = {
    "name": "ollama",
    "kind": "api",
    "capabilities": {"chat": True, "toolCalls": True},
}

OLLAMA_HOST = "127.0.0.1"
OLLAMA_PORT = 11434
DEFAULT_MODEL = "llama3.2:3b"


def _config_path() -> Path:
    """Walk up to find config.ini at the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "config.ini"
        if cand.exists():
            return cand
    return Path("config.ini")


def _model() -> str:
    """Read configured model from config.ini [ollama] model = ..."""
    cfg = configparser.ConfigParser(interpolation=None)
    try:
        cfg.read(_config_path(), encoding="utf-8")
    except Exception:
        return DEFAULT_MODEL
    return (cfg.get("ollama", "model", fallback="") or "").strip() or DEFAULT_MODEL


def discover_models() -> list[str]:
    """Hit /api/tags and return the list of locally-installed models.
    Empty list means daemon is down; runner falls back to manifest list."""
    try:
        with urllib.request.urlopen(
            f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/tags", timeout=2.0
        ) as r:
            data = json.loads(r.read().decode("utf-8"))
            return [m["name"] for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]
    except Exception:
        return []


def custom_driveChat(mini, message: str, email: str = "", password: str = "") -> dict:
    """One-shot POST to /api/chat. mini is unused. email/password unused."""
    model = _model()
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/chat",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180.0) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return {"ok": False,
                "error": f"can't reach ollama at {OLLAMA_HOST}:{OLLAMA_PORT} — "
                         f"is `ollama serve` running? ({e})"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    try:
        parsed = json.loads(raw)
        answer = parsed.get("message", {}).get("content", "")
        return {"ok": True, "answer": answer, "model": model}
    except Exception as e:
        return {"ok": False, "error": f"json parse: {e}", "raw": raw[:500]}


TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
