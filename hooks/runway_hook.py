"""
Hook File: runway_hook.py

What it does:
RunwayML API wrapper for uploads, text-to-image, image-to-video, task polling, and media download helpers.

How to use it:
Provide a Runway API key, then call the action helpers or CLI to create and monitor Runway jobs.

Primary entry points:
get_headers, post_json, get_json, wait_for_task, download_file, action_create_upload, action_upload_file, action_text_to_image, action_image_to_video, action_task, action_list_voices, action_list_avatars

Relevant URL(s):
- https://api.dev.runwayml.com

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : runway_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   RunwayML API wrapper for uploads, text-to-image, image-to-video, task polling, and media download helpers.
#
# HOW TO INVOKE
#   Provide a Runway API key, then call the action helpers or CLI to create and monitor Runway jobs.
#
# PRIMARY ENTRY POINTS
#   - get_headers
#   - post_json
#   - get_json
#   - wait_for_task
#   - download_file
#   - action_create_upload
#   - action_upload_file
#   - action_text_to_image
#   - action_image_to_video
#   - action_task
#   - action_list_voices
#   - action_list_avatars
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
import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from _config import cfg

API_BASE        = cfg("runway", "api_base",        default="https://api.dev.runwayml.com")
DEFAULT_VERSION = cfg("runway", "default_version", default="2024-11-06")
# config.ini-only — no hardcoded key in source.
DEFAULT_API_KEY = cfg("runway", "api_key",         env="RUNWAY_API_KEY")


def get_headers(api_key: str, include_json: bool = False):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Runway-Version": DEFAULT_VERSION,
    }
    if include_json:
        headers["Content-Type"] = "application/json"
    return headers


def post_json(path: str, payload: dict, api_key: str):
    r = requests.post(f"{API_BASE}{path}", headers=get_headers(api_key, True), json=payload, timeout=120)
    if not r.ok:
        try:
            detail = r.json()
        except Exception:
            detail = r.text
        raise RuntimeError(f"POST {path} failed with {r.status_code}: {detail}")
    return r.json()


def get_json(path: str, api_key: str):
    r = requests.get(f"{API_BASE}{path}", headers=get_headers(api_key, False), timeout=120)
    r.raise_for_status()
    return r.json()


def wait_for_task(task_id: str, api_key: str, interval: int = 5, timeout: int = 900):
    start = time.time()
    while True:
        data = get_json(f"/v1/tasks/{task_id}", api_key)
        status = data.get("status")
        if status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
            return data
        if time.time() - start > timeout:
            raise TimeoutError(f"Task {task_id} timed out after {timeout} seconds")
        time.sleep(interval)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return {}


def download_file(url: str, out_path: str):
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)


def action_create_upload(args):
    payload = {
        "filename": args.filename,
        "type": "ephemeral",
    }
    data = post_json("/v1/uploads", payload, args.api_key)
    print(json.dumps(data, indent=2))


def action_upload_file(args):
    file_path = Path(args.file)
    payload = {
        "filename": args.filename or file_path.name,
        "type": "ephemeral",
    }
    data = post_json("/v1/uploads", payload, args.api_key)
    upload_url = data.get("uploadUrl")
    fields = data.get("fields") or {}
    runway_uri = data.get("runwayUri")
    if not upload_url or not runway_uri:
        raise RuntimeError(f"Unexpected upload response: {data}")
    with open(file_path, "rb") as f:
        files = {"file": (payload["filename"], f)}
        r = requests.post(upload_url, data=fields, files=files, timeout=300)
        r.raise_for_status()
    print(json.dumps({
        "filename": payload["filename"],
        "runwayUri": runway_uri,
        "uploadUrl": upload_url,
        "uploadStatus": r.status_code,
        "response": data,
    }, indent=2))


def action_text_to_image(args):
    payload = {
        "model": args.model,
        "promptText": args.prompt,
        "ratio": args.ratio,
    }
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.reference_image:
        payload["referenceImages"] = [args.reference_image]
    created = post_json("/v1/text_to_image", payload, args.api_key)
    result = {"created": created}
    if args.wait:
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_image_to_video(args):
    prompt_image = args.prompt_image
    if not (str(prompt_image).startswith("http://") or str(prompt_image).startswith("https://") or str(prompt_image).startswith("runway:") or str(prompt_image).startswith("data:image/")):
        file_path = Path(prompt_image)
        if not file_path.exists():
            raise FileNotFoundError(f"prompt image not found: {prompt_image}")
        upload_payload = {
            "filename": file_path.name,
            "type": "ephemeral",
        }
        upload_data = post_json("/v1/uploads", upload_payload, args.api_key)
        upload_url = upload_data.get("uploadUrl")
        fields = upload_data.get("fields") or {}
        runway_uri = upload_data.get("runwayUri")
        if not upload_url or not runway_uri:
            raise RuntimeError(f"Unexpected upload response: {upload_data}")
        with open(file_path, "rb") as f:
            files = {"file": (file_path.name, f)}
            r = requests.post(upload_url, data=fields, files=files, timeout=300)
            r.raise_for_status()
        prompt_image = runway_uri

    payload = {
        "model": args.model,
        "promptImage": prompt_image,
        "promptText": args.prompt,
        "ratio": args.ratio,
        "duration": args.duration,
    }
    if args.seed is not None:
        payload["seed"] = args.seed
    created = post_json("/v1/image_to_video", payload, args.api_key)
    result = {"created": created, "promptImage": prompt_image}
    if args.wait:
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_task(args):
    data = get_json(f"/v1/tasks/{args.id}", args.api_key)
    print(json.dumps(data, indent=2))


def action_list_voices(args):
    data = get_json("/v1/voices", args.api_key)
    print(json.dumps(data, indent=2))


def action_list_avatars(args):
    data = get_json("/v1/avatars", args.api_key)
    print(json.dumps(data, indent=2))


def action_account_probe(args):
    paths = [
        "/v1/voices",
        "/v1/avatars",
        "/v1/tasks",
        "/v1/tasks?limit=10",
        "/v1/assets",
        "/v1/media",
        "/v1/files",
        "/v1/uploads",
        "/v1/videos",
        "/v1/images",
    ]
    results = []
    for path in paths:
        url = f"{API_BASE}{path}"
        try:
            r = requests.get(url, headers=get_headers(args.api_key, False), timeout=60)
            item = {"path": path, "status": r.status_code}
            try:
                item["json"] = r.json()
            except Exception:
                item["text"] = r.text[:1000]
            results.append(item)
        except Exception as e:
            results.append({"path": path, "error": str(e)})
    print(json.dumps({"results": results}, indent=2))


def action_text_to_speech(args):
    voice = {
        "type": args.voice_type or "custom",
        "id": args.voice_id,
    }
    if args.voice_name:
        voice["name"] = args.voice_name
    payload = {
        "model": args.model,
        "promptText": args.text,
        "voice": voice,
    }
    created = post_json("/v1/text_to_speech", payload, args.api_key)
    result = {"created": created, "payload": payload}
    if args.wait and created.get("id"):
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_speech_to_speech(args):
    payload = {
        "voiceId": args.voice_id,
        "audioUri": args.audio_uri,
    }
    created = post_json("/v1/speech_to_speech", payload, args.api_key)
    result = {"created": created}
    if args.wait and created.get("id"):
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_voice_dubbing(args):
    payload = {
        "videoUri": args.video_uri,
        "voiceId": args.voice_id,
    }
    if args.audio_uri:
        payload["audioUri"] = args.audio_uri
    if args.model:
        payload["model"] = args.model
    if args.target_lang:
        payload["targetLang"] = args.target_lang
    created = post_json("/v1/voice_dubbing", payload, args.api_key)
    result = {"created": created, "payload": payload}
    if args.wait and created.get("id"):
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_voice_isolation(args):
    payload = {"model": "eleven_voice_isolation", "videoUri": args.video_uri}
    created = post_json("/v1/voice_isolation", payload, args.api_key)
    result = {"created": created}
    if args.wait and created.get("id"):
        final = wait_for_task(created["id"], args.api_key, args.interval, args.timeout)
        result["final"] = final
        outputs = final.get("output") or []
        if args.output and outputs:
            download_file(outputs[0], args.output)
            result["downloaded_to"] = args.output
    print(json.dumps(result, indent=2))


def action_create_voice(args):
    payload = {
        "name": args.name,
        "from": {
            "audioUri": args.audio_uri,
        },
    }
    if args.description:
        payload["description"] = args.description
    created = post_json("/v1/voices", payload, args.api_key)
    print(json.dumps({"created": created}, indent=2))


def action_create_avatar(args):
    payload = {
        "name": args.name,
        "audioUri": args.audio_uri,
    }
    if args.reference_image:
        payload["referenceImageUri"] = args.reference_image
    created = post_json("/v1/avatars", payload, args.api_key)
    print(json.dumps({"created": created}, indent=2))


def build_parser():
    p = argparse.ArgumentParser(description="Runway API hook")
    p.add_argument("--api-key", default=os.environ.get("RUNWAY_API_KEY", DEFAULT_API_KEY))
    sub = p.add_subparsers(dest="action", required=True)

    p_cu = sub.add_parser("create_upload")
    p_cu.add_argument("--filename", required=True)
    p_cu.set_defaults(func=action_create_upload)

    p_uf = sub.add_parser("upload_file")
    p_uf.add_argument("--file", required=True)
    p_uf.add_argument("--filename")
    p_uf.set_defaults(func=action_upload_file)

    p_tti = sub.add_parser("text_to_image")
    p_tti.add_argument("--prompt", required=True)
    p_tti.add_argument("--model", default="gen4_image")
    p_tti.add_argument("--ratio", default="1280:720")
    p_tti.add_argument("--seed", type=int)
    p_tti.add_argument("--reference-image")
    p_tti.add_argument("--wait", action="store_true")
    p_tti.add_argument("--interval", type=int, default=5)
    p_tti.add_argument("--timeout", type=int, default=900)
    p_tti.add_argument("--output")
    p_tti.set_defaults(func=action_text_to_image)

    p_itv = sub.add_parser("image_to_video")
    p_itv.add_argument("--prompt-image", required=True)
    p_itv.add_argument("--prompt", required=True)
    p_itv.add_argument("--model", default="gen4_turbo")
    p_itv.add_argument("--ratio", default="1280:720")
    p_itv.add_argument("--duration", type=int, default=5)
    p_itv.add_argument("--seed", type=int)
    p_itv.add_argument("--wait", action="store_true")
    p_itv.add_argument("--interval", type=int, default=5)
    p_itv.add_argument("--timeout", type=int, default=1800)
    p_itv.add_argument("--output")
    p_itv.set_defaults(func=action_image_to_video)

    p_task = sub.add_parser("task")
    p_task.add_argument("--id", required=True)
    p_task.set_defaults(func=action_task)

    p_lv = sub.add_parser("list_voices")
    p_lv.set_defaults(func=action_list_voices)

    p_la = sub.add_parser("list_avatars")
    p_la.set_defaults(func=action_list_avatars)

    p_probe = sub.add_parser("account_probe")
    p_probe.set_defaults(func=action_account_probe)

    p_tts = sub.add_parser("text_to_speech")
    p_tts.add_argument("--voice-id", required=True)
    p_tts.add_argument("--voice-type")
    p_tts.add_argument("--voice-name")
    p_tts.add_argument("--text", required=True)
    p_tts.add_argument("--model", default="eleven_multilingual_v2")
    p_tts.add_argument("--wait", action="store_true")
    p_tts.add_argument("--interval", type=int, default=5)
    p_tts.add_argument("--timeout", type=int, default=900)
    p_tts.add_argument("--output")
    p_tts.set_defaults(func=action_text_to_speech)

    p_sts = sub.add_parser("speech_to_speech")
    p_sts.add_argument("--voice-id", required=True)
    p_sts.add_argument("--audio-uri", required=True)
    p_sts.add_argument("--wait", action="store_true")
    p_sts.add_argument("--interval", type=int, default=5)
    p_sts.add_argument("--timeout", type=int, default=1800)
    p_sts.add_argument("--output")
    p_sts.set_defaults(func=action_speech_to_speech)

    p_vd = sub.add_parser("voice_dubbing")
    p_vd.add_argument("--video-uri", required=True)
    p_vd.add_argument("--audio-uri", required=True)
    p_vd.add_argument("--voice-id", required=True)
    p_vd.add_argument("--model", default="eleven_voice_dubbing")
    p_vd.add_argument("--target-lang")
    p_vd.add_argument("--wait", action="store_true")
    p_vd.add_argument("--interval", type=int, default=5)
    p_vd.add_argument("--timeout", type=int, default=1800)
    p_vd.add_argument("--output")
    p_vd.set_defaults(func=action_voice_dubbing)

    p_vi = sub.add_parser("voice_isolation")
    p_vi.add_argument("--video-uri", required=True)
    p_vi.add_argument("--wait", action="store_true")
    p_vi.add_argument("--interval", type=int, default=5)
    p_vi.add_argument("--timeout", type=int, default=1800)
    p_vi.add_argument("--output")
    p_vi.set_defaults(func=action_voice_isolation)

    p_cv = sub.add_parser("create_voice")
    p_cv.add_argument("--name", required=True)
    p_cv.add_argument("--audio-uri", required=True)
    p_cv.add_argument("--description")
    p_cv.set_defaults(func=action_create_voice)

    p_ca = sub.add_parser("create_avatar")
    p_ca.add_argument("--name", required=True)
    p_ca.add_argument("--audio-uri", required=True)
    p_ca.add_argument("--reference-image")
    p_ca.set_defaults(func=action_create_avatar)

    return p


if __name__ == "__main__":
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except requests.HTTPError as e:
        body = e.response.text if e.response is not None else str(e)
        print(json.dumps({"error": "http", "status": getattr(e.response, "status_code", None), "body": body}, indent=2))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": "exception", "message": str(e)}, indent=2))
        sys.exit(1)
