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
const { BrowserBridge } = require('./bridge/browser-bridge');
const { SuperGrokBridge } = require('./bridge/supergrok-bridge');

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
    azure: {
        label: 'Azure OpenAI',
        /* Azure reads from [azure] section, not [api_keys]. Model = deployment name. */
        azureSection: true,
        defaultModel: '',
        models: [],
    },
    grokWeb: {
        label: 'Grok (web session)',
        webBridge: true,
        target: 'grok',
        url: 'https://grok.com/',
        defaultModel: '(web)',
        models: ['(web)'],
    },
    chatgptWeb: {
        label: 'ChatGPT (web session)',
        webBridge: true,
        target: 'chatgpt',
        url: 'https://chatgpt.com/',
        defaultModel: '(web)',
        models: ['(web)'],
    },
    geminiBridge: {
        /* Gemini via SuperGrok's resident bridge service (TCP). Requires
           C:\SuperGrok\ + a one-time `python start.py --gemini` login. */
        label: 'Gemini (SuperGrok)',
        superGrok: true,
        target: 'gemini',
        superGrokRoot: 'C:\\SuperGrok',
        defaultModel: '(web)',
        models: ['(web)'],
    },
    claudeBridge: {
        /* Claude via SuperGrok's resident bridge service (TCP). Requires
           C:\SuperGrok\ + a one-time `python start.py --claude` login. Note:
           one SuperGrok service answers one target at a time — if a Gemini
           bridge is running you'll need to stop it before Claude works. */
        label: 'Claude (SuperGrok)',
        superGrok: true,
        target: 'claude',
        superGrokRoot: 'C:\\SuperGrok',
        defaultModel: '(web)',
        models: ['(web)'],
    },
};

const DEFAULT_PROVIDER = 'anthropic';

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
    /* Web-bridge / SuperGrok providers don't use API keys at all; auth lives
       in the browser-profile cookies on the bridge side. Return a sentinel
       so the "(no key)" badge in the settings modal doesn't fire. */
    if (provider.webBridge || provider.superGrok) return '<web-session>';
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

let activePanel;
let conversation = [];
let outChan;
/* Our owned terminal — recreated on click if the user closed it. Kept here
   (module scope) so the openTerminal handler reveals the SAME terminal it
   created, not whatever VSCode picked as activeTerminal. */
let cbeTerm = null;
let statusBar;
let anthropicClient;
const browserBridges = {};   /* providerId -> BrowserBridge (lazy, persists across sends) */
const superGrokBridges = {}; /* providerId -> SuperGrokBridge (TCP shim over SuperGrok's service) */
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
/* Markers so we can pick the real transcript out of arbitrary PS output
   (progress, warnings, $PSDefaultParameterValues echoes, etc.). The script
   prints `__CBE_STT_OK__<text>` on success and `__CBE_STT_ERR__<msg>` on
   failure. Anything else is ignored, which avoids `exit null` looking like
   a transcript. */
