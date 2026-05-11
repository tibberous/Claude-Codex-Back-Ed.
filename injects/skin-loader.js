(function () {
  var STYLE_ID  = '__cb_skin_vars';
  var POLL_MS   = 8000;
  var PORT      = 57837;
  var _interval = null;

  function applyVars(css) {
    var el = document.getElementById(STYLE_ID);
    if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }

  function fetchSkin() {
    fetch('http://127.0.0.1:' + PORT + '/skin/css', { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (css) { applyVars(css); })
      .catch(function () { /* server not up yet — silent */ });
  }

  if (window.__cbSkinLoaderInterval) clearInterval(window.__cbSkinLoaderInterval);
  fetchSkin();
  window.__cbSkinLoaderInterval = setInterval(fetchSkin, POLL_MS);
})();
