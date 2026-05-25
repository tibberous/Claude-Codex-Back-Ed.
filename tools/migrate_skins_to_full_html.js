/* migrate_skins_to_full_html.js — convert legacy `skins/<name>/` CSS-overlay
   skins to the new full-HTML-per-skin format at `skins/<name>.skin/`.

   For each legacy skin:
     1. Mkdir `skins/<name>.skin/`.
     2. Copy manifest.xml + add <panelHtml>index.html</panelHtml>.
     3. Build `index.html` = clone of panel/index.html with the legacy
        styles.css inlined into a <style> tag near the end of <head>
        (so the skin's rules win the cascade over the inline defaults).
        Any `url('foo')` references inside the inlined CSS are rewritten
        to `url('{{SKIN_BASE}}/foo')` so the skin's local assets (icons/,
        wallpaper.png, fonts/) resolve when the webview mounts the HTML.
     4. Copy `assets/`, `icons/`, `wallpaper.png` over so the URLs in
        step 3 actually point at real files inside the new .skin/ folder.

   Run: node tools/migrate_skins_to_full_html.js [--all | <name>]

   Idempotent: rerunning overwrites the generated index.html + manifest.xml
   but leaves any human edits in the .skin/ folder untouched if they don't
   collide with one of those two filenames.

   Legacy folders are NEVER deleted — the loader prefers .skin/ but falls
   back to legacy so back-compat is preserved.
*/
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SKINS_DIR = path.join(ROOT, 'skins');
const PANEL_HTML_PATH = path.join(ROOT, 'panel', 'index.html');

if (!fs.existsSync(PANEL_HTML_PATH)) {
    console.error('FAIL: panel/index.html not found at', PANEL_HTML_PATH);
    process.exit(1);
}

const panelHtml = fs.readFileSync(PANEL_HTML_PATH, 'utf8');

function listLegacySkins() {
    const out = [];
    for (const ent of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (ent.name.endsWith('.skin')) continue;   /* skip already-new */
        const manifest = path.join(SKINS_DIR, ent.name, 'manifest.xml');
        if (!fs.existsSync(manifest)) continue;
        out.push(ent.name);
    }
    return out.sort();
}

function copyDirRecursive(src, dst) {
    if (!fs.existsSync(src)) return 0;
    let copied = 0;
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const sp = path.join(src, ent.name);
        const dp = path.join(dst, ent.name);
        if (ent.isDirectory()) {
            copied += copyDirRecursive(sp, dp);
        } else if (ent.isFile()) {
            fs.copyFileSync(sp, dp);
            copied++;
        }
    }
    return copied;
}

function copyFileIfExists(src, dst) {
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, dst);
    return true;
}

/* Rewrite manifest XML — add <panelHtml>index.html</panelHtml> if absent.
   Done with a minimal regex/string approach to preserve formatting +
   comments. */
function rewriteManifest(srcXml) {
    if (/<panelHtml\s*>/i.test(srcXml) || /<panel-html\s*>/i.test(srcXml)) {
        return srcXml;   /* already has it */
    }
    /* Insert just before the closing </skin> tag. */
    const insertion = '  <panelHtml>index.html</panelHtml>\n';
    if (/<\/skin>\s*$/i.test(srcXml)) {
        return srcXml.replace(/<\/skin>\s*$/i, insertion + '</skin>\n');
    }
    /* Fallback: append. */
    return srcXml.trim() + '\n' + insertion;
}

/* Rewrite url(...) refs inside CSS so relative paths point at the skin's
   own asset folder (now living inside <name>.skin/). Absolute URLs and
   data: URIs are left alone. */
function rewriteCssUrls(css) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
        if (/^(data:|https?:|file:|vscode-webview:|\/\/|\{\{)/i.test(ref)) return m;
        if (ref.startsWith('/')) return m;
        return `url(${q}{{SKIN_BASE}}/${ref}${q})`;
    });
}

/* Build the skin's index.html. Strategy: take panel/index.html verbatim,
   and inject an extra <style data-cbe-skin="<name>"> block immediately
   before </head> containing the (URL-rewritten) skin CSS. This way the
   skin's rules win the cascade (later in document order) without needing
   to touch the original inline style block. */
