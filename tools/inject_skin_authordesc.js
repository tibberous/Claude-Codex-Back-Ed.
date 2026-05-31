#!/usr/bin/env node
/* One-shot: recover <author>/<description> from the git d522934 manifests and
   inject them into each <id>.skin/index.html FIRST :root block as
   --cbe-skin-author / --cbe-skin-description (CSS-string-escaped).
   Idempotent: skips a var if it's already present. Run with --dry to preview. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SKINS = path.join(REPO, 'skins');
const DRY = process.argv.includes('--dry');

const IDS = ['aqua-dock','arch','claude-default','codex-black','glassy','gnome',
  'kde','macos-color-dock','mint-dock','office','redhat','tamagotchi',
  'terminal','ubuntu','xfce'];

/* Pull <author>/<description> from the git manifest at d522934. */
function fromGit(id, tag) {
  const xml = execSync(`git show d522934:skins/${id}.skin/manifest.xml`,
    { cwd: REPO, encoding: 'utf8' });
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/* Escape a JS string into a CSS double-quoted string literal. */
function cssStr(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/* Return [start,end) char range of the FIRST :root { ... } block body. */
function firstRootRange(text) {
  const idx = text.indexOf(':root');
  if (idx < 0) return null;
  const open = text.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return [open + 1, i]; }
  }
  return null;
}

let changed = 0;
for (const id of IDS) {
  const file = path.join(SKINS, `${id}.skin`, 'index.html');
  if (!fs.existsSync(file)) { console.error(`MISSING ${file}`); continue; }
  let html = fs.readFileSync(file, 'utf8');
  const range = firstRootRange(html);
  if (!range) { console.error(`NO :root in ${id}`); continue; }
  let body = html.slice(range[0], range[1]);

  const author = fromGit(id, 'author');
  const desc   = fromGit(id, 'description');

  const lines = [];
  if (!/--cbe-skin-author\s*:/.test(body) && author)
    lines.push(`  --cbe-skin-author: ${cssStr(author)};`);
  if (!/--cbe-skin-description\s*:/.test(body) && desc)
    lines.push(`  --cbe-skin-description: ${cssStr(desc)};`);

  if (!lines.length) { console.log(`skip  ${id} (already present)`); continue; }

  /* Insert right after the --cbe-skin-accent declaration if present,
     else at the end of the :root body. */
  const accentRe = /(--cbe-skin-accent\s*:[^;]*;)/;
  if (accentRe.test(body)) {
    body = body.replace(accentRe, `$1\n${lines.join('\n')}`);
  } else {
    body = body.replace(/\s*$/, `\n${lines.join('\n')}\n`);
  }
  const out = html.slice(0, range[0]) + body + html.slice(range[1]);
  if (DRY) {
    console.log(`--- ${id} would add ---\n${lines.join('\n')}`);
  } else {
    fs.writeFileSync(file, out, 'utf8');
    console.log(`OK    ${id}  (+${lines.length} var${lines.length>1?'s':''})`);
  }
  changed++;
}
console.log(`\n${DRY ? 'DRY ' : ''}done — ${changed} file(s) ${DRY ? 'would change' : 'changed'}.`);
