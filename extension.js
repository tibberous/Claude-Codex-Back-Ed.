const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SECRET_KEY = 'codexBlackEd.anthropicApiKey';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const CONFIG_INI_NAME = 'config.ini';

/* ── config.ini reader ────────────────────────────────────────────────────
   Minimal INI parser. Looks up [api_keys] anthropic_api_key in either the
   installed extension folder (__dirname) or the user-level fallback. */
function readConfigIni(extensionPath) {
    const candidates = [
        path.join(extensionPath, CONFIG_INI_NAME),
        path.join(require('os').homedir(), '.cbe', CONFIG_INI_NAME),
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
            const src = fs.readFileSync(p, 'utf8');
            /* Find [api_keys] section, then anthropic_api_key inside it. */
            const sec = src.split(/^\[api_keys\][\r\n]+/m)[1];
            if (!sec) { trace('config.ini found at ' + p + ' but no [api_keys] section'); continue; }
            const body = sec.split(/^\[/m)[0];
            const m = body.match(/^\s*anthropic_api_key\s*=\s*([^\r\n]+)/m);
            if (m && m[1].trim()) {
                trace('config.ini: anthropic_api_key found at ' + p + ' (len=' + m[1].trim().length + ')');
                return m[1].trim();
            }
            trace('config.ini at ' + p + ' has no anthropic_api_key');
        } catch (e) {
            traceErr('reading ' + p, e);
        }
    }
    return null;
}

let activePanel;
let conversation = [];  /* per-session in-memory history */
let outChan;
let anthropicClient;
let statusBar;

/* ── Tracing ──────────────────────────────────────────────────────────── */

function trace(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    try { outChan && outChan.appendLine(line); } catch (e) {}
    try { console.log('[codex-black]', msg); } catch (e) {}
}

function traceErr(msg, err) {
    const stack = err && err.stack ? '\n' + err.stack : '';
    trace('ERROR: ' + msg + (err ? ' :: ' + (err.message || err) : '') + stack);
}

function setStatus(text, busy) {
    if (!statusBar) return;
    statusBar.text = (busy ? '$(sync~spin) ' : '$(circle-large-outline) ') + 'CBE: ' + text;
    statusBar.show();
}

/* ── Activation ───────────────────────────────────────────────────────── */

function activate(context) {
    outChan = vscode.window.createOutputChannel('Claude Codex Black');
    trace('=== activate ===');

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBar.command = 'codexBlackEd.openPanel';
    setStatus('idle', false);
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('codexBlackEd.openPanel', () => openPanel(context)),
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

function deactivate() {
    trace('=== deactivate ===');
}

/* ── Panel lifecycle ──────────────────────────────────────────────────── */

function openPanel(context) {
    trace('openPanel');
    if (activePanel) {
        activePanel.reveal(undefined, false);
        trace('  revealed existing');
        return;
    }
    /* Tab scan — find an existing CBE webview tab even if our local ref was lost. */
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview &&
                tab.input.viewType === 'mainThreadWebview-codexBlackEd.panel') {
                trace('  found existing tab — focusing');
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
    trace('  created new panel');
    bindPanel(context, panel);
}

function bindPanel(context, panel) {
    activePanel = panel;
    panel.webview.html = getPanelHtml(context, panel.webview);

    panel.webview.onDidReceiveMessage(async (msg) => {
        trace('recv ' + JSON.stringify({ type: msg && msg.type, len: msg && msg.text && msg.text.length }));
        if (!msg || !msg.type) return;
        try {
            switch (msg.type) {
                case 'sendText':
                    await handleSendText(context, panel, msg.text || '');
                    break;
                case 'reset':
                    conversation = [];
                    panel.webview.postMessage({ type: 'info', text: 'Conversation reset.' });
                    trace('  conversation reset');
                    break;
                case 'labelClick':
                    trace('  labelClick (no-op for now)');
                    break;
                case 'start': case 'stop':
                    /* Voice STT not wired in this build — log and reply with error so UI doesn't hang. */
                    panel.webview.postMessage({ type: 'error', message: 'Voice input not yet wired in standalone build' });
                    break;
                case 'openDevTools':
                    trace('  openDevTools requested');
                    try {
                        await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
                        trace('  openDevTools dispatched');
                    } catch (e) {
                        traceErr('openDevTools failed', e);
                        panel.webview.postMessage({ type: 'error', message: 'Failed to open DevTools: ' + (e.message || String(e)) });
                    }
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
    const labelUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png'))
    );
    const prismJsUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism.min.js'))
    );
    const prismLangsUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-langs.min.js'))
    );
    const prismCssUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'lib', 'prism-dark.min.css'))
    );
    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    html = html.split('{{PRISM_JS_URI}}').join(prismJsUri.toString());
    html = html.split('{{PRISM_LANGS_URI}}').join(prismLangsUri.toString());
    html = html.split('{{PRISM_CSS_URI}}').join(prismCssUri.toString());
    return html;
}

