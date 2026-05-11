const { execFile } = require('child_process');

function ffmpegRunning(cb) {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH', '/FO', 'CSV'], (err, stdout) => {
        cb(!err && stdout.toLowerCase().includes('ffmpeg.exe'));
    });
}

module.exports = async function speechToggle({ cvLog, startRecording, stopRecording, recState }) {
    const state = recState();
    cvLog('speech-toggle hook: recState=' + state);

    const running = await new Promise(resolve => ffmpegRunning(resolve));
    cvLog('speech-toggle hook: ffmpeg running=' + running);

    if (!running) {
        // recState may be stale — ffmpeg is gone, treat as idle and start
        cvLog('speech-toggle: starting recording');
        startRecording();
        return { ok: true, action: 'start', status: 'recording' };
    } else {
        cvLog('speech-toggle: killing ffmpeg');
        await new Promise(resolve => {
            execFile('taskkill', ['/IM', 'ffmpeg.exe', '/T', '/F'], (err) => {
                cvLog('taskkill: ' + (err ? err.message : 'ok'));
                resolve();
            });
        });
        stopRecording();
        return { ok: true, action: 'stop', status: 'stopping' };
    }
};
