/* one-shot DOM probe — logs the textarea's ancestor chain + widths to the log server */
(function () {
  if (window.__cbDomProbeRan) return;
  window.__cbDomProbeRan = true;
  setTimeout(function () {
    var ta = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!ta) { fetch('http://127.0.0.1:57836', { method: 'POST', body: '[probe] no textarea' }); return; }
    var lines = [];
    var p = ta;
    var depth = 0;
    while (p && p !== document.body && depth < 20) {
      var r = p.getBoundingClientRect();
      var cls = (p.className || '') + '';
      var tag = p.tagName.toLowerCase();
      lines.push('[' + depth + '] ' + tag + '.' + cls.slice(0, 80) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' x=' + Math.round(r.x));
      p = p.parentElement;
      depth++;
    }
    fetch('http://127.0.0.1:57836', { method: 'POST', body: '[probe]\n' + lines.join('\n') });
  }, 1500);
})();
