"""Test chatgpt-as-driver WITH image upload to isolate why send fails."""
import sys
import time
import base64
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from start import getMiniComputer

m = getMiniComputer('chatgpt')
m.navigate('https://chatgpt.com/')
time.sleep(3)
print("url:", m.final_url())

# Make a tiny test PNG (red 200x100) to upload
from PIL import Image
test_png = Path("C:/Users/moren/Desktop/Claude Codex Black/logs/_test_upload.png")
test_png.parent.mkdir(exist_ok=True)
Image.new('RGB', (200, 100), (200, 50, 50)).save(test_png)
print(f"test image: {test_png} ({test_png.stat().st_size} bytes)")

# Find file input + upload
result = m._send("Runtime.evaluate", {
    "expression": "document.querySelector('input[type=\"file\"]')",
    "returnByValue": False,
})
object_id = ((result or {}).get("result", {}) or {}).get("objectId")
print("objectId:", object_id)
if object_id:
    try:
        m._send("DOM.setFileInputFiles", {"files": [str(test_png.resolve())], "objectId": object_id})
        print("setFileInputFiles OK via objectId")
    except Exception as e:
        print(f"objectId path failed: {e}")
        req = m._send("DOM.requestNode", {"objectId": object_id})
        node_id = (req or {}).get("nodeId")
        print(f"requestNode -> nodeId: {node_id}")
        if node_id:
            m._send("DOM.setFileInputFiles", {"files": [str(test_png.resolve())], "nodeId": node_id})
            print("setFileInputFiles OK via nodeId")

# Wait for upload to appear in UI
time.sleep(3)

# Check what chatgpt's UI shows now
print("UI after upload:")
print(m.eval_js("""(function(){
    var out = {};
    out.composer_text = (document.querySelector('#prompt-textarea')||{}).innerText || '';
    out.send_btn = (function(){var b=document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]');return b?{label:b.getAttribute('aria-label'),disabled:b.disabled,html:b.outerHTML.slice(0,200)}:'NO_BTN';})();
    out.previews = document.querySelectorAll('img[src^="blob:"], img[src^="data:"], [data-testid*="file"], div[role="img"]').length;
    out.thumb_elements = Array.from(document.querySelectorAll('[class*="image"], [class*="preview"], [class*="attach"]')).slice(0,5).map(el=>({tag:el.tagName, cls:(el.className||'').toString().slice(0,80)}));
    return JSON.stringify(out, null, 2);
})()"""))

# Now type a message + try to send
m.eval_js("document.querySelector('#prompt-textarea').focus();")
time.sleep(0.3)
m.type_text("What color is this image? One word.")
time.sleep(1)

print("\nsend button state after type:", m.eval_js("(function(){var b=document.querySelector('button[data-testid=\"send-button\"],button[aria-label=\"Send prompt\"]');return b?(b.disabled?'DISABLED':'ENABLED'):'NO_BTN';})()"))

# Click send via JS
clicked = m.eval_js("(function(){var b=document.querySelector('button[data-testid=\"send-button\"],button[aria-label=\"Send prompt\"]');if(!b)return 'NO_BTN';if(b.disabled)return 'DISABLED';b.click();return 'CLICKED';})()")
print("send click result:", clicked)
time.sleep(2)
print("user_msgs after click:", m.eval_js("document.querySelectorAll('[data-message-author-role=\"user\"]').length"))

# Wait for reply
deadline = time.time() + 30
while time.time() < deadline:
    n = int(m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
    if n > 0:
        txt = m.eval_js("""(function(){var els=document.querySelectorAll('[data-message-author-role="assistant"]');return els.length?(els[els.length-1].innerText||'').slice(0,200):'';})()""")
        print(f"REPLY: {txt!r}")
        break
    time.sleep(1)
else:
    print("TIMEOUT")
