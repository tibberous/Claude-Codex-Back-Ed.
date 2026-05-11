const { execFile } = require('child_process');

module.exports = async function speechStop({ cvLog, stopRecording }) {
    cvLog('speech-stop hook: taskkilling ffmpeg');
    await new Promise(resolve => {
        execFile('taskkill', ['/IM', 'ffmpeg.exe', '/T', '/F'], (err, stdout, stderr) => {
            cvLog('taskkill result: err=' + (err ? err.message : 'null') + ' stdout=' + stdout + ' stderr=' + stderr);
            resolve();
        });
    });
    stopRecording();
    return { ok: true };
};
