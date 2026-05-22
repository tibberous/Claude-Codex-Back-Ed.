/* ─────────────────────────────────────────────────────────────────────────
   Claude Codex Black Edition
   Trenton Tompkins <trenttompkins@gmail.com>
   (c) 2006 — Released under the MIT license. See license.txt.
   https://trentontompkins.com    https://github.com/tibberous
   Call (724) 431-5207 — PHP / Python / node.js / desktop / web / mobile
   ───────────────────────────────────────────────────────────────────── */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SECRET_KEY_PREFIX = 'codexBlackEd.';   /* per-provider secret = `${PREFIX}${id}.apiKey` */
const STATE_PROVIDER = 'codexBlackEd.activeProvider';
const STATE_MODEL    = 'codexBlackEd.activeModel';
const STATE_SKIN     = 'codexBlackEd.skin';   /* bare filename, e.g. 'noir.css' */
const SKINS_DIR_NAME = 'skins';
const CONFIG_INI_NAME = 'config.ini';
const secretsCache = {};   /* providerId -> apiKey | null. Populated at activate. */

/* ── Provider registry ────────────────────────────────────────────────────
   Per-provider metadata: pretty label, default model id, the field name to
   read from config.ini's [api_keys] section, the model-choice field name,
   and a hint list of candidate models for the dropdown. The Grok entry
   targets the direct xAI API (api.x.ai) — not the grok.com browser bridge. */
