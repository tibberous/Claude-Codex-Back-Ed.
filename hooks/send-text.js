const { exec } = require('child_process');

const MAX_RETRIES = 3;
const RETRY_DELAY = 8000;

function mouseKey(key) {
    return new Promise((resolve, reject) => {
        exec(
            `python C:/Users/moren/claude-tools/mouse.py key ${key}`,
            { timeout: 5000 },
            (err) => err ? reject(err) : resolve()
        );
    });
}

module.exports = async function({ vscode, cvLog, delay, body }) {
    const text = (body && body.text || '').trim();
    if (!text) return { ok: false, error: 'no text' };

    cvLog('send-text: ' + JSON.stringify(text.slice(0, 80)));

    const prev = await vscode.env.clipboard.readText();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        cvLog('send-text attempt ' + attempt + '/' + MAX_RETRIES);
        try {
            // Paste into whatever editor/input is currently focused
            await vscode.env.clipboard.writeText(text);
            await delay(80);
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            await delay(180);

            await mouseKey('enter');
            await delay(150);

            cvLog('send-text attempt ' + attempt + ' sent');
            setTimeout(() => vscode.env.clipboard.writeText(prev), 500);
            return { ok: true, attempt };
        } catch (e) {
            cvLog('send-text attempt ' + attempt + ' error: ' + e.message);
        }

        if (attempt < MAX_RETRIES) {
            cvLog('send-text waiting ' + (RETRY_DELAY / 1000) + 's before retry...');
            await delay(RETRY_DELAY);
        }
    }

    setTimeout(() => vscode.env.clipboard.writeText(prev), 300);
    cvLog('send-text: all retries exhausted');
    return { ok: false, error: 'all ' + MAX_RETRIES + ' attempts failed' };
};
