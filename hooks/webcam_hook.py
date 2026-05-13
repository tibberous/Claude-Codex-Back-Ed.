"""
Hook File: webcam_hook.py

What it does:
OpenCV webcam helper that can detect cameras, probe resolutions, capture stills, preview video, record clips, and optionally hand images to ChatGPT.

How to use it:
Run the CLI actions like snapshot, preview, record, or list_cameras after OpenCV is installed.

Primary entry points:
ensure_dir, timestamp_name, open_camera, probe_camera_resolution, detect_best_camera, resolve_camera, capture_frame, snapshot, send_to_me, record, preview, list_cameras

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import argparse
import os
import sys
from datetime import datetime

try:
    import cv2  # badimport-ok: import name provided by opencv-python
except ImportError:
    print("OpenCV (cv2) is required. Install with: pip install opencv-python", file=sys.stderr)
    sys.exit(1)

HOOK_DIR = r"C:\Users\moren\Desktop\hooks"
DEFAULT_OUT_DIR = r"C:\Temp\webcam"
CHATGTP_HOOK = r"C:\Users\moren\Desktop\hooks\chatgtp_hook.py"
COMMON_RESOLUTIONS = [
    (3840, 2160),
    (2560, 1440),
    (1920, 1080),
    (1600, 1200),
    (1280, 1024),
    (1280, 960),
    (1280, 720),
    (1024, 768),
    (800, 600),
    (640, 480),
]


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def timestamp_name(prefix, ext):
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{ext}"


def open_camera(index=0, width=None, height=None, backend=None):
    backends = []
    if backend is not None:
        backends.append(backend)
    else:
        if hasattr(cv2, "CAP_DSHOW"):
            backends.append(cv2.CAP_DSHOW)
        if hasattr(cv2, "CAP_MSMF"):
            backends.append(cv2.CAP_MSMF)
        backends.append(None)

    last_cap = None
    for be in backends:
        try:
            cap = cv2.VideoCapture(index, be) if be is not None else cv2.VideoCapture(index)
        except TypeError:
            cap = cv2.VideoCapture(index)
        if width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(width))
        if height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(height))
        if cap.isOpened():
            return cap
        last_cap = cap
        cap.release()
    return last_cap if last_cap is not None else cv2.VideoCapture(index)


def probe_camera_resolution(index, requested_resolutions=None, warmup=3):
    requested_resolutions = requested_resolutions or COMMON_RESOLUTIONS
    best = None
    errors = []

    for req_w, req_h in requested_resolutions:
        cap = open_camera(index, req_w, req_h)
        if not cap.isOpened():
            errors.append(f"camera {index} failed to open at requested {req_w}x{req_h}")
            cap.release()
            continue

        ok = False
        frame = None
        for _ in range(max(int(warmup), 1)):
            ok, frame = cap.read()
            if ok and frame is not None:
                break

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if frame is not None and hasattr(frame, 'shape'):
            actual_h = int(frame.shape[0])
            actual_w = int(frame.shape[1])
        cap.release()

        if not ok or frame is None or actual_w <= 0 or actual_h <= 0:
            errors.append(f"camera {index} did not return a frame for requested {req_w}x{req_h}")
            continue

        pixels = actual_w * actual_h
        candidate = {
            'index': index,
            'requested_width': req_w,
            'requested_height': req_h,
            'width': actual_w,
            'height': actual_h,
            'pixels': pixels,
        }
        if best is None or candidate['pixels'] > best['pixels']:
            best = candidate

        if actual_w >= req_w and actual_h >= req_h:
            break

    return best, errors


def detect_best_camera(max_index=2, warmup=3):
    results = []
    errors = []
    for idx in range(max_index + 1):
        best, errs = probe_camera_resolution(idx, warmup=warmup)
        if best:
            results.append(best)
        errors.extend(errs)

    if not results:
        return None, [], errors

    results.sort(key=lambda x: (x['pixels'], x['width'], x['height'], -x['index']), reverse=True)
    return results[0], results, errors


def resolve_camera(args):
    if not getattr(args, 'auto', False):
        return args.camera, args.width, args.height

    cache_path = os.path.join(DEFAULT_OUT_DIR, 'preferred_camera.txt')
    if os.path.exists(cache_path):
        try:
            raw = open(cache_path, 'r', encoding='utf-8').read().strip().split(',')
            cam = int(raw[0])
            w = int(raw[1]) if len(raw) > 1 and raw[1] else args.width
            h = int(raw[2]) if len(raw) > 2 and raw[2] else args.height
            test = open_camera(cam, w, h)
            ok, frame = test.read()
            test.release()
            if ok and frame is not None:
                width = args.width or w or int(frame.shape[1])
                height = args.height or h or int(frame.shape[0])
                print(f"AUTO_SELECTED cached camera={cam} resolution={width}x{height}", file=sys.stderr)
                return cam, width, height
        except Exception:
            pass

    best, _all_results, _ = detect_best_camera(max_index=args.max_index, warmup=args.warmup)
    if not best:
        print("ERROR: auto-detect failed to find any working camera", file=sys.stderr)
        return None, None, None

    width = args.width or best['width']
    height = args.height or best['height']
    try:
        ensure_dir(DEFAULT_OUT_DIR)
        open(cache_path, 'w', encoding='utf-8').write(f"{best['index']},{width},{height}")
    except Exception:
        pass
    print(f"AUTO_SELECTED camera={best['index']} resolution={best['width']}x{best['height']}", file=sys.stderr)
    return best['index'], width, height


def capture_frame(args):
    out_dir = getattr(args, 'out_dir', DEFAULT_OUT_DIR)
    ensure_dir(out_dir)
    out_path = args.output or os.path.join(out_dir, timestamp_name("snapshot", "jpg"))
    camera, width, height = resolve_camera(args)
    if camera is None:
        return 1, None

    cap = open_camera(camera, width, height)
    if not cap.isOpened():
        print(f"ERROR: could not open camera index {camera}", file=sys.stderr)
        return 1, None

    ok = False
    frame = None
    for _ in range(max(args.warmup, 1)):
        ok, frame = cap.read()
    cap.release()

    if not ok or frame is None:
        print("ERROR: failed to capture frame", file=sys.stderr)
        return 1, None

    ensure_dir(os.path.dirname(out_path) or out_dir)
    if not cv2.imwrite(out_path, frame):
        print(f"ERROR: failed to write image to {out_path}", file=sys.stderr)
        return 1, None

    return 0, out_path


def snapshot(args):
    rc, out_path = capture_frame(args)
    if rc != 0:
        return rc
    print(out_path)
    return 0


def send_to_me(args):
    rc, out_path = capture_frame(args)
    if rc != 0:
        return rc

    if not os.path.exists(CHATGTP_HOOK):
        print(f"ERROR: chatgtp_hook not found at {CHATGTP_HOOK}", file=sys.stderr)
        return 1

    prompt = args.prompt or "Please analyze this image and describe the visible contents."
    quoted = lambda s: '"' + str(s).replace('"', '\\"') + '"'
    cmd = f'python {quoted(CHATGTP_HOOK)} vision {quoted(out_path)} {quoted(prompt)}'
    print(f"CAPTURED {out_path}")
    print("SENDING_TO_CHATGPT_VISION")
    from trio_hook_lifecycle import runHookCommand
    result = runHookCommand(cmd, phaseName="webcam-vision", shell=True)
    rc2 = result.returncode
    return 0 if rc2 == 0 else 1


def record(args):
    ensure_dir(args.out_dir)
    out_path = args.output or os.path.join(args.out_dir, timestamp_name("recording", "mp4"))
    camera, width, height = resolve_camera(args)
    if camera is None:
        return 1

    cap = open_camera(camera, width, height)
    if not cap.isOpened():
        print(f"ERROR: could not open camera index {camera}", file=sys.stderr)
        return 1

    fps = float(args.fps)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or int(width or args.width or 640)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or int(height or args.height or 480)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))

    if not writer.isOpened():
        cap.release()
        print(f"ERROR: could not open video writer for {out_path}", file=sys.stderr)
        return 1

    frames = int(args.seconds * fps)
    captured = 0
    while captured < frames:
        ok, frame = cap.read()
        if not ok:
            break
        if frame.shape[1] != width or frame.shape[0] != height:
            frame = cv2.resize(frame, (width, height))
        writer.write(frame)
        captured += 1

    cap.release()
    writer.release()

    if captured == 0:
        print("ERROR: no frames captured", file=sys.stderr)
        return 1

    print(out_path)
    return 0


def preview(args):
    camera, width, height = resolve_camera(args)
    if camera is None:
        return 1

    cap = open_camera(camera, width, height)
    if not cap.isOpened():
        print(f"ERROR: could not open camera index {camera}", file=sys.stderr)
        return 1

    print("Preview started. Press Q to quit.")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        cv2.imshow("webcam_hook preview", frame)
        if cv2.waitKey(1) & 0xFF in (ord('q'), ord('Q')):
            break

    cap.release()
    cv2.destroyAllWindows()
    print("Preview stopped.")
    return 0


def list_cameras(args):
    found = []
    for idx in range(args.max_index + 1):
        best, _ = probe_camera_resolution(idx, warmup=args.warmup)
        if best:
            found.append(best)
    if found:
        for item in found:
            print(f"{item['index']} {item['width']}x{item['height']}")
    else:
        print("none")
    return 0


def auto_detect(args):
    best, results, errors = detect_best_camera(max_index=args.max_index, warmup=args.warmup)
    if not results:
        print("ERROR: no working cameras found", file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        return 1

    for item in results:
        marker = "*" if best and item['index'] == best['index'] else " "
        print(f"{marker} camera={item['index']} best={item['width']}x{item['height']} pixels={item['pixels']}")
    return 0


def build_parser():
    p = argparse.ArgumentParser(description="Webcam hook for local camera preview, snapshots, recordings, auto-detection, and ChatGPT file send.")
    sub = p.add_subparsers(dest="action", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--camera", type=int, default=0, help="Camera index (default: 0)")
    common.add_argument("--width", type=int, default=None, help="Requested capture width")
    common.add_argument("--height", type=int, default=None, help="Requested capture height")
    common.add_argument("--auto", action="store_true", help="Auto-detect best camera by highest working resolution")
    common.add_argument("--max-index", type=int, default=2, help="Highest camera index to probe during auto-detect")
    common.add_argument("--warmup", type=int, default=3, help="Frames to discard before capture/probe")

    p_snap = sub.add_parser("snapshot", parents=[common], help="Take a single webcam snapshot")
    p_snap.add_argument("--output", default=None, help="Output image path (.jpg)")
    p_snap.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="Directory for generated images")
    p_snap.set_defaults(func=snapshot)

    p_send = sub.add_parser("send_to_me", parents=[common], help="Capture a still image and send it to ChatGPT")
    p_send.add_argument("--output", default=None, help="Output image path (.jpg)")
    p_send.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="Directory for generated images")
    p_send.add_argument("--prompt", default=None, help="Prompt to send with the captured image")
    p_send.set_defaults(func=send_to_me)

    p_record = sub.add_parser("record", parents=[common], help="Record webcam video")
    p_record.add_argument("--output", default=None, help="Output video path (.mp4)")
    p_record.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="Directory for generated videos")
    p_record.add_argument("--seconds", type=int, default=5, help="Duration in seconds")
    p_record.add_argument("--fps", type=float, default=20, help="Frames per second")
    p_record.set_defaults(func=record)

    p_preview = sub.add_parser("preview", parents=[common], help="Open live webcam preview window")
    p_preview.set_defaults(func=preview)

    p_list = sub.add_parser("list", parents=[common], help="List available camera indexes and best detected resolutions")
    p_list.set_defaults(func=list_cameras)

    p_auto = sub.add_parser("auto_detect", help="Probe cameras and pick the one with the highest working resolution")
    p_auto.add_argument("--max-index", type=int, default=2, help="Highest camera index to probe")
    p_auto.add_argument("--warmup", type=int, default=3, help="Frames to discard before probe result")
    p_auto.set_defaults(func=auto_detect)

    return p


def main():
    ensure_dir(HOOK_DIR)
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