const STT_OK_MARK = '__CBE_STT_OK__';
const STT_ERR_MARK = '__CBE_STT_ERR__';
function startSapiStt(panel) {
    if (__sttProc) {
        try { __sttProc.kill(); } catch (e) {}
        __sttProc = null;
    }
    /* The previous implementation used `-Command <inline-script>` which (a)
       has nasty quoting issues with the `[TimeSpan]::FromSeconds(8)` casts
       and (b) defaults to MTA threading. COM-backed speech APIs require an
       STA apartment, so the COM fallback would silently die — that's what
       `exit null` was, the recognizer constructor throwing on a thread
       that can't host its COM proxies. The fix is to write the script to
       a temp .ps1 and invoke with `-Sta -File`, which gives us STA + a
       proper file-scoped parser.

       We also try TWO recognizers in order:
         1. System.Speech.Recognition.SpeechRecognitionEngine (managed,
            ships with .NET Framework, works on any Windows 10+ with
            Windows Speech installed).
         2. SAPI.SpInprocRecognizer COM (older SAPI 5.x, present even
            when the .NET assembly fails to load — e.g. PowerShell 7+
            doesn't auto-resolve `System.Speech` from the GAC).
       Both write to stdout via the marker convention; the parent reads
       only marker-prefixed lines and ignores everything else. */
    const psLines = [
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'function Emit-Ok($t)  { Write-Host ("' + STT_OK_MARK + '" + $t) }',
        'function Emit-Err($m) { Write-Host ("' + STT_ERR_MARK + '" + $m) }',
        '$managedOk = $false',
        'try {',
        '  Add-Type -AssemblyName System.Speech -ErrorAction Stop',
        '  $managedOk = $true',
        '} catch {',
        '  [Console]::Error.WriteLine("System.Speech load failed: " + $_.Exception.Message)',
        '}',
        'if ($managedOk) {',
        '  try {',
        '    $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
        '    $r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)',
        '    $r.EndSilenceTimeout     = [TimeSpan]::FromSeconds(1.2)',
        '    $r.BabbleTimeout         = [TimeSpan]::FromSeconds(15)',
        '    $g = New-Object System.Speech.Recognition.DictationGrammar',
        '    $r.LoadGrammar($g)',
        '    $r.SetInputToDefaultAudioDevice()',
        '    $res = $r.Recognize([TimeSpan]::FromSeconds(15))',
        '    if ($res -and $res.Text) { Emit-Ok $res.Text } else { Emit-Ok "" }',
        '    try { $r.Dispose() } catch {}',
        '    exit 0',
        '  } catch {',
        '    [Console]::Error.WriteLine("Managed recognizer failed: " + $_.Exception.Message)',
        '  }',
        '}',
        '# COM fallback: SAPI 5.x in-proc recognizer.',
        'try {',
        '  $rec = New-Object -ComObject SAPI.SpInprocRecognizer',
        '  $ctx = $rec.CreateRecoContext()',
        '  $gra = $ctx.CreateGrammar(0)',
        '  $gra.DictationLoad()',
        '  $gra.DictationSetState(1)  # SGDSActive',
        '  $deadline = (Get-Date).AddSeconds(15)',
        '  $got = ""',
        '  while ((Get-Date) -lt $deadline) {',
        '    $ev = $null',
        '    try { $ev = $ctx.GetEvents(1, 200) } catch { Start-Sleep -Milliseconds 100; continue }',
        '    if ($ev -and $ev.Count -gt 0) {',
        '      foreach ($e in $ev) {',
        '        if ($e.EventId -eq 1) { # SPEI_RECOGNITION',
        '          try { $got = $e.RecoResult.PhraseInfo.GetText() } catch {}',
        '          break',
        '        }',
        '      }',
        '      if ($got) { break }',
        '    } else {',
        '      Start-Sleep -Milliseconds 100',
        '    }',
        '  }',
        '  $gra.DictationSetState(0)',
        '  Emit-Ok $got',
        '  exit 0',
        '} catch {',
        '  Emit-Err ("COM SAPI failed: " + $_.Exception.Message)',
        '  exit 2',
        '}',
    ];
    let scriptPath;
    try {
        scriptPath = path.join(os.tmpdir(), 'cbe-stt-' + process.pid + '-' + Date.now() + '.ps1');
        fs.writeFileSync(scriptPath, psLines.join('\r\n'), 'utf8');
    } catch (e) {
        traceErr('stt: write script', e);
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: 'cannot write SAPI script: ' + (e.message || e) }); } catch (_) {}
        return;
    }
    __sttScriptPath = scriptPath;
    trace('stt: spawning powershell SAPI (Sta, File=' + scriptPath + ')');
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
        trace('stt: ps closed code=' + code + ' signal=' + signal +
              ' stdoutBytes=' + stdout.length + ' stderrBytes=' + stderr.length);
        if (__sttProc === proc) __sttProc = null;
        try { if (__sttScriptPath) fs.unlinkSync(__sttScriptPath); } catch (_) {}
        __sttScriptPath = null;
        /* Scan stdout for our markers. We deliberately ignore the exit
           code as the primary signal because powershell scripts can
           sometimes exit non-zero even after a successful Emit-Ok (e.g.
           a Dispose() throwing during cleanup). */
        let okText = null;
        let errMsg = null;
        for (const raw of stdout.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith(STT_OK_MARK)) okText = line.slice(STT_OK_MARK.length);
            else if (line.startsWith(STT_ERR_MARK)) errMsg = line.slice(STT_ERR_MARK.length);
        }
        if (okText !== null) {
            try { panel.webview.postMessage({ type: 'sttResult', text: okText }); } catch (_) {}
            if (stderr.trim()) trace('stt: stderr (non-fatal): ' + stderr.trim());
            return;
        }
        const err = errMsg ||
                    (stderr.trim()) ||
                    (signal ? ('killed by ' + signal) : ('exit ' + (code === null ? 'null' : code)));
        try { panel.webview.postMessage({ type: 'sttResult', text: '', error: err }); } catch (_) {}
    });
}
function stopSapiStt() {
    if (!__sttProc) return;
    trace('stt: stopping ps proc');
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
        outChan.appendLine('Call (724) 431-5207 to discuss your next project! (PHP, Python, node.js - desktp, web and mobile)');
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
    setStatus('idle', false, getActiveProvider(context));
    context.subscriptions.push(statusBar);
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
        vscode.commands.registerCommand('codexBlackEd.openWebLogin', () => openWebLogin(context)),
        vscode.commands.registerCommand('codexBlackEd.disposeWebBridge', () => disposeAllBridges()),
        /* If the user closes our terminal, drop the reference so the next
           click on the Terminal button creates a fresh one in the right cwd. */
        vscode.window.onDidCloseTerminal((t) => { if (t === cbeTerm) cbeTerm = null; }),
        outChan,
    );
    endCmds(`(${9} commands)`);

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

    endActivate();
    trace('=== activate complete ===');
}

