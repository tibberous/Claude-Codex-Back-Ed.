/* ─────────────────────────────────────────────────────────────────────────
   Codex Black Ed.
   Trenton Tompkins <trenttompkins@gmail.com>
   (c) 2006 — Released under the MIT license. See license.txt.
   https://trentontompkins.com    https://github.com/tibberous
   Call (724) 431-5207 — PHP / Python / node.js / desktop / web / mobile
   ───────────────────────────────────────────────────────────────────── */
/* ─── PANEL.JS LOAD MARKER ─── */
(function _cbePanelLoadMarker() {
  // Logs immediately on script evaluation. The number CHANGES on every
  // panel.js reload (different timestamp each load), so if you reopen the
  // panel and the marker number is the SAME as before, the webview is
  // serving a cached panel.js. If the number CHANGES, the file is fresh.
  // Also computes a content hash (FNV-1a, no crypto dep) so you can grep
  // for the marker in DevTools console + verify against the file on disk.
  try {
    let h = 0x811c9dc5;
    const src = (document.currentScript && document.currentScript.src) || '(no-src)';
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const loadId = (Date.now() % 1000000).toString(36);
    const srcHash = (h >>> 0).toString(16).padStart(8, '0');
    console.log('%c[CBE panel.js LOADED]', 'color:#ff0040;font-weight:bold;',
      'loadId=' + loadId, 'srcUrlFnvHash=0x' + srcHash, 'src=' + src);
    window.__CBE_PANEL_LOAD = { loadId, srcHash, loadedAt: new Date().toISOString(), src };
  } catch (err) {
    console.error('[CBE panel.js LOADED] marker failed:', err);
  }
})();

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

/* ── Native tool-call chips ───────────────────────────────────────────────
   Render host-side native tool calls (bash, etc.) the way Claude Code does:
   ONE line per call — a bullet + bold monospace tool name + a grey secondary
   status that resolves in place from "running…" to "done · NNB". Replaces the
   old faded-italic "▶ native-tool bash" / "◀ native-tool bash done (NB)" info
   lines (Trent 2026-06-04: arrows→bullet, white→grey, not janky). Native tool
   calls run sequentially (awaited one-at-a-time in extension.js), so a LIFO
   stack reliably pairs each `done` with its matching `start` chip. */
let __cbeToolChips = [];
function prettyToolName(n) {
  const s = String(n || 'tool').trim() || 'tool';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function renderToolCall(m) {
  const phase = (m && m.phase) || 'start';
  if (phase === 'done' && __cbeToolChips.length) {
    const d = __cbeToolChips.pop();
    d.classList.add('done');
    const sub = d.querySelector('.tc-sub');
    if (sub) sub.textContent = `done · ${(m.bytes || 0)}B`;
    thread.scrollTop = thread.scrollHeight;
    return d;
  }
  const d = document.createElement('div');
  d.className = 'msg toolcall';
  const name = document.createElement('span');
  name.className = 'tc-name';
  name.textContent = prettyToolName(m && m.name);
  const sub = document.createElement('span');
  sub.className = 'tc-sub';
  if (phase === 'done') { d.classList.add('done'); sub.textContent = `done · ${(m.bytes || 0)}B`; }
  else { sub.textContent = 'running…'; __cbeToolChips.push(d); }
  d.appendChild(name);
  d.appendChild(sub);
  thread.appendChild(d);
  thread.scrollTop = thread.scrollHeight;
  return d;
}

/* Mic-denied banner: textContent message + a clickable "Open Windows
   Privacy → Microphone" link that posts {type:'openWindowsMicSettings'}
   to the host (handled in extension.js, which calls vscode.env.openExternal
   on ms-settings:privacy-microphone). Replaces the old hardcoded "Anthropic
   STT: ..." string which lied about the provider and offered no action.
   (Trent 2026-05-27.) */
function addMicDeniedMsg(provider) {
  const d = document.createElement('div');
  d.className = 'msg error';
  const p = String(provider || 'STT');
  d.appendChild(document.createTextNode(
    'STT (' + p + '): microphone access denied. '
  ));
  const btn = document.createElement('a');
  btn.href = '#';
  btn.textContent = 'Open Windows Privacy → Microphone';
  btn.style.cssText = 'color:#4aa3df;text-decoration:underline;cursor:pointer;';
  btn.onclick = (ev) => {
    ev.preventDefault();
    try { (api || acquireVsCodeApi()).postMessage({ type: 'openWindowsMicSettings' }); } catch (_) {}
  };
  d.appendChild(btn);
  d.appendChild(document.createTextNode(
    ' — flip the toggle for Visual Studio Code, then click the mic again.'
  ));
  thread.appendChild(d);
  thread.scrollTop = thread.scrollHeight;
  playSfx('error');
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
  /* Commit + clear any still-active live dictation before reading the input,
     so a stale Deepgram/Whisper transcript can never be re-injected after a
     send (belt-and-suspenders for the accumulation bug). */
  try { if (window.__cbeCancelDictation) window.__cbeCancelDictation(); } catch (_) {}
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
  __cbeToolChips = [];                 /* drop any unresolved tool chips */
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
/* Trent canon 2026-05-28 (5th-attempt fix): the JS-rendered border-ring is
   REMOVED. All toolbar busy-rings now use the static `<img class="cbe-spinner"
   src="loading_blue.svg">` (blue) or `loading_green.svg` (green) pattern wired
   in index.html, sized to 32×32 via the #monitorBtn .cbe-spinner CSS rule.
   Both SVGs share viewBox 50×50 and the same ring path so the rendered
   diameter is IDENTICAL across the monitor / STT / autoReply / TTS buttons.
   Prior 4 attempts kept hitting a "same CSS box but different SVG viewBox"
   trap (auto_read_spinner.svg was 64×64 = visibly smaller ring; monitor's
   CSS-border ring drew at yet another effective diameter). One SVG family +
   one CSS rule + one toggling class = single source of truth.
   The signature stays so existing call sites (left-click toggle + supervisor
   poll at the bottom of the file) keep working. */
function cbeShowMonitorSpinner(on) {
  const btn = document.getElementById('monitorBtn');
  if (btn) btn.classList.toggle('is-monitoring', !!on);
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

/* ── Read aloud (TTS 🔊) — click=read last reply, double-click=auto-read ──
   Three-provider dispatch. Default is ElevenLabs (per the user's standing
   rule — memory elevenlabs_default.md). Provider selection is held in
   window.__cbeTtsProvider, hydrated from the host's init payload and
   updated when the user picks a different one in Settings → Voice.

     'elevenlabs' : host calls ElevenLabs TTS-1 multilingual, returns
                    base64 mp3, we play it via an <audio> element.
     'openai'     : host calls OpenAI tts-1 (voice=alloy), same return.
     'webspeech'  : we use window.speechSynthesis directly — the same
                    browser API Anthropic's bundle references but never
                    wires into Claude Code's UI. This is the always-free
                    fallback (no API key, no quota) AND the "Anthropic"
                    label in the picker (since the WebSpeech path is the
                    one Anthropic started shipping but didn't finish).
   The ID3 mp3 path also gracefully degrades to WebSpeech if the host
   reports an error (e.g. no API key configured). */
window.__cbeTtsProvider = window.__cbeTtsProvider || 'webspeech';
/* Voice tuning window state — hydrated from the host's persisted workspaceState
   on `init`, mutated by Settings → Read Aloud, and read by speakWebSpeech /
   speakRemote. Defaults match the host-side defaults (rate 1, volume 1, etc.). */
if (window.__cbeTtsVoice            === undefined) window.__cbeTtsVoice            = '';
if (window.__cbeTtsRate             === undefined) window.__cbeTtsRate             = 1;
if (window.__cbeTtsVolume           === undefined) window.__cbeTtsVolume           = 1;
if (window.__cbeTtsOpenAiVoice      === undefined) window.__cbeTtsOpenAiVoice      = 'alloy';
if (window.__cbeTtsOpenAiSpeed      === undefined) window.__cbeTtsOpenAiSpeed      = 1;
if (window.__cbeTtsElevenVoice      === undefined) window.__cbeTtsElevenVoice      = '';
if (window.__cbeTtsElevenStability  === undefined) window.__cbeTtsElevenStability  = 0.5;
if (window.__cbeTtsElevenSimilarity === undefined) window.__cbeTtsElevenSimilarity = 0.75;
const tts = (function() {
  const btn = document.getElementById('ttsBtn');
  const synth = window.speechSynthesis;
  let lastReply = '';
  let autoRead = false;
  let currentAudio = null;          /* <audio> element when remote-mp3 path is playing */
  const pendingTtsReqs = new Map(); /* reqId -> { resolve, reject } */

  function isSpeaking() {
    if (synth && synth.speaking) return true;
    if (currentAudio && !currentAudio.paused && !currentAudio.ended) return true;
    return false;
  }

  function setIdle() {
    btn.classList.remove('speaking');
  }

  function _stopAudio() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (_) {}
      try { currentAudio.src = ''; } catch (_) {}
      currentAudio = null;
    }
  }

  /* WebSpeech path (browser-native SpeechSynthesis — Anthropic's stub API).
     Applies the user's saved voice/rate/volume (Settings → Read Aloud). The
     voice is matched by name from speechSynthesis.getVoices(); rate (0.1–10)
     and volume (0–1) map straight onto the utterance. */
  function speakWebSpeech(txt) {
    if (!synth) { addMsg('Speech synthesis not available in this webview.', 'error'); setIdle(); return; }
    synth.cancel();
    const utt = new SpeechSynthesisUtterance(txt);
    utt.lang = navigator.language || 'en-US';
    /* Saved voice: match by name from the live voice list. */
    const wantVoice = String(window.__cbeTtsVoice || '');
    if (wantVoice) {
      try {
        const voices = (synth.getVoices && synth.getVoices()) || [];
        const v = voices.find((x) => x.name === wantVoice);
        if (v) { utt.voice = v; if (v.lang) utt.lang = v.lang; }
      } catch (_) {}
    }
    const r = Number(window.__cbeTtsRate);
    if (Number.isFinite(r) && r > 0) utt.rate = Math.max(0.1, Math.min(10, r));
    const vol = Number(window.__cbeTtsVolume);
    if (Number.isFinite(vol)) utt.volume = Math.max(0, Math.min(1, vol));
    utt.onend = utt.onerror = setIdle;
    btn.classList.add('speaking');
    synth.speak(utt);
  }

  /* Remote (ElevenLabs / OpenAI) path — extension does the HTTP call so the
     API key never crosses the webview boundary. We send a unique reqId so
     out-of-order replies don't clobber the wrong utterance. */
  function speakRemote(txt, provider) {
    if (!api) { addMsg('Voice: extension API unavailable — falling back to WebSpeech.', 'info'); speakWebSpeech(txt); return; }
    const reqId = 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    btn.classList.add('speaking');
    pendingTtsReqs.set(reqId, true);
    try {
      /* Carry the saved per-provider voice + tuning so the host call uses them.
         openai: voice + speed (0.25–4). elevenlabs: voiceId + stability/similarity. */
      api.postMessage({
        type: 'ttsRequest', reqId, provider, text: txt,
        voice:      String(window.__cbeTtsOpenAiVoice || 'alloy'),
        speed:      Number(window.__cbeTtsOpenAiSpeed) || 1,
        voiceId:    String(window.__cbeTtsElevenVoice || ''),
        stability:  (window.__cbeTtsElevenStability != null) ? Number(window.__cbeTtsElevenStability) : undefined,
        similarity: (window.__cbeTtsElevenSimilarity != null) ? Number(window.__cbeTtsElevenSimilarity) : undefined,
      });
    } catch (e) {
      console.debug('[cbe.tts] postMessage threw', e && e.message);
      pendingTtsReqs.delete(reqId);
      speakWebSpeech(txt);   /* graceful degrade */
    }
  }

  function speak(txt) {
    if (!txt) return;
    stopAll();                       /* preempt any in-flight utterance */
    const provider = window.__cbeTtsProvider || 'elevenlabs';
    if (provider === 'webspeech') return speakWebSpeech(txt);
    return speakRemote(txt, provider);
  }

  function stopAll() {
    if (synth) synth.cancel();
    _stopAudio();
    pendingTtsReqs.clear();
    setIdle();
  }

  /* Receive base64 mp3 from the host (ElevenLabs / OpenAI). On error fall
     back to WebSpeech so the user still hears something — proves the
     pitch's "voice always works" promise even if a key is missing. */
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type !== 'ttsResult') return;
    if (!pendingTtsReqs.has(m.reqId)) return;
    pendingTtsReqs.delete(m.reqId);
    if (!m.ok || !m.audioB64) {
      /* Graceful degrade: the remote provider (elevenlabs/openai) had no key
         or errored, so we fall back to keyless WebSpeech. This is NOT a
         user-facing failure — the audio still plays — so keep it to the
         console. Surfacing a toast here was the "says it failed but it works"
         false-failure. */
      console.debug('[cbe.tts] remote provider unavailable (' + (m.provider || '?') + '): ' + (m.error || 'unknown') + ' — using WebSpeech');
      speakWebSpeech(lastReply);
      return;
    }
    try {
      _stopAudio();
      currentAudio = new Audio('data:' + (m.mime || 'audio/mpeg') + ';base64,' + m.audioB64);
      currentAudio.onended = currentAudio.onerror = setIdle;
      currentAudio.play().catch((err) => {
        console.debug('[cbe.tts] audio.play threw', err && err.message);
        setIdle();
      });
    } catch (err) {
      console.debug('[cbe.tts] decode threw', err && err.message);
      setIdle();
    }
  });

  btn.addEventListener('click', (e) => {
    if (e.detail >= 2) return;
    if (isSpeaking()) { stopAll(); return; }
    if (lastReply) speak(lastReply);
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    autoRead = !autoRead;
    btn.classList.toggle('autoread', autoRead);
    btn.setAttribute('data-tooltip', autoRead
      ? 'Auto-read ON — right-click to disable'
      : 'Read aloud · right-click = auto-read every reply');
    if (autoRead) {
      playSfx('enable');
      if (lastReply) speak(lastReply);
    } else {
      playSfx('disable');
      stopAll();
    }
  });

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

/* ── Dictation (STT button, .speaking class toggles a red tint) ──────────
   Four-provider dispatch (window.__cbeSttProvider):

     'whisper-local': MediaRecorder captures webm/opus → base64 → host hits
                    local whisper.cpp server (keyless, offline, ~75MB model
                    auto-downloaded on first use). DEFAULT keyless option.
     'elevenlabs' : MediaRecorder captures webm/opus → base64 → host hits
                    ElevenLabs Scribe v1 → transcript. Lowest WER provider.
     'openai'     : MediaRecorder capture → host hits OpenAI
                    gpt-4o-transcribe (NOT older Whisper — see memory
                    stt_model_choice.md). Pro-tier accuracy.
     'webspeech'  : Browser-native SpeechRecognition (Anthropic's stub API).
                    BROKEN in the VSCode webview sandbox — kept as a value
                    for back-compat only; the click handler auto-promotes
                    it to 'elevenlabs' before any attempt. */
/* Default = elevenlabs (per user memory `elevenlabs_default.md`). The host's
   init payload re-hydrates this from workspaceState, but if that was stale-set
   to 'webspeech' the click handler below promotes it anyway. 2026-05-29. */
window.__cbeSttProvider = window.__cbeSttProvider || 'elevenlabs';
/* STT dictionary / language window state — hydrated on `init`, set by
   Settings → Speech to Text, read by the sttRequest / sttStreamStart posts
   and startWebSpeech's recog.lang. */
