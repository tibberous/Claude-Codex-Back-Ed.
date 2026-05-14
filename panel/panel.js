/* ─────────────────────────────────────────────────────────────────────────
   Claude Codex Black Edition
   Trenton Tompkins <trenttompkins@gmail.com>
   (c) 2006 — Released under the MIT license. See license.txt.
   https://trentontompkins.com    https://github.com/tibberous
   Call (724) 431-5207 — PHP / Python / node.js / desktop / web / mobile
   ───────────────────────────────────────────────────────────────────── */
/* panel.js — extracted from the original inline <script> block in panel/
   index.html so it can be loaded with `defer`. The HTML renders before this
   file finishes parsing/executing, dropping ~250ms off the webview boot.

   Template tokens (PRISM_JS_URI, PRISM_LANGS_URI, SOUNDS_BASE, HELP_URI) are
   no longer string-substituted in this file. They are exposed by a tiny
   inline `<script>` in index.html as `window.__cbeUris.*` and read from
   there. Adding a new URI: add it to the inline window.__cbeUris object in
   index.html AND substitute it in extension.js's getPanelHtml. */
const api = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
/* Prism lazy-load — kicked off right after `ready` is posted. Any code
   blocks rendered before Prism arrives are re-highlighted via a one-shot
   re-pass after the langs file finishes loading. */
let _prismLoadStarted = false;
let _prismLoadDone = null;   /* Promise resolved when both prism + langs are ready */
function ensurePrismLoaded() {
  if (_prismLoadDone) return _prismLoadDone;
  _prismLoadStarted = true;
  _prismLoadDone = new Promise((resolve) => {
    const s1 = document.createElement('script');
    s1.src = window.__cbeUris.PRISM_JS;
    s1.setAttribute('data-manual', '');
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = window.__cbeUris.PRISM_LANGS;
      s2.onload = () => {
        /* Re-highlight any code blocks rendered before Prism arrived. */
        try {
          document.querySelectorAll('pre[class*="language-"] code').forEach((el) => {
            try {
              const m = (el.className || '').match(/language-([a-z0-9+#-]+)/i);
              const lang = m && m[1];
              if (lang && window.Prism && Prism.languages && Prism.languages[lang]) {
                Prism.highlightElement(el);
              }
            } catch (e) { /* skip broken blocks */ }
          });
        } catch (e) {}
        resolve();
      };
      s2.onerror = () => resolve();   /* fail open — blocks stay plain */
      document.head.appendChild(s2);
    };
    s1.onerror = () => resolve();
    document.head.appendChild(s1);
  });
  return _prismLoadDone;
}
const thread = document.getElementById('thread');
const ti     = document.getElementById('promptBox');
const inBox  = document.getElementById('input-box');
const sendBtn= document.getElementById('sendBtn');
const addBtn = document.getElementById('addBtn');

/* ── Sound effects (SFX) — preloaded HTMLAudioElements, played on UI events ─
   16 ogg files under <extensionPath>/sounds (served via window.__cbeUris.SOUNDS_BASE).
   playSfx() is fire-and-forget; failed plays are swallowed so the UI never
   throws over a sound glitch. Volume kept low (0.55) so the UI doesn't
   become a casino. */
/* SOUNDS_BASE is the asWebviewUri() of <extensionPath>/sounds, set by
   extension.js via template substitution in the inline <script> at the
   bottom of index.html. If the substitution failed (token still wrapped
   in braces) we log loudly — silently building URLs like "{{SOUNDS_BASE}}/click.ogg"
   would make every playSfx() a mystery 404. */
const SFX_BASE = (window.__cbeUris && window.__cbeUris.SOUNDS_BASE) || '';
if (!SFX_BASE || SFX_BASE.indexOf('{{') === 0) {
  console.warn('[cbe.sfx] SOUNDS_BASE missing or unsubstituted:', SFX_BASE);
}
const SFX = {};  // name -> HTMLAudioElement
/* User-controlled SFX gates. Hydrated from the host on `init` and updated by
   the settings modal. Defaults: enabled, 0.55 volume. */
window.SFX_ENABLED = true;
window.SFX_VOLUME  = 0.55;
function preloadSfx(name) {
  if (!SFX[name]) {
    const a = new Audio(`${SFX_BASE}/${name}.ogg`);
    a.preload = 'auto';
    a.volume = window.SFX_VOLUME;
    SFX[name] = a;
  }
  return SFX[name];
}
/* Chromium autoplay policy: <audio>.play() rejects with NotAllowedError until
   the document has received a user gesture (click/keydown). The first call —
   typically the boot 'open_and_close_application' cue from `init` — happens
   BEFORE any gesture and will reject silently. We queue any pre-gesture plays
   and flush them once the first user gesture lands. After that, normal calls
   flow through immediately. */
let __cbeAudioUnlocked = false;
const __cbeSfxQueue    = [];
function __cbeUnlockSfx() {
  if (__cbeAudioUnlocked) return;
  __cbeAudioUnlocked = true;
  while (__cbeSfxQueue.length) {
    const n = __cbeSfxQueue.shift();
    try { __cbePlaySfxNow(n); } catch (e) { /* swallow */ }
  }
}
window.addEventListener('pointerdown', __cbeUnlockSfx, { capture: true, once: false });
window.addEventListener('keydown',     __cbeUnlockSfx, { capture: true, once: false });
window.addEventListener('click',       __cbeUnlockSfx, { capture: true, once: false });

function __cbePlaySfxNow(name) {
  const a = preloadSfx(name);
  a.volume = window.SFX_VOLUME;
  a.currentTime = 0;
  const p = a.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err) => {
      /* NotAllowedError → autoplay block; queue for next gesture. Other
         errors (decode, network) we just log and drop. */
      if (err && err.name === 'NotAllowedError') {
        __cbeAudioUnlocked = false;
        if (__cbeSfxQueue.indexOf(name) === -1) __cbeSfxQueue.push(name);
      } else {
        console.debug('[cbe.sfx] play rejected', name, err && err.message);
      }
    });
  }
}
function playSfx(name) {
  if (!window.SFX_ENABLED) return;
  try {
    if (!__cbeAudioUnlocked) {
      /* Pre-gesture: queue, don't even attempt — avoids the silent NotAllowed
         spam in the console for every boot cue. */
      if (__cbeSfxQueue.indexOf(name) === -1) __cbeSfxQueue.push(name);
      return;
    }
    __cbePlaySfxNow(name);
  } catch (e) { console.debug('[cbe.sfx] playSfx threw', name, e && e.message); }
}
function setSfxVolume(v) {
  const n = Math.max(0, Math.min(1, Number(v)));
  if (!Number.isFinite(n)) return;
  window.SFX_VOLUME = n;
  for (const k in SFX) {
    try { SFX[k].volume = n; }
    catch (e) { console.debug('[cbe.sfx] setSfxVolume', k, e && e.message); }
  }
}
function setSfxEnabled(b) { window.SFX_ENABLED = !!b; }
['click','tick','error','popup','close_modal','open_modal','connect','claude','gtp','gemini','shell','enable','disable','open_and_close_application','maximize','minimize'].forEach(preloadSfx);

/* Active provider id, tracked so provider response start can play the right
   provider-themed cue (claude/gtp/gemini/popup-fallback). Updated on `init`
   and `info` messages where the host signals provider changes. */
let __cbeActiveProvider = null;
let __cbeOpenAppPlayed  = false;  /* play "open_and_close_application" once on first init */
let __cbeChunkStarted   = false;  /* per-turn: did we already play the provider cue? */

let busy = false;
let streamingEl = null;

function addMsg(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  thread.appendChild(d);
  thread.scrollTop = thread.scrollHeight;
  if (cls === 'error') playSfx('error');
  return d;
}

/* ── Markdown fence rendering ────────────────────────────────────────── */
const LANG_MAP = {
  'powershell':'powershell','posh':'powershell','ps1':'powershell','ps':'powershell','psm1':'powershell',
  'bash':'bash','sh':'bash','shell':'bash','zsh':'bash',
  'xml':'xml','html':'markup','htm':'markup','xhtml':'markup',
  'svg':'svg',
  'css':'css','scss':'css','less':'css',
  'python':'python','py':'python',
  'js':'javascript','javascript':'javascript',
  'ts':'typescript','typescript':'typescript',
  'php':'php',
  'json':'json','yaml':'yaml','yml':'yaml'
};
const LANG_LABEL = {
  'powershell':'PowerShell','bash':'Bash','markup':'HTML','xml':'XML','svg':'SVG',
  'css':'CSS','python':'Python','javascript':'JavaScript','typescript':'TypeScript',
  'php':'PHP','json':'JSON','yaml':'YAML'
};

