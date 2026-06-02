/* ─────────────────────────────────────────────────────────────────────────
   stt-host-stream-el.js — host-side STREAMING microphone capture for the
   ElevenLabs Scribe v2 Realtime WS path.

   Sibling to stt-host-capture.js (which does the legacy batch path: ffmpeg →
   temp WAV → POST /v1/speech-to-text). That batch path stays as the silent
   fallback when the WS errors / 401s.

   THIS module spawns ffmpeg with dshow input → raw PCM s16le 16kHz mono on
   STDOUT (no temp file). The caller forwards chunks straight into the open
   ElevenLabs WS session and we stop GRACEFULLY (stdin 'q' + wmic cmdline-
   match fallback) the same way as stt-host-capture.js. The chocolatey shim
   landmine documented in cbe_stt_stop_bug.md applies here too — we reuse
   the same FFMPEG_CANDIDATES + listDshowAudioDevices() from the batch
   module so there's exactly ONE source of truth for ffmpeg discovery.

   API:
     startStream({ onPcm, onStarted, onError })
       Opens ffmpeg → emits PCM s16le 16k mono chunks via onPcm(Buffer).
       onStarted({device}) fires once ffmpeg actually opened the device.
       onError(err) fires on any startup / runtime failure.
       Resolves with a { stop() } handle.
     isStreaming() → bool
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/* Reuse the batch module's ffmpeg discovery + device listing — DRY, and one
   memory of the chocolatey shim quirks. */
const _capture = require('./stt-host-capture.js');

let _active = null;   /* { proc, stopped, _onClose } */

function isStreaming() { return !!_active; }

/* Start streaming raw PCM s16le 16kHz mono from the default DirectShow mic.
   Resolves with { stop } once the mic is open (or the 4s safety timeout fires).
   onPcm(buf) is called for every stdout chunk; onError(err) for failures. */
function startStream({ onPcm, onStarted, onError } = {}) {
    return new Promise((resolve, reject) => {
        if (_active) { reject(new Error('a recording is already in progress')); return; }
        const exe = _capture.resolveFfmpeg();
        _capture.listDshowAudioDevices().then((devices) => {
            if (!devices.length) {
                reject(new Error('no microphone device found (ffmpeg -f dshow listed 0 audio devices)'));
                return;
            }
            const device = devices[0];
            /* -f s16le -ar 16000 -ac 1 pipe:1 → raw PCM mono 16k on stdout.
               -t 300 = 5min safety cap so a forgotten recording can't run forever
               (matches ElevenLabs Scribe v2 Realtime's session cap range). */
            const args = [
                '-hide_banner', '-loglevel', 'info', '-y',
                '-f', 'dshow', '-i', 'audio=' + device,
                '-ac', '1', '-ar', '16000',
                '-f', 's16le',
                '-t', '300',
                'pipe:1',
            ];
            let proc;
            try {
                proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                reject(new Error('failed to start ffmpeg streaming capture: ' + (e.message || e)));
                return;
            }
            let err = '';
            let opened = false;
            const onErrData = (d) => {
                err += d.toString();
                /* "Output #0" / "Stream mapping" once input is open + writing. */
                if (!opened && /Output #0|Stream mapping|Press \[q\]/i.test(err)) {
                    opened = true;
                    if (typeof onStarted === 'function') { try { onStarted({ device }); } catch (_) {} }
                    resolve({ stop });
                }
            };
            proc.stderr.on('data', onErrData);
            proc.stdout.on('data', (buf) => {
                if (buf && buf.length && typeof onPcm === 'function') {
                    try { onPcm(buf); } catch (_) {}
                }
            });
            proc.on('error', (e) => {
                if (!opened) reject(new Error('ffmpeg not found — STT needs ffmpeg on PATH (' + (e.message || e) + ')'));
                if (typeof onError === 'function') { try { onError(e); } catch (_) {} }
                if (_active && _active.proc === proc) _active = null;
            });
            proc.on('close', (code) => {
                if (!opened) {
                    reject(new Error('ffmpeg could not open the microphone (exit ' + code + '): ' + err.slice(-300).trim()));
                }
                if (_active && _active.proc === proc) {
                    if (_active._onClose) _active._onClose({ code, err });
                    _active = null;
                }
            });
            _active = { proc, stopped: false, _onClose: null };
            /* Safety: if the device opens but ffmpeg never emits the signal
               within 4s (very old build / odd locale), resolve anyway — chunks
               are already flowing through stdout. */
            setTimeout(() => {
                if (!opened && _active && _active.proc === proc) {
                    opened = true;
                    if (typeof onStarted === 'function') { try { onStarted({ device }); } catch (_) {} }
                    resolve({ stop });
                }
            }, 4000);

            /* Graceful stop — stdin 'q' (clean shutdown) + 2s fallback that
               kills by PID AND by cmdline-match (wmic) so a chocolatey-shim
               orphan recording on this stdout is also reaped. Same pattern
               as stt-host-capture.js. */
            function stop() {
                const a = _active;
                if (!a || a.stopped) return;
                a.stopped = true;
                try { a.proc.stdin.write('q\n'); } catch (_) {}
                try { a.proc.stdin.end(); } catch (_) {}
                setTimeout(() => {
                    if (!_active) return;
                    try { a.proc.kill(); } catch (_) {}
                    try {
                        /* Cmdline match on pipe:1 + 16000 args so we don't
                           accidentally reap the batch-path ffmpeg that uses a
                           cbe_stt_*.wav name. */
                        execFile('wmic', ['process', 'where',
                            "name='ffmpeg.exe' and CommandLine like '%s16le%' and CommandLine like '%pipe:1%'",
                            'call', 'terminate'], { windowsHide: true }, () => {});
                    } catch (_) {}
                }, 2000);
            }
        }).catch(reject);
    });
}

module.exports = { startStream, isStreaming };
