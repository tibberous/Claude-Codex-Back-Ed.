(function () {
  var LABEL_ID      = '__cb_black_edition_label';
  var READALOUD_ID  = '__cb_readaloud_btn';
  var AUTO_READ     = false;
  var lastReadText  = '';
  var autoObserver  = null;

  /* ── Input box drop shadow via fixed overlay (bypasses parent overflow clipping) ── */
  var _shadowEl = null;
  var _shadowRaf = null;
  function applyInputShadow() {
    if (_shadowEl) return;
    _shadowEl = document.createElement('div');
    _shadowEl.id = '__cb_input_shadow';
    _shadowEl.style.cssText = [
      'position:fixed','pointer-events:none','z-index:2147483646',
      'border-radius:10px',
      'box-shadow:0 4px 14px var(--cb-inputShadowDark,rgba(0,0,0,.22)), 0 1px 3px var(--cb-inputShadowLight,rgba(0,0,0,.12))',
      'transition:all .1s ease',
    ].join(';');
    document.body.appendChild(_shadowEl);

    function tick() {
      var inner = document.querySelector('[class*="inputContainer"],[class*="InputContainer"]');
      if (inner) {
        var r = inner.getBoundingClientRect();
        _shadowEl.style.left   = (r.left - 4) + 'px';
        _shadowEl.style.top    = (r.top  - 4) + 'px';
        _shadowEl.style.width  = (r.width  + 8) + 'px';
        _shadowEl.style.height = (r.height + 8) + 'px';
        _shadowEl.style.opacity = '1';
      } else {
        _shadowEl.style.opacity = '0';
      }
      _shadowRaf = requestAnimationFrame(tick);
    }
    tick();
  }

  /* ── CSS (uses skin CSS vars with hardcoded fallbacks) ── */
  function applyBlackBorders() {
    var id = '__cb_black_borders';
    var old = document.getElementById(id);
    if (old) old.remove();
    var s = document.createElement('style');
    s.id = id;
    s.textContent = [
      /* input container — orange border wraps input + toolbar as one frame (good.png parity) */
      '[class*="inputContainer"],[class*="InputContainer"]{' +
        'border:4px solid var(--cb-accentBorder,#ff6b1a)!important;' +
        'border-radius:8px!important;' +
        'box-shadow:none!important;overflow:hidden!important;}',

      /* footer / toolbar — orange gradient, matches inputContainer width (good.png) */
      '[class*="footer"],[class*="Footer"],[class*="inputFooter"],[class*="InputFooter"]{' +
        'background:var(--cb-footerBg,linear-gradient(90deg,#b83c00 0%,#e8621a 55%,#ff7a1a 100%))!important;' +
        'background-image:linear-gradient(90deg,#b83c00 0%,#e8621a 55%,#ff7a1a 100%)!important;' +
        'width:70%!important;max-width:70%!important;' +
        'margin-left:auto!important;margin-right:auto!important;' +
        'border-top:none!important;' +
        'backdrop-filter:none!important;' +
        '-webkit-backdrop-filter:none!important;' +
        'box-shadow:0 -2px 8px rgba(0,0,0,0.5)!important;}',

      /* input wrapper — dark bg so the input box sits inside the orange toolbar */
      '[class*="inputWrapper"],[class*="InputWrapper"],' +
      '[class*="composer"],[class*="Composer"]{' +
        'background:transparent!important;}',

      '[class*="toolbar"],[class*="Toolbar"]{' +
        'background:transparent!important;border-top:none!important;}',

      /* messages scroll area — plain dark, no tile (tile lives in the toolbar strip) */
      '[class*="messagesContainer"]{' +
        'background-color:var(--cb-bodyBg,#1c1c1e)!important;' +
        'background-image:none!important;}',

      /* orange Claude branding text — keep as a subtle accent */
      '[class*="footer"] [class*="claude"],[class*="Footer"] [class*="claude"]{' +
        'color:var(--cb-accent,#f97316)!important;font-weight:600!important;}',

      /* hide active file pill (Untitled-1 etc) — use .cb-hide-file-pill class applied by JS */
      '.cb-hide-file-pill{display:none!important;}',

      /* strip border/outline from all buttons globally */
      'button:not(#__cb_black_edition_label):not(#__cb_monitor_btn){border:none!important;outline:none!important;box-shadow:none!important;}',

      /* icon buttons ghost-white, transparent bg */
      '[class*="toolbar"] button:not(#__cb_black_edition_label),[class*="Toolbar"] button:not(#__cb_black_edition_label),[class*="footer"] button:not(#__cb_black_edition_label),[class*="Footer"] button:not(#__cb_black_edition_label),' +
      '[class*="inputActions"] button:not(#__cb_black_edition_label),[class*="InputActions"] button:not(#__cb_black_edition_label){color:rgba(255,255,255,0.75)!important;background:transparent!important;}',

      /* prompt box at 70% panel width, centered */
      '[class*="inputContainer"],[class*="InputContainer"]{' +
        'width:70%!important;max-width:70%!important;' +
        'margin-left:auto!important;margin-right:auto!important;' +
        'box-sizing:border-box!important;}',


      '[class*="toolbar"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="Toolbar"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="footer"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="Footer"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="inputActions"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="InputActions"] button:not(#__cb_monitor_btn) svg,' +
      '[class*="toolbar"] button:not(#__cb_monitor_btn) svg path,' +
      '[class*="footer"] button:not(#__cb_monitor_btn) svg path,' +
      '[class*="inputActions"] button:not(#__cb_monitor_btn) svg path{' +
        'fill:rgba(255,255,255,0.55)!important;color:rgba(255,255,255,0.55)!important;}',

      /* prompt textarea — black terminal style matching good.png */
      'textarea,[class*="inputTextarea"],[class*="InputTextarea"],' +
      '[class*="inputContainer"] textarea,[class*="InputContainer"] textarea,' +
      '[class*="inputContainer"] [contenteditable="true"],[class*="InputContainer"] [contenteditable="true"],' +
      '[class*="inputContainer"] [contenteditable=""],[class*="InputContainer"] [contenteditable=""],' +
      '[class*="composer"] textarea,[class*="Composer"] textarea,' +
      '[class*="composer"] [contenteditable],[class*="Composer"] [contenteditable],' +
      '[class*="promptInput"],[class*="PromptInput"],' +
      '[role="textbox"]{' +
        'background:var(--cb-inputBg,#0d0d0d)!important;' +
        'background-image:none!important;' +
        'color:var(--cb-inputText,#e8e8e8)!important;' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace)!important;' +
        'caret-color:var(--cb-accent,#E8621A)!important;' +
        'box-shadow:inset 0 2px 6px rgba(0,0,0,0.5)!important;' +
        'border:none!important;}',

      /* input container — keep border + radius, transparent bg so footer dark grey shows through */
      '[class*="inputContainer"],[class*="InputContainer"]{' +
        'border-radius:var(--cb-inputRadius,6px)!important;' +
        'background:transparent!important;}',

      /* placeholder */
      'textarea::placeholder,[class*="inputTextarea"]::placeholder,' +
      '[class*="inputContainer"] [contenteditable]:empty:before{' +
        'color:rgba(232,98,26,0.5)!important;' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,monospace)!important;}',

      /* menus / dropdowns */
      '[role="menu"],[role="listbox"],[class*="menu"],[class*="Menu"],[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"]{' +
        'background:var(--cb-menuBg,#fff)!important;' +
        'color:var(--cb-menuFg,#000)!important;' +
        'font-family:var(--cb-inputFont,monospace)!important;' +
        'border:1.5px solid var(--cb-menuBorder,#000)!important;' +
        'border-radius:6px!important;}',

      '[role="menu"] *,[role="listbox"] *,[class*="menu"] [role="menuitem"],[class*="Menu"] [role="menuitem"],' +
      '[class*="dropdown"] li,[class*="Dropdown"] li{' +
        'color:var(--cb-menuFg,#000)!important;' +
        'font-family:var(--cb-inputFont,monospace)!important;background:transparent!important;}',

      '[role="menuitem"]:hover,[role="option"]:hover,[class*="menu"] [role="menuitem"]:hover{' +
        'background:var(--cb-menuHoverBg,#f0f0f0)!important;color:var(--cb-menuFg,#000)!important;}',

      /* stop button — black glass */
      'button[aria-label*="Stop"],button[aria-label*="stop"],[data-testid="stop-button"]{' +
        'background:linear-gradient(135deg,var(--cb-stopGrad1,rgba(0,0,0,0.9)) 0%,var(--cb-stopGrad2,rgba(30,20,20,0.85)) 100%)!important;' +
        'color:var(--cb-iconFg,#fff)!important;' +
        'border:1px solid var(--cb-stopBorder,rgba(255,255,255,0.15))!important;' +
        'border-radius:6px!important;backdrop-filter:blur(6px)!important;' +
        'box-shadow:0 2px 8px var(--cb-stopShadow,rgba(0,0,0,0.4))!important;}',

      /* read-aloud button */
      '#__cb_readaloud_btn{position:relative;background:none!important;border:none!important;cursor:pointer;' +
        'padding:3px 5px;line-height:1;opacity:.75;transition:opacity .15s;' +
        'display:inline-flex!important;align-items:center;margin:0;flex-shrink:0;}',
      '#__cb_readaloud_btn:hover,#__cb_readaloud_btn.__cb_speaking{opacity:1;}',
      '#__cb_readaloud_btn.__cb_autoread{opacity:1;}',
      '#__cb_readaloud_btn.__cb_autoread::after{content:"";position:absolute;inset:-3px;border-radius:50%;' +
        'border:2px solid transparent;border-top-color:var(--cb-spinRing,#0070f3);' +
        'animation:__cbSpin .8s linear infinite;pointer-events:none;}',
      '@keyframes __cbSpin{to{transform:rotate(360deg)}}',
    ].join('\n');
    document.head.appendChild(s);
    applyInputShadow();
  }

  /* ── helpers ── */
  function getLastAssistantText() {
    var msgs = document.querySelectorAll('[data-testid="assistant-message"],[class*="assistantMessage"],[class*="AssistantMessage"]');
    if (!msgs.length) msgs = document.querySelectorAll('[class*="prose"],[class*="Prose"]');
    if (!msgs.length) return '';
    var clone = msgs[msgs.length - 1].cloneNode(true);
    clone.querySelectorAll('pre,code,[class*="codeBlock"],[class*="CodeBlock"],[class*="code-block"]').forEach(function(el){ el.remove(); });
    return (clone.innerText || clone.textContent || '').trim().slice(0, 4000);
  }

  function speak(txt) {
    if (!txt || txt === lastReadText) return;
    lastReadText = txt;
    window.speechSynthesis.cancel();
    var utt = new SpeechSynthesisUtterance(txt);
    utt.lang = navigator.language || 'en-US';
    var btn = document.getElementById(READALOUD_ID);
    if (btn) btn.classList.add('__cb_speaking');
    utt.onend = utt.onerror = function () {
      if (btn) btn.classList.remove('__cb_speaking');
    };
    window.speechSynthesis.speak(utt);
  }

  function startAutoRead() {
    AUTO_READ = true;
    var btn = document.getElementById(READALOUD_ID);
    if (btn) { btn.classList.add('__cb_autoread'); btn.title = 'Auto-read ON — double-click to stop'; }
    if (autoObserver) return;
    autoObserver = new MutationObserver(function () {
      if (!AUTO_READ) return;
      var txt = getLastAssistantText();
      if (txt && txt !== lastReadText && !window.speechSynthesis.speaking) speak(txt);
    });
    autoObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopAutoRead() {
    AUTO_READ = false;
    window.speechSynthesis.cancel();
    if (autoObserver) { autoObserver.disconnect(); autoObserver = null; }
    var btn = document.getElementById(READALOUD_ID);
    if (btn) { btn.classList.remove('__cb_autoread','__cb_speaking'); btn.title = 'Read aloud  |  double-click = auto-read'; }
  }

  /* ── read-aloud button ── */
  function mountReadAloud(anchor) {
    if (document.getElementById(READALOUD_ID)) return;

    var btn = document.createElement('button');
    btn.id    = READALOUD_ID;
    btn.type  = 'button';
    btn.title = 'Read aloud  |  double-click = auto-read';
    btn.innerHTML = '<span style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" style="display:block"><path d="M9 4.5a.75.75 0 00-1.28-.53L4.1 7H2a1 1 0 00-1 1v4a1 1 0 001 1h2.1l3.62 3.03A.75.75 0 009 15.5v-11zm4.5.97a.75.75 0 011.06 0 7.5 7.5 0 010 10.6.75.75 0 11-1.06-1.07 6 6 0 000-8.47.75.75 0 010-1.06zm-2 2a.75.75 0 011.06 0 4.5 4.5 0 010 6.36.75.75 0 11-1.06-1.06 3 3 0 000-4.24.75.75 0 010-1.06z"/></svg></span>';

    btn.addEventListener('click', function (e) {
      if (e.detail >= 2) return;
      if (AUTO_READ) { stopAutoRead(); return; }
      if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); btn.classList.remove('__cb_speaking'); return; }
      speak(getLastAssistantText());
    });

    btn.addEventListener('dblclick', function () {
      if (AUTO_READ) stopAutoRead(); else startAutoRead();
    });

    var label = document.getElementById(LABEL_ID);
    if (label && label.parentNode) {
      label.parentNode.insertBefore(btn, label.nextSibling);
    } else {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }

  /* ── CBE badge label — anchored next to Stop button (or compact button as fallback) ── */
  function mountLabel() {
    var anchor = null;
    // Prefer Stop button so the badge sits right next to it in the toolbar
    document.querySelectorAll('button').forEach(function (b) {
      if (anchor) return;
      var lbl = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
      if (lbl.includes('stop')) anchor = b;
    });
    if (!anchor) {
      document.querySelectorAll('button').forEach(function (b) {
        if (!anchor && b.title && b.title.toLowerCase().includes('compact')) anchor = b;
      });
    }
    if (!anchor) {
      document.querySelectorAll('button').forEach(function (b) {
        if (!anchor && b.title && b.title.toLowerCase().includes('command menu')) anchor = b;
      });
    }
    /* idle-state fallback: the Add (+) button is always present in the toolbar */
    if (!anchor) {
      document.querySelectorAll('button').forEach(function (b) {
        if (anchor) return;
        var lbl = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
        if (lbl === 'add' || lbl.includes('add context') || lbl.includes('attach')) anchor = b;
      });
    }
    /* last-resort fallback: model selector / any toolbar button inside footer */
    if (!anchor) {
      var footer = document.querySelector('[class*="footer"],[class*="Footer"],[class*="toolbar"],[class*="Toolbar"]');
      if (footer) anchor = footer.querySelector('button');
    }
    if (!anchor) return;

    var existing = document.getElementById(LABEL_ID);
    if (existing && existing.tagName !== 'BUTTON') existing.remove(); /* drop old span badge */
    if (!document.getElementById(LABEL_ID)) {
      var label = document.createElement('button');
      label.id = LABEL_ID;
      label.type = 'button';
      label.title = 'Claude Codex Black Edition — click for STT provider';
      label.innerHTML =
        '<span style="font-weight:600;letter-spacing:.02em">Claude Codex — Black Edition</span>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:4px;flex-shrink:0"><polyline points="3 4.5 6 8 9 4.5"/></svg>';
      label.style.cssText = [
        'all:unset',
        'cursor:pointer',
        'font-size:11px','font-weight:600',
        'color:var(--cb-badgeFg,#fff)',
        'background:var(--cb-badgeBg,#1a1a1a)',
        'border:1px solid var(--cb-badgeBorder,rgba(255,255,255,0.18))',
        'border-radius:14px','padding:3px 10px','margin:0 6px',
        'white-space:nowrap','display:inline-flex','align-items:center','justify-content:center','gap:2px',
        'height:22px','line-height:1',
        'user-select:none','flex-shrink:0',
        'transition:background .12s,border-color .12s',
      ].join(';');
      label.addEventListener('mouseover', function(){ label.style.background = '#2a2a2a'; });
      label.addEventListener('mouseout',  function(){ label.style.background = '#1a1a1a'; });
      label.addEventListener('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        var rect = label.getBoundingClientRect();
        var ev = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: rect.left, clientY: rect.top,
        });
        var mic = document.getElementById('__cb_stt_mic');
        if (mic) mic.dispatchEvent(ev);
      });
      anchor.parentNode.insertBefore(label, anchor.nextSibling);
    }

    mountReadAloud(anchor);
  }

  if (window.__cbBlackEditionInterval) clearInterval(window.__cbBlackEditionInterval);
  var _oldBtn = document.getElementById(READALOUD_ID);
  if (_oldBtn) _oldBtn.remove();

  document.title = 'Claude Code Black Ed.';

  /* only apply background/border styles in the CC chat webview, not the CBE panel */
  var isCCChat = !!document.querySelector('[class*="messagesContainer"],[class*="inputContainer"],[class*="inputFooter"]');
  if (isCCChat) applyBlackBorders();
  mountLabel();

  function hideFilePill() {
    /* hide any toolbar button/role-button/link/div that represents an open-file/context pill */
    var KEEP = new Set([LABEL_ID, READALOUD_ID, '__cb_stt_mic', '__cb_monitor_btn']);
    var KEEP_TEXT = /^(stop|new|compact|add|slash|insert|command menu|voice|shield|claude codex.*black edition.*)$/i;
    document.querySelectorAll('button,a,[role="button"]').forEach(function(el) {
      if (KEEP.has(el.id)) return;
      if (el.querySelector && el.querySelector('#' + LABEL_ID)) return;
      var txt = (el.textContent || '').trim();
      if (!txt || txt.length < 3 || txt.length > 80) return;
      if (KEEP_TEXT.test(txt)) return;
      /* file-like patterns: Untitled-N, .ext, "tool output", "name (id)" */
      if (/untitled/i.test(txt) ||
          /\.\w{1,5}$/.test(txt) ||
          /tool output/i.test(txt) ||
          /\([\w]{3,}\)\s*$/.test(txt)) {
        el.classList.add('cb-hide-file-pill');
        el.style.setProperty('display', 'none', 'important');
        var p = el.parentElement;
        if (p && p.children.length <= 2) {
          p.classList.add('cb-hide-file-pill');
          p.style.setProperty('display', 'none', 'important');
        }
      }
    });
  }

  function forceTextareaDark() {
    /* CSS !important can be beaten by CC's own scoped styles — force via JS */
    document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').forEach(function(ta) {
      ta.style.setProperty('background', '#0d0d0d', 'important');
      ta.style.setProperty('background-color', '#0d0d0d', 'important');
      ta.style.setProperty('background-image', 'none', 'important');
      ta.style.setProperty('color', '#e8e8e8', 'important');
      ta.style.setProperty('caret-color', '#E8621A', 'important');
      /* walk up until inputContainer and force every wrapper transparent;
         on the wrapper whose width is < 70% of inputContainer width, put the orange border */
      var p = ta.parentElement;
      var depth = 0;
      var borderTarget = null;
      var inputContainerWidth = null;
      while (p && depth < 8) {
        var cls = (p.className || '') + '';
        if (/inputContainer|InputContainer/.test(cls)) {
          inputContainerWidth = p.getBoundingClientRect().width;
          /* fallback: if no narrower wrapper found, put border on inputContainer with a max-width to make it tight */
          if (!borderTarget) borderTarget = p;
          break;
        }
        if (!borderTarget) {
          var w = p.getBoundingClientRect().width;
          if (w > 50) borderTarget = p; /* first non-trivial wrapper above textarea */
        }
        p.style.setProperty('background', 'transparent', 'important');
        p.style.setProperty('background-color', 'transparent', 'important');
        p.style.setProperty('background-image', 'none', 'important');
        p = p.parentElement;
        depth++;
      }
      if (borderTarget) {
        borderTarget.style.setProperty('border', '4px solid #ff6b1a', 'important');
        borderTarget.style.setProperty('border-radius', '8px', 'important');
        borderTarget.style.setProperty('box-sizing', 'border-box', 'important');
        /* 70% of container, NOT 80vw. vw is viewport-relative and overflows narrow
           sidebar panels. Clear ancestor max-widths (don't force width:100% — that
           was what bled past panel edges before) so 70% lands on the panel width.
           NOTE: never set flex-basis — parent is column-direction, so
           flex-basis becomes height and the input balloons to fill the panel. */
        borderTarget.style.setProperty('width', '70%', 'important');
        borderTarget.style.setProperty('max-width', '70%', 'important');
        borderTarget.style.setProperty('flex', '0 0 auto', 'important');
        borderTarget.style.setProperty('margin-left', 'auto', 'important');
        borderTarget.style.setProperty('margin-right', 'auto', 'important');
        borderTarget.style.setProperty('align-self', 'center', 'important');
        /* clear CC's inner max-width constraint on ancestors, but DON'T set width:100% */
        var up = borderTarget.parentElement, d = 0;
        while (up && d < 6 && up !== document.body) {
          up.style.setProperty('max-width', 'none', 'important');
          up = up.parentElement; d++;
        }
      }
      /* also stretch the textarea itself */
      ta.style.setProperty('width', '100%', 'important');
      ta.style.setProperty('max-width', 'none', 'important');
      ta.style.setProperty('box-sizing', 'border-box', 'important');
    });
    /* force footer orange gradient via JS too (matches CSS) */
    document.querySelectorAll('[class*="footer"],[class*="Footer"],[class*="inputFooter"]').forEach(function(f) {
      f.style.setProperty('background', 'linear-gradient(90deg,#b83c00 0%,#e8621a 55%,#ff7a1a 100%)', 'important');
      f.style.setProperty('background-image', 'linear-gradient(90deg,#b83c00 0%,#e8621a 55%,#ff7a1a 100%)', 'important');
      f.style.setProperty('width', '70%', 'important');
      f.style.setProperty('max-width', '70%', 'important');
      f.style.setProperty('margin-left', 'auto', 'important');
      f.style.setProperty('margin-right', 'auto', 'important');
      f.style.setProperty('backdrop-filter', 'none', 'important');
    });

    /* diamond tile in the gutters around the 70% frame.
       Put on inputContainer's parent so the tile shows where the frame doesn't cover. */
    var TILE_URL = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2748%27 height=%2748%27%3E%3Crect width=%2748%27 height=%2748%27 fill=%27%231e1e20%27/%3E%3Cpolygon points=%2724,3 45,24 24,45 3,24%27 fill=%27%23252527%27 stroke=%27%23323235%27 stroke-width=%270.8%27/%3E%3C/svg%3E")';
    var ic = document.querySelector('[class*="inputContainer"],[class*="InputContainer"]');
    if (ic && ic.parentElement) {
      var gutter = ic.parentElement;
      gutter.style.setProperty('background-color', '#1c1c1e', 'important');
      gutter.style.setProperty('background-image', TILE_URL, 'important');
      gutter.style.setProperty('background-repeat', 'repeat', 'important');
      gutter.style.setProperty('background-size', '48px 48px', 'important');
    }
  }

  window.__cbBlackEditionInterval = setInterval(function () {
    document.title = 'Claude Code Black Ed.';
    if (!document.getElementById(LABEL_ID) || !document.getElementById(READALOUD_ID)) mountLabel();
    hideFilePill();
    forceTextareaDark();
  }, 1000);
})();
