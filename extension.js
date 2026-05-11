const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let activePanel;

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codexBlackEd.openPanel', () => openPanel(context))
    );

    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer('codexBlackEd.panel', {
                async deserializeWebviewPanel(webviewPanel) {
                    bindPanel(context, webviewPanel);
                }
            })
        );
    }
}

function openPanel(context) {
    if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.Two, false);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'codexBlackEd.panel',
        'Claude Codex Black',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'panel')),
                vscode.Uri.file(path.join(context.extensionPath, 'assets'))
            ]
        }
    );

    bindPanel(context, panel);
}

function bindPanel(context, panel) {
    activePanel = panel;
    panel.webview.html = getPanelHtml(context, panel.webview);
    panel.onDidDispose(() => {
        if (activePanel === panel) activePanel = undefined;
    });
}

function getPanelHtml(context, webview) {
    const htmlPath = path.join(context.extensionPath, 'panel', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const labelUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'assets', 'label-alpha.png'))
    );

    html = html.split('{{LABEL_ALPHA_URI}}').join(labelUri.toString());
    return html;
}

function deactivate() {}

module.exports = { activate, deactivate };