function makeCopyBtn(rawCode) {
  const btn = document.createElement('button');
  btn.className = 'cv-copy-btn';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.onclick = () => {
    const done = () => {
      btn.classList.add('copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = 'Copy';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(rawCode).then(done, () => {
        /* Fallback: textarea + execCommand */
        const ta = document.createElement('textarea');
        ta.value = rawCode;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { console.debug('[cbe.copy] execCommand fallback failed', e && e.message); }
        document.body.removeChild(ta);
        done();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = rawCode;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { console.debug('[cbe.copy] execCommand fallback failed', e && e.message); }
      document.body.removeChild(ta);
      done();
    }
  };
  return btn;
}

function makeCodeBlock(rawLang, rawCode) {
  /* Normalize lang. Unknown lang -> plain (no highlighting, but still wrap). */
  const key = (rawLang || '').trim().toLowerCase();
  const lang = LANG_MAP[key] || (key && /^[a-z0-9+#-]+$/i.test(key) ? key : '');
  const label = LANG_LABEL[lang] || (rawLang || 'TEXT').toUpperCase();

  const wrap = document.createElement('div');
  wrap.className = 'cv-code-wrap';

  const bar = document.createElement('div');
  bar.className = 'cv-code-bar';

  const langSpan = document.createElement('span');
  langSpan.className = 'cv-code-lang';
  langSpan.textContent = label;
  bar.appendChild(langSpan);
  bar.appendChild(makeCopyBtn(rawCode));

  const pre = document.createElement('pre');
  pre.className = 'line-numbers' + (lang ? ' language-' + lang : '');
  const codeEl = document.createElement('code');
  codeEl.className = lang ? 'language-' + lang : '';
  codeEl.textContent = rawCode;  /* textContent escapes safely */
  pre.appendChild(codeEl);

  wrap.appendChild(bar);
  wrap.appendChild(pre);

  /* Run Prism if it loaded and lang is known. */
  if (lang && window.Prism && Prism.languages && Prism.languages[lang]) {
    try { Prism.highlightElement(codeEl); }
    catch (e) { /* swallow — leave plain */ }
  }

  /* Line numbers via CSS counters: inject one <span> per line into a
     pointer-events:none / user-select:none container so the numbers render
     but never become part of the selection or clipboard. */
  const lineCount = Math.max(1, (rawCode.match(/\n/g) || []).length + (rawCode.endsWith('\n') ? 0 : 1));
  const lnRows = document.createElement('span');
  lnRows.className = 'line-numbers-rows';
  lnRows.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < lineCount; i++) lnRows.appendChild(document.createElement('span'));
  pre.appendChild(lnRows);

  return wrap;
}

/* Inline `code` (single-backtick) — only on prose chunks, not inside fences. */
function renderInlineCode(textNode, container) {
  const text = textNode;
  /* Simple single-backtick pass. Skip empty matches. */
  const parts = text.split(/(`[^`\r\n]+?`)/g);
  parts.forEach(part => {
    if (!part) return;
    const m = /^`([^`\r\n]+)`$/.exec(part);
    if (m) {
      const c = document.createElement('code');
      c.className = 'cv-inline';
      c.textContent = m[1];
      container.appendChild(c);
    } else {
      const span = document.createElement('span');
      span.className = 'cv-prose';
      span.textContent = part;
      container.appendChild(span);
    }
  });
}

/* Parse the full assistant reply into a sequence of prose + fenced blocks.
   Handles unclosed trailing fences by treating remainder as a code block
   with whatever lang was specified (or plaintext). */
function renderAssistantMarkdown(el, fullText) {
  el.textContent = '';  /* clear prior plain text */
  el.classList.add('rendered');

  const fenceRe = /```([ \t]*[A-Za-z0-9+#_.\-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  for (;;) {
    const m = fenceRe.exec(fullText);
    if (m === null) break;
    /* Prose before this fence */
    if (m.index > lastIndex) {
      renderInlineCode(fullText.slice(lastIndex, m.index), el);
    }
    const lang = m[1] || '';
    let body = m[2] || '';
    /* Strip a single trailing newline that's part of the fence sep, not the code. */
    if (body.endsWith('\n')) body = body.slice(0, -1);
    if (body.endsWith('\r')) body = body.slice(0, -1);
    el.appendChild(makeCodeBlock(lang, body));
    lastIndex = fenceRe.lastIndex;
  }
  /* Trailing prose after last fence */
  if (lastIndex < fullText.length) {
    renderInlineCode(fullText.slice(lastIndex), el);
  }
  thread.scrollTop = thread.scrollHeight;
}

function setBusy(b) {
  busy = b;
  ti.disabled = b;
  sendBtn.disabled = b;
  inBox.classList.toggle('busy', b);
  /* Note: `monitorBtn.is-monitoring` is now bound to the VSCode supervisor
     service state (CBEVSCodeSupervisor), NOT chat busy. Don't toggle it here
     anymore — the periodic monitorStatus probe owns that class. */
}

function send() {
  if (busy) return;
  const txt = (ti.value || '').trim();
  const attachBlock = buildAttachmentBlocks();
  if (!txt && !attachBlock) return;
  const fullText = attachBlock ? (txt + (txt ? '\n' : '') + attachBlock) : txt;
  /* Display the user-typed line only, plus a small chip summary if there
     are attachments — keep the chat compact, no need to re-paste content. */
  let displayText = txt;
  if (__cbeAttachments.length) {
    const names = __cbeAttachments.map(a => '📎 ' + a.name).join('  ');
    displayText = (txt ? txt + '\n\n' : '') + names;
  }
  addMsg(displayText, 'sent');
  if (api) api.postMessage({ type: 'sendText', text: fullText });
  if (api) api.postMessage({ type: 'logChatTurn', role: 'USER', text: fullText });
  historyPush(txt);   /* history stores the user's typed line, not attachments */
  historyReset();
  promptsResetRecall();
  clearAttachments();
  ti.value = '';
  ti.style.height = '';
  setBusy(true);
}

/* SFX hooks: toolbar button click delegation + send-button "tick" cue.
   Both listeners are ADDITIVE — they don't replace existing per-button
   handlers, they only fire alongside them. */
document.querySelector('.prompt-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.tool-button, .label-button, .stop-button');
  if (btn) playSfx('click');
});
sendBtn.addEventListener('click', () => { if (!busy) playSfx('tick'); });

sendBtn.onclick = send;
addBtn.onclick = () => {
  if (api) api.postMessage({ type: 'reset' });
  thread.innerHTML = '';
  addMsg('Conversation reset.', 'info');
  try { tts.stop(); } catch (e) { console.debug('[cbe.tts] addBtn reset stop', e && e.message); }
};
/* Monitor button: left-click toggles the VSCode supervisor Windows service
   (CBEVSCodeSupervisor — keeps Code.exe alive if it crashes). On click we
   IMMEDIATELY show the blue loading ring as optimistic UI feedback, so the
   user gets instant "I'm doing the thing" — even before the service has
   reported its real state. The next poll (3s cadence) either keeps the
   circle on (service is healthy) or removes it (start failed / probe down).
   Right-click still shows the trace channel for diagnostics. */
/* Bulletproof blue spinner — built from pure inline CSS, NO svg asset, NO
   external stylesheet, NO class that a skin could override. As long as the
   webview can run JS, this circle renders. The @keyframes is injected once. */
(function ensureMonitorSpinnerKeyframes() {
  if (document.getElementById('cbe-monitor-spin-kf')) return;
  const st = document.createElement('style');
  st.id = 'cbe-monitor-spin-kf';
  st.textContent = '@keyframes cbeMonitorSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}';
  document.head.appendChild(st);
})();
function cbeShowMonitorSpinner(on) {
  const btn = document.getElementById('monitorBtn');
  if (!btn) return;
  if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
  let ring = btn.querySelector('.cbe-monitor-ring');
  if (on) {
    if (!ring) {
      ring = document.createElement('span');
      ring.className = 'cbe-monitor-ring';
      ring.style.cssText = [
        'position:absolute', 'top:50%', 'left:50%', 'width:18px', 'height:18px',
        'margin:0', 'padding:0', 'box-sizing:border-box', 'border-radius:50%',
        'border:3px solid rgba(78,168,255,0.25)', 'border-top-color:#4ea8ff',
        'transform:translate(-50%,-50%)', 'pointer-events:none', 'z-index:5',
        'animation:cbeMonitorSpin .7s linear infinite',
      ].join(';');
      btn.appendChild(ring);
    }
    ring.style.display = 'block';
  } else if (ring) {
    ring.remove();
  }
}
document.getElementById('monitorBtn').onclick = () => {
  /* Sticky visual toggle: clicking turns the blue ring on and it STAYS on
     until the user clicks again. `__cbeMonitorForcedOn` tells the periodic
     monitorState poll not to wipe the ring just because the supervisor
     service hasn't reported healthy yet — the ring is user-controlled UI
     feedback, decoupled from the real service state. */
  const btn = document.getElementById('monitorBtn');
  const turningOn = !(window.__cbeMonitorForcedOn);
  window.__cbeMonitorForcedOn = turningOn;
  if (btn) {
    btn.classList.toggle('is-monitoring', turningOn);
    btn.setAttribute('data-tooltip', turningOn
      ? 'VSCode supervisor: starting… (left-click to stop · right-click for trace)'
      : 'VSCode supervisor: stopped (left-click to start · right-click for trace)');
  }
  cbeShowMonitorSpinner(turningOn);
  if (api) api.postMessage({ type: 'toggleMonitor' });
};
document.getElementById('monitorBtn').addEventListener('contextmenu', (e) => {
  /* Right-click = shut it off. Forces the blue ring off and tells the host
     to stop the supervisor if it was running. Unconditionally clears the
     forced-on flag so the next 3s poll can't bring the ring back. */
  e.preventDefault();
  const wasOn = !!window.__cbeMonitorForcedOn;
  window.__cbeMonitorForcedOn = false;
  const btn = document.getElementById('monitorBtn');
  if (btn) {
    btn.classList.remove('is-monitoring');
    btn.setAttribute('data-tooltip', 'VSCode supervisor: stopped (left-click to start)');
  }
  cbeShowMonitorSpinner(false);
  /* Only toggle the host if it was on — toggleMonitor flips state, so
     posting it while already off would start the service instead. */
  if (wasOn && api) api.postMessage({ type: 'toggleMonitor' });
});
document.getElementById('terminalBtn').onclick = () => { if (api) api.postMessage({ type: 'openTerminal' }); };
document.getElementById('setupBtn').onclick    = () => { if (api) api.postMessage({ type: 'loadSetup' }); };
document.getElementById('label-pill').onclick  = () => { if (api) api.postMessage({ type: 'labelClick' }); };
document.getElementById('settingsBtn').onclick = () => { if (api) api.postMessage({ type: 'openSettings' }); };
document.getElementById('domainsBtn').onclick  = () => {
  /* If the host already pre-fetched the list on startup, render it
     instantly from cache so there's zero perceived latency. Always
     post `listDomains` too so the modal refreshes with fresh data
     in the background — the second showDomainsModal() replaces the
     first if anything changed. */
  if (window.__cbeDomainsCache) showDomainsModal(window.__cbeDomainsCache);
  if (api) api.postMessage({ type: 'listDomains' });
};

/* ── Read aloud (TTS 🔊) — click=read last reply, double-click=auto-read ─ */
const tts = (function() {
  const btn = document.getElementById('ttsBtn');
  const synth = window.speechSynthesis;
  let lastReply = '';
  let autoRead = false;

  function isSpeaking() { return synth && synth.speaking; }

  /* Keep the SVG icon as the button content — never overwrite with text.
     Speaking state is communicated via the `.speaking` class only, so the
     icon stays visible the whole time. */
  function setIdle() {
    btn.classList.remove('speaking');
  }

  function speak(txt) {
    if (!synth) { addMsg('Speech synthesis not available in this webview.', 'error'); return; }
    if (!txt) return;
    synth.cancel();
    const utt = new SpeechSynthesisUtterance(txt);
    utt.lang = navigator.language || 'en-US';
    utt.onend = utt.onerror = setIdle;
    btn.classList.add('speaking');
    synth.speak(utt);
  }

  function stopAll() {
    if (synth) synth.cancel();
    setIdle();
  }

  btn.addEventListener('click', (e) => {
    /* dblclick fires before second click; let dblclick handle that case */
    if (e.detail >= 2) return;
    if (isSpeaking()) { stopAll(); return; }
    if (lastReply) speak(lastReply);
  });

  /* Right-click toggles auto-read-aloud mode. The .autoread class makes
     the neon-blue spinner SVG overlay appear on the TTS button. Every new
     assistant reply will then be spoken automatically via onAssistantDone. */
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    autoRead = !autoRead;
    btn.classList.toggle('autoread', autoRead);
    btn.setAttribute('data-tooltip', autoRead
      ? 'Auto-read ON — right-click to disable'
      : 'Read aloud · right-click = auto-read every reply');
    if (autoRead) {
      playSfx('enable');
      /* If a reply is already on screen, speak it now so the user gets
         immediate feedback that the mode just turned on. */
      if (lastReply) speak(lastReply);
    } else {
      playSfx('disable');
      stopAll();
    }
  });

  /* dblclick kept as an alternate way to toggle (back-compat with the
     prior behavior) — same logic as the right-click branch above. */
  btn.addEventListener('dblclick', () => {
    autoRead = !autoRead;
    btn.classList.toggle('autoread', autoRead);
    btn.setAttribute('data-tooltip', autoRead
      ? 'Auto-read ON — double-click / right-click to disable'
      : 'Read aloud · right-click = auto-read every reply');
    if (!autoRead) stopAll();
  });

  return {
    setLastReply(t) { lastReply = (t || '').trim(); },
    onAssistantDone(t) {
      lastReply = (t || '').trim();
      if (autoRead && lastReply) speak(lastReply);
    },
    stop: stopAll,
  };
})();

/* ── Web Speech dictation (STT button, .speaking class toggles a red tint) ─
   VSCode webviews silently deny microphone permission to the Web Speech API,
   so the first try fires "not-allowed" right after start(). When that happens
   we fall back to the host-side SAPI path: post `sttStart` to extension.js,
   which spawns PowerShell + System.Speech and posts back `sttResult` with
   the transcript. From the user's POV the button just works — they don't
   see the fallback. */
(function() {
  const sttBtn = document.getElementById('sttBtn');
  let recog = null;
  let listening = false;
  let mode = 'idle';            /* 'idle' | 'sr' (Web Speech) | 'sapi' (host fallback) */

  function setListeningUI(on) {
    /* `.speaking` is the legacy red-tint state. `.is-recording` drives the
       blue loading-ring overlay (same SVG as #monitorBtn) so the user can
       tell at a glance that the mic is actively capturing — important on
       the SAPI fallback path where the recognizer is silent for up to 8s
       waiting for the user to start speaking. */
    if (on) {
      sttBtn.classList.add('speaking');
      sttBtn.classList.add('is-recording');
      sttBtn.title = 'Listening… click to stop';
    } else {
      sttBtn.classList.remove('speaking');
      sttBtn.classList.remove('is-recording');
      sttBtn.title = 'Speech to Text — click to start/stop';
    }
  }

  function stopMic() {
    const wasListening = listening;
    if (recog) {
      try { recog.stop(); }
      catch (e) { console.debug('[cbe.stt] recog.stop', e && e.message); }
      recog = null;
    }
    if (mode === 'sapi' && api) {
      try { api.postMessage({ type: 'sttStop' }); } catch (e) {}
    }
    listening = false;
    mode = 'idle';
    setListeningUI(false);
    if (wasListening) playSfx('disable');
  }

  function appendToInput(t) {
    const cur = (ti.value || '').replace(/\s+$/, '');
    ti.value = cur ? (cur + ' ' + t) : t;
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    ti.focus();
  }

  function startSapi() {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot start SAPI fallback.', 'error');
      return;
    }
    mode = 'sapi';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    api.postMessage({ type: 'sttStart' });
  }

  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      /* No Web Speech API at all — go straight to SAPI. */
      startSapi();
      return;
    }
    try {
      recog = new SR();
      recog.continuous   = false;
      recog.interimResults = false;
      recog.lang = (navigator.language || 'en-US');
      recog.onresult = (e) => {
        const r = e.results && e.results[0] && e.results[0][0];
        if (r && r.transcript) appendToInput(r.transcript.trim());
      };
      recog.onerror = (e) => {
        const err = e && e.error;
        /* VSCode webview sandbox blocks mic access. On not-allowed /
           service-not-allowed, transparently retry on the host via SAPI
           instead of surfacing a useless error. */
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          console.debug('[cbe.stt] Web Speech denied (' + err + ') — falling back to host SAPI');
          /* Tear down the recognizer first so its onend doesn't clobber UI. */
          if (recog) { try { recog.onend = null; recog.stop(); } catch (_) {} recog = null; }
          mode = 'idle';
          listening = false;
          startSapi();
          return;
        }
        if (err && err !== 'aborted' && err !== 'no-speech') {
          addMsg('Voice: ' + err, 'error');
        }
        stopMic();
      };
      recog.onend = () => { if (mode === 'sr') stopMic(); };
      recog.start();
      mode = 'sr';
      listening = true;
      setListeningUI(true);
      playSfx('connect');
    } catch (e) {
      /* SR constructor itself can throw in some webviews — go straight to SAPI. */
      console.debug('[cbe.stt] SR ctor threw — using SAPI', e && e.message);
      if (recog) { try { recog.stop(); } catch (_) {} recog = null; }
      startSapi();
    }
  }

  sttBtn.onclick = () => {
    if (listening) { stopMic(); return; }
    startWebSpeech();
  };

  /* SAPI result coming back from extension.js. */
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type !== 'sttResult') return;
    if (m.error) {
      addMsg('Voice (SAPI): ' + m.error, 'error');
    } else if (m.text) {
      appendToInput(String(m.text).trim());
    } else {
      addMsg('Voice: no speech detected.', 'info');
    }
    /* Recognizer has already exited on the host. Reset UI. */
    listening = false;
    mode = 'idle';
    setListeningUI(false);
    playSfx('disable');
  });
})();


/* ── New toolbar button click handlers ───────────────────────────────────
   Each post-able to the extension host where appropriate; the rest log
   placeholders so the buttons are clickable before their handlers land. */
(function() {
  function bind(id, type, payload) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      if (api && type) api.postMessage({ type, ...(payload || {}) });
      else addMsg(`(stub) ${id} clicked`, 'info');
    });
  }
  bind('stopBtn',           'cancelInFlight');
  /* storedPromptsBtn handled inline below — opens an in-panel modal with
     combo + textarea + Add/Save/Delete/Use/Close. Slash-command /prompts
     still opens the raw prompts.txt file for power users. */
  (function() {
    const el = document.getElementById('storedPromptsBtn');
    if (!el) return;
    el.addEventListener('click', () => openStoredPromptsModal());
  })();
  bind('chatHistoryBtn',    'openChatHistory'); /* host opens QuickPick of chats/*.log */
  bind('attachFileBtn',     'attachFile'); /* host opens file picker, returns content */
  /* autoReplyBtn → left-click opens the Auto Prompt config modal; right-
     click stops a running loop (escape hatch — no need to open the modal
     and zero the interval). Sending interval is 0 by default (off); set
     interval > 0 + a prompt and the panel auto-fires every N seconds,
     with a blue spinner overlay + countdown badge as the running cue. */
  (function() {
    const el = document.getElementById('autoReplyBtn');
    if (!el) return;
    el.addEventListener('click', () => openAutoPromptModal());
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (__cbeAutoPromptTimer) {
        stopAutoPrompt();
        addMsg('Auto Prompt: stopped.', 'info');
      }
    });
  })();
  /* wakeUpBtn opens a small editor modal for wake.txt — the prompt the
     panel injects to nudge the model when it stalls. File is read/written
     by the host so the text survives panel reloads + lives on disk. */
  (function() {
    const el = document.getElementById('wakeUpBtn');
    if (!el) return;
    el.addEventListener('click', () => { if (api) api.postMessage({ type: 'loadWake' }); });
  })();
  /* showCommandsBtn handled inline — opens the in-panel slash menu */
  bind('compactBtn',        'compactConversation');
  /* handbookBtn handled inline below — opens an editable modal */
  /* helpBtn handled inline — opens an iframe modal pointing at help.html */
  /* extensionsBtn handled inline — opens an iframe modal to the marketplace */
  bind('projectFolderBtn',  'pickProjectFolder');
  /* gitBtn — opens a Git modal that runs commands in the active project
     folder. If no project folder is set we pop a "please pick one" prompt
     instead of silently doing nothing. */
  (function() {
    const el = document.getElementById('gitBtn');
    if (!el) return;
    el.addEventListener('click', () => openGitModal());
  })();
  /* githubBtn — fetches the user's GitHub repos via the host (PAT from
     config.ini) and shows a themed modal. The old `openGitHub` post had no
     host handler and was a silent no-op. */
  (function() {
    const el = document.getElementById('githubBtn');
    if (!el) return;
    el.addEventListener('click', () => {
      if (!api) { addMsg('(stub) githubBtn clicked', 'info'); return; }
      showGitHubReposModal({ loading: true });
      api.postMessage({ type: 'listGitHubRepos' });
    });
  })();
})();

/* Font Size toggle — adds/removes .cb-big on <body>, which flips
   --cb-font-scale from 1 to 1.8 (80% bigger) via the rules at the top of
   <style>. Persists via the host's workspaceState as `cbe.bigFont`. */
(function() {
  const btn = document.getElementById('fontSizeBtn');
  if (!btn) return;
  function applyBig(b) {
    document.body.classList.toggle('cb-big', !!b);
    btn.classList.toggle('autoread', !!b);   /* reuse the existing "active" affordance */
  }
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('cb-big');
    applyBig(next);
    if (api) api.postMessage({ type: 'setBigFont', value: next });
  });
  window.__cbApplyBig = applyBig;            /* called from init hydration */
})();

/* ── Settings modal ──────────────────────────────────────────────────── */
let __cbeProviders = [];   /* {id,label,models[],current,haveKey} */
let __cbeActive = null;
let __cbeActiveSkin = '';  /* bare filename, e.g. 'noir.css'. '' = no skin */
let __cbeSkinsList  = null;/* null = not yet discovered for this session; [] = scanned, empty */

function applySkinUri(uri) {
  /* Swap the <link id="cbe-skin"> href. Empty/missing uri clears the
     stylesheet. Browsers handle href="" as a no-op load, so we set the
     href to empty string to unload the previous skin. */
  const link = document.getElementById('cbe-skin');
  if (!link) return;
  link.setAttribute('href', uri || '');
}

function applySkinColors(colors) {
  /* Push the modal palette from manifest.xml onto :root as --cbe-modal-*
     custom properties. Empty/missing values fall back to the defaults
     baked into the index.html :root block. Removing a previously-set
     property via removeProperty() (rather than setting it to '') lets
     the inline default win again when the user picks "None". */
  const root = document.documentElement;
  const map = {
    'modal-bg':         '--cbe-modal-bg',
    'modal-fg':         '--cbe-modal-fg',
    'modal-border':     '--cbe-modal-border',
    'modal-title-bg-1': '--cbe-modal-title-bg-1',
    'modal-title-bg-2': '--cbe-modal-title-bg-2',
    'modal-title-fg':   '--cbe-modal-title-fg',
    'modal-foot-bg':    '--cbe-modal-foot-bg',
    'modal-accent':     '--cbe-modal-accent',
    'highlight-color':  '--cbe-highlight-color',
  };
  for (const [k, cssVar] of Object.entries(map)) {
    const v = colors && colors[k];
    if (v) root.style.setProperty(cssVar, v);
    else   root.style.removeProperty(cssVar);
  }
}

/* ── Auto Prompt ─────────────────────────────────────────────────────────
   Modal-driven recurring prompt. User sets a Prompt + Send Interval (sec).
   If interval > 0, panel fires the configured prompt every N seconds via
   the same path a normal send goes through (ti.value = ...; send();). The
   button gets `is-autoprompting` while the interval is running so the
   blue spinner overlay shows. Interval and prompt persist in localStorage
   so reloading the panel keeps the same loop running. */
let __cbeAutoPromptTimer    = null;
let __cbeAutoPromptCountdown = null;
let __cbeAutoPromptText     = '';
let __cbeAutoPromptSecs     = 0;
let __cbeAutoPromptNextAt   = 0;  /* ms timestamp of the next scheduled fire */

function _cbeAutoPromptApplyUI(running) {
  const btn = document.getElementById('autoReplyBtn');
  if (btn) {
    btn.classList.toggle('is-autoprompting', !!running);
    btn.setAttribute('data-tooltip',
      running ? `Auto Prompt: every ${__cbeAutoPromptSecs}s (click to edit)`
              : 'Auto Prompt'
    );
  }
}

function _cbeAutoPromptUpdateCountdown() {
  const btn = document.getElementById('autoReplyBtn');
  if (!btn) return;
  const badge = btn.querySelector('.cbe-countdown');
  if (!badge) return;
  if (!__cbeAutoPromptTimer || !__cbeAutoPromptNextAt) {
    badge.textContent = '';
    return;
  }
  const remaining = Math.max(0, Math.ceil((__cbeAutoPromptNextAt - Date.now()) / 1000));
  badge.textContent = String(remaining);
}

function startAutoPrompt(text, secs) {
  stopAutoPrompt();
  if (!text || !text.trim() || !secs || secs <= 0) return;
  __cbeAutoPromptText  = text;
  __cbeAutoPromptSecs  = secs;
  __cbeAutoPromptNextAt = Date.now() + secs * 1000;
  __cbeAutoPromptTimer = setInterval(() => {
    /* Skip a tick if the panel is currently waiting for a reply — don't
       stack up requests if a previous one is still streaming. */
    if (typeof busy !== 'undefined' && busy) {
      /* still arm the next-at clock so the countdown stays honest. */
      __cbeAutoPromptNextAt = Date.now() + __cbeAutoPromptSecs * 1000;
      return;
    }
    try {
      ti.value = __cbeAutoPromptText;
      send();
    } catch (e) { /* swallow — the next tick will try again */ }
    __cbeAutoPromptNextAt = Date.now() + __cbeAutoPromptSecs * 1000;
  }, secs * 1000);
  /* 1s tick paints the countdown badge in --cbe-highlight-color. */
  __cbeAutoPromptCountdown = setInterval(_cbeAutoPromptUpdateCountdown, 1000);
  _cbeAutoPromptUpdateCountdown();
  _cbeAutoPromptApplyUI(true);
  try {
    localStorage.setItem('cbe.autoPrompt', JSON.stringify({ text, secs }));
  } catch (_) {}
}

function stopAutoPrompt() {
  if (__cbeAutoPromptTimer) {
    clearInterval(__cbeAutoPromptTimer);
    __cbeAutoPromptTimer = null;
  }
  if (__cbeAutoPromptCountdown) {
    clearInterval(__cbeAutoPromptCountdown);
    __cbeAutoPromptCountdown = null;
  }
  __cbeAutoPromptText  = '';
  __cbeAutoPromptSecs  = 0;
  __cbeAutoPromptNextAt = 0;
  _cbeAutoPromptUpdateCountdown();
  _cbeAutoPromptApplyUI(false);
  try { localStorage.removeItem('cbe.autoPrompt'); } catch (_) {}
}

function openAutoPromptModal() {
  const old = document.getElementById('cbe-autoprompt-modal');
  if (old) old.remove();
  playSfx('open_modal');
  /* Pre-fill from the running loop if any, else from saved settings. */
  let prefillText = __cbeAutoPromptText, prefillSecs = __cbeAutoPromptSecs;
  if (!prefillText && !prefillSecs) {
    try {
      const raw = localStorage.getItem('cbe.autoPrompt');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o.text === 'string')   prefillText = o.text;
        if (o && typeof o.secs === 'number')   prefillSecs = o.secs;
      }
    } catch (_) {}
  }
  const overlay = document.createElement('div');
  overlay.id = 'cbe-autoprompt-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
  overlay.innerHTML =
    '<div class="cbe-box" style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:520px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
      '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>Auto Prompt</span>' +
        '<button type="button" data-act="cancel" aria-label="Close" style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      '<div style="padding:16px 18px;display:flex;flex-direction:column;gap:12px;">' +
        '<label style="display:flex;flex-direction:column;gap:6px;font-size:13px;">Prompt' +
          `<textarea id="cbe-ap-text" rows="5" spellcheck="false" style="resize:vertical;font:13px/1.4 Consolas,monospace;background:rgba(0,0,0,.25);color:var(--cbe-modal-fg);border:1px solid var(--cbe-modal-border);border-radius:6px;padding:8px 10px;">${escapeHtml(prefillText)}</textarea>` +
        '</label>' +
        '<label style="display:flex;flex-direction:column;gap:6px;font-size:13px;">Send Interval (seconds — 0 to stop)' +
          `<input id="cbe-ap-secs" type="number" min="0" step="1" value="${Number(prefillSecs)||0}" style="font:14px/1 Consolas,monospace;background:rgba(0,0,0,.25);color:var(--cbe-modal-fg);border:1px solid var(--cbe-modal-border);border-radius:6px;padding:8px 10px;" />` +
        '</label>' +
      '</div>' +
      '<div class="cbe-foot" style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
        '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
        '<button type="button" data-act="save" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  function done() {
    try { overlay.remove(); } catch (_) {}
    document.removeEventListener('keydown', onKey, true);
    playSfx('close_modal');
  }
  function onKey(e) {
    if (e.key === 'Escape') done();
  }
  overlay.addEventListener('click', (e) => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'cancel' || e.target === overlay) return done();
    if (act === 'save') {
      const text = (overlay.querySelector('#cbe-ap-text').value || '').trim();
      const secs = Math.max(0, parseInt(overlay.querySelector('#cbe-ap-secs').value, 10) || 0);
      if (secs === 0 || !text) stopAutoPrompt();
      else startAutoPrompt(text, secs);
      done();
    }
  });
  document.addEventListener('keydown', onKey, true);
}

/* Resume a previously-running loop on panel load. */
(function resumeAutoPrompt() {
  try {
    const raw = localStorage.getItem('cbe.autoPrompt');
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && o.text && o.secs && o.secs > 0) {
      /* Defer until the textarea + send fn exist. */
      setTimeout(() => startAutoPrompt(o.text, o.secs), 500);
    }
  } catch (_) {}
})();

/* ── Git modal ───────────────────────────────────────────────────────────
   Two states:
     1. No project folder set → "Please select a project folder to use Git"
        with a Pick Folder button that posts pickProjectFolder.
     2. Project folder set → an input for a git command, a Run button,
        an output panel, and quick-action buttons for common commands. */
let __cbeGitProjectFolder = '';

function openGitModal() {
  const old = document.getElementById('cbe-git-modal');
  if (old) old.remove();
  playSfx('open_modal');
  const overlay = document.createElement('div');
  overlay.id = 'cbe-git-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
  if (!__cbeGitProjectFolder) {
    /* Empty-state modal — block until the user picks a folder. */
    overlay.innerHTML =
      '<div class="cbe-box" style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:480px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
          '<span>Git</span>' +
          '<button type="button" data-act="cancel" aria-label="Close" style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
        '</div>' +
        '<div style="padding:24px 22px;text-align:center;line-height:1.5;">' +
          '<div style="font-size:15px;margin-bottom:8px;">Please select a Project Folder to use Git.</div>' +
          '<div style="font-size:12px;opacity:.65;margin-bottom:20px;">Git commands run in the project folder you pick.</div>' +
          '<button type="button" data-act="pick" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:10px 24px;cursor:pointer;font-weight:600;font-size:13px;">Pick Project Folder…</button>' +
        '</div>' +
      '</div>';
  } else {
    overlay.innerHTML =
      '<div class="cbe-box" style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:760px;max-width:94vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
          `<span>Git <span style="font-weight:400;opacity:.75;font-size:12px;">· ${escapeHtml(__cbeGitProjectFolder)}</span></span>` +
          '<button type="button" data-act="cancel" aria-label="Close" style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
        '</div>' +
        '<div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;">' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:12px;">' +
            ['status', 'log --oneline -10', 'diff', 'branch', 'fetch', 'pull', 'push'].map(c =>
              `<button type="button" data-quick="${escapeHtml(c)}" style="background:rgba(255,255,255,.08);color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 10px;cursor:pointer;font-family:Consolas,monospace;font-size:11px;">git ${escapeHtml(c)}</button>`).join('') +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<span style="font-family:Consolas,monospace;opacity:.6;">git</span>' +
            '<input id="cbe-git-input" type="text" placeholder="status" autocomplete="off" spellcheck="false" style="flex:1;font:13px/1 Consolas,monospace;background:rgba(0,0,0,.25);color:var(--cbe-modal-fg);border:1px solid var(--cbe-modal-border);border-radius:6px;padding:8px 10px;outline:none;" />' +
            '<button type="button" data-act="run" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:8px 18px;cursor:pointer;font-weight:600;">Run</button>' +
          '</div>' +
          '<pre id="cbe-git-output" style="margin:0;padding:12px;background:rgba(0,0,0,.35);color:var(--cbe-modal-fg);font:12px/1.4 Consolas,monospace;border-radius:6px;min-height:220px;max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-word;">Type a git subcommand and press Enter, or click a quick-action above.</pre>' +
        '</div>' +
        '<div class="cbe-foot" style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<button type="button" data-act="pick" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;">Change Folder…</button>' +
          '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Close</button>' +
        '</div>' +
      '</div>';
  }
  document.body.appendChild(overlay);
  function done() {
    try { overlay.remove(); } catch (_) {}
    document.removeEventListener('keydown', onKey, true);
    playSfx('close_modal');
  }
  function onKey(e) {
    if (e.key === 'Escape') done();
  }
  function runArgs(argv) {
    const out = overlay.querySelector('#cbe-git-output');
    if (out) {
      out.textContent = '$ git ' + argv.join(' ') + '\n\n…running…';
      out.scrollTop = 0;
    }
    if (api) api.postMessage({ type: 'runGit', args: argv });
  }
  overlay.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    const act = t.getAttribute && t.getAttribute('data-act');
    const quick = t.getAttribute && t.getAttribute('data-quick');
    if (act === 'cancel' || t === overlay) return done();
    if (act === 'pick') {
      if (api) api.postMessage({ type: 'pickProjectFolder' });
      /* Don't close — when the user picks a folder, the projectFolder
         message comes back and we re-render the modal with the new state. */
      return;
    }
    if (act === 'run') {
      const input = overlay.querySelector('#cbe-git-input');
      const raw = (input && input.value || '').trim();
      if (!raw) return;
      runArgs(raw.split(/\s+/));
      return;
    }
    if (quick) {
      runArgs(String(quick).split(/\s+/));
    }
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'cbe-git-input') {
      e.preventDefault();
      const raw = (e.target.value || '').trim();
      if (raw) runArgs(raw.split(/\s+/));
    }
  });
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => { try { overlay.querySelector('#cbe-git-input').focus(); } catch (_) {} }, 30);
}

function showWakeModal(initialText) {
  /* Editor for wake.txt — the prompt fired when the model stalls. Themed
     via --cbe-modal-* so it matches whatever skin is active. Save writes
     back to disk via the `saveWake` host handler. */
  const old = document.getElementById('cbe-wake-modal');
  if (old) old.remove();
  playSfx('open_modal');
  const overlay = document.createElement('div');
  overlay.id = 'cbe-wake-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
  overlay.innerHTML =
    '<div class="cbe-box" style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:600px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
      '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>Wake-up Prompt <span style="opacity:.6;font-weight:400;font-size:12px;">· wake.txt</span></span>' +
        '<button type="button" data-act="cancel" aria-label="Close" style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      '<div style="padding:16px 18px;display:flex;flex-direction:column;gap:8px;">' +
        '<div style="font-size:12px;opacity:.7;">Sent to the model when a stream stalls. Leave blank to disable.</div>' +
        `<textarea id="cbe-wake-ta" rows="8" spellcheck="false" style="resize:vertical;font:13px/1.4 Consolas,monospace;background:rgba(0,0,0,.25);color:var(--cbe-modal-fg);border:1px solid var(--cbe-modal-border);border-radius:6px;padding:10px 12px;">${escapeHtml(initialText)}</textarea>` +
      '</div>' +
      '<div class="cbe-foot" style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
        '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
        '<button type="button" data-act="save" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  function done() {
    try { overlay.remove(); } catch (_) {}
    document.removeEventListener('keydown', onKey, true);
    playSfx('close_modal');
  }
  function onKey(e) {
    if (e.key === 'Escape') done();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const text = overlay.querySelector('#cbe-wake-ta').value || '';
      if (api) api.postMessage({ type: 'saveWake', text });
      done();
    }
  }
  overlay.addEventListener('click', (e) => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'cancel' || e.target === overlay) return done();
    if (act === 'save') {
      const text = overlay.querySelector('#cbe-wake-ta').value || '';
      if (api) api.postMessage({ type: 'saveWake', text });
      done();
    }
  });
  document.addEventListener('keydown', onKey, true);
  /* Focus the textarea so the user can start typing immediately. */
  setTimeout(() => { try { overlay.querySelector('#cbe-wake-ta').focus(); } catch (_) {} }, 30);
}

function showDomainsModal(payload) {
  /* Render a quick modal listing NameSilo domains + their nameservers. Uses
     the same overlay conventions as the settings modal so it picks up the
     active skin's styling automatically. */
  const old = document.getElementById('cbe-domains-modal');
  if (old) old.remove();
  playSfx('open_modal');
  const overlay = document.createElement('div');
  overlay.id = 'cbe-domains-modal';
  overlay.className = 'cbe-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';

  let bodyHtml;
  if (payload.error) {
    bodyHtml = `<div style="padding:20px;color:#ffb6b6;">${escapeHtml(payload.error)}</div>`;
  } else if (!payload.domains || !payload.domains.length) {
    bodyHtml = '<div style="padding:20px;color:#e8e8e8;">No domains on this NameSilo account.</div>';
  } else {
    const rows = payload.domains.map(d => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #2a2a2a;color:#ffd09e;font-family:Consolas,monospace;">${escapeHtml(d.name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #2a2a2a;color:#e8e8e8;font-family:Consolas,monospace;font-size:12px;">${(d.nameservers || []).map(escapeHtml).join('<br>')}</td>
      </tr>`).join('');
    bodyHtml = `
      <div style="padding:14px 18px;max-height:60vh;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr>
            <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #444;color:#ffb084;">Domain</th>
            <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #444;color:#ffb084;">Nameservers</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* Title bar shows count + cache freshness when the payload came from
     domains.txt; Reload button refreshes from the NameSilo API + rewrites
     the cache, then re-renders. */
  const countStr = payload.domains ? ` (${payload.domains.length})` : '';
  const cacheStr = payload.fromCache && payload.savedAt
    ? ` <span style="opacity:.6;font-weight:400;font-size:12px;">· cached ${escapeHtml(payload.savedAt.replace('T', ' ').slice(0, 16))}</span>`
    : '';
  overlay.innerHTML =
    '<div class="cbe-box" style="background:var(--cbe-modal-bg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:700px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
      '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        `<span>NameSilo Domains${countStr}${cacheStr}</span>` +
        '<button type="button" data-act="close" aria-label="Close" style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      bodyHtml +
      '<div class="cbe-foot" style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
        '<span id="cbe-domains-status" style="font-size:12px;opacity:.7;"></span>' +
        '<div style="display:flex;gap:8px;">' +
          '<button type="button" data-act="reload" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">Reload</button>' +
          '<button type="button" data-act="close" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'close' || e.target === overlay) {
      overlay.remove();
      playSfx('close_modal');
      return;
    }
    if (act === 'reload') {
      const status = overlay.querySelector('#cbe-domains-status');
      if (status) status.textContent = 'Reloading from NameSilo…';
      const btn = e.target;
      btn.disabled = true;
      btn.style.opacity = '.6';
      /* Posting force:true makes the host bypass domains.txt, hit the API,
         rewrite the cache, and post a fresh `domainsList`. Our handler
         then re-runs showDomainsModal which replaces this overlay. */
      if (api) api.postMessage({ type: 'listDomains', force: true });
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── GitHub Repos modal ──────────────────────────────────────────────────
   Mirrors showDomainsModal's overlay/skin variables so it themes with the
   active skin. payload shapes:
     { loading: true }                           // initial "Loading..." state
     { error: 'message' }                        // PAT missing / 401 / 403 / net
     { repos: [{ full_name, private, html_url,
                  description, updated_at,
                  language, stargazers_count }] }
*/
let __cbeGitHubFilter = '';
let __cbeGitHubSort   = { key: 'updated_at', dir: 'desc' };
let __cbeGitHubRepos  = [];

function showGitHubReposModal(payload) {
  const existing = document.getElementById('cbe-github-modal');
  if (existing) existing.remove();
  if (!existing) playSfx('open_modal');

  if (payload && Array.isArray(payload.repos)) {
    __cbeGitHubRepos = payload.repos.slice();
    __cbeGitHubFilter = '';
    __cbeGitHubSort = { key: 'updated_at', dir: 'desc' };
  }

  const overlay = document.createElement('div');
  overlay.id = 'cbe-github-modal';
  overlay.className = 'cbe-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';

  const titleCount = (payload && Array.isArray(payload.repos)) ? ` (${payload.repos.length})` : '';
  const bodyHost   = '<div id="cbe-github-body" style="padding:14px 18px;max-height:60vh;overflow:auto;"></div>';
  const searchBar  =
    '<div style="padding:10px 18px 0 18px;display:flex;gap:8px;align-items:center;">' +
      '<input id="cbe-github-search" type="text" placeholder="Filter repos..." ' +
        'style="flex:1;background:#1a1a1a;color:var(--cbe-modal-fg);border:1px solid var(--cbe-modal-border);' +
        'border-radius:6px;padding:6px 10px;font-family:Consolas,monospace;font-size:13px;outline:none;">' +
      '<span id="cbe-github-count" style="opacity:.65;font-size:12px;color:var(--cbe-modal-fg);"></span>' +
    '</div>';

  overlay.innerHTML =
    '<div class="cbe-box" style="background:var(--cbe-modal-bg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:900px;max-width:94vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
      '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        `<span>GitHub Repositories${titleCount}</span>` +
        '<button type="button" data-act="close" aria-label="Close" style="background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      searchBar +
      bodyHost +
      '<div class="cbe-foot" style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid var(--cbe-modal-border);display:flex;justify-content:flex-end;gap:8px;">' +
        '<button type="button" data-act="refresh" style="background:#3a3a3a;color:#e8e8e8;border:1px solid #555;border-radius:6px;padding:6px 14px;cursor:pointer;">Refresh</button>' +
        '<button type="button" data-act="close" style="background:#3a3a3a;color:#e8e8e8;border:1px solid #555;border-radius:6px;padding:6px 14px;cursor:pointer;">Close</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (e.target === overlay || act === 'close') {
      overlay.remove();
      playSfx('close_modal');
    } else if (act === 'refresh') {
      if (api) {
        renderGitHubModalBody({ loading: true });
        api.postMessage({ type: 'listGitHubRepos' });
      }
    } else {
      /* Header sort clicks */
      const th = e.target && e.target.closest && e.target.closest('th[data-sort]');
      if (th) {
        const k = th.getAttribute('data-sort');
        if (__cbeGitHubSort.key === k) {
          __cbeGitHubSort.dir = __cbeGitHubSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          __cbeGitHubSort = { key: k, dir: (k === 'full_name' || k === 'language') ? 'asc' : 'desc' };
        }
        renderGitHubModalBody();
        return;
      }
      /* Row link click — route through host for openExternal */
      const a = e.target && e.target.closest && e.target.closest('a[data-url]');
      if (a) {
        e.preventDefault();
        const url = a.getAttribute('data-url');
        if (api && url) api.postMessage({ type: 'openExternal', url });
      }
    }
  });

  const searchEl = overlay.querySelector('#cbe-github-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      __cbeGitHubFilter = searchEl.value || '';
      renderGitHubModalBody();
    });
  }

  renderGitHubModalBody(payload);
}

function renderGitHubModalBody(payload) {
  const host = document.getElementById('cbe-github-body');
  if (!host) return;
  const countEl = document.getElementById('cbe-github-count');

  if (payload && payload.loading) {
    host.innerHTML = '<div style="padding:20px;color:var(--cbe-modal-fg);opacity:.75;">Loading repositories…</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (payload && payload.error) {
    host.innerHTML = `<div style="padding:20px;color:#ffb6b6;white-space:pre-wrap;">${escapeHtml(payload.error)}</div>`;
    if (countEl) countEl.textContent = '';
    return;
  }
  if (!__cbeGitHubRepos.length) {
    host.innerHTML = '<div style="padding:20px;color:var(--cbe-modal-fg);">No repositories found on this account.</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const q = __cbeGitHubFilter.trim().toLowerCase();
  let rows = __cbeGitHubRepos.slice();
  if (q) {
    rows = rows.filter(r =>
      (r.full_name && r.full_name.toLowerCase().includes(q)) ||
      (r.description && r.description.toLowerCase().includes(q)) ||
      (r.language && r.language.toLowerCase().includes(q))
    );
  }
  const { key, dir } = __cbeGitHubSort;
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'stargazers_count') { va = va || 0; vb = vb || 0; return (va - vb) * mul; }
    if (key === 'updated_at') {
      const da = va ? new Date(va).getTime() : 0;
      const db = vb ? new Date(vb).getTime() : 0;
      return (da - db) * mul;
    }
    va = String(va == null ? '' : va).toLowerCase();
    vb = String(vb == null ? '' : vb).toLowerCase();
    return va < vb ? -1 * mul : va > vb ? 1 * mul : 0;
  });

  function arrow(k) { return key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''; }

  const fmtDate = (s) => {
    if (!s) return '';
    try { const d = new Date(s); if (isNaN(d.getTime())) return s; return d.toISOString().slice(0, 10); }
    catch (_) { return s; }
  };

  const accent = 'var(--cbe-modal-accent)';
  const border = 'var(--cbe-modal-border)';
  const trs = rows.map(r => {
    const isPriv = !!r.private;
    const badge = isPriv
      ? '<span style="display:inline-block;padding:1px 7px;border-radius:10px;background:#5a2a2a;color:#ffb6b6;font-size:11px;font-weight:600;">private</span>'
      : '<span style="display:inline-block;padding:1px 7px;border-radius:10px;background:#2a4a2a;color:#b6ffc4;font-size:11px;font-weight:600;">public</span>';
    return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid ${border};font-family:Consolas,monospace;">
          <a href="${escapeHtml(r.html_url || '#')}" data-url="${escapeHtml(r.html_url || '')}"
             style="color:${accent};text-decoration:none;font-weight:600;">${escapeHtml(r.full_name || '')}</a>
          ${r.description ? `<div style="opacity:.7;font-family:system-ui,sans-serif;font-size:11px;margin-top:2px;">${escapeHtml(r.description)}</div>` : ''}
        </td>
        <td style="padding:6px 12px;border-bottom:1px solid ${border};">${badge}</td>
        <td style="padding:6px 12px;border-bottom:1px solid ${border};text-align:right;font-family:Consolas,monospace;">${r.stargazers_count || 0}</td>
        <td style="padding:6px 12px;border-bottom:1px solid ${border};font-family:Consolas,monospace;font-size:12px;">${escapeHtml(r.language || '')}</td>
        <td style="padding:6px 12px;border-bottom:1px solid ${border};font-family:Consolas,monospace;font-size:12px;">${escapeHtml(fmtDate(r.updated_at))}</td>
      </tr>`;
  }).join('');

  const thStyle = `text-align:left;padding:8px 12px;border-bottom:2px solid ${border};color:${accent};cursor:pointer;user-select:none;`;
  host.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:var(--cbe-modal-fg);">
      <thead><tr>
        <th data-sort="full_name"        style="${thStyle}">Repository${arrow('full_name')}</th>
        <th data-sort="private"          style="${thStyle}">Visibility${arrow('private')}</th>
        <th data-sort="stargazers_count" style="${thStyle};text-align:right;">Stars${arrow('stargazers_count')}</th>
        <th data-sort="language"         style="${thStyle}">Language${arrow('language')}</th>
        <th data-sort="updated_at"       style="${thStyle}">Updated${arrow('updated_at')}</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
    ${rows.length === 0 && q ? `<div style="padding:14px 4px;opacity:.6;color:var(--cbe-modal-fg);">No repos match "${escapeHtml(q)}".</div>` : ''}
  `;
  if (countEl) {
    countEl.textContent = q
      ? `${rows.length} of ${__cbeGitHubRepos.length}`
      : `${__cbeGitHubRepos.length} repos`;
  }
}

function renderSkinDropdown() {
  /* If the settings modal is open, fill its skin <select>. Called both when
     the skins list arrives from the host and when settings re-opens with a
     fresh scan in flight. */
  const sel = document.getElementById('cbe-set-skin');
  if (!sel) return;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— None —';
  sel.appendChild(none);
  if (!__cbeSkinsList) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Loading skins…'; o.disabled = true;
    sel.appendChild(o);
    sel.value = '';
    return;
  }
  __cbeSkinsList.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name; o.textContent = s.label || s.name;
    o.dataset.uri = s.uri || '';
    /* Stash the modal palette as JSON in a data-attr so the live-preview
       on `change` can apply it without another host round-trip. */
    if (s.colors) {
      try { o.dataset.colors = JSON.stringify(s.colors); } catch (_) {}
    }
    sel.appendChild(o);
  });
  sel.value = __cbeActiveSkin || '';
}

function openSettings(payload) {
  __cbeProviders = payload.providers || [];
  __cbeActive    = payload.active || (__cbeProviders[0] && __cbeProviders[0].id);
  playSfx('open_modal');
  closeSettings(true);
  const overlay = document.createElement('div');
  overlay.id = 'cbe-settings';
  overlay.innerHTML = ''
    + '<div class="cbe-box">'
    +   '<div class="cbe-hdr"><span>Settings — Provider &amp; Model</span><button type="button" class="cbe-btn cbe-cancel cbe-x-svg" data-act="cancel" aria-label="Close"></button></div>'
    +   '<div class="cbe-body">'
    +     '<div><label>Provider</label><select id="cbe-set-provider"></select></div>'
    +     '<div><label>Model</label><select id="cbe-set-model"></select></div>'
    +     '<div class="cbe-warn" id="cbe-set-warn">No API key configured for this provider in config.ini.</div>'
    +     '<div><label>Skin</label><select id="cbe-set-skin"><option value="">Loading skins…</option></select></div>'
    +     '<div><label>Language</label><select id="cbe-set-language"></select></div>'
    +     '<div style="display:flex;align-items:center;gap:10px;margin-top:4px;">'
    +       '<label for="cbe-set-sfx-enabled" style="margin:0;flex:1;">Sound Effects</label>'
    +       '<input type="checkbox" id="cbe-set-sfx-enabled" style="width:auto;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +     '<div>'
    +       '<label for="cbe-set-sfx-volume">Volume <span id="cbe-set-sfx-volume-pct" style="opacity:.65;font-weight:400;">55%</span></label>'
    +       '<input type="range" id="cbe-set-sfx-volume" min="0" max="100" step="1" value="55" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +   '</div>'
    +   '<div class="cbe-foot">'
    +     '<button type="button" class="cbe-btn cbe-save"   id="cbe-set-login" data-act="login" style="display:none;background:#2a5d8f">Open login</button>'
    +     '<button type="button" class="cbe-btn cbe-cancel" data-act="cancel">Cancel</button>'
    +     '<button type="button" class="cbe-btn cbe-save"   data-act="save">Save</button>'
    +   '</div>'
    + '</div>';
  document.body.appendChild(overlay);

  const sel = overlay.querySelector('#cbe-set-provider');
  __cbeProviders.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    let suffix = '';
    if (p.superGrok) suffix = '  (SuperGrok)';
    else if (p.webBridge) suffix = '  (web)';
    else if (!p.haveKey) suffix = '  (no key)';
    o.textContent = p.label + suffix;
    sel.appendChild(o);
  });
  sel.value = __cbeActive;

  const renderModels = () => {
    const cur = sel.value;
    const prov = __cbeProviders.find(p => p.id === cur);
    const ms = overlay.querySelector('#cbe-set-model');
    ms.innerHTML = '';
    (prov.models || []).forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      ms.appendChild(o);
    });
    if (prov.current && !Array.from(ms.options).some(o => o.value === prov.current)) {
      const o = document.createElement('option');
      o.value = prov.current; o.textContent = prov.current;
      ms.insertBefore(o, ms.firstChild);
    }
    ms.value = prov.current || (prov.models && prov.models[0]) || '';
    /* For web-bridge / SuperGrok providers, the model is fixed and the
       missing-key warn shouldn't fire — instead show a hint and a Login
       button. The button label is provider-specific. */
    const warn = overlay.querySelector('#cbe-set-warn');
    const loginBtn = overlay.querySelector('#cbe-set-login');
    if (prov.webBridge || prov.superGrok) {
      warn.classList.remove('show');
      ms.disabled = true;
      loginBtn.style.display = 'inline-block';
      const niceName =
        prov.id === 'chatgptWeb'   ? 'ChatGPT'  :
        prov.id === 'grokWeb'      ? 'Grok'     :
        prov.id === 'geminiBridge' ? 'Gemini'   :
        prov.id === 'claudeBridge' ? 'Claude'   :
        prov.label;
      loginBtn.textContent = 'Open ' + niceName + ' login';
    } else {
      ms.disabled = false;
      loginBtn.style.display = 'none';
      warn.classList.toggle('show', !prov.haveKey);
    }
  };
  sel.addEventListener('change', renderModels);
  renderModels();

  /* Language dropdown — populated from payload.languages (built by the host
     from languages/*.xml). Each option is prefixed with the country's flag
     emoji; a real <select> can't hold <img> tags, and the regional-indicator
     emoji renders a flag everywhere without a custom dropdown widget. */
  (function populateLanguages() {
    const langSel = overlay.querySelector('#cbe-set-language');
    if (!langSel) return;
    const langs = Array.isArray(payload.languages) ? payload.languages : [];
    if (!langs.length) {
      langSel.innerHTML = '<option value="en">🇬🇧 English</option>';
      langSel.value = 'en';
      return;
    }
    langSel.innerHTML = '';
    langs.forEach((l) => {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = (l.flag ? l.flag + '  ' : '') + (l.name || l.code);
      langSel.appendChild(o);
    });
    langSel.value = payload.language || 'en';
    if (!langSel.value) langSel.value = 'en';
  })();

  /* Skin discovery: ask the host to scan /skins NOW (not at startup) so
     freshly-dropped-in skin files show up without restarting the panel.
     The host replies with `skinsList`; renderSkinDropdown() fills the
     <select>. Until then the placeholder option says "Loading skins…". */
  __cbeSkinsList = null;
  renderSkinDropdown();
  if (api) api.postMessage({ type: 'listSkins' });

  /* Live-preview skin choice while the dropdown is open. We swap the
     <link> href immediately on `change` so the user sees the effect;
     Cancel reverts to the saved skin, Save persists the new one. */
  const __cbeSavedSkinAtOpen = __cbeActiveSkin;
  const __cbeSavedSkinUriAtOpen = (document.getElementById('cbe-skin') || {}).href || '';
  /* Snapshot the live :root style overrides so Cancel can restore exactly
     what was set before the user started fiddling with the dropdown. */
  const __cbeSavedColorsAtOpen = (() => {
    const r = document.documentElement.style;
    return {
      'modal-bg':         r.getPropertyValue('--cbe-modal-bg'),
      'modal-fg':         r.getPropertyValue('--cbe-modal-fg'),
      'modal-border':     r.getPropertyValue('--cbe-modal-border'),
      'modal-title-bg-1': r.getPropertyValue('--cbe-modal-title-bg-1'),
      'modal-title-bg-2': r.getPropertyValue('--cbe-modal-title-bg-2'),
      'modal-title-fg':   r.getPropertyValue('--cbe-modal-title-fg'),
      'modal-foot-bg':    r.getPropertyValue('--cbe-modal-foot-bg'),
      'modal-accent':     r.getPropertyValue('--cbe-modal-accent'),
      'highlight-color':  r.getPropertyValue('--cbe-highlight-color'),
    };
  })();
  overlay.querySelector('#cbe-set-skin').addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    const uri = (opt && opt.dataset && opt.dataset.uri) || '';
    applySkinUri(uri);
    /* Live-preview the modal palette too — pulled out of dataset.colors
       (set by renderSkinDropdown when the host's listSkins reply arrived). */
    let colors = null;
    try { colors = opt && opt.dataset && opt.dataset.colors ? JSON.parse(opt.dataset.colors) : null; }
    catch (_) { colors = null; }
    applySkinColors(colors);
  });

  /* SFX controls. Hydrate from current window state, wire live preview so
     user hears the volume change while dragging the slider; persistence
     fires on Save. */
  const sfxEnabled = overlay.querySelector('#cbe-set-sfx-enabled');
  const sfxVolume  = overlay.querySelector('#cbe-set-sfx-volume');
  const sfxVolPct  = overlay.querySelector('#cbe-set-sfx-volume-pct');
  sfxEnabled.checked = !!window.SFX_ENABLED;
  sfxVolume.value    = String(Math.round((window.SFX_VOLUME || 0.55) * 100));
  sfxVolPct.textContent = `${sfxVolume.value}%`;
  sfxEnabled.addEventListener('change', () => setSfxEnabled(sfxEnabled.checked));
  sfxVolume.addEventListener('input', () => {
    const n = Number(sfxVolume.value);
    sfxVolPct.textContent = `${n}%`;
    setSfxVolume(n / 100);
  });
  sfxVolume.addEventListener('change', () => playSfx('click'));

  overlay.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'cancel' || e.target === overlay) {
      /* Revert live-previewed SFX + skin + modal-palette changes on cancel. */
      setSfxEnabled(__cbeSavedSfxEnabled);
      setSfxVolume(__cbeSavedSfxVolume);
      applySkinUri(__cbeSavedSkinUriAtOpen);
      applySkinColors(__cbeSavedColorsAtOpen);
      __cbeActiveSkin = __cbeSavedSkinAtOpen;
      closeSettings();
      return;
    }
    if (act === 'save') {
      const provider = overlay.querySelector('#cbe-set-provider').value;
      const model    = overlay.querySelector('#cbe-set-model').value;
      __cbeActiveProvider = provider;
      const sfxEnabledVal = !!sfxEnabled.checked;
      const sfxVolumeVal  = Number(sfxVolume.value) / 100;
      setSfxEnabled(sfxEnabledVal);
      setSfxVolume(sfxVolumeVal);
      __cbeSavedSfxEnabled = sfxEnabledVal;
      __cbeSavedSfxVolume  = sfxVolumeVal;
      const skinSel = overlay.querySelector('#cbe-set-skin');
      const skin    = (skinSel && skinSel.value) || '';
      __cbeActiveSkin = skin;
      const langSel = overlay.querySelector('#cbe-set-language');
      const language = (langSel && langSel.value) || 'en';
      if (api) api.postMessage({
        type: 'setProvider', provider, model,
        sfxEnabled: sfxEnabledVal, sfxVolume: sfxVolumeVal,
        skin, language,
      });
      closeSettings();
    }
    if (act === 'login') {
      const provider = overlay.querySelector('#cbe-set-provider').value;
      if (api) api.postMessage({ type: 'openWebLogin', provider });
    }
  });
  document.addEventListener('keydown', escClose, true);
}
/* Saved SFX state baseline so Cancel can revert live previews. Hydrated
   on `init` from the host's persisted workspaceState. */
let __cbeSavedSfxEnabled = true;
let __cbeSavedSfxVolume  = 0.55;
function escClose(e) { if (e.key === 'Escape') closeSettings(); }
function closeSettings(suppressSfx) {
  const old = document.getElementById('cbe-settings');
  if (old) {
    old.remove();
    if (!suppressSfx) playSfx('close_modal');
  }
  document.removeEventListener('keydown', escClose, true);
}

/* Tell host we're ready to receive init payload. */
if (api) api.postMessage({ type: 'ready' });

/* Sync the monitor button's blue glow with the actual supervisor state on
   every panel load + every 3 seconds after. Polls the supervisor's HTTP
   /status endpoint on :3434 — a 200 OK means the supervisor is alive and
   Code.exe is being watched. Without the periodic re-check the button
   would lie if the service was stopped externally (Task Manager, sc.exe
   stop, crash). 3s cadence matches the supervisor's own crash-watch loop. */
function _cbeRequestMonitorState() {
  if (api) api.postMessage({ type: 'monitorStatus' });
}
_cbeRequestMonitorState();
setInterval(_cbeRequestMonitorState, 3000);

/* Diagnostic: log the resolved font stack on #promptBox right after first
   paint so we can confirm the monospace lock actually computes through.
   This used to be a silent assumption — surfacing the values means future
   regressions show up immediately in the trace channel ("VSCode monitor"
   button). Result also lands in window.__cbeComputedPromptFont for any
   slash-command introspection. */
function _cbeReportPromptFont(reason) {
  try {
    const el = document.getElementById('promptBox');
    if (!el) return;
    const cs = getComputedStyle(el);
    const report = {
      reason,
      fontFamily: cs.fontFamily,
      fontSize:   cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      font:       cs.font,
    };
    window.__cbeComputedPromptFont = report;
    if (api) api.postMessage({ type: 'debugComputed', target: '#promptBox', report });
  } catch (e) { /* probe is best-effort */ }
}
/* Fire once on load, once after fonts settle (system fonts can change the
   resolved family slightly), and expose a window helper for ad-hoc checks. */
window.addEventListener('load', () => _cbeReportPromptFont('load'));
if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
  document.fonts.ready.then(() => _cbeReportPromptFont('fonts-ready'));
}
window.__cbeProbeFont = (sel) => {
  const el = sel ? document.querySelector(sel) : document.getElementById('promptBox');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { selector: sel || '#promptBox', fontFamily: cs.fontFamily, fontSize: cs.fontSize, font: cs.font };
};

/* ── Nuclear monospace lock ──────────────────────────────────────────────
   The CSS lock at maximum specificity STILL loses when a skin is loaded
   (skin's `.prompt-input { font-family: ... !important }` ties on importance
   and depending on source-order can win). Going inline-with-!important is
   the only rule no CSS sheet can override — inline style with !important
   beats every external rule regardless of specificity or origin. A
   MutationObserver re-applies it if anything (panel.js itself, a skin, a
   future agent) strips or mutates the style attribute. */
(function lockPromptFont() {
  /* Prefer VSCode's editor font — guaranteed available and monospace.
     Plain Consolas/Cascadia/Courier weren't actually loaded in the
     webview sandbox on this user's box; the generic-monospace fallback
     resolved to a proportional UA default. */
  const FAMILY = 'var(--vscode-editor-font-family, Consolas, "Cascadia Mono", "Courier New", monospace)';
  const FONT_SHORTHAND = '400 18px/1.34 ' + FAMILY;
  function apply(el) {
    if (!el) return;
    el.style.setProperty('font',        FONT_SHORTHAND, 'important');
    el.style.setProperty('font-family', FAMILY,         'important');
  }
  function attach() {
    const el = document.getElementById('promptBox');
    if (!el) return false;
    apply(el);
    /* If anything later overwrites the style attr — e.g. a skin re-flow or
       a future feature setting an inline color — re-apply our font. We
       gate to attribute mutations only, and only on `style`, so the
       observer is cheap. */
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'style') {
          const cur = el.style.getPropertyValue('font-family');
          if (!cur || cur.indexOf('Consolas') === -1) apply(el);
        }
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    /* Also re-apply once after fonts settle — `document.fonts.ready` can
       cause the UA to re-resolve fallback chains briefly. */
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(() => apply(el)).catch(() => {});
    }
    return true;
  }
  if (!attach()) {
    /* Element not in DOM yet — retry once on DOMContentLoaded. */
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
})();

/* Kick off Prism load in the background AFTER `ready` is posted, so it
   never blocks the boot path. Code blocks rendered before Prism arrives
   are re-highlighted by the one-shot pass inside `ensurePrismLoaded`. */
setTimeout(ensurePrismLoaded, 0);

/* ── Prompt history (Linux/PowerShell-style Up/Down recall) ───────────
   - Loaded from prompt_history.txt via the extension host on 'ready'.
   - Pushed back via 'pushPromptHistory' on every send so the file stays
     current across reloads. Capped at 500 lines on the host side.
   - Up moves backward (older); Down moves forward (newer). When the user
     reaches the bottom of history, a synthetic empty entry restores the
     in-progress text they had before they started scrolling. */
let __cbeHistory = [];
let __cbeHistoryIdx = -1;     // -1 = not in recall mode (showing live text)
let __cbeHistoryDraft = '';   // the text the user had before recalling

function historyEnterRecall() {
  if (__cbeHistoryIdx === -1) __cbeHistoryDraft = ti.value;
}
function historyApply(text) {
  ti.value = text;
  ti.dispatchEvent(new Event('input'));
  const end = ti.value.length;
  try { ti.setSelectionRange(end, end); } catch (e) { console.debug('[cbe.history] caret', e && e.message); }
}
function historyUp() {
  if (!__cbeHistory.length) return;
  historyEnterRecall();
  if (__cbeHistoryIdx === -1) __cbeHistoryIdx = __cbeHistory.length - 1;
  else if (__cbeHistoryIdx > 0) __cbeHistoryIdx -= 1;
  else return;
  historyApply(__cbeHistory[__cbeHistoryIdx]);
}
function historyDown() {
  if (__cbeHistoryIdx === -1) return;
  if (__cbeHistoryIdx < __cbeHistory.length - 1) {
    __cbeHistoryIdx += 1;
    historyApply(__cbeHistory[__cbeHistoryIdx]);
  } else {
    __cbeHistoryIdx = -1;
    historyApply(__cbeHistoryDraft);
  }
}
function historyReset() {
  __cbeHistoryIdx = -1;
  __cbeHistoryDraft = '';
}
function historyPush(text) {
  if (!text || !text.trim()) return;
  if (__cbeHistory.length && __cbeHistory[__cbeHistory.length - 1] === text) return;
  __cbeHistory.push(text);
  if (api) api.postMessage({ type: 'pushPromptHistory', text });
}

/* Cycle history only when the caret would otherwise have nothing to do —
   i.e. caret on the first line for Up, last line for Down. That way the
   user can still arrow-navigate inside a multi-line draft. */
function caretAtFirstLine() {
  const v = ti.value, s = ti.selectionStart || 0;
  return v.lastIndexOf('\n', s - 1) === -1;
}
function caretAtLastLine() {
  const v = ti.value, s = ti.selectionStart || 0;
  return v.indexOf('\n', s) === -1;
}

/* ── Saved prompts (prompts.txt — Left / Right cycle through entries) ──
   - Loaded from <extensionPath>/prompts.txt on 'ready' (and again every
     time the user reopens the file from the toolbar — extension watches
     for save and pushes a fresh list).
   - Left/Right cycle ONLY when the caret is at the absolute start (Left)
     or end (Right) of the textarea, so normal in-text caret navigation
     still works. Empty textarea: any Left/Right cycles.
   - Like the history feature, the user's in-progress draft is saved on
     first entry into cycle mode and restored when they cycle past the
     end. */
let __cbePrompts = [];
let __cbePromptIdx = -1;       // -1 = not in recall mode
let __cbePromptDraft = '';

function promptsEnterRecall() {
  if (__cbePromptIdx === -1) __cbePromptDraft = ti.value;
}
function promptsApply(text) {
  ti.value = text;
  ti.dispatchEvent(new Event('input'));
  const end = ti.value.length;
  try { ti.setSelectionRange(end, end); } catch (e) { console.debug('[cbe.prompts] caret', e && e.message); }
}
function promptsLeft() {
  if (!__cbePrompts.length) return;
  promptsEnterRecall();
  if (__cbePromptIdx === -1) __cbePromptIdx = __cbePrompts.length - 1;
  else if (__cbePromptIdx > 0) __cbePromptIdx -= 1;
  else return;
  promptsApply(__cbePrompts[__cbePromptIdx]);
}
function promptsRight() {
  if (!__cbePrompts.length) return;
  if (__cbePromptIdx === -1) {
    /* First Right from a clean state: jump to the first saved prompt. */
    promptsEnterRecall();
    __cbePromptIdx = 0;
    promptsApply(__cbePrompts[0]);
    return;
  }
  if (__cbePromptIdx < __cbePrompts.length - 1) {
    __cbePromptIdx += 1;
    promptsApply(__cbePrompts[__cbePromptIdx]);
  } else {
    __cbePromptIdx = -1;
    promptsApply(__cbePromptDraft);
  }
}
function promptsResetRecall() { __cbePromptIdx = -1; __cbePromptDraft = ''; }

/* ── Stored Prompts modal ─────────────────────────────────────────────────
   In-panel editor for prompts.txt. Combo box lists every saved entry
   (truncated to 60 chars), textarea shows the full content, footer has
   Add / Save / Delete / Use / Close. Save round-trips through the host
   which rewrites prompts.txt and broadcasts a fresh `prompts` list back
   so the modal (and __cbePrompts for arrow-recall) stay in sync. */
let __cbePromptsModalSelIdx = -1;  /* index into __cbePrompts; -1 = unsaved/new */

function _cbePromptShort(s) {
  const oneLine = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 60) return oneLine || '(empty)';
  return oneLine.slice(0, 60) + '…';
}

function openStoredPromptsModal() {
  if (document.getElementById('cbe-prompts-modal')) return;
  playSfx('open_modal');
  const modal = document.createElement('div');
  modal.id = 'cbe-prompts-modal';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Stored Prompts">
      <div class="cbe-hdr">
        <span>Stored Prompts</span>
        <button type="button" class="cbe-x-svg" aria-label="Close" title="Close (Esc)"></button>
      </div>
      <div class="cbe-body">
        <div>
          <label for="cbe-prompts-sel">Saved prompts</label>
          <select id="cbe-prompts-sel"></select>
        </div>
        <div style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0;">
          <label for="cbe-prompts-ta">Prompt text</label>
          <textarea id="cbe-prompts-ta" spellcheck="false" placeholder="Type a prompt, then Save to add it."></textarea>
        </div>
      </div>
      <div class="cbe-foot">
        <div class="cbe-foot-left">
          <button type="button" class="cbe-btn cbe-btn--add"    data-act="add">+ Add</button>
          <button type="button" class="cbe-btn cbe-btn--delete" data-act="delete">Delete</button>
          <span class="cbe-status" data-role="status"></span>
        </div>
        <div class="cbe-foot-right">
          <button type="button" class="cbe-btn cbe-btn--use"   data-act="use">Use</button>
          <button type="button" class="cbe-btn cbe-btn--close" data-act="close">Close</button>
          <button type="button" class="cbe-btn cbe-btn--save"  data-act="save">Save</button>
        </div>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) closeStoredPromptsModal(); });
  document.body.appendChild(modal);

  __cbePromptsModalSelIdx = __cbePrompts.length ? 0 : -1;
  renderStoredPromptsModal();

  const sel = modal.querySelector('#cbe-prompts-sel');
  const ta  = modal.querySelector('#cbe-prompts-ta');

  sel.addEventListener('change', () => {
    const v = parseInt(sel.value, 10);
    __cbePromptsModalSelIdx = isNaN(v) ? -1 : v;
    if (__cbePromptsModalSelIdx >= 0 && __cbePromptsModalSelIdx < __cbePrompts.length) {
      ta.value = __cbePrompts[__cbePromptsModalSelIdx] || '';
    } else {
      ta.value = '';
    }
    setStoredPromptsStatus('');
  });

  ta.addEventListener('input', () => setStoredPromptsStatus(''));

  modal.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      if (act === 'close') return closeStoredPromptsModal();
      if (act === 'add')    return storedPromptsAdd();
      if (act === 'save')   return storedPromptsSave();
      if (act === 'delete') return storedPromptsDelete();
      if (act === 'use')    return storedPromptsUse();
    });
  });
  modal.querySelector('.cbe-x-svg').addEventListener('click', closeStoredPromptsModal);
}

function renderStoredPromptsModal() {
  const modal = document.getElementById('cbe-prompts-modal');
  if (!modal) return;
  const sel = modal.querySelector('#cbe-prompts-sel');
  const ta  = modal.querySelector('#cbe-prompts-ta');
  if (!sel || !ta) return;

  /* Rebuild combo from __cbePrompts. Clamp selection if it went out of range. */
  sel.innerHTML = '';
  if (!__cbePrompts.length) {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = '(no saved prompts yet)';
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    __cbePromptsModalSelIdx = -1;
  } else {
    __cbePrompts.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i + 1}. ${_cbePromptShort(p)}`;
      sel.appendChild(opt);
    });
    if (__cbePromptsModalSelIdx < 0 || __cbePromptsModalSelIdx >= __cbePrompts.length) {
      __cbePromptsModalSelIdx = 0;
    }
    sel.value = String(__cbePromptsModalSelIdx);
    ta.value = __cbePrompts[__cbePromptsModalSelIdx] || '';
  }

  /* Disable Delete when nothing real is selected. */
  const delBtn = modal.querySelector('button[data-act="delete"]');
  if (delBtn) delBtn.disabled = (__cbePromptsModalSelIdx < 0 || !__cbePrompts.length);
}

