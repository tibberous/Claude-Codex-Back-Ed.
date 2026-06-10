#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   cbe — Codex Black Ed. command-line interface
   Trenton Tompkins <trenttompkins@gmail.com> — MIT (see license.txt)

   "Everything you can do through the UI, doable through the CLI."

   ── Architecture (per-command standalone vs. live-extension) ──────────────
   Some actions are pure and need nothing running: print the version, TCP-probe
   a bridge port, run a git subcommand, pop a native save dialog. Those run
   STANDALONE inside this process.

   Other actions depend on the UI's *live state* — which provider is active,
   the current in-memory conversation, the auto-update push wired to config.ini
   — so they must talk to the RUNNING extension. extension.js hosts a tiny
   localhost HTTP control server (127.0.0.1:CONTROL_PORT, default 57838); those
   commands POST to it. If the extension isn't running, those commands say so
   and exit non-zero rather than silently re-running cold logic.

   Per-command path is documented on each handler below.

   Dependencies: Node.js built-ins ONLY (net, http, child_process, fs, path,
   os). No npm install needed. The native save dialog (recv) shells out to
   Windows PowerShell's System.Windows.Forms.SaveFileDialog.
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

/* ── Shared constants ──────────────────────────────────────────────────────
   BRIDGE_PORTS mirrors extension.js:92 / start.py:187 — single source of truth
   for the TCP line-protocol bridges. If those move, update here too. */
const BRIDGE_PORTS = {
    chatgpt:  8788,
    grok:     8789,
    copilot:  8790,
    gemini:   8791,
    /* claude web bridge removed — Anthropic API + logged-in Claude Code only. */
    ollama:   8793,
    deepseek: 8794,
};
const BRIDGE_DEFAULT_MODEL = {
    chatgpt:  'gpt-4o',
    grok:     'grok-4',
    copilot:  'gpt-4',
    gemini:   'gemini-2.5-pro',
    ollama:   'llama3.2:3b',
    deepseek: 'deepseek-chat',
};
/* Control server the running extension exposes (extension.js:startCliControlServer).
   127.0.0.1:57838 — chosen clear of claude-voice (57834/57835) and CBE's own
   ctrl/log ports (57835/57836/57837/57844). Overridable via $CBE_CONTROL_PORT. */
const CONTROL_PORT = Number(process.env.CBE_CONTROL_PORT) || 57838;
const CONTROL_HOST = '127.0.0.1';

/* The extension root is the parent of this cli/ folder. */
const EXT_ROOT = path.resolve(__dirname, '..');

/* ── Tiny output helpers ──────────────────────────────────────────────────── */
function out(s) { process.stdout.write(String(s)); }
function outln(s) { process.stdout.write(String(s == null ? '' : s) + '\n'); }
function errln(s) { process.stderr.write(String(s == null ? '' : s) + '\n'); }
function die(msg, code) { errln('cbe: ' + msg); process.exit(code == null ? 1 : code); }

/* ── package.json version (STANDALONE) ─────────────────────────────────────── */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
        return pkg.version || '(unknown)';
    } catch (e) {
        return '(unreadable: ' + (e.message || e) + ')';
    }
}

/* ── HTTP client to the running extension's control server ──────────────────
   Returns a Promise. On connection refused (extension not running) the caller
   gets a clear ECONNREFUSED so it can print a helpful hint. */
