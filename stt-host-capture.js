/* ─────────────────────────────────────────────────────────────────────────
   stt-host-capture.js — host-side microphone capture for CBE Speech-to-Text.

   WHY THIS EXISTS:
   VSCode webviews run in a sandboxed Electron iframe whose webContents
   permission handler DENIES `navigator.mediaDevices.getUserMedia()` by
   default, independent of the OS-level mic grant to Code.exe. There is no
   public VSCode extension API to grant getUserMedia to a webview (long-
   standing microsoft/vscode limitation). So the panel-side MediaRecorder
   path always throws NotAllowedError and the user sees "microphone access
   denied" even when Windows Privacy → Microphone allows VS Code.

   THE FIX: capture the mic HERE, in the Node extension host — a normal Node
   process with full OS mic access, no webview sandbox. We shell out to
   ffmpeg's DirectShow (dshow) input on Windows, record to a temp WAV, and
   hand the bytes back to the caller (extension.js) which transcribes them
   via the EXISTING ElevenLabs Scribe path.

   ── chocolatey ffmpeg shim landmine (memory: cbe_stt_stop_bug.md) ──────────
   `C:\ProgramData\chocolatey\bin\ffmpeg.exe` is a ~392KB SHIM that spawns the
   real ffmpeg as a child then exits. So our child PID points at a dead shim
   and `taskkill /PID <shim>` says "process not found" while the real ffmpeg
   keeps recording until its -t timeout, orphaned. We avoid that two ways:
     1. Prefer the REAL ffmpeg binary directly (skip the shim) when we can
        find it (chocolatey\lib\...\bin\ffmpeg.exe).
     2. Stop GRACEFULLY by writing `q\n` to ffmpeg stdin (flushes a valid WAV),
        never SIGKILL. A short fallback hard-stop matches by cmdline (the temp
        WAV name) via wmic so a shim-orphan is still reaped.
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

/* Candidate ffmpeg locations, in preference order. We try the REAL chocolatey
   binary first (skips the orphan-prone shim), then PATH, then a couple of
   common bundled spots from the user's other projects (flop_client / PyEncoder
   ship ffmpeg). The first one that exists wins; if none exist we fall back to
   the bare name 'ffmpeg' and let spawn surface ENOENT, which we translate into
   a SPECIFIC "ffmpeg not found" error rather than a generic mic-denied banner. */
const FFMPEG_CANDIDATES = [
    'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\lib\\ffmpeg-full\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
];

let _cachedFfmpeg = null;
/* Resolve an ffmpeg executable path. Returns an absolute path if a known one
   exists, else the bare 'ffmpeg' (resolved via PATH by spawn). */
function resolveFfmpeg() {
    if (_cachedFfmpeg) return _cachedFfmpeg;
    for (const c of FFMPEG_CANDIDATES) {
        try { if (fs.existsSync(c)) { _cachedFfmpeg = c; return c; } } catch (_) {}
    }
    _cachedFfmpeg = 'ffmpeg';   /* let PATH resolve it; spawn ENOENT → specific error */
    return _cachedFfmpeg;
}

/* Register an explicit ffmpeg path (e.g. one auto-downloaded by extension.js
   ensureFfmpeg() into globalStorage) so resolveFfmpeg() returns it instead of
   falling back to bare 'ffmpeg'. */
function setFfmpegPath(p) {
    if (p && typeof p === 'string') _cachedFfmpeg = p;
}

/* Enumerate DirectShow audio capture devices. ffmpeg prints them to STDERR
   (not stdout) as lines like:  "Microphone (EMEET OfficeCore M0 Plus)" (audio)
   Resolves to an array of device-name strings (may be empty). Rejects only on
   spawn failure (ffmpeg missing). */
function listDshowAudioDevices() {
    return new Promise((resolve, reject) => {
        const exe = resolveFfmpeg();
        let proc;
        try {
            proc = spawn(exe, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
                { windowsHide: true });
        } catch (e) {
            reject(new Error('ffmpeg not found — STT needs ffmpeg on PATH (' + (e.message || e) + ')'));
            return;
        }
        let err = '';
        proc.stderr.on('data', (d) => { err += d.toString(); });
        proc.on('error', (e) => reject(new Error('ffmpeg not found — STT needs ffmpeg on PATH (' + (e.message || e) + ')')));
        /* `-list_devices` always exits non-zero (it never finds a real input
           called "dummy"), so we parse the stderr regardless of exit code. */
        proc.on('close', () => {
            const names = [];
            /* Lines look like:  [dshow @ ...] "DEVICE NAME" (audio)
               Older ffmpeg:     [dshow @ ...]  "DEVICE NAME"
                                 [dshow @ ...]     Alternative name "@device_..."
               We match the quoted name on lines tagged (audio). To stay robust
               across ffmpeg versions we also accept the "(audio)" being on the
               same line as the quoted name. */
            const lines = err.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                if (!/\(audio\)/i.test(ln)) continue;
                const m = /"([^"]+)"/.exec(ln);
                if (m && m[1] && !/^@device_/i.test(m[1])) names.push(m[1]);
            }
            resolve(names);
        });
    });
}

/* Live recording handle. We keep exactly ONE active recording at a time
   (the mic button is a single toggle). */
let _active = null;   /* { proc, wavPath, exe, stopped, settle } */

