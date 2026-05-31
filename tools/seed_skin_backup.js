#!/usr/bin/env node
/* seed_skin_backup.js — one-shot, idempotent seed of the pristine skin backup.
 *
 * Flat layout (2026-05-31): a skin is ONE file `skins/<id>.html`. This script
 * copies every current `skins/<id>.html` (+ its sibling `skins/<id>-assets/`
 * dir, if present) into `skins-original-backup/<id>.html` (+ `<id>-assets/`)
 * — but ONLY when no pristine copy already exists. Existing backups are NEVER
 * clobbered: the backup is the permanent "Restore Original" source, so a
 * re-run after a skin has been edited must NOT overwrite the factory copy.
 *
 * `skins-original-backup/` is COMMITTED (tracked) — it is the source of truth
 * for Restore Original. `skins/previews/` and `*.bak` are gitignored and are
 * never touched here.
 *
 * Usage:  node tools/seed_skin_backup.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SKINS_DIR = path.join(REPO, 'skins');
const BACKUP_DIR = path.join(REPO, 'skins-original-backup');
const ASSETS_SUFFIX = '-assets';

function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) copyDirRecursive(s, d);
        else if (ent.isFile()) fs.copyFileSync(s, d);
    }
}

function main() {
    if (!fs.existsSync(SKINS_DIR)) {
        console.error(`[seed_skin_backup] no skins dir at ${SKINS_DIR}`);
        process.exit(1);
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    let seeded = 0, skipped = 0, total = 0;
    for (const ent of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith('.html')) continue;
        if (/\.(preview|bak)\b/i.test(ent.name)) continue;
        const id = ent.name.slice(0, -'.html'.length);
        if (!id) continue;
        total++;

        const srcHtml = path.join(SKINS_DIR, ent.name);
        const dstHtml = path.join(BACKUP_DIR, ent.name);
        if (fs.existsSync(dstHtml)) {
            skipped++;
            continue;                       /* pristine copy already exists — never clobber */
        }
        fs.copyFileSync(srcHtml, dstHtml);

        /* Bring along the skin's asset dir, if any. */
        const srcAssets = path.join(SKINS_DIR, `${id}${ASSETS_SUFFIX}`);
        if (fs.existsSync(srcAssets) && fs.statSync(srcAssets).isDirectory()) {
            copyDirRecursive(srcAssets, path.join(BACKUP_DIR, `${id}${ASSETS_SUFFIX}`));
        }
        seeded++;
        console.log(`[seed_skin_backup] seeded ${id}`);
    }

    const haveBackups = fs.readdirSync(BACKUP_DIR)
        .filter(n => n.endsWith('.html') && !/\.(preview|bak)\b/i.test(n)).length;
    console.log(`[seed_skin_backup] done — ${seeded} seeded, ${skipped} already present, ` +
                `${total} skins on disk, ${haveBackups} backups total in skins-original-backup/`);
}

main();