function controlRequest(method, urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
        const req = http.request({
            host: CONTROL_HOST,
            port: CONTROL_PORT,
            method,
            path: urlPath,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
                : {},
            timeout: 300000,
        }, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                let json = null;
                try { json = buf ? JSON.parse(buf) : {}; } catch (e) { json = { __raw: buf }; }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('control-server request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

/* NDJSON-streaming request to the control server (used by /chat). Calls
   onLine(obj) for each parsed JSON line as it arrives, then resolves. */
function controlStream(urlPath, bodyObj, onLine) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
        const req = http.request({
            host: CONTROL_HOST,
            port: CONTROL_PORT,
            method: 'POST',
            path: urlPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
            timeout: 300000,
        }, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let obj = null;
                    try { obj = JSON.parse(line); } catch (e) { obj = { type: 'raw', text: line }; }
                    onLine(obj);
                }
            });
            res.on('end', () => {
                const tail = buf.trim();
                if (tail) { try { onLine(JSON.parse(tail)); } catch (_) { onLine({ type: 'raw', text: tail }); } }
                resolve({ status: res.statusCode });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('chat stream timed out')));
        req.write(payload);
        req.end();
    });
}

function extensionNotRunningHint() {
    return 'the CBE extension is not running (or its control server on '
        + `${CONTROL_HOST}:${CONTROL_PORT} is unreachable). Open VS Code with the `
        + 'Codex Black extension active, then retry. '
        + '(Set $CBE_CONTROL_PORT if you changed the port.)';
}

/* ── Bridge TCP probe + send (STANDALONE) ───────────────────────────────────
   Bridges speak newline-delimited JSON over TCP. Probe = open + immediate
   close. Send = write one {"action":"chat",...}\n line, read one JSON line. */
function probeBridge(port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let settled = false;
        const finish = (up) => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} resolve(up); };
        sock.setTimeout(timeoutMs || 800);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(port, '127.0.0.1'); } catch (e) { finish(false); }
    });
}

function bridgeChat(target, message, model, timeoutMs) {
    return new Promise((resolve, reject) => {
        const port = BRIDGE_PORTS[target];
        const payload = JSON.stringify({
            action: 'chat',
            target,
            message,
            model: model || BRIDGE_DEFAULT_MODEL[target] || '',
        }) + '\n';
        const sock = new net.Socket();
        let body = '';
        let settled = false;
        const fail = (err) => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} reject(err); };
        sock.setTimeout(timeoutMs || 240000);
        sock.on('connect', () => sock.write(payload));
        sock.on('data', (c) => { body += c.toString('utf8'); });
        sock.on('end', () => {
            if (settled) return;
            const line = body.split('\n').find((s) => s.trim().length > 0) || '';
            let data = null;
            try { data = JSON.parse(line); } catch (_) { /* fall through */ }
            if (data && data.ok && typeof data.answer === 'string') { settled = true; resolve(data.answer); }
            else {
                const detail = (data && (data.error || data.err)) || line.slice(0, 300) || '(empty response)';
                fail(new Error(detail));
            }
        });
        sock.on('timeout', () => fail(new Error(`bridge ${target} timed out after ${(timeoutMs || 240000) / 1000}s`)));
        sock.on('error', (e) => fail(new Error(
            `bridge ${target} not reachable on port ${port} — ${e.message}. `
            + `Start CBE-Bridge-${target}.exe (in bin/) or check: netstat -ano | findstr ${port}`)));
        try { sock.connect(port, '127.0.0.1'); } catch (e) { fail(e); }
    });
}

/* ── Native save dialog (STANDALONE, Windows) ───────────────────────────────
   Pops a real SaveFileDialog via PowerShell + System.Windows.Forms. Returns the
   chosen absolute path, or '' if the user cancelled. On non-Windows we fall back
   to writing into the cwd with the suggested name (no dialog available). */
function nativeSaveDialog(suggestedName) {
    if (process.platform !== 'win32') {
        return path.resolve(process.cwd(), suggestedName || 'cbe-download');
    }
    const safeName = String(suggestedName || 'cbe-download').replace(/'/g, "''");
    const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.SaveFileDialog;',
        "$d.Title = 'CBE — Save received file';",
        `$d.FileName = '${safeName}';`,
        "$d.Filter = 'All files (*.*)|*.*';",
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
    ].join(' ');
    const res = spawnSync('powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', ps],
        { encoding: 'utf8', windowsHide: true });
    if (res.error) { errln('cbe: save dialog failed: ' + res.error.message); return ''; }
    return String(res.stdout || '').trim();
}

