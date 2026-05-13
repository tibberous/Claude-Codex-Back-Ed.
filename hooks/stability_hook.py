"""
Hook File: stability_hook.py

What it does:
Stability AI REST API wrapper — text-to-image generation using SDXL and
other Stability engines. Saves output images to disk.

How to use it:
  python stability_hook.py generate "a cat in space" out.png
  python stability_hook.py generate "a cat in space" out.png --engine stable-diffusion-xl-1024-v1-0 --steps 30

Primary entry points:
generate, list_engines, main

Relevant URL(s):
- https://platform.stability.ai/docs/api-reference
- Get a key: https://platform.stability.ai/account/keys
"""

import os
import sys
import json
import base64
import requests
from pathlib import Path

API_BASE = "https://api.stability.ai/v1"
API_KEY = os.environ.get("STABILITY_API_KEY", "")
DEFAULT_ENGINE = "stable-diffusion-xl-1024-v1-0"


def _require_key():
    if not API_KEY:
        print(
            "ERROR: STABILITY_API_KEY is not set.\n"
            "Set the env var or set API_KEY in this file.\n"
            "Get a key at: https://platform.stability.ai/account/keys",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_key()
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def generate(prompt: str, out_path: str = "output.png", engine: str = DEFAULT_ENGINE,
             negative_prompt: str = "", steps: int = 30, cfg_scale: float = 7.0,
             width: int = 1024, height: int = 1024):
    payload = {
        "text_prompts": [{"text": prompt, "weight": 1.0}],
        "cfg_scale": cfg_scale,
        "steps": steps,
        "width": width,
        "height": height,
        "samples": 1,
    }
    if negative_prompt:
        payload["text_prompts"].append({"text": negative_prompt, "weight": -1.0})

    r = requests.post(
        f"{API_BASE}/generation/{engine}/text-to-image",
        headers=_headers(),
        json=payload,
        timeout=120,
    )
    if not r.ok:
        try:
            detail = r.json()
        except Exception:
            detail = r.text
        print(json.dumps({"error": r.status_code, "detail": detail}, indent=2), file=sys.stderr)
        sys.exit(1)

    artifacts = r.json().get("artifacts", [])
    if not artifacts:
        print("ERROR: No image returned", file=sys.stderr)
        sys.exit(1)

    img_data = base64.b64decode(artifacts[0]["base64"])
    Path(out_path).write_bytes(img_data)
    print(f"Saved {len(img_data)} bytes → {out_path}")
    return out_path


def list_engines():
    r = requests.get(f"{API_BASE}/engines/list", headers=_headers(), timeout=30)
    r.raise_for_status()
    engines = r.json()
    print(json.dumps([{"id": e["id"], "name": e["name"]} for e in engines], indent=2))
    return engines


def main():
    if len(sys.argv) < 2:
        print(
            "Usage:\n"
            "  python stability_hook.py generate \"prompt\" [out.png] [--engine <id>] [--steps N] [--neg \"negative\"]\n"
            "  python stability_hook.py engines",
            file=sys.stderr,
        )
        sys.exit(1)

    action = sys.argv[1].lower()
    if action == "generate":
        if len(sys.argv) < 3:
            print("ERROR: prompt required", file=sys.stderr)
            sys.exit(1)
        prompt = sys.argv[2]
        out = "output.png"
        engine = DEFAULT_ENGINE
        steps = 30
        neg = ""
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--engine" and i + 1 < len(sys.argv):
                engine = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--steps" and i + 1 < len(sys.argv):
                steps = int(sys.argv[i + 1]); i += 2
            elif sys.argv[i] == "--neg" and i + 1 < len(sys.argv):
                neg = sys.argv[i + 1]; i += 2
            else:
                out = sys.argv[i]; i += 1
        generate(prompt, out, engine, neg, steps)
    elif action == "engines":
        list_engines()
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
