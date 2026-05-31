/* colors_xml_to_html.js — Phase 0 single-file cutover migration.
 *
 * Moves each skin's modal palette from `<id>.skin/manifest.xml <colors>`
 * into that skin's OWN `index.html` `:root` so the skin HTML is fully
 * self-contained (no XML, no runtime color push). Also injects
 * `--cbe-skin-name` + `--cbe-skin-accent` custom properties so the loader
 * can read the picker label + accent straight from `:root` without parsing
 * the CSS body or any XML.
 *
 * Target: the FIRST `:root { ... }` block in each index.html — the one that
 * carries the codex-black orange `--cbe-modal-*` DEFAULTS (aqua-dock lines
 * 44-60). We rewrite the value of each `--cbe-modal-*` / `--cbe-highlight-color`
 * / `--cbe-code-bar-*` declaration already present there to the manifest's
 * value, leaving any var()-chained defaults alone when the manifest omits a
 * color. New `--cbe-skin-name`/`--cbe-skin-accent` lines are appended just
 * before the closing brace of that block.
 *
 * Idempotent: re-running re-reads the manifest and re-writes the same values.
 * Once verified, manifest.xml + styles.css get deleted (Phase 0 step 4) and
 * the loader stops reading them (Phase 2).
 *
 * Usage:  node tools/colors_xml_to_html.js          (writes)
 *         node tools/colors_xml_to_html.js --dry     (report only)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKINS_DIR = path.join(REPO_ROOT, 'skins');
const DRY = process.argv.includes('--dry');

/* manifest <colors> tag -> the CSS custom property it maps to.
   Mirrors applySkinColors() @ panel.js 2400-2412 exactly. */
const COLOR_MAP = {
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

function pickXml(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/* Find the byte range of the FIRST top-level `:root {` block in the HTML
   (the head <style> defaults block). Returns {start, end, body} where
   start/end bracket the inner text between the braces, or null. */
function firstRootBlock(html) {
  const idx = html.indexOf(':root');
  if (idx < 0) return null;
  const open = html.indexOf('{', idx);
  if (open < 0) return null;
  /* The defaults block has no nested braces, but be defensive: walk to the
     matching close brace. */
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return { start: open + 1, end: i, body: html.slice(open + 1, i) };
      }
    }
  }
  return null;
}

function escapeReVar(name) {
  return name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

function migrate(skinDir) {
  const id = path.basename(skinDir).replace(/\.skin$/, '');
  const idxPath = path.join(skinDir, 'index.html');
  const manPath = path.join(skinDir, 'manifest.xml');
  if (!fs.existsSync(idxPath) || !fs.existsSync(manPath)) {
    return { id, status: 'skip', reason: 'missing index.html or manifest.xml' };
  }
  const xml = fs.readFileSync(manPath, 'utf8');
  const name = pickXml(xml, 'name') || id;
  const accent = pickXml(xml, 'accent') || '';
  const colors = {};
  for (const tag of Object.keys(COLOR_MAP)) {
    const v = pickXml(xml, tag);
    if (v) colors[tag] = v;
  }

  let html = fs.readFileSync(idxPath, 'utf8');
  const block = firstRootBlock(html);
  if (!block) return { id, status: 'error', reason: 'no :root block found' };

  let body = block.body;
  const changed = [];

  /* 1) Rewrite the value of each --cbe-* declaration already present in the
        block to the manifest color. We only touch declarations the manifest
        actually supplies, so var()-chained defaults (code-bar fallbacks) are
        preserved when the manifest omits them. */
  for (const [tag, cssVar] of Object.entries(COLOR_MAP)) {
    if (!colors[tag]) continue;
    const re = new RegExp(`(${escapeReVar(cssVar)}\\s*:\\s*)([^;]*)(;)`);
    if (re.test(body)) {
      body = body.replace(re, `$1${colors[tag]}$3`);
      changed.push(cssVar);
    } else {
      /* Not present — append it (rare; all 15 carry the defaults block). */
      body = body.replace(/\s*$/, `\n  ${cssVar}: ${colors[tag]};\n`);
      changed.push(cssVar + '(added)');
    }
  }

  /* 2) Inject/refresh --cbe-skin-name + --cbe-skin-accent metadata props so
        the loader can read label/accent from :root. Use a quoted string for
        the name (CSS custom-property values are token streams; quote to keep
        spaces/punctuation intact for the JS reader). */
  const nameVal = `"${name.replace(/"/g, '\\"')}"`;
  const metaLines =
    `\n  /* ── Phase-0 single-file metadata (read by the skin loader; replaces manifest.xml) ── */` +
    `\n  --cbe-skin-name:   ${nameVal};` +
    (accent ? `\n  --cbe-skin-accent: ${accent};` : '') + `\n`;

  /* Remove any prior metadata we injected (idempotent re-run). */
  body = body.replace(/\n\s*\/\* ── Phase-0 single-file metadata[\s\S]*?(?=\n\s*--cbe-skin-name|$)/, '');
  body = body.replace(/\n\s*--cbe-skin-name:\s*[^;]*;/g, '');
  body = body.replace(/\n\s*--cbe-skin-accent:\s*[^;]*;/g, '');
  /* Trim a trailing newline-run then append meta + one newline before close. */
  body = body.replace(/\s*$/, '\n');
  body = body + metaLines;

  const newHtml = html.slice(0, block.start) + body + html.slice(block.end);
  if (newHtml === html) return { id, status: 'nochange', changed };
  if (!DRY) fs.writeFileSync(idxPath, newHtml, 'utf8');
  return { id, status: DRY ? 'would-write' : 'written', changed, name, accent };
}

function main() {
  const entries = fs.readdirSync(SKINS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.endsWith('.skin'))
    .map(e => path.join(SKINS_DIR, e.name))
    .sort();
  let ok = 0, err = 0;
  for (const dir of entries) {
    const r = migrate(dir);
    if (r.status === 'error') { err++; console.log(`[colors] ERROR ${r.id}: ${r.reason}`); continue; }
    if (r.status === 'skip')  { console.log(`[colors] skip  ${r.id}: ${r.reason}`); continue; }
    ok++;
    console.log(`[colors] ${r.status.padEnd(11)} ${r.id.padEnd(20)} name=${JSON.stringify(r.name)} accent=${r.accent || '-'} (${(r.changed || []).length} vars)`);
  }
  console.log(`\n[colors] done: ${ok} migrated, ${err} errored, ${entries.length} skins`);
  process.exit(err ? 1 : 0);
}

main();