/* ─────────────────────────────────────────────────────────────────────────
   Subcommand handlers. Each is async. Registered in the COMMANDS table below
   and key-walked — no if/elif ladder.
   ───────────────────────────────────────────────────────────────────────── */

/* version — STANDALONE (reads package.json). */
async function cmdVersion() {
    outln('cbe (Codex Black Ed.) ' + readPackageVersion());
}

/* help / usage — STANDALONE. `man` prints the longer manual. */
async function cmdHelp() {
    outln(USAGE_TEXT);
}
async function cmdMan() {
    outln(MAN_TEXT);
}

/* bridges — STANDALONE. TCP-probes every bridge port and prints up/down. */
async function cmdBridges() {
    outln('Bridge status (TCP probe on 127.0.0.1):');
    const targets = Object.keys(BRIDGE_PORTS);
    const results = await Promise.all(targets.map(async (t) => ({ t, up: await probeBridge(BRIDGE_PORTS[t], 800) })));
    for (const r of results) {
        const mark = r.up ? 'UP  ' : 'down';
        outln(`  ${r.t.padEnd(9)} :${BRIDGE_PORTS[r.t]}  ${mark}`);
    }
    const upCount = results.filter((r) => r.up).length;
    outln(`(${upCount}/${targets.length} bridges up)`);
}

/* bridge <target> "<message>" — STANDALONE. Sends a chat packet, prints reply.
   Talks straight to the C++ tray exe's TCP line-protocol; doesn't need the
   extension running (but does need the bridge exe running). */
async function cmdBridge(argv) {
    const target = (argv[0] || '').toLowerCase();
    const message = argv.slice(1).join(' ').trim();
    if (!target || !(target in BRIDGE_PORTS)) {
        die(`bridge: unknown target "${argv[0] || ''}". Valid: ${Object.keys(BRIDGE_PORTS).join(', ')}`);
    }
    if (!message) die('bridge: no message. Usage: cbe bridge <target> "<message>"');
    errln(`→ ${target} :${BRIDGE_PORTS[target]}`);
    try {
        const answer = await bridgeChat(target, message);
        outln(answer);
    } catch (e) {
        die('bridge ' + target + ': ' + (e.message || e), 2);
    }
}

/* git — STANDALONE. Novice-friendly wrapper around the system `git`, run in
   the configured project folder when set (mirrors the panel's runGit cwd
   behaviour) else the cwd. `cbe git help` explains each subcommand in plain
   English; bare `cbe git` shows status. */
