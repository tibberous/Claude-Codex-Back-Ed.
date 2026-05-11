(function(){
  window.__cbPaste = function(txt, _retries){
    var retries = _retries || 0;
    var log = function(m){ console.error('[cb-paste]', m); };
    log('__cbPaste attempt=' + retries + ' txt=' + JSON.stringify(txt.slice(0,80)));

    var ta = document.querySelector('textarea');
    if (!ta) {
      log('no textarea, retry in 400ms');
      if (retries < 10) setTimeout(function(){ window.__cbPaste(txt, retries + 1); }, 400);
      return;
    }

    /* focus first — Enter keydown is ignored without focus */
    ta.focus();

    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(ta, txt);
    ta.dispatchEvent(new Event('input',  { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));

    log('value set — submitting via ctrl server /speech/submit');
    /* Route through extension's submitText() — bypasses DOM event issues entirely */
    fetch('http://127.0.0.1:57837/speech/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: txt })
    }).then(function(r){ return r.json(); })
      .then(function(d){ log('speech/submit result: ' + JSON.stringify(d)); })
      .catch(function(e){
        log('ctrl server unavailable (' + e + ') — falling back to Enter keydown');
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
        setTimeout(function(){
          if (ta.value && ta.value.trim().length > 0) {
            var btn = document.querySelector('button[type="submit"]') ||
                      document.querySelector('button[aria-label*="Send"]') ||
                      document.querySelector('button[data-permission-mode]');
            if (btn && !btn.disabled) { btn.click(); log('fallback: btn click'); }
          } else { log('fallback: textarea cleared OK'); }
        }, 400);
      });
  };
  console.error('[cb-paste] __cbPaste registered');
})();
