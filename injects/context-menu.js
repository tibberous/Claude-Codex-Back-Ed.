(function(){
  var MENU_ID = '__cb_ctx_menu';
  var CTRL    = 'http://127.0.0.1:57837';

  function removeMenu() {
    var old = document.getElementById(MENU_ID);
    if (old) old.remove();
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:70px;right:20px;background:#111;color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;font-family:system-ui,sans-serif;z-index:2147483647;opacity:0;transition:opacity .2s;';
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.style.opacity = '1'; });
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 250); }, 2500);
  }

  function buildMenu(x, y, items) {
    removeMenu();
    var menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position:fixed','z-index:2147483647',
      'left:' + x + 'px','top:' + y + 'px',
      'background:#fff','border:1.5px solid #000',
      'border-radius:6px','box-shadow:0 4px 20px rgba(0,0,0,.3)',
      'font-size:12px','font-family:system-ui,sans-serif',
      'min-width:200px','overflow:hidden','user-select:none',
    ].join(';');

    items.forEach(function(item) {
      if (item === '-') {
        var hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:#eee;margin:3px 0;';
        menu.appendChild(hr);
        return;
      }
      var el = document.createElement('div');
      el.textContent = item.label;
      el.style.cssText = 'padding:8px 14px;cursor:pointer;color:#222;';
      if (item.shortcut) {
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        var sc = document.createElement('span');
        sc.textContent = item.shortcut;
        sc.style.cssText = 'color:#999;font-size:11px;margin-left:20px;';
        el.appendChild(sc);
      }
      el.addEventListener('mouseover', function(){ el.style.background = '#f0f0f0'; });
      el.addEventListener('mouseout',  function(){ el.style.background = ''; });
      el.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        removeMenu();
        item.action();
      });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);

    /* keep menu on screen */
    var r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 8) + 'px';

    setTimeout(function() {
      document.addEventListener('mousedown', function dismiss(e) {
        if (!menu.contains(e.target)) { removeMenu(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 0);
  }

  /* ── View Source modal (shared with code-view-source.js) ── */
  function openViewSource(code, lang) {
    if (typeof window.__cbShowSource === 'function') {
      window.__cbShowSource(code, lang); return;
    }
    /* fallback: copy to clipboard */
    navigator.clipboard.writeText(code).then(function(){ showToast('Source copied to clipboard'); });
  }

  /* ── Code block right-click ── */
  function attachToCodeBlocks() {
    document.querySelectorAll('pre, [class*="codeBlock"], [class*="CodeBlock"]').forEach(function(pre) {
      if (pre.__cbCtxAttached) return;
      pre.__cbCtxAttached = true;
      pre.addEventListener('contextmenu', function(e) {
        e.preventDefault(); e.stopPropagation();
        var codeEl = pre.querySelector('code') || pre;
        var lang   = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';
        var code   = codeEl.textContent;
        buildMenu(e.clientX, e.clientY, [
          { label: '📋 Copy Code', action: function(){ navigator.clipboard.writeText(code); showToast('Copied!'); } },
          { label: '🔍 View Source', action: function(){ openViewSource(code, lang); } },
          '-',
          { label: '🛠 Open DevTools', shortcut: 'F12', action: openDevTools },
        ]);
      });
    });
  }

  /* ── General page right-click (non-code areas) ── */
  function attachToPage() {
    if (document.__cbPageCtxAttached) return;
    document.__cbPageCtxAttached = true;
    document.addEventListener('contextmenu', function(e) {
      /* if on/inside a code block, let the code-block handler handle it */
      var pre = e.target.closest('pre, [class*="codeBlock"], [class*="CodeBlock"]');
      if (pre && pre.__cbCtxAttached) return;
      if (e.target.closest('#__cb_ctx_menu')) return;

      e.preventDefault();
      buildMenu(e.clientX, e.clientY, [
        { label: '📋 Copy Selection', action: function(){
            var sel = window.getSelection();
            if (sel && sel.toString()) navigator.clipboard.writeText(sel.toString()).then(function(){ showToast('Copied!'); });
        }},
        '-',
        { label: '🛠 Open DevTools', shortcut: 'F12', action: openDevTools },
        { label: '♻️  Reload WebView', action: function(){
            fetch(CTRL + '/command', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command:'workbench.action.webview.reloadWebviewAction'}) }).catch(function(){});
        }},
        { label: '📜 View Page Source', action: function(){
            var html = document.documentElement.outerHTML;
            openViewSource(html, 'html');
        }},
      ]);
    });
  }

  function openDevTools() {
    fetch(CTRL + '/command', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'workbench.action.webview.openDeveloperTools' })
    }).then(function(r){
      if (!r || !r.ok) throw new Error('bad status');
    }).catch(function(){
      /* fallback: try the general toggle (VSCode window devtools, not webview's) */
      fetch(CTRL + '/command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({command:'workbench.action.toggleDevTools'}) }).catch(function(){});
    });
  }

  attachToPage();
  attachToCodeBlocks();
  if (window.__cbCtxObs) window.__cbCtxObs.disconnect();
  window.__cbCtxObs = new MutationObserver(attachToCodeBlocks);
  window.__cbCtxObs.observe(document.body, { childList: true, subtree: true });
})();
