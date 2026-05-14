"""
Hook File: gtp_hook.py

What it does:
Main OpenAI-backed CutiePy hook for chat, file upload/download, image generation, and file-to-model helper flows with DB logging.

How to use it:
Use this as the primary general-purpose OpenAI hook after the local settings table has a valid OpenAI key.

Primary entry points:
_db, _settings_get, _log, _api_key, _headers, chat, send_file, generate_image, get_file, file_to_model, md5_of_file, md5_of_string

Relevant URL(s):
- https://api.openai.com/v1/chat/completions
- https://api.openai.com/v1/containers/{container_id}/files/{returned_file_id}/content
- https://api.openai.com/v1/files
- https://api.openai.com/v1/files/{file_id}/content
- https://api.openai.com/v1/images/generations
- https://api.openai.com/v1/responses

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : gtp_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Main OpenAI-backed CutiePy hook for chat, file upload/download, image generation, and file-to-model helper flows with DB logging.
#
# HOW TO INVOKE
#   Use this as the primary general-purpose OpenAI hook after the local settings table has a valid OpenAI key.
#
# PRIMARY ENTRY POINTS
#   - _db
#   - _settings_get
#   - _log
#   - _api_key
#   - _headers
#   - chat
#   - send_file
#   - generate_image
#   - get_file
#   - file_to_model
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
import os, sys, hashlib, requests
from trio_hook_orm import log_hook, settings_get



def _settings_get(key):
    try:
        return settings_get(key)
    except Exception as e:
        _log(f"settings_get error: {e}", is_error=1); return None


def _log(data, is_error=0):
    try:
        log_hook("gtp_hook_log", data, int(is_error))
    except Exception:
        pass


def _api_key():
    return _settings_get("openai_api_key")


def _headers():
    return {"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"}


def chat(prompt, model="gpt-4o", system=None, history=None):
    try:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})
        _log({"action": "chat", "model": model, "prompt": str(prompt)[:200]})
        r = requests.post("https://api.openai.com/v1/chat/completions", headers=_headers(), json={"model": model, "messages": messages}, timeout=60)
        result = r.json()
        _log({"action": "chat_response", "status": r.status_code, "result": str(result)[:500]})
        if r.status_code != 200:
            _log({"action": "chat_error", "status": r.status_code, "body": result}, is_error=1); return None
        return result["choices"][0]["message"]["content"]
    except Exception as e:
        _log({"action": "chat_exception", "error": str(e)}, is_error=1); return None


def send_file(filepath, purpose="assistants"):
    try:
        _log({"action": "send_file", "filepath": filepath})
        headers = {"Authorization": f"Bearer {_api_key()}"}
        with open(filepath, "rb") as f:
            r = requests.post("https://api.openai.com/v1/files", headers=headers, files={"file": (os.path.basename(filepath), f)}, data={"purpose": purpose}, timeout=120)
        result = r.json()
        _log({"action": "send_file_response", "status": r.status_code, "result": str(result)[:500]})
        if r.status_code != 200:
            _log({"action": "send_file_error", "status": r.status_code, "body": result}, is_error=1); return None
        return result.get("id")
    except Exception as e:
        _log({"action": "send_file_exception", "error": str(e)}, is_error=1); return None


def generate_image(prompt, model="dall-e-3", size="1024x1024", quality="standard", save_to=None):
    try:
        payload = {"model": model, "prompt": prompt, "n": 1, "size": size, "quality": quality}
        _log({"action": "generate_image", "prompt": str(prompt)[:200], "model": model})
        r = requests.post("https://api.openai.com/v1/images/generations", headers=_headers(), json=payload, timeout=120)
        result = r.json()
        _log({"action": "generate_image_response", "status": r.status_code, "result": str(result)[:500]})
        if r.status_code != 200:
            _log({"action": "generate_image_error", "status": r.status_code, "body": result}, is_error=1); return None
        url = result["data"][0]["url"]
        if save_to:
            img_data = requests.get(url, timeout=60).content
            with open(save_to, "wb") as f:
                f.write(img_data)
            _log({"action": "generate_image_saved", "path": save_to})
        return url
    except Exception as e:
        _log({"action": "generate_image_exception", "error": str(e)}, is_error=1); return None


def get_file(file_id, save_to=None):
    try:
        _log({"action": "get_file", "file_id": file_id})
        headers = {"Authorization": f"Bearer {_api_key()}"}
        r = requests.get(f"https://api.openai.com/v1/files/{file_id}/content", headers=headers, timeout=120)
        _log({"action": "get_file_response", "status": r.status_code, "bytes": len(r.content)})
        if r.status_code != 200:
            _log({"action": "get_file_error", "status": r.status_code, "body": r.text[:500]}, is_error=1); return None
        if save_to:
            with open(save_to, "wb") as f:
                f.write(r.content)
            _log({"action": "get_file_saved", "path": save_to})
        return r.content
    except Exception as e:
        _log({"action": "get_file_exception", "error": str(e)}, is_error=1); return None


def file_to_model(filepath, prompt, model="gpt-4o", system=None, save_to=None):
    try:
        filepath = os.path.abspath(filepath)
        if not os.path.exists(filepath):
            _log({"action": "file_to_model_error", "error": "file_missing", "filepath": filepath}, is_error=1)
            return None

        filename = os.path.basename(filepath)
        ext = os.path.splitext(filepath)[1].lower()
        mime = "application/octet-stream"
        if ext == ".png":
            mime = "image/png"
        elif ext in (".jpg", ".jpeg"):
            mime = "image/jpeg"
        elif ext == ".gif":
            mime = "image/gif"
        elif ext == ".webp":
            mime = "image/webp"

        with open(filepath, "rb") as f:
            file_bytes = f.read()

        b64 = __import__("base64").b64encode(file_bytes).decode("ascii")
        data_url = f"data:{mime};base64,{b64}"
        content_blocks = [{"type": "input_text", "text": prompt}]
        if mime.startswith("image/"):
            content_blocks.append({"type": "input_image", "image_url": data_url})
        else:
            content_blocks.append({"type": "input_file", "filename": filename, "file_data": data_url})

        payload = {
            "model": model,
            "input": [{"role": "user", "content": content_blocks}],
            "tools": [{"type": "code_interpreter", "container": {"type": "auto"}}],
        }
        if system:
            payload["instructions"] = system

        r = requests.post("https://api.openai.com/v1/responses", headers=_headers(), json=payload, timeout=180)
        result = r.json()
        _log({"action": "file_to_model_response", "status": r.status_code, "result": str(result)[:2000], "filepath": filepath})
        if r.status_code != 200:
            _log({"action": "file_to_model_response_error", "status": r.status_code, "body": result, "filepath": filepath}, is_error=1)
            return None

        text_parts = []
        output = result.get("output", []) or []
        for item in output:
            if item.get("type") != "message":
                continue
            for part in item.get("content", []) or []:
                part_type = part.get("type")
                if part_type in ("output_text", "text"):
                    txt = part.get("text") or ""
                    if txt:
                        text_parts.append(txt)

        content_bytes = None
        returned_filename = filename
        for item in output:
            if item.get("type") != "message":
                continue
            for part in item.get("content", []) or []:
                for ann in part.get("annotations", []) or []:
                    if ann.get("type") != "container_file_citation":
                        continue
                    container_id = ann.get("container_id")
                    returned_file_id = ann.get("file_id")
                    returned_filename = ann.get("filename") or returned_filename
                    if not container_id or not returned_file_id:
                        continue
                    file_resp = requests.get(
                        f"https://api.openai.com/v1/containers/{container_id}/files/{returned_file_id}/content",
                        headers={"Authorization": f"Bearer {_api_key()}"},
                        timeout=180,
                    )
                    _log({"action": "file_to_model_download", "status": file_resp.status_code, "bytes": len(file_resp.content), "container_id": container_id, "file_id": returned_file_id})
                    if file_resp.status_code == 200:
                        content_bytes = file_resp.content
                        break
                if content_bytes is not None:
                    break
            if content_bytes is not None:
                break

        if content_bytes is None:
            content_bytes = file_bytes
            _log({"action": "file_to_model_fallback_original_bytes", "bytes": len(content_bytes), "filepath": filepath})

        if save_to:
            with open(save_to, "wb") as f:
                f.write(content_bytes)
            _log({"action": "file_to_model_saved", "path": save_to, "bytes": len(content_bytes)})

        return {
            "text": "\n".join(text_parts).strip(),
            "returned_filename": returned_filename,
            "bytes": len(content_bytes),
            "save_to": save_to,
            "source_path": filepath,
        }
    except Exception as e:
        _log({"action": "file_to_model_exception", "error": str(e)}, is_error=1)
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
    args = sys.argv[1:]
    if not args:
        print("Usage: python gtp_hook.py <action> [args...]")
        print("Actions: chat | generate_image | send_file | get_file | file_to_model")
        sys.exit(0)
    action = args[0].lower()
    if action == "chat":
        result = chat(args[1] if len(args) > 1 else "Hello")
        print("Reply:", result)
    elif action == "generate_image":
        prompt = args[1] if len(args) > 1 else "a test image"
        save_to = args[2] if len(args) > 2 else None
        url = generate_image(prompt, save_to=save_to)
        if url:
            print("Image URL:", url)
            if save_to:
                print("Saved to:", save_to)
        else:
            print("generate_image returned None -- check gtp_hook_log")
    elif action == "send_file":
        filepath = args[1] if len(args) > 1 else None
        if not filepath:
            print("Usage: python gtp_hook.py send_file <path>")
        else:
            print("File ID:", send_file(filepath))
    elif action == "get_file":
        file_id = args[1] if len(args) > 1 else None
        save_to = args[2] if len(args) > 2 else None
        if not file_id:
            print("Usage: python gtp_hook.py get_file <file_id> [save_to]")
        else:
            content = get_file(file_id, save_to=save_to)
            if save_to:
                print("Saved to:", save_to)
            else:
                print("Content:", content[:200] if content else None)
    elif action == "file_to_model":
        filepath = args[1] if len(args) > 1 else None
        prompt = args[2] if len(args) > 2 else "Return this file unchanged."
        save_to = args[3] if len(args) > 3 else None
        if not filepath:
            print("Usage: python gtp_hook.py file_to_model <path> [prompt] [save_to]")
        else:
            result = file_to_model(filepath, prompt, save_to=save_to)
            print(result)
    else:
        print(f"Unknown action: {action}")
        print("Actions: chat | generate_image | send_file | get_file | file_to_model")
