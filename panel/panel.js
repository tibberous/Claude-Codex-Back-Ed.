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
        /* Re-highlight any code blocks rendered before Prism arrived, and
           ensure each one has the title bar + footer (cbeWrapCodeBlock is
           idempotent — already-wrapped blocks are skipped). */
        try {
          document.querySelectorAll('pre[class*="language-"] code').forEach((el) => {
            try {
              const m = (el.className || '').match(/language-([a-z0-9+#-]+)/i);
              const lang = m && m[1];
              if (lang && window.Prism && Prism.languages && Prism.languages[lang]) {
                Prism.highlightElement(el);
              }
              const preEl = el.closest('pre');
              if (preEl && typeof cbeWrapCodeBlock === 'function') cbeWrapCodeBlock(preEl);
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
let __cbeStatusEl = null;  /* transient progress line for slow providers */

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

/* Shared clipboard helper. `getText()` returns the raw string to copy at
   click time (read lazily so a re-highlighted block still copies its real
   textContent, never the Prism-tokenised HTML). `btn` gets its label swapped
   to the localized "Copied!" for 1400ms then reverted. Labels resolve via
   the same cbeT() i18n table the rest of the dynamic DOM uses; English
   fallbacks keep it working before strings arrive. */
function cbeBindCopy(btn, getText) {
  let __revertTimer = null;
  const setLabel = () => {
    if (__revertTimer) return;            /* mid-"Copied!" — leave it */
    btn.textContent = cbeT('code.copy', 'Copy');
  };
  btn._cbeRelabel = setLabel;             /* re-applied on language change */
  setLabel();
  const done = () => {
    btn.classList.add('copied');
    btn.textContent = cbeT('code.copied', 'Copied!');
    if (__revertTimer) clearTimeout(__revertTimer);
    __revertTimer = setTimeout(() => {
      __revertTimer = null;
      btn.classList.remove('copied');
      btn.textContent = cbeT('code.copy', 'Copy');
    }, 1400);
  };
  const legacyCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); }
    catch (e) { console.debug('[cbe.copy] execCommand fallback failed', e && e.message); }
    document.body.removeChild(ta);
    done();
  };
  btn.onclick = () => {
    const text = (typeof getText === 'function') ? getText() : String(getText || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text));
    } else {
      legacyCopy(text);
    }
  };
}

function makeCopyBtn(getText) {
  const btn = document.createElement('button');
  btn.className = 'cv-copy-btn cbe-cb-copy';
  btn.type = 'button';
  cbeBindCopy(btn, getText);
  return btn;
}

/* Wrap a freshly-built or re-highlighted <pre> in a .cbe-codeblock container
   with a title bar (language name + Copy) above it and a footer (second Copy)
   below it. Idempotent: a <pre> already inside a .cbe-codeblock is left alone
   so the panel.js:36 re-highlight pass can call this on the same element
   without double-wrapping. Only the wrapper/bars are touched — the <code>
   innerHTML (Prism tokens) is never read or modified, so highlighting and
   line-numbers stay intact. The Copy buttons read codeEl.textContent lazily
   at click time, which yields the raw source even after Prism tokenises it. */
function cbeWrapCodeBlock(preEl) {
  if (!preEl || preEl.nodeName !== 'PRE') return preEl;
  if (preEl.closest('.cbe-codeblock')) return preEl.closest('.cbe-codeblock');
  const codeEl = preEl.querySelector('code') || preEl;
  const getText = () => codeEl.textContent || '';

  /* Derive a display label from the language-X class on <pre> or <code>. */
  const cls = (preEl.className || '') + ' ' + ((preEl.querySelector('code') || {}).className || '');
  const m = cls.match(/language-([a-z0-9+#-]+)/i);
  const lang = m && m[1] ? m[1].toLowerCase() : '';
  const label = LANG_LABEL[lang] || (lang ? lang.toUpperCase() : 'TEXT');

  const wrap = document.createElement('div');
  wrap.className = 'cbe-codeblock cv-code-wrap';

  const titlebar = document.createElement('div');
  titlebar.className = 'cbe-cb-titlebar cv-code-bar';
  const langSpan = document.createElement('span');
  langSpan.className = 'cbe-cb-lang cv-code-lang';
  langSpan.textContent = label;
  titlebar.appendChild(langSpan);
  titlebar.appendChild(makeCopyBtn(getText));

  const footer = document.createElement('div');
  footer.className = 'cbe-cb-footer';
  footer.appendChild(makeCopyBtn(getText));

  /* Splice the wrapper in where the <pre> currently lives (re-highlight
     path: <pre> is already in the DOM). If the <pre> is detached
     (fresh makeCodeBlock build) there is nothing to replace — the caller
     inserts the returned wrapper. */
  const parent = preEl.parentNode;
  if (parent) parent.replaceChild(wrap, preEl);
  wrap.appendChild(titlebar);
  wrap.appendChild(preEl);
  wrap.appendChild(footer);
  return wrap;
}

function makeCodeBlock(rawLang, rawCode) {
  /* Normalize lang. Unknown lang -> plain (no highlighting, but still wrap). */
  const key = (rawLang || '').trim().toLowerCase();
  const lang = LANG_MAP[key] || (key && /^[a-z0-9+#-]+$/i.test(key) ? key : '');

  const pre = document.createElement('pre');
  pre.className = 'line-numbers' + (lang ? ' language-' + lang : '');
  const codeEl = document.createElement('code');
  codeEl.className = lang ? 'language-' + lang : '';
  codeEl.textContent = rawCode;  /* textContent escapes safely */
  pre.appendChild(codeEl);

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

  /* <pre> is detached here — cbeWrapCodeBlock builds + returns the wrapper
     with the <pre> spliced in; the caller inserts the returned node. */
  return cbeWrapCodeBlock(pre);
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
  /* Leave the textarea typeable during streaming so a slow provider
     cold-start: 30-60s for chatgpt/grok cold spawn) doesn't lock the UI.
     send() guards against re-entry via the `busy` flag, and sendBtn is
     disabled below — so the user can compose the next prompt while the
     current one streams, but can't fire two requests at once. */
  sendBtn.disabled = b;
  inBox.classList.toggle('busy', b);
  /* Note: `monitorBtn.is-monitoring` is now bound to the VSCode supervisor
     service state (CBEVSCodeSupervisor), NOT chat busy. Don't toggle it here
     anymore — the periodic monitorStatus probe owns that class. */
}

/* Shared teardown for the chat send lifecycle. Called from EVERY exit path:
     • assistantDone (happy path)
     • error from the host
     • cancelled / Stop button
     • imageResult / imageError
   Without a single funnel like this the inFlight flag can leak set forever
   if the host posts a message we don't handle, or if a partial bubble is
   left in the DOM after an error. Idempotent — safe to call twice. */
function teardownChatLifecycle(opts) {
  opts = opts || {};
  try {
    if (__cbeStatusEl) { try { __cbeStatusEl.remove(); } catch (e) {} __cbeStatusEl = null; }
  } catch (_e) {}
  try {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      if (opts.cancelled) {
        const cancelTag = document.createElement('span');
        cancelTag.className = 'cbe-cancelled-tag';
        cancelTag.style.cssText = 'opacity:.6;font-style:italic;margin-left:6px;font-size:11px;';
        cancelTag.textContent = ' (cancelled)';
        streamingEl.appendChild(cancelTag);
      }
      streamingEl = null;
    }
  } catch (_e) {}
  setBusy(false);
}

function send() {
  if (busy) return;
  const txt = (ti.value || '').trim();
  const attachBlock = buildAttachmentBlocks();
  const images = buildAttachmentImages();
  if (!txt && !attachBlock && !images.length) return;
  const fullText = attachBlock ? (txt + (txt ? '\n' : '') + attachBlock) : txt;
  /* Display the user-typed line only, plus a small chip summary if there
     are attachments — keep the chat compact, no need to re-paste content. */
  let displayText = txt;
  if (__cbeAttachments.length) {
    const names = __cbeAttachments.map(a => '📎 ' + a.name).join('  ');
    displayText = (txt ? txt + '\n\n' : '') + names;
  }
  addMsg(displayText, 'sent');
  if (api) {
    const msg = { type: 'sendText', text: fullText };
    if (images.length) msg.images = images;
    api.postMessage(msg);
  }
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
        /* 43px = ~90% of the 48px tool-button square. Border scaled up so the
           ring still reads as a thin halo rather than a filled disc. */
        'position:absolute', 'top:50%', 'left:50%', 'width:43px', 'height:43px',
        'margin:0', 'padding:0', 'box-sizing:border-box', 'border-radius:50%',
        'border:4px solid rgba(78,168,255,0.25)', 'border-top-color:#4ea8ff',
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
(function wireAccountsButton() {
  const btn = document.getElementById('accountsBtn');
  if (btn) btn.onclick = () => openAccountsModal();
})();
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
  /* browserBtn — opens a NN4-skinned WebviewPanel via the host. The panel
     is created/revealed by extension.js on receipt of 'openNN4Browser'. */
  bind('browserBtn',        'openNN4Browser');
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
/* Which provider the Accounts section in the open Settings modal is showing.
   Set by renderModels() when the provider dropdown changes. */
let __cbeAccountsProvider = null;

/* HTML-escape for masked-key / label text injected into the accounts list. */
function _acctEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Friendly relative-ish timestamp for lastUsed / reset cells. */
function _acctWhen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toLocaleString(); } catch (_) { return iso; }
}

function _hideAccountForm() {
  const form = document.querySelector('#cbe-acct-form');
  if (!form) return;
  form.style.display = 'none';
  const lbl = document.querySelector('#cbe-acct-label');
  const key = document.querySelector('#cbe-acct-key');
  const err = document.querySelector('#cbe-acct-err');
  if (lbl) lbl.value = '';
  if (key) key.value = '';
  if (err) { err.style.display = 'none'; err.textContent = ''; }
}

function _showAccountFormError(text) {
  const err = document.querySelector('#cbe-acct-err');
  const form = document.querySelector('#cbe-acct-form');
  if (form) form.style.display = '';
  if (err) { err.textContent = text; err.style.display = ''; }
}

/* Render the per-provider account rows from a host accountsState payload.
   Each row: label, masked key, active dot, last-used, [Use]/[Disable]/[Delete].
   Keys arrive ALREADY MASKED from the host — the webview never sees a raw key. */
function renderAccountsList(payload) {
  const wrap = document.querySelector('#cbe-accounts-wrap');
  const list = document.querySelector('#cbe-acct-list');
  if (!wrap || !list) return;
  /* Ignore stale replies for a provider we're no longer viewing. */
  if (payload && payload.provider && __cbeAccountsProvider && payload.provider !== __cbeAccountsProvider) return;
  if (payload && payload.bridge) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  /* A successful state push means any pending add succeeded — close the form. */
  _hideAccountForm();
  const accounts = (payload && payload.accounts) || [];
  const countEl = document.querySelector('#cbe-acct-count');
  if (countEl) countEl.textContent = accounts.length ? `(${accounts.length})` : '(none yet)';
  list.innerHTML = '';
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:.6;font-size:12px;padding:4px 2px;';
    empty.textContent = 'No accounts yet — add one to start rotating on rate-limit.';
    list.appendChild(empty);
    return;
  }
  accounts.forEach((a) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid var(--cbe-modal-border,#3a3a3a);border-radius:4px;background:var(--cbe-modal-bg,#1a1a1a);'
      + (a.disabled ? 'opacity:.5;' : '');
    const dot = a.active ? '<span title="active" style="color:#4ade80;">●</span>' : '<span style="color:#555;">○</span>';
    const dis = a.disabled ? ` · <span style="color:#ff6b6b;">limited${a.disabledUntil ? ' until ' + _acctEsc(_acctWhen(a.disabledUntil)) : ''}</span>` : '';
    const used = a.lastUsedAt ? ` · used ${_acctEsc(_acctWhen(a.lastUsedAt))}` : '';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;font-size:12px;line-height:1.35;';
    /* Either api_key or email_password — both now carry an optional `email`
       identity tag (the gmail that owns this account). For api_key rows we
       show "email · maskedKey" when present, else just maskedKey. For
       email_password rows we show "email · maskedPassword". */
    let secondary;
    if (a.type === 'email_password') {
      secondary = `${_acctEsc(a.email || '')} &middot; ${_acctEsc(a.maskedPassword || '****')}`;
    } else if (a.email) {
      secondary = `${_acctEsc(a.email)} &middot; ${_acctEsc(a.maskedKey || '')}`;
    } else {
      secondary = _acctEsc(a.maskedKey || '');
    }
    info.innerHTML = `${dot} <b>${_acctEsc(a.label)}</b><br><code style="opacity:.8;">${secondary}</code>${used}${dis}`;
    row.appendChild(info);
    const mkBtn = (txt, type, extra) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.style.cssText = 'padding:2px 8px;font-size:11px;background:var(--cbe-modal-accent,#2563eb);color:#fff;border:0;border-radius:3px;cursor:pointer;font-family:inherit;flex-shrink:0;';
      if (extra) b.style.cssText += extra;
      b.addEventListener('click', () => {
        if (api) api.postMessage(Object.assign({ type, provider: __cbeAccountsProvider, accountId: a.id }, type === 'disableAccount' && a.disabled ? { enable: true } : {}));
      });
      return b;
    };
    if (!a.active) row.appendChild(mkBtn('Use', 'useAccount'));
    row.appendChild(mkBtn(a.disabled ? 'Enable' : 'Disable', 'disableAccount', 'background:#555;'));
    row.appendChild(mkBtn('Delete', 'deleteAccount', 'background:#7a2222;'));
    list.appendChild(row);
  });
}

/* ── Standalone Accounts modal (toolbar #accountsBtn) ───────────────────────
   Easy-access front-end over the SAME host protocol the Settings-embedded
   accounts section uses (getAccounts/addAccount/useAccount/disableAccount +
   the new removeAccount/editAccount). The host always replies with an
   `accountsState` message; renderAccountsList() fans it out to BOTH this modal
   (when open) and the Settings section. Keys are received already MASKED — the
   webview never holds a raw key. */
let __cbeAmProvider = null;          /* provider id the modal is currently showing */
let __cbeAmEditingId = null;         /* account id whose row is in inline-edit mode, or null */
let __cbeAmUndo = null;              /* { accountId, timer } for the 2s delete undo window */

function _amEl(id) { return document.getElementById(id); }

function _amModalOpen() {
  const m = _amEl('accountsModal');
  return !!(m && m.classList.contains('show'));
}

function _amShowError(text) {
  const err = _amEl('cbe-am-err');
  if (err) { err.textContent = text || ''; err.style.display = text ? 'block' : 'none'; }
}

/* Default account type for a provider id. Mirrors extension.js
   defaultAccountType — the panel uses this to decide which Add-form fields to
   show before the host's accountsState reply (which carries the authoritative
   accountType) lands. */
function _amProviderType(providerId) {
  if (providerId === 'ollama' || providerId === 'ollamaBridge') return 'none';
  const p = (__cbeProviders || []).find(x => x.id === providerId);
  return (p && p.bridge) ? 'email_password' : 'api_key';
}

/* Populate the provider <select> with every provider that has an account
   concept. Direct-API providers take API keys; browser-bridge providers take
   email+password. Ollama is local-only and hidden — no account UI applies. */
function _amPopulateProviders() {
  const sel = _amEl('accountsProvider');
  if (!sel) return;
  const prev = __cbeAmProvider;
  sel.innerHTML = '';
  /* Exclude ollama/ollamaBridge — local-only, no account. Every other provider
     (direct + bridge) shows up. */
  const choices = (__cbeProviders || []).filter(p =>
    p.id !== 'ollama' && p.id !== 'ollamaBridge');
  choices.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    const suffix = p.bridge ? '  (browser login)' : (p.haveKey ? '' : '  (no key)');
    o.textContent = p.label + suffix;
    sel.appendChild(o);
  });
  /* Prefer the previously-shown provider, else the active provider, else the
     first available choice. */
  let want = prev;
  if (!choices.some(p => p.id === want)) {
    want = (choices.some(p => p.id === __cbeActive)) ? __cbeActive : (choices[0] ? choices[0].id : null);
  }
  if (want) sel.value = want;
  __cbeAmProvider = sel.value || want || null;
  _amUpdateAddFormMode();
}

/* Toggle Add-form field visibility based on the selected provider's type.
   api_key: show #cbe-am-key, hide #cbe-am-email + #cbe-am-password
   email_password: hide #cbe-am-key, show email + password
   none: hide the entire add form (shouldn't happen — ollama is filtered out). */
function _amUpdateAddFormMode() {
  const t = _amProviderType(__cbeAmProvider);
  const keyRow   = _amEl('cbe-am-key-row');
  const emailRow = _amEl('cbe-am-email-row');
  const pwRow    = _amEl('cbe-am-password-row');
  const formWrap = document.querySelector('#accountsModal .cbe-am-addform');
  const hint     = _amEl('cbe-am-cred-hint');
  if (formWrap) formWrap.style.display = (t === 'none') ? 'none' : '';
  if (keyRow)   keyRow.style.display   = (t === 'api_key') ? '' : 'none';
  if (emailRow) emailRow.style.display = (t === 'email_password') ? '' : 'none';
  if (pwRow)    pwRow.style.display    = (t === 'email_password') ? '' : 'none';
  if (hint) {
    if (t === 'email_password') {
      hint.textContent = 'Passwords are stored locally; they drive the browser bridge login.';
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
  }
}

function openAccountsModal() {
  const modal = _amEl('accountsModal');
  if (!modal) return;
  __cbeAmEditingId = null;
  _amShowError('');
  const lbl   = _amEl('cbe-am-label');    if (lbl)   lbl.value   = '';
  const key   = _amEl('cbe-am-key');      if (key)   key.value   = '';
  const email = _amEl('cbe-am-email');    if (email) email.value = '';
  const pw    = _amEl('cbe-am-password'); if (pw)    pw.value    = '';
  _amPopulateProviders();
  modal.classList.add('show');
  if (__cbeAmProvider && api) api.postMessage({ type: 'listAccounts', provider: __cbeAmProvider });
}

function closeAccountsModal() {
  const modal = _amEl('accountsModal');
  if (!modal) return;
  modal.classList.remove('show');
  __cbeAmEditingId = null;
  /* Commit any pending delete immediately on close — the undo window ends. */
  if (__cbeAmUndo) { clearTimeout(__cbeAmUndo.timer); __cbeAmUndo = null; }
}

/* Render the account rows into the STANDALONE modal from a host payload.
   Mirrors the Settings-section renderer but targets #cbe-am-list and adds the
   Edit (inline) + Delete (2s undo) controls the standalone modal owns. */
function renderAccountsModalList(payload) {
  if (!_amModalOpen()) return;
  /* Ignore stale replies for a provider we're no longer viewing. */
  if (payload && payload.provider && __cbeAmProvider && payload.provider !== __cbeAmProvider) return;
  const list = _amEl('cbe-am-list');
  if (!list) return;
  /* A fresh state push means any pending add succeeded — clear the form. */
  const lbl   = _amEl('cbe-am-label');
  const key   = _amEl('cbe-am-key');
  const email = _amEl('cbe-am-email');
  const pw    = _amEl('cbe-am-password');
  if (lbl   && document.activeElement !== lbl)   lbl.value   = '';
  if (key)   key.value   = '';
  if (email && document.activeElement !== email) email.value = '';
  if (pw)    pw.value    = '';
  _amShowError('');
  /* Refresh the Add-form mode whenever payload arrives — the panel may have
     been opened before __cbeProviders was hydrated. */
  _amUpdateAddFormMode();
  const accounts = (payload && payload.accounts) || [];
  const countEl = _amEl('cbe-am-count');
  if (countEl) countEl.textContent = accounts.length ? `(${accounts.length})` : '(none yet)';
  list.innerHTML = '';
  /* `hasAccounts === false` means the provider has no account concept (Ollama).
     Show a neutral note instead of the empty-list message. */
  if (payload && payload.hasAccounts === false) {
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.6;font-size:12px;padding:4px 2px;';
    note.textContent = 'Local — no account needed for this provider.';
    list.appendChild(note);
    return;
  }
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:.6;font-size:12px;padding:4px 2px;';
    empty.textContent = 'No accounts yet — add one below.';
    list.appendChild(empty);
    return;
  }
  accounts.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'cbe-am-row';
    if (a.disabled) row.style.opacity = '.5';
    const accType = a.type === 'email_password' ? 'email_password' : 'api_key';

    if (__cbeAmEditingId === a.id) {
      /* Inline-edit mode. The fields shown depend on the row's account type:
           api_key       → Label + new API key
           email_password → Label + Email + new Password (blank password keeps current) */
      const editWrap = document.createElement('div');
      editWrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;';
      const lblIn = document.createElement('input');
      lblIn.type = 'text'; lblIn.value = a.label || ''; lblIn.placeholder = 'Label';
      lblIn.setAttribute('data-am-edit-label', '1');
      editWrap.appendChild(lblIn);
      let keyIn = null, emailIn = null, pwIn = null;
      if (accType === 'email_password') {
        emailIn = document.createElement('input');
        emailIn.type = 'text'; emailIn.value = a.email || ''; emailIn.placeholder = 'Email';
        emailIn.autocomplete = 'off'; emailIn.spellcheck = false;
        emailIn.setAttribute('data-am-edit-email', '1');
        pwIn = document.createElement('input');
        pwIn.type = 'password'; pwIn.placeholder = 'New password (leave blank to keep current)';
        pwIn.autocomplete = 'off'; pwIn.spellcheck = false;
        pwIn.setAttribute('data-am-edit-password', '1');
        editWrap.appendChild(emailIn);
        editWrap.appendChild(pwIn);
      } else {
        /* api_key rows ALSO get an email tag field — identity-tag only, not a
           credential. Blank means "no gmail associated"; the field is sent on
           save only if it differs from the current value. */
        emailIn = document.createElement('input');
        emailIn.type = 'text'; emailIn.value = a.email || ''; emailIn.placeholder = 'Email (identity tag — gmail that owns this key)';
        emailIn.autocomplete = 'off'; emailIn.spellcheck = false;
        emailIn.setAttribute('data-am-edit-email', '1');
        editWrap.appendChild(emailIn);
        keyIn = document.createElement('input');
        keyIn.type = 'password'; keyIn.placeholder = 'New API key (leave blank to keep current)';
        keyIn.autocomplete = 'off'; keyIn.spellcheck = false;
        keyIn.setAttribute('data-am-edit-key', '1');
        editWrap.appendChild(keyIn);
      }
      row.appendChild(editWrap);
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'cbe-am-btn'; saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => {
        const msg = { type: 'editAccount', provider: __cbeAmProvider, accountId: a.id };
        const newLabel = lblIn.value.trim();
        if (newLabel) msg.label = newLabel;
        if (accType === 'email_password') {
          const newEmail = (emailIn && emailIn.value || '').trim();
          const newPw    = (pwIn && pwIn.value || '');
          if (newEmail && newEmail !== (a.email || '')) msg.email = newEmail;
          if (newPw) msg.password = newPw;
        } else {
          /* api_key: send email only when it changed. Blank clears the tag —
             host treats hasEmail=false on blank, so user can't actually clear
             via this UI today (intentional: tag is opt-in). */
          const newEmail = (emailIn && emailIn.value || '').trim();
          const newKey   = (keyIn && keyIn.value || '').trim();
          if (newEmail && newEmail !== (a.email || '')) msg.email = newEmail;
          if (newKey) msg.apiKey = newKey;
        }
        __cbeAmEditingId = null;
        if (api) api.postMessage(msg);
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.className = 'cbe-am-btn cbe-am-btn--neutral'; cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        __cbeAmEditingId = null;
        renderAccountsModalList(payload);
      });
      row.appendChild(saveBtn);
      row.appendChild(cancelBtn);
      list.appendChild(row);
      setTimeout(() => lblIn.focus(), 0);
      return;
    }

    const dot = a.active ? '<span title="active" style="color:#4ade80;">&#9679;</span>' : '<span style="color:#555;">&#9675;</span>';
    const dis = a.disabled ? ` &middot; <span style="color:#ff6b6b;">limited</span>` : '';
    /* Type badge — "API" (blue) for api_key, "LOGIN" (purple) for email_password.
       Gives the user an at-a-glance sense of which rows are key-based vs
       browser-login. */
    const badge = accType === 'email_password'
      ? '<span style="display:inline-block;margin-right:6px;padding:1px 5px;font-size:9px;font-weight:700;background:#6d28d9;color:#fff;border-radius:3px;letter-spacing:.05em;" title="email + password (browser bridge)">LOGIN</span>'
      : '<span style="display:inline-block;margin-right:6px;padding:1px 5px;font-size:9px;font-weight:700;background:#1d4ed8;color:#fff;border-radius:3px;letter-spacing:.05em;" title="API key">API</span>';
    /* Secondary line: "email · maskedPassword" for email_password, or
       "email · maskedKey" / just "maskedKey" for api_key (depending on
       whether the row has been tagged with a gmail). */
    let secondary;
    if (accType === 'email_password') {
      secondary = `<code style="opacity:.8;">${_acctEsc(a.email || '')} &middot; ${_acctEsc(a.maskedPassword || '****')}</code>`;
    } else if (a.email) {
      secondary = `<code style="opacity:.8;">${_acctEsc(a.email)} &middot; ${_acctEsc(a.maskedKey || '')}</code>`;
    } else {
      secondary = `<code style="opacity:.8;">${_acctEsc(a.maskedKey || '')}</code>`;
    }
    const info = document.createElement('div');
    info.className = 'cbe-am-info';
    info.innerHTML = `${dot} ${badge}<b>${_acctEsc(a.label)}</b><br>${secondary}${dis}`;
    row.appendChild(info);

    const mk = (txt, cls, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cbe-am-btn' + (cls ? ' ' + cls : ''); b.textContent = txt;
      b.addEventListener('click', onClick);
      return b;
    };
    if (!a.active) row.appendChild(mk('Use', 'cbe-am-btn--neutral', () => {
      if (api) api.postMessage({ type: 'useAccount', provider: __cbeAmProvider, accountId: a.id });
    }));
    row.appendChild(mk('Edit', '', () => {
      __cbeAmEditingId = a.id;
      renderAccountsModalList(payload);
    }));
    row.appendChild(mk('Delete', 'cbe-am-btn--del', () => {
      _amStartDelete(a, row);
    }));
    list.appendChild(row);
  });
}