if (window.__cbeSttDictionary === undefined) window.__cbeSttDictionary = '';
if (window.__cbeSttLanguage   === undefined) window.__cbeSttLanguage   = '';
(function() {
  const sttBtn = document.getElementById('sttBtn');
  let recog = null;
  let listening = false;
  let mode = 'idle';            /* 'idle' | 'sr' (Web Speech) | 'host' (host fallback hint) | 'rec' (MediaRecorder for remote/whisper-local provider) */
  let mediaRec = null;
  let mediaStream = null;
  let recChunks = [];
  let recProvider = '';
  let pendingSttReqId = '';
  /* Live PCM streaming (anthropic + openai realtime) state. */
  let streamReqId = '';
  let audioCtx = null;
  let captureNode = null;     /* AudioWorkletNode or ScriptProcessorNode */
  let captureSource = null;   /* MediaStreamAudioSourceNode */
  /* Set true when we start a realtime openai stream so the sttFinal handler
     knows it's allowed to silently fall back to the host batch path on a
     WS error / 401 (no red banner — user already paid for the click). */
  let __cbeOpenAiRealtimeFallbackPending = false;
  /* Tracks whether any partial actually arrived during the openai realtime
     session. If no partials AND the session errored, we degrade silently
     via startHostRecording('openai') (host batch) — that's the safety net. */
  let __cbeOpenAiRealtimeGotPartial = false;

  function setListeningUI(on) {
    /* `.speaking` is the legacy red-tint state. `.is-recording` drives the
       blue loading-ring overlay (same SVG as #monitorBtn) so the user can
       tell at a glance that the mic is actively capturing — important on
       slow paths (whisper-local first-run model download) where transcript
       may take several seconds to come back. */
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
    const wasMode = mode;
    if (recog) {
      /* WebSpeech: onend will fire; commit the live transcript now (onend may
         arrive after we've reset mode, so do it here too — idempotent). */
      try { recog.stop(); }
      catch (e) { console.debug('[cbe.stt] recog.stop', e && e.message); }
      recog = null;
      cancelLiveDictation();
    }
    if (mode === 'host' && api) {
      try { api.postMessage({ type: 'sttStop' }); } catch (e) {}
    }
    if (mode === 'rec') {
      /* MediaRecorder path: stop() fires `dataavailable` + `stop` which the
         onstop handler turns into a sttRequest post. We DON'T tear down
         mediaStream here — the onstop handler does, after it's read the
         blob. */
      if (mediaRec && mediaRec.state !== 'inactive') {
        try { mediaRec.stop(); } catch (e) { console.debug('[cbe.stt] mediaRec.stop', e && e.message); }
      }
    }
    if (mode === 'stream') {
      /* Live PCM streaming path (anthropic). Tell the host to flush + finalize;
         the live dictation stays on screen until sttFinal commits it. Tear
         down the capture graph so the mic releases immediately. */
      if (api && streamReqId) {
        try { api.postMessage({ type: 'sttStreamStop', reqId: streamReqId }); } catch (_) {}
      }
      stopPcmCapture();
    }
    if (mode === 'hostrec') {
      /* Host-side ffmpeg capture (PRIMARY path). Tell the host to stop the
         mic + transcribe; the transcript comes back as sttRequestResult and
         pastes into the input. Keep the recording-ring on until then — the
         transcribe round-trip can take a second. We DON'T reset to idle here
         for hostrec; the sttRequestResult handler does that when the text
         (or error) lands. */
      if (api) {
        try {
          api.postMessage({
            type: 'sttHostStop', reqId: pendingSttReqId, provider: recProvider,
            dictionary: String(window.__cbeSttDictionary || ''),
            language:   String(window.__cbeSttLanguage || ''),
          });
        } catch (_) {}
      }
      /* Leave listening=true / mode unchanged so a stray second click can't
         double-fire; the result handler clears state. Just drop the wasMode
         disable-sfx (fires on transcript land instead). */
      return;
    }
    if (mode === 'hostrec-el') {
      /* ElevenLabs Scribe v2 Realtime streaming. Tell the host to stop
         ffmpeg + send end_of_stream to the WS; the final transcript lands
         as sttResultEl and we commit-live-dictation there. Keep the
         recording-ring on until then so the user sees the cap closing. */
      if (api) {
        try {
          api.postMessage({ type: 'sttHostStopEl', reqId: pendingSttReqId, provider: 'elevenlabs' });
        } catch (_) {}
      }
      return;
    }
    if (mode === 'hostrec-wcpp') {
      /* Realtime local: whisper.cpp stream. Host kills the subprocess +
         ffmpeg; trailing transcript flushes as sttResultEl. */
      if (api) {
        try {
          api.postMessage({ type: 'sttHostStopWcpp', reqId: pendingSttReqId, provider: 'whisper-cpp-stream' });
        } catch (_) {}
      }
      return;
    }
    if (mode === 'hostrec-fw') {
      /* Realtime local: faster-whisper. Host closes stdin → python does one
         final transcribe on the residual buffer + exits → sttResultEl. */
      if (api) {
        try {
          api.postMessage({ type: 'sttHostStopFw', reqId: pendingSttReqId, provider: 'faster-whisper-stream' });
        } catch (_) {}
      }
      return;
    }
    if (mode === 'hostrec-dg') {
      /* Deepgram streaming. Host stops ffmpeg + sends CloseStream to the WS;
         the final transcript flushes as sttResultEl. */
      if (api) {
        try {
          api.postMessage({ type: 'sttHostStopDg', reqId: pendingSttReqId, provider: 'deepgram' });
        } catch (_) {}
      }
      return;
    }
    listening = false;
    mode = 'idle';
    setListeningUI(false);
    if (wasListening && wasMode !== 'stream') playSfx('disable');
    /* For 'stream' the disable sfx fires when sttFinal lands, so stop/finalize
       feel connected. */
  }

  function _tearDownMediaStream() {
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); } catch (_) {}
      mediaStream = null;
    }
    mediaRec = null;
    recChunks = [];
  }

  /* ── Live PCM capture (Web Audio) for streaming providers ─────────────────
     MediaRecorder emits webm/opus which can't be incrementally decoded mid-
     stream, so for live STT we tap raw PCM off the AudioContext, downsample
     from the context rate (usually 48000) to 16000, convert Float32 → Int16
     LE, and ship ~100ms chunks (3200 bytes) to the host as base64.

     Downsampling is a plain decimation with a running fractional accumulator
     (good enough for speech STT; the proxy is robust). We prefer an
     AudioWorklet (no deprecation, runs off the main thread) but fall back to a
     ScriptProcessorNode, which is deprecated but works universally in the
     Chromium-based VSCode webview. */

  /* Float32 [-1,1] → Int16 LE Buffer-equivalent (Uint8Array we base64 below). */
  function _float32ToInt16LE(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /* base64 of an Int16Array's little-endian bytes (webview has no Buffer). */
  function _int16ToB64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  /* A stateful downsampler from `inRate` to 16000 via fractional decimation.
     Keeps the fractional read position across calls so chunk boundaries don't
     drift. Returns a Float32Array at 16k. */
  function _makeDownsampler(inRate) {
    const ratio = inRate / 16000;
    let pos = 0;   /* fractional read index into a virtual concatenated stream */
    return function (f32) {
      if (ratio <= 1) return f32.slice();   /* already <=16k: pass through */
      const out = [];
      /* pos is relative to the start of THIS buffer each call (we reset the
         integer part; carry only the fraction). */
      let p = pos;
      while (p < f32.length) {
        out.push(f32[Math.floor(p)]);
        p += ratio;
      }
      pos = p - f32.length;   /* carry the fractional remainder into next call */
      const arr = new Float32Array(out.length);
      arr.set(out);
      return arr;
    };
  }

  let _pcmDownsample = null;
  let _pcmSendBuf = [];        /* accumulated Int16 samples awaiting a 100ms flush */
  const PCM_FLUSH_SAMPLES = 1600;   /* 100ms @16k */

  function _flushPcm(force) {
    while (_pcmSendBuf.length >= PCM_FLUSH_SAMPLES || (force && _pcmSendBuf.length)) {
      const take = force ? _pcmSendBuf.length : PCM_FLUSH_SAMPLES;
      const slice = _pcmSendBuf.slice(0, take);
      _pcmSendBuf = _pcmSendBuf.slice(take);
      const int16 = new Int16Array(slice);
      if (api && streamReqId) {
        try { api.postMessage({ type: 'sttStreamChunk', reqId: streamReqId, pcmB64: _int16ToB64(int16) }); } catch (_) {}
      }
      if (force) break;
    }
  }

  function _onPcmFrame(f32) {
    if (mode !== 'stream') return;
    const ds = _pcmDownsample ? _pcmDownsample(f32) : f32;
    const int16 = _float32ToInt16LE(ds);
    for (let i = 0; i < int16.length; i++) _pcmSendBuf.push(int16[i]);
    _flushPcm(false);
  }

  function stopPcmCapture() {
    _flushPcm(true);   /* ship the tail */
    if (captureNode) { try { captureNode.disconnect(); } catch (_) {} try { captureNode.port && (captureNode.port.onmessage = null); } catch (_) {} }
    if (captureSource) { try { captureSource.disconnect(); } catch (_) {} }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    captureNode = null; captureSource = null; audioCtx = null;
    _pcmDownsample = null; _pcmSendBuf = [];
    _tearDownMediaStream();
  }

  /* Try AudioWorklet; resolves true if the worklet capture node is wired,
     false if the worklet path is unavailable (caller falls back to
     ScriptProcessor). */
  async function _tryAudioWorklet() {
    if (!audioCtx.audioWorklet) return false;
    /* Inline worklet processor: forwards each 128-sample render quantum's
       channel-0 Float32 to the main thread. Loaded from a blob URL so we
       don't ship a separate file (CSP in the webview allows blob: workers). */
    const src = `
      class CbePcmProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch && ch.length) this.port.postMessage(ch.slice(0));
          return true;
        }
      }
      registerProcessor('cbe-pcm', CbePcmProcessor);
    `;
    let url;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(url);
    } catch (e) {
      console.debug('[cbe.stt] AudioWorklet addModule failed', e && e.message);
      if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
      return false;
    }
    try { URL.revokeObjectURL(url); } catch (_) {}
    try {
      captureNode = new AudioWorkletNode(audioCtx, 'cbe-pcm');
      captureNode.port.onmessage = (ev) => { if (ev.data) _onPcmFrame(ev.data); };
      captureSource.connect(captureNode);
      /* Worklets don't need a destination connection to pull, but connecting
         to a muted gain keeps the graph alive in some Chromium builds. */
      return true;
    } catch (e) {
      console.debug('[cbe.stt] AudioWorkletNode ctor failed', e && e.message);
      return false;
    }
  }

  function _wireScriptProcessor() {
    /* Deprecated but universally available. 4096-frame buffer ≈ 85ms @48k. */
    const sp = audioCtx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      _onPcmFrame(ch);
    };
    captureSource.connect(sp);
    /* ScriptProcessor only fires onaudioprocess while connected to the
       destination — route through a muted gain so we don't echo the mic. */
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    sp.connect(mute);
    mute.connect(audioCtx.destination);
    captureNode = sp;
  }

  /* Live PCM streaming path for anthropic. If mic permission is denied,
     surface ONE clear error and respect the user's provider choice — do
     NOT silently downgrade to WebSpeech. Internal mode fallbacks (Audio
     Context → MediaRecorder request/response) stay, since those keep the
     same provider. */
  async function startPcmStream(provider) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.debug('[cbe.stt] getUserMedia denied for ' + provider, e && e.message);
      addMicDeniedMsg(provider);
      mode = 'idle'; listening = false; setListeningUI(false);
      return;
    }
    mediaStream = stream;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !api) {
      console.debug('[cbe.stt] no AudioContext / api — falling back to MediaRecorder request/response');
      _tearDownMediaStream();
      startMediaRecorder(provider);
      return;
    }
    try {
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (_) {} }
      captureSource = audioCtx.createMediaStreamSource(stream);
      _pcmDownsample = _makeDownsampler(audioCtx.sampleRate);
      _pcmSendBuf = [];
    } catch (e) {
      console.debug('[cbe.stt] AudioContext setup failed — falling back to request/response', e && e.message);
      stopPcmCapture();
      startMediaRecorder(provider);
      return;
    }

    /* Open the host-side WS session BEFORE we start emitting chunks. */
    streamReqId = 'stts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    recProvider = provider;
    mode = 'stream';
    listening = true;
    beginLiveDictation();
    try {
      /* Carry the custom dictionary (appended to the Deepgram keyterm list)
         + language so the live session biases recognition. */
      api.postMessage({
        type: 'sttStreamStart', provider, reqId: streamReqId,
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (_) {}

    let wired = false;
    try { wired = await _tryAudioWorklet(); } catch (_) { wired = false; }
    if (!wired) {
      try { _wireScriptProcessor(); }
      catch (e) {
        console.debug('[cbe.stt] capture node wiring failed — falling back', e && e.message);
        /* Abort the just-opened stream cleanly. */
        try { api.postMessage({ type: 'sttStreamStop', reqId: streamReqId }); } catch (_) {}
        streamReqId = '';
        cancelLiveDictation();
        stopPcmCapture();
        mode = 'idle'; listening = false; setListeningUI(false);
        startMediaRecorder(provider);
        return;
      }
    }
    setListeningUI(true);
    playSfx('connect');
  }

  /* MediaRecorder path for whisper-local / ElevenLabs / OpenAI / Anthropic
     (when the live PCM path falls back here). Respect the user's chosen
     provider on failure — surface ONE clear error, do NOT silently switch
     to WebSpeech. */
  async function startMediaRecorder(provider) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.debug('[cbe.stt] getUserMedia denied for ' + provider, e && e.message);
      addMicDeniedMsg(provider);
      mode = 'idle'; listening = false; setListeningUI(false);
      return;
    }
    mediaStream = stream;
    /* Pick the first MIME type the browser actually supports. webm/opus is
       universal in Chromium; both ElevenLabs and OpenAI accept it. */
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    let chosen = '';
    for (const c of candidates) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) { chosen = c; break; } }
      catch (_) {}
    }
    try {
      mediaRec = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
    } catch (e) {
      console.debug('[cbe.stt] MediaRecorder ctor threw', e && e.message);
      _tearDownMediaStream();
      addMsg('Voice (' + provider + '): MediaRecorder unavailable — falling back to WebSpeech.', 'info');
      startWebSpeech();
      return;
    }
    recChunks = [];
    recProvider = provider;
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
    mediaRec.onerror = (e) => {
      console.debug('[cbe.stt] MediaRecorder error', e && (e.error && e.error.message || e.message));
      _tearDownMediaStream();
      stopMic();
      addMsg('Voice (' + provider + '): recorder error — try again.', 'error');
    };
    mediaRec.onstop = () => {
      const mime = (mediaRec && mediaRec.mimeType) || 'audio/webm';
      const blob = new Blob(recChunks, { type: mime });
      _tearDownMediaStream();
      if (!blob || blob.size === 0) {
        addMsg('Voice (' + provider + '): no audio captured.', 'info');
        return;
      }
      /* Send to host as base64 so the structured-clone limit on bare ArrayBuffer
         payloads (some VSCode builds) doesn't kick in. */
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = String(fr.result || '');
        const idx = dataUrl.indexOf(',');
        const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : '';
        if (!b64) { addMsg('Voice (' + provider + '): audio encode failed.', 'error'); return; }
        pendingSttReqId = 'stt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        try {
          /* Carry the custom dictionary (whisper-local/openai use it as the
             transcription `prompt`) + language so the host biases recognition. */
          api.postMessage({
            type: 'sttRequest', reqId: pendingSttReqId, provider, mime, audioB64: b64,
            dictionary: String(window.__cbeSttDictionary || ''),
            language:   String(window.__cbeSttLanguage || ''),
          });
        } catch (e) {
          console.debug('[cbe.stt] sttRequest postMessage threw', e && e.message);
          addMsg('Voice (' + provider + '): cannot reach host — falling back to WebSpeech.', 'info');
          startWebSpeech();
        }
      };
      fr.onerror = () => { addMsg('Voice (' + provider + '): audio encode failed.', 'error'); };
      fr.readAsDataURL(blob);
    };
    mediaRec.start();
    mode = 'rec';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
  }

  function appendToInput(t) {
    const cur = (ti.value || '').replace(/\s+$/, '');
    ti.value = cur ? (cur + ' ' + t) : t;
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    ti.focus();
  }

  /* ── Live dictation (streaming providers: webspeech + anthropic) ──────────
     The transcript is CUMULATIVE (replace, not append) — both WebSpeech
     interim results and Anthropic's TranscriptInterim/Text carry the whole
     in-progress utterance each time. We snapshot whatever was already in the
     input when dictation starts, then render `prefix + liveText` on every
     update so the words grow in place (like gemini.com). On commit the live
     text becomes permanent; on cancel we restore the prefix. */
  let liveActive = false;
  let livePrefix = '';      /* input contents before dictation began */
  let liveText = '';        /* current cumulative transcript */

  function beginLiveDictation() {
    liveActive = true;
    const cur = (ti.value || '').replace(/\s+$/, '');
    livePrefix = cur ? cur + ' ' : '';
    liveText = '';
  }
  function updateLiveDictation(text) {
    if (!liveActive) return;
    liveText = String(text || '');
    ti.value = livePrefix + liveText;
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    ti.focus();
  }
  function commitLiveDictation(finalText) {
    if (!liveActive) {
      /* Defensive: if we somehow get a final without a begin, just append. */
      if (finalText) appendToInput(String(finalText).trim());
      return;
    }
    const t = String(finalText != null ? finalText : liveText).trim();
    ti.value = (livePrefix + t).replace(/\s+$/, '');
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    ti.focus();
    liveActive = false; livePrefix = ''; liveText = '';
  }
  function cancelLiveDictation() {
    if (!liveActive) return;
    /* Keep whatever was transcribed so far rather than discarding it — the
       user stopped on purpose; the partial is usually what they wanted. */
    commitLiveDictation();
  }
  /* Expose to send() (module scope) so a send always commits + clears any
     still-active dictation — hardens every STT provider against leaking an
     uncommitted transcript across a send (Trent 2026-06-04 accumulation bug). */
  window.__cbeCancelDictation = cancelLiveDictation;

  function startHostSttHint() {
    /* Legacy WebSpeech-denied fallback. Whisper-local needs MediaRecorder
       audio bytes, not a host-side passthrough — so this just pings the
       host to surface a "switch provider in Settings" hint message. */
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot fall back.', 'error');
      return;
    }
    mode = 'host';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    api.postMessage({ type: 'sttStart' });
  }

  /* PRIMARY STT capture for elevenlabs / openai / whisper-local. We DO NOT
     call getUserMedia here — the VSCode webview is a sandboxed iframe and
     Electron denies media capture regardless of the OS grant to Code.exe
     (no extension API can grant it), so getUserMedia always threw
     NotAllowedError → the misleading "microphone access denied" banner.
     Instead we record the mic in the Node extension HOST via ffmpeg dshow.
     We post sttHostStart; the host opens the mic and replies sttHostStarted
     (confirmed live) or sttHostResult{ok:false,error} (real cause: ffmpeg
     missing / no device). On stop, stopMic() posts sttHostStop and the host
     transcribes → sttRequestResult → pastes into the input. */
  function startHostRecording(provider) {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot record.', 'error');
      return;
    }
    recProvider = provider;
    pendingSttReqId = 'hoststt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    mode = 'hostrec';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    try {
      api.postMessage({
        type: 'sttHostStart', reqId: pendingSttReqId, provider,
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (e) {
      console.debug('[cbe.stt] sttHostStart postMessage threw', e && e.message);
      mode = 'idle'; listening = false; setListeningUI(false);
      addMsg('Voice (' + provider + '): cannot reach host to start recording.', 'error');
    }
  }

  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      /* No Web Speech API at all — surface the host fallback hint. */
      startHostSttHint();
      return;
    }
    try {
      recog = new SR();
      /* Live "words appear as you speak" — same API gemini.com uses. continuous
         keeps the session open across pauses; interimResults streams partials. */
      recog.continuous   = true;
      recog.interimResults = true;
      /* Saved STT language (Settings → Speech to Text) overrides the browser
         default when set. */
      recog.lang = String(window.__cbeSttLanguage || '').trim() || (navigator.language || 'en-US');
      /* WebSpeech gives us per-result finality. We commit finalized results to a
         running buffer and show committed + in-progress interim live on EVERY
         onresult (not just the final one). */
      beginLiveDictation();
      let srCommitted = '';
      recog.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = (res[0] && res[0].transcript) || '';
          if (res.isFinal) srCommitted = (srCommitted ? srCommitted + ' ' : '') + txt.trim();
          else interim += txt;
        }
        /* Cumulative committed + the live tail — updates on every event. */
        updateLiveDictation([srCommitted, interim.trim()].filter(Boolean).join(' '));
      };
      recog.onerror = (e) => {
        const err = e && e.error;
        /* VSCode webview sandbox blocks mic access. On not-allowed /
           service-not-allowed, surface the host hint (which tells the user
           to switch the STT provider to whisper-local in Settings). */
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          console.debug('[cbe.stt] Web Speech denied (' + err + ') — falling back to host hint');
          /* Tear down the recognizer first so its onend doesn't clobber UI. */
          if (recog) { try { recog.onend = null; recog.stop(); } catch (_) {} recog = null; }
          liveActive = false; livePrefix = ''; liveText = '';   /* nothing transcribed */
          mode = 'idle';
          listening = false;
          startHostSttHint();
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
      /* SR constructor itself can throw in some webviews — surface the host hint. */
      console.debug('[cbe.stt] SR ctor threw — falling back to host hint', e && e.message);
      if (recog) { try { recog.stop(); } catch (_) {} recog = null; }
      startHostSttHint();
    }
  }

  sttBtn.onclick = () => {
    if (listening) { stopMic(); return; }
    /* STT default = elevenlabs (per user memory `elevenlabs_default.md`).
       Previously 'webspeech' which kept routing Trent's clicks through the
       Anthropic streaming path on a stale workspaceState selection. 2026-05-27. */
    let provider = window.__cbeSttProvider || 'elevenlabs';
    /* VSCode webview sandbox detection — Electron denies SpeechRecognition
       AND getUserMedia in the webview iframe regardless of OS mic grant, so
       'webspeech' will always emit `not-allowed` here and surface the red
       "WebSpeech denied by sandbox" banner. Auto-promote to 'elevenlabs' on
       the spot and persist the change so the user isn't stuck. Trent saw
       the banner double-fire on a single click 2026-05-29. */
    const inVscodeWebview = (typeof acquireVsCodeApi === 'function')
      || (typeof api !== 'undefined' && api && typeof api.postMessage === 'function');
    if (provider === 'webspeech' && inVscodeWebview) {
      console.debug('[cbe.stt] sandbox auto-promote: webspeech -> elevenlabs');
      provider = 'elevenlabs';
      window.__cbeSttProvider = 'elevenlabs';
      /* Persist so the next click also routes correctly. Dedicated message
         instead of `setProvider` (which would overwrite the active LLM
         provider). Host handler at extension.js case 'setSttProvider'. */
      try { api && api.postMessage({ type: 'setSttProvider', sttProvider: 'elevenlabs' }); } catch (_) {}
    }
    if (provider === 'webspeech') {
      /* Browser-native live streaming (only reachable outside the sandbox). */
      startWebSpeech();
      return;
    }
    /* ElevenLabs Scribe v2 Realtime (streaming WS, 2026-05-29). Host opens
       ffmpeg → ElevenLabs WS → partial transcripts stream back as
       sttDeltaEl events while the user speaks (~150ms latency). On WS
       error / 401 the HOST silently falls through to the batch path
       (handleHostSttStart) and we end up in the same sttRequestResult
       flow — the panel doesn't need to know. */
    if (provider === 'elevenlabs') {
      startElevenLabsStreaming();
      return;
    }
    /* Realtime local providers (2026-05-30 — replaces the batch whisper-local
       path). Same host-side ffmpeg → subprocess → sttDeltaEl/sttResultEl
       protocol as the ElevenLabs streaming flow. */
    if (provider === 'whisper-cpp-stream') {
      startWhisperCppStreaming();
      return;
    }
    if (provider === 'faster-whisper-stream') {
      startFasterWhisperStreaming();
      return;
    }
    /* Deepgram Nova-3 streaming (BYO key, 2026-05-31) — real-time host ffmpeg
       → Deepgram WS → sttDeltaEl partials. Same streaming protocol as
       ElevenLabs; on WS / auth error the host silently falls back to the
       batch REST path (sttRequestResult). */
    if (provider === 'deepgram') {
      startDeepgramStreaming();
      return;
    }
    /* anthropic / openai ALL go through the HOST ffmpeg capture path.
       openai's webview-side getUserMedia path was sandbox-blocked in VSCode
       (always NotAllowedError → false "mic denied" banner) even though the
       OS grant was correct — confirmed 2026-05-30 by ElevenLabs (host
       ffmpeg) working seconds before openai failed on the same mic. Host
       capture = single safe default for everything except the streaming
       providers above. */
    startHostRecording(provider);
  };

  /* PRIMARY ElevenLabs path: host-side ffmpeg streams raw PCM straight into
     the ElevenLabs Scribe v2 Realtime WS. Partial transcripts arrive as
     sttDeltaEl messages and we render them via the existing live-dictation
     helpers (the same words-grow-in-place UX Anthropic streaming uses). On
     mic-up the host commits the WS + we get sttResultEl with the final text.
     If the WS errors / 401s, the host falls back to the batch path silently
     and the panel sees a sttRequestResult instead — handled below. */
  function startElevenLabsStreaming() {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot record.', 'error');
      return;
    }
    recProvider = 'elevenlabs';
    pendingSttReqId = 'elstream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    mode = 'hostrec-el';   /* distinct from 'hostrec' so stopMic routes correctly */
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    beginLiveDictation();   /* arm the prefix + live region for word-grow */
    try {
      api.postMessage({
        type: 'sttHostStartEl',
        reqId: pendingSttReqId,
        provider: 'elevenlabs',
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (e) {
      console.debug('[cbe.stt] sttHostStartEl postMessage threw', e && e.message);
      cancelLiveDictation();
      mode = 'idle'; listening = false; setListeningUI(false);
      addMsg('Voice (elevenlabs): cannot reach host to start streaming.', 'error');
    }
  }

  /* Realtime local: whisper.cpp `stream` example binary. Lazy-downloaded by
     the host on first use (~75MB tiny.en model + ggerganov release zip).
     Same protocol as ElevenLabs streaming — partials arrive as sttDeltaEl
     (with provider:'whisper-cpp-stream'); final as sttResultEl. */
  function startWhisperCppStreaming() {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot record.', 'error');
      return;
    }
    recProvider = 'whisper-cpp-stream';
    pendingSttReqId = 'wcppstream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    mode = 'hostrec-wcpp';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    beginLiveDictation();
    try {
      api.postMessage({
        type: 'sttHostStartWcpp',
        reqId: pendingSttReqId,
        provider: 'whisper-cpp-stream',
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (e) {
      console.debug('[cbe.stt] sttHostStartWcpp postMessage threw', e && e.message);
      cancelLiveDictation();
      mode = 'idle'; listening = false; setListeningUI(false);
      addMsg('Voice (whisper-cpp-stream): cannot reach host to start streaming.', 'error');
    }
  }

  /* Realtime local: faster-whisper (CTranslate2) + webrtcvad sliding window
     via python venv. First use triggers a ~150MB venv bootstrap progress
     notification; subsequent uses skip that. */
  function startFasterWhisperStreaming() {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot record.', 'error');
      return;
    }
    recProvider = 'faster-whisper-stream';
    pendingSttReqId = 'fwstream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    mode = 'hostrec-fw';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    beginLiveDictation();
    try {
      api.postMessage({
        type: 'sttHostStartFw',
        reqId: pendingSttReqId,
        provider: 'faster-whisper-stream',
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (e) {
      console.debug('[cbe.stt] sttHostStartFw postMessage threw', e && e.message);
      cancelLiveDictation();
      mode = 'idle'; listening = false; setListeningUI(false);
      addMsg('Voice (faster-whisper-stream): cannot reach host to start streaming.', 'error');
    }
  }

  /* Deepgram Nova-3 streaming (BYO key, 2026-05-31). Host opens ffmpeg →
     Deepgram WS → partial transcripts stream back as sttDeltaEl while the user
     speaks (~sub-second), final as sttResultEl. Same generic streaming
     protocol as ElevenLabs/whisper-stream. On WS error / 401 the host silently
     falls through to the batch REST path (sttRequestResult). */
  function startDeepgramStreaming() {
    if (!api) {
      addMsg('Voice: extension API unavailable — cannot record.', 'error');
      return;
    }
    recProvider = 'deepgram';
    pendingSttReqId = 'dgstream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    mode = 'hostrec-dg';
    listening = true;
    setListeningUI(true);
    playSfx('connect');
    beginLiveDictation();
    try {
      api.postMessage({
        type: 'sttHostStartDg',
        reqId: pendingSttReqId,
        provider: 'deepgram',
        dictionary: String(window.__cbeSttDictionary || ''),
        language:   String(window.__cbeSttLanguage || ''),
      });
    } catch (e) {
      console.debug('[cbe.stt] sttHostStartDg postMessage threw', e && e.message);
      cancelLiveDictation();
      mode = 'idle'; listening = false; setListeningUI(false);
      addMsg('Voice (deepgram): cannot reach host to start streaming.', 'error');
    }
  }

  /* Host responses — the legacy WebSpeech-denied fallback (sttResult) and
     the MediaRecorder remote-provider transcript (sttRequestResult) come
     back as separate message types so the panel can't confuse them. */
  let _lastSttErrMsg = '';
  let _lastSttErrAt  = 0;
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'sttResult') {
      /* Host fallback hint (WebSpeech denied). Reset UI regardless. */
      if (m.error) {
        /* Dedupe identical errors within 1.5s — WebSpeech can fire
           `not-allowed` + `service-not-allowed` + onend in rapid succession
           and stale recog handlers can re-fire after the host already replied.
           Trent saw the same red banner twice for a single click 2026-05-29. */
        const nowMs = Date.now();
        const same  = (String(m.error) === _lastSttErrMsg) && (nowMs - _lastSttErrAt < 1500);
        if (!same) {
          addMsg('Voice: ' + m.error, 'error');
          _lastSttErrMsg = String(m.error);
          _lastSttErrAt  = nowMs;
        } else {
          console.debug('[cbe.stt] dedupe identical sttResult error');
        }
      } else if (m.text) {
        appendToInput(String(m.text).trim());
      } else {
        addMsg('Voice: no speech detected.', 'info');
      }
      listening = false;
      mode = 'idle';
      setListeningUI(false);
      playSfx('disable');
      return;
    }
    if (m.type === 'sttHostStarted') {
      /* Host ffmpeg capture confirmed live (mic open). The red recording-ring
         is already on from startHostRecording(); nothing to do but keep it. */
      console.debug('[cbe.stt] host recording started on', m.device || '?');
      return;
    }
    if (m.type === 'sttHostResult') {
      /* Host-capture FAILURE before any audio (ffmpeg missing / no mic device
         / device busy). Surface the SPECIFIC cause — NOT "access denied". */
      if (m.ok === false) {
        addMsg('Voice: ' + (m.error || 'host mic capture failed') + '.', 'error');
      }
      pendingSttReqId = '';
      listening = false;
      mode = 'idle';
      setListeningUI(false);
      playSfx('disable');
      return;
    }
    if (m.type === 'sttRequestResult') {
      /* ElevenLabs / OpenAI transcript reply. */
      if (m.reqId && m.reqId !== pendingSttReqId) return;   /* ignore stale */
      pendingSttReqId = '';
      if (m.ok && m.text) {
        appendToInput(String(m.text).trim());
      } else if (m.ok) {
        addMsg('Voice (' + (m.provider || '?') + '): no speech detected.', 'info');
      } else {
        addMsg('Voice (' + (m.provider || '?') + '): ' + (m.error || 'unknown error') + ' — falling back to WebSpeech.', 'info');
        /* Don't restart — user can hit the mic again. The fallback is
           informational; we don't want to surprise-record after the user
           let go. */
      }
      listening = false;
      mode = 'idle';
      setListeningUI(false);
      playSfx('disable');
      return;
    }
    if (m.type === 'sttPartial') {
      /* Live interim transcript for streaming providers (anthropic +
         openai realtime). Text is CUMULATIVE — replace the in-progress
         dictation each time so the words grow in place. Ignore stale
         (post-stop) partials. */
      if (m.reqId && m.reqId !== streamReqId) return;
      if (String(m.text || '').trim()) __cbeOpenAiRealtimeGotPartial = true;
      updateLiveDictation(String(m.text || ''));
      return;
    }
    if (m.type === 'sttFinal') {
      /* Stream finished (clean close / endpoint / error). Commit whatever we
         have and reset UI. */
      if (m.reqId && m.reqId !== streamReqId) return;
      const wasRealtimeOpenAi = (m.provider === 'openai' && __cbeOpenAiRealtimeFallbackPending);
      streamReqId = '';
      if (m.ok) {
        commitLiveDictation(m.text != null ? String(m.text) : undefined);
        __cbeOpenAiRealtimeFallbackPending = false;
        __cbeOpenAiRealtimeGotPartial = false;
      } else if (wasRealtimeOpenAi && !__cbeOpenAiRealtimeGotPartial) {
        /* Realtime failed BEFORE any audio made it through (auth / WS handshake
           / network). Silently degrade to the host batch path — no red banner;
           the user just clicked the mic, they shouldn't see infra noise. The
           host already traced the real error to debug.log. */
        console.debug('[cbe.stt] openai realtime failed pre-partial — silent batch fallback');
        cancelLiveDictation();
        stopPcmCapture();
        __cbeOpenAiRealtimeFallbackPending = false;
        __cbeOpenAiRealtimeGotPartial = false;
        listening = false;
        mode = 'idle';
        setListeningUI(false);
        /* Don't auto-restart — the user wasn't speaking yet anyway, and
           kicking off a host recording behind their back would surprise-record.
           Next click will go through the same path (which will try realtime
           again — but if it's a persistent auth issue, that's a Settings fix). */
        return;
      } else {
        /* Keep the partial that was already showing, but tell the user. */
        cancelLiveDictation();
        addMsg('Voice (' + (m.provider || 'anthropic') + '): ' + (m.error || 'stream error'), 'info');
        __cbeOpenAiRealtimeFallbackPending = false;
        __cbeOpenAiRealtimeGotPartial = false;
      }
      stopPcmCapture();
      listening = false;
      mode = 'idle';
      setListeningUI(false);
      playSfx('disable');
      return;
    }
    if (m.type === 'sttDeltaEl') {
      /* ElevenLabs Scribe v2 Realtime partial. text is the CUMULATIVE
         running transcript (committed + tail) so we replace the live region
         the same way Anthropic's TranscriptInterim flow does. Ignore stale
         partials from a prior click. */
      if (m.reqId && m.reqId !== pendingSttReqId) return;
      updateLiveDictation(String(m.text || ''));
      return;
    }
    if (m.type === 'sttResultEl') {
      /* ElevenLabs streaming final / error. Commit the live dictation into
         #promptBox (mirrors the existing batch sttRequestResult paste path)
         then reset UI. On WS error the host already silently fell back to
         the batch path when possible — if .fallback is set we either just
         got the final text from the batch path OR we got a soft info
         (mic was already mid-stream when WS dropped); either way no red
         banner. */
      if (m.reqId && m.reqId !== pendingSttReqId) return;
      pendingSttReqId = '';
      if (m.ok) {
        commitLiveDictation(m.text != null ? String(m.text) : undefined);
      } else if (m.fallback) {
        /* Streaming failed AND batch couldn't transparently retake the click
           (mic was already streaming). Keep whatever partial we had — same
           as cancel-via-commit. Soft info, no red banner. */
        commitLiveDictation();
        const provLabel = String(m.provider || recProvider || 'elevenlabs');
        console.debug('[cbe.stt] ' + provLabel + ' streaming fell back: ' + (m.error || ''));
        addMsg('Voice (' + provLabel + '): streaming unavailable — used partial transcript.', 'info');
      } else {
        cancelLiveDictation();
        const provLabel = String(m.provider || recProvider || 'elevenlabs');
        addMsg('Voice (' + provLabel + '): ' + (m.error || 'streaming error'), 'info');
      }
      listening = false;
      mode = 'idle';
      setListeningUI(false);
      playSfx('disable');
      return;
    }
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
  if (p && p.cliAgent) return 'none';   /* logged-in Claude Code — OAuth, no key/account */
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
    const suffix = p.cliAgent ? '  (logged in)' : (p.bridge ? '  (browser login)' : (p.haveKey ? '' : '  (no key)'));
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
      saveBtn.type = 'button'; saveBtn.className = 'cbe-am-btn'; saveBtn.textContent = 'Apply1';
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

/* ── Shared prompt-row label layout — SINGLE SOURCE for all 15 skins ───────
   Each skin is its own standalone HTML, so the label/folder prompt-row layout
   used to be duplicated 15× and fixed one-at-a-time. Instead, panel.js (which
   is injected into EVERY skin) owns ONE shared stylesheet + a per-skin position
   map. The layout (label + project-folder pill always sharing the one
   .prompt-meta-row under the prompt box, with proper pairing) lives in one
   place; each skin only gets a POSITION (center / left / right) so they're not
   all identical. Change the layout here → all skins (current + future) update.
   Stop/Send spacing is left to the skins (already non-overlapping).
   The label + project-folder are STACKED (folder directly under the label) and
   the column is anchored to exactly ONE of three allowed spots (Trent 2026-06-02):
     'center' → centered, directly under the prompt bar  (DEFAULT)
     'left'   → bottom-left
     'right'  → bottom-right
   No other positions are permitted. */
const CBE_LABEL_POS = {
  // centered — clean / modern shells
  'codex-black': 'center', 'glassy': 'center', 'gnome': 'center',
  'kde': 'center', 'claude-default': 'center',
  // bottom-left — techy / classic shells
  'terminal': 'left', 'arch': 'left', 'ubuntu': 'left',
  'redhat': 'left', 'office': 'left',
  // bottom-right — dock / playful shells
  'tamagotchi': 'right', 'xfce': 'right', 'mint-dock': 'right',
  'macos-color-dock': 'right', 'aqua-dock': 'right',
};
const CBE_LABEL_POS_DEFAULT = 'center';

function ensurePromptRowSharedCss() {
  if (document.getElementById('cbe-promptrow-shared')) return;
  const st = document.createElement('style');
  st.id = 'cbe-promptrow-shared';
  st.textContent = [
    /* Brand label + project-folder pill, STACKED in one column under the
       prompt box (Trent 2026-06-02: the folder indicator must ALWAYS sit
       directly UNDER the label, never beside it). The column is anchored to
       ONE of the 3 allowed spots via body[data-cbe-label-pos] (CBE_LABEL_POS):
         left   → bottom-left
         center → center, directly under the prompt bar  (default)
         right  → bottom-right
       Higher specificity than the skins' own `.prompt-meta-row` rules +
       appended last, so this wins the cascade across every skin. */
    /* v3 (Trent 2026-06-10): meta-row is the LEFT cluster of the single
       control row [label][folder] ... [Stop][Send]. It must GROW (flex:1 1
       auto) and share the row with Stop/Send rather than take width:100%
       (the old full-width forced Stop/Send to wrap onto their own band). */
    '.prompt-meta-row{display:flex !important;flex-direction:row !important;',
    '  flex-wrap:nowrap !important;gap:4px 10px !important;flex:1 1 auto !important;',
    '  min-width:0 !important;align-items:center !important;',
    '  box-sizing:border-box !important;padding:0 !important;}',
    '.prompt-meta-row #label-pill{flex:0 0 auto !important;order:0 !important;}',
    /* folder renders in the SAME horizontal row, to the RIGHT of the label
       (Trent 2026-06-03: label + project-folder share one row, side-by-side —
       supersedes the 2026-06-02 stacked-column layout). order keeps it second
       even if a skin reordered the markup; it never grows the row past the
       available width. */
    '.prompt-meta-row #project-path{flex:0 1 auto !important;order:1 !important;',
    '  margin:0 !important;max-width:100% !important;}',
    '/* position variants — driven by body[data-cbe-label-pos] (CBE_LABEL_POS).',
    '   justify-content slides the whole [label][folder] row to the chosen edge. */',
    'body[data-cbe-label-pos="left"]   .prompt-meta-row{justify-content:flex-start !important;}',
    'body[data-cbe-label-pos="center"] .prompt-meta-row{justify-content:center !important;}',
    'body[data-cbe-label-pos="right"]  .prompt-meta-row{justify-content:flex-end !important;}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(st);
}

function applyLabelPos(skinBare) {
  try {
    ensurePromptRowSharedCss();
    if (!document.body) return;
    const id = String(skinBare || document.body.getAttribute('data-skin') || '').trim();
    document.body.setAttribute('data-cbe-label-pos',
                               CBE_LABEL_POS[id] || CBE_LABEL_POS_DEFAULT);
    syncThreadBottomPad();
  } catch (e) {
    console.warn('[CBE] label-pos apply failed:', e && e.message);
  }
}

/* Bug 1b (Trent 2026-06-04): every skin hard-codes `#thread { padding-bottom:
   420px }`, which leaves a big dead gap under the last message on any skin
   whose composer is shorter than 420px. Size the bottom padding to the ACTUAL
   composer height instead, and keep it in sync via a ResizeObserver (the
   textarea grows, attachments mount, the skin swaps). Inline padding-bottom
   (a longhand) beats each skin's `padding` shorthand in the cascade. */
let __cbeComposerRO = null;
function syncThreadBottomPad() {
  const t = document.getElementById('thread');
  const composer = document.querySelector('.prompt-area') || document.querySelector('.prompt-shell');
  if (!t || !composer) return;
  const h = composer.getBoundingClientRect().height;
  if (h > 0) t.style.paddingBottom = Math.round(h + 20) + 'px';
  if ('ResizeObserver' in window) {
    if (__cbeComposerRO) { try { __cbeComposerRO.disconnect(); } catch (_) {} }
    __cbeComposerRO = new ResizeObserver(() => {
      const tt = document.getElementById('thread');
      if (tt && composer.isConnected) {
        const hh = composer.getBoundingClientRect().height;
        if (hh > 0) tt.style.paddingBottom = Math.round(hh + 20) + 'px';
      }
    });
    try { __cbeComposerRO.observe(composer); } catch (_) {}
  }
}

/* Initial application — stampSkinBody fires on skin APPLY, but on first panel
   load the active skin's HTML is already mounted, so run once when the DOM is
   ready (data-skin is baked onto <body> by the skin / stamped by the host). */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyLabelPos());
} else {
  applyLabelPos();
}

/* Stamp the active skin id onto <body data-skin> so skin CSS can target
   skin-specific UI hooks (e.g. tamagotchi's body[data-skin="tamagotchi"]
   docks the pet panel into the prompt shell). Single-file skins (Phase 0/2)
   are their own full HTML, so this is the ONLY thing that has to fire on
   skin apply — there is no external <link> to swap anymore. */
function stampSkinBody(skinId) {
  try {
    /* __cbeActiveSkin may be a logical id ('tamagotchi') or, for legacy
       skins, a bare filename ('tamagotchi.css'). Strip any .css for the
       attribute value. */
    const bare = String(skinId || '').replace(/\.css$/i, '');
    if (bare) document.body.setAttribute('data-skin', bare);
    else      document.body.removeAttribute('data-skin');
    applyLabelPos(bare);   // re-apply the shared label position for this skin
  } catch (e) {
    console.warn('[CBE] data-skin stamp failed:', e && e.message);
  }
}

function applySkinUri(uri) {
  /* LEGACY CSS-overlay path only. Single-file skins (Phase 0/2) have no
     <link id="cbe-skin"> — it was removed from every .skin/index.html — so
     this early-returns for them. Kept for the bare `skins/<id>/` legacy
     dirs (D3 deferred) which still ship a styles.css the host links here.
     Also re-stamps <body data-skin> for parity. */
  stampSkinBody(__cbeActiveSkin);
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
        '<button type="button" class="cbe-x" data-act="cancel" aria-label="Close" style="color:var(--cbe-modal-title-fg);"></button>' +
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
          '<button type="button" class="cbe-x" data-act="cancel" aria-label="Close" style="color:var(--cbe-modal-title-fg);"></button>' +
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
          '<button type="button" class="cbe-x" data-act="cancel" aria-label="Close" style="color:var(--cbe-modal-title-fg);"></button>' +
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
        '<button type="button" class="cbe-x" data-act="cancel" aria-label="Close" style="color:var(--cbe-modal-title-fg);"></button>' +
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
        '<button type="button" class="cbe-x" data-act="close" aria-label="Close" style="color:var(--cbe-modal-title-fg);"></button>' +
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
        '<button type="button" class="cbe-x" data-act="close" aria-label="Close" style="color:#fff;"></button>' +
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

  /* ── 2026-05-25 settings-modal rebuild ──
     Previously the modal was built via innerHTML string concat, then the
     box/body/foot were grabbed via querySelector and styled. The inlined
     per-skin CSS (#cbe-settings .cbe-box { width:420px; overflow:hidden })
     was tied with inline-style on specificity AND something was making
     `.cbe-foot` extend past the box right edge in some skins.

     Fix: build the outer shell (box/hdr/body/foot) via createElement so
     parent/child relationships are explicit and impossible to mis-nest,
     and apply every layout style with setProperty(..., 'important') so
     stale per-skin CSS can't beat us. Body content is still set via
     innerHTML (it's all internal markup, the dangerous part is the
     box→body / box→foot relationship). */
  const box  = document.createElement('div'); box.className = 'cbe-box';
  const hdr  = document.createElement('div'); hdr.className = 'cbe-hdr';
  // Header stamp — if you don't see "[buildXXXX]" appended to the modal
  // title, the panel.js loaded by the webview isn't this one. The build
  // marker is just `Date.now() % 100000` so it changes on every webview
  // boot — different number each time you fully reload the panel.
  const _hdrStamp = '[build ' + (Date.now() % 100000) + ']';
  hdr.innerHTML =
      '<span>Settings — Provider &amp; Model ' + _hdrStamp + '</span>'
    + '<button type="button" class="cbe-btn cbe-cancel cbe-x-svg" data-act="cancel" aria-label="Close"></button>';
  /* ── 2026-05-26 category-nav rebuild ──────────────────────────────────────
     The flat 2-column scroll became crowded once voice controls landed, so
     the body is now a flex row: a LEFT vertical category list + a RIGHT
     scrollable pane. Clicking a category shows/hides the matching
     `.cbe-cat-pane` group. ALL existing controls are preserved verbatim —
     just regrouped under categories. The modal is self-contained: this
     <style> block (scoped to #cbe-settings) styles the nav so it looks
     identical across every skin and never collides with skins/ CSS. */
  const styleEl = document.createElement('style');
  styleEl.id = 'cbe-settings-catnav-style';
  styleEl.textContent =
      '#cbe-settings .cbe-catnav{display:flex;flex-direction:column;gap:2px;'
    + 'width:150px;min-width:150px;flex:0 0 150px;align-self:stretch;'
    + 'overflow-x:hidden;overflow-y:auto;padding-right:8px;border-right:1px solid var(--cbe-modal-border,#444);box-sizing:border-box;}'
    + '#cbe-settings .cbe-catnav-item{display:block;width:100%;text-align:left;'
    + 'padding:8px 10px;background:transparent;color:var(--cbe-modal-fg,#eee);'
    + 'border:1px solid transparent;border-radius:5px;cursor:pointer;font:inherit;'
    + 'font-size:13px;line-height:1.25;box-sizing:border-box;}'
    + '#cbe-settings .cbe-catnav-item:hover{background:rgba(255,255,255,.06);}'
    + '#cbe-settings .cbe-catnav-item.is-active{background:var(--cbe-modal-accent,#2a5d8f);'
    + 'color:#fff;border-color:var(--cbe-modal-accent,#2a5d8f);font-weight:600;}'
    + '#cbe-settings .cbe-catpane-wrap{flex:1 1 auto;min-width:0;overflow-x:hidden;overflow-y:auto;'
    + 'padding-left:16px;box-sizing:border-box;}'
    + '#cbe-settings .cbe-cat-pane{display:flex;flex-direction:column;gap:10px;min-width:0;}'
    + '#cbe-settings .cbe-cat-pane[hidden]{display:none;}'
    + '#cbe-settings .cbe-cat-title{font-weight:600;font-size:14px;margin:0 0 4px;opacity:.9;}'
    + '#cbe-settings .cbe-voice-sub{display:flex;flex-direction:column;gap:10px;'
    + 'margin-top:2px;padding:8px;border:1px solid var(--cbe-modal-border,#444);border-radius:5px;}'
    + '#cbe-settings .cbe-voice-sub[hidden]{display:none;}'
    + '#cbe-settings .cbe-stt-dict{width:100%;font:12px Consolas,monospace;'
    + 'background:#000;color:#dcdcdc;border:1px solid var(--cbe-modal-border,#444);'
    + 'border-radius:4px;padding:6px;box-sizing:border-box;resize:vertical;}'
    + '#cbe-settings .cbe-voice-text{width:100%;padding:6px 8px;background:var(--cbe-modal-bg,#1c1c1c);'
    + 'color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);'
    + 'border-radius:4px;font:inherit;box-sizing:border-box;}';
  const body = document.createElement('div'); body.className = 'cbe-body cbe-body--catnav';
  body.innerHTML = ''
    /* ── LEFT: category nav ───────────────────────────────────────────── */
    + '<div class="cbe-catnav" role="tablist" aria-label="Settings categories">'
    +   '<button type="button" class="cbe-catnav-item is-active" data-cat="provider" role="tab">Provider &amp; Model</button>'
    +   '<button type="button" class="cbe-catnav-item" data-cat="tts" role="tab">Read Aloud (TTS)</button>'
    +   '<button type="button" class="cbe-catnav-item" data-cat="stt" role="tab">Speech to Text</button>'
    +   '<button type="button" class="cbe-catnav-item" data-cat="appearance" role="tab">Appearance</button>'
    +   '<button type="button" class="cbe-catnav-item" data-cat="toolcalls" role="tab">Tool Calls</button>'
    +   '<button type="button" class="cbe-catnav-item" data-cat="operator" role="tab">Bridge Operator</button>'
    + '</div>'
    /* ── RIGHT: panes ─────────────────────────────────────────────────── */
    + '<div class="cbe-catpane-wrap">'
    /* — Provider & Model — */
    +   '<div class="cbe-cat-pane" data-cat="provider">'
    +     '<div class="cbe-cat-title">Provider &amp; Model</div>'
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
    +   '</div>'
    /* — Read Aloud (TTS) — */
    +   '<div class="cbe-cat-pane" data-cat="tts" hidden>'
    +     '<div class="cbe-cat-title">Read Aloud (Text-to-Speech)</div>'
    +     '<div><label for="cbe-set-tts-provider">TTS provider</label>'
    +       '<select id="cbe-set-tts-provider">'
    +         '<option value="webspeech">WebSpeech (keyless, browser-native)</option>'
    +         '<option value="elevenlabs">ElevenLabs (premium)</option>'
    +         '<option value="openai">OpenAI tts-1</option>'
    +       '</select>'
    +     '</div>'
    /*   webspeech sub-controls */
    +     '<div class="cbe-voice-sub" id="cbe-tts-sub-webspeech" hidden>'
    +       '<div><label for="cbe-tts-ws-voice">Voice</label>'
    +         '<select id="cbe-tts-ws-voice"><option value="">System default</option></select></div>'
    +       '<div><label for="cbe-tts-ws-rate">Rate <span id="cbe-tts-ws-rate-val" style="opacity:.65;font-weight:400;">1.0×</span></label>'
    +         '<input type="range" id="cbe-tts-ws-rate" min="0.1" max="3" step="0.1" value="1" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;"></div>'
    +       '<div><label for="cbe-tts-ws-volume">Volume <span id="cbe-tts-ws-volume-val" style="opacity:.65;font-weight:400;">100%</span></label>'
    +         '<input type="range" id="cbe-tts-ws-volume" min="0" max="100" step="1" value="100" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;"></div>'
    +     '</div>'
    /*   openai sub-controls */
    +     '<div class="cbe-voice-sub" id="cbe-tts-sub-openai" hidden>'
    +       '<div><label for="cbe-tts-oa-apikey">OpenAI API key</label>'
    +         '<div style="display:flex;gap:6px;">'
    +           '<input type="password" id="cbe-tts-oa-apikey" class="cbe-voice-text" spellcheck="false" autocomplete="off" placeholder="sk-proj-... from platform.openai.com" style="flex:1;">'
    +           '<button type="button" id="cbe-tts-oa-apikey-save" class="cbe-key-save-btn" style="padding:6px 12px;background:var(--cbe-modal-accent,#2a5d8f);color:#fff;border:1px solid var(--cbe-modal-accent,#2a5d8f);border-radius:4px;cursor:pointer;font:inherit;">Save</button>'
    +         '</div></div>'
    +       '<div><label for="cbe-tts-oa-voice">Voice</label>'
    +         '<select id="cbe-tts-oa-voice">'
    +           '<option value="alloy">alloy</option><option value="echo">echo</option>'
    +           '<option value="fable">fable</option><option value="onyx">onyx</option>'
    +           '<option value="nova">nova</option><option value="shimmer">shimmer</option>'
    +           '<option value="ash">ash</option><option value="sage">sage</option>'
    +           '<option value="coral">coral</option>'
    +         '</select></div>'
    +       '<div><label for="cbe-tts-oa-speed">Speed <span id="cbe-tts-oa-speed-val" style="opacity:.65;font-weight:400;">1.0×</span></label>'
    +         '<input type="range" id="cbe-tts-oa-speed" min="0.25" max="4" step="0.05" value="1" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;"></div>'
    +     '</div>'
    /*   elevenlabs sub-controls */
    +     '<div class="cbe-voice-sub" id="cbe-tts-sub-elevenlabs" hidden>'
    +       '<div><label for="cbe-tts-el-apikey">ElevenLabs API key</label>'
    +         '<div style="display:flex;gap:6px;">'
    +           '<input type="password" id="cbe-tts-el-apikey" class="cbe-voice-text" spellcheck="false" autocomplete="off" placeholder="paste from elevenlabs.io/app/settings" style="flex:1;">'
    +           '<button type="button" id="cbe-tts-el-apikey-save" class="cbe-key-save-btn" style="padding:6px 12px;background:var(--cbe-modal-accent,#2a5d8f);color:#fff;border:1px solid var(--cbe-modal-accent,#2a5d8f);border-radius:4px;cursor:pointer;font:inherit;">Save</button>'
    +         '</div></div>'
    +       '<div><label for="cbe-tts-el-voice">Voice</label>'
    +         '<select id="cbe-tts-el-voice-select" class="cbe-voice-text" style="margin-bottom:4px;"><option value="">(enter API key + click Refresh)</option></select>'
    +         '<div style="display:flex;gap:6px;align-items:center;">'
    +           '<input type="text" id="cbe-tts-el-voice" class="cbe-voice-text" spellcheck="false" placeholder="or paste a custom voice ID" style="flex:1;">'
    +           '<button type="button" id="cbe-tts-el-voice-refresh" style="padding:6px 12px;background:rgba(255,255,255,.05);color:inherit;border:1px solid var(--cbe-modal-border,#444);border-radius:4px;cursor:pointer;font:inherit;">Refresh list</button>'
    +         '</div></div>'
    +       '<div style="display:flex;gap:10px;">'
    +         '<div style="flex:1;"><label for="cbe-tts-el-stability">Stability <span id="cbe-tts-el-stability-val" style="opacity:.65;font-weight:400;">0.50</span></label>'
    +           '<input type="range" id="cbe-tts-el-stability" min="0" max="1" step="0.05" value="0.5" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;"></div>'
    +         '<div style="flex:1;"><label for="cbe-tts-el-similarity">Similarity <span id="cbe-tts-el-similarity-val" style="opacity:.65;font-weight:400;">0.75</span></label>'
    +           '<input type="range" id="cbe-tts-el-similarity" min="0" max="1" step="0.05" value="0.75" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;"></div>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    /* — Speech to Text (STT) — */
    +   '<div class="cbe-cat-pane" data-cat="stt" hidden>'
    +     '<div class="cbe-cat-title">Speech to Text (Dictation)</div>'
    +     '<div><label for="cbe-set-stt-provider">STT provider</label>'
    +       '<select id="cbe-set-stt-provider">'
    /* WebSpeech intentionally omitted — Electron blocks SpeechRecognition
       inside the VSCode webview sandbox so it can't actually work here.
       2026-05-29. Stored value remains valid for back-compat (auto-promoted
       to elevenlabs at click time + in getVoiceProvider on the host).
       whisper-local (batch HTTP server) removed 2026-05-30 — replaced by
       the two realtime local providers below. */
    +         '<option value="elevenlabs" title="Cloud, lowest latency. Needs [elevenlabs] api_key in config.ini.">ElevenLabs Scribe v2 (cloud, streaming)</option>'
    +         '<option value="faster-whisper-stream" title="Local realtime speech-to-text (faster-whisper / CTranslate2 + webrtcvad sliding window). Keyless. ~150MB one-time venv bootstrap. Windows-first.">Whisper (local, realtime)</option>'
    +         '<option value="openai" title="Cloud streaming via OpenAI Realtime API. Needs openai_api_key.">OpenAI Whisper (cloud, batch/streaming)</option>'
    +         '<option value="anthropic" title="Cloud streaming via Anthropic’s Deepgram Nova-3 proxy. Auth via your Claude Code login — no separate key.">Anthropic Claude (cloud, streaming)</option>'
    +         '<option value="deepgram" title="Cloud streaming via Deepgram Nova-3. Needs [deepgram] api_key in config.ini.">Deepgram (cloud, streaming)</option>'
    +       '</select>'
    +     '</div>'
    /*   Per-provider API key (shown only when the selected STT provider needs
         one — keyless providers like webspeech / whisper-cpp-stream /
         faster-whisper-stream / anthropic-OAuth hide this row). Save writes
         to config.ini under the right [section] via the host. */
    +     '<div id="cbe-stt-key-row" hidden>'
    +       '<label for="cbe-stt-apikey"><span id="cbe-stt-apikey-label">API key</span></label>'
    +       '<div style="display:flex;gap:6px;">'
    +         '<input type="password" id="cbe-stt-apikey" class="cbe-voice-text" spellcheck="false" autocomplete="off" placeholder="" style="flex:1;">'
    +         '<button type="button" id="cbe-stt-apikey-save" class="cbe-key-save-btn" style="padding:6px 12px;background:var(--cbe-modal-accent,#2a5d8f);color:#fff;border:1px solid var(--cbe-modal-accent,#2a5d8f);border-radius:4px;cursor:pointer;font:inherit;">Save</button>'
    +       '</div>'
    +       '<div id="cbe-stt-apikey-hint" style="opacity:.6;font-size:11px;margin-top:3px;"></div>'
    +     '</div>'
    +     '<div><label for="cbe-stt-language">Language <span style="opacity:.55;font-weight:400;font-size:.85em;">(BCP-47, e.g. en, en-US, fr)</span></label>'
    +       '<input type="text" id="cbe-stt-language" class="cbe-voice-text" spellcheck="false" placeholder="auto / en-US"></div>'
    +     '<div id="cbe-stt-dict-wrap">'
    +       '<label for="cbe-stt-dictionary" id="cbe-stt-dict-label">Custom dictionary / vocabulary</label>'
    +       '<div id="cbe-stt-dict-hint" style="opacity:.6;font-size:12px;margin:0 0 4px;">Comma- or newline-separated terms to bias transcription (names, jargon, acronyms).</div>'
    +       '<textarea id="cbe-stt-dictionary" rows="5" spellcheck="false" class="cbe-stt-dict"></textarea>'
    +     '</div>'
    +   '</div>'
    /* — Appearance — */
    +   '<div class="cbe-cat-pane" data-cat="appearance" hidden>'
    +     '<div class="cbe-cat-title">Appearance</div>'
    +     '<div><label>Skin</label>'
    +       '<div style="display:flex;gap:8px;align-items:center;">'
    +         '<select id="cbe-set-skin" style="flex:1;"><option value="">Loading skins…</option></select>'
    +         '<button type="button" id="cbe-skin-edit-btn" class="cbe-btn" style="padding:6px 12px;font-size:12px;white-space:nowrap;">Edit Skin</button>'
    +       '</div>'
    +     '</div>'
    /* The skin editor itself now opens in a dedicated full-size MODAL
       (#cbe-skin-editor-modal, built by openSkinEditor) instead of a cramped
       inline sub-panel — the Appearance pane had no room for a real editor.
       The "Edit Skin" button above opens that modal. Contract msg names match
       SKIN_EDITOR_SPRINT verbatim: getSkinSource / saveSkin / saveSkinAsNew /
       restoreSkinOriginal. */
    +     '<div><label>Language</label><div id="cbe-set-language-wrap" style="position:relative;"></div></div>'
    +     '<div style="display:flex;align-items:center;gap:10px;margin-top:4px;">'
    +       '<label for="cbe-set-sfx-enabled" style="margin:0;flex:1;">Sound Effects</label>'
    +       '<input type="checkbox" id="cbe-set-sfx-enabled" style="width:auto;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +     '<div>'
    +       '<label for="cbe-set-sfx-volume">Volume <span id="cbe-set-sfx-volume-pct" style="opacity:.65;font-weight:400;">55%</span></label>'
    +       '<input type="range" id="cbe-set-sfx-volume" min="0" max="100" step="1" value="55" style="width:100%;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +     '<div style="display:flex;align-items:center;gap:10px;margin-top:4px;">'
    +       '<label for="cbe-set-bigfont" style="margin:0;flex:1;">Large font</label>'
    +       '<input type="checkbox" id="cbe-set-bigfont" style="width:auto;accent-color:var(--cbe-modal-accent);cursor:pointer;">'
    +     '</div>'
    +   '</div>'
    /* — Tool Calls — */
    +   '<div class="cbe-cat-pane" data-cat="toolcalls" hidden>'
    +     '<div class="cbe-cat-title">Tool Calls (bridge daisy-chain)</div>'
    +     '<div id="cbe-tc-section">'
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
    /* — Bridge Operator — */
    +   '<div class="cbe-cat-pane" data-cat="operator" hidden>'
    +     '<div class="cbe-cat-title">Bridge Operator (vision pilot)</div>'
    +     '<div style="opacity:.65;font-size:12px;margin:0 0 6px;">The LLM that drives the browser bridges (chatgpt / grok / gemini / claude / copilot / deepseek) by reading screenshots of the offscreen Chromium and emitting click/type actions. Default is Azure.</div>'
    +     '<div><label for="cbe-op-provider">Provider</label>'
    +       '<select id="cbe-op-provider">'
    +         '<option value="azure">Azure OpenAI (default)</option>'
    +         '<option value="openai">OpenAI</option>'
    +         '<option value="anthropic">Anthropic</option>'
    +         '<option value="gemini">Google (Gemini API key)</option>'
    +         '<option value="vertex">Google Vertex (Cloud / ADC)</option>'
    +       '</select>'
    +     '</div>'
    +     '<div><label for="cbe-op-model"><span id="cbe-op-model-label">Deployment</span></label>'
    +       '<div style="display:flex;gap:6px;align-items:center;">'
    +         '<select id="cbe-op-model" style="flex:1;"><option value="">(click Load)</option></select>'
    +         '<button type="button" id="cbe-op-load" class="cbe-btn" style="padding:6px 12px;font-size:12px;white-space:nowrap;">Load</button>'
    +       '</div>'
    +     '</div>'
    +     '<div id="cbe-op-status" style="opacity:.7;font-size:12px;margin-top:4px;"></div>'
    +   '</div>'
    + '</div>';
  const foot      = document.createElement('div'); foot.className = 'cbe-foot';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'cbe-btn cbe-cancel';
  cancelBtn.setAttribute('data-act', 'cancel');
  cancelBtn.textContent = 'Cancel';
  const applyBtn  = document.createElement('button');
  applyBtn.type = 'button'; applyBtn.className = 'cbe-btn cbe-save';
  applyBtn.setAttribute('data-act', 'apply');
  // Label comes from the localization table now — user can rename in
  // C:/Users/moren/Desktop/Codex Black/languages/en.xml under
  // <s id="label.apply">…</s>. If they change it to "FOO" and reopen
  // settings, my button will say "FOO" — proving this createElement path
  // IS what's rendering. If they change it and my button still says
  // "Apply", a different button is stacked on top of mine.
  applyBtn.textContent = cbeT('label.apply', 'Apply');
  applyBtn.setAttribute('data-i18n', 'label.apply'); // applyStrings() will re-localize on language change
  applyBtn.style.setProperty('cursor', 'pointer', 'important');
  applyBtn.style.setProperty('pointer-events', 'auto', 'important');
  cancelBtn.style.setProperty('cursor', 'pointer', 'important');
  cancelBtn.style.setProperty('pointer-events', 'auto', 'important');
  // Always-on data stamps — invisible, but lets DevTools `document.querySelector(
  // '[data-cbe-built-by]')` identify which Apply is ours WITHOUT visual noise.
  applyBtn.setAttribute('data-cbe-built-by', 'openSettings-createElement-2026-05-25');
  cancelBtn.setAttribute('data-cbe-built-by', 'openSettings-createElement-2026-05-25');

  // Debug mode — opt-in via localStorage.setItem('cbe_debug','1'). Adds
  // a duplicate-Apply DOM scan + elementFromPoint check at modal mount,
  // useful if Apply ever silent-fails again. No visible UI changes.
  let CBE_DEBUG = false;
  try { CBE_DEBUG = localStorage.getItem('cbe_debug') === '1'; } catch (_) {}
  foot.appendChild(cancelBtn);
  foot.appendChild(applyBtn);
  box.appendChild(styleEl);
  box.appendChild(hdr);
  box.appendChild(body);
  box.appendChild(foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  /* Three-belt strategy because the click WAS silent-failing through plain
     addEventListener: (1) inline `onclick` attribute via .onclick property —
     survives ANY ancestor `parent.innerHTML = ...` rebuild because it's a
     DOM attribute, not a listener (addEventListener listeners die when the
     node is replaced; .onclick survives outerHTML serialization).
     (2) addEventListener click — normal path for normal cases.
     (3) document-level CAPTURE-PHASE listener — fires BEFORE any ancestor
     can stopPropagation; catches even clicks aimed at other Apply buttons
     stacked over ours by closest('[data-cbe-built-by="openSettings-...]').
     Plus: we expose `window._cbeForceApply` so the user can paste-call it
     from DevTools directly if all three of the above somehow fail. And we
     ditched alert() because VSCode webviews routinely suppress it — we
     flash the button background lime-green for 400ms instead, which is
     impossible to suppress at any layer. */
  function _cbeFlashApply(color) {
    try {
      const prevBg = applyBtn.style.backgroundColor;
      applyBtn.style.setProperty('background-color', color || '#00ff66', 'important');
      setTimeout(() => { applyBtn.style.backgroundColor = prevBg; }, 400);
    } catch (_) {}
  }
  function _cbeApplyClick(e, source) {
    if (e) { try { e.stopPropagation(); e.preventDefault(); } catch (_) {} }
    console.log('[CBE] Apply clicked via', source, 'at', new Date().toISOString());
    // Mirror to extension debug.log so trace is visible WITHOUT needing
    // webview DevTools open. Shows as `recv {"type":"_cbeDbg",...}` line.
    if (api) try { api.postMessage({ type: '_cbeDbg__apply-handler-' + source, tag: 'apply-handler', source }); } catch (_) {}
    _cbeFlashApply('#00ff66');
    try { _cbeDoApply(); }
    catch (err) {
      console.error('[CBE] _cbeDoApply threw', err);
      const msg = String((err && err.message) || err || 'unknown').replace(/[^a-zA-Z0-9 .:_-]/g, '_').slice(0, 200);
      const stk = String((err && err.stack) || '').replace(/[^a-zA-Z0-9 .:_-]/g, '_').slice(0, 200);
      if (api) try { api.postMessage({ type: '_cbeDbg__apply-handler-THREW__msg=' + msg, tag: 'apply-handler-threw', err: String(err && err.message || err), stack: String(err && err.stack || '') }); } catch (_) {}
      if (api) try { api.postMessage({ type: '_cbeDbg__apply-handler-THREW-STACK=' + stk }); } catch (_) {}
    }
  }
  function _cbeCancelClick(e, source) {
    if (e) { try { e.stopPropagation(); e.preventDefault(); } catch (_) {} }
    console.log('[CBE] Cancel clicked via', source, 'at', new Date().toISOString());
    if (api) try { api.postMessage({ type: '_cbeDbg__cancel-handler-' + source, tag: 'cancel-handler', source }); } catch (_) {}
    _cbeFlashApply('#ff8800');
    try { _cbeDoCancel(); }
    catch (err) { console.error('[CBE] _cbeDoCancel threw', err); }
  }
  applyBtn.onclick  = (e) => _cbeApplyClick(e, 'onclick-attr');
  cancelBtn.onclick = (e) => _cbeCancelClick(e, 'onclick-attr');
  applyBtn.addEventListener('click',     (e) => _cbeApplyClick(e, 'addEL-click'));
  applyBtn.addEventListener('mousedown', (e) => _cbeApplyClick(e, 'addEL-mousedown'));
  cancelBtn.addEventListener('click',    (e) => _cbeCancelClick(e, 'addEL-click'));
  /* Capture-phase document listener — catches Apply clicks anywhere within
     our overlay even if a sibling/cover element is intercepting them. We
     scope to our overlay so we don't hijack Apply buttons in unrelated
     modals. */
  function _cbeDocCapture(e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      if (!overlay.contains(t)) return;
      const btn = t.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'apply') {
        e.stopPropagation(); e.preventDefault();
        _cbeApplyClick(null, 'document-capture');
      } else if (act === 'cancel') {
        e.stopPropagation(); e.preventDefault();
        _cbeCancelClick(null, 'document-capture');
      }
    } catch (err) { console.error('[CBE] doc-capture handler threw', err); }
  }
  document.addEventListener('click', _cbeDocCapture, true);
  document.addEventListener('mousedown', _cbeDocCapture, true);
  /* ---- SCORCHED-EARTH DIAGNOSTIC ----
     Body-level capture listener that fires on ANY click anywhere on the
     page. Mirrors EVERY click to extension debug.log via _cbeDbg postMsg,
     so we can tell whether clicks are reaching the document at all, where
     they land, and whether overlay.contains(target) returns true. If clicks
     are silent here too, the click event never reaches the webview — that
     would be a webview focus/keyboard-shortcut absorbing the click. */
  function _cbeAnyClickProbe(e) {
    try {
      const t = e.target;
      const r = (t && t.getBoundingClientRect) ? t.getBoundingClientRect() : null;
      const inOverlay = !!(t && overlay && overlay.contains && overlay.contains(t));
      const closestBtn = t && t.closest ? t.closest('button') : null;
      const dataAct = closestBtn ? closestBtn.getAttribute('data-act') : null;
      const tagId = t ? `${t.tagName}#${t.id || '(no-id)'}.${(t.className && t.className.toString ? t.className.toString() : '(no-class)').slice(0, 80)}` : '(no-target)';
      if (api) api.postMessage({
        type: '_cbeDbg__any-click-probe',
        tag: 'any-click-probe',
        evt: e.type,
        target: tagId,
        rect: r ? { x: r.left|0, y: r.top|0, w: r.width|0, h: r.height|0 } : null,
        inOverlay,
        closestBtnDataAct: dataAct,
      });
    } catch (err) { /* swallow */ }
  }
  document.body.addEventListener('click',     _cbeAnyClickProbe, true);
  document.body.addEventListener('mousedown', _cbeAnyClickProbe, true);
  /* ---- POINTER-EVENTS ANCESTOR WALK ----
     The MOST LIKELY remaining cause: an ancestor of applyBtn has
     `pointer-events: none` baked into a skin's CSS, killing all clicks
     before they reach the button. We walk up from applyBtn to document.body
     and log each ancestor's COMPUTED pointer-events. If anyone returns
     "none", that's the bug. Runs 500ms after mount so any async skin CSS
     load finishes first. */
  setTimeout(() => {
    try {
      const chain = [];
      let node = applyBtn;
      while (node && node !== document.body) {
        const cs = window.getComputedStyle(node);
        chain.push({
          tag: node.tagName,
          id: node.id || '(no-id)',
          cls: (node.className && node.className.toString ? node.className.toString().slice(0, 60) : ''),
          pointerEvents: cs.pointerEvents,
          opacity: cs.opacity,
          visibility: cs.visibility,
          display: cs.display,
          zIndex: cs.zIndex,
        });
        node = node.parentNode;
      }
      console.log('[CBE] Apply ancestor pointer-events chain:', chain);
      // Also encode which ancestors have pointer-events:none into the type
      // so it's visible in debug.log without payload parsing.
      const peNone = chain.filter(c => c.pointerEvents === 'none').map(c => `${c.tag}#${c.id}`).join(',') || 'none-found';
      if (api) api.postMessage({ type: '_cbeDbg__apply-ancestor-walk__pe-none=' + peNone, tag: 'apply-ancestor-walk', chain });
      // Also log what's at the center of applyBtn — confirms there's no
      // invisible overlay we missed.
      const r = applyBtn.getBoundingClientRect();
      const elAt = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const elTag = elAt ? `${elAt.tagName}#${elAt.id || '(no-id)'}.${(elAt.className && elAt.className.toString ? elAt.className.toString() : '').slice(0, 60)}` : '(null)';
      if (api) api.postMessage({
        type: '_cbeDbg__elFromPoint__isOurs=' + (elAt === applyBtn) + '__el=' + elTag.replace(/[^a-zA-Z0-9._#-]/g, '_').slice(0, 80),
        tag: 'apply-element-from-point',
        elAt: elTag,
        isOurApplyBtn: elAt === applyBtn,
        rect: { x: r.left|0, y: r.top|0, w: r.width|0, h: r.height|0 },
      });
    } catch (err) { console.error('[CBE] ancestor walk threw', err); }
  }, 500);
  /* Manual escape hatch: user can run `_cbeForceApply()` in DevTools if all
     three click paths fail. Also exposes _cbeDoApply for direct invocation. */
  try {
    window._cbeForceApply  = () => _cbeApplyClick(null, 'window._cbeForceApply');
    window._cbeForceCancel = () => _cbeCancelClick(null, 'window._cbeForceCancel');
    window._cbeDoApply     = _cbeDoApply;
    console.log('[CBE] window._cbeForceApply() and window._cbeDoApply() now callable from DevTools');
  } catch (_) {}

  // Diagnostic — only runs when CBE_DEBUG is on. Scans document for any
  // OTHER Apply/Save buttons + reports which one is on top of ours.
  if (CBE_DEBUG) {
    setTimeout(() => {
      try {
        const allApply = Array.from(document.querySelectorAll('button')).filter(b =>
          (b.textContent || '').trim().toLowerCase() === 'apply' ||
          b.getAttribute('data-act') === 'apply' ||
          b.getAttribute('data-act') === 'save'
        );
        console.log('[CBE] DUPLICATE-APPLY scan: found', allApply.length, 'apply-ish buttons:');
        allApply.forEach((b, i) => {
          const r = b.getBoundingClientRect();
          console.log(`  #${i}`, {
            text: (b.textContent || '').trim(),
            dataAct: b.getAttribute('data-act'),
            dataCbeBuiltBy: b.getAttribute('data-cbe-built-by') || '(none)',
            isOurs: b === applyBtn,
            visible: r.width > 0 && r.height > 0,
            rect: r,
            modal: (b.closest('[id*="settings"], [id*="cbe-"]') || {}).id || '(no #cbe- ancestor)',
          });
        });
        const r = applyBtn.getBoundingClientRect();
        const elAt = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        console.log('[CBE] elementFromPoint(over our Apply):', elAt, 'IS ours?', elAt === applyBtn);
      } catch (err) { console.error('[CBE] debug-scan threw', err); }
    }, 300);
  }

  /* Restore persisted size. Default 720×auto; min 560×360; max 95vw×88vh. */
  let savedW = 720, savedH = null;
  try {
    const raw = localStorage.getItem('cbe-settings-size');
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Number.isFinite(o.w) && o.w >= 400) savedW = o.w;
      if (o && Number.isFinite(o.h) && o.h >= 300) savedH = o.h;
    }
  } catch (_) { /* ignore parse */ }

  /* setProperty(..., 'important') beats inline-styled selectors (#id .class)
     in every per-skin index.html, including any `width:420px` legacy rule. */
  box.style.setProperty('display',         'flex',          'important');
  box.style.setProperty('flex-direction',  'column',        'important');
  box.style.setProperty('width',           savedW + 'px',   'important');
  box.style.setProperty('min-width',       '560px',         'important');
  box.style.setProperty('max-width',       '95vw',          'important');
  if (savedH) box.style.setProperty('height', savedH + 'px', 'important');
  else        box.style.setProperty('height', 'auto',        'important');
  box.style.setProperty('min-height',      '360px',         'important');
  box.style.setProperty('max-height',      '88vh',          'important');
  box.style.setProperty('resize',          'both',          'important');
  box.style.setProperty('overflow',        'hidden',        'important');
  box.style.setProperty('box-sizing',      'border-box',    'important');

  /* Category-nav layout: a flex ROW (left nav + right pane). The body itself
     no longer scrolls — the right pane (.cbe-catpane-wrap) does — so the nav
     stays pinned while values scroll. */
  body.style.setProperty('display',              'flex',                'important');
  body.style.setProperty('flex-direction',       'row',                 'important');
  body.style.setProperty('align-items',          'stretch',             'important');
  body.style.setProperty('gap',                  '0',                   'important');
  body.style.setProperty('flex',                 '1 1 auto',            'important');
  body.style.setProperty('overflow',             'hidden',              'important');
  body.style.setProperty('min-height',           '0',                   'important');
  body.style.setProperty('min-width',            '0',                   'important');
  body.style.setProperty('width',                '100%',                'important');
  body.style.setProperty('box-sizing',           'border-box',          'important');

  foot.style.setProperty('flex',                 '0 0 auto',            'important');
  foot.style.setProperty('display',              'flex',                'important');
  foot.style.setProperty('justify-content',      'flex-end',            'important');
  foot.style.setProperty('gap',                  '8px',                 'important');
  foot.style.setProperty('width',                '100%',                'important');
  foot.style.setProperty('box-sizing',           'border-box',          'important');
  foot.style.setProperty('overflow',             'hidden',              'important');

  /* Debounced save on resize end. */
  if (typeof ResizeObserver !== 'undefined') {
    let saveTimer = null;
    const ro = new ResizeObserver(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem('cbe-settings-size', JSON.stringify({
            w: box.offsetWidth, h: box.offsetHeight,
          }));
        } catch (_) { /* ignore quota */ }
      }, 300);
    });
    ro.observe(box);
    /* Stop observing when the modal closes so we don't leak. */
    overlay.__cbeResizeObserver = ro;
  }

  /* Verification log — confirms structure is right and foot is inside box. */
  try {
    /* defer one frame so layout has settled */
    requestAnimationFrame(() => {
      console.log('CBE settings modal ready',
        box.getBoundingClientRect(),
        foot.getBoundingClientRect(),
        foot.parentElement === box);
    });
  } catch (_) { /* ignore */ }

  const sel = overlay.querySelector('#cbe-set-provider');
  __cbeProviders.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    let suffix = '';
    if (p.cliAgent) suffix = '  (logged in)';
    else if (p.local) suffix = '  (local)';
    else if (p.bridge) suffix = '  (bridge)';
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
    /* Bridge providers (chatgptBridge/grokBridge/...) have no API key — auth
       lives in the tray exe's QtWebEngine profile. Ollama (prov.local) is a
       local daemon with no auth at all. Suppress the no-key warning for both. */
    const warn = overlay.querySelector('#cbe-set-warn');
    /* cliAgent (logged-in Claude Code) authenticates via the Claude Code
       OAuth login — like bridges, it has no API key to warn about. */
    if (prov.bridge || prov.cliAgent || prov.local) {
      warn.classList.remove('show');
      ms.disabled = false;
    } else {
      ms.disabled = false;
      warn.classList.toggle('show', !prov.haveKey);
    }
    /* Refresh the multi-account section for the newly-selected provider.
       Hidden entirely for bridge + cliAgent + local (Ollama) providers — none
       of them have API keys / accounts to manage. */
    const acctWrap = overlay.querySelector('#cbe-accounts-wrap');
    if (acctWrap) {
      acctWrap.style.display = (prov.bridge || prov.cliAgent || prov.local) ? 'none' : '';
      if (!prov.bridge && !prov.cliAgent && !prov.local) {
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
  let __cbeSavedSkinAtOpen = __cbeActiveSkin;   // reassigned by _cbeDoApply when user applies a new skin (was `const`, threw TypeError on click)
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
    /* The editor is pinned to a specific skin id; switching skins invalidates
       its contents, so collapse it. User re-clicks "Edit Skin" for the new one. */
    closeSkinEditor();
  });

  /* ── Skin editor (Phase 4 — dedicated modal) ────────────────────────────
     "Edit Skin" now opens a dedicated, large MODAL (#cbe-skin-editor-modal,
     built by openSkinEditor) overlaying Settings. It has a near-full-height
     monospace <textarea>, a dirty-guard on close, and a validated Save-as-New
     name flow. The host replies (skinSource / skinSaved / skinSavedAsNew /
     skinRestored) are handled in the global message listener, which calls back
     into the helpers via the module-level __cbeSkinEditor state. All four
     outbound message names match the FIXED contract in SKIN_EDITOR_SPRINT
     verbatim. All Save / Save as New / Restore / Close buttons live INSIDE the
     modal now and are wired in openSkinEditor(). */
  const editBtn = overlay.querySelector('#cbe-skin-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    const sel = overlay.querySelector('#cbe-set-skin');
    const id = (sel && sel.value) || '';
    openSkinEditor(id);
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

  /* Bridge-operator settings — hydrate from payload.bridgeOperator. The model
     dropdown is populated on demand via the host's listOperatorModels message
     (the panel can't call provider APIs directly under CSP). The currently
     saved model is shown as a placeholder option until the user clicks Load. */
  const opProvSel  = overlay.querySelector('#cbe-op-provider');
  const opModelSel = overlay.querySelector('#cbe-op-model');
  const opModelLbl = overlay.querySelector('#cbe-op-model-label');
  const opLoadBtn  = overlay.querySelector('#cbe-op-load');
  const opStatus   = overlay.querySelector('#cbe-op-status');
  const __opCfg = (payload && payload.bridgeOperator) || { provider: 'azure' };
  const opSavedModel = {
    azure:     __opCfg.azureDeployment || '',
    openai:    __opCfg.openaiModel || '',
    anthropic: __opCfg.anthropicModel || '',
    gemini:    __opCfg.geminiModel || '',
    vertex:    __opCfg.vertexModel || '',
  };
  function opModelLabelFor(p) { return p === 'azure' ? 'Deployment' : 'Model'; }
  function opShowSavedModel(p) {
    /* Reset the dropdown to just the saved value until the user loads the
       live list. Keeps the persisted choice visible without a network call. */
    if (!opModelSel) return;
    const saved = opSavedModel[p] || '';
    opModelSel.innerHTML = '';
    const o = document.createElement('option');
    o.value = saved; o.textContent = saved || '(click Load to fetch models)';
    opModelSel.appendChild(o);
    opModelSel.value = saved;
  }
  if (opProvSel) {
    opProvSel.value = ['azure','openai','anthropic','gemini','vertex'].includes(__opCfg.provider) ? __opCfg.provider : 'azure';
    if (opModelLbl) opModelLbl.textContent = opModelLabelFor(opProvSel.value);
    opShowSavedModel(opProvSel.value);
    opProvSel.addEventListener('change', () => {
      if (opModelLbl) opModelLbl.textContent = opModelLabelFor(opProvSel.value);
      opShowSavedModel(opProvSel.value);
      if (opStatus) opStatus.textContent = '';
      playSfx('click');
    });
  }
  /* Load button — ask the host to list models/deployments for the selected
     provider. Result arrives via the global 'operatorModelsResult' message
     handler (registered at module scope) which calls window.__cbeOpFillModels. */
  window.__cbeOpFillModels = function (res) {
    if (!opModelSel || !opStatus) return;
    if (!res || !res.ok) {
      opStatus.textContent = 'Load failed: ' + ((res && res.error) || 'unknown error');
      return;
    }
    const saved = opSavedModel[res.provider] || '';
    const models = Array.isArray(res.models) ? res.models : [];
    opModelSel.innerHTML = '';
    if (!models.length) {
      const o = document.createElement('option'); o.value = saved; o.textContent = saved || '(none)';
      opModelSel.appendChild(o);
    } else {
      models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.detail ? (m.id + '  —  ' + m.detail) : m.id;
        opModelSel.appendChild(o);
      });
      /* keep the saved value selected if it's still in the list */
      if (saved && models.some(m => m.id === saved)) opModelSel.value = saved;
    }
    opStatus.textContent = `Loaded ${models.length} ${res.provider === 'azure' ? 'deployment' : 'model'}${models.length === 1 ? '' : 's'}.`;
  };
  if (opLoadBtn) {
    opLoadBtn.addEventListener('click', () => {
      const p = (opProvSel && opProvSel.value) || 'azure';
      if (opStatus) opStatus.textContent = 'Loading…';
      if (api) { try { api.postMessage({ type: 'listOperatorModels', provider: p }); } catch (_) {} }
      playSfx('click');
    });
  }

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

  /* Large-font checkbox — mirrors the toolbar #fontSizeBtn. Reads/writes the
     same `.cb-big` body class + `setBigFont` host message so the two stay in
     sync. Applied live on toggle; persisted host-side immediately (same path
     the toolbar button uses) so no extra Apply plumbing is needed. */
  const bigFontChk = overlay.querySelector('#cbe-set-bigfont');
  if (bigFontChk) {
    bigFontChk.checked = document.body.classList.contains('cb-big');
    bigFontChk.addEventListener('change', () => {
      const next = !!bigFontChk.checked;
      if (window.__cbApplyBig) window.__cbApplyBig(next);
      else document.body.classList.toggle('cb-big', next);
      if (api) api.postMessage({ type: 'setBigFont', value: next });
    });
  }

  /* ── Category-nav switching ──────────────────────────────────────────────
     Clicking a left-nav item shows the matching right pane and highlights the
     button. Default-selected = the first category (Provider & Model). */
  const catItems = Array.from(overlay.querySelectorAll('.cbe-catnav-item'));
  const catPanes = Array.from(overlay.querySelectorAll('.cbe-cat-pane'));
  function selectCategory(cat) {
    catItems.forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-cat') === cat));
    catPanes.forEach((p) => { p.hidden = (p.getAttribute('data-cat') !== cat); });
    /* Scroll the right pane back to top on a category switch. */
    const wrap = overlay.querySelector('.cbe-catpane-wrap');
    if (wrap) wrap.scrollTop = 0;
  }
  catItems.forEach((b) => b.addEventListener('click', () => {
    selectCategory(b.getAttribute('data-cat'));
    playSfx('click');
  }));
  selectCategory('provider');   /* default category */

  /* ── Voice (TTS / STT) controls ──────────────────────────────────────────
     Hydrate from payload.ttsProvider/sttProvider + the saved per-provider
     values (ttsVoice/ttsRate/ttsVolume, sttDictionary/sttLanguage). The
     TTS-provider dropdown shows/hides the matching sub-control group. Webspeech
     TTS settings apply LIVE panel-side (window.__cbeTts*) so the next read-aloud
     respects them even before Apply; remote-provider settings travel with the
     ttsRequest at speak time. Persistence fires on Apply (see _cbeDoApply). */
  const ttsProvSel  = overlay.querySelector('#cbe-set-tts-provider');
  const sttProvSel  = overlay.querySelector('#cbe-set-stt-provider');
  const ttsSubs = {
    webspeech:  overlay.querySelector('#cbe-tts-sub-webspeech'),
    openai:     overlay.querySelector('#cbe-tts-sub-openai'),
    elevenlabs: overlay.querySelector('#cbe-tts-sub-elevenlabs'),
  };
  /* webspeech sub-controls */
  const wsVoiceSel = overlay.querySelector('#cbe-tts-ws-voice');
  const wsRate     = overlay.querySelector('#cbe-tts-ws-rate');
  const wsRateVal  = overlay.querySelector('#cbe-tts-ws-rate-val');
  const wsVolume   = overlay.querySelector('#cbe-tts-ws-volume');
  const wsVolVal   = overlay.querySelector('#cbe-tts-ws-volume-val');
  /* openai sub-controls */
  const oaVoiceSel = overlay.querySelector('#cbe-tts-oa-voice');
  const oaSpeed    = overlay.querySelector('#cbe-tts-oa-speed');
  const oaSpeedVal = overlay.querySelector('#cbe-tts-oa-speed-val');
  /* elevenlabs sub-controls */
  const elVoice    = overlay.querySelector('#cbe-tts-el-voice');
  const elStab     = overlay.querySelector('#cbe-tts-el-stability');
  const elStabVal  = overlay.querySelector('#cbe-tts-el-stability-val');
  const elSim      = overlay.querySelector('#cbe-tts-el-similarity');
  const elSimVal   = overlay.querySelector('#cbe-tts-el-similarity-val');
  /* stt controls */
  const sttDict     = overlay.querySelector('#cbe-stt-dictionary');
  const sttLangEl   = overlay.querySelector('#cbe-stt-language');
  const sttDictLbl  = overlay.querySelector('#cbe-stt-dict-label');
  const sttDictHint = overlay.querySelector('#cbe-stt-dict-hint');
  const sttDictWrap = overlay.querySelector('#cbe-stt-dict-wrap');

  /* Hydrate provider selection from payload (validated server-side). */
  if (ttsProvSel) ttsProvSel.value = ['webspeech','elevenlabs','openai'].includes(payload.ttsProvider) ? payload.ttsProvider : 'webspeech';
  /* STT default = elevenlabs (per user memory `elevenlabs_default.md`). The
     old default 'webspeech' fell through to Anthropic STT after Trent picked
     it once, then bombed on getUserMedia. 2026-05-27.
     WebSpeech is no longer a user-selectable option (sandbox-blocked) — coerce
     any stored 'webspeech' to 'elevenlabs' when populating the dropdown so the
     user sees the active path. 2026-05-29. */
  if (sttProvSel) {
    const stored = String(payload.sttProvider || '');
    const coerced = (stored === 'webspeech') ? 'elevenlabs' : stored;
    /* whisper-local removed 2026-05-30; whisper-cpp-stream retired 2026-06-04
       (its prebuilt zip ships no `stream` binary → dead on most Windows
       installs). Both auto-migrate to the working faster-whisper-stream engine
       so users with old settings aren't silently re-pinned to elevenlabs. */
    const migrated = (coerced === 'whisper-local' || coerced === 'whisper-cpp-stream') ? 'faster-whisper-stream' : coerced;
    sttProvSel.value = ['faster-whisper-stream','elevenlabs','openai','anthropic','deepgram'].includes(migrated) ? migrated : 'elevenlabs';
  }

  /* Snapshot the live TTS window values so Cancel can restore them after any
     live preview / typing. */
  const __cbeSavedTtsAtOpen = {
    provider: window.__cbeTtsProvider,
    voice:    window.__cbeTtsVoice,
    rate:     window.__cbeTtsRate,
    volume:   window.__cbeTtsVolume,
    openaiVoice: window.__cbeTtsOpenAiVoice,
    openaiSpeed: window.__cbeTtsOpenAiSpeed,
    elevenVoice: window.__cbeTtsElevenVoice,
    elevenStability: window.__cbeTtsElevenStability,
    elevenSimilarity: window.__cbeTtsElevenSimilarity,
  };
  const __cbeSavedSttAtOpen = {
    provider: window.__cbeSttProvider,
    dictionary: window.__cbeSttDictionary,
    language: window.__cbeSttLanguage,
  };

  /* Hydrate value controls from saved window state (init hydrated these). */
  if (wsRate)   { wsRate.value   = String(window.__cbeTtsRate != null ? window.__cbeTtsRate : 1);   if (wsRateVal) wsRateVal.textContent = Number(wsRate.value).toFixed(1) + '×'; }
  if (wsVolume) { wsVolume.value = String(Math.round((window.__cbeTtsVolume != null ? window.__cbeTtsVolume : 1) * 100)); if (wsVolVal) wsVolVal.textContent = wsVolume.value + '%'; }
  if (oaVoiceSel && window.__cbeTtsOpenAiVoice) oaVoiceSel.value = window.__cbeTtsOpenAiVoice;
  if (oaSpeed)  { oaSpeed.value  = String(window.__cbeTtsOpenAiSpeed != null ? window.__cbeTtsOpenAiSpeed : 1); if (oaSpeedVal) oaSpeedVal.textContent = Number(oaSpeed.value).toFixed(2).replace(/0$/,'') + '×'; }
  if (elVoice)  elVoice.value = String(window.__cbeTtsElevenVoice || '');
  if (elStab)   { elStab.value = String(window.__cbeTtsElevenStability != null ? window.__cbeTtsElevenStability : 0.5); if (elStabVal) elStabVal.textContent = Number(elStab.value).toFixed(2); }
  if (elSim)    { elSim.value  = String(window.__cbeTtsElevenSimilarity != null ? window.__cbeTtsElevenSimilarity : 0.75); if (elSimVal) elSimVal.textContent = Number(elSim.value).toFixed(2); }
  if (sttDict)   sttDict.value = String(window.__cbeSttDictionary || '');
  if (sttLangEl) sttLangEl.value = String(window.__cbeSttLanguage || '');

  /* WebSpeech voice list — getVoices() is async on first call; populate now
     and re-populate on the onvoiceschanged event. Label as "Name (lang)". */
  function _populateWsVoices() {
    if (!wsVoiceSel) return;
    let voices = [];
    try { voices = (window.speechSynthesis && window.speechSynthesis.getVoices && window.speechSynthesis.getVoices()) || []; }
    catch (_) { voices = []; }
    const want = String(window.__cbeTtsVoice || '');
    /* Keep the leading "System default" option, drop the rest, repopulate. */
    while (wsVoiceSel.options.length > 1) wsVoiceSel.remove(1);
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '') + (v.default ? ' — default' : '');
      wsVoiceSel.appendChild(o);
    });
    if (want && Array.from(wsVoiceSel.options).some((o) => o.value === want)) wsVoiceSel.value = want;
  }
  if (wsVoiceSel) {
    _populateWsVoices();
    try { if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = _populateWsVoices; } catch (_) {}
  }

  /* Live-apply webspeech values to the window state as the user drags, so a
     read-aloud test reflects the new setting before Apply. */
  if (wsVoiceSel) wsVoiceSel.addEventListener('change', () => { window.__cbeTtsVoice = wsVoiceSel.value || ''; });
  if (wsRate) wsRate.addEventListener('input', () => {
    const n = Number(wsRate.value); if (wsRateVal) wsRateVal.textContent = n.toFixed(1) + '×'; window.__cbeTtsRate = n;
  });
  if (wsVolume) wsVolume.addEventListener('input', () => {
    const n = Number(wsVolume.value); if (wsVolVal) wsVolVal.textContent = n + '%'; window.__cbeTtsVolume = n / 100;
  });
  if (oaSpeed) oaSpeed.addEventListener('input', () => {
    const n = Number(oaSpeed.value); if (oaSpeedVal) oaSpeedVal.textContent = n.toFixed(2).replace(/0$/,'') + '×';
  });
  if (elStab) elStab.addEventListener('input', () => { if (elStabVal) elStabVal.textContent = Number(elStab.value).toFixed(2); });
  if (elSim)  elSim.addEventListener('input',  () => { if (elSimVal)  elSimVal.textContent  = Number(elSim.value).toFixed(2); });

  /* TTS provider dropdown shows/hides the matching sub-control group. */
  function _syncTtsSubs() {
    const p = (ttsProvSel && ttsProvSel.value) || 'webspeech';
    Object.keys(ttsSubs).forEach((k) => { if (ttsSubs[k]) ttsSubs[k].hidden = (k !== p); });
  }
  if (ttsProvSel) ttsProvSel.addEventListener('change', _syncTtsSubs);
  _syncTtsSubs();

  /* STT dictionary label/hint adapts per provider (whisper/openai = "prompt",
     anthropic = "Keyterms", webspeech = no dictionary, only language). */
  function _syncSttDict() {
    const p = (sttProvSel && sttProvSel.value) || 'webspeech';
    if (p === 'anthropic') {
      if (sttDictLbl)  sttDictLbl.textContent = 'Keyterms';
      if (sttDictHint) sttDictHint.textContent = 'Comma- or newline-separated terms appended to the Deepgram keyterm list to bias recognition.';
      if (sttDictWrap) sttDictWrap.hidden = false;
    } else if (p === 'webspeech') {
      /* WebSpeech has no vocabulary biasing — language only. */
      if (sttDictWrap) sttDictWrap.hidden = true;
    } else {
      if (sttDictLbl)  sttDictLbl.textContent = 'Custom dictionary / vocabulary';
      if (sttDictHint) sttDictHint.textContent = 'Comma- or newline-separated terms passed as the transcription prompt to bias spelling of names, jargon, and acronyms.';
      if (sttDictWrap) sttDictWrap.hidden = false;
    }
  }
  if (sttProvSel) sttProvSel.addEventListener('change', _syncSttDict);
  _syncSttDict();

  /* ── API-key UI wiring (added 2026-05-30) ──────────────────────────────
     Each keyed provider gets its config.ini section + an optional explicit
     key-name (otherwise defaults to "api_key"). 'webspeech',
     'whisper-cpp-stream', 'faster-whisper-stream', and 'anthropic'
     (Claude-Code OAuth) are intentionally absent — they don't take a key. */
  const KEY_PROVIDER_META = {
    elevenlabs: { section: 'elevenlabs', key: 'api_key',
                  label: 'ElevenLabs API key',
                  hint:  'From elevenlabs.io/app/settings → API Keys. Stored in [elevenlabs] api_key.' },
    openai:     { section: 'api_keys',  key: 'openai_api_key',
                  label: 'OpenAI API key',
                  hint:  'From platform.openai.com/api-keys. Stored in [api_keys] openai_api_key.' },
    deepgram:   { section: 'deepgram',  key: 'api_key',
                  label: 'Deepgram API key',
                  hint:  'From console.deepgram.com → API Keys. Stored in [deepgram] api_key.' },
  };

  const sttKeyRow   = overlay.querySelector('#cbe-stt-key-row');
  const sttKeyInput = overlay.querySelector('#cbe-stt-apikey');
  const sttKeyLabel = overlay.querySelector('#cbe-stt-apikey-label');
  const sttKeyHint  = overlay.querySelector('#cbe-stt-apikey-hint');
  const sttKeySave  = overlay.querySelector('#cbe-stt-apikey-save');

  function _syncSttKeyRow() {
    if (!sttKeyRow || !sttProvSel) return;
    const p = String(sttProvSel.value || '');
    const meta = KEY_PROVIDER_META[p];
    if (!meta) { sttKeyRow.hidden = true; return; }
    sttKeyRow.hidden = false;
    if (sttKeyLabel) sttKeyLabel.textContent = meta.label;
    if (sttKeyHint)  sttKeyHint.textContent  = meta.hint;
    if (sttKeyInput) {
      sttKeyInput.value = '';
      sttKeyInput.placeholder = '•••• (saved — paste a new value to replace)';
      sttKeyInput.setAttribute('data-section', meta.section);
      sttKeyInput.setAttribute('data-key', meta.key);
    }
  }
  if (sttProvSel) sttProvSel.addEventListener('change', _syncSttKeyRow);
  _syncSttKeyRow();

  /* Save buttons — three of them (STT row + TTS-elevenlabs + TTS-openai),
     all post the same {type:'setProviderKey', section, key, value} shape. */
  function _postKeySave(section, keyName, value, btn) {
    if (!value || !api) return;
    try { api.postMessage({ type: 'setProviderKey', section, key: keyName, value }); } catch (_) {}
    if (btn) {
      const orig = btn.textContent;
      /* Inline-SVG check (U+2713 tofus in the webview font). Restored to the
         plain original label via textContent after the timeout. */
      btn.innerHTML = 'Saved <svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
        'aria-hidden="true" style="vertical-align:-1px;"><path d="M5 13l4 4L19 7" ' +
        'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
  }
  if (sttKeySave) {
    sttKeySave.addEventListener('click', () => {
      const v = (sttKeyInput && sttKeyInput.value) || '';
      const section = (sttKeyInput && sttKeyInput.getAttribute('data-section')) || '';
      const keyName = (sttKeyInput && sttKeyInput.getAttribute('data-key')) || 'api_key';
      if (v && section) _postKeySave(section, keyName, v.trim(), sttKeySave);
    });
  }
  const elKeyInput = overlay.querySelector('#cbe-tts-el-apikey');
  const elKeySave  = overlay.querySelector('#cbe-tts-el-apikey-save');
  if (elKeySave && elKeyInput) {
    elKeySave.addEventListener('click', () => {
      const v = (elKeyInput.value || '').trim();
      if (v) _postKeySave('elevenlabs', 'api_key', v, elKeySave);
    });
  }
  const oaKeyInput = overlay.querySelector('#cbe-tts-oa-apikey');
  const oaKeySave  = overlay.querySelector('#cbe-tts-oa-apikey-save');
  if (oaKeySave && oaKeyInput) {
    oaKeySave.addEventListener('click', () => {
      const v = (oaKeyInput.value || '').trim();
      if (v) _postKeySave('api_keys', 'openai_api_key', v, oaKeySave);
    });
  }

  /* ── ElevenLabs voice list (auto-populate from /v1/voices) ──────────────
     On TTS provider change to elevenlabs OR Refresh button click, request
     the voice list from the host. Host hits api.elevenlabs.io/v1/voices and
     replies with {type:'elevenLabsVoicesResult', ok, voices:[{voice_id,name,...}]}.
     We populate the select; the text input remains as an override for custom
     voice IDs not in the list. */
  const elVoiceSelect  = overlay.querySelector('#cbe-tts-el-voice-select');
  const elVoiceText    = overlay.querySelector('#cbe-tts-el-voice');
  const elVoiceRefresh = overlay.querySelector('#cbe-tts-el-voice-refresh');
  function _requestElVoices() {
    if (!api) return;
    if (elVoiceSelect) {
      elVoiceSelect.innerHTML = '<option value="">(loading…)</option>';
    }
    try { api.postMessage({ type: 'fetchElevenLabsVoices' }); } catch (_) {}
  }
  if (elVoiceRefresh) elVoiceRefresh.addEventListener('click', _requestElVoices);
  if (elVoiceSelect) {
    elVoiceSelect.addEventListener('change', () => {
      if (elVoiceSelect.value && elVoiceText) elVoiceText.value = elVoiceSelect.value;
    });
  }
  /* Listen for the host's voice-list response. We tack onto the existing
     window-level message listener path rather than adding a new one to avoid
     duplicate-handler risk. */
  window.addEventListener('message', (ev) => {
    const m = (ev && ev.data) || {};
    if (m.type !== 'elevenLabsVoicesResult') return;
    if (!elVoiceSelect) return;
    if (!m.ok || !Array.isArray(m.voices)) {
      elVoiceSelect.innerHTML = '<option value="">(error: ' + (m.error ? String(m.error).slice(0, 60) : 'load failed') + ')</option>';
      return;
    }
    const current = (elVoiceText && elVoiceText.value) || '';
    const opts = ['<option value="">(pick a voice)</option>'];
    for (const v of m.voices) {
      const id = String(v.voice_id || v.id || '');
      const name = String(v.name || id);
      const sel = (id === current) ? ' selected' : '';
      opts.push('<option value="' + id + '"' + sel + '>' + name + ' (' + id.slice(0, 8) + '…)</option>');
    }
    elVoiceSelect.innerHTML = opts.join('');
  });
  /* Listen for the host's bridge-operator model-list response and hand it to
     window.__cbeOpFillModels (defined where the operator pane is wired). Same
     per-open listener pattern as the ElevenLabs voice list above. */
  window.addEventListener('message', (ev) => {
    const m = (ev && ev.data) || {};
    if (m.type !== 'operatorModelsResult') return;
    try { if (typeof window.__cbeOpFillModels === 'function') window.__cbeOpFillModels(m); } catch (_) {}
  });
  /* Trigger voice list fetch when ElevenLabs becomes the selected TTS provider. */
  if (ttsProvSel) {
    ttsProvSel.addEventListener('change', () => {
      if (ttsProvSel.value === 'elevenlabs') _requestElVoices();
    });
    if (String(ttsProvSel.value || '') === 'elevenlabs') _requestElVoices();
  }

  /* Backdrop click = cancel. Direct buttons (apply/cancel) call
     _cbeDoApply()/_cbeDoCancel() directly — see top of openSettings. */
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      console.log('[CBE] backdrop click -> cancel');
      try { _cbeDoCancel(); }
      catch (err) { console.error('[CBE] backdrop cancel threw', err); }
    }
  });
  document.addEventListener('keydown', escClose, true);

  /* ── The actual apply/cancel logic, callable directly from the button
     click listeners above. Function DECLARATIONS are hoisted within
     openSettings, so they resolve even though they're defined below the
     listener registration. Heavy console logging on every branch so the
     user can pinpoint where the chain breaks if it ever fails again. */
  function _cbeDoCancel() {
    console.log('[CBE] _cbeDoCancel ENTER');
    try {
      console.log('[CBE]   revert sfx', { savedEn: __cbeSavedSfxEnabled, savedVol: __cbeSavedSfxVolume });
      setSfxEnabled(__cbeSavedSfxEnabled);
      setSfxVolume(__cbeSavedSfxVolume);
      __cbeActiveSkin = __cbeSavedSkinAtOpen;
      console.log('[CBE]   restoring skin', __cbeSavedSkinAtOpen, 'uri=', __cbeSavedSkinUriAtOpen);
      applySkinUri(__cbeSavedSkinUriAtOpen);
      applySkinColors(__cbeSavedColorsAtOpen);
      /* Revert any live TTS/STT window-value previews to the open-time snapshot. */
      window.__cbeTtsProvider          = __cbeSavedTtsAtOpen.provider;
      window.__cbeTtsVoice             = __cbeSavedTtsAtOpen.voice;
      window.__cbeTtsRate              = __cbeSavedTtsAtOpen.rate;
      window.__cbeTtsVolume            = __cbeSavedTtsAtOpen.volume;
      window.__cbeTtsOpenAiVoice       = __cbeSavedTtsAtOpen.openaiVoice;
      window.__cbeTtsOpenAiSpeed       = __cbeSavedTtsAtOpen.openaiSpeed;
      window.__cbeTtsElevenVoice       = __cbeSavedTtsAtOpen.elevenVoice;
      window.__cbeTtsElevenStability   = __cbeSavedTtsAtOpen.elevenStability;
      window.__cbeTtsElevenSimilarity  = __cbeSavedTtsAtOpen.elevenSimilarity;
      window.__cbeSttProvider          = __cbeSavedSttAtOpen.provider;
      window.__cbeSttDictionary        = __cbeSavedSttAtOpen.dictionary;
      window.__cbeSttLanguage          = __cbeSavedSttAtOpen.language;
    } catch (err) {
      console.error('[CBE] _cbeDoCancel revert threw', err);
    }
    console.log('[CBE]   closing modal');
    closeSettings();
    console.log('[CBE] _cbeDoCancel EXIT');
  }

  function _cbeDoApply() {
    console.log('[CBE] _cbeDoApply ENTER');
    const providerEl = overlay.querySelector('#cbe-set-provider');
    const modelEl    = overlay.querySelector('#cbe-set-model');
    if (!providerEl || !modelEl) {
      console.error('[CBE] _cbeDoApply missing provider/model selects', { providerEl, modelEl });
      return;
    }
    const provider = providerEl.value;
    const model    = modelEl.value;
    __cbeActiveProvider = provider;
    console.log('[CBE]   provider/model', { provider, model });

    const sfxEnabledVal = !!sfxEnabled.checked;
    const sfxVolumeVal  = Number(sfxVolume.value) / 100;
    setSfxEnabled(sfxEnabledVal);
    setSfxVolume(sfxVolumeVal);
    __cbeSavedSfxEnabled = sfxEnabledVal;
    __cbeSavedSfxVolume  = sfxVolumeVal;
    console.log('[CBE]   sfx', { enabled: sfxEnabledVal, vol: sfxVolumeVal });

    const skinSel = overlay.querySelector('#cbe-set-skin');
    const skin    = (skinSel && skinSel.value) || '';
    __cbeActiveSkin = skin;
    __cbeSavedSkinAtOpen = skin;
    console.log('[CBE]   skin', skin);

    const langWrap = overlay.querySelector('#cbe-set-language-wrap');
    const language = (langWrap && langWrap.dataset && langWrap.dataset.value) || 'en';
    console.log('[CBE]   language', language);

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
      console.log('[CBE]   toolCall', toolCall);
    } catch (err) {
      console.error('[CBE] _cbeDoApply toolCall collect threw', err);
    }

    /* Bridge-operator collect — provider + the model for the SELECTED provider
       only (the others keep their saved values). */
    let bridgeOperator = null;
    try {
      const opProv = (opProvSel && opProvSel.value) || 'azure';
      const opModel = (opModelSel && opModelSel.value) || '';
      bridgeOperator = { provider: opProv };
      if (opProv === 'azure')     bridgeOperator.azureDeployment = opModel;
      if (opProv === 'openai')    bridgeOperator.openaiModel = opModel;
      if (opProv === 'anthropic') bridgeOperator.anthropicModel = opModel;
      if (opProv === 'gemini')    bridgeOperator.geminiModel = opModel;
      if (opProv === 'vertex')    bridgeOperator.vertexModel = opModel;
      console.log('[CBE]   bridgeOperator', bridgeOperator);
    } catch (err) {
      console.error('[CBE] _cbeDoApply bridgeOperator collect threw', err);
    }

    /* ── Voice (TTS / STT) collect + apply ──────────────────────────────────
       Read every voice control, write the active values onto the window so
       the panel-side speak/dictate paths use them immediately, and ship the
       persistable subset to the host (it stores them + applies the remote-TTS
       ones at speak time). */
    const ttsProvider = (ttsProvSel && ttsProvSel.value) || 'webspeech';
    const sttProvider = (sttProvSel && sttProvSel.value) || 'webspeech';
    const ttsVoice    = (wsVoiceSel && wsVoiceSel.value) || '';
    const ttsRate     = wsRate ? Number(wsRate.value) : 1;
    const ttsVolume   = wsVolume ? (Number(wsVolume.value) / 100) : 1;
    const ttsOpenAiVoice = (oaVoiceSel && oaVoiceSel.value) || 'alloy';
    const ttsOpenAiSpeed = oaSpeed ? Number(oaSpeed.value) : 1;
    const ttsElevenVoice = (elVoice && elVoice.value.trim()) || '';
    const ttsElevenStability  = elStab ? Number(elStab.value) : 0.5;
    const ttsElevenSimilarity = elSim ? Number(elSim.value) : 0.75;
    const sttDictionary = (sttDict && sttDict.value) || '';
    const sttLanguage   = (sttLangEl && sttLangEl.value.trim()) || '';

    /* Apply live to the window state used by speakWebSpeech / startWebSpeech /
       startMediaRecorder / speakRemote. */
    window.__cbeTtsProvider         = ttsProvider;
    window.__cbeSttProvider         = sttProvider;
    window.__cbeTtsVoice            = ttsVoice;
    window.__cbeTtsRate             = ttsRate;
    window.__cbeTtsVolume           = ttsVolume;
    window.__cbeTtsOpenAiVoice      = ttsOpenAiVoice;
    window.__cbeTtsOpenAiSpeed      = ttsOpenAiSpeed;
    window.__cbeTtsElevenVoice      = ttsElevenVoice;
    window.__cbeTtsElevenStability  = ttsElevenStability;
    window.__cbeTtsElevenSimilarity = ttsElevenSimilarity;
    window.__cbeSttDictionary       = sttDictionary;
    window.__cbeSttLanguage         = sttLanguage;
    /* Update the open-time snapshot so a follow-up Cancel doesn't revert what
       we just applied. */
    __cbeSavedTtsAtOpen.provider = ttsProvider; __cbeSavedTtsAtOpen.voice = ttsVoice;
    __cbeSavedTtsAtOpen.rate = ttsRate; __cbeSavedTtsAtOpen.volume = ttsVolume;
    __cbeSavedTtsAtOpen.openaiVoice = ttsOpenAiVoice; __cbeSavedTtsAtOpen.openaiSpeed = ttsOpenAiSpeed;
    __cbeSavedTtsAtOpen.elevenVoice = ttsElevenVoice; __cbeSavedTtsAtOpen.elevenStability = ttsElevenStability;
    __cbeSavedTtsAtOpen.elevenSimilarity = ttsElevenSimilarity;
    __cbeSavedSttAtOpen.provider = sttProvider; __cbeSavedSttAtOpen.dictionary = sttDictionary;
    __cbeSavedSttAtOpen.language = sttLanguage;
    console.log('[CBE]   voice', { ttsProvider, sttProvider, ttsVoice, ttsRate, ttsVolume });

    if (api) {
      console.log('[CBE]   postMessage setProvider', { provider, model, skin, language });
      try {
        api.postMessage({
          type: 'setProvider', provider, model,
          sfxEnabled: sfxEnabledVal, sfxVolume: sfxVolumeVal,
          skin, language, toolCall, bridgeOperator,
          /* voice */
          ttsProvider, sttProvider,
          ttsVoice, ttsRate, ttsVolume,
          ttsOpenAiVoice, ttsOpenAiSpeed,
          ttsElevenVoice, ttsElevenStability, ttsElevenSimilarity,
          sttDictionary, sttLanguage,
        });
        console.log('[CBE]   postMessage returned cleanly');
      } catch (err) {
        console.error('[CBE]   postMessage THREW', err);
      }
    } else {
      console.error('[CBE] _cbeDoApply: api is NULL — no postMessage sent');
    }
    console.log('[CBE]   closing modal');
    closeSettings();
    console.log('[CBE] _cbeDoApply EXIT');
  }
}
/* Saved SFX state baseline so Cancel can revert live previews. Hydrated
   on `init` from the host's persisted workspaceState. */
