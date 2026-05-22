"""One-shot diagnostic: inspect chatgpt.com DOM state for the file input + composer."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from start import getMiniComputer

m = getMiniComputer('chatgpt')
print("url:", m.final_url())
print("title:", m.page_title())

js_check = """(function(){
    var out = {};
    var inputs = document.querySelectorAll('input[type=\"file\"]');
    out.file_inputs = inputs.length;
    if (inputs.length) {
        out.first_file_input = {
            id: inputs[0].id,
            cls: (inputs[0].className||'').toString().slice(0,80),
            visible: inputs[0].offsetParent !== null,
        };
    }
    var composer = document.querySelector('#prompt-textarea');
    out.composer = composer ? 'FOUND' : 'MISSING';
    var sendBtn = document.querySelector('button[data-testid=\"send-button\"], button[aria-label=\"Send prompt\"]');
    out.send_button = sendBtn ? 'FOUND' : 'MISSING';
    var msgs = document.querySelectorAll('[data-message-author-role=\"assistant\"]');
    out.assistant_msgs = msgs.length;
    return JSON.stringify(out);
})()"""
print("DOM check:", m.eval_js(js_check))
