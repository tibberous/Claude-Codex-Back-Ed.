const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { BrowserBridge } = require('./bridge/browser-bridge');
const { SuperGrokBridge } = require('./bridge/supergrok-bridge');

const SECRET_KEY_PREFIX = 'codexBlackEd.';   /* per-provider secret = `${PREFIX}${id}.apiKey` */
const STATE_PROVIDER = 'codexBlackEd.activeProvider';
const STATE_MODEL    = 'codexBlackEd.activeModel';
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

/* ── config.ini reader (full multi-section) ──────────────────────────────
   Returns an object keyed by section name, each value is a flat key→string
   map. Looks at <extensionPath>/config.ini then ~/.cbe/config.ini. */
function readConfigIni(extensionPath) {
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
            trace('config.ini parsed from ' + p + ' sections=' + Object.keys(out).join(','));
            return { _path: p, ...out };
        } catch (e) {
            traceErr('reading ' + p, e);
        }
    }
    return null;
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
    for (const id of Object.keys(PROVIDERS)) {
        try {
            const v = await context.secrets.get(SECRET_KEY_PREFIX + id + '.apiKey');
            secretsCache[id] = v || null;
        } catch (e) { secretsCache[id] = null; }
    }
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
let statusBar;
let anthropicClient;
const browserBridges = {};   /* providerId -> BrowserBridge (lazy, persists across sends) */
const superGrokBridges = {}; /* providerId -> SuperGrokBridge (TCP shim over SuperGrok's service) */
let extensionContext = null; /* captured during activate so commands can resolve globalStorageUri */

/* ── Tracing ──────────────────────────────────────────────────────────── */

function trace(msg) {
    const ts = new Date().toISOString();
    try { outChan && outChan.appendLine(`[${ts}] ${msg}`); } catch (e) {}
    try { console.log('[codex-black]', msg); } catch (e) {}
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
    trace('=== activate ===');
    await refreshSecretsCache(context);
    trace('  secretsCache populated: ' + Object.keys(secretsCache).filter(k => secretsCache[k]).join(',') || '(none)');
    trace('  activeProvider=' + getActiveProvider(context) + ' model=' + getActiveModel(context, getActiveProvider(context)));

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBar.command = 'codexBlackEd.openPanel';
    setStatus('idle', false, getActiveProvider(context));
    context.subscriptions.push(statusBar);

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
        outChan,
    );

    /* Serializer intentionally disposes any restored panel instead of rebinding it
       so closing the tab keeps it closed across window reloads. The old behavior
       (`bindPanel(context, webviewPanel)`) made the panel auto-resurrect on every
       reload — see handbook §0822 "VSCode Extension Writing > WebviewPanelSerializer
       makes panels resurrect themselves" for the rationale. */
    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', {
                async deserializeWebviewPanel(webviewPanel) {
                    try { webviewPanel.dispose(); } catch (e) { traceErr('deserialize-dispose', e); }
                }
            })
        );
    }
    /* On activate, also close any stale instances of this panel type that
       VSCode tried to restore before the dispose-on-deserialize hook fired.
       This is the "delete the old panels" guarantee. */
    try {
        for (const grp of (vscode.window.tabGroups && vscode.window.tabGroups.all) || []) {
            for (const tab of (grp.tabs || [])) {
                const vt = tab.input && tab.input.viewType;
                if (typeof vt === 'string' && vt.endsWith('codexBlackEd.panel')) {
                    try { vscode.window.tabGroups.close(tab, true); }
                    catch (e) { traceErr('close-stale-panel', e); }
                }
            }
        }
    } catch (e) { traceErr('stale-panel-sweep', e); }

    trace('activate complete');
}

function deactivate() {
    trace('=== deactivate ===');
    disposeAllBridges();
}

function disposeAllBridges() {
    for (const id of Object.keys(browserBridges)) {
        try { browserBridges[id].dispose(); } catch (e) {}
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

function buildSettingsPayload(context) {
    const cfg = readConfigIni(context.extensionPath) || {};
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
    return {
        providers,
        active,
        sfxEnabled: (typeof sfxEnabled === 'boolean') ? sfxEnabled : true,
        sfxVolume:  (typeof sfxVolume  === 'number')  ? sfxVolume  : 0.55,
    };
}

/* ── Panel lifecycle ──────────────────────────────────────────────────── */

function openPanel(context) {
    trace('openPanel');
    if (activePanel) { activePanel.reveal(undefined, false); return; }
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            /* viewType is prefixed by VS Code internals (e.g. mainThreadWebview-); use endsWith
               so we survive prefix changes between VS Code versions. */
            if (tab.input instanceof vscode.TabInputWebview &&
                typeof tab.input.viewType === 'string' &&
                tab.input.viewType.endsWith('codexBlackEd.panel')) {
                vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                return;
            }
        }
    }
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
                vscode.Uri.file(path.join(context.extensionPath, 'sounds'))
            ]
        }
    );
    bindPanel(context, panel);
}

function bindPanel(context, panel) {
    activePanel = panel;
    panel.webview.html = getPanelHtml(context, panel.webview);

    panel.webview.onDidReceiveMessage(async (msg) => {
        trace('recv ' + JSON.stringify({ type: msg && msg.type }));
        if (!msg || !msg.type) return;
        try {
            switch (msg.type) {
                case 'ready':
                    panel.webview.postMessage({ type: 'init', ...buildSettingsPayload(context) });
                    break;
                case 'sendText':
                    await handleSendText(context, panel, msg.text || '');
                    break;
                case 'reset':
                    conversation = [];
                    panel.webview.postMessage({ type: 'info', text: 'Conversation reset.' });
                    break;
                case 'openSettings':
                    panel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
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
                    conversation = [];
                    trace(`active provider set: ${msg.provider} / ${msg.model || '(default)'} sfx=${msg.sfxEnabled}/${msg.sfxVolume}`);
                    setStatus('idle', false, msg.provider);
                    panel.webview.postMessage({ type: 'info', text: `Provider → ${PROVIDERS[msg.provider].label} · ${msg.model || getActiveModel(context, msg.provider)}` });
                    break;
                case 'labelClick':
                    panel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
                    break;
                case 'showTrace':
                    outChan.show(true);
                    break;
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
    });
}

function getPanelHtml(context, webview) {
    const htmlPath = path.join(context.extensionPath, 'panel', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const assetsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets')));
    const labelUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png')));
    const blankUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank.png')));
    const blankOverUri  = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_over.png')));
    const blankClickUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'blank_click.png')));
    const prismJsUri    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism.min.js')));
    const prismLangsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-langs.min.js')));
    const prismCssUri   = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-dark.min.css')));
    const soundsBase    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'sounds')));
    html = html.split('{{ASSETS_BASE}}').join(assetsBase.toString());
    html = html.split('{{SOUNDS_BASE}}').join(soundsBase.toString());
    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    html = html.split('{{BLANK_URI}}').join(blankUri.toString());
    html = html.split('{{BLANK_OVER_URI}}').join(blankOverUri.toString());
    html = html.split('{{BLANK_CLICK_URI}}').join(blankClickUri.toString());
    html = html.split('{{PRISM_JS_URI}}').join(prismJsUri.toString());
    html = html.split('{{PRISM_LANGS_URI}}').join(prismLangsUri.toString());
    html = html.split('{{PRISM_CSS_URI}}').join(prismCssUri.toString());
    return html;
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
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
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
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
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
