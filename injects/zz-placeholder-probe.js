/* probe — target the ACTUAL contenteditable (not the container) */
(function () {
  function log(msg) { try { fetch('http://127.0.0.1:57836', { method:'POST', body:'[probe2] '+msg }).catch(function(){}); } catch(e){} }
  setTimeout(function () {
    /* The real contenteditable: has both contenteditable AND data-placeholder */
    var mi = document.querySelector('[contenteditable][data-placeholder][role="textbox"]')
          || document.querySelector('[contenteditable][data-placeholder]')
          || document.querySelector('[class*="messageInput"][contenteditable]');
    if (!mi) { log('no messageInput contenteditable'); return; }
    log('mi class=' + mi.className + ' tag=' + mi.tagName);
    var cs = window.getComputedStyle(mi);
    var bs = window.getComputedStyle(mi, '::before');
    log('mi computed ff=' + cs.fontFamily);
    log('mi ::before content=' + bs.content);
    log('mi ::before ff=' + bs.fontFamily);
    log('mi ::before color=' + bs.color);
    /* dump only the CSS rules that explicitly target this element's :empty:before */
    try {
      var rules = [];
      for (var i = 0; i < document.styleSheets.length; i++) {
        var ss; try { ss = document.styleSheets[i]; var cr = ss.cssRules; } catch(e){ continue; }
        for (var j = 0; j < cr.length; j++) {
          var r = cr[j];
          if (r.selectorText && /messageInput|data-placeholder|empty.*before|contenteditable/.test(r.selectorText)) {
            if (r.style.fontFamily) rules.push(r.selectorText + ' { font-family: ' + r.style.fontFamily + (r.style.getPropertyPriority('font-family')==='important'?' !important':'') + ' }');
          }
        }
      }
      log('matching rules: ' + rules.length);
      rules.slice(0,20).forEach(function(s){ log('  ' + s); });
    } catch (e) { log('rule walk err: ' + e.message); }
  }, 2500);
})();