const PROVIDERS = {
    anthropic: {
        label: 'Claude (Anthropic)',
        keyField:   'anthropic_api_key',
        modelField: 'claude_model_choice',
        defaultModel: 'claude-sonnet-4-6',
        models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    openai: {
        label: 'ChatGPT (OpenAI)',
        keyField:   'openai_api_key',
        modelField: 'gpt_model_choice',
        defaultModel: 'gpt-4o',
        models: ['gpt-5.4', 'gpt-5', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'],
    },
    grok: {
        label: 'Grok (xAI direct API)',
        keyField:   'xai_api_key',
        modelField: 'grok_model_choice',
        defaultModel: 'grok-4.3',
        models: ['grok-4.3', 'grok-4-fast-reasoning', 'grok-3', 'grok-2-1212'],
    },
    gemini: {
        label: 'Gemini (Google)',
        keyField:   'gemini_api_key',
        modelField: 'gem_model_choice',
        defaultModel: 'gemini-2.5-pro',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    },
    deepseek: {
        label: 'DeepSeek (direct API)',
        keyField:   'deepseek_api_key',
        modelField: 'deepseek_model_choice',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    azure: {
        label: 'Azure OpenAI',
        /* Azure reads from [azure] section, not [api_keys]. Model = deployment name. */
        azureSection: true,
        defaultModel: '',
        models: [],
    },
    /* ── Native C++ tray bridges (bridges_cpp/CBE-Bridge-<Target>.exe) ───
       Each entry routes chat through a single TCP JSON line to the tray
       exe on its fixed BRIDGE_PORTS_DEFAULT port. No API key — auth lives
       in the QtWebEngine profile (browser cookies) or, for Ollama, the
       local daemon. Models are hints only: the actual model is picked in
       the tray exe's Settings → Models menu and persisted to config.ini
       under [<target>] model. */
    chatgptBridge: { label: 'ChatGPT (browser bridge)', bridge: true, bridgeTarget: 'chatgpt', defaultModel: 'gpt-4o',         models: ['gpt-4o', 'gpt-4.1', 'gpt-5', 'o3', 'o3-mini'] },
    grokBridge:    { label: 'Grok (browser bridge)',    bridge: true, bridgeTarget: 'grok',    defaultModel: 'grok-4',         models: ['grok-4', 'grok-4-fast', 'grok-3'] },
    copilotBridge: { label: 'Copilot (browser bridge)', bridge: true, bridgeTarget: 'copilot', defaultModel: 'gpt-4',          models: ['gpt-4'] },
    geminiBridge:  { label: 'Gemini (browser bridge)',  bridge: true, bridgeTarget: 'gemini',  defaultModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    claudeBridge:  { label: 'Claude (browser bridge)',  bridge: true, bridgeTarget: 'claude',  defaultModel: 'claude-sonnet-4-6', models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
    ollamaBridge:  { label: 'Ollama (local)',           bridge: true, bridgeTarget: 'ollama',  defaultModel: 'llama3.2:3b',    models: ['llama3.2:3b', 'llama3.2', 'qwen2.5', 'mistral'] },
    deepseekBridge:{ label: 'DeepSeek (browser bridge)',bridge: true, bridgeTarget: 'deepseek',defaultModel: 'deepseek-chat',  models: ['deepseek-chat', 'deepseek-reasoner'] },
};

const DEFAULT_PROVIDER = 'anthropic';

/* ── Bridge port registry (mirrors start.py BRIDGE_PORTS at start.py:187) ──
   Single source of truth for the JS side. Used by ensureBridge() to TCP-probe
   each tray exe before deciding whether to spawn it. If start.py's dict ever
   moves, update both — they MUST stay in sync. */
const BRIDGE_PORTS = {
    chatgpt:  8788,
    grok:     8789,
    copilot:  8790,
    gemini:   8791,
    claude:   8792,
    ollama:   8793,
    deepseek: 8794,
};

/* Pretty exe filename per bridge target — bin/CBE-Bridge-<Pretty>.exe. */
const BRIDGE_EXE_NAME = {
    chatgpt:  'CBE-Bridge-ChatGPT.exe',
    grok:     'CBE-Bridge-Grok.exe',
    copilot:  'CBE-Bridge-Copilot.exe',
    gemini:   'CBE-Bridge-Gemini.exe',
    claude:   'CBE-Bridge-Claude.exe',
    ollama:   'CBE-Bridge-Ollama.exe',
    deepseek: 'CBE-Bridge-DeepSeek.exe',
};

/* Track which bridges THIS extension instance has already spawned so we
   don't re-fork them on every chat. Map of target -> { pid, startedAt }. */
const _runningBridges = new Map();

/* ── Config singleton ─────────────────────────────────────────────────────
   `config.ini` is parsed ONCE per activation and stored in `Config`. Every
   caller that previously did `readConfigIni(extensionPath)` now reads
   `Config.get()` which returns the cached object (parsing on first access
   only). Call `Config.reload()` if something writes to the file at runtime
   and the new values need to be picked up. */
const Config = (() => {
    let _cached = null;       /* parsed sections, or null if unparsed/missing */
    let _loaded = false;       /* tracks "we've tried to parse" so we don't retry every call */
    let _extPath = null;
    function _parse(extensionPath) {
        const candidates = [
            path.join(extensionPath, CONFIG_INI_NAME),
            path.join(require('os').homedir(), '.cbe', CONFIG_INI_NAME),
        ];
        for (const p of candidates) {
            if (!fs.existsSync(p)) continue;
            try {
                const src = fs.readFileSync(p, 'utf8');
                const out = {};
                let cur = null;
                for (const raw of src.split(/\r?\n/)) {
                    const line = raw.trim();
                    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
                    const sec = line.match(/^\[([^\]]+)\]$/);
                    if (sec) { cur = sec[1].trim(); out[cur] = out[cur] || {}; continue; }
                    if (!cur) continue;
                    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
                    if (m) out[cur][m[1].trim()] = m[2].trim();
                }
                trace('Config: parsed ' + p + ' sections=' + Object.keys(out).join(','));
                return { _path: p, ...out };
            } catch (e) {
                traceErr('Config.parse ' + p, e);
            }
        }
        trace('Config: no config.ini found');
        return null;
    }
    return {
        /* Lazy first-read; subsequent calls are O(1). Pass the extensionPath
           on first call (it's captured for future reloads). */
        get(extensionPath) {
            if (!_loaded) {
                _extPath = extensionPath || _extPath;
                _cached = _parse(_extPath);
                _loaded = true;
            }
            return _cached;
        },
        /* Force a fresh read — call after writing config.ini. */
        reload(extensionPath) {
            _extPath = extensionPath || _extPath;
            _cached = _parse(_extPath);
            _loaded = true;
            return _cached;
        },
        /* For tests / `deactivate` — wipe the cache so the next get() reparses. */
        invalidate() { _cached = null; _loaded = false; },
    };
})();

/* Back-compat shim — all existing call sites use readConfigIni(...). They
   now hit the cache. (Kept as a single function so the rest of the file
   doesn't need touching.) */
/* ── Auto-update push (admin only) ────────────────────────────────────────
   When config.ini's [updates] section has is_admin=true, this fires a
   background WinSCP `synchronize remote` to push the extension folder up
   to /home/trentontompkins.com/cbe (or whatever [updates] remote_path
   says). Uses a saved WinSCP session so no creds live in code. Other
   clients on different machines never have is_admin=true and never push.

   manifest.xml.php is included in the push — once it lands on the server
   the auto-update pull side can fetch it to diff MD5s against local files. */
function pushUpdateToServer(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const u = cfg.updates || {};
    const isAdmin = String(u.is_admin || '').trim().toLowerCase() === 'true';
    if (!isAdmin) {
        trace('UPDATE:PUSH skip — is_admin=false (or unset) in config.ini [updates]');
        return;
    }
    const session    = String(u.winscp_session || 'vps').trim();
    const remotePath = String(u.remote_path || '/home/trentontompkins.com/cbe').trim();
    const winscpExe  = String(u.winscp_exe || 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com').trim();
    if (!fs.existsSync(winscpExe)) {
        trace(`UPDATE:PUSH skip — WinSCP.com not found at ${winscpExe}; set [updates] winscp_exe to the right path`);
        return;
    }
    const localPath = context.extensionPath;
    const logDir = path.join(context.extensionPath, 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
    const stampedSlug = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionLog = path.join(logDir, `winscp_push_${stampedSlug}.log`);
    const xmlLog     = path.join(logDir, `winscp_push_${stampedSlug}.xml`);

    /* Exclude patterns — match WinSCP's filemask format. Pipes separate
       include/exclude halves; we use the exclude half only (leading `|`).
       Wildcards bind to filenames; directory names end with `/`. */
    const excludes = [
        '*.log', '*.bak', '*.tmp', '*.swp',
        '.git/', 'node_modules/', 'logs/', 'chats/', 'dist/',
        '.claude/', 'reports/',
        'data/',                // 1.74 GB per-machine QtWebEngine Chrome profile data
                                // (cookies/cache/ActorSafetyLists/etc) — NEVER push
        'bridges/',             // per-target browser-profile build artifacts — per-machine
        'config.ini',           // per-machine secrets
        'domains.txt', 'wake.txt', 'prompt_history.txt',
        'tools/nssm.exe',       // bundled per-host binaries — server doesn't need
        'tools/rcedit.exe',
    ];
    const filemask = '|' + excludes.join(';');

    const commands = [
        `open ${session}`,
        'option batch abort',
        'option confirm off',
        `synchronize remote -mirror -filemask="${filemask}" "${localPath}" "${remotePath}"`,
        'exit',
    ];

    /* Spawn detached + stdio:'ignore' so the push runs concurrently with
       the panel session and dies with our process if the user quits.
       Output goes to the session + xml logs we asked WinSCP to write —
       NOT to stdout (which is ignored). */
    const args = [
        `/log=${sessionLog}`,
        '/loglevel=1',
        `/xmllog=${xmlLog}`,
        '/command',
        ...commands,
    ];
    trace(`UPDATE:PUSH starting session=${session} remote=${remotePath} log=${sessionLog} xml=${xmlLog}`);
    try {
        const cp = require('child_process');
        const child = cp.spawn(winscpExe, args, {
            cwd: localPath,
            stdio: 'ignore',
            windowsHide: true,
            detached: false,    // dies with parent — don't orphan WinSCP
        });
        child.on('error', (e) => trace(`UPDATE:PUSH spawn-error ${e.message || e}`));
        child.on('exit', (code, signal) => {
            const ok = code === 0;
            trace(`UPDATE:PUSH ${ok ? 'OK' : 'FAILED'} exit=${code} signal=${signal || 'none'} session=${session} — see ${path.basename(xmlLog)} for per-file results`);
        });
        child.unref();    // don't keep the extension host's event loop alive on this
    } catch (e) {
        traceErr('UPDATE:PUSH spawn', e);
    }
}

/* ── Auto-pull update (client side) ───────────────────────────────────────
   Inverse of pushUpdateToServer. Every client (NOT just admin) fetches
   manifest.xml.php from the server, then per-file MD5-compares against
   local copies. Files whose remote MD5 differs from local — OR which are
   missing locally — get downloaded over plain HTTPS GET. Files in the
   exclude list are NEVER pulled: anything that holds user-local state
   (config.ini, debug.log, domains.txt, etc.) stays untouched.

   Manifest format (emitted by manifest.xml.php on the server):
     <manifest>
       <file path="extension.js" md5="abc123…" bytes="12345"/>
       <file path="panel/index.html" md5="def456…" bytes="6789"/>
       …
     </manifest>
*/
const PULL_EXCLUDES = new Set([
    'config.ini',
    'domains.txt',
    'wake.txt',
    'prompt_history.txt',
    'debug.log',
    'tools/nssm.exe',
    'tools/rcedit.exe',
    'manifest.xml.php',  // server-side script; never overwrite our local copy of source
    // ── The extension's own source. The pull does MD5-only diffing (no
    // timestamp/version compare), so the server's older copy will ALWAYS
    // beat the dev tree and clobber in-progress fixes. Extension code
    // ships via .vsix, not over the auto-update channel.
    'extension.js',
    'package.json',
    'package-lock.json',
    'panel/panel.js',
    'panel/index.html',
    'panel/help.html',
    'tools/vscode_supervisor.ps1',
    'tools/build_skins.py',
    'tools/annotate_hooks.py',
    'tools/build_language_files.py',
    'tools/extract_prompts_from_log.py',
    'tools/pull_flag_svgs.ps1',
]);
const PULL_EXCLUDE_PREFIXES = ['.git/', 'node_modules/', 'logs/', 'chats/', 'dist/', '.claude/', 'reports/', 'data/', 'bridges/'];
const PULL_EXCLUDE_SUFFIXES = ['.log', '.bak', '.tmp', '.swp'];

function _shouldPullPath(relPath) {
    const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) return false;
    if (PULL_EXCLUDES.has(p)) return false;
    for (const pre of PULL_EXCLUDE_PREFIXES) { if (p.startsWith(pre)) return false; }
    for (const suf of PULL_EXCLUDE_SUFFIXES) { if (p.endsWith(suf)) return false; }
    return true;
}

function _md5FileSync(absPath) {
    try {
        const crypto = require('crypto');
        const data = fs.readFileSync(absPath);
        return crypto.createHash('md5').update(data).digest('hex');
    } catch (e) {
        return '';
    }
}

function _httpsGetBuffer(urlStr, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const url = require('url');
        const parsed = url.parse(urlStr);
        const req = https.request({
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.path,
            headers: { 'User-Agent': 'ClaudeCodexBlack/auto-pull' },
            timeout: timeoutMs || 60000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
                }
                resolve(Buffer.concat(chunks));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

/* ── Installed extension registry ──────────────────────────────────────
   Extensions live in <extensionPath>/extensions/<id>/. Each has a
   manifest.xml with id, name, version, <entry> (the HTML file to load
   when "Open" is clicked). Pinned IDs are kept in extensions/_pinned.json
   so they re-render on the toolbar after a panel reload. */
function _readManifestXml(xmlText) {
    const out = { id: '', name: '', version: '', author: '', description: '', entry: '', icon: '' };
    if (!xmlText) return out;
    const attrMatch = xmlText.match(/<extension\b([^>]*)>/);
    if (attrMatch) {
        const a = attrMatch[1];
        const pick = (n) => { const m = a.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`)); return m ? m[1] : ''; };
        out.id      = pick('id');
        out.version = pick('version');
    }
    const child = (tag) => {
        const m = xmlText.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
    };
    out.name        = child('name')        || out.id;
    out.author      = child('author');
    out.description = child('description');
    out.entry       = child('entry');
    /* <icon> is an emoji (or short text) the extension picks for itself —
       used for the pinned-toolbar button so it isn't a generic arrow. */
    out.icon        = child('icon');
    return out;
}

function _scanInstalledExtensions(context) {
    /* Returns Map<id, {name, version, entry, author, description}> for every
       valid extension found under extensions/. Skips directories without a
       manifest.xml so half-extracted installs don't show as installed. */
    const out = new Map();
    try {
        const root = path.join(context.extensionPath, 'extensions');
        if (!fs.existsSync(root)) return out;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('_')) continue;  // skip _pinned.json sidecars
            const manifestPath = path.join(root, entry.name, 'manifest.xml');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const xml = fs.readFileSync(manifestPath, 'utf8');
                const info = _readManifestXml(xml);
                const id = info.id || entry.name;
                /* If the extension folder ships an icon.svg next to manifest.xml,
                   read it inline so the panel can render a proper vector glyph
                   instead of an emoji. Emoji rendering in the VSCode webview is
                   font-dependent — Segoe UI Emoji isn't always available and
                   the icon shows as a tofu box. SVG sidesteps that entirely. */
                const iconSvgPath = path.join(root, entry.name, 'icon.svg');
                if (fs.existsSync(iconSvgPath)) {
                    try { info.iconSvg = fs.readFileSync(iconSvgPath, 'utf8'); }
                    catch (e) { traceErr(`EXT:SCAN:ICON ${entry.name}`, e); }
                }
                out.set(id, info);
            } catch (e) {
                traceErr(`EXT:SCAN:READ ${entry.name}`, e);
            }
        }
    } catch (e) {
        traceErr('EXT:SCAN', e);
    }
    return out;
}

/* Pinned-to-toolbar extension IDs persist in config.ini under
   [extensions] pinned = id1,id2,id3 — a comma-separated list. Pinning is
   always an explicit user action (the "Pin to Toolbar" icon on the card);
   nothing auto-pins on install. */
function _readPinnedExtensions(context) {
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        const raw = (cfg.extensions && cfg.extensions.pinned) || '';
        return String(raw)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    } catch (e) {
        traceErr('EXT:PINNED:READ', e);
        return [];
    }
}

function _writePinnedExtensions(context, list) {
    try {
        const uniq = [];
        for (const id of (list || [])) {
            const clean = String(id).trim();
            if (clean && !uniq.includes(clean)) uniq.push(clean);
        }
        const iniPath = path.join(context.extensionPath, CONFIG_INI_NAME);
        writeConfigPatch(iniPath, { 'extensions.pinned': uniq.join(',') });
        /* Force a fresh parse so the next readConfigIni() sees the new value.
           MUST be reload() — there is no refresh(); calling a missing method
           silently no-ops, leaving the cache stale so every pin read an empty
           list and overwrote the previous pin (only 1 ever stuck). */
        try { if (Config && Config.reload) Config.reload(context.extensionPath); } catch (_) {}
        return true;
    } catch (e) {
        traceErr('EXT:PINNED:WRITE', e);
        return false;
    }
}

/* ── Run-count + nag screen ────────────────────────────────────────────
   The panel shows a support/promo nag on runs #3, #6, #10, #20, then every
   30 runs after that (50, 80, 110, …). Run count lives in config.ini under
   [stats] run_count so it survives restarts. The panel picks which of the
   three nag messages to show at random — see CBE_NAGS in panel.js. */
const NAG_FIXED_TRIGGERS = [3, 6, 10, 20];
const NAG_PERIODIC_INTERVAL = 30;
const NAG_PERIODIC_START = NAG_FIXED_TRIGGERS[NAG_FIXED_TRIGGERS.length - 1] + NAG_PERIODIC_INTERVAL; // 50

function shouldShowNag(runNumber) {
    if (NAG_FIXED_TRIGGERS.includes(runNumber)) return true;
    if (runNumber >= NAG_PERIODIC_START && (runNumber - NAG_PERIODIC_START) % NAG_PERIODIC_INTERVAL === 0) return true;
    return false;
}

function bumpRunCount(context) {
    /* Read [stats] run_count from config.ini, increment, write back. The
       cached Config is reloaded so the next read sees the new value
       (same staleness bug that broke pin-all-extensions). Returns the NEW
       count, so caller checks shouldShowNag(returned). */
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        const cur = parseInt((cfg.stats && cfg.stats.run_count) || '0', 10) || 0;
        const next = cur + 1;
        const iniPath = path.join(context.extensionPath, CONFIG_INI_NAME);
        writeConfigPatch(iniPath, {
            'stats.run_count': String(next),
            'stats.last_run':  new Date().toISOString(),
        });
        try { if (Config && Config.reload) Config.reload(context.extensionPath); } catch (_) {}
        return next;
    } catch (e) {
        traceErr('NAG:BUMP_RUN_COUNT', e);
        return 0;
    }
}

function _rmTree(p) {
    /* Node 14+ has fs.rmSync — use it when available, fall back to manual
       recursive walk for older Electron host versions. */
    try {
        if (fs.rmSync) { fs.rmSync(p, { recursive: true, force: true }); return; }
    } catch (_) {}
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p)) {
        const full = path.join(p, e);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) _rmTree(full);
        else { try { fs.unlinkSync(full); } catch (_) {} }
    }
    try { fs.rmdirSync(p); } catch (_) {}
}

function _parseManifestXml(xmlText) {
    /* Lightweight regex parse — manifest.xml.php emits a flat list of
       <file path="…" md5="…" bytes="…"/> elements; no nested structure,
       no CDATA, no comments to worry about. We avoid pulling in a full
       XML library for this. */
    const entries = [];
    const re = /<file\s+([^/>]+)\/?>/g;
    let m;
    while ((m = re.exec(xmlText || '')) !== null) {
        const attrs = m[1];
        const pickAttr = (name) => {
            const am = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
            return am ? am[1] : '';
        };
        const path = pickAttr('path');
        const md5 = pickAttr('md5').toLowerCase();
        const bytes = parseInt(pickAttr('bytes') || '0', 10) || 0;
        if (path) entries.push({ path, md5, bytes });
    }
    return entries;
}

async function pullUpdateFromServer(context, opts) {
    /* Fetches the server manifest, diffs against local MD5s, downloads
       each changed file over HTTPS GET. Safe to call concurrently — uses
       a module-level _pullInFlight guard. Returns a summary object.

       opts.force       — re-download even if local md5 already matches
       opts.silent      — don't post panel info messages, only trace */
    if (_pullInFlight) {
        trace('UPDATE:PULL skip — already in flight');
        return { ok: false, skipped: true, reason: 'in-flight' };
    }
    _pullInFlight = true;
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        const u = cfg.updates || {};
        const manifestUrl = String(u.manifest_url || 'https://trentontompkins.com/cbe/manifest.xml.php').trim();
        const baseUrl     = String(u.pull_base_url || manifestUrl.replace(/\/manifest\.xml\.php.*$/, '')).trim();
        const force       = !!(opts && opts.force);
        const silent      = !!(opts && opts.silent);
        trace(`UPDATE:PULL:BEGIN manifestUrl=${manifestUrl} baseUrl=${baseUrl} force=${force}`);
        let manifestBuf;
        try { manifestBuf = await _httpsGetBuffer(manifestUrl, 30000); }
        catch (e) {
            trace(`UPDATE:PULL:MANIFEST-FAIL ${e.message || e}`);
            return { ok: false, error: 'manifest fetch failed: ' + (e.message || e) };
        }
        const manifestText = manifestBuf.toString('utf8');
        const entries = _parseManifestXml(manifestText);
        trace(`UPDATE:PULL:MANIFEST entries=${entries.length}`);
        const summary = { ok: true, total: entries.length, fetched: 0, unchanged: 0, excluded: 0, errors: 0, files: [] };
        for (const e of entries) {
            if (!_shouldPullPath(e.path)) {
                summary.excluded++;
                continue;
            }
            const abs = path.join(context.extensionPath, e.path.replace(/\\/g, path.sep).replace(/\//g, path.sep));
            const localMd5 = fs.existsSync(abs) ? _md5FileSync(abs) : '';
            if (!force && localMd5 && e.md5 && localMd5.toLowerCase() === e.md5.toLowerCase()) {
                summary.unchanged++;
                continue;
            }
            const fileUrl = `${baseUrl.replace(/\/+$/, '')}/${e.path.replace(/\\/g, '/').replace(/^\.\//, '')}`;
            try {
                const body = await _httpsGetBuffer(fileUrl, 60000);
                if (e.md5) {
                    const crypto = require('crypto');
                    const got = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
                    if (got !== e.md5.toLowerCase()) {
                        trace(`UPDATE:PULL:MD5-MISMATCH ${e.path} server=${e.md5} downloaded=${got} — skipping write`);
                        summary.errors++;
                        summary.files.push({ path: e.path, status: 'md5_mismatch' });
                        continue;
                    }
                }
                try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
                fs.writeFileSync(abs, body);
                summary.fetched++;
                summary.files.push({ path: e.path, status: 'fetched', bytes: body.length });
                trace(`UPDATE:PULL:WROTE ${e.path} bytes=${body.length}`);
            } catch (downloadError) {
                summary.errors++;
                summary.files.push({ path: e.path, status: 'error', error: downloadError.message || String(downloadError) });
                trace(`UPDATE:PULL:DOWNLOAD-FAIL ${e.path} ${downloadError.message || downloadError}`);
            }
        }
        trace(`UPDATE:PULL:DONE total=${summary.total} fetched=${summary.fetched} unchanged=${summary.unchanged} excluded=${summary.excluded} errors=${summary.errors}`);
        if (!silent && activePanel && summary.fetched > 0) {
            try { activePanel.webview.postMessage({ type: 'info', text: `Auto-update: pulled ${summary.fetched} updated file(s) (${summary.unchanged} unchanged, ${summary.excluded} skipped). Reload VSCode to apply.` }); } catch (_) {}
        }
        return summary;
    } finally {
        _pullInFlight = false;
    }
}
let _pullInFlight = false;

function readConfigIni(extensionPath) {
    return Config.get(extensionPath);
}

/* Write a flat "section.key" -> value patch back into config.ini WITHOUT
   destroying comments, blank lines, or section ordering. Each patched key
   is rewritten in place if it exists; missing keys get appended at the
   bottom of their section (creating the section if absent). New sections
   land at the end of the file with a header line. Used by the Setup
   wizard's saveSetup handler. */
function writeConfigPatch(filePath, patch) {
    if (!patch || typeof patch !== 'object') return;
    /* Group the patch by section so we can do one pass per section. */
    const bySection = {};
    for (const fk of Object.keys(patch)) {
        const dot = fk.indexOf('.');
        if (dot < 0) continue;
        const sec = fk.slice(0, dot), key = fk.slice(dot + 1);
        bySection[sec] = bySection[sec] || {};
        bySection[sec][key] = patch[fk];
    }
    /* Read or create the file. */
    let lines;
    try {
        lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    } catch (e) {
        lines = [];
    }
    /* Walk: find each [section] block, rewrite known keys, append missing
       ones at the section's end, then move on. Track which sections still
       need to be created. */
    const out = [];
    const sectionsHandled = new Set();
    let curSection = null;
    /* Per-section: track which keys we've already written in this section
       so we can append the ones that weren't found before the next [section]. */
    let writtenInCur = null;
    const flushPending = () => {
        if (!curSection) return;
        const patchForSec = bySection[curSection];
        if (!patchForSec) return;
        for (const k of Object.keys(patchForSec)) {
            if (!writtenInCur.has(k)) {
                out.push(`${k} = ${patchForSec[k]}`);
                writtenInCur.add(k);
            }
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (sec) {
            flushPending();
            if (curSection) sectionsHandled.add(curSection);
            curSection = sec[1].trim();
            writtenInCur = new Set();
            out.push(line);
            continue;
        }
        /* Inside a section: if this line is `key = value` and we have a patch
           for this key, rewrite it. Otherwise pass through verbatim. */
        const kv = line.match(/^(\s*)([^#;=\[\s][^=]*?)\s*=(.*)$/);
        if (kv && curSection && bySection[curSection]) {
            const key = kv[2].trim();
            if (Object.prototype.hasOwnProperty.call(bySection[curSection], key)) {
                out.push(`${kv[1]}${key} = ${bySection[curSection][key]}`);
                writtenInCur.add(key);
                continue;
            }
        }
        out.push(line);
    }
    /* End of file: flush whatever's left in the last section. */
    flushPending();
    if (curSection) sectionsHandled.add(curSection);
    /* Append any sections from the patch that don't exist in the file yet. */
    for (const sec of Object.keys(bySection)) {
        if (sectionsHandled.has(sec)) continue;
        /* Guard: don't append a blank section block. */
        const keys = Object.keys(bySection[sec]);
        if (!keys.length) continue;
        out.push('');
        out.push(`[${sec}]`);
        for (const k of keys) out.push(`${k} = ${bySection[sec][k]}`);
    }
    fs.writeFileSync(filePath, out.join('\n'), 'utf8');
}

/* ── Provider state lookup ────────────────────────────────────────────── */

function getActiveProvider(context) {
    const id = context.workspaceState.get(STATE_PROVIDER) || DEFAULT_PROVIDER;
    return PROVIDERS[id] ? id : DEFAULT_PROVIDER;
}

function getActiveModel(context, providerId) {
    const stored = context.workspaceState.get(STATE_MODEL + ':' + providerId);
    if (stored) return stored;
    const cfg = readConfigIni(context.extensionPath);
    const provider = PROVIDERS[providerId];
    if (!provider) return '';
    if (provider.azureSection) {
        return (cfg && cfg.azure && cfg.azure.deployment_name) || provider.defaultModel;
    }
    const fromIni = cfg && cfg.api_keys && cfg.api_keys[provider.modelField];
    return fromIni || provider.defaultModel;
}

function getProviderKey(context, providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) return null;
    /* Native C++ bridges: no API key — auth lives in the tray exe's
       QtWebEngine profile (cloud targets) or in the local ollama daemon.
       Return a sentinel so the "(no key)" badge in the settings modal
       stays quiet. */
    if (provider.bridge) return '<bridge>';
    /* 0. Active account from the multi-account list. This is the key the
       request path actually sends. It already migrates the legacy single
       key in as accounts[0], so a one-key user transparently resolves here.
       Skipped only if every account is disabled (rate-limited) — in that
       case we fall through to the secret/ini/env legacy chain so a manual
       Set-API-Key still works. */
    const activeAcc = getActiveAccount(context, providerId);
    if (activeAcc && !_accountDisabled(activeAcc) && activeAcc.apiKey) return activeAcc.apiKey;
    /* 1. Cached secret (set via Set API Key command) */
    if (secretsCache[providerId]) return secretsCache[providerId];
    /* 2. config.ini lookup */
    const cfg = readConfigIni(context.extensionPath);
    if (provider.azureSection) {
        return cfg && cfg.azure && (cfg.azure.api_key || cfg.azure.api_key1) || null;
    }
    const fromIni = cfg && cfg.api_keys && cfg.api_keys[provider.keyField];
    if (fromIni) return fromIni;
    /* 3. Env fallback per provider */
    const envName = ({
        anthropic: 'ANTHROPIC_API_KEY',
        openai:    'OPENAI_API_KEY',
        grok:      'XAI_API_KEY',
        gemini:    'GEMINI_API_KEY',
        deepseek:  'DEEPSEEK_API_KEY',
    })[providerId];
    return envName ? (process.env[envName] || null) : null;
}

async function refreshSecretsCache(context) {
    const ids = Object.keys(PROVIDERS);
    trace(`  refreshSecretsCache: ${ids.length} providers (parallel)`);
    /* All 9 secrets.get() calls run concurrently — the previous sequential
       loop took N×slowest; this takes max(slowest). On a warm vault that's
       ~125ms instead of ~530ms. */
    const tStart = Date.now();
    await Promise.all(ids.map(async (id) => {
        const tGet = Date.now();
        try {
            const v = await context.secrets.get(SECRET_KEY_PREFIX + id + '.apiKey');
            secretsCache[id] = v || null;
            trace(`    secrets.get(${id}) ${Date.now() - tGet}ms ${v ? 'present' : 'empty'}`);
        } catch (e) {
            secretsCache[id] = null;
            trace(`    secrets.get(${id}) FAILED ${Date.now() - tGet}ms ${e && e.message}`);
        }
    }));
    trace(`  refreshSecretsCache parallel total ${Date.now() - tStart}ms`);
}

async function pickProvider(promptText) {
    const items = Object.keys(PROVIDERS).map(id => ({ label: PROVIDERS[id].label, id }));
    const pick = await vscode.window.showQuickPick(items, { title: promptText, ignoreFocusOut: true });
    return pick ? pick.id : null;
}

async function promptForKey(context, providerId) {
    const provider = PROVIDERS[providerId];
    const entered = await vscode.window.showInputBox({
        title: `API Key for ${provider.label}`,
        prompt: 'Stored encrypted in VS Code secrets. Cleared via "Claude Codex Black: Clear API Key".',
        password: true,
        ignoreFocusOut: true,
    });
    if (!entered) return null;
    const trimmed = entered.trim();
    await context.secrets.store(SECRET_KEY_PREFIX + providerId + '.apiKey', trimmed);
    secretsCache[providerId] = trimmed;
    return trimmed;
}

function getMaxTokens() {
    const v = vscode.workspace.getConfiguration('codexBlackEd').get('maxTokens');
    return Number.isInteger(v) && v >= 256 && v <= 16384 ? v : 4096;
}

/* ── Multi-account management ──────────────────────────────────────────────
   The user runs ~10 Anthropic accounts (and may stack accounts on other
   providers) each on a weekly token cap that does NOT roll over. Instead of a
   single key per provider we keep a LIST of accounts and rotate through them
   when one hits its cap.

   Persistence: config.ini gets a new [accounts] section. One key per provider
   id whose VALUE is a JSON-encoded array of account objects:

       [accounts]
       anthropic = [{"id":"acc_...","label":"main","apiKey":"sk-ant-...","addedAt":"2026-05-21T...","lastUsedAt":null,"disabledUntil":null}, ...]
       openai    = [ ... ]

   The active-account index per provider lives in workspaceState (per-window),
   keyed STATE_ACTIVE_ACCOUNT + ':' + providerId. The legacy single key under
   [api_keys].<keyField> is preserved and migrated into accounts[0] on first
   read (see getProviderAccounts). NEVER log a full apiKey — always maskKey().
*/
const STATE_ACTIVE_ACCOUNT = 'codexBlackEd.activeAccount';   /* + ':' + providerId -> account id */
const ACCOUNTS_SECTION = 'accounts';

/* Mask a key to `prefix…last4` for any log/UI surface. Never echo a full key.
   The prefix keeps the recognizable provider tag (e.g. `sk-ant-`, `sk-proj-`,
   `xai-`) so the user can tell accounts apart, then elides the secret middle.
   For an unstructured/short key we just show last4 (or **** if very short). */
function maskKey(k) {
    const s = String(k || '');
    if (!s) return '(empty)';
    if (s.length <= 8) return '****';
    /* Keep up to the 2nd hyphen group (sk-ant-, sk-proj-) or the 1st (xai-),
       capped at 8 chars so we never leak a meaningful slice of the secret. */
    let cut = 4;
    const h1 = s.indexOf('-');
    if (h1 > 0 && h1 < 6) {
        const h2 = s.indexOf('-', h1 + 1);
        cut = (h2 > 0 && h2 <= 8) ? h2 + 1 : h1 + 1;
    }
    const head = s.slice(0, Math.min(cut, 8));
    return `${head}…${s.slice(-4)}`;
}

/* Cheap unique-ish id for an account row. */
function _newAccountId() {
    return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Validate a key's *shape* (not its validity) against the provider. Returns
   { ok, reason }. Bridge/azure providers have no shape requirement. */
function validateKeyShape(providerId, key) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, reason: 'empty key' };
    const p = PROVIDERS[providerId] || {};
    if (p.bridge) return { ok: true };
    const expect = ({
        anthropic: /^sk-ant-/,
        openai:    /^sk-/,
        deepseek:  /^sk-/,
        grok:      /^xai-/,
    })[providerId];
    if (expect && !expect.test(k)) {
        const hint = ({ anthropic: 'sk-ant-', openai: 'sk-', deepseek: 'sk-', grok: 'xai-' })[providerId];
        return { ok: false, reason: `key for ${providerId} should start with "${hint}"` };
    }
    return { ok: true };
}

/* Read the raw [accounts] JSON array for a provider, with one-time migration
   of the legacy [api_keys].<keyField> single key into accounts[0]. Returns a
   normalized array (never null). Does NOT persist the migration here — the
   caller persists when it makes a change; a read-only call just sees the
   migrated-in legacy account at the head. */
function getProviderAccounts(context, providerId) {
    const p = PROVIDERS[providerId];
    if (!p || p.bridge) return [];
    const cfg = readConfigIni(context.extensionPath) || {};
    let list = [];
    const rawSection = cfg[ACCOUNTS_SECTION] || {};
    const raw = rawSection[providerId];
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) list = parsed.filter(a => a && a.apiKey);
        } catch (e) {
            traceErr(`accounts JSON parse failed for ${providerId}`, e);
        }
    }
    /* Migrate the legacy single key into the list if it isn't represented. */
    let legacyKey = null;
    if (p.azureSection) {
        legacyKey = (cfg.azure && (cfg.azure.api_key || cfg.azure.api_key1)) || null;
    } else if (p.keyField) {
        legacyKey = (cfg.api_keys && cfg.api_keys[p.keyField]) || null;
    }
    legacyKey = legacyKey ? String(legacyKey).trim() : null;
    if (legacyKey && !list.some(a => a.apiKey === legacyKey)) {
        list.unshift({
            id: _newAccountId(),
            label: 'config.ini',
            apiKey: legacyKey,
            addedAt: new Date().toISOString(),
            lastUsedAt: null,
            disabledUntil: null,
        });
    }
    /* Normalize shape so downstream code never trips on undefined fields. */
    return list.map(a => ({
        id: a.id || _newAccountId(),
        label: a.label || maskKey(a.apiKey),
        apiKey: String(a.apiKey || ''),
        addedAt: a.addedAt || new Date().toISOString(),
        lastUsedAt: a.lastUsedAt || null,
        disabledUntil: a.disabledUntil || null,
    }));
}

/* Persist a provider's full account array back into config.ini [accounts]. */
function setProviderAccounts(context, providerId, accounts) {
    const filePath = path.join(context.extensionPath, CONFIG_INI_NAME);
    const patch = {};
    patch[`${ACCOUNTS_SECTION}.${providerId}`] = JSON.stringify(accounts || []);
    writeConfigPatch(filePath, patch);
    Config.reload(context.extensionPath);
    trace(`ACCOUNTS:SAVE provider=${providerId} count=${(accounts || []).length}`);
}

/* True when an account is currently disabled (disabledUntil in the future). */
function _accountDisabled(acc) {
    if (!acc || !acc.disabledUntil) return false;
    const t = Date.parse(acc.disabledUntil);
    return Number.isFinite(t) && t > Date.now();
}

/* Resolve the active account for a provider. Falls back to the first
   non-disabled account, then the first account. Returns the account object or
   null. */
function getActiveAccount(context, providerId) {
    const accounts = getProviderAccounts(context, providerId);
    if (!accounts.length) return null;
    const wantId = context.workspaceState.get(STATE_ACTIVE_ACCOUNT + ':' + providerId);
    if (wantId) {
        const hit = accounts.find(a => a.id === wantId);
        if (hit && !_accountDisabled(hit)) return hit;
    }
    const firstEnabled = accounts.find(a => !_accountDisabled(a));
    return firstEnabled || accounts[0];
}

/* Set which account id is active for a provider (workspaceState only). */
async function setActiveAccount(context, providerId, accountId) {
    await context.workspaceState.update(STATE_ACTIVE_ACCOUNT + ':' + providerId, accountId || '');
    trace(`ACCOUNTS:USE provider=${providerId} account=${accountId}`);
}

/* Stamp lastUsedAt on the active account at request time. Fire-and-forget;
   a write failure must not block a send. No-op for bridge providers. */
function touchActiveAccount(context, providerId) {
    try {
        const p = PROVIDERS[providerId];
        if (!p || p.bridge) return;
        const accounts = getProviderAccounts(context, providerId);
        const active = getActiveAccount(context, providerId);
        if (!active) return;
        let changed = false;
        for (const a of accounts) {
            if (a.id === active.id) { a.lastUsedAt = new Date().toISOString(); changed = true; break; }
        }
        if (changed) setProviderAccounts(context, providerId, accounts);
    } catch (e) {
        traceErr('touchActiveAccount', e);
    }
}

/* Compute the next weekly-reset boundary as an ISO string. Anthropic weekly
   caps reset on a rolling 7-day window; without the exact reset time from the
   API we approximate "+7 days from now". Callers that know better (e.g. a
   Retry-After header) can pass an explicit Date. */
function nextWeeklyReset(fromDate) {
    const base = fromDate instanceof Date ? fromDate.getTime() : Date.now();
    return new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
}

/* Mark the active account for a provider as rate-limited and advance to the
   next non-disabled account. Returns { rotated, from, to, allDisabled,
   soonest } where from/to are account objects (or null) and soonest is the
   earliest disabledUntil ISO when allDisabled. disableMs lets a Retry-After
   header set a precise window; absent it we use the weekly reset, or +1h if
   the reset is genuinely unknown for non-weekly providers. */
async function rotateOnRateLimit(context, providerId, opts) {
    opts = opts || {};
    const accounts = getProviderAccounts(context, providerId);
    if (!accounts.length) return { rotated: false, allDisabled: true, soonest: null };
    const cur = getActiveAccount(context, providerId);
    /* Decide the disable window for the account that just failed. */
    let disabledUntil;
    if (Number.isFinite(opts.disableMs)) {
        disabledUntil = new Date(Date.now() + opts.disableMs).toISOString();
    } else if (providerId === 'anthropic' || opts.weekly) {
        disabledUntil = nextWeeklyReset();
    } else {
        disabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();  /* +1h */
    }
    if (cur) {
        for (const a of accounts) {
            if (a.id === cur.id) { a.disabledUntil = disabledUntil; break; }
        }
    }
    /* Find the next non-disabled account after the current one (round-robin). */
    const startIdx = cur ? accounts.findIndex(a => a.id === cur.id) : -1;
    let next = null;
    for (let step = 1; step <= accounts.length; step++) {
        const cand = accounts[(startIdx + step + accounts.length) % accounts.length];
        if (cand && !_accountDisabled(cand)) { next = cand; break; }
    }
    setProviderAccounts(context, providerId, accounts);
    if (!next) {
        /* All disabled — surface the soonest reset. */
        let soonest = null;
        for (const a of accounts) {
            const t = a.disabledUntil ? Date.parse(a.disabledUntil) : null;
            if (Number.isFinite(t) && (soonest === null || t < soonest)) soonest = t;
        }
        trace(`ACCOUNTS:ROTATE provider=${providerId} ALL_DISABLED soonest=${soonest ? new Date(soonest).toISOString() : 'n/a'}`);
        return { rotated: false, from: cur || null, to: null, allDisabled: true, soonest: soonest ? new Date(soonest).toISOString() : null };
    }
    await setActiveAccount(context, providerId, next.id);
    /* Bust the cached Anthropic client so the next call uses the new key. */
    if (anthropicClient) anthropicClient = null;
    trace(`ACCOUNTS:ROTATE provider=${providerId} from=${cur ? cur.label : '?'} to=${next.label} disabledUntil=${disabledUntil}`);
    return { rotated: true, from: cur || null, to: next, allDisabled: false, soonest: null };
}

let activePanel;

/* Slash-command palette runner. Mirrors panel/panel.js CBE_COMMANDS so each
   slash command also exists as a real VSCode command id (registered in
   contributes.commands → "codexBlackEd.slash.<name>"). Opens the panel if
   needed, then posts the same `type` strings the in-panel run() bodies use.
   `key` is the panel-side slash name without the leading "/" (e.g. "help",
   "compact", "switchAccounts"). */
function runSlashCommand(context, key) {
    /* Map slash key → webview message envelope. For commands that the
       panel's CBE_COMMANDS runs by clicking a DOM button (e.g. /clear →
       addBtn.click()), we expose a thin `runSlash` message so panel.js
       can dispatch it without re-implementing the click logic. */
    const map = {
        help:           { type: 'runSlash', name: 'help' },
        handbook:       { type: 'runSlash', name: 'handbook' },
        clear:          { type: 'runSlash', name: 'clear' },
        settings:       { type: 'openSettings' },
        prompts:        { type: 'openPromptsFile' },
        history:        { type: 'openChatHistory' },
        font:           { type: 'runSlash', name: 'font' },
        attach:         { type: 'runSlash', name: 'attach' },
        folder:         { type: 'runSlash', name: 'folder' },
        compact:        { type: 'compactConversation' },
        git:            { type: 'openGit' },
        github:         { type: 'runSlash', name: 'github' },
        license:        { type: 'showLicense' },
        push:           { type: 'pushUpdate' },
        switchAccounts: { type: 'runSlash', name: 'switchAccounts' },
    };
    const msg = map[key];
    if (!msg) { trace(`SLASH:UNKNOWN ${key}`); return; }
    try {
        /* Ensure the panel exists, then post. openPanel resolves to the
           bound panel — we then deliver the message. */
        const ensure = () => {
            if (activePanel) { activePanel.webview.postMessage(msg); return; }
            vscode.commands.executeCommand('codexBlackEd.openPanel').then(() => {
                if (activePanel) activePanel.webview.postMessage(msg);
            }, e => traceErr('runSlashCommand:openPanel', e));
        };
        ensure();
    } catch (e) { traceErr('runSlashCommand', e); }
}

/* Singleton WebviewPanel for the NN4-skinned browser shell. Created lazily
   on the first 'openNN4Browser' message; revealed on subsequent clicks;
   nulled out by onDidDispose so the next click rebuilds it. */
let _nn4BrowserPanel = null;
/* Video library panel — autoplays newly generated videos from videos/.
   See loadVideoPlayerHtml below + the codexBlackEd.openVideoPlayer
   command. Posts cbe-videos-list to the webview on a 2s tick so files
   that land in videos/<bridge>/ show up live. */
let _videoPlayerPanel = null;
let _videoPlayerWatcher = null;
/* Local Python sidecar that proxies arbitrary HTTPS pages with X-Frame-Options
   / CSP frame-ancestors / HSTS / Set-Cookie stripped, so they will render
   inside the NN4 iframe.  Spawned on first browser open, kept alive until
   the panel disposes (or extension deactivates).  Port is ephemeral and
   read back from the child's first stdout line ("PORT=<n>"). */
let _nn4ProxyProc  = null;
let _nn4ProxyPort  = 0;
let _nn4ProxyReady = null;        /* Promise<int port> resolved when the child prints PORT= */

function ensureNn4ProxySidecar(context) {
    if (_nn4ProxyProc && _nn4ProxyPort) return Promise.resolve(_nn4ProxyPort);
    if (_nn4ProxyReady) return _nn4ProxyReady;
    const script = path.join(context.extensionPath, 'tools', 'nn4_proxy_sidecar.py');
    if (!fs.existsSync(script)) {
        const err = new Error('nn4_proxy_sidecar.py missing at ' + script);
        traceErr('nn4-proxy spawn', err);
        return Promise.reject(err);
    }
    // Prefer the Windows py launcher (always present on Python installs); fall
    // back to plain 'python' if py.exe isn't on PATH.
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    _nn4ProxyReady = new Promise((resolve, reject) => {
        let resolved = false;
        let proc;
        try {
            proc = spawn(pyCmd, ['-3', script, '--port', '0'], {
                cwd: context.extensionPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e) {
            traceErr('nn4-proxy spawn-exception', e);
            return reject(e);
        }
        _nn4ProxyProc = proc;
        let stdoutBuf = '';
        proc.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString('utf8');
            const m = stdoutBuf.match(/PORT=(\d+)/);
            if (m && !resolved) {
                resolved = true;
                _nn4ProxyPort = parseInt(m[1], 10);
                trace(`NN4:PROXY ready port=${_nn4ProxyPort} pid=${proc.pid}`);
                resolve(_nn4ProxyPort);
            }
        });
        proc.stderr.on('data', (chunk) => {
            // Every sidecar log line goes into the trace channel so the user
            // can open Output -> Codex Black Ed. and see every proxied URL +
            // its upstream HTTP status, response size, and elapsed ms.
            chunk.toString('utf8').split(/\r?\n/).forEach(line => {
                if (line.trim()) trace('NN4:PROXY ' + line);
            });
        });
        proc.on('error', (e) => {
            traceErr('nn4-proxy proc-error', e);
            if (!resolved) { resolved = true; reject(e); }
        });
        proc.on('exit', (code, sig) => {
            trace(`NN4:PROXY exit code=${code} sig=${sig}`);
            _nn4ProxyProc = null;
            _nn4ProxyPort = 0;
            _nn4ProxyReady = null;
        });
        // Boot timeout — fail fast if the child never prints PORT=.
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { proc.kill(); } catch (_) {}
                reject(new Error('nn4-proxy did not announce PORT= within 5s'));
            }
        }, 5000);
    });
    return _nn4ProxyReady;
}

function stopNn4ProxySidecar() {
    if (_nn4ProxyProc) {
        try { _nn4ProxyProc.kill(); } catch (_) {}
        _nn4ProxyProc = null;
        _nn4ProxyPort = 0;
        _nn4ProxyReady = null;
        trace('NN4:PROXY killed');
    }
}

/* Wire up an already-created _videoPlayerPanel: load panel/video-player.html,
   convert local file:// paths to webview-safe URIs, push the videos/ scan to
   the webview every 2 seconds so newly-generated files show up live with
   autoplay. */
function _scanVideos(context) {
    const videosRoot = path.join(context.extensionPath, 'videos');
    const out = [];
    try {
        if (!fs.existsSync(videosRoot)) return out;
        const bridges = fs.readdirSync(videosRoot, { withFileTypes: true });
        for (const b of bridges) {
            if (!b.isDirectory()) continue;
            const bridgeDir = path.join(videosRoot, b.name);
            for (const f of fs.readdirSync(bridgeDir)) {
                if (!/\.(mp4|webm|mov)$/i.test(f)) continue;
                const fp = path.join(bridgeDir, f);
                const st = fs.statSync(fp);
                out.push({ name: f, bridge: b.name, path: fp, size: st.size, mtime: st.mtimeMs });
            }
        }
    } catch (e) {
        traceErr('videoPlayer scan', e);
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

async function loadVideoPlayerHtml(context, panel) {
    let html;
    try {
        html = fs.readFileSync(path.join(context.extensionPath, 'panel', 'video-player.html'), 'utf8');
    } catch (e) {
        traceErr('read video-player.html', e);
        panel.webview.html = '<html><body style="color:#d4d4d4;background:#1e1e1e;font-family:sans-serif;padding:1em;">' +
            '<h3>Video player failed to load</h3><pre>' + String(e && e.message || e) + '</pre></body></html>';
        return;
    }
    html = html.replace(/\{\{CSP_SOURCE\}\}/g, panel.webview.cspSource || '');
    panel.webview.html = html;

    /* Push the videos[] list with webview-safe URIs. Re-fired on
       cbe-videos-rescan + every 2s from the watcher tick. */
    const pushList = () => {
        if (!panel || !panel.webview) return;
        const items = _scanVideos(context).map(v => ({
            name:   v.name,
            bridge: v.bridge,
            path:   v.path,
            size:   v.size,
            mtime:  v.mtime,
            uri:    panel.webview.asWebviewUri(vscode.Uri.file(v.path)).toString(),
        }));
        panel.webview.postMessage({ type: 'cbe-videos-list', videos: items });
    };

    panel.webview.onDidReceiveMessage((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'cbe-videos-rescan') { pushList(); return; }
        if (msg.type === 'cbe-videos-open-folder') {
            try {
                const videosRoot = path.join(context.extensionPath, 'videos');
                if (!fs.existsSync(videosRoot)) fs.mkdirSync(videosRoot, { recursive: true });
                vscode.env.openExternal(vscode.Uri.file(videosRoot));
            } catch (e) { traceErr('cbe-videos-open-folder', e); }
            return;
        }
    });

    // 2s tick — cheap because _scanVideos is just a directory walk.
    if (_videoPlayerWatcher) clearInterval(_videoPlayerWatcher);
    _videoPlayerWatcher = setInterval(pushList, 2000);
    pushList();
}

/* Wire up an already-created _nn4BrowserPanel: spawn (or attach to) the local
   proxy sidecar, substitute {{PROXY_BASE}} in nn4-browser.html with the
   sidecar's URL, install a webviewMessage handler so panel-side console logs
   land in the trace channel, and write the resulting HTML into the webview.
   Errors land in trace() AND in a fallback HTML body that names the file. */
async function loadNn4BrowserHtml(context, panel) {
    let html;
    try {
        html = fs.readFileSync(path.join(context.extensionPath, 'panel', 'nn4-browser.html'), 'utf8');
    } catch (e) {
        traceErr('read nn4-browser.html', e);
        panel.webview.html =
            '<html><body style="font-family:sans-serif;padding:1em;">' +
            '<h3>NN4 Browser failed to load</h3><pre>' +
            String(e && e.message || e) + '</pre></body></html>';
        return;
    }
    let proxyBase = '';
    try {
        const port = await ensureNn4ProxySidecar(context);
        proxyBase = `http://127.0.0.1:${port}/proxy`;
        trace('NN4:BROWSER using proxyBase=' + proxyBase);
    } catch (e) {
        traceErr('NN4:BROWSER sidecar spawn', e);
        // Still load the HTML — the panel's own logging will surface
        // "proxy unreachable" status the moment the user hits Go.
    }
    html = html
        .replace(/\{\{PROXY_BASE\}\}/g, proxyBase)
        .replace(/\{\{CSP_SOURCE\}\}/g, panel.webview.cspSource || '');
    panel.webview.html = html;

    // Pipe panel console logs -> output channel.
    panel.webview.onDidReceiveMessage((msg) => {
        if (!msg) return;
        if (msg.type === 'nn4BrowserLog') {
            const lvl = (msg.level || 'log').toUpperCase();
            trace(`NN4:WEBVIEW [${lvl}] ${msg.text || ''}`);
            return;
        }
        if (msg.type === 'nn4OpenExternal') {
            const url = (msg.url || '').toString();
            const low = url.toLowerCase();
            if (!(low.startsWith('http://') || low.startsWith('https://'))) {
                trace('nn4OpenExternal -> refused non-http(s): ' + url);
                return;
            }
            const helper = path.join(context.extensionPath, 'tools', 'open_external.py');
            if (!fs.existsSync(helper)) {
                trace('nn4OpenExternal -> helper missing at ' + helper);
                return;
            }
            const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
            const pyArgs = process.platform === 'win32'
                ? ['-3', helper, url]
                : [helper, url];
            trace('nn4OpenExternal -> launching ' + url);
            try {
                const child = spawn(pyCmd, pyArgs, {
                    cwd: context.extensionPath,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                });
                let out = '';
                let errOut = '';
                child.stdout.on('data', (c) => { out += c.toString(); });
                child.stderr.on('data', (c) => { errOut += c.toString(); });
                child.on('error', (e) => {
                    traceErr('nn4OpenExternal spawn', e);
                });
                child.on('close', (code) => {
                    const used = out.trim();
                    if (code === 0 && used) {
                        trace('nn4OpenExternal -> ' + used);
                    } else {
                        trace('nn4OpenExternal -> no browser found (code=' +
                            code + ') ' + (errOut.trim() || '').slice(0, 200));
                    }
                });
            } catch (e) {
                traceErr('nn4OpenExternal spawn-exception', e);
            }
            return;
        }
        if (msg.type === 'nn4BrowserDevTools') {
            trace('NN4:WEBVIEW [INFO] dev-tools requested');
            try {
                vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
            } catch (e) {
                trace('NN4:WEBVIEW [ERR] openDeveloperTools threw ' + (e && e.message));
            }
            return;
        }
    });
}
let conversation = [];
let outChan;
/* Our owned terminal — recreated on click if the user closed it. Kept here
   (module scope) so the openTerminal handler reveals the SAME terminal it
   created, not whatever VSCode picked as activeTerminal. */
let cbeTerm = null;
let statusBar;
let anthropicClient;
let extensionContext = null; /* captured during activate so commands can resolve globalStorageUri */

/* ── Speech-to-Text (SAPI fallback) ────────────────────────────────────────
   VSCode webviews cannot use the Web Speech API — the sandbox denies
   microphone permission silently (Voice: not-allowed). The fix is to fall
   back to Windows SAPI on the host side: launch PowerShell with
   System.Speech.Recognition.SpeechRecognitionEngine, capture the default
   mic via SetInputToDefaultAudioDevice(), and return the transcript over
   stdout. The webview posts {type:'sttStart'} when the Web Speech API
   throws not-allowed; we reply with {type:'sttResult', text} so panel.js
   appends the transcript to the prompt textarea.
   No ffmpeg, no external dependencies — uses Windows-bundled SAPI. */
let __sttProc = null;
let __sttScriptPath = null;
/* Set true when WE deliberately kill the recognizer (user clicked the mic
   again, panel disposed, sttStop message). The close handler reads this
   to avoid surfacing "killed by SIGTERM" as an error when the user just
   asked us to stop — that path posts a normal sttResult with the partial
   transcript (if any) instead of an error chip. */
let __sttUserStopped = false;
/* Markers so we can pick the real transcript out of arbitrary PS output
   (progress, warnings, $PSDefaultParameterValues echoes, etc.). The script
   prints `__CBE_STT_OK__<text>` on success and `__CBE_STT_ERR__<msg>` on
   failure. `__CBE_STT_HYP__` fires on SpeechHypothesized so the parent can
   tell "no audio came in" from "audio came in but nothing matched" — used
   to give the user an actionable error message instead of a raw signal name.
   Anything else is ignored, which avoids `exit null` looking like a transcript. */
const STT_OK_MARK = '__CBE_STT_OK__';
const STT_ERR_MARK = '__CBE_STT_ERR__';
const STT_HYP_MARK = '__CBE_STT_HYP__';
const STT_INFO_MARK = '__CBE_STT_INFO__';
const STT_PREWARM_READY_MARK = '__CBE_STT_PREWARM_READY__';
function startSapiStt(panel) {
    if (__sttProc) {
        __sttUserStopped = true;     // we're tearing down an existing one; don't surface as error
        try { __sttProc.kill(); } catch (e) {}
        __sttProc = null;
    }
    __sttUserStopped = false;
    /* Listening window — configurable via config.ini [voice] listen_seconds.
       Default 30s (up from 15) because SAPI's Recognize() blocks waiting for
       a complete utterance + EndSilenceTimeout, and on slow systems / quiet
       mics 15s wasn't enough for the InitialSilenceTimeout to even elapse. */
    let listenSeconds = 30;
    try {
        const extPath = extensionContext && extensionContext.extensionPath;
        const cfg = extPath ? readConfigIni(extPath) : null;
        const v = cfg && cfg.voice && cfg.voice.listen_seconds;
        const n = v ? parseInt(String(v).trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 5 && n <= 120) listenSeconds = n;
    } catch (_) { /* best effort */ }
    trace('stt: listenSeconds=' + listenSeconds);
    /* If a pre-warmed PowerShell is sitting at the ReadLine() pause, use it.
       That skips the 2–4s System.Speech assembly load + engine construction
       that was the entire reason early stop-clicks were producing 0-byte
       stdouts. Just send "go\n" on its stdin and attach the normal handlers. */
    if (__sttPrewarmProc && __sttPrewarmReady) {
        const proc = __sttPrewarmProc;
        const scriptPath = __sttPrewarmScriptPath;
        const engineHint = __sttPrewarmEngine || 'managed';
        __sttPrewarmProc = null;
        __sttPrewarmReady = false;
        __sttPrewarmScriptPath = null;
        __sttPrewarmEngine = '';
        trace('stt: using pre-warmed SAPI pid=' + proc.pid + ' engine=' + engineHint);
        __sttProc = proc;
        __sttScriptPath = scriptPath;
        _attachSttHandlers(panel, proc);
        try { proc.stdin.write('go\n'); proc.stdin.end(); } catch (e) {
            traceErr('stt: prewarm stdin write', e);
        }
        return;
    }
    /* Cold start: no prewarm available. Write the script + spawn now. */
    const listenSecondsStr = String(listenSeconds);
    const psLines = _buildSttPsLines(listenSecondsStr, false);
    let scriptPath;
    try {
        scriptPath = _writeSttScript(psLines);
    } catch (e) {
        traceErr('stt: write script', e);
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: 'cannot write SAPI script: ' + (e.message || e) }); } catch (_) {}
        return;
    }
    __sttScriptPath = scriptPath;
    trace('stt: spawning powershell SAPI (Sta, File=' + scriptPath + ')');
    _spawnAndAttach(panel, scriptPath);
}

/* Build the PowerShell SAPI script. When warmupMode is true, init the
   engine fully and then BLOCK on stdin ReadLine() before calling Recognize().
   Pre-warming this way removes the 2–4s cold-start cost from the user's
   first mic click (which was getting killed by impatient stop-clicks before
   the engine even bound to the mic — see debug.log's stdoutBytes=0 history). */
function _buildSttPsLines(listenSecondsStr, warmupMode) {
    /* End-silence is 1.2s — but if Recognize() returns null because the
       overall timeout fires, we have no audio info. We use the managed
       engine's events to emit hypothesis markers; the parent uses them
       to format a useful error message ("audio detected but no match"
       vs "no audio detected") instead of "killed by SIGTERM". */
    const prewarmPauseManaged = warmupMode
        ? '    Write-Host "' + STT_PREWARM_READY_MARK + 'managed"\n    [Console]::Out.Flush()\n    [Console]::In.ReadLine() | Out-Null'
        : '    # prewarm-pause disabled in cold-start mode';
    const prewarmPauseCom = warmupMode
        ? '  Write-Host "' + STT_PREWARM_READY_MARK + 'com"\n  [Console]::Out.Flush()\n  [Console]::In.ReadLine() | Out-Null'
        : '  # prewarm-pause disabled in cold-start mode';
    return [
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'function Emit-Ok($t)   { Write-Host ("' + STT_OK_MARK + '" + $t) }',
        'function Emit-Err($m)  { Write-Host ("' + STT_ERR_MARK + '" + $m) }',
        'function Emit-Hyp($t)  { Write-Host ("' + STT_HYP_MARK + '" + $t) }',
        'function Emit-Info($t) { Write-Host ("' + STT_INFO_MARK + '" + $t) }',
        '# Diagnostic: name of the current default audio capture device. Useful',
        '# when the user has the wrong mic selected in Windows sound settings.',
        'try {',
        '  $defMic = Get-CimInstance Win32_SoundDevice | Where-Object { $_.StatusInfo -eq 3 } | Select-Object -First 1 -ExpandProperty Name',
        '  if (-not $defMic) { $defMic = "(unknown)" }',
        '  [Console]::Error.WriteLine("audio: default device = " + $defMic)',
        '} catch {',
        '  [Console]::Error.WriteLine("audio: could not query default device: " + $_.Exception.Message)',
        '}',
        '[Console]::Error.WriteLine("listen window: ' + listenSecondsStr + ' seconds")',
        '$managedOk = $false',
        'try {',
        '  Add-Type -AssemblyName System.Speech -ErrorAction Stop',
        '  $managedOk = $true',
        '} catch {',
        '  [Console]::Error.WriteLine("System.Speech load failed: " + $_.Exception.Message)',
        '}',
        'if ($managedOk) {',
        '  try {',
        '    Emit-Info "engine=managed"',
        '    [Console]::Error.WriteLine("engine: System.Speech.Recognition.SpeechRecognitionEngine (managed)")',
        '    $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
        /* InitialSilenceTimeout is per-Recognize call — capped to the overall
           listen window so the user has the full window to start speaking. */
        '    $r.InitialSilenceTimeout = [TimeSpan]::FromSeconds([Math]::Max(8, [int](' + listenSecondsStr + ' - 2)))',
        '    $r.EndSilenceTimeout     = [TimeSpan]::FromSeconds(1.2)',
        '    $r.BabbleTimeout         = [TimeSpan]::FromSeconds(' + listenSecondsStr + ')',
        '    $g = New-Object System.Speech.Recognition.DictationGrammar',
        '    $r.LoadGrammar($g)',
        '    $r.SetInputToDefaultAudioDevice()',
        /* SpeechHypothesized fires as the engine hears partial words. We
           write a marker line so the parent knows "audio was heard" even
           if the final Recognize() returns null. SpeechDetected fires the
           moment the engine decides there's voice in the audio stream. */
        '    $hypHandler = [System.EventHandler[System.Speech.Recognition.SpeechHypothesizedEventArgs]]{ param($s, $e) try { Emit-Hyp $e.Result.Text } catch {} }',
        '    $r.add_SpeechHypothesized($hypHandler)',
        '    $detHandler = [System.EventHandler[System.Speech.Recognition.SpeechDetectedEventArgs]]{ param($s, $e) try { [Console]::Error.WriteLine("speech detected at " + $e.AudioPosition) } catch {} }',
        '    $r.add_SpeechDetected($detHandler)',
        prewarmPauseManaged,
        '    $res = $r.Recognize([TimeSpan]::FromSeconds(' + listenSecondsStr + '))',
        '    if ($res -and $res.Text) { Emit-Ok $res.Text } else { Emit-Ok "" }',
        '    try { $r.Dispose() } catch {}',
        '    exit 0',
        '  } catch {',
        '    [Console]::Error.WriteLine("Managed recognizer failed: " + $_.Exception.Message)',
        '  }',
        '}',
        '# COM fallback: SAPI 5.x in-proc recognizer.',
        'try {',
        '  Emit-Info "engine=com"',
        '  [Console]::Error.WriteLine("engine: SAPI.SpInprocRecognizer (COM fallback)")',
        '  $rec = New-Object -ComObject SAPI.SpInprocRecognizer',
        '  $ctx = $rec.CreateRecoContext()',
        '  $gra = $ctx.CreateGrammar(0)',
        '  $gra.DictationLoad()',
        '  $gra.DictationSetState(1)  # SGDSActive',
        prewarmPauseCom,
        '  $deadline = (Get-Date).AddSeconds(' + listenSecondsStr + ')',
        '  $got = ""',
        '  $heardAny = $false',
        '  while ((Get-Date) -lt $deadline) {',
        '    $ev = $null',
        '    try { $ev = $ctx.GetEvents(8, 200) } catch { Start-Sleep -Milliseconds 100; continue }',
        '    if ($ev -and $ev.Count -gt 0) {',
        '      foreach ($e in $ev) {',
        /* EventIds: 1=SPEI_RECOGNITION (final), 2=SPEI_HYPOTHESIS (partial),
           11=SPEI_SOUND_START, 12=SPEI_SOUND_END, 5=SPEI_PHRASE_START */
        '        if ($e.EventId -eq 1) {',
        '          try { $got = $e.RecoResult.PhraseInfo.GetText() } catch {}',
        '          break',
        '        } elseif ($e.EventId -eq 2) {',
        '          $heardAny = $true',
        '          try { Emit-Hyp $e.RecoResult.PhraseInfo.GetText() } catch {}',
        '        } elseif ($e.EventId -eq 11 -or $e.EventId -eq 5) {',
        '          $heardAny = $true',
        '        }',
        '      }',
        '      if ($got) { break }',
        '    } else {',
        '      Start-Sleep -Milliseconds 100',
        '    }',
        '  }',
        '  $gra.DictationSetState(0)',
        '  if (-not $heardAny) { [Console]::Error.WriteLine("com: no SOUND_START during listen window") }',
        '  Emit-Ok $got',
        '  exit 0',
        '} catch {',
        '  Emit-Err ("COM SAPI failed: " + $_.Exception.Message)',
        '  exit 2',
        '}',
    ];
}

function _writeSttScript(psLines) {
    const scriptPath = path.join(os.tmpdir(), 'cbe-stt-' + process.pid + '-' + Date.now() + '.ps1');
    fs.writeFileSync(scriptPath, psLines.join('\r\n'), 'utf8');
    return scriptPath;
}

/* Pre-warmed SAPI: a PowerShell child sitting at the stdin-wait inside the
   recognizer init. Sending 'go\n' to its stdin unblocks Recognize() and the
   rest of the script runs as normal. Saves the user the 2–4s cold-start cost
   on the first mic click (which previously got killed before SAPI bound to
   the mic — see debug.log's stdoutBytes=0 history). */
let __sttPrewarmProc = null;
let __sttPrewarmReady = false;
let __sttPrewarmScriptPath = null;
let __sttPrewarmEngine = '';   // 'managed' or 'com', filled when the ready marker arrives

function prewarmSapiStt() {
    if (__sttPrewarmProc) {
        return;
    }
    let listenSeconds = 30;
    try {
        const extPath = extensionContext && extensionContext.extensionPath;
        const cfg = extPath ? readConfigIni(extPath) : null;
        const v = cfg && cfg.voice && cfg.voice.listen_seconds;
        const n = v ? parseInt(String(v).trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 5 && n <= 120) listenSeconds = n;
    } catch (_) { /* best effort */ }
    const psLines = _buildSttPsLines(String(listenSeconds), true);
    let scriptPath;
    try {
        scriptPath = _writeSttScript(psLines);
    } catch (e) {
        traceErr('stt: prewarm write script', e);
        return;
    }
    __sttPrewarmScriptPath = scriptPath;
    let proc;
    try {
        proc = spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', scriptPath],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        traceErr('stt: prewarm spawn', e);
        try { fs.unlinkSync(scriptPath); } catch (_) {}
        __sttPrewarmScriptPath = null;
        return;
    }
    __sttPrewarmProc = proc;
    __sttPrewarmReady = false;
    __sttPrewarmEngine = '';
    trace('stt: prewarm spawned pid=' + proc.pid + ' file=' + scriptPath);
    let prewarmBuf = '';
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        prewarmBuf += text;
        let idx;
        while ((idx = prewarmBuf.indexOf('\n')) !== -1) {
            const line = prewarmBuf.slice(0, idx).replace(/\r$/, '');
            prewarmBuf = prewarmBuf.slice(idx + 1);
            if (line.startsWith(STT_PREWARM_READY_MARK)) {
                __sttPrewarmEngine = line.slice(STT_PREWARM_READY_MARK.length) || 'managed';
                __sttPrewarmReady = true;
                trace('stt: prewarm READY engine=' + __sttPrewarmEngine + ' pid=' + proc.pid);
            }
        }
    });
    proc.on('error', (e) => {
        trace('stt: prewarm proc error: ' + (e && e.message));
    });
    proc.on('close', (code, signal) => {
        if (__sttPrewarmProc === proc) {
            __sttPrewarmProc = null;
            __sttPrewarmReady = false;
            __sttPrewarmEngine = '';
            try { if (__sttPrewarmScriptPath) fs.unlinkSync(__sttPrewarmScriptPath); } catch (_) {}
            __sttPrewarmScriptPath = null;
            trace('stt: prewarm closed code=' + code + ' signal=' + signal);
        }
    });
}

function _spawnAndAttach(panel, scriptPath) {
    let proc;
    try {
        proc = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', scriptPath],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        traceErr('stt spawn', e);
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: 'spawn failed: ' + (e.message || e) }); } catch (_) {}
        try { fs.unlinkSync(scriptPath); } catch (_) {}
        __sttScriptPath = null;
        return;
    }
    __sttProc = proc;
    _attachSttHandlers(panel, proc);
}

