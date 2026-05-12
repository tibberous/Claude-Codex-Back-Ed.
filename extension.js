const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SECRET_KEY = 'codexBlackEd.anthropicApiKey';
const STATE_PROVIDER = 'codexBlackEd.activeProvider';
const STATE_MODEL    = 'codexBlackEd.activeModel';
const CONFIG_INI_NAME = 'config.ini';

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
    const cfg = readConfigIni(context.extensionPath);
    const provider = PROVIDERS[providerId];
    if (!provider) return null;
    if (provider.azureSection) {
        return cfg && cfg.azure && (cfg.azure.api_key || cfg.azure.api_key1);
    }
    const fromIni = cfg && cfg.api_keys && cfg.api_keys[provider.keyField];
    if (fromIni) return fromIni;
    /* env fallback per provider */
    const envName = ({
        anthropic: 'ANTHROPIC_API_KEY',
        openai:    'OPENAI_API_KEY',
        grok:      'XAI_API_KEY',
        gemini:    'GEMINI_API_KEY',
    })[providerId];
    return envName ? (process.env[envName] || null) : null;
}

let activePanel;
let conversation = [];
let outChan;
let statusBar;
let anthropicClient;

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

function activate(context) {
    outChan = vscode.window.createOutputChannel('Claude Codex Black');
    trace('=== activate ===');
    trace('  activeProvider=' + getActiveProvider(context) + ' model=' + getActiveModel(context, getActiveProvider(context)));

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBar.command = 'codexBlackEd.openPanel';
    setStatus('idle', false, getActiveProvider(context));
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('codexBlackEd.openPanel', () => openPanel(context)),
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
        outChan,
    );

    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', {
                async deserializeWebviewPanel(webviewPanel) { bindPanel(context, webviewPanel); }
            })
        );
    }

    trace('activate complete');
}

function deactivate() { trace('=== deactivate ==='); }

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
        return { id, label: p.label, models, current: currentModel, haveKey };
    });
    return { providers, active };
}

/* ── Panel lifecycle ──────────────────────────────────────────────────── */

function openPanel(context) {
    trace('openPanel');
    if (activePanel) { activePanel.reveal(undefined, false); return; }
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview &&
                tab.input.viewType === 'mainThreadWebview-codexBlackEd.panel') {
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
                vscode.Uri.file(path.join(context.extensionPath, 'lib'))
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
                    conversation = [];
                    trace(`active provider set: ${msg.provider} / ${msg.model || '(default)'}`);
                    setStatus('idle', false, msg.provider);
                    panel.webview.postMessage({ type: 'info', text: `Provider → ${PROVIDERS[msg.provider].label} · ${msg.model || getActiveModel(context, msg.provider)}` });
                    break;
                case 'labelClick':
                    panel.webview.postMessage({ type: 'openSettings', ...buildSettingsPayload(context) });
                    break;
                case 'start': case 'stop':
                    panel.webview.postMessage({ type: 'error', message: 'Voice input not yet wired in standalone build' });
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
    const labelUri      = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png')));
    const prismJsUri    = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism.min.js')));
    const prismLangsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-langs.min.js')));
    const prismCssUri   = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-dark.min.css')));
    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    html = html.split('{{PRISM_JS_URI}}').join(prismJsUri.toString());
    html = html.split('{{PRISM_LANGS_URI}}').join(prismLangsUri.toString());
    html = html.split('{{PRISM_CSS_URI}}').join(prismCssUri.toString());
    return html;
}

/* ── API key utility / Anthropic SDK client ───────────────────────────── */

async function setApiKey(context) {
    const entered = await vscode.window.showInputBox({
        title: 'Set Anthropic API Key',
        prompt: 'Replace stored Anthropic key. Other providers read from config.ini.',
        password: true, ignoreFocusOut: true,
    });
    if (!entered) return;
    await context.secrets.store(SECRET_KEY, entered.trim());
    vscode.window.showInformationMessage('CBE: Anthropic API key saved.');
}

async function clearApiKey(context) {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('CBE: Anthropic API key cleared.');
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
async function* streamGemini(apiKey, model, messages) {
    /* Convert {role:'user'|'assistant', content} → Gemini's contents[]. */
    const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
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

/* Anthropic via SDK — wrap stream events as async generator. */
async function* streamAnthropic(apiKey, model, messages) {
    const client = getAnthropicClient(apiKey);
    const stream = await client.messages.stream({ model, max_tokens: 4096, messages });
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
async function* chatStream(context, providerId, model, messages) {
    const cfg = readConfigIni(context.extensionPath) || {};
    const key = getProviderKey(context, providerId);
    if (!key) throw new Error(`No API key for ${providerId}. Add it to config.ini under [api_keys] (or [azure]).`);

    if (providerId === 'anthropic') {
        yield* streamAnthropic(key, model, messages);
        return;
    }
    if (providerId === 'gemini') {
        yield* streamGemini(key, model, messages);
        return;
    }
    /* OpenAI-compatible: OAI, Grok, Azure */
    let url, headers;
    const body = { model, messages, stream: true, max_tokens: 4096 };
    if (providerId === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    } else if (providerId === 'grok') {
        url = 'https://api.x.ai/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    } else if (providerId === 'azure') {
        const endpoint = (cfg.azure && cfg.azure.endpoint || '').replace(/\/+$/, '');
        const apiVersion = (cfg.azure && cfg.azure.api_version) || '2024-12-01-preview';
        if (!endpoint) throw new Error('Azure endpoint missing in config.ini [azure] section.');
        if (!model) throw new Error('Azure deployment_name missing.');
        url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
        headers = { 'Content-Type': 'application/json', 'api-key': key };
        delete body.model; /* Azure uses deployment in URL */
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
    conversation.push({ role: 'user', content: text });

    setStatus('streaming', true, providerId);
    panel.webview.postMessage({ type: 'assistantStart' });
    trace(`stream start provider=${providerId} model=${model} historyLen=${conversation.length}`);

    let assembled = '';
    const t0 = Date.now();
    try {
        for await (const delta of chatStream(context, providerId, model, conversation)) {
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
