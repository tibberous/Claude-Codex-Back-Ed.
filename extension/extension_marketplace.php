<?php
/*
 * extension_marketplace.php — HTML marketplace UI for Claude Codex Black.
 *
 * Lives at /home/trentontompkins.com/cbe/extension/extension_marketplace.php.
 * The CBE panel embeds this page in an iframe modal when the user clicks
 * the Extensions / Marketplace button.
 *
 * What it does:
 *   1. Fetches the sibling extensions.xml.php catalog.
 *   2. Renders each extension as a card with metadata + Install button.
 *   3. Install button posts a message to window.parent:
 *        { type: "cbe.installExtension", id, file, md5, bytes, name, version, url }
 *      The CBE panel listens for this message and downloads the .ext file
 *      to the user's local extension store (handled in extension.js).
 *
 * The PHP itself only serves the static HTML/CSS/JS shell — all dynamic
 * data is fetched client-side from extensions.xml.php so the marketplace
 * updates as the catalog updates without re-deploying this file.
 */

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');

// Self-relative URL of the catalog so this works regardless of host.
$catalogUrl = 'extensions.xml.php';
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CBE Extension Marketplace</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #1c1f24;
    --surface: #23262e;
    --surface2: #2b313b;
    --border: #3a414c;
    --text: #e7eaef;
    --muted: #b9bec7;
    --accent: #4ea8ff;
    --accent-bg: #173050;
    --ok: #6fd58a;
    --err: #ff8a8a;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
               font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 16px 18px; border-bottom: 1px solid var(--border);
           display: flex; align-items: center; justify-content: space-between; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.01em; }
  header .meta { color: var(--muted); font-size: 12px; }
  #search { display: block; width: calc(100% - 36px); margin: 14px 18px;
            padding: 8px 12px; background: var(--surface); color: var(--text);
            border: 1px solid var(--border); border-radius: 6px; font: 14px ui-monospace; }
  .grid { display: grid; gap: 12px; padding: 0 18px 24px 18px;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
          padding: 14px; display: flex; flex-direction: column; gap: 8px; }
  .card h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .card .sub { color: var(--muted); font-size: 12px; }
  .card .desc { font-size: 13px; color: var(--text); flex-grow: 1; min-height: 36px; }
  .card .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { background: var(--surface2); color: var(--muted); border: 1px solid var(--border);
         border-radius: 4px; padding: 2px 6px; font-size: 11px; }
  .card .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .card .bytes { color: var(--muted); font-size: 11px; font-family: ui-monospace; }
  button.install { background: var(--accent-bg); color: var(--accent);
                   border: 1px solid var(--accent); border-radius: 6px;
                   padding: 6px 12px; font: 13px ui-monospace; cursor: pointer; }
  button.install:hover { background: var(--accent); color: #0f1116; }
  button.install:disabled { opacity: 0.5; cursor: default; }
  button.install.installed { background: transparent; color: var(--ok); border-color: var(--ok); }
  #empty, #err { padding: 32px 18px; text-align: center; color: var(--muted); }
  #err { color: var(--err); }
  #toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
           background: var(--surface2); color: var(--text); padding: 8px 14px;
           border: 1px solid var(--border); border-radius: 6px; font: 12px ui-monospace;
           opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; }
  .intro { padding: 14px 18px 4px 18px; color: var(--muted); font-size: 13px;
           border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .intro p { margin: 0 0 8px 0; }
  .intro p:last-child { margin-bottom: 12px; }
  .intro a { color: var(--accent); }
  .byline { font: 12px ui-monospace; }
  .byline a { margin: 0 4px; }
  .cta { background: rgba(78,168,255,0.08); border-left: 3px solid var(--accent);
         padding: 8px 12px; border-radius: 0 4px 4px 0; color: var(--text);
         font-size: 13px; }
  .cta a { color: var(--accent); font-weight: 600; }
  footer { margin-top: 32px; padding: 16px 18px 24px 18px; border-top: 1px solid var(--border);
           color: var(--muted); font-size: 12px; display: flex; justify-content: space-between;
           gap: 16px; flex-wrap: wrap; }
  footer .credit { font: 11px ui-monospace; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Claude Codex — Black Edition · Marketplace</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<div class="intro">
  <p>Browse, install, and update third-party extensions for the Claude Codex Black panel.
  Every extension is a single <code>.ext</code> bundle — manifest plus a self-contained UI —
  so installs are atomic and fully sandboxed inside the panel's iframe. Click <strong>Install</strong>
  on any card and your CBE panel will pull the latest version straight from this server.</p>
  <p class="byline">
    Curated by <a href="https://trentontompkins.com" target="_blank" rel="noopener">Trenton Tompkins</a>
    · <a href="https://github.com/tibberous" target="_blank" rel="noopener">github.com/tibberous</a>
  </p>
  <p class="cta">
    Call <a href="tel:+17244315207">(724) 431-5207</a>
    or email <a href="mailto:TrentTompkins@gmail.com">TrentTompkins@gmail.com</a>
    to discuss your next project!
  </p>
</div>
<input id="search" placeholder="search extensions, tags, authors…">
<div id="grid" class="grid"></div>
<div id="empty" hidden>No extensions found.</div>
<div id="err" hidden></div>
<div id="toast"></div>
<footer>
  <span>Want to publish your own extension? Package it as a <code>.ext</code> bundle
  (zip containing <code>manifest.xml</code> + your UI) and email it.</span>
  <span class="credit">Coded by Claude Sonnet 4.6 · MIT-licensed · &copy; 2026 Trenton Tompkins</span>
</footer>
<script>
(function () {
  const CATALOG_URL = <?= json_encode($catalogUrl) ?>;
  // Same origin as this page (the iframe). Each Install button advertises
  // its file URL absolutely so the parent extension can fetch directly.
  const BASE = new URL('.', window.location.href).href; // ends with /
  const grid = document.getElementById('grid');
  const meta = document.getElementById('meta');
  const search = document.getElementById('search');
  const empty = document.getElementById('empty');
  const errBox = document.getElementById('err');
  const toast = document.getElementById('toast');
  let allExtensions = [];

  function toastMsg(text) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1600);
  }

  function render(filter) {
    grid.innerHTML = '';
    const q = (filter || '').toLowerCase().trim();
    const matched = q
      ? allExtensions.filter(e => {
          const blob = [
            e.id, e.name, e.author, e.description,
            (e.tags || []).join(' ')
          ].join(' ').toLowerCase();
          return blob.includes(q);
        })
      : allExtensions.slice();
    if (!matched.length) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const ext of matched) {
      const card = document.createElement('div');
      card.className = 'card';
      const fileUrl = BASE + 'extensions/' + (ext.file || (ext.id + '.ext'));
      const sizeKB = ext.bytes ? (ext.bytes / 1024).toFixed(1) + ' KB' : '';
      card.innerHTML = `
        <h3>${escapeHtml(ext.name)} <span class="sub">v${escapeHtml(ext.version)}</span></h3>
        <div class="sub">by ${escapeHtml(ext.author || 'unknown')}${ext.created ? ' · ' + escapeHtml(ext.created) : ''}</div>
        <div class="desc">${escapeHtml(ext.description || '')}</div>
        <div class="tags">${(ext.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="row">
          <span class="bytes">${escapeHtml(sizeKB)}${ext.md5 ? ' · md5:' + escapeHtml(ext.md5.slice(0, 8)) + '…' : ''}</span>
          <button class="install" data-id="${escapeHtml(ext.id)}">Install</button>
        </div>
      `;
      const btn = card.querySelector('button.install');
      btn.onclick = () => {
        // Disable while in flight; the parent panel will postMessage back
        // with installResult so we can flip to "Installed".
        btn.disabled = true;
        btn.textContent = 'Installing…';
        const payload = {
          type: 'cbe.installExtension',
          id: ext.id,
          file: ext.file || (ext.id + '.ext'),
          fileUrl,
          md5: ext.md5 || '',
          bytes: ext.bytes || 0,
          name: ext.name,
          version: ext.version,
          author: ext.author || '',
          url: ext.url || '',
        };
        try {
          window.parent.postMessage(payload, '*');
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Install';
          toastMsg('install failed: ' + (e.message || e));
        }
      };
      grid.appendChild(card);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Parse the XML catalog into a plain JS array.
  function parseCatalog(xmlText) {
    const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
    const items = Array.from(dom.querySelectorAll('extension'));
    return items.map(node => {
      const attr = (k) => node.getAttribute(k) || '';
      const text = (sel) => {
        const el = node.querySelector(sel);
        return el ? (el.textContent || '').trim() : '';
      };
      return {
        id:          attr('id'),
        version:     attr('version'),
        name:        attr('name'),
        author:      attr('author'),
        created:     attr('created'),
        file:        attr('file'),
        md5:         attr('md5'),
        bytes:       parseInt(attr('bytes') || '0', 10) || 0,
        min_core:    attr('min_core'),
        description: text('description'),
        url:         text('url'),
        entry:       text('entry'),
        tags:        Array.from(node.querySelectorAll('tag')).map(t => (t.textContent || '').trim()),
      };
    });
  }

  // Listen for install-result echoes from the parent panel so the button
  // visually flips to a checkmark/Installed state after a successful copy.
  window.addEventListener('message', (event) => {
    const m = event.data || {};
    if (m && m.type === 'cbe.installResult' && m.id) {
      const btn = grid.querySelector('button.install[data-id="' + CSS.escape(m.id) + '"]');
      if (!btn) return;
      btn.disabled = m.ok !== false ? true : false;
      btn.textContent = m.ok !== false ? '✓ Installed' : 'Install';
      if (m.ok !== false) btn.classList.add('installed');
      toastMsg((m.ok !== false ? 'Installed: ' : 'Install failed: ') + (m.name || m.id));
    }
  });

  fetch(CATALOG_URL, { cache: 'no-store' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(text => {
      allExtensions = parseCatalog(text);
      meta.textContent = allExtensions.length + ' extension(s)';
      render('');
    })
    .catch(err => {
      errBox.hidden = false;
      errBox.textContent = 'Catalog fetch failed: ' + (err.message || err);
      meta.textContent = 'error';
    });

  search.addEventListener('input', () => render(search.value));
})();
</script>
</body>
</html>