let __cbeSavedSfxEnabled = true;
let __cbeSavedSfxVolume  = 0.55;
function escClose(e) { if (e.key === 'Escape') closeSettings(); }
function closeSettings(suppressSfx) {
  const old = document.getElementById('cbe-settings');
  if (old) {
    /* Disconnect resize observer to avoid leaking after modal removal. */
    try { if (old.__cbeResizeObserver) old.__cbeResizeObserver.disconnect(); } catch (_) {}
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

function cbeConfirm(message, opts) {
  /* Tiny replacement for window.confirm() that works inside a VSCode
     webview. Themed via the same --cbe-modal-* vars the rest of the
     modals use, so it matches the active skin. Returns a Promise<bool>.
     opts (optional): { title:'Confirm', okLabel:'Delete' } — back-compat:
     when omitted, keeps the original "Confirm"/"Delete" labels. */
  const title   = (opts && opts.title)   || 'Confirm';
  const okLabel = (opts && opts.okLabel) || 'Delete';
  return new Promise(resolve => {
    const old = document.getElementById('cbe-confirm');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cbe-confirm';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    overlay.innerHTML =
      '<div style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:420px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;">' + escapeHtml(title) + '</div>' +
        '<div style="padding:16px 18px;white-space:pre-wrap;line-height:1.45;">' + escapeHtml(message) + '</div>' +
        '<div style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
          '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
          '<button type="button" data-act="ok" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">' + escapeHtml(okLabel) + '</button>' +
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

/* ── cbePrompt — in-DOM single-line text prompt (NOT window.prompt, which is
   unavailable in the VSCode webview). Same theming as cbeConfirm. Resolves
   to the entered string, or null if cancelled/Esc. Used by "Save as New". */
function cbePrompt(title, placeholder, initial) {
  return new Promise(resolve => {
    const old = document.getElementById('cbe-prompt');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cbe-prompt';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    overlay.innerHTML =
      '<div style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:420px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;">' + escapeHtml(title || 'Enter a value') + '</div>' +
        '<div style="padding:16px 18px;">' +
          '<input type="text" id="cbe-prompt-input" spellcheck="false" placeholder="' + escapeHtml(placeholder || '') + '" value="' + escapeHtml(initial || '') + '" style="width:100%;padding:6px 8px;background:var(--cbe-modal-bg,#1c1c1c);color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);border-radius:4px;font:inherit;box-sizing:border-box;">' +
        '</div>' +
        '<div style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
          '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
          '<button type="button" data-act="ok" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#cbe-prompt-input');
    function done(result) {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); done(input ? input.value : null); }
    }
    overlay.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') done(input ? input.value : null);
      else if (act === 'cancel' || e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey, true);
    if (input) { input.focus(); try { input.select(); } catch (_) {} }
  });
}

/* ── cbeChoice — in-DOM multi-button prompt (N choices). Used by the skin
   editor's unsaved-changes dirty-guard (Save / Save as New / Discard /
   Cancel). Resolves to the chosen button id, or null on Esc/backdrop.
   opts: { title, buttons:[{id,label,primary}] }. */
function cbeChoice(message, opts) {
  const title   = (opts && opts.title) || 'Confirm';
  const buttons = (opts && Array.isArray(opts.buttons) && opts.buttons.length)
    ? opts.buttons
    : [{ id: 'ok', label: 'OK', primary: true }, { id: 'cancel', label: 'Cancel' }];
  return new Promise(resolve => {
    const old = document.getElementById('cbe-choice');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cbe-choice';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    const btnHtml = buttons.map(b => {
      const primary = b.primary
        ? 'background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;font-weight:600;'
        : 'background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);';
      return '<button type="button" data-choice="' + escapeHtml(b.id) + '" style="' + primary + 'border-radius:6px;padding:6px 14px;cursor:pointer;">' + escapeHtml(b.label) + '</button>';
    }).join('');
    overlay.innerHTML =
      '<div style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:460px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;">' + escapeHtml(title) + '</div>' +
        '<div style="padding:16px 18px;white-space:pre-wrap;line-height:1.45;">' + escapeHtml(message) + '</div>' +
        '<div style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">' + btnHtml + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function done(result) {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(null); } }
    overlay.addEventListener('click', (e) => {
      const c = e.target && e.target.getAttribute && e.target.getAttribute('data-choice');
      if (c) done(c);
      else if (e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey, true);
    const first = overlay.querySelector('button[data-choice]');
    if (first) first.focus();
  });
}

/* ── cbePromptValidated — in-DOM text prompt with live validation. The
   validate(value) callback returns an error string (shown inline + OK
   disabled) or '' when valid. Resolves to the (trimmed-as-entered) string,
   or null if cancelled/Esc. Used by the skin editor "Save as New" flow so
   blank / illegal-filename-char names can't be submitted. */
function cbePromptValidated(title, placeholder, initial, validate) {
  return new Promise(resolve => {
    const old = document.getElementById('cbe-prompt-validated');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cbe-prompt-validated';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    overlay.innerHTML =
      '<div style="background:var(--cbe-modal-bg);color:var(--cbe-modal-fg);border:2px solid var(--cbe-modal-border);border-radius:10px;width:460px;max-width:92vw;box-shadow:0 12px 50px rgba(0,0,0,.7);display:flex;flex-direction:column;">' +
        '<div style="padding:12px 16px;background:linear-gradient(90deg,var(--cbe-modal-title-bg-1),var(--cbe-modal-title-bg-2));color:var(--cbe-modal-title-fg);font-weight:700;">' + escapeHtml(title || 'Enter a value') + '</div>' +
        '<div style="padding:16px 18px;">' +
          '<input type="text" id="cbe-pv-input" spellcheck="false" placeholder="' + escapeHtml(placeholder || '') + '" value="' + escapeHtml(initial || '') + '" style="width:100%;padding:6px 8px;background:var(--cbe-modal-bg,#1c1c1c);color:var(--cbe-modal-fg,#eee);border:1px solid var(--cbe-modal-border,#444);border-radius:4px;font:inherit;box-sizing:border-box;">' +
          '<div id="cbe-pv-err" style="min-height:16px;margin-top:6px;color:#ff6b6b;font-size:12px;"></div>' +
        '</div>' +
        '<div style="padding:10px 16px;background:var(--cbe-modal-foot-bg);border-top:1px solid rgba(0,0,0,.25);display:flex;justify-content:flex-end;gap:8px;">' +
          '<button type="button" data-act="cancel" style="background:transparent;color:var(--cbe-modal-fg);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;cursor:pointer;">Cancel</button>' +
          '<button type="button" id="cbe-pv-ok" data-act="ok" style="background:var(--cbe-modal-accent);color:var(--cbe-modal-title-fg);border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#cbe-pv-input');
    const errEl = overlay.querySelector('#cbe-pv-err');
    const okBtn = overlay.querySelector('#cbe-pv-ok');
    function currentError() {
      const v = input ? input.value : '';
      try { return (typeof validate === 'function') ? (validate(v) || '') : ''; }
      catch (_) { return ''; }
    }
    function refresh() {
      const err = currentError();
      if (errEl) errEl.textContent = err;
      if (okBtn) {
        okBtn.disabled = !!err;
        okBtn.style.opacity = err ? '0.5' : '1';
        okBtn.style.cursor  = err ? 'not-allowed' : 'pointer';
      }
      return err;
    }
    function done(result) {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function submit() {
      if (refresh()) return;                 // invalid → block
      done(input ? input.value : null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }
    overlay.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') submit();
      else if (act === 'cancel' || e.target === overlay) done(null);
    });
    if (input) input.addEventListener('input', refresh);
    document.addEventListener('keydown', onKey, true);
    refresh();
    if (input) { input.focus(); try { input.select(); } catch (_) {} }
  });
}