const GIT_HELP = [
    ['status',  'See what has changed but is not yet saved into history. Start here.'],
    ['init',    'Turn the current folder into a brand-new git project (one time only).'],
    ['add',     'Mark changed files to be included in the next save. "cbe git add ." = all of them.'],
    ['commit',  'Save a snapshot of the marked changes with a message. Always include -m "message".'],
    ['log',     'Show the history of past saves (commits), newest first.'],
    ['diff',    'Show line-by-line what you changed since the last save.'],
    ['branch',  'List or create parallel lines of work. New branches keep main clean.'],
    ['fetch',   'Download other people\'s saves from the server WITHOUT changing your files.'],
    ['pull',    'Download AND merge the latest saves from the server into your folder.'],
    ['push',    'Upload your local saves to the shared server (GitHub). Do this when ready to share.'],
    ['clone',   'Copy an existing project from a server URL onto your machine.'],
];
function gitProjectFolder() {
    /* The panel stores the active project folder in VS Code workspaceState
       (not on disk in a way the CLI can read), and config.ini may also carry
       it. Prefer $CBE_PROJECT_FOLDER, then config.ini [chat] project_folder,
       then the current working directory. */
    if (process.env.CBE_PROJECT_FOLDER && fs.existsSync(process.env.CBE_PROJECT_FOLDER)) {
        return process.env.CBE_PROJECT_FOLDER;
    }
    try {
        const iniPath = path.join(EXT_ROOT, 'config.ini');
        if (fs.existsSync(iniPath)) {
            const src = fs.readFileSync(iniPath, 'utf8');
            const m = src.match(/^\s*project_folder\s*=\s*(.+)\s*$/mi);
            if (m && fs.existsSync(m[1].trim())) return m[1].trim();
        }
    } catch (e) { /* non-fatal — fall through to cwd */ }
    return process.cwd();
}
function printGitHelp() {
    outln('cbe git — friendly git, for people who have never used it.\n');
    outln('Git keeps a saved history of your project so you can undo mistakes and');
    outln('share work. The usual flow is:\n');
    outln('  1. cbe git status                 (see what changed)');
    outln('  2. cbe git add .                  (mark everything to save)');
    outln('  3. cbe git commit -m "what I did" (save a snapshot)');
    outln('  4. cbe git push                   (upload to GitHub)\n');
    outln('Subcommands:');
    for (const [name, desc] of GIT_HELP) outln('  ' + name.padEnd(8) + ' ' + desc);
    outln('\nAnything else is passed straight through to git, e.g.:');
    outln('  cbe git remote -v');
    outln('  cbe git checkout -b my-feature');
    outln('\nGit runs in: ' + gitProjectFolder());
    outln('(override with $CBE_PROJECT_FOLDER)');
}
async function cmdGit(argv) {
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { printGitHelp(); return; }
    const folder = gitProjectFolder();
    const args = argv.length ? argv : ['status'];   /* bare `cbe git` = status */
    /* commit with no message is the #1 novice trap — nudge them. */
    if (args[0] === 'commit' && !args.includes('-m') && !args.includes('--message') && !args.includes('--amend')) {
        errln('cbe git: a commit needs a message. Try:  cbe git commit -m "describe your change"');
        process.exit(1);
        return;
    }
    await new Promise((resolve) => {
        execFile('git', args, { cwd: folder, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (stdout) out(stdout);
                if (stderr) errln(stderr.replace(/\s+$/, ''));
                if (err && err.code === 'ENOENT') {
                    errln('cbe git: `git` is not installed or not on PATH. Install Git for Windows: https://git-scm.com/download/win');
                    process.exitCode = 1;
                } else if (err && typeof err.code === 'number') {
                    process.exitCode = err.code;
                }
                resolve();
            });
    });
}

/* status — LIVE EXTENSION. Reports the running extension's active provider,
   model, conversation length, panel state. */
async function cmdStatus() {
    try {
        const { status, json } = await controlRequest('GET', '/status', null);
        if (status !== 200 || !json || !json.ok) { die('status: unexpected response ' + JSON.stringify(json)); return; }
        outln('CBE extension status (live):');
        outln('  version      ' + json.version);
        outln('  provider     ' + json.provider + '  (' + (json.providerLabel || '') + ')');
        outln('  model        ' + (json.model || '(none)'));
        outln('  conversation ' + json.convoLen + ' messages');
        outln('  panel open   ' + (json.panelOpen ? 'yes' : 'no'));
    } catch (e) {
        if (e && e.code === 'ECONNREFUSED') die('status: ' + extensionNotRunningHint(), 3);
        die('status: ' + (e.message || e));
    }
}

/* monitor — LIVE EXTENSION + STANDALONE probe. Reports the companion control
   server (this CLI's server) AND probes the known VS Code/claude-voice control
   ports so the user can see what's listening. */