/* Delete with a 2s undo window: the row swaps to a "Deleted — Undo" strip; if
   the user doesn't click Undo within 2s we fire removeAccount to the host. */
function _amStartDelete(account, row) {
  if (__cbeAmUndo) { clearTimeout(__cbeAmUndo.timer); __cbeAmUndo = null; }
  row.innerHTML = '';
  row.style.opacity = '1';
  const msg = document.createElement('div');
  msg.className = 'cbe-am-info';
  msg.innerHTML = `Deleted <b>${_acctEsc(account.label)}</b>`;
  row.appendChild(msg);
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button'; undoBtn.className = 'cbe-am-btn cbe-am-btn--neutral'; undoBtn.textContent = 'Undo';
  row.appendChild(undoBtn);
  const fire = () => {
    __cbeAmUndo = null;
    if (api) api.postMessage({ type: 'removeAccount', provider: __cbeAmProvider, accountId: account.id });
  };
  const timer = setTimeout(fire, 2000);
  __cbeAmUndo = { accountId: account.id, timer };
  undoBtn.addEventListener('click', () => {
    clearTimeout(timer);
    __cbeAmUndo = null;
    /* Re-fetch fresh state so the row comes back exactly as the host has it. */
    if (api) api.postMessage({ type: 'listAccounts', provider: __cbeAmProvider });
  });
}

(function wireAccountsModal() {
  const sel = _amEl('accountsProvider');
  if (sel) sel.addEventListener('change', () => {
    __cbeAmProvider = sel.value || null;
    __cbeAmEditingId = null;
    if (__cbeAmUndo) { clearTimeout(__cbeAmUndo.timer); __cbeAmUndo = null; }
    _amShowError('');
    _amUpdateAddFormMode();
    if (__cbeAmProvider && api) api.postMessage({ type: 'listAccounts', provider: __cbeAmProvider });
  });
  const closeBtn = _amEl('cbe-am-close');
  const doneBtn  = _amEl('cbe-am-done');
  if (closeBtn) closeBtn.addEventListener('click', closeAccountsModal);
  if (doneBtn)  doneBtn.addEventListener('click', closeAccountsModal);
  /* Click-outside the .cbe-box closes the modal. */
  const modal = _amEl('accountsModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeAccountsModal(); });
  const addBtn = _amEl('cbe-am-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (!__cbeAmProvider) { _amShowError('Pick a provider first.'); return; }
    const t = _amProviderType(__cbeAmProvider);
    if (t === 'none') { _amShowError('This provider is local — no account needed.'); return; }
    const label = ((_amEl('cbe-am-label') || {}).value || '').trim();
    const payload = { type: 'addAccount', provider: __cbeAmProvider, label };
    if (t === 'email_password') {
      const email = ((_amEl('cbe-am-email')    || {}).value || '').trim();
      const pw    =  (_amEl('cbe-am-password') || {}).value || '';
      if (!email) { _amShowError('Enter an email.'); return; }
      if (!pw)    { _amShowError('Enter a password.'); return; }
      payload.accountType = 'email_password';
      payload.email = email;
      payload.password = pw;
    } else {
      const key = ((_amEl('cbe-am-key') || {}).value || '').trim();
      if (!key) { _amShowError('Enter an API key.'); return; }
      payload.accountType = 'api_key';
      payload.apiKey = key;
    }
    if (api) api.postMessage(payload);
  });
  /* Enter in any add-form field submits the form. */
  ['cbe-am-key', 'cbe-am-email', 'cbe-am-password', 'cbe-am-label'].forEach(id => {
    const el = _amEl(id);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (addBtn) addBtn.click(); }
    });
  });
})();
let __cbeActiveSkin = '';  /* bare filename, e.g. 'noir.css'. '' = no skin */
let __cbeSkinsList  = null;/* null = not yet discovered for this session; [] = scanned, empty */

