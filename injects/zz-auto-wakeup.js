(function(){
  /* Stall-detector wake-up.
     Fires when:
       - We've SEEN a Stop button at least once this page (proves Claude worked once)
       - Stop button is gone (Claude is done responding)
       - Textarea is empty (user is not typing)
       - >90s have passed since Stop disappeared
       - Cooldown of 5 min since last fire has elapsed
     The server-side bootstrap wakeup in extension.js is a separate, one-shot mechanism
     for session start. This handles silent stalls mid-session. */

  var WAKEUP_MSG       = "Hey! Wake up! You're a code bot! Read C:\\Users\\moren\\.claude\\CLAUDE.md";
  var CTRL_LOG         = 'http://127.0.0.1:57836';
  var IDLE_THRESHOLD   = 90 * 1000;
  var COOLDOWN         = 5 * 60 * 1000;
  var POLL_MS          = 2000;
  var LS_LAST_FIRED    = '__cbStallLastFired';
  var LS_SEEN_STOP     = '__cbStallSeenStop';

  function trace(m) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', CTRL_LOG, true);
    xhr.setRequestHeader('Content-Type', 'text/plain');
    try { xhr.send('[cb-stall] ' + m); } catch(e){}
  }

  function hasStop() {
    return !!(document.querySelector('button[aria-label*="Stop" i]') ||
              document.querySelector('[data-testid="stop-button"]') ||
              Array.from(document.querySelectorAll('button')).some(function(b){
                var t = (b.textContent || '').trim().toLowerCase();
                return t === 'stop';
              }));
  }

  function getTA() {
    var ta = document.querySelector('textarea');
    if (!ta || ta.disabled || ta.readOnly) return null;
    return ta;
  }

  function taIsEmpty() {
    var ta = getTA();
    if (!ta) return false;
    var v = (ta.value || '').trim();
    if (v.length > 0) return false;
    var ce = document.querySelector('[contenteditable="true"]');
    if (ce && (ce.textContent || '').trim().length > 0) return false;
    return true;
  }

  if (window.__cbStallInterval) { clearInterval(window.__cbStallInterval); window.__cbStallInterval = null; }

  var doneAt = 0;
  var seenStopThisPage = sessionStorage.getItem(LS_SEEN_STOP) === '1';

  trace('stall detector loaded — seenStopThisPage=' + seenStopThisPage);

  window.__cbStallInterval = setInterval(function(){
    var stop = hasStop();

    if (stop) {
      if (!seenStopThisPage) {
        seenStopThisPage = true;
        sessionStorage.setItem(LS_SEEN_STOP, '1');
        trace('first Stop button observed — arming stall detector');
      }
      doneAt = 0;
      return;
    }

    if (!seenStopThisPage) return;

    if (doneAt === 0) {
      doneAt = Date.now();
      return;
    }

    if (!taIsEmpty()) { doneAt = 0; return; }

    var idle = Date.now() - doneAt;
    if (idle < IDLE_THRESHOLD) return;

    var lastFired = parseInt(localStorage.getItem(LS_LAST_FIRED) || '0', 10);
    if (Date.now() - lastFired < COOLDOWN) return;

    localStorage.setItem(LS_LAST_FIRED, Date.now().toString());
    doneAt = Date.now();
    trace('FIRING wakeup — idle=' + Math.round(idle/1000) + 's');

    var pasteFn = window.__cbPaste || window.__cvPaste;
    if (typeof pasteFn === 'function') {
      try { pasteFn(WAKEUP_MSG); trace('fired via paste fn'); return; } catch(e){ trace('paste fn threw: ' + e.message); }
    }
    var ta = getTA();
    if (!ta) { trace('no textarea — abort'); return; }
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, WAKEUP_MSG);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(function(){
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }, 80);
    trace('fired via fallback paste');
  }, POLL_MS);
})();
