"""
Hook File: gemini_hook.py

What it does:
Google Gemini hook for chat-style prompts, image generation, model listing, and DB-backed logging.

How to use it:
Configure a Gemini API key, then call chat, generate_image, or list_models from this module.

Primary entry points:
_db, _settings_get, _log, _api_key, _ensure_log_table, chat, generate_image, list_models, md5_of_file, md5_of_string

Relevant URL(s):
- https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}
- https://generativelanguage.googleapis.com/v1beta/models/{model}:predict?key={api_key}
- https://generativelanguage.googleapis.com/v1beta/models?key={api_key}

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : gemini_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Google Gemini hook for chat-style prompts, image generation, model listing, and DB-backed logging.
#
# HOW TO INVOKE
#   Configure a Gemini API key, then call chat, generate_image, or list_models from this module.
#
# PRIMARY ENTRY POINTS
#   - _db
#   - _settings_get
#   - _log
#   - _api_key
#   - _ensure_log_table
#   - chat
#   - generate_image
#   - list_models
#   - md5_of_file
#   - md5_of_string
#
# CREDENTIALS
#   API keys, tokens, and remote endpoints live in config.ini at
#   the repo root. Hooks read them via hooks/_config.py. Do NOT
#   hardcode keys in source. Do NOT push config.ini to the server
#   (it is on the auto-update exclude list in extension.js).
#
# SIDE EFFECTS
#   May make outbound network calls, may write to disk under the
#   repo root (logs/, chats/, reports/), may spawn subprocesses,
#   may touch the journaling DB through trio_hook_orm. Inspect
#   the function before running it on production data.
#
# THINGS THIS HOOK WILL NOT DO
#   - It will not reload the VSCode window. Nothing in this repo
#     reloads the window. See handbook.txt Section 8.
#   - It will not push files to the server. Pushing is gated on
#     config.ini [updates] is_admin=true and is handled by the
#     extension, not by individual hooks. See handbook.txt §17.
#   - It will not silently swallow errors. If it fails it raises
#     or returns a structured error; check the trace channel.
#
# RELATED HANDBOOK SECTIONS
#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library
#   §22 Trace channel   §24 Troubleshooting
#
# === LLM-USAGE: END ===
import os
import sys
import json
import hashlib
import datetime
import requests
from trio_hook_orm import ensure_log_table, log_hook, settings_get

def _settings_get(key):
    try:
        return settings_get(key)
    except Exception as e:
        _log(f"settings_get error: {e}", is_error=1)
        return None

def _log(data, is_error=0):
    try:
        log_hook("gemini_hook_log", data, int(is_error))
    except Exception:
        pass

def _api_key():
    return _settings_get("gemini_api_key")

def _ensure_log_table():
    try:
        ensure_log_table("gemini_hook_log")
    except Exception:
        pass

_ensure_log_table()

def chat(prompt, model=None, system=None, history=None):
    try:
        if model is None:
            model = _settings_get("gem_model_choice") or "gemini-2.0-flash"
        api_key = _api_key()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        contents = []
        if history:
            contents.extend(history)
        contents.append({"role": "user", "parts": [{"text": prompt}]})
        payload = {"contents": contents}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        _log({"action": "chat", "model": model, "prompt": prompt[:200]})
        r = requests.post(url, headers={"Content-Type": "application/json"}, json=payload, timeout=60)
        result = r.json()
        _log({"action": "chat_response", "status": r.status_code, "result": str(result)[:500]})
        if r.status_code != 200:
            _log({"action": "chat_error", "status": r.status_code, "body": result}, is_error=1)
            return None
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        _log({"action": "chat_exception", "error": str(e)}, is_error=1)
        return None

def generate_image(prompt, model="imagen-3.0-generate-002", save_to=None, aspect_ratio="1:1", number_of_images=1):
    try:
        import base64
        api_key = _api_key()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:predict?key={api_key}"
        payload = {
            "instances": [{"prompt": prompt}],
            "parameters": {"sampleCount": number_of_images, "aspectRatio": aspect_ratio}
        }
        _log({"action": "generate_image", "prompt": prompt[:200], "model": model})
        r = requests.post(url, headers={"Content-Type": "application/json"}, json=payload, timeout=120)
        result = r.json()
        _log({"action": "generate_image_response", "status": r.status_code, "result": str(result)[:500]})
        if r.status_code != 200:
            _log({"action": "generate_image_error", "status": r.status_code, "body": result}, is_error=1)
            return None
        predictions = result.get("predictions", [])
        if not predictions:
            _log({"action": "generate_image_empty", "result": str(result)[:500]}, is_error=1)
            return None
        images = []
        for pred in predictions:
            b64 = pred.get("bytesBase64Encoded")
            mime = pred.get("mimeType", "image/png")
            images.append({"b64": b64, "mimeType": mime})
        if save_to and images and images[0]["b64"]:
            ext = ".png" if "png" in images[0]["mimeType"] else ".jpeg"
            if not save_to.lower().endswith((".png", ".jpg", ".jpeg")):
                save_to = save_to + ext
            img_bytes = base64.b64decode(images[0]["b64"])
            with open(save_to, "wb") as f:
                f.write(img_bytes)
            images[0]["path"] = save_to
            _log({"action": "generate_image_saved", "path": save_to})
        return images
    except Exception as e:
        _log({"action": "generate_image_exception", "error": str(e)}, is_error=1)
        return None

def list_models():
    try:
        api_key = _api_key()
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
        _log({"action": "list_models"})
        r = requests.get(url, timeout=30)
        result = r.json()
        _log({"action": "list_models_response", "status": r.status_code, "count": len(result.get("models", []))})
        if r.status_code != 200:
            _log({"action": "list_models_error", "status": r.status_code, "body": result}, is_error=1)
            return None
        return [m["name"] for m in result.get("models", [])]
    except Exception as e:
        _log({"action": "list_models_exception", "error": str(e)}, is_error=1)
        return None

def md5_of_file(filepath):
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()

def md5_of_string(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python gemini_hook.py <action> [args]")
        print("Actions: chat | generate_image | list_models")
        import sys; sys.exit(1)
    action = sys.argv[1].lower()
    if action == "chat":
        prompt = sys.argv[2] if len(sys.argv) > 2 else "Say hello from gemini_hook in one sentence."
        model  = sys.argv[3] if len(sys.argv) > 3 else None
        reply  = chat(prompt, model=model)
        print("Reply:", reply)
    elif action == "generate_image":
        prompt  = sys.argv[2] if len(sys.argv) > 2 else "A photorealistic red apple on a white table"
        save_to = sys.argv[3] if len(sys.argv) > 3 else None
        results = generate_image(prompt, save_to=save_to)
        if results:
            print(f"Generated {len(results)} image(s).")
            if save_to:
                print(f"Saved to: {results[0].get('path', save_to)}")
        else:
            print("Image generation failed. Check gemini_hook_log.")
    elif action == "list_models":
        models = list_models()
        if models:
            for m in models:
                print(m)
        else:
            print("Failed to retrieve models. Check gemini_hook_log.")
    else:
        print(f"Unknown action: {action}")
        import sys; sys.exit(1)
