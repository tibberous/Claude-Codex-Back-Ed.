// red-stop-btn.js — Red Stop button injected next to the send/stop button
// Dynamically re-mounts if Claude Code re-renders its input toolbar.
// Click behavior: TBD (user will specify)
(function(){
  var BTN_ID = '__cb_red_stop_btn';

  function log(m){
    try{fetch('http://127.0.0.1:57836',{method:'POST',mode:'no-cors',body:'[red-stop] '+String(m)});}catch(e){}
    console.error('[red-stop]',m);
  }

  function onRedStopClick(){
    log('red stop button clicked — calling /hook/red-stop');
    fetch('http://127.0.0.1:57837/hook/red-stop',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ts:Date.now()})
    }).then(function(r){return r.json();})
      .then(function(d){log('hook result: '+JSON.stringify(d));})
      .catch(function(e){log('hook error: '+e);});
  }

  function createBtn(){
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'SUPER Stop';
    btn.onclick = onRedStopClick;
    btn.style.cssText = [
      'background:#e53e3e',
      'border:none',
      'border-radius:4px',
      'color:#fff',
      'cursor:pointer',
      'font-size:11px',
      'font-weight:600',
      'padding:3px 8px',
      'margin:0 3px',
      'line-height:1.4',
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
    ].join(';');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="10" height="10" fill="white" style="display:block"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>Stop';
    return btn;
  }

  function mount(){
    if(document.getElementById(BTN_ID)) return; // already there

    // Find the send/stop button — it has data-permission-mode attr
    var submitBtn = document.querySelector('button[type="submit"][data-permission-mode]')
                || document.querySelector('button[type="submit"]');
    if(!submitBtn){
      return; // not ready yet — interval will retry
    }

    var parent = submitBtn.parentNode;
    if(!parent) return;

    var btn = createBtn();
    parent.insertBefore(btn, submitBtn);
    log('red stop button mounted');
  }

  // Initial mount + re-mount guard (React may re-render the toolbar)
  mount();
  if(!window.__cbRedStopInterval){
    window.__cbRedStopInterval = setInterval(function(){
      if(!document.getElementById(BTN_ID)) mount();
    }, 1000);
  }
})();
