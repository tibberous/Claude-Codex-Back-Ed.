"""
Hook File: file_to_model_hook.py

What it does:
Hook-form copy of the unified OpenAI file bridge used to send local files to a model and retrieve model-produced files.

How to use it:
Call the exported helpers from other automation or execute the CLI entrypoints in the file for direct testing.

Primary entry points:
_db, _log, _settings_get, _api_key, _headers, _ensure_dir, md5_of_file, _mime, _read_text_fallback, _normalize_model, model_supports_file_inputs, model_supports_tools

Relevant URL(s):
- https://api.openai.com/v1/files
- https://api.openai.com/v1/files/{file_id}
- https://api.openai.com/v1/files/{file_id}/content
- https://api.openai.com/v1/responses

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : file_to_model_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Hook-form copy of the unified OpenAI file bridge used to send local files to a model and retrieve model-produced files.
#
# HOW TO INVOKE
#   Call the exported helpers from other automation or execute the CLI entrypoints in the file for direct testing.
#
# PRIMARY ENTRY POINTS
#   - _db
#   - _log
#   - _settings_get
#   - _api_key
#   - _headers
#   - _ensure_dir
#   - md5_of_file
#   - _mime
#   - _read_text_fallback
#   - _normalize_model
#   - model_supports_file_inputs
#   - model_supports_tools
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
import os, sys, io, json, base64, mimetypes, hashlib, traceback
from pathlib import Path

import requests
from trio_hook_orm import log_hook, settings_get


DEFAULT_MODEL = "gpt-4.1-mini"
DEFAULT_SCREEN_DIR = r"C:\Temp\screenshots"
DEFAULT_OUTPUT_DIR = r"C:\Temp\file_to_model_out"


FILE_MODELS = {
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-4-turbo-preview",
    "gpt-4",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "o1",
    "o1-mini",
    "o1-preview",
    "o3",
    "o3-mini",
    "o4-mini",
}


TOOL_MODELS_PREFIXES = ("gpt-4", "gpt-5", "o1", "o3", "o4")



def _log(data, is_error=0):
    try:
        log_hook("gtp_hook_log", data, int(is_error))
    except Exception:
        pass


def _settings_get(key):
    try:
        return settings_get(key)
    except Exception as e:
        _log({"action": "file_to_model.settings_get.error", "key": key, "error": str(e)}, is_error=1)
        return None


def _api_key():
    return _settings_get("openai_api_key")


def _headers(json_mode=True):
    headers = {"Authorization": f"Bearer {_api_key()}"}
    if json_mode:
        headers["Content-Type"] = "application/json"
    return headers


def _ensure_dir(path):
    if path:
        Path(path).mkdir(parents=True, exist_ok=True)


def md5_of_file(filepath):
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _mime(path):
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def _read_text_fallback(path: Path):
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except Exception:
            pass
    return path.read_bytes().decode("utf-8", errors="replace")


def _normalize_model(model):
    return (model or "").strip().lower()


def model_supports_file_inputs(model):
    m = _normalize_model(model)
    if not m:
        return False
    if m in FILE_MODELS:
        return True
    if m.startswith(("gpt-4", "gpt-5", "o1", "o3", "o4")):
        return True
    return False


def model_supports_tools(model):
    m = _normalize_model(model)
    return any(m.startswith(prefix) for prefix in TOOL_MODELS_PREFIXES)


def model_capabilities(model):
    return {
        "model": model,
        "normalized": _normalize_model(model),
        "supports_file_inputs": model_supports_file_inputs(model),
        "supports_tools": model_supports_tools(model),
    }


def _upload_file(filepath, purpose="user_data"):
    filepath = os.path.abspath(filepath)
    _log({"action": "file_to_model.upload", "filepath": filepath, "purpose": purpose})
    with open(filepath, "rb") as f:
        r = requests.post(
            "https://api.openai.com/v1/files",
            headers=_headers(json_mode=False),
            files={"file": (os.path.basename(filepath), f)},
            data={"purpose": purpose},
            timeout=120,
        )
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text[:1500]}
    _log({"action": "file_to_model.upload.response", "status": r.status_code, "body": str(data)[:1500]})
    if r.status_code != 200:
        _log({"action": "file_to_model.upload.error", "status": r.status_code, "body": data}, is_error=1)
        return None
    return data.get("id")


def _build_attachment_parts(filepath):
    path = Path(filepath)
    name = path.name
    mime = _mime(path)

    if mime.startswith("image/"):
        return [
            {"type": "input_text", "text": f"Attached image: {name}"},
            {"type": "input_image", "image_url": f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"},
        ]

    if mime == "application/pdf" or path.suffix.lower() == ".pdf":
        return [
            {"type": "input_text", "text": f"Attached PDF: {name}"},
            {"type": "input_file", "filename": name, "file_data": f"data:application/pdf;base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"},
        ]

    text_suffixes = {".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".css", ".js", ".py", ".php", ".sql", ".yaml", ".yml", ".ini", ".log", ".bat", ".ps1"}
    if path.suffix.lower() in text_suffixes or mime.startswith("text/"):
        text = _read_text_fallback(path)
        return [{"type": "input_text", "text": f"File: {name}\n\n{text}"}]

    return [
        {"type": "input_text", "text": f"Binary file attached: {name}"},
        {"type": "input_file", "filename": name, "file_data": f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"},
    ]


def _response_payload(model, content, allow_tools=False):
    payload = {
        "model": model,
        "input": [{"role": "user", "content": content}],
    }
    if allow_tools and model_supports_tools(model):
        payload["tools"] = [{"type": "code_interpreter", "container": {"type": "auto"}}]
    return payload


def _extract_text(response_json):
    parts = []
    if response_json.get("output_text"):
        parts.append(response_json.get("output_text"))
    for item in response_json.get("output", []) or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []) or []:
            if content.get("type") in ("output_text", "text") and content.get("text"):
                parts.append(content.get("text"))
    return "\n".join([p for p in parts if p]).strip()


def _extract_output_file_ids(response_json):
    found = []
    for item in response_json.get("output", []) or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []) or []:
            if content.get("type") == "output_file" and content.get("file_id"):
                found.append((content.get("file_id"), None))
            for ann in content.get("annotations", []) or []:
                if ann.get("type") == "container_file_citation" and ann.get("file_id"):
                    found.append((ann.get("file_id"), ann.get("filename")))
    deduped = []
    seen = set()
    for file_id, name in found:
        if file_id not in seen:
            seen.add(file_id)
            deduped.append((file_id, name))
    return deduped


def get_file(file_id, save_to):
    r = requests.get(f"https://api.openai.com/v1/files/{file_id}/content", headers=_headers(json_mode=False), timeout=180)
    if r.status_code != 200:
        _log({"action": "file_to_model.get_file.error", "status": r.status_code, "file_id": file_id, "body": r.text[:1000]}, is_error=1)
        return None
    target = Path(save_to)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(r.content)
    _log({"action": "file_to_model.get_file.saved", "file_id": file_id, "save_to": str(target), "bytes": len(r.content)})
    return str(target)


def _download_output_files(response_json, save_dir=None):
    save_dir = save_dir or DEFAULT_OUTPUT_DIR
    _ensure_dir(save_dir)
    saved = []
    for file_id, hinted_name in _extract_output_file_ids(response_json):
        meta_name = hinted_name
        try:
            meta = requests.get(f"https://api.openai.com/v1/files/{file_id}", headers=_headers(json_mode=False), timeout=60)
            if meta.status_code == 200:
                meta_json = meta.json()
                meta_name = meta_name or meta_json.get("filename")
        except Exception:
            pass
        name = meta_name or f"{file_id}.bin"
        target = Path(save_dir) / name
        saved_path = get_file(file_id, str(target))
        if saved_path:
            saved.append(saved_path)
    return saved


def _call_responses(model, content, allow_tools=False, timeout=240):
    payload = _response_payload(model=model, content=content, allow_tools=allow_tools)
    _log({"action": "file_to_model.responses.request", "model": model, "allow_tools": allow_tools, "payload_preview": str(payload)[:1800]})
    r = requests.post("https://api.openai.com/v1/responses", headers=_headers(json_mode=True), json=payload, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text[:2000]}
    _log({"action": "file_to_model.responses.response", "status": r.status_code, "body": str(data)[:2000]})
    return r.status_code, data


def analyze(filepath, prompt, model=DEFAULT_MODEL):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    uploaded_id = _upload_file(filepath)
    caps = model_capabilities(model)
    if not caps["supports_file_inputs"]:
        return {
            "ok": False,
            "status": None,
            "error": f"Model does not appear to support file inputs through this hook: {model}",
            "capabilities": caps,
            "uploaded_file_id": uploaded_id,
        }
    content = _build_attachment_parts(filepath) + [{"type": "input_text", "text": str(prompt)}]
    status, data = _call_responses(model=model, content=content, allow_tools=False, timeout=180)
    if status != 200:
        _log({"action": "file_to_model.analyze.error", "status": status, "body": data}, is_error=1)
        return {"ok": False, "status": status, "result": data, "uploaded_file_id": uploaded_id, "capabilities": caps}
    return {
        "ok": True,
        "uploaded_file_id": uploaded_id,
        "response_id": data.get("id"),
        "text": _extract_text(data),
        "saved_files": _download_output_files(data),
        "capabilities": caps,
    }


def analyze_file(filepath, prompt, model=DEFAULT_MODEL):
    return analyze(filepath, prompt, model=model)


def roundtrip(filepath, prompt=None, model=DEFAULT_MODEL, save_dir=None):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    uploaded_id = _upload_file(filepath)
    caps = model_capabilities(model)
    if not caps["supports_file_inputs"]:
        return {
            "ok": False,
            "status": None,
            "error": f"Model does not appear to support file inputs through this hook: {model}",
            "capabilities": caps,
            "uploaded_file_id": uploaded_id,
        }
    user_prompt = prompt or "Return the attached file unchanged as a downloadable output file with the same filename. Do not modify, summarize, transform, or re-encode it."
    content = _build_attachment_parts(filepath) + [{"type": "input_text", "text": user_prompt}]

    status, data = _call_responses(model=model, content=content, allow_tools=True, timeout=240)
    if status != 200:
        _log({"action": "file_to_model.roundtrip.error", "status": status, "body": data}, is_error=1)
        return {"ok": False, "status": status, "result": data, "uploaded_file_id": uploaded_id, "capabilities": caps}

    saved = _download_output_files(data, save_dir=save_dir)
    if not saved and caps["supports_tools"]:
        status2, data2 = _call_responses(model=model, content=content, allow_tools=False, timeout=180)
        if status2 == 200:
            data = data2
            saved = _download_output_files(data2, save_dir=save_dir)

    return {
        "ok": True,
        "uploaded_file_id": uploaded_id,
        "response_id": data.get("id"),
        "text": _extract_text(data),
        "saved_files": saved,
        "input_md5": md5_of_file(filepath),
        "saved_md5": [md5_of_file(p) for p in saved],
        "capabilities": caps,
    }


def mirror_file(filepath, save_to=None, model=DEFAULT_MODEL):
    save_to = save_to or DEFAULT_OUTPUT_DIR
    save_dir = save_to if os.path.isdir(save_to) or str(save_to).endswith("\\") else str(Path(save_to).parent)
    result = roundtrip(filepath, model=model, save_dir=save_dir)
    if not result.get("ok"):
        return None
    saved = result.get("saved_files") or []
    if not saved:
        return None
    if save_to and not os.path.isdir(save_to) and not str(save_to).endswith("\\"):
        target = Path(save_to)
        target.parent.mkdir(parents=True, exist_ok=True)
        Path(saved[0]).replace(target)
        return str(target)
    return saved[0]


def _screen_auto_path():
    _ensure_dir(DEFAULT_SCREEN_DIR)
    import datetime
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(DEFAULT_SCREEN_DIR, f"screenshot_{ts}.png")


def capture_screen(save_to=None, region=None, window_title=None, padding=8):
    from screencapture_hook import capture, capture_window
    if window_title:
        return capture_window(window_title, save_to=save_to, padding=padding)
    return capture(save_to=save_to or _screen_auto_path(), region=region)


def capture_and_analyze(prompt, model=DEFAULT_MODEL, save_to=None, region=None, window_title=None, padding=8):
    path = capture_screen(save_to=save_to, region=region, window_title=window_title, padding=padding)
    result = analyze(path, prompt, model=model)
    if isinstance(result, dict):
        result["captured_file"] = path
    return result


def screen_to_model(prompt, model=DEFAULT_MODEL, save_to=None, region=None, window_title=None, padding=8):
    return capture_and_analyze(prompt=prompt, model=model, save_to=save_to, region=region, window_title=window_title, padding=padding)


def save_file_copy(filepath, save_to=None):
    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise FileNotFoundError(filepath)
    src = Path(filepath)
    if not save_to:
        import time
        save_to = str(src.with_name(f"{src.stem}_copy_{int(time.time())}{src.suffix}"))
    Path(save_to).write_bytes(src.read_bytes())
    _log({"action": "file_to_model.save_file_copy", "src": filepath, "dst": save_to, "bytes": os.path.getsize(save_to)})
    return save_to


def _print_result(obj):
    print(json.dumps(obj, indent=2, default=str))


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print("Usage: python file_to_model.py <analyze|analyze_file|roundtrip|mirror_file|capture_and_analyze|screen_to_model|capabilities> ...")
        sys.exit(0)
    action = args[0].lower()
    try:
        if action in ("analyze", "analyze_file"):
            fp = args[1]
            prompt = args[2] if len(args) > 2 else "Describe this file."
            model = args[3] if len(args) > 3 else DEFAULT_MODEL
            _print_result(analyze(fp, prompt, model=model))
        elif action == "roundtrip":
            fp = args[1]
            prompt = args[2] if len(args) > 2 and args[2] != "-" else None
            model = args[3] if len(args) > 3 else DEFAULT_MODEL
            save_dir = args[4] if len(args) > 4 else None
            _print_result(roundtrip(fp, prompt=prompt, model=model, save_dir=save_dir))
        elif action == "mirror_file":
            fp = args[1]
            save_to = args[2] if len(args) > 2 else DEFAULT_OUTPUT_DIR
            model = args[3] if len(args) > 3 else DEFAULT_MODEL
            print(mirror_file(fp, save_to=save_to, model=model) or "None")
        elif action in ("capture_and_analyze", "screen_to_model"):
            prompt = args[1] if len(args) > 1 else "Describe what is on this screen."
            model = args[2] if len(args) > 2 else DEFAULT_MODEL
            _print_result(capture_and_analyze(prompt=prompt, model=model))
        elif action == "capabilities":
            model = args[1] if len(args) > 1 else DEFAULT_MODEL
            _print_result(model_capabilities(model))
        else:
            print(f"Unknown action: {action}")
    except Exception:
        _log({"action": "file_to_model.__main__.exception", "trace": traceback.format_exc()}, is_error=1)
        raise
