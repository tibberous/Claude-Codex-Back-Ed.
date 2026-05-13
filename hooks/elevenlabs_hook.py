"""
Hook File: elevenlabs_hook.py

What it does:
ElevenLabs TTS API — generate speech from text, list available voices,
and save audio to a file. Supports all ElevenLabs models.

How to use it:
  python elevenlabs_hook.py speak "Hello world" out.mp3
  python elevenlabs_hook.py speak "Hello" out.mp3 --voice <voice_id> --model eleven_turbo_v2
  python elevenlabs_hook.py voices

Primary entry points:
speak, list_voices, main

Relevant URL(s):
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- Get a key: https://elevenlabs.io/app/settings/api-keys
"""

import os
import sys
import json
import requests
from pathlib import Path

API_BASE = "https://api.elevenlabs.io/v1"
API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")

DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel
DEFAULT_MODEL = "eleven_turbo_v2"


def _require_key():
    if not API_KEY:
        print(
            "ERROR: ELEVENLABS_API_KEY is not set.\n"
            "Set the env var or set API_KEY in this file.\n"
            "Get a key at: https://elevenlabs.io/app/settings/api-keys",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_key()
    return {"xi-api-key": API_KEY, "Content-Type": "application/json"}


def speak(text: str, out_path: str = "output.mp3", voice_id: str = DEFAULT_VOICE_ID, model: str = DEFAULT_MODEL):
    payload = {
        "text": text,
        "model_id": model,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    r = requests.post(
        f"{API_BASE}/text-to-speech/{voice_id}",
        headers={**_headers(), "Accept": "audio/mpeg"},
        json=payload,
        timeout=60,
    )
    r.raise_for_status()
    Path(out_path).write_bytes(r.content)
    print(f"Saved {len(r.content)} bytes → {out_path}")
    return out_path


def list_voices():
    r = requests.get(f"{API_BASE}/voices", headers=_headers(), timeout=30)
    r.raise_for_status()
    voices = r.json().get("voices", [])
    result = [{"voice_id": v["voice_id"], "name": v["name"], "category": v.get("category", "")} for v in voices]
    print(json.dumps(result, indent=2))
    return result


def main():
    if len(sys.argv) < 2:
        print(
            "Usage:\n"
            "  python elevenlabs_hook.py speak \"text\" [out.mp3] [--voice <id>] [--model <id>]\n"
            "  python elevenlabs_hook.py voices",
            file=sys.stderr,
        )
        sys.exit(1)

    action = sys.argv[1].lower()
    if action == "speak":
        if len(sys.argv) < 3:
            print("ERROR: text required", file=sys.stderr)
            sys.exit(1)
        text = sys.argv[2]
        out = "output.mp3"
        voice = DEFAULT_VOICE_ID
        model = DEFAULT_MODEL
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--voice" and i + 1 < len(sys.argv):
                voice = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--model" and i + 1 < len(sys.argv):
                model = sys.argv[i + 1]; i += 2
            else:
                out = sys.argv[i]; i += 1
        speak(text, out, voice, model)
    elif action == "voices":
        list_voices()
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