function deactivate() {
    trace('=== deactivate ===');
    disposeAllBridges();
}

function disposeAllBridges() {
    for (const id of Object.keys(browserBridges)) {
        try { browserBridges[id].dispose(); } catch (e) { traceErr(`disposeAllBridges(${id})`, e); }
        delete browserBridges[id];
    }
}

/* Open the browser-bridge tab(s) so the user can sign in. Asks which provider
   when there are multiple webBridge OR superGrok providers configured. Does
   not send any prompt — pure auth bootstrap. */
async function openWebLogin(context) {
    const ids = Object.keys(PROVIDERS).filter(id => PROVIDERS[id].webBridge || PROVIDERS[id].superGrok);
    if (!ids.length) { vscode.window.showInformationMessage('No web-bridge providers configured.'); return; }
    let id;
    if (ids.length === 1) id = ids[0];
    else {
        const pick = await vscode.window.showQuickPick(
            ids.map(i => ({ label: PROVIDERS[i].label, id: i })),
            { title: 'Open web login for which provider?', ignoreFocusOut: true }
        );
        if (!pick) return;
        id = pick.id;
    }
    const p = PROVIDERS[id];
    try {
        if (p.superGrok) {
            const bridge = getSuperGrokBridge(id);
            const r = await bridge.openLoginWindow();
            vscode.window.showInformationMessage(
                `CBE: ${p.label} login window opened (pid ${r.pid}). Sign in to Google, then close the window.`
            );
            return;
        }
        const bridge = getBrowserBridge(id);
        await bridge.ensureRunning();
        await bridge.navigateHome();
        const probe = await bridge.ping();
        vscode.window.showInformationMessage(
            `CBE: ${p.label} window opened at ${probe.url}. Sign in there; the session is saved.`
        );
    } catch (e) {
        traceErr('openWebLogin', e);
        vscode.window.showErrorMessage('CBE: web login failed — ' + (e.message || e));
    }
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

function _supervisorHttpAlive() {
    /* Quick liveness probe — supervisor.ps1 binds 127.0.0.1:3434 and replies
       to GET / with `Status: 200 OK` and a JSON status blob. A 200 here is
       proof the script is actually executing inside its NSSM-managed process,
       not just that SCM thinks the service is running. Returns a Promise that
       resolves to true on 200 within 700ms, false otherwise. */
    return new Promise((resolve) => {
        try {
            const http = require('http');
            const req = http.request({ host: '127.0.0.1', port: 3434, path: '/', method: 'GET', timeout: 700 }, (res) => {
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
    // Path quoting for PowerShell. Single-quoted PS strings are LITERAL —
    // no $-expansion, no escape sequences — which makes them the safest
    // form for paths with spaces. The previous double-quoted form lost the
    // outer quotes when PowerShell handed argv to nssm, splitting the
    // "Microsoft VS Code" path into three tokens and tripping the install.
    const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const psExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    // AppParameters is stored AS A SINGLE STRING in the registry. NSSM
    // re-uses it verbatim when spawning, so paths with spaces inside the
    // arg string need their OWN embedded double-quotes (which we double-up
    // inside the PowerShell single-quoted outer string).
    const appParams = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}" -CodePath "${codePath}"`;
    const logDir    = os.tmpdir();
    const stdoutLog = path.join(logDir, 'cbe_supervisor.stdout.log');
    const stderrLog = path.join(logDir, 'cbe_supervisor.stderr.log');
    // Stub-then-set install: avoids the quote-chain disaster of trying to
    // pass Application + AppParameters in one giant `nssm install` call.
    // Each `nssm set` takes ONE value, single-quoted, so PowerShell can't
    // split it on spaces. `nssm install <name>` with no app argument
    // creates a stub the subsequent `set` calls fill in.
    const ps = [
        `& ${sq(nssm)} stop ${SUPERVISOR_SERVICE_NAME} 2>&1 | Out-Null`,
        `& ${sq(nssm)} remove ${SUPERVISOR_SERVICE_NAME} confirm 2>&1 | Out-Null`,
        // Installing with placeholder so older NSSM builds that require an
        // app argument don't reject the stub. We overwrite it immediately.
        `& ${sq(nssm)} install ${SUPERVISOR_SERVICE_NAME} ${sq(psExe)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Application       ${sq(psExe)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppParameters     ${sq(appParams)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppDirectory      ${sq(path.dirname(scriptPath))}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} DisplayName       ${sq(SUPERVISOR_DISPLAY_NAME)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Description       ${sq('Keeps VSCode (Code.exe) alive - relaunches on crash. Managed by Claude Codex Black.')}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} Start             SERVICE_DEMAND_START`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStdout         ${sq(stdoutLog)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStderr         ${sq(stderrLog)}`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppRotateFiles    1`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppRotateBytes    1048576`,
        // NSSM sends CTRL+C on stop. supervisor.ps1's CancelKeyPress handler
        // catches it and breaks the loop. 3s gives the loop time to drain.
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStopMethodSkip    0`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} AppStopMethodConsole 3000`,
        `& ${sq(nssm)} set    ${SUPERVISOR_SERVICE_NAME} ObjectName        LocalSystem`,
        // SDDL: SY=LocalSystem (full), BA=BuiltinAdmins (full),
        // AU=AuthUsers (start/stop/query) — so post-install toggles need no UAC.
        `sc.exe sdset ${SUPERVISOR_SERVICE_NAME} 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLORC;;;AU)' | Out-Null`,
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
    panel.webview.postMessage({ type: 'monitorState', running: after === 'running', state: after });
    return after;
}

/* ── NameSilo domain list ────────────────────────────────────────────────
   Reads the API key from config.ini ([namesilo] api_key, fallback
   [api_keys].namesilo_api_key), hits /listDomains then /getDomainInfo per
   domain for nameservers. Returns { domains: [{name, nameservers[]}] } or
   { error: '...' }. Pure stdlib — uses node's https module, no axios. */
async function listNameSiloDomains(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
    let apiKey = (cfg.namesilo && cfg.namesilo.api_key) || (cfg.api_keys && cfg.api_keys.namesilo_api_key) || '';
    apiKey = String(apiKey || '').trim();
    if (!apiKey) {
        return { error: 'No NameSilo API key in config.ini ([namesilo] api_key or [api_keys] namesilo_api_key).' };
    }
    const baseUrl = (cfg.namesilo && cfg.namesilo.base_url) || 'https://www.namesilo.com/api';
    const https = require('https');
    const url = require('url');

    function call(endpoint, extra) {
        const params = new URLSearchParams({ version: '1', type: 'json', key: apiKey, ...(extra || {}) });
        const full = `${baseUrl}/${endpoint}?${params.toString()}`;
        const parsed = url.parse(full);
        return new Promise((resolve, reject) => {
            const req = https.request({
                method: 'GET',
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.path,
                headers: { 'Accept': 'application/json' },
                timeout: 30000,
            }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (d) => buf += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(buf)); }
                    catch (e) { reject(new Error('non-JSON reply: ' + buf.slice(0, 120))); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.end();
        });
    }

    let listed;
    try { listed = await call('listDomains'); }
    catch (e) { return { error: 'listDomains: ' + (e.message || e) }; }
    const reply = (listed && listed.reply) || {};
    if (reply.code !== 300) {
        return { error: `NameSilo API ${reply.code}: ${reply.detail || ''}` };
    }
    let raw = (reply.domains && reply.domains.domain) || [];
    if (typeof raw === 'string') raw = [raw];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = [raw];
    if (!Array.isArray(raw)) raw = [];

    const domains = [];
    for (const entry of raw) {
        /* NameSilo's /listDomains returns each row as an object
           { domain, created, expires } — not a bare string. The old code
           did `String(entry)` which produced "[object Object]" and made
           every subsequent getDomainInfo call fail. */
        const dname = (entry && typeof entry === 'object')
            ? String(entry.domain || entry.name || '').trim()
            : String(entry || '').trim();
        if (!dname) continue;
        try {
            const info = await call('getDomainInfo', { domain: dname });
            const ir = (info && info.reply) || {};
            if (ir.code !== 300) {
                domains.push({ name: dname, nameservers: [`(error ${ir.code}: ${ir.detail || ''})`] });
                continue;
            }
            let ns = (ir.nameservers && ir.nameservers.nameserver) || [];
            if (typeof ns === 'string') ns = [ns];
            const cleaned = (Array.isArray(ns) ? ns : []).map(n => {
                if (n && typeof n === 'object') return String(n['#text'] || n.host || '').trim();
                return String(n || '').trim();
            }).filter(Boolean);
            domains.push({ name: dname, nameservers: cleaned.length ? cleaned : ['(none)'] });
        } catch (e) {
            domains.push({ name: dname, nameservers: [`(lookup failed: ${e.message || e})`] });
        }
    }
    return { domains };
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

function buildSettingsPayload(context) {
    const endPay = timeStep('    buildSettingsPayload');
    const endIni = timeStep('      readConfigIni');
    const cfg = readConfigIni(context.extensionPath) || {};
    endIni();
    const active = getActiveProvider(context);
    const providers = Object.keys(PROVIDERS).map(id => {
        const p = PROVIDERS[id];
        const haveKey = !!getProviderKey(context, id);
        const models = p.azureSection
            ? (cfg.azure && cfg.azure.deployment_name ? [cfg.azure.deployment_name] : [])
            : p.models.slice();
        const currentModel = getActiveModel(context, id);
        if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
        return { id, label: p.label, models, current: currentModel, haveKey, webBridge: !!p.webBridge, superGrok: !!p.superGrok };
    });
    /* SFX prefs are persisted in workspaceState. Booleans + a 0..1 number;
       defaults match the panel's window.SFX_* defaults so a fresh install
       hears sounds at the same volume the agent originally wired (0.55). */
    const sfxEnabled = context.workspaceState.get('codexBlackEd.sfxEnabled');
    const sfxVolume  = context.workspaceState.get('codexBlackEd.sfxVolume');
    const bigFont    = context.workspaceState.get('codexBlackEd.bigFont');
    endPay(`providers=${providers.length} active=${active}`);
    return {
        providers,
        active,
        sfxEnabled: (typeof sfxEnabled === 'boolean') ? sfxEnabled : true,
        sfxVolume:  (typeof sfxVolume  === 'number')  ? sfxVolume  : 0.55,
        bigFont:    (typeof bigFont    === 'boolean') ? bigFont    : false,
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
                    panel.webview.postMessage({
                        type: 'init',
                        ...buildSettingsPayload(context),
                        skin: resolved.name,
                        skinUri,
                        skinColors: resolved.colors || null,
                    });
                    endInit();
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
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Attach file',
                    });
                    if (!picked || !picked[0]) break;
                    const fp = picked[0].fsPath;
                    try {
                        const stat = fs.statSync(fp);
                        if (stat.size > 1024 * 1024) {
                            panel.webview.postMessage({ type: 'info', text: `Attach skipped: ${path.basename(fp)} is larger than 1 MB.` });
                            break;
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
                        panel.webview.postMessage({ type: 'error', message: 'attach: ' + (e.message || e) });
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
                    conversation = [];
                    trace(`active provider set: ${msg.provider} / ${msg.model || '(default)'} sfx=${msg.sfxEnabled}/${msg.sfxVolume} skin=${msg.skin || '(none)'}`);
                    setStatus('idle', false, msg.provider);
                    panel.webview.postMessage({ type: 'info', text: `Provider → ${PROVIDERS[msg.provider].label} · ${msg.model || getActiveModel(context, msg.provider)}` });
                    break;
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
                    /* Read-only status probe. Glow tracks the HTTP liveness on
                       :3434 (200 OK means the supervisor script is actually
                       running and serving). `state` from sc.exe is reported
                       too so the UI can tell "installed but stopped" apart
                       from "not installed at all". */
                    const state = _scQueryState(SUPERVISOR_SERVICE_NAME);
                    _supervisorHttpAlive().then(alive => {
                        panel.webview.postMessage({
                            type: 'monitorState',
                            running: alive,                  /* drives the blue glow */
                            state,                           /* sc state for tooltips */
                            httpAlive: alive,
                        });
                    });
                    break;
                }
                case 'listDomains': {
                    /* NameSilo domain list. Reads the API key from config.ini,
                       hits /listDomains then /getDomainInfo per domain for
                       nameservers. Pure stdlib, no extra deps. */
                    listNameSiloDomains(context).then(payload => {
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
                case 'openWebLogin':
                    /* Triggered by the modal's "Open login" button. msg.provider
                       names a specific webBridge OR superGrok provider; we route
                       to the right login path. openWebLogin() (the command) handles
                       the "ambiguous" case by asking the user. */
                    {
                        const p = msg.provider && PROVIDERS[msg.provider];
                        if (p && p.webBridge) {
                            try {
                                const bridge = getBrowserBridge(msg.provider);
                                await bridge.ensureRunning();
                                await bridge.navigateHome();
                                panel.webview.postMessage({ type: 'info', text: `${p.label} window opened — sign in there.` });
                            } catch (e) {
                                traceErr('panel openWebLogin (web)', e);
                                panel.webview.postMessage({ type: 'error', message: 'web login: ' + (e.message || e) });
                            }
                        } else if (p && p.superGrok) {
                            try {
                                const bridge = getSuperGrokBridge(msg.provider);
                                const r = await bridge.openLoginWindow();
                                panel.webview.postMessage({ type: 'info', text: `${p.label} login window opened (pid ${r.pid}). Sign in to Google, then close that window.` });
                            } catch (e) {
                                traceErr('panel openWebLogin (supergrok)', e);
                                panel.webview.postMessage({ type: 'error', message: 'SuperGrok login: ' + (e.message || e) });
                            }
                        } else {
                            await openWebLogin(context);
                        }
                    }
                    break;
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
                       message handlers stay registered, terminal stays open. */
                    try {
                        const html = getPanelHtml(context, panel.webview);
                        panel.webview.html = html;
                        trace('panel refreshed via context menu');
                    } catch (e) {
                        traceErr('refreshPanel', e);
                    }
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

    const endUris = timeStep('  buildAssetUris');
    const assetsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets')));
    const labelUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png')));
    const blankUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank.png')));
    const blankOverUri  = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_over.png')));
    const blankClickUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_click.png')));
    const prismJsUri    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism.min.js')));
    const prismLangsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-langs.min.js')));
    const prismCssUri   = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-dark.min.css')));
    const soundsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'sounds')));
    const helpUri       = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'help.html')));
    const panelJsUri    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'panel', 'panel.js')));
    endUris();

    const endSubst = timeStep('  substituteTemplateTokens');
    html = html.split('{{ASSETS_BASE}}').join(assetsBase.toString());
    html = html.split('{{SOUNDS_BASE}}').join(soundsBase.toString());
    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    html = html.split('{{BLANK_URI}}').join(blankUri.toString());
    html = html.split('{{BLANK_OVER_URI}}').join(blankOverUri.toString());
    html = html.split('{{BLANK_CLICK_URI}}').join(blankClickUri.toString());
    html = html.split('{{PRISM_JS_URI}}').join(prismJsUri.toString());
    html = html.split('{{PRISM_LANGS_URI}}').join(prismLangsUri.toString());
    html = html.split('{{PRISM_CSS_URI}}').join(prismCssUri.toString());
    html = html.split('{{HELP_URI}}').join(helpUri.toString());
    html = html.split('{{PANEL_JS_URI}}').join(panelJsUri.toString());
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
const PROMPTS_FILE        = 'prompts.txt';      /* user-curated, separator: ^---$ */
const PROMPTS_SEPARATOR   = '---';
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

/* Curated prompts (prompts.txt). Multi-line entries separated by a "---"
   line. The user edits this file directly (storedPromptsBtn opens it
   in a normal VSCode editor tab). Empty file or no file → []. */
function promptsFilePath(context) {
    return path.join(context.extensionPath, PROMPTS_FILE);
}

function loadPrompts(context) {
    try {
        const p = promptsFilePath(context);
        if (!fs.existsSync(p)) return [];
        const raw = fs.readFileSync(p, 'utf8');
        /* Split on lines that are EXACTLY "---" (no leading/trailing whitespace,
           a simple format that's easy to type by hand). */
        const lines = raw.split(/\r?\n/);
        const out = [];
        let cur = [];
        for (const line of lines) {
            if (line.trim() === PROMPTS_SEPARATOR) {
                const piece = cur.join('\n').replace(/^\s+|\s+$/g, '');
                if (piece) out.push(piece);
                cur = [];
            } else {
                cur.push(line);
            }
        }
        const tail = cur.join('\n').replace(/^\s+|\s+$/g, '');
        if (tail) out.push(tail);
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
    const p = promptsFilePath(context);
    const cleaned = (Array.isArray(items) ? items : [])
        .map(s => String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''))
        .filter(s => s.length > 0);
    /* Body = entries joined by "\n---\n", trailing newline so the file is
       POSIX-friendly and `cat` doesn't dirty the next shell prompt. */
    const body = cleaned.length
        ? cleaned.join('\n' + PROMPTS_SEPARATOR + '\n') + '\n'
        : '';
    const tmp = p + '.tmp';
    try {
        fs.writeFileSync(tmp, body, 'utf8');
        /* fs.renameSync is atomic on the same filesystem (Win32 + POSIX). */
        fs.renameSync(tmp, p);
        return cleaned;
    } catch (e) {
        /* Best-effort cleanup of the orphaned tmp file. */
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { traceErr('savePrompts cleanup', e2); }
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
async function* streamOpenAIFormat(url, headers, body) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
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
            if (payload === '[DONE]') return;
            try {
                const j = JSON.parse(payload);
                const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                if (delta) yield delta;
            } catch (e) { /* ignore parse hiccups on partial chunks */ }
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

/* ── Web-bridge streaming ─────────────────────────────────────────────── */

function browserProfileDir(providerId) {
    /* Persistent per-provider browser profile under globalStorage so cookies
       (and therefore login state) survive across VS Code sessions. */
    const root = extensionContext.globalStorageUri.fsPath;
    return path.join(root, 'web-profiles', providerId);
}

function getBrowserBridge(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider || !provider.webBridge) throw new Error('not a web-bridge provider: ' + providerId);
    if (browserBridges[providerId]) return browserBridges[providerId];
    fs.mkdirSync(path.dirname(browserProfileDir(providerId)), { recursive: true });
    const bridge = new BrowserBridge({
        profileDir: browserProfileDir(providerId),
        startUrl: provider.url,
        target: provider.target,
        log: (m) => trace(`bridge[${providerId}] ${m}`),
    });
    browserBridges[providerId] = bridge;
    return bridge;
}

/* Web-bridge "streaming": send the latest user turn into the page, then poll
   the assistant DOM. We only push the latest turn — the live page already has
   the prior conversation in its own DOM history. */
async function* streamWebBridge(providerId, messages) {
    const bridge = getBrowserBridge(providerId);
    await bridge.ensureRunning();
    /* Only send the latest user message — the page's own thread has context. */
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) throw new Error('no user message to send');
    await bridge.sendPrompt(lastUser.content);
    yield* bridge.streamResponse();
}

/* SuperGrok-backed providers: send the latest turn via TCP to SuperGrok's
   resident service. SuperGrok handles the offscreen browser, DOM injection,
   and response capture. We yield the full answer as one chunk because the
   TCP protocol doesn't stream. */
function getSuperGrokBridge(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider || !provider.superGrok) throw new Error('not a supergrok provider: ' + providerId);
    if (superGrokBridges[providerId]) return superGrokBridges[providerId];
    const bridge = new SuperGrokBridge({
        superGrokRoot: provider.superGrokRoot,
        target: provider.target,
        log: (m) => trace(`supergrok[${providerId}] ${m}`),
    });
    superGrokBridges[providerId] = bridge;
    return bridge;
}