function applySkinUri(uri) {
  /* Swap the <link id="cbe-skin"> href. Empty/missing uri clears the
     stylesheet. Browsers handle href="" as a no-op load, so we set the
     href to empty string to unload the previous skin. Also stamp the
     active skin id onto <body data-skin> so skin CSS can target
     skin-specific UI hooks (e.g. tamagotchi docks the pet panel into
     the prompt shell's left edge). */
  const link = document.getElementById('cbe-skin');
  if (!link) return;
  link.setAttribute('href', uri || '');
  /* __cbeActiveSkin is a bare filename like "tamagotchi.css" or empty
     string. Strip extension for the data-attribute value. */
  try {
    const bare = String(__cbeActiveSkin || '').replace(/\.css$/i, '');
    if (bare) document.body.setAttribute('data-skin', bare);
    else      document.body.removeAttribute('data-skin');
  } catch (e) {
    console.warn('[CBE] data-skin stamp failed:', e && e.message);
  }
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
    'code-bar-bg':      '--cbe-code-bar-bg',
    'code-bar-fg':      '--cbe-code-bar-fg',
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
            ['init', 'add -A', 'commit', 'status', 'log --oneline -10', 'diff', 'branch', 'fetch', 'pull', 'push'].map(c =>
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
    +     '<div id="cbe-accounts-wrap" style="margin:6px 0 2px;">'
    +       '<div style="display:flex;align-items:center;gap:8px;">'
    +         '<label style="margin:0;flex:1;">Accounts <span id="cbe-acct-count" style="opacity:.6;font-weight:400;"></span></label>'
    +         '<button type="button" id="cbe-acct-add-btn" class="cbe-btn" style="padding:4px 12px;font-size:12px;">+ Add Account</button>'
    +       '</div>'
    +       '<div id="cbe-acct-list" style="margin-top:6px;display:flex;flex-direction:column;gap:4px;"></div>'
    +       '<div id="cbe-acct-form" style="display:none;margin-top:8px;padding:8px;border:1px solid var(--cbe-modal-border,#444);border-radius:5px;background:var(--cbe-modal-bg,#181818);">'
    +         '<input type="text" id="cbe-acct-label" placeholder="Label (e.g. work, alt-2)" style="width:100%;margin-bottom:6px;padding:6px 8px;background:var(--cbe-modal-bg,#1c1c1c);color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);border-radius:4px;font:inherit;box-sizing:border-box;">'
    +         '<input type="password" id="cbe-acct-key" placeholder="API key" autocomplete="off" spellcheck="false" style="width:100%;margin-bottom:6px;padding:6px 8px;background:var(--cbe-modal-bg,#1c1c1c);color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);border-radius:4px;font:inherit;box-sizing:border-box;">'
    +         '<div id="cbe-acct-err" style="display:none;color:#ff6b6b;font-size:12px;margin-bottom:6px;"></div>'
    +         '<div style="display:flex;gap:6px;justify-content:flex-end;">'
    +           '<button type="button" id="cbe-acct-cancel-btn" class="cbe-btn cbe-cancel" style="padding:4px 12px;font-size:12px;">Cancel</button>'
    +           '<button type="button" id="cbe-acct-save-btn" class="cbe-btn cbe-save" style="padding:4px 12px;font-size:12px;">Add</button>'
    +         '</div>'
    +       '</div>'
    +     '</div>'
    +     '<div><label>Skin</label><select id="cbe-set-skin"><option value="">Loading skins…</option></select></div>'
    +     '<div><label>Language</label><div id="cbe-set-language-wrap" style="position:relative;"></div></div>'
    +     '<div style="display:flex;align-items:center;gap:10px;margin-top:4px;">'
    +       '<label for="cbe-set-sfx-enabled" style="margin:0;flex:1;">Sound Effects</label>'
    +       '<input type="checkbox" id="cbe-set-sfx-enabled" style="width:auto;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +     '<div>'
    +       '<label for="cbe-set-sfx-volume">Volume <span id="cbe-set-sfx-volume-pct" style="opacity:.65;font-weight:400;">55%</span></label>'
    +       '<input type="range" id="cbe-set-sfx-volume" min="0" max="100" step="1" value="55" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +     /* Tool calls section — controls daisy-chain command execution for
           bridge chat. mode=off disables; allowlist runs only safe commands
           without prompting (everything else prompts); confirm always prompts;
           auto runs everything without prompting. */
    +     '<div id="cbe-tc-section" style="margin-top:8px;padding:8px;border:1px solid var(--cbe-modal-border,#444);border-radius:5px;">'
    +       '<div style="font-weight:600;margin-bottom:6px;">Tool calls (bridge daisy-chain)</div>'
    +       '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">'
    +         '<label style="margin:0;flex:1;" for="cbe-tc-mode">Mode</label>'
    +         '<select id="cbe-tc-mode" style="flex:2;">'
    +           '<option value="off">off (disable)</option>'
    +           '<option value="allowlist">allowlist (safe commands no prompt)</option>'
    +           '<option value="confirm">confirm (always ask)</option>'
    +           '<option value="auto">auto (no prompt, run everything)</option>'
    +         '</select>'
    +       '</div>'
    +       '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">'
    +         '<label style="margin:0;flex:1;" for="cbe-tc-maxsteps">Max chain steps</label>'
    +         '<input type="number" id="cbe-tc-maxsteps" min="1" max="50" step="1" value="10" style="flex:2;">'
    +       '</div>'
    +       '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">'
    +         '<label style="margin:0;flex:1;" for="cbe-tc-timeout">Per-command timeout (s)</label>'
    +         '<input type="number" id="cbe-tc-timeout" min="1" max="600" step="1" value="60" style="flex:2;">'
    +       '</div>'
    +       '<div>'
    +         '<label for="cbe-tc-allowlist">Allowlist (one per line)</label>'
    +         '<textarea id="cbe-tc-allowlist" rows="6" spellcheck="false" style="width:100%;font:12px Consolas,monospace;background:#000;color:#dcdcdc;border:1px solid var(--cbe-modal-border,#444);border-radius:4px;padding:6px;box-sizing:border-box;"></textarea>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="cbe-foot">'
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
    if (p.bridge) suffix = '  (bridge)';
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
    if (!prov) return;
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
    /* Bridge providers (chatgptBridge/grokBridge/.../ollamaBridge) have
       no API key — auth lives in the tray exe's QtWebEngine profile (or
       in the local ollama daemon). Suppress the no-key warning. */
    const warn = overlay.querySelector('#cbe-set-warn');
    if (prov.bridge) {
      warn.classList.remove('show');
      ms.disabled = false;
    } else {
      ms.disabled = false;
      warn.classList.toggle('show', !prov.haveKey);
    }
    /* Refresh the multi-account section for the newly-selected provider.
       Hidden entirely for bridge providers (no API keys to manage). */
    const acctWrap = overlay.querySelector('#cbe-accounts-wrap');
    if (acctWrap) {
      acctWrap.style.display = prov.bridge ? 'none' : '';
      if (!prov.bridge) {
        __cbeAccountsProvider = prov.id;
        _hideAccountForm();
        if (api) api.postMessage({ type: 'getAccounts', provider: prov.id });
      }
    }
  };
  sel.addEventListener('change', renderModels);
  renderModels();

  /* ── Accounts section wiring ──────────────────────────────────────────
     The list itself is rendered by renderAccountsList() when the host
     answers getAccounts with an accountsState message. Here we wire the
     Add-Account form's open/cancel/submit buttons. */
  const acctAddBtn    = overlay.querySelector('#cbe-acct-add-btn');
  const acctSaveBtn   = overlay.querySelector('#cbe-acct-save-btn');
  const acctCancelBtn = overlay.querySelector('#cbe-acct-cancel-btn');
  if (acctAddBtn) acctAddBtn.addEventListener('click', () => {
    const form = overlay.querySelector('#cbe-acct-form');
    if (form) { form.style.display = ''; const lbl = overlay.querySelector('#cbe-acct-label'); if (lbl) lbl.focus(); }
  });
  if (acctCancelBtn) acctCancelBtn.addEventListener('click', _hideAccountForm);
  if (acctSaveBtn) acctSaveBtn.addEventListener('click', () => {
    const label = (overlay.querySelector('#cbe-acct-label') || {}).value || '';
    const key   = (overlay.querySelector('#cbe-acct-key') || {}).value || '';
    if (!key.trim()) { _showAccountFormError('Enter an API key.'); return; }
    if (api) api.postMessage({ type: 'addAccount', provider: __cbeAccountsProvider, label: label.trim(), apiKey: key.trim() });
    /* The host replies with accountsState (re-render) or accountError. */
  });

  /* Language dropdown — custom widget (a native <select> can't render <img>,
     and on Windows the regional-indicator emoji shows as plain letters, so
     real SVG flags require this). The host substitutes {{ASSETS_BASE}} into
     window.__cbeAssetsBase; we build flag URIs from it and write the chosen
     code to wrap.dataset.value, which the Save handler reads. */
  (function populateLanguages() {
    const wrap = overlay.querySelector('#cbe-set-language-wrap');
    if (!wrap) return;
    const assetsBase = String(window.__cbeAssetsBase || '').replace(/\/$/, '');
    const flagUri = (code) => `${assetsBase}/flags/${encodeURIComponent(code)}.svg`;
    const langs = Array.isArray(payload.languages) ? payload.languages : [];
    const entries = langs.length ? langs : [{ code: 'en', name: 'English', flag: '' }];
    const findEntry = (code) =>
      entries.find((e) => e.code === code) || entries[0];
    const initial = findEntry(payload.language || 'en');
    wrap.dataset.value = initial.code;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'cbe-set-language-trigger';
    trigger.style.cssText =
      'width:100%;display:flex;align-items:center;gap:8px;'
      + 'padding:6px 28px 6px 8px;background:var(--cbe-modal-bg,#1c1c1c);'
      + 'color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);'
      + 'border-radius:4px;cursor:pointer;font:inherit;text-align:left;'
      + 'position:relative;';
    const triggerImg = document.createElement('img');
    triggerImg.alt = '';
    triggerImg.src = flagUri(initial.code);
    triggerImg.style.cssText =
      'width:22px;height:16px;object-fit:cover;border-radius:2px;flex-shrink:0;';
    /* Build the dual-label string: "Native · English" so a user reading either
       script can recognize the entry. Fall back gracefully when one side is
       missing. */
    const dualLabel = (e) => {
      const native = (e.nativeName || e.name || '').trim();
      const english = (e.englishName || '').trim();
      if (native && english && native !== english) return `${native} · ${english}`;
      return native || english || e.code;
    };
    const triggerLabel = document.createElement('span');
    triggerLabel.textContent = dualLabel(initial);
    triggerLabel.style.flex = '1';
    const triggerCaret = document.createElement('span');
    triggerCaret.textContent = '▾';
    triggerCaret.style.cssText =
      'position:absolute;right:10px;top:50%;transform:translateY(-50%);'
      + 'pointer-events:none;opacity:.7;';
    trigger.appendChild(triggerImg);
    trigger.appendChild(triggerLabel);
    trigger.appendChild(triggerCaret);

    const menu = document.createElement('div');
    menu.id = 'cbe-set-language-menu';
    menu.setAttribute('role', 'listbox');
    menu.style.cssText =
      'display:none;position:absolute;left:0;right:0;top:100%;'
      + 'margin-top:2px;max-height:260px;overflow-y:auto;'
      + 'background:var(--cbe-modal-bg,#1c1c1c);color:var(--cbe-modal-fg,#eee);'
      + 'border:1px solid var(--cbe-modal-border,#444);border-radius:4px;'
      + 'z-index:10;box-shadow:0 6px 14px rgba(0,0,0,.4);';

    wrap.innerHTML = '';
    wrap.appendChild(trigger);
    wrap.appendChild(menu);

    function selectLanguage(code) {
      const entry = findEntry(code);
      wrap.dataset.value = entry.code;
      triggerImg.src = flagUri(entry.code);
      triggerLabel.textContent = dualLabel(entry);
    }

    entries.forEach((l) => {
      const row = document.createElement('div');
      row.setAttribute('data-code', l.code);
      row.setAttribute('role', 'option');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;';
      const img = document.createElement('img');
      img.alt = '';
      img.src = flagUri(l.code);
      img.style.cssText =
        'width:22px;height:16px;object-fit:cover;border-radius:2px;flex-shrink:0;';
      const label = document.createElement('span');
      label.textContent = dualLabel(l);
      label.style.flex = '1';
      const codeTag = document.createElement('span');
      codeTag.textContent = l.code;
      codeTag.style.cssText = 'opacity:.55;font-size:.85em;';
      row.appendChild(img);
      row.appendChild(label);
      row.appendChild(codeTag);
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--cbe-modal-accent,#2a5d8f)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectLanguage(l.code);
        closeMenu();
        playSfx('click');
      });
      menu.appendChild(row);
    });

    function onDocClick(ev) {
      if (!wrap.contains(ev.target)) closeMenu();
    }
    function openMenu() {
      menu.style.display = 'block';
      /* defer so the same click that opened the menu doesn't close it. */
      setTimeout(() => document.addEventListener('click', onDocClick), 0);
    }
    function closeMenu() {
      menu.style.display = 'none';
      document.removeEventListener('click', onDocClick);
    }
    trigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.style.display === 'block' ? closeMenu() : openMenu();
    });
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
    /* Update __cbeActiveSkin BEFORE applySkinUri so the data-skin stamp
       reflects the previewed skin and skin-specific UI hooks paint live. */
    __cbeActiveSkin = (e.target && e.target.value) || '';
    applySkinUri(uri);
    /* Live-preview the modal palette too — pulled out of dataset.colors
       (set by renderSkinDropdown when the host's listSkins reply arrived). */
    let colors = null;
    try { colors = opt && opt.dataset && opt.dataset.colors ? JSON.parse(opt.dataset.colors) : null; }
    catch (_) { colors = null; }
    applySkinColors(colors);
  });

  /* Tool-call settings — hydrate from payload.toolCall (extension's
     loadToolCallConfig). Form persists on Save via setProvider.toolCall. */
  try {
    const tc = (payload && payload.toolCall) || { mode: 'allowlist', maxSteps: 10, timeoutS: 60, allowlist: [] };
    const modeEl = overlay.querySelector('#cbe-tc-mode');
    const maxEl  = overlay.querySelector('#cbe-tc-maxsteps');
    const toEl   = overlay.querySelector('#cbe-tc-timeout');
    const alEl   = overlay.querySelector('#cbe-tc-allowlist');
    if (modeEl) modeEl.value = ['off','allowlist','confirm','auto'].includes(tc.mode) ? tc.mode : 'allowlist';
    if (maxEl)  maxEl.value  = String(tc.maxSteps || 10);
    if (toEl)   toEl.value   = String(tc.timeoutS || 60);
    if (alEl)   alEl.value   = (Array.isArray(tc.allowlist) ? tc.allowlist : []).join('\n');
  } catch (e) { /* swallow */ }

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
      /* Restore __cbeActiveSkin BEFORE applySkinUri so the data-skin stamp
         on <body> reverts to the saved skin (not the previewed one). */
      __cbeActiveSkin = __cbeSavedSkinAtOpen;
      applySkinUri(__cbeSavedSkinUriAtOpen);
      applySkinColors(__cbeSavedColorsAtOpen);
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
      const langWrap = overlay.querySelector('#cbe-set-language-wrap');
      const language = (langWrap && langWrap.dataset && langWrap.dataset.value) || 'en';
      /* Collect tool-call settings from the Tool calls section. Empty
         allowlist is allowed (means no commands are auto-allowed in
         allowlist mode). */
      let toolCall = null;
      try {
        const modeEl = overlay.querySelector('#cbe-tc-mode');
        const maxEl  = overlay.querySelector('#cbe-tc-maxsteps');
        const toEl   = overlay.querySelector('#cbe-tc-timeout');
        const alEl   = overlay.querySelector('#cbe-tc-allowlist');
        const allowLines = (alEl && alEl.value || '')
          .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        toolCall = {
          mode: (modeEl && modeEl.value) || 'allowlist',
          maxSteps: Number((maxEl && maxEl.value) || 10),
          timeoutS: Number((toEl && toEl.value) || 60),
          allowlist: allowLines,
        };
      } catch (e) { /* swallow */ }
      if (api) api.postMessage({
        type: 'setProvider', provider, model,
        sfxEnabled: sfxEnabledVal, sfxVolume: sfxVolumeVal,
        skin, language,
        toolCall,
      });
      closeSettings();
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
     resolved to a proportional UA default.

     Skin-aware: the tamagotchi skin ships its own retro pixel font
     (Jersey 10) and wants the prompt to use it. We pick the family from
     the active <body data-skin> stamp so the nuclear inline lock doesn't
     stomp a skin's intentional font choice. */
  const DEFAULT_FAMILY = 'var(--vscode-editor-font-family, Consolas, "Cascadia Mono", "Courier New", monospace)';
  const SKIN_FAMILY = {
    tamagotchi: "'Jersey 10', 'Courier New', monospace",
  };
  function familyForActiveSkin() {
    const skin = (document.body && document.body.dataset && document.body.dataset.skin) || '';
    return SKIN_FAMILY[skin] || DEFAULT_FAMILY;
  }
  /* Sentinel substring used by the observer to detect "our font got stripped"
     — switches with the skin so a skin-font lock isn't seen as foreign. */
  function sentinelFor(family) {
    return family.indexOf('Jersey') !== -1 ? 'Jersey' : 'Consolas';
  }
  function apply(el) {
    if (!el) return;
    const family = familyForActiveSkin();
    el.style.setProperty('font',        '400 18px/1.34 ' + family, 'important');
    el.style.setProperty('font-family', family,                    'important');
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
          const want = sentinelFor(familyForActiveSkin());
          if (!cur || cur.indexOf(want) === -1) apply(el);
        }
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    /* Re-apply when the skin changes — the data-skin stamp flips on <body>. */
    const skinMo = new MutationObserver(() => apply(el));
    if (document.body) skinMo.observe(document.body, { attributes: true, attributeFilter: ['data-skin'] });
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
  /* The help doc is rendered in an <iframe srcdoc>. srcdoc takes the full
     HTML document as inline content (NOT a fetched URL) so:
       - there's no CSP frame-src / asWebviewUri resource-load problem,
       - the doc is a real isolated document, so its <style>, <script>,
         :root vars and <body> background all apply natively (the previous
         innerHTML approach rendered the <style> block as visible text),
       - help.html's own smooth-scroll script runs as-is.
     Falls back to a message if the host hasn't shipped the HTML. */
  const html = window.__cbeHelpHtml || '';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Help">
      <div class="cbe-hdr" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <span data-i18n="title.help">Claude Codex — Black Edition · Help</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <button id="cbe-help-changelog-btn" type="button"
                  data-i18n="label.change_log"
                  style="background:rgba(255,255,255,0.08);color:inherit;border:1px solid rgba(255,255,255,0.18);border-radius:5px;padding:4px 12px;font:12px ui-sans-serif,system-ui,sans-serif;cursor:pointer;">
            Change Log
          </button>
          <button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)"></button>
        </div>
      </div>
      <div id="cbe-help-body" style="flex:1 1 auto;display:flex;background:var(--cbe-modal-bg);"></div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) closeHelp(); });
  modal.querySelector('.cbe-x').addEventListener('click', closeHelp);
  const changelogBtn = modal.querySelector('#cbe-help-changelog-btn');
  if (changelogBtn) changelogBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openChangelog();
  });
  document.body.appendChild(modal);
  /* Re-apply translations to the freshly-built modal so the title + Change Log
     button pick up the active locale. applyStrings walks data-i18n attributes. */
  if (typeof applyStrings === 'function') applyStrings();
  const bodyHost = modal.querySelector('#cbe-help-body');
  if (html) {
    const iframe = document.createElement('iframe');
    iframe.title = 'Help';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    iframe.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:var(--cbe-modal-bg);';
    iframe.srcdoc = html;
    bodyHost.appendChild(iframe);
  } else {
    bodyHost.innerHTML = '<div style="padding:24px;color:var(--cbe-modal-fg);">Help content not loaded. Reload the panel to retry.</div>';
  }
}

