"""
Hook File: image_data_hook.py

What it does:
Reads image metadata, dimensions, EXIF, timestamps, and PIL info fields and returns them as JSON.

How to use it:
Run `python image_data_hook.py info <image_path>` to inspect a file on disk.

Primary entry points:
exif_to_dict, image_info, usage

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import os
import sys
import json
from datetime import datetime
from PIL import Image, ExifTags  # badimport-ok: import name provided by Pillow


def exif_to_dict(img):
    try:
        raw = img.getexif()
        if not raw:
            return {}
        out = {}
        for k, v in raw.items():
            name = ExifTags.TAGS.get(k, str(k))
            try:
                if isinstance(v, bytes):
                    out[name] = f"<bytes:{len(v)}>"
                else:
                    json.dumps(v)
                    out[name] = v
            except Exception:
                out[name] = str(v)
        return out
    except Exception as e:
        return {"_exif_error": str(e)}


def image_info(path):
    if not os.path.exists(path):
        return {"ok": False, "error": "FILE_NOT_FOUND", "path": path}

    st = os.stat(path)
    result = {
        "ok": True,
        "path": os.path.abspath(path),
        "filename": os.path.basename(path),
        "size_bytes": st.st_size,
        "created": datetime.fromtimestamp(st.st_ctime).isoformat(),
        "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
    }

    with Image.open(path) as img:
        result.update({
            "format": img.format,
            "mime": Image.MIME.get(img.format),
            "mode": img.mode,
            "width": img.width,
            "height": img.height,
        })

        dpi = img.info.get("dpi")
        if dpi:
            result["dpi"] = dpi

        result["info"] = {k: (f"<bytes:{len(v)}>" if isinstance(v, bytes) else v) for k, v in img.info.items()}
        result["exif"] = exif_to_dict(img)

    return result


def usage():
    print("Usage: python image_data_hook.py info <image_path>")
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        usage()
    action = sys.argv[1].lower()
    if action != "info":
        usage()
    path = sys.argv[2]
    print(json.dumps(image_info(path), indent=2, default=str))