function setStoredPromptsStatus(text) {
  const modal = document.getElementById('cbe-prompts-modal');
  if (!modal) return;
  const s = modal.querySelector('[data-role="status"]');
  if (s) s.textContent = text || '';
}

function storedPromptsAdd() {
  const modal = document.getElementById('cbe-prompts-modal');
  if (!modal) return;
  const ta = modal.querySelector('#cbe-prompts-ta');
  const sel = modal.querySelector('#cbe-prompts-sel');
  __cbePromptsModalSelIdx = -1;
  if (sel) {
    /* No real entry selected — show "(new)" option temporarily. */
    if (!sel.querySelector('option[value="-1"]')) {
      const opt = document.createElement('option');
      opt.value = '-1';
      opt.textContent = '(new prompt — unsaved)';
      sel.insertBefore(opt, sel.firstChild);
    }
    sel.value = '-1';
  }
  if (ta) { ta.value = ''; ta.focus(); }
  setStoredPromptsStatus('New prompt — type then Save.');
}

function storedPromptsSave() {
  const modal = document.getElementById('cbe-prompts-modal');
  if (!modal) return;
  const ta = modal.querySelector('#cbe-prompts-ta');
  const text = (ta && ta.value || '').replace(/^\s+|\s+$/g, '');
  if (!text) {
    setStoredPromptsStatus('Cannot save an empty prompt.');
    return;
  }
  const next = __cbePrompts.slice();
  if (__cbePromptsModalSelIdx >= 0 && __cbePromptsModalSelIdx < next.length) {
    next[__cbePromptsModalSelIdx] = text;
  } else {
    next.push(text);
    __cbePromptsModalSelIdx = next.length - 1;
  }
  __cbePrompts = next;
  promptsResetRecall();
  if (api) api.postMessage({ type: 'saveStoredPrompts', items: next });
  setStoredPromptsStatus('Saved.');
  renderStoredPromptsModal();
}