function _attachSttHandlers(panel, proc) {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', err => {
        traceErr('stt proc error', err);
        if (__sttProc === proc) __sttProc = null;
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: err.message || String(err) }); } catch (_) {}
    });
    proc.on('close', (code, signal) => {
        const wasUserStop = __sttUserStopped;
        __sttUserStopped = false;
        trace('stt: ps closed code=' + code + ' signal=' + signal +
              ' stdoutBytes=' + stdout.length + ' stderrBytes=' + stderr.length +
              ' userStop=' + wasUserStop);
        if (__sttProc === proc) __sttProc = null;
        try { if (__sttScriptPath) fs.unlinkSync(__sttScriptPath); } catch (_) {}
        __sttScriptPath = null;
        /* Always log stderr to the trace channel for diagnosis — engine
           choice, default audio device, speech-detected timestamps, any
           managed-vs-COM transitions all flow through here. */
        if (stderr.trim()) trace('stt: stderr: ' + stderr.trim().replace(/\r?\n/g, ' | '));
        /* Scan stdout for our markers. We deliberately ignore the exit
           code as the primary signal because powershell scripts can
           sometimes exit non-zero even after a successful Emit-Ok (e.g.
           a Dispose() throwing during cleanup). */
        let okText = null;
        let errMsg = null;
        let lastHyp = null;
        let engineUsed = null;
        for (const raw of stdout.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith(STT_OK_MARK))       okText     = line.slice(STT_OK_MARK.length);
            else if (line.startsWith(STT_ERR_MARK)) errMsg     = line.slice(STT_ERR_MARK.length);
            else if (line.startsWith(STT_HYP_MARK)) lastHyp    = line.slice(STT_HYP_MARK.length);
            else if (line.startsWith(STT_INFO_MARK)) {
                const info = line.slice(STT_INFO_MARK.length);
                const m = info.match(/^engine=(.+)$/);
                if (m) engineUsed = m[1];
            }
        }
        if (engineUsed) trace('stt: engine used = ' + engineUsed);
        if (lastHyp) trace('stt: last hypothesis = ' + lastHyp);
        if (okText !== null) {
            try { panel.webview.postMessage({ type: 'sttResult', text: okText }); } catch (_) {}
            try { setTimeout(prewarmSapiStt, 250); } catch (_) {}
            return;
        }
        /* User-initiated stop: don't surface as an error. If we have a
           partial hypothesis, use it as the transcript so the user's
           half-spoken input still lands in the textarea. Otherwise just
           post an empty result and the panel will close the listening UI
           silently. */
        if (wasUserStop) {
            try { panel.webview.postMessage({ type: 'sttResult', text: lastHyp || '' }); } catch (_) {}
            try { setTimeout(prewarmSapiStt, 250); } catch (_) {}
            return;
        }
        /* No transcript, not a user stop: figure out the most useful
           message. Priority:
             1. Explicit STT_ERR_MARK from the script (real failure path).
             2. SIGTERM with no hypothesis => "no audio detected".
             3. SIGTERM with hypothesis    => audio was heard, recognizer
                                              couldn't lock onto a phrase.
             4. Other signals / exit codes => fall back to stderr / signal.
           This replaces the old "killed by SIGTERM" raw signal echo. */
        let err;
        if (errMsg) {
            err = errMsg;
        } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            if (lastHyp) {
                err = 'recognizer stopped — partial heard: "' + lastHyp + '". Try again, speak the full phrase.';
            } else {
                err = 'no speech detected — speak closer to the mic, or check Windows Sound settings (default input device).';
            }
        } else if (signal) {
            err = 'recognizer terminated (' + signal + ')';
        } else if (stderr.trim()) {
            err = stderr.trim().split(/\r?\n/).slice(-1)[0];
        } else {
            err = 'exit ' + (code === null ? 'null' : code);
        }
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: err }); } catch (_) {}
        /* Re-warm in the background so the NEXT mic click is also fast. */
        try { setTimeout(prewarmSapiStt, 250); } catch (_) {}
    });
}
function stopSapiStt() {
    if (!__sttProc) return;
    trace('stt: stopping ps proc (user-initiated)');
    /* Mark this as a user stop so the proc.on('close', …) handler doesn't
       surface "killed by SIGTERM" as an error chip. The close handler
       resets the flag once it consumes it. */
    __sttUserStopped = true;
    try { __sttProc.kill(); } catch (e) {}
    __sttProc = null;
    try { if (__sttScriptPath) fs.unlinkSync(__sttScriptPath); } catch (_) {}
    __sttScriptPath = null;
}

/* ── Tracing ──────────────────────────────────────────────────────────── */

/* T0 = activation start (reset on every activate() call so each run shows
   times relative to its own activation). Every trace line shows (a) the
   wall-clock ISO, (b) elapsed ms since T0, and (c) delta ms since the
   previous trace — so it's easy to see which step is slow. Output is
   written to the OutputChannel + a debug.log file next to the extension
   (truncated on each activate). Console.log is intentionally NOT used —
   it spams the DevTools console. */
let _T0 = Date.now();
let _lastTraceTs = _T0;
let _logFilePath = null;
function _resetTraceClock() { _T0 = Date.now(); _lastTraceTs = _T0; }
function _setLogFilePath(p) {
    _logFilePath = p;
    try { fs.writeFileSync(p, ''); } catch (e) { /* best effort */ }
}

function trace(msg) {
    const now = Date.now();
    const since = now - _T0;
    const delta = now - _lastTraceTs;
    _lastTraceTs = now;
    const ts = new Date(now).toISOString();
    const line = `[${ts}] [+${since}ms Δ${delta}ms] ${msg}`;
    /* Traces go ONLY to the file (debug.log next to the extension). The
       VSCode Output Channel keeps a clean 4-line banner shown at activate;
       we do not flood it with every step's timing. The file is the place
       to look for granular timing. */
    try {
        if (_logFilePath) fs.appendFileSync(_logFilePath, line + '\n');
    } catch (e) {
        try { process.stderr.write(`[codex-black] trace.file failed: ${e && e.message}\n`); } catch (_e) {}
    }
}

/* Returns a closure that traces "<label> done in Nms" when called. Use to
   bracket a chunk of work: const end = timeStep('foo'); ...work...; end(); */
function timeStep(label) {
    const t0 = Date.now();
    trace(`▶ ${label} start`);
    return (extra) => {
        const ms = Date.now() - t0;
        trace(`✔ ${label} done (${ms}ms)${extra ? ' ' + extra : ''}`);
        return ms;
    };
}

function traceErr(msg, err) {
    const stack = err && err.stack ? '\n' + err.stack : '';
    trace('ERROR: ' + msg + (err ? ' :: ' + (err.message || err) : '') + stack);
}

function setStatus(text, busy, providerId) {
    if (!statusBar) return;
    const tag = providerId ? ` [${PROVIDERS[providerId] ? PROVIDERS[providerId].label.split(' ')[0] : providerId}]` : '';
    statusBar.text = (busy ? '$(sync~spin) ' : '$(circle-large-outline) ') + 'CBE: ' + text + tag;
    statusBar.show();
}

/* ── Activation ───────────────────────────────────────────────────────── */

async function activate(context) {
    extensionContext = context;
    outChan = vscode.window.createOutputChannel('Claude Codex Black');
    /* Clear stale entries from a previous activation so each run's timing
       is readable on its own. (VS Code keeps the OutputChannel alive across
       window reloads, so without this the log just keeps appending.) */
    try { outChan.clear(); } catch (e) { /* clear is best-effort */ }
    /* Print the clean banner — this is ALL the user sees in the Output
       Channel. Granular timing/traces go to debug.log on disk. */
    try {
        outChan.appendLine('Claude Codex Black Ed. Loaded');
        outChan.appendLine('Trenton Tompkins <trenttompkins@gmail.com> (c) 2006 Released under the MIT license.');
        outChan.appendLine('See license.txt or type /license');
        outChan.appendLine('Call (724) 431-5207 to discuss your next project! (PHP, Python, node.js - desktop, web and mobile)');
        outChan.appendLine('https://trentontompkins.com    https://github.com/tibberous');
    } catch (e) { /* output channel might not be ready, best-effort */ }
    /* Reset T0 to NOW so all timing deltas in this run are relative to
       this activation, not the module-load time of an earlier session. */
    _resetTraceClock();
    /* File-backed log so we can read the timing offline (debug.log next to
       the extension — truncated on each activate). */
    _setLogFilePath(path.join(context.extensionPath, 'debug.log'));
    /* Drop any cached Config from a previous activation so this run picks
       up edits the user made to config.ini between sessions. */
    Config.invalidate();
    const endActivate = timeStep('activate()');
    trace('=== activate === extPath=' + context.extensionPath);
    trace('  log file: ' + path.join(context.extensionPath, 'debug.log'));
    const endSecrets = timeStep('refreshSecretsCache');
    await refreshSecretsCache(context);
    endSecrets();
    trace('  secretsCache populated: ' + Object.keys(secretsCache).filter(k => secretsCache[k]).join(',') || '(none)');
    trace('  activeProvider=' + getActiveProvider(context) + ' model=' + getActiveModel(context, getActiveProvider(context)));

    const endStatusBar = timeStep('  createStatusBarItem');
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBar.command = 'codexBlackEd.openPanel';
    // Explicit tooltip — VSCode's auto-rendered "(<keybinding>)" trailer
    // can be misleading when the registered keybinding loses to a built-in
    // resolver collision. Stating it directly here means hover text matches
    // what actually works on the user's keymap. The string is treated as
    // Markdown; backticks render the chord as code.
    statusBar.tooltip = 'Claude Codex Black — click to open · `Ctrl+Alt+B`';
    setStatus('idle', false, getActiveProvider(context));
    context.subscriptions.push(statusBar);
    /* Second status-bar item: standalone "Web Browser" button that opens
       the NN4 webview. Keeps the retro-stupid browser one click away from
       anywhere in VSCode, no need to open the chat panel first. */
    const browserStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    browserStatusBar.command = 'codexBlackEd.openBrowser';
    browserStatusBar.text = '$(browser) Web';
    browserStatusBar.tooltip = 'Open NN4 Web Browser — `Ctrl+Alt+N`';
    browserStatusBar.show();
    context.subscriptions.push(browserStatusBar);
    endStatusBar();

    const endCmds = timeStep('  registerCommands');
    context.subscriptions.push(
        vscode.commands.registerCommand('codexBlackEd.openPanel', () => openPanel(context)),
        /* Alias kept for command-palette convenience and for chord bindings
           that want a shorter id. Behaviour identical to openPanel. */
        vscode.commands.registerCommand('codexBlackEd.show', () => openPanel(context)),
        vscode.commands.registerCommand('codexBlackEd.openSettings', () => {
            if (activePanel) activePanel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
            else openPanel(context);
        }),
        vscode.commands.registerCommand('codexBlackEd.setApiKey', () => setApiKey(context)),
        vscode.commands.registerCommand('codexBlackEd.clearApiKey', () => clearApiKey(context)),
        vscode.commands.registerCommand('codexBlackEd.resetConversation', () => {
            conversation = [];
            trace('conversation reset');
            if (activePanel) activePanel.webview.postMessage({ type: 'info', text: 'Conversation reset.' });
        }),
        vscode.commands.registerCommand('codexBlackEd.showTrace', () => outChan.show(true)),
        /* Web Browser command — opens (or reveals) the NN4-skinned browser
           webview panel directly, without needing to first open the chat
           panel + click the Browser button. Mirrors the openNN4Browser
           message handler. Reachable via Ctrl+Alt+N, the editor title bar,
           the command palette, and the status-bar button below. */
        /* Video library — opens panel/video-player.html in a new webview
           panel rooted at videos/. Auto-plays newly generated files; the
           2s watcher tick keeps the list live so a sora/veo/runway/
           bing-video generation that completes mid-session pops up in
           the player without a manual refresh. */
        vscode.commands.registerCommand('codexBlackEd.openVideoPlayer', () => {
            try {
                if (!_videoPlayerPanel) {
                    const videosRoot = path.join(context.extensionPath, 'videos');
                    if (!fs.existsSync(videosRoot)) fs.mkdirSync(videosRoot, { recursive: true });
                    _videoPlayerPanel = vscode.window.createWebviewPanel(
                        'codexBlackEd.videoPlayer',
                        'CBE Video Library',
                        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true,
                            // Crucial: webviews can only load files under listed roots.
                            // The videos/ dir is where the bridge runner saves outputs.
                            localResourceRoots: [vscode.Uri.file(videosRoot)],
                        }
                    );
                    loadVideoPlayerHtml(context, _videoPlayerPanel).catch(e =>
                        traceErr('loadVideoPlayerHtml', e));
                    _videoPlayerPanel.onDidDispose(() => {
                        _videoPlayerPanel = null;
                        if (_videoPlayerWatcher) {
                            clearInterval(_videoPlayerWatcher);
                            _videoPlayerWatcher = null;
                        }
                    });
                } else {
                    _videoPlayerPanel.reveal(vscode.ViewColumn.Active);
                }
            } catch (e) {
                traceErr('openVideoPlayer command', e);
                vscode.window.showErrorMessage('Failed to open Video Library: ' + (e && e.message || String(e)));
            }
        }),
        vscode.commands.registerCommand('codexBlackEd.openBrowser', () => {
            try {
                if (!_nn4BrowserPanel) {
                    _nn4BrowserPanel = vscode.window.createWebviewPanel(
                        'codexBlackEd.nn4Browser',
                        'Netscape Navigator 4.0 — CBE',
                        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                        { enableScripts: true, retainContextWhenHidden: true }
                    );
                    loadNn4BrowserHtml(context, _nn4BrowserPanel).catch(e =>
                        traceErr('loadNn4BrowserHtml (command)', e));
                    _nn4BrowserPanel.onDidDispose(() => {
                        _nn4BrowserPanel = null;
                        stopNn4ProxySidecar();
                    });
                } else {
                    _nn4BrowserPanel.reveal(vscode.ViewColumn.Active);
                }
            } catch (e) {
                traceErr('openBrowser command', e);
                vscode.window.showErrorMessage('Failed to open Web Browser: ' + (e && e.message || String(e)));
            }
        }),
        /* Manual auto-update trigger — fires the same WinSCP push the
           background activate hook would, but on demand so you don't have
           to close+reopen the panel just to retry a push. Also reachable
           via the /push slash command. */
        vscode.commands.registerCommand('codexBlackEd.pushUpdate', () => {
            try {
                pushUpdateToServer(context);
                if (activePanel) activePanel.webview.postMessage({ type: 'info', text: 'Auto-update push started — see logs/winscp_push_*.xml for results.' });
            } catch (e) {
                traceErr('codexBlackEd.pushUpdate', e);
                if (activePanel) activePanel.webview.postMessage({ type: 'error', message: 'pushUpdate failed: ' + (e.message || e) });
            }
        }),
        /* Slash-command palette mirrors — every CBE_COMMANDS entry from
           panel/panel.js also gets a real VSCode command id so it shows up
           in the Marketplace "Commands" section and in the Command Palette.
           Each handler ensures the panel is open, then posts a message that
           the panel's slash-command runner reads via window message events.
           The message types here match the postMessage `type` strings used
           inside CBE_COMMANDS run() bodies. */
        vscode.commands.registerCommand('codexBlackEd.slash.help',     () => runSlashCommand(context, 'help')),
        vscode.commands.registerCommand('codexBlackEd.slash.handbook', () => runSlashCommand(context, 'handbook')),
        vscode.commands.registerCommand('codexBlackEd.slash.clear',    () => runSlashCommand(context, 'clear')),
        vscode.commands.registerCommand('codexBlackEd.slash.settings', () => runSlashCommand(context, 'settings')),
        vscode.commands.registerCommand('codexBlackEd.slash.prompts',  () => runSlashCommand(context, 'prompts')),
        vscode.commands.registerCommand('codexBlackEd.slash.history',  () => runSlashCommand(context, 'history')),
        vscode.commands.registerCommand('codexBlackEd.slash.font',     () => runSlashCommand(context, 'font')),
        vscode.commands.registerCommand('codexBlackEd.slash.attach',   () => runSlashCommand(context, 'attach')),
        vscode.commands.registerCommand('codexBlackEd.slash.folder',   () => runSlashCommand(context, 'folder')),
        vscode.commands.registerCommand('codexBlackEd.slash.compact',  () => runSlashCommand(context, 'compact')),
        vscode.commands.registerCommand('codexBlackEd.slash.compress', () => runSlashCommand(context, 'compact')),
        vscode.commands.registerCommand('codexBlackEd.slash.git',      () => runSlashCommand(context, 'git')),
        vscode.commands.registerCommand('codexBlackEd.slash.github',   () => runSlashCommand(context, 'github')),
        vscode.commands.registerCommand('codexBlackEd.slash.license',  () => runSlashCommand(context, 'license')),
        vscode.commands.registerCommand('codexBlackEd.slash.push',     () => runSlashCommand(context, 'push')),
        vscode.commands.registerCommand('codexBlackEd.slash.switchAccounts', () => runSlashCommand(context, 'switchAccounts')),
        /* If the user closes our terminal, drop the reference so the next
           click on the Terminal button creates a fresh one in the right cwd. */
        vscode.window.onDidCloseTerminal((t) => { if (t === cbeTerm) cbeTerm = null; }),
        outChan,
    );
    endCmds(`(${25} commands)`);

    /* Auto-update gate — respects BOTH our own toggle
       (codexBlackEd.autoUpdate.enabled) AND VS Code's global
       `extensions.autoUpdate` (which can be true | false |
       "onlyEnabledExtensions" | "onlySelectedExtensions"). We treat any
       truthy non-"false" value of the global setting as "auto-update on"
       because for an enabled extension all of those modes mean
       "this extension is allowed to auto-update". */
    const ourAutoUpdate    = vscode.workspace.getConfiguration('codexBlackEd.autoUpdate').get('enabled', true);
    const ourPushOnActivate = vscode.workspace.getConfiguration('codexBlackEd.autoUpdate').get('pushOnActivate', true);
    const vscodeAutoUpdate = vscode.workspace.getConfiguration('extensions').get('autoUpdate', true);
    const vscodeAutoUpdateOn = vscodeAutoUpdate === true
        || vscodeAutoUpdate === 'onlyEnabledExtensions'
        || vscodeAutoUpdate === 'onlySelectedExtensions';

    /* Background admin push — deferred via setImmediate so activation finishes
       before WinSCP spawns. No-op on non-admin machines (is_admin=false in
       config.ini). Failures land in logs/winscp_push_*.xml so the panel boot
       isn't disturbed. Gated by both our pushOnActivate toggle and VS
       Code's global extensions.autoUpdate setting. */
    if (ourPushOnActivate && vscodeAutoUpdateOn) {
        setImmediate(() => { try { pushUpdateToServer(context); } catch (e) { traceErr('pushUpdateToServer', e); } });
    } else {
        trace(`UPDATE:PUSH skipped — ours=${ourPushOnActivate} vscode=${vscodeAutoUpdate}`);
    }
    /* Auto-pull: every client (admin or not) fetches the server manifest a
       few seconds after activate, then MD5-compares per-file and downloads
       only changed/missing files. Excludes user-local state (config.ini,
       debug.log, domains.txt, etc) so personal config is never clobbered.
       Gated by both our autoUpdate.enabled toggle and VS Code's global
       extensions.autoUpdate setting. */
    if (ourAutoUpdate && vscodeAutoUpdateOn) {
        setTimeout(() => pullUpdateFromServer(context, { silent: true }).catch(e => traceErr('pullUpdateFromServer', e)), 4000);
    } else {
        trace(`UPDATE:PULL skipped — ours=${ourAutoUpdate} vscode=${vscodeAutoUpdate}`);
    }
    /* Load i18n language files from languages/*.xml on activate so the
       translation table is in memory before the panel asks for strings. */
    try { loadLanguageFiles(context); } catch (e) { traceErr('loadLanguageFiles', e); }

    /* Serializer intentionally disposes any restored panel instead of rebinding it
       so closing the tab keeps it closed across window reloads. The old behavior
       (`bindPanel(context, webviewPanel)`) made the panel auto-resurrect on every
       reload — see handbook §0822 "VSCode Extension Writing > WebviewPanelSerializer
       makes panels resurrect themselves" for the rationale. */
    const endSer = timeStep('  registerWebviewPanelSerializer');
    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', {
                async deserializeWebviewPanel(webviewPanel) {
                    try { webviewPanel.dispose(); } catch (e) { traceErr('deserialize-dispose', e); }
                }
            })
        );
    }
    endSer();
    /* On activate, also close any stale instances of this panel type that
       VSCode tried to restore before the dispose-on-deserialize hook fired.
       This is the "delete the old panels" guarantee. */
    const endSweep = timeStep('  stalePanelSweep');
    let sweepCount = 0, closedCount = 0;
    try {
        for (const grp of (vscode.window.tabGroups && vscode.window.tabGroups.all) || []) {
            for (const tab of (grp.tabs || [])) {
                sweepCount++;
                const vt = tab.input && tab.input.viewType;
                if (typeof vt === 'string' && vt.endsWith('codexBlackEd.panel')) {
                    try { vscode.window.tabGroups.close(tab, true); closedCount++; }
                    catch (e) { traceErr('close-stale-panel', e); }
                }
            }
        }
    } catch (e) { traceErr('stale-panel-sweep', e); }
    endSweep(`scanned=${sweepCount} closed=${closedCount}`);

    /* ── Bridge auto-start + Ollama discovery ─────────────────────────────
       If the active provider is a bridge (claudeBridge, chatgptBridge, etc),
       spawn its tray exe NOW so the first chat doesn't pay a cold-start.
       Mirrors the same ensureBridge() call that streamBridge() makes, but
       runs in the background so activation isn't blocked by an 8s probe.
       Same for Ollama: if the active provider is "ollamaBridge" or the
       new "ollama" registry entry, discover + daemon-start in the bg. */
    setTimeout(() => {
        try {
            const activeId = getActiveProvider(context);
            const provider = PROVIDERS[activeId];
            if (provider && provider.bridge && provider.bridgeTarget) {
                const target = provider.bridgeTarget;
                trace(`BRIDGE:AUTOSTART target=${target} (active provider=${activeId})`);
                killOtherBridgeTrays(target);
                ensureBridge(context, target, { timeoutMs: 8000 })
                    .then((r) => trace(`BRIDGE:AUTOSTART target=${target} result=${r.ok ? 'ok' : 'fail'} ${r.reason || ''}`))
                    .catch((e) => traceErr(`BRIDGE:AUTOSTART target=${target}`, e));
            }
            /* Ollama: any time the user has the local provider selected,
               make sure the daemon is breathing. Doesn't auto-install — that
               requires a click on the panel install button. */
            if (activeId === 'ollamaBridge' || activeId === 'ollama') {
                ensureOllamaReady({ timeoutMs: 8000 })
                    .then((r) => {
                        trace(`OLLAMA:AUTOSTART state=${r.state} models=${(r.models || []).length}`);
                        if (activePanel) {
                            activePanel.webview.postMessage({ type: 'ollamaStatus', ...r });
                        }
                    })
                    .catch((e) => traceErr('OLLAMA:AUTOSTART', e));
            }
        } catch (e) { traceErr('activate bridge-autostart block', e); }
    }, 200);

    endActivate();
    trace('=== activate complete ===');

    /* Pre-warm a SAPI PowerShell so the first mic click doesn't pay the 2–4s
       cold-start cost (which was getting the recognizer killed before it
       even bound to the mic; see debug.log's stdoutBytes=0 history). */
    try { setTimeout(prewarmSapiStt, 500); } catch (_) {}
}

function deactivate() {
    trace('=== deactivate ===');
    try {
        if (__sttPrewarmProc) {
            __sttPrewarmProc.kill();
            __sttPrewarmProc = null;
            __sttPrewarmReady = false;
            if (__sttPrewarmScriptPath) {
                try { fs.unlinkSync(__sttPrewarmScriptPath); } catch (_) {}
                __sttPrewarmScriptPath = null;
            }
        }
    } catch (_) {}
}

/* ── Settings payload (sent to webview to populate the settings modal) ── */

/* ── Skin discovery ───────────────────────────────────────────────────────
   Skins are FOLDERS inside <extension>/skins. Each folder contains:
     manifest.xml  — <skin><id><name><version><author><description><accent></skin>
     styles.css    — the actual override stylesheet (linked at runtime)
     assets/       — optional supporting files (icons, gifs, fonts)
   The discovery scan is lazy: every `listSkins` call hits the filesystem
   fresh so dropping a new skin folder works without restarting the panel.
   `resolveSkin()` validates a requested skin id against the current
   on-disk folders before we apply it. */
function parseSkinManifest(manifestPath) {
    /* Tiny ad-hoc parser — manifest.xml is shallow, no attrs. Reads
       <tagName>value</tagName> pairs at any depth (so nested <colors><...>
       still resolves). Anything not matched falls back to a sensible default
       at the caller. */
    try {
        const xml = fs.readFileSync(manifestPath, 'utf8');
        const pick = (tag) => {
            const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
            return m ? m[1].trim() : '';
        };
        return {
            id:          pick('id'),
            name:        pick('name'),
            version:     pick('version'),
            author:      pick('author'),
            accent:      pick('accent'),
            stylesheet:  pick('stylesheet') || 'styles.css',
            description: pick('description'),
            /* Modal palette — pushed to :root as --cbe-modal-* vars on apply.
               Tags inside <colors> live at the same regex grep level so the
               flat pick() picks them up too. Empty string = "use default". */
            colors: {
                'modal-bg':         pick('modal-bg'),
                'modal-fg':         pick('modal-fg'),
                'modal-border':     pick('modal-border'),
                'modal-title-bg-1': pick('modal-title-bg-1'),
                'modal-title-bg-2': pick('modal-title-bg-2'),
                'modal-title-fg':   pick('modal-title-fg'),
                'modal-foot-bg':    pick('modal-foot-bg'),
                'modal-accent':     pick('modal-accent'),
                'highlight-color':  pick('highlight-color'),
                'code-bar-bg':      pick('code-bar-bg'),
                'code-bar-fg':      pick('code-bar-fg'),
            },
        };
    } catch (_) {
        return null;
    }
}