/* ── Skin editor state + helpers (Phase 4 — dedicated modal) ──────────────
   The editor now lives in its own big modal (#cbe-skin-editor-modal) built on
   demand by openSkinEditor() — the cramped Appearance sub-panel had no room.
   __cbeSkinEditor tracks which skin id the editor is bound to PLUS the
   original (loaded) text for dirty-tracking. The host-reply handlers
   (skinSource/skinSaved/skinSavedAsNew/skinRestored) in the global message
   listener call these helpers. */
let __cbeSkinEditor = { id: '', label: '', original: null };
/* After "Save as New" the host sends skinSavedAsNew{newId}; we re-request
   listSkins, and when the fresh skinsList arrives we auto-select this id. */
let __cbeSkinSelectAfterList = '';

function skinEditorEl() { return document.getElementById('cbe-skin-editor-modal'); }

function skinLabelFor(id) {
  /* Resolve the picker label for a skin id from the cached skins list. */
  if (Array.isArray(__cbeSkinsList)) {
    const hit = __cbeSkinsList.find(s => s && s.name === id);
    if (hit) return hit.label || hit.name || id;
  }
  return id;
}

/* True when the textarea differs from the last-loaded original. Until a
   source actually loads (original === null) we treat it as NOT dirty so an
   in-flight getSkinSource reply can populate without triggering the guard. */
