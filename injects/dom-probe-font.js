/* dom-probe-font.js — dump all CSS rules that target .messageInput / :before
   so we know exactly what CC sets and can outspecify it. */
(function () {
  setTimeout(function () {
    var log = function (m) { console.error('[dom-probe-font] ' + m); };
    var found = 0;
    function walk(sheet, src) {
      var rules;
      try { rules = sheet.cssRules || sheet.rules; } catch (e) { return; }
      if (!rules) return;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.cssRules) { walk(r, src); continue; }
        if (!r.selectorText) continue;
        if (/messageInput|placeholder|::before/i.test(r.selectorText) === false) continue;
        found++;
        log('RULE ' + src + ' :: ' + r.selectorText);
        var ct = r.style.cssText;
        if (ct.length > 400) ct = ct.slice(0, 400) + '…';
        log('  ' + ct);
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      walk(document.styleSheets[s], 'sheet[' + s + '] href=' + (document.styleSheets[s].href || 'inline').slice(0, 80));
    }
    log('done. matched rules: ' + found);

    /* also test what ::before computed font is actually inherited */
    var el = document.querySelector('[class*="messageInput"]');
    if (el) {
      log('messageInput element font-family: ' + getComputedStyle(el).fontFamily);
      try {
        log('messageInput ::before font-family: ' + getComputedStyle(el, '::before').fontFamily);
        log('messageInput ::before content: ' + getComputedStyle(el, '::before').content);
      } catch (e) { log('::before probe failed: ' + e.message); }
    }
  }, 2500);
})();