function buildSkinIndexHtml(skinName, skinCss) {
    const rewritten = rewriteCssUrls(skinCss);
    const styleBlock =
        `\n<!-- CBE skin "${skinName}" (auto-migrated to full-HTML format ` +
        new Date().toISOString().slice(0, 10) + `).\n` +
        `     This block was inlined from skins/${skinName}/styles.css; url(...)\n` +
        `     refs were rewritten to use {{SKIN_BASE}} so the skin's own assets\n` +
        `     (icons/, wallpaper.png, fonts/) resolve from the .skin/ folder. -->\n` +
        `<style data-cbe-skin="${skinName}">\n` +
        rewritten +
        `\n</style>\n`;
    /* Insert before the first </head> tag. */
    const idx = panelHtml.search(/<\/head\s*>/i);
    if (idx < 0) {
        throw new Error('panel/index.html has no </head> — cannot inject skin block');
    }
    return panelHtml.slice(0, idx) + styleBlock + panelHtml.slice(idx);
}

function migrate(name) {
    const srcDir = path.join(SKINS_DIR, name);
    const dstDir = path.join(SKINS_DIR, name + '.skin');
    if (!fs.existsSync(srcDir)) {
        return { name, ok: false, reason: 'source not found' };
    }
    const srcManifest = path.join(srcDir, 'manifest.xml');
    if (!fs.existsSync(srcManifest)) {
        return { name, ok: false, reason: 'manifest.xml missing' };
    }
    const srcStyles = path.join(srcDir, 'styles.css');
    if (!fs.existsSync(srcStyles)) {
        return { name, ok: false, reason: 'styles.css missing' };
    }

    fs.mkdirSync(dstDir, { recursive: true });

    /* 1. Manifest with <panelHtml> field. */
    const manifestXml = rewriteManifest(fs.readFileSync(srcManifest, 'utf8'));
    fs.writeFileSync(path.join(dstDir, 'manifest.xml'), manifestXml, 'utf8');

    /* 2. Carry forward styles.css verbatim (so the new format has a
          separate file too — convenient for skin authors who want to
          tweak it without re-editing index.html). */
    fs.copyFileSync(srcStyles, path.join(dstDir, 'styles.css'));

    /* 3. Asset folders / loose files. */
    let assetCount = 0;
    for (const sub of ['assets', 'icons', 'fonts', 'images']) {
        const subSrc = path.join(srcDir, sub);
        if (fs.existsSync(subSrc)) {
            assetCount += copyDirRecursive(subSrc, path.join(dstDir, sub));
        }
    }
    for (const loose of ['wallpaper.png', 'wallpaper.jpg', 'background.png', 'background.jpg']) {
        if (copyFileIfExists(path.join(srcDir, loose), path.join(dstDir, loose))) assetCount++;
    }

    /* 4. The mounted HTML. */
    const indexHtml = buildSkinIndexHtml(name, fs.readFileSync(srcStyles, 'utf8'));
    fs.writeFileSync(path.join(dstDir, 'index.html'), indexHtml, 'utf8');

    return { name, ok: true, dst: dstDir, assetCount, indexBytes: indexHtml.length };
}

function main() {
    const args = process.argv.slice(2);
    const wantAll = args.length === 0 || args.includes('--all');
    const explicit = args.filter(a => !a.startsWith('--'));
    const targets = wantAll ? listLegacySkins() : explicit;
    if (targets.length === 0) {
        console.error('No skins to migrate.');
        process.exit(1);
    }
    let ok = 0, fail = 0;
    for (const name of targets) {
        try {
            const r = migrate(name);
            if (r.ok) {
                console.log(`OK   ${name} -> ${path.relative(ROOT, r.dst)}  (assets=${r.assetCount}, html=${r.indexBytes}B)`);
                ok++;
            } else {
                console.log(`SKIP ${name} (${r.reason})`);
                fail++;
            }
        } catch (e) {
            console.log(`FAIL ${name} : ${e.message}`);
            fail++;
        }
    }
    console.log(`\nMigrated ${ok} ok, ${fail} skipped/failed (of ${targets.length} attempted).`);
    process.exit(fail ? 1 : 0);
}

main();
