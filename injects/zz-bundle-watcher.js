/* zz-bundle-watcher.js — when patch-webview.js stamps a new bundle timestamp,
   force a real location.reload() from inside the webview so the new bundle's
   JS context fully re-executes. Bypasses VSCode's broken reloadWebviewAction
   for sidebar webviews with retainContextWhenHidden=true. */
(function () {
  if (window.__cbBundleWatcherInterval) clearInterval(window.__cbBundleWatcherInterval);
  var myTs = window.__cbBundleTs || 0;
  if (!myTs) return; /* bundle pre-dates the stamp — wait for next patch */

  var failures = 0;
  window.__cbBundleWatcherInterval = setInterval(function () {
    fetch('http://127.0.0.1:57837/bundle/version', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        failures = 0;
        if (d && d.ts && d.ts > myTs) {
          /* new bundle — force full re-fetch */
          location.reload();
        }
      })
      .catch(function () {
        failures++;
        if (failures > 30) {
          clearInterval(window.__cbBundleWatcherInterval);
        }
      });
  }, 2000);
})();
