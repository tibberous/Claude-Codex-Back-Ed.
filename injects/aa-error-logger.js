(function(){
  // Runs first (alphabetical 'aa-') so it captures errors from every other inject.
  // Routes window.onerror, unhandledrejection, and console.error to CBE log server.

  if (window.__cbErrLogger) return;
  window.__cbErrLogger = { v: 1, count: 0 };

  var LOG_PORT = 57836;
  var ENDPOINT = 'http://127.0.0.1:' + LOG_PORT + '/';
  var BUF      = [];
  var FLUSH_MS = 600;
  var MAX_BUF  = 50;

  function send(line) {
    BUF.push(line);
    if (BUF.length > MAX_BUF) BUF.shift();
    scheduleFlush();
  }

  var _flushTimer = null;
  function scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(function(){
      _flushTimer = null;
      if (!BUF.length) return;
      var batch = BUF.splice(0, BUF.length).join('\n');
      try {
        fetch(ENDPOINT, { method: 'POST', mode: 'no-cors', headers: {'Content-Type':'text/plain'}, body: batch })
          .catch(function(){ /* CBE down — drop silently */ });
      } catch(e) {}
    }, FLUSH_MS);
  }

  function fmt(label, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      try {
        if (a instanceof Error) parts.push(a.stack || (a.name + ': ' + a.message));
        else if (typeof a === 'object') parts.push(JSON.stringify(a));
        else parts.push(String(a));
      } catch(e) { parts.push('[unserializable]'); }
    }
    return '[' + new Date().toISOString() + '] [' + label + '] ' + parts.join(' ');
  }

  // window.onerror — uncaught synchronous errors
  window.addEventListener('error', function(ev) {
    window.__cbErrLogger.count++;
    var msg = ev.message + ' @ ' + (ev.filename || '?') + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0);
    if (ev.error && ev.error.stack) msg += '\n' + ev.error.stack;
    send(fmt('ERROR', [msg]));
  }, true);

  // unhandled promise rejections
  window.addEventListener('unhandledrejection', function(ev) {
    window.__cbErrLogger.count++;
    var r = ev.reason;
    var msg = r instanceof Error ? (r.stack || r.message) : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    send(fmt('UNHANDLED-REJECTION', [msg]));
  }, true);

  // Wrap console.error so failed fetches and inject errors land in the log too
  var _origError = console.error.bind(console);
  console.error = function() {
    try { send(fmt('CONSOLE.ERROR', arguments)); } catch(e) {}
    return _origError.apply(console, arguments);
  };

  // Wrap console.warn similarly — useful for fetch failures that browsers log as warnings
  var _origWarn = console.warn.bind(console);
  console.warn = function() {
    try { send(fmt('CONSOLE.WARN', arguments)); } catch(e) {}
    return _origWarn.apply(console, arguments);
  };

  send(fmt('INIT', ['cb-error-logger ready, routing to ' + ENDPOINT]));
})();
