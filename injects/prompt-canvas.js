(function(){
  // Disabled — the big right-side CBE canvas was visual clutter.
  // Tiny CBE badge lives in black-edition.js mountLabel(), anchored next to Stop.
  console.error('[cb-canvas] disabled');
  return;
  // eslint-disable-next-line no-unreachable
  var CANVAS_ID = '__cb_prompt_canvas';
  var WRAP_ID   = '__cb_prompt_canvas_wrap';

  function getPromptBarBottom() {
    var submitBtn = document.querySelector('button[type="submit"]');
    if (!submitBtn) return null;
    var el = submitBtn;
    for (var i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el || el === document.body || el === document.documentElement) break;
      var rect = el.getBoundingClientRect();
      if (rect.height >= 70) return rect;
    }
    return null;
  }

  function mount() {
    if (document.getElementById(WRAP_ID)) return;

    var rect = getPromptBarBottom();
    if (!rect) return;

    var h = Math.round(rect.height) || 80;
    var bottom = Math.round(window.innerHeight - rect.bottom);

    var wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    wrap.style.cssText = [
      'position:fixed',
      'right:0',
      'bottom:' + bottom + 'px',
      'width:100px',
      'height:' + h + 'px',
      'border:2px solid #333',
      'border-radius:8px 0 0 8px',
      'overflow:hidden',
      'background:#1e1e1e',
      'z-index:9999',
      'pointer-events:none',
    ].join(';');

    var canvas = document.createElement('canvas');
    canvas.id     = CANVAS_ID;
    canvas.width  = 100;
    canvas.height = h;
    canvas.style.cssText = 'display:block;width:100%;height:100%;';

    var ctx = canvas.getContext('2d');
    if (ctx) {
      var grad = ctx.createLinearGradient(0, 0, 100, h);
      grad.addColorStop(0, '#1a1a2e');
      grad.addColorStop(1, '#0f3460');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 100, h);

      // Draw "CBE" text
      ctx.fillStyle = '#7090ff';
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('CBE', 50, h / 2 + 5);
    }

    wrap.appendChild(canvas);
    (document.body || document.documentElement).appendChild(wrap);

    console.error('[cb-canvas] mounted fixed bottom=' + bottom + ' h=' + h);
  }

  if (window.__cbCanvasInterval) clearInterval(window.__cbCanvasInterval);
  window.__cbCanvasInterval = setInterval(function() {
    if (!document.getElementById(WRAP_ID)) mount();
  }, 1000);

  setTimeout(mount, 800);
})();
