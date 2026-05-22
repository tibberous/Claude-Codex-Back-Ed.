"""Manual debug of chatgpt fast-path — bypasses the bridge_runner."""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from start import getMiniComputer

m = getMiniComputer('chatgpt')
print('url:', m.final_url())
print('title:', m.page_title())

before = int(m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
print('before count:', before)

m.eval_js("document.querySelector('#prompt-textarea').focus();")
time.sleep(0.3)
m.type_text('Reply with one word: pong')
time.sleep(0.5)

btn = m.eval_js("(function(){var b=document.querySelector('button[data-testid=\"send-button\"]');return b ? JSON.stringify({disabled: b.disabled, aria: b.getAttribute('aria-label'), text: (b.innerText||'').slice(0,30)}) : 'NO_BUTTON';})()")
print('btn:', btn)

clicked = m.eval_js("(function(){var b=document.querySelector('button[data-testid=\"send-button\"]');if(b){b.click();return 'clicked';}return 'no_btn';})()")
print('click result:', clicked)

time.sleep(2)
u_after = m.eval_js("document.querySelectorAll('[data-message-author-role=\"user\"]').length")
a_after = m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length")
print(f'user msgs after click: {u_after}')
print(f'assistant msgs after click: {a_after}')

# Wait for assistant reply
print('polling for reply (up to 60s)...')
deadline = time.time() + 60
last = ''
while time.time() < deadline:
    cnt = int(m.eval_js("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length") or 0)
    if cnt > before:
        txt = m.eval_js("""(function(){var els=document.querySelectorAll('[data-message-author-role=\"assistant\"]');if(!els.length)return '';var l=els[els.length-1];return (l.innerText||l.textContent||'').trim().slice(0,200);})()""")
        if txt and txt != last:
            print(f'  [{int(time.time())}] {txt!r}')
            last = txt
    time.sleep(2)
print(f'final reply: {last!r}')
