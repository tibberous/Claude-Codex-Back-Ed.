/* Hot-patch the running extension so clicking the icon focuses the Claude Code chat
   instead of starting STT — without waiting for extension reactivation.

   We can't replace the registered command handler (vscode.commands.registerCommand
   throws on duplicates and provides no public unregister). We CAN replace functions
   referenced by the existing handler closure if they live on a require()'d module.

   The startRecording function calls child_process.spawn(FFMPEG, ...). Node caches the
   child_process module exports; replacing spawn there is observed by all later callers
   in this process. We wrap spawn so when called with ffmpeg + dshow args we instead
   trigger claude-vscode.focus and return a no-op fake child.

   Idempotent via global.__cbIconHotpatch_v2. */
const child_process = require('child_process');
const { EventEmitter } = require('events');

module.exports = async function ({ vscode, cvLog }) {
    if (global.__cbIconHotpatch_v2) {
        cvLog('hotpatch-icon: already patched — no-op');
        return { ok: true, alreadyPatched: true };
    }

    const origSpawn = child_process.spawn;

    child_process.spawn = function (cmd, args, opts) {
        const cmdStr = String(cmd || '').toLowerCase();
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        const looksLikeFfmpegRec = cmdStr.includes('ffmpeg') && argStr.includes('dshow') && argStr.includes('audio=');

        if (looksLikeFfmpegRec) {
            cvLog('hotpatch-icon: intercepted ffmpeg spawn → focusing Claude Code chat');
            vscode.commands.executeCommand('claude-vscode.focus').catch(e => {
                cvLog('hotpatch-icon: focus error: ' + e.message);
            });
            /* Return a fake child so the caller's .on('error'), .on('close'), .stdin.write,
               .kill, etc. don't throw. We synthesise an immediate "close code 0" so any
               downstream stopAndTranscribe logic skips because WAV won't exist. */
            const fake = new EventEmitter();
            fake.pid    = -1;
            fake.stdin  = { write: () => {}, end: () => {} };
            fake.stdout = new EventEmitter();
            fake.stderr = new EventEmitter();
            fake.kill   = () => {};
            setImmediate(() => fake.emit('close', 0));
            return fake;
        }

        return origSpawn.apply(this, arguments);
    };

    global.__cbIconHotpatch_v2 = true;
    cvLog('hotpatch-icon: child_process.spawn wrapped — icon click now focuses chat (no recording)');
    return { ok: true, patched: 'child_process.spawn' };
};