/* ── API key flow ─────────────────────────────────────────────────────── */

async function getApiKey(context) {
    /* Priority: config.ini → ANTHROPIC_API_KEY env → SecretStorage → first-run prompt. */
    const fromIni = readConfigIni(context.extensionPath);
    if (fromIni) {
        trace('apiKey: using config.ini (len=' + fromIni.length + ')');
        return fromIni;
    }
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey && envKey.trim()) {
        trace('apiKey: using ANTHROPIC_API_KEY env var (len=' + envKey.length + ')');
        return envKey.trim();
    }
    const stored = await context.secrets.get(SECRET_KEY);
    if (stored && stored.trim()) {
        trace('apiKey: using SecretStorage (len=' + stored.length + ')');
        return stored.trim();
    }
    trace('apiKey: not found in config.ini / env / SecretStorage, prompting');
    const entered = await vscode.window.showInputBox({
        title: 'Anthropic API Key',
        prompt: 'Paste your Anthropic API key (sk-ant-...). Stored encrypted in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (v && v.startsWith('sk-ant-')) ? null : 'Key should start with sk-ant-',
    });
    if (!entered) { trace('apiKey: user cancelled prompt'); return null; }
    await context.secrets.store(SECRET_KEY, entered.trim());
    trace('apiKey: saved to SecretStorage (len=' + entered.length + ')');
    return entered.trim();
}

async function setApiKey(context) {
    const entered = await vscode.window.showInputBox({
        title: 'Set Anthropic API Key',
        prompt: 'Replace stored key. Leave blank to cancel.',
        password: true,
        ignoreFocusOut: true,
    });
    if (!entered) return;
    await context.secrets.store(SECRET_KEY, entered.trim());
    trace('apiKey: replaced via setApiKey command');
    vscode.window.showInformationMessage('CBE: API key saved.');
}

async function clearApiKey(context) {
    await context.secrets.delete(SECRET_KEY);
    trace('apiKey: cleared from SecretStorage');
    vscode.window.showInformationMessage('CBE: API key cleared.');
}

/* ── Anthropic client (lazy) ──────────────────────────────────────────── */

function getClient(apiKey) {
    if (anthropicClient && anthropicClient._cbApiKey === apiKey) return anthropicClient;
    /* require lazily — module may have side effects we don't want during activation */
    let Anthropic;
    try {
        Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk').Anthropic || require('@anthropic-ai/sdk');
    } catch (e) {
        traceErr('@anthropic-ai/sdk require failed', e);
        throw new Error('Anthropic SDK not installed. Run `npm install @anthropic-ai/sdk` in the extension folder.');
    }
    anthropicClient = new Anthropic({ apiKey });
    anthropicClient._cbApiKey = apiKey;
    trace('Anthropic client created');
    return anthropicClient;
}

/* ── Chat dispatch ────────────────────────────────────────────────────── */

async function handleSendText(context, panel, text) {
    text = (text || '').trim();
    if (!text) { trace('sendText: empty, ignored'); return; }

    const apiKey = await getApiKey(context);
    if (!apiKey) {
        panel.webview.postMessage({ type: 'error', message: 'No API key. Run "CBE: Set API Key".' });
        return;
    }

    let client;
    try { client = getClient(apiKey); }
    catch (e) {
        panel.webview.postMessage({ type: 'error', message: e.message });
        return;
    }

    conversation.push({ role: 'user', content: text });
    const model = vscode.workspace.getConfiguration().get('codexBlackEd.model') || DEFAULT_MODEL;
    const maxTokens = vscode.workspace.getConfiguration().get('codexBlackEd.maxTokens') || 4096;

    setStatus('streaming', true);
    panel.webview.postMessage({ type: 'assistantStart' });
    trace(`stream start model=${model} maxTokens=${maxTokens} historyLen=${conversation.length}`);

    let assembled = '';
    const t0 = Date.now();
    try {
        const stream = await client.messages.stream({
            model,
            max_tokens: maxTokens,
            messages: conversation,
        });

        stream.on('text', (delta) => {
            assembled += delta;
            panel.webview.postMessage({ type: 'chunk', text: delta });
        });

        const final = await stream.finalMessage();
        const usage = final && final.usage;
        trace(`stream done in=${usage && usage.input_tokens} out=${usage && usage.output_tokens} ms=${Date.now() - t0}`);
        conversation.push({ role: 'assistant', content: assembled });
        panel.webview.postMessage({ type: 'assistantDone', text: assembled });
        setStatus('idle', false);
    } catch (e) {
        traceErr('stream failed', e);
        panel.webview.postMessage({ type: 'error', message: e.message || String(e) });
        setStatus('error', false);
        /* Pop the failed user turn so retry doesn't dupe it. */
        if (conversation[conversation.length - 1] && conversation[conversation.length - 1].role === 'user') {
            conversation.pop();
        }
    }
}

module.exports = { activate, deactivate };