function listSkins(context, webview) {
    const dir = path.join(context.extensionPath, SKINS_DIR_NAME);
    let entries = [];
    try {
        if (!fs.existsSync(dir)) return [];
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        traceErr('listSkins', e);
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skinRoot = path.join(dir, ent.name);
        const manifestPath = path.join(skinRoot, 'manifest.xml');
        if (!fs.existsSync(manifestPath)) continue;
        const meta = parseSkinManifest(manifestPath);
        if (!meta) continue;
        const cssPath = path.join(skinRoot, meta.stylesheet);
        if (!fs.existsSync(cssPath)) continue;
        const uri = webview
            ? webview.asWebviewUri(vscode.Uri.file(cssPath)).toString()
            : '';
        out.push({
            name:        ent.name,                     /* directory id, used as the picker value */
            label:       meta.name || ent.name,        /* pretty display name from <name> */
            uri,
            accent:      meta.accent || '',
            author:      meta.author || '',
            description: meta.description || '',
            colors:      meta.colors || null,          /* modal palette, applied as :root --cbe-modal-* vars */
        });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
}

function resolveSkin(context, requestedName) {
    /* '' / unknown id → cleared skin. Otherwise return the styles.css path
       as a vscode.Uri plus the parsed modal-color palette so the caller
       can push both to the webview in a single message. */
    if (!requestedName) return { name: '', uri: null, colors: null };
    const dir = path.join(context.extensionPath, SKINS_DIR_NAME);
    const safe = path.basename(requestedName);   /* strip any path traversal */
    const skinRoot = path.join(dir, safe);
    const manifestPath = path.join(skinRoot, 'manifest.xml');
    try {
        if (!fs.existsSync(manifestPath)) return { name: '', uri: null, colors: null };
        const meta = parseSkinManifest(manifestPath);
        if (!meta) return { name: '', uri: null, colors: null };
        const cssPath = path.join(skinRoot, meta.stylesheet || 'styles.css');
        if (!fs.existsSync(cssPath)) return { name: '', uri: null, colors: null };
        return { name: safe, uri: vscode.Uri.file(cssPath), colors: meta.colors || null };
    } catch (_) {
        return { name: '', uri: null, colors: null };
    }
}

/* ── VSCode supervisor service ───────────────────────────────────────────
   "VSCode monitor" button = toggle for a Windows service that keeps Code.exe
   alive. If VSCode dies (crash/OOM/GPU fault) the service respawns it. The
   service wraps tools/vscode_supervisor.ps1.

   Service name: CBEVSCodeSupervisor
   Initial install requires UAC elevation (sc.exe create). After install, the
   service ACL is widened so the current user can start/stop without UAC.
   Subsequent toggles are zero-prompt. */
const SUPERVISOR_SERVICE_NAME = 'CBEVSCodeSupervisor';
const SUPERVISOR_DISPLAY_NAME = 'Claude Codex Black — VSCode Supervisor';
/* The supervisor.ps1 script binds its liveness HTTP listener here. Single
   source of truth so the probe, the announcements, and the script stay in
   sync. Override with the CBE_SUPERVISOR_PORT env var if 3434 is taken. */
const SUPERVISOR_PORT = parseInt(process.env.CBE_SUPERVISOR_PORT || '3434', 10) || 3434;

let _supervisorLastRestartAt = 0;

function _supervisorHttpAlive() {
    /* Quick liveness probe — supervisor.ps1 binds 127.0.0.1:3434 and replies
       to GET / with `Status: 200 OK` and a JSON status blob. A 200 here is
       proof the script is actually executing inside its NSSM-managed process,
       not just that SCM thinks the service is running. Returns a Promise that
       resolves to true on 200 within 700ms, false otherwise. */
    return new Promise((resolve) => {
        try {
            const http = require('http');
            const req = http.request({ host: '127.0.0.1', port: SUPERVISOR_PORT, path: '/', method: 'GET', timeout: 700 }, (res) => {
                const ok = res.statusCode === 200;
                res.resume(); /* drain so the socket can close */
                resolve(ok);
            });
            req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
            req.on('error', () => resolve(false));
            req.end();
        } catch (_) { resolve(false); }
    });
}

function _scQueryState(serviceName) {
    /* Returns 'running' | 'stopped' | 'not-installed' | 'unknown'. Read-only,
       no UAC needed. */
    try {
        const r = require('child_process').spawnSync('sc.exe', ['query', serviceName], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) return 'not-installed';
        const m = /STATE\s*:\s*\d+\s+(\w+)/i.exec(r.stdout || '');
        if (!m) return 'unknown';
        const s = m[1].toUpperCase();
        if (s === 'RUNNING' || s === 'START_PENDING') return 'running';
        if (s === 'STOPPED' || s === 'STOP_PENDING') return 'stopped';
        return s.toLowerCase();
    } catch (_) {
        return 'unknown';
    }
}

function _supervisorScriptPath(context) {
    return path.join(context.extensionPath, 'tools', 'vscode_supervisor.ps1');
}

function _nssmPath(context) {
    return path.join(context.extensionPath, 'tools', 'nssm.exe');
}

function _resolveCodeExePath() {
    /* Find the running Code.exe. process.execPath in the extension host IS
       Code.exe on Windows, but we double-check that the basename matches —
       on remote/SSH hosts it might be node.exe instead, in which case we
       fall back to a couple of canonical install locations. */
    try {
        const exe = process.execPath || '';
        if (exe && /\bCode\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
    } catch (_) {}
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
    ];
    for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
    return null;
}

function _runElevated(psCommand, label) {
    /* Run a PowerShell snippet with -Verb RunAs so it pops UAC once and
       executes elevated. We write the command to a temp .ps1 file and run
       it by path — far safer than threading a multi-line script through
       JSON.stringify and PowerShell's -Command parser (which previously
       double-escaped backslashes and quotes, mangling sc.exe's binPath). */
    return new Promise((resolve) => {
        let scriptFile = null;
        try {
            const cp = require('child_process');
            const tmp = path.join(os.tmpdir(), `cbe_supervisor_${label}_${Date.now()}.ps1`);
            // Wrap the script in a try/catch so failures land in a log we can
            // inspect later instead of vanishing across the UAC boundary.
            const logFile = path.join(os.tmpdir(), 'cbe_supervisor_install.log');
            const wrapped =
                `$ErrorActionPreference = 'Continue'\r\n` +
                `Start-Transcript -Path '${logFile.replace(/'/g, "''")}' -Append -Force | Out-Null\r\n` +
                `try {\r\n${psCommand}\r\n} catch { Write-Output "ERROR: $($_.Exception.Message)" }\r\n` +
                `Stop-Transcript | Out-Null\r\n`;
            fs.writeFileSync(tmp, wrapped, { encoding: 'utf8' });
            scriptFile = tmp;
            const outer = [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
                // Inner Start-Process: PowerShell unwraps the -ArgumentList
                // and passes -File <tmp.ps1> to the elevated child. No quote
                // escaping inside the script body itself.
                `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp.replace(/'/g, "''")}')`,
            ];
            const child = cp.spawn('powershell.exe', outer, { windowsHide: true });
            child.on('exit', (code) => {
                trace(`SUPERVISOR:${label}:elevated-exit code=${code} script=${tmp}`);
                // Leave the temp .ps1 + transcript on disk for postmortem if it failed.
                if (code === 0) { try { fs.unlinkSync(tmp); } catch (_) {} }
                resolve(code === 0);
            });
            child.on('error', (e) => { traceErr(`SUPERVISOR:${label}:elevated-error`, e); resolve(false); });
        } catch (e) {
            traceErr(`SUPERVISOR:${label}:spawn-error`, e);
            if (scriptFile) { try { fs.unlinkSync(scriptFile); } catch (_) {} }
            resolve(false);
        }
    });
}

async function installSupervisorService(context) {
    /* One-time install: wrap the supervisor .ps1 as a Windows service via
       NSSM (Non-Sucking Service Manager). A raw `powershell.exe -File foo.ps1`
       under sc.exe always fails error 1053 because PowerShell never signals
       SERVICE_RUNNING back to SCM. NSSM is a tiny ~330KB exe that handles
       the SCM dance and stop signals correctly.
       After install, we widen the service ACL with sc.exe sdset so
       Authenticated Users can start/stop without re-prompting UAC. */
    const scriptPath = _supervisorScriptPath(context);
    if (!fs.existsSync(scriptPath)) {
        throw new Error('vscode_supervisor.ps1 not found at ' + scriptPath);
    }
    const nssm = _nssmPath(context);
    if (!fs.existsSync(nssm)) {
        throw new Error('nssm.exe not found at ' + nssm + ' (re-bundle the extension)');
    }
    const codePath = _resolveCodeExePath();
    if (!codePath) {
        throw new Error('could not locate Code.exe to supervise');
    }
    const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const psExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    // ── The space-free-path strategy ──────────────────────────────────────
    // The extension lives under "...\Claude Codex Black\tools\" — a path WITH
    // SPACES. Every prior attempt to pass `-File "<spaced path>" -CodePath
    // "<spaced path>"` through NSSM's AppParameters had the embedded quotes
    // mangled (PowerShell argv handling + nssm re-parse + reg.exe). The fix:
    //   1. Copy the supervisor script to C:\ProgramData\cbe\ (NO spaces).
    //   2. Write the Code.exe path to C:\ProgramData\cbe\code_path.txt — the
    //      script reads it from there, so AppParameters needs NO -CodePath
    //      arg and therefore NO embedded quotes at all.
    //   3. AppParameters becomes a plain space-delimited string with one
    //      space-free -File path. Nothing to mangle.
    const deployDir    = 'C:\\ProgramData\\cbe';
    const deployScript = deployDir + '\\vscode_supervisor.ps1';
    const codePathFile = deployDir + '\\code_path.txt';
    const stdoutLog    = deployDir + '\\supervisor.stdout.log';
    const stderrLog    = deployDir + '\\supervisor.stderr.log';
    // AppParameters: every token is space-free, so no quoting survives-or-dies
    // games. The script self-resolves Code.exe from code_path.txt.
    const appParams = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ${deployScript}`;
    const ps = [
        // 1. Stage the script + code path into the space-free deploy dir.
        `New-Item -ItemType Directory -Force -Path ${sq(deployDir)} | Out-Null`,
        `Copy-Item -Force ${sq(scriptPath)} ${sq(deployScript)}`,
        `Set-Content -Path ${sq(codePathFile)} -Value ${sq(codePath)} -Encoding ascii -NoNewline`,
        // 2. Reinstall the service from scratch.
        `& ${sq(nssm)} stop ${SUPERVISOR_SERVICE_NAME} 2>&1 | Out-Null`,
        `& ${sq(nssm)} remove ${SUPERVISOR_SERVICE_NAME} confirm 2>&1 | Out-Null`,
        `Start-Sleep -Seconds 1`,
        `& ${sq(nssm)} install ${SUPERVISOR_SERVICE_NAME} ${sq(psExe)}`,
        // AppParameters is space-free — a plain `nssm set` is safe now.
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppParameters     ${sq(appParams)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppDirectory      ${sq(deployDir)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} DisplayName       ${sq(SUPERVISOR_DISPLAY_NAME)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Description       ${sq('Keeps VSCode (Code.exe) alive - relaunches on crash. Serves /status on :3434. Managed by Claude Codex Black.')}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Start             SERVICE_AUTO_START`,
        // AppNoConsole 1 — no console window flashes when the service starts.
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppNoConsole      1`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStdout         ${sq(stdoutLog)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStderr         ${sq(stderrLog)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppRotateFiles    1`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppRotateBytes    1048576`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStopMethodSkip    0`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStopMethodConsole 3000`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} ObjectName        LocalSystem`,
        // SDDL: SY=LocalSystem (full), BA=BuiltinAdmins (full),
        // AU=AuthUsers (start/stop/query) — so post-install toggles need no UAC.
        `sc.exe sdset ${SUPERVISOR_SERVICE_NAME} 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLORC;;;AU)' | Out-Null`,
        `sc.exe start ${SUPERVISOR_SERVICE_NAME} 2>&1 | Out-Null`,
        `Write-Output "INSTALL_OK"`,
    ].join("\r\n");
    const ok = await _runElevated(ps, 'install');
    if (!ok) throw new Error('elevated install failed (UAC denied or NSSM error — see %TEMP%\\cbe_supervisor_install.log)');
    return _scQueryState(SUPERVISOR_SERVICE_NAME);
}

function startSupervisorService() {
    /* No UAC needed if install widened the ACL. Returns true on success. */
    const r = require('child_process').spawnSync('sc.exe', ['start', SUPERVISOR_SERVICE_NAME], { encoding: 'utf8', windowsHide: true });
    trace(`SUPERVISOR:start rc=${r.status} stdout=${(r.stdout||'').trim().slice(0,200)} stderr=${(r.stderr||'').trim().slice(0,200)}`);
    return r.status === 0;
}

function stopSupervisorService() {
    const r = require('child_process').spawnSync('sc.exe', ['stop', SUPERVISOR_SERVICE_NAME], { encoding: 'utf8', windowsHide: true });
    trace(`SUPERVISOR:stop rc=${r.status} stdout=${(r.stdout||'').trim().slice(0,200)} stderr=${(r.stderr||'').trim().slice(0,200)}`);
    return r.status === 0;
}

function _waitForServiceState(target, timeoutMs) {
    /* sc.exe start/stop return immediately while the service is still in
       START_PENDING / STOP_PENDING. Poll _scQueryState briefly so the UI
       reflects the final state instead of the transient one. */
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
            const s = _scQueryState(SUPERVISOR_SERVICE_NAME);
            if (s === target || s === 'not-installed' || Date.now() - t0 > timeoutMs) return resolve(s);
            setTimeout(tick, 250);
        };
        tick();
    });
}

async function toggleSupervisorService(context, panel) {
    const before = _scQueryState(SUPERVISOR_SERVICE_NAME);
    trace(`SUPERVISOR:toggle state-before=${before}`);
    let after = before;
    try {
        if (before === 'not-installed') {
            panel.webview.postMessage({ type: 'info', text: 'Installing VSCode supervisor service (UAC will prompt)…' });
            await installSupervisorService(context);
            startSupervisorService();
            after = await _waitForServiceState('running', 8000);
            panel.webview.postMessage({ type: 'info', text: `Supervisor: ${after}.` });
        } else if (before === 'running') {
            stopSupervisorService();
            after = await _waitForServiceState('stopped', 8000);
            panel.webview.postMessage({ type: 'info', text: 'Supervisor stopped.' });
        } else {
            startSupervisorService();
            after = await _waitForServiceState('running', 8000);
            panel.webview.postMessage({ type: 'info', text: 'Supervisor started.' });
        }
    } catch (e) {
        traceErr('SUPERVISOR:toggle', e);
        panel.webview.postMessage({ type: 'error', message: 'Supervisor toggle failed: ' + (e.message || e) });
    }
    /* Announce the bound port to the output channel so the user can see
       exactly what the supervisor is listening on (and probe it by hand). */
    try {
        if (outChan) {
            if (after === 'running') {
                const alive = await _supervisorHttpAlive();
                outChan.appendLine(`[supervisor] service ${SUPERVISOR_SERVICE_NAME} is RUNNING — bound to http://127.0.0.1:${SUPERVISOR_PORT}/ (liveness probe: ${alive ? '200 OK' : 'no response yet'})`);
            } else {
                outChan.appendLine(`[supervisor] service ${SUPERVISOR_SERVICE_NAME} is ${String(after).toUpperCase()} — port ${SUPERVISOR_PORT} not bound`);
            }
            outChan.show(true);
        }
    } catch (e) { traceErr('SUPERVISOR:port-announce', e); }
    panel.webview.postMessage({ type: 'monitorState', running: after === 'running', state: after, port: SUPERVISOR_PORT });
    return after;
}

/* ── NameSilo domain list ────────────────────────────────────────────────
   Reads the API key from config.ini ([namesilo] api_key, fallback
   [api_keys].namesilo_api_key), hits /listDomains then /getDomainInfo per
   domain for nameservers. Returns { domains: [{name, nameservers[]}] } or
   { error: '...' }. Pure stdlib — uses node's https module, no axios. */
// NameSilo reply.code dictionary. Per their public docs at
// https://www.namesilo.com/api-reference — `300` is the only success code;
// everything else is an error worth surfacing verbatim instead of swallowing
// to "0 domains". List below covers all auth/billing/validation paths we
// could plausibly hit; anything not in the map falls back to "API code N".
const NAMESILO_CODES = {
    300: 'Success',
    301: 'Success (partial)',
    302: 'Pending',
    110: 'Invalid API version',
    200: 'Authentication issue',
    201: 'API key missing',
    250: 'Bad request / no command',
    251: 'Internal system error',
    252: 'Domain locked',
    253: 'API access denied for this command',
    254: 'Required parameter missing',
    255: 'Invalid parameter value',
    256: 'Domain not in your account',
    257: 'Domain expired',
    258: 'Domain not accepting transfers',
    259: 'Insufficient funds',
    260: 'Account locked',
    261: 'Domain not active in account',
    262: 'Hostname not found',
    263: 'Invalid parameter format',
    264: 'Cannot process transfer in current state',
    265: 'Account locked — call NameSilo support',
    266: 'API user not authorized for this command',
    267: 'Invalid / unavailable domain',
    268: 'Invalid SLD / TLD',
    280: 'Invalid API key',
    400: 'Existing API request in progress (rate limit)',
    401: 'Internal database error',
};

function _modelMaxContext(providerId) {
    /* Coarse per-provider context-window caps (in tokens) used to compute
       the fill ratio on the Compact button's ring. Real values vary by
       model variant; these are conservative defaults that read close
       enough on the indicator. */
    return ({
        anthropic: 200000,    // Claude 4.x family
        openai:    128000,    // GPT-4o / GPT-5 family
        grok:      256000,
        gemini:    1000000,
        azure:     128000,
        deepseek:  65536,     // DeepSeek V3 / R1 context window
    })[providerId] || 128000;
}

function _postContextUsage(panel, context) {
    /* Estimate total tokens used by the running conversation. Rough rule of
       thumb: 4 chars/token across English-leaning content. Posted to the
       panel as {ratio:0..1, tokens:int, max:int} so the Compact button can
       paint its conic-gradient ring proportional to fill. */
    try {
        const chars = conversation.reduce((n, m) => n + String(m.content || '').length, 0);
        const tokens = Math.round(chars / 4);
        const providerId = getActiveProvider(context);
        const max = _modelMaxContext(providerId);
        const ratio = Math.max(0, Math.min(1, tokens / max));
        panel.webview.postMessage({ type: 'contextUsage', ratio, tokens, max, providerId });
    } catch (e) {
        traceErr('contextUsage', e);
    }
}

function _domainsCachePath(context) {
    return path.join(context.extensionPath, 'domains.txt');
}

function _readDomainsCache(context) {
    try {
        const p = _domainsCachePath(context);
        if (!fs.existsSync(p)) return null;
        const txt = fs.readFileSync(p, 'utf8');
        const obj = JSON.parse(txt);
        if (!obj || !Array.isArray(obj.domains)) return null;
        /* An empty cache is the same as no cache — fall through to a fresh
           fetch instead of perpetually serving zero domains. An earlier bug
           wrote an empty array; this guard prevents that state from being
           permanent. */
        if (obj.domains.length === 0) {
            trace('DOMAINS:CACHE-EMPTY treating as miss');
            return null;
        }
        return obj;
    } catch (e) {
        traceErr('DOMAINS:CACHE-READ', e);
        return null;
    }
}

function _writeDomainsCache(context, payload) {
    try {
        const list = (payload && payload.domains) || [];
        /* Never persist an empty result. If the fetch returned zero domains,
           something is wrong (auth, API error, account empty), and writing
           the empty cache would mask that on every subsequent panel boot. */
        if (!Array.isArray(list) || list.length === 0) {
            trace('DOMAINS:CACHE-WRITE skipped (empty result — keeping previous cache if any)');
            return;
        }
        const p = _domainsCachePath(context);
        const out = { savedAt: new Date().toISOString(), domains: list };
        fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
        trace(`DOMAINS:CACHE-WRITE path=${p} count=${out.domains.length}`);
    } catch (e) {
        traceErr('DOMAINS:CACHE-WRITE', e);
    }
}

async function listNameSiloDomains(context, opts) {
    /* Two-tier flow:
         - No `force` flag: serve from domains.txt if it exists. Zero network.
         - `force === true` (or no cache): hit /listDomains + /getDomainInfo,
           write the result to domains.txt for next time.
       Every failure mode traces to the trace channel ("VSCode monitor") so
       the user can see WHY it returned nothing. */
    const force = !!(opts && opts.force);
    trace(`DOMAINS:BEGIN force=${force}`);
    if (!force) {
        const cached = _readDomainsCache(context);
        if (cached) {
            trace(`DOMAINS:FROM-CACHE count=${cached.domains.length} savedAt=${cached.savedAt}`);
            return { domains: cached.domains, fromCache: true, savedAt: cached.savedAt };
        }
        trace('DOMAINS:NO-CACHE proceeding to fetch');
    }
    trace('DOMAINS:READING config.ini');
    const cfg = readConfigIni(context.extensionPath) || {};
    trace(`DOMAINS:CONFIG sections=${Object.keys(cfg).join(',') || '(none)'}`);
    trace(`DOMAINS:CONFIG namesilo=${JSON.stringify(cfg.namesilo || null)}`);
    trace(`DOMAINS:CONFIG api_keys.namesilo_api_key=${cfg.api_keys && cfg.api_keys.namesilo_api_key ? '(set,len=' + String(cfg.api_keys.namesilo_api_key).length + ')' : '(unset)'}`);
    let apiKey = (cfg.namesilo && cfg.namesilo.api_key) || (cfg.api_keys && cfg.api_keys.namesilo_api_key) || '';
    apiKey = String(apiKey || '').trim();
    if (!apiKey) {
        const msg = 'No NameSilo API key in config.ini ([namesilo] api_key or [api_keys] namesilo_api_key).';
        trace('DOMAINS:FAIL ' + msg);
        return { error: msg };
    }
    const masked = apiKey.length <= 8 ? '****' : apiKey.slice(0, 4) + '…' + apiKey.slice(-4) + ` (len=${apiKey.length})`;
    trace(`DOMAINS:KEY ${masked}`);
    const baseUrl = (cfg.namesilo && cfg.namesilo.base_url) || 'https://www.namesilo.com/api';
    trace(`DOMAINS:BASE ${baseUrl}`);
    const https = require('https');
    const url = require('url');

    function call(endpoint, extra) {
        const params = new URLSearchParams({ version: '1', type: 'json', key: apiKey, ...(extra || {}) });
        const full = `${baseUrl}/${endpoint}?${params.toString()}`;
        const masked_full = full.replace(apiKey, '****' + apiKey.slice(-4));
        trace(`DOMAINS:GET ${masked_full}`);
        const parsed = url.parse(full);
        return new Promise((resolve, reject) => {
            const req = https.request({
                method: 'GET',
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.path,
                headers: { 'Accept': 'application/json', 'User-Agent': 'ClaudeCodexBlack' },
                timeout: 30000,
            }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (d) => buf += d);
                res.on('end', () => {
                    trace(`DOMAINS:RESP ${endpoint} status=${res.statusCode} bytes=${buf.length}`);
                    try { resolve(JSON.parse(buf)); }
                    catch (e) {
                        trace(`DOMAINS:RESP-NOT-JSON ${endpoint} body[:200]=${buf.slice(0, 200)}`);
                        reject(new Error('non-JSON reply: ' + buf.slice(0, 200)));
                    }
                });
            });
            req.on('error', (e) => { trace(`DOMAINS:NETERR ${endpoint} ${e.message}`); reject(e); });
            req.on('timeout', () => { trace(`DOMAINS:TIMEOUT ${endpoint}`); req.destroy(new Error('timeout')); });
            req.end();
        });
    }

    let listed;
    try { listed = await call('listDomains'); }
    catch (e) { return { error: 'listDomains: ' + (e.message || e) }; }
    const reply = (listed && listed.reply) || {};
    trace(`DOMAINS:REPLY code=${reply.code} detail=${reply.detail || ''} domains-keys=${reply.domains ? Object.keys(reply.domains).join(',') : '(none)'}`);
    if (reply.code !== 300 && reply.code !== 301) {
        const meaning = NAMESILO_CODES[reply.code] || 'Unknown API error';
        const detail  = reply.detail ? ` — ${reply.detail}` : '';
        return { error: `NameSilo API ${reply.code} (${meaning})${detail}` };
    }
    // NameSilo's JSON `type=json` response gives `reply.domains` as a plain
    // array of {domain,created,expires} objects. Their older XML-wrapped
    // shape used `reply.domains.domain = [...]`. Accept either: try the
    // legacy nested key first, fall through to the array itself.
    let raw = (reply.domains && (reply.domains.domain || reply.domains)) || [];
    if (typeof raw === 'string') raw = [raw];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = [raw];
    if (!Array.isArray(raw)) raw = [];
    trace(`DOMAINS:RAW count=${raw.length} sample=${JSON.stringify((raw[0] || null))}`);

    const domains = [];
    for (const entry of raw) {
        /* NameSilo's /listDomains returns each row as an object
           { domain, created, expires } — not a bare string. The old code
           did `String(entry)` which produced "[object Object]" and made
           every subsequent getDomainInfo call fail. */
        const dname = (entry && typeof entry === 'object')
            ? String(entry.domain || entry.name || '').trim()
            : String(entry || '').trim();
        if (!dname) { trace(`DOMAINS:SKIP empty-name entry=${JSON.stringify(entry)}`); continue; }
        try {
            const info = await call('getDomainInfo', { domain: dname });
            const ir = (info && info.reply) || {};
            if (ir.code !== 300) {
                domains.push({ name: dname, nameservers: [`(error ${ir.code}: ${ir.detail || ''})`] });
                continue;
            }
            /* NameSilo's current JSON shape for getDomainInfo:
                 reply.nameservers = [{ nameserver: "ns1.x", position: 1 }, ...]
               Legacy XML-wrapped JSON used reply.nameservers.nameserver = [...]
               of bare strings or {#text} objects. Accept all three. Also
               sort by `position` when present so the order matches the
               registrar's UI. */
            let ns = ir.nameservers;
            if (ns && !Array.isArray(ns) && typeof ns === 'object') {
                ns = ns.nameserver || ns.host || [];
            }
            if (typeof ns === 'string') ns = [ns];
            if (!Array.isArray(ns)) ns = [];
            const withPos = ns.map((n, i) => {
                if (n && typeof n === 'object') {
                    const host = String(n.nameserver || n.host || n['#text'] || n.value || '').trim();
                    const pos = Number.isFinite(+n.position) ? +n.position : (i + 1);
                    return { host, pos };
                }
                return { host: String(n || '').trim(), pos: i + 1 };
            }).filter(x => x.host);
            withPos.sort((a, b) => a.pos - b.pos);
            const cleaned = withPos.map(x => x.host);
            domains.push({ name: dname, nameservers: cleaned.length ? cleaned : ['(none)'] });
        } catch (e) {
            domains.push({ name: dname, nameservers: [`(lookup failed: ${e.message || e})`] });
        }
    }
    trace(`DOMAINS:DONE returned=${domains.length}`);
    /* Persist to domains.txt so future panel loads serve from cache. */
    _writeDomainsCache(context, { domains });
    return { domains, fromCache: false, savedAt: new Date().toISOString() };
}

/* ── GitHub repo list ────────────────────────────────────────────────────
   Reads the PAT from config.ini ([github] token, fallback
   [api_keys] github_token), hits GET /user/repos with pagination
   (Link header, capped at 5 pages = 500 repos). Returns
     { repos: [{ full_name, private, html_url, description,
                 updated_at, language, stargazers_count }] }
   or { error: '...' }. Pure stdlib — Node `https` only.
   Robust against missing PAT, 401, 403 (rate-limit/SSO), and network
   failures — every failure mode produces a clear error string. */
async function listGitHubRepos(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    let token = (cfg.github && cfg.github.token) || (cfg.api_keys && cfg.api_keys.github_token) || '';
    token = String(token || '').trim();
    if (!token) {
        return { error: 'No GitHub PAT in config.ini ([github] token or [api_keys] github_token).' };
    }

    const https = require('https');
    const baseHost = 'api.github.com';
    /* affiliation= covers owned + collab + org repos, which is what users
       expect from a "list my repos" button. per_page=100 minimizes HTTP. */
    const firstPath = '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';

    function call(pathOrUrl) {
        return new Promise((resolve, reject) => {
            let hostname = baseHost;
            let pathPart = pathOrUrl;
            if (/^https?:\/\//i.test(pathOrUrl)) {
                try {
                    const u = new URL(pathOrUrl);
                    hostname = u.hostname;
                    pathPart = u.pathname + u.search;
                } catch (e) { return reject(new Error('bad next-page URL: ' + pathOrUrl)); }
            }
            const req = https.request({
                method: 'GET',
                hostname,
                port: 443,
                path: pathPart,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'ClaudeCodexBlack',
                },
                timeout: 30000,
            }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (d) => buf += d);
                res.on('end', () => {
                    resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: buf });
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout after 30s')));
            req.end();
        });
    }

    /* RFC-5988 Link parser — find rel="next" URL or null. */
    function nextFromLink(linkHeader) {
        if (!linkHeader) return null;
        const parts = String(linkHeader).split(',');
        for (const p of parts) {
            const m = p.match(/<([^>]+)>\s*;\s*rel="next"/i);
            if (m) return m[1];
        }
        return null;
    }

    const all = [];
    let pathOrUrl = firstPath;
    const maxPages = 5;
    for (let page = 0; page < maxPages && pathOrUrl; page++) {
        let res;
        try { res = await call(pathOrUrl); }
        catch (e) {
            const msg = (e && e.message) || String(e);
            return { error: `Network error talking to api.github.com: ${msg}` };
        }
        if (res.status === 401) {
            return { error: 'GitHub rejected the token (401 Unauthorized). The PAT in config.ini is invalid, revoked, or expired. Generate a new one at https://github.com/settings/tokens.' };
        }
        if (res.status === 403) {
            const remaining = res.headers['x-ratelimit-remaining'];
            const reset = res.headers['x-ratelimit-reset'];
            if (remaining === '0' && reset) {
                const when = new Date(Number(reset) * 1000).toISOString();
                return { error: `GitHub rate-limit exhausted (resets at ${when}).` };
            }
            let detail = '';
            try { const j = JSON.parse(res.body); detail = j && j.message ? ` — ${j.message}` : ''; } catch (_) {}
            return { error: `GitHub 403 Forbidden${detail}. The PAT may lack the "repo" scope, or SSO authorization is required for an org.` };
        }
        if (res.status === 404) {
            return { error: 'GitHub returned 404 for /user/repos — the PAT may be malformed.' };
        }
        if (res.status < 200 || res.status >= 300) {
            let detail = '';
            try { const j = JSON.parse(res.body); detail = j && j.message ? `: ${j.message}` : ''; } catch (_) {}
            return { error: `GitHub HTTP ${res.status}${detail}` };
        }
        let chunk;
        try { chunk = JSON.parse(res.body); }
        catch (e) { return { error: 'GitHub returned non-JSON: ' + String(res.body).slice(0, 200) }; }
        if (!Array.isArray(chunk)) {
            return { error: 'GitHub returned unexpected payload (not an array).' };
        }
        for (const r of chunk) {
            if (!r || typeof r !== 'object') continue;
            all.push({
                full_name: r.full_name || '',
                private: !!r.private,
                html_url: r.html_url || '',
                description: r.description || '',
                updated_at: r.updated_at || r.pushed_at || '',
                language: r.language || '',
                stargazers_count: r.stargazers_count || 0,
            });
        }
        pathOrUrl = nextFromLink(res.headers.link || res.headers.Link);
    }

    return { repos: all };
}

/* ── i18n: languages/*.xml ────────────────────────────────────────────────
   Every locale is a flat list of <s id="key">value</s> elements. The
   English file is authoritative — missing keys in other locales fall
   back to en. _i18nCache stores the parsed maps and locale metadata so
   the Settings dropdown can show "Español", "中文", etc next to codes. */
let _i18nCache = null;

/* Locale code → country (for the flag emoji). Keys match languages/*.xml. */
const LANGUAGE_COUNTRY = {
    ar: 'SA', bn: 'BD', cs: 'CZ', da: 'DK', de: 'DE', el: 'GR', en: 'GB',
    es: 'ES', fa: 'IR', fi: 'FI', fr: 'FR', ha: 'NG', he: 'IL', hi: 'IN',
    hu: 'HU', id: 'ID', it: 'IT', ja: 'JP', ko: 'KR', mr: 'IN', nb: 'NO',
    nl: 'NL', pa: 'IN', pl: 'PL', pt: 'PT', ro: 'RO', ru: 'RU', sv: 'SE',
    sw: 'KE', ta: 'IN', te: 'IN', th: 'TH', tl: 'PH', tr: 'TR', uk: 'UA',
    ur: 'PK', vi: 'VN', yue: 'HK', zh: 'CN',
};

function _flagEmoji(countryCode) {
    /* Two ASCII letters → two Unicode regional-indicator symbols, which the
       OS renders as a flag. 'GB' → 🇬🇧. A real <select> can't hold <img>, so
       the emoji is how the flag shows up next to each language. */
    const cc = String(countryCode || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '';
    return cc.replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
}

function loadLanguageFiles(context) {
    const dir = path.join(context.extensionPath, 'languages');
    if (!fs.existsSync(dir)) {
        trace('I18N:NO-DIR ' + dir);
        _i18nCache = { locales: {}, order: [], meta: [] };
        return _i18nCache;
    }
    const out = { locales: {}, order: [], meta: [] };
    for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.xml')) continue;
        const code = name.slice(0, -4);
        const xml = fs.readFileSync(path.join(dir, name), 'utf8');
        const strings = {};
        const re = /<s\s+id\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/s>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const key = m[1];
            const raw = m[2]
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'");
            strings[key] = raw;
        }
        const nameMatch = xml.match(/<strings[^>]*\bname\s*=\s*"([^"]+)"/);
        const nativeMatch = xml.match(/<strings[^>]*\bnative\s*=\s*"([^"]+)"/);
        out.locales[code] = strings;
        out.order.push(code);
        const englishName = nameMatch ? nameMatch[1] : code;
        const nativeName = nativeMatch ? nativeMatch[1] : code;
        out.meta.push({
            code,
            englishName,
            nativeName,
            name: nativeName || englishName || code,
            flag: _flagEmoji(LANGUAGE_COUNTRY[code]),
            keyCount: Object.keys(strings).length,
        });
    }
    out.order.sort();
    out.meta.sort((a, b) => a.code.localeCompare(b.code));
    _i18nCache = out;
    trace(`I18N:LOADED locales=${out.order.length} en-keys=${(out.locales.en && Object.keys(out.locales.en).length) || 0}`);
    return out;
}

function _currentLanguageCode(context) {
    /* workspaceState (set by the Settings dropdown) wins over config.ini —
       config.ini is reserved for API keys and shouldn't be rewritten by a
       UI preference. */
    const fromState = String(context.workspaceState.get('codexBlackEd.language') || '').trim().toLowerCase();
    if (fromState && (!_i18nCache || _i18nCache.locales[fromState])) return fromState;
    const cfg = readConfigIni(context.extensionPath) || {};
    const fromIni = (cfg.settings && cfg.settings.language) || (cfg.general && cfg.general.language) || '';
    const code = String(fromIni || '').trim().toLowerCase();
    if (_i18nCache && _i18nCache.locales[code]) return code;
    return 'en';
}

function _languageStringsFor(context, code) {
    if (!_i18nCache) loadLanguageFiles(context);
    const cache = _i18nCache || { locales: {} };
    const english = cache.locales.en || {};
    const target = cache.locales[code] || {};
    // Merge: English provides every key, target overlays its translations
    return { ...english, ...target };
}

/* ── Azure deployment discovery via the data-plane endpoint ──────────────
   Cache holds Array<{name, model}> keyed by endpoint+key tail. */
let _azureDeploymentsCache = { ts: 0, items: [], key: '' };

/* Mirrors triodesktop start.py / vendor/cloud/chat_sync.py _fetch_azure_deployments:
     GET {endpoint}/openai/deployments?api-version=<v>
     Header: api-key: <azure api_key>
   The Cognitive Services data plane returns every deployment served by THIS
   endpoint, including its underlying model id — so a deployment named "sora"
   that's actually running sora-2 surfaces as { name:"sora", model:"sora-2" }.
   Earlier versions used Azure Resource Manager, which required az CLI login
   plus subscription/RG/account creds and silently dropped deployments that
   ARM didn't enumerate (e.g. Claude). The data plane needs only the values
   already in [azure].endpoint + api_key. We try the newest api-version first
   and walk back, since older Azure regions still pin to 2023-03-15-preview. */
function discoverAzureDeployments(context, opts) {
    /* Returns Promise<Array<{name:string, model:string}>>. */
    return new Promise((resolve, reject) => {
        const cfg = readConfigIni(context.extensionPath) || {};
        const az = cfg.azure || {};
        const endpoint = String(az.endpoint || '').trim().replace(/\/+$/, '');
        const apiKey = String(az.api_key || az.api_key1 || '').trim();
        if (!endpoint || !apiKey) {
            trace(`AZURE:DEPLOY:SKIP missing endpoint=${!!endpoint} key=${!!apiKey}`);
            return resolve([]);
        }
        const cacheKey = `${endpoint}|${apiKey.slice(-8)}`;
        const fresh = (Date.now() - _azureDeploymentsCache.ts) < 5 * 60 * 1000;
        if (fresh && _azureDeploymentsCache.key === cacheKey && !(opts && opts.force)) {
            return resolve(_azureDeploymentsCache.items.slice());
        }
        const versions = ['2025-01-01-preview', '2024-10-21', '2024-05-01-preview', '2023-03-15-preview'];
        const https = require('https');
        const tryVersion = (i, lastErr) => {
            if (i >= versions.length) {
                return reject(lastErr || new Error(`all api-versions failed for ${endpoint}`));
            }
            const v = versions[i];
            const url = `${endpoint}/openai/deployments?api-version=${v}`;
            let u;
            try { u = new URL(url); } catch (e) { return reject(e); }
            const req = https.request({
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: 'GET',
                headers: { 'api-key': apiKey, 'Accept': 'application/json' },
                timeout: 15000,
            }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        trace(`AZURE:DEPLOY:HTTP ${res.statusCode} v=${v} body=${body.slice(0, 200)}`);
                        return tryVersion(i + 1, new Error(`HTTP ${res.statusCode} on v=${v}: ${body.slice(0, 200)}`));
                    }
                    try {
                        const j = JSON.parse(body);
                        /* Data-plane shape: { data: [ { id, model, ... } ] }.
                           Older preview versions returned { value: [ { name, properties:{ model:{ name } } } ] };
                           handle both. */
                        const raw = j.data || j.value || [];
                        const items = raw.map((d) => {
                            const name = String(d.id || d.name || '').trim();
                            let model = '';
                            if (typeof d.model === 'string') model = d.model;
                            else if (d.model && typeof d.model === 'object') model = String(d.model.name || d.model.id || '');
                            else if (d.properties && d.properties.model) {
                                const pm = d.properties.model;
                                model = typeof pm === 'string' ? pm : String(pm.name || pm.id || '');
                            }
                            return { name, model: String(model || '').trim() };
                        }).filter((row) => row.name).sort((a, b) => a.name.localeCompare(b.name));
                        _azureDeploymentsCache = { ts: Date.now(), items, key: cacheKey };
                        trace(`AZURE:DEPLOY:OK v=${v} count=${items.length} ${items.map(r => r.name + (r.model && r.model !== r.name ? '(' + r.model + ')' : '')).join(',')}`);
                        resolve(items.slice());
                    } catch (e) {
                        traceErr(`AZURE:DEPLOY:PARSE v=${v}`, e);
                        tryVersion(i + 1, e);
                    }
                });
            });
            req.on('error', (e) => { traceErr(`AZURE:DEPLOY:REQ v=${v}`, e); tryVersion(i + 1, e); });
            req.on('timeout', () => { req.destroy(); tryVersion(i + 1, new Error(`timeout on v=${v}`)); });
            req.end();
        };
        tryVersion(0, null);
    });
}