function skinEditorIsDirty() {
  if (__cbeSkinEditor.original === null) return false;
  const ta = document.getElementById('cbe-skin-editor-ta');
  if (!ta) return false;
  return ta.value !== __cbeSkinEditor.original;
}

/* Illegal filename-char validation shared by the Save-as-New dialog and the
   dirty-guard's "Save as New" branch. Returns an error string, or '' if the
   name is valid. */
function skinNameValidationError(raw) {
  const name = String(raw == null ? '' : raw);
  if (!name.trim()) return 'Name cannot be blank.';
  /* eslint-disable-next-line no-control-regex */
  if (/[\x00-\x1f\x7f]/.test(name)) return 'Name cannot contain control characters.';
  const bad = /[\/\\:*?"<>|]/.exec(name);
  if (bad) return 'Name cannot contain the "' + bad[0] + '" character.';
  if (/^[ .]/.test(name) || /[ .]$/.test(name)) {
    return 'Name cannot start or end with a space or dot.';
  }
  return '';
}

/* Inject the scoped LIGHT Prism theme for the skin editor exactly once.
   This is a light scheme (Prism "Coy"-flavoured token colors on a near-white
   parchment bg) scoped to `.cbe-skin-hl-light` so it does NOT touch the chat
   code blocks (which load the dark theme via {{PRISM_CSS_URI}}). It also
   force-matches the <pre>/<code> typography to the transparent <textarea> so
   the highlighted glyphs land under the caret 1:1. Inlined (not CDN) per CSP. */
function ensureSkinEditorThemeCss() {
  if (document.getElementById('cbe-skin-hl-theme')) return;
  const st = document.createElement('style');
  st.id = 'cbe-skin-hl-theme';
  st.textContent = [
    /* shared typography — MUST match between textarea + pre/code */
    '.cbe-skin-hl-light pre, .cbe-skin-hl-light textarea {',
    '  font:13px/1.45 Consolas,"Courier New",monospace !important;',
    '  letter-spacing:0 !important; tab-size:2; -moz-tab-size:2;',
    '  padding:10px !important;',
    '}',
    '.cbe-skin-hl-light code { font:inherit !important; }',
    /* base text + parchment-light background */
    '.cbe-skin-hl-light { color:#2b2b2b; }',
    '.cbe-skin-hl-light pre[id], .cbe-skin-hl-light code { color:#2b2b2b; background:transparent; text-shadow:none; }',
    /* light token palette (Coy / Solarized-Light flavour) */
    '.cbe-skin-hl-light .token.comment,',
    '.cbe-skin-hl-light .token.prolog,',
    '.cbe-skin-hl-light .token.doctype,',
    '.cbe-skin-hl-light .token.cdata { color:#93a1a1; font-style:italic; }',
    '.cbe-skin-hl-light .token.punctuation { color:#5c6e74; }',
    '.cbe-skin-hl-light .token.tag,',
    '.cbe-skin-hl-light .token.namespace,',
    '.cbe-skin-hl-light .token.deleted { color:#2f6f9f; }',
    '.cbe-skin-hl-light .token.tag .token.punctuation { color:#2f6f9f; }',
    '.cbe-skin-hl-light .token.attr-name,',
    '.cbe-skin-hl-light .token.property,',
    '.cbe-skin-hl-light .token.class-name,',
    '.cbe-skin-hl-light .token.constant,',
    '.cbe-skin-hl-light .token.symbol { color:#a0522d; }',
    '.cbe-skin-hl-light .token.boolean,',
    '.cbe-skin-hl-light .token.number { color:#c2185b; }',
    '.cbe-skin-hl-light .token.selector,',
    '.cbe-skin-hl-light .token.attr-value,',
    '.cbe-skin-hl-light .token.string,',
    '.cbe-skin-hl-light .token.char,',
    '.cbe-skin-hl-light .token.builtin,',
    '.cbe-skin-hl-light .token.inserted { color:#448c27; }',
    '.cbe-skin-hl-light .token.operator,',
    '.cbe-skin-hl-light .token.entity,',
    '.cbe-skin-hl-light .token.url,',
    '.cbe-skin-hl-light .language-css .token.string,',
    '.cbe-skin-hl-light .style .token.string { color:#5c6e74; }',
    '.cbe-skin-hl-light .token.atrule,',
    '.cbe-skin-hl-light .token.keyword { color:#7b2fbe; }',
    '.cbe-skin-hl-light .token.function { color:#d2413a; }',
    '.cbe-skin-hl-light .token.regex,',
    '.cbe-skin-hl-light .token.important,',
    '.cbe-skin-hl-light .token.variable { color:#e36209; }',
    '.cbe-skin-hl-light .token.important,',
    '.cbe-skin-hl-light .token.bold { font-weight:bold; }',
    '.cbe-skin-hl-light .token.italic { font-style:italic; }',
    /* textarea selection visible against transparent text */
    '.cbe-skin-hl-light textarea::selection { background:rgba(47,111,159,.30); }',
  ].join('\n');
  document.head.appendChild(st);
}

/* Re-tokenise the <pre><code> highlight layer from the current textarea
   value. Prism may not have finished loading the first time the editor opens;
   ensurePrismLoaded() resolves a promise we re-run against so highlighting
   appears as soon as the grammar is available. Until then the <code> still
   shows the (escaped) raw text, so nothing looks broken — it's just uncolored. */
function renderSkinEditorHighlight() {
  const ta   = document.getElementById('cbe-skin-editor-ta');
  const code = document.getElementById('cbe-skin-editor-code');
  if (!ta || !code) return;
  const src = ta.value;
  if (window.Prism && Prism.languages && Prism.languages.markup) {
    try {
      code.innerHTML = Prism.highlight(src, Prism.languages.markup, 'markup');
      return;
    } catch (e) { /* fall through to plain */ }
  }
  /* Prism not ready (or threw) → show escaped plain text so glyphs still align. */
  code.textContent = src;
}

/* Keep the highlight <pre> scrolled in lock-step with the textarea. */
function syncSkinEditorScroll() {
  const ta  = document.getElementById('cbe-skin-editor-ta');
  const pre = document.getElementById('cbe-skin-editor-pre');
  if (!ta || !pre) return;
  pre.scrollTop  = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

/* Wire input/scroll/Tab on the overlay textarea and run the first highlight.
   Re-runs the highlight once Prism's promise resolves (lazy load). */
function setupSkinEditorHighlight(overlay) {
  const ta = overlay.querySelector('#cbe-skin-editor-ta');
  if (!ta) return;
  ta.addEventListener('input', () => { renderSkinEditorHighlight(); syncSkinEditorScroll(); });
  ta.addEventListener('scroll', syncSkinEditorScroll);
  /* Tab inserts a literal tab (instead of moving focus) and preserves caret. */
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '\t' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 1;
      renderSkinEditorHighlight();
      syncSkinEditorScroll();
    }
  });
  /* First paint (textarea may still be empty until skinSource arrives). */
  renderSkinEditorHighlight();
  /* Ensure Prism is loaded, then re-highlight when its grammar is ready. */
  try {
    if (typeof ensurePrismLoaded === 'function') {
      ensurePrismLoaded().then(() => {
        if (document.getElementById('cbe-skin-editor-ta')) renderSkinEditorHighlight();
      });
    }
  } catch (e) { /* fail open — editor stays plain but editable */ }
}

