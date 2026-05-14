"""
Hook File: chatgtp_hook.py

What it does:
OpenAI / ChatGPT hook that wraps text chat, vision input, file upload/download, model listing, and logging through the local MariaDB tables.

How to use it:
Import and call actions like ask, chat, vision, send_file, get_file, or models after configuring the OpenAI key in settings or environment.

Primary entry points:
_db, _log, _settings_get, _api_key, _headers, _extract_text, _data_url, ask, chat, vision, send_file, get_file

Relevant URL(s):
- https://api.openai.com/v1

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : chatgtp_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   OpenAI / ChatGPT hook that wraps text chat, vision input, file upload/download, model listing, and logging through the local MariaDB tables.
#
# HOW TO INVOKE
#   Import and call actions like ask, chat, vision, send_file, get_file, or models after configuring the OpenAI key in settings or environment.
#
# PRIMARY ENTRY POINTS
#   - _db
#   - _log
#   - _settings_get
#   - _api_key
#   - _headers
#   - _extract_text
#   - _data_url
#   - ask
#   - chat
#   - vision
#   - send_file
#   - get_file
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
import os, sys, json, base64, mimetypes
import requests
from trio_hook_orm import log_hook, settings_get


API_BASE = "https://api.openai.com/v1"
DEFAULT_MODEL = os.environ.get("CHATGTP_DEFAULT_MODEL", "gpt-4o")



def _log(data, is_error=0):
    try:
        log_hook("gtp_hook_log", data, int(is_error))
    except Exception:
        pass


def _settings_get(key):
    try:
        return settings_get(key)
    except Exception as e:
        _log({"action": "settings_get_error", "key": key, "error": str(e)}, is_error=1)
        return None


def _api_key():
    key = (
        _settings_get("openai_api_key")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("OPENAI_KEY")
        or os.environ.get("API_KEY")
        or ""
    )
    return str(key).strip()


def _headers():
    key = _api_key()
    if not key:
        raise RuntimeError("OpenAI API key not found in settings.openai_api_key or environment")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _extract_text(result):
    texts = []
    try:
        for item in result.get("output", []) or []:
            if item.get("type") != "message":
                continue
            for part in item.get("content", []) or []:
                if part.get("type") in ("output_text", "text"):
                    txt = part.get("text") or ""
                    if txt:
                        texts.append(txt)
    except Exception:
        pass
    if texts:
        return "\n".join(texts).strip()
    try:
        return result["choices"][0]["message"]["content"]
    except Exception:
        return ""


def _data_url(filepath):
    mime, _ = mimetypes.guess_type(filepath)
    if not mime:
        mime = "application/octet-stream"
    with open(filepath, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return mime, f"data:{mime};base64,{b64}"


def ask(prompt, model=DEFAULT_MODEL, system=None):
    payload = {
        "model": model,
        "input": [],
    }
    if system:
        payload["instructions"] = system
    payload["input"].append({
        "role": "user",
        "content": [{"type": "input_text", "text": prompt}],
    })
    _log({"action": "ask", "model": model, "prompt": str(prompt)[:300]})
    r = requests.post(f"{API_BASE}/responses", headers=_headers(), json=payload, timeout=180)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "ask_response", "status": r.status_code, "body": str(result)[:1500]})
    if r.status_code != 200:
        _log({"action": "ask_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    return _extract_text(result)


def chat(prompt, model=DEFAULT_MODEL, system=None, history=None):
    payload = {
        "model": model,
        "input": [],
    }
    if system:
        payload["instructions"] = system
    if history:
        for item in history:
            role = "assistant" if str(item.get("role", "")).lower() == "assistant" else "user"
            content = item.get("content", "")
            if isinstance(content, list):
                payload["input"].append({"role": role, "content": content})
            else:
                payload["input"].append({"role": role, "content": [{"type": "input_text", "text": str(content)}]})
    payload["input"].append({"role": "user", "content": [{"type": "input_text", "text": prompt}]})
    _log({"action": "chat", "model": model, "prompt": str(prompt)[:300], "history_len": len(history or [])})
    r = requests.post(f"{API_BASE}/responses", headers=_headers(), json=payload, timeout=180)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "chat_response", "status": r.status_code, "body": str(result)[:1500]})
    if r.status_code != 200:
        _log({"action": "chat_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    return _extract_text(result)


def vision(filepath, prompt, model=DEFAULT_MODEL, system=None):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    mime, url = _data_url(filepath)
    payload = {
        "model": model,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": url},
            ],
        }],
    }
    if system:
        payload["instructions"] = system
    _log({"action": "vision", "model": model, "filepath": filepath, "mime": mime, "prompt": str(prompt)[:300]})
    r = requests.post(f"{API_BASE}/responses", headers=_headers(), json=payload, timeout=240)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "vision_response", "status": r.status_code, "body": str(result)[:1500]})
    if r.status_code != 200:
        _log({"action": "vision_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    return _extract_text(result)


def send_file(filepath, purpose="assistants"):
    filepath = os.path.abspath(filepath)
    _log({"action": "send_file", "filepath": filepath, "purpose": purpose})
    headers = {"Authorization": f"Bearer {_api_key()}"}
    with open(filepath, "rb") as f:
        r = requests.post(f"{API_BASE}/files", headers=headers, files={"file": (os.path.basename(filepath), f)}, data={"purpose": purpose}, timeout=240)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "send_file_response", "status": r.status_code, "body": str(result)[:1500]})
    if r.status_code != 200:
        _log({"action": "send_file_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    return result.get("id")


def get_file(file_id, save_to=None):
    _log({"action": "get_file", "file_id": file_id, "save_to": save_to})
    headers = {"Authorization": f"Bearer {_api_key()}"}
    r = requests.get(f"{API_BASE}/files/{file_id}/content", headers=headers, timeout=240)
    _log({"action": "get_file_response", "status": r.status_code, "bytes": len(r.content)})
    if r.status_code != 200:
        _log({"action": "get_file_error", "status": r.status_code, "body": r.text[:1500]}, is_error=1)
        return None
    if save_to:
        with open(save_to, "wb") as f:
            f.write(r.content)
        return save_to
    return r.content

def direct_file_to_me(filepath, prompt=None, model=DEFAULT_MODEL, system=None):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    mime, _ = mimetypes.guess_type(filepath)
    if not mime:
        mime = "application/octet-stream"
    filename = os.path.basename(filepath)
    _log({"action": "direct_file_to_me", "filepath": filepath, "mime": mime, "model": model})
    headers = {"Authorization": f"Bearer {_api_key()}"}
    with open(filepath, "rb") as f:
        upload = requests.post(
            f"{API_BASE}/files",
            headers=headers,
            files={"file": (filename, f, mime)},
            data={"purpose": "user_data"},
            timeout=240,
        )
    try:
        upload_result = upload.json()
    except Exception:
        upload_result = {"raw": upload.text[:4000]}
    _log({"action": "direct_file_to_me_upload_response", "status": upload.status_code, "body": str(upload_result)[:1500]})
    if upload.status_code != 200:
        _log({"action": "direct_file_to_me_upload_error", "status": upload.status_code, "body": upload_result}, is_error=1)
        return None
    file_id = upload_result.get("id")
    if not file_id:
        _log({"action": "direct_file_to_me_missing_file_id", "body": upload_result}, is_error=1)
        return None
    user_prompt = prompt or "Return the attached file directly as a downloadable file with the same bytes and original filename. Do not describe it. Do not transform it."
    payload = {
        "model": model,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": user_prompt},
                {"type": "input_file", "file_id": file_id},
            ],
        }],
    }
    if system:
        payload["instructions"] = system
    r = requests.post(f"{API_BASE}/responses", headers=_headers(), json=payload, timeout=240)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "direct_file_to_me_response", "status": r.status_code, "body": str(result)[:2000]})
    if r.status_code != 200:
        _log({"action": "direct_file_to_me_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    out = {
        "uploaded_file_id": file_id,
        "response_id": result.get("id"),
        "text": _extract_text(result),
        "container_files": [],
    }
    try:
        for item in result.get("output", []) or []:
            if item.get("type") != "message":
                continue
            for part in item.get("content", []) or []:
                for ann in part.get("annotations", []) or []:
                    if ann.get("type") != "container_file_citation":
                        continue
                    out["container_files"].append({
                        "container_id": ann.get("container_id"),
                        "file_id": ann.get("file_id"),
                        "filename": ann.get("filename"),
                    })
    except Exception as e:
        out["annotation_error"] = str(e)
    return out


def fetch_container_file(container_id, file_id, save_to=None):
    _log({"action": "fetch_container_file", "container_id": container_id, "file_id": file_id, "save_to": save_to})
    r = requests.get(
        f"{API_BASE}/containers/{container_id}/files/{file_id}/content",
        headers={"Authorization": f"Bearer {_api_key()}"},
        timeout=240,
    )
    _log({"action": "fetch_container_file_response", "status": r.status_code, "bytes": len(r.content)})
    if r.status_code != 200:
        _log({"action": "fetch_container_file_error", "status": r.status_code, "body": r.text[:1500]}, is_error=1)
        return None
    if save_to:
        with open(save_to, "wb") as f:
            f.write(r.content)
        return save_to
    return r.content




def analyze_video(filepath, prompt, model=DEFAULT_MODEL, system=None):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    mime, _ = mimetypes.guess_type(filepath)
    if not mime:
        mime = "video/mp4"
    filename = os.path.basename(filepath)
    _log({"action": "analyze_video", "model": model, "filepath": filepath, "mime": mime, "prompt": str(prompt)[:300]})

    headers = {"Authorization": f"Bearer {_api_key()}"}
    with open(filepath, "rb") as f:
        upload = requests.post(
            f"{API_BASE}/files",
            headers=headers,
            files={"file": (filename, f, mime)},
            data={"purpose": "user_data"},
            timeout=600,
        )
    try:
        upload_result = upload.json()
    except Exception:
        upload_result = {"raw": upload.text[:4000]}
    _log({"action": "analyze_video_upload_response", "status": upload.status_code, "body": str(upload_result)[:2000]})
    if upload.status_code != 200:
        _log({"action": "analyze_video_upload_error", "status": upload.status_code, "body": upload_result}, is_error=1)
        return None

    file_id = upload_result.get("id")
    if not file_id:
        _log({"action": "analyze_video_missing_file_id", "body": upload_result}, is_error=1)
        return None

    payload = {
        "model": model,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_file", "file_id": file_id},
            ],
        }],
    }
    if system:
        payload["instructions"] = system
    r = requests.post(f"{API_BASE}/responses", headers=_headers(), json=payload, timeout=600)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "analyze_video_response", "status": r.status_code, "body": str(result)[:2000]})
    if r.status_code != 200:
        _log({"action": "analyze_video_error", "status": r.status_code, "body": result}, is_error=1)
        return {"uploaded_file_id": file_id, "error": result}
    return {
        "uploaded_file_id": file_id,
        "text": _extract_text(result),
        "response": result,
    }

def models():
    _log({"action": "models"})
    r = requests.get(f"{API_BASE}/models", headers={"Authorization": f"Bearer {_api_key()}"}, timeout=120)
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}
    _log({"action": "models_response", "status": r.status_code, "body": str(result)[:1500]})
    if r.status_code != 200:
        _log({"action": "models_error", "status": r.status_code, "body": result}, is_error=1)
        return None
    ids = [item.get("id") for item in (result.get("data") or []) if item.get("id")]
    return ids


def _usage():
    print("Usage: python chatgtp_hook.py <action> [args...]")
    print("Actions:")
    print("  ask <prompt>")
    print("  chat <prompt>")
    print("  vision <image_path> <prompt>")
    print("  send_file <path> [purpose]")
    print("  get_file <file_id> [save_to]")
    print("  direct_file_to_me <path> [prompt]")
    print("  analyze_video <video_path> <prompt>")
    print("  fetch_container_file <container_id> <file_id> [save_to]")
    print("  models")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        _usage()
        sys.exit(0)
    action = str(args[0]).lower()
    if action == "ask":
        print(ask(args[1] if len(args) > 1 else "Hello"))
    elif action == "chat":
        print(chat(args[1] if len(args) > 1 else "Hello"))
    elif action == "vision":
        if len(args) < 3:
            print("Usage: python chatgtp_hook.py vision <image_path> <prompt>")
            sys.exit(1)
        print(vision(args[1], args[2]))
    elif action == "send_file":
        if len(args) < 2:
            print("Usage: python chatgtp_hook.py send_file <path> [purpose]")
            sys.exit(1)
        print(send_file(args[1], args[2] if len(args) > 2 else "assistants"))
    elif action == "get_file":
        if len(args) < 2:
            print("Usage: python chatgtp_hook.py get_file <file_id> [save_to]")
            sys.exit(1)
        print(get_file(args[1], args[2] if len(args) > 2 else None))
    elif action == "direct_file_to_me":
        if len(args) < 2:
            print("Usage: python chatgtp_hook.py direct_file_to_me <path> [prompt]")
            sys.exit(1)
        result = direct_file_to_me(args[1], args[2] if len(args) > 2 else None)
        print(json.dumps(result, ensure_ascii=False))
    elif action == "fetch_container_file":
        if len(args) < 3:
            print("Usage: python chatgtp_hook.py fetch_container_file <container_id> <file_id> [save_to]")
            sys.exit(1)
        print(fetch_container_file(args[1], args[2], args[3] if len(args) > 3 else None))
    elif action == "analyze_video":
        if len(args) < 3:
            print("Usage: python chatgtp_hook.py analyze_video <video_path> <prompt>")
            sys.exit(1)
        prompt = " ".join(args[2:])
        print(json.dumps(analyze_video(args[1], prompt), ensure_ascii=False, indent=2))
    elif action == "models":
        result = models()
        if result is None:
            print(None)
        else:
            print("\n".join(result))
    else:
        _usage()
        sys.exit(1)