function buildSettingsPayload(context) {
    const endPay = timeStep('    buildSettingsPayload');
    const endIni = timeStep('      readConfigIni');
    const cfg = readConfigIni(context.extensionPath) || {};
    endIni();
    const active = getActiveProvider(context);
    const providers = Object.keys(PROVIDERS).map(id => {
        const p = PROVIDERS[id];
        const haveKey = !!getProviderKey(context, id);
        let models;
        if (p.azureSection) {
            /* Prefer the data-plane-discovered list if the cache has anything;
               fall back to just the configured deployment_name on first open.
               Cache stores {name, model} objects; the panel's initial payload
               only carries strings, so flatten to names here. The panel will
               receive the rich list shortly via the 'azureDeployments' message. */
            if (_azureDeploymentsCache.items && _azureDeploymentsCache.items.length) {
                models = _azureDeploymentsCache.items.map(it => typeof it === 'string' ? it : it.name).filter(Boolean);
            } else {
                models = (cfg.azure && cfg.azure.deployment_name) ? [cfg.azure.deployment_name] : [];
            }
        } else {
            models = (p.models && p.models.slice) ? p.models.slice() : [];
        }
        const currentModel = getActiveModel(context, id);
        if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
        return { id, label: p.label, models, current: currentModel, haveKey, bridge: !!p.bridge, bridgeTarget: p.bridgeTarget || null };
    });
    /* SFX prefs are persisted in workspaceState. Booleans + a 0..1 number;
       defaults match the panel's window.SFX_* defaults so a fresh install
       hears sounds at the same volume the agent originally wired (0.55). */
    const sfxEnabled = context.workspaceState.get('codexBlackEd.sfxEnabled');
    const sfxVolume  = context.workspaceState.get('codexBlackEd.sfxVolume');
    const bigFont    = context.workspaceState.get('codexBlackEd.bigFont');
    endPay(`providers=${providers.length} active=${active}`);
    // Language list + strings: panel uses these to populate the Settings
    // dropdown AND to translate UI labels at render time. The strings map
    // is the merged English-fallback view for the active locale.
    const currentLang = _currentLanguageCode(context);
    const i18n = _i18nCache || loadLanguageFiles(context);
    return {
        providers,
        active,
        sfxEnabled: (typeof sfxEnabled === 'boolean') ? sfxEnabled : true,
        sfxVolume:  (typeof sfxVolume  === 'number')  ? sfxVolume  : 0.55,
        bigFont:    (typeof bigFont    === 'boolean') ? bigFont    : false,
        language: currentLang,
        languages: (i18n && i18n.meta) || [],
        strings: _languageStringsFor(context, currentLang),
    };
}

/* Build the accounts payload for a single provider, masked for the webview.
   The webview NEVER receives raw apiKey values — only masked previews + the
   account id (used by [Use]/[Disable]/[Delete]). disabled is computed live so
   the UI can grey rate-limited rows. */
function buildAccountsPayload(context, providerId) {
    const p = PROVIDERS[providerId] || {};
    const isBridge = !!p.bridge;
    const accounts = isBridge ? [] : getProviderAccounts(context, providerId);
    const active = getActiveAccount(context, providerId);
    const activeId = active ? active.id : null;
    return {
        provider: providerId,
        providerLabel: p.label || providerId,
        bridge: isBridge,
        activeId,
        accounts: accounts.map(a => ({
            id: a.id,
            label: a.label,
            maskedKey: maskKey(a.apiKey),
            addedAt: a.addedAt,
            lastUsedAt: a.lastUsedAt,
            disabledUntil: a.disabledUntil,
            disabled: _accountDisabled(a),
            active: a.id === activeId,
        })),
    };
}

/* ── Panel lifecycle ──────────────────────────────────────────────────── */

function openPanel(context) {
    const endOpen = timeStep('openPanel');
    if (activePanel) { activePanel.reveal(undefined, false); endOpen('reveal existing'); return; }
    /* Scan existing tabs. If we find a CBE panel tab BUT activePanel is null
       (i.e. it's a leftover restored by VSCode from a previous session that
       our serializer disposed — the tab shell can outlive the webview), we
       CLOSE it and fall through to create a fresh panel. Without this the
       command silently focuses a dead tab and the user thinks it's broken. */
    const endScan = timeStep('  scanExistingTabs');
    let scanned = 0;
    const staleTabs = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            scanned++;
            /* viewType is prefixed by VS Code internals (e.g. mainThreadWebview-); use endsWith
               so we survive prefix changes between VS Code versions. */
            if (tab.input instanceof vscode.TabInputWebview &&
                typeof tab.input.viewType === 'string' &&
                tab.input.viewType.endsWith('codexBlackEd.panel')) {
                staleTabs.push(tab);
            }
        }
    }
    if (staleTabs.length) {
        endScan(`stale=${staleTabs.length} of ${scanned}; closing then re-creating`);
        for (const t of staleTabs) {
            try { vscode.window.tabGroups.close(t, true); }
            catch (e) { traceErr('openPanel.closeStale', e); }
        }
    } else {
        endScan(`miss scanned=${scanned}`);
    }
    const endCreate = timeStep('  createWebviewPanel');
    const panel = vscode.window.createWebviewPanel(
        'codexBlackEd.panel',
        'Claude Codex Black',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'panel')),
                vscode.Uri.file(path.join(context.extensionPath, 'assets')),
                vscode.Uri.file(path.join(context.extensionPath, 'lib')),
                vscode.Uri.file(path.join(context.extensionPath, 'sounds')),
                /* Skins live in /skins. Loaded as a stylesheet at runtime via
                   asWebviewUri(); the file list is discovered lazily when the
                   user opens Settings (not at activation), so dropping a new
                   .css in /skins works without restarting the panel. */
                vscode.Uri.file(path.join(context.extensionPath, SKINS_DIR_NAME)),
            ]
        }
    );
    endCreate();
    const endBind = timeStep('  bindPanel');
    bindPanel(context, panel);
    endBind();
    endOpen();
}

