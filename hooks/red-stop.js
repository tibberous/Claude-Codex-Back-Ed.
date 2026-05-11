// hooks/red-stop.js — SUPER STOP
// 1. Send Escape to abort any running generation
// 2. Kill the Claude process via its own stop mechanism
// 3. Disconnect by closing the panel
// 4. Open a fresh conversation
// Edit this file freely — no reload needed, takes effect on next click.

module.exports = async function redStop(ctx) {
    const { vscode, cvLog, delay } = ctx;

    cvLog('SUPER STOP fired');

    // Step 1: Escape — interrupt whatever is running
    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        await delay(150);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } catch (e) { cvLog('focus err: ' + e.message); }

    // Step 2: Send Escape key to the active element to stop generation
    try {
        await vscode.commands.executeCommand('type', { text: '\x1b' }); // ESC char
    } catch (e) { cvLog('esc err: ' + e.message); }

    await delay(300);

    // Step 3: Kill the Claude terminal process if one is running
    try {
        const claudeTerms = vscode.window.terminals.filter(t =>
            t.name.toLowerCase().includes('claude')
        );
        for (const t of claudeTerms) {
            cvLog('killing terminal: ' + t.name);
            t.dispose();
        }
    } catch (e) { cvLog('terminal kill err: ' + e.message); }

    await delay(200);

    // Step 4: Refocus Claude in the same panel — no new tab
    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        cvLog('new conversation opened');
    } catch (e) { cvLog('focus err: ' + e.message); }

    return { ok: true, message: 'super stop complete' };
};
