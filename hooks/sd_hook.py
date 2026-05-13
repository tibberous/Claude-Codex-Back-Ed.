"""
Hook File: sd_hook.py

What it does:
Local Stable Diffusion / Forge hook that checks whether Forge is running, launches it if needed, and requests image generation through the local API.

How to use it:
Use it when the local Forge server should render an image through the HTTP API on the configured localhost port.

Primary entry points:
db_connect, log, log_exception, settings_get, forge_is_running, forge_start, generate_image

Relevant URL(s):
- http://127.0.0.1:7860

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import sys
import os
import requests
import base64
from trio_hook_lifecycle import startHookProcess
import time
import json
import datetime
import traceback
from trio_hook_orm import log_hook, settings_get as orm_settings_get

# DB helpers

def log(data, is_error=0):
    try:
        log_hook("sd_hook_log", data, int(is_error))
    except Exception as e:
        print(f"[log error] {e}")

def log_exception(context, e):
    tb = traceback.format_exc()
    msg = f"{context}: {type(e).__name__}: {e}\n{tb}"
    log(msg, is_error=1)
    return msg

def settings_get(key):
    return orm_settings_get(key)

# Config
FORGE_URL    = "http://127.0.0.1:7860"
FORGE_BAT    = r"C:\forge\webui\webui-user.bat"
MODELS_DIR   = r"C:\forge\webui\models\Stable-diffusion"
MODELS = [
    "absolutereality_v181.safetensors",
    "dreamshaper_8.safetensors",
    "epicrealismXL_pureFix.safetensors",
    "epicrealism_naturalSinRC1VAE.safetensors",
    "juggernautXL_ragnarokBy.safetensors",
    "realisticVisionV60B1_v51HyperVAE.safetensors",
]
DEFAULT_MODEL = "dreamshaper_8.safetensors"

# Forge lifecycle

def forge_is_running():
    try:
        r = requests.get(f"{FORGE_URL}/sdapi/v1/sd-models", timeout=5)
        return r.status_code == 200
    except Exception:
        return False

def forge_start(wait_timeout=15):
    if forge_is_running():
        return True

    print("[sd_hook] Forge not running - launching detached process...")
    log("Forge not running - launching detached process")

    forge_dir = os.path.dirname(FORGE_BAT)
    ps_command = (
        f"Start-Process -FilePath '{FORGE_BAT}' "
        f"-WorkingDirectory '{forge_dir}' "
        f"-ArgumentList '--api --skip-python-version-check' "
        f"-WindowStyle Normal"
    )

    startHookProcess(
        ["powershell", "-NoProfile", "-Command", ps_command],
        phaseName="stable-diffusion-start",
        cwd=forge_dir
    )

    deadline = time.time() + wait_timeout
    while time.time() < deadline:
        time.sleep(2)
        if forge_is_running():
            waited = int(wait_timeout - max(0, deadline - time.time()))
            print(f"[sd_hook] Forge ready after about {waited}s")
            log(f"Forge ready after about {waited}s")
            return True

    print("[sd_hook] Forge launched in a separate process; API not ready yet.")
    log("Forge launched in a separate process; API not ready yet")
    return False

def generate_image(prompt, dest, model=DEFAULT_MODEL,
                   width=512, height=512, steps=25, cfg=7):
    try:
        if not forge_start():
            msg = "Forge is still starting in a separate window. Try the command again in a minute."
            log(msg, is_error=1)
            print(f"[sd_hook] {msg}")
            return

        dest_lower = dest.lower()
        if not (dest_lower.endswith(".png") or dest_lower.endswith(".jpg")
                or dest_lower.endswith(".jpeg")):
            dest = dest + ".png"

        payload_model = {"sd_model_checkpoint": model}
        opt_resp = requests.post(f"{FORGE_URL}/sdapi/v1/options", json=payload_model, timeout=30)
        log(f"options status={opt_resp.status_code} body={opt_resp.text[:500]}")
        opt_resp.raise_for_status()

        payload = {
            "prompt": prompt,
            "negative_prompt": "",
            "steps": steps,
            "cfg_scale": cfg,
            "width": width,
            "height": height,
            "sampler_name": "DPM++ 2M Karras",
        }

        log(f"generate_image | model={model} | prompt={prompt} | dest={dest}")
        r = requests.post(f"{FORGE_URL}/sdapi/v1/txt2img", json=payload, timeout=300)
        log(f"txt2img status={r.status_code} body={r.text[:500]}")
        r.raise_for_status()

        result = r.json()
        img_b64 = result["images"][0]
        img_bytes = base64.b64decode(img_b64)

        with open(dest, "wb") as f:
            f.write(img_bytes)

        print(f"[sd_hook] Saved to {dest}")
        log(f"Saved {len(img_bytes)} bytes to {dest}")

    except Exception as e:
        full = log_exception("generate_image ERROR", e)
        print(f"[sd_hook] ERROR: {e}")
        print(full)

# CLI dispatcher
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python sd_hook.py generate_image <prompt> <dest> [model] [width] [height] [steps] [cfg]")
        print("       python sd_hook.py list_models")
        sys.exit(1)

    action = sys.argv[1]

    if action == "generate_image":
        prompt = sys.argv[2] if len(sys.argv) > 2 else "a beautiful landscape"
        dest   = sys.argv[3] if len(sys.argv) > 3 else r"C:\Users\moren\Desktop\hooks\output.png"
        model  = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_MODEL
        width  = int(sys.argv[5]) if len(sys.argv) > 5 else 512
        height = int(sys.argv[6]) if len(sys.argv) > 6 else 512
        steps  = int(sys.argv[7]) if len(sys.argv) > 7 else 25
        cfg    = float(sys.argv[8]) if len(sys.argv) > 8 else 7.0
        generate_image(prompt, dest, model, width, height, steps, cfg)

    elif action == "list_models":
        for m in MODELS:
            print(m)

    else:
        print(f"Unknown action: {action}")
        sys.exit(1)