function bindPanel(context, panel) {
    activePanel = panel;
    const endGetHtml = timeStep('    bindPanel.getPanelHtml');
    const html = getPanelHtml(context, panel.webview);
    endGetHtml(`bytes=${html.length}`);
    const endAssignHtml = timeStep('    bindPanel.assign webview.html');
    panel.webview.html = html;
    endAssignHtml();

    panel.webview.onDidReceiveMessage(async (msg) => {
        trace('recv ' + JSON.stringify({ type: msg && msg.type }));
        if (!msg || !msg.type) return;
        try {
            switch (msg.type) {
                case 'ready': {
                    const endReady = timeStep('webview ready -> server response');
                    const endInit = timeStep('  buildSettingsPayload + postMessage init');
                    /* Resolve persisted skin to a webview URI (or empty if the
                       file is gone) so the panel can apply it on first paint. */
                    const savedSkinName = context.workspaceState.get(STATE_SKIN, '') || '';
                    const resolved = resolveSkin(context, savedSkinName);
                    const skinUri = resolved.uri ? panel.webview.asWebviewUri(resolved.uri).toString() : '';
                    /* Inline help.html — iframes loaded via asWebviewUri in
                       newer VSCode versions silently render empty/black on
                       some installs (the resource URL is reachable to img/css
                       but not always to nested-document loads). Shipping the
                       HTML body in the init payload sidesteps that entirely:
                       openHelp() in panel.js innerHTML's it into a div. */
                    /* Pick the help file matching the active language, fall
                       back to English. Files live at panel/help.<code>.html
                       (e.g. panel/help.fr.html); panel/help.html is the
                       authoritative English source. */
                    let helpHtml = '';
                    try {
                        const _lang = _currentLanguageCode(context);
                        const candidates = [
                            path.join(context.extensionPath, 'panel', `help.${_lang}.html`),
                            path.join(context.extensionPath, 'panel', 'help.html'),
                        ];
                        for (const p of candidates) {
                            if (fs.existsSync(p)) {
                                helpHtml = fs.readFileSync(p, 'utf8');
                                trace(`HELP:LOAD lang=${_lang} from=${path.basename(p)}`);
                                break;
                            }
                        }
                    } catch (e) { traceErr('read help.html', e); }
                    /* Pinned extensions list — shipped on init so the toolbar
                       can render its quick-launch buttons immediately. Each
                       entry carries id + name; the icon is shared (📦). */
                    const _pinnedIds = _readPinnedExtensions(context);
                    const _scanned   = _scanInstalledExtensions(context);
                    const _pinnedMeta = _pinnedIds
                        .map(id => {
                            const info = _scanned.get(id) || {};
                            return { id, name: info.name || id, icon: info.icon || '', iconSvg: info.iconSvg || '' };
                        })
                        .filter(x => _scanned.has(x.id));
                    /* Read change_log.html same way as help.html — generated by
                       tools/build_changelog.py after every commit. */
                    let changelogHtml = '';
                    try {
                        changelogHtml = fs.readFileSync(path.join(context.extensionPath, 'panel', 'change_log.html'), 'utf8');
                    } catch (e) { /* file may not exist yet — first run before build_changelog */ }
                    panel.webview.postMessage({
                        type: 'init',
                        ...buildSettingsPayload(context),
                        skin: resolved.name,
                        skinUri,
                        skinColors: resolved.colors || null,
                        helpHtml,
                        changelogHtml,
                        pinnedExtensions: _pinnedIds,
                        pinnedExtensionsMeta: _pinnedMeta,
                    });
                    /* Bump the panel-open run counter in config.ini and, if
                       this run hits a nag trigger (3/6/10/20, then every 30),
                       tell the panel to show one of the support/promo nags. */
                    const _runNumber = bumpRunCount(context);
                    trace(`NAG:RUN_COUNT=${_runNumber}`);
                    if (shouldShowNag(_runNumber)) {
                        panel.webview.postMessage({ type: 'nag', run: _runNumber });
                    }
                    endInit();
                    /* Kick off Azure data-plane deployment discovery in the
                       background. The init payload above used whatever was in
                       the cache (just the configured deployment_name on a cold
                       start); once the endpoint answers we post the real list
                       (objects with name + underlying model id) and the panel
                       swaps in the full set with model annotations. */
                    discoverAzureDeployments(context).then((items) => {
                        if (items && items.length) {
                            panel.webview.postMessage({ type: 'azureDeployments', items });
                        }
                    }).catch((e) => traceErr('AZURE:DEPLOY:DISCOVER', e));
                    const endHist = timeStep('  loadPromptHistory');
                    const histItems = loadPromptHistory(context);
                    panel.webview.postMessage({ type: 'promptHistory', items: histItems });
                    endHist(`items=${histItems.length}`);
                    const endPrompts = timeStep('  loadPrompts');
                    const promptItems = loadPrompts(context);
                    panel.webview.postMessage({ type: 'prompts', items: promptItems });
                    endPrompts(`items=${promptItems.length}`);
                    /* Pre-fetch the NameSilo domain list on panel boot so clicking
                       the Domains button serves an instant result. Runs in the
                       background — startup is not blocked. The webview caches the
                       payload and re-fetches in the background on each open. */
                    setImmediate(() => {
                        listNameSiloDomains(context).then(payload => {
                            panel.webview.postMessage({ type: 'domainsList', ...payload, prefetched: true });
                        }).catch(e => traceErr('domains:prefetch', e));
                    });
                    {
                        const cur = context.workspaceState.get('codexBlackEd.projectFolder', '');
                        if (cur) panel.webview.postMessage({ type: 'projectFolder', path: cur });
                        /* One-time auto-context: dir tree + handbook, sent as
                           the first user prompt so the model has the project
                           shape and house rules before any real question.
                           Only fires once per extension activation and only
                           when a project folder is set.

                           DEFERRED: schedule on setImmediate so the panel's
                           critical path (init/history/prompts) finishes and
                           the UI paints BEFORE we spend ~100–250ms building
                           the dir tree + serializing 16KB of context. */
                        if (!__autoContextSent && cur && fs.existsSync(cur)) {
                            setImmediate(() => {
                                const endAuto = timeStep('  autoContext (deferred, dir tree + handbook)');
                                try {
                                    const endTree = timeStep('    buildDirTree');
                                    const tree = buildDirTree(cur);
                                    endTree();
                                    const endHb = timeStep('    read handbook.txt');
                                    const hp = path.join(context.extensionPath, 'handbook.txt');
                                    const handbook = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '(handbook.txt not found)';
                                    endHb(`bytes=${handbook.length}`);
                                    const text = buildAutoContextPrompt(cur, tree, handbook);
                                    panel.webview.postMessage({ type: 'autoPrompt', text });
                                    __autoContextSent = true;
                                    endAuto(`promptBytes=${text.length}`);
                                } catch (e) {
                                    traceErr('autoContext', e);
                                    endAuto('FAILED');
                                }
                            });
                        }
                    }
                    endReady();
                    break;
                }
                case 'attachFile': {
                    /* Multi-select: pick any number of files in one dialog.
                       Each file is processed independently and posted back
                       as its own `attachFile` message so the panel renders
                       a chip per file (existing renderer iterates one chip
                       per message). Oversized / unreadable files surface
                       as info/error messages but don't block the rest of
                       the batch. */
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        openLabel: 'Attach files',
                    });
                    if (!picked || !picked.length) break;
                    for (const item of picked) {
                        const fp = item.fsPath;
                        try {
                            const stat = fs.statSync(fp);
                            if (stat.size > 1024 * 1024) {
                                panel.webview.postMessage({ type: 'info', text: `Attach skipped: ${path.basename(fp)} is larger than 1 MB.` });
                                continue;
                            }
                            const buf = fs.readFileSync(fp);
                            /* Cheap binary detector — if more than 1% of the bytes
                               are zeros or high-ASCII control bytes, treat as binary. */
                            let bin = 0;
                            for (let i = 0; i < buf.length && i < 4096; i++) {
                                const c = buf[i];
                                if (c === 0 || (c < 9) || (c > 13 && c < 32)) bin++;
                            }
                            const isBinary = bin > Math.max(2, Math.min(40, buf.length / 100));
                            let text;
                            if (isBinary) {
                                text = `(binary file, ${stat.size} bytes — content omitted)`;
                            } else {
                                text = buf.toString('utf8');
                            }
                            panel.webview.postMessage({
                                type: 'attachFile',
                                name: path.basename(fp),
                                path: fp,
                                ext: path.extname(fp).replace(/^\./, ''),
                                text,
                                bytes: stat.size,
                            });
                        } catch (e) {
                            traceErr('attachFile', e);
                            panel.webview.postMessage({ type: 'error', message: `attach ${path.basename(fp)}: ${e.message || e}` });
                        }
                    }
                    break;
                }
                case 'pushPromptHistory':
                    pushPromptHistory(context, msg.text || '');
                    break;
                case 'reloadPrompts':
                    panel.webview.postMessage({ type: 'prompts', items: loadPrompts(context) });
                    break;
                case 'openPromptsFile':
                    /* Kept for the /prompts slash-command (power users who want
                       to edit the raw prompts.txt file directly). The toolbar
                       button now opens an in-panel modal — see saveStoredPrompts. */
                    await openPromptsFile(context);
                    /* Re-send prompts list after the user has a chance to edit
                       — done on file save via the watcher below. Send the
                       current list immediately so the panel has at least
                       something while the editor is open. */
                    panel.webview.postMessage({ type: 'prompts', items: loadPrompts(context) });
                    break;
                case 'saveStoredPrompts': {
                    /* In-panel modal save. Writes prompts.txt atomically then
                       broadcasts the fresh list back so the panel's
                       __cbePrompts (and any open modal) re-sync immediately. */
                    try {
                        savePrompts(context, msg.items || []);
                    } catch (e) {
                        panel.webview.postMessage({
                            type: 'error',
                            message: 'saveStoredPrompts: ' + (e.message || e),
                        });
                    }
                    panel.webview.postMessage({ type: 'prompts', items: loadPrompts(context) });
                    break;
                }
                case 'openChatHistory':
                    await openChatHistory(context);
                    break;
                case 'logChatTurn':
                    logChatTurn(context, msg.role || 'USER', msg.text || '');
                    break;
                case 'loadHandbook': {
                    const hp = path.join(context.extensionPath, 'handbook.txt');
                    let text = '';
                    try { text = fs.readFileSync(hp, 'utf8'); }
                    catch (e) { traceErr('loadHandbook', e); }
                    panel.webview.postMessage({ type: 'handbook', text });
                    break;
                }
                case 'saveHandbook': {
                    const hp = path.join(context.extensionPath, 'handbook.txt');
                    try { fs.writeFileSync(hp, String(msg.text || ''), 'utf8'); }
                    catch (e) {
                        traceErr('saveHandbook', e);
                        panel.webview.postMessage({ type: 'error', message: 'handbook save: ' + (e.message || e) });
                    }
                    break;
                }
                case 'pickProjectFolder': {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Set as project folder',
                    });
                    if (picked && picked[0]) {
                        const fsPath = picked[0].fsPath;
                        await context.workspaceState.update('codexBlackEd.projectFolder', fsPath);
                        panel.webview.postMessage({ type: 'projectFolder', path: fsPath });
                    }
                    break;
                }
                case 'sendText':
                    await handleSendText(context, panel, msg.text || '');
                    break;
                case 'cancelInFlight':
                    /* Stop button. The panel posts this when the user clicks
                       #stopBtn (panel.js:765). We set a flag the streaming loop
                       in handleSendText checks each iteration, then break out
                       and post assistantDone so the UI clears. The bridge
                       subprocess may keep running to completion — we just stop
                       consuming its output, which is what the user sees. */
                    panel.__cbeCancel = true;
                    panel.webview.postMessage({ type: 'info', text: 'Stopped.' });
                    break;
                case 'reset':
                    conversation = [];
                    panel.webview.postMessage({ type: 'info', text: 'Conversation reset.' });
                    /* Re-fire the auto-context (dir tree + handbook) so each
                       fresh conversation starts with the model knowing the
                       project shape — same as the initial session start. */
                    __autoContextSent = false;
                    {
                        const cur = context.workspaceState.get('codexBlackEd.projectFolder', '');
                        if (cur && fs.existsSync(cur)) {
                            setImmediate(() => {
                                try {
                                    const tree = buildDirTree(cur);
                                    const hp = path.join(context.extensionPath, 'handbook.txt');
                                    const handbook = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '(handbook.txt not found)';
                                    const text = buildAutoContextPrompt(cur, tree, handbook);
                                    panel.webview.postMessage({ type: 'autoPrompt', text });
                                    __autoContextSent = true;
                                } catch (e) {
                                    traceErr('autoContext on reset', e);
                                }
                            });
                        }
                    }
                    break;
                case 'openSettings':
                    panel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
                    break;
                case 'openNN4Browser': {
                    /* Open (or reveal) a separate WebviewPanel that renders
                       panel/nn4-browser.html — a Netscape Navigator 4.0
                       skinned browser shell wrapping an <iframe>. Scripts
                       are enabled; retainContextWhenHidden keeps the iframe
                       state alive across tab switches. The HTML is inlined
                       (no localResourceRoots needed) since the file is
                       self-contained — pure CSS + inline JS, no asset refs. */
                    if (!_nn4BrowserPanel) {
                        _nn4BrowserPanel = vscode.window.createWebviewPanel(
                            'codexBlackEd.nn4Browser',
                            'Netscape Navigator 4.0 — CBE',
                            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                            { enableScripts: true, retainContextWhenHidden: true }
                        );
                        loadNn4BrowserHtml(context, _nn4BrowserPanel).catch(e =>
                            traceErr('loadNn4BrowserHtml (msg)', e));
                        _nn4BrowserPanel.onDidDispose(() => {
                            _nn4BrowserPanel = null;
                            stopNn4ProxySidecar();
                        });
                    } else {
                        _nn4BrowserPanel.reveal(vscode.ViewColumn.Active);
                    }
                    break;
                }
                case 'setBigFont':
                    await context.workspaceState.update('codexBlackEd.bigFont', !!msg.value);
                    break;
                case 'setProvider':
                    await context.workspaceState.update(STATE_PROVIDER, msg.provider);
                    if (msg.model) await context.workspaceState.update(STATE_MODEL + ':' + msg.provider, msg.model);
                    if (typeof msg.sfxEnabled === 'boolean') {
                        await context.workspaceState.update('codexBlackEd.sfxEnabled', msg.sfxEnabled);
                    }
                    if (typeof msg.sfxVolume === 'number') {
                        const v = Math.max(0, Math.min(1, msg.sfxVolume));
                        await context.workspaceState.update('codexBlackEd.sfxVolume', v);
                    }
                    if (typeof msg.skin === 'string') {
                        /* Validate the skin filename against what's actually on disk
                           right now — refusing arbitrary strings keeps a malformed
                           webview message from injecting a stray <link href>. Empty
                           string clears the skin. */
                        const safe = resolveSkin(context, msg.skin);
                        await context.workspaceState.update(STATE_SKIN, safe.name);
                        panel.webview.postMessage({
                            type: 'applySkin',
                            skin: safe.name,
                            skinUri: safe.uri ? panel.webview.asWebviewUri(safe.uri).toString() : '',
                            skinColors: safe.colors || null,
                        });
                    }
                    if (typeof msg.language === 'string' && msg.language) {
                        /* Validate against the locales we actually ship before
                           persisting, so a malformed webview message can't
                           write a junk locale. Stored in workspaceState — NOT
                           config.ini, which is reserved for API keys. */
                        const i18n = _i18nCache || loadLanguageFiles(context);
                        const safeLang = (i18n && i18n.locales[msg.language]) ? msg.language : 'en';
                        await context.workspaceState.update('codexBlackEd.language', safeLang);
                        /* Push the fresh strings map down so the panel can
                           re-translate tooltips/labels live — without this the
                           dropdown changes but the UI stays in the old language. */
                        try {
                            panel.webview.postMessage({ type: 'strings', language: safeLang, strings: _languageStringsFor(context, safeLang) });
                            trace(`language changed -> ${safeLang}; pushed ${Object.keys(_languageStringsFor(context, safeLang)).length} strings to panel`);
                        } catch (e) { traceErr('push strings after language change', e); }
                        /* Re-ship the help HTML in the new language so the
                           next Help-button click renders the right file. */
                        try {
                            const helpCands = [
                                path.join(context.extensionPath, 'panel', `help.${safeLang}.html`),
                                path.join(context.extensionPath, 'panel', 'help.html'),
                            ];
                            for (const p of helpCands) {
                                if (fs.existsSync(p)) {
                                    panel.webview.postMessage({
                                        type: 'helpHtml',
                                        helpHtml: fs.readFileSync(p, 'utf8'),
                                        language: safeLang,
                                    });
                                    trace(`HELP:RELOAD lang=${safeLang} from=${path.basename(p)}`);
                                    break;
                                }
                            }
                        } catch (e) { traceErr('reship help.html on language change', e); }
                    }
                    conversation = [];
                    trace(`active provider set: ${msg.provider} / ${msg.model || '(default)'} sfx=${msg.sfxEnabled}/${msg.sfxVolume} skin=${msg.skin || '(none)'} lang=${msg.language || '(unchanged)'}`);
                    setStatus('idle', false, msg.provider);
                    panel.webview.postMessage({ type: 'info', text: `Provider → ${PROVIDERS[msg.provider].label} · ${msg.model || getActiveModel(context, msg.provider)}` });
                    /* Auto-start the matching tray bridge on provider switch.
                       Idempotent — already-running bridges are a no-op. Runs
                       in the background so the panel doesn't freeze if the
                       exe takes a second to bind its port. Posts bridgeStatus
                       to the panel so the user sees "Claude bridge ready" /
                       "Bridge exe missing" instead of the old stale warning. */
                    const _provider = PROVIDERS[msg.provider];
                    if (_provider && _provider.bridge && _provider.bridgeTarget) {
                        const _target = _provider.bridgeTarget;
                        killOtherBridgeTrays(_target);
                        ensureBridge(context, _target, { timeoutMs: 8000 })
                            .then((r) => {
                                trace(`BRIDGE:PROVIDER-SWITCH target=${_target} ok=${r.ok} ${r.reason || ''}`);
                                if (activePanel) {
                                    activePanel.webview.postMessage({
                                        type: 'bridgeStatus',
                                        target: _target,
                                        ok: !!r.ok,
                                        spawned: !!r.spawned,
                                        exeMissing: !!r.exeMissing,
                                        port: r.port,
                                        reason: r.reason || '',
                                    });
                                }
                            })
                            .catch((e) => traceErr(`BRIDGE:PROVIDER-SWITCH target=${_target}`, e));
                    }
                    /* Ollama discovery on provider switch — if the user picked
                       Ollama and we can't reach the local daemon, post the
                       missing-state so the panel can render the Install button. */
                    if (msg.provider === 'ollamaBridge' || msg.provider === 'ollama') {
                        ensureOllamaReady({ timeoutMs: 8000 })
                            .then((r) => {
                                trace(`OLLAMA:PROVIDER-SWITCH state=${r.state}`);
                                if (activePanel) activePanel.webview.postMessage({ type: 'ollamaStatus', ...r });
                            })
                            .catch((e) => traceErr('OLLAMA:PROVIDER-SWITCH', e));
                    }
                    break;
                /* ── Multi-account management ──────────────────────────────
                   The panel's Settings → Accounts UI drives these. Every
                   reply ships a fresh masked accountsState so the list
                   re-renders. Keys are NEVER echoed back — only maskedKey. */
                /* listAccounts is the standalone Accounts modal's name for the
                   read; getAccounts is the Settings-embedded section's name.
                   Both answer with the same masked accountsState payload. */
                case 'listAccounts':
                case 'getAccounts': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    break;
                }
                case 'addAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    const p = PROVIDERS[pid] || {};
                    if (p.bridge) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Bridge providers authenticate in the browser — no API key to add.' });
                        break;
                    }
                    const key = String(msg.apiKey || '').trim();
                    const shape = validateKeyShape(pid, key);
                    if (!shape.ok) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid key: ${shape.reason}.` });
                        break;
                    }
                    const accounts = getProviderAccounts(context, pid);
                    if (accounts.some(a => a.apiKey === key)) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That key is already in the list.' });
                        break;
                    }
                    const label = String(msg.label || '').trim() || `account ${accounts.length + 1}`;
                    const acc = {
                        id: _newAccountId(),
                        label,
                        apiKey: key,
                        addedAt: new Date().toISOString(),
                        lastUsedAt: null,
                        disabledUntil: null,
                    };
                    accounts.push(acc);
                    setProviderAccounts(context, pid, accounts);
                    /* First account added becomes active automatically. */
                    if (accounts.length === 1) await setActiveAccount(context, pid, acc.id);
                    trace(`ACCOUNTS:ADD provider=${pid} label=${label} key=${maskKey(key)} total=${accounts.length}`);
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    /* Refresh the provider settings payload too (haveKey may flip). */
                    panel.webview.postMessage({ type: 'init', ...buildSettingsPayload(context) });
                    break;
                }
                case 'useAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    const accounts = getProviderAccounts(context, pid);
                    const hit = accounts.find(a => a.id === msg.accountId);
                    if (hit) {
                        /* Picking a row clears its disabled flag — the user is
                           explicitly choosing it, overriding the rotation skip. */
                        if (hit.disabledUntil) {
                            for (const a of accounts) if (a.id === hit.id) a.disabledUntil = null;
                            setProviderAccounts(context, pid, accounts);
                        }
                        hit.lastUsedAt = new Date().toISOString();
                        for (const a of accounts) if (a.id === hit.id) a.lastUsedAt = hit.lastUsedAt;
                        setProviderAccounts(context, pid, accounts);
                        if (anthropicClient && pid === 'anthropic') anthropicClient = null;
                        await setActiveAccount(context, pid, hit.id);
                    }
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    break;
                }
                case 'disableAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    const accounts = getProviderAccounts(context, pid);
                    const hit = accounts.find(a => a.id === msg.accountId);
                    if (hit) {
                        /* Manual disable = skip in rotation until the user
                           re-enables. Use a far-future marker so it stays out
                           until [Use]/[Enable] clears it. */
                        for (const a of accounts) if (a.id === hit.id) a.disabledUntil = msg.enable ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
                        setProviderAccounts(context, pid, accounts);
                        /* If we just disabled the active account, advance active. */
                        const stillActive = getActiveAccount(context, pid);
                        if (stillActive && stillActive.id !== hit.id && anthropicClient && pid === 'anthropic') anthropicClient = null;
                    }
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    break;
                }
                /* removeAccount is the standalone modal's name; deleteAccount is
                   the Settings section's name. Same delete-and-reactivate flow. */
                case 'removeAccount':
                case 'deleteAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    let accounts = getProviderAccounts(context, pid);
                    const wasActive = (getActiveAccount(context, pid) || {}).id === msg.accountId;
                    accounts = accounts.filter(a => a.id !== msg.accountId);
                    setProviderAccounts(context, pid, accounts);
                    if (wasActive) {
                        const next = accounts.find(a => !_accountDisabled(a)) || accounts[0] || null;
                        await setActiveAccount(context, pid, next ? next.id : '');
                        if (anthropicClient && pid === 'anthropic') anthropicClient = null;
                    }
                    trace(`ACCOUNTS:DELETE provider=${pid} id=${msg.accountId} remaining=${accounts.length}`);
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    panel.webview.postMessage({ type: 'init', ...buildSettingsPayload(context) });
                    break;
                }
                /* Edit an existing account's label and/or key in place. Either
                   field is optional; a new key is shape-validated and de-duped.
                   NEVER log the raw key — only maskKey(). The webview drives this
                   from the standalone Accounts modal's inline-edit row. */
                case 'editAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    const p = PROVIDERS[pid] || {};
                    if (p.bridge) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Bridge providers have no API key to edit.' });
                        break;
                    }
                    const accounts = getProviderAccounts(context, pid);
                    const target = accounts.find(a => a.id === msg.accountId);
                    if (!target) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Account not found.' });
                        break;
                    }
                    const hasLabel = Object.prototype.hasOwnProperty.call(msg, 'label') && String(msg.label || '').trim() !== '';
                    const hasKey   = Object.prototype.hasOwnProperty.call(msg, 'apiKey') && String(msg.apiKey || '').trim() !== '';
                    if (!hasLabel && !hasKey) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Nothing to change — enter a new label or key.' });
                        break;
                    }
                    if (hasKey) {
                        const newKey = String(msg.apiKey).trim();
                        const shape = validateKeyShape(pid, newKey);
                        if (!shape.ok) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid key: ${shape.reason}.` });
                            break;
                        }
                        if (accounts.some(a => a.id !== target.id && a.apiKey === newKey)) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That key is already in the list.' });
                            break;
                        }
                        target.apiKey = newKey;
                        /* A key change invalidates a cached SDK client bound to it. */
                        if (anthropicClient && pid === 'anthropic') anthropicClient = null;
                    }
                    if (hasLabel) target.label = String(msg.label).trim();
                    setProviderAccounts(context, pid, accounts);
                    trace(`ACCOUNTS:EDIT provider=${pid} id=${target.id} label=${target.label} key=${maskKey(target.apiKey)} keyChanged=${hasKey}`);
                    panel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, pid) });
                    break;
                }
                case 'ollamaProbe': {
                    /* Panel asked us to re-check Ollama state — used after the
                       user manually starts the daemon themselves, or to refresh
                       the model list after a `pullOllamaModel`. */
                    ensureOllamaReady({ timeoutMs: 8000 })
                        .then((r) => {
                            if (activePanel) activePanel.webview.postMessage({ type: 'ollamaStatus', ...r });
                        })
                        .catch((e) => traceErr('ollamaProbe', e));
                    break;
                }
                case 'installOllama': {
                    /* User clicked the Install button. Runs the full silent-
                       install flow, streaming progress to the panel as a
                       sequence of ollamaInstallStatus messages. After install
                       lands, we re-probe and post the final ollamaStatus. */
                    if (_ollamaInstallInProgress) {
                        panel.webview.postMessage({ type: 'ollamaInstallStatus', step: 'busy', text: 'Install already in progress…' });
                        break;
                    }
                    panel.webview.postMessage({ type: 'ollamaInstallStatus', step: 'start', text: 'Starting Ollama install…' });
                    installOllama((step) => {
                        if (activePanel) activePanel.webview.postMessage({ type: 'ollamaInstallStatus', step: 'progress', text: step });
                    })
                        .then((r) => {
                            if (activePanel) {
                                activePanel.webview.postMessage({
                                    type: 'ollamaInstallStatus',
                                    step: r.ok ? 'done' : 'fail',
                                    text: r.ok
                                        ? `Ollama ready (${(r.models || []).length} model${(r.models || []).length === 1 ? '' : 's'})`
                                        : 'Install failed: ' + (r.reason || 'unknown'),
                                });
                                /* Refresh canonical state so the install button
                                   hides + the model dropdown renders. */
                                activePanel.webview.postMessage({
                                    type: 'ollamaStatus',
                                    state: r.ok ? 'ready' : 'missing',
                                    models: r.models || [],
                                });
                            }
                        })
                        .catch((e) => {
                            traceErr('installOllama', e);
                            if (activePanel) activePanel.webview.postMessage({ type: 'ollamaInstallStatus', step: 'fail', text: 'Install crashed: ' + (e.message || e) });
                        });
                    break;
                }
                case 'pullOllamaModel': {
                    const name = String((msg.model || '')).trim();
                    if (!name) {
                        panel.webview.postMessage({ type: 'ollamaPullStatus', step: 'fail', text: 'No model name supplied.' });
                        break;
                    }
                    panel.webview.postMessage({ type: 'ollamaPullStatus', step: 'start', model: name, text: `Pulling ${name}…` });
                    pullOllamaModel(name, (line) => {
                        if (activePanel) activePanel.webview.postMessage({ type: 'ollamaPullStatus', step: 'progress', model: name, text: line });
                    }).then((r) => {
                        if (activePanel) {
                            activePanel.webview.postMessage({
                                type: 'ollamaPullStatus',
                                step: r.ok ? 'done' : 'fail',
                                model: name,
                                text: r.ok ? `Pulled ${name}` : `Pull failed (exit ${r.code})`,
                            });
                            /* Re-probe so the available-models list updates. */
                            ensureOllamaReady({ timeoutMs: 4000 })
                                .then((s) => activePanel.webview.postMessage({ type: 'ollamaStatus', ...s }))
                                .catch(() => {});
                        }
                    }).catch((e) => traceErr('pullOllamaModel', e));
                    break;
                }
                case 'ensureBridge': {
                    /* Panel-initiated bridge check (e.g. user clicked "retry"
                       on a bridgeStatus banner). target is a key from
                       BRIDGE_PORTS. */
                    const t = String(msg.target || '').toLowerCase();
                    if (!BRIDGE_PORTS[t]) {
                        panel.webview.postMessage({ type: 'bridgeStatus', target: t, ok: false, reason: 'unknown bridge target' });
                        break;
                    }
                    ensureBridge(context, t, { timeoutMs: 8000 })
                        .then((r) => {
                            if (activePanel) activePanel.webview.postMessage({
                                type: 'bridgeStatus',
                                target: t,
                                ok: !!r.ok,
                                spawned: !!r.spawned,
                                exeMissing: !!r.exeMissing,
                                port: r.port,
                                reason: r.reason || '',
                            });
                        })
                        .catch((e) => traceErr('ensureBridge msg', e));
                    break;
                }
                case 'listSkins': {
                    /* Lazy scan: discover skins on-demand each time the webview
                       asks, so a user can drop a new .css into /skins and have
                       it appear without reloading the panel. Returns
                       [{ name, label, uri }] with webview-safe URIs. */
                    const skins = listSkins(context, panel.webview);
                    panel.webview.postMessage({ type: 'skinsList', skins });
                    break;
                }
                case 'debugComputed': {
                    /* Forward webview-side getComputedStyle reports to the trace
                       channel so we can see what the cascade actually resolves
                       to on a real session — diagnostic for the "still not
                       monospace" complaint without needing DevTools. */
                    const t = msg.target || '?';
                    const r = msg.report || {};
                    trace(`computed ${t} [${msg.reason||''}]: font-family=${r.fontFamily} size=${r.fontSize} weight=${r.fontWeight} font="${r.font}"`);
                    break;
                }
                case 'toggleMonitor':
                    /* VSCode supervisor service toggle. Sends `monitorState`
                       back when done so the webview can update the glow. */
                    toggleSupervisorService(context, panel).catch(e => traceErr('toggleMonitor', e));
                    break;
                case 'monitorStatus': {
                    /* Probe + watchdog. Glow tracks HTTP liveness on :3434 —
                       a 200 OK means the supervisor script is bound to its
                       port AND replying. If the service is installed but
                       the HTTP probe fails, auto-restart the service so the
                       blue glow self-heals after crashes/external stops. */
                    const state = _scQueryState(SUPERVISOR_SERVICE_NAME);
                    _supervisorHttpAlive().then(alive => {
                        panel.webview.postMessage({
                            type: 'monitorState',
                            running: alive,                  /* drives the blue glow */
                            state,                           /* sc state for tooltips */
                            httpAlive: alive,
                            port: SUPERVISOR_PORT,
                        });
                        if (!alive && state !== 'not-installed') {
                            const now = Date.now();
                            const last = _supervisorLastRestartAt || 0;
                            if (now - last > 30000) {
                                /* 30s cool-down. If the service is genuinely
                                   broken, repeated restarts won't fix it, so
                                   we don't restart-storm. The trace channel
                                   shows each kick. */
                                _supervisorLastRestartAt = now;
                                trace(`SUPERVISOR:WATCHDOG http-down state=${state} — kicking restart`);
                                try {
                                    if (state === 'running') stopSupervisorService();
                                    setTimeout(() => { try { startSupervisorService(); } catch (e) { traceErr('SUPERVISOR:WATCHDOG:start', e); } }, 1500);
                                } catch (e) { traceErr('SUPERVISOR:WATCHDOG', e); }
                            }
                        }
                    });
                    break;
                }
                case 'pushUpdate': {
                    /* Webview-triggered push. Same path as the
                       codexBlackEd.pushUpdate command. Posts info/error
                       message back so the chat shows what happened. */
                    try {
                        pushUpdateToServer(context);
                        panel.webview.postMessage({ type: 'info', text: 'Auto-update push started — see logs/winscp_push_*.xml for results.' });
                    } catch (e) {
                        traceErr('pushUpdate(webview)', e);
                        panel.webview.postMessage({ type: 'error', message: 'pushUpdate failed: ' + (e.message || e) });
                    }
                    break;
                }
                case 'fetchExtensionsCatalog': {
                    /* Host-side fetch of the marketplace catalog XML. The panel
                       renders the cards NATIVELY instead of iframing the PHP
                       page — VSCode webviews render external-https iframes as
                       a black rectangle on many builds, so we pull the data
                       here and hand the panel a plain JS array.

                       We ALSO scan extensions/<id>/ on disk and mark each
                       catalog item with `installed: true/false` so the panel
                       can render "Open"/"Uninstall" instead of "Install" for
                       anything already present. This way install state
                       persists across modal close+reopen. */
                    const catalogUrl = 'https://trentontompkins.com/cbe/extension/extensions.xml.php';
                    (async () => {
                        try {
                            const buf = await _httpsGetBuffer(catalogUrl, 15000);
                            const xml = buf.toString('utf8');
                            /* Flat schema — one <extension> block per entry with
                               attributes + a few child elements. Regex-parse it;
                               no XML lib needed for a structure this simple. */
                            const items = [];
                            const blockRe = /<extension\b([^>]*)>([\s\S]*?)<\/extension>/gi;
                            const attrRe = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
                            const childText = (body, tag) => {
                                const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
                                return m ? m[1].trim() : '';
                            };
                            const childAll = (body, tag) => {
                                const out = [];
                                const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
                                let mm;
                                while ((mm = re.exec(body)) !== null) out.push(mm[1].trim());
                                return out;
                            };
                            const unescapeXml = (s) => String(s)
                                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                                .replace(/&amp;/g, '&');
                            let block;
                            while ((block = blockRe.exec(xml)) !== null) {
                                const attrs = {};
                                let am;
                                attrRe.lastIndex = 0;
                                while ((am = attrRe.exec(block[1])) !== null) attrs[am[1]] = unescapeXml(am[2]);
                                const body = block[2];
                                items.push({
                                    id: attrs.id || '',
                                    name: attrs.name || attrs.id || '',
                                    version: attrs.version || '',
                                    author: attrs.author || '',
                                    created: attrs.created || '',
                                    md5: attrs.md5 || '',
                                    bytes: Number(attrs.bytes || 0) || 0,
                                    minCore: attrs.min_core || '',
                                    description: unescapeXml(childText(body, 'description')),
                                    fileUrl: unescapeXml(childText(body, 'url')),
                                    entry: unescapeXml(childText(body, 'entry')),
                                    icon: unescapeXml(childText(body, 'icon')),
                                    tags: childAll(body, 'tag').map(unescapeXml),
                                });
                            }
                            /* Cross-reference with the on-disk extensions/<id>/
                               folder so install state survives a modal close+
                               reopen. Items installed locally but not in the
                               catalog (sideloaded / catalog removed) still get
                               surfaced so the user can Open/Uninstall them. */
                            const installedMap = _scanInstalledExtensions(context);
                            const pinned       = _readPinnedExtensions(context);
                            for (const it of items) {
                                const localInfo = installedMap.get(it.id);
                                it.installed       = !!localInfo;
                                it.installedEntry  = localInfo ? localInfo.entry  : '';
                                it.installedVer    = localInfo ? localInfo.version : '';
                                it.pinned          = pinned.includes(it.id);
                                if (!it.icon && localInfo && localInfo.icon) it.icon = localInfo.icon;
                            }
                            for (const [id, info] of installedMap.entries()) {
                                if (items.find(it => it.id === id)) continue;
                                items.push({
                                    id,
                                    name: info.name || id,
                                    version: info.version || '',
                                    author: info.author || '',
                                    created: '',
                                    md5: '',
                                    bytes: 0,
                                    minCore: '',
                                    description: info.description || '(sideloaded — not in catalog)',
                                    fileUrl: '',
                                    entry: info.entry || '',
                                    icon: info.icon || '',
                                    tags: [],
                                    installed: true,
                                    installedEntry: info.entry || '',
                                    installedVer: info.version || '',
                                    pinned: pinned.includes(id),
                                });
                            }
                            trace(`EXT:CATALOG:OK url=${catalogUrl} count=${items.length} installed=${installedMap.size} pinned=${pinned.length}`);
                            panel.webview.postMessage({ type: 'extensionsCatalog', items });
                        } catch (e) {
                            traceErr('EXT:CATALOG:FAIL', e);
                            panel.webview.postMessage({ type: 'extensionsCatalog', items: [], error: (e && e.message) || String(e) });
                        }
                    })();
                    break;
                }
                case 'installExtension': {
                    /* The marketplace iframe asked us to install a .ext bundle.
                       Download it over HTTPS, MD5-verify if a hash was given,
                       then extract the zip into extensions/<id>/. Echo the
                       result back so the iframe's button flips state. */
                    const ext = msg.ext || {};
                    const extId = String(ext.id || '').replace(/[^a-zA-Z0-9_.-]/g, '') || 'unknown';
                    const fileUrl = String(ext.fileUrl || '');
                    trace(`EXT:INSTALL:BEGIN id=${extId} url=${fileUrl} md5=${ext.md5 || '<none>'}`);
                    (async () => {
                        let ok = false;
                        let errMsg = '';
                        try {
                            if (!/^https:\/\//i.test(fileUrl)) throw new Error('refusing non-https extension URL');
                            const buf = await _httpsGetBuffer(fileUrl, 60000);
                            if (ext.md5) {
                                const got = require('crypto').createHash('md5').update(buf).digest('hex').toLowerCase();
                                if (got !== String(ext.md5).toLowerCase()) {
                                    throw new Error(`md5 mismatch: server=${ext.md5} downloaded=${got}`);
                                }
                            }
                            const extsRoot = path.join(context.extensionPath, 'extensions');
                            const destDir  = path.join(extsRoot, extId);
                            fs.mkdirSync(destDir, { recursive: true });
                            /* .ext is a plain zip. Node has no built-in unzip, so
                               write it to a temp .zip and let PowerShell's
                               Expand-Archive extract it — zero extra deps. */
                            const tmpZip = path.join(os.tmpdir(), `cbe_ext_${extId}_${Date.now()}.zip`);
                            fs.writeFileSync(tmpZip, buf);
                            const r = require('child_process').spawnSync('powershell.exe',
                                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                                 `Expand-Archive -LiteralPath '${tmpZip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
                                { encoding: 'utf8', windowsHide: true, timeout: 30000 });
                            try { fs.unlinkSync(tmpZip); } catch (_) {}
                            if (r.status !== 0) {
                                throw new Error('Expand-Archive failed: ' + ((r.stderr || '').trim() || 'rc=' + r.status));
                            }
                            ok = true;
                            trace(`EXT:INSTALL:OK id=${extId} -> ${destDir}`);
                        } catch (e) {
                            errMsg = e.message || String(e);
                            traceErr('EXT:INSTALL:FAIL id=' + extId, e);
                        }
                        let installedEntry = '';
                        if (ok) {
                            /* Re-scan to pick up the freshly-extracted manifest
                               so the panel knows the entry HTML path for "Open". */
                            const scanned = _scanInstalledExtensions(context);
                            const info = scanned.get(extId);
                            installedEntry = (info && info.entry) || '';
                        }
                        try {
                            panel.webview.postMessage({
                                type: 'cbe.installResultFromHost',
                                id: extId, ok, name: ext.name || extId,
                                entry: installedEntry,
                            });
                        } catch (_) {}
                        if (ok) {
                            panel.webview.postMessage({ type: 'info', text: `Extension installed: ${ext.name || extId}. It lives in extensions/${extId}/.` });
                        } else {
                            panel.webview.postMessage({ type: 'error', message: `Extension install failed (${ext.name || extId}): ${errMsg}` });
                        }
                    })();
                    break;
                }
                case 'openExtension': {
                    /* User clicked the "Open" icon on an installed extension
                       card. Read the entry HTML off disk, post it back as a
                       srcdoc payload so the panel can iframe it inside a modal
                       (or render it on the toolbar if pinned). The entry path
                       is normalized to stay inside extensions/<id>/. */
                    const extId = String((msg.id || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
                    if (!extId) { panel.webview.postMessage({ type: 'error', message: 'openExtension: missing id' }); break; }
                    try {
                        const scanned = _scanInstalledExtensions(context);
                        const info = scanned.get(extId);
                        if (!info) throw new Error(`extension '${extId}' is not installed`);
                        const entry = info.entry || 'extension.html';
                        /* Path-traversal guard: resolve and ensure it's still
                           under extensions/<id>/. */
                        const extDir = path.join(context.extensionPath, 'extensions', extId);
                        const entryAbs = path.resolve(extDir, entry);
                        if (!entryAbs.toLowerCase().startsWith(extDir.toLowerCase() + path.sep) &&
                            entryAbs.toLowerCase() !== extDir.toLowerCase()) {
                            throw new Error(`entry path escapes extension dir: ${entry}`);
                        }
                        if (!fs.existsSync(entryAbs)) throw new Error(`entry file not found: ${entry}`);
                        const html = fs.readFileSync(entryAbs, 'utf8');
                        panel.webview.postMessage({
                            type: 'cbe.openExtensionFromHost',
                            id: extId, name: info.name || extId, html,
                        });
                        trace(`EXT:OPEN:OK id=${extId} entry=${entry} bytes=${html.length}`);
                    } catch (e) {
                        traceErr(`EXT:OPEN:FAIL id=${extId}`, e);
                        panel.webview.postMessage({ type: 'error', message: `Open extension failed (${extId}): ${e.message || e}` });
                    }
                    break;
                }
                case 'uninstallExtension': {
                    /* Recursive remove of extensions/<id>/ + drop from pinned
                       list. The panel re-renders the card as "Install" again. */
                    const extId = String((msg.id || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
                    if (!extId) { panel.webview.postMessage({ type: 'error', message: 'uninstallExtension: missing id' }); break; }
                    try {
                        const dir = path.join(context.extensionPath, 'extensions', extId);
                        if (fs.existsSync(dir)) _rmTree(dir);
                        const pinned = _readPinnedExtensions(context).filter(x => x !== extId);
                        _writePinnedExtensions(context, pinned);
                        panel.webview.postMessage({
                            type: 'cbe.uninstallResultFromHost',
                            id: extId, ok: true, pinned,
                        });
                        panel.webview.postMessage({ type: 'info', text: `Extension uninstalled: ${extId}.` });
                        trace(`EXT:UNINSTALL:OK id=${extId}`);
                    } catch (e) {
                        traceErr(`EXT:UNINSTALL:FAIL id=${extId}`, e);
                        panel.webview.postMessage({ type: 'cbe.uninstallResultFromHost', id: extId, ok: false });
                        panel.webview.postMessage({ type: 'error', message: `Uninstall failed (${extId}): ${e.message || e}` });
                    }
                    break;
                }
                case 'pinExtension':
                case 'unpinExtension': {
                    /* Toggle membership in extensions/_pinned.json. Panel
                       receives the new pinned list + re-renders the toolbar. */
                    const extId = String((msg.id || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
                    if (!extId) break;
                    let pinned = _readPinnedExtensions(context);
                    if (msg.type === 'pinExtension') {
                        if (!pinned.includes(extId)) pinned.push(extId);
                    } else {
                        pinned = pinned.filter(x => x !== extId);
                    }
                    _writePinnedExtensions(context, pinned);
                    /* Build the metadata list the panel needs to render toolbar
                       buttons — id + name + the extension's own <icon> emoji
                       (falls back to a generic glyph panel-side if absent). */
                    const scanned = _scanInstalledExtensions(context);
                    const meta = pinned
                        .map(id => {
                            const info = scanned.get(id) || {};
                            return { id, name: info.name || id, icon: info.icon || '', iconSvg: info.iconSvg || '' };
                        })
                        .filter(x => scanned.has(x.id));
                    panel.webview.postMessage({
                        type: 'cbe.pinnedExtensions',
                        pinned, meta,
                    });
                    trace(`EXT:PIN:${msg.type === 'pinExtension' ? 'ADD' : 'REMOVE'} id=${extId} -> [${pinned.join(',')}]`);
                    break;
                }
                case 'compactConversation': {
                    /* Compact the running conversation. Strategy:
                         - Keep the last 4 turns verbatim (system + recent
                           context the user is actively iterating on).
                         - Replace everything before that with a single
                           synthetic assistant message that summarizes the
                           dropped turns by length. No API call — the host
                           can't reliably stream a model summary from here
                           without conflicting with an in-flight chat.
                       The token-usage ring on the button resets after this
                       because the dropped body bytes are gone. */
                    const KEEP_TAIL = 4;
                    const before = conversation.length;
                    if (before > KEEP_TAIL) {
                        const dropped = conversation.slice(0, before - KEEP_TAIL);
                        const droppedChars = dropped.reduce((n, m) => n + String(m.content || '').length, 0);
                        const tail = conversation.slice(before - KEEP_TAIL);
                        conversation = [
                            { role: 'user',      content: `[Conversation compacted: ${dropped.length} prior turns (${droppedChars.toLocaleString()} chars) summarized away.]` },
                            { role: 'assistant', content: 'Acknowledged — earlier context dropped. Continuing with the most recent turns.' },
                            ...tail,
                        ];
                        trace(`COMPACT before=${before} after=${conversation.length} dropped-chars=${droppedChars}`);
                        panel.webview.postMessage({ type: 'info', text: `Compacted: dropped ${dropped.length} prior turns (~${Math.round(droppedChars / 4).toLocaleString()} tokens).` });
                    } else {
                        panel.webview.postMessage({ type: 'info', text: `Nothing to compact — only ${before} turn${before === 1 ? '' : 's'} in history.` });
                    }
                    /* Push a fresh usage estimate to the panel so the ring resets. */
                    _postContextUsage(panel, context);
                    break;
                }
                case 'contextUsage': {
                    _postContextUsage(panel, context);
                    break;
                }
                case 'runGit': {
                    /* Run a git command in the active project folder + post
                       the combined stdout/stderr back to the panel. Refuses
                       to run with no project folder set (panel should have
                       already prompted, but the host enforces it too). */
                    const folder = context.workspaceState.get('codexBlackEd.projectFolder', '') || '';
                    if (!folder || !fs.existsSync(folder)) {
                        panel.webview.postMessage({ type: 'gitResult', error: 'No project folder set. Pick one first.' });
                        break;
                    }
                    const argv = Array.isArray(msg.args) ? msg.args.map(String) : [];
                    if (!argv.length) {
                        panel.webview.postMessage({ type: 'gitResult', error: 'No git arguments provided.' });
                        break;
                    }
                    try {
                        const cp = require('child_process');
                        cp.execFile('git', argv, { cwd: folder, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                            const out = String(stdout || '');
                            const errOut = String(stderr || '');
                            const rc = (err && typeof err.code === 'number') ? err.code : (err ? 1 : 0);
                            panel.webview.postMessage({
                                type: 'gitResult',
                                argv,
                                cwd: folder,
                                rc,
                                stdout: out,
                                stderr: errOut,
                            });
                        });
                    } catch (e) {
                        traceErr('runGit', e);
                        panel.webview.postMessage({ type: 'gitResult', error: String(e && e.message || e) });
                    }
                    break;
                }
                case 'loadWake': {
                    /* Read wake.txt from extension root + post back so the
                       panel can render its editor modal. Missing file → empty
                       string default. */
                    try {
                        const wakePath = path.join(context.extensionPath, 'wake.txt');
                        const text = fs.existsSync(wakePath) ? fs.readFileSync(wakePath, 'utf8') : '';
                        panel.webview.postMessage({ type: 'wakeText', text });
                    } catch (e) {
                        traceErr('loadWake', e);
                        panel.webview.postMessage({ type: 'wakeText', text: '', error: String(e.message || e) });
                    }
                    break;
                }
                case 'saveWake': {
                    /* Write wake.txt with the panel-supplied text. Empty
                       string clears the file (still kept as a 0-byte
                       marker so future reads don't 404). */
                    try {
                        const wakePath = path.join(context.extensionPath, 'wake.txt');
                        fs.writeFileSync(wakePath, String(msg.text || ''), 'utf8');
                        panel.webview.postMessage({ type: 'info', text: `wake.txt saved (${(msg.text || '').length} chars).` });
                    } catch (e) {
                        traceErr('saveWake', e);
                        panel.webview.postMessage({ type: 'error', message: 'wake.txt write failed: ' + (e.message || e) });
                    }
                    break;
                }
                case 'listDomains': {
                    /* NameSilo domain list. Serves from domains.txt cache by
                       default; the panel's Reload button posts `force: true`
                       to refresh from the API + rewrite the cache. */
                    listNameSiloDomains(context, { force: !!msg.force }).then(payload => {
                        panel.webview.postMessage({ type: 'domainsList', ...payload });
                    }).catch(e => {
                        traceErr('listDomains', e);
                        panel.webview.postMessage({ type: 'domainsList', error: String(e && e.message || e) });
                    });
                    break;
                }
                case 'listGitHubRepos': {
                    /* GitHub /user/repos listing — PAT from config.ini, paginated
                       via Link header (5 pages max). All error modes (no PAT,
                       401, 403, network) come back as { error: '...' }. */
                    listGitHubRepos(context).then(payload => {
                        panel.webview.postMessage({ type: 'githubReposList', ...payload });
                    }).catch(e => {
                        traceErr('listGitHubRepos', e);
                        panel.webview.postMessage({ type: 'githubReposList', error: String(e && e.message || e) });
                    });
                    break;
                }
                case 'openExternal': {
                    /* Open a URL in the user's default browser. Used by the
                       GitHub repos modal so clicking a repo name navigates
                       to github.com without leaving VSCode's host context. */
                    try {
                        const url = String(msg.url || '').trim();
                        if (!url) break;
                        if (!/^https?:\/\//i.test(url)) {
                            panel.webview.postMessage({ type: 'error', message: 'openExternal: refused non-http(s) URL.' });
                            break;
                        }
                        await vscode.env.openExternal(vscode.Uri.parse(url));
                    } catch (e) {
                        traceErr('openExternal', e);
                        panel.webview.postMessage({ type: 'error', message: 'openExternal: ' + (e.message || e) });
                    }
                    break;
                }
                case 'labelClick':
                    panel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
                    break;
                case 'showTrace':
                    /* Triple-tap: outChan.show() switches to our channel,
                       the workbench command forces the Output panel open
                       (in case it's collapsed), and a trace line on every
                       click means even an already-visible channel scrolls
                       and confirms the click landed. Wrapped in try/catch
                       so any one failing doesn't prevent the others. */
                    try { trace(`monitor: clicked at ${new Date().toISOString()}`); } catch (_) {}
                    try { outChan.show(false); } catch (e) { traceErr('showTrace.outChan.show', e); }
                    try { await vscode.commands.executeCommand('workbench.panel.output.focus'); }
                    catch (e) { traceErr('showTrace.output.focus', e); }
                    try { await vscode.commands.executeCommand('workbench.action.output.show.codexBlackEd'); }
                    catch (_) { /* expected to fail on most VSCode builds — fallback above already worked */ }
                    break;
                case 'loadSetup': {
                    /* Read config.ini and post back a flat "section.key" ->
                       value map for every field the setup wizard knows
                       about. The wizard renders one step at a time using
                       these as preset values. */
                    const cfgFull = Config.get(context.extensionPath) || {};
                    const wanted = [
                        'api_keys.anthropic_api_key', 'api_keys.openai_api_key',
                        'api_keys.gemini_api_key',    'api_keys.xai_api_key',
                        'github.token',
                        'email.account',  'email.password',
                        'cloudflare.api_token',
                        'twilio.account_sid', 'twilio.auth_token', 'twilio.from_number',
                        'elevenlabs.api_key',
                        'stability.api_key',
                        'runway.api_key',
                        'sendgrid.api_key', 'sendgrid.from_email',
                        'serpapi.api_key',
                        'namesilo.api_key',
                        'airtable.api_token',
                        'browserless.token',
                        'google.service_account_json', 'google.admin_email',
                    ];
                    const values = {};
                    for (const fk of wanted) {
                        const [section, key] = fk.split('.');
                        values[fk] = (cfgFull[section] && cfgFull[section][key]) || '';
                    }
                    panel.webview.postMessage({ type: 'setupValues', values });
                    break;
                }
                case 'saveSetup': {
                    /* Write the supplied "section.key" -> value patch back
                       into config.ini, preserving comments + structure.
                       Empty values are still written (so the user can clear
                       a field) — the wizard's Skip path never reaches this
                       handler, so this only fires for fields they touched. */
                    try {
                        const patch = (msg && msg.patch) || {};
                        const cfgPath = path.join(context.extensionPath, CONFIG_INI_NAME);
                        writeConfigPatch(cfgPath, patch);
                        Config.reload(context.extensionPath);
                        panel.webview.postMessage({ type: 'info', text: 'Setup saved.' });
                    } catch (e) {
                        traceErr('saveSetup', e);
                        panel.webview.postMessage({ type: 'error', message: 'Setup save failed: ' + (e.message || e) });
                    }
                    break;
                }
                case 'openTerminal': {
                    /* Open our named "Claude Codex Black" terminal so the user
                       can run shell commands. cwd resolution, in order:
                         1. The active project folder if one is set
                         2. The user's Desktop as the universal fallback
                       We deliberately do NOT reuse VSCode's activeTerminal —
                       that might be sitting in some unrelated cwd from another
                       extension. Instead we own a single CBE terminal: reveal
                       it if still alive, otherwise spin up a fresh one rooted
                       in the right cwd. */
                    const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || '';
                    let cwd = '';
                    if (projectFolder && fs.existsSync(projectFolder)) {
                        cwd = projectFolder;
                    } else {
                        const desktop = path.join(os.homedir(), 'Desktop');
                        if (fs.existsSync(desktop)) cwd = desktop;
                    }
                    /* Find an existing CBE terminal if we haven't closed it. */
                    const existing = vscode.window.terminals.find(t => t === cbeTerm);
                    if (existing) {
                        existing.show(false);
                    } else {
                        cbeTerm = vscode.window.createTerminal({
                            name: 'Claude Codex Black',
                            cwd: cwd || undefined,
                        });
                        cbeTerm.show(false);
                    }
                    break;
                }
                case 'openDevTools':
                    try { await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools'); }
                    catch (e) { traceErr('openDevTools', e); panel.webview.postMessage({ type: 'error', message: 'DevTools: ' + (e.message || e) }); }
                    break;
                case 'showLicense': {
                    /* /license slash command — read LICENSE.TXT and stream
                       it into the chat as an info message. Full MIT terms
                       visible inline without leaving the panel. */
                    try {
                        const lic = path.join(context.extensionPath, 'LICENSE.TXT');
                        const text = fs.existsSync(lic)
                            ? fs.readFileSync(lic, 'utf8')
                            : 'LICENSE.TXT not found in the extension folder.';
                        panel.webview.postMessage({ type: 'info', text });
                    } catch (e) {
                        traceErr('showLicense', e);
                        panel.webview.postMessage({ type: 'error', message: 'LICENSE read failed: ' + (e.message || e) });
                    }
                    break;
                }
                case 'refreshPanel':
                    /* Re-read panel/index.html + re-resolve all template URIs and
                       reassign panel.webview.html. The webview tears itself down
                       and re-fires `ready` on the new document, which rehydrates
                       provider/skin/sfx state from buildSettingsPayload. This
                       is NOT a full VSCode reload — extension host stays alive,
                       message handlers stay registered, terminal stays open.
                       Cache-busting query strings on the JS/CSS URIs make this
                       actually pick up file edits (was a no-op before fix). */
                    try {
                        const html = getPanelHtml(context, panel.webview);
                        panel.webview.html = html;
                        trace('panel reloaded via context menu (cache-busted)');
                    } catch (e) {
                        traceErr('refreshPanel', e);
                    }
                    break;
                case 'reloadWindow':
                    /* Full VSCode window reload — last-resort for picking up
                       extension.js (host-side) edits. User authorized this
                       2026-05-22 over the never-reload rule because Reload
                       Panel can't touch extension host code. */
                    trace('reloadWindow requested via context menu');
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                    break;
                case 'sttStart':
                    /* Fallback path: webview's Web Speech API got `not-allowed`
                       (VSCode sandboxes the iframe out of the mic permission).
                       Launch Windows SAPI on the host instead and post the
                       transcript back as sttResult. */
                    startSapiStt(panel);
                    break;
                case 'sttStop':
                    stopSapiStt();
                    break;
                default:
                    trace('  unhandled type: ' + msg.type);
            }
        } catch (e) {
            traceErr('onDidReceiveMessage handler', e);
            panel.webview.postMessage({ type: 'error', message: e.message || String(e) });
        }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
        trace('panel disposed');
        if (activePanel === panel) activePanel = undefined;
        /* Reap any in-flight SAPI recognizer so the PowerShell process doesn't
           outlive the panel that was waiting on its transcript. */
        stopSapiStt();
    });
}

function getPanelHtml(context, webview) {
    const endHtml = timeStep('getPanelHtml');
    const htmlPath = path.join(context.extensionPath, 'panel', 'index.html');
    const endRead = timeStep('  read panel/index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    endRead(`bytes=${html.length}`);

    /* Cache-buster appended to every JS/CSS URI. Without this, reassigning
       panel.webview.html on refresh keeps producing the SAME URIs, so
       Chromium serves the cached resources and edits to panel.js / CSS
       never appear (user 2026-05-22: "right click > Refresh doesnt do
       anything"). Stamping `?v=<mtime>` per-file forces a re-fetch only
       when the file actually changed. */
    const _bust = (p) => {
        try { return String(fs.statSync(p).mtimeMs | 0); }
        catch (e) { return String(Date.now()); }
    };
    const withV = (uri, fsPath) => uri.toString() + '?v=' + _bust(fsPath);

    const endUris = timeStep('  buildAssetUris');
    const assetsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets')));
    const labelUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png')));
    const blankUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank.png')));
    const blankOverUri  = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_over.png')));
    const blankClickUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_click.png')));
    const prismJsPath   = path.join(context.extensionPath, 'lib', 'prism.min.js');
    const prismLangsPath= path.join(context.extensionPath, 'lib', 'prism-langs.min.js');
    const prismCssPath  = path.join(context.extensionPath, 'lib', 'prism-dark.min.css');
    const prismJsUri    = webview.asWebviewUri(vscode.Uri.file(prismJsPath));
    const prismLangsUri = webview.asWebviewUri(vscode.Uri.file(prismLangsPath));
    const prismCssUri   = webview.asWebviewUri(vscode.Uri.file(prismCssPath));
    const soundsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'sounds')));
    const helpUri       = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'panel', 'help.html')));
    const panelJsPath   = path.join(context.extensionPath, 'panel', 'panel.js');
    const panelJsUri    = webview.asWebviewUri(vscode.Uri.file(panelJsPath));
    /* Tamagotchi game scripts — three vanilla-JS modules that the panel's
       index.html loads BEFORE panel.js so the game's globals (DotMatrix40,
       TAMAGOTCHI_SPRITES, TamagotchiGame) are defined for any code that
       wants to reference them. Each module self-guards against duplicate
       registration, so re-injecting via hot-reload is safe. */
    const dotmatrixJsPath   = path.join(context.extensionPath, 'panel', 'dotmatrix.js');
    const tamaSpritesJsPath = path.join(context.extensionPath, 'panel', 'dotmatrix-tamagotchi-sprites.js');
    const tamaGameJsPath    = path.join(context.extensionPath, 'panel', 'dotmatrix-tamagotchi-game.js');
    const dotmatrixJsUri    = webview.asWebviewUri(vscode.Uri.file(dotmatrixJsPath));
    const tamaSpritesJsUri  = webview.asWebviewUri(vscode.Uri.file(tamaSpritesJsPath));
    const tamaGameJsUri     = webview.asWebviewUri(vscode.Uri.file(tamaGameJsPath));
    endUris();

    const endSubst = timeStep('  substituteTemplateTokens');
    html = html.split('{{ASSETS_BASE}}').join(assetsBase.toString());
    html = html.split('{{SOUNDS_BASE}}').join(soundsBase.toString());
    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    html = html.split('{{BLANK_URI}}').join(blankUri.toString());
    html = html.split('{{BLANK_OVER_URI}}').join(blankOverUri.toString());
    html = html.split('{{BLANK_CLICK_URI}}').join(blankClickUri.toString());
    html = html.split('{{PRISM_JS_URI}}').join(withV(prismJsUri, prismJsPath));
    html = html.split('{{PRISM_LANGS_URI}}').join(withV(prismLangsUri, prismLangsPath));
    html = html.split('{{PRISM_CSS_URI}}').join(withV(prismCssUri, prismCssPath));
    html = html.split('{{HELP_URI}}').join(helpUri.toString());
    html = html.split('{{PANEL_JS_URI}}').join(withV(panelJsUri, panelJsPath));
    html = html.split('{{DOTMATRIX_JS_URI}}').join(withV(dotmatrixJsUri, dotmatrixJsPath));
    html = html.split('{{TAMA_SPRITES_JS_URI}}').join(withV(tamaSpritesJsUri, tamaSpritesJsPath));
    html = html.split('{{TAMA_GAME_JS_URI}}').join(withV(tamaGameJsUri, tamaGameJsPath));
    html = html.split('{{CSP_SOURCE}}').join(webview.cspSource);
    endSubst();
    endHtml(`final bytes=${html.length}`);
    return html;
}

/* Prompt-history file (Linux/PowerShell-style up-arrow recall). One line per
   prompt, capped at 500 lines. Lives next to the extension so it survives
   workspace switches. */
const PROMPT_HISTORY_FILE = 'prompt_history.txt';
const PROMPT_HISTORY_MAX  = 500;
const PROMPTS_FILE        = 'prompts.txt';      /* legacy single-file format — migrated to stored_prompts/ on first read */
const PROMPTS_SEPARATOR   = '---';
const STORED_PROMPTS_DIR  = 'stored_prompts';   /* one .txt file per prompt; sorted by filename (NN-slug.txt) */
const CHATS_DIR           = 'chats';            /* one log per UTC date */

function promptHistoryPath(context) {
    return path.join(context.extensionPath, PROMPT_HISTORY_FILE);
}

function loadPromptHistory(context) {
    try {
        const p = promptHistoryPath(context);
        if (!fs.existsSync(p)) return [];
        const raw = fs.readFileSync(p, 'utf8');
        return raw.split(/\r?\n/).map(s => s).filter(s => s.length > 0);
    } catch (e) {
        traceErr('loadPromptHistory', e);
        return [];
    }
}

function pushPromptHistory(context, text) {
    if (!text || !text.trim()) return;
    try {
        const p = promptHistoryPath(context);
        const existing = loadPromptHistory(context);
        if (existing.length && existing[existing.length - 1] === text) return;
        existing.push(text);
        const trimmed = existing.slice(-PROMPT_HISTORY_MAX);
        fs.writeFileSync(p, trimmed.join('\n') + '\n', 'utf8');
    } catch (e) {
        traceErr('pushPromptHistory', e);
    }
}

/* Curated prompts — directory layout (stored_prompts/NN-slug.txt, one prompt
   per file). Files are sorted by filename so "01-…", "02-…" controls order.
   Legacy prompts.txt (multi-block, "---" separator) is migrated into the
   directory on first read and then ignored. */
function promptsFilePath(context) {
    return path.join(context.extensionPath, PROMPTS_FILE);
}

function storedPromptsDir(context) {
    return path.join(context.extensionPath, STORED_PROMPTS_DIR);
}

function slugify(s) {
    return String(s || '')
        .replace(/^\s+|\s+$/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'prompt';
}

function _migrateLegacyPromptsTxt(context, dir) {
    /* Called only when stored_prompts/ doesn't exist yet. Read the old single
       file, split on "---", write one file per block, then leave prompts.txt
       in place as a backup the user can delete by hand. */
    try {
        const p = promptsFilePath(context);
        if (!fs.existsSync(p)) return;
        const raw = fs.readFileSync(p, 'utf8');
        const lines = raw.split(/\r?\n/);
        const blocks = [];
        let cur = [];
        for (const line of lines) {
            if (line.trim() === PROMPTS_SEPARATOR) {
                const piece = cur.join('\n').replace(/^\s+|\s+$/g, '');
                if (piece) blocks.push(piece);
                cur = [];
            } else {
                cur.push(line);
            }
        }
        const tail = cur.join('\n').replace(/^\s+|\s+$/g, '');
        if (tail) blocks.push(tail);
        if (!blocks.length) return;
        fs.mkdirSync(dir, { recursive: true });
        blocks.forEach((body, i) => {
            const num = String(i + 1).padStart(2, '0');
            const firstLine = (body.split(/\r?\n/).find(l => l.trim()) || '').trim();
            const name = `${num}-${slugify(firstLine)}.txt`;
            const full = path.join(dir, name);
            if (!fs.existsSync(full)) fs.writeFileSync(full, body + '\n', 'utf8');
        });
        trace(`PROMPTS:MIGRATED count=${blocks.length} from=${p} into=${dir}`);
    } catch (e) {
        traceErr('_migrateLegacyPromptsTxt', e);
    }
}

function loadPrompts(context) {
    try {
        const dir = storedPromptsDir(context);
        if (!fs.existsSync(dir)) _migrateLegacyPromptsTxt(context, dir);
        if (!fs.existsSync(dir)) return [];
        const names = fs.readdirSync(dir)
            .filter(n => n.toLowerCase().endsWith('.txt'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const out = [];
        for (const name of names) {
            try {
                const body = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\s+|\s+$/g, '');
                if (body) out.push(body);
            } catch (e) {
                traceErr(`loadPrompts read ${name}`, e);
            }
        }
        return out;
    } catch (e) {
        traceErr('loadPrompts', e);
        return [];
    }
}

/* Persist the user-curated prompt list back to prompts.txt. Each entry is
   written as its own block separated by a line that is exactly "---".
   Empty / whitespace-only entries are dropped to keep the file clean.
   Atomic write: stage to a sibling .tmp file then rename over the target
   so partial writes can't corrupt the canonical file. Returns the array
   that was actually written (i.e. after the empty-entry filter). */
function savePrompts(context, items) {
    /* Wipes stored_prompts/ and rewrites each item as NN-slug.txt with a
       sequential numeric prefix that preserves the panel's display order.
       Slug comes from the first non-blank line. We only remove .txt files
       so unrelated user files in the dir (notes, etc.) survive. */
    const dir = storedPromptsDir(context);
    const cleaned = (Array.isArray(items) ? items : [])
        .map(s => String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''))
        .filter(s => s.length > 0);
    try {
        fs.mkdirSync(dir, { recursive: true });
        for (const name of fs.readdirSync(dir)) {
            if (name.toLowerCase().endsWith('.txt')) {
                try { fs.unlinkSync(path.join(dir, name)); } catch (e) { traceErr(`savePrompts unlink ${name}`, e); }
            }
        }
        const pad = Math.max(2, String(cleaned.length).length);
        cleaned.forEach((body, i) => {
            const num = String(i + 1).padStart(pad, '0');
            const firstLine = (body.split(/\r?\n/).find(l => l.trim()) || '').trim();
            const name = `${num}-${slugify(firstLine)}.txt`;
            fs.writeFileSync(path.join(dir, name), body + '\n', 'utf8');
        });
        return cleaned;
    } catch (e) {
        traceErr('savePrompts', e);
        throw e;
    }
}

/* Chat history — one log file per day at <extensionPath>/chats/chat-M-D-YYYY.log
   Format is plain text with role headers + timestamps so the file reads
   cleanly when opened in a normal editor. */
function chatsDir(context) {
    const d = path.join(context.extensionPath, CHATS_DIR);
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { traceErr('mkdir chats', e); }
    return d;
}

function todaysChatLogPath(context) {
    const now = new Date();
    const name = `chat-${now.getMonth() + 1}-${now.getDate()}-${now.getFullYear()}.log`;
    return path.join(chatsDir(context), name);
}

function fmtStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logChatTurn(context, role, text) {
    if (!text) return;
    try {
        const p = todaysChatLogPath(context);
        const r = (role || '').toUpperCase() === 'ASSISTANT' ? 'ASSISTANT' : 'USER';
        const block = `\n## ${r} · ${fmtStamp()}\n${text}\n`;
        fs.appendFileSync(p, block, 'utf8');
    } catch (e) {
        traceErr('logChatTurn', e);
    }
}

async function openChatHistory(context) {
    const dir = chatsDir(context);
    let files = [];
    try {
        files = fs.readdirSync(dir)
            .filter(n => /^chat-\d+-\d+-\d+\.log$/.test(n))
            .map(n => ({
                name: n,
                full: path.join(dir, n),
                mtime: fs.statSync(path.join(dir, n)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
        traceErr('readdir chats', e);
    }
    if (!files.length) {
        vscode.window.showInformationMessage('CBE: no chat logs yet — they appear in chats/ as you send messages.');
        return;
    }
    const items = files.map(f => ({
        label: f.name,
        description: new Date(f.mtime).toLocaleString(),
        full: f.full,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Open chat log',
        placeHolder: 'Pick a daily chat log from /chats',
        ignoreFocusOut: true,
    });
    if (!pick) return;
    try {
        const doc = await vscode.workspace.openTextDocument(pick.full);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
        traceErr('open chat log', e);
        vscode.window.showErrorMessage('CBE: failed to open log: ' + (e.message || e));
    }
}

/* Auto-context — built once per extension activation. Recursive dir tree of
   the currently-set project folder (depth 3, common big folders skipped)
   plus the handbook content, sent as the first user message so the model
   has the project shape + house rules before answering anything. */
let __autoContextSent = false;
const AUTO_CTX_IGNORE = new Set([
    '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
    'dist', 'build', 'out', '.next', '.cache', '.idea', '.vscode',
    'chats', 'target', 'bin', 'obj',
]);
const AUTO_CTX_TREE_DEPTH = 3;
const AUTO_CTX_TREE_BUDGET = 18000; /* chars */
const AUTO_CTX_FILE_LIMIT_PER_DIR = 80; /* don't list more than this per dir */

function buildDirTree(rootPath, maxDepth = AUTO_CTX_TREE_DEPTH) {
    const lines = [];
    let used = 0;
    function over() { return used > AUTO_CTX_TREE_BUDGET; }
    function add(s) { lines.push(s); used += s.length + 1; }
    function walk(p, prefix, depthLeft) {
        if (over()) return;
        let entries;
        try { entries = fs.readdirSync(p, { withFileTypes: true }); }
        catch (e) { add(prefix + '(unreadable)'); return; }
        entries = entries.filter(e => !AUTO_CTX_IGNORE.has(e.name));
        entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        const trimmed = entries.length > AUTO_CTX_FILE_LIMIT_PER_DIR
            ? entries.slice(0, AUTO_CTX_FILE_LIMIT_PER_DIR)
            : entries;
        trimmed.forEach((e, i) => {
            if (over()) return;
            const isLast = i === trimmed.length - 1;
            add(prefix + (isLast ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
            if (e.isDirectory() && depthLeft > 0) {
                walk(path.join(p, e.name), prefix + (isLast ? '    ' : '│   '), depthLeft - 1);
            }
        });
        if (entries.length > AUTO_CTX_FILE_LIMIT_PER_DIR) {
            add(prefix + `… (${entries.length - AUTO_CTX_FILE_LIMIT_PER_DIR} more)`);
        }
    }
    add(path.basename(rootPath) || rootPath);
    walk(rootPath, '', maxDepth);
    if (over()) add('… (tree truncated at ' + AUTO_CTX_TREE_BUDGET + ' chars)');
    return lines.join('\n');
}

function buildAutoContextPrompt(folder, treeText, handbookText) {
    return [
        '[Claude Codex — Black Edition · automatic session context]',
        '',
        `PROJECT DIRECTORY: ${folder}`,
        '',
        'Recursive tree (depth ' + AUTO_CTX_TREE_DEPTH + ', common build/vendor dirs skipped):',
        '',
        '```',
        treeText,
        '```',
        '',
        'EMPLOYEE HANDBOOK (handbook.txt) — house rules, code style, behavior:',
        '',
        '```',
        handbookText,
        '```',
        '',
        '(This message was auto-sent at session start so you have project shape + house rules before the first real question. Ready for instructions.)',
    ].join('\n');
}

async function openPromptsFile(context) {
    const p = promptsFilePath(context);
    /* Seed an empty file with a friendly comment + one example so the user
       has something to start from. */
    if (!fs.existsSync(p)) {
        const seed =
`# Saved prompts — one entry per block, separated by a line that is exactly "---".
# Use Left / Right arrows in the chat input (at start/end of text) to cycle.

Summarize the above in three bullet points.
---
Explain this code to a junior developer. Be specific about side effects.
---
Refactor the selected function for readability without changing behavior.
`;
        try { fs.writeFileSync(p, seed, 'utf8'); } catch (e) { traceErr('seed prompts.txt', e); }
    }
    try {
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
        traceErr('open prompts.txt', e);
        vscode.window.showErrorMessage('CBE: failed to open prompts.txt: ' + (e.message || e));
    }
}

/* ── API key utility / Anthropic SDK client ───────────────────────────── */

async function setApiKey(context) {
    const id = await pickProvider('Which provider needs an API key?');
    if (!id) return;
    const stored = await promptForKey(context, id);
    if (stored) {
        vscode.window.showInformationMessage(`CBE: ${PROVIDERS[id].label} key saved.`);
        if (activePanel) activePanel.webview.postMessage({ type: 'init', ...buildSettingsPayload(context) });
    }
}

async function clearApiKey(context) {
    const id = await pickProvider('Clear API key for which provider?');
    if (!id) return;
    await context.secrets.delete(SECRET_KEY_PREFIX + id + '.apiKey');
    secretsCache[id] = null;
    vscode.window.showInformationMessage(`CBE: ${PROVIDERS[id].label} key cleared.`);
    if (activePanel) activePanel.webview.postMessage({ type: 'init', ...buildSettingsPayload(context) });
}

function getAnthropicClient(apiKey) {
    if (anthropicClient && anthropicClient._cbApiKey === apiKey) return anthropicClient;
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk').Anthropic || require('@anthropic-ai/sdk'); }
    catch (e) { traceErr('@anthropic-ai/sdk require failed', e); throw new Error('Anthropic SDK missing. npm install @anthropic-ai/sdk.'); }
    anthropicClient = new Anthropic({ apiKey });
    anthropicClient._cbApiKey = apiKey;
    return anthropicClient;
}

/* ── Streaming primitives ─────────────────────────────────────────────── */

/* SSE reader for OpenAI-format endpoints (OAI / Grok / Azure).
   Yields delta text strings. Stops on [DONE]. */
/* Streams an OpenAI-compatible chat-completions endpoint.

   Yields:
     - string chunks for normal assistant text (back-compat)
     - one final `{ __toolCalls: [...] }` sentinel if the assistant turn ended
       with `finish_reason: 'tool_calls'`. `toolCalls[]` shape mirrors OpenAI:
       `{ id, type:'function', function:{ name, arguments:<JSON-string> } }`.

   The caller (handleSendText / chatStreamWithTools) inspects each yielded
   value: if it's an object with `__toolCalls`, run the tool-calls loop;
   otherwise treat it as a text delta. The sentinel keeps the generator's
   string-yield contract intact for every existing call site that doesn't pass
   `tools` (Anthropic, Gemini, web bridges, and OAI/Azure without tools). */
async function* streamOpenAIFormat(url, headers, body) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? ': ' + errText.slice(0, 400) : ''}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    /* Tool-call assembly: stream chunks deliver `tool_calls[]` deltas keyed by
       `index`. We accumulate name + arguments (the arguments field is a JSON
       STRING that arrives in fragments) and emit the full array once. */
    const toolCallsByIdx = {};
    let finishReason = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
            const idx = buf.indexOf('\n');
            if (idx === -1) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
                const calls = Object.keys(toolCallsByIdx).sort((a,b)=>(+a)-(+b)).map(k => toolCallsByIdx[k]);
                if (calls.length) yield { __toolCalls: calls, __finishReason: finishReason || 'tool_calls' };
                return;
            }
            try {
                const j = JSON.parse(payload);
                const ch = j.choices && j.choices[0];
                if (!ch) continue;
                if (ch.finish_reason) finishReason = ch.finish_reason;
                const delta = ch.delta || {};
                if (typeof delta.content === 'string' && delta.content) yield delta.content;
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const ix = typeof tc.index === 'number' ? tc.index : 0;
                        const slot = toolCallsByIdx[ix] = toolCallsByIdx[ix] || {
                            id: '', type: 'function', function: { name: '', arguments: '' },
                        };
                        if (tc.id) slot.id = tc.id;
                        if (tc.type) slot.type = tc.type;
                        if (tc.function) {
                            if (tc.function.name) slot.function.name += tc.function.name;
                            if (typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
                        }
                    }
                }
            } catch (e) { /* ignore parse hiccups on partial chunks */ }
        }
    }
    /* Stream ended without explicit [DONE] — still flush any tool-calls. */
    const calls = Object.keys(toolCallsByIdx).sort((a,b)=>(+a)-(+b)).map(k => toolCallsByIdx[k]);
    if (calls.length) yield { __toolCalls: calls, __finishReason: finishReason || 'tool_calls' };
}

/* ── Native API tool-calls (Grok / xAI) ──────────────────────────────────
   These are the OpenAI-compatible function tools we expose to Grok via the
   `tools` request parameter. Distinct from the fenced-code `# !exec` tools
   (parseToolCalls / executeToolCall above), which work for ANY provider by
   pattern-matching the assistant's plain-text output. The native tools below
   only fire when the provider actually emits a structured `tool_calls[]`
   message — currently wired for `grok` in chatStream(). Each tool's schema is
   sent to the model so it knows the function signature. */
const NATIVE_TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Run a shell command on the user\'s Windows machine and return stdout/stderr/exit. Use this to inspect files, run scripts, open apps, or do anything you would normally do at a command prompt. The user must approve every call before it runs.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The command to execute. Runs through cmd.exe /d /c by default.' },
                    shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: 'Optional shell to use. Defaults to cmd.' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a UTF-8 text file from disk and return its contents. Returns at most 50 KB; longer files are truncated with a marker. Use absolute paths.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file.' },
                },
                required: ['path'],
            },
        },
    },
];