async function* streamSuperGrok(providerId, messages) {
    const bridge = getSuperGrokBridge(providerId);
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) throw new Error('no user message to send');
    yield* bridge.chatStream(lastUser.content);
}

/* Anthropic via SDK — wrap stream events as async generator. */
async function* streamAnthropic(apiKey, model, messages, maxTokens) {
    const client = getAnthropicClient(apiKey);
    const stream = await client.messages.stream({ model, max_tokens: maxTokens, messages });
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
}

/* Dispatch by provider id. Returns async iterator yielding text chunks. */
async function* chatStream(context, providerId, model, messages, maxTokens) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const provider = PROVIDERS[providerId];

    if (provider && provider.webBridge) {
        yield* streamWebBridge(providerId, messages);
        return;
    }

    if (provider && provider.superGrok) {
        yield* streamSuperGrok(providerId, messages);
        return;
    }

    const key = getProviderKey(context, providerId);
    if (!key) throw new Error(`No API key for ${providerId}. Run "Claude Codex Black: Set API Key" or add it to config.ini under [api_keys] (or [azure]).`);

    if (providerId === 'anthropic') {
        yield* streamAnthropic(key, model, messages, maxTokens);
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
    if (providerId === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        body.max_completion_tokens = maxTokens;
    } else if (providerId === 'grok') {
        url = 'https://api.x.ai/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        body.max_tokens = maxTokens;
    } else if (providerId === 'azure') {
        const endpoint = (cfg.azure && cfg.azure.endpoint || '').replace(/\/+$/, '');
        const apiVersion = (cfg.azure && cfg.azure.api_version) || '2024-12-01-preview';
        if (!endpoint) throw new Error('Azure endpoint missing in config.ini [azure] section.');
        if (!model) throw new Error('Azure deployment_name missing.');
        url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
        headers = { 'Content-Type': 'application/json', 'api-key': key };
        delete body.model; /* Azure uses deployment in URL */
        body.max_tokens = maxTokens;
    } else {
        throw new Error('Unknown provider: ' + providerId);
    }
    yield* streamOpenAIFormat(url, headers, body);
}