function openSkinEditor(id) {
  /* Build (or rebuild) the dedicated editor modal and request the source.
     If another instance is open, tear it down first (no dirty-check — this
     is a fresh "Edit Skin" press). */
  const existing = skinEditorEl();
  if (existing) { try { existing.remove(); } catch (_) {} }

  __cbeSkinEditor.id = id || '';
  __cbeSkinEditor.label = skinLabelFor(id);
  __cbeSkinEditor.original = null;   // not yet loaded → not dirty

  const overlay = document.createElement('div');
  overlay.id = 'cbe-skin-editor-modal';
  /* Sit ABOVE the Settings modal. Reuse the cbe-box / cbe-hdr / cbe-body /
     cbe-foot chrome classes so it matches the active skin, but force a big
     near-full-screen size with !important so per-skin width rules can't
     shrink it. */
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'font-family:system-ui,sans-serif;';
  const labelTxt = __cbeSkinEditor.label || '(none)';
  overlay.innerHTML =
    '<div class="cbe-box" style="display:flex;flex-direction:column;width:92vw;max-width:1100px;height:88vh;box-sizing:border-box;overflow:hidden;">'
    +   '<div class="cbe-hdr" style="display:flex;align-items:center;gap:8px;">'
    +     '<span style="flex:1;">Edit Skin — <span id="cbe-skin-editor-name" style="font-weight:400;opacity:.85;">' + escapeHtml(labelTxt) + '</span></span>'
    +     '<button type="button" id="cbe-skin-editor-x" class="cbe-btn cbe-cancel cbe-x-svg" aria-label="Close"></button>'
    +   '</div>'
    +   '<div class="cbe-body" style="display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:hidden;box-sizing:border-box;">'
    /* Syntax-highlight overlay: a transparent <textarea> (real caret + input)
       layered exactly over a Prism-highlighted <pre><code>. The two share
       identical font/padding/line-height/white-space so glyphs align. The
       textarea KEEPS id="cbe-skin-editor-ta" so all existing readers/writers
       (skinSource handler, save, dirty-check) are unchanged. */
    +     '<div id="cbe-skin-editor-hlwrap" class="cbe-skin-hl-light" style="position:relative;flex:1 1 auto;min-height:0;border:1px solid var(--cbe-modal-border,#444);border-radius:4px;overflow:hidden;background:#fdfdfd;">'
    +       '<pre id="cbe-skin-editor-pre" aria-hidden="true" style="margin:0;position:absolute;inset:0;overflow:auto;pointer-events:none;box-sizing:border-box;background:transparent;"><code id="cbe-skin-editor-code" class="language-markup" style="display:block;white-space:pre;"></code></pre>'
    +       '<textarea id="cbe-skin-editor-ta" spellcheck="false" wrap="off" aria-label="Skin HTML source" style="position:absolute;inset:0;width:100%;height:100%;margin:0;background:transparent;color:transparent;caret-color:#222;border:0;box-sizing:border-box;resize:none;white-space:pre;overflow:auto;outline:none;"></textarea>'
    +     '</div>'
    +     '<div id="cbe-skin-editor-status" role="status" aria-live="polite" style="min-height:16px;font-size:12px;opacity:.85;"></div>'
    +   '</div>'
    +   '<div class="cbe-foot" style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;flex:0 0 auto;box-sizing:border-box;">'
    +     '<button type="button" id="cbe-skin-restore-btn" class="cbe-btn" style="padding:6px 14px;font-size:13px;margin-right:auto;">Restore Original</button>'
    +     '<button type="button" id="cbe-skin-saveas-btn" class="cbe-btn" style="padding:6px 14px;font-size:13px;">Save as New</button>'
    +     '<button type="button" id="cbe-skin-editor-close" class="cbe-btn cbe-cancel" style="padding:6px 14px;font-size:13px;">Close</button>'
    +     '<button type="button" id="cbe-skin-save-btn" class="cbe-btn cbe-save" style="padding:6px 16px;font-size:13px;background:var(--cbe-modal-accent,#2a5d8f);color:#fff;border:1px solid var(--cbe-modal-accent,#2a5d8f);">Save</button>'
    +   '</div>'
    + '</div>';
  document.body.appendChild(overlay);

  /* Light Prism theme + glyph-alignment CSS for the editor (injected from
     panel.js, scoped to .cbe-skin-hl-light so it never recolors the chat
     code blocks which use the dark {{PRISM_CSS_URI}} theme). */
  ensureSkinEditorThemeCss();
  /* Wire the highlight overlay (Prism + caret/scroll sync + Tab). */
  setupSkinEditorHighlight(overlay);

  /* Esc / backdrop close routes through the dirty-guard. */
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skinEditorAttemptClose(); }
  }
  overlay.__cbeOnKey = onKey;
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) skinEditorAttemptClose();
  });

  /* Footer button wiring. */
  const xBtn      = overlay.querySelector('#cbe-skin-editor-x');
  const closeBtn  = overlay.querySelector('#cbe-skin-editor-close');
  const saveBtn   = overlay.querySelector('#cbe-skin-save-btn');
  const saveAsBtn = overlay.querySelector('#cbe-skin-saveas-btn');
  const restoreBtn= overlay.querySelector('#cbe-skin-restore-btn');
  if (xBtn)     xBtn.addEventListener('click', () => skinEditorAttemptClose());
  if (closeBtn) closeBtn.addEventListener('click', () => skinEditorAttemptClose());
  if (saveBtn)  saveBtn.addEventListener('click', () => skinEditorSave());
  if (saveAsBtn) saveAsBtn.addEventListener('click', () => skinEditorSaveAs());
  if (restoreBtn) restoreBtn.addEventListener('click', () => skinEditorRestore());

  if (!id) {
    setSkinEditorStatus('Select a skin first.', true);
    return;
  }
  setSkinEditorStatus('Loading skin source…');
  if (api) api.postMessage({ type: 'getSkinSource', id: id });
}

