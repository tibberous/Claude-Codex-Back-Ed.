(function(){
  if (window.__cbHelpBtnLoaded) return;
  window.__cbHelpBtnLoaded = true;

  var BTN_ID      = '__cb_help_btn';
  var MODAL_ID    = '__cb_help_modal';
  var CTX_ID      = '__cb_help_ctx';
  var CTRL        = 'http://127.0.0.1:57837';

  function trace(m, isErr) {
    fetch('http://127.0.0.1:57836', { method:'POST', headers:{'Content-Type':'text/plain'}, body:'[help-btn] '+m }).catch(function(){});
    (isErr ? console.error : console.debug)('[help-btn] '+m);
  }

  var HELP_CSS = [
    '#'+MODAL_ID+'{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;font-family:Consolas,Menlo,Monaco,monospace;color:#fff;}',
    '#'+MODAL_ID+' .__cb_help_backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);}',
    '#'+MODAL_ID+' .__cb_help_box{position:relative;width:min(720px,92vw);max-height:86vh;overflow:auto;background:#1e1e20;border:1px solid #e8621a;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.8),0 0 0 1px rgba(232,98,26,.25);padding:24px 28px;}',
    '#'+MODAL_ID+' h1{margin:0 0 14px;font-size:18px;color:#e8621a;letter-spacing:.5px;text-transform:uppercase;}',
    '#'+MODAL_ID+' h2{margin:22px 0 8px;font-size:13px;color:#e8621a;letter-spacing:.5px;text-transform:uppercase;border-bottom:1px solid rgba(232,98,26,.35);padding-bottom:4px;}',
    '#'+MODAL_ID+' p{margin:8px 0;font-size:12.5px;line-height:1.55;color:#d8d8d8;}',
    '#'+MODAL_ID+' ul{margin:6px 0 6px 18px;padding:0;font-size:12.5px;color:#d8d8d8;}',
    '#'+MODAL_ID+' li{margin:3px 0;line-height:1.5;}',
    '#'+MODAL_ID+' table{border-collapse:collapse;margin:6px 0;font-size:12.5px;width:100%;}',
    '#'+MODAL_ID+' th,#'+MODAL_ID+' td{padding:5px 10px;border:1px solid #333;text-align:left;}',
    '#'+MODAL_ID+' th{background:#26262a;color:#e8621a;font-weight:600;}',
    '#'+MODAL_ID+' td{background:#141416;color:#d8d8d8;}',
    '#'+MODAL_ID+' kbd{background:#0e0e10;border:1px solid #444;border-bottom-width:2px;border-radius:3px;padding:1px 6px;font-family:inherit;font-size:11.5px;color:#fff;}',
    '#'+MODAL_ID+' a{color:#e8621a;text-decoration:none;}',
    '#'+MODAL_ID+' a:hover{text-decoration:underline;}',
    '#'+MODAL_ID+' .__cb_help_close{position:absolute;top:8px;right:10px;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:4px 9px;line-height:1;border-radius:4px;font-family:inherit;}',
    '#'+MODAL_ID+' .__cb_help_close:hover{background:#e8621a;color:#000;}',
    '#'+MODAL_ID+' .__cb_about{font-size:12px;color:#d8d8d8;background:#141416;border:1px solid #2a2a2e;border-radius:5px;padding:10px 14px;margin-top:8px;}',
    '#'+MODAL_ID+' .__cb_about div{margin:3px 0;}',
    '#'+MODAL_ID+' .__cb_about b{color:#e8621a;display:inline-block;min-width:70px;}',
    '#'+CTX_ID+'{position:fixed;z-index:999998;background:#1e1e20;border:1px solid #e8621a;border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,.7);padding:4px 0;font-family:Consolas,Menlo,Monaco,monospace;font-size:12.5px;color:#fff;min-width:140px;}',
    '#'+CTX_ID+' .__cb_ctx_item{padding:6px 18px;cursor:pointer;}',
    '#'+CTX_ID+' .__cb_ctx_item:hover{background:#e8621a;color:#000;}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('__cb_help_style')) return;
    var s = document.createElement('style');
    s.id = '__cb_help_style';
    s.textContent = HELP_CSS;
    document.head.appendChild(s);
  }

  function buildModalHtml(about) {
    var repo   = (about && about.repo)    || 'https://github.com/tibberous/Claude-Codex-Back-Ed';
    var author = (about && about.author)  || 'Trenton Tompkins';
    var email  = (about && about.email)   || '';
    var ver    = (about && about.version) || '1.0.0';
    return [
      '<div class="__cb_help_backdrop"></div>',
      '<div class="__cb_help_box" role="dialog" aria-modal="true">',
        '<button class="__cb_help_close" title="Close (Esc)">&times;</button>',
        '<h1>Codex Black Edition &mdash; Help</h1>',

        '<h2>How Codex Black Edition Works</h2>',
        '<p>CBE rides on top of Anthropic\'s Claude Code via a patcher (<code>patch-webview.js</code>) that bundles inject scripts into the existing webview. Every CBE feature renders <i>inside</i> Anthropic\'s chat panel &mdash; there is no separate CBE window.</p>',
        '<p>The orange "label-alpha" pill, the dark theme, microphone (Whisper/Gemini STT), screenshot button, monitor watchdog, and this help system are all driven by injects bundled at activation time and hot-reloaded within ~2s of save.</p>',
        '<p>A local control server on port <code>57837</code> bridges the webview to VSCode (clipboard, focus, terminal, status). All UI lives in the webview; all VSCode actions go through the server.</p>',

        '<h2>Keyboard Shortcuts</h2>',
        '<table>',
          '<tr><th>Shortcut</th><th>Action</th></tr>',
          '<tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd></td><td>Focus the Claude Code chat</td></tr>',
          '<tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd></td><td>Toggle voice recording</td></tr>',
          '<tr><td><kbd>/help</kbd></td><td>Open this menu</td></tr>',
        '</table>',

        '<h2>Features</h2>',
        '<ul>',
          '<li><b>Voice input</b> &mdash; ffmpeg captures audio, sent to OpenAI Whisper or Gemini for transcription, pasted into the chat.</li>',
          '<li><b>Screenshot send</b> &mdash; capture a region of the screen and paste it directly into the chat.</li>',
          '<li><b>Custom skins</b> &mdash; XML-driven theme system in <code>themes/</code>; switch via the command palette.</li>',
          '<li><b>Hot-reload injects</b> &mdash; save any file in <code>injects/</code> and it re-bundles + reloads within ~2 seconds, no VSCode reload.</li>',
          '<li><b>Auto wakeup</b> &mdash; watchdog relaunches VSCode if it crashes, and replays a wake-up prompt so the conversation resumes itself.</li>',
          '<li><b>Right-click menu</b> &mdash; custom contextmenu inside the chat with quick access to Help.</li>',
        '</ul>',

        '<h2>About</h2>',
        '<div class="__cb_about">',
          '<div><b>Repo</b> <a href="'+repo+'" target="_blank" rel="noopener" data-cb-extlink="'+repo+'">'+repo+'</a></div>',
          '<div><b>Author</b> '+author+'</div>',
          (email ? '<div><b>Email</b> '+email+'</div>' : ''),
          '<div><b>Version</b> '+ver+'</div>',
        '</div>',
      '</div>',
    ].join('');
  }

  function closeModal() {
    var m = document.getElementById(MODAL_ID);
    if (m) m.remove();
    window.__cbHelpOpen = false;
    document.removeEventListener('keydown', onEscKey, true);
  }

  function onEscKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); }
  }

  function openExternal(url) {
    fetch(CTRL + '/command', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command:'vscode.open', args:[url] })
    }).catch(function(){});
  }

  function showModal() {
    if (window.__cbHelpOpen) return;
    window.__cbHelpOpen = true;
    ensureStyle();

    var existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = buildModalHtml(null);
    document.body.appendChild(modal);

    function wire() {
      modal.querySelector('.__cb_help_backdrop').addEventListener('click', closeModal);
      modal.querySelector('.__cb_help_close').addEventListener('click', closeModal);
      modal.querySelectorAll('a[data-cb-extlink]').forEach(function(a){
        a.addEventListener('click', function(e){
          e.preventDefault();
          openExternal(a.getAttribute('data-cb-extlink'));
        });
      });
    }
    wire();
    document.addEventListener('keydown', onEscKey, true);

    fetch(CTRL + '/about')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!document.getElementById(MODAL_ID)) return;
        modal.innerHTML = buildModalHtml(d || null);
        wire();
      })
      .catch(function(e){ trace('about fetch failed: '+e, true); });
  }

  window.__cbShowHelp = showModal;

  function mountBtn(anchor) {
    if (document.getElementById(BTN_ID)) return;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Codex Black Ed. — Help';
    btn.style.cssText = 'position:relative;background:none!important;border:none!important;cursor:pointer;padding:3px 5px;line-height:1;opacity:.75;transition:opacity .15s,color .15s;display:inline-flex!important;align-items:center;margin:0;flex-shrink:0;color:#fff;';
    btn.innerHTML = '<span style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" style="display:block"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 14.5a6.5 6.5 0 110-13 6.5 6.5 0 010 13zm.95-5.4c.7-.4 1.55-.95 1.55-2.1 0-1.4-1.15-2.5-2.5-2.5S7.5 7.6 7.5 9h1.5c0-.55.45-1 1-1s1 .45 1 1c0 .45-.35.7-1 1.05-.6.35-1.25.85-1.25 1.95v.25h1.5v-.15c0-.5.35-.75.95-1.05zM9.25 13.5h1.5V15h-1.5z"/></svg></span>';
    btn.addEventListener('mouseover', function(){ btn.style.opacity = '1'; });
    btn.addEventListener('mouseout',  function(){ btn.style.opacity = '.75'; });
    btn.addEventListener('click', function(e){ e.preventDefault(); showModal(); });

    var mon = document.getElementById('__cb_monitor_btn');
    var mic = document.getElementById('__cb_stt_mic');
    var ra  = document.getElementById('__cb_readaloud_btn');
    var ref = mon || mic || ra;
    if (ref && ref.parentNode) {
      ref.parentNode.insertBefore(btn, ref.nextSibling);
    } else if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }

  function tryMount() {
    if (document.getElementById(BTN_ID)) return;
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
  if (window.__cbHelpBtnInterval) clearInterval(window.__cbHelpBtnInterval);
  window.__cbHelpBtnInterval = setInterval(tryMount, 1500);

  /* ── /help slash-command interceptor on the chat input ── */
  function inputEl() {
    return document.querySelector('[class*="messageInput"]') || document.querySelector('[contenteditable="true"]');
  }

  function inputText(el) {
    if (!el) return '';
    if (el.value != null) return String(el.value);
    return el.textContent || '';
  }

  function clearInput(el) {
    if (!el) return;
    if (el.value != null) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') ||
                   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      try { setter && setter.set.call(el, ''); } catch(e) { el.value = ''; }
      el.dispatchEvent(new Event('input', { bubbles:true }));
    } else {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles:true }));
    }
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    var el = e.target;
    if (!el) return;
    var inContainer = el.matches && (el.matches('[class*="messageInput"]') || el.matches('[contenteditable="true"]') || el.closest('[class*="messageInput"]'));
    if (!inContainer) return;
    var txt = inputText(el);
    if (txt.trim().toLowerCase() !== '/help') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    clearInput(el);
    showModal();
  }
  document.addEventListener('keydown', onKeyDown, true);

  /* ── Right-click custom context menu (scoped to chat surfaces) ── */
  function closeCtxMenu() {
    var m = document.getElementById(CTX_ID);
    if (m) m.remove();
    document.removeEventListener('mousedown', onDocMouseDown, true);
  }

  function onDocMouseDown(e) {
    var m = document.getElementById(CTX_ID);
    if (m && !m.contains(e.target)) closeCtxMenu();
  }

  function onContextMenu(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var inChat = t.closest('[class*="inputContainer"], [class*="messageList"], [class*="conversation"], [class*="messageInput"]');
    if (!inChat) return;
    e.preventDefault();
    ensureStyle();
    closeCtxMenu();
    var menu = document.createElement('div');
    menu.id = CTX_ID;
    menu.innerHTML = '<div class="__cb_ctx_item" data-act="help">Help</div>';
    document.body.appendChild(menu);
    var x = e.clientX, y = e.clientY;
    var r = menu.getBoundingClientRect();
    if (x + r.width  > window.innerWidth)  x = window.innerWidth  - r.width  - 6;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 6;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.querySelector('[data-act="help"]').addEventListener('click', function(){
      closeCtxMenu();
      showModal();
    });
    setTimeout(function(){ document.addEventListener('mousedown', onDocMouseDown, true); }, 0);
  }
  document.addEventListener('contextmenu', onContextMenu, true);

  trace('loaded');
})();