function storedPromptsDelete() {
  if (__cbePromptsModalSelIdx < 0 || __cbePromptsModalSelIdx >= __cbePrompts.length) return;
  const which = _cbePromptShort(__cbePrompts[__cbePromptsModalSelIdx]);
  /* Native confirm() is blocked in VSCode webviews — it returns undefined
     and the dialog never paints, so the user's click looked like a no-op.
     cbeConfirm() renders an in-panel overlay that works in the webview
     sandbox and themes via --cbe-modal-*. */
  cbeConfirm(`Delete this prompt?\n\n${which}`).then(ok => {
    if (!ok) { setStoredPromptsStatus('Cancelled.'); return; }
    if (__cbePromptsModalSelIdx < 0 || __cbePromptsModalSelIdx >= __cbePrompts.length) return;
    const next = __cbePrompts.slice();
    next.splice(__cbePromptsModalSelIdx, 1);
    __cbePrompts = next;
    promptsResetRecall();
    __cbePromptsModalSelIdx = next.length ? Math.min(__cbePromptsModalSelIdx, next.length - 1) : -1;
    if (api) api.postMessage({ type: 'saveStoredPrompts', items: next });
    setStoredPromptsStatus('Deleted.');
    renderStoredPromptsModal();
  });
}

function cbeConfirm(message) {
  /* Tiny replacement for window.confirm() that works inside a VSCode
     webview. Themed via the same --cbe-modal-* vars the rest of the
     modals use, so it matches the active skin. Returns a Promise<bool>. */
  return new Promise(resolve => {
    const old = document.getElementById('cbe-confirm');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cbe-confirm';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    overlay.innerHTML =
      '<div style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:420px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;">Confirm</div>' +
        '<div style="padding:16px 18px;white-space:pre-wrap;line-height:1.45;">' + escapeHtml(message) + '</div>' +
        '<div style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
          '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
          '<button type="button" data-act="ok" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">Delete</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function done(result) {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    }
    overlay.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') done(true);
      else if (act === 'cancel' || e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    /* Focus the cancel button by default so Enter doesn't auto-delete. */
    const cancelBtn = overlay.querySelector('button[data-act="cancel"]');
    if (cancelBtn) cancelBtn.focus();
  });
}

function storedPromptsUse() {
  const modal = document.getElementById('cbe-prompts-modal');
  if (!modal) return;
  const ta = modal.querySelector('#cbe-prompts-ta');
  const text = (ta && ta.value) || '';
  if (!text) { setStoredPromptsStatus('Nothing to use — textarea is empty.'); return; }
  ti.value = text;
  ti.dispatchEvent(new Event('input'));
  try { ti.setSelectionRange(text.length, text.length); } catch (e) { /* noop */ }
  closeStoredPromptsModal();
  ti.focus();
}

function closeStoredPromptsModal() {
  const m = document.getElementById('cbe-prompts-modal');
  if (m) {
    m.remove();
    playSfx('close_modal');
  }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-prompts-modal')) closeStoredPromptsModal();
});

