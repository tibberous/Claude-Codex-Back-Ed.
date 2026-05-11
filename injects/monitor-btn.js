(function(){
  var BTN_ID     = '__cb_monitor_btn';
  var OVERLAY_ID = '__cb_monitor_overlay';
  var CTRL       = 'http://127.0.0.1:57837';
  var LS_KEY     = '__cb_monitor_active';

  var active = localStorage.getItem(LS_KEY) === '1';

  /* ── overlay (green spinning ring shown during relaunch) ── */
  function showOverlay(msg) {
    removeOverlay();
    var ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.style.cssText = [
      'position:fixed','inset:0','z-index:2147483647',
      'display:flex','flex-direction:column',
      'align-items:center','justify-content:center',
      'background:rgba(0,0,0,.55)',
      'backdrop-filter:blur(4px)',
    ].join(';');
    ov.innerHTML = [
      '<div style="width:64px;height:64px;border-radius:50%;',
        'border:4px solid rgba(34,197,94,.25);',
        'border-top-color:#22c55e;',
        'animation:__cbSpin .8s linear infinite;',
        'box-shadow:0 0 24px rgba(34,197,94,.5)">',
      '</div>',
      '<p style="margin-top:20px;color:#fff;font-family:system-ui,sans-serif;',
        'font-size:14px;font-weight:600;text-shadow:0 1px 4px rgba(0,0,0,.8)">',
        msg || 'Monitoring VS Code&hellip;',
      '</p>',
    ].join('');

    if (!document.getElementById('__cbSpinKf')) {
      var st = document.createElement('style');
      st.id = '__cbSpinKf';
      st.textContent = '@keyframes __cbSpin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(ov);
    return ov;
  }

  function removeOverlay() {
    var old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
  }

  function trace(m) {
    fetch('http://127.0.0.1:57836', { method: 'POST', headers: {'Content-Type':'text/plain'}, body: '[monitor-btn] ' + m }).catch(function(){});
    console.error('[monitor-btn] ' + m);
  }

  /* ── status fetch ── */
  function getStatus() {
    var btn = document.getElementById(BTN_ID);
    trace('getStatus called, btn=' + (btn ? 'found' : 'NOT FOUND'));
    fetch(CTRL + '/monitor/status')
      .then(function(r){ return r.json(); })
      .then(function(d){
        trace('status response: running=' + d.running + ' pid=' + d.pid);
        setActive(!!d.running);
        var b = document.getElementById(BTN_ID);
        trace('after setActive: btn color=' + (b ? b.style.color : 'NO BTN') + ' fill=' + (b ? b.style.fill : 'N/A'));
      })
      .catch(function(e){ trace('getStatus fetch error: ' + e); });
  }

  function setActive(val) {
    active = val;
    localStorage.setItem(LS_KEY, val ? '1' : '0');
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.title = val ? 'VS Code Monitor ON  |  double-click to stop' : 'VS Code Monitor OFF  |  double-click to start';
    btn.style.color   = val ? '#22c55e' : '#fff';
    btn.style.fill    = val ? '#22c55e' : '#fff';
    btn.style.opacity = val ? '1' : '.75';
    var svg = btn.querySelector('svg');
    if (svg) { svg.style.color = btn.style.color; svg.style.fill = btn.style.color; }
    var paths = btn.querySelectorAll('path');
    paths.forEach(function(p){ p.style.fill = btn.style.color; });
  }

  /* ── toggle via double-click ── */
  function toggle() {
    if (active) {
      fetch(CTRL + '/monitor/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
        .then(function(r){ return r.json(); })
        .then(function(d){ setActive(false); showToast('Monitor stopped'); })
        .catch(function(){ showToast('CBE server not running'); });
    } else {
      var ov = showOverlay('Starting VS Code Monitor…');
      fetch(CTRL + '/monitor/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          setTimeout(removeOverlay, 1200);
          setActive(!!d.running);
          showToast(d.running ? 'Monitor active ✓' : 'Failed to start monitor');
        })
        .catch(function(){
          removeOverlay();
          showToast('CBE server not running');
        });
    }
  }

  /* ── toast ── */
  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:70px;right:20px;background:#111;color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;font-family:system-ui,sans-serif;z-index:2147483647;opacity:0;transition:opacity .2s;';
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.style.opacity = '1'; });
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 250); }, 2500);
  }

  /* ── mount button ── */
  function mountBtn(anchor) {
    if (document.getElementById(BTN_ID)) { setActive(active); return; }
    var btn = document.createElement('button');
    btn.id   = BTN_ID;
    btn.type = 'button';
    btn.style.cssText = 'position:relative;background:none!important;border:none!important;cursor:pointer;padding:3px 5px;line-height:1;opacity:.75;transition:opacity .15s,color .15s;display:inline-flex!important;align-items:center;margin:0;flex-shrink:0;';
    /* shield icon */
    btn.innerHTML = '<span style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" style="display:block"><path fill-rule="evenodd" d="M9.661 2.237a.531.531 0 01.678 0 11.947 11.947 0 007.078 2.749.5.5 0 01.479.525c-.109 5.518-3.286 10.083-7.738 11.947a.516.516 0 01-.316 0C5.186 15.594 2.01 11.029 1.9 5.511a.5.5 0 01.48-.525 11.947 11.947 0 007.281-2.749zM10 6.5a.75.75 0 01.75.75v2.75a.75.75 0 01-1.5 0V7.25A.75.75 0 0110 6.5zm0 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg></span>';
    setActive(active);

    btn.addEventListener('mouseover', function(){ btn.style.opacity = '1'; });
    btn.addEventListener('mouseout',  function(){ if (!active) btn.style.opacity = '.75'; });
    btn.addEventListener('dblclick',  function(e){ e.preventDefault(); toggle(); });
    /* single click: show status toast only */
    btn.addEventListener('click', function(e){
      if (e.detail >= 2) return;
      showToast('Monitor: ' + (active ? 'ON — double-click to stop' : 'OFF — double-click to start'));
    });

    /* insert after mic button if present, else after read-aloud, else after anchor */
    var mic = document.getElementById('__cb_stt_mic');
    var ra  = document.getElementById('__cb_readaloud_btn');
    var ref = mic || ra;
    if (ref && ref.parentNode) {
      ref.parentNode.insertBefore(btn, ref.nextSibling);
    } else {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
    getStatus();
  }

  function tryMount() {
    var anchor = null;
    document.querySelectorAll('button').forEach(function(b){
      if (!anchor && b.title && b.title.toLowerCase().includes('compact')) anchor = b;
    });
    if (!anchor) document.querySelectorAll('button').forEach(function(b){
      if (!anchor && b.title && b.title.toLowerCase().includes('command menu')) anchor = b;
    });
    if (anchor) mountBtn(anchor);
  }

  tryMount();
  if (window.__cbMonitorBtnInterval) clearInterval(window.__cbMonitorBtnInterval);
  window.__cbMonitorBtnInterval = setInterval(tryMount, 1500);

  // Poll status every 5s to keep shield green/grey accurate
  if (window.__cbMonitorPollInterval) clearInterval(window.__cbMonitorPollInterval);
  window.__cbMonitorPollInterval = setInterval(function() {
    if (document.getElementById(BTN_ID)) getStatus();
  }, 5000);
  // Also fetch immediately in case mount already happened
  setTimeout(getStatus, 500);
})();