/* ── Chat dispatch ────────────────────────────────────────────────────── */

async function handleSendText(context, panel, text) {
    text = (text || '').trim();
    if (!text) return;

    const providerId = getActiveProvider(context);
    const model = getActiveModel(context, providerId);
    const maxTokens = getMaxTokens();

    /* If no key for this provider, prompt up-front and store it. Web-bridge
       and SuperGrok providers skip this — they authenticate via the browser
       session, not an API key. */
    const _pInfo = PROVIDERS[providerId] || {};
    if (!_pInfo.webBridge && !_pInfo.superGrok && !getProviderKey(context, providerId)) {
        const got = await promptForKey(context, providerId);
        if (!got) {
            panel.webview.postMessage({ type: 'error', message: `${providerId}: API key required to send.` });
            return;
        }
        panel.webview.postMessage({ type: 'info', text: `${PROVIDERS[providerId].label} key stored.` });
    }

    conversation.push({ role: 'user', content: text });

    setStatus('streaming', true, providerId);
    panel.webview.postMessage({ type: 'assistantStart' });
    trace(`stream start provider=${providerId} model=${model} maxTokens=${maxTokens} historyLen=${conversation.length}`);

    let assembled = '';
    const t0 = Date.now();
    try {
        for await (const delta of chatStream(context, providerId, model, conversation, maxTokens)) {
            assembled += delta;
            panel.webview.postMessage({ type: 'chunk', text: delta });
        }
        trace(`stream done provider=${providerId} chars=${assembled.length} ms=${Date.now() - t0}`);
        conversation.push({ role: 'assistant', content: assembled });
        panel.webview.postMessage({ type: 'assistantDone', text: assembled });
        setStatus('idle', false, providerId);
    } catch (e) {
        traceErr(`stream failed (provider=${providerId})`, e);
        panel.webview.postMessage({ type: 'error', message: `${providerId}: ${e.message || e}` });
        setStatus('error', false, providerId);
        if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') conversation.pop();
    }
}

module.exports = { activate, deactivate };