/* Start recording the default DirectShow mic to a temp WAV (mono, 16kHz —
   ideal for speech recognition; ElevenLabs Scribe accepts it directly).
   Resolves once recording has actually begun (device opened) with the wav
   path; rejects with a SPECIFIC error (no ffmpeg / no device / open failed)
   so the caller never falls back to the generic "access denied" banner.

   `-t 120` is a safety cap so a forgotten recording can't run forever. */
function startRecording() {
    return new Promise((resolve, reject) => {
        if (_active) { reject(new Error('a recording is already in progress')); return; }
        const exe = resolveFfmpeg();
        listDshowAudioDevices().then((devices) => {
            if (!devices.length) {
                reject(new Error('no microphone device found (ffmpeg -f dshow listed 0 audio devices)'));
                return;
            }
            const device = devices[0];   /* default = first enumerated capture device */
            const wavPath = path.join(os.tmpdir(), 'cbe_stt_' + Date.now() + '.wav');
            const args = [
                '-hide_banner', '-loglevel', 'info', '-y',
                '-f', 'dshow', '-i', 'audio=' + device,
                '-ac', '1', '-ar', '16000',
                '-t', '120',
                wavPath,
            ];
            let proc;
            try {
                proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                reject(new Error('failed to start ffmpeg capture: ' + (e.message || e)));
                return;
            }
            let err = '';
            let opened = false;
            const onErrData = (d) => {
                err += d.toString();
                /* ffmpeg prints "Output #0" / "Stream mapping" once the input is
                   open and it has started writing the WAV. Use that as the
                   "recording actually started" signal so the UI red-ring only
                   shows when the mic is genuinely live. */
                if (!opened && /Output #0|Stream mapping|Press \[q\]/i.test(err)) {
                    opened = true;
                    resolve({ wavPath, device });
                }
            };
            proc.stderr.on('data', onErrData);
            proc.on('error', (e) => {
                if (!opened) reject(new Error('ffmpeg not found — STT needs ffmpeg on PATH (' + (e.message || e) + ')'));
                if (_active && _active.proc === proc) _active = null;
            });
            proc.on('close', (code) => {
                /* If we never reached the "opened" signal, surface why. Common
                   cause: device busy, or dshow couldn't open the named device. */
                if (!opened) {
                    reject(new Error('ffmpeg could not open the microphone (exit ' + code + '): ' + err.slice(-300).trim()));
                }
                /* The settle() promise (awaited by stopRecording) resolves with
                   the final exit info so the caller knows the WAV is flushed. */
                if (_active && _active.proc === proc && _active._onClose) {
                    _active._onClose({ code, err });
                }
            });
            _active = { proc, wavPath, exe, device, stopped: false, _onClose: null };
            /* Safety: if the device opens but ffmpeg never emits the signal
               within 4s (very old build / odd locale), resolve anyway — the
               WAV is being written; worst case we get a slightly clipped head. */
            setTimeout(() => { if (!opened && _active && _active.proc === proc) { opened = true; resolve({ wavPath, device }); } }, 4000);
        }).catch(reject);
    });
}

/* Stop the active recording GRACEFULLY and resolve with the recorded WAV
   bytes (a Buffer) once ffmpeg has flushed + exited. We write 'q' to ffmpeg
   stdin (clean WAV finalization), then a 2s fallback that combines a PID
   kill AND a wmic cmdline-match kill to catch chocolatey-shim orphans. */
function stopRecording() {
    return new Promise((resolve, reject) => {
        const a = _active;
        if (!a) { reject(new Error('no active recording to stop')); return; }
        if (a.stopped) { reject(new Error('recording already stopping')); return; }
        a.stopped = true;

        let settled = false;
        const finish = () => {
            if (settled) return; settled = true;
            _active = null;
            let buf = null;
            try { buf = fs.readFileSync(a.wavPath); } catch (_) { buf = null; }
            /* Best-effort cleanup of the temp WAV after we've read it. */
            try { fs.unlink(a.wavPath, () => {}); } catch (_) {}
            if (!buf || buf.length === 0) { reject(new Error('recording produced no audio (empty WAV)')); return; }
            resolve(buf);
        };

        a._onClose = () => finish();

        /* 1. Graceful stop: 'q' on stdin → ffmpeg writes the WAV trailer + exits. */
        try { a.proc.stdin.write('q\n'); } catch (_) {}
        try { a.proc.stdin.end(); } catch (_) {}

        /* 2. Fallback hard-stop after 2s if 'q' didn't take. Kill by PID AND by
              cmdline (wmic) so a chocolatey-shim orphan recording our wav name
              is also reaped. The close handler's finish() still runs after. */
        setTimeout(() => {
            if (settled) return;
            try { a.proc.kill(); } catch (_) {}
            try {
                const wavName = path.basename(a.wavPath);
                /* wmic matches the orphaned real-ffmpeg by the temp WAV in its
                   command line — defeats the shim-orphan problem. */
                execFile('wmic', ['process', 'where',
                    "name='ffmpeg.exe' and CommandLine like '%" + wavName + "%'",
                    'call', 'terminate'], { windowsHide: true }, () => {});
            } catch (_) {}
            /* Give the kill a moment to let 'close' fire; if it doesn't, force finish. */
            setTimeout(finish, 1200);
        }, 2000);
    });
}

/* True if a host recording is currently active (mic open). */
function isRecording() { return !!_active; }

module.exports = { startRecording, stopRecording, isRecording, listDshowAudioDevices, resolveFfmpeg, setFfmpegPath };
