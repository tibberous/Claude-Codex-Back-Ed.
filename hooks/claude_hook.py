"""
Hook File: claude_hook.py

What it does:
Anthropic Claude hook that sends text or image prompts, lists models, reads usage, and records hook activity to the database.

How to use it:
Run or import it after providing an Anthropic API key. Use the exported ask, vision, models, and usage paths described in the code.

Primary entry points:
_load_gtp_settings, get_api_key, db_connect, ensure_log_table, log_action, media_type_for, client, ask, vision, models, usage, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import json
import mimetypes
from pathlib import Path
from datetime import datetime
from trio_hook_orm import ensure_log_table as orm_ensure_log_table, first_setting, log_hook

try:
    import anthropic
except Exception as e:
    print(f"anthropic import failed: {e}", file=sys.stderr)
    sys.exit(2)

HOOK_NAME = "claude_hook"
DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
GTP_PATH = ROOT / "cutiepy.py"


def _load_gtp_settings():
    text = GTP_PATH.read_text(encoding="utf-8", errors="ignore")
    if "globals()['ANTHROPIC_KEY']" in text or 'globals()["ANTHROPIC_KEY"]' in text:
        return {"anthropic_api_key": os.environ.get("ANTHROPIC_KEY", "")}
    ns = {}
    try:
        exec(compile(text, str(GTP_PATH), "exec"), ns, ns)  # monkeypatch-ok: controlled legacy settings loader
    except Exception:
        pass
    settings = ns.get("settings")
    if settings is not None:
        return settings
    return None


def get_api_key():
    for env_name in ("ANTHROPIC_API_KEY", "ANTHROPIC_KEY"):
        v = str(os.environ.get(env_name, "") or "").strip()
        if v:
            return v
    settings = _load_gtp_settings()
    if settings is not None:
        for attr in ("anthropic_api_key", "anthropicApiKey", "claude_api_key", "claudeApiKey"):
            try:
                v = str(getattr(settings, attr, "") or "").strip()
                if v:
                    return v
            except Exception:
                pass
        try:
            for key in ("anthropic_api_key", "anthropicApiKey", "claude_api_key", "claudeApiKey"):
                v = str(settings.get(key, "") or "").strip()
                if v:
                    return v
        except Exception:
            pass
    db_value = first_setting(("anthropic_api_key", "claude_api_key", "anthropicApiKey", "claudeApiKey"), "")
    return str(db_value or "").strip()


def db_connect():
    # Compatibility shim: hook database work now goes through SQLAlchemy ORM helpers.
    return None

def ensure_log_table():
    try:
        orm_ensure_log_table("gtp_hook_log")
    except Exception:
        pass

def log_action(action, details):
    payload = {"hook_name": HOOK_NAME, "action": action, "details": details}
    try:
        log_hook("gtp_hook_log", payload, 0)
    except Exception:
        pass

def media_type_for(path: Path) -> str:
    mt, _ = mimetypes.guess_type(str(path))
    if mt:
        return mt
    return "application/octet-stream"


def client():
    key = get_api_key()
    if not key:
        raise RuntimeError("Anthropic API key not found in CutiePy settings or environment")
    return anthropic.Anthropic(api_key=key)


def ask(prompt: str, model: str = DEFAULT_MODEL):
    c = client()
    resp = c.messages.create(
        model=model,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    parts = []
    for block in getattr(resp, "content", []) or []:
        txt = getattr(block, "text", None)
        if txt:
            parts.append(txt)
    text = "\n".join(parts).strip()
    log_action("ask", {"model": model, "prompt": prompt[:1000], "response": text[:4000]})
    print(text)


def vision(image_path: str, prompt: str, model: str = DEFAULT_MODEL):
    p = Path(image_path)
    if not p.exists():
        raise FileNotFoundError(image_path)
    c = client()
    data = p.read_bytes()
    resp = c.messages.create(
        model=model,
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type_for(p),
                        "data": __import__("base64").b64encode(data).decode("ascii")
                    }
                },
                {"type": "text", "text": prompt}
            ]
        }],
    )
    parts = []
    for block in getattr(resp, "content", []) or []:
        txt = getattr(block, "text", None)
        if txt:
            parts.append(txt)
    text = "\n".join(parts).strip()
    log_action("vision", {"model": model, "image_path": str(p), "prompt": prompt[:1000], "response": text[:4000]})
    print(text)


def models():
    builtin_models = ["claude-sonnet-4-6", "claude-opus-4.1", "claude-haiku-4.5"]
    log_action("models", {"models": builtin_models})
    print("\n".join(builtin_models))


def usage():
    print(
        "Usage:\n"
        "  python claude_hook.py ask \"prompt\" [model]\n"
        "  python claude_hook.py chat \"prompt\" [model]\n"
        "  python claude_hook.py vision <image_path> \"prompt\" [model]\n"
        "  python claude_hook.py models\n"
    )


def main():
    ensure_log_table()
    if len(sys.argv) < 2:
        usage()
        sys.exit(1)
    action = (sys.argv[1] or "").strip().lower()
    if action in ("ask", "chat"):
        if len(sys.argv) < 3:
            usage()
            sys.exit(1)
        prompt = sys.argv[2]
        model = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_MODEL
        ask(prompt, model)
        return
    if action == "vision":
        if len(sys.argv) < 4:
            usage()
            sys.exit(1)
        image_path = sys.argv[2]
        prompt = sys.argv[3]
        model = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_MODEL
        vision(image_path, prompt, model)
        return
    if action == "models":
        models()
        return
    usage()
    sys.exit(1)


if __name__ == "__main__":
    main()
