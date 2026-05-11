/* Dynamically registers codexBlackEd.openPanel as an alias for startRecording.
   VSCode caches menu contributions across extension-host restarts. If a prior package.json
   bound the editor/title icon to openPanel and the new one binds it to startRecording, the
   running window may still hold the stale openPanel binding. This hook lets us bind a live
   handler without a full window reload. Re-registration is idempotent. */
module.exports = async function ({ vscode, cvLog, startRecording, stopRecording, recState }) {
    const CMD = 'codexBlackEd.openPanel';
    /* If a handler already exists, return without re-registering (registerCommand throws on dup). */
    const all = await vscode.commands.getCommands(true);
    if (all.includes(CMD)) {
        cvLog('register-alias: ' + CMD + ' already registered — no-op');
        return { ok: true, alreadyRegistered: true };
    }
    vscode.commands.registerCommand(CMD, () => {
        const s = recState();
        cvLog('openPanel (live alias) → toggle recState=' + s);
        if (s === 'idle') startRecording();
        else if (s === 'recording') stopRecording();
    });
    cvLog('register-alias: registered ' + CMD + ' → startRecording toggle');
    return { ok: true, registered: CMD };
};