function caretAtAbsoluteStart() {
  return (ti.selectionStart || 0) === 0 && (ti.selectionEnd || 0) === 0;
}
function caretAtAbsoluteEnd() {
  const len = ti.value.length;
  return (ti.selectionStart || 0) === len && (ti.selectionEnd || 0) === len;
}

ti.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
  if (e.key === 'ArrowUp'    && caretAtFirstLine())     { e.preventDefault(); historyUp();   return; }
  if (e.key === 'ArrowDown'  && caretAtLastLine())      { e.preventDefault(); historyDown(); return; }
  if (e.key === 'ArrowLeft'  && caretAtAbsoluteStart()) { e.preventDefault(); promptsLeft(); return; }
  if (e.key === 'ArrowRight' && caretAtAbsoluteEnd())   { e.preventDefault(); promptsRight(); return; }
});
ti.addEventListener('input', function() {
  this.style.height = '';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

/* ── Help modal — iframes help.html so its content can evolve without
   touching the panel's JS/CSS. Esc closes; clicking the backdrop closes. */
function openHelp() {
  let modal = document.getElementById('cbe-help-modal');
  if (modal) { modal.style.display = 'flex'; return; }
  modal = document.createElement('div');
  modal.id = 'cbe-help-modal';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Help">
      <div class="cbe-hdr">
        <span>Claude Codex — Black Edition · Help</span>
        <button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)"></button>
      </div>
      <iframe src="${window.__cbeUris.HELP_URI}" title="Help"></iframe>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) closeHelp(); });
  modal.querySelector('.cbe-x').addEventListener('click', closeHelp);
  document.body.appendChild(modal);
}
function closeHelp() {
  const m = document.getElementById('cbe-help-modal');
  if (m) m.remove();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-help-modal')) closeHelp();
});
document.getElementById('helpBtn').addEventListener('click', openHelp);

