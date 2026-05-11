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
      /* outer orange border removed per user request — inner orange toolbar stays. */
      '[class*="inputContainer"],[class*="InputContainer"]{' +
        'border:none!important;' +
        'border-radius:8px!important;' +
        'box-shadow:none!important;overflow:hidden!important;}',

      /* footer / toolbar — orange gradient, matches inputContainer width (70%) */
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

      /* prompt box at 70% panel width, centered — outermost inputContainer only.
         Children (background, messageInput chain, footer) are 100% of THIS, so the
         whole input frame stays at 70% panel width with side gutters. */
      '[class*="inputContainer"]:not([class*="inputContainer"] *),' +
      '[class*="InputContainer"]:not([class*="InputContainer"] *){' +
        'width:70%!important;max-width:70%!important;' +
        'margin-left:auto!important;margin-right:auto!important;' +
        'box-sizing:border-box!important;}',
      /* nested inputContainer fills its parent so no inner column appears */
      '[class*="inputContainer"] [class*="inputContainer"],' +
      '[class*="InputContainer"] [class*="InputContainer"]{' +
        'width:100%!important;max-width:100%!important;margin:0!important;}',

      /* inputContainerBackground — stretch to full width of its parent */
      '[class*="inputContainerBackground"],[class*="InputContainerBackground"]{' +
        'width:100%!important;max-width:100%!important;' +
        'left:0!important;right:0!important;' +
        'margin-left:0!important;margin-right:0!important;' +
        'box-sizing:border-box!important;}',

      /* children of inputContainerBackground — fill parent.
         Direct-child selector so we don't blow up inline button/svg widths. */
      '[class*="inputContainerBackground"] > *,[class*="InputContainerBackground"] > *{' +
        'width:100%!important;max-width:100%!important;' +
        'margin-left:0!important;margin-right:0!important;' +
        'box-sizing:border-box!important;}',

      /* message input chain — same parent, also stretch to 100% */
      '[class*="messageInputContainer"],[class*="MessageInputContainer"],' +
      '[class*="messageInput"],[class*="MessageInput"]{' +
        'width:100%!important;max-width:100%!important;' +
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

      /* HAMMER: dedicated monospace rule for the actual contenteditable input —
         DOM confirmed via DevTools: <div class="messageInput_cKsPxg" contenteditable
         data-placeholder="..."> is THE input. Covers element, all descendants, and
         the ::before/::after pseudo (placeholder uses ::before with attr(data-placeholder)). */
      '[class*="messageInput"],[class*="MessageInput"],' +
      '[class*="messageInput"] *,[class*="MessageInput"] *,' +
      '[class*="messageInput"]::before,[class*="MessageInput"]::before,' +
      '[class*="messageInput"]::after,[class*="MessageInput"]::after{' +
        'font-family:ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace!important;}',

      /* prompt textarea — black terminal style matching good.png */
      'textarea,[class*="inputTextarea"],[class*="InputTextarea"],' +
      '[class*="inputContainer"] textarea,[class*="InputContainer"] textarea,' +
      '[class*="inputContainer"] [contenteditable],[class*="InputContainer"] [contenteditable],' +
      '[class*="composer"] textarea,[class*="Composer"] textarea,' +
      '[class*="composer"] [contenteditable],[class*="Composer"] [contenteditable],' +
      '[class*="messageInput"],[class*="MessageInput"],' +
      '[class*="promptInput"],[class*="PromptInput"],' +
      '[role="textbox"]{' +
        'background:var(--cb-inputBg,ghostwhite)!important;' +
        'background-image:none!important;' +
        'color:var(--cb-inputText,#000)!important;' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace)!important;' +
        'caret-color:var(--cb-accent,#E8621A)!important;' +
        'box-shadow:inset 0 2px 6px rgba(0,0,0,0.5)!important;' +
        'border:none!important;}',

      /* input container — keep border + radius, transparent bg so footer dark grey shows through */
      '[class*="inputContainer"],[class*="InputContainer"]{' +
        'border-radius:var(--cb-inputRadius,6px)!important;' +
        'background:transparent!important;}',

      /* placeholder — CC's real selector confirmed via DOM probe:
         <div class="messageInput_cKsPxg" placeholder="..." contenteditable>
         placeholder rendered via :empty::before { content: attr(placeholder) }. */
      'textarea::placeholder,textarea::-webkit-input-placeholder,' +
      '[class*="inputTextarea"]::placeholder,[class*="inputTextarea"]::-webkit-input-placeholder,' +
      'div[placeholder]:empty::before,div[placeholder]:empty:before,' +
      '[contenteditable][placeholder]:empty::before,[contenteditable][placeholder]:empty:before,' +
      '[class*="messageInput"]:empty::before,[class*="messageInput"]:empty:before,' +
      '[data-placeholder]::before,[data-placeholder]:empty::before,' +
      '[role="textbox"][data-placeholder]::before,' +
      '[role="textbox"]:empty::before,' +
      '[class*="inputContainer"] [contenteditable]:empty::before,' +
      '[class*="InputContainer"] [contenteditable]:empty::before,' +
      '[class*="placeholder"],[class*="Placeholder"]{' +
        'color:rgba(0,0,0,0.55)!important;' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace)!important;' +
        'font-size:inherit!important;' +
        'opacity:1!important;' +
        'pointer-events:none!important;}',

      /* nuclear option: ALL ::before/::after pseudos inside the input/composer.
         CC's placeholder is a pseudo with `content:"Queue another message…"` and the
         exact bearing element is hard to pin without DevTools. */
      '[class*="inputContainer"] *::before,[class*="InputContainer"] *::before,' +
      '[class*="inputContainer"] *::after,[class*="InputContainer"] *::after,' +
      '[class*="composer"] *::before,[class*="Composer"] *::before,' +
      '[class*="composer"] *::after,[class*="Composer"] *::after,' +
      '[class*="inputContainer"]::before,[class*="InputContainer"]::before,' +
      '[class*="composer"]::before,[class*="Composer"]::before{' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace)!important;' +
        'color:rgba(0,0,0,0.55)!important;}',

      /* force monospace cascade on everything inside the prompt input */
      '[class*="inputContainer"] textarea,[class*="InputContainer"] textarea,' +
      '[class*="inputContainer"] [contenteditable],[class*="InputContainer"] [contenteditable],' +
      '[class*="inputContainer"] textarea *,[class*="InputContainer"] textarea *,' +
      '[class*="inputContainer"] [contenteditable] *,[class*="InputContainer"] [contenteditable] *{' +
        'font-family:var(--cb-inputFont,ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace)!important;}',

      /* menus / dropdowns — skin OUR injected menus only.
         CC's slash-command popover, command palette, and autocomplete suggestions
         are left to CC's own styling — we'd otherwise repaint them white-on-white
         and break their internal layout. Match by our own __cb_ id prefix. */
      '[id^="__cb_"][role="menu"],[id^="__cb_"][role="listbox"]{' +
        'background:var(--cb-menuBg,#fff)!important;' +
        'color:var(--cb-menuFg,#000)!important;' +
        'font-family:var(--cb-inputFont,monospace)!important;' +
        'border:1.5px solid var(--cb-menuBorder,#000)!important;' +
        'border-radius:6px!important;}',

      '[id^="__cb_"][role="menu"] *,[id^="__cb_"][role="listbox"] *{' +
        'color:var(--cb-menuFg,#000)!important;' +
        'font-family:var(--cb-inputFont,monospace)!important;background:transparent!important;}',

      '[id^="__cb_"] [role="menuitem"]:hover,[id^="__cb_"] [role="option"]:hover{' +
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

    /* data URLs may not be loaded yet — aa-label-data.js can be ordered AFTER us in
       the live bundle (Injector insertion-order, not alphabetic). Bail and let the
       interval retry once globals are populated. */
    if (!window.__CB_LABEL_NORMAL) return;

    var existing = document.getElementById(LABEL_ID);
    /* drop old badge unless it's already at current rev. Bump the sentinel ('data-cb-img'
       value) whenever BTN_H or visual styling changes — that forces stale labels left over
       from prior bundle versions to be removed and re-created. */
    var isCurrentRev = existing && existing.getAttribute('data-cb-img') === '4';
    if (existing && (existing.tagName !== 'BUTTON' || !isCurrentRev)) {
      existing.remove();
    }
    if (!document.getElementById(LABEL_ID)) {
      var label = document.createElement('button');
      label.id = LABEL_ID;
      label.type = 'button';
      label.title = 'Claude Codex Black Edition — click for STT provider';
      label.setAttribute('aria-label', 'Claude Codex Black Edition');
      label.setAttribute('data-cb-img', '4'); /* sentinel rev 4: tight-cropped PNG (932x148), BTN_H=32 */
      var normalUrl = window.__CB_LABEL_NORMAL;
      var hoverUrl  = window.__CB_LABEL_HOVER  || normalUrl;
      var imgW = window.__CB_LABEL_W || 964;
      var imgH = window.__CB_LABEL_H || 793;
      /* size button to image aspect ratio at toolbar height */
      var BTN_H = 32;
      var BTN_W = Math.round(BTN_H * (imgW / imgH));
      label.style.cssText = [
        'all:unset',
        'cursor:pointer',
        'display:inline-block',
        'width:'  + BTN_W + 'px',
        'height:' + BTN_H + 'px',
        'background-image:url("' + normalUrl + '")',
        'background-size:contain',
        'background-repeat:no-repeat',
        'background-position:center',
        'flex-shrink:0',
        'margin:0 6px',
        'transition:filter .12s',
      ].join(';');
      label.addEventListener('mouseover', function(){
        label.style.backgroundImage = 'url("' + hoverUrl + '")';
      });
      label.addEventListener('mouseout',  function(){
        label.style.backgroundImage = 'url("' + normalUrl + '")';
      });
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

  /* ── Send-button skin: replace CC's submit-button icon with our 3-state PNGs.
        Anchor to top-right of the textarea's immediate wrapper (= the orange-bordered
        box), not the wider inputContainer. ── */
  function mountSendButton() {
    if (!window.__CB_SEND_NORMAL) return;
    var btns = document.querySelectorAll('button[type="submit"]');
    var SZ = 28; /* must be reachable from the geometry block below */
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var SZ = 28;
      var isNew = btn.getAttribute('data-cb-send') !== '4';
      if (isNew) {
        btn.setAttribute('data-cb-send', '4');
        Array.prototype.forEach.call(btn.children, function(ch){
          ch.style.setProperty('display', 'none', 'important');
        });
        btn.style.setProperty('width',  SZ + 'px', 'important');
        btn.style.setProperty('height', SZ + 'px', 'important');
        btn.style.setProperty('min-width',  SZ + 'px', 'important');
        btn.style.setProperty('min-height', SZ + 'px', 'important');
        btn.style.setProperty('padding', '0', 'important');
        btn.style.setProperty('border', 'none', 'important');
        btn.style.setProperty('border-radius', '50%', 'important');
        btn.style.setProperty('background-color', 'transparent', 'important');
        btn.style.setProperty('background-image', 'url("' + window.__CB_SEND_NORMAL + '")', 'important');
        btn.style.setProperty('background-size', 'contain', 'important');
        btn.style.setProperty('background-repeat', 'no-repeat', 'important');
        btn.style.setProperty('background-position', 'center', 'important');
        btn.style.setProperty('box-shadow', 'none', 'important');
        btn.style.setProperty('outline', 'none', 'important');
        btn.style.setProperty('cursor', 'pointer', 'important');
        (function(b){
          var setBg = function(u){ b.style.setProperty('background-image', 'url("' + u + '")', 'important'); };
          b.addEventListener('mouseenter', function(){ setBg(window.__CB_SEND_HOVER); });
          b.addEventListener('mouseleave', function(){ setBg(window.__CB_SEND_NORMAL); });
          b.addEventListener('mousedown',  function(){ setBg(window.__CB_SEND_CLICK); });
          b.addEventListener('mouseup',    function(){ setBg(window.__CB_SEND_HOVER); });
        })(btn);
      }
      /* recompute geometry each tick — textarea wrapper size changes with content */
      var ic = btn.closest('[class*="inputContainer"],[class*="InputContainer"]');
      var ta = ic && ic.querySelector('textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"]');
      var wrap = ta ? ta.parentElement : null;
      if (ic && wrap) {
        if (getComputedStyle(ic).position === 'static') {
          ic.style.setProperty('position', 'relative', 'important');
        }
        var icRect   = ic.getBoundingClientRect();
        var wrapRect = wrap.getBoundingClientRect();
        var rightOffset = Math.max(8, (icRect.right - wrapRect.right) + 8);
        /* vertically center the button inside the textarea-row wrapper, then nudge up 3px */
        var topOffset = Math.max(0,
          (wrapRect.top - icRect.top) + Math.max(0, (wrapRect.height - SZ) / 2) - 3
        );
        btn.style.setProperty('position', 'absolute', 'important');
        btn.style.setProperty('top',   topOffset   + 'px', 'important');
        btn.style.setProperty('right', rightOffset + 'px', 'important');
        btn.style.setProperty('left',   'auto', 'important');
        btn.style.setProperty('bottom', 'auto', 'important');
        btn.style.setProperty('z-index', '20', 'important');
      }
    }
  }

  if (window.__cbBlackEditionInterval) clearInterval(window.__cbBlackEditionInterval);
  var _oldBtn = document.getElementById(READALOUD_ID);
  if (_oldBtn) _oldBtn.remove();

  document.title = 'Claude Code Black Ed.';

  /* only apply background/border styles in the CC chat webview, not the CBE panel */
  var isCCChat = !!document.querySelector('[class*="messagesContainer"],[class*="inputContainer"],[class*="inputFooter"]');
  if (isCCChat) applyBlackBorders();

  /* Late-stage font override: appended to <body> AFTER all of CC's own styles + ours,
     with maximum-specificity selector chain so it wins the cascade.
     CC's .messageInput_<hash> has `font-family:inherit`, ::before has no font-family
     — both end up using `--vscode-chat-font-family` (system sans-serif). Override here. */
  function applyMonoOverride() {
    var id = '__cb_font_override';
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    var MONO = 'Consolas, "Cascadia Mono", "JetBrains Mono", "Source Code Pro", ui-monospace, monospace';
    s.textContent = [
      'html body [class*="inputContainer"] [class*="messageInput"],',
      'html body [class*="inputContainer"] [class*="messageInput"] *,',
      'html body [class*="inputContainer"] [contenteditable],',
      'html body [class*="inputContainer"] [contenteditable] *,',
      'html body [class*="inputContainer"] [role="textbox"],',
      'html body [class*="inputContainer"] [role="textbox"] *{',
      '  font-family:' + MONO + '!important;',
      '  color:#000!important;',
      '}',
      'html body [class*="inputContainer"] [class*="messageInput"]::before,',
      'html body [class*="inputContainer"] [class*="messageInput"]:before,',
      'html body [class*="inputContainer"] [contenteditable]::before,',
      'html body [class*="inputContainer"] [contenteditable]:before,',
      'html body [class*="inputContainer"] [role="textbox"]::before,',
      'html body [class*="inputContainer"] [role="textbox"]:before,',
      'html body [class*="inputContainer"] [data-placeholder]::before,',
      'html body [class*="inputContainer"] [data-placeholder]:before{',
      '  font-family:' + MONO + '!important;',
      '  color:rgba(0,0,0,0.55)!important;',
      '  opacity:1!important;',
      '}',
    ].join('\n');
    (document.body || document.documentElement).appendChild(s);
  }
  applyMonoOverride();
  mountLabel();
  mountSendButton();

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
      /* hide CC's auto-shown editor file pill (Untitled-N, tool output).
         Don't match generic .ext$ — that catches user-attached files like good.png. */
      if (/^untitled[\s-]?\d/i.test(txt) ||
          /^tool output/i.test(txt)) {
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
    /* CSS !important can be beaten by CC's own scoped styles — force via JS.
       Scope to the chat input only: code diffs, dialogs etc. also use contenteditable
       and were getting the orange-border / 70%-width treatment by mistake. */
    /* match textarea, ANY contenteditable variant, and role=textbox.
       CC uses <div contenteditable=""> (no value), so [contenteditable="true"] misses it. */
    var candidates = document.querySelectorAll('textarea,[contenteditable],[role="textbox"]');
    var MONO = 'ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace';

    /* CC renders the placeholder as a sibling element (not a real ::placeholder).
       Find it by its known text and force monospace + black on it. */
    var PH_RE = /^(?:Queue another message|Ask Claude to edit|(?:ctrl esc|⌘\s*Esc)\s+to\s+(?:focus|unfocus|attach))/i;
    document.querySelectorAll('[class*="inputContainer"] *,[class*="InputContainer"] *').forEach(function(el){
      if (el.children.length !== 0) return; /* only leaf text nodes */
      var t = (el.textContent || '').trim();
      if (!t || !PH_RE.test(t)) return;
      el.style.setProperty('font-family', MONO, 'important');
      el.style.setProperty('color', 'rgba(0,0,0,0.55)', 'important');
      el.style.setProperty('opacity', '1', 'important');
    });

    Array.prototype.filter.call(candidates, function(ta) {
      return ta.closest('[class*="inputContainer"],[class*="InputContainer"],[class*="composer"],[class*="Composer"]');
    }).forEach(function(ta) {
      ta.style.setProperty('background', 'ghostwhite', 'important');
      ta.style.setProperty('background-color', 'ghostwhite', 'important');
      ta.style.setProperty('background-image', 'none', 'important');
      ta.style.setProperty('color', '#000', 'important');
      ta.style.setProperty('font-family', MONO, 'important');
      ta.style.setProperty('caret-color', '#E8621A', 'important');
      /* the contenteditable wraps typed text in spans/divs that inherit nothing —
         force font-family + color on every descendant element too.
         SKIP anything inside CC's slash-command / autocomplete popover — its items
         have role=option/menuitem/listbox and our black color makes them invisible. */
      ta.querySelectorAll('*').forEach(function(child){
        if (child.closest('[role="menu"],[role="listbox"],[role="option"],[role="menuitem"],[role="dialog"],[class*="popover"],[class*="Popover"],[class*="suggestion"],[class*="Suggestion"],[class*="autocomplete"],[class*="Autocomplete"],[class*="commandMenu"],[class*="CommandMenu"],[class*="slashMenu"],[class*="SlashMenu"]')) return;
        child.style.setProperty('font-family', MONO, 'important');
        child.style.setProperty('color', '#000', 'important');
      });
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
          /* always target the outermost wrapper (inputContainer) — avoids the
             nested-border bug where an inner wrapper also gets the orange ring */
          borderTarget = p;
          break;
        }
        p.style.setProperty('background', 'transparent', 'important');
        p.style.setProperty('background-color', 'transparent', 'important');
        p.style.setProperty('background-image', 'none', 'important');
        /* strip any stale orange border we set on inner wrappers in a previous pass */
        if (p.style && p.style.borderColor === 'rgb(255, 107, 26)') {
          p.style.removeProperty('border');
          p.style.removeProperty('border-radius');
          p.style.removeProperty('width');
          p.style.removeProperty('max-width');
        }
        p = p.parentElement;
        depth++;
      }
      if (borderTarget) {
        /* outer orange border removed per user request — keep sizing only */
        borderTarget.style.setProperty('border', 'none', 'important');
        borderTarget.style.setProperty('border-radius', '8px', 'important');
        borderTarget.style.setProperty('box-sizing', 'border-box', 'important');
        /* outer frame at 70% panel width, centered. Children remain 100% of THIS,
           so the input chain fills the frame but the frame itself has gutters.
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
    /* hammer monospace on every descendant of inputContainer / composer / inputFooter.
       Also scan textContent for the placeholder string since CC renders the placeholder
       as a positioned sibling that may live outside inputContainer entirely. */
    var MONO = 'ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace';
    var WRAP_SEL = '[class*="inputContainer"],[class*="InputContainer"],' +
                   '[class*="composer"],[class*="Composer"]';
    document.querySelectorAll(WRAP_SEL).forEach(function(ic){
      ic.style.setProperty('font-family', MONO, 'important');
      ic.querySelectorAll('*').forEach(function(el){
        if (el.id && /^__cb_/.test(el.id)) return;
        if (el.tagName === 'SVG' || el.tagName === 'svg' || el.tagName === 'IMG') return;
        if (el.closest('[role="menu"],[role="listbox"],[role="option"],[role="menuitem"],[role="dialog"],[class*="popover"],[class*="Popover"],[class*="suggestion"],[class*="Suggestion"],[class*="autocomplete"],[class*="Autocomplete"],[class*="commandMenu"],[class*="CommandMenu"],[class*="slashMenu"],[class*="SlashMenu"]')) return;
        el.style.setProperty('font-family', MONO, 'important');
      });
    });
    /* catch placeholder elements rendered as overlays outside inputContainer */
    var PLACEHOLDER_RE = /^(queue another message|send a message|ctrl esc to focus|type a message)/i;
    document.querySelectorAll('div,span,p,label').forEach(function(el){
      if (el.children.length) return; /* leaf only */
      var t = (el.textContent || '').trim();
      if (t && PLACEHOLDER_RE.test(t)) {
        el.style.setProperty('font-family', MONO, 'important');
        el.style.setProperty('color', 'rgba(0,0,0,0.55)', 'important');
      }
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

  /* CC builds the placeholder via JSX (var x1 in webview/index.js). It renders as a
     sibling overlay element with default font-family, NOT a real textarea::placeholder.
     Match by known placeholder text and force monospace+black inline (beats CC's CSS). */
  function forceMonoOnPlaceholders() {
    var MONO = 'ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace';
    var PAT = /(focus or unfocus|queue another message|attach selected text|ask claude to edit)/i;
    document.querySelectorAll('div,span,p').forEach(function(el) {
      if (el.children.length > 0) return;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 80) return;
      if (!PAT.test(t)) return;
      el.style.setProperty('font-family', MONO, 'important');
      el.style.setProperty('color', 'rgba(0,0,0,0.55)', 'important');
      el.style.setProperty('opacity', '1', 'important');
    });
  }

  window.__cbBlackEditionInterval = setInterval(function () {
    document.title = 'Claude Code Black Ed.';
    /* ensure our stylesheet stays installed — CC re-renders can drop it,
       and the initial call at startup can run before inputContainer exists. */
    if (!document.getElementById('__cb_black_borders')) {
      var nowIsCC = !!document.querySelector('[class*="messagesContainer"],[class*="inputContainer"],[class*="inputFooter"]');
      if (nowIsCC) applyBlackBorders();
    }
    if (!document.getElementById(LABEL_ID) || !document.getElementById(READALOUD_ID)) mountLabel();
    mountSendButton();
    hideFilePill();
    forceTextareaDark();
    forceMonoOnPlaceholders();
  }, 1000);
})();
