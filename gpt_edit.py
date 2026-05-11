"""One-off: send an image to OpenAI /images/edits, save the result.

Usage:
  python gpt_edit.py <input.png> <output.png> "<prompt>"

Reads openai_api_key from config.ini in this folder.
"""

import sys, base64, configparser, pathlib, requests

if len(sys.argv) < 4:
    sys.exit("usage: gpt_edit.py <input.png> <output.png> \"<prompt>\"")

inPath = pathlib.Path(sys.argv[1])
outPath = pathlib.Path(sys.argv[2])
prompt = sys.argv[3]

cfg = configparser.RawConfigParser()
cfg.read(pathlib.Path(__file__).parent / "config.ini", encoding="utf-8")
key = cfg.get("api_keys", "openai_api_key").strip()
if not key:
    sys.exit("no openai_api_key in config.ini")

print(f"editing {inPath} -> {outPath}")
print(f"prompt: {prompt}")

with open(inPath, "rb") as f:
    r = requests.post(
        "https://api.openai.com/v1/images/edits",
        headers={"Authorization": f"Bearer {key}"},
        files={"image": (inPath.name, f, "image/png")},
        data={"model": "gpt-image-1", "prompt": prompt, "size": "1024x1024"},
        timeout=300,
    )

if r.status_code != 200:
    print(f"ERROR {r.status_code}: {r.text[:2000]}")
    sys.exit(1)

result = r.json()
png_b64 = result["data"][0]["b64_json"]
outPath.parent.mkdir(parents=True, exist_ok=True)
outPath.write_bytes(base64.b64decode(png_b64))
print(f"wrote {outPath} ({outPath.stat().st_size} bytes)")
