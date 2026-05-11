(function(){
  // Always reinstall — restore original fetch first if we wrapped it before
  if(window.__cbSpeechFixOrigFetch) window.fetch = window.__cbSpeechFixOrigFetch;
  window.__cbSpeechFixOrigFetch = window.fetch.bind(window);

  var CTRL = 'http://127.0.0.1:57837';
  var _baselineClip = null;
  var _clipPollTimer = null;

  function log(m){ console.error('[speech-fix]',m); }

  function sendText(txt){
    if(!txt) return;
    log('sendText via hook: '+JSON.stringify(txt.slice(0,60)));
    fetch(CTRL+'/hook/send-text', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text: txt})
    }).then(function(r){ return r.json(); })
      .then(function(d){ log('send-text result: '+JSON.stringify(d)); })
      .catch(function(e){ log('send-text err: '+e); });
  }

  // After SAPI starts, extension's submitText() writes transcript to clipboard.
  // We detect the change and route it through send-text hook (SendKeys, proven by vs-whisper).
  function startClipboardWatch(){
    if(_clipPollTimer) return;
    log('clipboard watch started');
    navigator.clipboard.readText().then(function(t){ _baselineClip = t; }).catch(function(){});
    var attempts = 0;
    _clipPollTimer = setInterval(function(){
      attempts++;
      if(attempts > 100){ clearInterval(_clipPollTimer); _clipPollTimer = null; log('clipboard watch timed out'); return; }
      navigator.clipboard.readText().then(function(txt){
        if(txt && txt !== _baselineClip){
          clearInterval(_clipPollTimer); _clipPollTimer = null;
          log('clipboard changed: '+JSON.stringify(txt.slice(0,60)));
          _baselineClip = txt;
          sendText(txt);
        }
      }).catch(function(){ clearInterval(_clipPollTimer); _clipPollTimer = null; });
    }, 400);
  }

  var _origFetch = window.__cbSpeechFixOrigFetch;
  window.fetch = function(url, opts){
    if(typeof url !== 'string') return _origFetch(url, opts);

    // Web Speech API result → route through send-text hook
    if(url.indexOf('/speech/submit') !== -1){
      var body = {};
      try{ body = JSON.parse((opts&&opts.body)||'{}'); }catch(e){}
      var txt = (body.text||'').trim();
      log('intercepted /speech/submit: '+JSON.stringify(txt.slice(0,60)));
      if(txt) sendText(txt);
      return Promise.resolve(new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}}));
    }

    // SAPI path — submitText() in extension handles paste, no clipboard watch needed
    if(url.indexOf('/speech/start') !== -1){
      log('intercepted /speech/start');
    }

    return _origFetch(url, opts);
  };

  log('speech-fix installed');
})();