async function cmdMonitor() {
    outln('Companion / control server status:');
    const known = [
        { name: 'CBE CLI control',      port: CONTROL_PORT },
        { name: 'VSCode ctrl (CBE)',    port: 57835 },
        { name: 'CBE log server',       port: 57836 },
        { name: 'CBE inject ctrl',      port: 57837 },
        { name: 'claude-voice log',     port: 57834 },
    ];
    const results = await Promise.all(known.map(async (k) => ({ ...k, up: await probeBridge(k.port, 600) })));
    for (const r of results) outln('  ' + r.name.padEnd(20) + ' :' + r.port + '  ' + (r.up ? 'UP' : 'down'));
    /* If our control server is up, also pull the live extension status. */
    const cli = results.find((r) => r.port === CONTROL_PORT);
    if (cli && cli.up) {
        outln('');
        await cmdStatus();
    } else {
        outln('\n(CBE extension control server is down — chat/status/update need it. ' + extensionNotRunningHint() + ')');
    }
}

/* update / push — LIVE EXTENSION. Fires the same WinSCP auto-update push the
   activation hook / codexBlackEd.pushUpdate command runs. No-op on non-admin
   machines (config.ini [updates] is_admin=false), exactly like the UI. */
async function cmdUpdate() {
    try {
        const { status, json } = await controlRequest('POST', '/update', { push: true });
        if (status === 200 && json && json.ok) { outln('cbe update: ' + (json.message || 'push triggered')); return; }
        die('update: ' + JSON.stringify(json));
    } catch (e) {
        if (e && e.code === 'ECONNREFUSED') die('update: ' + extensionNotRunningHint(), 3);
        die('update: ' + (e.message || e));
    }
}

/* reset — LIVE EXTENSION. Clears the in-memory conversation (same as
   codexBlackEd.resetConversation). */
async function cmdReset() {
    try {
        const { json } = await controlRequest('POST', '/reset', {});
        outln('cbe reset: conversation cleared (now ' + (json && json.convoLen) + ' messages)');
    } catch (e) {
        if (e && e.code === 'ECONNREFUSED') die('reset: ' + extensionNotRunningHint(), 3);
        die('reset: ' + (e.message || e));
    }
}

/* chat "<message>" — LIVE EXTENSION. Sends to the active provider and streams
   the reply to stdout. Tool calls (bash / read_file via # !exec and native
   tool_calls) execute inside the extension's headless chat path. */
async function cmdChat(argv) {
    const message = argv.join(' ').trim();
    if (!message) die('chat: no message. Usage: cbe chat "<message>"');
    try {
        let sawChunk = false;
        await controlStream('/chat', { message }, (ev) => {
            if (!ev || !ev.type) return;
            if (ev.type === 'chunk') { out(ev.text); sawChunk = true; }
            else if (ev.type === 'status') errln('  … ' + ev.text);
            else if (ev.type === 'tool') {
                if (ev.phase === 'start') errln('  ▶ tool ' + ev.name);
                else errln('  ◀ tool ' + ev.name + (ev.rc != null ? ' rc=' + ev.rc : '') + (ev.bytes != null ? ' ' + ev.bytes + 'B' : ''));
            } else if (ev.type === 'start') {
                errln('  (' + ev.provider + ' / ' + ev.model + ')');
            } else if (ev.type === 'error') {
                errln('\ncbe chat error: ' + ev.message);
                process.exitCode = 2;
            } else if (ev.type === 'done') {
                if (sawChunk) out('\n');
            } else if (ev.type === 'raw') {
                out(ev.text);
            }
        });
    } catch (e) {
        if (e && e.code === 'ECONNREFUSED') die('chat: ' + extensionNotRunningHint(), 3);
        die('chat: ' + (e.message || e));
    }
}

/* send <path> — LIVE EXTENSION. Stages a local file into the running
   conversation context (so the next `cbe chat` can reference it). */
