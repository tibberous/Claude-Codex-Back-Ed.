"""Test chatgpt-as-driver WITHOUT image upload — just text. Isolates
whether the file-upload is what's blocking the send, vs. something else."""
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from start import getMiniComputer

m = getMiniComputer('chatgpt')
print("url:", m.final_url())

# First, blow away any previous chat by navigating to /new
m.navigate('https://chatgpt.com/')
time.sleep(3)

# Inspect state
js = """(function(){
    var out = {};
    out.composer_text = (function(){
        var el = document.querySelector('#prompt-textarea');
        if(!el) return 'NO_COMPOSER';
        return (el.innerText || el.textContent || '').slice(0, 80);
    })();
    out.assistant_count = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    out.user_count = document.querySelectorAll('[data-message-author-role="user"]').length;
    return JSON.stringify(out);
})()"""
print("pre-state:", m.eval_js(js))

# Type a simple test message
before = int(m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
print("assistant_msgs BEFORE:", before)

m.eval_js("document.querySelector('#prompt-textarea').focus();")
time.sleep(0.3)
m.type_text("Reply with one word: hello")
time.sleep(0.5)

# Check composer state
print("composer after type:", m.eval_js("(function(){var c=document.querySelector('#prompt-textarea');return c ? (c.innerText||c.textContent||'').slice(0,200) : 'GONE';})()"))

# Check send button state
print("send button state:", m.eval_js("""(function(){
    var b = document.querySelector('button[data-testid=\"send-button\"], button[aria-label=\"Send prompt\"]');
    if (!b) return 'NO_BUTTON';
    return JSON.stringify({label: b.getAttribute('aria-label'), disabled: b.disabled, testid: b.getAttribute('data-testid')});
})()"""))

# Try Enter first
print("pressing Enter...")
m.press_key("enter")
time.sleep(2)

print("user_msgs after Enter:", m.eval_js("document.querySelectorAll('[data-message-author-role=\"user\"]').length"))

# Click send as backup
m.eval_js("""(function(){var b=document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]');if(b)b.click();})()""")
time.sleep(2)

print("user_msgs after click:", m.eval_js("document.querySelectorAll('[data-message-author-role=\"user\"]').length"))

# Wait up to 30s for assistant reply
deadline = time.time() + 30
while time.time() < deadline:
    after = int(m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
    if after > before:
        txt = m.eval_js("""(function(){var els=document.querySelectorAll('[data-message-author-role="assistant"]');if(!els.length)return'';var l=els[els.length-1];return (l.innerText||l.textContent||'').trim().slice(0,200);})()""")
        print(f"GOT REPLY: {txt!r}")
        break
    time.sleep(1)
else:
    print("TIMEOUT, no new assistant msg")