/* ── Extensions marketplace modal — iframes the server-hosted marketplace
   PHP. The page lists every available .ext bundle with an Install button;
   clicking Install postMessages `cbe.installExtension` up to this window,
   which we forward to the host (extension.js downloads the .ext + extracts
   it). The host echoes back `cbe.installResult` which we relay into the
   iframe so its button flips to "Installed". */
const CBE_MARKETPLACE_URL = 'https://trentontompkins.com/cbe/extension/extension_marketplace.php';
function openExtensionsMarketplace() {
  let modal = document.getElementById('cbe-ext-modal');
  if (modal) { modal.style.display = 'flex'; return; }
  modal = document.createElement('div');
  modal.id = 'cbe-ext-modal';
  /* Reuse the help modal's chrome classes so skins style it consistently. */
  modal.className = 'cbe-help-modal-shell';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Extensions Marketplace">
      <div class="cbe-hdr">
        <span>Extensions Marketplace</span>
        <button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)"></button>
      </div>
      <iframe src="${CBE_MARKETPLACE_URL}" title="Extensions Marketplace"
              sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
    </div>`;
  /* Match the help modal's fixed-overlay layout (in case the className
     above isn't styled by the active skin, set the essentials inline). */
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
  const box = modal.querySelector('.cbe-box');
  if (box) box.style.cssText = 'width:80vw;height:80vh;max-width:1100px;display:flex;' +
    'flex-direction:column;background:#1c1f24;border:1px solid #353a45;border-radius:8px;overflow:hidden;';
  const ifr = modal.querySelector('iframe');
  if (ifr) ifr.style.cssText = 'flex:1;width:100%;border:0;background:#16181d;';
  modal.addEventListener('click', e => { if (e.target === modal) closeExtensionsMarketplace(); });
  modal.querySelector('.cbe-x').addEventListener('click', closeExtensionsMarketplace);
  document.body.appendChild(modal);
}
function closeExtensionsMarketplace() {
  const m = document.getElementById('cbe-ext-modal');
  if (m) m.remove();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-ext-modal')) closeExtensionsMarketplace();
});
(function () {
  const el = document.getElementById('extensionsBtn');
  if (el) el.addEventListener('click', openExtensionsMarketplace);
})();
/* Bridge: the marketplace iframe → this panel → the host. */
window.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m && m.type === 'cbe.installExtension') {
    /* Forward the install request to the host. extension.js downloads the
       .ext file (HTTPS GET), MD5-verifies, extracts under extensions/. */
    if (api) api.postMessage({ type: 'installExtension', ext: m });
  } else if (m && m.type === 'cbe.installResultFromHost') {
    /* Host finished — relay the result into the iframe so its Install
       button flips to "✓ Installed" (or back to "Install" on failure). */
    const ifr = document.querySelector('#cbe-ext-modal iframe');
    if (ifr && ifr.contentWindow) {
      try { ifr.contentWindow.postMessage({ type: 'cbe.installResult', id: m.id, ok: m.ok, name: m.name }, '*'); } catch (_) {}
    }
  }
});

/* ── Handbook modal — editable; round-trips handbook.txt via the host.
   Click handbook tool button → loads handbook.txt → shows in a big
   monospace textarea → Save writes it back. Dirty/saved status shown
   in the footer. */
let __cbeHandbookText = '';
let __cbeHandbookDirty = false;
function openHandbook() {
  if (document.getElementById('cbe-handbook-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'cbe-handbook-modal';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Handbook">
      <div class="cbe-hdr">
        <span>Handbook (handbook.txt) — editable</span>
        <button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)"></button>
      </div>
      <textarea spellcheck="false" placeholder="Loading handbook…"></textarea>
      <div class="cbe-foot">
        <span class="status">Loading…</span>
        <div>
          <button class="cbe-btn cbe-btn--close" type="button">Close</button>
          <button class="cbe-btn cbe-btn--save"  type="button">Save</button>
        </div>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) closeHandbook(); });
  document.body.appendChild(modal);

  const ta     = modal.querySelector('textarea');
  const status = modal.querySelector('.status');
  const btnX   = modal.querySelector('.cbe-x');
  const btnClose = modal.querySelector('.cbe-btn--close');
  const btnSave  = modal.querySelector('.cbe-btn--save');

  function markClean() {
    __cbeHandbookDirty = false;
    status.textContent = 'Saved';
    status.classList.remove('dirty'); status.classList.add('saved');
  }
  function markDirty() {
    __cbeHandbookDirty = true;
    status.textContent = 'Unsaved changes';
    status.classList.remove('saved'); status.classList.add('dirty');
  }

  ta.addEventListener('input', () => { __cbeHandbookText = ta.value; markDirty(); });
  btnX.addEventListener('click', closeHandbook);
  btnClose.addEventListener('click', closeHandbook);
  btnSave.addEventListener('click', () => {
    __cbeHandbookText = ta.value;
    if (api) api.postMessage({ type: 'saveHandbook', text: __cbeHandbookText });
    markClean();
  });

  /* Ask host for the current handbook.txt content. */
  if (api) api.postMessage({ type: 'loadHandbook' });
  /* If we already have a cached copy, render it immediately. */
  if (__cbeHandbookText) {
    ta.value = __cbeHandbookText;
    markClean();
  } else {
    status.textContent = 'Loading…';
  }
}
function closeHandbook() {
  /* If unsaved, give a chance to keep editing. */
  if (__cbeHandbookDirty) {
    if (!confirm('Discard unsaved handbook changes?')) return;
  }
  const m = document.getElementById('cbe-handbook-modal');
  if (m) m.remove();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-handbook-modal')) closeHandbook();
});
document.getElementById('handbookBtn').addEventListener('click', openHandbook);

/* ── Slash-command menu ───────────────────────────────────────────────────
   - Typing "/" at the start of the input opens the menu and filters as the
     user keeps typing.
   - Clicking the Show Commands toolbar button also opens it.
   - Up/Down navigate, Enter runs, Esc closes. */
const CBE_COMMANDS = [
  { name: '/help',     desc: 'Open help',                run: () => openHelp() },
  { name: '/handbook', desc: 'Open handbook',            run: () => openHandbook() },
  { name: '/clear',    desc: 'New conversation',         run: () => addBtn.click() },
  { name: '/settings', desc: 'Open settings',            run: () => { if (api) api.postMessage({ type: 'openSettings' }); } },
  { name: '/prompts',  desc: 'Edit saved prompts',       run: () => { if (api) api.postMessage({ type: 'openPromptsFile' }); } },
  { name: '/history',  desc: 'Browse chat history',      run: () => { if (api) api.postMessage({ type: 'openChatHistory' }); } },
  { name: '/font',     desc: 'Toggle big font',          run: () => document.getElementById('fontSizeBtn').click() },
  { name: '/attach',   desc: 'Attach a file',            run: () => document.getElementById('attachFileBtn').click() },
  { name: '/folder',   desc: 'Pick project folder',      run: () => document.getElementById('projectFolderBtn').click() },
  { name: '/compact',  desc: 'Compact conversation',     run: () => { if (api) api.postMessage({ type: 'compactConversation' }); } },
  { name: '/git',      desc: 'Source control',           run: () => { if (api) api.postMessage({ type: 'openGit' }); } },
  { name: '/github',   desc: 'List GitHub repos',        run: () => { const b = document.getElementById('githubBtn'); if (b) b.click(); } },
  { name: '/license',  desc: 'Show the MIT license',     run: () => { if (api) api.postMessage({ type: 'showLicense' }); } },
  { name: '/push',     desc: 'Push files to server (auto-update)', run: () => { if (api) api.postMessage({ type: 'pushUpdate' }); } },
];

let __cbeCmdMenuEl    = null;
let __cbeCmdMenuFocus = 0;
let __cbeCmdMenuFromSlash = false;  // true when triggered by typing "/"

function cbeCmdFilter() {
  const v = ti.value || '';
  if (!__cbeCmdMenuFromSlash) return CBE_COMMANDS;
  const q = v.replace(/^\//, '').toLowerCase().trim();
  if (!q) return CBE_COMMANDS;
  return CBE_COMMANDS.filter(c => c.name.slice(1).toLowerCase().includes(q) ||
                                  c.desc.toLowerCase().includes(q));
}
function cbeRenderCmdMenu() {
  if (!__cbeCmdMenuEl) return;
  const items = cbeCmdFilter();
  if (__cbeCmdMenuFocus >= items.length) __cbeCmdMenuFocus = Math.max(0, items.length - 1);
  __cbeCmdMenuEl.innerHTML = '';
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'cbe-empty';
    e.textContent = 'no matching commands';
    __cbeCmdMenuEl.appendChild(e);
    return;
  }
  items.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'cbe-cmd' + (idx === __cbeCmdMenuFocus ? ' is-focus' : '');
    row.innerHTML = `<span class="name">${c.name}</span><span class="desc">${c.desc}</span>`;
    row.addEventListener('mouseenter', () => { __cbeCmdMenuFocus = idx; cbeRenderCmdMenu(); });
    /* Use mousedown (not click) + preventDefault so the textarea keeps focus
       — without preventDefault, clicking the menu shifts focus to the row,
       the textarea blurs, and the subsequent `ti.value = ...` lands on an
       unfocused element. mousedown also fires before the document-level
       outside-click handler, eliminating any race where the menu DOM is
       removed mid-click. */
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cbeRunCmdAt(idx);
    });
    __cbeCmdMenuEl.appendChild(row);
  });
}
function cbePositionCmdMenu() {
  if (!__cbeCmdMenuEl) return;
  const rect = ti.getBoundingClientRect();
  __cbeCmdMenuEl.style.left = rect.left + 'px';
  __cbeCmdMenuEl.style.minWidth = Math.min(rect.width, 420) + 'px';
  /* Position ABOVE the input — anchor the bottom to input's top. */
  __cbeCmdMenuEl.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  __cbeCmdMenuEl.style.top = 'auto';
}
function cbeOpenCmdMenu(fromSlash) {
  if (__cbeCmdMenuEl) { cbeRenderCmdMenu(); cbePositionCmdMenu(); return; }
  __cbeCmdMenuFromSlash = !!fromSlash;
  __cbeCmdMenuFocus = 0;
  __cbeCmdMenuEl = document.createElement('div');
  __cbeCmdMenuEl.id = 'cbe-cmd-menu';
  document.body.appendChild(__cbeCmdMenuEl);
  cbeRenderCmdMenu();
  cbePositionCmdMenu();
}
function cbeCloseCmdMenu() {
  if (__cbeCmdMenuEl) { __cbeCmdMenuEl.remove(); __cbeCmdMenuEl = null; }
  __cbeCmdMenuFromSlash = false;
}
function cbeRunCmdAt(idx) {
  const items = cbeCmdFilter();
  const c = items[idx];
  if (!c) return;
  /* When the menu was opened via the toolbar button (not by typing "/"),
     a click PUTS the command name into the prompt box instead of running
     it — that way the user can edit/append arguments before pressing
     Enter. The slash-trigger path keeps the old "run immediately" UX so
     typing "/help<Enter>" still fires help instantly. */
  if (!__cbeCmdMenuFromSlash) {
    cbeCloseCmdMenu();
    try {
      /* Suppress the slash auto-open. Setting ti.value to "/foo " and
         dispatching input would normally re-trigger the menu (because the
         text starts with `/`) — the input handler checks this flag and
         bails when set. Reset on the next tick so subsequent real typing
         still triggers normally. */
      window.__cbeSuppressSlashTrigger = true;
      ti.value = c.name + ' ';
      ti.focus();
      ti.dispatchEvent(new Event('input'));
      const end = ti.value.length;
      ti.setSelectionRange(end, end);
      setTimeout(() => { window.__cbeSuppressSlashTrigger = false; }, 0);
    } catch (e) { console.debug('[cbe.cmd] insert', c.name, e && e.message); }
    return;
  }
  /* Slash-triggered path — clear the slash trigger and run the command. */
  ti.value = '';
  ti.dispatchEvent(new Event('input'));
  cbeCloseCmdMenu();
  try { c.run(); } catch (e) { console.debug('[cbe.cmd] run', c.name, e && e.message); }
}

/* Slash trigger — only when the input is empty or contains only the slash
   prefix (i.e. the user is typing a command, not regular text). The
   __cbeSuppressSlashTrigger flag short-circuits when cbeRunCmdAt INSERTED
   a slash-command into the textarea programmatically (we don't want to
   re-open the menu immediately after the user just picked an item). */
ti.addEventListener('input', () => {
  if (window.__cbeSuppressSlashTrigger) return;
  const v = ti.value || '';
  const isCommandTyping = v.startsWith('/') && !v.includes('\n');
  if (isCommandTyping && !__cbeCmdMenuEl) cbeOpenCmdMenu(true);
  if (__cbeCmdMenuEl) {
    if (!isCommandTyping && __cbeCmdMenuFromSlash) cbeCloseCmdMenu();
    else { cbeRenderCmdMenu(); cbePositionCmdMenu(); }
  }
});
window.addEventListener('resize', cbePositionCmdMenu);
window.addEventListener('scroll', cbePositionCmdMenu, true);

/* Toolbar button trigger. Also re-bind in place of the bind() stub. */
document.getElementById('showCommandsBtn').addEventListener('click', () => {
  if (__cbeCmdMenuEl) cbeCloseCmdMenu();
  else { ti.focus(); cbeOpenCmdMenu(false); }
});

/* Capture-phase keydown so we can intercept Up/Down/Enter/Esc BEFORE the
   send / history / prompts handlers run when the menu is open. */
ti.addEventListener('keydown', e => {
  if (!__cbeCmdMenuEl) return;
  const items = cbeCmdFilter();
  if (e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    __cbeCmdMenuFocus = (__cbeCmdMenuFocus + 1) % Math.max(1, items.length);
    cbeRenderCmdMenu();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    __cbeCmdMenuFocus = (__cbeCmdMenuFocus - 1 + items.length) % Math.max(1, items.length);
    cbeRenderCmdMenu();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    cbeRunCmdAt(__cbeCmdMenuFocus);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    cbeCloseCmdMenu();
    return;
  }
}, true);

/* Click outside closes the menu. */
document.addEventListener('mousedown', e => {
  if (!__cbeCmdMenuEl) return;
  if (__cbeCmdMenuEl.contains(e.target) || ti.contains(e.target)) return;
  if (document.getElementById('showCommandsBtn').contains(e.target)) return;
  cbeCloseCmdMenu();
});

/* Replace the now-unused bind() stub for showCommandsBtn. */

/* Map provider id → SFX cue. anthropic→claude, openai→gtp, google/gemini→gemini,
   anything else → 'popup' fallback so the user still gets an audible "the
   model is replying" signal. */
function providerSfxName(id) {
  if (!id) return 'popup';
  if (id === 'anthropic' || id === 'claudeBridge') return 'claude';
  if (id === 'openai'    || id === 'chatgptWeb')   return 'gtp';
  if (id === 'gemini'    || id === 'geminiBridge' || id === 'google') return 'gemini';
  return 'popup';
}

window.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'assistantStart') {
    streamingEl = addMsg('', 'assistant streaming');
    __cbeChunkStarted = false;
  } else if (m.type === 'chunk') {
    if (!streamingEl) streamingEl = addMsg('', 'assistant streaming');
    if (!__cbeChunkStarted) {
      __cbeChunkStarted = true;
      playSfx(providerSfxName(__cbeActiveProvider));
    }
    streamingEl.textContent += (m.text || '');
    thread.scrollTop = thread.scrollHeight;
  } else if (m.type === 'assistantDone') {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      const fullText = (typeof m.text === 'string' && m.text)
        ? m.text
        : (streamingEl.textContent || '');
      try {
        renderAssistantMarkdown(streamingEl, fullText);
      } catch (e) {
        /* Rendering failed — fall back to plain text so the user still sees the reply. */
        streamingEl.textContent = fullText;
      }
      streamingEl = null;
      try { tts.onAssistantDone(fullText); } catch (e) { console.debug('[cbe.tts] onAssistantDone', e && e.message); }
      if (api && fullText) api.postMessage({ type: 'logChatTurn', role: 'ASSISTANT', text: fullText });
      /* Notification ping — fires when a new assistant message fully
         arrives (Slack/iMessage-style). Provider-specific cue already
         fires on the FIRST chunk; this one signals completion so the
         user knows the reply is ready to read. */
      playSfx('popup');
    }
    setBusy(false);
    ti.focus();
  } else if (m.type === 'error') {
    if (streamingEl) { streamingEl.classList.remove('streaming'); streamingEl = null; }
    addMsg('⚠ ' + (m.message || 'error'), 'error');
    setBusy(false);
  } else if (m.type === 'info') {
    addMsg(m.text || '', 'info');
  } else if (m.type === 'init') {
    /* Cache provider state for later; don't open modal yet. */
    __cbeProviders = m.providers || [];
    __cbeActive    = m.active;
    __cbeActiveProvider = m.active;
    /* Hydrate persisted SFX settings; window defaults apply if absent. */
    if (typeof m.sfxEnabled === 'boolean') { setSfxEnabled(m.sfxEnabled); __cbeSavedSfxEnabled = m.sfxEnabled; }
    if (typeof m.sfxVolume  === 'number')  { setSfxVolume(m.sfxVolume);   __cbeSavedSfxVolume  = m.sfxVolume; }
    if (typeof m.bigFont    === 'boolean' && window.__cbApplyBig) { window.__cbApplyBig(m.bigFont); }
    /* Apply previously-saved skin on boot. m.skinUri is the asWebviewUri()
       form ready for <link href>; m.skin is the bare filename used to mark
       the dropdown selection when settings opens. */
    if (typeof m.skin === 'string') __cbeActiveSkin = m.skin;
    if (m.skinUri) applySkinUri(m.skinUri);
    applySkinColors(m.skinColors || null);
    if (!__cbeOpenAppPlayed) {
      __cbeOpenAppPlayed = true;
      playSfx('open_and_close_application');
    }
  } else if (m.type === 'applySkin') {
    /* Host-driven skin swap. m.skin = bare filename ('' to clear),
       m.skinUri = full webview URI ('' to clear),
       m.skinColors = modal palette from manifest (null to fall back to defaults). */
    __cbeActiveSkin = m.skin || '';
    applySkinUri(m.skinUri || '');
    applySkinColors(m.skinColors || null);
  } else if (m.type === 'skinsList') {
    /* Lazy-discovered skin list — populates the dropdown if settings is open. */
    __cbeSkinsList = Array.isArray(m.skins) ? m.skins.slice() : [];
    renderSkinDropdown();
  } else if (m.type === 'contextUsage') {
    /* Update the Compact button's conic-gradient fill ring. Host estimates
       tokens-used / max-context and posts the ratio after every assistant
       turn + after a compact. Above 75% the ring shifts red. */
    const btn = document.getElementById('compactBtn');
    if (btn) {
      const r = Math.max(0, Math.min(1, Number(m.ratio) || 0));
      btn.style.setProperty('--cbe-ctx-ratio', String(r));
      btn.classList.toggle('has-ctx-ratio', r > 0.01);
      btn.classList.toggle('ctx-warn', r > 0.75);
      const pct = Math.round(r * 100);
      const tok = (m.tokens || 0).toLocaleString();
      const max = (m.max || 0).toLocaleString();
      btn.setAttribute('data-tooltip', `Compact conversation · context ${pct}% (${tok} / ${max} tokens)`);
    }
  } else if (m.type === 'wakeText') {
    /* Host returned the contents of wake.txt — open the editor modal. */
    showWakeModal(m.text || '');
  } else if (m.type === 'domainsList') {
    /* NameSilo domain listing — cache for instant re-open, and render
       a modal table now. The host fires this once at startup
       (prefetched=true) and again on every click; in both cases we
       refresh the cache so subsequent clicks are instant. The modal
       is rendered for explicit clicks (no prefetched flag) AND when
       a refresh comes in while a modal is already on screen. */
    window.__cbeDomainsCache = m;
    const modalOpen = !!document.getElementById('cbe-domains-modal');
    if (!m.prefetched || modalOpen) showDomainsModal(m);
  } else if (m.type === 'githubReposList') {
    /* GitHub repos from the host — show or refresh the modal. */
    showGitHubReposModal(m);
  } else if (m.type === 'monitorState') {
    /* Supervisor service running/stopped. The poll may turn the ring ON when
       the service is genuinely healthy, but it must NEVER turn it OFF while
       the user has clicked it on (`__cbeMonitorForcedOn`) — otherwise the
       optimistic blue circle gets wiped within one 3s poll cycle. */
    const btn = document.getElementById('monitorBtn');
    if (btn) {
      if (m.running) {
        btn.classList.add('is-monitoring');
        cbeShowMonitorSpinner(true);
      } else if (!window.__cbeMonitorForcedOn) {
        btn.classList.remove('is-monitoring');
        cbeShowMonitorSpinner(false);
      }
      btn.setAttribute('data-tooltip',
        m.running ? 'VSCode supervisor: RUNNING (left-click to stop · right-click for trace)'
                  : 'VSCode supervisor: stopped (left-click to start · right-click for trace)');
    }
  } else if (m.type === 'openSettings') {
    __cbeActiveProvider = m.active || __cbeActiveProvider;
    openSettings(m);
  } else if (m.type === 'promptHistory') {
    __cbeHistory = Array.isArray(m.items) ? m.items.slice() : [];
    historyReset();
  } else if (m.type === 'projectFolder') {
    setProjectFolder(m.path || '');
    __cbeGitProjectFolder = m.path || '';
    /* If the Git modal is open and the user just picked a folder via its
       Pick button, re-render so the empty-state turns into the command UI. */
    if (document.getElementById('cbe-git-modal') && __cbeGitProjectFolder) {
      openGitModal();
    }
  } else if (m.type === 'gitResult') {
    /* Result from `runGit` — paint into the output pane if the modal is open. */
    const out = document.getElementById('cbe-git-output');
    if (out) {
      if (m.error) {
        out.textContent = 'ERROR: ' + m.error;
      } else {
        const head = '$ git ' + (m.argv || []).join(' ') + (m.rc !== undefined ? `\n[exit ${m.rc}]` : '') + '\n\n';
        out.textContent = head + (m.stdout || '') + (m.stderr ? '\n--- stderr ---\n' + m.stderr : '');
      }
      out.scrollTop = 0;
    }
  } else if (m.type === 'prompts') {
    __cbePrompts = Array.isArray(m.items) ? m.items.slice() : [];
    promptsResetRecall();
    /* If the Stored Prompts modal is open, re-render so it reflects the
       fresh list (e.g. after a save round-trip from the host, or after the
       user edited prompts.txt directly via the /prompts slash-command). */
    if (document.getElementById('cbe-prompts-modal')) {
      renderStoredPromptsModal();
    }
  } else if (m.type === 'handbook') {
    __cbeHandbookText = String(m.text || '');
    const modal = document.getElementById('cbe-handbook-modal');
    if (modal) {
      const ta = modal.querySelector('textarea');
      const status = modal.querySelector('.status');
      if (ta) ta.value = __cbeHandbookText;
      if (status) { status.textContent = 'Saved'; status.classList.remove('dirty'); status.classList.add('saved'); }
      __cbeHandbookDirty = false;
    }
  } else if (m.type === 'autoPrompt') {
    /* One-time session-start prompt from the host (project dir tree +
       handbook). Send it to the model WITHOUT displaying anything in the
       chat — the payload is 16+ KB of tree output and ugly to look at.
       The model's reply still appears normally. If the user has already
       started typing, skip entirely so we don't disturb their draft. */
    if (m.text) {
      if (ti.value && ti.value.trim().length) {
        console.debug('[cbe.autoCtx] skipped, user already drafting');
      } else if (api) {
        api.postMessage({ type: 'sendText', text: m.text });
        api.postMessage({ type: 'logChatTurn', role: 'USER', text: m.text });
        setBusy(true);
      }
    }
  } else if (m.type === 'attachFile') {
    /* Queue the file as a chip below the input. send() will splice the
       file content into the outgoing prompt at submit time. */
    pushAttachment({
      name:  m.name || 'attachment',
      ext:   (m.ext || '').toLowerCase(),
      text:  m.text || '',
      path:  m.path || '',
      bytes: m.bytes || 0,
    });
  }
});

/* ── Attachments (file chips queued below the input) ───────────────────
   The host's attachFile picker posts back the file content; we keep an
   in-memory queue of { name, ext, text, path, bytes }. Each chip renders
   the filename + size + a red − to remove. On send(), every queued
   attachment is spliced into the outgoing prompt as a fenced code block
   prefixed with 📎 filename, then the queue is cleared. */
let __cbeAttachments = [];
const __cbeAttachmentsEl = document.getElementById('attachments');

function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
function renderAttachments() {
  if (!__cbeAttachmentsEl) return;
  __cbeAttachmentsEl.innerHTML = '';
  __cbeAttachments.forEach((a, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.title = a.path || a.name;

    const nameEl = document.createElement('span');
    nameEl.className = 'attach-name';
    nameEl.textContent = '📎 ' + a.name;
    chip.appendChild(nameEl);

    if (a.bytes) {
      const sz = document.createElement('span');
      sz.className = 'attach-size';
      sz.textContent = fmtBytes(a.bytes);
      chip.appendChild(sz);
    }

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.title = 'Remove attachment';
    rm.setAttribute('aria-label', 'Remove ' + a.name);
    rm.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">' +
        '<path d="M5 12h14" stroke="#ff3838" stroke-width="3" stroke-linecap="round" ' +
              'style="filter: drop-shadow(0 0 2px rgba(255,56,56,0.6));"/>' +
      '</svg>';
    rm.addEventListener('click', () => removeAttachment(idx));
    chip.appendChild(rm);

    __cbeAttachmentsEl.appendChild(chip);
  });
}
function pushAttachment(a) {
  __cbeAttachments.push(a);
  renderAttachments();
}
function removeAttachment(idx) {
  __cbeAttachments.splice(idx, 1);
  renderAttachments();
}
function clearAttachments() {
  __cbeAttachments = [];
  renderAttachments();
}
function buildAttachmentBlocks() {
  if (!__cbeAttachments.length) return '';
  const parts = ['']; /* leading blank line */
  for (const a of __cbeAttachments) {
    const lang = a.ext || '';
    parts.push(`📎 ${a.name}`);
    parts.push('```' + lang);
    parts.push(a.text);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n');
}

