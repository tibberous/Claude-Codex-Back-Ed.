/* Live audio-device picker for CBE. Runs entirely inside the extension process,
   so it works without the extension reactivating. Lists devices via ffmpeg dshow,
   shows VSCode QuickPick, persists choice to config.ini. */
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const FFMPEG     = 'ffmpeg';
const CBE_CONFIG = path.join(__dirname, '..', 'config.ini');

function listAudioDevices() {
    return new Promise((resolve) => {
        const proc = spawn(FFMPEG, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
        let buf = '';
        proc.stderr.on('data', d => buf += d.toString());
        proc.on('close', () => {
            const out = [];
            const lines = buf.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^\[dshow @ [^\]]+\] +"([^"]+)" +\(audio\)/);
                if (m) {
                    const entry = { name: m[1], altName: null };
                    const next  = lines[i + 1] || '';
                    const am    = next.match(/Alternative name +"([^"]+)"/);
                    if (am) entry.altName = am[1];
                    out.push(entry);
                }
            }
            resolve(out);
        });
        proc.on('error', () => resolve([]));
    });
}

function readIni() { try { return fs.readFileSync(CBE_CONFIG, 'utf8'); } catch (e) { return ''; } }

function getCurrent() {
    const m = readIni().match(/^\s*audio_device\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : 'Microphone (webcam AC310)';
}

function setCurrent(name) {
    let ini = readIni();
    if (/^\s*audio_device\s*=/m.test(ini)) {
        ini = ini.replace(/^(\s*audio_device\s*=\s*).+/m, '$1' + name);
    } else if (/^\[stt\]/m.test(ini)) {
        ini = ini.replace(/(\[stt\][^\[]*)/m, '$1audio_device = ' + name + '\n');
    } else {
        ini += '\n[stt]\naudio_device = ' + name + '\n';
    }
    fs.writeFileSync(CBE_CONFIG, ini, 'utf8');
}

module.exports = async function ({ vscode, cvLog, body }) {
    const devices = await listAudioDevices();
    cvLog('audio-pick: found ' + devices.length + ' devices');
    if (!devices.length) {
        vscode.window.showWarningMessage('Codex Black: ffmpeg found no audio capture devices.');
        return { ok: false, error: 'no devices' };
    }

    /* If body.set is provided, bypass the picker (programmatic mode). */
    if (body && body.set) {
        const target = String(body.set);
        if (!devices.some(d => d.name === target)) {
            return { ok: false, error: 'device not found: ' + target, available: devices.map(d => d.name) };
        }
        setCurrent(target);
        vscode.window.showInformationMessage('Codex Black mic → ' + target);
        return { ok: true, current: target };
    }

    /* Interactive QuickPick mode. */
    const current = getCurrent();
    const items = devices.map(d => ({
        label:       (d.name === current ? '$(check) ' : '$(mic) ') + d.name,
        description: d.altName ? d.altName.slice(0, 60) + (d.altName.length > 60 ? '…' : '') : '',
        deviceName:  d.name,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        title:       'Codex Black — Pick Microphone',
        placeHolder: 'Current: ' + current,
    });
    if (!pick) return { ok: true, cancelled: true, current };

    setCurrent(pick.deviceName);
    vscode.window.showInformationMessage('Codex Black mic → ' + pick.deviceName);
    cvLog('audio-pick: set to "' + pick.deviceName + '"');
    return { ok: true, current: pick.deviceName };
};