/* ── Support / promo nag screens ────────────────────────────────────────
   Three short, dismissable cards that ask the user to chip in or book a
   consultation. The host (extension.js) tracks panel-open runs in
   config.ini [stats] run_count and posts `{type:'nag', run}` on runs
   3, 6, 10, 20, then every 30 after that. The panel picks ONE of the
   three messages at random per fire so the rotation feels fresh.
   Each CTA opens its URL via the existing host openExternal handler
   (vscode.env.openExternal) so the user's default browser handles it. */
const CBE_NAGS = [
  {
    icon: '💛',
    title: 'Help keep this open-source',
    body:  'Claude Codex Black is free, open source, and built solo. If it makes your day better, a one-time tip on GoFundMe lets me keep shipping features and fixing bugs.',
    cta:   'Open GoFundMe',
    url:   'https://www.gofundme.com/manage/donate-today-to-support-the-creation-of-open-source-tools',
  },
  {
    icon: '❤️',
    title: 'Sponsor on GitHub',
    body:  'Prefer recurring? Sponsor me monthly on GitHub. Any tier funds the next sprint — extensions, skins, bridges, the whole stack.',
    cta:   'Open GitHub Sponsors',
    url:   'https://github.com/sponsors/tibberous?preview=true',
  },
  {
    icon: '☕',
    title: 'Free consultation',
    body:  'Need help wiring this into your own workflow, or have a custom build idea? Book a free consultation — no obligation.',
    cta:   'Book a free consultation',
    url:   'https://trenttompkins.com/free_consultation',
  },
];

