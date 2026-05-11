(function () {
  var MIC_ID   = '__cb_stt_mic';
  var MENU_ID  = '__cb_stt_menu';
  var CTRL     = 'http://127.0.0.1:57837';
  var LS_KEY   = '__cb_stt_provider';

  /* ── provider state (localStorage for persistence without server) ── */
  function getProvider() { return localStorage.getItem(LS_KEY) || 'openai'; }
  function setProvider(p) {
    localStorage.setItem(LS_KEY, p);
    updateMicTitle();
    /* also tell the server if it's running */
    try {
      fetch(CTRL + '/speech/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: p })
      }).catch(function(){});
    } catch(e) {}
  }

  function updateMicTitle() {
    var mic = document.getElementById(MIC_ID);
    if (mic) mic.title = 'STT (' + getProvider() + ')  |  right-click = switch provider';
  }

  /* ── context menu ── */
  function removeMenu() {
    var old = document.getElementById(MENU_ID);
    if (old) old.remove();
  }

  var PROVIDERS = [
    { id: 'openai', label: 'OpenAI Whisper' },
    { id: 'gemini', label: 'Google Gemini' },
  ];

  function showMenu(x, y) {
    removeMenu();
    var menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position:fixed', 'z-index:2147483647',
      'left:' + x + 'px', 'top:' + y + 'px',
      'background:#fff', 'border:1.5px solid #000',
      'border-radius:6px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'font-size:12px', 'font-family:system-ui,sans-serif',
      'min-width:170px', 'overflow:hidden', 'user-select:none',
    ].join(';');

    var header = document.createElement('div');
    header.textContent = 'STT Provider';
    header.style.cssText = 'padding:6px 12px;font-weight:700;font-size:11px;color:#555;border-bottom:1px solid #eee;background:#fafafa;';
    menu.appendChild(header);

    var cur = getProvider();
    PROVIDERS.forEach(function(p) {
      var item = document.createElement('div');
      item.textContent = (p.id === cur ? '✓ ' : '   ') + p.label;
      item.style.cssText = [
        'padding:8px 12px', 'cursor:pointer',
        'color:' + (p.id === cur ? '#000' : '#333'),
        'font-weight:' + (p.id === cur ? '700' : '400'),
      ].join(';');
      item.addEventListener('mouseover', function(){ item.style.background = '#f0f0f0'; });
      item.addEventListener('mouseout',  function(){ item.style.background = ''; });
      item.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        removeMenu();
        if (p.id === cur) return;
        setProvider(p.id);
        showToast('STT: ' + p.label);
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    /* flip upward/leftward if it goes off screen */
    var mr = menu.getBoundingClientRect();
    if (mr.bottom > window.innerHeight - 8) menu.style.top  = Math.max(8, y - mr.height) + 'px';
    if (mr.right  > window.innerWidth  - 8) menu.style.left = Math.max(8, x - mr.width)  + 'px';

    setTimeout(function() {
      document.addEventListener('mousedown', function dismiss(e) {
        if (!menu.contains(e.target)) { removeMenu(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 0);
  }

  /* ── toast ── */
  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'bottom:70px', 'right:20px',
      'background:#111', 'color:#fff',
      'padding:7px 14px', 'border-radius:6px',
      'font-size:12px', 'font-family:system-ui,sans-serif',
      'z-index:2147483647', 'opacity:0', 'transition:opacity .2s',
    ].join(';');
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.style.opacity = '1'; });
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 250); }, 2000);
  }

  /* ── mic button ── */
  var recActive = false;

  function mountMicBtn(anchor) {
    if (document.getElementById(MIC_ID)) { updateMicTitle(); return; }

    var btn = document.createElement('button');
    btn.id    = MIC_ID;
    btn.type  = 'button';
    btn.style.cssText = [
      'position:relative', 'background:none!important', 'border:none!important',
      'cursor:pointer', 'padding:3px 5px', 'line-height:1',
      'opacity:.75', 'transition:opacity .15s',
      'display:inline-flex!important', 'align-items:center',
      'margin:0', 'flex-shrink:0',
    ].join(';');
    btn.innerHTML = '<span style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" style="display:block"><path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zM5.5 9.5a.75.75 0 00-1.5 0 6 6 0 0011.75 1.75.75.75 0 10-1.46-.33A4.5 4.5 0 016 10a4.5 4.5 0 01-.5-.5zM10 16.5a.75.75 0 01-.75-.75v-1.54a6.002 6.002 0 01-4.9-5.46.75.75 0 111.5-.1A4.5 4.5 0 0010 13.5a4.5 4.5 0 004.15-2.85.75.75 0 111.5.1 6.002 6.002 0 01-4.9 5.46v1.54A.75.75 0 0110 16.5z"/></svg></span>';
    updateMicTitle();

    btn.addEventListener('mouseover', function(){ btn.style.opacity = '1'; });
    btn.addEventListener('mouseout',  function(){ if (!recActive) btn.style.opacity = '.75'; });

    btn.addEventListener('contextmenu', function(e) {
      e.preventDefault(); e.stopPropagation();
      showMenu(e.clientX, e.clientY);
    });

    btn.addEventListener('click', function(e) {
      if (e.detail >= 2) return;
      /* toggle recording via CBE server */
      fetch(CTRL + '/speech/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          recActive = d.action === 'start';
          btn.style.opacity = recActive ? '1' : '.75';
          btn.style.color   = recActive ? 'red' : '';
          showToast(recActive ? '🔴 Recording...' : '⏹ Stopped');
        })
        .catch(function(){ showToast('CBE server not running'); });
    });

    /* insert after read-aloud button if present, else after anchor */
    var ra = document.getElementById('__cb_readaloud_btn');
    if (ra && ra.parentNode) {
      ra.parentNode.insertBefore(btn, ra.nextSibling);
    } else {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }

  /* ── find toolbar anchor ── */
  function tryMount() {
    var anchor = null;
    document.querySelectorAll('button').forEach(function(b) {
      if (!anchor && b.title && b.title.toLowerCase().includes('compact')) anchor = b;
    });
    if (!anchor) {
      document.querySelectorAll('button').forEach(function(b) {
        if (!anchor && b.title && b.title.toLowerCase().includes('command menu')) anchor = b;
      });
    }
    if (anchor) mountMicBtn(anchor);
  }

  tryMount();
  if (window.__cbSttMenuInterval) clearInterval(window.__cbSttMenuInterval);
  window.__cbSttMenuInterval = setInterval(tryMount, 1500);
})();