async function cmdSend(argv) {
    const p = argv[0];
    if (!p) die('send: no path. Usage: cbe send <path>');
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) die('send: file not found: ' + abs);
    try {
        const { status, json } = await controlRequest('POST', '/sendFile', { path: abs });
        if (status === 200 && json && json.ok) {
            outln(`cbe send: staged ${json.name} (${json.bytes} bytes${json.truncated ? ', truncated to 200 KB' : ''}) into the conversation.`);
            return;
        }
        die('send: ' + JSON.stringify(json));
    } catch (e) {
        if (e && e.code === 'ECONNREFUSED') die('send: ' + extensionNotRunningHint(), 3);
        die('send: ' + (e.message || e));
    }
}

/* recv <name> — STANDALONE for the dialog; reads the named file from the
   extension's videos/ + chats/ output dirs (or an absolute path) and pops a
   native Save dialog so the user picks where to drop it. */
function _resolveReceivable(name) {
    if (path.isAbsolute(name) && fs.existsSync(name)) return name;
    /* Search the well-known output dirs the UI writes to. */
    const roots = [
        path.join(EXT_ROOT, 'videos'),
        path.join(EXT_ROOT, 'chats'),
        path.join(EXT_ROOT, 'downloads'),
        EXT_ROOT,
    ];
    for (const root of roots) {
        const direct = path.join(root, name);
        if (fs.existsSync(direct)) return direct;
        /* one level deep (videos/<bridge>/<file>) */
        try {
            if (fs.existsSync(root)) {
                for (const sub of fs.readdirSync(root, { withFileTypes: true })) {
                    if (!sub.isDirectory()) continue;
                    const nested = path.join(root, sub.name, name);
                    if (fs.existsSync(nested)) return nested;
                }
            }
        } catch (e) { /* unreadable dir — skip */ }
    }
    return '';
}
async function cmdRecv(argv) {
    const name = argv[0];
    if (!name) die('recv: no name. Usage: cbe recv <name|absolute-path>');
    const src = _resolveReceivable(name);
    if (!src) die('recv: could not find "' + name + '" under videos/, chats/, downloads/, or as an absolute path.');
    const dest = nativeSaveDialog(path.basename(src));
    if (!dest) { outln('cbe recv: cancelled.'); return; }
    try {
        fs.copyFileSync(src, dest);
        outln('cbe recv: saved ' + src + ' → ' + dest);
    } catch (e) {
        die('recv: copy failed: ' + (e.message || e));
    }
}

/* ── Help text (kept at the bottom so handlers read top-down) ──────────────── */
const USAGE_TEXT = `cbe — Codex Black Ed. command-line interface

Usage: cbe <command> [args]

  --version                 Print the extension version.
  --help, usage             Show this help.
  man                       Show the full manual page.

  status                    Show the LIVE extension's active provider/model/convo.
  monitor                   Probe CBE / companion control servers + live status.

  bridges                   List which bridge servers are running (TCP probe).
  bridge <target> "<msg>"   Send a chat packet to a bridge; print the reply.
                            targets: ${Object.keys(BRIDGE_PORTS).join(', ')}

  chat "<message>"          Send to the active provider; stream the reply.
                            Tool calls (bash / read_file) run automatically.
  reset                     Clear the live in-memory conversation.
  send <path>               Stage a local file into the conversation context.
  recv <name>               Find a CBE output file + pop a Save dialog.

  git [args...]             Friendly git wrapper. Try:  cbe git help
  update, push              Trigger the auto-update push (admin-only; UI parity).

Most commands run standalone; status/chat/reset/update/send talk to the
running extension on 127.0.0.1:${CONTROL_PORT}. Run \`cbe man\` for details.`;