function openNag(run) {
  /* Don't stack — replace any existing nag modal. */
  const old = document.getElementById('cbe-nag-modal');
  if (old) old.remove();
  const nag = CBE_NAGS[Math.floor(Math.random() * CBE_NAGS.length)];
  const overlay = document.createElement('div');
  overlay.id = 'cbe-nag-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
  overlay.innerHTML =
    '<div class="cbe-box" role="dialog" aria-modal="true" aria-label="' + escapeHtmlExt(nag.title) + '" ' +
      'style="width:440px;max-width:92vw;background:var(--cbe-modal-bg,#1c1f24);' +
      'border:2px solid var(--cbe-modal-border,#353a45);border-radius:12px;' +
      'box-shadow:0 18px 60px rgba(0,0,0,.7);overflow:hidden;">' +
      '<div class="cbe-hdr" style="padding:14px 18px;background:linear-gradient(90deg,' +
        'var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);' +
        'font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<span style="font-size:15px;">' + nag.icon + '  ' + escapeHtmlExt(nag.title) + '</span>' +
        '<button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)" ' +
          'style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:20px;cursor:pointer;line-height:1;">×</button>' +
      '</div>' +
      '<div style="padding:18px 20px;color:var(--cbe-modal-fg,#e7eaef);font:14px/1.55 system-ui,sans-serif;">' +
        escapeHtmlExt(nag.body) +
      '</div>' +
      '<div style="padding:0 20px 18px 20px;display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="cbe-nag-later" type="button" ' +
          'style="background:rgba(255,255,255,.06);color:var(--cbe-modal-fg,#e7eaef);' +
          'border:1px solid var(--cbe-modal-border,#3a414c);border-radius:6px;padding:8px 14px;cursor:pointer;">Later</button>' +
        '<button class="cbe-nag-cta" type="button" data-url="' + escapeHtmlExt(nag.url) + '" ' +
          'style="background:var(--cbe-modal-accent,#173050);color:var(--cbe-modal-title-fg,#4ea8ff);' +
          'border:1px solid var(--cbe-modal-border,#4ea8ff);border-radius:6px;padding:8px 14px;cursor:pointer;font-weight:600;">' +
          escapeHtmlExt(nag.cta) + '</button>' +
      '</div>' +
    '</div>';
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.cbe-x').addEventListener('click', close);
  overlay.querySelector('.cbe-nag-later').addEventListener('click', close);
  overlay.querySelector('.cbe-nag-cta').addEventListener('click', () => {
    const url = overlay.querySelector('.cbe-nag-cta').getAttribute('data-url') || '';
    if (api && url) api.postMessage({ type: 'openExternal', url });
    close();
  });
  const onEsc = (e) => { if (e.key === 'Escape' && document.getElementById('cbe-nag-modal')) { close(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

/* ── /switch auth picker ──────────────────────────────────────────────────
   CBE's rebranded clone of Claude Code's login screen. Three big buttons:
   Claude.ai Subscription / Anthropic Console / Bedrock, Foundry, or Vertex.
   Stays inside CBE per [[feedback-never-touch-anthropic-dir]] — we don't
   modify the stock Claude Code webview, we render our own. Each button maps
   to a CBE account flow (browser bridge / API key / external docs). */
function openAuthPicker() {
  const old = document.getElementById('cbe-authpicker-modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'cbe-authpicker-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
  const btnStyle = 'display:block;width:100%;padding:12px 16px;margin:6px 0;border-radius:6px;' +
    'border:1px solid var(--cbe-modal-border,#3a414c);background:var(--cbe-modal-accent,#173050);' +
    'color:var(--cbe-modal-title-fg,#e7eaef);font:600 14px/1.3 system-ui,sans-serif;cursor:pointer;text-align:center;';
  const subStyle = 'opacity:.65;font:13px/1.5 system-ui,sans-serif;color:var(--cbe-modal-fg,#e7eaef);margin:4px 0 14px 0;';
  overlay.innerHTML =
    '<div class="cbe-box" role="dialog" aria-modal="true" aria-label="Switch account" ' +
      'style="width:480px;max-width:92vw;background:var(--cbe-modal-bg,#1c1f24);' +
      'border:2px solid var(--cbe-modal-border,#353a45);border-radius:12px;' +
      'box-shadow:0 18px 60px rgba(0,0,0,.7);overflow:hidden;">' +
      '<div class="cbe-hdr" style="padding:14px 18px;background:linear-gradient(90deg,' +
        'var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);' +
        'font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<span style="font-size:15px;">Switch account</span>' +
        '<button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)" ' +
          'style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:20px;cursor:pointer;line-height:1;">×</button>' +
      '</div>' +
      '<div style="padding:18px 22px;color:var(--cbe-modal-fg,#e7eaef);font:14px/1.55 system-ui,sans-serif;">' +
        '<div style="margin-bottom:6px;">Claude Codex Black Ed. can be used with your Claude subscription or billed based on API usage through your Console account.</div>' +
        '<div style="' + subStyle + '">How do you want to log in?</div>' +
        '<button class="cbe-ap-claude"    type="button" style="' + btnStyle + '">Claude.ai Subscription</button>' +
        '<div style="' + subStyle + '">Use your Claude Pro, Team, or Enterprise subscription (browser bridge).</div>' +
        '<button class="cbe-ap-anthropic" type="button" style="' + btnStyle + '">Anthropic Console</button>' +
        '<div style="' + subStyle + '">Pay for API usage through your Console account (API key).</div>' +
        '<button class="cbe-ap-bedrock"   type="button" style="' + btnStyle + '">Bedrock, Foundry, or Vertex</button>' +
        '<div style="' + subStyle + '">Instructions on how to use API keys or third-party providers.</div>' +
      '</div>' +
    '</div>';
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.cbe-x').addEventListener('click', close);
  overlay.querySelector('.cbe-ap-claude').addEventListener('click', () => {
    close();
    /* Pre-target the standalone Accounts modal at the Claude browser bridge
       so the user lands directly in the "add bridge login" form. */
    __cbeAmProvider = 'claudeBridge';
    openAccountsModal();
  });
  overlay.querySelector('.cbe-ap-anthropic').addEventListener('click', () => {
    close();
    __cbeAmProvider = 'anthropic';
    openAccountsModal();
  });
  overlay.querySelector('.cbe-ap-bedrock').addEventListener('click', () => {
    close();
    if (api) api.postMessage({ type: 'openExternal', url: 'https://docs.anthropic.com/en/api/claude-on-amazon-bedrock' });
  });
  const onEsc = (e) => { if (e.key === 'Escape' && document.getElementById('cbe-authpicker-modal')) { close(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

/* ── Change Log modal — separate from Help so closing Change Log returns the
   user to the open Help modal. Same srcdoc-iframe pattern: extension.js
   reads panel/change_log.html on activate and ships the body as
   window.__cbeChangelogHtml in the init payload. */
function openChangelog() {
  let modal = document.getElementById('cbe-changelog-modal');
  if (modal) { modal.style.display = 'flex'; return; }
  modal = document.createElement('div');
  modal.id = 'cbe-changelog-modal';
  /* Match the help modal's overlay layout. */
  modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);';
  modal.innerHTML = `
    <div class="cbe-box" role="dialog" aria-modal="true" aria-label="Change Log"
         style="width:86vw;max-width:1100px;height:80vh;display:flex;flex-direction:column;background:var(--cbe-modal-bg);border:2px solid var(--cbe-modal-border);border-radius:10px;overflow:hidden;">
      <div class="cbe-hdr" style="padding:10px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;display:flex;justify-content:space-between;align-items:center;">
        <span data-i18n="label.change_log">Change Log</span>
        <button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)"></button>
      </div>
      <div id="cbe-changelog-body" style="flex:1 1 auto;display:flex;background:var(--cbe-modal-bg);"></div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) closeChangelog(); });
  modal.querySelector('.cbe-x').addEventListener('click', closeChangelog);
  document.body.appendChild(modal);
  if (typeof applyStrings === 'function') applyStrings();
  const body = modal.querySelector('#cbe-changelog-body');
  const html = window.__cbeChangelogHtml || '';
  if (html) {
    const iframe = document.createElement('iframe');
    iframe.title = 'Change Log';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    iframe.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:var(--cbe-modal-bg);';
    iframe.srcdoc = html;
    body.appendChild(iframe);
  } else {
    body.innerHTML = '<div style="padding:24px;color:var(--cbe-modal-fg);">Change log not yet generated. Run <code>python tools/build_changelog.py</code> then reload the panel.</div>';
  }
}
function closeChangelog() {
  const m = document.getElementById('cbe-changelog-modal');
  if (m) m.remove();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-changelog-modal')) closeChangelog();
});
function closeHelp() {
  const m = document.getElementById('cbe-help-modal');
  if (m) m.remove();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-help-modal')) closeHelp();
});
document.getElementById('helpBtn').addEventListener('click', openHelp);


/* ── Extensions marketplace modal — NATIVE render (no iframe).
   VSCode webviews render external-https iframes as a black rectangle on many
   builds, so instead of embedding the marketplace PHP we ask the host to
   fetch the catalog XML (`fetchExtensionsCatalog`) and render the cards here
   with plain DOM. Install → `installExtension` host message → the host
   downloads + MD5-verifies + extracts the .ext, then echoes back
   `cbe.installResultFromHost` which flips the matching card's button. */
function openExtensionsMarketplace() {
  let modal = document.getElementById('cbe-ext-modal');
  if (modal) { modal.style.display = 'flex'; return; }
  modal = document.createElement('div');
  modal.id = 'cbe-ext-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
  modal.innerHTML =
    '<div class="cbe-box" role="dialog" aria-modal="true" aria-label="Extensions Marketplace" ' +
      'style="width:80vw;height:80vh;max-width:1040px;display:flex;flex-direction:column;' +
      'background:var(--cbe-modal-bg,#1c1f24);border:2px solid var(--cbe-modal-border,#353a45);' +
      'border-radius:10px;overflow:hidden;box-shadow:0 12px 50px rgba(0,0,0,.7);">' +
      '<div class="cbe-hdr" style="padding:12px 16px;background:linear-gradient(90deg,' +
        'var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);' +
        'font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>Extensions Marketplace</span>' +
        '<button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)" ' +
          'style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      '<div id="cbe-ext-body" style="flex:1 1 auto;overflow:auto;padding:16px 18px;' +
        'color:var(--cbe-modal-fg,#e7eaef);font:13px/1.5 system-ui,sans-serif;">' +
        '<div style="opacity:.7;padding:20px 0;">Loading marketplace…</div>' +
      '</div>' +
    '</div>';
  modal.addEventListener('click', e => { if (e.target === modal) closeExtensionsMarketplace(); });
  modal.querySelector('.cbe-x').addEventListener('click', closeExtensionsMarketplace);
  document.body.appendChild(modal);
  /* Ask the host for the catalog; renderExtensionsCatalog() fills the body
     when the `extensionsCatalog` message comes back. */
  if (api) api.postMessage({ type: 'fetchExtensionsCatalog' });
}
function closeExtensionsMarketplace() {
  const m = document.getElementById('cbe-ext-modal');
  if (m) m.remove();
}
function escapeHtmlExt(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/* SVG icons used on installed extension cards + on the toolbar pin buttons.
   16×16, single-color (white) so they pick up the inherited button text color. */
const CBE_EXT_ICONS = {
  open:      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l6 5-6 5z" fill="currentColor"/></svg>',
  pin:       '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5l5 5-2 1-3 3 1 2.5-1 1-3-3-3.5 3.5-1-1 3.5-3.5-3-3 1-1 2.5 1 3-3z"/></svg>',
  pinned:    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M9.5 1.5l5 5-2 1-3 3 1 2.5-1 1-3-3-3.5 3.5-1-1 3.5-3.5-3-3 1-1 2.5 1 3-3z"/></svg>',
  uninstall: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 4l.7 9.5a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9L11 4M7 7v5M9 7v5"/></svg>',
};

function _extCardActionsHtml(ext) {
  /* Renders the bottom-right action area: either a single "Install" button
     (not installed) or three icon buttons Open / Pin / Uninstall (installed).
     The Pin icon swaps to a filled state when ext.pinned is true. */
  if (!ext.installed) {
    return (
      '<button type="button" class="cbe-ext-install" ' +
        'data-ext-id="' + escapeHtmlExt(ext.id) + '" ' +
        'data-ext-name="' + escapeHtmlExt(ext.name) + '" ' +
        'data-ext-url="' + escapeHtmlExt(ext.fileUrl) + '" ' +
        'data-ext-md5="' + escapeHtmlExt(ext.md5) + '" ' +
        'style="background:var(--cbe-modal-accent,#173050);color:var(--cbe-modal-title-fg,#4ea8ff);' +
        'border:1px solid var(--cbe-modal-border,#4ea8ff);border-radius:6px;padding:6px 12px;' +
        'font:13px ui-monospace,monospace;cursor:pointer;">Install</button>'
    );
  }
  const iconBtn = (cls, title, svg, color) =>
    '<button type="button" class="' + cls + '" data-ext-id="' + escapeHtmlExt(ext.id) + '" ' +
      'data-ext-name="' + escapeHtmlExt(ext.name) + '" ' +
      'title="' + escapeHtmlExt(title) + '" aria-label="' + escapeHtmlExt(title) + '" ' +
      'style="background:rgba(255,255,255,.06);color:' + color + ';' +
      'border:1px solid var(--cbe-modal-border,#3a414c);border-radius:6px;' +
      'width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;' +
      'cursor:pointer;padding:0;">' + svg + '</button>';
  const pinSvg = ext.pinned ? CBE_EXT_ICONS.pinned : CBE_EXT_ICONS.pin;
  const pinTitle = ext.pinned
    ? cbeT('label.unpin_toolbar', 'Unpin from Toolbar')
    : cbeT('label.pin_toolbar', 'Pin to Toolbar');
  return (
    '<span style="display:inline-flex;gap:6px;">' +
      iconBtn('cbe-ext-open',      cbeT('label.open', 'Open'),           CBE_EXT_ICONS.open,      '#6fd58a') +
      iconBtn('cbe-ext-pin',       pinTitle,                             pinSvg,                  ext.pinned ? '#ffd84d' : 'var(--cbe-modal-title-fg,#4ea8ff)') +
      iconBtn('cbe-ext-uninstall', cbeT('label.uninstall', 'Uninstall'), CBE_EXT_ICONS.uninstall, '#ff8a8a') +
    '</span>'
  );
}

function renderExtensionsCatalog(items, error) {
  const body = document.getElementById('cbe-ext-body');
  if (!body) return;
  if (error) {
    body.innerHTML =
      '<h3 style="margin:0 0 10px;color:#ff8a8a;">Couldn’t load the marketplace</h3>' +
      '<p style="opacity:.85;">' + escapeHtmlExt(error) + '</p>' +
      '<p style="opacity:.7;">The host fetch of <code>extensions.xml.php</code> failed — ' +
      'check the network, or that trentontompkins.com is reachable.</p>';
    return;
  }
  if (!items || !items.length) {
    body.innerHTML = '<div style="opacity:.7;padding:20px 0;">No extensions published yet.</div>';
    return;
  }
  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
  const cards = items.map((ext) => {
    const tags = (ext.tags || []).map(t =>
      '<span style="background:rgba(255,255,255,.08);border:1px solid var(--cbe-modal-border,#3a414c);' +
      'border-radius:4px;padding:2px 6px;font-size:11px;opacity:.85;">' + escapeHtmlExt(t) + '</span>'
    ).join(' ');
    const stateBadge = ext.installed
      ? '<span style="color:#6fd58a;font-size:11px;font-family:ui-monospace,monospace;border:1px solid #285b3f;' +
        'border-radius:3px;padding:1px 5px;margin-left:6px;">✓ Installed</span>'
      : '';
    const iconGlyph = String((ext.icon || '')).trim();
    const iconUri   = String((ext.iconUri || '')).trim();
    /* Prefer an image icon (bridge_chat extensions ship a logo PNG resolved
       to a webview URI). Fall back to the emoji glyph for legacy .ext
       extensions. Both render in the same 18px slot. */
    let iconHtml = '';
    if (iconUri) {
      iconHtml = '<img src="' + escapeHtmlExt(iconUri) + '" alt="" aria-hidden="true" ' +
        'style="width:18px;height:18px;object-fit:contain;margin-right:6px;vertical-align:-3px;border-radius:3px;background:rgba(255,255,255,.05);" />';
    } else if (iconGlyph) {
      iconHtml = '<span aria-hidden="true" style="font-size:18px;line-height:1;margin-right:6px;' +
        'font-family:\'Segoe UI Emoji\',\'Noto Color Emoji\',\'Apple Color Emoji\',sans-serif;">' +
        escapeHtmlExt(iconGlyph) + '</span>';
    }
    const typeBadge = ext.type === 'bridge_chat'
      ? '<span style="background:rgba(120,160,255,.12);color:#9fbcff;border:1px solid #3a5b9e;' +
        'border-radius:3px;padding:1px 5px;margin-left:6px;font-size:11px;font-family:ui-monospace,monospace;">bridge</span>'
      : '';
    return (
      '<div class="cbe-ext-card" data-ext-id="' + escapeHtmlExt(ext.id) + '" ' +
        'style="background:rgba(255,255,255,.05);border:1px solid var(--cbe-modal-border,#3a414c);' +
        'border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">' +
          '<strong style="font-size:15px;">' + iconHtml + escapeHtmlExt(ext.name) + typeBadge + stateBadge + '</strong>' +
          '<span style="opacity:.6;font-size:11px;font-family:ui-monospace,monospace;">v' + escapeHtmlExt(ext.version) + '</span>' +
        '</div>' +
        '<div style="opacity:.65;font-size:12px;">by ' + escapeHtmlExt(ext.author || 'unknown') +
          (ext.created ? ' · ' + escapeHtmlExt(ext.created) : '') + '</div>' +
        '<div style="flex-grow:1;min-height:34px;">' + escapeHtmlExt(ext.description) + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px;">' + tags + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<span style="opacity:.6;font-size:11px;font-family:ui-monospace,monospace;">' + fmtBytes(ext.bytes) + '</span>' +
          _extCardActionsHtml(ext) +
        '</div>' +
      '</div>'
    );
  }).join('');
  body.innerHTML =
    '<div style="opacity:.75;margin-bottom:14px;">Browse and install third-party ' +
    'extensions for the Claude Codex Black panel. Each is a single <code>.ext</code> ' +
    'bundle, downloaded + MD5-verified + extracted by the host.</div>' +
    '<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));">' +
    cards + '</div>';
  body.querySelectorAll('.cbe-ext-install').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Installing…';
      btn.style.opacity = '0.6';
      if (api) api.postMessage({
        type: 'installExtension',
        ext: {
          id: btn.getAttribute('data-ext-id'),
          name: btn.getAttribute('data-ext-name'),
          fileUrl: btn.getAttribute('data-ext-url'),
          md5: btn.getAttribute('data-ext-md5'),
        },
      });
    });
  });
  body.querySelectorAll('.cbe-ext-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (api) api.postMessage({ type: 'openExtension', id: btn.getAttribute('data-ext-id') });
    });
  });
  body.querySelectorAll('.cbe-ext-pin').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-ext-id');
      const isPinned = (window.__cbePinnedExtensions || []).includes(id);
      if (api) api.postMessage({ type: isPinned ? 'unpinExtension' : 'pinExtension', id });
    });
  });
  body.querySelectorAll('.cbe-ext-uninstall').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-ext-id');
      const name = btn.getAttribute('data-ext-name') || id;
      if (!confirm('Uninstall "' + name + '"?')) return;
      if (api) api.postMessage({ type: 'uninstallExtension', id });
    });
  });
}

function openExtensionRunner(payload) {
  /* Modal that iframes an installed extension's entry HTML via srcdoc. The
     payload comes from the host (`cbe.openExtensionFromHost`) with the HTML
     already read off disk so we don't need a webview resource URI. */
  const old = document.getElementById('cbe-ext-runner');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'cbe-ext-runner';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
  const safeName = escapeHtmlExt(payload.name || payload.id || 'Extension');
  overlay.innerHTML =
    '<div class="cbe-box" role="dialog" aria-modal="true" aria-label="' + safeName + '" ' +
      'style="width:84vw;height:84vh;max-width:1100px;display:flex;flex-direction:column;' +
      'background:var(--cbe-modal-bg,#1c1f24);border:2px solid var(--cbe-modal-border,#353a45);' +
      'border-radius:10px;overflow:hidden;box-shadow:0 12px 50px rgba(0,0,0,.7);">' +
      '<div class="cbe-hdr" style="padding:10px 14px;background:linear-gradient(90deg,' +
        'var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);' +
        'font-weight:700;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>' + safeName + '</span>' +
        '<button class="cbe-x" type="button" aria-label="Close" title="Close (Esc)" ' +
          'style="background:transparent;border:0;color:var(--cbe-modal-title-fg);font-size:18px;cursor:pointer;">×</button>' +
      '</div>' +
      '<iframe srcdoc="" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' +
        'style="flex:1 1 auto;width:100%;border:0;background:#1c1f24;"></iframe>' +
    '</div>';
  document.body.appendChild(overlay);
  const iframe = overlay.querySelector('iframe');
  iframe.srcdoc = String(payload.html || '');
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.cbe-x').addEventListener('click', close);
  const onEsc = (e) => { if (e.key === 'Escape' && document.getElementById('cbe-ext-runner')) { close(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
}

function renderPinnedExtensionButtons() {
  /* Render one tiny pinned-extension button per id in __cbePinnedExtensions,
     placed in the #cbe-pinned-ext-row strip just before the trailing toolbar
     overflow. Each button opens the extension when clicked. */
  const meta = Array.isArray(window.__cbePinnedExtensionsMeta) ? window.__cbePinnedExtensionsMeta : [];
  let row = document.getElementById('cbe-pinned-ext-row');
  if (!row) {
    /* Fall back: append to the body if the host bar doesn't have a slot. */
    const host = document.querySelector('.title-actions') || document.querySelector('.toolbar') || document.body;
    row = document.createElement('span');
    row.id = 'cbe-pinned-ext-row';
    row.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin:0 6px;';
    host.appendChild(row);
  }
  row.innerHTML = '';
  for (const ent of meta) {
    const btn = document.createElement('button');
    btn.type = 'button';
    /* tool-button is the SAME class as every other toolbar icon (help, git,
       settings, …). Inheriting it means the pinned-extension buttons pick
       up the active skin's tile size, hover magnify, drop-shadow, and
       layout automatically — no per-skin re-styling needed. */
    btn.className = 'tool-button cbe-pinned-ext';
    btn.dataset.extId = ent.id;
    /* Translate the built-in demo extensions (calculator / minesweeper /
       emoji-picker) via the i18n table under the `ext.<id>` key. Setting
       data-i18n-tip lets applyI18n() re-translate the tooltip + aria-label
       whenever the language changes. User-installed extensions have no
       `ext.<id>` string, so they fall back to the extension's own name and
       get NO data-i18n-tip (nothing to translate). Previously the tooltip was
       hardcoded to ent.name, so these stayed English in every locale
       (user 2026-05-22: emoji/minesweeper/calculator/etc. "arent translating"). */
    const extKey = 'ext.' + ent.id;
    const i18nName = Object.prototype.hasOwnProperty.call(__cbeStrings, extKey)
      ? __cbeStrings[extKey] : null;
    const extName = i18nName || ent.name || ent.id;
    btn.title = extName;
    btn.setAttribute('data-tooltip', extName);
    btn.setAttribute('aria-label', 'Open ' + extName);
    if (i18nName != null) btn.setAttribute('data-i18n-tip', extKey);
    /* Prefer inline SVG — emoji rendering in the VSCode webview depends on
       system fonts (Segoe UI Emoji) which may not be available, causing
       tofu-box rendering. SVG glyphs are always crisp. Fall back to emoji
       if no SVG, then fall back to the generic open arrow. The span
       inherits stroke color via currentColor → CSS controls the visual. */
    const rawSvg = String((ent.iconSvg || '')).trim();
    const rawIcon = String((ent.icon || '')).trim();
    if (rawSvg) {
      btn.innerHTML =
        '<span class="cbe-pinned-svg" aria-hidden="true" style="' +
          'display:inline-flex;align-items:center;justify-content:center;' +
          'width:40px;height:40px;color:#ccc;' +
        '">' + rawSvg + '</span>';
    } else if (rawIcon) {
      btn.innerHTML =
        '<span class="cbe-pinned-emoji" aria-hidden="true" style="' +
          'display:inline-flex;align-items:center;justify-content:center;' +
          'width:40px;height:40px;font-size:34px;line-height:1;' +
          'font-family:\'Segoe UI Emoji\',\'Noto Color Emoji\',\'Apple Color Emoji\',sans-serif;' +
          'text-shadow:0 2px 3px rgba(0,0,0,0.55);' +
        '">' + escapeHtmlExt(rawIcon) + '</span>';
    } else {
      btn.innerHTML =
        '<span style="display:inline-flex;width:40px;height:40px;align-items:center;' +
        'justify-content:center;color:#fff;">' + CBE_EXT_ICONS.open + '</span>';
    }
    btn.addEventListener('click', () => {
      if (api) api.postMessage({ type: 'openExtension', id: ent.id });
    });
    row.appendChild(btn);
  }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('cbe-ext-modal')) closeExtensionsMarketplace();
});
(function () {
  const el = document.getElementById('extensionsBtn');
  if (el) el.addEventListener('click', openExtensionsMarketplace);
})();

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
  { name: '/compress', desc: 'Compress conversation (alias of /compact)', run: () => { if (api) api.postMessage({ type: 'compactConversation' }); } },
  { name: '/git',      desc: 'Source control',           run: () => { if (api) api.postMessage({ type: 'openGit' }); } },
  { name: '/github',   desc: 'List GitHub repos',        run: () => { const b = document.getElementById('githubBtn'); if (b) b.click(); } },
  { name: '/license',  desc: 'Show the MIT license',     run: () => { if (api) api.postMessage({ type: 'showLicense' }); } },
  { name: '/push',     desc: 'Push files to server (auto-update)', run: () => { if (api) api.postMessage({ type: 'pushUpdate' }); } },
  /* /switch and /switch account / /switch-accounts ALL open CBE's own
     auth picker (openAuthPicker) — a rebranded clone of Claude Code's
     login screen. Stays inside CBE per [[feedback-never-touch-anthropic-dir]];
     we don't dispatch claude-vscode.logout or touch the stock webview. */
  { name: '/switch',          desc: 'Switch account (Claude.ai / Console / Bedrock)', run: () => openAuthPicker() },
  { name: '/switch account',  desc: 'Switch account (Claude.ai / Console / Bedrock)', run: () => openAuthPicker() },
  { name: '/switch-accounts', desc: 'Switch account (Claude.ai / Console / Bedrock)', run: () => openAuthPicker() },
  { name: '/email',    desc: 'Open multi-account inbox', run: () => { if (api) api.postMessage({ type: 'openEmail' }); } },
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

/* ── i18n ────────────────────────────────────────────────────────────────
   The host ships a merged English-fallback strings map (payload.strings,
   keyed by the ids in languages/<code>.xml). applyStrings() walks the DOM
   for translation markers and swaps the visible text:
     data-i18n      → element.textContent
     data-i18n-tip  → data-tooltip + aria-label (toolbar buttons)
     data-i18n-ph   → input/textarea placeholder
   __cbeStrings is kept around so code that builds DOM dynamically can call
   cbeT('some.key') with the same table. Re-running applyStrings after a
   language change re-translates everything already on the page. */
let __cbeStrings = {};
function cbeT(key, fallback) {
  if (key && Object.prototype.hasOwnProperty.call(__cbeStrings, key)) return __cbeStrings[key];
  return fallback != null ? fallback : key;
}
function applyStrings(strings, language) {
  if (strings && typeof strings === 'object') __cbeStrings = strings;
  if (typeof language === 'string' && language) window.__cbeActiveLang = language;
  const tbl = __cbeStrings || {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k && tbl[k] != null) el.textContent = tbl[k];
  });
  document.querySelectorAll('[data-i18n-tip]').forEach((el) => {
    const k = el.getAttribute('data-i18n-tip');
    if (k && tbl[k] != null) {
      el.setAttribute('data-tooltip', tbl[k]);
      el.setAttribute('aria-label', tbl[k]);
    }
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const k = el.getAttribute('data-i18n-ph');
    if (k && tbl[k] != null) el.setAttribute('placeholder', tbl[k]);
  });
  /* Code-block Copy buttons aren't static markup (their label toggles
     Copy ⇄ Copied!), so they carry a _cbeRelabel closure instead of a
     data-i18n attribute. Re-apply it so a language change re-localizes
     every already-rendered button without disturbing one mid-"Copied!". */
  document.querySelectorAll('.cbe-cb-copy').forEach((el) => {
    if (typeof el._cbeRelabel === 'function') el._cbeRelabel();
  });
  /* Brand label is shipped as a per-language SVG under assets/labels/<code>.svg.
     The English fallback is wired in index.html; here we just swap the src
     when the active locale is known. */
  const brand = document.querySelector('[data-cbe-brand]');
  if (brand) {
    const lang = (window.__cbeActiveLang || 'en').toLowerCase();
    const assetsBase = String(window.__cbeAssetsBase || '').replace(/\/$/, '');
    if (assetsBase) brand.src = `${assetsBase}/labels/${encodeURIComponent(lang)}.svg`;
  }
}

/* Map provider id → SFX cue. anthropic→claude, openai→gtp, google/gemini→gemini,
   anything else → 'popup' fallback so the user still gets an audible "the
   model is replying" signal. */
function providerSfxName(id) {
  if (!id) return 'popup';
  if (id === 'anthropic') return 'claude';
  if (id === 'openai')   return 'gtp';
  if (id === 'gemini'    || id === 'google') return 'gemini';
  return 'popup';
}

window.addEventListener('message', e => {
  const m = e.data || {};
  /* Bridge cbe.openExternal events from nested iframes (the help srcdoc, the
     extensions marketplace) through to the host — vscode.env.openExternal
     opens the user's real default browser instead of trying to navigate the
     sandboxed iframe to nowhere. */
  if (m && m.type === 'cbe.openExternal' && typeof m.url === 'string') {
    if (api) api.postMessage({ type: 'openExternal', url: m.url });
    return;
  }
  /* runSlash — invoked from the host when a user runs one of the
     codexBlackEd.slash.* VSCode commands. Map the slash name to its
     CBE_COMMANDS entry and run it. This lets the Marketplace
     "Commands" list / Command Palette / keybindings drive the same
     code path the in-panel "/" menu uses. */
  if (m && m.type === 'runSlash' && typeof m.name === 'string') {
    try {
      const entry = (typeof CBE_COMMANDS !== 'undefined' ? CBE_COMMANDS : [])
        .find(c => c && c.name === '/' + m.name);
      if (entry && typeof entry.run === 'function') {
        entry.run();
      } else {
        /* switchAccounts isn't in CBE_COMMANDS under that exact slug
           (it's "/switch-accounts"); resolve aliases here. */
        if (m.name === 'switchAccounts') {
          const b = document.getElementById('accountsBtn');
          if (b) b.click();
        }
      }
    } catch (err) { /* swallow */ }
    return;
  }
  if (m.type === 'assistantStart') {
    streamingEl = addMsg('', 'assistant streaming');
    __cbeChunkStarted = false;
  } else if (m.type === 'status') {
    /* Transient progress line for slow providers. A SINGLE element that
       updates in place — not an accumulating log — and it's cleared the
       moment real answer text arrives. */
    if (!__cbeStatusEl || !__cbeStatusEl.isConnected) {
      __cbeStatusEl = addMsg('', 'info cbe-progress');
    }
    /* Use the loading_orange.svg spinner instead of a ⏳ emoji prefix. Consolas
       (and the webview's monospace stack) has no glyph for U+23F3, so it
       rendered as a tofu box — user 2026-05-22: "magic boxing" / "see that
       square under yo?". An SVG icon + the existing .cbe-spinner animation
       renders crisply with zero font dependency, like the toolbar icons. */
    __cbeStatusEl.textContent = '';
    const __ab = String(window.__cbeAssetsBase || '').replace(/\/$/, '');
    if (__ab) {
      const __sp = document.createElement('img');
      __sp.src = __ab + '/loading_orange.svg';
      __sp.alt = '';
      __sp.className = 'cbe-spinner';
      __sp.style.cssText = 'width:13px;height:13px;vertical-align:-2px;margin-right:6px;';
      __cbeStatusEl.appendChild(__sp);
    } else {
      __cbeStatusEl.appendChild(document.createTextNode('… '));
    }
    __cbeStatusEl.appendChild(document.createTextNode(m.text || ''));
    thread.scrollTop = thread.scrollHeight;
  } else if (m.type === 'chunk') {
    if (__cbeStatusEl) { try { __cbeStatusEl.remove(); } catch (e) {} __cbeStatusEl = null; }
    if (!streamingEl) streamingEl = addMsg('', 'assistant streaming');
    if (!__cbeChunkStarted) {
      __cbeChunkStarted = true;
      playSfx(providerSfxName(__cbeActiveProvider));
    }
    streamingEl.textContent += (m.text || '');
    thread.scrollTop = thread.scrollHeight;
  } else if (m.type === 'assistantDone') {
    if (__cbeStatusEl) { try { __cbeStatusEl.remove(); } catch (e) {} __cbeStatusEl = null; }
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
    /* Funnel everything through the shared teardown so future bugs that
       skip setBusy(false) can't sneak in — every exit path uses the same
       cleanup primitive. */
    teardownChatLifecycle();
    ti.focus();
  } else if (m.type === 'error') {
    addMsg('⚠ ' + (m.message || 'error'), 'error');
    teardownChatLifecycle();
  } else if (m.type === 'cancelled') {
    /* Stop button feedback from extension.js cancelInFlight. Mark the
       in-flight assistant bubble as "(cancelled)" rather than removing
       it, so partial output is preserved. */
    teardownChatLifecycle({ cancelled: true });
  } else if (m.type === 'imageResult') {
    /* Real image-gen result from extension.js -> tryHandleImageGeneration.
       Render the PNG inline (data:URI) with a Save-as link. Replaces the
       broken hallucinated-URL <img> markdown that text-only chat models
       were emitting (e.g. Gemini Pro returning the fake oaidalle URL). */
    try { renderGeneratedImage(m); } catch (e) {
      addMsg('⚠ image render failed: ' + (e && e.message), 'error');
    }
    teardownChatLifecycle();
    try { playSfx('popup'); } catch (_) {}
  } else if (m.type === 'imageError') {
    /* Image-gen failure: red error block with full error text so debugging
       is possible. Used for both API failures AND the friendly "this provider
       doesn't have an image-gen endpoint" message for Anthropic/DeepSeek. */
    const wrap = document.createElement('div');
    wrap.className = 'msg error cbe-image-error';
    wrap.style.cssText = 'background:#ffeaea;color:#c33;padding:8px 10px;border-radius:6px;white-space:pre-wrap;';
    wrap.textContent = '⚠ ' + (m.message || 'image-gen failed');
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    try { playSfx('error'); } catch (_) {}
    teardownChatLifecycle();
  } else if (m.type === 'info') {
    addMsg(m.text || '', 'info');
  } else if (m.type === 'toolExec') {
    /* Bridge daisy-chain — host is about to execute a command extracted
       from the bridge model's reply. Yellow system-style block clearly
       marks it as an auto-action (not user-typed, not assistant text). */
    try {
      const wrap = document.createElement('div');
      wrap.className = 'msg cbe-tool-exec';
      wrap.style.cssText = 'background:#fff8e0;color:#5a3a00;border-left:4px solid #c93;'
        + 'padding:6px 10px;border-radius:4px;font-family:Consolas,monospace;'
        + 'font-size:12px;white-space:pre-wrap;margin:4px 0;';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:2px;';
      head.textContent = `▶ tool-exec [${m.lang || 'cmd'}] (${m.kind || 'fence'}, mode=${m.mode || '?'})`;
      const body = document.createElement('div');
      body.textContent = m.cmdShort || (m.command || '').slice(0, 200);
      wrap.appendChild(head);
      wrap.appendChild(body);
      thread.appendChild(wrap);
      thread.scrollTop = thread.scrollHeight;
    } catch (e) { addMsg(`▶ exec ${m.cmdShort || m.command || ''}`, 'info'); }
  } else if (m.type === 'toolResult') {
    /* Output of a bridge tool-call. Same yellow block, with stdout/stderr
       collapsed visually. denied=true uses a slightly redder tint. */
    try {
      const wrap = document.createElement('div');
      wrap.className = 'msg cbe-tool-result';
      const bg = m.denied ? '#ffeaea' : '#fff8e0';
      const border = m.denied ? '#c33' : '#c93';
      wrap.style.cssText = `background:${bg};color:#3a2a00;border-left:4px solid ${border};`
        + 'padding:6px 10px;border-radius:4px;font-family:Consolas,monospace;'
        + 'font-size:12px;white-space:pre-wrap;margin:4px 0;';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:2px;';
      const stdoutN = (m.stdout || '').length;
      const stderrN = (m.stderr || '').length;
      head.textContent = m.denied
        ? `✗ tool-denied: ${m.reason || 'denied'}`
        : `◀ tool-result rc=${m.rc} stdout=${stdoutN}B stderr=${stderrN}B ms=${m.durationMs}${m.truncated ? ' (truncated)' : ''}`;
      const body = document.createElement('div');
      const lines = [];
      lines.push(`cmd: ${m.cmdShort || m.command || ''}`);
      if (m.stdout) lines.push('--- stdout ---\n' + m.stdout.replace(/\r?\n$/, ''));
      if (m.stderr) lines.push('--- stderr ---\n' + m.stderr.replace(/\r?\n$/, ''));
      body.textContent = lines.join('\n');
      wrap.appendChild(head);
      wrap.appendChild(body);
      thread.appendChild(wrap);
      thread.scrollTop = thread.scrollHeight;
    } catch (e) { addMsg(`◀ rc=${m.rc} ${m.cmdShort || ''}`, 'info'); }
  } else if (m.type === 'toolConfirm') {
    /* Confirmation prompt — yellow block with ✓/✗ buttons. Posts back
       toolConfirmResponse with the user's decision. Only one prompt is
       expected at a time; the host waits up to 5 minutes. */
    try {
      const wrap = document.createElement('div');
      wrap.className = 'msg cbe-tool-confirm';
      wrap.style.cssText = 'background:#fff8e0;color:#5a3a00;border-left:4px solid #c93;'
        + 'padding:8px 10px;border-radius:4px;font-family:Consolas,monospace;'
        + 'font-size:12px;white-space:pre-wrap;margin:4px 0;';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:4px;';
      head.textContent = `? Run this ${m.lang || 'cmd'}? (${m.kind || 'fence'}, mode=${m.mode || '?'})`;
      const body = document.createElement('div');
      body.style.cssText = 'margin-bottom:6px;';
      body.textContent = m.command || '';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;';
      const allowBtn = document.createElement('button');
      allowBtn.type = 'button';
      allowBtn.textContent = '✓ Allow';
      allowBtn.className = 'cbe-btn';
      allowBtn.style.cssText = 'background:#6a3;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;';
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.textContent = '✗ Deny';
      denyBtn.className = 'cbe-btn';
      denyBtn.style.cssText = 'background:#c33;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;';
      let answered = false;
      const reply = (allow) => {
        if (answered) return;
        answered = true;
        allowBtn.disabled = true;
        denyBtn.disabled = true;
        head.textContent = allow ? '✓ Allowed' : '✗ Denied';
        if (api) api.postMessage({ type: 'toolConfirmResponse', id: m.id, allow });
      };
      allowBtn.addEventListener('click', () => reply(true));
      denyBtn.addEventListener('click', () => reply(false));
      btns.appendChild(allowBtn);
      btns.appendChild(denyBtn);
      wrap.appendChild(head);
      wrap.appendChild(body);
      wrap.appendChild(btns);
      thread.appendChild(wrap);
      thread.scrollTop = thread.scrollHeight;
    } catch (e) {
      /* Failsafe: deny on render error so the chain doesn't hang. */
      if (api) api.postMessage({ type: 'toolConfirmResponse', id: m.id, allow: false });
    }
  } else if (m.type === 'bridgeStatus') {
    /* Bridge auto-start telemetry from extension.js. Renders a one-line
       banner in #thread; if the EXE is missing we render an explicit
       error so the user knows to build it from bridges_cpp/. */
    const label = (m.target || 'bridge') + ' bridge';
    if (m.exeMissing) {
      addMsg(`⚠ ${label}: EXE missing on disk (${m.reason || 'no path'}). Build it via build_bridges.ps1.`, 'error');
    } else if (m.ok) {
      if (m.spawned) addMsg(`${label} started on :${m.port}`, 'info');
      /* If it was already running, stay quiet — no log spam. */
    } else {
      addMsg(`⚠ ${label}: ${m.reason || 'could not reach port ' + (m.port || '?')}`, 'error');
    }
  } else if (m.type === 'accountsState') {
    /* Host answered getAccounts/listAccounts or a mutating account command.
       Fan the masked state out to BOTH surfaces: the Settings-embedded list
       and the standalone Accounts modal. Each renderer no-ops when its host
       UI is closed, so this is safe regardless of which one is visible. */
    renderAccountsList(m);
    renderAccountsModalList(m);
  } else if (m.type === 'accountError') {
    /* Add/validate/edit failure — show it inline in whichever surface is open. */
    _showAccountFormError(m.message || 'Account error.');
    if (typeof _amModalOpen === 'function' && _amModalOpen()) _amShowError(m.message || 'Account error.');
  } else if (m.type === 'accountToast') {
    /* Rotation fired — surface a small toast so the user knows we switched
       accounts mid-request. addMsg renders an info line in the thread. */
    addMsg(`↻ Account ${m.from} hit its limit — switched to ${m.to}`, 'info');
    if (typeof playSfx === 'function') { try { playSfx('popup'); } catch (_) {} }
  } else if (m.type === 'ollamaStatus') {
    /* Render the persistent Ollama provision banner (install button +
       model dropdown). Replaces any previous banner so we never stack
       duplicates. State comes straight from ensureOllamaReady(): 'ready',
       'missing', 'daemonFailed'. */
    renderOllamaStatusBanner(m);
  } else if (m.type === 'ollamaInstallStatus') {
    updateOllamaInstallProgress(m);
  } else if (m.type === 'ollamaPullStatus') {
    updateOllamaPullProgress(m);
  } else if (m.type === 'nag') {
    /* Host hit a run-count trigger (3/6/10/20, then every 30). Random
       pick of the three support/promo cards — see CBE_NAGS. */
    openNag(m.run);
  } else if (m.type === 'showAuthPicker') {
    /* Host-side trigger for the /switch auth picker — invoked when the
       user runs codexBlackEd.slash.switchAccounts from the Command Palette
       or keybinding. Same code path as typing "/switch" in the chat. */
    openAuthPicker();
  } else if (m.type === 'helpHtml') {
    /* Host re-shipped help.html after a language change. Update the
       cache so the next Help-button click renders the new locale.
       Also re-render an already-open help modal if one is up. */
    if (typeof m.helpHtml === 'string' && m.helpHtml) {
      window.__cbeHelpHtml = m.helpHtml;
      const modal = document.getElementById('cbe-help-modal');
      if (modal) {
        const body = modal.querySelector('#cbe-help-body');
        if (body) {
          body.innerHTML = '';
          const iframe = document.createElement('iframe');
          iframe.title = 'Help';
          iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
          iframe.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:var(--cbe-modal-bg);';
          iframe.srcdoc = m.helpHtml;
          body.appendChild(iframe);
        }
      }
    }
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
    /* Cache help.html body shipped from the host. openHelp() innerHTMLs this
       into a div instead of iframing the file — iframes via asWebviewUri were
       rendering empty on some VSCode builds. */
    if (typeof m.helpHtml === 'string' && m.helpHtml) window.__cbeHelpHtml = m.helpHtml;
    /* Cache change_log.html the same way — openChangelog() innerHTMLs it. */
    if (typeof m.changelogHtml === 'string' && m.changelogHtml) window.__cbeChangelogHtml = m.changelogHtml;
    /* Pinned extensions: ids + metadata shipped from config.ini. Render the
       toolbar quick-launch buttons on first paint. */
    window.__cbePinnedExtensions = Array.isArray(m.pinnedExtensions) ? m.pinnedExtensions.slice() : [];
    window.__cbePinnedExtensionsMeta = Array.isArray(m.pinnedExtensionsMeta) ? m.pinnedExtensionsMeta.slice() : [];
    renderPinnedExtensionButtons();
    /* Apply the active locale's strings to tooltips/labels on first paint. */
    if (m.strings && typeof m.strings === 'object') applyStrings(m.strings, m.language);
    if (!__cbeOpenAppPlayed) {
      __cbeOpenAppPlayed = true;
      playSfx('open_and_close_application');
    }
  } else if (m.type === 'strings') {
    /* Host pushes a fresh strings map after the language is changed in
       Settings. Re-translate everything currently on the page. */
    applyStrings(m.strings || {}, m.language);
  } else if (m.type === 'azureDeployments') {
    /* Host fetched the real Azure deployments via the data-plane endpoint.
       Items may be plain strings (legacy) or {name, model} objects. The
       option's value is always the deployment NAME (used in the chat URL);
       the label appends ` — <model>` when the underlying model id differs
       so e.g. a deployment named "sora" running sora-2 reads as
       "sora — sora-2". Replace the cached Azure provider models with the
       live names AND, if the Settings modal is open on Azure, swap the
       <select> options live. */
    const raw = Array.isArray(m.items) ? m.items.slice() : [];
    const items = raw.map((it) => (typeof it === 'string')
      ? { name: it, model: '' }
      : { name: String((it && it.name) || ''), model: String((it && it.model) || '') }
    ).filter(it => it.name);
    const names = items.map(it => it.name);
    const azureProv = (__cbeProviders || []).find(p => p && p.id === 'azure');
    if (azureProv) azureProv.models = names;
    const sel = document.querySelector('#cbe-set-provider');
    const ms  = document.querySelector('#cbe-set-model');
    if (sel && ms && sel.value === 'azure' && items.length) {
      const prev = ms.value;
      ms.innerHTML = '';
      items.forEach(({ name, model }) => {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = (model && model !== name) ? (name + ' — ' + model) : name;
        ms.appendChild(o);
      });
      if (names.includes(prev)) ms.value = prev;
      else if (azureProv && azureProv.current && names.includes(azureProv.current)) ms.value = azureProv.current;
    }
  } else if (m.type === 'extensionsCatalog') {
    /* Host fetched + parsed extensions.xml.php — render the cards natively. */
    renderExtensionsCatalog(m.items || [], m.error);
  } else if (m.type === 'cbe.installResultFromHost') {
    /* Host finished an install. On success, re-fetch the catalog so the card
       re-renders with Open/Pin/Uninstall icons (the host now reports
       installed state). On failure, just restore the Install button. */
    if (m.ok) {
      if (api) api.postMessage({ type: 'fetchExtensionsCatalog' });
    } else {
      const btn = document.querySelector('.cbe-ext-install[data-ext-id="' +
        (window.CSS && CSS.escape ? CSS.escape(String(m.id || '')) : String(m.id || '')) + '"]');
      if (btn) {
        btn.textContent = 'Install';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  } else if (m.type === 'cbe.openExtensionFromHost') {
    /* Host read the extension's entry HTML off disk — run it in a srcdoc
       iframe modal. */
    openExtensionRunner(m);
  } else if (m.type === 'cbe.uninstallResultFromHost') {
    /* Extension removed from disk — refresh pinned state + re-render catalog
       so the card flips back to "Install". */
    if (m.ok) {
      window.__cbePinnedExtensions = Array.isArray(m.pinned) ? m.pinned.slice() : (window.__cbePinnedExtensions || []);
      window.__cbePinnedExtensionsMeta = (window.__cbePinnedExtensionsMeta || [])
        .filter(x => window.__cbePinnedExtensions.includes(x.id));
      renderPinnedExtensionButtons();
      if (document.getElementById('cbe-ext-body') && api) {
        api.postMessage({ type: 'fetchExtensionsCatalog' });
      }
    }
  } else if (m.type === 'cbe.pinnedExtensions') {
    /* Pin/unpin toggled — host persisted to config.ini and echoed the new
       list + metadata. Update the toolbar strip and re-render any open
       catalog so the pin icon reflects the new state. */
    window.__cbePinnedExtensions = Array.isArray(m.pinned) ? m.pinned.slice() : [];
    window.__cbePinnedExtensionsMeta = Array.isArray(m.meta) ? m.meta.slice() : [];
    renderPinnedExtensionButtons();
    if (document.getElementById('cbe-ext-body') && api) {
      api.postMessage({ type: 'fetchExtensionsCatalog' });
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
       file content into the outgoing prompt at submit time. kind/mime/
       base64/dataUri are MIME-aware fields added 2026-05-23 so binary
       and image attachments don't get pasted as garbage text. */
    pushAttachment({
      name:    m.name || 'attachment',
      ext:     (m.ext || '').toLowerCase(),
      text:    m.text || '',
      path:    m.path || '',
      bytes:   m.bytes || 0,
      mime:    m.mime || '',
      kind:    m.kind || 'text',
      base64:  m.base64 || '',
      dataUri: m.dataUri || '',
    });
  } else if (m.type === 'fileDownload') {
    /* send_file tool delivery: render a downloadable attachment bubble in
       the chat. dataUri (under 2MB) or webview uri (>= 2MB). */
    renderFileDownload(m);
  }
});

/* Render a generated image (from extension.js -> tryHandleImageGeneration) as
   an inline assistant message: data:URI <img> + a Save-as link. The PNG bytes
   are passed as base64 in m.b64 so nothing ever leaves the webview. */
function renderGeneratedImage(m) {
  const mime = String(m.mime || 'image/png');
  const b64 = String(m.b64 || '');
  if (!b64) {
    addMsg('⚠ image-gen returned no bytes', 'error');
    return;
  }
  const dataUri = 'data:' + mime + ';base64,' + b64;
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant rendered cbe-image-result';

  /* Caption: provider + prompt + (optional) quality. */
  const cap = document.createElement('div');
  cap.style.cssText = 'font-size:12px;opacity:0.75;margin-bottom:6px;';
  const promptTxt = m.prompt ? ('"' + String(m.prompt).slice(0, 200) + '"') : '';
  const qTxt = m.quality ? (' · ' + m.quality) : '';
  cap.textContent = '🖼 ' + (m.providerLabel || m.provider || 'image-gen') + qTxt + (promptTxt ? ' — ' + promptTxt : '');
  wrap.appendChild(cap);

  /* The image itself. */
  const img = document.createElement('img');
  img.src = dataUri;
  img.alt = String(m.prompt || 'generated image');
  img.style.cssText = 'display:block;max-width:512px;border-radius:6px;';
  wrap.appendChild(img);

  /* Save-as link. <a download> triggers the browser's save dialog with the
     data URI as the source — works in VSCode's webview without any host
     round-trip. Default filename includes provider + a timestamp slug. */
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
  const fname = 'cbe-' + (m.provider || 'image') + '-' + ts + '.' + ext;
  const saveLink = document.createElement('a');
  saveLink.href = dataUri;
  saveLink.setAttribute('download', fname);
  saveLink.textContent = 'Save as…';
  saveLink.style.cssText = 'display:inline-block;margin-top:6px;font-size:12px;color:#4ec9b0;text-decoration:underline;';
  wrap.appendChild(saveLink);

  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

/* Render a file-download bubble in the chat for the send_file tool. */
function renderFileDownload(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg recv file-download';
  const name = String(m.name || 'file');
  const mime = String(m.mime || 'application/octet-stream');
  const bytes = Number(m.bytes || 0);
  const href = m.dataUri || m.uri || '';
  const sizeStr = fmtBytes(bytes);
  const link = document.createElement('a');
  link.href = href;
  link.setAttribute('download', name);
  link.textContent = 'Download';
  link.style.marginLeft = '8px';
  link.style.color = '#4ec9b0';
  link.style.textDecoration = 'underline';
  const label = document.createElement('span');
  label.textContent = '📎 ' + name + ' (' + sizeStr + ', ' + mime + ')';
  wrap.appendChild(label);
  wrap.appendChild(link);
  /* If image and small enough, inline a thumbnail preview. */
  if (m.dataUri && /^image\//.test(mime)) {
    const img = document.createElement('img');
    img.src = m.dataUri;
    img.alt = name;
    img.style.display = 'block';
    img.style.marginTop = '6px';
    img.style.maxWidth = '320px';
    img.style.maxHeight = '240px';
    img.style.borderRadius = '4px';
    wrap.appendChild(img);
  }
  const chat = document.getElementById('chat') || document.body;
  chat.appendChild(wrap);
  try { chat.scrollTop = chat.scrollHeight; } catch (e) { /* not fatal */ }
}

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
    const kind = a.kind || 'text';
    const lang = a.ext || '';
    if (kind === 'image') {
      /* Image: emit a labeled marker. The actual image_url payload is
         carried out-of-band in the sendText message.images[] array (see
         send()) so vision-capable providers can attach it natively. */
      parts.push(`--- FILE: ${a.name} (${a.mime || 'image'}, ${a.bytes} bytes) ---`);
      parts.push(`[image attached: ${a.name}]`);
      parts.push('--- END ---');
      parts.push('');
    } else if (kind === 'binary') {
      /* Binary non-image: emit base64 inline. The model can still ask the
         user to decode/inspect it but won't see garbage bytes that break
         tokenization. */
      parts.push(`--- FILE: ${a.name} (${a.mime || 'application/octet-stream'}, base64, ${a.bytes} bytes) ---`);
      parts.push(a.base64 || '(no base64 payload)');
      parts.push('--- END ---');
      parts.push('');
    } else {
      /* Text (or text-classified file): keep the original fenced block. */
      parts.push(`--- FILE: ${a.name} ---`);
      parts.push('```' + lang);
      parts.push(a.text || '');
      parts.push('```');
      parts.push('--- END ---');
      parts.push('');
    }
  }
  return parts.join('\n');
}

/* Collect image attachments for the out-of-band images[] channel on the
   sendText message. Each entry: { name, mime, dataUri }. */
function buildAttachmentImages() {
  const imgs = [];
  for (const a of __cbeAttachments) {
    if ((a.kind || 'text') === 'image' && a.dataUri) {
      imgs.push({ name: a.name, mime: a.mime || 'image/png', dataUri: a.dataUri });
    }
  }
  return imgs;
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

    /* Settings — opens the same Settings modal the toolbar settingsBtn
       opens (provider / model / skin / language / SFX). Reachable from
       the right-click menu so the user doesn't have to hunt for the
       toolbar button. (user 2026-05-22.) */
    var settings = document.createElement('div');
    settings.className = 'cbe-item';
    settings.textContent = 'Settings';
    settings.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (api) api.postMessage({ type: 'openSettings' });
    });
    menu.appendChild(settings);

    /* About — small modal showing version, author, license, contact.
       (user 2026-05-22: "right clicking the extension panel should give
       options for settings and about".) */
    var about = document.createElement('div');
    about.className = 'cbe-item';
    about.textContent = 'About';
    about.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      showAboutModal();
    });
    menu.appendChild(about);

    /* Reload Panel — re-reads panel/index.html + panel.js + lib/* from disk
       with a per-file mtime cache-buster and reassigns panel.webview.html.
       This is the supported way to pick up CSS / JS edits in panel-side
       code WITHOUT rebooting VSCode (extension.js host code is unaffected
       by this — use Reload Window for that). The webview re-fires `ready`. */
    var refresh = document.createElement('div');
    refresh.className = 'cbe-item';
    refresh.textContent = 'Reload Panel';
    refresh.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (api) api.postMessage({ type: 'refreshPanel' });
    });
    menu.appendChild(refresh);

    /* Reload Window — full VSCode reload. Use ONLY when a Reload Panel
       isn't enough (i.e., you changed extension.js host code and need the
       extension to restart). User explicitly authorized this menu item
       2026-05-22 ("if you can just do Reload for the whole app"). */
    var reload = document.createElement('div');
    reload.className = 'cbe-item';
    reload.textContent = 'Reload Window';
    reload.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeMenu();
      if (api) api.postMessage({ type: 'reloadWindow' });
    });
    menu.appendChild(reload);

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
      /* Editable prompt textarea: let the BROWSER's native context menu
         render so the user gets Copy / Cut / Paste / Delete / Select All
         (user 2026-05-22: "the prompt windows need to let you right click
         for copy / cut / delete / paste"). Just return without
         preventDefault so the default menu fires. */
      const isTextInput = e.target.closest('#promptBox, .prompt-input-wrap');
      if (isTextInput) return;
      /* Toolbar / send / stop / label: a context menu over a button is
         confusing — silence the default and skip the custom one too. */
      const isChrome = e.target.closest(
        '.tool-button, .label-button, .send-button, .stop-button, ' +
        '.prompt-toolbar, .toolbar-meta'
      );
      if (isChrome) {
        e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    var codeEl = findCodeEl(e.target);
    showCtxMenu(e.clientX, e.clientY, codeEl);
  });

  /* About modal — version, author, license, repo, contact. Reached from
     the right-click menu. Theming via the panel's --cbe-modal-* variables
     so it picks up the active skin's palette automatically. */
  function showAboutModal() {
    /* Reuse the source-modal overlay id so escape/click-outside logic
       still works; we just paint different content into it. */
    removeModal();
    var overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.innerHTML =
      '<div class="cbe-box" style="max-width:520px;">' +
        '<div class="cbe-hdr">' +
          '<span class="cbe-title">About Claude Codex Black</span>' +
          '<div class="cbe-actions"><button class="cbe-close" type="button" aria-label="Close">×</button></div>' +
        '</div>' +
        '<div class="cbe-body" style="padding:18px 22px;font-family:inherit;font-size:13.5px;line-height:1.6;">' +
          '<p style="margin:0 0 10px;font-size:15px;"><b>Claude Codex — Black Edition</b></p>' +
          '<p style="margin:0 0 6px;">Standalone VSCode panel for multi-provider AI chat (Claude / GPT / Grok / Gemini / Copilot / DeepSeek / Azure) with direct API + browser bridges, TTS/STT, multi-account, skinning, and a Tamagotchi pet.</p>' +
          '<table style="margin:14px 0;border-collapse:collapse;width:100%;font-size:13px;">' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;width:90px;">Version</td><td>1.0.1</td></tr>' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;">Author</td><td>Trent Tompkins &nbsp;<a href="mailto:trenttompkins@gmail.com" style="color:var(--cbe-modal-accent);">&lt;trenttompkins@gmail.com&gt;</a></td></tr>' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;">License</td><td>MIT</td></tr>' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;">Repo</td><td><a href="https://github.com/tibberous/Claude-Codex-Back-Ed." style="color:var(--cbe-modal-accent);">github.com/tibberous/Claude-Codex-Back-Ed.</a></td></tr>' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;">Portfolio</td><td><a href="https://trentontompkins.com" style="color:var(--cbe-modal-accent);">trentontompkins.com</a></td></tr>' +
            '<tr><td style="padding:3px 0;color:var(--cbe-modal-fg);opacity:0.7;">Contact</td><td>(724) 431-5207</td></tr>' +
          '</table>' +
          '<p style="margin:14px 0 0;font-size:12.5px;opacity:0.75;">Need help on your next project? Websites, extensions, mobile development, application development — production-level code at fair prices with lightning-fast turn-around.</p>' +
        '</div>' +
      '</div>';
    /* Close-on-click handlers: backdrop click + × button + Escape. */
    overlay.addEventListener('mousedown', function(e) {
      if (e.target === overlay) removeModal();
    });
    var closeBtn = overlay.querySelector('.cbe-close');
    if (closeBtn) closeBtn.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      removeModal();
    });
    function escClose(e) {
      if (e.key === 'Escape') { removeModal(); document.removeEventListener('keydown', escClose, true); }
    }
    document.addEventListener('keydown', escClose, true);
    document.body.appendChild(overlay);
  }

  /* Expose for future agents (e.g. DevTools merge). */
  window.__cbeShowSource = showSourceModal;
  window.__cbeShowCtxMenu = showCtxMenu;
  window.__cbeShowAbout = showAboutModal;
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
      desc:  'API key for direct Claude calls. Get one at <a href="https://console.anthropic.com/account/keys">console.anthropic.com</a>. ' +
             'Buy credits: <a href="https://console.anthropic.com/settings/billing">console.anthropic.com/settings/billing</a>.',
      fields: [{ section:'api_keys', key:'anthropic_api_key', label:'API Key', placeholder:'sk-ant-…', password:true }] },
    { title: 'OpenAI (ChatGPT)',
      desc:  'API key for GPT models. Get one at <a href="https://platform.openai.com/api-keys">platform.openai.com</a>. ' +
             'Buy credits: <a href="https://platform.openai.com/settings/organization/billing/overview">platform.openai.com/settings/organization/billing</a>.',
      fields: [{ section:'api_keys', key:'openai_api_key', label:'API Key', placeholder:'sk-proj-…', password:true }] },
    { title: 'Google Gemini',
      desc:  'API key for Gemini. Get one at <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>. ' +
             'Buy credits: <a href="https://aistudio.google.com/app/billing">aistudio.google.com/app/billing</a>.',
      fields: [{ section:'api_keys', key:'gemini_api_key', label:'API Key', placeholder:'AIza…', password:true }] },
    { title: 'xAI (Grok)',
      desc:  'API key for Grok direct API. Get one at <a href="https://console.x.ai/">console.x.ai</a>. ' +
             'Buy credits: <a href="https://console.x.ai/">console.x.ai</a> → Billing → API spend management.',
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

/* ── Ollama provision banner ─────────────────────────────────────────────
   Persistent panel widget that surfaces the host-side ensureOllamaReady()
   state machine. Renders one of three modes:
     • ready          — quiet info pill ("Ollama ready · llama3.2:3b")
     • missing        — big Install button (kicks installOllama msg)
     • daemonFailed   — Retry button (re-runs ollamaProbe)
   Plus, when the daemon is up but has zero models, a model picker with a
   Pull button that streams ollama pull stdout into the banner. */
const RECOMMENDED_OLLAMA_MODELS = ['llama3.2:3b', 'qwen2.5:7b', 'phi3:mini'];

function _ollamaBannerEl() {
  let el = document.getElementById('cbe-ollama-banner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cbe-ollama-banner';
  el.className = 'msg info';
  el.style.cssText = [
    'border:1px solid #e8621a',
    'background:linear-gradient(180deg, #1a1a1a, #0f0f0f)',
    'color:#e8e8e8',
    'padding:10px 14px',
    'margin:8px 0',
    'border-radius:6px',
    'font-family:Consolas,Menlo,monospace',
    'font-size:13px',
    'line-height:1.45',
  ].join(';');
  const thread = document.getElementById('thread');
  if (thread) thread.appendChild(el);
  return el;
}

function renderOllamaStatusBanner(m) {
  const el = _ollamaBannerEl();
  const state = m && m.state;
  if (state === 'ready') {
    const models = (m.models || []);
    const first = models[0] || '(no models pulled)';
    el.innerHTML = '';
    const header = document.createElement('div');
    header.innerHTML = `<b style="color:#ffd166">Ollama ready</b> · daemon on :11434 · ${models.length} model${models.length === 1 ? '' : 's'}${models.length ? ' (active: <code>' + _ollamaEscape(first) + '</code>)' : ''}`;
    el.appendChild(header);
    if (!models.length) {
      el.appendChild(_buildOllamaPullPicker());
    } else {
      /* Hide the banner after 6s once it's truly ready (less chrome). */
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 6000);
    }
    return;
  }
  if (state === 'missing') {
    el.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.marginBottom = '8px';
    msg.innerHTML = `<b style="color:#ff6b6b">Ollama not installed.</b> Click below to download + install the latest Windows build silently — no manual steps needed.`;
    el.appendChild(msg);
    const btn = document.createElement('button');
    btn.id = 'ollamaInstallBtn';
    btn.textContent = 'Install Ollama';
    btn.style.cssText = 'padding:8px 18px;background:#e8621a;color:#fff;border:0;border-radius:5px;cursor:pointer;font-weight:600;font-family:inherit;';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      if (api) api.postMessage({ type: 'installOllama' });
    });
    el.appendChild(btn);
    const progress = document.createElement('div');
    progress.id = 'cbe-ollama-install-progress';
    progress.style.cssText = 'margin-top:10px;color:#9da3a6;font-size:12px;min-height:1.2em;';
    el.appendChild(progress);
    return;
  }
  if (state === 'daemonFailed') {
    el.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.marginBottom = '8px';
    msg.innerHTML = `<b style="color:#ff6b6b">Ollama daemon didn't start.</b> Found exe at <code>${_ollamaEscape(m.exe || '(unknown)')}</code> but /api/tags timed out.`;
    el.appendChild(msg);
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.style.cssText = 'padding:6px 14px;background:#444;color:#fff;border:0;border-radius:5px;cursor:pointer;font-family:inherit;';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Probing…';
      if (api) api.postMessage({ type: 'ollamaProbe' });
    });
    el.appendChild(btn);
    return;
  }
  /* unknown state — fall back to silent removal */
  try { el.remove(); } catch (_) {}
}