/* Hard close — removes the modal + listeners with NO dirty-check. Use only
   after the dirty-guard has resolved (or when not dirty). */
function closeSkinEditor() {
  const overlay = skinEditorEl();
  if (overlay) {
    if (overlay.__cbeOnKey) {
      try { document.removeEventListener('keydown', overlay.__cbeOnKey, true); } catch (_) {}
    }
    try { overlay.remove(); } catch (_) {}
  }
  __cbeSkinEditor = { id: '', label: '', original: null };
}

/* Close attempt that honors unsaved changes (TASK 2). When clean, closes
   immediately; when dirty, shows an in-DOM 4-way prompt. */
async function skinEditorAttemptClose() {
  if (!skinEditorIsDirty()) { closeSkinEditor(); return; }
  const choice = await cbeChoice(
    'You have unsaved changes to this skin. What would you like to do?',
    {
      title: 'Unsaved changes',
      buttons: [
        { id: 'save',    label: 'Save',            primary: true },
        { id: 'saveas',  label: 'Save as New' },
        { id: 'discard', label: 'Discard changes' },
        { id: 'cancel',  label: 'Cancel' },
      ],
    });
  if (choice === 'cancel' || choice === null) return;            // stay
  if (choice === 'discard') { closeSkinEditor(); return; }
  if (choice === 'save')   { await skinEditorSave({ closeOnSuccess: true }); return; }
  if (choice === 'saveas') { await skinEditorSaveAs({ closeOnSuccess: true }); return; }
}

/* Save the current skin in place (saveSkin). On the skinSaved reply the
   message handler clears dirty + (if requested) closes. */
function skinEditorSave(opts) {
  const id = __cbeSkinEditor.id;
  const ta = document.getElementById('cbe-skin-editor-ta');
  if (!id || !ta) return;
  __cbeSkinEditor.closeOnSaveOk = !!(opts && opts.closeOnSuccess);
  setSkinEditorStatus('Saving…');
  if (api) api.postMessage({ type: 'saveSkin', id: id, html: ta.value });
}

/* Save-as-New name flow (TASK 3) — validated in-DOM prompt, then
   saveSkinAsNew. closeOnSuccess closes the modal once the host confirms. */
async function skinEditorSaveAs(opts) {
  const id = __cbeSkinEditor.id;
  const ta = document.getElementById('cbe-skin-editor-ta');
  if (!id || !ta) return;
  const name = await cbePromptValidated(
    'Save as New Skin', 'New skin name', '', skinNameValidationError);
  if (name === null) return;                  // cancelled
  __cbeSkinEditor.closeOnSaveOk = !!(opts && opts.closeOnSuccess);
  setSkinEditorStatus('Creating “' + name + '”…');
  if (api) api.postMessage({ type: 'saveSkinAsNew', fromId: id, name: name, html: ta.value });
}

async function skinEditorRestore() {
  const id = __cbeSkinEditor.id;
  if (!id) return;
  const label = __cbeSkinEditor.label || id;
  const ok = await cbeConfirm('This discards your changes to “' + label +
    '” and restores the original. Continue?', { okLabel: 'Restore', title: 'Restore Original' });
  if (!ok) return;
  setSkinEditorStatus('Restoring original…');
  if (api) api.postMessage({ type: 'restoreSkinOriginal', id: id });
}

