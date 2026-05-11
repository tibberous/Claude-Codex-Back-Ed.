/* aa-probe-placeholder.js — find CC's placeholder element by its visible text and
   force monospace + faded black on it. Re-applies via MutationObserver because
   CC re-renders the prompt subtree on every keystroke + focus change. */
(function () {
  var PH_RE = /Queue another message|Ask Claude to edit|(?:ctrl\s*esc|⌘\s*Esc)\s+to\s+(?:focus|unfocus|attach)/i;
  var MONO = 'ui-monospace,Consolas,"Cascadia Code","Source Code Pro",monospace';

  /* route to 57836 via console.error (aa-error-logger wraps console.error) */
  function log(msg) {
    try { console.error('[cb-probe-placeholder] ' + msg); } catch (e) {}
  }
  log('probe loaded');

  function apply() {
    var hits = 0;
    document.querySelectorAll('body *').forEach(function (el) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
      /* skip elements we already styled */
      if (el.getAttribute('data-cb-mono') === '1') {
        /* but re-assert font-family in case CC's re-render overwrote it */
        el.style.setProperty('font-family', MONO, 'important');
        return;
      }
      var t = (el.textContent || '').trim();
      if (!t || t.length > 200) return;
      if (!PH_RE.test(t)) return;
      el.setAttribute('data-cb-mono', '1');
      el.style.setProperty('font-family', MONO, 'important');
      el.style.setProperty('color', 'rgba(0,0,0,0.55)', 'important');
      el.style.setProperty('opacity', '1', 'important');
      hits++;
      if (hits <= 3) {
        var tag = el.tagName.toLowerCase();
        var cls = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + '').slice(0, 60);
        log('hit ' + tag + '.' + cls.replace(/\s+/g, '.') + ' text="' + t.slice(0, 50) + '"');
      }
    });
  }

  apply();
  var iv = setInterval(apply, 500);

  try {
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (e) { log('MO error: ' + e.message); }
})();