function updateOllamaInstallProgress(m) {
  const el = document.getElementById('cbe-ollama-install-progress');
  if (!el) return;
  const text = (m && m.text) || '';
  el.textContent = text;
  if (m && m.step === 'fail') {
    el.style.color = '#ff6b6b';
    /* Re-enable the install button so the user can retry. */
    const btn = document.getElementById('ollamaInstallBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Install Ollama'; }
  } else if (m && m.step === 'done') {
    el.style.color = '#9aff9a';
  } else {
    el.style.color = '#ffd166';
  }
}

function _buildOllamaPullPicker() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
  const label = document.createElement('span');
  label.textContent = 'Pull a starter model:';
  label.style.color = '#9da3a6';
  wrap.appendChild(label);
  const sel = document.createElement('select');
  sel.id = 'cbe-ollama-model-pick';
  sel.style.cssText = 'background:#0a0a0a;color:#e8e8e8;border:1px solid #444;border-radius:4px;padding:4px 8px;font-family:inherit;';
  for (const n of RECOMMENDED_OLLAMA_MODELS) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
  wrap.appendChild(sel);
  const btn = document.createElement('button');
  btn.textContent = 'Pull';
  btn.style.cssText = 'padding:5px 14px;background:#e8621a;color:#fff;border:0;border-radius:4px;cursor:pointer;font-family:inherit;';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Pulling…';
    if (api) api.postMessage({ type: 'pullOllamaModel', model: sel.value });
  });
  wrap.appendChild(btn);
  const log = document.createElement('div');
  log.id = 'cbe-ollama-pull-log';
  log.style.cssText = 'flex-basis:100%;color:#9da3a6;font-size:12px;margin-top:6px;white-space:pre-wrap;max-height:140px;overflow:auto;font-family:Consolas,Menlo,monospace;';
  wrap.appendChild(log);
  return wrap;
}

function updateOllamaPullProgress(m) {
  const log = document.getElementById('cbe-ollama-pull-log');
  if (!log) return;
  const t = (m && m.text) || '';
  /* Most pull lines are "pulling <sha>... 38%" — replace last line if it
     looks like a progress redraw (ends with %), else append. */
  if (/%\s*$/.test(t)) {
    const lines = log.textContent.split('\n');
    if (lines.length && /%\s*$/.test(lines[lines.length - 1])) lines[lines.length - 1] = t;
    else lines.push(t);
    log.textContent = lines.join('\n');
  } else {
    log.textContent += (log.textContent ? '\n' : '') + t;
  }
  log.scrollTop = log.scrollHeight;
  if (m && (m.step === 'done' || m.step === 'fail')) {
    const btn = log.parentElement && log.parentElement.querySelector('button');
    if (btn) { btn.disabled = false; btn.textContent = 'Pull'; }
  }
}

function _ollamaEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