function setSkinEditorStatus(text, isError) {
  const el = document.getElementById('cbe-skin-editor-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff6b6b' : '';
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
        <span data-i18n="title.help">Codex Black Ed. · Help</span>
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
/* Inline-SVG nag icons. The webview's font has no glyph for 💛/❤️/☕
   (they rendered as tofu boxes), so each card carries a small currentColor
   SVG inserted via innerHTML alongside the title. */
const __nagSvgHeart = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" style="vertical-align:-3px;"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.2 5c2 0 3.3 1.1 4 2.2C9.9 6.1 11.2 5 13.2 5 16.4 5 18 8.4 16.4 11.7 14 16.4 12 21 12 21z"/></svg>';
const __nagSvgCoffee = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M7 4c0 1-1 1-1 2M11 4c0 1-1 1-1 2"/></svg>';
const CBE_NAGS = [
  {
    icon: __nagSvgHeart,
    title: 'Help keep this open-source',
    body:  'Codex Black is free, open source, and built solo. If it makes your day better, a one-time tip on GoFundMe lets me keep shipping features and fixing bugs.',
    cta:   'Open GoFundMe',
    url:   'https://www.gofundme.com/manage/donate-today-to-support-the-creation-of-open-source-tools',
  },
  {
    icon: __nagSvgHeart,
    title: 'Sponsor on GitHub',
    body:  'Prefer recurring? Sponsor me monthly on GitHub. Any tier funds the next sprint — extensions, skins, bridges, the whole stack.',
    cta:   'Open GitHub Sponsors',
    url:   'https://github.com/sponsors/tibberous?preview=true',
  },
  {
    icon: __nagSvgCoffee,
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
          'style="color:var(--cbe-modal-title-fg);"></button>' +
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
   to a CBE account flow (logged-in Claude Code / API key / external docs). */
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
          'style="color:var(--cbe-modal-title-fg);"></button>' +
      '</div>' +
      '<div style="padding:18px 22px;color:var(--cbe-modal-fg,#e7eaef);font:14px/1.55 system-ui,sans-serif;">' +
        '<div style="margin-bottom:6px;">Codex Black Ed. can be used with your Claude subscription or billed based on API usage through your Console account.</div>' +
        '<div style="' + subStyle + '">How do you want to log in?</div>' +
        '<button class="cbe-ap-claude"    type="button" style="' + btnStyle + '">Claude Subscription (logged in)</button>' +
        '<div style="' + subStyle + '">Run the real Claude Code agent on your Claude Pro/Max/Team subscription — same login &amp; billing as Claude Code, no API key.</div>' +
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
    /* Logged-in mode: switch to the real Claude Code agent (claudeCode),
       which rides your Claude Code OAuth subscription — no API key, no
       browser bridge. Just `claude login` once in a terminal if you haven't. */
    if (api) {
      api.postMessage({ type: 'setProvider', provider: 'claudeCode', model: 'claude-sonnet-4-6' });
      api.postMessage({ type: 'info', text: 'Claude (logged in) active — uses your Claude Code subscription. Run `claude login` in a terminal if prompted to authenticate.' });
    }
  });
  /* The "Auto-login all accounts (Vision Pilot)" button was removed along
     with the Claude browser bridge — Claude now uses the Anthropic API or
     the logged-in Claude Code subscription, neither of which needs a
     claude.ai web-login cookie harvest. */
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
          'style="color:var(--cbe-modal-title-fg);"></button>' +
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
        'border-radius:3px;padding:1px 5px;margin-left:6px;">' +
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden="true" style="vertical-align:-1px;margin-right:2px;">' +
        '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Installed</span>'
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
    'extensions for the Codex Black panel. Each is a single <code>.ext</code> ' +
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
      window.__cbePinnedExtensions = window.__cbePinnedExtensions || [];
      const isPinned = window.__cbePinnedExtensions.includes(id);
      const nowPinned = !isPinned;
      /* Optimistic toggle: the host persists to config.ini [extensions] pinned
         (the 1/0 setting) + re-sends, but that only refreshes the toolbar — so
         flip THIS card's button right here or it looks dead ("always pinned"). */
      window.__cbePinnedExtensions = nowPinned
        ? window.__cbePinnedExtensions.concat([id])
        : window.__cbePinnedExtensions.filter((x) => x !== id);
      btn.innerHTML = nowPinned ? CBE_EXT_ICONS.pinned : CBE_EXT_ICONS.pin;
      const t = nowPinned ? cbeT('label.unpin_toolbar', 'Unpin from Toolbar')
                          : cbeT('label.pin_toolbar', 'Pin to Toolbar');
      btn.title = t;
      btn.setAttribute('aria-label', t);
      btn.style.color = nowPinned ? '#ffd84d' : 'var(--cbe-modal-title-fg,#4ea8ff)';
      try { renderPinnedExtensionButtons(); } catch (e) {}
      if (api) api.postMessage({ type: nowPinned ? 'pinExtension' : 'unpinExtension', id });
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
          'style="color:var(--cbe-modal-title-fg);"></button>' +
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

/* Email toolbar button — opens the multi-account inbox panel. Same code
   path as the /email slash command and the codexBlackEd.openEmail VSCode
   command; host handler creates/reveals the email webview. */
(function () {
  const el = document.getElementById('emailBtn');
  if (el) el.addEventListener('click', () => {
    if (api) api.postMessage({ type: 'openEmail' });
  });
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
  { name: '/folder',   desc: 'Pick project folder',      run: () => { if (api) api.postMessage({ type: 'pickProjectFolder' }); } },
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
    if (assetsBase) {
      const base = `${assetsBase}/labels/${encodeURIComponent(lang)}`;
      /* The ORIGINAL (codex-black / no-skin default) shell gets the minimalist
         no-pill label so it sits flush on the black prompt row; every other
         skin keeps the dark-pill label. If a localized `.original` variant is
         missing (only `en` ships one for now) we fall back to the pill label. */
      const skin = String((document.body && document.body.getAttribute('data-skin')) || __cbeActiveSkin || '').trim();
      const isOriginal = (skin === '' || skin === 'codex-black');
      if (isOriginal) {
        brand.onerror = () => { brand.onerror = null; brand.src = `${base}.svg`; };
        brand.src = `${base}.original.svg`;
      } else {
        brand.onerror = null;
        brand.src = `${base}.svg`;
      }
    }
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
    /* Inline progress spinner instead of a ⏳ emoji prefix. Consolas
       (and the webview's monospace stack) has no glyph for U+23F3, so it
       rendered as a tofu box — user 2026-05-22: "magic boxing" / "see that
       square under yo?". An SVG icon + the existing .cbe-spinner animation
       renders crisply with zero font dependency, like the toolbar icons.
       Color convention (Trent 2026-05-27): every busy-indicator is BLUE
       (green is reserved for the VSCode monitor). Was loading_orange.svg. */
    __cbeStatusEl.textContent = '';
    const __ab = String(window.__cbeAssetsBase || '').replace(/\/$/, '');
    if (__ab) {
      const __sp = document.createElement('img');
      __sp.src = __ab + '/loading_blue.svg';
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
  } else if (m.type === 'toolCall') {
    renderToolCall(m);
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
      /* Inline-SVG check/cross prefixes (Consolas has no U+2713/U+2717 glyph
         → tofu). currentColor inherits the button's white text color. */
      const __svgCheck = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true" style="vertical-align:-2px;margin-right:4px;"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const __svgCross = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true" style="vertical-align:-2px;margin-right:4px;"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
      const allowBtn = document.createElement('button');
      allowBtn.type = 'button';
      allowBtn.innerHTML = __svgCheck + 'Allow';
      allowBtn.className = 'cbe-btn';
      allowBtn.style.cssText = 'background:#6a3;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;';
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.innerHTML = __svgCross + 'Deny';
      denyBtn.className = 'cbe-btn';
      denyBtn.style.cssText = 'background:#c33;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;';
      let answered = false;
      const reply = (allow) => {
        if (answered) return;
        answered = true;
        allowBtn.disabled = true;
        denyBtn.disabled = true;
        head.innerHTML = allow ? (__svgCheck + 'Allowed') : (__svgCross + 'Denied');
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
    /* Hydrate persisted voice (TTS / STT) provider + tuning so the panel-side
       speak / dictate paths use the saved values from first paint. */
    if (typeof m.ttsProvider === 'string') window.__cbeTtsProvider = m.ttsProvider;
    if (typeof m.sttProvider === 'string') window.__cbeSttProvider = m.sttProvider;
    if (typeof m.ttsVoice    === 'string') window.__cbeTtsVoice    = m.ttsVoice;
    if (typeof m.ttsRate     === 'number') window.__cbeTtsRate      = m.ttsRate;
    if (typeof m.ttsVolume   === 'number') window.__cbeTtsVolume    = m.ttsVolume;
    if (typeof m.ttsOpenAiVoice === 'string') window.__cbeTtsOpenAiVoice = m.ttsOpenAiVoice;
    if (typeof m.ttsOpenAiSpeed === 'number') window.__cbeTtsOpenAiSpeed = m.ttsOpenAiSpeed;
    if (typeof m.ttsElevenVoice === 'string') window.__cbeTtsElevenVoice = m.ttsElevenVoice;
    if (typeof m.ttsElevenStability  === 'number') window.__cbeTtsElevenStability  = m.ttsElevenStability;
    if (typeof m.ttsElevenSimilarity === 'number') window.__cbeTtsElevenSimilarity = m.ttsElevenSimilarity;
    if (typeof m.sttDictionary === 'string') window.__cbeSttDictionary = m.sttDictionary;
    if (typeof m.sttLanguage   === 'string') window.__cbeSttLanguage   = m.sttLanguage;
    if (typeof m.bigFont    === 'boolean' && window.__cbApplyBig) { window.__cbApplyBig(m.bigFont); }
    /* Apply previously-saved skin on boot. Single-file skins (Phase 0/2) carry
       their CSS + palette inside the already-mounted index.html :root, so the
       host no longer sends skinUri/skinColors (D6). We still stamp the active
       skin id onto <body data-skin> so skin-specific hooks (e.g. tamagotchi's
       body[data-skin="tamagotchi"] pet-dock CSS) match. Legacy CSS-overlay
       skins still arrive with m.skinUri/m.skinColors and use applySkin*. */
    if (typeof m.skin === 'string') __cbeActiveSkin = m.skin;
    stampSkinBody(__cbeActiveSkin);
    if (m.skinUri) applySkinUri(m.skinUri);
    if (m.skinColors) applySkinColors(m.skinColors);
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
    /* LEGACY CSS-overlay skin swap only. Single-file skins (Phase 0/2) are
       remounted host-side via getPanelHtml (the new index.html's :root owns
       the palette), so this message is no longer sent for them — the host
       only posts applySkin when switching between two legacy CSS-overlay
       skins. m.skinUri = styles.css webview URI; m.skinColors = manifest
       palette. applySkinUri also re-stamps <body data-skin>. */
    __cbeActiveSkin = m.skin || '';
    applySkinUri(m.skinUri || '');
    applySkinColors(m.skinColors || null);
  } else if (m.type === 'skinsList') {
    /* Lazy-discovered skin list — populates the dropdown if settings is open. */
    __cbeSkinsList = Array.isArray(m.skins) ? m.skins.slice() : [];
    /* If a "Save as New" just landed, select the freshly-created skin now
       that it's in the list. Setting .value before renderSkinDropdown is
       wiped, so set __cbeActiveSkin (which renderSkinDropdown honors). */
    if (__cbeSkinSelectAfterList) {
      __cbeActiveSkin = __cbeSkinSelectAfterList;
      __cbeSkinSelectAfterList = '';
    }
    renderSkinDropdown();
  } else if (m.type === 'skinSource') {
    /* Host shipped the selected skin's raw index.html. Fill the editor and
       record the loaded text as the dirty-tracking baseline (TASK 2). */
    if (m.id === __cbeSkinEditor.id) {
      if (m.ok) {
        const ta = document.getElementById('cbe-skin-editor-ta');
        const loaded = (typeof m.html === 'string') ? m.html : '';
        if (ta) ta.value = loaded;
        __cbeSkinEditor.original = loaded;   // baseline → editor now clean
        /* Re-tokenise the highlight overlay now that the source has arrived
           (setup ran while the textarea was still empty) and reset scroll. */
        if (typeof renderSkinEditorHighlight === 'function') renderSkinEditorHighlight();
        if (typeof syncSkinEditorScroll === 'function') syncSkinEditorScroll();
        setSkinEditorStatus('Loaded ' + (__cbeSkinEditor.label || m.id) + '.');
      } else {
        setSkinEditorStatus(m.error || 'Failed to load skin source.', true);
      }
    }
  } else if (m.type === 'skinSaved') {
    if (m.id === __cbeSkinEditor.id) {
      if (m.ok) {
        /* Persisted → the textarea is now the clean baseline. */
        const ta = document.getElementById('cbe-skin-editor-ta');
        if (ta) __cbeSkinEditor.original = ta.value;
        setSkinEditorStatus('Saved.' + (m.bak ? ' Backup: ' + m.bak : '') +
          ' Skin remounted live.');
        if (__cbeSkinEditor.closeOnSaveOk) { __cbeSkinEditor.closeOnSaveOk = false; closeSkinEditor(); }
      } else {
        __cbeSkinEditor.closeOnSaveOk = false;
        setSkinEditorStatus(m.error || 'Save failed.', true);
      }
    }
  } else if (m.type === 'skinSavedAsNew') {
    if (m.ok) {
      const wantClose = !!__cbeSkinEditor.closeOnSaveOk;
      __cbeSkinEditor.closeOnSaveOk = false;
      /* The new skin file is a faithful copy of the textarea, so the current
         editor is no longer "dirty" against what's on disk. */
      const ta = document.getElementById('cbe-skin-editor-ta');
      if (ta) __cbeSkinEditor.original = ta.value;
      setSkinEditorStatus('Created new skin “' + (m.newId || '') + '”.');
      /* Refresh dropdown then auto-select the new skin when it arrives. */
      __cbeSkinSelectAfterList = m.newId || '';
      if (api) api.postMessage({ type: 'listSkins' });
      if (wantClose) closeSkinEditor();
    } else {
      __cbeSkinEditor.closeOnSaveOk = false;
      setSkinEditorStatus(m.error || 'Could not create new skin (name in use?).', true);
    }
  } else if (m.type === 'skinRestored') {
    if (m.id === __cbeSkinEditor.id) {
      if (m.ok) {
        setSkinEditorStatus('Original restored. Reloading source…');
        /* Reload the editor textarea from the now-restored file. */
        if (api) api.postMessage({ type: 'getSkinSource', id: m.id });
      } else {
        setSkinEditorStatus(m.error || 'Restore failed.', true);
      }
    }
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
    /* Re-hydrate the voice window state from the fresh payload so the modal's
       value controls (which read window.__cbe*) reflect the persisted values
       even if the panel booted before init landed. */
    if (typeof m.ttsProvider === 'string') window.__cbeTtsProvider = m.ttsProvider;
    if (typeof m.sttProvider === 'string') window.__cbeSttProvider = m.sttProvider;
    if (typeof m.ttsVoice    === 'string') window.__cbeTtsVoice    = m.ttsVoice;
    if (typeof m.ttsRate     === 'number') window.__cbeTtsRate      = m.ttsRate;
    if (typeof m.ttsVolume   === 'number') window.__cbeTtsVolume    = m.ttsVolume;
    if (typeof m.ttsOpenAiVoice === 'string') window.__cbeTtsOpenAiVoice = m.ttsOpenAiVoice;
    if (typeof m.ttsOpenAiSpeed === 'number') window.__cbeTtsOpenAiSpeed = m.ttsOpenAiSpeed;
    if (typeof m.ttsElevenVoice === 'string') window.__cbeTtsElevenVoice = m.ttsElevenVoice;
    if (typeof m.ttsElevenStability  === 'number') window.__cbeTtsElevenStability  = m.ttsElevenStability;
    if (typeof m.ttsElevenSimilarity === 'number') window.__cbeTtsElevenSimilarity = m.ttsElevenSimilarity;
    if (typeof m.sttDictionary === 'string') window.__cbeSttDictionary = m.sttDictionary;
    if (typeof m.sttLanguage   === 'string') window.__cbeSttLanguage   = m.sttLanguage;
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
  /* Picture-icon prefix as inline SVG (🖼 U+1F5BC tofus in the webview font). */
  cap.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true" ' +
          'style="vertical-align:-2px;margin-right:5px;">' +
      '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="8.5" cy="10" r="1.5" fill="currentColor"/>' +
      '<path d="M5 17l4.5-4.5L13 16l3-3 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  cap.appendChild(document.createTextNode(
    (m.providerLabel || m.provider || 'image-gen') + qTxt + (promptTxt ? ' — ' + promptTxt : '')));
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
  label.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true" ' +
          'style="vertical-align:-2px;margin-right:4px;">' +
      '<path d="M16.5 6.5l-7 7a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.4-6.4l-7 7a6.5 6.5 0 0 0 9.2 9.2l6-6" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  label.appendChild(document.createTextNode(name + ' (' + sizeStr + ', ' + mime + ')'));
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
    nameEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true" ' +
            'style="vertical-align:-2px;margin-right:4px;">' +
        '<path d="M16.5 6.5l-7 7a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.4-6.4l-7 7a6.5 6.5 0 0 0 9.2 9.2l6-6" ' +
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    nameEl.appendChild(document.createTextNode(a.name));
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

/* Paste-/drop-to-attach: capture a screenshot or image dropped/pasted into the
   composer and queue it as an image attachment — renders an "image.png" chip
   and ships the data out-of-band via send()'s images[] to vision-capable
   providers. Mirrors the native Claude Code composer. Non-image content falls
   through to default behavior. */
(function wireImageAttach() {
  if (!ti) return;

  function attachImageFile(file) {
    if (!file) return;
    const mime = file.type || 'image/png';
    const ext  = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const fr = new FileReader();
    fr.onload  = () => pushAttachment({
      name: `image.${ext}`, kind: 'image', mime,
      dataUri: fr.result, bytes: file.size || 0,
    });
    fr.onerror = () => { try { console.error('[cbe] image read failed'); } catch (_) {} };
    fr.readAsDataURL(file);
  }

  /* Paste */
  ti.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd || !cd.items) return;
    const files = [];
    for (const it of cd.items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) files.push(it.getAsFile());
    }
    if (!files.length) return;      /* not an image → let the text paste through */
    e.preventDefault();             /* don't dump the blob as garbage text */
    files.forEach(attachImageFile);
  });

  /* Drag-and-drop */
  const dropCue = (on) => { ti.style.boxShadow = on ? 'inset 0 0 0 2px #2b6cb0' : ''; };
  ti.addEventListener('dragover', (e) => { e.preventDefault(); dropCue(true); });
  ti.addEventListener('dragleave', () => dropCue(false));
  ti.addEventListener('drop', (e) => {
    dropCue(false);
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const imgs = Array.from(dt.files).filter(f => /^image\//.test(f.type));
    if (!imgs.length) return;       /* non-image drop → let default handle it */
    e.preventDefault();
    imgs.forEach(attachImageFile);
  });
})();

/* ── Project folder pill ────────────────────────────────────────────────
   The pill IS the project-folder control now (the redundant dock
   projectFolderBtn was removed): click it to pick a folder when none is set,
   or reveal it in the file explorer when one is. A small ✕ clears it. The
   actual picker/reveal/clear lives in extension.js (pickProjectFolder /
   revealProjectFolder / clearProjectFolder); we get back a 'projectFolder'
   message with the chosen fsPath and render it middle-truncated so it never
   widens the toolbar. Re-fits on window resize.
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

/* Project-pill interactivity (user 2026-05-31):
   - click the pill with NO folder set → open the picker (same as the folder btn)
   - click the pill WITH a folder set → reveal it in the OS file explorer
   - a small ✕ at the row's top-right clears the folder → "no project folder"
   The ✕ is a sibling positioned over the pill's corner, NOT a child of
   #project-path (whose text is set via textContent, which would wipe a child).
   Uses an inline <svg> X — a glyph would tofu in the webview. */
(function wireProjectPill() {
  if (!__cbeProjectEl || typeof api === 'undefined' || !api) return;
  __cbeProjectEl.style.cursor = 'pointer';
  __cbeProjectEl.addEventListener('click', () => {
    try { api.postMessage({ type: __cbeProjectFolder ? 'revealProjectFolder' : 'pickProjectFolder' }); } catch (_) {}
  });
  const row = (__cbeProjectEl.closest && __cbeProjectEl.closest('.toolbar-meta')) || __cbeProjectEl.parentElement;
  if (!row) return;
  if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
  const x = document.createElement('button');
  x.type = 'button';
  x.id = '__cbe-project-clear';
  x.title = 'Clear project folder';
  x.setAttribute('aria-label', 'Clear project folder');
  x.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" style="display:block"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
  x.style.cssText = 'position:absolute;top:-7px;right:-7px;width:16px;height:16px;'
    + 'display:none;align-items:center;justify-content:center;padding:0;border-radius:50%;'
    + 'border:1px solid rgba(255,255,255,.55);background:#c0392b;cursor:pointer;z-index:6;';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    try { api.postMessage({ type: 'clearProjectFolder' }); } catch (_) {}
  });
  row.appendChild(x);
  window.__cbeProjectClearBtn = x;
})();

/* Show/hide the clear-✕ whenever the project folder changes. Wraps the
   original setProjectFolder so both the display update + the ✕ toggle stay
   in sync (and the pill's empty-state cursor still makes sense). */
(function () {
  const _origSetProjectFolder = setProjectFolder;
  setProjectFolder = function (p) {
    _origSetProjectFolder(p);
    const x = window.__cbeProjectClearBtn;
    if (x) x.style.display = (p && String(p).trim()) ? 'inline-flex' : 'none';
  };
})();

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
          '<span class="cbe-title">About Codex Black</span>' +
          '<div class="cbe-actions"><button class="cbe-close cbe-x" type="button" aria-label="Close"></button></div>' +
        '</div>' +
        '<div class="cbe-body" style="padding:18px 22px;font-family:inherit;font-size:13.5px;line-height:1.6;">' +
          '<p style="margin:0 0 10px;font-size:15px;"><b>Codex Black Ed.</b></p>' +
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