const MAN_TEXT = `CBE(1)                  Codex Black Ed. Manual                  CBE(1)

NAME
  cbe — drive every Codex Black UI action from the command line.

DESIGN
  Some commands are STANDALONE (no VS Code needed): --version, bridges,
  bridge, git, recv (the file dialog). They talk straight to disk / TCP.

  Some commands need the LIVE extension because they depend on UI state
  (active provider, the open conversation, the configured auto-update push):
  status, monitor, chat, reset, update/push, send. These POST to a localhost
  control server the extension hosts on 127.0.0.1:${CONTROL_PORT} (override with
  $CBE_CONTROL_PORT). If VS Code isn't running with CBE active, they exit 3
  with a hint instead of silently doing the wrong thing.

COMMANDS
  --version
      Print the version from package.json (never hardcoded).

  status
      Ask the running extension what provider/model is active, how many
      messages are in the conversation, and whether the panel is open.

  monitor
      Probe the CBE CLI control server plus the VS Code / log / inject /
      claude-voice control ports, then (if up) print the live status.

  bridges
      TCP-probe each bridge port (chatgpt 8788, grok 8789, copilot 8790,
      gemini 8791, ollama 8793, deepseek 8794) and report
      up/down. The C++ tray exes in bin/ own these ports.

  bridge <target> "<message>"
      Open a TCP socket to the bridge, write one
      {"action":"chat","target":..,"message":..,"model":..} JSON line, read
      one JSON line back, and print its "answer". Needs the bridge exe up
      (start it from the panel or run bin/CBE-Bridge-<Target>.exe).

  chat "<message>"
      Send to whatever provider is active in the UI and stream the reply to
      stdout. The extension runs the full tool-call loop — # !exec fenced
      shell blocks and native tool_calls (bash / read_file) — so a chat can
      inspect files and run commands exactly like the panel does. Status and
      tool steps print to stderr; the answer prints to stdout.

  reset
      Clear the in-memory conversation (same as the UI's New Conversation).

  send <path>
      Read a local file and stage it into the live conversation so the next
      chat turn can reference it.

  recv <name|path>
      Locate <name> under videos/, chats/, downloads/, or treat it as an
      absolute path, then pop a native Windows Save dialog (PowerShell
      System.Windows.Forms.SaveFileDialog) to choose where to copy it.

  git [args...]
      Run git in the configured project folder ($CBE_PROJECT_FOLDER, else
      config.ini project_folder, else the cwd). Bare \`cbe git\` runs status.
      \`cbe git help\` explains each subcommand in plain English. Commits
      without -m are blocked with a friendly nudge. Everything else passes
      through to the real git.

  update / push
      Fire the same WinSCP auto-update push the extension runs on activation
      (codexBlackEd.pushUpdate). No-op unless config.ini [updates]
      is_admin=true — identical to the UI.

ENVIRONMENT
  CBE_CONTROL_PORT   Override the control-server port (default ${CONTROL_PORT}).
  CBE_PROJECT_FOLDER Folder git runs in.

EXIT STATUS
  0 success · 1 usage/error · 2 remote (bridge/chat) error · 3 extension not running.`;

/* ── Registered dispatch table (key-walked; no if/elif ladder) ─────────────── */
const COMMANDS = {
    '--version': cmdVersion,
    '-v':        cmdVersion,
    'version':   cmdVersion,
    '--help':    cmdHelp,
    '-h':        cmdHelp,
    'help':      cmdHelp,
    'usage':     cmdHelp,
    'man':       cmdMan,
    'status':    cmdStatus,
    'monitor':   cmdMonitor,
    'bridges':   cmdBridges,
    'bridge':    cmdBridge,
    'chat':      cmdChat,
    'reset':     cmdReset,
    'send':      cmdSend,
    'recv':      cmdRecv,
    'git':       cmdGit,
    'update':    cmdUpdate,
    'push':      cmdUpdate,
};

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (!cmd) { outln(USAGE_TEXT); process.exit(0); return; }
    const handler = COMMANDS[cmd];
    if (!handler) {
        errln('cbe: unknown command "' + cmd + '"\n');
        outln(USAGE_TEXT);
        process.exit(1);
        return;
    }
    await handler(argv.slice(1));
}

main().catch((e) => { die((e && e.stack) || (e && e.message) || String(e)); });
