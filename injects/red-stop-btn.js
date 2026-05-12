/* red-stop-btn.js — SUPER STOP for Claude Code.
   State machine: IDLE -> STOPPING -> VERIFYING -> ESCALATING -> RECOVERING -> IDLE
   Each state has a max duration. Verification reads the DOM (Stop-button presence),
   not text strings. Subprocess kill + ESC happen at STOPPING, not RECOVERING. */
(function () {
  var BTN_ID  = '__cb_red_stop_btn';
  var CTRL    = 'http://127.0.0.1:57837';
  var LOG_URL = 'http://127.0.0.1:57836';

  /* Budget per state (ms). Tune here if needed. */
  var POLL_INTERVAL    = 100;
  var STOPPING_MAX     = 1500;
  var ESCALATING_MAX   = 2500;
  var RECOVERING_MAX   = 2000;
  var DONE_LINGER      = 1000;

  /* Visual states. Each maps to a background color and a label. */
  var VISUAL = {
    IDLE:        { bg: '#e53e3e', fg: '#fff', label: 'Stop'      },
    STOPPING:    { bg: '#d69e2e', fg: '#fff', label: 'stopping…' },
    VERIFYING:   { bg: '#d69e2e', fg: '#fff', label: 'verify…'   },
    ESCALATING:  { bg: '#dd6b20', fg: '#fff', label: 'force DC'  },
    RECOVERING:  { bg: '#4a5568', fg: '#fff', label: 'new chat'  },
    DONE:        { bg: '#38a169', fg: '#fff', label: 'stopped'   },
    ERROR:       { bg: '#9b2c2c', fg: '#fff', label: 'err'       },
  };

  /* Module-level state. */
  var state = 'IDLE';
  var startedAt = 0;
  var pollHandle = null;
  var inFlight = false;       /* reentrance guard */
  var blockedSubmit = null;   /* event listener to swallow Enter during stop */

  /* ── Logging ─────────────────────────────────────────────────────────── */
  function log(m) {
    try { fetch(LOG_URL, { method: 'POST', mode: 'no-cors', body: '[red-stop] ' + String(m) }); } catch (e) {}
    try { console.error('[red-stop]', m); } catch (e) {}
  }

  /* ── DOM helpers ─────────────────────────────────────────────────────── */

  /* Is Claude Code currently generating? Check by Stop-button presence.
     Anthropic shows a button labeled "Stop" while a response is streaming. */
  function isGenerating() {
    if (document.querySelector('button[aria-label*="Stop" i]'))   return true;
    if (document.querySelector('[data-testid="stop-button"]'))    return true;
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || '').trim().toLowerCase();
      if (t === 'stop') return true;
    }
    return false;
  }

  /* Find Anthropic's submit/stop button so we mount next to it. */
  function findAnchor() {
    return document.querySelector('button[type="submit"][data-permission-mode]')
        || document.querySelector('button[type="submit"]');
  }

  /* ── State management ────────────────────────────────────────────────── */

  function setState(next) {
    state = next;
    startedAt = Date.now();
    paint();
    log('state -> ' + next);
  }

  function paint() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var v = VISUAL[state] || VISUAL.IDLE;
    btn.style.setProperty('background-color', v.bg, 'important');
    btn.style.setProperty('color', v.fg, 'important');
    btn.dataset.cbState = state;
    var lbl = btn.querySelector('.cb-rs-label');
    if (lbl) lbl.textContent = v.label;
  }

  function clearPoll() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }

  /* Swallow Enter while a stop is in flight so the user doesn't fire a new
     request mid-shutdown. Restored when state returns to IDLE. */
  function installSubmitBlocker() {
    if (blockedSubmit) return;
    blockedSubmit = function (e) {
      if (state === 'IDLE') return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        log('blocked Enter during ' + state);
      }
    };
    document.addEventListener('keydown', blockedSubmit, true);
  }
  function removeSubmitBlocker() {
    if (!blockedSubmit) return;
    document.removeEventListener('keydown', blockedSubmit, true);
    blockedSubmit = null;
  }

  /* ── Hook dispatch ───────────────────────────────────────────────────── */

  function callHook(phase) {
    return fetch(CTRL + '/hook/red-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: phase, ts: Date.now() })
    }).then(function (r) { return r.json(); })
      .then(function (d) { log('hook ' + phase + ' -> ' + JSON.stringify(d)); return d; })
      .catch(function (e) { log('hook ' + phase + ' err: ' + (e && e.message)); throw e; });
  }

  /* ── State machine transitions ───────────────────────────────────────── */

  function transitionFromStopping() {
    /* Active-poll for Stop button absence. Exit as soon as gone, escalate at budget. */
    setState('VERIFYING');
    pollHandle = setInterval(function () {
      if (!isGenerating()) {
        clearPoll();
        finishSuccess();
        return;
      }
      if (Date.now() - startedAt > STOPPING_MAX) {
        clearPoll();
        escalate();
      }
    }, POLL_INTERVAL);
  }

  function escalate() {
    setState('ESCALATING');
    callHook('escalate').finally(function () {
      /* Whether the hook reported success or not, we still want to verify
         the DOM caught up. Poll once more before recovering. */
      setState('VERIFYING');
      var t0 = Date.now();
      pollHandle = setInterval(function () {
        if (!isGenerating()) { clearPoll(); recover(); return; }
        if (Date.now() - t0 > ESCALATING_MAX) {
          clearPoll();
          /* Still generating after escalation — fall through to recover anyway;
             the new-chat call usually breaks the loop. */
          recover();
        }
      }, POLL_INTERVAL);
    });
  }

  function recover() {
    setState('RECOVERING');
    callHook('newchat').finally(function () {
      /* Give Anthropic ~RECOVERING_MAX to mount the new conversation editor.
         No DOM signal we can reliably wait on cross-version, so use the budget. */
      setTimeout(finishSuccess, RECOVERING_MAX);
    });
  }

  function finishSuccess() {
    setState('DONE');
    setTimeout(function () {
      setState('IDLE');
      removeSubmitBlocker();
      inFlight = false;
    }, DONE_LINGER);
  }

  function finishError(msg) {
    setState('ERROR');
    log('ERROR: ' + msg);
    setTimeout(function () {
      setState('IDLE');
      removeSubmitBlocker();
      inFlight = false;
    }, DONE_LINGER * 2);
  }

  /* ── Click entry ─────────────────────────────────────────────────────── */

  function onClick() {
    if (inFlight) { log('reentrance ignored (state=' + state + ')'); return; }
    inFlight = true;
    installSubmitBlocker();
    setState('STOPPING');
    callHook('begin').then(function () {
      transitionFromStopping();
    }).catch(function (e) {
      finishError('begin hook failed: ' + (e && e.message));
    });
  }

  /* ── Mount ───────────────────────────────────────────────────────────── */

  function createBtn() {
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'SUPER STOP — ESC + kill subprocess, escalate to DC + new chat if needed';
    btn.onclick = onClick;
    btn.style.cssText = [
      'border:none',
      'border-radius:4px',
      'cursor:pointer',
      'font-size:11px',
      'font-weight:700',
      'padding:4px 10px',
      'margin:0 4px',
      'line-height:1.4',
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'min-width:60px',
      'justify-content:center',
      'transition:background-color .15s, transform .08s',
    ].join(';');
    btn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="10" height="10" fill="currentColor" style="display:block">' +
      '<rect x="2" y="2" width="8" height="8" rx="1"/></svg>' +
      '<span class="cb-rs-label">Stop</span>';
    btn.addEventListener('mousedown', function () { btn.style.transform = 'scale(.95)'; });
    btn.addEventListener('mouseup',   function () { btn.style.transform = ''; });
    btn.addEventListener('mouseleave',function () { btn.style.transform = ''; });
    return btn;
  }

  function mount() {
    if (document.getElementById(BTN_ID)) return;
    var anchor = findAnchor();
    if (!anchor || !anchor.parentNode) return;
    var btn = createBtn();
    anchor.parentNode.insertBefore(btn, anchor);
    paint();
    log('mounted');
  }

  /* Initial + re-mount loop (React may reset the toolbar). */
  mount();
  if (window.__cbRedStopInterval) clearInterval(window.__cbRedStopInterval);
  window.__cbRedStopInterval = setInterval(function () {
    if (!document.getElementById(BTN_ID)) mount();
    else paint();   /* if React preserved the node but cleared inline styles, repaint */
  }, 1000);
})();