/* ── Project folder pill ────────────────────────────────────────────────
   Display only — the actual picker lives in extension.js, triggered by
   the projectFolderBtn click. We get back a 'projectFolder' message with
   the chosen fsPath and render it middle-truncated so it never widens
   the toolbar. Re-fits on window resize.
   Example: C:\Users\moren\Desktop\very long path → C:\Users\mo....\Desktop */
let __cbeProjectFolder = '';
const __cbeProjectEl = document.getElementById('project-path');

function fitProjectPath() {
  if (!__cbeProjectEl || !__cbeProjectFolder) return;
  const el  = __cbeProjectEl;
  const sep = __cbeProjectFolder.includes('\\') ? '\\' : '/';
  el.textContent = __cbeProjectFolder;
  if (el.scrollWidth <= el.clientWidth) return;
  /* Keep the last 2 path segments as the "tail" (parent dir + leaf) so the
     user still sees what folder they're in; shrink the head from the end,
     prepending "...." until it fits. */
  const parts = __cbeProjectFolder.split(/[\\/]/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0]) ? parts.shift() + sep : '';
  if (parts.length < 3) return;
  let tail = sep + parts.slice(-2).join(sep);
  let head = drive + parts.slice(0, -2).join(sep);
  el.textContent = head + '....' + tail;
  while (el.scrollWidth > el.clientWidth && head.length > 0) {
    head = head.slice(0, -1);
    el.textContent = head + '....' + tail;
  }
  /* Final safety net — if even the tail overflows, hard-clip from the left. */
  while (el.scrollWidth > el.clientWidth && tail.length > 4) {
    tail = tail.slice(1);
    el.textContent = '....' + tail;
  }
}
function setProjectFolder(p) {
  __cbeProjectFolder = p || '';
  /* Mirror for the Git modal — it makes its empty-state vs run-state
     decision from this variable. Keeping them in sync here means the
     button works correctly on the very first click after panel boot. */
  __cbeGitProjectFolder = p || '';
  if (!__cbeProjectEl) return;
  if (!__cbeProjectFolder) {
    __cbeProjectEl.textContent = '';
    __cbeProjectEl.title = '';
    __cbeProjectEl.setAttribute('data-tooltip', 'No project folder — click the folder button to pick one');
    return;
  }
  __cbeProjectEl.title = __cbeProjectFolder;
  __cbeProjectEl.setAttribute('data-tooltip', __cbeProjectFolder);
  fitProjectPath();
}
window.addEventListener('resize', fitProjectPath);

/* ────────────────────────────────────────────────────────────────────────
   Data-tooltip overlay (GPT's prompt-bar design uses #tooltip + data-tooltip
   attrs instead of native title=). One delegated mouseover handler positions
   the floating tooltip near the cursor; mouseleave hides it. */
(function(){
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  function show(text, x, y) {
    if (!text) return hide();
    tip.textContent = text;
    tip.classList.add('is-visible');
    tip.setAttribute('aria-hidden', 'false');
    place(x, y);
  }
  function place(x, y) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(window.innerWidth - w - 10, x + 14);
    const top  = Math.max(10, y - h - 18);
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  function hide() {
    tip.classList.remove('is-visible');
    tip.setAttribute('aria-hidden', 'true');
    tip.style.transform = 'translate(-9999px,-9999px)';
  }
  document.body.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tooltip]');
    if (t) show(t.getAttribute('data-tooltip'), e.clientX, e.clientY);
  });
  document.body.addEventListener('mousemove', e => {
    if (tip.classList.contains('is-visible')) place(e.clientX, e.clientY);
  });
  document.body.addEventListener('mouseout', e => {
    if (e.target.closest('[data-tooltip]')) hide();
  });
})();

/* ────────────────────────────────────────────────────────────────────────
   Right-click context menu + View Source modal
   Menu shows for ALL right-clicks; "View Source" is enabled only when the
   click target is inside `pre code`. Another agent owns DevTools, so we
   build a clean single-item menu here; merges can append items later.
   ──────────────────────────────────────────────────────────────────────── */
