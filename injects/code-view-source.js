(function(){
  var MODAL_ID = '__cb_source_modal';
  var BASE     = 'http://127.0.0.1:57837';

  function ensurePrism(cb) {
    if (window.Prism) { cb(); return; }

    if (!document.getElementById('__cb_prism_css_vs')) {
      var link = document.createElement('link');
      link.id  = '__cb_prism_css_vs';
      link.rel = 'stylesheet';
      link.href = BASE + '/lib/prism-dark.min.css';
      document.head.appendChild(link);
    }

    // line-numbers plugin CSS
    if (!document.getElementById('__cb_prism_ln_css')) {
      var lnLink = document.createElement('link');
      lnLink.id  = '__cb_prism_ln_css';
      lnLink.rel = 'stylesheet';
      lnLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.css';
      document.head.appendChild(lnLink);
    }

    var s = document.createElement('script');
    s.src = BASE + '/lib/prism.min.js';
    s.onload = function() {
      var s2 = document.createElement('script');
      s2.src = BASE + '/lib/prism-langs.min.js';
      s2.onload = function() {
        // load line-numbers plugin after langs
        var s3 = document.createElement('script');
        s3.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.js';
        s3.onload = s3.onerror = cb;
        document.head.appendChild(s3);
      };
      s2.onerror = cb;
      document.head.appendChild(s2);
    };
    s.onerror = cb;
    document.head.appendChild(s);
  }

  function removeModal() {
    var old = document.getElementById(MODAL_ID);
    if (old) old.remove();
  }

  window.__cbShowSource = showSourceModal;

  function showSourceModal(code, lang) {
    removeModal();
    ensurePrism(function() {
      var overlay = document.createElement('div');
      overlay.id = MODAL_ID;
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;';

      var box = document.createElement('div');
      box.style.cssText = 'background:#1e1e1e;border:2px solid #e8621a;border-radius:8px;width:80vw;max-width:900px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.6);overflow:hidden;';

      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:2px solid #e8621a;background:linear-gradient(90deg,#b83c00,#e8621a);flex-shrink:0;';

      var title = document.createElement('span');
      title.textContent = 'View Source' + (lang ? ' — ' + lang : '');
      title.style.cssText = 'font-family:system-ui,sans-serif;font-size:12px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4);';

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;align-items:center;gap:8px;';

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy';
      copyBtn.style.cssText = 'background:#e8621a;border:none;color:#fff;cursor:pointer;font-size:11px;padding:4px 10px;border-radius:4px;font-family:system-ui,sans-serif;font-weight:700;';
      copyBtn.addEventListener('click', function(){
        navigator.clipboard.writeText(code).then(function(){
          copyBtn.textContent = 'Copied!';
          setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500);
        });
      });

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:14px;padding:2px 6px;font-family:system-ui,sans-serif;opacity:0.85;';
      closeBtn.addEventListener('click', removeModal);

      hdr.appendChild(title);
      actions.appendChild(copyBtn);
      actions.appendChild(closeBtn);
      hdr.appendChild(actions);

      var scroller = document.createElement('div');
      scroller.style.cssText = 'overflow:auto;flex:1;';

      var pre = document.createElement('pre');
      pre.className = 'line-numbers';
      pre.style.cssText = 'margin:0;padding:16px;background:#1e1e1e;font-size:13px;line-height:1.5;font-family:monospace;';

      var codeEl = document.createElement('code');
      // default to markup for raw HTML, fallback to plaintext
      var prismLang = lang || 'markup';
      codeEl.className = 'language-' + prismLang;
      codeEl.textContent = code;
      pre.appendChild(codeEl);
      scroller.appendChild(pre);

      box.appendChild(hdr);
      box.appendChild(scroller);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      if (window.Prism) Prism.highlightElement(codeEl);

      overlay.addEventListener('mousedown', function(e){ if (e.target === overlay) removeModal(); });
      document.addEventListener('keydown', function esc(e){
        if (e.key === 'Escape') { removeModal(); document.removeEventListener('keydown', esc); }
      });
    });
  }

  /* ── right-click menu on code blocks ── */
  var CMENU_ID = '__cb_code_cmenu';

  function removeCtxMenu() {
    var old = document.getElementById(CMENU_ID);
    if (old) old.remove();
  }

  function showCtxMenu(x, y, code, lang) {
    removeCtxMenu();
    var menu = document.createElement('div');
    menu.id = CMENU_ID;
    menu.style.cssText = [
      'position:fixed','z-index:2147483647',
      'left:' + x + 'px','top:' + y + 'px',
      'background:#1e1e1e','border:1.5px solid #444',
      'border-radius:6px','box-shadow:0 4px 20px rgba(0,0,0,.5)',
      'font-size:13px','font-family:system-ui,sans-serif',
      'min-width:190px','overflow:hidden','user-select:none',
    ].join(';');

    var items = [
      { label: '🔍  View Source', action: function(){ showSourceModal(code, lang); } },
      { label: '📋  Copy Code',   action: function(){ navigator.clipboard.writeText(code); } },
      { label: '🛠️  DevTools',    action: function(){
          try {
            // Works in Electron/VSCode webview
            require('electron').remote.getCurrentWebContents().openDevTools({ mode: 'detach' });
          } catch(e) {
            // Fallback: VS Code command via CBE server
            fetch('http://127.0.0.1:57835/command', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({command:'workbench.action.webview.openDeveloperTools'})
            }).catch(function(){});
          }
        }
      },
    ];

    items.forEach(function(item, i) {
      var el = document.createElement('div');
      el.textContent = item.label;
      el.style.cssText = 'padding:9px 14px;cursor:pointer;color:#ddd;' + (i < items.length-1 ? 'border-bottom:1px solid #333;' : '');
      el.addEventListener('mouseover', function(){ el.style.background = '#2a2a2a'; });
      el.addEventListener('mouseout',  function(){ el.style.background = ''; });
      el.addEventListener('mousedown', function(e){
        e.preventDefault(); e.stopPropagation();
        removeCtxMenu();
        item.action();
      });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);

    /* keep menu on screen */
    var r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';

    setTimeout(function(){
      document.addEventListener('mousedown', function dismiss(e){
        if (!menu.contains(e.target)) { removeCtxMenu(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 0);
  }

  /* ── attach to code blocks ── */
  function attachToCodeBlocks() {
    document.querySelectorAll('pre code, [class*="codeBlock"] code, [class*="CodeBlock"] code').forEach(function(codeEl) {
      var pre = codeEl.closest('pre') || codeEl.parentElement;
      if (pre.__cbViewSourceAttached) return;
      pre.__cbViewSourceAttached = true;
      pre.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        var lang = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';
        showCtxMenu(e.clientX, e.clientY, codeEl.textContent, lang);
      });
    });
  }

  attachToCodeBlocks();
  if (window.__cbViewSourceObs) window.__cbViewSourceObs.disconnect();
  window.__cbViewSourceObs = new MutationObserver(attachToCodeBlocks);
  window.__cbViewSourceObs.observe(document.body, { childList: true, subtree: true });
})();
