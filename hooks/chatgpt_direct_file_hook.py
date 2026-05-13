"""
Hook File: chatgpt_direct_file_hook.py

What it does:
Sends a local file or image straight to the OpenAI Responses API, asks the model to operate on it, and can save any returned file output.

How to use it:
Run `python chatgpt_direct_file_hook.py <file_path> [prompt] [out_path]` with an OpenAI key in OPENAI_API_KEY or CHATGPT_API_KEY.

Primary entry points:
_load_key, _guess_mime, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import json
import base64
import mimetypes
from pathlib import Path

try:
    from openai import OpenAI
except Exception as e:
    print(json.dumps({"ok": False, "error": f"openai import failed: {e}"}))
    raise SystemExit(1)


def _load_key():
    for name in ("OPENAI_API_KEY", "CHATGPT_API_KEY"):
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: python chatgpt_direct_file_hook.py <file_path> [prompt] [out_path]"}))
        raise SystemExit(1)

    file_path = Path(sys.argv[1]).expanduser()
    prompt = sys.argv[2] if len(sys.argv) >= 3 else "Return the attached file unchanged. Do not transform it."
    out_path = Path(sys.argv[3]).expanduser() if len(sys.argv) >= 4 and sys.argv[3].strip() else None

    if not file_path.exists():
        print(json.dumps({"ok": False, "error": f"file not found: {file_path}"}))
        raise SystemExit(1)

    key = _load_key()
    if not key:
        print(json.dumps({"ok": False, "error": "OPENAI_API_KEY/CHATGPT_API_KEY not set"}))
        raise SystemExit(1)

    client = OpenAI(api_key=key)
    data = file_path.read_bytes()
    mime = _guess_mime(file_path)
    b64 = base64.b64encode(data).decode("ascii")

    input_parts = [
        {"type": "input_text", "text": prompt},
    ]

    if mime.startswith("image/"):
        input_parts.append({"type": "input_image", "image_url": f"data:{mime};base64,{b64}", "detail": "auto"})
    else:
        input_parts.append({"type": "input_file", "filename": file_path.name, "file_data": b64})

    response = client.responses.create(
        model="gpt-4.1-mini",
        input=[{"role": "user", "content": input_parts}],
        tools=[{"type": "code_interpreter", "container": {"type": "auto"}}],
    )

    text_parts = []
    saved_files = []

    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", None) == "message":
            for part in getattr(item, "content", []) or []:
                txt = getattr(part, "text", None)
                if txt:
                    text_parts.append(str(txt))
                for ann in getattr(part, "annotations", None) or []:
                    if getattr(ann, "type", None) != "container_file_citation":
                        continue
                    container_id = getattr(ann, "container_id", None)
                    file_id = getattr(ann, "file_id", None)
                    filename = getattr(ann, "filename", None) or file_path.name
                    if not container_id or not file_id:
                        continue
                    blob = client.containers.files.content(container_id=container_id, file_id=file_id)
                    out_bytes = blob.read() if callable(getattr(blob, "read", None)) else getattr(blob, "content", blob)
                    if isinstance(out_bytes, str):
                        out_bytes = out_bytes.encode("utf-8", errors="replace")
                    if isinstance(out_bytes, (bytes, bytearray)):
                        target = out_path if out_path else file_path.with_name(file_path.stem + "_returned" + file_path.suffix)
                        Path(target).write_bytes(bytes(out_bytes))
                        saved_files.append(str(target))

    result = {
        "ok": True,
        "response_id": getattr(response, "id", None),
        "text": "\n".join(text_parts).strip(),
        "saved_files": saved_files,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