(function(){
  var CMENU_ID = 'cbe-ctx-menu';
  var MODAL_ID = 'cbe-source-modal';

  /* Supported Prism languages (per task spec) and common aliases. */
  var LANG_ALIAS = {
    'sh': 'bash', 'shell': 'bash', 'zsh': 'bash',
    'ps': 'powershell', 'ps1': 'powershell', 'pwsh': 'powershell',
    'py': 'python',
    'ts': 'typescript', 'tsx': 'typescript',
    'js': 'javascript', 'jsx': 'javascript',
    'html': 'markup', 'xml': 'markup', 'svg': 'markup',
  };
  var SUPPORTED = {
    powershell: 1, bash: 1, xml: 1, markup: 1, css: 1, python: 1,
    svg: 1, javascript: 1, js: 1, typescript: 1, ts: 1, php: 1,
  };

  function normalizeLang(raw) {
    if (!raw) return 'markup';
    raw = String(raw).toLowerCase().trim();
    if (LANG_ALIAS[raw]) raw = LANG_ALIAS[raw];
    return SUPPORTED[raw] ? raw : 'markup';
  }

  function removeMenu() {
    var old = document.getElementById(CMENU_ID);
    if (old) old.remove();
  }

  function removeModal() {
    var old = document.getElementById(MODAL_ID);
    if (old) old.remove();
  }

  function findCodeEl(target) {
    if (!target || !target.closest) return null;
    return target.closest('pre code');
  }

  function showCtxMenu(x, y, codeEl) {
    removeMenu();
    var menu = document.createElement('div');
    menu.id = CMENU_ID;

    /* Copy — copies the current text selection if any, else falls back to
       the clicked code block's full text. Webview blocks the native
       browser context menu so this entry is how the user actually copies. */
    var copy = document.createElement('div');
    copy.className = 'cbe-item';
    var sel = (function() {
      try { return String(window.getSelection() || ''); } catch (e) { return ''; }
    })();
    var hasSelection = !!sel.trim();
    copy.textContent = 'Copy' + (hasSelection ? '' : (codeEl ? ' code block' : ''));
    copy.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      var text = hasSelection ? sel : (codeEl ? (codeEl.textContent || '') : '');
      if (!text) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function() {
            /* Fallback: textarea + execCommand */
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
          });
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
        }
      } catch (e) { /* swallow */ }
    });
    menu.appendChild(copy);

    /* View Source — always enabled. If the right-click landed inside a
       <pre><code>, show that block. Otherwise show the panel's full
       <html> source (the webview's actual DOM as currently rendered). */
    var item = document.createElement('div');
    item.className = 'cbe-item';
    var lang = '';
    if (codeEl) {
      lang = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';
    }
    item.textContent = 'View Source' + (codeEl && lang ? ' (' + lang + ')' : codeEl ? '' : ' (panel)');
    item.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (codeEl) {
        showSourceModal(codeEl.textContent, lang || 'markup');
      } else {
        var html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        showSourceModal(html, 'markup');
      }
    });
    menu.appendChild(item);

    /* Open DevTools — always enabled. Asks host to fire the VS Code command. */
    var dev = document.createElement('div');
    dev.className = 'cbe-item';
    dev.textContent = 'Open DevTools';
    dev.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (api) api.postMessage({ type: 'openDevTools' });
    });
    menu.appendChild(dev);

    /* Refresh — asks the host to re-read panel/index.html + panel.js from
       disk and re-assign panel.webview.html. This is the supported way to
       pick up CSS / JS edits without rebooting VSCode. The webview will
       re-fire its `ready` message and rehydrate state from the host. */
    var refresh = document.createElement('div');
    refresh.className = 'cbe-item';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (api) api.postMessage({ type: 'refreshPanel' });
    });
    menu.appendChild(refresh);

    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    document.body.appendChild(menu);

    /* Reposition if off-screen */
    var r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = Math.max(0, x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = Math.max(0, y - r.height) + 'px';

    /* Dismiss on outside click */
    setTimeout(function() {
      function dismiss(e) {
        if (!menu.contains(e.target)) {
          removeMenu();
          document.removeEventListener('mousedown', dismiss, true);
        }
      }
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }

  function showSourceModal(code, rawLang) {
    removeModal();
    var lang = normalizeLang(rawLang);

    var overlay = document.createElement('div');
    overlay.id = MODAL_ID;

    var box = document.createElement('div');
    box.className = 'cbe-box';

    var hdr = document.createElement('div');
    hdr.className = 'cbe-hdr';

    var title = document.createElement('span');
    title.className = 'cbe-title';
    title.textContent = 'View Source' + (rawLang ? ' — ' + rawLang : '');

    var actions = document.createElement('div');
    actions.className = 'cbe-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'cbe-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function() {
      try {
        navigator.clipboard.writeText(code).then(function() {
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
        });
      } catch (e) {
        copyBtn.textContent = 'Failed';
      }
    });

    var closeBtn = document.createElement('button');
    closeBtn.className = 'cbe-x-svg';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', removeModal);

    hdr.appendChild(title);
    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn);
    hdr.appendChild(actions);

    var scroller = document.createElement('div');
    scroller.className = 'cbe-scroller';

    /* Build a row-per-line table so line numbers stay aligned even when
       Prism's wrapping spans cross newlines. */
    var pre = document.createElement('pre');
    pre.className = 'language-' + lang;

    /* Highlight first (Prism returns string), then split by lines. */
    var html;
    try {
      if (window.Prism && Prism.languages[lang]) {
        html = Prism.highlight(code, Prism.languages[lang], lang);
      } else {
        html = escapeHtml(code);
      }
    } catch (e) {
      html = escapeHtml(code);
    }

    var lines = html.split('\n');
    var table = document.createElement('div');
    table.className = 'cbe-numbered';
    /* Strip a trailing empty line (most files end in \n). */
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.forEach(function(line, i) {
      var row = document.createElement('div');
      row.className = 'cbe-row';
      var ln = document.createElement('span');
      ln.className = 'cbe-ln';
      ln.textContent = String(i + 1);
      var codeCell = document.createElement('span');
      codeCell.className = 'cbe-code language-' + lang;
      codeCell.innerHTML = line || ' ';
      row.appendChild(ln);
      row.appendChild(codeCell);
      table.appendChild(row);
    });
    pre.appendChild(table);
    scroller.appendChild(pre);

    box.appendChild(hdr);
    box.appendChild(scroller);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function(e) {
      if (e.target === overlay) removeModal();
    });
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape') {
        removeModal();
        document.removeEventListener('keydown', escClose);
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Single global contextmenu listener — capture phase so we override
     VS Code's default webview menu. Skips the menu entirely when the
     click lands on a toolbar control (tool/label/send/stop button) or
     the input textarea, where a context menu is more confusing than
     useful. Right-click on chat text / code blocks still shows it so
     Copy / View Source / DevTools / Refresh remain reachable. */
  document.addEventListener('contextmenu', function(e) {
    if (e.target && e.target.closest) {
      const skip = e.target.closest(
        '.tool-button, .label-button, .send-button, .stop-button, ' +
        '#promptBox, .prompt-input-wrap, .prompt-toolbar, .toolbar-meta'
      );
      if (skip) {
        e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    var codeEl = findCodeEl(e.target);
    showCtxMenu(e.clientX, e.clientY, codeEl);
  });

  /* Expose for future agents (e.g. DevTools merge). */
  window.__cbeShowSource = showSourceModal;
  window.__cbeShowCtxMenu = showCtxMenu;
})();

/* ────────────────────────────────────────────────────────────────────────
   Setup wizard — multi-step modal for API keys / PATs.
   Flow: setupBtn click → postMessage('loadSetup') → host reads config.ini
   and posts back { type:'setupValues', values:{...} }. We open the modal,
   render one step at a time, Skip advances without saving, Next saves the
   step's fields then advances, last step's Done writes config.ini.
   ──────────────────────────────────────────────────────────────────────── */
(function(){
  /* Section/key pairs each step writes to. `password:true` masks the input
     so shoulder-surfers don't read the token off the screen. `placeholder`
     and `help` are the user-facing hints. */
  const STEPS = [
    { title: 'Anthropic (Claude)',
      desc:  'API key for direct Claude calls. Get one at <a href="https://console.anthropic.com/account/keys">console.anthropic.com</a>.',
      fields: [{ section:'api_keys', key:'anthropic_api_key', label:'API Key', placeholder:'sk-ant-…', password:true }] },
    { title: 'OpenAI (ChatGPT)',
      desc:  'API key for GPT models. Get one at <a href="https://platform.openai.com/api-keys">platform.openai.com</a>.',
      fields: [{ section:'api_keys', key:'openai_api_key', label:'API Key', placeholder:'sk-proj-…', password:true }] },
    { title: 'Google Gemini',
      desc:  'API key for Gemini. Get one at <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>.',
      fields: [{ section:'api_keys', key:'gemini_api_key', label:'API Key', placeholder:'AIza…', password:true }] },
    { title: 'xAI (Grok)',
      desc:  'API key for Grok direct API. Get one at <a href="https://console.x.ai/">console.x.ai</a>.',
      fields: [{ section:'api_keys', key:'xai_api_key', label:'API Key', placeholder:'xai-…', password:true }] },
    { title: 'GitHub Personal Access Token',
      desc:  'PAT for repos, issues, PRs, releases, workflows, packages, secrets, webhooks. ' +
             'Generate at <a href="https://github.com/settings/tokens/new">github.com/settings/tokens</a> with scopes: ' +
             '<b>repo, workflow, write:packages, admin:org, gist, notifications, user, delete_repo</b>.',
      fields: [{ section:'github', key:'token', label:'PAT', placeholder:'ghp_… or fine-grained token', password:true }] },
    { title: 'Email / SMTP (Gmail app password recommended)',
      desc:  'For email_hook / email_check_hook. Gmail app passwords: <a href="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</a>.',
      fields: [
        { section:'email', key:'account',  label:'Account / login',  placeholder:'you@example.com' },
        { section:'email', key:'password', label:'Password (app-pw)', placeholder:'16-char app password', password:true },
      ] },
    { title: 'Cloudflare',
      desc:  'API token (NOT global key). Permissions: Zone:DNS:Edit, Zone:Zone:Read, Account:Workers:Edit. <a href="https://dash.cloudflare.com/profile/api-tokens">dash.cloudflare.com</a>.',
      fields: [{ section:'cloudflare', key:'api_token', label:'API Token', password:true }] },
    { title: 'Twilio (SMS/voice)',
      desc:  'Console: <a href="https://console.twilio.com/">console.twilio.com</a>.',
      fields: [
        { section:'twilio', key:'account_sid', label:'Account SID', placeholder:'AC…' },
        { section:'twilio', key:'auth_token',  label:'Auth Token', password:true },
        { section:'twilio', key:'from_number', label:'From number (E.164)', placeholder:'+12125551234' },
      ] },
    { title: 'ElevenLabs (TTS)',
      desc:  'Keys at <a href="https://elevenlabs.io/app/settings/api-keys">elevenlabs.io</a>.',
      fields: [{ section:'elevenlabs', key:'api_key', label:'API Key', password:true }] },
    { title: 'Stability AI (Stable Diffusion)',
      desc:  'Keys at <a href="https://platform.stability.ai/account/keys">platform.stability.ai</a>.',
      fields: [{ section:'stability', key:'api_key', label:'API Key', password:true }] },
    { title: 'Runway ML',
      desc:  'Keys at <a href="https://dev.runwayml.com/">dev.runwayml.com</a>.',
      fields: [{ section:'runway', key:'api_key', label:'API Key', placeholder:'key_…', password:true }] },
    { title: 'SendGrid (email)',
      desc:  'Keys at <a href="https://app.sendgrid.com/settings/api_keys">app.sendgrid.com</a>.',
      fields: [
        { section:'sendgrid', key:'api_key',    label:'API Key', password:true },
        { section:'sendgrid', key:'from_email', label:'Verified sender' },
      ] },
    { title: 'SerpAPI (search results)',
      desc:  'Keys at <a href="https://serpapi.com/manage-api-key">serpapi.com</a>.',
      fields: [{ section:'serpapi', key:'api_key', label:'API Key', password:true }] },
    { title: 'NameSilo (domains)',
      desc:  'Keys at <a href="https://www.namesilo.com/account/api-manager">namesilo.com</a>.',
      fields: [{ section:'namesilo', key:'api_key', label:'API Key', password:true }] },
    { title: 'Airtable',
      desc:  'Personal access token at <a href="https://airtable.com/create/tokens">airtable.com/create/tokens</a>.',
      fields: [{ section:'airtable', key:'api_token', label:'API Token', placeholder:'pat…', password:true }] },
    { title: 'Browserless (remote headless Chrome)',
      desc:  'Tokens at <a href="https://www.browserless.io/">browserless.io</a>.',
      fields: [{ section:'browserless', key:'token', label:'Token', password:true }] },
    { title: 'Google Workspace / Sheets / Gmail API',
      desc:  'Service account JSON file path. Create at <a href="https://console.cloud.google.com/iam-admin/serviceaccounts">console.cloud.google.com</a>.',
      fields: [
        { section:'google', key:'service_account_json', label:'JSON file path', placeholder:'C:\\Users\\you\\sa.json' },
        { section:'google', key:'admin_email',          label:'Admin email (impersonation)' },
      ] },
  ];

  let _idx = 0;
  let _values = {};   /* "section.key" -> string, hydrated from host */
  let _overlay = null;

  function _fieldKey(f) { return f.section + '.' + f.key; }

  function close() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    document.removeEventListener('keydown', _escClose, true);
  }
  function _escClose(e) { if (e.key === 'Escape') close(); }

  function _captureCurrentStepInto(targetMap) {
    if (!_overlay) return;
    STEPS[_idx].fields.forEach(f => {
      const inp = _overlay.querySelector('input[data-fk="' + _fieldKey(f) + '"]');
      if (inp) targetMap[_fieldKey(f)] = inp.value;
    });
  }

  function _saveCurrentStep() {
    _captureCurrentStepInto(_values);
    /* Build the host payload limited to THIS step's fields so we don't
       accidentally re-write blanks for steps the user skipped. */
    const patch = {};
    STEPS[_idx].fields.forEach(f => {
      patch[_fieldKey(f)] = _values[_fieldKey(f)] || '';
    });
    if (api) api.postMessage({ type: 'saveSetup', patch });
  }

  function render() {
    const step = STEPS[_idx];
    const isLast = _idx === STEPS.length - 1;
    const pct = Math.round(((_idx + 1) / STEPS.length) * 100);
    _overlay.innerHTML = ''
      + '<div class="cbe-box" role="dialog" aria-modal="true" aria-label="Setup wizard">'
      +   '<div class="cbe-hdr">'
      +     '<span>Setup wizard &nbsp;·&nbsp; ' + (_idx + 1) + ' of ' + STEPS.length + '</span>'
      +     '<button type="button" class="cbe-x-svg" data-act="close" aria-label="Close"></button>'
      +   '</div>'
      +   '<div class="cbe-progress"><span style="width:' + pct + '%"></span></div>'
      +   '<div class="cbe-body">'
      +     '<h3 class="cbe-step-title">' + _escape(step.title) + '</h3>'
      +     '<p class="cbe-step-desc">' + step.desc + '</p>'
      +     step.fields.map(f => {
        const v = _values[_fieldKey(f)] || '';
        const ph = f.placeholder ? ' placeholder="' + _escapeAttr(f.placeholder) + '"' : '';
        const type = f.password ? 'password' : 'text';
        return '<div><label>' + _escape(f.label) + '</label>'
             + '<input type="' + type + '" data-fk="' + _escapeAttr(_fieldKey(f)) + '" value="' + _escapeAttr(v) + '"' + ph + ' /></div>';
      }).join('')
      +   '</div>'
      +   '<div class="cbe-foot">'
      +     '<div class="cbe-foot-left">'
      +       (_idx > 0 ? '<button class="cbe-btn cbe-back" data-act="back">‹ Back</button>' : '')
      +     '</div>'
      +     '<div class="cbe-foot-right">'
      +       '<button class="cbe-btn cbe-skip" data-act="skip">Skip</button>'
      +       '<button class="cbe-btn cbe-next" data-act="next">' + (isLast ? 'Done' : 'Next ›') + '</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    _overlay.querySelector('[data-act="close"]').addEventListener('click', close);
    _overlay.querySelector('[data-act="skip"]').addEventListener('click', () => {
      /* Skip = don't write this step, just move on. Still capture in-memory
         so if the user comes back via Back, the value isn't lost. */
      _captureCurrentStepInto(_values);
      _advance();
    });
    _overlay.querySelector('[data-act="next"]').addEventListener('click', () => {
      _saveCurrentStep();
      _advance();
    });
    const backBtn = _overlay.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener('click', () => {
      _captureCurrentStepInto(_values);
      _idx = Math.max(0, _idx - 1);
      render();
    });
    /* Focus the first input so the user can start typing immediately. */
    const firstInp = _overlay.querySelector('input');
    if (firstInp) firstInp.focus();
  }

  function _advance() {
    if (_idx >= STEPS.length - 1) { close(); return; }
    _idx += 1;
    render();
  }

  function open(values) {
    _values = values || {};
    _idx = 0;
    close();
    _overlay = document.createElement('div');
    _overlay.id = 'cbe-setup';
    document.body.appendChild(_overlay);
    render();
    document.addEventListener('keydown', _escClose, true);
  }

  function _escape(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function _escapeAttr(s) {
    return _escape(s).replace(/"/g, '&quot;');
  }

  /* Inbound: host responds to loadSetup with the current values map. */
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m && m.type === 'setupValues') open(m.values || {});
  });
})();

