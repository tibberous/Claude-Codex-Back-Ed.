(function(){
  var MENU_ID = '__cb_ctx_menu';
  var CTRL    = 'http://127.0.0.1:57835'; /* companion server */

  function removeMenu() {
    var old = document.getElementById(MENU_ID);
    if (old) old.remove();
  }

  function showMenu(x, y, target) {
    removeMenu();

    var menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position:fixed','z-index:2147483647',
      'left:' + x + 'px','top:' + y + 'px',
      'background:#fff','border:1.5px solid #000',
      'border-radius:6px','box-shadow:0 4px 16px rgba(0,0,0,.28)',
      'font-size:12px','font-family:system-ui,sans-serif',
      'min-width:190px','overflow:hidden','user-select:none',
    ].join(';');

    var items = [];

    /* View Source — only on code blocks */
    var codeEl = target ? target.closest('pre code, [class*="codeBlock"] code, [class*="CodeBlock"] code') : null;
    if (codeEl) {
      var lang = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';
      items.push({ label: '📄 View Source' + (lang ? ' (' + lang + ')' : ''), action: function() {
        if (window.__cbShowSource) window.__cbShowSource(codeEl.textContent, lang);
        else alert('View Source not ready — CBE server may be down');
      }});
    }

    /* DevTools */
    items.push({ label: '🔧 Open DevTools', action: function() {
      fetch(CTRL + '/command', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ command: 'workbench.action.webview.openDeveloperTools' }) }).catch(function(){});
    }});

    /* Reload webview */
    items.push({ label: '🔄 Reload Webview', action: function() {
      fetch(CTRL + '/command', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ command: 'workbench.action.webview.reloadWebviewAction' }) }).catch(function(){});
    }});

    /* Separator + Copy */
    if (window.getSelection && window.getSelection().toString().trim()) {
      items.push({ sep: true });
      items.push({ label: '📋 Copy Selection', action: function() {
        navigator.clipboard.writeText(window.getSelection().toString());
      }});
    }

    if (items.length === 0) { removeMenu(); return; }

    items.forEach(function(item) {
      if (item.sep) {
        var hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:#eee;margin:2px 0;';
        menu.appendChild(hr);
        return;
      }
      var el = document.createElement('div');
      el.textContent = item.label;
      el.style.cssText = 'padding:8px 14px;cursor:pointer;color:#222;';
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

    /* reposition if off-screen */
    var r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';

    setTimeout(function() {
      document.addEventListener('mousedown', function dismiss(e) {
        if (!menu.contains(e.target)) { removeMenu(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 0);
  }

  document.addEventListener('contextmenu', function(e) {
    /* only intercept on code blocks or when DevTools item makes sense */
    var onCode = !!e.target.closest('pre, [class*="codeBlock"], [class*="CodeBlock"]');
    if (!onCode) return; /* let browser handle normal right-click elsewhere */
    e.preventDefault();
    showMenu(e.clientX, e.clientY, e.target);
  });

  /* expose showSource hook for code-view-source.js to register */
  window.__cbCtxMenu = { show: showMenu };
})();
