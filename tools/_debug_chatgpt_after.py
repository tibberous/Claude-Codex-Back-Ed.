import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from start import getMiniComputer

m = getMiniComputer('chatgpt')
print("url:", m.final_url())

js = """(function(){
    var out = {};
    out.assistant_msgs = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    out.user_msgs = document.querySelectorAll('[data-message-author-role="user"]').length;
    var composer = document.querySelector('#prompt-textarea');
    out.composer_text = composer ? (composer.innerText || composer.textContent || '').slice(0, 200) : 'MISSING';
    var img_previews = document.querySelectorAll('[data-testid="file-upload-preview"], div[role="img"]');
    out.img_previews = img_previews.length;
    var btns = document.querySelectorAll('button[aria-label]');
    out.relevant_btns = Array.from(btns)
        .filter(b => {
            var l = (b.getAttribute('aria-label') || '').toLowerCase();
            return l.includes('send') || l.includes('submit') || l.includes('voice') || l.includes('stop');
        })
        .map(b => ({label: b.getAttribute('aria-label'), disabled: b.disabled, testid: b.getAttribute('data-testid')}));
    return JSON.stringify(out, null, 2);
})()"""
print(m.eval_js(js))
