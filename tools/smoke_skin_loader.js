/* smoke_skin_loader.js — sanity test for the skin loader changes (2026-05-25).
   Loads extension.js inside a minimal stub of the vscode module so we can call
   resolveSkin() / listSkins() / parseSkinManifest() against the on-disk
   skins/ folder without launching the extension host.

   Run: node tools/smoke_skin_loader.js
*/
'use strict';

const path = require('path');
const fs   = require('fs');
const Module = require('module');

const EXT_ROOT = path.resolve(__dirname, '..');

/* Stub the `vscode` module — extension.js requires it at the top. We only
   need a few things: Uri.file, a no-op window/commands surface, and an
   asWebviewUri that returns a usable URL so listSkins doesn't crash. */
const vscodeStub = {
    Uri: {
        file: (p) => ({
            fsPath: p,
            toString: () => 'file://' + String(p).replace(/\\/g, '/'),
        }),
    },
    ViewColumn:     { Active: 1 },
    Disposable:     class { dispose() {} },
    EventEmitter:   class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    workspace:      { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
    window:         {
        createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve(),
        createWebviewPanel: () => ({ webview: { html: '' } }),
        registerWebviewViewProvider: () => ({ dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        createTerminal: () => ({}),
        terminals: [],
        activeTextEditor: null,
    },
    commands:       { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
    env:            { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    extensions:     { all: [], getExtension: () => undefined },
    languages:      { registerHoverProvider: () => ({ dispose() {} }) },
    Position:       class { constructor(l, c) { this.line = l; this.character = c; } },
    Range:          class { constructor(a, b) { this.start = a; this.end = b; } },
    Selection:      class { constructor(a, b) { this.anchor = a; this.active = b; } },
    TextEdit:       { replace: () => ({}) },
    WorkspaceEdit:  class { replace() {} },
    ProgressLocation: { Notification: 15, Window: 10 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

/* Intercept require('vscode') from inside extension.js. */
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return 'vscode';
    return origResolve.call(this, req, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
    if (req === 'vscode') return vscodeStub;
    return origLoad.call(this, req, parent, ...rest);
};

/* Now load extension.js. activate() is NOT called — we just need the
   exported helpers. extension.js doesn't `module.exports` the skin
   helpers, so we re-evaluate the file in a context where we can capture
   the functions we need. Simpler approach: read the source, find the
   three functions we need, and use a tiny require-cache trick. */

let extPath = path.join(EXT_ROOT, 'extension.js');
let ext;
try {
    ext = require(extPath);
} catch (e) {
    console.error('FAIL: could not load extension.js:', e.message);
    process.exit(1);
}

/* extension.js doesn't export its internals. Pull them out by re-requiring
   the file with a small monkey-patch that exposes them. We do this by
   reading the source, appending `module.exports.__internals = { ... }`,
   writing to a tmp file, and requiring that. */
const src = fs.readFileSync(extPath, 'utf8');
const tmp = path.join(EXT_ROOT, '.smoke_skin_loader.tmp.js');
const exposeLine = `\nmodule.exports.parseSkinManifest = parseSkinManifest;\nmodule.exports.listSkins = listSkins;\nmodule.exports.resolveSkin = resolveSkin;\n`;
fs.writeFileSync(tmp, src + exposeLine, 'utf8');

/* Drop the previous cached extension.js so the tmp variant's helpers are
   reachable. */
delete require.cache[extPath];
let internals;
try {
    internals = require(tmp);
} finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
}

const { parseSkinManifest, listSkins, resolveSkin } = internals;

if (typeof resolveSkin !== 'function' || typeof listSkins !== 'function') {
    console.error('FAIL: resolveSkin / listSkins not exported correctly');
    process.exit(1);
}

/* Fake VSCode extension context — only extensionPath + workspaceState.get
   are used by resolveSkin / listSkins. */
const ctx = {
    extensionPath: EXT_ROOT,
    workspaceState: { get: (k, d) => d, update: () => Promise.resolve() },
};

/* Fake webview — listSkins reads webview.asWebviewUri(uri).toString(). */
const fakeWebview = {
    asWebviewUri: (uri) => ({ toString: () => 'vscode-webview://stub' + (uri.fsPath || '').replace(/\\/g, '/') }),
    cspSource: 'vscode-webview://stub',
};

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { console.log('PASS', label, detail || ''); pass++; }
    else      { console.log('FAIL', label, detail || ''); fail++; }
}

/* ── 1. listSkins returns >=10 entries and includes new+legacy formats ── */
const all = listSkins(ctx, fakeWebview);
check('listSkins returns array', Array.isArray(all), `length=${all.length}`);
check('listSkins finds >=10 skins', all.length >= 10, `count=${all.length}`);

const byName = Object.create(null);
for (const s of all) byName[s.name] = s;

/* ── 2. resolveSkin('gnome') — should hit the LEGACY format (CSS overlay) ── */
const gnome = resolveSkin(ctx, 'gnome');
check('resolveSkin(gnome).name === gnome', gnome.name === 'gnome', `got=${gnome.name}`);
check('resolveSkin(gnome).format === legacy', gnome.format === 'legacy', `format=${gnome.format}`);
check('resolveSkin(gnome).uri is set (CSS)', !!gnome.uri, `uri=${gnome.uri && gnome.uri.fsPath}`);
check('resolveSkin(gnome) no panelHtml', !gnome.panelHtmlPath, `panelHtml=${gnome.panelHtml}`);

/* ── 3. resolveSkin('codex-black') — should prefer the NEW format if it
       exists, else fall through to legacy. After migration this MUST be
       the new format. ── */
const codex = resolveSkin(ctx, 'codex-black');
check('resolveSkin(codex-black).name === codex-black', codex.name === 'codex-black', `got=${codex.name}`);
if (fs.existsSync(path.join(EXT_ROOT, 'skins', 'codex-black.skin'))) {
    check('resolveSkin(codex-black).format === new', codex.format === 'new', `format=${codex.format}`);
    check('resolveSkin(codex-black) has panelHtml', !!codex.panelHtmlPath, `panelHtmlPath=${codex.panelHtmlPath}`);
    check('resolveSkin(codex-black).panelHtml exists on disk', !!codex.panelHtmlPath && fs.existsSync(codex.panelHtmlPath));
} else {
    console.log('SKIP codex-black.skin not yet migrated — running test in legacy mode');
    check('resolveSkin(codex-black).format === legacy', codex.format === 'legacy', `format=${codex.format}`);
}

/* ── 4. resolveSkin('') and unknown id ── */
const empty = resolveSkin(ctx, '');
check('resolveSkin("") → no skin', empty.name === '' && !empty.uri && !empty.panelHtmlPath);
const bogus = resolveSkin(ctx, 'this-skin-does-not-exist');
check('resolveSkin(bogus) → no skin', bogus.name === '' && !bogus.uri);

/* ── 5. path-traversal defence ── */
const trav = resolveSkin(ctx, '../etc/passwd');
check('resolveSkin(traversal) → safe miss', trav.name === '' || trav.name === 'passwd' && !trav.uri,
    `name=${trav.name} uri=${!!trav.uri}`);

/* ── 6. Manifest parse ── */
const m = parseSkinManifest(path.join(EXT_ROOT, 'skins', 'codex-black', 'manifest.xml'));
check('parseSkinManifest reads <id>', m && m.id === 'codex-black', `id=${m && m.id}`);
check('parseSkinManifest reads <accent>', m && /^#/.test(m.accent || ''), `accent=${m && m.accent}`);
check('parseSkinManifest defaults stylesheet', m && m.stylesheet === 'styles.css');
check('parseSkinManifest reads panelHtml field (may be empty)', m && typeof m.panelHtml === 'string');

console.log('');
console.log(`SUMMARY: ${pass} pass / ${fail} fail / ${all.length} skins discovered`);
process.exit(fail ? 1 : 0);