/* Execute a native tool call (the OpenAI-compatible `tool_calls[]` shape).
   `tc.function.name` selects the handler; `tc.function.arguments` is a JSON
   string. Returns a plain string ready to be stuffed into a `role:'tool'`
   message's `content` field. */
async function executeNativeToolCall(tc, opts = {}) {
    const name = (tc.function && tc.function.name) || '';
    let args = {};
    try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); }
    catch (e) { return JSON.stringify({ error: 'invalid JSON arguments: ' + (e.message || e), raw: tc.function && tc.function.arguments }); }
    if (name === 'bash') {
        const cmd = String(args.command || '').trim();
        if (!cmd) return JSON.stringify({ error: 'empty command' });
        const shellSel = String(args.shell || 'cmd').toLowerCase();
        const langMap = { cmd: 'cmd', powershell: 'pwsh', pwsh: 'pwsh', bash: 'bash', sh: 'bash' };
        const lang = langMap[shellSel] || 'cmd';
        const r = await executeToolCall({ lang, command: cmd, raw: cmd }, { cwd: opts.cwd, timeoutMs: 30000 });
        return JSON.stringify({
            exit: r.rc, signal: r.signal || null,
            stdout: (r.stdout || '').slice(0, 16000),
            stderr: (r.stderr || '').slice(0, 8000),
            truncated: !!r.truncated, durationMs: r.durationMs,
        });
    }
    if (name === 'read_file') {
        const p = String(args.path || '').trim();
        if (!p) return JSON.stringify({ error: 'empty path' });
        try {
            const stat = fs.statSync(p);
            if (!stat.isFile()) return JSON.stringify({ error: 'not a file', path: p });
            const MAX = 50 * 1024;
            const buf = fs.readFileSync(p);
            const truncated = buf.length > MAX;
            const text = (truncated ? buf.slice(0, MAX) : buf).toString('utf8');
            return JSON.stringify({ path: p, bytes: stat.size, truncated, content: text + (truncated ? '\n…[truncated at 50 KB]' : '') });
        } catch (e) {
            return JSON.stringify({ error: e.message || String(e), path: p });
        }
    }
    return JSON.stringify({ error: 'unknown tool: ' + name });
}

/* ── Tool-approval gate ──────────────────────────────────────────────────
   The panel UI is the source of truth for user consent. We post a
   `toolApprovalRequest` with the call's id + name + args, render Allow/Deny
   buttons inline, and wait (via a per-call Promise) for the matching
   `toolApprovalResponse` that the panel posts back. */
const _pendingToolApprovals = new Map();   /* call_id -> { resolve(approved) } */

function _requestToolApproval(panel, tc) {
    return new Promise((resolve) => {
        const id = tc.id || ('call_' + Math.random().toString(36).slice(2, 10));
        _pendingToolApprovals.set(id, { resolve });
        try {
            panel.webview.postMessage({
                type: 'toolApprovalRequest',
                id,
                name: tc.function && tc.function.name,
                arguments: tc.function && tc.function.arguments,
            });
        } catch (e) {
            _pendingToolApprovals.delete(id);
            resolve(false);
        }
        /* Auto-deny after 5 min to avoid leaking pending promises. */
        setTimeout(() => {
            if (_pendingToolApprovals.has(id)) {
                _pendingToolApprovals.delete(id);
                resolve(false);
            }
        }, 5 * 60 * 1000);
    });
}

function _resolveToolApproval(id, approved) {
    const slot = _pendingToolApprovals.get(id);
    if (!slot) return false;
    _pendingToolApprovals.delete(id);
    slot.resolve(!!approved);
    return true;
}

/* Mirrors triodesktop start.py:_chatAzureDeploymentPrefersResponses (line 9086).
   Azure has split model families across API surfaces: gpt-5.4 / gpt-5.5 / gpt-5-pro
   etc. reject /chat/completions with "The requested operation is unsupported"
   and only serve /openai/v1/responses. Older *-chat deployments still use
   /chat/completions. The TRIO_AZURE_FORCE_RESPONSES env var force-overrides. */
function _azureDeploymentPrefersResponses(deployment) {
    const forced = String(process.env.TRIO_AZURE_FORCE_RESPONSES || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'responses'].includes(forced)) return true;
    if (['0', 'false', 'no', 'off', 'chat', 'completions'].includes(forced)) return false;
    const text = String(deployment || '').trim().toLowerCase().replace(/_/g, '-');
    if (!text) return false;
    if (text.endsWith('-chat') || text.includes('-chat-')) return false;
    if (text.startsWith('gpt-5.4') || text.startsWith('gpt-5.5')) return true;
    return ['gpt-5-pro', 'gpt-5.1', 'gpt-5.1-pro', 'gpt-5.2', 'gpt-5.2-pro'].includes(text);
}

function _azureErrorLooksOperationUnsupported(text) {
    const t = String(text || '').toLowerCase();
    return ['requested operation is unsupported', 'operation is unsupported', 'operationnotsupported',
            'unsupported operation', 'unsupported_value', "unsupported parameter: 'messages'",
            'messages parameter', '/chat/completions'].some(m => t.includes(m));
}

/* Azure /openai/v1/responses streamer. SSE protocol:
     event: response.output_text.delta
     data: { "type":"response.output_text.delta", "delta":"text", ... }
   We only yield the .delta strings. Multi-turn `messages` go straight into the
   `input` field — the Responses API accepts the same {role, content} shape.
   Reasoning models burn output tokens on hidden reasoning before answering, so
   we floor max_output_tokens at 4096. */
async function* streamAzureResponses(endpoint, apiKey, deployment, messages, maxTokens, apiVersion) {
    /* Triodesktop's working _chatAzureExecuteResponsesOnce hits this URL with
       NO api-version query param — adding one returns "API version not
       supported" on cognitiveservices.azure.com endpoints. apiVersion is
       still accepted (kept for forward-compat) but only appended when set. */
    let url = `${String(endpoint).replace(/\/+$/, '')}/openai/v1/responses`;
    if (apiVersion) url += `?api-version=${encodeURIComponent(apiVersion)}`;
    const body = {
        model: deployment,
        input: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        max_output_tokens: Math.max(maxTokens || 4096, 4096),
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? ': ' + errText.slice(0, 400) : ''}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
            const idx = buf.indexOf('\n');
            if (idx === -1) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const j = JSON.parse(payload);
                if (j.type === 'response.output_text.delta' && typeof j.delta === 'string') {
                    yield j.delta;
                } else if (j.type === 'response.completed' || j.type === 'response.failed') {
                    return;
                }
            } catch (e) { /* partial chunk */ }
        }
    }
}

/* Gemini SSE — same protocol shape (data: {...}), different payload structure. */
async function* streamGemini(apiKey, model, messages, maxTokens) {
    /* Convert {role:'user'|'assistant', content} → Gemini's contents[]. */
    const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? ': ' + errText.slice(0, 400) : ''}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
            const idx = buf.indexOf('\n');
            if (idx === -1) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
                const j = JSON.parse(payload);
                const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
                if (parts) for (const p of parts) if (p.text) yield p.text;
            } catch (e) { /* partial */ }
        }
    }
}

/* ── Bridge lifecycle helpers ────────────────────────────────────────────
   ensureBridge(context, target) is the canonical entry point: it resolves
   bin/CBE-Bridge-<Pretty>.exe, TCP-probes its BRIDGE_PORTS port, and spawns
   the tray exe (windowsHide + detached + unref) if no daemon is up. Returns
   { ok, port, pid, reason }. All bridge spawning anywhere in this file
   funnels through here — never spawn a bridge exe directly. */
function _bridgeExePath(extPath, target) {
    const name = BRIDGE_EXE_NAME[target];
    if (!name) return null;
    /* Canonical location is bin/ next to extension.js. bridges_cpp/ holds
       sources only — exes were moved out per the build_bridges.ps1 layout. */
    return path.join(extPath, 'bin', name);
}

/* TCP-probe a port — resolves true if something is listening, false on
   refused/timeout. Used to detect a running bridge (or Ollama daemon). */
function _probeTcpPort(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const net = require('net');
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (_) {}
            resolve(ok);
        };
        sock.setTimeout(timeoutMs || 700);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error',   () => finish(false));
        try { sock.connect(port, host || '127.0.0.1'); } catch (_) { finish(false); }
    });
}

/* Spawn a bridge exe detached + hidden. Tracks it in _runningBridges so we
   don't double-spawn. Returns the child handle (already unref'd).

   This launches the native C++ tray exe at bin/CBE-Bridge-<Target>.exe — the
   ONLY thing that knows how to drive the logged-in browser session (via
   bridge_pilot.py + the minicomputer chrome it supervises) for cloud
   providers, and the only thing that talks to the local Ollama daemon for
   the Ollama target. (Earlier code launched smart_bridge.py instead — a
   REST-API client that has no public route for Copilot, no browser session
   for the others, and a different on-the-wire shape than what the JS chat
   path posts. That was the routing-bug being fixed here.)

   The tray exe takes its TCP port as its first command-line argument. */
function _spawnBridge(target, exePath) {
    const cp = require('child_process');
    const port = BRIDGE_PORTS[target];
    const child = cp.spawn(exePath, [String(port)], {
        cwd: path.dirname(exePath),
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
    });
    child.on('error', (e) => trace(`BRIDGE:SPAWN error target=${target} ${e && e.message}`));
    child.on('exit', (code, signal) => {
        trace(`BRIDGE:EXIT target=${target} code=${code} signal=${signal || 'none'}`);
        _runningBridges.delete(target);
    });
    child.unref();
    _runningBridges.set(target, { pid: child.pid, startedAt: Date.now() });
    return child;
}

/* Wait up to timeoutMs for `port` to become reachable. Polls every 250ms. */
async function _waitForPort(host, port, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
        if (await _probeTcpPort(host, port, 400)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

/* Kill every CBE-Bridge-*.exe whose target is NOT `keepTarget`. Single-bridge
   invariant: only the currently-selected provider's tray stays alive. Without
   this, every Settings → provider switch leaves the old bridge tray running,
   so after N switches the user has N trays piled up. Treat "process not
   found" (no instance running) as a non-event — don't log it as an error. */
function killOtherBridgeTrays(keepTarget) {
    const keepExe = (BRIDGE_EXE_NAME[keepTarget] || '').toLowerCase();
    const { execFile } = require('child_process');
    for (const target of Object.keys(BRIDGE_EXE_NAME)) {
        if (target === keepTarget) continue;
        const exe = BRIDGE_EXE_NAME[target];
        if (!exe || exe.toLowerCase() === keepExe) continue;
        try {
            execFile('taskkill', ['/F', '/IM', exe], { windowsHide: true }, (err) => {
                if (err) {
                    const msg = String((err && err.message) || err);
                    /* taskkill returns non-zero when no matching process exists.
                       That's the common case (most bridges aren't running), so
                       silence it. Only log surprise failures. */
                    if (!/not found|there is no running|not running/i.test(msg)) {
                        trace(`BRIDGE:KILL ${exe} err=${msg.trim()}`);
                    }
                } else {
                    trace(`BRIDGE:KILL ${exe} ok`);
                    /* Drop any stale book-keeping for the killed target. */
                    _runningBridges.delete(target);
                }
            });
        } catch (e) {
            /* synchronous throw from execFile is rare (bad args); log + continue */
            trace(`BRIDGE:KILL ${exe} threw ${e && e.message}`);
        }
    }
}

/* Ensure the tray-exe bridge for `target` is running. If not, spawn it +
   wait for its TCP port. Returns { ok, port, pid?, reason? }. Idempotent —
   safe to call from activate(), setProvider, and the chat dispatch path. */
async function ensureBridge(context, target, opts) {
    opts = opts || {};
    const port = BRIDGE_PORTS[target];
    if (!port) return { ok: false, reason: `unknown bridge target: ${target}` };
    /* 1. Already responding? Done. */
    if (await _probeTcpPort('127.0.0.1', port, 500)) {
        return { ok: true, port, alreadyRunning: true };
    }
    /* 2. Find the exe. */
    const exePath = _bridgeExePath(context.extensionPath, target);
    if (!exePath || !fs.existsSync(exePath)) {
        const msg = `bridge exe missing: bin/${BRIDGE_EXE_NAME[target] || target}`;
        trace(`BRIDGE:MISSING target=${target} expected=${exePath}`);
        return { ok: false, reason: msg, exeMissing: true };
    }
    /* 3. Spawn + wait. */
    trace(`BRIDGE:SPAWN target=${target} exe=${exePath} port=${port}`);
    const child = _spawnBridge(target, exePath);
    const ok = await _waitForPort('127.0.0.1', port, opts.timeoutMs || 8000);
    if (!ok) {
        trace(`BRIDGE:TIMEOUT target=${target} port=${port} pid=${child && child.pid} — exe spawned but never bound`);
        return { ok: false, port, pid: child && child.pid, reason: `bridge ${target} spawned (pid ${child && child.pid}) but did not bind port ${port} within ${opts.timeoutMs || 8000}ms` };
    }
    trace(`BRIDGE:READY target=${target} port=${port} pid=${child && child.pid}`);
    return { ok: true, port, pid: child && child.pid, spawned: true };
}

/* ── Ollama lifecycle ────────────────────────────────────────────────────
   Discovery cascade → daemon-start → install fallback. Wired into the
   provider switch + chat path so picking "ollamaBridge" or "ollama"
   provider auto-resolves the local daemon without user intervention. */
const OLLAMA_PORT = 11434;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PATHS = [
    path.join(process.env.LOCALAPPDATA || (os.homedir() + '\\AppData\\Local'), 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
];
let _ollamaInstallInProgress = false;
let _ollamaDaemonChild = null;

function _resolveOllamaExe() {
    /* PATH lookup first — `where ollama.exe`. Synchronous, cheap. */
    try {
        const cp = require('child_process');
        const out = cp.execFileSync('where', ['ollama.exe'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
        const first = (out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        if (first && fs.existsSync(first)) return first;
    } catch (_) { /* not on PATH */ }
    for (const p of OLLAMA_PATHS) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

/* GET http://127.0.0.1:11434/api/tags. Resolves { ok, models: [...] } or
   { ok:false }. No throw — caller branches on .ok. */
function _probeOllamaDaemon(timeoutMs) {
    return new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
            host: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/tags',
            method: 'GET',
            timeout: timeoutMs || 1200,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    const models = Array.isArray(j.models) ? j.models : [];
                    resolve({ ok: true, models: models.map(m => m.name || m.model).filter(Boolean) });
                } catch (e) {
                    resolve({ ok: true, models: [] });
                }
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false }); });
        req.end();
    });
}

/* Start `ollama serve` detached. Returns child or null if spawn failed. */
function _startOllamaDaemon(exePath) {
    if (_ollamaDaemonChild) return _ollamaDaemonChild;
    try {
        const cp = require('child_process');
        const child = cp.spawn(exePath, ['serve'], {
            cwd: path.dirname(exePath),
            stdio: 'ignore',
            windowsHide: true,
            detached: true,
            env: process.env,
        });
        child.on('exit', (code, signal) => {
            trace(`OLLAMA:DAEMON exit code=${code} signal=${signal || 'none'}`);
            _ollamaDaemonChild = null;
        });
        child.unref();
        _ollamaDaemonChild = child;
        trace(`OLLAMA:DAEMON spawned pid=${child.pid} exe=${exePath}`);
        return child;
    } catch (e) {
        traceErr('OLLAMA:DAEMON spawn', e);
        return null;
    }
}

/* Discovery → daemon-start state machine. Returns one of:
     { state:'ready',      models:[...] }
     { state:'missing'                    }   – binary not on disk
     { state:'daemonFailed', exe:'…'      }   – binary present, /api/tags timed out
   Idempotent + cheap if daemon already responds. */
async function ensureOllamaReady(opts) {
    opts = opts || {};
    /* 1. Already up? */
    const first = await _probeOllamaDaemon(800);
    if (first.ok) return { state: 'ready', models: first.models };
    /* 2. Find binary. */
    const exe = _resolveOllamaExe();
    if (!exe) return { state: 'missing' };
    /* 3. Spawn daemon + wait up to 8s. */
    trace(`OLLAMA:STARTING daemon via ${exe}`);
    _startOllamaDaemon(exe);
    const deadline = Date.now() + (opts.timeoutMs || 8000);
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));
        const probe = await _probeOllamaDaemon(800);
        if (probe.ok) return { state: 'ready', models: probe.models, exe };
    }
    return { state: 'daemonFailed', exe };
}

