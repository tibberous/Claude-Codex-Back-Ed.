"""End-to-end test of a video bridge through the plugin path.

Drives bing-video via drive_async_job. Polls every 10s up to 5 minutes.
On success, saves the mp4 to videos/bing-video/ and prints the path.
"""
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tools"))

from bridge_runner import discover_bridges
from start import getMiniComputer, _gptVisionPilotReadCredentials

bridges = discover_bridges(REPO / "bridges")
b = bridges.get("bing-video")
if not b:
    print("FAIL: bing-video plugin not loaded")
    sys.exit(1)

print(f"loaded: {b.manifest.name} v{b.manifest.version}")
print(f"caps: {[c for c, a in b.manifest.capabilities.items() if a.get('supported') == 'true']}")
print()

print("attaching to bing-video chrome (cdp port 9796)...")
mini = getMiniComputer("bing-video", offscreen=True, autostart=True)
if mini is None:
    print("FAIL: minicomputer unavailable for bing-video")
    sys.exit(2)

print(f"chrome attached. final_url: {mini.final_url()}")
print(f"title: {mini.page_title()}")
print()

creds = _gptVisionPilotReadCredentials("bing-video")
print(f"creds source: {creds.get('source')} ({creds.get('email')})")
print()

PROMPT = "A cat riding a skateboard down a hill in pixel art"
print(f"prompt: {PROMPT!r}")
print("submitting + polling for up to 5 minutes...")
t0 = time.time()
result = b.drive_async_job(
    mini, PROMPT,
    poll_interval_s=10.0,
    poll_max_s=300,
    output_root=REPO,
)
elapsed = time.time() - t0
print()
print(f"=== RESULT (elapsed: {elapsed:.0f}s) ===")
import json
print(json.dumps(result, indent=2))
