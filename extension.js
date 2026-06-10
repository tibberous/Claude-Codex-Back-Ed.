/* ─────────────────────────────────────────────────────────────────────────
   Codex Black Ed.
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
const STATE_TTS_PROVIDER = 'codexBlackEd.ttsProvider';
const STATE_STT_PROVIDER = 'codexBlackEd.sttProvider';
/* Voice tuning (per the picked provider). TTS read-aloud: voice/rate/volume
   (webspeech, applied panel-side) + openai voice/speed + elevenlabs voiceId/
   stability/similarity (applied host-side in handleTtsRequest). STT: a custom
   dictionary/vocabulary string + language, applied per-provider in the
   transcription path. */
const STATE_TTS_VOICE       = 'codexBlackEd.ttsVoice';        /* webspeech voice name */
const STATE_TTS_RATE        = 'codexBlackEd.ttsRate';         /* webspeech rate 0.1–10 */
const STATE_TTS_VOLUME      = 'codexBlackEd.ttsVolume';       /* webspeech volume 0–1 */
const STATE_TTS_OPENAI_VOICE = 'codexBlackEd.ttsOpenAiVoice'; /* alloy/echo/… */
const STATE_TTS_OPENAI_SPEED = 'codexBlackEd.ttsOpenAiSpeed'; /* 0.25–4 */
const STATE_TTS_ELEVEN_VOICE = 'codexBlackEd.ttsElevenVoice'; /* eleven voice id */
const STATE_TTS_ELEVEN_STABILITY  = 'codexBlackEd.ttsElevenStability';  /* 0–1 */
const STATE_TTS_ELEVEN_SIMILARITY = 'codexBlackEd.ttsElevenSimilarity'; /* 0–1 */
const STATE_STT_DICTIONARY  = 'codexBlackEd.sttDictionary';   /* comma/newline terms */
const STATE_STT_LANGUAGE    = 'codexBlackEd.sttLanguage';     /* BCP-47 or '' */
const OPENAI_TTS_VOICES = ['alloy','echo','fable','onyx','nova','shimmer','ash','sage','coral'];
/* Voice providers (TTS + STT). 'webspeech' = browser-native (panel-side).
   Realtime local STT options (2026-05-30 — replaces the batch whisper-local
   HTTP-server path):
     'whisper-cpp-stream'    — whisper.cpp's `stream` example binary, fed raw
                               PCM via stdin (Windows-first; SDL2 fallback
                               possible cross-platform later).
     'faster-whisper-stream' — Python CTranslate2 implementation w/ webrtcvad
                               + sliding window. Bootstraps a per-repo venv on
                               first use (~150MB model download).
   'elevenlabs' / 'openai' are network-backed premium options. 'anthropic'
   = STT only, via Anthropic's undocumented Deepgram-Nova-3 WebSocket proxy,
   authenticated with the Claude Code OAuth token (so it's included with a
   Claude subscription — no separate key). The legacy host-side
   SpeechRecognition path was retired 2026-05-26. */
/* `deepgram` is the BYO-key first-class Deepgram provider — user supplies
   their own Deepgram API key via [deepgram] api_key in config.ini. Distinct
   from `anthropic` (which proxies Deepgram Nova-3 through Anthropic's STT
   endpoint, billed against the Claude Code OAuth token) — added 2026-05-28
   per user request so people who already pay Deepgram can use that key
   directly without going through Anthropic's quota. */
const VOICE_PROVIDERS = ['webspeech', 'whisper-cpp-stream', 'faster-whisper-stream', 'elevenlabs', 'openai', 'anthropic', 'deepgram'];
/* TTS default = webspeech (keyless, browser-native).
   STT default = elevenlabs (per user memory `elevenlabs_default.md` — ElevenLabs
   is the canonical default for STT + TTS across all surfaces; falls back to
   openai → realtime-local → webspeech when the key is missing). Trent 2026-05-27. */
const VOICE_PROVIDER_DEFAULT = 'webspeech';
const STT_PROVIDER_DEFAULT = 'elevenlabs';
/* Both realtime local providers depend on ffmpeg dshow input → Windows-first.
   On macOS/Linux we hide them from the runtime list and soft-pin selectors to
   the default.
   TODO(cross-platform): faster-whisper itself runs anywhere; only the ffmpeg
   capture is platform-specific. A future PR can swap dshow → avfoundation
   (macOS) / pulse (linux). whisper.cpp's `stream` example also has SDL2
   capture mode which works cross-platform without ffmpeg. */
const REALTIME_LOCAL_STT_PROVIDERS = ['whisper-cpp-stream', 'faster-whisper-stream'];
function getRuntimeVoiceProviders() {
    return (process.platform === 'win32')
        ? VOICE_PROVIDERS
        : VOICE_PROVIDERS.filter(p => !REALTIME_LOCAL_STT_PROVIDERS.includes(p));
}
const SKINS_DIR_NAME = 'skins';
const SKINS_BACKUP_DIR_NAME = 'skins-original-backup';   /* pristine "Restore Original" source (tracked) */
const CONFIG_INI_NAME = 'config.ini';
const secretsCache = {};   /* providerId -> apiKey | null. Populated at activate. */

/* ── Provider registry ────────────────────────────────────────────────────
   Per-provider metadata: pretty label, default model id, the field name to
   read from config.ini's [api_keys] section, the model-choice field name,
   and a hint list of candidate models for the dropdown. The Grok entry
   targets the direct xAI API (api.x.ai) — not the grok.com browser bridge. */
let _lastProviderInfoLine = '';   // dedupe the "Provider → …" info line (only re-announce on an actual change)
const PROVIDERS = {
    anthropic: {
        label: 'Claude (API key)',
        keyField:   'anthropic_api_key',
        modelField: 'claude_model_choice',
        defaultModel: 'claude-sonnet-4-6',
        models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    /* ── Logged-in Claude (the forked Claude Code path, restored) ──────────
       Hosts the REAL `claude` CLI agent (tool use, file edits, the full
       loop) running against the Claude Code OAuth subscription login — no
       API key. Same auth + billing as bare Claude Code. cliAgent:true routes
       chat through streamClaudeAgent() instead of the HTTP-provider stream;
       the spawn env strips ANTHROPIC_API_KEY so the CLI uses OAuth, not the
       API-credit ledger. This is NOT a browser bridge — for Claude a web
       bridge is pointless (claude.ai web + Claude Code share one subscription
       pool), so the old claudeBridge was removed in favor of this. */
    claudeCode: {
        label: 'Claude (logged in)',
        cliAgent: true,
        modelField: 'claude_model_choice',
        defaultModel: 'claude-sonnet-4-6',
        models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
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
    /* NOTE: no claudeBridge. A web bridge buys nothing for Claude — claude.ai
       web and Claude Code draw from the SAME subscription pool — so Claude is
       served by the `claudeCode` logged-in agent (above) + the `anthropic`
       API-key provider. Bridges remain for ChatGPT/Grok/Copilot/Gemini where
       web vs API billing actually differ. */
    /* Ollama is NOT a browser bridge — it's a LOCAL HTTP runtime (the ollama
       daemon on 127.0.0.1:11434). It talks DIRECTLY to /api/chat from Node
       (streamOllama), bypassing the C++ tray exe + bridge_chat.py entirely.
       `local:true` routes chatStream to streamOllama; `localTarget` is the
       config.ini [ollama] section key. The registry id stays `ollamaBridge`
       only so previously-persisted provider selections keep resolving. */
    ollamaBridge:  { label: 'Ollama (local)',           local: true, localTarget: 'ollama',   defaultModel: 'llama3.2:3b',    models: ['llama3.2:3b', 'llama3.2', 'qwen2.5', 'mistral'] },
    /* deepseekBridge is registered dynamically from extensions/deepseek.bridge
       via loadBridgeExtensions() at activation. Add other browser-bridge
       providers the same way — drop a *.bridge XML in extensions/. */
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
    ollama:   8793,
    /* deepseek: registered by loadBridgeExtensions() from extensions/deepseek.bridge */
};

/* Consolidated 2026-05-24: every browser bridge target now uses the SAME
   unified bin/CBE-Bridge.exe, launched with `--target <name> --port <n>`.
   Was 7 per-target exes (CBE-Bridge-Claude.exe, CBE-Bridge-ChatGPT.exe, …)
   each compiled with a different TARGET_NAME #define. Switched to one exe
   so Azure Trusted Signing only has to cover a single binary identity.
   The map is kept as a per-target lookup in case a future bridge ships its
   own separate exe (the .bridge XML's <exeName> still overrides per id). */
const UNIFIED_BRIDGE_EXE = 'CBE-Bridge.exe';
const BRIDGE_EXE_NAME = {
    chatgpt:  UNIFIED_BRIDGE_EXE,
    grok:     UNIFIED_BRIDGE_EXE,
    copilot:  UNIFIED_BRIDGE_EXE,
    gemini:   UNIFIED_BRIDGE_EXE,
    ollama:   UNIFIED_BRIDGE_EXE,
    /* deepseek: registered by loadBridgeExtensions() from extensions/deepseek.bridge */
};

/* Track which bridges THIS extension instance has already spawned so we
   don't re-fork them on every chat. Map of target -> { pid, startedAt }. */
const _runningBridges = new Map();

/* Module-level cache of the last bridge-extension scan result (set by
   activate() once loadBridgeExtensions runs). Used by the marketplace
   catalog handler to surface .bridge entries alongside .ext extensions. */
let _bridgeExtensionsLoaded = [];

/* ── Bridge extension scanner ─────────────────────────────────────────────
   Loads pluggable browser-bridge providers from extensions/*.bridge XML
   files at activation time. Each .bridge file declares a provider id,
   bridge port, exe name, default model, and model list — same fields the
   hardcoded entries above carry. New entries are added to PROVIDERS,
   BRIDGE_PORTS, and BRIDGE_EXE_NAME so the rest of the system treats them
   identically to the built-in bridges. Format:
       <bridge id="deepseek">
         <name>DeepSeek</name>
         <author>Claude Opus 4.7</author>
         <released>2026-05-24</released>
         <loginUrl>...</loginUrl>
         <bridgePort>8794</bridgePort>
         <exeName>CBE-Bridge-DeepSeek.exe</exeName>
         <defaultModel>deepseek-chat</defaultModel>
         <model>deepseek-chat</model>
         <model>deepseek-reasoner</model>
       </bridge>
*/
function loadBridgeExtensions(extensionPath) {
    const dir = path.join(extensionPath, 'extensions');
    if (!fs.existsSync(dir)) return [];
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.bridge')); }
    catch (e) { return []; }
    const loaded = [];
    const childText = (body, tag) => {
        const m = body.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
        return m ? m[1].trim() : '';
    };
    const childAll = (body, tag) => {
        const out = [];
        const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi');
        let mm;
        while ((mm = re.exec(body)) !== null) out.push(mm[1].trim());
        return out;
    };
    for (const f of files) {
        const full = path.join(dir, f);
        let xml;
        try { xml = fs.readFileSync(full, 'utf8'); }
        catch (e) { trace('BRIDGE_EXT:read_fail file=' + f + ' err=' + (e.message || e)); continue; }
        const idMatch = xml.match(/<bridge[^>]*\bid\s*=\s*"([^"]+)"/i);
        const id = idMatch ? idMatch[1].trim() : path.basename(f, '.bridge');
        const name        = childText(xml, 'name') || id;
        const author      = childText(xml, 'author') || '';
        const released    = childText(xml, 'released') || '';
        const version     = childText(xml, 'version') || '';
        const description = childText(xml, 'description') || '';
        const mainUrl     = childText(xml, 'mainUrl') || childText(xml, 'homeUrl') || '';
        const loginUrl    = childText(xml, 'loginUrl') || '';
        const createAccountUrl = childText(xml, 'createAccountUrl') || '';
        const bridgePort  = parseInt(childText(xml, 'bridgePort'), 10);
        const cdpPortRaw  = parseInt(childText(xml, 'cdpPort'), 10);
        const cdpPort     = Number.isFinite(cdpPortRaw) ? cdpPortRaw : (bridgePort + 1000);
        const exeName     = childText(xml, 'exeName') || ('CBE-Bridge-' + name + '.exe');
        const iconFile    = childText(xml, 'iconFile') || '';
        const defaultModel = childText(xml, 'defaultModel') || '';
        const models      = childAll(xml, 'model');
        /* <enabled> defaults to TRUE when the tag is missing — the 6 stock
           bridges ship without it and stay live. New off-by-default
           extensions declare <enabled>false</enabled> explicitly. */
        const enabledRaw  = childText(xml, 'enabled');
        const enabled     = enabledRaw === '' ? true : !/^(false|0|no|off)$/i.test(enabledRaw);
        if (!id || !Number.isFinite(bridgePort)) {
            trace('BRIDGE_EXT:invalid file=' + f + ' (missing id or bridgePort)');
            continue;
        }
        const meta = {
            id, providerId: id + 'Bridge', file: f, name, author, released, version, description,
            port: bridgePort, cdpPort, exeName, iconFile,
            mainUrl, loginUrl, createAccountUrl,
            enabled,
            models, defaultModel,
        };
        if (!enabled) {
            /* Disabled bridges are catalogued for the marketplace UI but NOT
               registered as live providers. Users flip them on by editing
               the .bridge file (or via a future Install action that rewrites
               <enabled>true</enabled>). */
            loaded.push(meta);
            continue;
        }
        PROVIDERS[meta.providerId] = {
            label: name + ' (browser bridge)',
            bridge: true,
            bridgeTarget: id,
            defaultModel: defaultModel || (models[0] || ''),
            models: models.length ? models : (defaultModel ? [defaultModel] : []),
            __source: 'bridge_extension',
            __file: f,
            __author: author,
            __released: released,
            __mainUrl: mainUrl,
            __loginUrl: loginUrl,
            __createAccountUrl: createAccountUrl,
            __iconFile: iconFile,
        };
        BRIDGE_PORTS[id] = bridgePort;
        BRIDGE_EXE_NAME[id] = exeName;
        loaded.push(meta);
    }
    return loaded;
}

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
    /* Secondary mirror target — a backup pull source if the primary host fails.
       Same VPS today (so weak as DR; GitHub would be better), but free. Empty
       string disables it. user 2026-05-31. */
    const remotePathBackup = String(u.remote_path_backup != null ? u.remote_path_backup : '/home/tristate.digital/cbe').trim();
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
        '.git/', '.gitignore', 'node_modules/', 'logs/', 'chats/', 'dist/',
        '.claude/', 'reports/',
        'data/',                // 1.74 GB per-machine QtWebEngine Chrome profile data
                                // (cookies/cache/ActorSafetyLists/etc) — NEVER push
        'bridges/',             // per-target browser-profile build artifacts — per-machine
        'skins/previews/',      // content-addressed skin thumbnails — generated
                                // per-machine on demand (<theme>-<md5>.png); never sync
        'config.ini',           // per-machine secrets
        'domains.txt', 'wake.txt', 'prompt_history.txt',
        'tools/nssm.exe',       // bundled per-host binaries — server doesn't need
        'tools/rcedit.exe',
    ];
    const filemask = '|' + excludes.join(';');

    /* Commands go in a SCRIPT FILE (/script=), NOT /command. With /command,
       each command is a separate spawn argv, and Node's Windows arg-escaping
       mangles the nested quotes around a localPath that contains a SPACE
       ("…\Codex Black") — WinSCP then truncates the path at the space
       ("…\Claude\*.*") and aborts with exit 1 (the push silently failed for a
       week this way). A script file is read by WinSCP directly, so quoted
       spaced paths survive intact. CRLF line endings; one command per line. */
    const scriptPath = path.join(logDir, `winscp_push_${stampedSlug}.script.txt`);
    const scriptBody = [
        'option batch abort',
        'option confirm off',
        `open ${session}`,
        `synchronize remote -mirror -filemask="${filemask}" "${localPath}" "${remotePath}"`,
        /* Secondary backup mirror in the same session (omitted if disabled). */
        ...(remotePathBackup ? [`synchronize remote -mirror -filemask="${filemask}" "${localPath}" "${remotePathBackup}"`] : []),
        'exit',
        '',
    ].join('\r\n');
    try { fs.writeFileSync(scriptPath, scriptBody, 'utf8'); }
    catch (e) { traceErr('UPDATE:PUSH write script', e); return; }

    /* Output goes to the session + xml logs we asked WinSCP to write — NOT to
       stdout (which is ignored). The spaced switch-paths (/log=, /script=) are
       each a single argv that Node quotes as a whole; WinSCP accepts that (the
       /log= path already worked even while the inline /command path failed). */
    const args = [
        `/log=${sessionLog}`,
        '/loglevel=1',
        `/xmllog=${xmlLog}`,
        `/script=${scriptPath}`,
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
        child.on('error', (e) => {
            trace(`UPDATE:PUSH spawn-error ${e.message || e}`);
            try { vscode.window.showErrorMessage('CBE: server push could NOT START — ' + (e.message || e)
                + ' (check [updates] winscp_exe in config.ini).'); } catch (_) {}
        });
        child.on('exit', (code, signal) => {
            const ok = code === 0;
            trace(`UPDATE:PUSH ${ok ? 'OK' : 'FAILED'} exit=${code} signal=${signal || 'none'} session=${session} — see ${path.basename(xmlLog)} for per-file results`);
            if (!ok) {
                /* Surface failures — they used to vanish into debug.log (the
                   spaced-path bug silently failed for ~a week). user 2026-05-31. */
                try {
                    vscode.window.showErrorMessage(
                        `CBE: server push FAILED (WinSCP exit ${code}). The remote was NOT updated — clients will pull a stale build.`,
                        'Show Log'
                    ).then(pick => { if (pick === 'Show Log') { try { vscode.window.showTextDocument(vscode.Uri.file(sessionLog)); } catch (_) {} } });
                } catch (_) {}
                return;
            }
            /* On success, read the remote manifest back and md5-compare every
               file to local — confirms the push actually landed + the mirror
               deleted stale files. Dialog only on a problem. user 2026-05-31. */
            _verifyPush(context, path.basename(sessionLog)).catch(e => trace('UPDATE:PUSH:VERIFY error ' + ((e && e.message) || e)));
        });
        child.unref();    // don't keep the extension host's event loop alive on this
    } catch (e) {
        traceErr('UPDATE:PUSH spawn', e);
    }
}

/* Verify a just-completed push by reading the remote manifest back and
   md5-comparing every listed file to the local copy. Confirms the push landed
   AND that the -mirror deleted stale remote files. Warns (dialog) only on a
   real discrepancy — silent on a clean push so it doesn't nag every activate.
   Skips paths the push excludes so they don't show as false mismatches. */
async function _verifyPush(context, logName) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const u = cfg.updates || {};
    const manifestUrl = String(u.manifest_url || 'https://trentontompkins.com/cbe/manifest.xml.php').trim();
    let buf;
    try { buf = await _httpsGetBuffer(manifestUrl, 30000); }
    catch (e) { trace('UPDATE:PUSH:VERIFY fetch failed ' + ((e && e.message) || e)); return; }
    const entries = _parseManifestXml(buf.toString('utf8')) || [];
    if (!entries.length) { trace('UPDATE:PUSH:VERIFY manifest empty/parse-failed'); return; }
    /* Same exclusions the push filemask uses — those files are never uploaded,
       so a remote/absent-local difference for them is expected, not a fault. */
    const skip = (p) => /^(data|bridges|logs|chats|reports|emails|node_modules|\.git|dist)\//i.test(p)
        || /^skins\/previews\//i.test(p) || /\.(log|bak|tmp|swp|vsix)$/i.test(p)
        || p === 'config.ini' || p === 'config.sample.ini';
    let okCount = 0, mismatch = 0, remoteOnly = 0;
    const bad = [];
    for (const e of entries) {
        if (skip(e.path)) continue;
        const local = path.join(context.extensionPath, e.path);
        if (!fs.existsSync(local)) { remoteOnly++; if (bad.length < 6) bad.push(e.path); continue; }
        const m = _md5FileSync(local);
        if (m && m.toLowerCase() === String(e.md5).toLowerCase()) okCount++;
        else { mismatch++; if (bad.length < 6) bad.push(e.path); }
    }
    trace(`UPDATE:PUSH:VERIFY total=${entries.length} ok=${okCount} mismatch=${mismatch} remoteOnly(notLocal)=${remoteOnly}`);
    if (mismatch === 0 && remoteOnly === 0) { trace('UPDATE:PUSH:VERIFY clean — remote matches local'); return; }
    const parts = [];
    if (mismatch)   parts.push(`${mismatch} file(s) on the server don't match local`);
    if (remoteOnly) parts.push(`${remoteOnly} stale remote file(s) the mirror did NOT delete`);
    const msg = `CBE push verify: ${parts.join(' + ')}${bad.length ? ' — e.g. ' + bad.slice(0, 4).join(', ') : ''}.`;
    try {
        vscode.window.showWarningMessage(msg, 'Show Log').then(pick => {
            if (pick === 'Show Log') { try { vscode.window.showTextDocument(vscode.Uri.file(path.join(context.extensionPath, 'logs', logName))); } catch (_) {} }
        });
    } catch (_) {}
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
    '.gitignore',        // dev metadata, per-repo — NEVER pull (a stale remote
                         // copy was clobbering the local data/bridges/previews
                         // ignore-block on every reload). user 2026-05-31.
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
/* 50% more frequent than the prior 30-run cadence per user 2026-05-24 —
   periodic interval dropped to 20 (next fires at 40, 60, 80, ...) and a
   couple of extra early-life triggers (4, 8, 15) interleaved with the
   original 3 / 6 / 10 / 20 set. Total density ≈ 1.5×. */
const NAG_FIXED_TRIGGERS = [3, 4, 6, 8, 10, 15, 20];
const NAG_PERIODIC_INTERVAL = 20;
const NAG_PERIODIC_START = NAG_FIXED_TRIGGERS[NAG_FIXED_TRIGGERS.length - 1] + NAG_PERIODIC_INTERVAL; // 40

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

/* ── Voice provider helpers (TTS / STT) ────────────────────────────────────
   CBE supports three TTS providers and three STT providers, dispatched by
   the per-workspace state keys STATE_TTS_PROVIDER / STATE_STT_PROVIDER.
   The user picks one in Settings → Voice; the panel emits 'ttsRequest' /
   'sttRequest' for the network-backed providers and handles WebSpeech
   itself in the webview (since SpeechSynthesis / SpeechRecognition are
   browser APIs, not Node APIs).

   This is the pitch pillar: CBE ships a working 3-way voice switcher
   including the WebSpeech path that the official anthropic.claude-code
   bundle references in its source but doesn't wire into the UI. */
function _getElevenLabsKey(context) {
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        let k = (cfg.elevenlabs && cfg.elevenlabs.api_key) || '';
        if (k) return k;
        if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
        /* Fallback to the master TrioDesktop config dump (per user policy:
           TrioDesktop config.ini is the canonical key dump for all projects).
           Windows-only path; harmless on macOS/Linux (file just doesn't exist). */
        try {
            const fs = require('fs');
            const path = require('path');
            const master = path.join('C:', 'TrioDesktop', 'config.ini');
            if (fs.existsSync(master)) {
                const txt = fs.readFileSync(master, 'utf8');
                /* Tiny inline parser — read [elevenlabs] api_key = ... */
                const m = /^\s*\[elevenlabs\][\s\S]*?^\s*api_key\s*=\s*([^\r\n]+)/mi.exec(txt);
                if (m && m[1]) return m[1].trim();
            }
        } catch (_) { /* best-effort fallback */ }
        return '';
    } catch (e) { return ''; }
}

/* Mirror of _getElevenLabsKey — pulls a Deepgram API key from config.ini's
   [deepgram] api_key, then DEEPGRAM_API_KEY env, then the master TrioDesktop
   config.ini dump per the same canonical-keys policy. Used by the
   `provider === 'deepgram'` STT branch below. */
function _getDeepgramKey(context) {
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        let k = (cfg.deepgram && cfg.deepgram.api_key) || '';
        if (k) return k;
        if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY;
        try {
            const fs = require('fs');
            const path = require('path');
            const master = path.join('C:', 'TrioDesktop', 'config.ini');
            if (fs.existsSync(master)) {
                const txt = fs.readFileSync(master, 'utf8');
                const m = /^\s*\[deepgram\][\s\S]*?^\s*api_key\s*=\s*([^\r\n]+)/mi.exec(txt);
                if (m && m[1]) return m[1].trim();
            }
        } catch (_) { /* best-effort fallback */ }
        return '';
    } catch (e) { return ''; }
}

let _whisperNonWinWarned = false;
function getVoiceProvider(context, kind /* 'tts' | 'stt' */) {
    const key = (kind === 'stt') ? STATE_STT_PROVIDER : STATE_TTS_PROVIDER;
    const v = context.workspaceState.get(key);
    /* Per-kind default: STT → elevenlabs (per user memory `elevenlabs_default.md`),
       TTS → webspeech (keyless, no key required). Trent 2026-05-27. */
    const defaultForKind = (kind === 'stt') ? STT_PROVIDER_DEFAULT : VOICE_PROVIDER_DEFAULT;
    /* Legacy stored value: 'whisper-local' was removed 2026-05-30 in favor of
       the two realtime providers (whisper-cpp-stream + faster-whisper-stream).
       Auto-migrate stale selections to the canonical realtime equivalent. */
    if (v === 'whisper-local') return (kind === 'stt' && process.platform === 'win32')
        ? 'whisper-cpp-stream' : defaultForKind;
    /* Realtime local STT providers depend on ffmpeg dshow → Windows-only.
       Soft-pin to default elsewhere. */
    if (REALTIME_LOCAL_STT_PROVIDERS.includes(v) && process.platform !== 'win32') {
        if (!_whisperNonWinWarned) {
            _whisperNonWinWarned = true;
            trace(v + ' soft-pinned to ' + defaultForKind + ': not Windows (' + process.platform + ')');
        }
        return defaultForKind;
    }
    /* anthropic is STT-only (no TTS) — if it leaked into a tts slot, fall back. */
    if (v === 'anthropic' && kind === 'tts') return defaultForKind;
    /* WebSpeech is structurally dead for STT inside the VSCode webview sandbox
       (Electron denies SpeechRecognition / getUserMedia regardless of the OS
       grant). A stale 'webspeech' selection here causes the red "WebSpeech
       denied by sandbox" banner on every mic click. Auto-promote to the
       canonical STT default (elevenlabs) — Trent 2026-05-29. WebSpeech remains
       valid for TTS (speechSynthesis IS available in the webview). */
    if (kind === 'stt' && v === 'webspeech') return defaultForKind;
    return VOICE_PROVIDERS.includes(v) ? v : defaultForKind;
}

/* Server-side TTS: take text, return base64 audio (mp3) the panel plays
   in an <audio> element. WebSpeech is handled by the panel itself; this
   function only services the elevenlabs / openai providers. */
async function handleTtsRequest(panel, context, msg) {
    const reqId   = msg.reqId || '';
    const text    = String(msg.text || '').trim();
    const provider = String(msg.provider || getVoiceProvider(context, 'tts'));
    if (!text) {
        try { panel.webview.postMessage({ type: 'ttsResult', reqId, error: 'empty text' }); } catch (_) {}
        return;
    }
    try {
        let audioBuf = null;
        let mime = 'audio/mpeg';
        if (provider === 'elevenlabs') {
            const key = _getElevenLabsKey(context);
            if (!key) throw new Error('no [elevenlabs] api_key in config.ini');
            /* eleven_multilingual_v2 + Rachel voice — same defaults TrioDesktop
               uses. The saved voice ID + stability/similarity (Settings → Read
               Aloud) override the per-request defaults when present. */
            const savedVoice = String(context.workspaceState.get(STATE_TTS_ELEVEN_VOICE) || '');
            const voiceId = (msg.voiceId || savedVoice || '21m00Tcm4TlvDq8ikWAM');
            const savedStab = context.workspaceState.get(STATE_TTS_ELEVEN_STABILITY);
            const savedSim  = context.workspaceState.get(STATE_TTS_ELEVEN_SIMILARITY);
            const stability = (typeof msg.stability === 'number') ? msg.stability
                            : (typeof savedStab === 'number') ? savedStab : 0.5;
            const similarity = (typeof msg.similarity === 'number') ? msg.similarity
                             : (typeof savedSim === 'number') ? savedSim : 0.75;
            const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'xi-api-key': key,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    text,
                    model_id: 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: Math.max(0, Math.min(1, stability)),
                        similarity_boost: Math.max(0, Math.min(1, similarity)),
                    },
                }),
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { const j = await res.json(); if (j && j.detail) detail = JSON.stringify(j.detail); }
                catch (_) {}
                throw new Error('ElevenLabs: ' + detail);
            }
            audioBuf = Buffer.from(await res.arrayBuffer());
            mime = 'audio/mpeg';
        } else if (provider === 'openai') {
            const key = getProviderKey(context, 'openai');
            if (!key) throw new Error('no openai api key configured');
            /* Saved voice + speed (Settings → Read Aloud) override per-request
               defaults. Speed is clamped to OpenAI's documented 0.25–4.0 range. */
            const savedVoice = String(context.workspaceState.get(STATE_TTS_OPENAI_VOICE) || '');
            const voice = (msg.voice && OPENAI_TTS_VOICES.includes(msg.voice)) ? msg.voice
                        : (OPENAI_TTS_VOICES.includes(savedVoice) ? savedVoice : 'alloy');
            const savedSpeed = context.workspaceState.get(STATE_TTS_OPENAI_SPEED);
            const speedRaw = (typeof msg.speed === 'number') ? msg.speed
                           : (typeof savedSpeed === 'number') ? savedSpeed : 1;
            const speed = Math.max(0.25, Math.min(4, speedRaw));
            const res = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    model: 'tts-1',
                    voice,
                    input: text,
                    format: 'mp3',
                    speed,
                }),
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { const j = await res.json(); if (j && j.error && j.error.message) detail = j.error.message; }
                catch (_) {}
                throw new Error('OpenAI TTS: ' + detail);
            }
            audioBuf = Buffer.from(await res.arrayBuffer());
            mime = 'audio/mpeg';
        } else {
            /* webspeech — the panel should never have sent this request to the
               host (it speaks locally). If it did, signal so panel.js can
               fall back to its own SpeechSynthesis path. */
            throw new Error('webspeech is a panel-side provider; no host call');
        }
        const b64 = audioBuf.toString('base64');
        try {
            panel.webview.postMessage({ type: 'ttsResult', reqId, ok: true, mime, audioB64: b64, provider });
        } catch (e) { traceErr('ttsResult postMessage', e); }
    } catch (e) {
        try {
            panel.webview.postMessage({ type: 'ttsResult', reqId, ok: false, error: (e && e.message) || String(e), provider });
        } catch (_) {}
    }
}

/* Server-side STT: take base64 audio (webm/opus or wav), return transcript.
   WebSpeech is handled by the panel itself; whisper-local is handled by the
   spawned whisper.cpp server below. This function services elevenlabs and openai. */
async function handleSttRequest(panel, context, msg) {
    const reqId   = msg.reqId || '';
    const provider = String(msg.provider || getVoiceProvider(context, 'stt'));
    const b64     = String(msg.audioB64 || '');
    const mime    = String(msg.mime || 'audio/webm');
    /* Custom dictionary / vocabulary (Settings → Speech to Text). Used as the
       transcription `prompt` for whisper-local + openai to bias spelling of
       names/jargon. Prefer the message value, fall back to persisted state. */
    const dictionary = (typeof msg.dictionary === 'string' && msg.dictionary)
        ? msg.dictionary
        : String(context.workspaceState.get(STATE_STT_DICTIONARY) || '');
    if (!b64) {
        try { panel.webview.postMessage({ type: 'sttRequestResult', reqId, ok: false, error: 'empty audio' }); } catch (_) {}
        return;
    }
    try {
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) throw new Error('audio decode produced 0 bytes');
        /* Derive an extension from the mime so the multipart filename is
           recognizable by both providers. They both accept webm/wav/m4a/mp3. */
        let ext = 'webm';
        if (/wav/i.test(mime)) ext = 'wav';
        else if (/mp4|m4a/i.test(mime)) ext = 'm4a';
        else if (/mpeg/i.test(mime)) ext = 'mp3';
        else if (/ogg/i.test(mime)) ext = 'ogg';
        let text = '';
        if (provider === 'elevenlabs') {
            const key = _getElevenLabsKey(context);
            if (!key) throw new Error('no [elevenlabs] api_key in config.ini');
            const form = new FormData();
            form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
            form.append('model_id', 'scribe_v1');
            const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
                method: 'POST',
                headers: { 'xi-api-key': key },
                body: form,
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { const j = await res.json(); if (j && j.detail) detail = JSON.stringify(j.detail); }
                catch (_) {}
                throw new Error('ElevenLabs STT: ' + detail);
            }
            const j = await res.json();
            text = String((j && (j.text || j.transcript)) || '').trim();
        } else if (provider === 'openai') {
            const key = getProviderKey(context, 'openai');
            if (!key) throw new Error('no openai api key configured');
            const form = new FormData();
            form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
            form.append('model', 'gpt-4o-transcribe');
            form.append('response_format', 'json');
            /* Custom dictionary biases spelling of names / jargon / acronyms. */
            if (dictionary.trim()) form.append('prompt', dictionary.slice(0, 4096));
            const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}` },
                body: form,
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { const j = await res.json(); if (j && j.error && j.error.message) detail = j.error.message; }
                catch (_) {}
                throw new Error('OpenAI STT: ' + detail);
            }
            const j = await res.json();
            text = String((j && j.text) || '').trim();
        } else if (provider === 'whisper-cpp-stream' || provider === 'faster-whisper-stream') {
            /* Realtime local providers don't service the batch /sttRequest
               path — they're streaming-only. The panel routes them to
               sttHostStart{Wcpp,Fw} instead. If we still see them here it
               means a stale code path called us with a recorded clip; surface
               a clear error. */
            throw new Error(provider + ' is realtime-only — no batch transcription path');
        } else if (provider === 'anthropic') {
            /* Anthropic's undocumented streaming STT (Deepgram Nova-3 proxy),
               authenticated with the Claude Code OAuth token — included with a
               Claude subscription, no separate key. Request/response mode here
               (panel sends a complete clip); the streaming pass makes it live.
               The custom dictionary → extra Deepgram keyterms; language → BCP-47. */
            text = await handleAnthropicStt(context, buf, mime, undefined, {
                keyterms: _splitDictionaryTerms(dictionary),
                language: (typeof msg.language === 'string' && msg.language) ? msg.language : String(context.workspaceState.get(STATE_STT_LANGUAGE) || ''),
            });
        } else if (provider === 'deepgram') {
            /* Direct Deepgram REST — user supplies their own Deepgram API key
               via [deepgram] api_key in config.ini. Same Nova-3 model the
               Anthropic proxy uses, but BYO billing. Custom dictionary maps
               to `keyterm=` query params (Deepgram tokens up to 100 keyterms);
               language maps to `language=` (Nova-3 auto-detects if blank). */
            const key = _getDeepgramKey(context);
            if (!key) throw new Error('no [deepgram] api_key in config.ini');
            const params = new URLSearchParams();
            params.set('model', 'nova-3');
            params.set('smart_format', 'true');
            params.set('punctuate', 'true');
            const lang = (typeof msg.language === 'string' && msg.language)
                ? msg.language
                : String(context.workspaceState.get(STATE_STT_LANGUAGE) || '');
            if (lang) params.set('language', lang);
            for (const kt of _splitDictionaryTerms(dictionary).slice(0, 100)) {
                if (kt) params.append('keyterm', kt);
            }
            const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
                method: 'POST',
                headers: { 'Authorization': `Token ${key}`, 'Content-Type': mime },
                body: buf,
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try {
                    const j = await res.json();
                    if (j && (j.err_msg || j.reason || j.message)) {
                        detail = j.err_msg || j.reason || j.message;
                    }
                } catch (_) {}
                throw new Error('Deepgram STT: ' + detail);
            }
            const j = await res.json();
            text = String(
                ((j.results && j.results.channels && j.results.channels[0]
                  && j.results.channels[0].alternatives
                  && j.results.channels[0].alternatives[0]
                  && j.results.channels[0].alternatives[0].transcript) || '')
            ).trim();
        } else {
            throw new Error('webspeech is a panel-side provider; no host call');
        }
        try {
            panel.webview.postMessage({ type: 'sttRequestResult', reqId, ok: true, text, provider });
        } catch (e) { traceErr('sttRequestResult postMessage', e); }
    } catch (e) {
        try {
            panel.webview.postMessage({ type: 'sttRequestResult', reqId, ok: false, error: (e && e.message) || String(e), provider });
        } catch (_) {}
    }
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
        prompt: 'Stored encrypted in VS Code secrets. Cleared via "Codex Black: Clear API Key".',
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

/* Validate an email+password pair for a bridge account. Email shape is checked
   loosely (one @, at least one dot in the domain); password is just non-empty.
   Returns { ok, reason }. */
function validateLoginShape(email, password) {
    const e = String(email || '').trim();
    const pw = String(password || '');
    if (!e) return { ok: false, reason: 'empty email' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, reason: 'email looks invalid' };
    if (!pw) return { ok: false, reason: 'empty password' };
    return { ok: true };
}

/* Mask a password for any log/UI surface — same posture as maskKey but with no
   prefix (passwords are opaque). */
function maskPassword(pw) {
    const s = String(pw || '');
    if (!s) return '(empty)';
    if (s.length <= 4) return '****';
    return '****' + s.slice(-2);
}

/* Default account `type` for a provider. Direct-API providers use API keys;
   browser-bridge providers (claudeBridge/chatgptBridge/grokBridge/geminiBridge/
   copilotBridge/deepseekBridge) drive a real logged-in browser session via the
   C++ tray exe in bin/, so their accounts are email+password. Ollama is a
   LOCAL runtime (the ollama daemon, direct HTTP — not a bridge) and needs no
   account — callers should still skip the Add UI for it. */
function defaultAccountType(providerId) {
    const p = PROVIDERS[providerId] || {};
    /* cliAgent (logged-in Claude Code) + local Ollama have no key/account —
       auth lives in the Claude Code OAuth login / local daemon. */
    if (p.cliAgent || providerId === 'ollamaBridge' || providerId === 'ollama') return 'none';
    return p.bridge ? 'email_password' : 'api_key';
}

/* True when a provider has NO concept of an account at all (e.g. local Ollama).
   Used by buildAccountsPayload + the panel to hide/disable the Add UI. */
function providerHasAccounts(providerId) {
    return defaultAccountType(providerId) !== 'none';
}

/* Read the raw [accounts] JSON array for a provider, with one-time migration
   of the legacy [api_keys].<keyField> single key into accounts[0]. Returns a
   normalized array (never null). Does NOT persist the migration here — the
   caller persists when it makes a change; a read-only call just sees the
   migrated-in legacy account at the head.

   Each account is either:
     { type: 'api_key',         id, label, email, apiKey,   addedAt, lastUsedAt, disabledUntil }
     { type: 'email_password',  id, label, email, password, addedAt, lastUsedAt, disabledUntil }
   `email` is the identity tag — the gmail (or other) address the user
   associates with this account. ALWAYS present (even on api_key rows) so the
   user can see WHICH gmail owns each key. May be `null` for legacy api_key
   rows migrated in from [api_keys] before the email tag landed. Accounts
   without a `type` default to api_key for backward compat — never
   destructively rewritten on read. */
function getProviderAccounts(context, providerId) {
    const p = PROVIDERS[providerId];
    if (!p) return [];
    if (!providerHasAccounts(providerId)) return [];
    const cfg = readConfigIni(context.extensionPath) || {};
    let list = [];
    const rawSection = cfg[ACCOUNTS_SECTION] || {};
    const raw = rawSection[providerId];
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                /* Keep any row that has SOMETHING addressable — an apiKey for
                   api_key rows or an email for email_password rows. */
                list = parsed.filter(a => a && (a.apiKey || a.email));
            }
        } catch (e) {
            traceErr(`accounts JSON parse failed for ${providerId}`, e);
        }
    }
    /* Migrate the legacy single key into the list if it isn't represented.
       Only applies to direct-API providers — bridges have no [api_keys] entry. */
    if (!p.bridge) {
        let legacyKey = null;
        if (p.azureSection) {
            legacyKey = (cfg.azure && (cfg.azure.api_key || cfg.azure.api_key1)) || null;
        } else if (p.keyField) {
            legacyKey = (cfg.api_keys && cfg.api_keys[p.keyField]) || null;
        }
        legacyKey = legacyKey ? String(legacyKey).trim() : null;
        if (legacyKey && !list.some(a => (a.type || 'api_key') === 'api_key' && a.apiKey === legacyKey)) {
            list.unshift({
                id: _newAccountId(),
                type: 'api_key',
                label: 'config.ini',
                apiKey: legacyKey,
                addedAt: new Date().toISOString(),
                lastUsedAt: null,
                disabledUntil: null,
            });
        }
    }
    /* Normalize shape so downstream code never trips on undefined fields.
       The DEFAULT for a missing `type` is api_key (back-compat for accounts
       written before the email_password schema landed). */
    return list.map(a => {
        const type = a.type === 'email_password' ? 'email_password' : 'api_key';
        if (type === 'email_password') {
            return {
                id: a.id || _newAccountId(),
                type,
                label: a.label || a.email || 'login',
                email: String(a.email || ''),
                password: String(a.password || ''),
                addedAt: a.addedAt || new Date().toISOString(),
                lastUsedAt: a.lastUsedAt || null,
                disabledUntil: a.disabledUntil || null,
            };
        }
        return {
            id: a.id || _newAccountId(),
            type,
            label: a.label || maskKey(a.apiKey),
            /* email is the identity tag for api_key rows — gmail that owns the
               key. Optional: legacy rows migrated from [api_keys] have none
               (null), seeded rows get the user's primary gmail. */
            email: a.email ? String(a.email) : null,
            apiKey: String(a.apiKey || ''),
            addedAt: a.addedAt || new Date().toISOString(),
            lastUsedAt: a.lastUsedAt || null,
            disabledUntil: a.disabledUntil || null,
        };
    });
}

/* ── OAuth-token storage (per-account) ────────────────────────────────────
   Claude Code-style PKCE tokens (acquired via tools/claude_oauth.py) live
   in VS Code secrets keyed by `cbe.oauth.<providerId>.<accountId>.token`.
   Storage only — wiring into rotateOnRateLimit + request-send happens once
   we've confirmed one real token works end-to-end (see TODO at top of
   tools/claude_oauth.py). Keeping storage and request-wiring as separate
   commits so a partial integration doesn't break the existing apiKey path. */
const OAUTH_SECRET_PREFIX = 'cbe.oauth.';   /* + <providerId>.<accountId>.token */

async function storeAccountOAuthToken(context, providerId, accountId, tokenJson) {
    /* tokenJson is the full { access_token, refresh_token, expires_in,
       token_type } object — stored as a single JSON string so we keep
       all redemption fields together. */
    const key = `${OAUTH_SECRET_PREFIX}${providerId}.${accountId}.token`;
    await context.secrets.store(key, JSON.stringify(tokenJson || {}));
    trace(`OAUTH:STORE provider=${providerId} accountId=${accountId} keys=${Object.keys(tokenJson || {}).join(',')}`);
}

async function getAccountOAuthToken(context, providerId, accountId) {
    const key = `${OAUTH_SECRET_PREFIX}${providerId}.${accountId}.token`;
    const raw = await context.secrets.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) { traceErr(`oauth-token parse ${providerId}/${accountId}`, e); return null; }
}

async function clearAccountOAuthToken(context, providerId, accountId) {
    const key = `${OAUTH_SECRET_PREFIX}${providerId}.${accountId}.token`;
    try { await context.secrets.delete(key); }
    catch (e) { /* may not exist — fine */ }
    trace(`OAUTH:CLEAR provider=${providerId} accountId=${accountId}`);
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

/* ── Email-client accounts (multi-account inbox view) ─────────────────────
   Separate from the LLM [accounts] schema above. An email account row only
   needs: { id, label, provider, email, addedAt }. Passwords (app-passwords
   for gmail/yahoo/outlook IMAP+SMTP) live in VS Code secrets keyed by
   `cbe.email.<accountId>.password` — never in config.ini, never logged.
   Scope: a small inbox-30 reader (user 2026-05-24 — "not replacing
   thunderbird"). Spawns tools/imap_read.py for fetch and tools/smtp_send.py
   for send; both are stdlib-only and require no pip install. */
const EMAIL_ACCOUNTS_SECTION = 'email_accounts';
const EMAIL_SECRET_PREFIX    = 'cbe.email.';   /* + <accountId> + '.password' */
const EMAIL_PROVIDERS = ['gmail', 'yahoo', 'outlook', 'hotmail'];

function getEmailAccounts(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const sect = cfg[EMAIL_ACCOUNTS_SECTION] || {};
    const raw  = sect.list;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(a => a && a.id && a.email && EMAIL_PROVIDERS.includes(a.provider))
            .map(a => ({
                id:       String(a.id),
                label:    String(a.label || a.email),
                provider: String(a.provider),
                email:    String(a.email),
                addedAt:  a.addedAt || new Date().toISOString(),
            }));
    } catch (e) {
        traceErr('email-accounts JSON parse failed', e);
        return [];
    }
}

function setEmailAccounts(context, accounts) {
    const filePath = path.join(context.extensionPath, CONFIG_INI_NAME);
    writeConfigPatch(filePath, {
        [`${EMAIL_ACCOUNTS_SECTION}.list`]: JSON.stringify(accounts || []),
    });
    Config.reload(context.extensionPath);
    trace(`EMAIL:ACCOUNTS:SAVE count=${(accounts || []).length}`);
}

async function addEmailAccount(context, { provider, email, password, label }) {
    if (!EMAIL_PROVIDERS.includes(provider)) {
        throw new Error(`unknown email provider: ${provider}`);
    }
    if (!email || !password) throw new Error('email + password required');
    const accounts = getEmailAccounts(context);
    /* dedupe by (provider,email) — re-adding the same address rotates the
       stored password instead of growing the list. */
    let row = accounts.find(a => a.provider === provider && a.email.toLowerCase() === email.toLowerCase());
    if (!row) {
        row = {
            id:       _newAccountId(),
            label:    label || email,
            provider, email,
            addedAt:  new Date().toISOString(),
        };
        accounts.push(row);
    } else if (label) {
        row.label = label;
    }
    setEmailAccounts(context, accounts);
    await context.secrets.store(EMAIL_SECRET_PREFIX + row.id + '.password', password);
    trace(`EMAIL:ACCOUNT:ADD id=${row.id} provider=${provider} email=${email}`);
    return row;
}

async function removeEmailAccount(context, accountId) {
    const accounts = getEmailAccounts(context);
    const next = accounts.filter(a => a.id !== accountId);
    setEmailAccounts(context, next);
    try { await context.secrets.delete(EMAIL_SECRET_PREFIX + accountId + '.password'); }
    catch (e) { /* secret may not exist — fine */ }
    trace(`EMAIL:ACCOUNT:REMOVE id=${accountId}`);
}

async function getEmailPassword(context, accountId) {
    return (await context.secrets.get(EMAIL_SECRET_PREFIX + accountId + '.password')) || null;
}

/* Seed an email account from config.ini [email] if no email_accounts exist
   yet. Lets the user keep credentials in config.ini (project convention,
   confirmed by user 2026-05-24 — same pattern as [api_keys]) while the
   running extension still reads passwords from vscode.secrets at call
   time. Idempotent + gated by globalState so it only runs once per install. */
const EMAIL_SEED_FLAG = 'emailAccountsSeeded_v1';

/* Bulk-seed every email the user owns into the email_accounts list so the
   Email panel's account dropdown lists all 11 from the moment the panel
   opens. Source of truth = ALL_GMAILS + EXTRA_CLAUDE_EMAILS (the user's
   full address roster, used for IMAP magic-link reading / email features).
   addEmailAccount dedupes by (provider,email) so this is safe to re-run.
   Provider is inferred from the address: *@gmail.com → gmail (workspace
   Gmail addresses like admin@acquisitioninvest.com also map to gmail
   because that's the IMAP server they actually use), *@yahoo.com → yahoo,
   *@hotmail.com / *@outlook.com / *@live.com → outlook. Password starts
   at DEFAULT_BRIDGE_PASSWORD — the user rotates from there in the panel. */
/* Bumped to v2 on 2026-05-24 when EMAIL_APP_PASSWORDS landed — the v1 seed
   had stamped every gmail/yahoo row with DEFAULT_BRIDGE_PASSWORD, which
   Google/Yahoo's IMAP rejects with "Application-specific password
   required". v2 re-runs the seed so addresses with an override pick up
   their real app password; addEmailAccount dedupes by (provider,email) so
   the row count stays the same. */
const EMAIL_BULK_SEED_FLAG = 'emailAccountsBulkSeeded_v2';

/* Per-address IMAP password overrides. Gmail + Yahoo no longer accept the
   regular account password for IMAP — each address needs an "app password"
   (16-char string from accounts.google.com → Security → 2FA → App
   passwords, or login.yahoo.com → Account info → Generate app password).
   Two Gmail app passwords found in the user's existing infra
   (admin@acquisitioninvest.com from /home/acquisitioninvest.com/config.php
   + tristate.digital cms config; trenttompkins@gmail.com from
   C:\TrioDesktop\config.ini [smtp]). Addresses not listed fall back to
   DEFAULT_BRIDGE_PASSWORD — they'll show in the dropdown but IMAP will
   fail until the user generates app passwords and rotates them in the
   panel. */
const EMAIL_APP_PASSWORDS = {
    'trenttompkins@gmail.com':        'mtnxqiwnyjeoqwbo',
    'admin@acquisitioninvest.com':    'aljwhrgbouirjfow',
    /* TODO once user generates them: fullpriceexit@gmail.com,
       fidiumpa@gmail.com, flopcoinai@gmail.com, acquisitioninvest@gmail.com,
       corey.pletcher@gmail.com, fullpriceexit@yahoo.com, tibberous@yahoo.com,
       tibberous@hotmail.com, acquisitioninvest@yahoo.com */
};

async function seedAllEmailAccounts(context) {
    try {
        if (context.globalState.get(EMAIL_BULK_SEED_FLAG)) return;
        const WORKSPACE_GMAIL_DOMAINS = new Set([
            'acquisitioninvest.com',
            /* add more Google-Workspace-backed domains here as needed */
        ]);
        const pickProvider = (addr) => {
            const dom = (addr.split('@')[1] || '').toLowerCase();
            if (dom === 'gmail.com' || WORKSPACE_GMAIL_DOMAINS.has(dom)) return 'gmail';
            if (dom === 'yahoo.com')                                     return 'yahoo';
            if (dom === 'hotmail.com' || dom === 'outlook.com' ||
                dom === 'live.com')                                      return 'outlook';
            return null;
        };
        let added = 0;
        for (const addr of [...ALL_GMAILS, ...EXTRA_CLAUDE_EMAILS]) {
            const provider = pickProvider(addr);
            if (!provider) { trace(`EMAIL:BULK_SEED:SKIP unknown provider for ${addr}`); continue; }
            const password = EMAIL_APP_PASSWORDS[addr.toLowerCase()] || DEFAULT_BRIDGE_PASSWORD;
            try {
                await addEmailAccount(context, {
                    provider, email: addr, password, label: addr,
                });
                added++;
            } catch (e) {
                traceErr(`EMAIL:BULK_SEED:ADD ${addr}`, e);
            }
        }
        await context.globalState.update(EMAIL_BULK_SEED_FLAG, true);
        trace(`EMAIL:BULK_SEED ok added=${added} total=${getEmailAccounts(context).length}`);
    } catch (err) {
        traceErr('seedAllEmailAccounts', err);
    }
}

async function seedEmailAccountsFromConfigIni(context) {
    try {
        if (context.globalState.get(EMAIL_SEED_FLAG)) return;
        if (getEmailAccounts(context).length > 0) {
            await context.globalState.update(EMAIL_SEED_FLAG, true);
            return;
        }
        const cfg = readConfigIni(context.extensionPath) || {};
        const e   = cfg.email || {};
        const account  = String(e.account  || '').trim();
        const password = String(e.password || '').trim();
        if (!account || !password) return;     /* nothing to seed */
        /* Infer provider from the SMTP host so we don't have to ask. */
        const smtp = String(e.smtp_server || '').toLowerCase();
        let provider = null;
        if (smtp.includes('gmail'))           provider = 'gmail';
        else if (smtp.includes('yahoo'))      provider = 'yahoo';
        else if (smtp.includes('outlook') ||
                 smtp.includes('office365'))  provider = 'outlook';
        if (!provider) {
            trace(`EMAIL:SEED:SKIP unknown smtp_server=${smtp}`);
            return;
        }
        await addEmailAccount(context, {
            provider, email: account, password, label: account,
        });
        await context.globalState.update(EMAIL_SEED_FLAG, true);
        trace(`EMAIL:SEED ok provider=${provider} account=${account}`);
    } catch (err) {
        traceErr('seedEmailAccountsFromConfigIni', err);
    }
}

/* Spawn tools/imap_read.py to fetch the last N messages of the inbox.
   Returns the parsed { ok, count, emails:[...] } JSON. Password is passed
   via env var (IMAP_PASSWORD) — never on the argv (visible in tasklist).
   The default --extract-links regex catches claude.ai/anthropic sign-in
   magic links (the primary reason this email reader exists) plus generic
   https URLs so the user can spot any actionable link per row. */
const _DEFAULT_LINK_REGEX = 'https?://(?:claude\\.(?:ai|com)|anthropic\\.com|accounts\\.google\\.com|login\\.live\\.com|login\\.yahoo\\.com)/[^ \\"<>\\\']*';
async function fetchEmailInbox(context, accountId, { max = 30, sinceMinutes = 60 * 24 * 7, linkRegex = _DEFAULT_LINK_REGEX } = {}) {
    const acc = getEmailAccounts(context).find(a => a.id === accountId);
    if (!acc) throw new Error(`unknown email account id: ${accountId}`);
    const pw = await getEmailPassword(context, accountId);
    if (!pw) throw new Error(`no password stored for ${acc.email}`);
    const script = path.join(context.extensionPath, 'tools', 'imap_read.py');
    if (!fs.existsSync(script)) throw new Error(`imap_read.py missing at ${script}`);
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    return new Promise((resolve, reject) => {
        const proc = spawn(pyCmd, ['-3', script,
            '--provider',     acc.provider,
            '--email',        acc.email,
            '--password-env', 'IMAP_PASSWORD',
            '--since-minutes', String(sinceMinutes),
            '--max',          String(max),
            '--extract-links', linkRegex,
        ], {
            cwd: context.extensionPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, IMAP_PASSWORD: pw },
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
        proc.on('error', reject);
        proc.on('close', code => {
            const line = stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout.trim();
            try {
                const parsed = JSON.parse(line);
                resolve(parsed);
            } catch (e) {
                reject(new Error(`imap_read.py exit=${code} stderr=${stderr.slice(0,300)}`));
            }
        });
    });
}

/* Walk every configured email account on activate, fetch the 30 most-recent
   messages per account, and dump each one to <ext>/emails/<md5>.eml.
   Powers the bridge auto-login flow (scan cached inboxes for magic-link
   codes from Anthropic / Google / etc.).

   Behaviour:
   - Skips accounts whose stored password is still DEFAULT_BRIDGE_PASSWORD
     AND that have no override in EMAIL_APP_PASSWORDS (they would IMAP-fail
     noisily — login rejected with "Application-specific password required").
   - Re-uses tools/imap_read.py's new --dump-eml flag.
   - Per-account failures are logged + swallowed — one bad inbox must not
     stop the rest.
   - Designed to be fire-and-forget from activate(): caller wraps in
     setImmediate so the panel paints first.
   Returns { accounts:N, ok:N, skipped:N, failed:N, dumped:N }. */
async function cacheRecentEmails(context) {
    const cacheDir = path.join(context.extensionPath, 'emails');
    try { fs.mkdirSync(cacheDir, { recursive: true }); }
    catch (e) { traceErr('cacheRecentEmails:mkdir', e); return null; }

    const accounts = getEmailAccounts(context);
    const known    = new Set(Object.keys(EMAIL_APP_PASSWORDS).map(k => k.toLowerCase()));
    let ok = 0, skipped = 0, failed = 0, dumped = 0;

    trace(`EMAIL:CACHE start accounts=${accounts.length} dir=${cacheDir}`);

    for (const acc of accounts) {
        const lowEmail = (acc.email || '').toLowerCase();
        const hasApp   = known.has(lowEmail);
        let pw = '';
        try { pw = await getEmailPassword(context, acc.id) || ''; }
        catch (e) { /* fall through */ }

        if (!hasApp && (!pw || pw === DEFAULT_BRIDGE_PASSWORD)) {
            trace(`EMAIL:CACHE:SKIP ${acc.email} (no app-password configured)`);
            skipped++;
            continue;
        }
        if (!pw) {
            trace(`EMAIL:CACHE:SKIP ${acc.email} (no password in secrets)`);
            skipped++;
            continue;
        }

        const script = path.join(context.extensionPath, 'tools', 'imap_read.py');
        if (!fs.existsSync(script)) {
            traceErr('cacheRecentEmails', new Error(`imap_read.py missing at ${script}`));
            failed++;
            continue;
        }
        const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
        try {
            const res = await new Promise((resolve) => {
                const proc = spawn(pyCmd, ['-3', script,
                    '--provider',     acc.provider,
                    '--email',        acc.email,
                    '--password-env', 'IMAP_PASSWORD',
                    '--since-minutes', String(60 * 24 * 365 * 5), /* ~5y window — caps via --max */
                    '--max',          '30',
                    '--dump-eml',     cacheDir,
                ], {
                    cwd: context.extensionPath,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: { ...process.env, IMAP_PASSWORD: pw },
                });
                let stdout = '', stderr = '';
                proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
                proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
                proc.on('error', err => resolve({ ok: false, error: String(err) }));
                proc.on('close', code => {
                    const line = stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout.trim();
                    try { resolve(JSON.parse(line)); }
                    catch (_) { resolve({ ok: false, error: `exit=${code} stderr=${stderr.slice(0,200)}` }); }
                });
            });
            if (res && res.ok) {
                ok++;
                dumped += (res.dumped || 0);
                trace(`EMAIL:CACHE:OK ${acc.email} dumped=${res.dumped || 0} count=${res.count || 0}`);
            } else {
                failed++;
                trace(`EMAIL:CACHE:FAIL ${acc.email} ${res && res.error ? res.error : '(unknown)'}`);
            }
        } catch (e) {
            failed++;
            traceErr(`cacheRecentEmails:${acc.email}`, e);
        }
    }
    const summary = { accounts: accounts.length, ok, skipped, failed, dumped };
    trace(`EMAIL:CACHE done ${JSON.stringify(summary)}`);
    return summary;
}

/* Scan <ext>/emails/*.eml for an Anthropic magic-login link addressed to
   `emailAddress`, optionally fetch (consume) the newest match to obtain a
   claude.ai session cookie. Powers the [[codexBlackEd.email.consumeMagicLink]]
   command and the Claude.ai-Subscription auto-login shortcut on the
   /switch auth picker.

   IMPORTANT: --fetch consumes the magic-link token (claude.ai marks it
   used). We never auto-fire on activate — only on explicit user trigger.

   opts: { fetch:bool=false, max:int=10 }
   Returns the parsed JSON payload from tools/anthropic_magic_link.py,
   plus we side-effect-write the cookies to
       <ext>/emails/<emailAddress>.claude-cookies.json
   when fetch succeeds (v1 cut — bridge profile cookie-jar import lands
   in a follow-up). */
async function findAndConsumeClaudeMagicLink(context, emailAddress, opts = {}) {
    const { fetch = false, max = 10 } = opts;
    const cacheDir = path.join(context.extensionPath, 'emails');
    const script   = path.join(context.extensionPath, 'tools', 'anthropic_magic_link.py');
    if (!fs.existsSync(script)) {
        throw new Error(`anthropic_magic_link.py missing at ${script}`);
    }
    if (!fs.existsSync(cacheDir)) {
        return { matches: [], note: 'no emails cache yet (cacheRecentEmails has not run)' };
    }
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    const args  = ['-3', script, '--eml-dir', cacheDir, '--max', String(max)];
    if (emailAddress) args.push('--for-email', emailAddress);
    if (fetch)        args.push('--fetch');

    const result = await new Promise((resolve) => {
        const proc = spawn(pyCmd, args, {
            cwd: context.extensionPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
        proc.on('error', err => resolve({ ok: false, error: String(err), matches: [] }));
        proc.on('close', code => {
            // Pick the first { ... } block in stdout (the script also prints
            // human-readable diagnostics on stderr).
            const start = stdout.indexOf('{');
            const end   = stdout.lastIndexOf('}');
            if (start < 0 || end < start) {
                resolve({ ok: false, error: `exit=${code} stderr=${stderr.slice(0, 200)}`, matches: [] });
                return;
            }
            try {
                const payload = JSON.parse(stdout.slice(start, end + 1));
                payload.ok = true;
                resolve(payload);
            } catch (e) {
                resolve({ ok: false, error: `bad JSON: ${e.message}`, matches: [] });
            }
        });
    });

    // Side-effect: dump cookies to disk on successful fetch so a future
    // bridge launch can pick them up. v1 cut — proper Cookies.db import
    // into bridge_profiles/claude/ lands in a follow-up.
    if (fetch && result && result.fetched && result.fetched.ok) {
        try {
            const slug = (emailAddress || result.fetched.email || 'unknown')
                .toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
            const outFile = path.join(cacheDir, `${slug}.claude-cookies.json`);
            fs.writeFileSync(outFile, JSON.stringify({
                email:     result.fetched.email,
                token:     result.fetched.token,
                status:    result.fetched.status,
                final_url: result.fetched.final_url,
                cookies:   result.fetched.cookies,
                consumedAt: new Date().toISOString(),
            }, null, 2), 'utf8');
            result.cookieFile = outFile;
            trace(`EMAIL:MAGIC consumed token=${result.fetched.token} email=${result.fetched.email} -> ${outFile}`);
        } catch (e) {
            traceErr('findAndConsumeClaudeMagicLink:writeCookies', e);
        }
    }
    return result;
}

/* Spawn tools/email_watch.py — long-poll an inbox until a matching message
   arrives, then return { ok, found, links, ... }. Designed for the bridge
   magic-link flow: extension shells out, gets the claude.ai sign-in URL
   back, navigates the bridge browser to it. opts: { fromFilter, subjectFilter,
   linkRegex, intervalSec, timeoutSec }. */
async function watchEmailInbox(context, accountId, {
    fromFilter = '', subjectFilter = '', linkRegex = '',
    intervalSec = 5, timeoutSec = 300,
} = {}) {
    const acc = getEmailAccounts(context).find(a => a.id === accountId);
    if (!acc) throw new Error(`unknown email account id: ${accountId}`);
    const pw = await getEmailPassword(context, accountId);
    if (!pw) throw new Error(`no password stored for ${acc.email}`);
    const script = path.join(context.extensionPath, 'tools', 'email_watch.py');
    if (!fs.existsSync(script)) throw new Error(`email_watch.py missing at ${script}`);
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    const args = ['-3', script,
        '--provider',     acc.provider,
        '--email',        acc.email,
        '--password-env', 'IMAP_PASSWORD',
        '--interval',     String(intervalSec),
        '--timeout',      String(timeoutSec),
    ];
    if (fromFilter)    args.push('--from-filter',    fromFilter);
    if (subjectFilter) args.push('--subject-filter', subjectFilter);
    if (linkRegex)     args.push('--extract-links',  linkRegex);
    return new Promise((resolve, reject) => {
        const proc = spawn(pyCmd, args, {
            cwd: context.extensionPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, IMAP_PASSWORD: pw },
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
        proc.on('error', reject);
        proc.on('close', code => {
            const line = stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout.trim();
            try { resolve(JSON.parse(line)); }
            catch (e) { reject(new Error(`email_watch.py exit=${code} stderr=${stderr.slice(0,300)}`)); }
        });
    });
}

/* Spawn tools/smtp_send.py. opts: { to, cc?, bcc?, subject, body, bodyHtml?, attach? }. */
async function sendEmail(context, accountId, opts) {
    const acc = getEmailAccounts(context).find(a => a.id === accountId);
    if (!acc) throw new Error(`unknown email account id: ${accountId}`);
    const pw = await getEmailPassword(context, accountId);
    if (!pw) throw new Error(`no password stored for ${acc.email}`);
    const script = path.join(context.extensionPath, 'tools', 'smtp_send.py');
    if (!fs.existsSync(script)) throw new Error(`smtp_send.py missing at ${script}`);
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    const args = ['-3', script,
        '--provider',     acc.provider,
        '--email',        acc.email,
        '--password-env', 'SMTP_PASSWORD',
        '--to',           String(opts.to || ''),
        '--subject',      String(opts.subject || ''),
    ];
    if (opts.cc)       args.push('--cc',       String(opts.cc));
    if (opts.bcc)      args.push('--bcc',      String(opts.bcc));
    if (opts.body)     args.push('--body',     String(opts.body));
    if (opts.bodyHtml) args.push('--body-html', String(opts.bodyHtml));
    for (const p of (opts.attach || [])) args.push('--attach', String(p));
    return new Promise((resolve, reject) => {
        const proc = spawn(pyCmd, args, {
            cwd: context.extensionPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, SMTP_PASSWORD: pw },
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
        proc.on('error', reject);
        proc.on('close', code => {
            const line = stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout.trim();
            try { resolve(JSON.parse(line)); }
            catch (e) { reject(new Error(`smtp_send.py exit=${code} stderr=${stderr.slice(0,300)}`)); }
        });
    });
}

/* ── seedDefaultAccounts ─────────────────────────────────────────────────
   One-shot pre-population of the user's known accounts. Runs ONCE per
   install, gated by globalState['accountsSeeded_v2']. Idempotent at the
   row level too: we never duplicate an existing row (matched by email for
   bridges, matched by existing row for api_key providers we only tag).

   Plan:
     - claudeBridge:  add ALL the user's emails as email_password
                      (default password DEFAULT_BRIDGE_PASSWORD).
     - chatgptBridge / grokBridge / copilotBridge / geminiBridge:
                      add ONLY primary gmail as email_password.
     - ollama / ollamaBridge: skipped (local, no account).
     - anthropic / openai / grok / gemini / deepseek / azure:
                      if an existing row has no `email`, tag it with the
                      primary gmail. Do NOT add or overwrite apiKey.

   Bridge logins drive a headless browser into the SaaS account, so they need
   a real password to type into the login form. We seed the user's standard
   password but NEVER overwrite a non-blank one — if the user (or a previous
   seed) already set a password, it is left alone. apiKeys are never touched. */
const ACCOUNTS_SEED_FLAG = 'accountsSeeded_v2';
const DEFAULT_BRIDGE_PASSWORD = '***REMOVED***';
const PRIMARY_GMAIL = 'trenttompkins@gmail.com';
const ALL_GMAILS = [
    'trenttompkins@gmail.com',
    'fullpriceexit@gmail.com',
    'admin@acquisitioninvest.com',
    'fidiumpa@gmail.com',
    'flopcoinai@gmail.com',
    'acquisitioninvest@gmail.com',
    'corey.pletcher@gmail.com',
];
/* Non-gmail addresses in the user's roster (used for IMAP magic-link
   reading / the Email panel). Name kept for historical continuity; the
   Claude browser bridge that originally consumed these is removed. */
const EXTRA_CLAUDE_EMAILS = [
    'fullpriceexit@yahoo.com',
    'tibberous@yahoo.com',
    'tibberous@hotmail.com',
    'acquisitioninvest@yahoo.com',
];

function seedDefaultAccounts(context) {
    try {
        if (context.globalState.get(ACCOUNTS_SEED_FLAG)) {
            trace('seedDefaultAccounts: already seeded — skip');
            return;
        }
        const now = new Date().toISOString();
        const seededProviders = [];

        /* Bridge providers — seed email_password rows with the default
           password. Existing rows with a blank password get backfilled; rows
           that already have a non-blank password are left untouched. */
        const bridgeSeed = {
            chatgptBridge: [PRIMARY_GMAIL],
            grokBridge:    [PRIMARY_GMAIL],
            copilotBridge: [PRIMARY_GMAIL],
            geminiBridge:  [PRIMARY_GMAIL],
        };
        for (const [pid, emails] of Object.entries(bridgeSeed)) {
            if (!PROVIDERS[pid]) continue;
            const existing = getProviderAccounts(context, pid);
            const byEmail = new Map(
                existing
                    .filter(a => (a.type || 'api_key') === 'email_password')
                    .map(a => [String(a.email || '').toLowerCase(), a])
                    .filter(([k]) => k)
            );
            let added = 0, filled = 0;
            for (const email of emails) {
                const row = byEmail.get(email.toLowerCase());
                if (row) {
                    if (!row.password) { row.password = DEFAULT_BRIDGE_PASSWORD; filled++; }
                    continue;
                }
                existing.push({
                    id: _newAccountId(),
                    type: 'email_password',
                    label: email,
                    email,
                    password: DEFAULT_BRIDGE_PASSWORD,
                    addedAt: now,
                    lastUsedAt: null,
                    disabledUntil: null,
                });
                added++;
            }
            if (added > 0 || filled > 0) {
                setProviderAccounts(context, pid, existing);
                seededProviders.push(`${pid}:+${added}/fill${filled}`);
            }
        }

        /* Direct-API providers — only TAG existing api_key rows with the
           primary gmail. Do not add new rows, do not touch apiKey. */
        const apiTagProviders = ['anthropic', 'openai', 'grok', 'gemini', 'deepseek', 'azure'];
        for (const pid of apiTagProviders) {
            if (!PROVIDERS[pid]) continue;
            const existing = getProviderAccounts(context, pid);
            let tagged = 0;
            for (const a of existing) {
                if ((a.type || 'api_key') !== 'api_key') continue;
                if (!a.email) {
                    a.email = PRIMARY_GMAIL;
                    tagged++;
                }
            }
            if (tagged > 0) {
                setProviderAccounts(context, pid, existing);
                seededProviders.push(`${pid}:tag${tagged}`);
            }
        }

        context.globalState.update(ACCOUNTS_SEED_FLAG, true);
        trace('seedDefaultAccounts: done — ' + (seededProviders.length ? seededProviders.join(' ') : '(no changes)'));
    } catch (e) {
        traceErr('seedDefaultAccounts failed', e);
    }
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
        if (!providerHasAccounts(providerId)) return;
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

/* Singleton webview for the multi-account email reader. Same pattern as
   the NN4 browser / video player panels — created lazily on first
   `codexBlackEd.openEmail` invocation, revealed on subsequent ones,
   nulled by onDidDispose so the next call rebuilds. */
let _emailPanel = null;

async function loadEmailPanelHtml(context, panel) {
    let html;
    try {
        html = fs.readFileSync(path.join(context.extensionPath, 'panel', 'email.html'), 'utf8');
    } catch (e) {
        traceErr('read email.html', e);
        panel.webview.html =
            '<html><body style="color:#d4d4d4;background:#1e1e1e;font-family:sans-serif;padding:1em;">' +
            '<h3>Email panel failed to load</h3><pre>' + String(e && e.message || e) + '</pre></body></html>';
        return;
    }
    html = html.replace(/\{\{CSP_SOURCE\}\}/g, panel.webview.cspSource || '');
    panel.webview.html = html;

    const sendAccounts = () => {
        try {
            /* hasAppPassword flag tells the panel which accounts are wired
               with a real provider app-password vs which will fail IMAP
               login with "Invalid credentials" until the user generates +
               rotates an app password. Source of truth = EMAIL_APP_PASSWORDS. */
            const knownApp = new Set(Object.keys(EMAIL_APP_PASSWORDS).map(k => k.toLowerCase()));
            const accounts = getEmailAccounts(context).map(a => ({
                id: a.id, label: a.label, provider: a.provider, email: a.email,
                hasAppPassword: knownApp.has(String(a.email || '').toLowerCase()),
            }));
            panel.webview.postMessage({ type: 'cbe-email-accounts', accounts });
        } catch (e) {
            traceErr('email panel sendAccounts', e);
            panel.webview.postMessage({ type: 'cbe-email-error', error: String(e && e.message || e) });
        }
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg !== 'object') return;
        try {
            if (msg.type === 'cbe-email-list-accounts') {
                sendAccounts();
                return;
            }
            if (msg.type === 'cbe-email-fetch-inbox') {
                const accountId = String(msg.accountId || '');
                const max       = Number(msg.max) || 30;
                if (!accountId) {
                    panel.webview.postMessage({ type: 'cbe-email-inbox', ok: false, error: 'no accountId' });
                    return;
                }
                /* If the script throws (spawn fail / py missing / Python
                   traceback) we don't want the catch-all "email panel msg"
                   handler to swallow it as a generic cbe-email-error toast
                   that the empty-list keeps stuck on "Loading…". Wrap +
                   forward the failure to the panel as a structured
                   cbe-email-inbox failure so the list renders "Fetch
                   failed" instead of an indefinite spinner. */
                let res;
                try {
                    res = await fetchEmailInbox(context, accountId, { max });
                } catch (err) {
                    res = { ok: false, error: String(err && err.message || err) };
                }
                /* Decorate auth errors with the actionable next step so the
                   panel's red banner tells the user EXACTLY what to do
                   (generate app pwd) instead of just echoing the cryptic
                   IMAP protocol message. Same pattern Gmail itself does
                   in its web UI when IMAP fails. */
                if (!res.ok && typeof res.error === 'string' &&
                    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Application-specific password required/i.test(res.error)) {
                    const acc = getEmailAccounts(context).find(a => a.id === accountId);
                    const provider = (acc && acc.provider) || 'gmail';
                    const helpUrl = {
                        gmail:   'https://myaccount.google.com/apppasswords',
                        yahoo:   'https://login.yahoo.com/account/security/app-passwords',
                        hotmail: 'https://account.live.com/proofs/AppPassword',
                        outlook: 'https://account.live.com/proofs/AppPassword',
                    }[provider] || '';
                    res.needsAppPassword = true;
                    res.helpUrl = helpUrl;
                    res.error = `IMAP rejected the saved password for ${(acc && acc.email) || 'this account'}. ` +
                                `${provider} needs an app password — generate one at ${helpUrl} ` +
                                `and re-add the account via the + button.`;
                }
                panel.webview.postMessage({ type: 'cbe-email-inbox', ...res });
                return;
            }
            if (msg.type === 'cbe-email-add-account') {
                await vscode.commands.executeCommand('codexBlackEd.email.addAccount');
                sendAccounts();
                return;
            }
            if (msg.type === 'cbe-email-open-link') {
                const url = String(msg.url || '');
                if (!url) return;
                try { await vscode.env.openExternal(vscode.Uri.parse(url)); }
                catch (e) { traceErr('cbe-email-open-link', e); }
                return;
            }
            if (msg.type === 'cbe-email-remove-account') {
                const accountId = String(msg.accountId || '');
                if (!accountId) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Remove this email account? Stored app-password will be deleted.`,
                    { modal: true }, 'Remove'
                );
                if (confirm !== 'Remove') return;
                await removeEmailAccount(context, accountId);
                sendAccounts();
                return;
            }
        } catch (e) {
            traceErr('email panel msg', e);
            panel.webview.postMessage({ type: 'cbe-email-error', error: String(e && e.message || e) });
        }
    });
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

/* ── Speech-to-Text (realtime local providers) ────────────────────────────
   Two realtime local STT providers replace the deprecated whisper-local batch
   HTTP-server path (removed 2026-05-30, was added 2026-05-26 to replace the
   PowerShell recognizer):

     whisper-cpp-stream   — ggerganov/whisper.cpp `stream` example binary,
                            fed raw PCM via stdin (Windows-first; SDL2
                            capture mode could swap in cross-platform later).
     faster-whisper-stream — Python CTranslate2 implementation w/ webrtcvad +
                            sliding window. Bootstraps a per-repo venv on
                            first use (~150MB model download).

   Both ride the SAME host-side ffmpeg dshow → subprocess → sttDeltaEl /
   sttResultEl protocol the ElevenLabs Realtime path uses
   (createElevenLabsSttSession + stt-host-stream-el.js). The shared shape
   means panel.js can dispatch on provider id and the rest of the plumbing
   composes identically.

   Models + binaries live under globalStorageUri/whisper/ (server) and
   globalStorageUri/faster-whisper/ (CT2 models). The Python venv lives at
   repo-root/venv-whisper/ (flat layout per CLAUDE.md). */
const WHISPER_DIR_NAME = 'whisper';
const WHISPER_STREAM_EXE = 'whisper-stream.exe';
const WHISPER_MODEL_NAME = 'ggml-tiny.en.bin';
/* TODO: update when release pattern changes — the GitHub Releases API gets
   parsed first; this hardcoded URL is only the fallback. The same zip ships
   main.exe / server.exe / stream.exe. */
const WHISPER_BIN_FALLBACK_URL =
    'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip';
const WHISPER_MODEL_URL =
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';

function _getWhisperDir(context) {
    const base = (context.globalStorageUri && context.globalStorageUri.fsPath) || os.tmpdir();
    const dir = path.join(base, WHISPER_DIR_NAME);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

/* HTTPS GET with redirect-follow (GitHub release assets 302 to S3, HF resolve
   /resolve/main/... 302s to cdn-lfs). Streams to disk so we can report progress
   without loading the whole binary into memory. */
function _httpsDownloadToFile(urlStr, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        const url = require('url');
        let redirects = 0;
        const MAX_REDIRECTS = 6;
        const tmp = destPath + '.part';
        const fetch = (u) => {
            const parsed = url.parse(u);
            const mod = (parsed.protocol === 'http:') ? http : https;
            const req = mod.request({
                method: 'GET',
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
                path: parsed.path,
                headers: { 'User-Agent': 'ClaudeCodexBlack/whisper-bootstrap' },
                timeout: 60000,
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (++redirects > MAX_REDIRECTS) return reject(new Error('too many redirects'));
                    res.resume();
                    return fetch(res.headers.location);
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }
                const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
                let got = 0;
                const out = fs.createWriteStream(tmp);
                res.on('data', (chunk) => {
                    got += chunk.length;
                    if (typeof onProgress === 'function') {
                        try { onProgress(got, total); } catch (_) {}
                    }
                });
                res.pipe(out);
                out.on('finish', () => out.close(() => {
                    try { fs.renameSync(tmp, destPath); resolve(destPath); }
                    catch (e) { reject(e); }
                }));
                out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
            });
            req.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.end();
        };
        fetch(urlStr);
    });
}

/* Resolve the latest whisper-bin-x64.zip download URL from GitHub. If the
   API call fails (rate-limit / no network), return the hardcoded fallback.
   Returns a Promise<string>. Same zip ships main / server / stream binaries. */
function _resolveWhisperBinUrl() {
    return new Promise((resolve) => {
        const https = require('https');
        const req = https.request({
            method: 'GET',
            hostname: 'api.github.com',
            path: '/repos/ggerganov/whisper.cpp/releases/latest',
            headers: {
                'User-Agent': 'ClaudeCodexBlack/whisper-bootstrap',
                'Accept': 'application/vnd.github+json',
            },
            timeout: 10000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return resolve(WHISPER_BIN_FALLBACK_URL);
                }
                try {
                    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const assets = (j && j.assets) || [];
                    const pick = assets.find((a) =>
                        /win|windows/i.test(a.name) && /x64|amd64/i.test(a.name) && /\.zip$/i.test(a.name)
                    ) || assets.find((a) => /\.zip$/i.test(a.name) && /win/i.test(a.name));
                    resolve((pick && pick.browser_download_url) || WHISPER_BIN_FALLBACK_URL);
                } catch (_) {
                    resolve(WHISPER_BIN_FALLBACK_URL);
                }
            });
        });
        req.on('error', () => resolve(WHISPER_BIN_FALLBACK_URL));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(WHISPER_BIN_FALLBACK_URL); });
        req.end();
    });
}

/* Locate whisper.cpp's `stream` example binary inside a freshly-unpacked zip.
   Naming has drifted across releases: `stream.exe`, `whisper-stream.exe`,
   `whisper-cli-stream.exe`. Returns the absolute path or '' if not found. */
function _findWhisperStreamExe(rootDir) {
    const stack = [rootDir];
    const candidates = /^(whisper-stream|whisper-cli-stream|stream)\.exe$/i;
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (_) { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(full); continue; }
            if (candidates.test(e.name)) return full;
        }
    }
    return '';
}

/* Extract a zip via PowerShell Expand-Archive (no third-party dep). Returns
   the directory the archive was expanded into. */
function _extractZipPS(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        const ps = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        ps.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        ps.on('error', reject);
        ps.on('close', (code) => {
            if (code === 0) resolve(destDir);
            else reject(new Error('Expand-Archive failed (exit ' + code + ') ' + stderr.trim()));
        });
    });
}

/* ── ffmpeg auto-bootstrap ─────────────────────────────────────────────────
   ffmpeg is a hard dependency for ALL voice/STT (host-side mic capture). If it
   isn't found via stt-host-capture.resolveFfmpeg() (Chocolatey candidates) nor
   on PATH, download a STATIC build into globalStorageUri/ffmpeg/ and register
   it via setFfmpegPath() — no winget, no admin, no Store; works on every
   Windows. Mirrors the whisper.cpp lazy-download. Cross-platform URLs included
   (Windows is the live path today; Linux/macOS ready for the dshow→alsa/
   avfoundation work). Best-effort: callers still fall back to the specific
   "ffmpeg not found" error if the download fails. */
const FFMPEG_DIR_NAME = 'ffmpeg';
const FFMPEG_STATIC_URLS = {
    win32:  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    linux:  'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
};

function _findFfmpegBin(dir) {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    let found = '';
    const walk = (d) => {
        if (found) return;
        let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (found) return;
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name === exe) found = full;
        }
    };
    walk(dir);
    return found;
}

let _ensureFfmpegInFlight = null;
async function ensureFfmpeg(context) {
    const cap = require(path.join(context.extensionPath || __dirname, 'stt-host-capture.js'));
    /* 1. Already a real file via the Chocolatey candidates? */
    const cur = cap.resolveFfmpeg();
    if (cur && cur !== 'ffmpeg' && fs.existsSync(cur)) return cur;
    /* 2. On PATH? */
    try {
        const r = require('child_process').spawnSync('ffmpeg', ['-version'], { windowsHide: true });
        if (r && r.status === 0) return 'ffmpeg';
    } catch (_) {}
    /* 3. Previously auto-downloaded into globalStorage? */
    const base = (context.globalStorageUri && context.globalStorageUri.fsPath) || os.tmpdir();
    const ffDir = path.join(base, FFMPEG_DIR_NAME);
    let bin = _findFfmpegBin(ffDir);
    if (bin && fs.existsSync(bin)) { cap.setFfmpegPath(bin); return bin; }
    /* 4. Download once (deduped if concurrent). */
    if (_ensureFfmpegInFlight) return _ensureFfmpegInFlight;
    _ensureFfmpegInFlight = (async () => {
        const url = FFMPEG_STATIC_URLS[process.platform];
        if (!url) throw new Error('no static ffmpeg build URL for platform ' + process.platform);
        try { fs.mkdirSync(ffDir, { recursive: true }); } catch (_) {}
        const isTar = url.endsWith('.tar.xz') || url.endsWith('.tar.gz');
        const archive = path.join(ffDir, isTar ? 'ffmpeg-dl.tar.xz' : 'ffmpeg-dl.zip');
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Downloading ffmpeg (one-time, ~80 MB)…', cancellable: false },
            async (prog) => {
                let lastPct = 0;
                await _httpsDownloadToFile(url, archive, (got, total) => {
                    if (!total) return;
                    const pct = Math.floor(got / total * 100);
                    if (pct > lastPct) { prog.report({ increment: pct - lastPct, message: pct + '%' }); lastPct = pct; }
                });
                if (isTar) {
                    const r = require('child_process').spawnSync('tar', ['-xf', archive, '-C', ffDir], { windowsHide: true });
                    if (r.status !== 0) throw new Error('tar extract failed: ' + (r.stderr || r.status));
                } else {
                    await _extractZipPS(archive, ffDir);   /* PowerShell Expand-Archive (win/mac-with-pwsh) */
                }
            }
        );
        try { fs.unlinkSync(archive); } catch (_) {}
        bin = _findFfmpegBin(ffDir);
        if (!bin) throw new Error('ffmpeg binary not found after extract under ' + ffDir);
        if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch (_) {} }
        cap.setFfmpegPath(bin);
        trace('FFMPEG:BOOTSTRAP downloaded → ' + bin);
        return bin;
    })().finally(() => { _ensureFfmpegInFlight = null; });
    return _ensureFfmpegInFlight;
}

/* Ensure whisper.cpp's stream binary + the tiny.en model are on disk. Downloads
   with a VSCode progress notification. On any failure throws — caller surfaces
   the failure to the panel as a sttResultEl error. */
async function _ensureWhisperStreamFiles(context) {
    const dir = _getWhisperDir(context);
    const streamPath = path.join(dir, WHISPER_STREAM_EXE);
    const modelPath  = path.join(dir, WHISPER_MODEL_NAME);
    const needStream = !fs.existsSync(streamPath);
    const needModel  = !fs.existsSync(modelPath);
    if (!needStream && !needModel) return { streamPath, modelPath };
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up whisper.cpp stream (one-time, ~75MB)…',
        cancellable: false,
    }, async (progress) => {
        if (needStream) {
            progress.report({ message: 'fetching whisper.cpp release…' });
            const url = await _resolveWhisperBinUrl();
            trace('whisper-cpp-stream: bin url = ' + url);
            const zipPath = path.join(dir, 'whisper-bin.zip');
            let lastPct = 0;
            await _httpsDownloadToFile(url, zipPath, (got, total) => {
                const pct = total ? Math.floor((got / total) * 100) : 0;
                if (pct - lastPct >= 5) {
                    progress.report({ message: 'binary ' + pct + '%' });
                    lastPct = pct;
                }
            });
            const extractDir = path.join(dir, '_unpack');
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
            await _extractZipPS(zipPath, extractDir);
            const found = _findWhisperStreamExe(extractDir);
            if (!found) {
                throw new Error('whisper.cpp `stream` binary not found inside the release zip. ' +
                    'The release at ' + url + ' may not bundle the stream example. ' +
                    'Build whisper.cpp from source with -DWHISPER_BUILD_EXAMPLES=ON and drop stream.exe into ' + dir);
            }
            // Move every file from the dir-containing-found into WHISPER_DIR so
            // any sibling DLLs (ggml.dll etc.) end up next to the exe.
            const srcDir = path.dirname(found);
            for (const e of fs.readdirSync(srcDir)) {
                const from = path.join(srcDir, e);
                const to = path.join(dir, e);
                try { fs.renameSync(from, to); } catch (_) {
                    try { fs.copyFileSync(from, to); } catch (_) {}
                }
            }
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
            try { fs.unlinkSync(zipPath); } catch (_) {}
            // Normalize whatever the release named it → WHISPER_STREAM_EXE.
            if (!fs.existsSync(streamPath)) {
                for (const cand of ['stream.exe', 'whisper-cli-stream.exe']) {
                    const alt = path.join(dir, cand);
                    if (fs.existsSync(alt)) {
                        try { fs.renameSync(alt, streamPath); } catch (_) {}
                        break;
                    }
                }
            }
            if (!fs.existsSync(streamPath)) {
                throw new Error(WHISPER_STREAM_EXE + ' missing after extract');
            }
        }
        if (needModel) {
            progress.report({ message: 'fetching ggml-tiny.en.bin (~75MB)…' });
            let lastPct = 0;
            await _httpsDownloadToFile(WHISPER_MODEL_URL, modelPath, (got, total) => {
                const pct = total ? Math.floor((got / total) * 100) : 0;
                if (pct - lastPct >= 2) {
                    progress.report({ message: 'model ' + pct + '%' });
                    lastPct = pct;
                }
            });
        }
        return { streamPath, modelPath };
    });
}

/* ── faster-whisper Python venv ───────────────────────────────────────────
   Bootstrap a per-repo venv at repo-root/venv-whisper/ on first use. Uses
   resources/python/python.exe if present (CBE ships its own Python), else
   falls back to system `python3`/`python`. Installs faster-whisper +
   webrtcvad + numpy. The CT2 model downloads at first transcribe via
   WhisperModel(...) into globalStorageUri/faster-whisper/.

   Idempotent: subsequent calls notice the marker file and short-circuit. */
const FASTER_WHISPER_VENV_DIR_NAME = 'venv-whisper';
const FASTER_WHISPER_VENV_MARKER = '.ready';
const FASTER_WHISPER_MODEL_DIR_NAME = 'faster-whisper';

function _getFasterWhisperVenvDir() {
    /* Flat layout per CLAUDE.md — venv lives at repo root. extensionContext is
       populated by activate(); we resolve relative to the extension path. */
    const base = (extensionContext && extensionContext.extensionPath) || __dirname;
    return path.join(base, FASTER_WHISPER_VENV_DIR_NAME);
}
function _getFasterWhisperModelDir(context) {
    const base = (context.globalStorageUri && context.globalStorageUri.fsPath) || os.tmpdir();
    const dir = path.join(base, FASTER_WHISPER_MODEL_DIR_NAME);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}
function _findSystemPython() {
    /* Prefer CBE's bundled CPython if present (matches PyEncoder convention),
       else system python. */
    const bundled = path.join(
        (extensionContext && extensionContext.extensionPath) || __dirname,
        'resources', 'python', process.platform === 'win32' ? 'python.exe' : 'python'
    );
    if (fs.existsSync(bundled)) return bundled;
    return (process.platform === 'win32') ? 'python.exe' : 'python3';
}
function _getFasterWhisperPython() {
    const venv = _getFasterWhisperVenvDir();
    return (process.platform === 'win32')
        ? path.join(venv, 'Scripts', 'python.exe')
        : path.join(venv, 'bin', 'python');
}

/* Run a child process and resolve { code, stdout, stderr }. Used by venv
   bootstrap so we can surface pip errors verbatim. */
function _runCapture(exe, args, opts) {
    return new Promise((resolve) => {
        let proc;
        try { proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) }); }
        catch (e) { resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e) }); return; }
        let so = ''; let se = '';
        proc.stdout.on('data', (d) => { so += d.toString('utf8'); });
        proc.stderr.on('data', (d) => { se += d.toString('utf8'); });
        proc.on('error', (e) => resolve({ code: -1, stdout: so, stderr: se + String((e && e.message) || e) }));
        proc.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout: so, stderr: se }));
    });
}

async function _ensureFasterWhisperVenv() {
    const venv = _getFasterWhisperVenvDir();
    const marker = path.join(venv, FASTER_WHISPER_VENV_MARKER);
    const py = _getFasterWhisperPython();
    if (fs.existsSync(marker) && fs.existsSync(py)) return py;
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up faster-whisper venv (~150MB download, one-time)…',
        cancellable: false,
    }, async (progress) => {
        if (!fs.existsSync(py)) {
            progress.report({ message: 'creating venv…' });
            const sysPy = _findSystemPython();
            trace('faster-whisper: creating venv with ' + sysPy + ' → ' + venv);
            const create = await _runCapture(sysPy, ['-m', 'venv', venv]);
            if (create.code !== 0 || !fs.existsSync(py)) {
                throw new Error('venv creation failed (exit ' + create.code + '): ' + (create.stderr || create.stdout).slice(0, 400).trim());
            }
        }
        progress.report({ message: 'upgrading pip…' });
        await _runCapture(py, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip']);
        progress.report({ message: 'installing faster-whisper + webrtcvad + numpy…' });
        /* setuptools<81 is REQUIRED: webrtcvad 2.0.10 does `import pkg_resources`
           at module load, but setuptools 81+ removed pkg_resources. With a modern
           setuptools (the default in fresh Python 3.12+ venvs) the driver crashes
           at startup with "No module named 'pkg_resources'" — which previously
           surfaced as a silent stuck "Setting up…" / no transcription. Pinning
           setuptools<81 keeps pkg_resources available for webrtcvad. */
        trace('faster-whisper: pip install setuptools<81 faster-whisper webrtcvad numpy');
        const pip = await _runCapture(py, ['-m', 'pip', 'install', '--quiet', 'setuptools<81', 'faster-whisper', 'webrtcvad', 'numpy']);
        if (pip.code !== 0) {
            throw new Error('pip install failed (exit ' + pip.code + '): ' + (pip.stderr || pip.stdout).slice(0, 800).trim());
        }
        /* Sanity-check the imports the driver needs BEFORE writing the .ready
           marker — otherwise a broken venv (e.g. a stray modern setuptools that
           shadows the pin, a missing CT2 wheel) is cached as "ready" and every
           later mic click silent-fails. Surface the real ImportError instead. */
        progress.report({ message: 'verifying imports…' });
        const verify = await _runCapture(py, ['-c', 'import pkg_resources, webrtcvad, numpy; from faster_whisper import WhisperModel']);
        if (verify.code !== 0) {
            throw new Error('faster-whisper venv import check failed (exit ' + verify.code + '): ' + (verify.stderr || verify.stdout).slice(0, 800).trim());
        }
        try { fs.writeFileSync(marker, new Date().toISOString()); } catch (_) {}
        trace('faster-whisper: venv ready at ' + venv);
        return py;
    });
}

/* ── Anthropic streaming STT (Deepgram Nova-3 proxy) ───────────────────────
   Reverse-engineered from the official anthropic.claude-code bundle. The
   endpoint is a WebSocket that proxies Deepgram Nova-3, tuned with IDE
   keyterms, and is gated to Claude Code OAuth tokens (NOT api03 API keys —
   those get 1008). Because it rides the Claude Code login, STT is included
   with the user's Claude subscription and counts against its rate limits.

   Protocol (server→client JSON): TranscriptInterim / TranscriptText carry the
   cumulative text in `.data`; TranscriptEndpoint marks an utterance final;
   TranscriptError / error carry failures. Client→server: 'KeepAlive' (every
   8s) and 'CloseStream' to finish. Audio is raw linear16 PCM @16kHz mono sent
   as binary frames. */
const ANTHROPIC_STT_WS_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const ANTHROPIC_STT_SAMPLE_RATE = 16000;
const ANTHROPIC_STT_KEEPALIVE_MS = 8000;

/* OpenAI Realtime API — transcription subset. WebSocket endpoint with the
   `transcription` intent ('intent=transcription' lets us skip the chat /
   tool-use / TTS surface and only get conversation.item.input_audio_transcription.*
   events back). Model id verified 2026-05-29: gpt-4o-transcribe is the
   GA transcription model exposed via the Realtime session.
   Audio in: PCM16 mono. Realtime canonical rate is 24kHz; the panel emits
   linear16 @ ANTHROPIC_STT_SAMPLE_RATE (16k) so we upsample on the host
   before append. Events of interest:
     - conversation.item.input_audio_transcription.delta     (interim chunk)
     - conversation.item.input_audio_transcription.completed (final per utterance)
   Audio in events:
     - input_audio_buffer.append { audio: <base64 pcm16> }
     - input_audio_buffer.commit                              (on stop) */
const OPENAI_REALTIME_WS_URL    = 'wss://api.openai.com/v1/realtime?intent=transcription';
const OPENAI_REALTIME_SAMPLE_RATE_OUT = 24000;
const OPENAI_REALTIME_MODEL     = 'gpt-4o-transcribe';
const ANTHROPIC_STT_KEYTERMS = [
    'VS Code', 'IDE', 'webview', 'IntelliSense', 'MCP', 'symlink', 'grep',
    'regex', 'localhost', 'codebase', 'TypeScript', 'JSON', 'OAuth', 'webhook',
    'gRPC', 'dotfiles', 'subagent', 'worktree',
    /* CBE-specific additions — this extension is about Claude tooling. */
    'CBE', 'Codex Black', 'whisper.cpp', 'Deepgram', 'Anthropic',
];

/* Split a user-supplied custom-dictionary string into individual terms. Accepts
   commas and/or newlines as separators (the textarea hint says either works). */
function _splitDictionaryTerms(s) {
    return String(s || '')
        .split(/[\r\n,]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

/* Read the Claude Code OAuth access token at request time (never cached — the
   CLI refreshes it in place). Returns the bearer token or throws a helpful
   error if missing / expired. */
function _readClaudeOAuthToken() {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    let raw;
    try {
        raw = fs.readFileSync(credPath, 'utf8');
    } catch (e) {
        throw new Error('not logged into Claude Code (no ~/.claude/.credentials.json) — run Claude Code login first');
    }
    let oauth;
    try {
        oauth = (JSON.parse(raw) || {}).claudeAiOauth;
    } catch (e) {
        throw new Error('~/.claude/.credentials.json is unreadable');
    }
    const tok = oauth && oauth.accessToken;
    if (!tok) throw new Error('no Claude Code OAuth token found — re-login to Claude Code');
    if (oauth.expiresAt && oauth.expiresAt <= Date.now()) {
        throw new Error('Claude Code login expired — re-login (or reopen Claude Code to refresh)');
    }
    return tok;
}

/* Decode arbitrary recorded audio (webm/opus, wav, m4a…) to raw linear16 PCM
   @16kHz mono via ffmpeg, which the WS endpoint expects. Resolves a Buffer. */
function _toPcm16kMono(buf) {
    return new Promise((resolve, reject) => {
        let ff;
        try {
            ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0', '-ar', String(ANTHROPIC_STT_SAMPLE_RATE),
                '-ac', '1', '-f', 's16le', 'pipe:1'], { windowsHide: true });
        } catch (e) {
            reject(new Error('ffmpeg not available for PCM conversion: ' + (e.message || e)));
            return;
        }
        const out = [];
        let errTxt = '';
        ff.stdout.on('data', (d) => out.push(d));
        ff.stderr.on('data', (d) => { errTxt += d.toString(); });
        ff.on('error', (e) => reject(new Error('ffmpeg spawn failed (is it on PATH?): ' + (e.message || e))));
        ff.on('close', (code) => {
            if (code !== 0) { reject(new Error('ffmpeg exit ' + code + ': ' + errTxt.slice(0, 200))); return; }
            const pcm = Buffer.concat(out);
            if (!pcm.length) { reject(new Error('ffmpeg produced 0 PCM bytes')); return; }
            resolve(pcm);
        });
        ff.stdin.on('error', () => {});   /* ignore EPIPE if ffmpeg bails early */
        ff.stdin.write(buf);
        ff.stdin.end();
    });
}

/* Open ONE live Anthropic STT WebSocket session. This is the single source of
   truth for the WS protocol (URL/params/headers/keepalive/parse/close) — both
   the request/response path (handleAnthropicStt, which feeds it a complete
   ffmpeg-decoded clip) and the live-streaming path (sttStream* handlers, which
   feed it raw PCM chunks straight off the mic) ride on top of it.

   Callbacks:
     onPartial(text)  cumulative interim transcript (TranscriptInterim/Text .data)
     onFinal(text)    the full committed transcript on clean close / utterance end
     onError(err)     fatal error (auth, server, transport). onFinal won't also fire.

   Returns { sendPcm(buf), close() }:
     sendPcm(buf)  queue a raw linear16 PCM @16k mono chunk. Buffered until the
                   WS is OPEN, then flushed in order. Safe to call before open.
     close()       send CloseStream so the server flushes its final transcript,
                   then let the WS close naturally (onFinal fires on close).

   The session DOES NOT pace audio — callers decide cadence. Live mic input is
   already real-time; the request/response wrapper paces a stored clip itself. */
function createAnthropicSttSession({ onPartial, onFinal, onError, keyterms, language } = {}) {
    const token = _readClaudeOAuthToken();   /* throws if not logged in / expired */
    const WebSocket = require('ws');

    /* Custom dictionary terms (Settings → Speech to Text → "Keyterms") are
       appended to the built-in IDE keyterm list so the user's names / jargon
       bias recognition. dedupe + cap so a pathological list can't blow the URL. */
    const extraTerms = Array.isArray(keyterms)
        ? keyterms.map(t => String(t || '').trim()).filter(Boolean)
        : [];
    const allTerms = [];
    const seen = new Set();
    for (const t of ANTHROPIC_STT_KEYTERMS.concat(extraTerms)) {
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        allTerms.push(t);
        if (allTerms.length >= 200) break;
    }
    /* Language: a sanitized BCP-47 tag overrides the default 'en'. */
    const lang = (typeof language === 'string' && language.trim())
        ? language.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) || 'en'
        : 'en';

    const params = new URLSearchParams({
        encoding: 'linear16', sample_rate: String(ANTHROPIC_STT_SAMPLE_RATE),
        channels: '1', endpointing_ms: '300', utterance_end_ms: '1000',
        language: lang, use_conversation_engine: 'true', stt_provider: 'deepgram-nova3',
    });
    for (const k of allTerms) params.append('keyterms', k);

    const ws = new WebSocket(`${ANTHROPIC_STT_WS_URL}?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-app': 'vscode' } });

    let keepalive = null;
    let latest = '';            /* cumulative in-progress interim text */
    let finalText = '';         /* committed on each TranscriptEndpoint */
    let settled = false;        /* onFinal/onError fired exactly once */
    let closeRequested = false; /* caller asked to finish — send CloseStream */
    const pending = [];         /* PCM chunks queued before WS open */

    const cleanup = () => { if (keepalive) { clearInterval(keepalive); keepalive = null; } };
    const fullText = () => [finalText, latest].filter(Boolean).join(' ').trim();
    const fail = (err) => {
        if (settled) return;
        settled = true; cleanup();
        try { ws.close(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return;
        settled = true; cleanup();
        /* Combine committed utterances with any trailing interim that arrived
           after the last TranscriptEndpoint — returning only one drops the tail. */
        if (typeof onFinal === 'function') { try { onFinal(fullText()); } catch (_) {} }
    };

    ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
        keepalive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, ANTHROPIC_STT_KEEPALIVE_MS);
        /* Flush anything queued before the socket opened, in order. */
        while (pending.length) { try { ws.send(pending.shift()); } catch (_) {} }
        /* If close() was called before we opened, finish now. */
        if (closeRequested) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {} }
    });

    ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        switch (m.type) {
            case 'TranscriptInterim':
            case 'TranscriptText':
                if (m.data) { latest = m.data; if (typeof onPartial === 'function') { try { onPartial(latest); } catch (_) {} } }
                break;
            case 'TranscriptEndpoint':
                if (latest) { finalText = finalText ? (finalText + ' ' + latest) : latest; latest = ''; }
                break;
            case 'TranscriptError':
                fail(new Error('anthropic STT: ' + (m.description || 'transcription error'))); break;
            case 'error':
                fail(new Error('anthropic STT: ' + (m.message || 'server error'))); break;
        }
    });

    ws.on('error', (e) => {
        const mm = /Unexpected server response: (\d+)/.exec(e.message || '');
        const code = mm ? Number(mm[1]) : 0;
        if (code === 401 || code === 403) fail(new Error('anthropic STT: not authorized — Claude Code login may be expired'));
        else fail(new Error('anthropic STT WS error: ' + (e.message || e)));
    });

    ws.on('close', (code, reason) => {
        if (code === 1008 || /authorization/i.test(String(reason || ''))) {
            fail(new Error('anthropic STT: invalid authorization (Claude Code OAuth token rejected) — re-login to Claude Code'));
            return;
        }
        succeed();   /* clean close — emit whatever we collected */
    });

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            if (ws.readyState === WebSocket.OPEN) { try { ws.send(buf); } catch (_) {} }
            else pending.push(buf);   /* will flush on open */
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {} }
            /* If not yet open, the open handler sends CloseStream after flush. */
        },
    };
}

/* Transcribe a COMPLETE audio buffer via Anthropic's streaming STT WS
   (request/response mode). Decodes the clip to PCM with ffmpeg, then paces it
   through a createAnthropicSttSession at ~real time. onPartial(text) is called
   with cumulative interims if provided; always resolves with the final
   transcript. Shares the WS protocol with the live path — no duplication. */
async function handleAnthropicStt(context, buf, mime, onPartial) {
    const pcm = await _toPcm16kMono(buf);

    return new Promise((resolve, reject) => {
        let session;
        try {
            session = createAnthropicSttSession({
                onPartial: (t) => { if (typeof onPartial === 'function') { try { onPartial(t); } catch (_) {} } },
                onFinal: (t) => { clearTimeout(hard); resolve(t); },
                onError: (e) => { clearTimeout(hard); reject(e); },
            });
        } catch (e) { reject(e); return; }

        /* The endpoint proxies Deepgram, which transcribes at ~real time. Pace
           audio at ~real time and only close() once it's all sent, or the
           server finalizes early and truncates. Scale the hard timeout to the
           clip length + processing/close grace. */
        const durationSec = pcm.length / 2 / ANTHROPIC_STT_SAMPLE_RATE;
        const hard = setTimeout(() => { try { session.close(); } catch (_) {} reject(new Error('anthropic STT timeout')); },
            Math.max(30000, Math.ceil(durationSec * 1300) + 8000));

        /* Real-time pacing: 100ms of audio per 100ms tick. CHUNK =
           16000 samples * 2 bytes * 0.1s = 3200. After the last chunk,
           close() sends CloseStream so the server flushes its transcript. */
        const CHUNK = 3200;
        let i = 0;
        const pump = () => {
            if (i >= pcm.length) { try { session.close(); } catch (_) {} return; }
            session.sendPcm(pcm.slice(i, i + CHUNK));
            i += CHUNK;
            setTimeout(pump, 100);
        };
        pump();
    });
}

/* ── Live STT streaming (raw PCM straight off the mic) ─────────────────────
   The panel captures raw linear16 @16k mono via the Web Audio API and streams
   it in ~100ms chunks. We keep one createAnthropicSttSession per reqId so the
   stop message can resolve the right one. Partials/final flow back to the
   panel as { type:'sttPartial'|'sttFinal', reqId, text }. */
const _activeSttStreams = new Map();   /* reqId -> { session } */

/* Open ONE live OpenAI Realtime STT WebSocket session. Mirrors the shape of
   createAnthropicSttSession so the sttStream* dispatch can treat them
   interchangeably.

   Wire:
     1. open WS → send session.update with input_audio_format=pcm16 +
        input_audio_transcription.model=gpt-4o-transcribe + server_vad turn
        detection (so the model commits utterances itself without a chat loop)
     2. caller pushes linear16 16kHz PCM via sendPcm(buf); we upsample to 24kHz
        (zero-order hold, cheap, no extra deps) and base64-encode each chunk
        as input_audio_buffer.append
     3. server emits conversation.item.input_audio_transcription.delta (partial)
        and .completed (final) events; we accumulate
     4. on close() we send input_audio_buffer.commit + response.create-free
        close cleanly. The close handler resolves onFinal with whatever we got.

   Note: we deliberately set modalities=['text'] in session.update so the
   Realtime server doesn't try to stream voice/text response back — we just
   want raw STT. NO function calls, NO chat content, NO TTS. */
function createOpenAiRealtimeSttSession({ onPartial, onFinal, onError, apiKey, dictionary, language } = {}) {
    if (!apiKey) throw new Error('no openai api key configured');
    const WebSocket = require('ws');

    /* Optional bias text: feed the dictionary as the transcription `prompt`,
       same way the batch /v1/audio/transcriptions path does (handleSttRequest). */
    const promptBias = (typeof dictionary === 'string' && dictionary.trim())
        ? dictionary.slice(0, 4096)
        : '';
    const lang = (typeof language === 'string' && language.trim())
        ? language.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16)
        : '';

    const ws = new WebSocket(OPENAI_REALTIME_WS_URL, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    /* Accumulators. The Realtime transcription stream emits per-item deltas
       (one item == one user utterance, terminated by server VAD). We keep
       `committedText` (sum of .completed transcripts) + `liveText` (current
       in-progress delta buffer keyed by item_id). onPartial gets the joined
       view so the panel can replace the live region as words grow. */
    let committedText = '';
    const liveByItem = new Map();     /* item_id -> in-progress delta text */
    let settled = false;              /* onFinal/onError fired exactly once */
    let closeRequested = false;
    const pending = [];               /* base64 chunks queued before WS open */

    const buildView = () => {
        const live = Array.from(liveByItem.values()).join(' ').trim();
        return [committedText, live].filter(Boolean).join(' ').trim();
    };
    const emitPartial = () => {
        if (typeof onPartial === 'function') {
            try { onPartial(buildView()); } catch (_) {}
        }
    };
    const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return;
        settled = true;
        if (typeof onFinal === 'function') { try { onFinal(buildView()); } catch (_) {} }
    };

    /* Linear16 16k -> 24k upsample. Zero-order hold (sample-and-hold) at the
       3:2 ratio: every 2 input samples produce 3 output samples (s0, s0, s1).
       Cheap, no FFT dep, fine for speech recognition (Realtime decodes back
       down to mel anyway). buf is Buffer of int16 LE PCM @ 16kHz mono. */
    const upsample16kTo24k = (buf) => {
        if (!buf || !buf.length) return Buffer.alloc(0);
        const inCount = buf.length >>> 1;           /* int16 samples */
        if (inCount < 2) return buf;
        const pairCount = inCount >>> 1;            /* whole 16k pairs */
        const out = Buffer.allocUnsafe(pairCount * 3 * 2);   /* 3 samples per pair */
        let oi = 0;
        for (let i = 0; i < pairCount; i++) {
            const s0 = buf.readInt16LE(i * 4);
            const s1 = buf.readInt16LE(i * 4 + 2);
            out.writeInt16LE(s0, oi); oi += 2;
            out.writeInt16LE(s0, oi); oi += 2;
            out.writeInt16LE(s1, oi); oi += 2;
        }
        return out;
    };

    ws.on('open', () => {
        /* Configure the transcription session. We disable audio out + tools and
           only ask for text + STT events. server_vad lets the model decide when
           an utterance ends; without it we'd never get .completed. */
        try {
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    modalities: ['text'],
                    input_audio_format: 'pcm16',
                    input_audio_transcription: Object.assign(
                        { model: OPENAI_REALTIME_MODEL },
                        promptBias ? { prompt: promptBias } : {},
                        lang ? { language: lang } : {},
                    ),
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                    },
                },
            }));
        } catch (_) {}
        /* Flush queued audio. Each entry is already a base64 string of pcm16 @ 24k. */
        while (pending.length) {
            try {
                ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pending.shift() }));
            } catch (_) {}
        }
        if (closeRequested) {
            try { ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch (_) {}
        }
    });

    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        const t = m && m.type;
        if (!t) return;
        if (t === 'conversation.item.input_audio_transcription.delta') {
            /* Per-spec: { item_id, content_index, delta }. We append delta into
               the live bucket for that item so simultaneous items (rare under
               server_vad) don't trample each other. */
            const itemId = String(m.item_id || m.itemId || 'live');
            const delta  = String(m.delta || '');
            if (!delta) return;
            liveByItem.set(itemId, (liveByItem.get(itemId) || '') + delta);
            emitPartial();
            return;
        }
        if (t === 'conversation.item.input_audio_transcription.completed') {
            /* { item_id, transcript } — commit to the running committed buffer
               and drop the per-item live entry so partials reset cleanly. */
            const itemId = String(m.item_id || m.itemId || 'live');
            const finalChunk = String(m.transcript || liveByItem.get(itemId) || '').trim();
            liveByItem.delete(itemId);
            if (finalChunk) committedText = committedText ? (committedText + ' ' + finalChunk) : finalChunk;
            emitPartial();
            return;
        }
        if (t === 'error') {
            const err = (m.error && (m.error.message || m.error.code)) || 'realtime server error';
            fail(new Error('OpenAI Realtime STT: ' + err));
            return;
        }
        /* Other events (session.created, session.updated, input_audio_buffer.*
           speech_started/stopped, response.*) are no-ops for our STT-only flow. */
    });

    ws.on('error', (e) => {
        /* Auth errors surface as either an HTTP code on the upgrade or a 1008
           close — handle both. */
        const mm = /Unexpected server response: (\d+)/.exec(e && e.message || '');
        const code = mm ? Number(mm[1]) : 0;
        if (code === 401 || code === 403) {
            fail(new Error('OpenAI Realtime STT: not authorized — check [openai] api_key'));
        } else {
            fail(new Error('OpenAI Realtime WS error: ' + ((e && e.message) || e)));
        }
    });

    ws.on('close', (code, reason) => {
        if (code === 1008 || /authorization|invalid_api_key/i.test(String(reason || ''))) {
            fail(new Error('OpenAI Realtime STT: invalid authorization — re-check [openai] api_key'));
            return;
        }
        succeed();
    });

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            const up = upsample16kTo24k(buf);
            if (!up.length) return;
            const b64 = up.toString('base64');
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 })); } catch (_) {}
            } else {
                pending.push(b64);
            }
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            if (ws.readyState === WebSocket.OPEN) {
                /* Tell the server to flush whatever's left, then politely close. */
                try { ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch (_) {}
                /* Give the server ~1.5s to flush a final .completed before we
                   yank the socket. The close handler resolves onFinal regardless. */
                setTimeout(() => { try { ws.close(); } catch (_) {} }, 1500);
            }
            /* If not yet open, open handler will send commit after flushing pending. */
        },
    };
}

function handleSttStreamStart(panel, context, msg) {
    const reqId = String(msg.reqId || '');
    const provider = String(msg.provider || '');
    if (!reqId) return;
    if (_activeSttStreams.has(reqId)) return;   /* dup start — ignore */
    /* Live-streaming providers supported in this pass: anthropic + openai.
       Anything else falls back to batch via the panel's existing path. */
    if (provider !== 'anthropic' && provider !== 'openai') {
        try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: false, error: 'provider does not support live streaming', provider }); } catch (_) {}
        return;
    }
    let session;
    try {
        if (provider === 'openai') {
            const key = getProviderKey(context, 'openai');
            if (!key) throw new Error('no openai api key configured');
            /* Pull dictionary/language preferences the same way the batch path does. */
            const dictionary = (typeof msg.dictionary === 'string' && msg.dictionary)
                ? msg.dictionary
                : String(context.workspaceState.get(STATE_STT_DICTIONARY) || '');
            const language = (typeof msg.language === 'string' && msg.language)
                ? msg.language
                : String(context.workspaceState.get(STATE_STT_LANGUAGE) || '');
            session = createOpenAiRealtimeSttSession({
                apiKey: key,
                dictionary,
                language,
                onPartial: (text) => {
                    try { panel.webview.postMessage({ type: 'sttPartial', reqId, text, provider }); } catch (_) {}
                },
                onFinal: (text) => {
                    _activeSttStreams.delete(reqId);
                    try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: true, text, provider }); } catch (_) {}
                },
                onError: (err) => {
                    _activeSttStreams.delete(reqId);
                    /* Host-side trace only — the panel surfaces a generic
                       'falling back' info banner; we don't want a red banner
                       for what is silently a degraded experience. */
                    trace('openai realtime stt error: ' + ((err && err.message) || err));
                    try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: false, error: (err && err.message) || String(err), provider }); } catch (_) {}
                },
            });
        } else {
            session = createAnthropicSttSession({
                onPartial: (text) => {
                    try { panel.webview.postMessage({ type: 'sttPartial', reqId, text, provider }); } catch (_) {}
                },
                onFinal: (text) => {
                    _activeSttStreams.delete(reqId);
                    try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: true, text, provider }); } catch (_) {}
                },
                onError: (err) => {
                    _activeSttStreams.delete(reqId);
                    try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: false, error: (err && err.message) || String(err), provider }); } catch (_) {}
                },
            });
        }
    } catch (e) {
        try { panel.webview.postMessage({ type: 'sttFinal', reqId, ok: false, error: (e && e.message) || String(e), provider }); } catch (_) {}
        return;
    }
    _activeSttStreams.set(reqId, { session });
}

function handleSttStreamChunk(panel, context, msg) {
    const reqId = String(msg.reqId || '');
    const entry = _activeSttStreams.get(reqId);
    if (!entry) return;   /* stream already closed/errored */
    const b64 = String(msg.pcmB64 || '');
    if (!b64) return;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return; }
    if (buf.length) entry.session.sendPcm(buf);
}

function handleSttStreamStop(panel, context, msg) {
    const reqId = String(msg.reqId || '');
    const entry = _activeSttStreams.get(reqId);
    if (!entry) return;
    /* close() triggers CloseStream → server flushes → onFinal posts sttFinal
       and removes the entry from the map. */
    try { entry.session.close(); } catch (_) {}
}

/* ── ElevenLabs Scribe v2 Realtime (streaming WS) ─────────────────────────
   PRIMARY ElevenLabs path as of 2026-05-29 — replaces the batch
   /v1/speech-to-text POST with a live WS that streams partial transcripts as
   the user speaks (~150ms latency). The batch path (handleSttRequest) stays
   as the SILENT fallback when this WS errors / 401s.

   PROTOCOL (verified live 2026-05-30 against the v2 Realtime endpoint):
     • URL:  wss://api.elevenlabs.io/v1/speech-to-text/realtime
             (NOT /stream — that path 403s with an empty body. The real path
             is /realtime, confirmed via 101 Switching Protocols probe.)
     • Query: model_id=scribe_v2_realtime, encoding=pcm_s16le, sample_rate=16000
             ('scribe_v2_realtime' is currently the ONLY accepted model_id;
             scribe_v1 / scribe_v2 / scribe-v2-realtime all close with 1008
             invalid_request.)
     • Auth: header  xi-api-key: <key>  on the WS upgrade (server-side pattern;
             the client-side cookbook uses a single-use token instead — we're
             host-side Node so the direct header is fine).
     • Send: BINARY frames of raw PCM s16le 16kHz mono. We chunk ffmpeg stdout
             into ~200ms slices (~6.4 KB) for responsive partials.
     • Recv: JSON messages keyed by `message_type` (NOT `type` — confirmed
             from live session_started frame). Known message_types:
                {message_type:"session_started", session_id, config:{…}}
                {message_type:"partial_transcript", text:"..."}   running
                {message_type:"final_transcript",   text:"..."}   committed
                {message_type:"completed"}                        server done
                {message_type:"invalid_request", error:"..."}     1008 close
             For forward-compat we ALSO tolerate `type` (old shape) and
             {is_final:true|false, text:"..."} / bare {text:"..."}.
     • End:  send JSON {"type":"end_of_stream"} → wait briefly for completed →
             close socket. */
const ELEVENLABS_STT_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const ELEVENLABS_STT_MODEL_ID = 'scribe_v2_realtime';
const ELEVENLABS_STT_SAMPLE_RATE = 16000;

/* Open a Scribe v2 Realtime WS session. Mirrors createAnthropicSttSession's
   shape so callers compose identically: sendPcm(buf), close(), and
   onPartial/onFinal/onError callbacks. Caller supplies the api key — we don't
   re-read config.ini here so the host-handler can decide WHICH key to use
   (workspace config takes precedence over the file). */
function createElevenLabsSttSession({ apiKey, onPartial, onFinal, onError } = {}) {
    if (!apiKey) throw new Error('no [elevenlabs] api_key in config.ini');

    const WebSocket = require('ws');
    /* v32.12 — protocol fixed against canonical spec at
       https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
       Param names were wrong before (encoding/sample_rate instead of audio_format),
       and no commit_strategy=vad meant the server never auto-committed → no
       partials flowing through. */
    const params = new URLSearchParams({
        model_id: ELEVENLABS_STT_MODEL_ID,
        audio_format: 'pcm_16000',          /* matches sample_rate 16000 */
        commit_strategy: 'vad',             /* server auto-commits on silence */
        vad_silence_threshold_secs: '0.6',  /* tighter than default 1.5s for snappier finals */
    });
    const ws = new WebSocket(`${ELEVENLABS_STT_WS_URL}?${params.toString()}`,
        { headers: { 'xi-api-key': apiKey } });

    let committed = '';          /* accumulator for final_transcript chunks */
    let tail = '';               /* latest partial appended for display */
    let settled = false;         /* onFinal/onError fired exactly once */
    let closeRequested = false;  /* caller asked to finish */
    const pending = [];          /* PCM chunks queued before WS open */

    const fullText = () => (committed + (tail ? (committed ? ' ' : '') + tail : '')).trim();
    const fail = (err) => {
        if (settled) return; settled = true;
        try { ws.close(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return; settled = true;
        if (typeof onFinal === 'function') { try { onFinal(fullText()); } catch (_) {} }
    };

    /* v32.12 — wrap PCM in the canonical {message_type:"input_audio_chunk",
       audio_base_64, commit, sample_rate} envelope. Raw binary frames are
       silently ignored by the server. */
    const wrapChunk = (buf, commit = false) => JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(buf).toString('base64'),
        commit: !!commit,
        sample_rate: ELEVENLABS_STT_SAMPLE_RATE,
    });

    ws.on('open', () => {
        while (pending.length) { try { ws.send(wrapChunk(pending.shift(), false)); } catch (_) {} }
        if (closeRequested) {
            /* End-of-stream = send an empty chunk with commit:true so the
               server finalizes the last segment. No "end_of_stream" message
               type exists in the canonical protocol. */
            try { ws.send(wrapChunk(Buffer.alloc(0), true)); } catch (_) {}
        }
    });

    ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        const text = String((m && (m.text || m.transcript || (m.data && m.data.text))) || '');
        /* v2 Realtime keys discriminator as `message_type`; older docs / future
           revisions may use `type`. Accept either so a server-side rename
           doesn't silently break us again. */
        const t = m && (m.message_type || m.type);
        if (t === 'session_started') return;   /* handshake ack, ignore */
        if (t === 'completed') { succeed(); return; }
        if (t === 'invalid_request' || t === 'error' || (m && m.error)) {
            const msg = (m.error || m.message || 'transcription error');
            fail(new Error('ElevenLabs STT: ' + msg)); return;
        }
        /* v32.12 — server uses `committed_transcript` not `final_transcript`.
           Accept both for safety. Same for committed_transcript_with_timestamps. */
        const isFinal   = (t === 'committed_transcript') || (t === 'committed_transcript_with_timestamps') || (t === 'final_transcript') || m.is_final === true;
        const isPartial = (t === 'partial_transcript') || m.is_final === false;
        if (isFinal && text) {
            committed = committed ? (committed + ' ' + text) : text;
            tail = '';
            if (typeof onPartial === 'function') { try { onPartial(fullText()); } catch (_) {} }
            return;
        }
        if (isPartial && text) {
            tail = text;
            if (typeof onPartial === 'function') { try { onPartial(fullText()); } catch (_) {} }
            return;
        }
        /* Bare {text} (no type tag) — treat as a running partial. */
        if (!t && text) {
            tail = text;
            if (typeof onPartial === 'function') { try { onPartial(fullText()); } catch (_) {} }
        }
    });

    ws.on('error', (e) => {
        const mm = /Unexpected server response: (\d+)/.exec((e && e.message) || '');
        const code = mm ? Number(mm[1]) : 0;
        if (code === 401 || code === 403) fail(new Error('ElevenLabs STT: not authorized — check [elevenlabs] api_key in config.ini'));
        else fail(new Error('ElevenLabs STT WS error: ' + ((e && e.message) || e)));
    });

    ws.on('close', () => { succeed(); });

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(wrapChunk(buf, false)); } catch (_) {}
            } else {
                pending.push(buf);   /* will flush on open */
            }
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            if (ws.readyState === WebSocket.OPEN) {
                /* v32.12 — empty chunk + commit:true tells the server to
                   finalize and emit the trailing committed_transcript. */
                try { ws.send(wrapChunk(Buffer.alloc(0), true)); } catch (_) {}
                /* Give the server up to 1.5s to emit `completed` + trailing
                   committed_transcript before yanking the socket. */
                setTimeout(() => { try { ws.close(); } catch (_) {} }, 1500);
            }
            /* If not yet open, open handler will send the commit chunk after flush. */
        },
    };
}

/* Active ElevenLabs streaming sessions keyed by reqId. Mic button is a single
   toggle so the map has at most one entry, but keying by reqId means a stale
   stop from a prior click can't kill a fresh session. */
const _activeElevenLabsStreams = new Map();   /* reqId -> { session, capture } */

/* Start: open ffmpeg PCM stream → open ElevenLabs WS → pipe chunks. Partials
   post back as { type:'sttDeltaEl', reqId, text }, final as
   { type:'sttResultEl', reqId, text }. On ANY failure (WS error, 401,
   ffmpeg missing) we fall through to the existing batch path silently —
   Trent already paid for the click; surfacing a red banner would be worse
   than just transcribing the clip with batch. */
async function handleSttHostStartElevenLabs(panel, context, msg) {
    const reqId = String((msg && msg.reqId) || ('elstream-' + Date.now()));
    if (_activeElevenLabsStreams.has(reqId)) return;
    if (process.platform !== 'win32') {
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: 'host mic capture is Windows-only on this build — pick WebSpeech in Settings → Voice' }); } catch (_) {}
        return;
    }
    try { await ensureFfmpeg(context); } catch (e) { trace('ensureFfmpeg: ' + ((e && e.message) || e)); }
    const key = _getElevenLabsKey(context);
    if (!key) {
        /* No key → tell the panel to fall to the batch path (which surfaces
           the same "no [elevenlabs] api_key" error consistently). */
        try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: 'no [elevenlabs] api_key in config.ini', fallback: true }); } catch (_) {}
        return;
    }

    let session = null;
    let capture = null;
    let fellBack = false;
    let started  = false;        /* did we successfully fire sttHostStarted? */
    const fallbackToBatch = async (whyErr) => {
        if (fellBack) return; fellBack = true;
        trace('ElevenLabs streaming failed (' + ((whyErr && whyErr.message) || whyErr) + ') — falling back to batch path');
        try { if (session) session.close(); } catch (_) {}
        try { if (capture && capture.stop) capture.stop(); } catch (_) {}
        _activeElevenLabsStreams.delete(reqId);
        if (started) {
            /* Mic was already open in streaming mode — by the time we get here
               it's stopped (we just stop()'d it). The batch path can't
               re-record a clip after the fact. Tell the panel that streaming
               failed; it'll surface a soft info banner and reset UI. */
            try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: (whyErr && whyErr.message) || String(whyErr), fallback: true }); } catch (_) {}
            return;
        }
        /* Streaming never started — kick off a fresh batch capture. The panel
           gets a sttHostStarted from THAT path and a normal sttRequestResult
           at the end, identical to the legacy click. */
        try { await handleHostSttStart(panel, context, { ...msg, reqId }); } catch (_) {}
    };

    try {
        session = createElevenLabsSttSession({
            apiKey: key,
            onPartial: (text) => {
                try { panel.webview.postMessage({ type: 'sttDeltaEl', reqId, text }); } catch (_) {}
            },
            onFinal: (text) => {
                _activeElevenLabsStreams.delete(reqId);
                try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: true, text }); } catch (_) {}
                try { if (capture && capture.stop) capture.stop(); } catch (_) {}
            },
            onError: (err) => {
                /* WS-side failure (401, transport error, server error). Fall
                   back to batch so the user's click isn't wasted. */
                fallbackToBatch(err);
            },
        });
    } catch (e) {
        /* createElevenLabsSttSession() throws synchronously on missing key —
           we already guarded that, so this is some other config issue. */
        try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: (e && e.message) || String(e), fallback: true }); } catch (_) {}
        return;
    }

    try {
        const stream = require(path.join(context.extensionPath || __dirname, 'stt-host-stream-el.js'));
        capture = await stream.startStream({
            onPcm: (buf) => { try { if (session) session.sendPcm(buf); } catch (_) {} },
            onStarted: ({ device }) => {
                started = true;
                trace('ElevenLabs streaming recording on device: ' + device);
                try { panel.webview.postMessage({ type: 'sttHostStarted', reqId, device }); } catch (_) {}
            },
            onError: (err) => { fallbackToBatch(err); },
        });
        _activeElevenLabsStreams.set(reqId, { session, capture });
    } catch (e) {
        /* ffmpeg missing / no device / dshow open failed — render as
           sttHostResult so the panel shows the SPECIFIC cause. */
        traceErr('handleSttHostStartElevenLabs ffmpeg', e);
        try { if (session) session.close(); } catch (_) {}
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: (e && e.message) || String(e) }); } catch (_) {}
    }
}

/* Stop: close the WS (sends end_of_stream) and stop the ffmpeg stream. The
   session's onFinal posts sttResultEl. */
function handleSttHostStopElevenLabs(panel, context, msg) {
    const reqId = String((msg && msg.reqId) || '');
    const entry = reqId
        ? _activeElevenLabsStreams.get(reqId)
        : (_activeElevenLabsStreams.size ? _activeElevenLabsStreams.values().next().value : null);
    if (!entry) return;
    /* Stop the mic FIRST so we don't leak ffmpeg chunks after the WS closes —
       any chunks already in-flight on stdout still flush through onPcm before
       proc.close fires. Then close() the session → server flushes final. */
    try { if (entry.capture && entry.capture.stop) entry.capture.stop(); } catch (_) {}
    try { if (entry.session) entry.session.close(); } catch (_) {}
}

/* ── Deepgram Nova-3 streaming STT (BYO key, real-time) ────────────────────
   Mirrors the ElevenLabs streaming path: host-side ffmpeg dshow capture
   (stt-host-stream-el.js) streams raw linear16 16kHz PCM straight into a
   Deepgram streaming WebSocket; partial transcripts post back to the panel as
   sttDeltaEl events (final as sttResultEl) — the SAME generic streaming
   delta/result protocol el/wcpp/fw use. BYO key from config.ini [deepgram]
   api_key (distinct from the Anthropic-proxy 'anthropic' STT). This replaces
   the old batch REST path (handleSttRequest 'deepgram'), which stays as the
   silent fallback when the WS can't open.

   Deepgram native streaming protocol (verified at developers.deepgram.com):
     wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&...
     Auth header: Authorization: Token <key>  (NOT Bearer)
     server→client JSON: { type:'Results', is_final, speech_final,
       channel:{ alternatives:[{ transcript }] } } — is_final=false is an
       interim for the current segment; is_final=true finalizes it (append).
     client→server control: {"type":"KeepAlive"} (every 8s; the server drops
       the socket after ~10s with no audio) and {"type":"CloseStream"} to
       flush + finish. Audio is raw linear16 PCM binary frames. */
const _activeDeepgramStreams = new Map();   /* reqId -> { session, capture } */
const DEEPGRAM_STT_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_STT_SAMPLE_RATE = 16000;
const DEEPGRAM_STT_KEEPALIVE_MS = 8000;

/* Open ONE live Deepgram streaming STT session. Same callback + return shape
   as createAnthropicSttSession / createElevenLabsSttSession so the host
   streaming handler composes identically: sendPcm(buf), close(). */
function createDeepgramSttSession({ key, dictionary, language, onPartial, onFinal, onError } = {}) {
    if (!key) throw new Error('no [deepgram] api_key in config.ini');
    const WebSocket = require('ws');

    const params = new URLSearchParams({
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: String(DEEPGRAM_STT_SAMPLE_RATE),
        channels: '1',
        smart_format: 'true',
        punctuate: 'true',
        interim_results: 'true',
        endpointing: '300',
        utterance_end_ms: '1000',
    });
    const lang = (typeof language === 'string' && language.trim())
        ? language.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) : '';
    if (lang) params.set('language', lang);
    /* Custom dictionary → Nova-3 keyterm prompting (singular param, repeated;
       cap at 100 per Deepgram's limit). Same source the batch REST path uses. */
    for (const kt of _splitDictionaryTerms(dictionary).slice(0, 100)) {
        if (kt) params.append('keyterm', kt);
    }

    const ws = new WebSocket(`${DEEPGRAM_STT_WS_URL}?${params.toString()}`,
        { headers: { Authorization: `Token ${key}` } });

    let keepalive = null;
    let latest = '';            /* current in-progress interim segment */
    let finalText = '';         /* concatenated is_final segments */
    let settled = false;
    let closeRequested = false;
    const pending = [];         /* PCM chunks queued before WS open */

    const cleanup = () => { if (keepalive) { clearInterval(keepalive); keepalive = null; } };
    const fullText = () => [finalText, latest].filter(Boolean).join(' ').trim();
    const fail = (err) => {
        if (settled) return;
        settled = true; cleanup();
        try { ws.close(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return;
        settled = true; cleanup();
        if (typeof onFinal === 'function') { try { onFinal(fullText()); } catch (_) {} }
    };

    ws.on('open', () => {
        keepalive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, DEEPGRAM_STT_KEEPALIVE_MS);
        while (pending.length) { try { ws.send(pending.shift()); } catch (_) {} }
        if (closeRequested) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {} }
    });

    ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        if (m.type === 'Results') {
            const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
            const txt = (alt && alt.transcript) ? alt.transcript : '';
            if (!txt) return;
            if (m.is_final) { finalText = finalText ? (finalText + ' ' + txt) : txt; latest = ''; }
            else { latest = txt; }
            if (typeof onPartial === 'function') { try { onPartial(fullText()); } catch (_) {} }
        } else if (m.type === 'Error' || m.type === 'error') {
            fail(new Error('Deepgram STT: ' + (m.description || m.message || 'stream error')));
        }
        /* 'UtteranceEnd' / 'Metadata' / 'SpeechStarted' need no handling —
           finalText already accumulates on each is_final Results. */
    });

    ws.on('error', (e) => {
        const mm = /Unexpected server response: (\d+)/.exec(e.message || '');
        const code = mm ? Number(mm[1]) : 0;
        if (code === 401 || code === 403) fail(new Error('Deepgram STT: not authorized — check [deepgram] api_key'));
        else fail(new Error('Deepgram STT WS error: ' + (e.message || e)));
    });

    ws.on('close', (code, reason) => {
        if (code === 4001 || code === 4003 || /auth/i.test(String(reason || ''))) {
            fail(new Error('Deepgram STT: authorization rejected — check [deepgram] api_key'));
            return;
        }
        succeed();   /* clean close — emit whatever we collected */
    });

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            if (ws.readyState === WebSocket.OPEN) { try { ws.send(buf); } catch (_) {} }
            else pending.push(buf);
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            /* Stop the keepalive FIRST — the KeepAlive frames keep the socket
               from closing, which can otherwise prevent ws.on('close') from
               ever firing after CloseStream. */
            if (keepalive) { clearInterval(keepalive); keepalive = null; }
            if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {} }
            /* Guarantee a final/commit even if the server never cleanly closes
               (late finals / lingering socket). Without this the transcript is
               never committed, liveActive stays true, and the NEXT recording
               prepends the old text (Trent 2026-06-04: "saves what was said and
               puts it all back in"). succeed() is idempotent via `settled`. */
            setTimeout(() => { try { succeed(); } catch (_) {} try { ws.close(); } catch (_) {} }, 1500);
        },
    };
}

/* Begin Deepgram streaming: host ffmpeg PCM → Deepgram WS → sttDeltaEl/
   sttResultEl. Mirror of handleSttHostStartElevenLabs; falls back to the batch
   REST path (handleHostSttStart → handleSttRequest 'deepgram') on any WS /
   capture failure so the user's click isn't wasted. */
async function handleSttHostStartDeepgram(panel, context, msg) {
    const reqId = String((msg && msg.reqId) || ('dgstream-' + Date.now()));
    if (_activeDeepgramStreams.has(reqId)) return;
    if (process.platform !== 'win32') {
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: 'host mic capture is Windows-only on this build — pick WebSpeech in Settings → Voice' }); } catch (_) {}
        return;
    }
    try { await ensureFfmpeg(context); } catch (e) { trace('ensureFfmpeg: ' + ((e && e.message) || e)); }
    const key = _getDeepgramKey(context);
    if (!key) {
        try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: 'no [deepgram] api_key in config.ini', fallback: true }); } catch (_) {}
        return;
    }

    let session = null;
    let capture = null;
    let fellBack = false;
    let started  = false;
    const dictionary = (msg && typeof msg.dictionary === 'string') ? msg.dictionary : '';
    const language   = (msg && typeof msg.language === 'string') ? msg.language : '';
    const fallbackToBatch = async (whyErr) => {
        if (fellBack) return; fellBack = true;
        trace('Deepgram streaming failed (' + ((whyErr && whyErr.message) || whyErr) + ') — falling back to batch path');
        try { if (session) session.close(); } catch (_) {}
        try { if (capture && capture.stop) capture.stop(); } catch (_) {}
        _activeDeepgramStreams.delete(reqId);
        if (started) {
            try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: (whyErr && whyErr.message) || String(whyErr), fallback: true }); } catch (_) {}
            return;
        }
        try { await handleHostSttStart(panel, context, { ...msg, reqId }); } catch (_) {}
    };

    try {
        session = createDeepgramSttSession({
            key, dictionary, language,
            onPartial: (text) => {
                try { panel.webview.postMessage({ type: 'sttDeltaEl', reqId, text }); } catch (_) {}
            },
            onFinal: (text) => {
                _activeDeepgramStreams.delete(reqId);
                try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: true, text }); } catch (_) {}
                try { if (capture && capture.stop) capture.stop(); } catch (_) {}
            },
            onError: (err) => { fallbackToBatch(err); },
        });
    } catch (e) {
        try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: (e && e.message) || String(e), fallback: true }); } catch (_) {}
        return;
    }

    try {
        const stream = require(path.join(context.extensionPath || __dirname, 'stt-host-stream-el.js'));
        capture = await stream.startStream({
            onPcm: (buf) => { try { if (session) session.sendPcm(buf); } catch (_) {} },
            onStarted: ({ device }) => {
                started = true;
                trace('Deepgram streaming recording on device: ' + device);
                try { panel.webview.postMessage({ type: 'sttHostStarted', reqId, device }); } catch (_) {}
            },
            onError: (err) => { fallbackToBatch(err); },
        });
        _activeDeepgramStreams.set(reqId, { session, capture });
    } catch (e) {
        traceErr('handleSttHostStartDeepgram ffmpeg', e);
        try { if (session) session.close(); } catch (_) {}
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: (e && e.message) || String(e) }); } catch (_) {}
    }
}

/* Mic-up for Deepgram streaming: stop ffmpeg first, then CloseStream → server
   flushes its final transcript → sttResultEl. */
function handleSttHostStopDeepgram(panel, context, msg) {
    const reqId = String((msg && msg.reqId) || '');
    const entry = reqId
        ? _activeDeepgramStreams.get(reqId)
        : (_activeDeepgramStreams.size ? _activeDeepgramStreams.values().next().value : null);
    if (!entry) return;
    try { if (entry.capture && entry.capture.stop) entry.capture.stop(); } catch (_) {}
    try { if (entry.session) entry.session.close(); } catch (_) {}
}

/* ── Realtime local STT providers ─────────────────────────────────────────
   Two realtime providers (whisper-cpp-stream + faster-whisper-stream) ride
   the SAME ffmpeg dshow → subprocess → sttDeltaEl/sttResultEl protocol the
   ElevenLabs Scribe v2 Realtime path uses. Subprocess stdin = raw PCM s16le
   16kHz mono; subprocess stdout = JSON-line transcripts OR whisper.cpp's
   `[ms-->ms] text` line format. Both parse into onPartial / onFinal callbacks
   shaped identically to createElevenLabsSttSession.

   Whisper.cpp stream binary's stdout format (verified against ggerganov build):
       [00:00:01.000 --> 00:00:03.000]  this is a test
   We parse those + emit them as cumulative partials, then re-emit as final on
   close. The binary supports both stdin PCM (--file -) and SDL2 mic capture;
   we use the stdin path for protocol symmetry with the ElevenLabs flow.

   faster-whisper stream uses tools/faster_whisper_stream.py — see that file
   for the sliding-window + webrtcvad implementation. JSON-line stdout shape:
     {"type":"partial","text":"..."}
     {"type":"final","text":"..."} */

/* createWhisperCppStreamSession — spawns whisper.cpp's stream example binary.
   Mirrors createElevenLabsSttSession's API:
     sendPcm(buf)     queue PCM s16le 16k mono. Buffered until process alive.
     close()          stop subprocess; trailing transcript flushes as final.
   Callbacks: onPartial(text) / onFinal(text) / onError(err). */
function createWhisperCppStreamSession({ streamPath, modelPath, onPartial, onFinal, onError } = {}) {
    if (!streamPath || !fs.existsSync(streamPath)) {
        throw new Error('whisper.cpp stream binary missing: ' + streamPath);
    }
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error('whisper.cpp model missing: ' + modelPath);
    }
    /* --step / --length / --keep tuned for snappy partials (~500ms granularity).
       --vad-thold 0.6 reduces re-transcribing silence; -t 4 = 4 threads.
       --file - reads raw PCM from stdin. The binary's CLI has drifted across
       builds; if --file - is unsupported we fall back to streaming via SDL2
       on startup (the binary captures the mic itself). */
    const args = [
        '-m', modelPath,
        '--step', '500',
        '--length', '5000',
        '--keep', '200',
        '--vad-thold', '0.6',
        '--freq-thold', '100',
        '-t', '4',
        '--file', '-',
    ];
    let proc;
    try {
        proc = spawn(streamPath, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(streamPath),    /* find sibling DLLs */
        });
    } catch (e) {
        throw new Error('failed to spawn whisper-stream: ' + ((e && e.message) || e));
    }

    let settled = false;
    let closeRequested = false;
    const pending = [];
    /* Track the latest spoken segment as the "tail" + everything before it
       as committed, so onFinal returns a coherent full transcript even when
       the binary re-prints overlapping windows. */
    let committed = '';
    let tail = '';
    const fullText = () => (committed + (tail ? (committed ? ' ' : '') + tail : '')).trim();

    const fail = (err) => {
        if (settled) return; settled = true;
        try { proc.kill(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return; settled = true;
        if (typeof onFinal === 'function') { try { onFinal(fullText()); } catch (_) {} }
    };

    /* Flush queued PCM. Should-be-rare race because spawn is synchronous on
       Linux/Win; defensive for slower platforms or proc.stdin not yet ready. */
    const flushPending = () => {
        while (pending.length) {
            try { proc.stdin.write(pending.shift()); } catch (e) { fail(e); return; }
        }
    };

    /* whisper.cpp stream prints segments as `[mm:ss.sss --> mm:ss.sss] text`.
       Buffer stdout into lines + emit each non-empty text as the tail. On a
       newline-only flush (an empty `### Transcription ... END ###` block in
       some builds) treat as a commit boundary. */
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl).replace(/\r$/, '').trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            /* Match the timestamped line shape; pull out the text payload. */
            const m = /^\[[^\]]+\]\s*(.+)$/.exec(line);
            const text = m ? m[1].trim() : line.trim();
            if (!text) continue;
            /* Heuristic: if the new text starts with the old tail, treat as
               an extension; otherwise treat as a new utterance (commit the
               previous tail). */
            if (tail && text.startsWith(tail)) {
                tail = text;
            } else if (tail) {
                committed = committed ? (committed + ' ' + tail) : tail;
                tail = text;
            } else {
                tail = text;
            }
            if (typeof onPartial === 'function') {
                try { onPartial(fullText()); } catch (_) {}
            }
        }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
    });

    proc.on('error', (e) => fail(new Error('whisper-stream proc error: ' + ((e && e.message) || e))));
    proc.on('close', (code) => {
        if (!settled) {
            if (code && code !== 0 && !closeRequested) {
                fail(new Error('whisper-stream exited ' + code + ': ' + stderrBuf.slice(-300).trim()));
            } else {
                succeed();
            }
        }
    });

    /* Flush any pending PCM that arrived before stdin was writable. */
    setImmediate(flushPending);

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            if (proc.stdin && proc.stdin.writable) {
                try { proc.stdin.write(buf); } catch (e) { fail(e); }
            } else {
                pending.push(buf);
            }
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            try { proc.stdin && proc.stdin.end(); } catch (_) {}
            /* Give the binary 1.5s to flush trailing output before we kill it. */
            setTimeout(() => { try { proc.kill(); } catch (_) {} }, 1500);
        },
    };
}

/* createFasterWhisperStreamSession — spawns the venv python + driver script.
   Same shape as createWhisperCppStreamSession. Driver prints JSON-line:
     {"type":"partial","text":"..."}  // running interim
     {"type":"final","text":"..."}    // commit on close */
function createFasterWhisperStreamSession({ pythonPath, scriptPath, modelDir, onPartial, onFinal, onError } = {}) {
    if (!pythonPath || !fs.existsSync(pythonPath)) {
        throw new Error('faster-whisper venv python missing: ' + pythonPath);
    }
    if (!scriptPath || !fs.existsSync(scriptPath)) {
        throw new Error('faster-whisper driver missing: ' + scriptPath);
    }
    let proc;
    try {
        const args = [scriptPath];
        if (modelDir) args.push(modelDir);
        proc = spawn(pythonPath, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
    } catch (e) {
        throw new Error('failed to spawn faster-whisper: ' + ((e && e.message) || e));
    }

    let settled = false;
    let closeRequested = false;
    const pending = [];
    let committed = '';
    let tail = '';
    const fullText = () => (committed + (tail ? (committed ? ' ' : '') + tail : '')).trim();

    const fail = (err) => {
        if (settled) return; settled = true;
        try { proc.kill(); } catch (_) {}
        if (typeof onError === 'function') { try { onError(err); } catch (_) {} }
    };
    const succeed = () => {
        if (settled) return; settled = true;
        if (typeof onFinal === 'function') { try { onFinal(fullText()); } catch (_) {} }
    };

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl).replace(/\r$/, '').trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            let m; try { m = JSON.parse(line); } catch (_) { continue; }
            const text = String((m && m.text) || '').trim();
            if (!text) continue;
            if (m.type === 'final') {
                committed = committed ? (committed + ' ' + text) : text;
                tail = '';
                if (typeof onPartial === 'function') {
                    try { onPartial(fullText()); } catch (_) {}
                }
            } else {
                /* partial — replace tail, partials are cumulative per window. */
                tail = text;
                if (typeof onPartial === 'function') {
                    try { onPartial(fullText()); } catch (_) {}
                }
            }
        }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
        /* Surface python tracebacks via trace() so debug.log captures them. */
        trace('faster-whisper(err): ' + chunk.toString('utf8').trim());
    });

    proc.on('error', (e) => fail(new Error('faster-whisper proc error: ' + ((e && e.message) || e))));
    proc.on('close', (code) => {
        if (!settled) {
            if (code && code !== 0 && !closeRequested) {
                fail(new Error('faster-whisper exited ' + code + ': ' + stderrBuf.slice(-300).trim()));
            } else {
                succeed();
            }
        }
    });

    return {
        sendPcm(buf) {
            if (settled || closeRequested || !buf || !buf.length) return;
            if (proc.stdin && proc.stdin.writable) {
                try { proc.stdin.write(buf); } catch (e) { fail(e); }
            } else {
                pending.push(buf);
            }
        },
        close() {
            if (settled || closeRequested) return;
            closeRequested = true;
            try { proc.stdin && proc.stdin.end(); } catch (_) {}
            /* faster-whisper does a final transcribe on EOF so it can take up
               to 2s to emit the final and exit cleanly. */
            setTimeout(() => { try { proc.kill(); } catch (_) {} }, 3000);
        },
    };
}

/* Active realtime local sessions, keyed by reqId — same single-toggle pattern
   as _activeElevenLabsStreams. */
const _activeRealtimeLocalStreams = new Map();   /* reqId -> { session, capture, provider } */

/* Generic START handler for realtime local providers. Mirrors
   handleSttHostStartElevenLabs: open ffmpeg dshow → open subprocess → pipe
   chunks. Partials post as sttDeltaEl; final as sttResultEl (we reuse the
   ElevenLabs message types so the panel handler is one cleaner switch —
   provider field distinguishes which one was used). */
async function handleSttHostStartRealtimeLocal(panel, context, msg, provider /* 'whisper-cpp-stream' | 'faster-whisper-stream' */) {
    const reqId = String((msg && msg.reqId) || (provider + '-' + Date.now()));
    if (_activeRealtimeLocalStreams.has(reqId)) return;
    if (process.platform !== 'win32') {
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: provider + ' is Windows-only on this build (ffmpeg dshow capture). Pick ElevenLabs or another provider.' }); } catch (_) {}
        return;
    }
    try { await ensureFfmpeg(context); } catch (e) { trace('ensureFfmpeg: ' + ((e && e.message) || e)); }

    let session = null;
    let capture = null;
    let started = false;

    const reportFail = (err) => {
        try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: false, error: (err && err.message) || String(err), provider, fallback: false }); } catch (_) {}
        try { if (session) session.close(); } catch (_) {}
        try { if (capture && capture.stop) capture.stop(); } catch (_) {}
        _activeRealtimeLocalStreams.delete(reqId);
    };

    /* 1. Resolve the subprocess (download + venv bootstrap if needed). */
    try {
        if (provider === 'whisper-cpp-stream') {
            let streamPath, modelPath;
            try {
                ({ streamPath, modelPath } = await _ensureWhisperStreamFiles(context));
            } catch (wErr) {
                /* whisper.cpp's prebuilt Windows zip ships NO `stream` example
                   binary (needs SDL2), so this provider dead-ends on most
                   installs. Transparently fall back to the working faster-whisper
                   engine instead of failing the mic click — same reqId so the
                   panel's pending request still resolves (Trent 2026-06-04:
                   "whisper isnt working at all"). */
                trace('whisper-cpp-stream unavailable (' + ((wErr && wErr.message) || wErr) + ') — falling back to faster-whisper-stream');
                _activeRealtimeLocalStreams.delete(reqId);
                return handleSttHostStartRealtimeLocal(panel, context, msg, 'faster-whisper-stream');
            }
            session = createWhisperCppStreamSession({
                streamPath, modelPath,
                onPartial: (text) => {
                    try { panel.webview.postMessage({ type: 'sttDeltaEl', reqId, text, provider }); } catch (_) {}
                },
                onFinal: (text) => {
                    _activeRealtimeLocalStreams.delete(reqId);
                    try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: true, text, provider }); } catch (_) {}
                    try { if (capture && capture.stop) capture.stop(); } catch (_) {}
                },
                onError: (err) => reportFail(err),
            });
        } else if (provider === 'faster-whisper-stream') {
            const py = await _ensureFasterWhisperVenv();
            const script = path.join(
                (context && context.extensionPath) || __dirname,
                'tools', 'faster_whisper_stream.py'
            );
            if (!fs.existsSync(script)) {
                throw new Error('faster-whisper driver script missing at ' + script);
            }
            const modelDir = _getFasterWhisperModelDir(context);
            session = createFasterWhisperStreamSession({
                pythonPath: py,
                scriptPath: script,
                modelDir,
                onPartial: (text) => {
                    try { panel.webview.postMessage({ type: 'sttDeltaEl', reqId, text, provider }); } catch (_) {}
                },
                onFinal: (text) => {
                    _activeRealtimeLocalStreams.delete(reqId);
                    try { panel.webview.postMessage({ type: 'sttResultEl', reqId, ok: true, text, provider }); } catch (_) {}
                    try { if (capture && capture.stop) capture.stop(); } catch (_) {}
                },
                onError: (err) => reportFail(err),
            });
        } else {
            throw new Error('unknown realtime local provider: ' + provider);
        }
    } catch (e) {
        traceErr('handleSttHostStartRealtimeLocal session', e);
        reportFail(e);
        return;
    }

    /* 2. Open ffmpeg dshow → pipe PCM to the subprocess. */
    try {
        const stream = require(path.join(context.extensionPath || __dirname, 'stt-host-stream-el.js'));
        capture = await stream.startStream({
            onPcm: (buf) => { try { if (session) session.sendPcm(buf); } catch (_) {} },
            onStarted: ({ device }) => {
                started = true;
                trace(provider + ' streaming recording on device: ' + device);
                try { panel.webview.postMessage({ type: 'sttHostStarted', reqId, device, provider }); } catch (_) {}
            },
            onError: (err) => reportFail(err),
        });
        _activeRealtimeLocalStreams.set(reqId, { session, capture, provider });
    } catch (e) {
        traceErr('handleSttHostStartRealtimeLocal ffmpeg', e);
        try { if (session) session.close(); } catch (_) {}
        try { panel.webview.postMessage({ type: 'sttHostResult', reqId, ok: false, error: (e && e.message) || String(e), provider }); } catch (_) {}
    }
}

/* Generic STOP — close the subprocess (sends EOF / kills after grace) +
   stop ffmpeg. The session's onFinal posts sttResultEl. */
function handleSttHostStopRealtimeLocal(panel, context, msg) {
    const reqId = String((msg && msg.reqId) || '');
    const entry = reqId
        ? _activeRealtimeLocalStreams.get(reqId)
        : (_activeRealtimeLocalStreams.size ? _activeRealtimeLocalStreams.values().next().value : null);
    if (!entry) return;
    try { if (entry.capture && entry.capture.stop) entry.capture.stop(); } catch (_) {}
    try { if (entry.session) entry.session.close(); } catch (_) {}
}


/* Legacy entry: panel posts {type:'sttStart'} when WebSpeech got denied.
   The previous whisper-local-download-failed soft-pin flag is gone with the
   batch path; ElevenLabs is the canonical fallback (per
   `elevenlabs_default.md`). */
let _lastSttHintAt = 0;
function startHostSttHint(panel) {
    if (!extensionContext) return;
    const context = extensionContext;
    /* Dedupe back-to-back fires — WebSpeech can emit `not-allowed` followed
       by `service-not-allowed` (or onend after onerror) in <1s, which used
       to double-post the same red banner. Trent saw it twice in the same
       click 2026-05-29. Suppress the second hit within 1500ms. */
    const nowTs = Date.now();
    if (nowTs - _lastSttHintAt < 1500) {
        trace('startHostSttHint: dedupe (last hint ' + (nowTs - _lastSttHintAt) + 'ms ago)');
        return;
    }
    _lastSttHintAt = nowTs;
    /* Webview won't have raw mic audio here — this entry point is only hit
       when the panel's WebSpeech path was denied. Auto-promote the STT
       provider to ElevenLabs (canonical default per `elevenlabs_default.md`)
       and post a clear banner. If the ElevenLabs key is missing, surface a
       specific instruction instead of the legacy WebSpeech message. */
    try {
        context.workspaceState.update(STATE_STT_PROVIDER, 'elevenlabs');
        trace('startHostSttHint: auto-promoted STT provider to elevenlabs');
    } catch (_) {}
    const haveKey = !!_getElevenLabsKey(context);
    const errMsg = haveKey
        ? 'WebSpeech is unavailable in the VSCode webview — switched STT to ElevenLabs. Click the mic again to record.'
        : 'WebSpeech is unavailable in the VSCode webview. Add `api_key = sk_...` under `[elevenlabs]` in config.ini, then click the mic again.';
    try {
        panel.webview.postMessage({ type: 'sttResult', text: '', error: errMsg });
    } catch (_) {}
}

/* No-op stop: kept so legacy 'sttStop' messages from older panel.js snapshots
   don't crash the message router. The whisper-server stays running once
   booted; nothing to tear down per-request. */
function stopHostStt() { /* deprecated — whisper-server is long-lived */ }
function prewarmHostStt() { /* deprecated — whisper-server is lazy-spawned */ }

/* ── Host-side mic capture (PRIMARY STT path) ─────────────────────────────
   VSCode webviews can't getUserMedia (sandboxed iframe; Electron denies media
   capture regardless of the OS grant to Code.exe — no extension API to fix it).
   So the mic button posts {type:'sttHostStart'} / {type:'sttHostStop'} and we
   capture the mic HERE in the Node host via ffmpeg dshow, then transcribe via
   the EXISTING handleSttRequest path (ElevenLabs Scribe by default). The panel
   never touches getUserMedia on this path. See stt-host-capture.js for the
   ffmpeg/shim/graceful-stop details (memory: cbe_stt_stop_bug.md). */
let _sttHostCapture = null;   /* lazy require of stt-host-capture.js */
function _getSttHostCapture(context) {
    if (_sttHostCapture) return _sttHostCapture;
    const mod = path.join((context && context.extensionPath) || __dirname, 'stt-host-capture.js');
    _sttHostCapture = require(mod);
    return _sttHostCapture;
}

/* Begin host capture. On success the UI's red recording-ring stays on (panel
   already set it before posting); on failure we post a SPECIFIC error so the
   user sees the real cause ("ffmpeg not found" / "no microphone device")
   instead of the misleading "access denied" banner. */
async function handleHostSttStart(panel, context, msg) {
    if (process.platform !== 'win32') {
        try { panel.webview.postMessage({ type: 'sttHostResult', ok: false, error: 'host mic capture is Windows-only on this build — pick WebSpeech in Settings → Voice' }); } catch (_) {}
        return;
    }
    try { await ensureFfmpeg(context); } catch (e) { trace('ensureFfmpeg: ' + ((e && e.message) || e)); }
    try {
        const cap = _getSttHostCapture(context);
        const { device } = await cap.startRecording();
        trace('host STT recording started on device: ' + device);
        try { panel.webview.postMessage({ type: 'sttHostStarted', device }); } catch (_) {}
    } catch (e) {
        traceErr('handleHostSttStart', e);
        try { panel.webview.postMessage({ type: 'sttHostResult', ok: false, error: (e && e.message) || String(e) }); } catch (_) {}
    }
}

/* Stop host capture, grab the WAV bytes, and transcribe via the existing
   provider dispatch. We construct a synthetic 'sttRequest' message and reuse
   handleSttRequest verbatim — that posts {type:'sttRequestResult', ok, text}
   which the panel already pastes into the input via appendToInput(). Reusing
   that path means ZERO new transcription/paste code and the ElevenLabs key is
   read from its existing _getElevenLabsKey() (config.ini [elevenlabs]). */
async function handleHostSttStop(panel, context, msg) {
    const cap = _sttHostCapture;
    if (!cap || !cap.isRecording()) {
        /* Stop arrived with nothing recording (e.g. start failed already). The
           panel reset its UI on the error; nothing to do. */
        return;
    }
    const reqId = String((msg && msg.reqId) || ('hoststt-' + Date.now()));
    const provider = String((msg && msg.provider) || getVoiceProvider(context, 'stt'));
    try {
        const buf = await cap.stopRecording();
        const audioB64 = buf.toString('base64');
        trace('host STT captured ' + buf.length + ' WAV bytes; transcribing via ' + provider);
        /* Reuse the existing host transcription + sttRequestResult paste path. */
        await handleSttRequest(panel, context, {
            type: 'sttRequest',
            reqId,
            provider,
            mime: 'audio/wav',
            audioB64,
            dictionary: (msg && typeof msg.dictionary === 'string') ? msg.dictionary : '',
            language: (msg && typeof msg.language === 'string') ? msg.language : '',
        });
    } catch (e) {
        traceErr('handleHostSttStop', e);
        try { panel.webview.postMessage({ type: 'sttRequestResult', reqId, ok: false, error: (e && e.message) || String(e), provider }); } catch (_) {}
    }
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

/* ── Stale-install self-cleaner ───────────────────────────────────────── */
/**
 * Find and disable older copies of CBE that VSCode left behind. Causes:
 *   - Publisher rename (TrentonTompkins -> Trent-Tompkins) — VSCode treats
 *     pre/post-rename as DIFFERENT extensions, both stay installed, both
 *     try to register `codexBlackEd.openPanel` -> "command already exists".
 *   - rmdir failure on Windows when the active extension's own files are
 *     open (process holds handles) -> new VSIX installer can't fully
 *     remove the old folder.
 *   - User-side .bak duplicates under ~/.vscode/extensions/.
 *
 * Renames stale folders to `<name>.disabled-<stamp>` (out of VSCode's load
 * path) and prunes the matching entries from extensions.json. Idempotent
 * and best-effort; failures don't block activation. If anything was cleaned,
 * a toast offers a one-click reload to finalize.
 */
async function _cleanStaleCBEVersions(context) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const cp = require('child_process');

    const ourId = String(context.extension?.id || '').toLowerCase();
    const ourPath = path.normalize(context.extensionPath).toLowerCase();
    const isCBE = (s) => /codex-black-ed/i.test(String(s || ''));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let cleaned = 0;

    // Scan every standard install root + the parent of our own folder
    // (covers the --extensionDevelopmentPath case where we run from
    // outside ~/.vscode/extensions/). Set dedupes overlap.
    const roots = new Set([
        path.join(os.homedir(), '.vscode', 'extensions'),
        path.join(os.homedir(), '.vscode-insiders', 'extensions'),
        path.join(os.homedir(), '.vscode-oss', 'extensions'),
        path.dirname(context.extensionPath),
    ]);

    // Step 0 — on Windows, kill any CBE-Bridge-*.exe tray process whose
    // ExecutablePath sits inside a foreign CBE folder (current OR already
    // .disabled). Without this the tray keeps listening on its TCP port
    // and the dev folder's freshly-rebuilt tray refuses to spawn ("port
    // already bound, reusing existing bridge") — meaning code changes to
    // the C++ tray don't take effect even after a panel reload. Each tray
    // has a KILL_ON_JOB_CLOSE JobObject so killing it atomically nukes
    // its entire chrome tree too. Wrapped — failure (e.g. missing perms)
    // just leaves the process alone and falls through to the folder
    // rename step.
    if (process.platform === 'win32') {
        const isStaleTrayPath = (p) =>
            p && isCBE(p) &&
            path.normalize(p).toLowerCase().indexOf(ourPath) !== 0;  // not in our extension dir
        try {
            const ps = cp.spawnSync('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command',
                 /* Match BOTH the legacy per-target exes (CBE-Bridge-Claude.exe
                    etc., still on disk in old installs) AND the unified
                    CBE-Bridge.exe — single trailing wildcard covers both. */
                 "Get-CimInstance Win32_Process -Filter \"Name LIKE 'CBE-Bridge%'\" | " +
                 "Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"],
                { encoding: 'utf8', windowsHide: true, timeout: 8000 });
            let procs = [];
            try {
                const parsed = JSON.parse(ps.stdout || 'null');
                procs = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            } catch (_) { /* no procs / non-JSON */ }
            for (const proc of procs) {
                if (!isStaleTrayPath(proc.ExecutablePath)) continue;
                try {
                    cp.spawnSync('taskkill', ['/F', '/PID', String(proc.ProcessId)],
                                 { windowsHide: true, timeout: 5000 });
                    cleaned++;
                    console.log('[CBE cleaner] killed stale tray pid=' + proc.ProcessId
                                + ' path=' + proc.ExecutablePath);
                } catch (e) {
                    console.warn('[CBE cleaner] taskkill failed for pid', proc.ProcessId, e.message);
                }
            }
        } catch (e) {
            console.warn('[CBE cleaner] tray enumeration failed:', e.message);
        }
    }

    // Step 1 — rename foreign CBE folders out of VSCode's load path, then
    // immediately delete the bytes. The rename-first is defensive: even if
    // the recursive delete partially fails (an antivirus scan opens a
    // file mid-delete), VSCode won't try to load whatever's left because
    // it's no longer at a recognized .vscode/extensions path. Old binaries
    // would otherwise pile up forever — every VSIX side-load left ~25 MB
    // behind that the user had to manually rm.
    //
    // Also sweeps any pre-existing .disabled-* CBE folders (from prior
    // cleaner runs or manual rename ops) — they're already excluded from
    // the VSCode load path but still occupy disk.
    const wipeDir = (p) => {
        try {
            fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return true;
        } catch (e) {
            console.warn('[CBE cleaner] delete failed:', p, e.message);
            return false;
        }
    };
    for (const root of roots) {
        let entries;
        try { entries = fs.readdirSync(root, { withFileTypes: true }); }
        catch (e) { continue; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!isCBE(entry.name)) continue;
            const p = path.join(root, entry.name);
            if (path.normalize(p).toLowerCase() === ourPath) continue;
            const alreadyDisabled = /\.disabled(-[\w\-:T]+)?$/i.test(entry.name);
            if (alreadyDisabled) {
                // Pre-existing disabled folder — straight to delete.
                if (wipeDir(p)) cleaned++;
                continue;
            }
            // Live foreign CBE — rename first (instant takeoff from VSCode's
            // load path), then delete the bytes.
            const disabled = p + '.disabled-' + stamp;
            try {
                fs.renameSync(p, disabled);
                cleaned++;
                wipeDir(disabled);  // best-effort; cleaned++ already counted the rename
            } catch (e) {
                console.warn('[CBE cleaner] rename failed:', p, e.message);
                // Even if rename failed, try a direct recursive delete — the
                // folder may be partly writable.
                if (wipeDir(p)) cleaned++;
            }
        }
    }

    // Step 2 — drop matching entries from extensions.json so the registry
    // doesn't keep listing folders that are now `.disabled-*` (VSCode would
    // log warnings for missing paths on every launch otherwise).
    for (const root of roots) {
        const regPath = path.join(root, 'extensions.json');
        if (!fs.existsSync(regPath)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            if (!Array.isArray(data)) continue;
            const before = data.length;
            const kept = data.filter(e => {
                const id  = String(e?.identifier?.id || '').toLowerCase();
                const loc = String(e?.location?.fsPath || e?.location?.path || '').toLowerCase();
                if (!isCBE(id) && !isCBE(loc)) return true;          // not CBE
                if (ourId && id === ourId) return true;              // it's us by id
                if (loc && loc.includes(path.basename(ourPath))) return true; // by path
                return false;                                        // stale -> drop
            });
            if (kept.length !== before) {
                fs.writeFileSync(regPath, JSON.stringify(kept, null, 2));
                cleaned += (before - kept.length);
            }
        } catch (e) {
            console.warn('[CBE cleaner] registry prune failed:', regPath, e.message);
        }
    }

    if (cleaned > 0) {
        const msg = `Codex Black: cleaned ${cleaned} stale install${cleaned === 1 ? '' : 's'}. Reload window to finalize.`;
        vscode.window.showInformationMessage(msg, 'Reload now').then(answer => {
            if (answer === 'Reload now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
        console.log('[CBE cleaner] cleaned', cleaned, 'stale entries/folders');
    }
}

/* ── Windows microphone-permission auto-fix ─────────────────────────────
 * On a fresh Windows 10/11 install the OS gates desktop apps behind a
 * per-exe "Microphone access" toggle in Settings → Privacy. Until the
 * user flips it, getUserMedia() inside the webview fails silently and
 * STT shows "microphone access denied. Grant mic permission to VSCode".
 *
 * The consent state lives in three HKCU registry values (per-user — no
 * admin needed):
 *
 *   HKCU\Software\Microsoft\Windows\CurrentVersion
 *        \CapabilityAccessManager\ConsentStore\microphone\Value         (global, REG_SZ "Allow"/"Deny")
 *        \...\microphone\NonPackaged\Value                              (all win32 apps, REG_SZ)
 *        \...\microphone\NonPackaged\<mangledExePath>\Value             (per-exe, REG_SZ)
 *
 * The per-exe subkey name is the full path with BOTH ":" AND "\" replaced
 * by "#". A "C:#Users#..." (colon-preserved) subkey also exists in HKCU
 * but it only stores LastUsedTimeStart/Stop usage telemetry — Chromium
 * reads consent from the colon-stripped "C##Users#..." variant. Verified
 * by `reg query` against the live consent store on this machine 2026-05-27.
 *   C:\Users\foo\AppData\Local\Programs\Microsoft VS Code\Code.exe
 *   →   C##Users#foo#AppData#Local#Programs#Microsoft VS Code#Code.exe
 *
 * Sources (confirmed 2026-05-27):
 *   - sysmansquad.com/2023/01/21/microphone_app_permissions
 *   - svch0st on Medium ("Tracking processes accessing the camera/mic")
 *   - Velociraptor Windows.Registry.CapabilityAccessManager artifact
 *   - davidarno.org/using-the-registry-to-monitor-webcam-and-microphone-use
 *
 * Chromium re-reads the consent value on every getUserMedia() call so no
 * window reload is required after we write it — the next mic click just
 * succeeds. If the write fails (rare: locked-down policy hive, GPO-pinned
 * value), we fall back to opening ms-settings:privacy-microphone so the
 * user lands one click from the right toggle.
 */
async function _ensureMicPermission(context) {
    if (process.platform !== 'win32') return;          /* Linux/macOS gate elsewhere */
    const CHECK_KEY = '_cbeMicPermCheck';
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;            /* re-probe weekly */
    try {
        const last = context.globalState.get(CHECK_KEY);
        if (typeof last === 'number' && Date.now() - last < TTL_MS) return;
    } catch (_) { /* globalState read failure — proceed */ }

    const cp = require('child_process');
    const exePath = process.execPath;                  /* e.g. C:\...\Code.exe */
    /* Mangling: BOTH colon and backslash → #. The colon-kept form
       ("C:#…") is a usage-telemetry key; the canonical consent key is
       the colon-stripped form ("C##…"). Verified live 2026-05-27. */
    const mangled = exePath.replace(/[:\\]/g, '#');

    const BASE_GLOBAL    = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
    const BASE_NONPKG    = BASE_GLOBAL + '\\NonPackaged';
    const KEY_PER_EXE    = BASE_NONPKG + '\\' + mangled;

    /* Run `reg query KEY /v Value` and return current REG_SZ data or null. */
    const queryValue = (regKey) => {
        try {
            const r = cp.spawnSync('reg', ['query', regKey, '/v', 'Value'],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (r.status !== 0) return null;
            const m = /Value\s+REG_SZ\s+(\w+)/i.exec(r.stdout || '');
            return m ? m[1] : null;
        } catch (_) { return null; }
    };
    /* Run `reg add KEY /v Value /t REG_SZ /d Allow /f`. Returns true on success. */
    const writeAllow = (regKey) => {
        try {
            const r = cp.spawnSync('reg',
                ['add', regKey, '/v', 'Value', '/t', 'REG_SZ', '/d', 'Allow', '/f'],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            return r.status === 0;
        } catch (_) { return false; }
    };

    let wroteSomething = false;
    let allOk = true;
    const targets = [
        { name: 'microphone (global)',  key: BASE_GLOBAL },
        { name: 'NonPackaged (apps)',   key: BASE_NONPKG },
        { name: 'per-exe Code.exe',     key: KEY_PER_EXE },
    ];
    for (const t of targets) {
        const cur = queryValue(t.key);
        if (cur === 'Allow') {
            trace('MIC-PERM: ' + t.name + ' already Allow');
            continue;
        }
        const ok = writeAllow(t.key);
        if (ok) {
            wroteSomething = true;
            trace('MIC-PERM: wrote Allow → ' + t.name + (cur ? ' (was ' + cur + ')' : ' (missing)'));
        } else {
            allOk = false;
            trace('MIC-PERM: FAILED to write ' + t.name + ' — reg add returned non-zero');
        }
    }

    if (allOk) {
        try { context.globalState.update(CHECK_KEY, Date.now()); } catch (_) {}
        if (wroteSomething) {
            try { outChan && outChan.appendLine('[CBE] Granted Windows mic permission for ' + path.basename(exePath)); } catch (_) {}
        }
    } else {
        /* Fallback: registry write blocked (locked-down policy, GPO, etc).
           Open the Settings page so the user is one click from done. */
        try {
            vscode.window.showWarningMessage(
                'Could not auto-grant microphone access. Click the toggle for Visual Studio Code on the next screen.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    try { vscode.env.openExternal(vscode.Uri.parse('ms-settings:privacy-microphone')); } catch (_) {}
                }
            });
        } catch (_) { /* even the toast failed — give up silently */ }
    }
}

/* ── Prerequisite checker ─────────────────────────────────────────────── */
/**
 * Verify every external program/library CBE shells out to at runtime is
 * present and current. If anything's missing or too old, surface a single
 * unified toast with a "Install all" button that runs the installers in a
 * visible VSCode terminal. Cached in globalState for 24h so we don't
 * re-probe every launch.
 *
 * Currently checks: Python ≥ 3.10, Git, PowerShell (Win), pip packages
 * listed in requirements.txt. PowerShell is a built-in on Windows so the
 * probe is verification-only — no install path; if it's actually missing
 * the user has bigger problems than this extension.
 */
async function _ensurePrerequisites(context) {
    const fs   = require('fs');
    const path = require('path');
    const cp   = require('child_process');

    const CHECK_KEY = '_cbePrereqCheck';
    const TTL_MS = 24 * 60 * 60 * 1000;
    const last = context.globalState.get(CHECK_KEY);
    if (typeof last === 'number' && Date.now() - last < TTL_MS) return; // recent OK

    // ── tiny promisified spawners ───────────────────────────────────────
    const run = (cmd, args) => new Promise(resolve => {
        let out = '';
        let proc;
        try { proc = cp.spawn(cmd, args, { windowsHide: true }); }
        catch (e) { return resolve({ ok: false, reason: 'spawn-throw: ' + e.message, out: '' }); }
        proc.stdout && proc.stdout.on('data', d => out += d);
        proc.stderr && proc.stderr.on('data', d => out += d);
        proc.on('error', e => resolve({ ok: false, reason: e.code || e.message, out }));
        proc.on('close', code => resolve({ ok: code === 0, reason: 'exit ' + code, out, code }));
    });

    const missing = [];

    // ── Python ≥ 3.10 ──────────────────────────────────────────────────
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    const pyProbe = await run(pyCmd, ['--version']);
    let pythonOk = false;
    if (pyProbe.ok) {
        const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(pyProbe.out);
        if (m) {
            const major = +m[1], minor = +m[2];
            pythonOk = major > 3 || (major === 3 && minor >= 10);
            if (!pythonOk) missing.push({
                what: 'Python ≥ 3.10 (found ' + m[0] + ' — too old)',
                winget: 'Python.Python.3.12',
                brew: 'python@3.12',
                aptHint: 'sudo apt install python3.12 python3.12-venv',
            });
        }
    } else {
        missing.push({
            what: 'Python (not installed)',
            winget: 'Python.Python.3.12',
            brew: 'python@3.12',
            aptHint: 'sudo apt install python3 python3-pip python3-venv',
        });
    }

    // ── pip packages from requirements.txt (only if Python is OK) ──────
    const pipPackages = [];
    if (pythonOk) {
        const reqPath = path.join(context.extensionPath, 'requirements.txt');
        if (fs.existsSync(reqPath)) {
            const required = fs.readFileSync(reqPath, 'utf8').split(/\r?\n/)
                .map(l => l.replace(/#.*$/, '').trim())
                .filter(Boolean)
                .map(l => ({
                    raw: l,
                    name: l.split(/[<>=;\s]/)[0].trim().toLowerCase(),
                }))
                .filter(p => p.name);
            const pipList = await run(pyCmd, ['-3', '-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check']);
            const installed = new Set(
                (pipList.out || '').split(/\r?\n/)
                    .map(l => l.split('==')[0].trim().toLowerCase())
                    .filter(Boolean)
            );
            for (const p of required) if (!installed.has(p.name)) pipPackages.push(p.raw);
        }
        if (pipPackages.length) {
            missing.push({ what: pipPackages.length + ' Python packages (requirements.txt)', pipArgs: pipPackages });
        }
    }

    // ── Git (used by the GitHub button + git-blame integrations) ───────
    const gitProbe = await run('git', ['--version']);
    if (!gitProbe.ok) missing.push({
        what: 'Git', winget: 'Git.Git', brew: 'git', aptHint: 'sudo apt install git',
    });

    // ── ffmpeg — NOT prompted here anymore. ensureFfmpeg() auto-downloads a
    // static build into globalStorage silently on first STT use (no winget, no
    // admin), so nagging the user at activation to winget-install it would be
    // redundant — and they don't need ffmpeg at all unless they use voice.

    // ── PowerShell (Windows only — verification only, no install path) ─
    if (process.platform === 'win32') {
        const psProbe = await run('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
        if (!psProbe.ok) missing.push({
            what: 'PowerShell (built into Windows; if missing, run Windows Update)',
            noInstaller: true,
        });
    }

    // ── Nothing missing? Cache OK and bail ─────────────────────────────
    if (missing.length === 0) {
        context.globalState.update(CHECK_KEY, Date.now());
        return;
    }

    // ── Build a single unified toast ───────────────────────────────────
    const summary = missing.map(m => '• ' + m.what).join('  ');
    const action = await vscode.window.showWarningMessage(
        'Codex Black: missing prerequisites — ' + summary,
        { modal: false },
        'Install all',
        'Later',
        'Skip permanently',
    );

    if (action === 'Skip permanently') {
        // Sentinel: far future, treat as "don't ask again."
        context.globalState.update(CHECK_KEY, Date.now() + 100 * 365 * TTL_MS);
        return;
    }
    if (action !== 'Install all') {
        // "Later" or dismissed — re-ask in an hour (don't burn the whole 24h TTL).
        context.globalState.update(CHECK_KEY, Date.now() - TTL_MS + 60 * 60 * 1000);
        return;
    }

    // ── Run installers in a visible terminal so the user can watch ─────
    const term = vscode.window.createTerminal({ name: 'CBE prerequisites' });
    term.show(true);
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    for (const m of missing) {
        if (m.noInstaller) continue;
        if (m.pipArgs) {
            const py = isWin ? 'py' : 'python3';
            term.sendText(`${py} -3 -m pip install --upgrade ${m.pipArgs.map(a => '"' + a + '"').join(' ')}`);
        } else if (isWin && m.winget) {
            term.sendText(`winget install ${m.winget} --accept-package-agreements --accept-source-agreements`);
        } else if (isMac && m.brew) {
            term.sendText(`brew install ${m.brew}`);
        } else if (m.aptHint) {
            term.sendText(m.aptHint);
        }
    }
    term.sendText('echo "=== CBE prerequisites: install commands queued — review output, then reload window ==="');

    // Don't cache OK — let the NEXT activation re-probe so we confirm
    // installs actually took.
}

/* ── CLI control server ────────────────────────────────────────────────────
   A tiny localhost-only HTTP server so the `cbe` CLI (cli/cbe.js) can drive
   the SAME live extension the panel does — active provider, the in-memory
   conversation, the auto-update push — instead of re-running cold logic in a
   second process. Stateless actions (version, bridge TCP probe, git, native
   save dialog) are done by the CLI itself and never touch this server.

   Port 57838 — confirmed free; deliberately clear of claude-voice (57834 /
   57835) and CBE's own ctrl/log ports (57835 / 57836 / 57837 / 57844). Bound
   to 127.0.0.1 ONLY so nothing off-box can reach it. The server handle is
   pushed onto context.subscriptions (and tracked in _cliServer) so VSCode
   tears it down on deactivate — no leaked listener.

   Routes (all POST JSON unless noted):
     GET  /status               -> { ok, version, provider, model, convoLen, panelOpen }
     POST /chat   {message}     -> streams the active provider's reply (NDJSON
                                   lines: {type:'chunk',text} / {type:'tool',...}
                                   / {type:'done'} / {type:'error',message}),
                                   running bash/read_file tool calls headlessly.
     POST /reset                -> clears the in-memory conversation
     POST /update {push:true}   -> fires pushUpdateToServer (same as /push slash)
     POST /sendFile {path}      -> stage a file into the conversation context
   The CLI never calls reloadWindow or any host-restart command. */
const CLI_CONTROL_PORT = 57838;
let _cliServer = null;

/* Headless chat: same dispatch as handleSendText() but with no webview panel.
   Pushes the user turn onto the shared `conversation`, streams the active
   provider, runs the # !exec and native tool_calls daisy-chain (executeToolCall
   / executeNativeToolCall) exactly like the panel path, and invokes
   onEvent({type,...}) for each chunk / tool step / completion. Returns the
   fully-assembled assistant text. Throws on stream failure (the caller maps it
   to an {type:'error'} NDJSON line). */
async function cliHeadlessChat(context, text, onEvent) {
    const emit = (ev) => { try { if (onEvent) onEvent(ev); } catch (_) {} };
    const cleaned = String(text || '').trim();
    if (!cleaned) throw new Error('empty message');

    const providerId = getActiveProvider(context);
    const model = getActiveModel(context, providerId);
    const maxTokens = getMaxTokens();
    const pInfo = PROVIDERS[providerId] || {};
    if (!pInfo.bridge && !pInfo.cliAgent && !getProviderKey(context, providerId)) {
        throw new Error(`${providerId}: no API key. Set one in the panel, config.ini [api_keys], or the provider env var.`);
    }

    conversation.push({ role: 'user', content: cleaned });
    try { touchActiveAccount(context, providerId); } catch (_) {}
    emit({ type: 'start', provider: providerId, model });

    const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || os.homedir();
    const MAX_TOOL_ITERATIONS = 8;
    let toolIterations = 0;
    let finalText = '';

    for (;;) {
        let assembled = '';
        let nativeToolCalls = null;
        const onProgress = (step) => emit({ type: 'status', text: step });
        for await (const delta of chatStream(context, providerId, model, conversation, maxTokens, onProgress)) {
            if (delta && typeof delta === 'object' && Array.isArray(delta.__toolCalls)) {
                nativeToolCalls = delta.__toolCalls;
                continue;
            }
            assembled += delta;
            emit({ type: 'chunk', text: String(delta) });
        }

        /* Native tool_calls daisy-chain (openai / grok / deepseek / anthropic). */
        if (nativeToolCalls && nativeToolCalls.length && toolIterations < MAX_TOOL_ITERATIONS) {
            toolIterations++;
            conversation.push({ role: 'assistant', content: assembled || null, tool_calls: nativeToolCalls });
            for (const tc of nativeToolCalls) {
                const fname = (tc.function && tc.function.name) || '(unknown)';
                emit({ type: 'tool', phase: 'start', name: fname });
                let resultStr;
                try { resultStr = await executeNativeToolCall(tc, { cwd: projectFolder, panel: null, context }); }
                catch (e) { resultStr = `[executeNativeToolCall error: ${(e && e.message) || e}]`; }
                emit({ type: 'tool', phase: 'done', name: fname, bytes: (resultStr || '').length });
                conversation.push({ role: 'tool', tool_call_id: tc.id, content: String(resultStr || '') });
            }
            finalText = assembled;
            continue;
        }

        conversation.push({ role: 'assistant', content: assembled });
        finalText = assembled;

        /* # !exec fenced-block tool calls. */
        const calls = parseToolCalls(assembled);
        if (!calls.length || toolIterations >= MAX_TOOL_ITERATIONS) break;
        toolIterations++;
        const resultParts = [];
        for (const call of calls) {
            emit({ type: 'tool', phase: 'start', name: `${call.lang}` });
            const r = await executeToolCall(call, { cwd: projectFolder });
            resultParts.push(formatToolResult(call, r));
            emit({ type: 'tool', phase: 'done', name: `${call.lang}`, rc: r.rc, ms: r.durationMs });
        }
        conversation.push({ role: 'user', content: resultParts.join('\n\n') });
    }

    emit({ type: 'done', text: finalText });
    return finalText;
}

function startCliControlServer(context) {
    if (_cliServer) return _cliServer;
    const http = require('http');
    const pkgVersion = (() => {
        try { return require(path.join(context.extensionPath, 'package.json')).version || ''; }
        catch (e) { traceErr('CLI:version', e); return ''; }
    })();

    const readBody = (req) => new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => { buf += c.toString('utf8'); if (buf.length > 1024 * 1024) req.destroy(); });
        req.on('end', () => { let j = {}; try { j = buf ? JSON.parse(buf) : {}; } catch (e) { j = { __parseError: e.message }; } resolve(j); });
        req.on('error', () => resolve({}));
    });
    const sendJson = (res, code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    /* Registered route table — key-walked, no if/elif ladder. Each handler is
       async (req, res, body). GET /status is special-cased before the table. */
    const ROUTES = {
        '/reset': async (req, res) => {
            conversation = [];
            trace('CLI: conversation reset');
            sendJson(res, 200, { ok: true, convoLen: 0 });
        },
        '/update': async (req, res) => {
            try {
                pushUpdateToServer(context);
                sendJson(res, 200, { ok: true, message: 'push started — see logs/winscp_push_*.xml' });
            } catch (e) {
                traceErr('CLI:/update', e);
                sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
        },
        '/sendFile': async (req, res, body) => {
            const p = String(body.path || '').trim();
            if (!p || !fs.existsSync(p)) { sendJson(res, 400, { ok: false, error: 'file not found: ' + p }); return; }
            try {
                const MAX = 200 * 1024;
                const stat = fs.statSync(p);
                const raw = fs.readFileSync(p);
                const truncated = raw.length > MAX;
                const txt = (truncated ? raw.slice(0, MAX) : raw).toString('utf8');
                conversation.push({ role: 'user', content: `[attached file: ${path.basename(p)} (${stat.size} bytes)]\n\n${txt}${truncated ? '\n…[truncated at 200 KB]' : ''}` });
                trace(`CLI: staged file ${p} (${stat.size}B) into conversation`);
                sendJson(res, 200, { ok: true, name: path.basename(p), bytes: stat.size, truncated });
            } catch (e) {
                traceErr('CLI:/sendFile', e);
                sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
        },
        '/resume': async (req, res, body) => {
            /* CCLS resume nudge: inject text (default "...") into the LIVE panel
               session via the SAME handleSendText() path the auto-prompt uses
               (panel.js send() -> 'sendText' -> handleSendText). Focus/window-
               independent — unlike OS SendKeys or the disabled /input endpoint.
               Used by C:\hooks\claude_code_send_dot_do_dot.py after a cap rotate. */
            const text = (body && typeof body.text === 'string' && body.text.trim())
                ? body.text : '...';
            if (!activePanel) { sendJson(res, 409, { ok: false, error: 'no active panel' }); return; }
            try {
                Promise.resolve(handleSendText(context, activePanel, text, null))
                    .catch((e) => trace(`CLI:/resume handleSendText: ${(e && e.message) || e}`));
                trace(`CLI:/resume injected ${JSON.stringify(text)} via handleSendText`);
                sendJson(res, 200, { ok: true, sent: text });
            } catch (e) {
                traceErr('CLI:/resume', e);
                sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
        },
        '/chat': async (req, res, body) => {
            const message = String(body.message || '').trim();
            if (!message) { sendJson(res, 400, { ok: false, error: 'empty message' }); return; }
            /* Stream NDJSON: one JSON object per line. The CLI parses each line
               and prints chunk text live. */
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
            const writeLine = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
            try {
                await cliHeadlessChat(context, message, writeLine);
            } catch (e) {
                traceErr('CLI:/chat', e);
                writeLine({ type: 'error', message: String((e && e.message) || e) });
            }
            try { res.end(); } catch (_) {}
        },
    };

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/status') {
                const providerId = getActiveProvider(context);
                sendJson(res, 200, {
                    ok: true,
                    version: pkgVersion,
                    provider: providerId,
                    providerLabel: (PROVIDERS[providerId] && PROVIDERS[providerId].label) || providerId,
                    model: getActiveModel(context, providerId),
                    convoLen: conversation.length,
                    panelOpen: !!activePanel,
                });
                return;
            }
            const handler = ROUTES[req.url];
            if (req.method === 'POST' && handler) {
                const body = await readBody(req);
                await handler(req, res, body);
                return;
            }
            sendJson(res, 404, { ok: false, error: `no route ${req.method} ${req.url}` });
        } catch (e) {
            traceErr('CLI:server', e);
            try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (_) {}
        }
    });

    server.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
            trace(`CLI:server port ${CLI_CONTROL_PORT} already in use — another CBE window owns it; skipping.`);
        } else {
            traceErr('CLI:server listen', e);
        }
        _cliServer = null;
    });
    server.listen(CLI_CONTROL_PORT, '127.0.0.1', () => {
        trace(`CLI:server listening on 127.0.0.1:${CLI_CONTROL_PORT}`);
    });
    _cliServer = server;
    /* Dispose with the extension so the listener never leaks across reloads. */
    context.subscriptions.push({ dispose() { try { server.close(); } catch (_) {} _cliServer = null; } });
    return server;
}

/* ── Activation ───────────────────────────────────────────────────────── */

async function activate(context) {
    extensionContext = context;
    // Self-clean stale CBE installs BEFORE we register any command so future
    // launches don't hit "command 'codexBlackEd.openPanel' already exists".
    // Wrapped in try/catch — a cleanup failure must not block activation.
    try { await _cleanStaleCBEVersions(context); }
    catch (e) { console.warn('[CBE cleaner] top-level fail:', e); }
    // Verify Python / pip packages / Git / PowerShell are present and
    // current. If anything's missing, surfaces a single unified toast with
    // an "Install all" button that runs winget/brew/apt + pip in a visible
    // terminal. Cached for 24h so we don't probe on every reload.
    try { await _ensurePrerequisites(context); }
    catch (e) { console.warn('[CBE prereq] top-level fail:', e); }
    outChan = vscode.window.createOutputChannel('Codex Black');
    /* Clear stale entries from a previous activation so each run's timing
       is readable on its own. (VS Code keeps the OutputChannel alive across
       window reloads, so without this the log just keeps appending.) */
    try { outChan.clear(); } catch (e) { /* clear is best-effort */ }
    /* Print the clean banner — this is ALL the user sees in the Output
       Channel. Granular timing/traces go to debug.log on disk. */
    try {
        outChan.appendLine('Codex Black Ed. Loaded');
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
    /* Windows-only: pre-grant the per-exe microphone permission so STT
       getUserMedia() doesn't silent-fail on a fresh install. HKCU writes,
       no admin needed. Runs AFTER trace logging is wired so we can see
       what it did in debug.log. See _ensureMicPermission() for details. */
    try { await _ensureMicPermission(context); }
    catch (e) { console.warn('[CBE mic-perm] top-level fail:', e); }
    /* One-time STT provider migration (2026-05-27): users who had STT pinned
       to 'anthropic' kept hitting the "Anthropic STT: microphone access
       denied" red banner because the Anthropic Deepgram-proxy endpoint is
       undocumented and unreliable. Per user memory `elevenlabs_default.md`
       ElevenLabs is the canonical default. Migrate stale 'anthropic'
       selections to 'elevenlabs' ONCE per machine; the user can still pick
       'anthropic' explicitly afterwards if they want. */
    try {
        const MIG_KEY = '_cbeSttAnthropicMigrationDone';
        if (!context.globalState.get(MIG_KEY)) {
            const current = context.workspaceState.get(STATE_STT_PROVIDER);
            if (current === 'anthropic') {
                await context.workspaceState.update(STATE_STT_PROVIDER, 'elevenlabs');
                trace('STT migration: anthropic -> elevenlabs (one-time)');
            }
            await context.globalState.update(MIG_KEY, Date.now());
        }
    } catch (e) { console.warn('[CBE STT migration] failed:', e); }
    /* Drop any cached Config from a previous activation so this run picks
       up edits the user made to config.ini between sessions. */
    Config.invalidate();
    const endActivate = timeStep('activate()');
    trace('=== activate === extPath=' + context.extensionPath);
    trace('  log file: ' + path.join(context.extensionPath, 'debug.log'));
    /* Load *.bridge extension files from extensions/ so users can drop in
       new browser-bridge providers (DeepSeek etc.) without editing source.
       Each .bridge XML registers a provider id, port, exe, and models. */
    try {
        const loaded = loadBridgeExtensions(context.extensionPath);
        _bridgeExtensionsLoaded = loaded || [];
        if (loaded.length) {
            trace('BRIDGE_EXT:loaded count=' + loaded.length + ' ids=' + loaded.map(x => x.id).join(','));
            loaded.forEach(b => trace('  BRIDGE_EXT:' + b.id + ' port=' + b.port + ' enabled=' + (b.enabled ? '1' : '0') + ' by=' + (b.author || '?') + ' file=' + b.file));
        } else {
            trace('BRIDGE_EXT:none');
        }
    } catch (e) {
        traceErr('loadBridgeExtensions', e);
    }
    const endSecrets = timeStep('refreshSecretsCache');
    await refreshSecretsCache(context);
    endSecrets();
    trace('  secretsCache populated: ' + Object.keys(secretsCache).filter(k => secretsCache[k]).join(',') || '(none)');
    trace('  activeProvider=' + getActiveProvider(context) + ' model=' + getActiveModel(context, getActiveProvider(context)));
    /* One-shot seed of the user's known Gmail accounts. Gated by globalState
       so it never re-runs. See seedDefaultAccounts() for the seeding plan. */
    const endSeed = timeStep('  seedDefaultAccounts');
    try { seedDefaultAccounts(context); }
    catch (e) { console.warn('[CBE seed] top-level fail:', e); }
    endSeed();

    /* One-shot: seed an email account from config.ini [email] so the email
       panel works out-of-box. Skipped after the first run via globalState. */
    seedEmailAccountsFromConfigIni(context).catch(e =>
        console.warn('[CBE email-seed] top-level fail:', e));

    /* One-shot: bulk-seed every email the user owns (ALL_GMAILS +
       EXTRA_CLAUDE_EMAILS, 11 accounts total) so the Email panel's account
       dropdown is populated from the moment it opens. Gated by a separate
       globalState flag so a future seed run can add new addresses without
       re-doing what's already there. */
    seedAllEmailAccounts(context).catch(e =>
        console.warn('[CBE email-bulk-seed] top-level fail:', e));

    /* Fire-and-forget: cache the 30 most-recent .eml files per configured
       email account under <ext>/emails/<md5>.eml. Powers the bridge
       auto-login flow (scans cached inboxes for magic-link codes from
       Anthropic / Google / etc.). Deferred via setImmediate so the panel
       paints first; runs once per activate(). */
    setImmediate(() => {
        cacheRecentEmails(context).catch(e =>
            console.warn('[CBE email-cache] top-level fail:', e));
    });

    const endStatusBar = timeStep('  createStatusBarItem');
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBar.command = 'codexBlackEd.openPanel';
    // Explicit tooltip — VSCode's auto-rendered "(<keybinding>)" trailer
    // can be misleading when the registered keybinding loses to a built-in
    // resolver collision. Stating it directly here means hover text matches
    // what actually works on the user's keymap. The string is treated as
    // Markdown; backticks render the chord as code.
    statusBar.tooltip = 'Codex Black — click to open · `Ctrl+Alt+B`';
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
        /* /email → open the multi-account inbox panel. Direct passthrough
           to codexBlackEd.openEmail (no panel-side runner needed). */
        vscode.commands.registerCommand('codexBlackEd.slash.email', () =>
            vscode.commands.executeCommand('codexBlackEd.openEmail')),
        /* Email-client commands — small inbox-30 reader + send, multi-account.
           These are the user-reachable surface for the helpers added in the
           ── Email-client accounts ── block above. */
        vscode.commands.registerCommand('codexBlackEd.email.addAccount', async () => {
            try {
                const provider = await vscode.window.showQuickPick(EMAIL_PROVIDERS, {
                    title: 'Email provider', ignoreFocusOut: true,
                });
                if (!provider) return;
                const email = (await vscode.window.showInputBox({
                    title: 'Email address (the IMAP/SMTP login)',
                    ignoreFocusOut: true, placeHolder: 'you@gmail.com',
                }) || '').trim();
                if (!email) return;
                const password = (await vscode.window.showInputBox({
                    title: `App password for ${email}`,
                    prompt: 'For gmail/yahoo/outlook use an APP PASSWORD, not the account password.',
                    password: true, ignoreFocusOut: true,
                }) || '').trim();
                if (!password) return;
                const label = (await vscode.window.showInputBox({
                    title: 'Optional label (e.g. "personal", "work")',
                    ignoreFocusOut: true, value: email,
                }) || '').trim();
                const row = await addEmailAccount(context, { provider, email, password, label });
                vscode.window.showInformationMessage(`Added email account: ${row.email} (${row.provider})`);
            } catch (e) {
                traceErr('email.addAccount', e);
                vscode.window.showErrorMessage('Add email account failed: ' + (e.message || String(e)));
            }
        }),
        /* Consume an Anthropic magic-login link from the .eml cache to obtain
           a claude.ai session cookie. User-triggered; never auto-fires from
           activate. Quick-picks across configured Anthropic-capable accounts
           if --for-email isn't supplied. */
        vscode.commands.registerCommand('codexBlackEd.email.consumeMagicLink', async () => {
            try {
                const accounts = getEmailAccounts(context);
                let targetEmail = '';
                if (accounts.length) {
                    const pick = await vscode.window.showQuickPick(
                        accounts.map(a => ({ label: a.label || a.email, description: `${a.provider} — ${a.email}`, email: a.email })),
                        { title: 'Which email received the Anthropic magic link?', ignoreFocusOut: true });
                    if (!pick) return;
                    targetEmail = pick.email;
                } else {
                    targetEmail = (await vscode.window.showInputBox({
                        title: 'Email address that received the Anthropic magic link',
                        ignoreFocusOut: true, placeHolder: 'you@example.com',
                    }) || '').trim();
                    if (!targetEmail) return;
                }
                // Scan-only first so we can show the user what we found before consuming.
                const scan = await findAndConsumeClaudeMagicLink(context, targetEmail, { fetch: false });
                const hits = (scan && scan.matches) || [];
                if (!hits.length) {
                    vscode.window.showWarningMessage(
                        `No Anthropic magic-link found in cache for ${targetEmail}. ` +
                        `Trigger "Login with email" on claude.ai first, then wait for the next email-cache tick.`);
                    return;
                }
                const choice = await vscode.window.showWarningMessage(
                    `Found magic-link for ${hits[0].email} (token ${hits[0].token.slice(0, 8)}…). ` +
                    `Fetching this URL will CONSUME the link — you can't use it again. Proceed?`,
                    { modal: true }, 'Consume + login', 'Cancel');
                if (choice !== 'Consume + login') return;
                const result = await findAndConsumeClaudeMagicLink(context, targetEmail, { fetch: true });
                if (result && result.fetched && result.fetched.ok) {
                    vscode.window.showInformationMessage(
                        `Logged in as ${result.fetched.email}. Cookies dumped to ${result.cookieFile || '(memory only)'}.`);
                } else {
                    const err = (result && result.fetched && result.fetched.error) || (result && result.error) || 'unknown failure';
                    vscode.window.showErrorMessage(`Magic-link consume failed: ${err}`);
                }
            } catch (e) {
                traceErr('email.consumeMagicLink', e);
                vscode.window.showErrorMessage('Magic-link consume failed: ' + (e.message || String(e)));
            }
        }),
        vscode.commands.registerCommand('codexBlackEd.email.readInbox', async () => {
            try {
                const accounts = getEmailAccounts(context);
                if (!accounts.length) {
                    const pick = await vscode.window.showInformationMessage(
                        'No email accounts configured. Add one now?', 'Add account');
                    if (pick === 'Add account') vscode.commands.executeCommand('codexBlackEd.email.addAccount');
                    return;
                }
                const acc = await vscode.window.showQuickPick(
                    accounts.map(a => ({ label: a.label || a.email, description: `${a.provider} — ${a.email}`, id: a.id })),
                    { title: 'Which inbox?', ignoreFocusOut: true });
                if (!acc) return;
                const out = vscode.window.createOutputChannel('CBE Email');
                out.show(true);
                out.appendLine(`Fetching inbox-30 for ${acc.description} …`);
                const res = await fetchEmailInbox(context, acc.id, { max: 30 });
                if (!res.ok) { out.appendLine(`ERROR: ${res.error}`); return; }
                out.appendLine(`Got ${res.count} messages.\n`);
                for (const m of (res.emails || [])) {
                    out.appendLine(`──────────────────────────────────────────`);
                    out.appendLine(`From:    ${m.from}`);
                    out.appendLine(`Date:    ${m.date}`);
                    out.appendLine(`Subject: ${m.subject}`);
                    if (m.links && m.links.length) out.appendLine(`Links:   ${m.links.join(', ')}`);
                    if (m.body_preview) {
                        out.appendLine('');
                        out.appendLine(m.body_preview);
                    }
                    out.appendLine('');
                }
            } catch (e) {
                traceErr('email.readInbox', e);
                vscode.window.showErrorMessage('Read inbox failed: ' + (e.message || String(e)));
            }
        }),
        /* OAuth-token storage commands. Until the bridge-driven OAuth dance
           is fully landed, the user (or a future agent) can paste a token
           captured manually from claude.ai → DevTools → /switch flow. */
        vscode.commands.registerCommand('codexBlackEd.oauth.storeToken', async () => {
            try {
                const providers = Object.keys(PROVIDERS).filter(id => !PROVIDERS[id].bridge);
                const providerId = await vscode.window.showQuickPick(providers,
                    { title: 'OAuth token: which provider?', ignoreFocusOut: true });
                if (!providerId) return;
                const accounts = getProviderAccounts(context, providerId);
                if (!accounts.length) {
                    vscode.window.showErrorMessage(`No accounts configured for ${providerId} — add one first.`);
                    return;
                }
                const pick = await vscode.window.showQuickPick(
                    accounts.map(a => ({ label: a.label || a.email || maskKey(a.apiKey), description: a.id, id: a.id })),
                    { title: 'OAuth token: which account?', ignoreFocusOut: true });
                if (!pick) return;
                const raw = (await vscode.window.showInputBox({
                    title: `OAuth token JSON for ${pick.label}`,
                    prompt: 'Paste the JSON returned by tools/claude_oauth.py (access_token + refresh_token + expires_in).',
                    password: true, ignoreFocusOut: true,
                }) || '').trim();
                if (!raw) return;
                let parsed;
                try { parsed = JSON.parse(raw); }
                catch (e) { vscode.window.showErrorMessage('Not valid JSON: ' + e.message); return; }
                await storeAccountOAuthToken(context, providerId, pick.id, parsed);
                vscode.window.showInformationMessage(`Stored OAuth token for ${pick.label}.`);
            } catch (e) {
                traceErr('oauth.storeToken', e);
                vscode.window.showErrorMessage('Store OAuth token failed: ' + (e.message || String(e)));
            }
        }),
        vscode.commands.registerCommand('codexBlackEd.oauth.clearToken', async () => {
            try {
                const providers = Object.keys(PROVIDERS).filter(id => !PROVIDERS[id].bridge);
                const providerId = await vscode.window.showQuickPick(providers,
                    { title: 'Clear OAuth token: which provider?', ignoreFocusOut: true });
                if (!providerId) return;
                const accounts = getProviderAccounts(context, providerId);
                const pick = await vscode.window.showQuickPick(
                    accounts.map(a => ({ label: a.label || a.email || maskKey(a.apiKey), description: a.id, id: a.id })),
                    { title: 'Clear OAuth token: which account?', ignoreFocusOut: true });
                if (!pick) return;
                await clearAccountOAuthToken(context, providerId, pick.id);
                vscode.window.showInformationMessage(`Cleared OAuth token for ${pick.label}.`);
            } catch (e) {
                traceErr('oauth.clearToken', e);
                vscode.window.showErrorMessage('Clear OAuth token failed: ' + (e.message || String(e)));
            }
        }),
        vscode.commands.registerCommand('codexBlackEd.openEmail', () => {
            try {
                if (!_emailPanel) {
                    _emailPanel = vscode.window.createWebviewPanel(
                        'codexBlackEd.email',
                        'Email — CBE',
                        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                        { enableScripts: true, retainContextWhenHidden: true }
                    );
                    loadEmailPanelHtml(context, _emailPanel).catch(e =>
                        traceErr('loadEmailPanelHtml', e));
                    _emailPanel.onDidDispose(() => { _emailPanel = null; });
                } else {
                    _emailPanel.reveal(vscode.ViewColumn.Active);
                }
            } catch (e) {
                traceErr('openEmail command', e);
                vscode.window.showErrorMessage('Failed to open Email panel: ' + (e.message || String(e)));
            }
        }),
        vscode.commands.registerCommand('codexBlackEd.email.removeAccount', async () => {
            try {
                const accounts = getEmailAccounts(context);
                if (!accounts.length) { vscode.window.showInformationMessage('No email accounts to remove.'); return; }
                const acc = await vscode.window.showQuickPick(
                    accounts.map(a => ({ label: a.label || a.email, description: `${a.provider} — ${a.email}`, id: a.id })),
                    { title: 'Remove which account?', ignoreFocusOut: true });
                if (!acc) return;
                await removeEmailAccount(context, acc.id);
                vscode.window.showInformationMessage(`Removed: ${acc.label}`);
            } catch (e) {
                traceErr('email.removeAccount', e);
                vscode.window.showErrorMessage('Remove account failed: ' + (e.message || String(e)));
            }
        }),
        /* The codexBlackEd.claude.autoLoginAllAccounts command (Vision-Pilot
           claude.ai cookie-harvest orchestrator) was removed with the Claude
           browser bridge. Claude now uses the Anthropic API or the logged-in
           Claude Code subscription — neither needs a claude.ai web login. */
        /* If the user closes our terminal, drop the reference so the next
           click on the Terminal button creates a fresh one in the right cwd. */
        vscode.window.onDidCloseTerminal((t) => { if (t === cbeTerm) cbeTerm = null; }),
        outChan,
    );
    endCmds(`(${25} commands)`);

    /* Start the localhost CLI control server so the `cbe` command-line tool
       can drive this live extension (chat / status / reset / push / sendFile).
       Bound to 127.0.0.1:57838 only; disposed via context.subscriptions. */
    try { startCliControlServer(context); }
    catch (e) { traceErr('startCliControlServer', e); }

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
    /* Firstrun skin previews — generate any MISSING content-addressed
       thumbnails (deferred, never blocks boot). Batched (--all) so PySide6
       auto-installs ONCE and renders run sequentially, not 15 concurrent
       pip-install races. No-ops once every skin has a preview. user 2026-05-31. */
    setTimeout(() => { try { ensureSkinPreviews(context); } catch (e) { traceErr('ensureSkinPreviews', e); } }, 8000);
    /* Live model-list refresh — once per day, deferred, best-effort. Fetches
       each fetchable provider's current model list (so the dropdown shows
       e.g. opus-4-8 instead of the hardcoded opus-4-7) and caches it in
       globalState. Every fetch silent-fails to the hardcoded fallback — no
       dialog, trace-only. Never blocks activation. user 2026-05-31. */
    setTimeout(() => { ensureModelLists(context).catch(e => trace('MODELS:ENSURE failed ' + (e && e.message ? e.message : e))); }, 6000);
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
       Ollama is NOT a bridge — it's a local daemon. If the active provider is
       the local Ollama provider, discover + daemon-start it in the bg. */
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

    /* First-run welcome (deferred so the panel paints first). globalState gates
       it so the user sees it only once per install. */
    try { setTimeout(() => { try { maybeShowFirstRun(context); } catch (_) {} }, 1000); } catch (_) {}
}

/* First-run welcome notification — surfaces the keyless-by-default story
   and points users at config.ini for premium upgrades. globalState gate
   ensures it only fires once per install. */
const FIRST_RUN_KEY = 'codexBlackEd.firstRunShown';
function maybeShowFirstRun(context) {
    try {
        if (context.globalState.get(FIRST_RUN_KEY) === true) return;
    } catch (_) { return; }
    const msg =
        'Welcome to Codex Black Ed..\n\n' +
        'Works out of the box: voice is keyless (WebSpeech for TTS, whisper.cpp realtime for STT — ~75MB first-run download).\n\n' +
        'For higher-quality chat/voice, add keys in config.ini:\n' +
        '  • ElevenLabs / OpenAI / Anthropic for premium voice + chat\n' +
        '  • NameSilo for domain features\n' +
        'Or use a logged-in browser bridge (Claude / ChatGPT / Grok / Gemini / Copilot / Ollama).';
    const markShown = () => {
        try { context.globalState.update(FIRST_RUN_KEY, true); } catch (_) {}
    };
    try {
        vscode.window.showInformationMessage(msg, 'Open config.ini', 'Got it').then((choice) => {
            markShown();
            if (choice === 'Open config.ini') {
                try {
                    const cfgPath = path.join(context.extensionPath, CONFIG_INI_NAME);
                    if (!fs.existsSync(cfgPath)) {
                        // Some installs ship config.dist.ini; fall back to it for read-only viewing.
                        const dist = path.join(context.extensionPath, 'config.dist.ini');
                        if (fs.existsSync(dist)) {
                            vscode.workspace.openTextDocument(vscode.Uri.file(dist))
                                .then((doc) => vscode.window.showTextDocument(doc));
                            return;
                        }
                    }
                    vscode.workspace.openTextDocument(vscode.Uri.file(cfgPath))
                        .then((doc) => vscode.window.showTextDocument(doc));
                } catch (e) { traceErr('firstRun:openConfig', e); }
            }
        }, () => { markShown(); });
    } catch (e) {
        traceErr('maybeShowFirstRun', e);
        markShown();
    }
}

function deactivate() {
    trace('=== deactivate ===');
    /* Close the CLI control server explicitly. context.subscriptions already
       disposes it, but doing it here too guarantees the 57838 listener is
       released even if subscription teardown order changes. */
    try {
        if (_cliServer) { _cliServer.close(); _cliServer = null; trace('CLI:server closed on deactivate'); }
    } catch (e) { traceErr('deactivate:cliServer', e); }
    /* Kill any live realtime STT subprocesses (whisper.cpp stream / faster-
       whisper python) — the per-session capture handles its own ffmpeg
       teardown, this is a paranoia sweep for the subprocess + the venv
       python so a panel close doesn't leak. */
    try {
        for (const [, entry] of _activeRealtimeLocalStreams) {
            try { if (entry && entry.capture && entry.capture.stop) entry.capture.stop(); } catch (_) {}
            try { if (entry && entry.session) entry.session.close(); } catch (_) {}
        }
        _activeRealtimeLocalStreams.clear();
    } catch (_) {}
}

/* ── Settings payload (sent to webview to populate the settings modal) ── */

/* ── Skin discovery ───────────────────────────────────────────────────────
   FLAT single-file layout (2026-05-31). A skin is ONE self-contained HTML
   file directly under <extension>/skins:

     skins/<id>.html          — the FULL chat-panel HTML the skin owns (clone
                                of panel/index.html, restyled/relaid out by
                                the author). All {{TOKEN}} substitutions are
                                applied so panel.js, Prism, the shared asset
                                icons ({{ASSETS_BASE}}), sounds, and CSP_SOURCE
                                still resolve from the extension dirs at
                                runtime. The skin's palette + metadata
                                (name/accent/author/description) live in this
                                file's FIRST :root block as --cbe-skin-* /
                                --cbe-modal-* custom properties.
     skins/<id>.preview.png   — picker thumbnail (sibling file).
     skins/<id>-assets/       — ONLY for skins that ship their own assets
                                (icons, wallpaper, fonts). Referenced from the
                                HTML via the {{SKIN_BASE}} token, which the
                                loader points at this dir. Most skins have no
                                assets dir at all.

   Discovery is lazy (re-scanned on each listSkins/resolveSkin) so dropping a
   new `<id>.html` works without a reload. There is no manifest.xml and no
   separate styles.css — the .html file IS the skin. `.bak` snapshot files and
   `*.preview.png` are never treated as skins. */
/* skin <colors> tag <-> the CSS custom property it maps to. Used to scrape
   each skin's palette out of its `<id>.html` :root block. Mirrors
   applySkinColors() @ panel.js 2400-2412. */
const SKIN_COLOR_VARS = {
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

/* Extract the inner text of the FIRST `:root { ... }` block in a CSS/HTML
   string (the skin's head <style> defaults block, where Phase-0 wrote the
   palette + metadata). Returns '' if none. Brace-matched so a value with no
   nested braces resolves cleanly. */
function _firstRootBody(text) {
    const idx = text.indexOf(':root');
    if (idx < 0) return '';
    const open = text.indexOf('{', idx);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
    }
    return '';
}

/* Read a single CSS custom property value out of a :root body. Strips an
   optional surrounding pair of double-quotes (used for --cbe-skin-name so
   spaces/punctuation survive as a CSS token). */
function _readRootVar(rootBody, cssVar) {
    const re = new RegExp(`${cssVar.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:\\s*([^;]*)`);
    const m = re.exec(rootBody);
    if (!m) return '';
    let v = m[1].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    return v;
}

/* Phase-2 replacement for parseSkinManifest: read a skin's metadata + palette
   from its OWN index.html :root (the Phase-0 single-file contract) instead of
   manifest.xml. Returns the SAME shape callers relied on so the rest of the
   loader is unchanged:
     { id, name, accent, stylesheet, panelHtml, colors:{ 'modal-bg':..., ... } }
   `id` is derived from the folder name by the caller (passed in). Colors that
   the :root resolves to a var()-chain (e.g. an un-migrated code-bar default)
   are returned as '' so they fall through to the baked default — never pushed
   as a literal "var(--x)" string. */
function parseSkinHtmlMeta(indexHtmlPath, logicalId) {
    try {
        const html = fs.readFileSync(indexHtmlPath, 'utf8');
        const root = _firstRootBody(html);
        const name   = _readRootVar(root, '--cbe-skin-name');
        const accent = _readRootVar(root, '--cbe-skin-accent');
        const author = _readRootVar(root, '--cbe-skin-author');
        const desc   = _readRootVar(root, '--cbe-skin-description');
        const colors = {};
        for (const [tag, cssVar] of Object.entries(SKIN_COLOR_VARS)) {
            let v = _readRootVar(root, cssVar);
            /* Ignore var()-chained / empty values — let the baked default win. */
            if (!v || /^var\(/i.test(v)) v = '';
            colors[tag] = v;
        }
        /* Flat layout (2026-05-31): name falls back to a title-cased slug
           derived from the file's basename (`<id>.html`) when --cbe-skin-name
           is absent. */
        const fallbackName = (logicalId || '')
            .split('-').filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return {
            id:          logicalId || '',
            name:        name || fallbackName || logicalId || '',
            version:     '',
            author:      author || '',
            accent:      accent || '',
            /* No separate stylesheet in the single-file format; the .html IS
               the skin. Kept for shape-compat; never read by the loader now. */
            stylesheet:  '',
            /* The skin's own .html file is always the panel HTML. */
            panelHtml:   path.basename(indexHtmlPath),
            description: desc || '',
            colors,
        };
    } catch (_) {
        return null;
    }
}

/* Suffix marking a skin's optional sibling asset dir: `skins/<id>-assets/`.
   Only the few skins that ship their own icons/wallpaper/fonts have one;
   it's where the {{SKIN_BASE}} token resolves to for that skin. */
const SKIN_ASSETS_SUFFIX = '-assets';

/* Walk skins/ once and return a map of logical-id → { htmlPath, assetsDir }.
   FLAT layout (2026-05-31): each `skins/<id>.html` IS a skin. `assetsDir` is
   the absolute path to `skins/<id>-assets/` when that dir exists, else ''.
   `*.preview.png` files, `*.bak` snapshots, and `<id>-assets/` dirs are never
   themselves enumerated as skins. */
function _scanSkinDirs(context) {
    const dir = path.join(context.extensionPath, SKINS_DIR_NAME);
    const map = Object.create(null);
    let entries = [];
    try {
        if (!fs.existsSync(dir)) return map;
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        traceErr('_scanSkinDirs', e);
        return map;
    }
    for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!ent.name.endsWith('.html')) continue;
        /* `<id>.preview.png` is .png not .html, so already excluded; guard
           against stray `<id>.preview.html` or `.bak.html` just in case. */
        if (/\.(preview|bak)\b/i.test(ent.name)) continue;
        const logicalId = ent.name.slice(0, -'.html'.length);
        if (!logicalId) continue;
        const htmlPath  = path.join(dir, ent.name);
        const assetsDir = path.join(dir, `${logicalId}${SKIN_ASSETS_SUFFIX}`);
        map[logicalId] = {
            htmlPath,
            assetsDir: fs.existsSync(assetsDir) ? assetsDir : '',
        };
    }
    return map;
}

function listSkins(context, webview) {
    const scanned = _scanSkinDirs(context);
    const out = [];
    for (const id of Object.keys(scanned)) {
        const { htmlPath } = scanned[id];
        /* Flat single-file format: read label/accent/author/description/colors
           from the skin's own `<id>.html` :root. */
        const meta = parseSkinHtmlMeta(htmlPath, id);
        if (!meta) continue;
        /* Content-addressed preview thumbnail (Phase 5):
           `skins/previews/<id>-<md5[:6]>.png`. If absent, fire-and-forget a
           generation so it's ready next time; the picker shows a placeholder
           meanwhile. The md5 of the skin HTML is the cache key, so a saved
           edit self-refreshes the preview. */
        let previewUri = '';
        const pi = skinPreviewInfo(context, id);
        if (pi && pi.exists && webview) {
            previewUri = webview.asWebviewUri(vscode.Uri.file(pi.previewFsPath)).toString();
        } else if (pi && !pi.exists) {
            regenSkinPreview(context, id, false);
        }
        out.push({
            name:        id,                            /* logical id — picker value */
            label:       meta.name || id,               /* pretty display name from --cbe-skin-name */
            uri:         '',                            /* no external stylesheet — the .html IS the skin */
            previewUri,                                 /* optional rendered thumbnail */
            format:      'new',                         /* single retained format */
            hasPanelHtml: true,                         /* every skin is full-HTML now */
            accent:      meta.accent || '',
            author:      meta.author || '',
            description: meta.description || '',
            colors:      meta.colors || null,           /* modal palette, applied as :root --cbe-modal-* vars */
        });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
}

function resolveSkin(context, requestedName) {
    /* '' / unknown id → cleared skin. Otherwise return the resolved skin's
       on-disk paths so the caller can mount its HTML + resolve its asset base,
       plus the parsed modal-color palette.

       Returns: {
         name:          logical id ('' on miss) — what gets persisted,
         uri:           always null (no external stylesheet in flat layout),
         colors:        { 'modal-bg':..., 'modal-fg':..., … } OR null,
         format:        'new' | '',
         root:          absolute path to the skin's `<id>.html` ('' on miss),
         assetsDir:     absolute path to `skins/<id>-assets/` ('' if none),
         panelHtml:     basename of the skin's HTML file ('' on miss),
         panelHtmlPath: absolute path to the skin's HTML ('' on miss),
       } */
    const miss = { name: '', uri: null, colors: null, format: '', root: '', assetsDir: '', panelHtml: '', panelHtmlPath: '' };
    if (!requestedName) return miss;
    const safe = path.basename(requestedName);   /* strip any path traversal */
    if (!safe) return miss;
    /* The picker stores the logical id. Allow a `.html` suffix too so callers
       (tests / CLI) can pass the exact filename. */
    const scanned = _scanSkinDirs(context);
    let entry = scanned[safe] || null;
    if (!entry && safe.endsWith('.html')) {
        entry = scanned[safe.slice(0, -'.html'.length)] || null;
    }
    if (!entry) return miss;
    try {
        const logicalId = path.basename(entry.htmlPath).slice(0, -'.html'.length);
        if (!fs.existsSync(entry.htmlPath)) return miss;
        const meta = parseSkinHtmlMeta(entry.htmlPath, logicalId);
        if (!meta) return miss;
        return {
            name:          logicalId,
            uri:           null,
            colors:        meta.colors || null,
            format:        'new',
            root:          entry.htmlPath,
            assetsDir:     entry.assetsDir || '',
            panelHtml:     path.basename(entry.htmlPath),
            panelHtmlPath: entry.htmlPath,
        };
    } catch (_) {
        return miss;
    }
}

/* ── Skin editor backend (Phase 1/4/5) ───────────────────────────────────
   The in-app skin editor (Settings → Appearance) reads/writes the flat
   `skins/<id>.html` files. Every overwrite is non-destructive: we snapshot
   the current file to a human-readable `.bak` first, and a pristine copy of
   every factory skin lives in `skins-original-backup/` for Restore Original. */

/* Recursive directory copy (no deps). Creates dst, copies files + subdirs. */
function _copyDirRecursiveSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) _copyDirRecursiveSync(s, d);
        else if (ent.isFile()) fs.copyFileSync(s, d);
    }
}

/* Human-readable timestamp for `.bak` filenames, e.g. `Sunday-3-13-PM`.
   No deps — local time. */
function _bakTimestamp(d) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    d = d || new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${days[d.getDay()]}-${h}-${mm}-${ampm}`;
}

/* Snapshot `skins/<id>.html` → `skins/<id>.<Day>-<H>-<MM>-<AMPM>.bak` BEFORE
   any overwrite. `.bak` files are gitignored (`*.bak`) and the loader skips
   them (`_scanSkinDirs` only enumerates `*.html`, excluding `*.bak`). Returns
   the basename of the snapshot written, or '' if there was nothing to snapshot.
   Never throws into the caller — a snapshot failure must not block the save,
   but we trace it. */
function snapshotSkin(context, id) {
    try {
        const safe = path.basename(String(id || ''));
        if (!safe) return '';
        const src = path.join(context.extensionPath, SKINS_DIR_NAME, `${safe}.html`);
        if (!fs.existsSync(src)) return '';   /* nothing to snapshot (e.g. brand-new skin) */
        const bakName = `${safe}.${_bakTimestamp()}.bak`;
        const dst = path.join(context.extensionPath, SKINS_DIR_NAME, bakName);
        fs.copyFileSync(src, dst);
        trace(`SKIN:SNAPSHOT ${safe} -> ${bakName}`);
        return bakName;
    } catch (e) {
        traceErr('snapshotSkin', e);
        return '';
    }
}

/* Slugify a display name into a safe skin id: lowercase, spaces→'-', strip
   anything that isn't [a-z0-9-], collapse repeats, trim leading/trailing '-'.
   Returns '' when nothing usable survives (caller treats as invalid name). */
function slugifySkinName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/* Set (or insert) the `--cbe-skin-name: "..."` declaration in the FIRST :root
   block of a skin HTML string, so a Save-as-New picks up the entered display
   name in the picker. Best-effort: if there's no :root, returns html unchanged
   (loader falls back to the title-cased slug). Mirrors the :root-rewrite
   approach used by tools/inject_skin_authordesc.js. */
function setSkinNameInHtml(html, displayName) {
    try {
        const safeName = String(displayName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const decl = `--cbe-skin-name: "${safeName}";`;
        const rootIdx = html.indexOf(':root');
        if (rootIdx < 0) return html;
        const open = html.indexOf('{', rootIdx);
        if (open < 0) return html;
        /* Find the matching close brace of this :root block. */
        let depth = 0, close = -1;
        for (let i = open; i < html.length; i++) {
            const c = html[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { close = i; break; } }
        }
        if (close < 0) return html;
        const body = html.slice(open + 1, close);
        const re = /--cbe-skin-name\s*:\s*[^;]*;?/;
        let newBody;
        if (re.test(body)) {
            newBody = body.replace(re, decl);
        } else {
            /* Insert right after the opening brace, preserving indentation feel. */
            newBody = `\n    ${decl}${body}`;
        }
        return html.slice(0, open + 1) + newBody + html.slice(close);
    } catch (_) {
        return html;
    }
}

/* Fire-and-forget regen of a skin's content-addressed preview PNG. Non-blocking
   — the picker shows a placeholder until it lands; failures are traced only.
   Uses the same python command resolution as the rest of extension.js. */
function regenSkinPreview(context, id, force) {
    try {
        const safe = path.basename(String(id || ''));
        if (!safe) return;
        const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
        const args = ['-3', path.join('tools', 'gen_skin_preview.py'), '--skin', safe];
        if (force) args.push('--force');
        const proc = spawn(pyCmd, args, {
            cwd: context.extensionPath,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        if (proc.stderr) proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('error', e => traceErr('regenSkinPreview spawn', e));
        proc.on('close', code => {
            if (code !== 0) trace(`SKIN:PREVIEW regen ${safe} exit=${code} ${err.trim().slice(0, 300)}`);
            else trace(`SKIN:PREVIEW regen ${safe} ok`);
        });
    } catch (e) {
        traceErr('regenSkinPreview', e);
    }
}

/* Firstrun batch preview generation. Renders ALL missing skin thumbnails in
   ONE `gen_skin_preview.py --all` process (the script skips skins that already
   have a current preview), so the PySide6 auto-install happens ONCE and renders
   run sequentially — NOT 15 concurrent regenSkinPreview spawns each racing to
   pip-install PySide6. No-ops when every skin already has a preview. */
function ensureSkinPreviews(context) {
    try {
        const skinsDir = path.join(context.extensionPath, 'skins');
        const prevDir  = path.join(skinsDir, 'previews');
        const skins = fs.existsSync(skinsDir)
            ? fs.readdirSync(skinsDir).filter(n => n.toLowerCase().endsWith('.html')) : [];
        let have = 0;
        try { have = fs.existsSync(prevDir) ? fs.readdirSync(prevDir).filter(n => n.toLowerCase().endsWith('.png')).length : 0; } catch (_) {}
        if (!skins.length || have >= skins.length) { trace(`SKIN:PREVIEWS ok (${have}/${skins.length})`); return; }
        trace(`SKIN:PREVIEWS firstrun — have ${have}/${skins.length}, running gen_skin_preview --all (installs PySide6 once if needed)`);
        const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
        const script = path.join('tools', 'gen_skin_preview.py');
        const args = (process.platform === 'win32' ? ['-3', script] : [script]).concat(['--all']);
        const proc = spawn(pyCmd, args, { cwd: context.extensionPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        if (proc.stderr) proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('error', e => traceErr('ensureSkinPreviews spawn', e));
        proc.on('close', code => trace(`SKIN:PREVIEWS gen --all exit=${code}${code ? ' ' + err.trim().slice(0, 300) : ''}`));
        proc.unref();
    } catch (e) {
        traceErr('ensureSkinPreviews', e);
    }
}

/* Compute the content-addressed preview path for a skin: first 6 hex of the
   md5 of `skins/<id>.html`. Returns { previewFsPath, exists } or null. */
function skinPreviewInfo(context, id) {
    try {
        const safe = path.basename(String(id || ''));
        if (!safe) return null;
        const htmlPath = path.join(context.extensionPath, SKINS_DIR_NAME, `${safe}.html`);
        if (!fs.existsSync(htmlPath)) return null;
        const md5 = require('crypto').createHash('md5')
            .update(fs.readFileSync(htmlPath)).digest('hex').slice(0, 6);
        const previewFsPath = path.join(context.extensionPath, SKINS_DIR_NAME, 'previews', `${safe}-${md5}.png`);
        return { previewFsPath, exists: fs.existsSync(previewFsPath) };
    } catch (e) {
        traceErr('skinPreviewInfo', e);
        return null;
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
const SUPERVISOR_DISPLAY_NAME = 'Codex Black — VSCode Supervisor';
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
    // The extension lives under "...\Codex Black\tools\" — a path WITH
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
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Description       ${sq('Keeps VSCode (Code.exe) alive - relaunches on crash. Serves /status on :3434. Managed by Codex Black.')}`,
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
            /* Today's live-fetched list if cached, else the hardcoded
               PROVIDERS[id].models fallback (getProviderModels handles both). */
            models = getProviderModels(context, id);
        }
        /* Keep the saved/active model selectable. If it's still a valid id,
           surface it at the top. If a once-current model dropped out of the
           freshly-fetched list, fall back to the provider's defaultModel so
           the dropdown never shows a stale selection that no longer exists. */
        let currentModel = getActiveModel(context, id);
        if (currentModel && !models.includes(currentModel)) {
            if (models.length && p.defaultModel && models.includes(p.defaultModel)) {
                currentModel = p.defaultModel;
            } else {
                /* No usable default in the new list — keep showing the saved
                   id so the user isn't silently switched off it. */
                models.unshift(currentModel);
            }
        }
        return { id, label: p.label, models, current: currentModel, haveKey, bridge: !!p.bridge, bridgeTarget: p.bridgeTarget || null, cliAgent: !!p.cliAgent, local: !!p.local, localTarget: p.localTarget || null };
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
    /* Bridge tool-call config — hydrate the panel's Settings → Tool calls
       form. The panel only renders this section for bridge providers. */
    let toolCall;
    try {
        const tc = loadToolCallConfig(context);
        toolCall = {
            mode: tc.mode,
            maxSteps: tc.maxSteps,
            allowlist: tc.allowlist,
            timeoutS: Math.round(tc.timeoutMs / 1000),
        };
    } catch (_) {
        toolCall = { mode: 'allowlist', maxSteps: 10, allowlist: TOOL_CALL_DEFAULT_ALLOWLIST.slice(), timeoutS: 60 };
    }
    /* Bridge-operator config — hydrate Settings → Bridge Operator (the
       vision-pilot provider/model selector). */
    let bridgeOperator;
    try {
        bridgeOperator = loadBridgeOperatorConfig(context);
    } catch (_) {
        bridgeOperator = { provider: 'azure', azureDeployment: '', openaiModel: '', anthropicModel: '', geminiModel: '', vertexModel: '' };
    }
    /* Voice (TTS / STT) provider selection. TTS defaults to 'webspeech' —
       the only keyless TTS option (whisper.cpp doesn't synthesize). STT
       defaults to 'elevenlabs' (per elevenlabs_default.md); keyless realtime
       fallbacks are whisper-cpp-stream + faster-whisper-stream (~75MB and
       ~150MB respective one-time bootstraps). ElevenLabs / OpenAI remain the
       premium upgrades when the user drops keys into config.ini. The legacy
       host-side SpeechRecognition path was retired 2026-05-26; the batch
       whisper-local HTTP-server path was retired 2026-05-30 in favor of the
       two realtime streaming providers above. */
    const ttsProvider = getVoiceProvider(context, 'tts');
    const sttProvider = getVoiceProvider(context, 'stt');
    /* Voice tuning values (persisted in workspaceState; defaults match the
       panel-side window defaults). Shipped down so Settings → Read Aloud /
       Speech to Text hydrate their controls. */
    const ttsVoice  = String(context.workspaceState.get(STATE_TTS_VOICE) || '');
    const ttsRate   = (typeof context.workspaceState.get(STATE_TTS_RATE)   === 'number') ? context.workspaceState.get(STATE_TTS_RATE)   : 1;
    const ttsVolume = (typeof context.workspaceState.get(STATE_TTS_VOLUME) === 'number') ? context.workspaceState.get(STATE_TTS_VOLUME) : 1;
    const ttsOpenAiVoice = String(context.workspaceState.get(STATE_TTS_OPENAI_VOICE) || 'alloy');
    const ttsOpenAiSpeed = (typeof context.workspaceState.get(STATE_TTS_OPENAI_SPEED) === 'number') ? context.workspaceState.get(STATE_TTS_OPENAI_SPEED) : 1;
    const ttsElevenVoice = String(context.workspaceState.get(STATE_TTS_ELEVEN_VOICE) || '');
    const ttsElevenStability  = (typeof context.workspaceState.get(STATE_TTS_ELEVEN_STABILITY)  === 'number') ? context.workspaceState.get(STATE_TTS_ELEVEN_STABILITY)  : 0.5;
    const ttsElevenSimilarity = (typeof context.workspaceState.get(STATE_TTS_ELEVEN_SIMILARITY) === 'number') ? context.workspaceState.get(STATE_TTS_ELEVEN_SIMILARITY) : 0.75;
    const sttDictionary = String(context.workspaceState.get(STATE_STT_DICTIONARY) || '');
    const sttLanguage   = String(context.workspaceState.get(STATE_STT_LANGUAGE) || '');
    /* Tell the panel whether the host-side ElevenLabs key is present so the
       UI can show a "(no key)" hint next to the ElevenLabs option. We never
       send the key itself to the webview. */
    const haveElevenLabsKey = !!_getElevenLabsKey(context);
    const haveOpenAiKey     = !!getProviderKey(context, 'openai');
    return {
        providers,
        active,
        sfxEnabled: (typeof sfxEnabled === 'boolean') ? sfxEnabled : true,
        sfxVolume:  (typeof sfxVolume  === 'number')  ? sfxVolume  : 0.55,
        bigFont:    (typeof bigFont    === 'boolean') ? bigFont    : false,
        language: currentLang,
        languages: (i18n && i18n.meta) || [],
        strings: _languageStringsFor(context, currentLang),
        toolCall,
        bridgeOperator,
        ttsProvider,
        sttProvider,
        ttsVoice,
        ttsRate,
        ttsVolume,
        ttsOpenAiVoice,
        ttsOpenAiSpeed,
        ttsElevenVoice,
        ttsElevenStability,
        ttsElevenSimilarity,
        sttDictionary,
        sttLanguage,
        haveElevenLabsKey,
        haveOpenAiKey,
    };
}

/* Build the accounts payload for a single provider, masked for the webview.
   The webview NEVER receives raw apiKey / password values — only masked
   previews + the account id (used by [Use]/[Disable]/[Delete]). disabled is
   computed live so the UI can grey rate-limited rows.

   The new `accountType` field tells the panel which Add-form fields to render:
     'api_key'         — Direct-API providers (Anthropic/OpenAI/Grok/Gemini/
                         DeepSeek/Azure). Add form = Label + API Key.
     'email_password'  — Browser-bridge providers (claudeBridge/chatgptBridge/
                         grokBridge/geminiBridge/copilotBridge/deepseekBridge).
                         Add form = Label + Email + Password (drives the C++
                         tray exe's browser session).
     'none'            — Local-only (ollama / ollamaBridge). No Add UI; the
                         panel shows a "no account needed" hint.
   `bridge: true` STILL flags bridge providers for the legacy callers that
   branched on it, but it no longer suppresses the account list — bridges
   carry email_password accounts now. */
function buildAccountsPayload(context, providerId) {
    const p = PROVIDERS[providerId] || {};
    const isBridge = !!p.bridge;
    const accountType = defaultAccountType(providerId);
    const hasAccounts = providerHasAccounts(providerId);
    const accounts = hasAccounts ? getProviderAccounts(context, providerId) : [];
    const active = hasAccounts ? getActiveAccount(context, providerId) : null;
    const activeId = active ? active.id : null;
    return {
        provider: providerId,
        providerLabel: p.label || providerId,
        bridge: isBridge,
        accountType,        /* 'api_key' | 'email_password' | 'none' */
        hasAccounts,        /* false only for ollama/ollamaBridge */
        activeId,
        accounts: accounts.map(a => {
            const type = a.type === 'email_password' ? 'email_password' : 'api_key';
            const row = {
                id: a.id,
                type,
                label: a.label,
                addedAt: a.addedAt,
                lastUsedAt: a.lastUsedAt,
                disabledUntil: a.disabledUntil,
                disabled: _accountDisabled(a),
                active: a.id === activeId,
            };
            if (type === 'email_password') {
                row.email = a.email || '';
                row.maskedPassword = maskPassword(a.password);
            } else {
                /* api_key rows also carry the identity-tag email so the panel
                   can show which gmail owns the key. May be empty string for
                   legacy rows that have no associated gmail. */
                row.email = a.email || '';
                row.maskedKey = maskKey(a.apiKey);
            }
            return row;
        }),
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
        'Codex Black',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'panel')),
                vscode.Uri.file(path.join(context.extensionPath, 'assets')),
                vscode.Uri.file(path.join(context.extensionPath, 'lib')),
                vscode.Uri.file(path.join(context.extensionPath, 'sounds')),
                /* Skins live in /skins as flat `<id>.html` files (+ optional
                   `<id>-assets/` dirs + `<id>.preview.png` thumbnails). The
                   active skin's HTML is mounted as the panel via getPanelHtml;
                   its assets + preview resolve through asWebviewUri under this
                   root. The skin list is discovered lazily on Settings-open, so
                   dropping a new `<id>.html` works without restarting the panel. */
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
                    /* Resolve the persisted skin only for its logical name —
                       single-file skins (Phase 0/2) carry their CSS + palette
                       inside the already-mounted index.html :root, so there is
                       NO styles.css URI to push and NO runtime color push (D6).
                       Default to codex-black on fresh install (matches the
                       getPanelHtml fallback set 2026-05-26 for Jack Clark demo). */
                    const savedSkinName = context.workspaceState.get(STATE_SKIN, 'codex-black') || 'codex-black';
                    const resolved = resolveSkin(context, savedSkinName);
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
                        /* skinUri / skinColors retired (Phase 2 / D6): the active
                           skin's `<id>.html` (already mounted by getPanelHtml) owns
                           its CSS + palette in :root. Nothing to push at runtime. */
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
                       per message). MIME-aware: text -> raw utf8, image ->
                       base64 + dataUri (later wired into multimodal image_url),
                       other binary -> base64 with explicit binary flag so the
                       panel doesn't paste garbage chars into the outgoing
                       prompt. Oversized / unreadable files surface as
                       info/error messages but don't block the rest of the
                       batch. */
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
                            const mime = _sniffMime(fp);
                            let kind = _classifyFile(mime);
                            /* If MIME said text but the file looks binary,
                               override to binary. This catches mislabeled .txt
                               files that are actually binary blobs. */
                            if (kind === 'text') {
                                let bin = 0;
                                for (let i = 0; i < buf.length && i < 4096; i++) {
                                    const c = buf[i];
                                    if (c === 0 || (c < 9) || (c > 13 && c < 32)) bin++;
                                }
                                const looksBinary = bin > Math.max(2, Math.min(40, buf.length / 100));
                                if (looksBinary) kind = 'binary';
                            }
                            const payload = {
                                type: 'attachFile',
                                name: path.basename(fp),
                                path: fp,
                                ext: path.extname(fp).replace(/^\./, ''),
                                mime,
                                kind,
                                bytes: stat.size,
                            };
                            if (kind === 'text') {
                                payload.text = buf.toString('utf8');
                            } else if (kind === 'image') {
                                payload.base64 = buf.toString('base64');
                                payload.dataUri = `data:${mime};base64,${payload.base64}`;
                                payload.text = `(image ${path.basename(fp)}, ${mime}, ${stat.size} bytes)`;
                            } else {
                                payload.base64 = buf.toString('base64');
                                payload.text = `(binary file ${path.basename(fp)}, ${mime}, ${stat.size} bytes)`;
                            }
                            panel.webview.postMessage(payload);
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
                case 'openEmail':
                    await vscode.commands.executeCommand('codexBlackEd.openEmail');
                    break;
                /* /switch (account) — delegate to the real Claude Code extension's
                   logout command so the user lands in Claude Code's official
                   re-login flow, NOT CBE's local Accounts modal. User asked:
                   "/switch account is opening the settings modal in the
                   extension but it needs to use the same code Claude Code uses".
                   Per [[feedback-never-touch-anthropic-dir]] we never modify
                   Claude Code's source — we just invoke its published command. */
                /* (duplicate logout-only 'claudeCodeSwitchAccount' case removed
                   2026-05-31 — it shadowed the intended auth-picker case below,
                   now the sole handler, which posts showAuthPicker → rendered by
                   panel.js. Per [[feedback-never-touch-anthropic-dir]].) */
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
                case 'revealProjectFolder': {
                    /* Clicking the project pill when a folder IS set opens it in
                       the OS file explorer (user 2026-05-31). */
                    const cur = context.workspaceState.get('codexBlackEd.projectFolder', '');
                    if (cur && fs.existsSync(cur)) {
                        try { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cur)); }
                        catch (_) { try { await vscode.env.openExternal(vscode.Uri.file(cur)); } catch (__) {} }
                    } else {
                        /* Stale/missing folder — fall back to the picker. */
                        try { panel.webview.postMessage({ type: 'projectFolder', path: '' }); } catch (_) {}
                    }
                    break;
                }
                case 'clearProjectFolder': {
                    /* The ✕ on the project pill unsets the folder → back to
                       "no project folder" (user 2026-05-31). */
                    await context.workspaceState.update('codexBlackEd.projectFolder', '');
                    panel.webview.postMessage({ type: 'projectFolder', path: '' });
                    break;
                }
                case 'sendText':
                    await handleSendText(context, panel, msg.text || '', Array.isArray(msg.images) ? msg.images : null);
                    break;
                case 'cancelInFlight':
                    /* Stop button. The panel posts this when the user clicks
                       #stopBtn (panel.js:770). We set a flag the streaming
                       loop in handleSendText checks each iteration, then break
                       out and post assistantDone so the UI clears.

                       BUT — if the active provider is a browser bridge, the
                       async iterator is blocked on a network read inside
                       streamBridge, NOT on the per-chunk JS loop. Flipping
                       __cbeCancel alone wouldn't actually unblock it. So we
                       ALSO destroy the in-flight socket (published on
                       context.__cbeActiveBridgeSocket by streamBridge), which
                       makes the awaited promise reject with a "stopped" error.
                       That falls into handleSendText's catch block, which
                       posts the error message AND clears setBusy on the panel
                       — the teardown the user actually wants. */
                    panel.__cbeCancel = true;
                    try {
                        const _sock = context && context.__cbeActiveBridgeSocket;
                        if (_sock && !_sock.destroyed) {
                            _sock.destroy(new Error('stopped by user'));
                        }
                        if (context) context.__cbeActiveBridgeSocket = null;
                    } catch (_e) { /* swallow — best-effort */ }
                    /* Logged-in Claude agent: kill the in-flight `claude` child. */
                    try {
                        const _ch = panel.__cbeClaudeChild;
                        if (_ch && !_ch.killed) { _ch.kill(); }
                        panel.__cbeClaudeChild = null;
                    } catch (_e) { /* best-effort */ }
                    panel.webview.postMessage({ type: 'info', text: 'Stopped.' });
                    /* Force a teardown signal in case the stream loop is
                       blocked somewhere the cancel flag won't reach. The
                       panel's 'cancelled' handler clears setBusy and marks
                       the partial bubble. */
                    panel.webview.postMessage({ type: 'cancelled' });
                    break;
                case 'reset':
                    conversation = [];
                    /* Drop the logged-in Claude agent session so the next turn
                       starts a brand-new `claude` session (no --resume). */
                    panel.__cbeClaudeSessionId = null;
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
                case 'setSttProvider':
                    /* Dedicated STT-only persistence — used by the panel's
                       sandbox-auto-promote (webspeech → elevenlabs at click
                       time) without disturbing the active LLM provider. */
                    if (typeof msg.sttProvider === 'string' && VOICE_PROVIDERS.includes(msg.sttProvider)) {
                        await context.workspaceState.update(STATE_STT_PROVIDER, msg.sttProvider);
                        trace('STT provider persisted (setSttProvider): ' + msg.sttProvider);
                    }
                    break;
                case 'setProviderKey': {
                    /* In-Settings API key save. Writes config.ini under the
                       provider's [section] key. Mirrors the bumpRunCount /
                       pinned-extensions write pattern (writeConfigPatch +
                       Config.reload). Section + key chosen by the panel from
                       KEY_PROVIDER_META — webspeech / whisper-cpp-stream /
                       faster-whisper-stream / anthropic-OAuth never get here.
                       Added 2026-05-30 — user feedback: "DG needs a key. BUT
                       theres no where in settings to actually ENTER the key!" */
                    try {
                        const section = String(msg.section || '').trim();
                        const keyName = String(msg.key || 'api_key').trim();
                        const value   = String(msg.value || '').trim();
                        if (!section || !value) {
                            panel.webview.postMessage({ type: 'providerKeySaved', ok: false, error: 'missing section or value' });
                            break;
                        }
                        if (!/^[A-Za-z0-9_-]+$/.test(section) || !/^[A-Za-z0-9_-]+$/.test(keyName)) {
                            panel.webview.postMessage({ type: 'providerKeySaved', ok: false, error: 'invalid section/key chars' });
                            break;
                        }
                        const iniPath = path.join(context.extensionPath, CONFIG_INI_NAME);
                        writeConfigPatch(iniPath, { [`${section}.${keyName}`]: value });
                        try { if (Config && Config.reload) Config.reload(context.extensionPath); } catch (_) {}
                        trace(`provider key saved: [${section}] ${keyName} = (${value.length} chars)`);
                        panel.webview.postMessage({ type: 'providerKeySaved', ok: true, section, key: keyName });
                    } catch (e) {
                        traceErr('setProviderKey', e);
                        panel.webview.postMessage({ type: 'providerKeySaved', ok: false, error: (e && e.message) || String(e) });
                    }
                    break;
                }
                case 'fetchElevenLabsVoices': {
                    /* Settings → Read Aloud (TTS) → ElevenLabs Voice dropdown.
                       Calls GET https://api.elevenlabs.io/v1/voices and posts
                       {type:'elevenLabsVoicesResult', ok, voices:[{voice_id,name,...}]}
                       back to the panel. Used to replace the raw 20-char Voice
                       ID text input with a real selector. Added 2026-05-30 —
                       user feedback: "htf are they supposed [to know] the 16
                       digit alpha numeric voice id?" */
                    try {
                        const key = _getElevenLabsKey(context);
                        if (!key) {
                            panel.webview.postMessage({ type: 'elevenLabsVoicesResult', ok: false, error: 'no [elevenlabs] api_key in config.ini — save one in Settings first' });
                            break;
                        }
                        const res = await fetch('https://api.elevenlabs.io/v1/voices', {
                            headers: { 'xi-api-key': key, 'Accept': 'application/json' },
                        });
                        if (!res.ok) {
                            const errText = await res.text().catch(() => '');
                            panel.webview.postMessage({ type: 'elevenLabsVoicesResult', ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` });
                            break;
                        }
                        const body = await res.json();
                        const voices = Array.isArray(body.voices) ? body.voices : [];
                        trace(`elevenlabs voices fetched: ${voices.length}`);
                        panel.webview.postMessage({ type: 'elevenLabsVoicesResult', ok: true, voices: voices.map(v => ({ voice_id: v.voice_id, name: v.name, category: v.category })) });
                    } catch (e) {
                        traceErr('fetchElevenLabsVoices', e);
                        panel.webview.postMessage({ type: 'elevenLabsVoicesResult', ok: false, error: (e && e.message) || String(e) });
                    }
                    break;
                }
                case 'listOperatorModels': {
                    /* Settings → Bridge Operator → model/deployment dropdown.
                       Lists models/deployments for the requested operator
                       provider so the panel (CSP-blocked from calling these
                       endpoints directly) can populate the selector.
                         azure     — ARM deployments list (service principal)
                         openai    — GET /v1/models
                         anthropic — GET /v1/models
                         gemini    — GET /v1beta/models
                       Returns {type:'operatorModelsResult', ok, provider, models:[{id,detail}]}. */
                    const provider = String(msg.provider || '').toLowerCase().trim();
                    const reply = (ok, models, error) => panel.webview.postMessage({
                        type: 'operatorModelsResult', ok, provider, models: models || [], error: error || '',
                    });
                    try {
                        const cfg = readConfigIni(context.extensionPath) || {};
                        if (provider === 'azure') {
                            const az = cfg.azure || {};
                            const tenant = String(az.tenant_id || '').trim();
                            const cid = String(az.client_id || '').trim();
                            const csec = String(az.client_secret || '').trim();
                            const sub = String(az.subscription_id || '').trim();
                            const rg = String(az.resource_group || '').trim();
                            const acct = String(az.account_name || '').trim();
                            if (!(tenant && cid && csec && sub && rg && acct)) {
                                reply(false, [], 'missing Azure service-principal creds in config.ini [azure]');
                                break;
                            }
                            const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: new URLSearchParams({
                                    grant_type: 'client_credentials', client_id: cid, client_secret: csec,
                                    scope: 'https://management.azure.com/.default',
                                }).toString(),
                            });
                            if (!tokRes.ok) { reply(false, [], `AAD token HTTP ${tokRes.status}`); break; }
                            const tok = (await tokRes.json()).access_token;
                            const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}`
                                + `/providers/Microsoft.CognitiveServices/accounts/${acct}/deployments?api-version=2024-10-01`;
                            const dRes = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
                            if (!dRes.ok) { reply(false, [], `ARM HTTP ${dRes.status}`); break; }
                            const body = await dRes.json();
                            const models = (body.value || []).map(d => ({
                                id: d.name,
                                detail: ((d.properties && d.properties.model && d.properties.model.name) || ''),
                            }));
                            trace(`operator models (azure): ${models.length} deployments`);
                            reply(true, models);
                            break;
                        }
                        if (provider === 'openai') {
                            const key = String((cfg.api_keys || {}).openai_api_key || '').trim();
                            if (!key) { reply(false, [], 'no openai_api_key in config.ini'); break; }
                            const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
                            if (!r.ok) { reply(false, [], `OpenAI HTTP ${r.status}`); break; }
                            const body = await r.json();
                            const models = (body.data || []).map(m => ({ id: m.id, detail: '' }))
                                .filter(m => /gpt|o1|o3|o4/i.test(m.id));
                            reply(true, models);
                            break;
                        }
                        if (provider === 'anthropic') {
                            const key = String((cfg.api_keys || {}).anthropic_api_key || '').trim();
                            if (!key) { reply(false, [], 'no anthropic_api_key in config.ini'); break; }
                            const r = await fetch('https://api.anthropic.com/v1/models', {
                                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                            });
                            if (!r.ok) { reply(false, [], `Anthropic HTTP ${r.status}`); break; }
                            const body = await r.json();
                            const models = (body.data || []).map(m => ({ id: m.id, detail: m.display_name || '' }));
                            reply(true, models);
                            break;
                        }
                        if (provider === 'gemini') {
                            const key = String((cfg.api_keys || {}).gemini_api_key || '').trim();
                            if (!key) { reply(false, [], 'no gemini_api_key in config.ini'); break; }
                            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
                            if (!r.ok) { reply(false, [], `Gemini HTTP ${r.status}`); break; }
                            const body = await r.json();
                            const models = (body.models || [])
                                .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                                .map(m => ({ id: String(m.name || '').replace(/^models\//, ''), detail: m.displayName || '' }));
                            reply(true, models);
                            break;
                        }
                        if (provider === 'vertex') {
                            // Vertex models on Google Cloud (ADC). gemini-2.5-flash
                            // is verified on project triodesktop; offer the 2.5 family.
                            reply(true, [
                                { id: 'gemini-2.5-flash', detail: 'fast · vision · verified' },
                                { id: 'gemini-2.5-pro', detail: 'higher quality' },
                                { id: 'gemini-2.5-flash-lite', detail: 'cheapest' },
                            ]);
                            break;
                        }
                        reply(false, [], `unknown provider '${provider}'`);
                    } catch (e) {
                        traceErr('listOperatorModels', e);
                        reply(false, [], (e && e.message) || String(e));
                    }
                    break;
                }
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
                    /* Voice (TTS / STT) provider persistence. Validate against
                       the allowed list before writing so a malformed message
                       can't poison the state. */
                    if (typeof msg.ttsProvider === 'string' && VOICE_PROVIDERS.includes(msg.ttsProvider)) {
                        await context.workspaceState.update(STATE_TTS_PROVIDER, msg.ttsProvider);
                    }
                    if (typeof msg.sttProvider === 'string' && VOICE_PROVIDERS.includes(msg.sttProvider)) {
                        await context.workspaceState.update(STATE_STT_PROVIDER, msg.sttProvider);
                    }
                    /* Voice tuning — validate/clamp each value before persisting so
                       a malformed webview message can't poison the state. */
                    if (typeof msg.ttsVoice === 'string') {
                        await context.workspaceState.update(STATE_TTS_VOICE, msg.ttsVoice.slice(0, 200));
                    }
                    if (typeof msg.ttsRate === 'number' && Number.isFinite(msg.ttsRate)) {
                        await context.workspaceState.update(STATE_TTS_RATE, Math.max(0.1, Math.min(10, msg.ttsRate)));
                    }
                    if (typeof msg.ttsVolume === 'number' && Number.isFinite(msg.ttsVolume)) {
                        await context.workspaceState.update(STATE_TTS_VOLUME, Math.max(0, Math.min(1, msg.ttsVolume)));
                    }
                    if (typeof msg.ttsOpenAiVoice === 'string' && OPENAI_TTS_VOICES.includes(msg.ttsOpenAiVoice)) {
                        await context.workspaceState.update(STATE_TTS_OPENAI_VOICE, msg.ttsOpenAiVoice);
                    }
                    if (typeof msg.ttsOpenAiSpeed === 'number' && Number.isFinite(msg.ttsOpenAiSpeed)) {
                        await context.workspaceState.update(STATE_TTS_OPENAI_SPEED, Math.max(0.25, Math.min(4, msg.ttsOpenAiSpeed)));
                    }
                    if (typeof msg.ttsElevenVoice === 'string') {
                        await context.workspaceState.update(STATE_TTS_ELEVEN_VOICE, msg.ttsElevenVoice.trim().slice(0, 100));
                    }
                    if (typeof msg.ttsElevenStability === 'number' && Number.isFinite(msg.ttsElevenStability)) {
                        await context.workspaceState.update(STATE_TTS_ELEVEN_STABILITY, Math.max(0, Math.min(1, msg.ttsElevenStability)));
                    }
                    if (typeof msg.ttsElevenSimilarity === 'number' && Number.isFinite(msg.ttsElevenSimilarity)) {
                        await context.workspaceState.update(STATE_TTS_ELEVEN_SIMILARITY, Math.max(0, Math.min(1, msg.ttsElevenSimilarity)));
                    }
                    if (typeof msg.sttDictionary === 'string') {
                        /* Cap at a generous 4KB — keyterm/prompt biasing doesn't
                           benefit from megabytes and we don't want to bloat state. */
                        await context.workspaceState.update(STATE_STT_DICTIONARY, msg.sttDictionary.slice(0, 4096));
                    }
                    if (typeof msg.sttLanguage === 'string') {
                        /* Permissive: a BCP-47 tag or '' (auto). Strip anything that
                           isn't a letter/digit/hyphen so it can't inject params. */
                        await context.workspaceState.update(STATE_STT_LANGUAGE, msg.sttLanguage.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16));
                    }
                    if (typeof msg.skin === 'string') {
                        /* Validate the skin filename against what's actually on disk
                           right now — refusing arbitrary strings keeps a malformed
                           webview message from injecting a stray <link href>. Empty
                           string clears the skin.

                           Flat single-file skins own the full panel HTML, so
                           a `postMessage`+`<link href>` swap can't reach them —
                           we re-mount panel.webview.html via getPanelHtml() which
                           picks up the new skin's `<id>.html`. Switching to a
                           cleared/empty skin (no panelHtmlPath) also remounts so
                           the default panel/index.html comes back. The legacy
                           CSS-overlay `applySkin` postMessage branch below is now
                           only reached for the empty/cleared case. */
                        const prev = context.workspaceState.get(STATE_SKIN, '') || '';
                        const prevResolved = prev ? resolveSkin(context, prev) : null;
                        const wasFullHtml = !!(prevResolved && prevResolved.panelHtmlPath);
                        const safe = resolveSkin(context, msg.skin);
                        const isFullHtml = !!safe.panelHtmlPath;
                        await context.workspaceState.update(STATE_SKIN, safe.name);
                        if (isFullHtml || wasFullHtml) {
                            try {
                                panel.webview.html = getPanelHtml(context, panel.webview);
                                trace(`SKIN:REMOUNT prev=${prev}(fullHtml=${wasFullHtml}) -> ${safe.name}(fullHtml=${isFullHtml})`);
                            } catch (e) {
                                traceErr('SKIN:REMOUNT', e);
                            }
                        } else {
                            panel.webview.postMessage({
                                type: 'applySkin',
                                skin: safe.name,
                                skinUri: safe.uri ? panel.webview.asWebviewUri(safe.uri).toString() : '',
                                skinColors: safe.colors || null,
                            });
                        }
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
                    const _provInfoLine = `Provider → ${PROVIDERS[msg.provider].label} · ${msg.model || getActiveModel(context, msg.provider)}`;
                    if (_provInfoLine !== _lastProviderInfoLine) {
                        _lastProviderInfoLine = _provInfoLine;
                        panel.webview.postMessage({ type: 'info', text: _provInfoLine });
                    }
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
                    /* Bridge tool-call settings (Settings → Tool calls). The
                       panel ships these alongside provider/model/skin. Stored
                       in config.ini [bridge] so they survive reinstall and
                       can be edited manually. Empty values keep the current
                       config (the panel only sends them when the user touched
                       the section). */
                    if (msg.toolCall && typeof msg.toolCall === 'object') {
                        try {
                            const patch = {};
                            const tc = msg.toolCall;
                            if (typeof tc.mode === 'string') {
                                const m = tc.mode.toLowerCase();
                                if (['off', 'allowlist', 'confirm', 'auto'].includes(m)) {
                                    patch['bridge.tool_call_mode'] = m;
                                }
                            }
                            if (typeof tc.maxSteps === 'number' && tc.maxSteps > 0) {
                                patch['bridge.tool_call_max_steps'] = String(Math.max(1, Math.min(50, Math.floor(tc.maxSteps))));
                            }
                            if (Array.isArray(tc.allowlist)) {
                                const cleaned = tc.allowlist.map(s => String(s).trim()).filter(Boolean);
                                patch['bridge.tool_call_allowlist'] = cleaned.join('|');
                            }
                            if (typeof tc.timeoutS === 'number' && tc.timeoutS > 0) {
                                patch['bridge.tool_call_timeout_s'] = String(Math.max(1, Math.min(600, Math.floor(tc.timeoutS))));
                            }
                            if (Object.keys(patch).length) {
                                writeConfigPatch(path.join(context.extensionPath, 'config.ini'), patch);
                                try { Config.invalidate(); } catch (_) {}
                                trace(`tool-call config patched: ${Object.keys(patch).join(', ')}`);
                            }
                        } catch (e) {
                            traceErr('save tool-call config', e);
                        }
                    }
                    /* Bridge-operator settings (Settings → Bridge Operator).
                       Persisted in config.ini [bridge_operator] so start.py's
                       provider-aware _InlineChatGPTHook reads the same source. */
                    if (msg.bridgeOperator && typeof msg.bridgeOperator === 'object') {
                        try {
                            const patch = {};
                            const bo = msg.bridgeOperator;
                            if (typeof bo.provider === 'string') {
                                const p = bo.provider.toLowerCase().trim();
                                if (BRIDGE_OPERATOR_PROVIDERS.includes(p)) patch['bridge_operator.provider'] = p;
                            }
                            const sanitizeModel = (v) => String(v || '').trim().slice(0, 120);
                            if (typeof bo.azureDeployment === 'string' && bo.azureDeployment.trim()) patch['bridge_operator.azure_deployment'] = sanitizeModel(bo.azureDeployment);
                            if (typeof bo.openaiModel === 'string' && bo.openaiModel.trim()) patch['bridge_operator.openai_model'] = sanitizeModel(bo.openaiModel);
                            if (typeof bo.anthropicModel === 'string' && bo.anthropicModel.trim()) patch['bridge_operator.anthropic_model'] = sanitizeModel(bo.anthropicModel);
                            if (typeof bo.geminiModel === 'string' && bo.geminiModel.trim()) patch['bridge_operator.gemini_model'] = sanitizeModel(bo.geminiModel);
                            if (typeof bo.vertexModel === 'string' && bo.vertexModel.trim()) patch['bridge_operator.vertex_model'] = sanitizeModel(bo.vertexModel);
                            if (Object.keys(patch).length) {
                                writeConfigPatch(path.join(context.extensionPath, 'config.ini'), patch);
                                try { Config.invalidate(); } catch (_) {}
                                trace(`bridge-operator config patched: ${Object.keys(patch).join(', ')}`);
                            }
                        } catch (e) {
                            traceErr('save bridge-operator config', e);
                        }
                    }
                    break;
                /* ── Bridge tool-call confirmation response ───────────────
                   awaitToolConfirm() in the bridge loose-tool-call path
                   posts a `toolConfirm` request and stores a resolver on
                   panel.__cbeToolConfirmResolvers[id]. The panel's UI
                   answers with `toolConfirmResponse { id, allow }`. */
                case 'toolConfirmResponse': {
                    try {
                        const id = msg.id;
                        const allow = !!msg.allow;
                        const resolvers = panel.__cbeToolConfirmResolvers || {};
                        const r = resolvers[id];
                        if (r) {
                            delete resolvers[id];
                            r(allow);
                        }
                    } catch (e) { traceErr('toolConfirmResponse', e); }
                    break;
                }
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
                    /* Reject providers with no account concept (Ollama). */
                    if (!providerHasAccounts(pid)) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: `${p.label || pid} is local — no account needed.` });
                        break;
                    }
                    /* Decide which account type this provider expects. Caller
                       MAY pass an explicit `accountType` for future toggles, but
                       today we always derive it from the provider. */
                    const wantType = msg.accountType === 'email_password' || msg.accountType === 'api_key'
                        ? msg.accountType
                        : defaultAccountType(pid);
                    const accounts = getProviderAccounts(context, pid);
                    const label = String(msg.label || '').trim();
                    let acc;
                    if (wantType === 'email_password') {
                        if (!p.bridge) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: `${p.label || pid} doesn't take an email+password — use an API key.` });
                            break;
                        }
                        const email = String(msg.email || '').trim();
                        const password = String(msg.password || '');
                        const shape = validateLoginShape(email, password);
                        if (!shape.ok) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid login: ${shape.reason}.` });
                            break;
                        }
                        if (accounts.some(a => (a.type || 'api_key') === 'email_password' && a.email && a.email.toLowerCase() === email.toLowerCase())) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That email is already in the list for this provider.' });
                            break;
                        }
                        acc = {
                            id: _newAccountId(),
                            type: 'email_password',
                            label: label || email || `account ${accounts.length + 1}`,
                            email,
                            password,
                            addedAt: new Date().toISOString(),
                            lastUsedAt: null,
                            disabledUntil: null,
                        };
                    } else {
                        if (p.bridge) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Bridge providers authenticate in the browser — use email+password, not an API key.' });
                            break;
                        }
                        const key = String(msg.apiKey || '').trim();
                        const shape = validateKeyShape(pid, key);
                        if (!shape.ok) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid key: ${shape.reason}.` });
                            break;
                        }
                        if (accounts.some(a => (a.type || 'api_key') === 'api_key' && a.apiKey === key)) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That key is already in the list.' });
                            break;
                        }
                        /* api_key rows may carry an optional identity-tag
                           email (the gmail that owns this key). Empty is fine. */
                        const tagEmailRaw = String(msg.email || '').trim();
                        let tagEmail = null;
                        if (tagEmailRaw) {
                            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tagEmailRaw)) {
                                panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Email looks invalid.' });
                                break;
                            }
                            tagEmail = tagEmailRaw;
                        }
                        acc = {
                            id: _newAccountId(),
                            type: 'api_key',
                            label: label || `account ${accounts.length + 1}`,
                            email: tagEmail,
                            apiKey: key,
                            addedAt: new Date().toISOString(),
                            lastUsedAt: null,
                            disabledUntil: null,
                        };
                    }
                    accounts.push(acc);
                    setProviderAccounts(context, pid, accounts);
                    /* First account added becomes active automatically. */
                    if (accounts.length === 1) await setActiveAccount(context, pid, acc.id);
                    if (acc.type === 'email_password') {
                        trace(`ACCOUNTS:ADD provider=${pid} type=email_password label=${acc.label} email=${acc.email} total=${accounts.length}`);
                    } else {
                        trace(`ACCOUNTS:ADD provider=${pid} type=api_key label=${acc.label} key=${maskKey(acc.apiKey)} total=${accounts.length}`);
                    }
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
                /* Edit an existing account's label and/or credentials in place.
                   Every field is optional; api_key accounts can edit label + key,
                   email_password accounts can edit label + email + password. New
                   creds are shape-validated and de-duped against the rest of the
                   provider's account list. NEVER log raw secrets — mask first. */
                case 'editAccount': {
                    const pid = PROVIDERS[msg.provider] ? msg.provider : getActiveProvider(context);
                    const p = PROVIDERS[pid] || {};
                    if (!providerHasAccounts(pid)) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: `${p.label || pid} is local — no account to edit.` });
                        break;
                    }
                    const accounts = getProviderAccounts(context, pid);
                    const target = accounts.find(a => a.id === msg.accountId);
                    if (!target) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Account not found.' });
                        break;
                    }
                    const targetType = target.type === 'email_password' ? 'email_password' : 'api_key';
                    const hasLabel    = Object.prototype.hasOwnProperty.call(msg, 'label')    && String(msg.label    || '').trim() !== '';
                    const hasKey      = Object.prototype.hasOwnProperty.call(msg, 'apiKey')   && String(msg.apiKey   || '').trim() !== '';
                    const hasEmail    = Object.prototype.hasOwnProperty.call(msg, 'email')    && String(msg.email    || '').trim() !== '';
                    const hasPassword = Object.prototype.hasOwnProperty.call(msg, 'password') && String(msg.password || '')        !== '';
                    if (!hasLabel && !hasKey && !hasEmail && !hasPassword) {
                        panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Nothing to change.' });
                        break;
                    }
                    if (targetType === 'email_password') {
                        if (hasKey) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'This account uses an email+password — editing the API key is not applicable.' });
                            break;
                        }
                        const newEmail = hasEmail ? String(msg.email).trim() : target.email;
                        const newPw    = hasPassword ? String(msg.password) : target.password;
                        if (hasEmail || hasPassword) {
                            const shape = validateLoginShape(newEmail, newPw);
                            if (!shape.ok) {
                                panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid login: ${shape.reason}.` });
                                break;
                            }
                        }
                        if (hasEmail && accounts.some(a => a.id !== target.id && (a.type || 'api_key') === 'email_password' && (a.email || '').toLowerCase() === newEmail.toLowerCase())) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That email is already in the list for this provider.' });
                            break;
                        }
                        if (hasEmail) target.email = newEmail;
                        if (hasPassword) target.password = newPw;
                    } else {
                        /* api_key rows accept an `email` edit (identity tag,
                           not a credential) and a `apiKey` edit. They REJECT
                           `password` — there's no password on an api_key row. */
                        if (hasPassword) {
                            panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'This account uses an API key — editing the password is not applicable.' });
                            break;
                        }
                        if (hasEmail) {
                            const newEmail = String(msg.email).trim();
                            /* Cheap shape check — empty was already filtered by hasEmail. */
                            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
                                panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'Email looks invalid.' });
                                break;
                            }
                            target.email = newEmail;
                        }
                        if (hasKey) {
                            const newKey = String(msg.apiKey).trim();
                            const shape = validateKeyShape(pid, newKey);
                            if (!shape.ok) {
                                panel.webview.postMessage({ type: 'accountError', provider: pid, message: `Invalid key: ${shape.reason}.` });
                                break;
                            }
                            if (accounts.some(a => a.id !== target.id && (a.type || 'api_key') === 'api_key' && a.apiKey === newKey)) {
                                panel.webview.postMessage({ type: 'accountError', provider: pid, message: 'That key is already in the list.' });
                                break;
                            }
                            target.apiKey = newKey;
                            /* A key change invalidates a cached SDK client bound to it. */
                            if (anthropicClient && pid === 'anthropic') anthropicClient = null;
                        }
                    }
                    if (hasLabel) target.label = String(msg.label).trim();
                    setProviderAccounts(context, pid, accounts);
                    if (targetType === 'email_password') {
                        trace(`ACCOUNTS:EDIT provider=${pid} id=${target.id} type=email_password label=${target.label} email=${target.email} pwChanged=${hasPassword}`);
                    } else {
                        trace(`ACCOUNTS:EDIT provider=${pid} id=${target.id} type=api_key label=${target.label} email=${target.email || '(none)'} key=${maskKey(target.apiKey)} keyChanged=${hasKey} emailChanged=${hasEmail}`);
                    }
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
                    }).catch((e) => {
                        traceErr('pullOllamaModel', e);
                        /* 2026-05-30: ensure the panel's Pull button gets
                           re-enabled on throw — without this `fail` message
                           the spinner stays forever (updateOllamaPullProgress
                           only resets the button on step === 'done' | 'fail'). */
                        if (activePanel) {
                            activePanel.webview.postMessage({
                                type: 'ollamaPullStatus',
                                step: 'fail',
                                model: name,
                                text: `Pull error: ${e && e.message || e}`,
                            });
                        }
                    });
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
                /* ── Skin editor backend (Phase 4) ─────────────────────────
                   Read/write the flat `skins/<id>.html` files for the in-app
                   editor (Settings → Appearance). All writes are non-destructive
                   (snapshot to .bak first). Contract messages match the panel.js
                   editor side verbatim — do not rename. */
                case 'getSkinSource': {
                    /* {type:'getSkinSource', id} → {type:'skinSource', id, ok, html, error?} */
                    const id = path.basename(String(msg.id || ''));
                    try {
                        if (!id) throw new Error('missing skin id');
                        const htmlPath = path.join(context.extensionPath, SKINS_DIR_NAME, `${id}.html`);
                        if (!fs.existsSync(htmlPath)) throw new Error(`no such skin: ${id}`);
                        const html = fs.readFileSync(htmlPath, 'utf8');
                        panel.webview.postMessage({ type: 'skinSource', id, ok: true, html });
                    } catch (e) {
                        traceErr('getSkinSource', e);
                        panel.webview.postMessage({ type: 'skinSource', id, ok: false, error: String(e && e.message || e) });
                    }
                    break;
                }
                case 'saveSkin': {
                    /* {type:'saveSkin', id, html} → {type:'skinSaved', id, ok, bak?, error?}
                       Snapshot → overwrite → regen preview (non-blocking) → remount
                       so the edit shows live (NO VSCode reload). */
                    const id = path.basename(String(msg.id || ''));
                    try {
                        if (!id) throw new Error('missing skin id');
                        if (typeof msg.html !== 'string') throw new Error('missing html');
                        const htmlPath = path.join(context.extensionPath, SKINS_DIR_NAME, `${id}.html`);
                        if (!fs.existsSync(htmlPath)) throw new Error(`no such skin: ${id}`);
                        const bak = snapshotSkin(context, id);              /* non-destructive */
                        fs.writeFileSync(htmlPath, msg.html, 'utf8');
                        regenSkinPreview(context, id, true);               /* html changed → force */
                        /* Remount the panel if THIS is the active skin, reusing the
                           same getPanelHtml path the skin-change handler uses. */
                        try {
                            const active = context.workspaceState.get(STATE_SKIN, '') || '';
                            if (path.basename(active) === id) {
                                panel.webview.html = getPanelHtml(context, panel.webview);
                                trace(`SKIN:SAVE remount active skin ${id}`);
                            }
                        } catch (e) { traceErr('saveSkin remount', e); }
                        panel.webview.postMessage({ type: 'skinSaved', id, ok: true, bak });
                    } catch (e) {
                        traceErr('saveSkin', e);
                        panel.webview.postMessage({ type: 'skinSaved', id, ok: false, error: String(e && e.message || e) });
                    }
                    break;
                }
                case 'saveSkinAsNew': {
                    /* {type:'saveSkinAsNew', fromId, name, html}
                         → {type:'skinSavedAsNew', ok, newId?, error?}
                       Slugify name → collision-check → write skins/<slug>.html +
                       skins-original-backup/<slug>.html (R1: new skin's pristine
                       original = its creation state). Copy <fromId>-assets/ if any. */
                    try {
                        if (typeof msg.html !== 'string') throw new Error('missing html');
                        const slug = slugifySkinName(msg.name);
                        if (!slug) throw new Error('invalid skin name');
                        const skinsDir  = path.join(context.extensionPath, SKINS_DIR_NAME);
                        const backupDir = path.join(context.extensionPath, SKINS_BACKUP_DIR_NAME);
                        const newHtmlPath = path.join(skinsDir, `${slug}.html`);
                        if (fs.existsSync(newHtmlPath)) throw new Error(`a skin named "${slug}" already exists`);

                        /* Stamp the entered display name into the new skin's :root
                           so the picker labels it correctly. */
                        const stamped = setSkinNameInHtml(msg.html, msg.name);
                        fs.writeFileSync(newHtmlPath, stamped, 'utf8');

                        /* R1: the new skin's pristine "Restore Original" point is
                           its creation state — write the SAME html to the backup. */
                        fs.mkdirSync(backupDir, { recursive: true });
                        fs.writeFileSync(path.join(backupDir, `${slug}.html`), stamped, 'utf8');

                        /* If the source skin had an assets dir, clone it to the new
                           skin (and into the backup) so asset refs still resolve. */
                        const fromId = path.basename(String(msg.fromId || ''));
                        if (fromId) {
                            const srcAssets = path.join(skinsDir, `${fromId}${SKIN_ASSETS_SUFFIX}`);
                            if (fs.existsSync(srcAssets) && fs.statSync(srcAssets).isDirectory()) {
                                _copyDirRecursiveSync(srcAssets, path.join(skinsDir, `${slug}${SKIN_ASSETS_SUFFIX}`));
                                _copyDirRecursiveSync(srcAssets, path.join(backupDir, `${slug}${SKIN_ASSETS_SUFFIX}`));
                            }
                        }
                        regenSkinPreview(context, slug, false);
                        trace(`SKIN:SAVEASNEW ${fromId || '?'} -> ${slug}`);
                        panel.webview.postMessage({ type: 'skinSavedAsNew', ok: true, newId: slug });
                    } catch (e) {
                        traceErr('saveSkinAsNew', e);
                        panel.webview.postMessage({ type: 'skinSavedAsNew', ok: false, error: String(e && e.message || e) });
                    }
                    break;
                }
                case 'restoreSkinOriginal': {
                    /* {type:'restoreSkinOriginal', id} → {type:'skinRestored', id, ok, error?}
                       Snapshot current → copy skins-original-backup/<id>.html (+assets)
                       over skins/<id>.html → regen preview → remount. Errors clearly
                       if there's no factory original for this skin. */
                    const id = path.basename(String(msg.id || ''));
                    try {
                        if (!id) throw new Error('missing skin id');
                        const skinsDir  = path.join(context.extensionPath, SKINS_DIR_NAME);
                        const backupDir = path.join(context.extensionPath, SKINS_BACKUP_DIR_NAME);
                        const bakHtml = path.join(backupDir, `${id}.html`);
                        if (!fs.existsSync(bakHtml)) throw new Error(`no factory original for "${id}"`);
                        snapshotSkin(context, id);                          /* even Restore is non-destructive */
                        fs.copyFileSync(bakHtml, path.join(skinsDir, `${id}.html`));
                        /* Restore the backed-up assets dir too, if present. */
                        const bakAssets = path.join(backupDir, `${id}${SKIN_ASSETS_SUFFIX}`);
                        if (fs.existsSync(bakAssets) && fs.statSync(bakAssets).isDirectory()) {
                            _copyDirRecursiveSync(bakAssets, path.join(skinsDir, `${id}${SKIN_ASSETS_SUFFIX}`));
                        }
                        regenSkinPreview(context, id, true);
                        try {
                            const active = context.workspaceState.get(STATE_SKIN, '') || '';
                            if (path.basename(active) === id) {
                                panel.webview.html = getPanelHtml(context, panel.webview);
                                trace(`SKIN:RESTORE remount active skin ${id}`);
                            }
                        } catch (e) { traceErr('restoreSkinOriginal remount', e); }
                        panel.webview.postMessage({ type: 'skinRestored', id, ok: true });
                    } catch (e) {
                        traceErr('restoreSkinOriginal', e);
                        panel.webview.postMessage({ type: 'skinRestored', id, ok: false, error: String(e && e.message || e) });
                    }
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
                            /* Append .bridge entries (extensions/*.bridge) so the
                               marketplace shows installable chat bridges next to
                               regular .ext extensions. Each bridge becomes a card
                               with type='bridge_chat' and an iconUri pointing at
                               its local PNG resolved through panel.webview.asWebviewUri. */
                            try {
                                for (const b of (_bridgeExtensionsLoaded || [])) {
                                    let iconUri = '';
                                    if (b.iconFile) {
                                        const abs = path.join(context.extensionPath, 'extensions', b.iconFile);
                                        if (fs.existsSync(abs)) {
                                            iconUri = panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
                                        }
                                    }
                                    items.push({
                                        id: b.id,
                                        name: b.name || b.id,
                                        version: b.version || '',
                                        author: b.author || '',
                                        created: b.released || '',
                                        md5: '',
                                        bytes: 0,
                                        minCore: '',
                                        description: b.description || '',
                                        fileUrl: '',
                                        entry: '',
                                        icon: '',
                                        iconUri,
                                        tags: ['bridge_chat'],
                                        type: 'bridge_chat',
                                        bridge: {
                                            port: b.port,
                                            exeName: b.exeName,
                                            mainUrl: b.mainUrl,
                                            loginUrl: b.loginUrl,
                                            createAccountUrl: b.createAccountUrl,
                                            models: b.models,
                                            defaultModel: b.defaultModel,
                                        },
                                        installed: !!b.enabled,
                                        installedEntry: '',
                                        installedVer: b.version || '',
                                        pinned: pinned.includes(b.id),
                                    });
                                }
                            } catch (e) { traceErr('EXT:CATALOG:merge-bridges', e); }
                            trace(`EXT:CATALOG:OK url=${catalogUrl} count=${items.length} installed=${installedMap.size} pinned=${pinned.length} bridges=${(_bridgeExtensionsLoaded || []).length}`);
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
                    /* Open our named "Codex Black" terminal so the user
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
                            name: 'Codex Black',
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
                case 'claudeCodeSwitchAccount': {
                    /* /switch, /switch account, /switch-accounts — show CBE's
                       OWN rebranded auth picker (3 buttons: Claude.ai
                       Subscription / Anthropic Console / Bedrock/Foundry/Vertex).
                       Mirrors Claude Code's login screen but stays inside CBE
                       per [[feedback-never-touch-anthropic-dir]]. */
                    panel.webview.postMessage({ type: 'showAuthPicker' });
                    break;
                }
                /* 'claudeAutoLoginAll' message + the
                   codexBlackEd.claude.autoLoginAllAccounts command were
                   removed with the Claude browser bridge. Claude now uses the
                   Anthropic API or logged-in Claude Code — no claude.ai web
                   cookie harvest, so no Vision-Pilot auto-login. */
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
                    /* Legacy fallback path: webview's Web Speech API got
                       `not-allowed` (VSCode sandboxes the iframe). Whisper-
                       local needs the panel to do MediaRecorder capture +
                       sttRequest with audioB64, so we just surface a hint
                       asking the user to switch STT provider explicitly. */
                    startHostSttHint(panel);
                    break;
                case 'sttStop':
                    stopHostStt();
                    break;
                case 'sttHostStart':
                    /* PRIMARY STT path: capture the mic in the Node host via
                       ffmpeg dshow (webview getUserMedia is sandbox-blocked
                       regardless of the OS grant to Code.exe). */
                    handleHostSttStart(panel, context, msg);
                    break;
                case 'sttHostStop':
                    /* Stop host capture + transcribe via the existing provider
                       dispatch (ElevenLabs Scribe by default). Result comes
                       back as sttRequestResult and pastes into the input. */
                    handleHostSttStop(panel, context, msg);
                    break;
                case 'sttHostStartEl':
                    /* ElevenLabs Scribe v2 Realtime (streaming WS). Opens
                       ffmpeg → host WS → partial transcripts stream back to
                       the panel as sttDeltaEl events. Final commit comes as
                       sttResultEl. On WS error / 401 we silently fall through
                       to the batch sttHostStart path. */
                    handleSttHostStartElevenLabs(panel, context, msg);
                    break;
                case 'sttHostStopEl':
                    /* Mic-up for the ElevenLabs streaming path. Stops ffmpeg
                       + sends end_of_stream to the WS; final transcript posts
                       as sttResultEl. */
                    handleSttHostStopElevenLabs(panel, context, msg);
                    break;
                case 'sttHostStartDg':
                    /* Deepgram Nova-3 streaming (BYO key). Host ffmpeg → Deepgram
                       WS → sttDeltaEl partials / sttResultEl final. Falls back to
                       the batch REST path on WS / auth failure. */
                    handleSttHostStartDeepgram(panel, context, msg);
                    break;
                case 'sttHostStopDg':
                    handleSttHostStopDeepgram(panel, context, msg);
                    break;
                case 'sttHostStartWcpp':
                    /* Realtime local: whisper.cpp `stream` example binary
                       fed PCM via stdin. Same ffmpeg dshow capture as the
                       ElevenLabs path; partials post as sttDeltaEl, final
                       as sttResultEl. Lazy-downloads the stream.exe + tiny
                       model on first use. */
                    handleSttHostStartRealtimeLocal(panel, context, msg, 'whisper-cpp-stream');
                    break;
                case 'sttHostStopWcpp':
                    handleSttHostStopRealtimeLocal(panel, context, msg);
                    break;
                case 'sttHostStartFw':
                    /* Realtime local: faster-whisper (CTranslate2) + webrtcvad
                       sliding window. Lazy-bootstraps a per-repo venv at
                       repo-root/venv-whisper on first use (~150MB download). */
                    handleSttHostStartRealtimeLocal(panel, context, msg, 'faster-whisper-stream');
                    break;
                case 'sttHostStopFw':
                    handleSttHostStopRealtimeLocal(panel, context, msg);
                    break;
                case 'ttsRequest':
                    /* Server-side TTS: panel handed us text + provider; we
                       call ElevenLabs / OpenAI and return base64 mp3 so the
                       panel plays it in an <audio> element. WebSpeech is
                       handled entirely panel-side and never reaches here. */
                    handleTtsRequest(panel, context, msg);
                    break;
                case 'sttRequest':
                    /* Server-side STT: panel handed us a base64 audio blob
                       (from MediaRecorder) + provider; we transcribe via
                       ElevenLabs Scribe / OpenAI gpt-4o-transcribe and
                       return the text. */
                    handleSttRequest(panel, context, msg);
                    break;
                case 'sttStreamStart':
                    /* Live STT: panel is about to stream raw PCM off the mic.
                       Open the provider WS session (anthropic only) keyed by
                       reqId; partials flow back as sttPartial, final as
                       sttFinal. See createAnthropicSttSession. */
                    handleSttStreamStart(panel, context, msg);
                    break;
                case 'sttStreamChunk':
                    /* A ~100ms base64 linear16 PCM chunk for an open stream. */
                    handleSttStreamChunk(panel, context, msg);
                    break;
                case 'sttStreamStop':
                    /* Mic stopped — flush + finalize the open stream. */
                    handleSttStreamStop(panel, context, msg);
                    break;
                case 'openWindowsMicSettings':
                    /* User clicked the "Open Windows Privacy → Microphone"
                       link in a mic-denied banner (panel.js addMicDeniedMsg).
                       Opens the OS-level toggle one click away. (Trent 2026-05-27.) */
                    try {
                        if (process.platform === 'win32') {
                            vscode.env.openExternal(vscode.Uri.parse('ms-settings:privacy-microphone'));
                        } else if (process.platform === 'darwin') {
                            vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
                        } else {
                            vscode.window.showInformationMessage('Grant microphone access to VSCode in your OS privacy settings, then click the mic again.');
                        }
                    } catch (_) {}
                    break;
                case '_cbeDbg':
                    /* Diagnostic mirror from panel.js — we serialize the
                       FULL payload so the click trace (handler firing,
                       ancestor pointer-events chain, elementFromPoint
                       result) is readable in debug.log without DevTools. */
                    try {
                        const _cp = JSON.parse(JSON.stringify(msg));
                        delete _cp.type;
                        trace('_cbeDbg ' + (_cp.tag || '?') + ' ' + JSON.stringify(_cp));
                    } catch (_) { trace('_cbeDbg (unserializable)'); }
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
        /* No per-panel STT teardown — whisper-server is a long-lived child
           reaped in deactivate(). */
    });
}

function getPanelHtml(context, webview) {
    const endHtml = timeStep('getPanelHtml');
    /* The active skin provides the entire panel HTML in the flat single-file
       layout: when `resolveSkin` returns a `panelHtmlPath` (always, for a
       known skin = `skins/<id>.html`) we read THAT instead of the default
       panel/index.html. All template tokens ({{PANEL_JS_URI}}, {{ASSETS_BASE}},
       {{SKIN_BASE}}, {{CSP_SOURCE}}, etc.) are substituted the same way, so the
       skin's panel.js / shared assets / Prism / sounds still resolve from the
       extension's panel/ + assets/ + lib/ + sounds/ dirs, and the skin's OWN
       assets resolve from skins/<id>-assets/ via {{SKIN_BASE}}. A cleared /
       unknown skin falls through to panel/index.html unchanged. */
    /* Fresh-install default: codex-black (the Claude-Code clone look).
       Existing users' picks are preserved — only kicks in when nothing was
       previously saved. 2026-05-26: set as default for Jack Clark demo. */
    const savedSkinName = context.workspaceState.get(STATE_SKIN, 'codex-black') || 'codex-black';
    const resolvedSkin = savedSkinName ? resolveSkin(context, savedSkinName) : null;
    let htmlPath;
    let htmlSource;
    if (resolvedSkin && resolvedSkin.panelHtmlPath) {
        htmlPath = resolvedSkin.panelHtmlPath;
        htmlSource = `skin:${resolvedSkin.name}/${resolvedSkin.panelHtml}`;
    } else {
        htmlPath = path.join(context.extensionPath, 'panel', 'index.html');
        htmlSource = 'panel/index.html';
    }
    const endRead = timeStep(`  read ${htmlSource}`);
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
    /* SKIN_BASE: the active skin's OWN assets (icons, fonts, wallpaper)
       live under `skins/<id>-assets/` in the flat layout. That dir is what
       {{SKIN_BASE}} resolves to so the skin's url('{{SKIN_BASE}}/icons/...')
       refs reach the right files. Skins with no assets dir (most of them),
       and the no-skin fallback, point {{SKIN_BASE}} at the extension's shared
       assets dir so the token is always a safe substitution. */
    const skinBaseFs = (resolvedSkin && resolvedSkin.assetsDir)
        ? resolvedSkin.assetsDir
        : path.join(context.extensionPath, 'assets');
    const skinBaseUri = webview.asWebviewUri(vscode.Uri.file(skinBaseFs));
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
    html = html.split('{{SKIN_BASE}}').join(skinBaseUri.toString());
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
        '[Codex Black Ed. · automatic session context]',
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
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file on disk. Creates parent dirs as needed. Refuses paths under VSCode extension dirs (anthropic.*). Returns {ok, path, bytes} on success.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
                    content: { type: 'string', description: 'Content to write. If encoding is binary-base64, this is the base64-encoded body.' },
                    mode: { type: 'string', enum: ['w', 'a', 'x'], description: 'w=overwrite (default), a=append, x=fail if file exists.' },
                    encoding: { type: 'string', enum: ['utf-8', 'binary-base64'], description: 'utf-8 (default) or binary-base64 to decode the content arg as base64.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_file',
            description: 'Send a file from disk to the chat UI as a downloadable attachment bubble. The user sees a paperclip chip with a Download link. Use for outputs the user should grab (generated docs, transcripts, images, archives, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file on disk.' },
                    displayName: { type: 'string', description: 'Optional display name (defaults to basename).' },
                    mime: { type: 'string', description: 'Optional MIME type (auto-detected from extension if omitted).' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'upload_file',
            description: 'Upload a local file to OpenAI Files API. Returns a file_id you can reference in vision / Responses / Assistants calls. Use this when you need to attach a file (image, PDF, document) for a follow-up model call rather than echoing its bytes.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file on disk.' },
                    purpose: { type: 'string', enum: ['assistants', 'vision', 'batch', 'fine-tune', 'user_data'], description: 'OpenAI file purpose. Defaults to "user_data".' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'download_file',
            description: 'Receive a file: fetch it from an HTTP(S) url OR retrieve a previously-uploaded OpenAI file by file_id, and save the bytes to disk. The inverse of upload_file/send_file. Returns {ok, path, bytes, source}. Provide exactly one of url or file_id.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'HTTP(S) URL to download. Mutually exclusive with file_id.' },
                    file_id: { type: 'string', description: 'OpenAI Files API file id (e.g. "file-abc123") to retrieve via /v1/files/{id}/content. Mutually exclusive with url.' },
                    path: { type: 'string', description: 'Destination path on disk. If a directory or omitted, a filename is derived from the url/file_id and saved under cwd.' },
                },
                required: [],
            },
        },
    },
];

/* MIME type sniffer from file extension. Conservative — anything not in
   the table is application/octet-stream. Used by send_file + attachFile. */
function _sniffMime(p) {
    const ext = (path.extname(p) || '').toLowerCase().replace(/^\./, '');
    const map = {
        // text
        txt: 'text/plain', md: 'text/markdown', json: 'application/json',
        xml: 'application/xml', csv: 'text/csv', html: 'text/html',
        htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
        ts: 'text/typescript', py: 'text/x-python', cs: 'text/x-csharp',
        go: 'text/x-go', rs: 'text/x-rust', ini: 'text/plain',
        yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/x-toml',
        cfg: 'text/plain', log: 'text/plain', sh: 'text/x-sh',
        ps1: 'text/x-powershell', bat: 'text/x-bat', cmd: 'text/x-bat',
        c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', hpp: 'text/x-c++',
        // images
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        bmp: 'image/bmp', ico: 'image/x-icon',
        // docs/archives/media
        pdf: 'application/pdf', zip: 'application/zip',
        rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
        tar: 'application/x-tar', gz: 'application/gzip',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    };
    return map[ext] || 'application/octet-stream';
}

/* Classify a file as text / image / binary for the attachment pipeline.
   image:* MIME -> image; text/* and select application/{json,xml} -> text;
   everything else -> binary. Used by attachFile + send_file. */
function _classifyFile(mime) {
    if (!mime) return 'binary';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('text/')) return 'text';
    if (mime === 'application/json' || mime === 'application/xml') return 'text';
    return 'binary';
}

/* Anthropic-extensions-dir guard: refuse any path that resolves under
   <home>\.vscode\extensions\anthropic.* — these are owned by the official
   Claude Code extension and per [[feedback_never_touch_anthropic_dir]]
   must never be touched. Used by write_file. */
function _isAnthropicPath(absPath) {
    try {
        const norm = path.resolve(absPath).toLowerCase();
        const root = path.join(os.homedir(), '.vscode', 'extensions').toLowerCase();
        if (!norm.startsWith(root)) return false;
        const rest = norm.slice(root.length).replace(/^[\\/]+/, '');
        return /^anthropic\./.test(rest);
    } catch (e) {
        return false;
    }
}

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
    if (name === 'write_file') {
        const rawPath = String(args.path || '').trim();
        if (!rawPath) return JSON.stringify({ ok: false, error: 'empty path' });
        const content = args.content == null ? '' : String(args.content);
        const mode = String(args.mode || 'w').toLowerCase();
        const enc = String(args.encoding || 'utf-8').toLowerCase();
        if (!['w', 'a', 'x'].includes(mode)) return JSON.stringify({ ok: false, error: `invalid mode: ${mode}` });
        if (!['utf-8', 'utf8', 'binary-base64'].includes(enc)) return JSON.stringify({ ok: false, error: `invalid encoding: ${enc}` });
        const baseDir = opts.cwd || os.homedir();
        const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseDir, rawPath);
        if (_isAnthropicPath(absPath)) {
            return JSON.stringify({ ok: false, error: 'refused: anthropic dir is off-limits', path: absPath });
        }
        try {
            const parent = path.dirname(absPath);
            fs.mkdirSync(parent, { recursive: true });
            if (mode === 'x' && fs.existsSync(absPath)) {
                return JSON.stringify({ ok: false, error: 'file exists (mode=x)', path: absPath });
            }
            let buf;
            if (enc === 'binary-base64') {
                buf = Buffer.from(content, 'base64');
            } else {
                buf = Buffer.from(content, 'utf8');
            }
            const flag = mode === 'a' ? 'a' : 'w';
            fs.writeFileSync(absPath, buf, { flag });
            const stat = fs.statSync(absPath);
            return JSON.stringify({ ok: true, path: absPath, bytes: stat.size });
        } catch (e) {
            return JSON.stringify({ ok: false, error: e.message || String(e), path: absPath });
        }
    }
    if (name === 'send_file') {
        const rawPath = String(args.path || '').trim();
        if (!rawPath) return JSON.stringify({ ok: false, error: 'empty path' });
        const baseDir = opts.cwd || os.homedir();
        const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseDir, rawPath);
        const displayName = String(args.displayName || path.basename(absPath));
        const mime = String(args.mime || _sniffMime(absPath));
        try {
            const stat = fs.statSync(absPath);
            if (!stat.isFile()) return JSON.stringify({ ok: false, error: 'not a file', path: absPath });
            const panel = opts.panel || activePanel;
            if (!panel) return JSON.stringify({ ok: false, error: 'no active panel to send to', path: absPath });
            const THRESHOLD = 2 * 1024 * 1024;
            const payload = {
                type: 'fileDownload',
                name: displayName,
                mime,
                bytes: stat.size,
            };
            let delivery;
            if (stat.size < THRESHOLD) {
                const buf = fs.readFileSync(absPath);
                payload.dataUri = `data:${mime};base64,${buf.toString('base64')}`;
                delivery = 'dataUri';
            } else {
                try {
                    payload.uri = panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                    delivery = 'webviewUri';
                } catch (e) {
                    return JSON.stringify({ ok: false, error: 'asWebviewUri failed: ' + (e.message || e), path: absPath });
                }
            }
            try {
                panel.webview.postMessage(payload);
            } catch (e) {
                return JSON.stringify({ ok: false, error: 'postMessage failed: ' + (e.message || e), path: absPath });
            }
            return JSON.stringify({ ok: true, sent_to_chat: true, name: displayName, mime, bytes: stat.size, delivery });
        } catch (e) {
            return JSON.stringify({ ok: false, error: e.message || String(e), path: absPath });
        }
    }
    if (name === 'upload_file') {
        const rawPath = String(args.path || '').trim();
        if (!rawPath) return JSON.stringify({ ok: false, error: 'empty path' });
        const baseDir = opts.cwd || os.homedir();
        const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseDir, rawPath);
        if (_isAnthropicPath(absPath)) {
            return JSON.stringify({ ok: false, error: 'refused: anthropic dir is off-limits', path: absPath });
        }
        const apiKey = opts.context ? getProviderKey(opts.context, 'openai') : (process.env.OPENAI_API_KEY || null);
        if (!apiKey) return JSON.stringify({ ok: false, error: 'no openai key configured' });
        try {
            const stat = fs.statSync(absPath);
            if (!stat.isFile()) return JSON.stringify({ ok: false, error: 'not a file', path: absPath });
            const buf = fs.readFileSync(absPath);
            const purpose = String(args.purpose || 'user_data');
            const mime = _sniffMime(absPath);
            const form = new FormData();
            form.append('file', new Blob([buf], { type: mime }), path.basename(absPath));
            form.append('purpose', purpose);
            const res = await fetch('https://api.openai.com/v1/files', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: form,
            });
            const body = await res.json();
            if (!res.ok) return JSON.stringify({ ok: false, error: body.error && body.error.message || `HTTP ${res.status}`, path: absPath });
            return JSON.stringify({ ok: true, file_id: body.id, path: absPath, bytes: stat.size, mime, purpose });
        } catch (e) {
            return JSON.stringify({ ok: false, error: e.message || String(e), path: absPath });
        }
    }
    if (name === 'download_file') {
        const url = String(args.url || '').trim();
        const fileId = String(args.file_id || '').trim();
        if (!url && !fileId) return JSON.stringify({ ok: false, error: 'provide url or file_id' });
        if (url && fileId) return JSON.stringify({ ok: false, error: 'provide exactly one of url or file_id, not both' });
        const baseDir = opts.cwd || os.homedir();
        /* Derive a destination filename when caller gave a dir or nothing. */
        let rawPath = String(args.path || '').trim();
        const deriveName = () => {
            if (url) {
                try { const u = new URL(url); const b = path.basename(u.pathname); if (b) return b; } catch (e) { /* fall through */ }
                return 'download.bin';
            }
            return fileId.replace(/[^A-Za-z0-9._-]/g, '_') || 'download.bin';
        };
        let absPath;
        if (!rawPath) {
            absPath = path.resolve(baseDir, deriveName());
        } else {
            absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseDir, rawPath);
            let isDir = false;
            try { isDir = fs.statSync(absPath).isDirectory(); } catch (e) { isDir = /[\\/]$/.test(rawPath); }
            if (isDir) absPath = path.join(absPath, deriveName());
        }
        if (_isAnthropicPath(absPath)) return JSON.stringify({ ok: false, error: 'refused: anthropic dir is off-limits', path: absPath });
        try {
            let res, source;
            if (url) {
                if (!/^https?:\/\//i.test(url)) return JSON.stringify({ ok: false, error: 'only http(s) urls are allowed', url });
                res = await fetch(url);
                source = url;
            } else {
                const apiKey = opts.context ? getProviderKey(opts.context, 'openai') : (process.env.OPENAI_API_KEY || null);
                if (!apiKey) return JSON.stringify({ ok: false, error: 'no openai key configured (needed for file_id)' });
                res = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}/content`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });
                source = `openai:${fileId}`;
            }
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { const j = await res.json(); if (j && j.error && j.error.message) detail = j.error.message; } catch (e) { /* non-json body */ }
                return JSON.stringify({ ok: false, error: detail, source });
            }
            const buf = Buffer.from(await res.arrayBuffer());
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, buf);
            return JSON.stringify({ ok: true, path: absPath, bytes: buf.length, source });
        } catch (e) {
            return JSON.stringify({ ok: false, error: e.message || String(e), path: absPath });
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

   The tray exe takes its TCP port as its first command-line argument.

   credentials (optional): { email, password } from the active email_password
   account for this bridge. When present we surface them to the tray exe via
   environment variables (CBE_BRIDGE_EMAIL / CBE_BRIDGE_PASSWORD). The C++ tray
   exes today don't read these — they expect the user to log in manually in the
   QtWebEngine profile — but we plumb them through so the tray side can pick
   them up once the login-handshake patch lands without an extension change.
   TODO: bridge tray exes need a login-cred handshake to consume CBE_BRIDGE_*. */
function _spawnBridge(target, exePath, credentials) {
    const cp = require('child_process');
    const port = BRIDGE_PORTS[target];
    const env = Object.assign({}, process.env);
    if (credentials && credentials.email) {
        env.CBE_BRIDGE_EMAIL = String(credentials.email);
        env.CBE_BRIDGE_PROVIDER = target;
        /* Password may be empty for accounts mid-edit — still set the email so
           the tray can pre-fill the login form even without auto-submit. */
        if (credentials.password) env.CBE_BRIDGE_PASSWORD = String(credentials.password);
    }
    /* Unified CBE-Bridge.exe needs `--target <name>` so it knows which icon
       + default model + (legacy compatibility) bridge persona to load.
       --port stays explicit so a single binary can serve every target on
       its registered port. */
    const child = cp.spawn(exePath, ['--target', target, '--port', String(port)], {
        cwd: path.dirname(exePath),
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
        env,
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

/* Check whether the unified Python bridge service (bridges_py/) is enabled.
   Per BRIDGE_WHITEPAPER.md v2, the v2 service is OFF by default — flip
   `[bridge] use_python = true` in config.ini to route through it instead of
   the per-target C++ tray exes. The Python service is also gated on the
   bridges_py/ directory + bridge_service.py existing on disk, so a clone
   that hasn't received the scaffold yet falls back to v1 automatically. */
function _isPythonBridgeEnabled(context) {
    try {
        const cfg = Config.get(context && context.extensionPath);
        const bridgeSec = (cfg && cfg.bridge) || {};
        const flag = String(bridgeSec.use_python || bridgeSec.usePython || '').toLowerCase();
        if (flag !== 'true' && flag !== '1' && flag !== 'yes') return false;
        const scriptPath = path.join(context.extensionPath, 'bridges_py', 'bridge_service.py');
        return fs.existsSync(scriptPath);
    } catch (_) {
        return false;
    }
}

/* Spawn `py -3 -m bridges_py.bridge_service ...` detached + hidden. Single
   process owns ALL provider ports; once running, every subsequent target's
   ensureBridge() short-circuits because the port probe already responds.

   Mirrors _spawnBridge() but for the unified Python service. _runningBridges
   gets a synthetic 'bridges_py' entry so we don't try to re-spawn it. */
function _spawnPythonBridgeService(context) {
    const cp = require('child_process');
    const extPath = context.extensionPath;
    /* `py -3` is the standard Windows Python launcher. Fall back to `python`
       if py isn't on PATH (e.g. a venv-only setup). */
    const child = cp.spawn('py', ['-3', '-m', 'bridges_py.bridge_service',
        '--providers', path.join(extPath, 'providers'),
        '--repo-root', extPath,
    ], {
        cwd: extPath,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
    });
    child.on('error', (e) => trace(`BRIDGE-PY:SPAWN error ${e && e.message}`));
    child.on('exit', (code, signal) => {
        trace(`BRIDGE-PY:EXIT code=${code} signal=${signal || 'none'}`);
        _runningBridges.delete('bridges_py');
    });
    child.unref();
    _runningBridges.set('bridges_py', { pid: child.pid, startedAt: Date.now() });
    return child;
}

/* Ensure the tray-exe bridge for `target` is running. If not, spawn it +
   wait for its TCP port. Returns { ok, port, pid?, reason? }. Idempotent —
   safe to call from activate(), setProvider, and the chat dispatch path. */
async function ensureBridge(context, target, opts) {
    opts = opts || {};
    const port = BRIDGE_PORTS[target];
    if (!port) return { ok: false, reason: `unknown bridge target: ${target}` };
    /* 1. Already responding? Done — covers both the C++ tray AND the Python
       service since they share BRIDGE_PORTS by design. */
    if (await _probeTcpPort('127.0.0.1', port, 500)) {
        return { ok: true, port, alreadyRunning: true };
    }
    /* 1a. Python-bridge path (off by default; gated on config + scaffold). */
    if (_isPythonBridgeEnabled(context)) {
        trace(`BRIDGE-PY:SPAWN target=${target} port=${port}`);
        const child = _spawnPythonBridgeService(context);
        const ok = await _waitForPort('127.0.0.1', port, opts.timeoutMs || 12000);
        if (!ok) {
            trace(`BRIDGE-PY:TIMEOUT target=${target} port=${port} pid=${child && child.pid} — service spawned but never bound`);
            return { ok: false, port, pid: child && child.pid, reason: `bridges_py spawned (pid ${child && child.pid}) but did not bind port ${port} within ${opts.timeoutMs || 12000}ms` };
        }
        trace(`BRIDGE-PY:READY target=${target} port=${port} pid=${child && child.pid}`);
        return { ok: true, port, pid: child && child.pid, spawned: true, python: true };
    }
    /* 2. Find the exe. */
    const exePath = _bridgeExePath(context.extensionPath, target);
    if (!exePath || !fs.existsSync(exePath)) {
        const msg = `bridge exe missing: bin/${BRIDGE_EXE_NAME[target] || target}`;
        trace(`BRIDGE:MISSING target=${target} expected=${exePath}`);
        return { ok: false, reason: msg, exeMissing: true };
    }
    /* 3. Spawn + wait. Resolve the active email_password account for this
       bridge (if any) so the tray exe can pre-fill / auto-login. We find the
       provider id by reverse-lookup on bridgeTarget; ollama has no creds. */
    let credentials = null;
    try {
        if (target !== 'ollama') {
            const providerId = Object.keys(PROVIDERS).find(k => PROVIDERS[k].bridge && PROVIDERS[k].bridgeTarget === target);
            if (providerId) {
                const active = getActiveAccount(context, providerId);
                if (active && active.type === 'email_password' && active.email) {
                    credentials = { email: active.email, password: active.password || '' };
                    trace(`BRIDGE:CREDS target=${target} email=${credentials.email} pw=${maskPassword(credentials.password)}`);
                }
            }
        }
    } catch (e) {
        traceErr('ensureBridge.resolveCreds', e);
    }
    trace(`BRIDGE:SPAWN target=${target} exe=${exePath} port=${port}${credentials ? ' withCreds=1' : ''}`);
    const child = _spawnBridge(target, exePath, credentials);
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

/* ── Live model-list fetch (once-per-day, silent-fail) ────────────────────
   Model lists in PROVIDERS are hardcoded and drift (e.g. opus-4-7 vs the
   current opus-4-8). ensureModelLists() fetches each fetchable provider's
   live list ONCE PER DAY, caches it in globalState under MODEL_CACHE_KEY,
   and getProviderModels() serves today's cached list everywhere the UI
   surfaces models — falling back to the hardcoded PROVIDERS[id].models on
   any miss. Every fetch is best-effort: a failure is trace()'d and the
   hardcoded fallback is kept. NEVER a dialog/error popup. */
const MODEL_CACHE_KEY = 'cbeModelCache';

function _todayStamp() {
    /* Local-date YYYY-MM-DD so the daily-skip flips at the user's midnight. */
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* GET a URL with arbitrary headers (the shared _httpsGetBuffer hardcodes a
   single UA header and can't carry x-api-key / Authorization). Resolves the
   raw Buffer; rejects on transport error / HTTP >= 400. */
function _httpsGetBufferWithHeaders(urlStr, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const url = require('url');
        const parsed = url.parse(urlStr);
        const req = https.request({
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.path,
            headers: Object.assign({ 'User-Agent': 'ClaudeCodexBlack/model-list' }, headers || {}),
            timeout: timeoutMs || 12000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${parsed.hostname}${parsed.pathname || ''}`));
                }
                resolve(Buffer.concat(chunks));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

/* Per-provider live fetch. Each returns a filtered array of model-id strings
   (may throw — the caller wraps in try/catch and keeps the fallback). Only
   key-bearing / local providers are fetchable; bridges & keyless providers
   return null so ensureModelLists() skips them entirely. */
async function _fetchModelsForProvider(context, providerId) {
    switch (providerId) {
        case 'anthropic': {
            const key = getProviderKey(context, providerId);
            if (!key || key === '<bridge>') return null;
            const buf = await _httpsGetBufferWithHeaders('https://api.anthropic.com/v1/models',
                { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            return (Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean);
        }
        case 'claudeCode': {
            /* OAuth subscription path — no API key. If the token is missing /
               expired _readClaudeOAuthToken throws; if Anthropic 401s the
               OAuth scope against /v1/models, _httpsGetBufferWithHeaders
               rejects. Either way the caller keeps the hardcoded fallback. */
            const tok = _readClaudeOAuthToken();
            const buf = await _httpsGetBufferWithHeaders('https://api.anthropic.com/v1/models',
                { 'Authorization': `Bearer ${tok}`, 'anthropic-version': '2023-06-01' }, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            return (Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean);
        }
        case 'openai': {
            const key = getProviderKey(context, providerId);
            if (!key || key === '<bridge>') return null;
            const buf = await _httpsGetBufferWithHeaders('https://api.openai.com/v1/models',
                { 'Authorization': `Bearer ${key}` }, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            const ids = (Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean);
            /* Keep chat-capable families; drop non-chat modalities. */
            return ids.filter(id =>
                /^(gpt-|o\d|chatgpt-)/.test(id) &&
                !/(embed|audio|image|whisper|tts|realtime|moderation|transcribe|search|dall|davinci|babbage)/i.test(id));
        }
        case 'grok': {
            const key = getProviderKey(context, providerId);
            if (!key || key === '<bridge>') return null;
            const buf = await _httpsGetBufferWithHeaders('https://api.x.ai/v1/models',
                { 'Authorization': `Bearer ${key}` }, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            return (Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean);
        }
        case 'gemini': {
            const key = getProviderKey(context, providerId);
            if (!key || key === '<bridge>') return null;
            const buf = await _httpsGetBufferWithHeaders(
                'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
                {}, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            return (Array.isArray(j.models) ? j.models : [])
                .map(m => m && m.name ? String(m.name).replace(/^models\//, '') : '')
                .filter(id => id && /^gemini-/.test(id));
        }
        case 'deepseek': {
            const key = getProviderKey(context, providerId);
            if (!key || key === '<bridge>') return null;
            const buf = await _httpsGetBufferWithHeaders('https://api.deepseek.com/models',
                { 'Authorization': `Bearer ${key}` }, 12000);
            const j = JSON.parse(buf.toString('utf8'));
            return (Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean);
        }
        case 'ollama': {
            /* Reuse the existing local-daemon tags probe. .ok=false (daemon
               down) → null so we keep the fallback rather than wipe the list. */
            const r = await _probeOllamaDaemon(2000);
            if (!r || !r.ok) return null;
            return (r.models || []).filter(Boolean);
        }
        default:
            /* bridges + azure + any keyless/dynamic provider: not fetchable. */
            return null;
    }
}

/* Providers we attempt a live fetch for. Everything else (bridges, azure,
   dynamically-registered bridge extensions) keeps its hardcoded list. */
const MODEL_FETCH_PROVIDERS = ['anthropic', 'claudeCode', 'openai', 'grok', 'gemini', 'deepseek', 'ollama'];

/* Returns today's cached fetched model list for a provider if present,
   else the hardcoded PROVIDERS[providerId].models fallback. This is the
   single accessor the UI payload routes through. */
function getProviderModels(context, providerId) {
    const p = PROVIDERS[providerId];
    const fallback = (p && p.models && p.models.slice) ? p.models.slice() : [];
    try {
        const cache = context.globalState.get(MODEL_CACHE_KEY) || {};
        const entry = cache[providerId];
        if (entry && entry.date === _todayStamp() && Array.isArray(entry.models) && entry.models.length) {
            return entry.models.slice();
        }
    } catch (_) { /* fall through to hardcoded fallback */ }
    return fallback;
}

/* Deferred, best-effort, once-per-day live model-list refresh. For each
   fetchable provider: if today's cache entry already exists, SKIP; else
   fetch + filter + store under MODEL_CACHE_KEY. Each provider is wrapped in
   its own try/catch — a failure traces and continues; never throws, never
   shows a dialog. */
async function ensureModelLists(context) {
    let cache;
    try {
        cache = context.globalState.get(MODEL_CACHE_KEY) || {};
    } catch (_) {
        cache = {};
    }
    const today = _todayStamp();
    let changed = false;
    for (const providerId of MODEL_FETCH_PROVIDERS) {
        try {
            if (cache[providerId] && cache[providerId].date === today) {
                continue;   /* already fetched today */
            }
            const models = await _fetchModelsForProvider(context, providerId);
            if (Array.isArray(models) && models.length) {
                cache[providerId] = { date: today, models };
                changed = true;
                trace(`MODELS:FETCH ${providerId} ok (${models.length})`);
            } else {
                /* null = not fetchable / no key / daemon down — keep fallback,
                   don't poison the cache so we retry next activation. */
                trace(`MODELS:FETCH ${providerId} skipped (no list)`);
            }
        } catch (e) {
            /* Silent-fail: trace only, keep the hardcoded fallback. */
            trace('MODELS:FETCH ' + providerId + ' failed ' + (e && e.message ? e.message : e));
        }
    }
    if (changed) {
        try { await context.globalState.update(MODEL_CACHE_KEY, cache); }
        catch (e) { trace('MODELS:CACHE update failed ' + (e && e.message ? e.message : e)); }
    }
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

    /* Hard per-target socket idle timeout. The browser targets share a
       90s upper bound with bridge_server.cpp's runChatScript timeout (it
       TerminateProcess()es the Python child at 90s), so the panel-side
       socket needs to be the SAME bound or a tiny bit larger, NOT 4x
       larger. 240s left the Copilot bridge looking hung for 4 minutes
       when the tray exe crashed mid-reply (Bug 1). Add a small grace
       window above 90s so the tray gets a chance to write the
       timed-out error JSON before we tear the socket down. */
    const SOCKET_IDLE_TIMEOUT_MS = (target === 'ollama') ? 240000 : 95000;

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
            /* Clear the cancel-handle so a stale reference doesn't fire
               teardown twice when the next stream starts. */
            if (context && context.__cbeActiveBridgeSocket === sock) {
                context.__cbeActiveBridgeSocket = null;
            }
            reject(err);
        };
        const succeed = (text) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch (_) {}
            if (context && context.__cbeActiveBridgeSocket === sock) {
                context.__cbeActiveBridgeSocket = null;
            }
            resolve(text);
        };
        /* Publish the socket so cancelInFlight can hard-kill the in-flight
           wait. Without this, the Stop button only flips a flag the
           async-iterator loop checks — but the iterator is blocked here
           on the network read and never gets to re-check the flag. */
        if (context) context.__cbeActiveBridgeSocket = sock;

        sock.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
        sock.on('connect', () => { sock.write(payload); });
        /* Capture the raw bytes as UTF-8 explicitly. Buffer.toString('utf8')
           is the default but stating it makes Bug 4 (magic-box replacement
           chars) impossible to reintroduce by accident. */
        sock.on('data', (c) => { body += c.toString('utf8'); });
        sock.on('end', () => {
            if (settled) return;
            const line = body.split('\n').find(s => s.trim().length > 0) || '';
            /* Bug 2 — strip JSON-breaking control chars before parsing. The
               browser web-driver occasionally emits NULs / lone CRs inside
               what should be a JSON string field, which made json.loads
               throw "Invalid control character at: line 1 column 49". */
            const cleaned = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
            let data = null;
            try { data = JSON.parse(cleaned); } catch (_) { /* fall through */ }
            if (data && data.ok && typeof data.answer === 'string') {
                succeed(data.answer);
            } else {
                const detail = (data && (data.error || data.err)) || line.slice(0, 300) || '(empty response)';
                fail(new Error(`bridge ${target} chat failed: ${detail}`));
            }
        });
        sock.on('timeout', () => fail(new Error(
            `bridge ${target} chat timed out after ${Math.round(SOCKET_IDLE_TIMEOUT_MS / 1000)}s — `
            + `check bin/CBE-Bridge-${target[0].toUpperCase() + target.slice(1)}.exe is running `
            + `and the target site is signed in. Try restarting the tray exe.`)));
        sock.on('error', (e) => {
            /* If we already settled (e.g., cancelInFlight destroyed the
               socket), suppress the secondary ECONNRESET to avoid a
               double-error. */
            if (settled) return;
            fail(new Error(
                `bridge ${target} not reachable on port ${port} — ${e.message}. `
                + `CBE auto-starts CBE-Bridge-${target}.exe; check bin/ for the exe and `
                + `netstat -ano | findstr ${port}.`));
        });
        sock.on('close', () => {
            /* If the C++ tray closes the socket WITHOUT writing a newline
               (e.g., it crashed) the 'end' handler may never fire and the
               panel is left hanging until SOCKET_IDLE_TIMEOUT_MS. Settle
               here so the catch-block teardown runs immediately. */
            if (settled) return;
            if (body.trim().length > 0) {
                // Re-route through the same parser path as 'end'.
                const line = body.split('\n').find(s => s.trim().length > 0) || '';
                const cleaned = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
                let data = null;
                try { data = JSON.parse(cleaned); } catch (_) { /* fall through */ }
                if (data && data.ok && typeof data.answer === 'string') {
                    succeed(data.answer);
                    return;
                }
            }
            fail(new Error(`bridge ${target} disconnected before sending a reply`));
        });
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
        /* Multimodal user content: convert OpenAI image_url shape to
           Anthropic's {type:'image', source:{type:'base64', media_type, data}} block. */
        if (Array.isArray(m.content)) {
            const blocks = [];
            for (const part of m.content) {
                if (!part || !part.type) continue;
                if (part.type === 'text') {
                    blocks.push({ type: 'text', text: String(part.text || '') });
                } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                    const url = String(part.image_url.url);
                    const dm = /^data:([^;]+);base64,(.+)$/.exec(url);
                    if (dm) {
                        blocks.push({ type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } });
                    } else {
                        blocks.push({ type: 'text', text: `[image url: ${url}]` });
                    }
                }
            }
            out.push({ role: m.role, content: blocks.length ? blocks : '' });
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

/* ── Ollama LOCAL runtime (direct HTTP, no bridge) ───────────────────────
   Ollama runs locally on 127.0.0.1:11434 with no auth. We POST straight to
   /api/chat with stream:true and parse the NDJSON line stream, yielding each
   message.content delta as it arrives — mirroring how streamOpenAIFormat
   streams SSE into the panel. This replaces the old (broken) path that went
   streamBridge → CBE-Bridge.exe → bridge_chat.py, which returned no output
   whenever python wasn't on PATH / the script couldn't be located.

   `model` is the model id chosen in the picker; falls back to the configured
   [ollama] model in config.ini, then the provider default. ensureOllamaReady
   has already (best-effort) started the daemon on provider-switch / activate. */
async function* streamOllama(context, model, messages) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const cfgModel = (cfg.ollama && (cfg.ollama.model || cfg.ollama.default_model)) || '';
    const chosen = (model && String(model).trim())
        || (cfgModel && String(cfgModel).trim())
        || (PROVIDERS.ollamaBridge && PROVIDERS.ollamaBridge.defaultModel)
        || 'llama3.2:3b';

    /* Ollama /api/chat takes the same role/content message shape we store
       canonically (OpenAI-shape). It ignores unknown roles; map any tool
       messages down to plain user/assistant text so the local model still
       sees the context. */
    const oMessages = messages.map((m) => {
        if (m.role === 'tool') {
            return { role: 'user', content: '[tool result] ' + String(m.content || '') };
        }
        let content = m.content;
        if (Array.isArray(content)) {
            /* Flatten multimodal parts to text — local models here are text-only. */
            content = content.map(p => (p && p.type === 'text') ? (p.text || '') : '').join('');
        }
        return { role: m.role, content: String(content == null ? '' : content) };
    });

    const body = JSON.stringify({ model: chosen, messages: oMessages, stream: true });
    let res;
    try {
        res = await fetch(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
    } catch (e) {
        throw new Error(
            `Can't reach the local Ollama daemon at ${OLLAMA_HOST}:${OLLAMA_PORT} — `
            + `is Ollama running? (${e.message || e}). Pick Ollama again to auto-start it, `
            + `or install it from Settings → Models.`);
    }
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        /* 404 from /api/chat usually means the model isn't pulled yet. */
        const hint = res.status === 404
            ? ` — model "${chosen}" may not be installed. Pull it from Settings → Models.`
            : '';
        throw new Error(`Ollama HTTP ${res.status} ${res.statusText}${errText ? ': ' + errText.slice(0, 300) : ''}${hint}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        /* Ollama streams newline-delimited JSON objects (NDJSON), one per
           line: {"message":{"role":"assistant","content":"…"},"done":false}
           … terminated by {"done":true}. Parse complete lines as they land. */
        for (;;) {
            const idx = buf.indexOf('\n');
            if (idx === -1) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let j;
            try { j = JSON.parse(line); } catch (_) { continue; }
            if (j.error) throw new Error(`Ollama error: ${j.error}`);
            const chunk = j.message && typeof j.message.content === 'string' ? j.message.content : '';
            if (chunk) yield chunk;
            if (j.done) return;
        }
    }
    /* Flush a trailing object with no newline (rare). */
    const tail = buf.trim();
    if (tail) {
        try {
            const j = JSON.parse(tail);
            const chunk = j.message && typeof j.message.content === 'string' ? j.message.content : '';
            if (chunk) yield chunk;
        } catch (_) { /* ignore */ }
    }
}

/* Dispatch by provider id. Returns async iterator yielding text chunks.
   `onProgress(step)` (optional) receives human-readable status strings for
   slow providers so the panel can show progress. */
async function* chatStream(context, providerId, model, messages, maxTokens, onProgress) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const provider = PROVIDERS[providerId];

    /* Ollama LOCAL runtime — direct HTTP to the daemon, no C++ bridge / python. */
    if (provider && provider.local && provider.localTarget === 'ollama') {
        if (onProgress) onProgress('ollama (local) → ' + (model || provider.defaultModel));
        try { await ensureOllamaReady({ timeoutMs: 8000 }); } catch (_) { /* streamOllama surfaces a clean error if still down */ }
        yield* streamOllama(context, model, messages);
        return;
    }

    if (provider && provider.bridge) {
        yield* streamBridge(context, providerId, messages, onProgress);
        return;
    }

    const key = getProviderKey(context, providerId);
    if (!key) throw new Error(`No API key for ${providerId}. Run "Codex Black: Set API Key" or add it to config.ini under [api_keys] (or [azure]).`);

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

/* Parse the human "resets …" hint Claude prints on a cap into a disableMs
   (ms from now until the reset). Handles both forms the client emits:
     "resets 3:10am (America/New_York)"        — clock time today/tomorrow
     "resets May 25, 12am (America/New_York)"  — explicit month/day
   Wall-clock times are interpreted in local time (this machine runs ET, the
   same zone the message quotes). Returns NaN if no parsable hint. */
function parseResetHint(msg) {
    if (!msg) return NaN;
    const now = new Date();
    /* Explicit "<Mon> <day>, <h>[:mm]<am|pm>" first (weekly cap form). */
    let m = msg.match(/resets\s+([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
    if (m) {
        const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        const mon = months.indexOf(m[1].slice(0, 3).toLowerCase());
        if (mon >= 0) {
            let hr = parseInt(m[3], 10) % 12;
            if (/pm/i.test(m[5])) hr += 12;
            const min = m[4] ? parseInt(m[4], 10) : 0;
            let yr = now.getFullYear();
            let target = new Date(yr, mon, parseInt(m[2], 10), hr, min, 0, 0);
            if (target.getTime() < now.getTime() - 86400000) target = new Date(yr + 1, mon, parseInt(m[2], 10), hr, min, 0, 0);
            const ms = target.getTime() - now.getTime();
            return ms > 0 ? ms : NaN;
        }
    }
    /* Plain "<h>[:mm]<am|pm>" clock time (session cap form). */
    m = msg.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
    if (m) {
        let hr = parseInt(m[1], 10) % 12;
        if (/pm/i.test(m[3])) hr += 12;
        const min = m[2] ? parseInt(m[2], 10) : 0;
        let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, min, 0, 0);
        if (target.getTime() <= now.getTime()) target = new Date(target.getTime() + 86400000); /* already passed today → tomorrow */
        const ms = target.getTime() - now.getTime();
        return ms > 0 ? ms : NaN;
    }
    return NaN;
}

/* ── CCLS: session-limit → auto account-switch (output-stream detector) ───
   CBE hosts the wrapped Claude output and sees the raw streamed text directly,
   so it can catch the weekly-cap sentence even when it arrives as plain
   assistant TEXT (not a thrown error / 429). The canonical message:
       You've hit your session limit · resets 1:50am (America/New_York)
   On match we fire a GET to the local claude_switcher service to rotate to the
   next/best account — the CBE-side counterpart to the Claude-Code-side hook
   (C:\hooks\ccls_limit_switch.py wired into ~/.claude/settings.json). The two
   are independent on purpose: whichever sees the cap first fires the switch,
   and the switcher self-dedupes by account.

   Patterns mirror ccls_limit_switch.py's LIMIT_RE (tolerant, case-insensitive).
   SAFETY: wrapped so a detector fault can NEVER break the chat stream, and
   self-throttled (won't re-fire within CCLS_COOLDOWN_MS) since a single cap
   can produce repeated output lines. */
const CCLS_SWITCH_URL = process.env.CCLS_SWITCH_URL || 'http://127.0.0.1:3333/switch';
/* The CCLS watchdog HTTP backup-trigger interface (ccls_watchdog.py serve).
   POST /rotate routes through the watchdog's shared CclsState suppression guard
   so the CBE-detected cap and the scheduled-task poller can't double-rotate.
   This is the PRIMARY target now; :3333/switch is kept as a legacy fallback for
   setups still running the old claude_switcher service. */
const CCLS_ROTATE_URL = process.env.CCLS_ROTATE_URL || 'http://127.0.0.1:57840/rotate';
const CCLS_COOLDOWN_MS = 60 * 1000;
let _cclsLastFire = 0;
const CCLS_LIMIT_RE = new RegExp(
    'hit your session limit'                          + '|' +
    'session limit\\s*[·:]\\s*resets'            + '|' +   /* "session limit · resets" / "session limit: resets" */
    "you'?ve hit your (usage|session) limit"          + '|' +
    'weekly (usage|session) limit'                    + '|' +
    'rate_?limit_?exceeded'                           + '|' +
    'usage limit reached',
    'i'
);

/* True if `text` carries the limit message. Pure predicate — no side effects,
   so it's trivially unit-testable. */
function cclsTextHasLimit(text) {
    return !!(text && CCLS_LIMIT_RE.test(String(text)));
}

/* Scan output-stream text for the limit message; on match (and outside the
   cooldown) fire the rotation, then keep the session alive by injecting "...".

   Flow on a detected cap:
     1. POST CCLS_ROTATE_URL (127.0.0.1:57840/rotate) — the watchdog swaps the
        active Anthropic account UNDER the running session (creds hot-swap). The
        watchdog routes this through its shared CclsState suppression guard, so
        if the scheduled-task poller already rotated for this same cap, the
        watchdog answers "suppressed" and nothing double-rotates.
     2. Fall back to the legacy :3333/switch GET if the watchdog isn't up.
     3. Inject "..." into the wrapped session (via injectCtx) so the conversation
        continues on the freshly-swapped creds. Per CLAUDE.md, a bare "..." means
        "I crashed — pick up where I left off", which is exactly the resume cue
        the assistant needs; the full context is still in the window.

   `injectCtx` (optional) = { context, panel } from the streaming chokepoint.
   When present we re-drive the wrapped session after a short delay (give the
   cred swap a beat to land). When absent (error-path callers without panel
   scope) we still fire the rotate — the poller / next user turn picks it up.

   Returns true if a rotation was fired. Never throws — all faults swallowed. */

/* Interpret a switcher response into { switched, reason, from, to, active }.
   The two switch backends share a vocabulary but differ in shape:
     - ccls_watchdog :57840 /rotate  ->
         real swap:   { ok:true, action:"swap", swap:{ ok:true, from, to } }
         suppressed:  { ok:true, action:"suppressed_awaiting_log_advance", … }
                        (ok:true but NOTHING swapped — must NOT resume)
     - claude_switcher :3333 /switch ->
         real swap:   { ok:true, from, account|to, … }
         debounced:   { ok:false, skipped:true, active, error:"debounced …" }
   A switch "happened" ONLY when a credential write actually occurred; a
   suppressed/skipped/debounced/error result is an honest no-op. We never trust
   the HTTP status alone (a refusal is a 200 JSON body). */
function cclsRotateResult(httpStatus, bodyText, source) {
    const fail = (reason, extra) => Object.assign({ switched: false, reason: reason || 'switch failed' }, extra || {});
    let j = null;
    try { j = JSON.parse(bodyText || ''); } catch (_) { /* non-JSON below */ }
    if (!j || typeof j !== 'object') {
        if (httpStatus >= 200 && httpStatus < 300) return fail('switcher gave no parseable result');
        return fail(`switcher HTTP ${httpStatus}`);
    }
    /* Watchdog suppression: ok:true but it deliberately did not swap. */
    const action = String(j.action || '');
    if (/suppress/i.test(action)) return fail('rotation suppressed (already rotated for this cap)');
    /* Unwrap the watchdog's nested swap result if present. */
    const swap = (j.swap && typeof j.swap === 'object') ? j.swap : j;
    const ok = !!(swap.ok && !swap.skipped);
    if (ok) {
        return { switched: true, reason: 'switched',
                 from: swap.from || swap.from_account || null,
                 to: swap.to || swap.account || swap.to_account || null };
    }
    /* Honest no-op: surface the switcher's own reason (debounce / no headroom /
       all-capped / creds write failed) verbatim so the user knows why. */
    return fail(swap.error || j.error || (swap.skipped ? 'switch skipped' : 'switch failed'),
                { active: swap.active || j.active || null });
}

/* Post a short info line into the panel IF we have panel scope — used for the
   honest "switched / skipped" status after a CCLS rotate. Safe + best-effort. */
function cclsPostInfo(injectCtx, text) {
    try {
        if (injectCtx && injectCtx.panel && injectCtx.panel.webview) {
            injectCtx.panel.webview.postMessage({ type: 'info', text });
        } else if (activePanel && activePanel.webview) {
            activePanel.webview.postMessage({ type: 'info', text });
        }
    } catch (_) { /* never break the stream over a status line */ }
}

function cclsCheckLimitText(text, injectCtx, fromErrorChannel) {
    try {
        /* HARDENED (2026-06-03): only EVER fire from a genuine error channel —
           the wrapped `claude` subprocess's stderr or an is_error result event.
           Assistant output (text_delta / a SUCCESS result's text) is NEVER a
           trustworthy cap signal: a session merely *discussing* rate limits, or
           a sub-agent death message ("you've hit your session limit · resets …")
           echoed into the stream, contains the exact phrases and would
           false-rotate a healthy account. A real cap is emitted by the CLI as an
           error, not as assistant content. */
        if (fromErrorChannel !== true) return false;
        if (!cclsTextHasLimit(text)) return false;
        const now = Date.now();
        if (now - _cclsLastFire < CCLS_COOLDOWN_MS) {
            trace('CCLS: limit detected in output but within cooldown — not re-firing');
            return false;
        }
        _cclsLastFire = now;   /* debounce: one rotate per cap, not per output line */
        trace('CCLS: session-limit message detected in output stream — firing rotate');

        /* (1) POST the watchdog /rotate; (2) legacy GET fallback; (3) inject "..."
           ONLY IF the swap actually happened. Fully fire-and-forget — a detector
           fault can NEVER break the chat.

           HONESTY FIX (2026-06-04): we must act on the switcher's RESULT, not on
           "did the fetch succeed". The :3333 switcher answers
           {ok:false, skipped:true, error:"debounced …"} when it refuses to
           rotate; previously we ignored the body and always injected "..." +
           continued as if switched, so CBE *said* it switched while it was still
           on the capped account. Now cclsRotateResult parses ok/skipped and we
           only resume on a real swap; a skipped/failed switch posts an honest
           "Switch skipped — <reason>" line so the user knows they're still on the
           capping account. */
        Promise.resolve()
            .then(() => fetch(CCLS_ROTATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
            .then(async (res) => {
                let body = '';
                try { body = (await res.text()).slice(0, 300); } catch (_) {}
                trace(`CCLS: rotate POST ${CCLS_ROTATE_URL} -> ${res.status} ${body}`);
                return cclsRotateResult(res.status, body, 'watchdog');
            })
            .catch((e) => {
                trace(`CCLS: rotate POST failed (${CCLS_ROTATE_URL}): ${(e && e.message) || e} — trying legacy :3333`);
                /* Legacy fallback for hosts still on the old claude_switcher. */
                return fetch(CCLS_SWITCH_URL, { method: 'GET' })
                    .then(async (res) => {
                        let body = '';
                        try { body = (await res.text()).slice(0, 200); } catch (_) {}
                        trace(`CCLS: legacy switch GET ${CCLS_SWITCH_URL} -> ${res.status} ${body}`);
                        return cclsRotateResult(res.status, body, 'legacy');
                    })
                    .catch((e2) => {
                        trace(`CCLS: legacy switch GET also failed: ${(e2 && e2.message) || e2}`);
                        return { switched: false, reason: 'switcher unreachable' };
                    });
            })
            .then((r) => {
                r = r || { switched: false, reason: 'no result' };
                if (r.switched) {
                    /* (3) Real swap — keep the session alive: re-drive the wrapped
                       session with "..." once creds have swapped. Panel scope only. */
                    if (r.to) cclsPostInfo(injectCtx, `↻ Account hit its limit — switched to ${r.to}`);
                    cclsInjectResumeNudge(injectCtx);
                } else {
                    /* Honest no-op: DO NOT inject "..." (that would resume on the
                       still-capped account). Tell the user we did NOT switch. */
                    const stillOn = r.active ? ` (still on ${r.active})` : '';
                    trace(`CCLS: rotate did NOT switch — ${r.reason}${stillOn}; not resuming`);
                    cclsPostInfo(injectCtx, `Switch skipped — ${r.reason}${stillOn}`);
                }
            })
            .catch((e) => { try { trace(`CCLS: post-rotate chain fault: ${(e && e.message) || e}`); } catch (_) {} });
        return true;
    } catch (e) {
        try { trace(`CCLS: detector fault swallowed: ${(e && e.message) || e}`); } catch (_) {}
        return false;
    }
}

/* Inject the "..." resume nudge into the wrapped Claude session after a cap
   rotation, so the conversation continues on the freshly-swapped credentials.
   Guarded + debounced separately from the rotate so a fault here can't break
   the stream, and a flurry of cap lines can't fire a flurry of nudges. */
let _cclsLastNudge = 0;
function cclsInjectResumeNudge(injectCtx) {
    try {
        if (!injectCtx || !injectCtx.panel || !injectCtx.context) {
            trace('CCLS: no panel scope for resume nudge — relying on poller / next user turn');
            return;
        }
        const now = Date.now();
        if (now - _cclsLastNudge < CCLS_COOLDOWN_MS) {
            trace('CCLS: resume nudge within cooldown — not re-injecting');
            return;
        }
        _cclsLastNudge = now;
        const { context, panel } = injectCtx;
        /* Delay so the watchdog's switch_to() + token reload lands before we
           start the new turn on the swapped account. 2.5s is comfortably more
           than a local cred-file swap takes. */
        setTimeout(() => {
            try {
                trace("CCLS: injecting '...' resume nudge into wrapped session");
                /* Mirror the user typing "..." — drives streamClaudeAgent on the
                   now-swapped creds. handleSendText pushes it as a user turn. */
                Promise.resolve(handleSendText(context, panel, '...'))
                    .catch((e) => trace(`CCLS: resume nudge send failed: ${(e && e.message) || e}`));
            } catch (e) {
                trace(`CCLS: resume nudge fault: ${(e && e.message) || e}`);
            }
        }, 2500);
    } catch (e) {
        try { trace(`CCLS: resume-nudge outer fault: ${(e && e.message) || e}`); } catch (_) {}
    }
}

/* Classify a thrown stream error as a rate-limit / weekly-cap hit. The
   fetch-based streamers throw `HTTP 429 ...`; the Anthropic SDK throws an
   error carrying .status === 429. We also pattern-match the error vocabulary
   ("rate limit", "weekly limit", "usage limit", "quota") because some
   providers wrap 429s in a 200 SSE error frame or a 400 with that text.
   The Claude client also surfaces caps as a plain sentence with no 429 status:
   "You've hit your session limit · resets 3:10am (America/New_York)" or
   "You've hit your weekly limit · resets May 25, 12am" — match those too so a
   session/weekly cap rotates the account instead of stalling the chat.
   Returns { isRateLimit, weekly, disableMs } — disableMs is parsed from a
   Retry-After header, else from the "resets …" hint (NaN otherwise). */
function classifyRateLimit(err) {
    const msg = String((err && err.message) || err || '');
    const status = err && (err.status || err.statusCode);
    const is429 = status === 429 || /HTTP\s+429\b/i.test(msg) || /\b429\b/.test(msg);
    /* The session/weekly cap sentence Claude prints (no 429 status attached). */
    const hitYourLimit =
        /hit your (?:session|weekly|usage|current|daily)?\s*limit/i.test(msg) ||
        /\bsession limit\b/i.test(msg) ||
        /\bmessage limit\b/i.test(msg) ||         /* claude.ai bridge: "reached your message limit" */
        /reached your .*\blimit\b/i.test(msg) ||
        /\blimit\b.*\bresets\b/i.test(msg);       /* "...limit · resets 12am (America/...)" */
    const vocab =
        /rate[_\s-]?limit/i.test(msg) ||
        /\bweekly\b/i.test(msg) ||
        /usage limit/i.test(msg) ||
        /\bquota\b/i.test(msg) ||
        /too many requests/i.test(msg) ||
        /\boverloaded\b/i.test(msg) ||
        /\binsufficient_quota\b/i.test(msg) ||
        hitYourLimit;
    const isRateLimit = is429 || vocab;
    /* "session limit" is a short cap and must NOT be treated as weekly. */
    const session = /\bsession limit\b/i.test(msg) || /hit your session/i.test(msg);
    const weekly = !session && /\bweek/i.test(msg);  /* "weekly limit", "this week" */
    /* Retry-After can be seconds or an explicit header echoed in the body. */
    let disableMs = NaN;
    const retryHeaderObj = err && err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
    const m = String(retryHeaderObj || '').match(/^(\d+)/) || msg.match(/retry[-\s]?after[":=\s]+(\d+)/i);
    if (m) {
        const secs = parseInt(m[1], 10);
        if (Number.isFinite(secs) && secs > 0) disableMs = secs * 1000;
    }
    /* No Retry-After header → fall back to the printed "resets …" wall-clock. */
    if (!Number.isFinite(disableMs)) disableMs = parseResetHint(msg);
    return { isRateLimit, weekly, disableMs };
}

/* ── Image generation: real multi-provider image-gen ──────────────────────
   Detect image-gen intent in the user message before dispatching to chat.
   Text-only chat models hallucinate fake image URLs (e.g. Gemini Pro emitting
   the famous `oaidalleapiprodscus.blob.core.windows.net` URL) — so we
   intercept the prompt, route it to the active provider's real image-gen
   endpoint, decode the base64 result, and render it inline in the panel.

   Spec (2026):
   - OpenAI: POST /v1/images/generations, model gpt-image-1, b64_json response.
              DALL-E 3 was retired March 2026 — only gpt-image-1 ships now.
              Default quality MUST be "low" per the user's hard rule
              (see ~/.claude/.../feedback_image_gen_default_medium.md).
   - Gemini: gemini-2.5-flash-image-preview:generateContent with image MIME,
             base64 in candidates[0].content.parts[].inlineData.data.
             Falls back to gemini-2.0-flash-exp on 404.
   - xAI Grok: POST /v1/images/generations, model grok-2-image, b64_json.
   - Anthropic / DeepSeek: no image-gen API — friendly message.
   - Ollama: not v1 — friendly message.
   - Browser bridges (chatgptBridge / claudeBridge / grokBridge etc.):
     pass-through. The bridge's DOM driver handles image-gen natively via
     the chat page's "generate image" button. */

const IMAGE_INTENT_RE = /^(generate|make|create|draw|render)\s+(an?\s+)?(image|picture|photo|illustration|drawing)\s+(of\s+|showing\s+|with\s+)?(.+)/i;

/* Detect image-gen intent. Returns { prompt, quality } or null. Slash form
   `/image <prompt> [--quality low|medium|high]` always wins; the regex form
   triggers on natural-language requests like "draw a goldfish". */
function detectImageIntent(text) {
    if (!text) return null;
    const trimmed = text.trim();

    /* Slash form: /image <prompt> [--quality X] */
    if (/^\/image\s+/i.test(trimmed)) {
        let body = trimmed.replace(/^\/image\s+/i, '');
        let quality = 'low';
        const qm = body.match(/\s*--quality\s+(low|medium|high)\s*$/i)
                || body.match(/\s+--quality\s+(low|medium|high)\s+/i);
        if (qm) {
            quality = qm[1].toLowerCase();
            body = body.replace(/\s*--quality\s+(low|medium|high)\s*/i, ' ').trim();
        }
        if (!body) return null;
        return { prompt: body, quality };
    }

    /* Natural-language form. Capture group 5 is the actual subject. */
    const m = trimmed.match(IMAGE_INTENT_RE);
    if (m && m[5]) {
        let body = m[5].trim();
        let quality = 'low';
        const qm = body.match(/\s*--quality\s+(low|medium|high)\s*$/i);
        if (qm) {
            quality = qm[1].toLowerCase();
            body = body.replace(/\s*--quality\s+(low|medium|high)\s*$/i, '').trim();
        }
        if (!body) return null;
        return { prompt: body, quality };
    }

    return null;
}

/* OpenAI image generation. gpt-image-1, b64_json format. */
async function generateImageOpenAI(apiKey, prompt, quality) {
    const body = {
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: quality || 'low',
        background: 'auto',
    };
    const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 400)}`);
    }
    let json;
    try { json = JSON.parse(txt); } catch (e) {
        throw new Error(`OpenAI: non-JSON response: ${txt.slice(0, 200)}`);
    }
    const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) throw new Error(`OpenAI: no b64_json in response: ${txt.slice(0, 200)}`);
    return { b64, mime: 'image/png' };
}

/* Gemini image generation. Tries 2.5-flash-image-preview first, falls back
   to 2.0-flash-exp on 404. Base64 lives inside parts[].inlineData. */
async function generateImageGemini(apiKey, prompt) {
    const models = ['gemini-2.5-flash-image-preview', 'gemini-2.0-flash-exp'];
    let lastErr = null;
    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'image/png' },
        };
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (e) {
            lastErr = e;
            continue;
        }
        const txt = await res.text();
        if (res.status === 404) {
            lastErr = new Error(`HTTP 404 ${res.statusText}: ${txt.slice(0, 200)}`);
            continue;   /* try the fallback model */
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 400)}`);
        }
        let json;
        try { json = JSON.parse(txt); } catch (e) {
            throw new Error(`Gemini: non-JSON response: ${txt.slice(0, 200)}`);
        }
        const cand = json && json.candidates && json.candidates[0];
        const parts = cand && cand.content && cand.content.parts;
        if (Array.isArray(parts)) {
            for (const p of parts) {
                if (p && p.inlineData && p.inlineData.data
                    && /^image\//.test(String(p.inlineData.mimeType || ''))) {
                    return { b64: p.inlineData.data, mime: p.inlineData.mimeType };
                }
            }
        }
        throw new Error(`Gemini: no inlineData image in response: ${txt.slice(0, 200)}`);
    }
    throw lastErr || new Error('Gemini: all image-gen models failed.');
}

/* xAI Grok image generation. grok-2-image, b64_json. */
async function generateImageGrok(apiKey, prompt) {
    const body = {
        model: 'grok-2-image',
        prompt,
        n: 1,
        response_format: 'b64_json',
    };
    const res = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 400)}`);
    }
    let json;
    try { json = JSON.parse(txt); } catch (e) {
        throw new Error(`Grok: non-JSON response: ${txt.slice(0, 200)}`);
    }
    const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) throw new Error(`Grok: no b64_json in response: ${txt.slice(0, 200)}`);
    return { b64, mime: 'image/png' };
}

/* Dispatcher. Returns true if the message was consumed by the image-gen
   path (success OR friendly-error); false if we should fall through to chat. */
async function tryHandleImageGeneration(context, panel, text) {
    const intent = detectImageIntent(text);
    if (!intent) return false;
    const providerId = getActiveProvider(context);
    const _info = PROVIDERS[providerId] || {};

    /* Bridge providers handle image-gen natively via their browser DOM driver
       (chatgpt.com's image button, etc.). Pass through to streamBridge as
       a normal chat — the bridge already returns whatever the page produces,
       including images. */
    if (_info.bridge) return false;

    /* Echo the user's typed line to the chat so they see what they sent,
       then mark the assistant turn as starting (consistent with chat flow). */
    panel.webview.postMessage({ type: 'info', text: `🖼 image-gen: "${intent.prompt}" via ${_info.label || providerId}` });
    setStatus('streaming', true, providerId);

    /* Providers with no image-gen API: render the friendly message inline
       instead of silently falling back, so the user doesn't get surprised
       by a chat-only reply. */
    if (providerId === 'anthropic') {
        panel.webview.postMessage({
            type: 'imageError',
            message: "Anthropic Claude doesn't have an image-generation endpoint. Switch to OpenAI / Gemini / xAI Grok for image gen.",
        });
        setStatus('idle', false, providerId);
        return true;
    }
    if (providerId === 'deepseek') {
        panel.webview.postMessage({
            type: 'imageError',
            message: "DeepSeek doesn't have an image-generation endpoint. Switch to OpenAI / Gemini / xAI Grok for image gen.",
        });
        setStatus('idle', false, providerId);
        return true;
    }
    if (providerId === 'azure') {
        panel.webview.postMessage({
            type: 'imageError',
            message: "Azure OpenAI image-gen isn't wired in this build. Use the OpenAI provider directly.",
        });
        setStatus('idle', false, providerId);
        return true;
    }

    /* Real image-gen providers. */
    const key = getProviderKey(context, providerId);
    if (!key) {
        panel.webview.postMessage({
            type: 'imageError',
            message: `${_info.label || providerId}: API key required for image gen. Set one in config.ini [api_keys] or via Set API Key.`,
        });
        setStatus('error', false, providerId);
        return true;
    }

    try {
        let out;
        if (providerId === 'openai') {
            out = await generateImageOpenAI(key, intent.prompt, intent.quality);
        } else if (providerId === 'gemini') {
            out = await generateImageGemini(key, intent.prompt);
        } else if (providerId === 'grok') {
            out = await generateImageGrok(key, intent.prompt);
        } else {
            /* Local / Ollama / anything we didn't special-case above. */
            panel.webview.postMessage({
                type: 'imageError',
                message: "Local models need ComfyUI or SD wired separately. Switch to OpenAI / Gemini / xAI Grok for image gen.",
            });
            setStatus('idle', false, providerId);
            return true;
        }
        trace(`image-gen ok provider=${providerId} prompt="${intent.prompt.slice(0, 60)}" bytes=${out.b64.length}`);
        panel.webview.postMessage({
            type: 'imageResult',
            provider: providerId,
            providerLabel: _info.label || providerId,
            prompt: intent.prompt,
            quality: intent.quality,
            mime: out.mime || 'image/png',
            b64: out.b64,
        });
        setStatus('idle', false, providerId);
    } catch (e) {
        traceErr(`image-gen failed (provider=${providerId})`, e);
        const msg = String((e && e.message) || e || 'unknown error');
        panel.webview.postMessage({
            type: 'imageError',
            message: `${_info.label || providerId}: image-gen failed — ${msg}`,
        });
        setStatus('error', false, providerId);
    }
    return true;
}

/* ── Logged-in Claude Code agent host ─────────────────────────────────────
   Resolve the native `claude` binary. The npm install ships a real exe at
   <prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe (the .cmd
   launcher just shells to it). Spawning the exe directly avoids a shell, so
   project paths with spaces are safe. Falls back to `claude(.cmd)` on PATH. */
function resolveClaudeExe() {
    const isWin = process.platform === 'win32';
    const exe = isWin ? 'claude.exe' : 'claude';
    const cands = [];
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
    cands.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
    cands.push(path.join(os.homedir(), '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
    if (process.env.npm_config_prefix) cands.push(path.join(process.env.npm_config_prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
    for (const c of cands) { try { if (c && fs.existsSync(c)) return { cmd: c, shell: false }; } catch (_) {} }
    /* PATH fallback — the Windows launcher is a .cmd, which needs a shell. */
    return { cmd: isWin ? 'claude.cmd' : 'claude', shell: isWin };
}

/* Permission mode for the hosted agent. The panel has no interactive
   approval UI, so the default (prompting) mode would auto-deny tools in
   print mode. Honor [claude_code] permission_mode from config.ini; default
   to bypassPermissions so the agent can actually run tools end-to-end on the
   user's own machine. Valid: acceptEdits | bypassPermissions | default | plan. */
function getClaudePermissionMode(context) {
    try {
        const cfg = readConfigIni(context.extensionPath) || {};
        const m = cfg.claude_code && cfg.claude_code.permission_mode;
        if (m && ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk', 'auto'].includes(String(m).trim())) {
            return String(m).trim();
        }
    } catch (_) { /* config optional */ }
    return 'bypassPermissions';
}

/* Summarize a tool_use input for a one-line ▶ notice (don't dump full args). */
function summarizeClaudeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    const pick = input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description;
    if (pick) return String(pick).split(/\r?\n/)[0].slice(0, 120);
    try { return JSON.stringify(input).slice(0, 100); } catch (_) { return ''; }
}

/* Host the real `claude` CLI agent for one user turn and stream its events to
   the panel using the same protocol as the HTTP-provider path (assistantStart
   was already posted by the caller; we post chunk / info / assistantDone).
   The agent runs its OWN tool loop (Bash/Edit/etc.) — we don't daisy-chain
   tools here. Session continuity is via --resume <session_id>, stored per
   panel on panel.__cbeClaudeSessionId. */
function streamClaudeAgent(context, panel, text, images) {
    return new Promise((resolve) => {
        const cp = require('child_process');
        const model = getActiveModel(context, 'claudeCode') || 'claude-sonnet-4-6';
        const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || os.homedir();
        const permMode = getClaudePermissionMode(context);

        let prompt = String(text || '').trim();
        if (images && images.length) prompt += `\n\n[${images.length} image(s) attached — image forwarding to the Claude Code agent is not wired yet]`;
        if (!prompt) { resolve(); return; }

        conversation.push({ role: 'user', content: prompt });
        try { touchActiveAccount(context, 'claudeCode'); } catch (_) {}
        setStatus('streaming', true, 'claudeCode');
        panel.webview.postMessage({ type: 'assistantStart' });

        const args = [
            '-p',
            '--output-format', 'stream-json',
            '--include-partial-messages',
            '--verbose',
            '--model', model,
            '--permission-mode', permMode,
            '--add-dir', projectFolder,
        ];
        const sid = panel.__cbeClaudeSessionId;
        if (sid) args.push('--resume', sid);

        /* Strip API-key env so the CLI authenticates via the Claude Code OAuth
           subscription (NOT the API-credit ledger). This is the whole point of
           "logged-in" mode. */
        const env = Object.assign({}, process.env);
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;

        const bin = resolveClaudeExe();
        trace(`claudeCode spawn: ${bin.cmd} model=${model} perm=${permMode} resume=${sid ? sid.slice(0, 8) : 'new'} cwd=${projectFolder}`);

        let child;
        try {
            child = cp.spawn(bin.cmd, args, { cwd: projectFolder, env, shell: bin.shell, windowsHide: true });
        } catch (e) {
            panel.webview.postMessage({ type: 'error', message: `claude spawn failed: ${(e && e.message) || e}` });
            try { setStatus('idle', false, 'claudeCode'); } catch (_) {}
            resolve();
            return;
        }
        panel.__cbeClaudeChild = child;

        let assembled = '';
        let stderrBuf = '';
        let stdoutBuf = '';
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            if (panel.__cbeClaudeChild === child) panel.__cbeClaudeChild = null;
            conversation.push({ role: 'assistant', content: assembled });
            panel.webview.postMessage({ type: 'assistantDone', text: assembled });
            try { setStatus('idle', false, 'claudeCode'); } catch (_) {}
            resolve();
        };

        const onEvent = (ev) => {
            if (!ev || typeof ev !== 'object') return;
            if (ev.session_id) panel.__cbeClaudeSessionId = ev.session_id;
            const t = ev.type;
            if (t === 'system' && ev.subtype === 'init') {
                panel.webview.postMessage({ type: 'status', text: `claude ${ev.model || model} · ${permMode} · session ${String(ev.session_id || '').slice(0, 8)}` });
                return;
            }
            /* Incremental text via --include-partial-messages. */
            if (t === 'stream_event' && ev.event) {
                const se = ev.event;
                if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta' && se.delta.text) {
                    assembled += se.delta.text;
                    panel.webview.postMessage({ type: 'chunk', text: se.delta.text });
                    /* CCLS: do NOT scan assistant text_delta — it's the model's
                       own output, never a real cap (a cap means the model can't
                       respond). Cap detection lives on stderr + is_error results
                       only, to avoid false-rotating when the assistant merely
                       discusses rate limits. */
                }
                return;
            }
            /* Assistant turn — surface tool_use as ▶ notices. Text already
               streamed via partials, so don't re-emit it here (avoids dupes). */
            if (t === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
                for (const b of ev.message.content) {
                    if (b && b.type === 'tool_use') {
                        panel.webview.postMessage({ type: 'info', text: `▶ ${b.name} ${summarizeClaudeToolInput(b.input)}` });
                    }
                }
                return;
            }
            /* Tool results come back as a synthetic user turn. */
            if (t === 'user' && ev.message && Array.isArray(ev.message.content)) {
                for (const b of ev.message.content) {
                    if (b && b.type === 'tool_result') {
                        const sz = typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content || '').length;
                        panel.webview.postMessage({ type: 'info', text: `◀ tool result (${sz}B)${b.is_error ? ' [error]' : ''}` });
                    }
                }
                return;
            }
            /* Terminal result event. If partials never delivered text (e.g.
               a pure tool turn), fall back to the final result string. */
            if (t === 'result') {
                if (!assembled && ev.result) {
                    assembled = String(ev.result);
                    panel.webview.postMessage({ type: 'chunk', text: assembled });
                }
                if (ev.is_error) {
                    panel.webview.postMessage({ type: 'info', text: `claude: ${ev.subtype || 'error'}` });
                    /* CCLS: ONLY an is_error result is a real cap signal. A
                       success result's `ev.result` is the assistant's final text
                       (would false-rotate if it mentioned a limit), so we never
                       scan it. fromErrorChannel=true. */
                    cclsCheckLimitText(String(ev.result || '') + ' ' + String(ev.subtype || ''), { context, panel }, true);
                }
                return;
            }
        };

        child.stdout.on('data', (d) => {
            stdoutBuf += d.toString('utf8');
            let nl;
            while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, nl).trim();
                stdoutBuf = stdoutBuf.slice(nl + 1);
                if (!line) continue;
                let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
                try { onEvent(ev); } catch (e) { traceErr('claudeCode onEvent', e); }
            }
        });
        child.stderr.on('data', (d) => {
            stderrBuf += d.toString('utf8');
            /* CCLS: stderr is a genuine error channel — the wrapped `claude` CLI
               prints the cap sentence here on some paths. Eligible to fire. */
            cclsCheckLimitText(stderrBuf.length > 800 ? stderrBuf.slice(-800) : stderrBuf, { context, panel }, true);
        });
        child.on('error', (e) => {
            panel.webview.postMessage({ type: 'error', message: `claude process error: ${(e && e.message) || e}` });
            finish();
        });
        child.on('close', (code) => {
            if (code !== 0 && !assembled) {
                panel.webview.postMessage({ type: 'error', message: `claude exited ${code}${stderrBuf ? ': ' + stderrBuf.slice(0, 500) : ''}` });
            }
            finish();
        });

        /* Feed the prompt over stdin (default --input-format text) so user
           text never touches a shell command line. */
        try { child.stdin.write(prompt); child.stdin.end(); }
        catch (e) { traceErr('claudeCode stdin', e); }
    });
}

async function handleSendText(context, panel, text, images) {
    /* Capture retry markers off the (possibly boxed-String) argument BEFORE
       trimming coerces it to a primitive and drops them. __cbeRotateCount
       counts rate-limit rotations this turn; __cbeAuthRetry guards the
       single auth-key retry. */
    const _rotateCount = (text && typeof text === 'object' && Number(text.__cbeRotateCount)) || 0;
    const _authRetried = !!(text && typeof text === 'object' && text.__cbeAuthRetry);
    text = (text || '').trim();
    if (!text && !(images && images.length)) return;

    const providerId = getActiveProvider(context);
    const model = getActiveModel(context, providerId);
    const maxTokens = getMaxTokens();

    /* If no key for this provider, prompt up-front and store it. Native
       bridge providers skip this — they authenticate via the tray exe's
       QtWebEngine profile (or local ollama daemon), not an API key. */
    const _pInfo = PROVIDERS[providerId] || {};

    /* Logged-in Claude Code agent: host the real `claude` CLI over the OAuth
       subscription (no API key, runs its own tool loop). Bypasses the whole
       HTTP-provider stream + CBE tool daisy-chain below. */
    if (_pInfo.cliAgent) {
        await streamClaudeAgent(context, panel, text, images);
        return;
    }

    /* If no key for this provider, prompt up-front and store it. Native
       bridge providers skip this — they authenticate via the tray exe's
       QtWebEngine profile (or local ollama daemon), not an API key. */
    if (!_pInfo.bridge && !getProviderKey(context, providerId)) {
        const got = await promptForKey(context, providerId);
        if (!got) {
            panel.webview.postMessage({ type: 'error', message: `${providerId}: API key required to send.` });
            return;
        }
        panel.webview.postMessage({ type: 'info', text: `${PROVIDERS[providerId].label} key stored.` });
    }

    /* Image-gen intercept. If the user's text reads as an image-gen request
       (slash `/image ...` or NL like "draw a goldfish"), route to the active
       provider's real image-gen endpoint instead of streaming chat — chat-only
       models hallucinate fake image URLs otherwise. Bridge providers fall
       through (their browser driver handles images natively). */
    if (!images || !images.length) {
        const handled = await tryHandleImageGeneration(context, panel, text);
        if (handled) return;
    }

    /* Multimodal: if the panel sent images alongside text, build an
       OpenAI-shape content array. Vision-capable OpenAI-compatible
       providers (gpt-4o, gpt-4-vision, grok-vision) consume this natively.
       Anthropic + Gemini + bridges fall back to text-only on their own
       conversion paths — _messagesToAnthropic will pass content[] through
       and the SDK will reject non-text blocks gracefully. */
    if (images && images.length) {
        const parts = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of images) {
            if (img && img.dataUri) {
                parts.push({ type: 'image_url', image_url: { url: img.dataUri } });
            }
        }
        conversation.push({ role: 'user', content: parts });
    } else {
        conversation.push({ role: 'user', content: text });
    }

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
                /* CCLS: do NOT scan this assistant text. It's the model's own
                   streamed output (and this HTTP-provider path isn't even the
                   wrapped-Anthropic-CLI path that CCLS rotates), so matching cap
                   phrases here would false-rotate when the assistant merely
                   discusses limits. Cap detection = stderr + is_error results
                   on the claude-subprocess path only. */
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
                    panel.webview.postMessage({ type: 'toolCall', phase: 'start', name: fname });
                    let resultStr;
                    try {
                        resultStr = await executeNativeToolCall(tc, { cwd: projectFolder, panel, context });
                    } catch (e) {
                        resultStr = `[executeNativeToolCall error: ${(e && e.message) || e}]`;
                    }
                    panel.webview.postMessage({ type: 'toolCall', phase: 'done', name: fname, bytes: (resultStr || '').length });
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
            if (calls.length && toolIterations < MAX_TOOL_ITERATIONS) {
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
                continue;
            }

            /* ── Bridge loose tool-call mode ──
               When the active provider is a browser-bridge AND the user has
               tool calls enabled in Settings ([bridge].tool_call_mode != off),
               we ALSO scan the reply for:
                 • triple-fenced shell blocks (no # !exec required)
                 • single-line backticked commands
                 • <run>…</run> tags
               and execute them per the configured policy (allowlist | confirm |
               auto), then feed the [tool output] back as a user turn so the
               bridge model can chain. Hard cap = tool_call_max_steps. */
            const _toolCfg = _pInfo.bridge ? loadToolCallConfig(context) : null;
            if (_pInfo.bridge && _toolCfg && _toolCfg.enabled && toolIterations < _toolCfg.maxSteps) {
                const projectFolder = context.workspaceState.get('codexBlackEd.projectFolder', '') || os.homedir();
                const looseResult = await _runToolCallsLoose(panel, context, assembled, _toolCfg, projectFolder);
                if (looseResult.ranAny || looseResult.calls.length) {
                    toolIterations++;
                    if (looseResult.ranAny) {
                        conversation.push({ role: 'user', content: looseResult.output });
                        panel.webview.postMessage({ type: 'assistantDone', text: assembled });
                        panel.webview.postMessage({ type: 'assistantStart' });
                        if (toolIterations >= _toolCfg.maxSteps) {
                            conversation[conversation.length - 1].content += `\n\n[tool-chain limit reached after ${_toolCfg.maxSteps} steps]`;
                            panel.webview.postMessage({ type: 'info', text: `[tool-chain limit reached after ${_toolCfg.maxSteps} steps]` });
                        }
                        continue;
                    }
                    /* All denied — still feed deny notice back so the model can react. */
                    if (looseResult.deniedAll && looseResult.output) {
                        conversation.push({ role: 'user', content: looseResult.output });
                        panel.webview.postMessage({ type: 'assistantDone', text: assembled });
                        panel.webview.postMessage({ type: 'assistantStart' });
                        continue;
                    }
                }
            }

            /* No more tool calls — finalize. */
            if (calls.length) {
                panel.webview.postMessage({ type: 'info', text: `Tool-call iteration cap (${MAX_TOOL_ITERATIONS}) reached — not executing further.` });
            }
            panel.webview.postMessage({ type: 'assistantDone', text: assembled });
            _postContextUsage(panel, context);
            setStatus('idle', false, providerId);
            break;
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
                /* The user-visible cue the cap was hit and we're cycling. The
                   full email→magic-link→offscreen-OAuth login for accounts that
                   need it runs inside ensureClaudeAccountLogin (account_switch.js)
                   once rotation picks the next account. */
                panel.webview.postMessage({ type: 'status', text: 'Switching accounts…' });
                panel.webview.postMessage({ type: 'accountSwitching', reason: rl.weekly ? 'weekly' : 'session' });
                const res = await rotateOnRateLimit(context, providerId, {
                    weekly: rl.weekly,
                    disableMs: rl.disableMs,
                });
                /* Refresh the panel's account/provider state either way. */
                if (activePanel) activePanel.webview.postMessage({ type: 'accountsState', ...buildAccountsPayload(context, providerId) });
                if (res.rotated) {
                    const fromLabel = res.from ? res.from.label : '(unknown)';
                    /* If the target account has no usable API key (email/magic-link
                       account), drive the offscreen sign-in before retrying. The
                       module is optional: if it isn't present yet, we fall through
                       to the plain key-swap retry (api_key accounts need no login). */
                    try {
                        const accountSwitch = require('./account_switch.js');
                        if (accountSwitch && typeof accountSwitch.ensureClaudeAccountLogin === 'function'
                            && res.to && !res.to.apiKey) {
                            await accountSwitch.ensureClaudeAccountLogin(context, res.to, {
                                extensionPath: context.extensionPath,
                                postStatus: (t) => panel.webview.postMessage({ type: 'status', text: t }),
                            });
                        }
                    } catch (loginErr) {
                        trace(`ACCOUNTS:LOGIN-FLOW skipped/failed: ${(loginErr && loginErr.message) || loginErr}`);
                    }
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
   for chats that aren't aware of the convention).

   BRIDGE TOOL-CALL MODE (parseToolCallsLoose): when the user enables tool
   calls in Settings, the bridge chat path ALSO accepts:
     • triple-fenced shell blocks without the `# !exec` marker
     • single-line backticked commands at the start of a line (`calc`)
     • <run>...</run> XML tags
   Gated by [bridge].tool_call_mode in config.ini (off | allowlist |
   confirm | auto). Default `allowlist`. */
const TOOL_FENCE_RE = /```(bash|sh|shell|pwsh|powershell|cmd|batch)\r?\n([\s\S]*?)```/gi;
const TOOL_EXEC_MARKER_RE = /^\s*#\s*!exec\b/i;

/* Loose: same fence regex but NO !exec marker required + backtick singles +
   <run>...</run>. Used by the bridge tool-call path. */
const TOOL_FENCE_LOOSE_RE = /```(bash|sh|shell|pwsh|powershell|cmd|batch)\r?\n([\s\S]*?)```/gi;
const TOOL_BACKTICK_LINE_RE = /(^|\n)[ \t]*`([^`\r\n]{1,400})`[ \t]*(?=\r?\n|$)/g;
const TOOL_RUN_TAG_RE = /<run>([\s\S]*?)<\/run>/gi;

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

/* Loose parser: collects every plausible command. Each entry carries `kind`
   ('fence' | 'backtick' | 'run') so the executor can pick the right shell.
   Order in the output reflects appearance order in the source — the daisy
   chain runs them in this order. */
function parseToolCallsLoose(text) {
    const out = [];
    if (!text) return out;
    const hits = [];
    /* 1. Fenced shell blocks (no # !exec needed). */
    TOOL_FENCE_LOOSE_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_FENCE_LOOSE_RE.exec(text)) !== null) {
        const lang = m[1].toLowerCase();
        const body = (m[2] || '').replace(/\r?\n$/, '');
        if (!body.trim()) continue;
        hits.push({ idx: m.index, kind: 'fence', lang, command: body, raw: m[0] });
    }
    /* 2. <run>…</run> XML tag → cmd. */
    TOOL_RUN_TAG_RE.lastIndex = 0;
    while ((m = TOOL_RUN_TAG_RE.exec(text)) !== null) {
        const cmd = (m[1] || '').trim();
        if (!cmd) continue;
        hits.push({ idx: m.index, kind: 'run', lang: 'cmd', command: cmd, raw: m[0] });
    }
    /* 3. Single-line backticked command at the start of a line. We avoid
       false positives by skipping ranges already claimed by fences/<run>. */
    const claimedRanges = hits.map(h => [h.idx, h.idx + h.raw.length]);
    const inClaimed = (i) => claimedRanges.some(([a, b]) => i >= a && i < b);
    TOOL_BACKTICK_LINE_RE.lastIndex = 0;
    while ((m = TOOL_BACKTICK_LINE_RE.exec(text)) !== null) {
        if (inClaimed(m.index)) continue;
        const cmd = (m[2] || '').trim();
        if (!cmd) continue;
        /* Skip obviously-non-command snippets (e.g. inline identifiers).
           Heuristic: only treat as command if first token looks like an
           exe/word and not pure punctuation. */
        if (!/^[A-Za-z_./\\-]/.test(cmd)) continue;
        hits.push({ idx: m.index, kind: 'backtick', lang: 'cmd', command: cmd, raw: m[0] });
    }
    hits.sort((a, b) => a.idx - b.idx);
    return hits;
}

/* Load [bridge] tool-call settings from config.ini. Defaults match the
   conservative "allowlist mode + 10 step cap + 60s timeout" the spec calls
   for. Returns:
     { enabled: bool, mode: 'off'|'allowlist'|'confirm'|'auto',
       maxSteps: number, allowlist: string[], timeoutMs: number } */
function loadToolCallConfig(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const br = cfg.bridge || {};
    let mode = String(br.tool_call_mode || 'allowlist').toLowerCase().trim();
    if (!['off', 'allowlist', 'confirm', 'auto'].includes(mode)) mode = 'allowlist';
    const maxSteps = Math.max(1, Math.min(50, Number(br.tool_call_max_steps) || 10));
    const timeoutMs = Math.max(1000, Math.min(600000, (Number(br.tool_call_timeout_s) || 60) * 1000));
    /* Allowlist: newline OR comma separated. Persisted as a single config.ini
       value with "|" as the separator (since INI lines can't have embedded
       newlines without escapes). We accept any of the three for resilience. */
    let allowRaw = br.tool_call_allowlist;
    if (allowRaw === undefined || allowRaw === null || String(allowRaw).trim() === '') {
        allowRaw = TOOL_CALL_DEFAULT_ALLOWLIST.join('|');
    }
    const allowlist = String(allowRaw)
        .split(/[|\n,]/)
        .map(s => s.trim())
        .filter(Boolean);
    return { enabled: mode !== 'off', mode, maxSteps, allowlist, timeoutMs };
}

/* Bridge-operator config (Settings → Bridge Operator). The operator is the
   vision-pilot LLM that drives the offscreen Chromium bridges by reading
   screenshots and emitting JSON actions. provider is selectable; default is
   azure (Trent's only funded GPT-class option). Mirrors loadToolCallConfig:
   reads config.ini [bridge_operator], returns a small hydrated object. */
const BRIDGE_OPERATOR_PROVIDERS = ['azure', 'openai', 'anthropic', 'gemini', 'vertex'];
function loadBridgeOperatorConfig(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const bo = cfg.bridge_operator || {};
    let provider = String(bo.provider || 'azure').toLowerCase().trim();
    if (!BRIDGE_OPERATOR_PROVIDERS.includes(provider)) provider = 'azure';
    const azure = cfg.azure || {};
    const keys = cfg.api_keys || {};
    return {
        provider,
        azureDeployment: String(bo.azure_deployment || azure.deployment_name || '').trim(),
        openaiModel: String(bo.openai_model || keys.gpt_model_choice || '').trim(),
        anthropicModel: String(bo.anthropic_model || keys.claude_model_choice || '').trim(),
        geminiModel: String(bo.gemini_model || keys.gem_model_choice || '').trim(),
        vertexModel: String(bo.vertex_model || 'gemini-2.5-flash').trim(),
    };
}

const TOOL_CALL_DEFAULT_ALLOWLIST = [
    'calc', 'notepad', 'dir', 'echo', 'ls', 'pwd', 'cat', 'type',
    'whoami', 'hostname', 'date', 'time', 'ipconfig', 'netstat',
    'tasklist', 'ping', 'tracert', 'where',
    'git status', 'git log', 'git diff', 'git branch',
    'node --version', 'python --version', 'gh repo list',
];

/* Check a command string against the allowlist. We compare the FIRST TOKEN
   (the executable) AND the longest matching prefix — `git status` should
   match the allow-listed "git status" but `git push` should not. */
function isCommandAllowed(command, allowlist) {
    if (!command) return false;
    const norm = command.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const entry of allowlist) {
        const e = String(entry).replace(/\s+/g, ' ').trim().toLowerCase();
        if (!e) continue;
        if (norm === e) return true;
        if (norm.startsWith(e + ' ')) return true;
        /* Also accept `cmd.exe` for `cmd`, etc. */
        if (norm.startsWith(e + '.')) return true;
    }
    return false;
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
        const cp = require('child_process');
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

/* Bridge-style [tool output] formatter. Plain-text body the bridge model can
   read on its next turn without further markup. */
function formatToolOutputBridge(call, r) {
    const cmdShort = (call.command || '').split(/\r?\n/)[0].slice(0, 200);
    const out = [];
    out.push(`[tool output] cmd=\`${cmdShort}\``);
    out.push('--- stdout ---');
    out.push((r.stdout || '').replace(/\r?\n$/, ''));
    out.push('--- stderr ---');
    out.push((r.stderr || '').replace(/\r?\n$/, ''));
    out.push(`--- returncode=${r.rc}${r.signal ? ` signal=${r.signal}` : ''}${r.truncated ? ' truncated=true' : ''} ms=${r.durationMs} ---`);
    return out.join('\n');
}

/* Map a loose call's kind/lang to a real shell. backtick + run + lang=cmd
   all default to cmd.exe. Other langs delegate to executeToolCall's
   normal dispatcher. */
function _resolveToolLang(call) {
    if (call.kind === 'fence' && call.lang) return call.lang;
    if (call.kind === 'run' || call.kind === 'backtick' || !call.lang) return 'cmd';
    return call.lang;
}

/* Wait for the panel to answer a `toolConfirm` request. We post the prompt,
   record the resolver on the panel object, and resolve when the panel sends
   back `toolConfirmResponse`. The dispatcher in registerPanelMessages picks
   up the response and calls the stored resolver. Times out after 5 minutes
   so a stale tab can't hold the chain forever. */
function awaitToolConfirm(panel, payload, timeoutMs) {
    return new Promise((resolve) => {
        const id = 'tc_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
        if (!panel.__cbeToolConfirmResolvers) panel.__cbeToolConfirmResolvers = {};
        panel.__cbeToolConfirmResolvers[id] = (decision) => resolve(decision);
        const timer = setTimeout(() => {
            try {
                const r = panel.__cbeToolConfirmResolvers && panel.__cbeToolConfirmResolvers[id];
                if (r) {
                    delete panel.__cbeToolConfirmResolvers[id];
                    r(false);
                }
            } catch (_) {}
        }, timeoutMs || 300000);
        try {
            panel.webview.postMessage({ type: 'toolConfirm', id, ...payload });
        } catch (_) {
            clearTimeout(timer);
            resolve(false);
        }
    });
}

/* Execute one loose tool call with the configured policy. Returns:
     { ran: bool, denied: bool, denyReason: string|null, result: <executeToolCall result>|null } */
async function runOneToolCallWithPolicy(panel, context, call, cfg, opts) {
    const lang = _resolveToolLang(call);
    const execCall = { lang, command: call.command, raw: call.raw };
    const cwd = opts.cwd;
    /* Mode gate. */
    if (cfg.mode === 'off') {
        return { ran: false, denied: true, denyReason: 'tool calls disabled', result: null };
    }
    let needsConfirm = false;
    if (cfg.mode === 'auto') {
        needsConfirm = false;
    } else if (cfg.mode === 'allowlist') {
        if (!isCommandAllowed(call.command, cfg.allowlist)) {
            needsConfirm = true;
        }
    } else { /* 'confirm' */
        needsConfirm = true;
    }
    if (needsConfirm && panel) {
        const decision = await awaitToolConfirm(panel, {
            command: call.command,
            lang,
            kind: call.kind || 'fence',
            mode: cfg.mode,
        }, 300000);
        if (!decision) {
            return { ran: false, denied: true, denyReason: 'user denied execution', result: null };
        }
    } else if (needsConfirm && !panel) {
        /* No panel to ask — deny. */
        return { ran: false, denied: true, denyReason: 'no UI to confirm execution', result: null };
    }
    const r = await executeToolCall(execCall, { cwd, timeoutMs: cfg.timeoutMs });
    return { ran: true, denied: false, denyReason: null, result: r };
}

/* Detect + run loose tool calls in a bridge reply. Posts a `toolExec` event
   to the panel for visual feedback, executes per-policy, and returns
   { ranAny, output, deniedAll } so the caller can decide whether to chain.

   The `output` string is in the [tool output] shape the spec asks for —
   one block per executed call, separated by blank lines. */
async function _runToolCallsLoose(panel, context, replyText, cfg, cwd) {
    const calls = parseToolCallsLoose(replyText);
    if (!calls.length) return { ranAny: false, output: '', deniedAll: false, calls: [] };
    const parts = [];
    let ranAny = false;
    let denyCount = 0;
    for (const call of calls) {
        const cmdShort = (call.command || '').split(/\r?\n/)[0].slice(0, 120);
        if (panel) {
            try {
                panel.webview.postMessage({
                    type: 'toolExec',
                    command: call.command,
                    cmdShort,
                    kind: call.kind || 'fence',
                    lang: _resolveToolLang(call),
                    mode: cfg.mode,
                });
            } catch (_) {}
        }
        const decision = await runOneToolCallWithPolicy(panel, context, call, cfg, { cwd });
        if (decision.denied) {
            denyCount++;
            const denyBlock = [
                `[tool output] cmd=\`${cmdShort}\``,
                '--- stdout ---',
                '',
                '--- stderr ---',
                decision.denyReason || 'execution denied',
                '--- returncode=-1 denied=true ---',
            ].join('\n');
            parts.push(denyBlock);
            if (panel) {
                try {
                    panel.webview.postMessage({
                        type: 'toolResult',
                        command: call.command,
                        cmdShort,
                        rc: -1,
                        denied: true,
                        reason: decision.denyReason || 'denied',
                        stdout: '',
                        stderr: decision.denyReason || 'denied',
                        durationMs: 0,
                    });
                } catch (_) {}
            }
            continue;
        }
        ranAny = true;
        const r = decision.result;
        const execLang = _resolveToolLang(call);
        parts.push(formatToolOutputBridge({ command: call.command, lang: execLang }, r));
        if (panel) {
            try {
                panel.webview.postMessage({
                    type: 'toolResult',
                    command: call.command,
                    cmdShort,
                    rc: r.rc,
                    denied: false,
                    stdout: r.stdout || '',
                    stderr: r.stderr || '',
                    durationMs: r.durationMs,
                    truncated: !!r.truncated,
                });
            } catch (_) {}
        }
    }
    return {
        ranAny,
        output: parts.join('\n\n'),
        deniedAll: denyCount === calls.length && calls.length > 0,
        calls,
    };
}

module.exports = { activate, deactivate };