/* Install Ollama silently via PowerShell. Downloads the installer to
   %TEMP%\OllamaSetup.exe, then Start-Process -Wait with Inno-Setup
   silent flags. Progress is reported via the onProgress callback as
   strings ("Downloading…" / "Installing…" / "Starting daemon…"). */
async function installOllama(onProgress) {
    if (_ollamaInstallInProgress) {
        if (onProgress) onProgress('Install already in progress…');
        return { ok: false, reason: 'already in progress' };
    }
    _ollamaInstallInProgress = true;
    try {
        const cp = require('child_process');
        const tmp = path.join(os.tmpdir(), 'OllamaSetup.exe');
        const url = 'https://ollama.com/download/OllamaSetup.exe';
        const psDownload = [
            '$ProgressPreference="SilentlyContinue";',
            '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;',
            `Invoke-WebRequest -Uri '${url}' -OutFile '${tmp}' -UseBasicParsing;`,
            `if (-not (Test-Path '${tmp}')) { exit 5 }`,
            `if ((Get-Item '${tmp}').Length -lt 1000000) { exit 6 }`,
            'exit 0',
        ].join(' ');
        if (onProgress) onProgress('Downloading Ollama installer…');
        trace(`OLLAMA:INSTALL download → ${tmp}`);
        await new Promise((resolve, reject) => {
            const p = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psDownload], {
                windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let err = '';
            p.stderr.on('data', (c) => { err += c.toString('utf8'); });
            p.on('error', reject);
            p.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`installer download failed (exit ${code}): ${err.slice(0, 400)}`));
            });
        });
        if (onProgress) onProgress('Installing Ollama (silent)…');
        trace(`OLLAMA:INSTALL run silent installer ${tmp}`);
        await new Promise((resolve, reject) => {
            const psRun = `Start-Process -FilePath '${tmp}' -ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait`;
            const p = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psRun], {
                windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let err = '';
            p.stderr.on('data', (c) => { err += c.toString('utf8'); });
            p.on('error', reject);
            p.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`silent install exited ${code}: ${err.slice(0, 400)}`));
            });
        });
        if (onProgress) onProgress('Starting Ollama daemon…');
        const ready = await ensureOllamaReady({ timeoutMs: 10000 });
        if (ready.state === 'ready') {
            if (onProgress) onProgress(`Ollama ready (${ready.models.length} model${ready.models.length === 1 ? '' : 's'})`);
            return { ok: true, models: ready.models };
        }
        return { ok: false, reason: `installed but daemon didn't start: state=${ready.state}` };
    } catch (e) {
        traceErr('OLLAMA:INSTALL', e);
        return { ok: false, reason: e && e.message || String(e) };
    } finally {
        _ollamaInstallInProgress = false;
    }
}

/* Spawn `ollama pull <name>` and stream stdout/stderr lines via onLine.
   Resolves { ok, code } when the child exits. */
function pullOllamaModel(modelName, onLine) {
    return new Promise((resolve) => {
        const exe = _resolveOllamaExe();
        if (!exe) {
            if (onLine) onLine('ollama binary not found — install it first');
            resolve({ ok: false, reason: 'no-exe' });
            return;
        }
        const cp = require('child_process');
        const child = cp.spawn(exe, ['pull', modelName], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const onChunk = (c) => {
            const s = c.toString('utf8');
            for (const ln of s.split(/\r?\n/)) {
                const t = ln.trim();
                if (t && onLine) onLine(t);
            }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('error', (e) => { if (onLine) onLine('error: ' + e.message); resolve({ ok: false, reason: e.message }); });
        child.on('exit', (code) => resolve({ ok: code === 0, code }));
    });
}

/* ── Native C++ bridge chat (via start.py --chat CLI) ────────────────────
   Delegates to `python start.py --chat <target> "<message>"`. That CLI is
   the single source of truth for everything bridge-related:
     • per-target port resolution from BRIDGE_PORTS + [bridge] config.ini
     • bridge-running probe with the "no bridge running" hint
     • async jobId polling + progress traces
     • 240 s default timeout (--chat-timeout)
     • stale LISTEN-socket diagnostics
     • logged-out detection
   We pass --no-auto-login because CBE is non-interactive — if the session
   has logged out, surface the error rather than popping a Qt window. On
   success the CLI prints the answer to stdout; on failure it writes a
   JSON error blob to stderr and exits non-zero. */
async function* streamBridge(context, providerId, messages, onProgress) {
    const { spawn } = require('child_process');
    const provider = PROVIDERS[providerId];
    if (!provider || !provider.bridge) throw new Error('not a bridge provider: ' + providerId);
    const target = provider.bridgeTarget;

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const message = (lastUser && lastUser.content) || '';
    if (!message) throw new Error('no user message to send');

    if (onProgress) onProgress(`bridge → ${target}`);

    /* AUTO-START the tray bridge BEFORE invoking start.py --chat. Without
       this, --chat exits 2 ("bridge ${target} not running") whenever the
       user hasn't manually picked the provider in Settings yet. ensureBridge
       is idempotent — if the daemon is already up, this is one TCP probe.
       If the exe is missing on disk, surface that as a clean error instead
       of letting --chat exit 2 with the stale "pick the provider" hint. */
    try {
        const bridge = await ensureBridge(context, target, { timeoutMs: 8000 });
        if (!bridge.ok) {
            if (bridge.exeMissing) {
                throw new Error(`bridge ${target} exe missing: bin/${BRIDGE_EXE_NAME[target] || target}. Build it from bridges_cpp/ via build_bridges.ps1.`);
            }
            /* spawned but never bound — fall through to start.py and let it
               do its own LISTEN-socket diagnostics. */
            if (onProgress) onProgress(`bridge ${target} spawning…`);
        } else if (bridge.spawned) {
            if (onProgress) onProgress(`bridge ${target} started (pid ${bridge.pid})`);
        }
    } catch (e) {
        throw e;
    }

    const answer = await new Promise((resolve, reject) => {
        /* Speak the C++ tray exe's newline-delimited JSON protocol directly.
           The exe's handleConnection() (bridge_server.cpp) sniffs the first
           byte: '{' selects the SuperGrok line protocol; anything else falls
           into the HTTP/1.1 status-ping path (which has no chat route — that
           was the routing bug being fixed here).

           Wire shape:
             out: {"action":"chat","target":"<t>","message":"<text>","model":"<m>"}\n
             in : {"ok":true,"accepted":false,"target":"<t>","port":<p>,
                   "model":"<m>","answer":"<text>","server":"CBE-Bridge-<T>/1.0"}\n
           The exe dispatches internally to bridge_chat.py (Ollama) or
           bridge_pilot.py (browser targets) and returns the final answer
           synchronously — no jobId/polling needed. */
        const net  = require('net');
        const port = BRIDGE_PORTS[target];
        const payload = JSON.stringify({
            action:  'chat',
            target:  target,
            message: message,
            model:   provider.defaultModel,
        }) + '\n';
        const sock = new net.Socket();
        let body = '';
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch (_) {}
            reject(err);
        };
        sock.setTimeout(240000);
        sock.on('connect', () => { sock.write(payload); });
        sock.on('data', (c) => { body += c.toString('utf8'); });
        sock.on('end', () => {
            if (settled) return;
            const line = body.split('\n').find(s => s.trim().length > 0) || '';
            let data = null;
            try { data = JSON.parse(line); } catch (_) { /* fall through */ }
            if (data && data.ok && typeof data.answer === 'string') {
                settled = true;
                resolve(data.answer);
            } else {
                const detail = (data && (data.error || data.err)) || line.slice(0, 300) || '(empty response)';
                fail(new Error(`bridge ${target} chat failed: ${detail}`));
            }
        });
        sock.on('timeout', () => fail(new Error(`bridge ${target} chat timed out after 240s`)));
        sock.on('error', (e) => fail(new Error(
            `bridge ${target} not reachable on port ${port} — ${e.message}. `
            + `CBE auto-starts CBE-Bridge-${target}.exe; check bin/ for the exe and `
            + `netstat -ano | findstr ${port}.`)));
        try { sock.connect(port, '127.0.0.1'); } catch (e) { fail(e); }
    });
    if (answer) yield answer;
}

/* Translate the OpenAI-shape conversation into Anthropic's messages/system
   format. Conversation is stored canonically in OpenAI shape (role:'user' |
   'assistant' | 'tool' | 'system'; assistant may carry tool_calls[]; tool
   carries tool_call_id). Anthropic wants:
     - system as a separate top-level field
     - assistant tool calls as content blocks {type:'tool_use', id, name, input}
     - tool results as content blocks {type:'tool_result', tool_use_id, content}
       inside a USER message (consecutive tool results merge into one msg). */
function _messagesToAnthropic(openAiMessages) {
    const out = [];
    let system = '';
    for (const m of openAiMessages) {
        if (m.role === 'system') {
            system += (system ? '\n\n' : '') + (m.content || '');
            continue;
        }
        if (m.role === 'tool') {
            const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') };
            const last = out[out.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                out.push({ role: 'user', content: [block] });
            }
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: String(m.content) });
            for (const tc of m.tool_calls) {
                let inp = {};
                try { inp = JSON.parse((tc.function && tc.function.arguments) || '{}'); }
                catch (e) { inp = { __raw_arguments: tc.function && tc.function.arguments }; }
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input: inp });
            }
            out.push({ role: 'assistant', content: blocks });
            continue;
        }
        out.push({ role: m.role, content: m.content || '' });
    }
    return { system, messages: out };
}

/* OpenAI-shape NATIVE_TOOL_SCHEMAS → Anthropic tool definitions. Anthropic
   uses `input_schema` instead of `parameters` and drops the {type:'function'}
   wrapper — name/description/input_schema sit at the top level. */
function _toolsToAnthropic(schemas) {
    return (schemas || []).map(t => ({
        name: t.function && t.function.name,
        description: t.function && t.function.description,
        input_schema: t.function && t.function.parameters,
    }));
}

/* Anthropic via SDK — wrap stream events as async generator. When `tools` is
   provided, we also tail the stream's finalMessage() for tool_use content
   blocks and yield them as a `__toolCalls` sentinel in the same OpenAI shape
   that streamOpenAIFormat emits, so handleSendText's existing daisy-chain
   branch handles them without provider-specific code. */
async function* streamAnthropic(apiKey, model, messages, maxTokens, tools) {
    const client = getAnthropicClient(apiKey);
    const { system, messages: anthMsgs } = _messagesToAnthropic(messages);
    const req = { model, max_tokens: maxTokens, messages: anthMsgs };
    if (system) req.system = system;
    if (tools && tools.length) req.tools = _toolsToAnthropic(tools);
    const stream = await client.messages.stream(req);
    const queue = [];
    let finished = false;
    let pendingResolve = null;
    stream.on('text', t => { queue.push(t); if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); } });
    stream.on('end', () => { finished = true; if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); } });
    stream.on('error', err => { finished = true; queue.push({ __err: err }); if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); } });
    while (true) {
        if (queue.length) {
            const v = queue.shift();
            if (v && v.__err) throw v.__err;
            yield v;
        } else if (finished) {
            break;
        } else {
            await new Promise(r => { pendingResolve = r; });
        }
    }
    /* Stream ended — collect tool_use blocks if the model wants to call a tool.
       finalMessage() resolves to the assembled Message; stop_reason 'tool_use'
       means the next turn must carry tool_result blocks. */
    try {
        const final = await stream.finalMessage();
        if (final && final.stop_reason === 'tool_use' && Array.isArray(final.content)) {
            const toolCalls = [];
            for (const block of final.content) {
                if (block && block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
                    });
                }
            }
            if (toolCalls.length) yield { __toolCalls: toolCalls, __finishReason: 'tool_use' };
        }
    } catch (e) {
        traceErr('streamAnthropic finalMessage', e);
    }
}

/* Dispatch by provider id. Returns async iterator yielding text chunks.
   `onProgress(step)` (optional) receives human-readable status strings for
   slow providers so the panel can show progress. */
async function* chatStream(context, providerId, model, messages, maxTokens, onProgress) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const provider = PROVIDERS[providerId];

    if (provider && provider.bridge) {
        yield* streamBridge(context, providerId, messages, onProgress);
        return;
    }

    const key = getProviderKey(context, providerId);
    if (!key) throw new Error(`No API key for ${providerId}. Run "Claude Codex Black: Set API Key" or add it to config.ini under [api_keys] (or [azure]).`);

    if (providerId === 'anthropic') {
        yield* streamAnthropic(key, model, messages, maxTokens, NATIVE_TOOL_SCHEMAS);
        return;
    }
    if (providerId === 'gemini') {
        yield* streamGemini(key, model, messages, maxTokens);
        return;
    }
    /* OpenAI-compatible: OAI, Grok, Azure. OAI's modern chat models (o-series + gpt-4o
       family) require `max_completion_tokens`; the deprecated `max_tokens` 400s on o-series.
       Grok (xAI) mimics the older OpenAI shape and uses `max_tokens`. Azure varies by
       deployment but `max_tokens` is the safer default across api-versions. */
    let url, headers;
    const body = { model, messages, stream: true };
    /* Native tool-calls wiring: ALL three OpenAI-compatible providers
       (openai / grok / deepseek) get the same NATIVE_TOOL_SCHEMAS so the
       model can emit structured `tool_calls[]` messages instead of (or in
       addition to) the # !exec fenced-code pattern. handleSendText() picks
       up the streamOpenAIFormat sentinel and runs the daisy-chain loop:
       executeNativeToolCall → push role:'tool' message → re-stream. */
    if (providerId === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        body.max_completion_tokens = maxTokens;
        body.tools = NATIVE_TOOL_SCHEMAS;
        body.tool_choice = 'auto';
    } else if (providerId === 'grok') {
        url = 'https://api.x.ai/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        body.max_tokens = maxTokens;
        body.tools = NATIVE_TOOL_SCHEMAS;
        body.tool_choice = 'auto';
    } else if (providerId === 'deepseek') {
        /* DeepSeek ships an OpenAI-compatible chat-completions endpoint, so
           streamOpenAIFormat handles it unchanged. deepseek-chat = V3,
           deepseek-reasoner = R1. Bearer auth, same as OpenAI/xAI. */
        url = 'https://api.deepseek.com/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        body.max_tokens = maxTokens;
        body.tools = NATIVE_TOOL_SCHEMAS;
        body.tool_choice = 'auto';
    } else if (providerId === 'azure') {
        const endpoint = (cfg.azure && cfg.azure.endpoint || '').replace(/\/+$/, '');
        if (!endpoint) throw new Error('Azure endpoint missing in config.ini [azure] section.');
        if (!model) throw new Error('Azure deployment_name missing.');
        /* Two API surfaces, picked by deployment family (mirrors triodesktop's
           _chatAzureDeploymentPrefersResponses): gpt-5.4 / gpt-5.5 / gpt-5-pro
           etc. only serve /openai/v1/responses; everything else uses the
           legacy /openai/deployments/<name>/chat/completions path. If /chat
           returns "operation unsupported" we fall back to /responses, since
           Azure occasionally re-routes deployments without warning. */
        const apiVersion = (cfg.azure && cfg.azure.api_version) || '2025-01-01-preview';
        if (_azureDeploymentPrefersResponses(model)) {
            /* Responses endpoint takes NO api-version on this resource; pass empty. */
            trace(`AZURE:CHAT route=responses deployment=${model}`);
            yield* streamAzureResponses(endpoint, key, model, messages, maxTokens, '');
            return;
        }
        url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
        headers = { 'Content-Type': 'application/json', 'api-key': key };
        delete body.model; /* Azure uses deployment in URL */
        const lower = String(model || '').toLowerCase();
        if (lower.startsWith('gpt-5') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
            body.max_completion_tokens = maxTokens;
        } else {
            body.max_tokens = maxTokens;
        }
        trace(`AZURE:CHAT route=chat-completions deployment=${model} apiVersion=${apiVersion}`);
        try {
            yield* streamOpenAIFormat(url, headers, body);
        } catch (e) {
            if (_azureErrorLooksOperationUnsupported(e && e.message)) {
                trace(`AZURE:CHAT fallback chat→responses deployment=${model} reason=${String(e && e.message || '').slice(0, 200)}`);
                yield* streamAzureResponses(endpoint, key, model, messages, maxTokens, '');
                return;
            }
            throw e;
        }
        return;
    } else {
        throw new Error('Unknown provider: ' + providerId);
    }
    yield* streamOpenAIFormat(url, headers, body);
}

/* ── Chat dispatch ────────────────────────────────────────────────────── */

/* Classify a thrown stream error as a rate-limit / weekly-cap hit. The
   fetch-based streamers throw `HTTP 429 ...`; the Anthropic SDK throws an
   error carrying .status === 429. We also pattern-match the error vocabulary
   ("rate limit", "weekly limit", "usage limit", "quota") because some
   providers wrap 429s in a 200 SSE error frame or a 400 with that text.
   Returns { isRateLimit, weekly, disableMs } — disableMs is parsed from a
   Retry-After-style hint when present (NaN otherwise). */
function classifyRateLimit(err) {
    const msg = String((err && err.message) || err || '');
    const status = err && (err.status || err.statusCode);
    const is429 = status === 429 || /HTTP\s+429\b/i.test(msg) || /\b429\b/.test(msg);
    const vocab =
        /rate[_\s-]?limit/i.test(msg) ||
        /\bweekly\b/i.test(msg) ||
        /usage limit/i.test(msg) ||
        /\bquota\b/i.test(msg) ||
        /too many requests/i.test(msg) ||
        /\boverloaded\b/i.test(msg) ||
        /\binsufficient_quota\b/i.test(msg);
    const isRateLimit = is429 || vocab;
    const weekly = /\bweek/i.test(msg);  /* "weekly limit", "this week" */
    /* Retry-After can be seconds or an explicit header echoed in the body. */
    let disableMs = NaN;
    const retryHeaderObj = err && err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
    const m = String(retryHeaderObj || '').match(/^(\d+)/) || msg.match(/retry[-\s]?after[":=\s]+(\d+)/i);
    if (m) {
        const secs = parseInt(m[1], 10);
        if (Number.isFinite(secs) && secs > 0) disableMs = secs * 1000;
    }
    return { isRateLimit, weekly, disableMs };
}

async function handleSendText(context, panel, text) {
    /* Capture retry markers off the (possibly boxed-String) argument BEFORE
       trimming coerces it to a primitive and drops them. __cbeRotateCount
       counts rate-limit rotations this turn; __cbeAuthRetry guards the
       single auth-key retry. */
    const _rotateCount = (text && typeof text === 'object' && Number(text.__cbeRotateCount)) || 0;
    const _authRetried = !!(text && typeof text === 'object' && text.__cbeAuthRetry);
    text = (text || '').trim();
    if (!text) return;

    const providerId = getActiveProvider(context);
    const model = getActiveModel(context, providerId);
    const maxTokens = getMaxTokens();

    /* If no key for this provider, prompt up-front and store it. Native
       bridge providers skip this — they authenticate via the tray exe's
       QtWebEngine profile (or local ollama daemon), not an API key. */
    const _pInfo = PROVIDERS[providerId] || {};
    if (!_pInfo.bridge && !getProviderKey(context, providerId)) {
        const got = await promptForKey(context, providerId);
        if (!got) {
            panel.webview.postMessage({ type: 'error', message: `${providerId}: API key required to send.` });
            return;
        }
        panel.webview.postMessage({ type: 'info', text: `${PROVIDERS[providerId].label} key stored.` });
    }

    conversation.push({ role: 'user', content: text });

    /* Stamp the active account's lastUsedAt so the Accounts UI shows which
       account is doing the work. Fire-and-forget; never blocks the send. */
    touchActiveAccount(context, providerId);

    setStatus('streaming', true, providerId);
    panel.webview.postMessage({ type: 'assistantStart' });
    trace(`stream start provider=${providerId} model=${model} maxTokens=${maxTokens} historyLen=${conversation.length}`);

    const t0 = Date.now();
    let toolIterations = 0;
    const MAX_TOOL_ITERATIONS = 8;
    try {
        /* Outer loop: stream the model, then look for tool calls in its reply.
           If found, execute them, append the tool result as a NEW user turn,
           and stream again. The loop exits when the model emits a turn with
           no executable blocks, or we hit MAX_TOOL_ITERATIONS as a safety. */
        for (;;) {
            let assembled = '';
            /* nativeToolCalls collects the {__toolCalls, __finishReason}
               sentinel that streamOpenAIFormat yields when the model emits a
               structured tool_calls[] turn instead of (or alongside) text.
               We DON'T string-coerce this object into `assembled` — that's
               what was destroying the data before. Captured here, then
               executed after the stream loop ends. */
            let nativeToolCalls = null;
            /* onProgress surfaces slow-bridge cold-start steps as transient
               status lines so a slow bridge doesn't look hung. */
            const onProgress = (step) => {
                panel.webview.postMessage({ type: 'status', text: step });
            };
            /* Reset the stop-button flag before each new stream so a click that
               cancelled the prior turn doesn't leak into this one. The
               'cancelInFlight' case in the dispatcher flips this to true; we
               check it each delta and bail with a clean assistantDone. */
            panel.__cbeCancel = false;
            for await (const delta of chatStream(context, providerId, model, conversation, maxTokens, onProgress)) {
                if (panel.__cbeCancel) {
                    panel.webview.postMessage({ type: 'assistantDone', text: assembled });
                    try { setStatus('idle', false, providerId); } catch (_) {}
                    return;
                }
                if (delta && typeof delta === 'object' && Array.isArray(delta.__toolCalls)) {
                    nativeToolCalls = delta.__toolCalls;
                    continue;
                }
                assembled += delta;
                panel.webview.postMessage({ type: 'chunk', text: delta });
            }
            trace(`stream done provider=${providerId} chars=${assembled.length} ms=${Date.now() - t0} toolIter=${toolIterations} nativeToolCalls=${nativeToolCalls ? nativeToolCalls.length : 0}`);

            /* Native OpenAI/Grok/DeepSeek tool-calls daisy-chain. When the
               model emitted a structured tool_calls[] turn, the assistant
               message we push must carry the SAME tool_calls array — the
               API enforces that role:'tool' result messages cite a
               tool_call_id that appears in the immediately-preceding
               assistant turn. Otherwise the model 400s. */
            if (nativeToolCalls && nativeToolCalls.length && toolIterations < MAX_TOOL_ITERATIONS) {
                toolIterations++;
                conversation.push({
                    role: 'assistant',
                    content: assembled || null,
                    tool_calls: nativeToolCalls,
                });
                const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || os.homedir();
                for (const tc of nativeToolCalls) {
                    const fname = (tc.function && tc.function.name) || '(unknown)';
                    panel.webview.postMessage({ type: 'info', text: `▶ native-tool ${fname}` });
                    let resultStr;
                    try {
                        resultStr = await executeNativeToolCall(tc, { cwd: projectFolder });
                    } catch (e) {
                        resultStr = `[executeNativeToolCall error: ${(e && e.message) || e}]`;
                    }
                    panel.webview.postMessage({ type: 'info', text: `◀ native-tool ${fname} done (${(resultStr || '').length}B)` });
                    conversation.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: String(resultStr || ''),
                    });
                }
                panel.webview.postMessage({ type: 'assistantDone', text: assembled });
                panel.webview.postMessage({ type: 'assistantStart' });
                continue;
            }

            conversation.push({ role: 'assistant', content: assembled });

            const calls = parseToolCalls(assembled);
            if (!calls.length || toolIterations >= MAX_TOOL_ITERATIONS) {
                if (calls.length) {
                    panel.webview.postMessage({ type: 'info', text: `Tool-call iteration cap (${MAX_TOOL_ITERATIONS}) reached — not executing further.` });
                }
                panel.webview.postMessage({ type: 'assistantDone', text: assembled });
                _postContextUsage(panel, context);
                setStatus('idle', false, providerId);
                break;
            }
            toolIterations++;
            const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || os.homedir();
            const resultParts = [];
            for (const call of calls) {
                panel.webview.postMessage({ type: 'info', text: `▶ exec [${call.lang}] ${call.command.split(/\r?\n/)[0].slice(0, 100)}${call.command.length > 100 ? '…' : ''}` });
                const r = await executeToolCall(call, { cwd: projectFolder });
                resultParts.push(formatToolResult(call, r));
                panel.webview.postMessage({ type: 'info', text: `◀ rc=${r.rc} stdout=${r.stdout.length}B stderr=${r.stderr.length}B in ${r.durationMs}ms` });
            }
            /* Tool result goes back as a synthetic user turn — same shape the
               model emitted, so it can read its own output. */
            const toolReply = resultParts.join('\n\n');
            conversation.push({ role: 'user', content: toolReply });
            /* For web-bridge providers, the bridge page already saw the
               assistant reply; we need to type the tool result so the bridge
               picks it up as a fresh user turn on its next stream. */
            panel.webview.postMessage({ type: 'assistantDone', text: assembled });
            panel.webview.postMessage({ type: 'assistantStart' });
        }
    } catch (e) {
        traceErr(`stream failed (provider=${providerId})`, e);
        /* Auth-failure detector. The streamX functions throw errors of the
           shape `HTTP <status> <statusText>: <body excerpt>`. We pattern-match
           on the status + provider error vocabulary to decide whether to pop
           an API-key modal and retry — the user just has to paste a fresh
           key instead of digging through config.ini or running a CLI.
           Native bridge providers (chatgpt/grok/copilot/gemini/claude/
           ollama via the tray exes) skip this — their failures aren't
           API-key related. */
        const msg = String(e && e.message || e || '');
        const _info = PROVIDERS[providerId] || {};
        /* ── Rate-limit auto-rotation (the multi-account key feature) ──────
           When the active account hits its weekly cap / 429, disable it
           until its reset, advance to the next non-disabled account, and
           retry transparently. Bridge providers don't have API keys, so
           they skip this. We bound rotations with __cbeRotateCount so a
           run of all-limited accounts can't loop forever. */
        const rl = !_info.bridge ? classifyRateLimit(e) : { isRateLimit: false };
        const rotateCount = _rotateCount;
        if (rl.isRateLimit && rotateCount < 12) {
            const accounts = getProviderAccounts(context, providerId);
            if (accounts.length >= 1) {
                const res = await rotateOnRateLimit(context, providerId, {
                    weekly: rl.weekly,
                    disableMs: rl.disableMs,
                });
                /* Refresh the panel's account/provider state either way. */
                if (activePanel) activePanel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, providerId) });
                if (res.rotated) {
                    const fromLabel = res.from ? res.from.label : '(unknown)';
                    panel.webview.postMessage({ type: 'info', text: `Account ${fromLabel} hit its limit — switched to ${res.to.label}` });
                    panel.webview.postMessage({ type: 'accountToast', from: fromLabel, to: res.to.label });
                    /* Pop the user turn we appended so the retry doesn't double it. */
                    if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') conversation.pop();
                    /* Pass a boxed String so the rotation-count marker survives
                       into the recursive call (a primitive can't carry props). */
                    const retryText = new String(text);
                    retryText.__cbeRotateCount = rotateCount + 1;
                    if (_authRetried) retryText.__cbeAuthRetry = true;
                    return handleSendText(context, panel, retryText);
                }
                /* No account left — surface the soonest reset and stop. */
                const when = res.soonest ? new Date(res.soonest).toLocaleString() : 'unknown';
                panel.webview.postMessage({ type: 'error', message: `All ${PROVIDERS[providerId].label} accounts are rate-limited. Soonest reset: ${when}. Add another account or wait.` });
                setStatus('error', false, providerId);
                if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') conversation.pop();
                return;
            }
        }
        const looksLikeAuthErr = !_info.bridge && (
            /HTTP\s+401\b/i.test(msg) ||
            /HTTP\s+403\b/i.test(msg) ||
            /\binvalid_api_key\b/i.test(msg) ||
            /\bauthentication_error\b/i.test(msg) ||
            /\binvalid x-api-key\b/i.test(msg) ||
            /\bUNAUTHENTICATED\b/.test(msg) ||
            /\bPERMISSION_DENIED\b/.test(msg) ||
            /Incorrect API key/i.test(msg) ||
            /Invalid authentication/i.test(msg) ||
            /API key not valid/i.test(msg) ||
            /\bunauthorized\b/i.test(msg)
        );
        if (looksLikeAuthErr && !_authRetried) {
            trace(`AUTH:DETECT provider=${providerId} popping key modal`);
            panel.webview.postMessage({ type: 'info', text: `${PROVIDERS[providerId].label} key was rejected — paste a new one.` });
            const got = await promptForKey(context, providerId);
            if (got) {
                /* Pop the user message we just appended so the retry doesn't
                   stack two of them in conversation history. */
                if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') conversation.pop();
                /* Box the text so the auth-retry marker survives the recursive
                   call (a primitive can't carry props; .trim() at the top reads
                   the marker off the object before coercing). Carry the rotate
                   count forward too so the two retry paths don't reset each
                   other's loop guard. */
                const retryText = new String(text);
                retryText.__cbeAuthRetry = true;
                retryText.__cbeRotateCount = _rotateCount;
                panel.webview.postMessage({ type: 'info', text: `${PROVIDERS[providerId].label} key stored — retrying.` });
                return handleSendText(context, panel, retryText);
            }
            panel.webview.postMessage({ type: 'error', message: `${providerId}: auth failed and no new key supplied.` });
        } else {
            panel.webview.postMessage({ type: 'error', message: `${providerId}: ${msg}` });
        }
        setStatus('error', false, providerId);
        if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') conversation.pop();
    }
}

/* ── Tool-call parsing + execution ────────────────────────────────────────
   Opt-in convention: the model wraps an executable command in a fenced
   code block whose FIRST line is the marker `# !exec` (case-insensitive).
   Recognized languages: bash, sh, pwsh, powershell, cmd, batch. Examples:

       ```bash
       # !exec
       git status
       ```

       ```pwsh
       # !exec
       Get-ChildItem -Recurse -File | Measure-Object
       ```

   Without the marker, fenced blocks are display-only (zero behavior change
   for chats that aren't aware of the convention). */
const TOOL_FENCE_RE = /```(bash|sh|pwsh|powershell|cmd|batch)\r?\n([\s\S]*?)```/gi;
const TOOL_EXEC_MARKER_RE = /^\s*#\s*!exec\b/i;

function parseToolCalls(text) {
    const out = [];
    if (!text) return out;
    TOOL_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_FENCE_RE.exec(text)) !== null) {
        const lang = m[1].toLowerCase();
        const body = m[2] || '';
        const firstNL = body.indexOf('\n');
        const firstLine = firstNL >= 0 ? body.slice(0, firstNL) : body;
        if (!TOOL_EXEC_MARKER_RE.test(firstLine)) continue;
        const command = (firstNL >= 0 ? body.slice(firstNL + 1) : '').replace(/\r?\n$/, '');
        if (!command.trim()) continue;
        out.push({ lang, command, raw: m[0] });
    }
    return out;
}

function executeToolCall(call, opts = {}) {
    const cwd = opts.cwd || os.homedir();
    const timeoutMs = Number(opts.timeoutMs) || 60000;
    const maxBuffer = Number(opts.maxBuffer) || (4 * 1024 * 1024);
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let shell, shellArgs;
        if (call.lang === 'pwsh' || call.lang === 'powershell') {
            shell = 'powershell.exe';
            shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', call.command];
        } else if (call.lang === 'cmd' || call.lang === 'batch') {
            shell = 'cmd.exe';
            shellArgs = ['/d', '/c', call.command];
        } else {
            /* bash / sh — use the bash that ships with Git for Windows if
               present, otherwise fall back to cmd. Picked via PATH lookup. */
            shell = process.env.COMSPEC && fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
                ? 'C:\\Program Files\\Git\\bin\\bash.exe'
                : 'bash';
            shellArgs = ['-lc', call.command];
        }
        const proc = cp.spawn(shell, shellArgs, { cwd, windowsHide: true, env: process.env });
        let stdout = '', stderr = '', truncated = false;
        const cap = (which, chunk) => {
            const buf = which === 'out' ? stdout : stderr;
            const room = maxBuffer - buf.length;
            if (room <= 0) { truncated = true; return; }
            const s = chunk.toString('utf8');
            if (which === 'out') stdout += s.slice(0, room);
            else                 stderr += s.slice(0, room);
            if (s.length > room) truncated = true;
        };
        proc.stdout.on('data', d => cap('out', d));
        proc.stderr.on('data', d => cap('err', d));
        const killer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, timeoutMs);
        proc.on('close', (code, signal) => {
            clearTimeout(killer);
            resolve({
                rc: typeof code === 'number' ? code : -1,
                signal: signal || null,
                stdout, stderr,
                truncated,
                durationMs: Date.now() - startedAt,
                command: call.command,
                lang: call.lang,
            });
        });
        proc.on('error', err => {
            clearTimeout(killer);
            resolve({
                rc: -1, signal: null,
                stdout, stderr: stderr + `\n[spawn-error] ${err.message}`,
                truncated, durationMs: Date.now() - startedAt,
                command: call.command, lang: call.lang,
            });
        });
    });
}

function formatToolResult(call, r) {
    /* Mirror the fenced shape the model emits so re-feeding the conversation
       is symmetric. The wrapper block is `tool-output` (NOT one of the
       executable langs) so the next pass won't try to re-execute the result. */
    const head = `[tool-result lang=${call.lang} rc=${r.rc}${r.signal ? ` signal=${r.signal}` : ''} ms=${r.durationMs}${r.truncated ? ' truncated=true' : ''}]`;
    const sections = [];
    if (r.stdout.length) sections.push(`stdout:\n\`\`\`text\n${r.stdout.replace(/\r?\n$/, '')}\n\`\`\``);
    if (r.stderr.length) sections.push(`stderr:\n\`\`\`text\n${r.stderr.replace(/\r?\n$/, '')}\n\`\`\``);
    if (!sections.length) sections.push('(no output)');
    return `${head}\n${sections.join('\n')}`;
}

module.exports = { activate, deactivate };
