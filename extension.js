// Claude Codex Black Ed.x Black — voice input + Black Edition UI for Claude Codex Black Ed.

const vscode   = require('vscode');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execFile, exec, spawn } = require('child_process');

const LOG_PORT       = 57836;
const CTRL_PORT      = 57837;
const LOG_FILE       = path.join(os.homedir(), 'debug.log');
function chatLogFile() {
    const d = new Date();
    const ymd = d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
    return path.join(os.homedir(), 'chat-' + ymd + '.log');
}
const EXT_ROOT       = path.join(os.homedir(), '.vscode', 'extensions');
const INJECTS_DIR    = path.join(__dirname, 'injects');
const FFMPEG         = findFfmpeg();
const TMP_WAV        = path.join(os.tmpdir(), 'codex_black_rec.wav');
const TMP_PS         = path.join(os.tmpdir(), 'cv_sapi.ps1');
const MONITOR_SCRIPT = path.join(os.tmpdir(), 'cbe_watchdog.ps1');
const CBE_PATH       = __dirname;

let watchdogProc = null;

function findFfmpeg() {
    const candidates = [
        'ffmpeg',
        'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    ];
    for (const c of candidates) {
        try { require('child_process').execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch (e) {}
    }
    return candidates[1]; // fallback to choco path, will error descriptively at record time
}

let logServer   = null;
let ctrlServer  = null;
let watchers    = [];
let statusBarItem;

// recording state
let ffmpegProc   = null;   // active ffmpeg process
let recState     = 'idle'; // idle | recording | transcribing
let pendingText  = null;   // transcribed text waiting for webview to consume

// ── Logging ────────────────────────────────────────────────────────────────

function cvLog(msg, isErr) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
    (isErr ? console.error : console.log)('[codex-black]', msg);
}

function cvChat(role, msg) {
    const line = `[${new Date().toISOString()}] [${role}] ${msg}\n`;
    try { fs.appendFileSync(chatLogFile(), line); } catch (e) {}
}

// ── Inject / Injector ─────────────────────────────────────────────────────

class Inject {
    constructor(filePath) {
        this.filePath = filePath;
        this.name     = path.basename(filePath);
        this.type     = this.name.endsWith('.css') ? 'css' : 'js';
        this.content  = this._read();
    }
    _read() {
        try { return fs.readFileSync(this.filePath, 'utf8'); } catch (e) { return ''; }
    }
    reload() {
        const fresh = this._read();
        if (fresh !== this.content) { this.content = fresh; return true; }
        return false;
    }
}

class Injector {
    constructor(dir) {
        this.dir     = dir;
        this.injects = new Map();   // name -> Inject
        this.version = 0;
        this._watcher = null;
        if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }
        this._loadAll();
        this._watch();
    }

    _loadAll() {
        try {
            fs.readdirSync(this.dir)
                .filter(f => f.endsWith('.js') || f.endsWith('.css'))
                .sort()
                .forEach(f => this.injects.set(f, new Inject(path.join(this.dir, f))));
        } catch (e) {}
        this.version++;
        cvLog(`Injector loaded ${this.injects.size} injects v=${this.version}`);
    }

    _watch() {
        try {
            this._watcher = fs.watch(this.dir, { persistent: false }, (ev, fname) => {
                if (!fname || (!fname.endsWith('.js') && !fname.endsWith('.css'))) return;
                const fp = path.join(this.dir, fname);
                if (fs.existsSync(fp)) {
                    this.injects.set(fname, new Inject(fp));
                    cvLog(`Injector: ${fname} updated`);
                } else {
                    this.injects.delete(fname);
                    cvLog(`Injector: ${fname} removed`);
                }
                this.version++;
                // Auto-repatch and reload webview so changes go live immediately
                this._scheduleLiveReload(fname);
            });
        } catch (e) { cvLog('Injector watch error: ' + e.message); }
    }

    _scheduleLiveReload(fname) {
        clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => {
            const patchScript = path.join(__dirname, 'patch-webview.js');
            cvLog(`Injector: live-reload triggered by ${fname} — repatching...`);
            execFile('node', [patchScript], { timeout: 15000 }, (err, stdout) => {
                if (err) { cvLog('live-reload patch failed: ' + err.message); return; }
                cvLog('live-reload patch OK: ' + stdout.trim().split('\n').pop());
                // Reload just the active webview panel (Claude Codex Black Ed.'s chat panel)
                vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction')
                    .then(() => cvLog('live-reload: webview reloaded'))
                    .then(undefined, () => {
                        // Fallback: focus Claude Codex Black Ed. panel then reload
                        vscode.commands.executeCommand('claude-vscode.focus').then(() => {
                            vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
                        }, () => {});
                    });
            });
        }, 600); // debounce 600ms so rapid saves don't trigger multiple reloads
    }

    getManifest() {
        return { version: this.version, files: [...this.injects.keys()] };
    }

    getFile(name) {
        return this.injects.get(name) || null;
    }

    getBundle() {
        const parts = [];
        for (const inj of this.injects.values()) {
            if (inj.type === 'js') {
                parts.push(`/* === ${inj.name} === */\ntry{\n${inj.content}\n}catch(e){console.error('[cb-bundle] ${inj.name}:',e);}`);
            }
        }
        return parts.join('\n\n');
    }

    dispose() {
        try { if (this._watcher) this._watcher.close(); } catch (e) {}
    }
}

let injector = null;

// ── Log server (receives logs FROM the webview) ────────────────────────────

function startLogServer() {
    logServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                if (req.url === '/chat') {
                    /* body format: ROLE\tMESSAGE  (ROLE = USER | CLAUDE | SYSTEM) */
                    const tab = body.indexOf('\t');
                    const role = tab > -1 ? body.slice(0, tab) : 'UNKNOWN';
                    const text = tab > -1 ? body.slice(tab + 1) : body;
                    cvChat(role, text);
                } else {
                    cvLog('[webview] ' + body);
                }
                res.writeHead(200); res.end('ok');
            });
        } else { res.writeHead(404); res.end(); }
    });
    logServer.on('error', e => {
        cvLog('logServer error: ' + e.message);
        if (e.code === 'EADDRINUSE') {
            cvLog('logServer port ' + LOG_PORT + ' busy — killing occupant and retrying in 1s');
            require('child_process').exec(
                `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${LOG_PORT}') do taskkill /PID %a /F`,
                () => setTimeout(() => { try { logServer.listen(LOG_PORT, '127.0.0.1', () => cvLog('log server up on ' + LOG_PORT + ' (retry)')); } catch(e2) { cvLog('logServer retry failed: ' + e2.message); } }, 1000)
            );
        }
    });
    logServer.listen(LOG_PORT, '127.0.0.1', () => cvLog('log server up on ' + LOG_PORT));
}

// ── Recording via ffmpeg ───────────────────────────────────────────────────

function startRecording() {
    if (recState !== 'idle') { cvLog('startRecording: already ' + recState); return; }
    cvLog('startRecording: spawning ffmpeg wav=' + TMP_WAV);

    try { if (fs.existsSync(TMP_WAV)) fs.unlinkSync(TMP_WAV); } catch (e) {}

    const device = getAudioDevice();
    cvLog('startRecording: using device "' + device + '"');
    const args = [
        '-y', '-f', 'dshow',
        '-i', 'audio=' + device,
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        '-t', '300',
        TMP_WAV,
    ];
    const argsFallback = [
        '-y', '-f', 'dshow',
        '-i', 'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{5F576A7E-1B41-44E3-8B7F-A12263F5A268}',
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        '-t', '300',
        TMP_WAV,
    ];

    cvLog('ffmpeg args: ' + args.join(' '));
    /* stdin must be pipe so we can send 'q' for graceful WAV finalization */
    ffmpegProc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    /* Warming flag: dshow init takes 1-3s on Windows. ffmpeg only writes the WAV header
       (and responds to 'q' on stdin) AFTER the input device opens. If the user clicks
       stop before that, killing ffmpeg leaves a zero-byte WAV → Whisper gets nothing.
       We flip warming=false on the first "size=" progress line (= capture is live). */
    ffmpegProc.warming = true;
    recState = 'recording';
    setListening();
    notifyPanel({ type: 'recording' });

    ffmpegProc.stdout.on('data', d => cvLog('ffmpeg stdout: ' + d.toString().trim()));
    ffmpegProc.stderr.on('data', d => {
        const s = d.toString();
        cvLog('ffmpeg stderr: ' + s.trim());
        if (ffmpegProc && ffmpegProc.warming && /size=\s*\d/.test(s)) {
            ffmpegProc.warming = false;
            cvLog('ffmpeg dshow ready — capture live');
        }
    });
    ffmpegProc.on('error', err => {
        cvLog('ffmpeg spawn error: ' + err.message + ' — trying fallback device');
        ffmpegProc = spawn(FFMPEG, argsFallback, { stdio: ['ignore', 'pipe', 'pipe'] });
        ffmpegProc.stderr.on('data', d => cvLog('ffmpeg-fb stderr: ' + d.toString().trim()));
        ffmpegProc.on('error', err2 => { cvLog('ffmpeg fallback error: ' + err2.message); recState = 'idle'; setIdle(); notifyPanel({ type: 'error', message: err2.message }); });
        ffmpegProc.on('close', code => { cvLog('ffmpeg-fb closed code=' + code); if (recState === 'recording' || recState === 'transcribing') stopAndTranscribe(); });
    });
    ffmpegProc.on('close', code => {
        cvLog('ffmpeg closed code=' + code + ' recState=' + recState);
        /* recording = natural -t timeout / user-stop; transcribing = user clicked stop and we already flipped state. Either way, transcribe. */
        if (recState === 'recording' || recState === 'transcribing') stopAndTranscribe();
    });
}

function stopRecording() {
    cvLog('stopRecording called recState=' + recState + ' warming=' + (ffmpegProc && ffmpegProc.warming));
    if (recState !== 'recording' || !ffmpegProc) { cvLog('nothing to stop'); return; }
    /* If ffmpeg is still in dshow init (warming), defer the stop until capture is live.
       Otherwise the kill leaves a zero-byte WAV and Whisper gets nothing.
       Poll up to 4s waiting for warming=false; if dshow never opens, fall through and kill. */
    if (ffmpegProc.warming) {
        cvLog('stopRecording: ffmpeg still warming up — deferring until dshow opens');
        const procRef = ffmpegProc;
        let waited = 0;
        const waitInt = setInterval(() => {
            waited += 100;
            if (!procRef || procRef !== ffmpegProc) { clearInterval(waitInt); return; }
            if (!procRef.warming || waited >= 4000) {
                clearInterval(waitInt);
                cvLog('stopRecording: deferred fire (waited ' + waited + 'ms, warming=' + procRef.warming + ')');
                doStopRecording();
            }
        }, 100);
        return;
    }
    doStopRecording();
}

function doStopRecording() {
    if (!ffmpegProc) return;
    recState = 'transcribing';
    setTranscribing();
    notifyPanel({ type: 'transcribing' });
    /* Graceful: 'q' on stdin makes ffmpeg finalize the WAV header cleanly. */
    try { ffmpegProc.stdin.write('q\n'); ffmpegProc.stdin.end(); cvLog('sent q to ffmpeg stdin'); } catch (e) { cvLog('stdin q failed: ' + e.message); }
    /* Hard-kill fallback after 1.5s — covers chocolatey shim case where the spawned PID is a dead wrapper and the real ffmpeg is orphaned. */
    const procRef = ffmpegProc;
    setTimeout(() => {
        if (procRef && procRef === ffmpegProc) {
            cvLog('graceful quit timed out — hard-killing ffmpeg tree + orphans');
            try { require('child_process').execFile('taskkill', ['/PID', String(procRef.pid), '/T', '/F'], () => {}); } catch (e) {}
            try { procRef.kill('SIGKILL'); } catch (e) {}
            /* Chocolatey-shim orphan: nuke any ffmpeg.exe whose cmdline contains our WAV path */
            try {
                const wavName = path.basename(TMP_WAV);
                require('child_process').exec(
                    `wmic process where "name='ffmpeg.exe' and CommandLine like '%${wavName}%'" call terminate`,
                    () => {}
                );
            } catch (e) {}
        }
    }, 1500);
}

async function stopAndTranscribe() {
    cvLog('stopAndTranscribe: recState=' + recState);
    recState = 'transcribing';
    ffmpegProc = null;
    setTranscribing();
    notifyPanel({ type: 'transcribing' });

    const wavExists = fs.existsSync(TMP_WAV);
    const wavSize   = wavExists ? fs.statSync(TMP_WAV).size : 0;
    cvLog('WAV exists=' + wavExists + ' size=' + wavSize);

    if (!wavExists || wavSize < 1000) {
        cvLog('WAV too small or missing — aborting');
        recState = 'idle'; setIdle();
        notifyPanel({ type: 'error', message: 'No audio recorded (WAV size=' + wavSize + ')' });
        return;
    }

    const provider = getSttProvider();
    let apiKey, transcribeFn, providerLabel;
    if (provider === 'gemini') {
        apiKey = getGeminiKey();
        transcribeFn = transcribeGemini;
        providerLabel = 'Gemini';
    } else {
        apiKey = getOpenAiKey();
        transcribeFn = transcribeWhisper;
        providerLabel = 'OpenAI Whisper';
    }

    if (!apiKey) {
        cvLog('No ' + providerLabel + ' API key in config.ini');
        recState = 'idle'; setIdle();
        notifyPanel({ type: 'error', message: 'No ' + providerLabel + ' API key configured' });
        return;
    }

    cvLog('transcribing via ' + providerLabel + '...');
    try {
        const text = await transcribeFn(TMP_WAV, apiKey);
        cvLog(providerLabel + ' transcript: ' + JSON.stringify(text));
        recState = 'idle'; setIdle();
        notifyPanel({ type: 'result', text: text || '' });
        if (text) {
            pendingText = text; /* legacy fallback for /speech/status pollers */
            /* Drive the paste directly — no chat-panel poller exists post-pivot.
               STT defaults to paste-only so the user can edit before sending;
               set codexBlackEd.autoSend = true to auto-submit. */
            const autoSend = vscode.workspace.getConfiguration('codexBlackEd').get('autoSend', false);
            submitText(text, autoSend);
        } else {
            cvLog('empty transcript — nothing to submit');
            notifyPanel({ type: 'error', message: 'No speech detected' });
        }
    } catch (e) {
        cvLog(providerLabel + ' error: ' + e.message);
        recState = 'idle'; setIdle();
        notifyPanel({ type: 'error', message: 'Transcription failed: ' + e.message });
    }
}

// ── VS Code watchdog ──────────────────────────────────────────────────────

function writeWatchdogScript() {
    const cbePath = CBE_PATH; // single backslashes — PowerShell doesn't use \ as escape char
    const script = [
        '$logFile = "$env:TEMP\\cbe_monitor.log"',
        `$cbePath = "${cbePath}"`,
        '"$(Get-Date -Format \'HH:mm:ss\') [watchdog] started" | Add-Content $logFile',
        'while ($true) {',
        '    Start-Sleep -Seconds 5',
        '    $procs = Get-Process "Code" -ErrorAction SilentlyContinue',
        '    if (-not $procs) {',
        '        "$(Get-Date -Format \'HH:mm:ss\') [watchdog] Code.exe gone - relaunching" | Add-Content $logFile',
        '        Start-Sleep -Seconds 3',
        '        node "$cbePath\\patch-webview.js" 2>&1 | Add-Content $logFile',
        '        Start-Sleep -Seconds 1',
        '        Start-Process "code" -ArgumentList "--extensionDevelopmentPath=$cbePath"',
        '        Start-Sleep -Seconds 20',
        '        "$(Get-Date -Format \'HH:mm:ss\') [watchdog] relaunch done" | Add-Content $logFile',
        '    }',
        '}',
    ].join('\r\n');
    // Launcher: spawns the real watchdog via Start-Process (truly detached) and writes its PID
    const launcher = [
        `$p = Start-Process powershell.exe -ArgumentList '-ExecutionPolicy Bypass -NonInteractive -File "${MONITOR_SCRIPT}"' -WindowStyle Hidden -PassThru`,
        `$p.Id | Out-File -FilePath "${MONITOR_SCRIPT}.pid" -Encoding ascii`,
    ].join('\r\n');
    fs.writeFileSync(MONITOR_SCRIPT, script, 'utf8');
    fs.writeFileSync(MONITOR_SCRIPT + '.launcher.ps1', launcher, 'utf8');
}

function startWatchdog() {
    if (isWatchdogRunning()) { cvLog('watchdog already running pid=' + getWatchdogPid()); return; }
    watchdogProc = null;
    writeWatchdogScript();
    // Launch via a separate launcher PS1 — avoids quote-escaping issues with inline -Command
    watchdogProc = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass', '-NonInteractive',
        '-File', MONITOR_SCRIPT + '.launcher.ps1',
    ], { stdio: 'ignore', windowsHide: true });
    watchdogProc.unref();
    cvLog('watchdog started pid=' + watchdogProc.pid);
}

function stopWatchdog() {
    const pid = getWatchdogPid();
    if (pid) {
        try { require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { timeout: 3000 }); } catch(e) {}
        try { fs.unlinkSync(MONITOR_SCRIPT + '.pid'); } catch(e) {}
        cvLog('watchdog stopped pid=' + pid);
    }
    watchdogProc = null;
}

function getWatchdogPid() {
    try {
        const pidFile = MONITOR_SCRIPT + '.pid';
        if (!fs.existsSync(pidFile)) return null;
        return fs.readFileSync(pidFile, 'utf8').trim();
    } catch(e) { return null; }
}
function isWatchdogRunning() {
    const pid = getWatchdogPid();
    if (!pid) return false;
    try {
        const out = require('child_process').execSync(`tasklist /FI "PID eq ${pid}" /NH`, { timeout: 2000 }).toString();
        return out.includes(String(pid));
    } catch(e) { return false; }
}

// ── STT provider config ───────────────────────────────────────────────────

const CBE_CONFIG = path.join(__dirname, 'config.ini');

function readCbeConfig() {
    try { return fs.readFileSync(CBE_CONFIG, 'utf8'); } catch (e) { return ''; }
}

function getSttProvider() {
    const m = readCbeConfig().match(/^\s*provider\s*=\s*(\S+)/m);
    return (m ? m[1].trim() : 'openai').toLowerCase();
}

// ── Audio device config ───────────────────────────────────────────────────

/* Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr for audio devices.
   Returns [{name, altName}]. ffmpeg writes device lines like:
     [dshow @ ...] "Microphone (webcam AC310)" (audio)
     [dshow @ ...]   Alternative name "@device_cm_{...}\\wave_{...}"
   The altName is what we pass to ffmpeg when the friendly name has special chars. */
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
                    const next = lines[i + 1] || '';
                    const am = next.match(/Alternative name +"([^"]+)"/);
                    if (am) entry.altName = am[1];
                    out.push(entry);
                }
            }
            resolve(out);
        });
        proc.on('error', () => resolve([]));
    });
}

function getAudioDevice() {
    const m = readCbeConfig().match(/^\s*audio_device\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : 'Microphone (webcam AC310)';
}

function setAudioDevice(name) {
    let ini = readCbeConfig();
    if (/^\s*audio_device\s*=/m.test(ini)) {
        ini = ini.replace(/^(\s*audio_device\s*=\s*).+/m, '$1' + name);
    } else {
        /* Add under [stt] section if present, otherwise append. */
        if (/^\[stt\]/m.test(ini)) {
            ini = ini.replace(/(\[stt\][^\[]*)/m, '$1audio_device = ' + name + '\n');
        } else {
            ini += '\n[stt]\naudio_device = ' + name + '\n';
        }
    }
    fs.writeFileSync(CBE_CONFIG, ini, 'utf8');
    cvLog('audio device set to: ' + name);
}

async function pickAudioDevice() {
    const devices = await listAudioDevices();
    if (!devices.length) {
        vscode.window.showWarningMessage('Codex Black: no audio capture devices found by ffmpeg.');
        return;
    }
    const current = getAudioDevice();
    const items = devices.map(d => ({
        label: (d.name === current ? '$(check) ' : '') + d.name,
        description: d.altName ? d.altName.slice(0, 60) : '',
        deviceName: d.name,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Codex Black — Pick Microphone',
        placeHolder: 'Current: ' + current,
    });
    if (pick) {
        setAudioDevice(pick.deviceName);
        vscode.window.showInformationMessage('Codex Black mic → ' + pick.deviceName);
    }
}

function setSttProvider(prov) {
    let ini = readCbeConfig();
    if (/^\s*provider\s*=/m.test(ini)) {
        ini = ini.replace(/^(\s*provider\s*=\s*).+/m, '$1' + prov);
    } else {
        ini += '\nprovider = ' + prov + '\n';
    }
    fs.writeFileSync(CBE_CONFIG, ini, 'utf8');
    cvLog('STT provider set to: ' + prov);
}

function getOpenAiKey() {
    const ini = readCbeConfig();
    const m = ini.match(/openai_api_key\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
}

function getGeminiKey() {
    const ini = readCbeConfig();
    const m = ini.match(/gemini_api_key\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
}

// ── Whisper transcription (vs-whisper style) ──────────────────────────────

function transcribeWhisper(audioPath, apiKey) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const boundary = '----CBEWhisper' + Date.now();
        const preFile = [
            '--' + boundary,
            'Content-Disposition: form-data; name="file"; filename="audio.wav"',
            'Content-Type: audio/wav',
            '',
            '',
        ].join('\r\n');
        const postFile = [
            '',
            '--' + boundary,
            'Content-Disposition: form-data; name="model"',
            '',
            'whisper-1',
            '--' + boundary,
            'Content-Disposition: form-data; name="language"',
            '',
            'en',
            '--' + boundary,
            'Content-Disposition: form-data; name="response_format"',
            '',
            'json',
            '--' + boundary + '--',
            '',
        ].join('\r\n');

        const fileSize = fs.statSync(audioPath).size;
        const contentLength = Buffer.byteLength(preFile) + fileSize + Buffer.byteLength(postFile);

        const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/audio/transcriptions',
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + apiKey,
                'Content-Type': 'multipart/form-data; boundary=' + boundary,
                'Content-Length': contentLength,
            },
        }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error('Whisper API (' + res.statusCode + '): ' + body));
                    return;
                }
                try {
                    const json = JSON.parse(body);
                    resolve((json.text || '').trim());
                } catch (e) {
                    reject(new Error('Parse error: ' + body.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(preFile);
        const stream = fs.createReadStream(audioPath);
        stream.on('data', c => { req.write(c); });
        stream.on('end', () => { req.write(postFile); req.end(); });
        stream.on('error', reject);
    });
}

function transcribeGemini(audioPath, apiKey) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const audioData = fs.readFileSync(audioPath).toString('base64');
        const body = JSON.stringify({
            contents: [{
                parts: [
                    { text: 'Transcribe this audio exactly as spoken. Return only the transcript text, nothing else.' },
                    { inlineData: { mimeType: 'audio/wav', data: audioData } }
                ]
            }]
        });
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: '/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let resp = '';
            res.on('data', c => { resp += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) { reject(new Error('Gemini API (' + res.statusCode + '): ' + resp)); return; }
                try {
                    const json = JSON.parse(resp);
                    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    resolve(text.trim());
                } catch (e) { reject(new Error('Gemini parse error: ' + resp.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Submit to Claude Codex Black Ed. ─────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function submitText(text, submit = true) {
    cvLog('submitText: ' + JSON.stringify(text.slice(0, 80)) + ' submit=' + submit);
    try {
        cvLog('focusing Claude Codex Black Ed....');
        try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch (e) { cvLog('focus err: ' + e.message); }
        await delay(250);
        cvLog('writing clipboard...');
        await vscode.env.clipboard.writeText(text);
        await delay(80);
        cvLog('pasting...');
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        if (!submit) { cvLog('submitText complete (paste-only, autoSend off)'); return; }
        await delay(180);
        cvLog('typing enter...');
        require('child_process').execSync('python C:/Users/moren/claude-tools/mouse.py key enter', { timeout: 3000 });
        cvLog('submitText complete');
    } catch (e) {
        cvLog('submitText error: ' + e.message + '\n' + e.stack);
    }
}

// ── Panel messaging ────────────────────────────────────────────────────────

function notifyPanel(msg) {
    try { if (panel) panel.webview.postMessage(msg); } catch (e) {}
}

// ── Panel (REMOVED) ───────────────────────────────────────────────────────
//
// CBE used to define its own webview panel ('codexBlackEd.panel') with
// bindPanel / openCBEPanel / CodexBlackPanelSerializer / panelHtml. That panel
// rendered "CLAUDE CODEX BLACK ED.X — BLACK EDITION" and a separate chat surface,
// which collided with Anthropic's panel and confused the user.
//
// CBE's actual UI is the orange "label-alpha" pill + injects that run INSIDE
// Anthropic's Claude Code webview (see patch-webview.js + injects/aa-*-data.js +
// injects/black-edition.js). There is no second CBE panel — Anthropic owns the
// surface, CBE owns the look. `panel` stays declared so the legacy notifyPanel()
// no-op guard `if (panel)` is safe; nothing ever assigns to it now.

let panel = null;

// ── Control server ────────────────────────────────────────────────────────

async function handleControl(url, p, res) {
    // ── About (read [about] section from config.ini, fresh each call) ────
    if (url === '/about') {
        const ini = readCbeConfig();
        const aboutBlock = ini.split(/^\[about\][\r\n]+/m)[1] || '';
        const section = aboutBlock.split(/^\[/m)[0] || '';
        function pick(key) {
            const re = new RegExp('^\\s*' + key + '\\s*=\\s*([^\\r\\n]+)', 'm');
            const m = section.match(re);
            return m ? m[1].trim() : '';
        }
        const about = {
            repo:    pick('repo'),
            author:  pick('author'),
            email:   pick('email'),
            version: pick('version'),
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(JSON.stringify(about));
        return null;
    }

    // ── Inject routes (served outside JSON wrapper) ──────────────────────
    if (url === '/injects/manifest') {
        const manifest = injector ? injector.getManifest() : { version: 0, files: [] };
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(manifest));
        return null; // signal: already responded
    }

    if (url === '/injects/bundle') {
        const bundle = injector ? injector.getBundle() : '';
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(bundle);
        return null;
    }

    if (url === '/bundle/version') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(JSON.stringify({ ts: injector ? injector.version : 0 }));
        return null;
    }

    if (url === '/bundle/bump') {
        if (injector) { injector._loadAll(); }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, version: injector ? injector.version : 0 }));
        return null;
    }

    if (url.startsWith('/hook/')) {
        const hookName = url.slice('/hook/'.length).replace(/[^a-z0-9_-]/gi, '');
        const hookFile = path.join(__dirname, 'hooks', hookName + '.js');
        if (!fs.existsSync(hookFile)) {
            res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'hook not found: ' + hookName })); return null;
        }
        try {
            delete require.cache[require.resolve(hookFile)];
            const hookFn = require(hookFile);
            const result = await hookFn({ vscode, cvLog, delay, submitText, startRecording, stopRecording, recState: () => recState, body: p });
            res.writeHead(200); res.end(JSON.stringify({ ok: true, ...(result || {}) })); return null;
        } catch (e) {
            cvLog('hook error ' + hookName + ': ' + e.message);
            res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); return null;
        }
    }

    if (url.startsWith('/lib/')) {
        const name = path.basename(decodeURIComponent(url.slice('/lib/'.length)));
        const libPath = path.join(__dirname, 'lib', name);
        try {
            const content = require('fs').readFileSync(libPath);
            const ct = name.endsWith('.css') ? 'text/css' : 'application/javascript';
            res.setHeader('Content-Type', ct);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.writeHead(200); res.end(content); return null;
        } catch (e) { res.writeHead(404); res.end('not found'); return null; }
    }

    if (url.startsWith('/injects/file/')) {
        const name = decodeURIComponent(url.slice('/injects/file/'.length));
        const inj = injector ? injector.getFile(name) : null;
        if (!inj) {
            res.writeHead(404); res.end('not found'); return null;
        }
        res.setHeader('Content-Type', inj.type === 'css' ? 'text/css' : 'application/javascript');
        res.writeHead(200);
        res.end(inj.content);
        return null;
    }

    switch (url) {

        case '/status': {
            const ed  = vscode.window.activeTextEditor;
            const sel = ed ? ed.document.getText(ed.selection) : '';
            return {
                file:             ed?.document.uri.fsPath ?? null,
                language:         ed?.document.languageId ?? null,
                selection:        sel.slice(0, 2000),
                cursorLine:       ed?.selection.active.line ?? null,
                terminals:        vscode.window.terminals.map(t => t.name),
                activeTerminal:   vscode.window.activeTerminal?.name ?? null,
                workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
            };
        }

        case '/command': {
            const result = await vscode.commands.executeCommand(p.command, ...(p.args ?? []));
            return { result: result !== undefined ? String(result) : null };
        }

        case '/type': {
            await vscode.commands.executeCommand('type', { text: p.text });
            return {};
        }

        case '/clipboard': {
            await vscode.env.clipboard.writeText(p.text);
            if (p.paste !== false) {
                await delay(120);
                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            }
            return {};
        }

        case '/terminal/send': {
            let term = p.name
                ? vscode.window.terminals.find(t => t.name === p.name) ?? vscode.window.createTerminal(p.name)
                : vscode.window.activeTerminal ?? vscode.window.createTerminal('Claude');
            if (p.focus !== false) term.show(true);
            term.sendText(p.text, p.execute !== false);
            return { terminal: term.name };
        }

        case '/terminal/run': {
            return new Promise(resolve => {
                exec(p.command, { timeout: p.timeout ?? 30000, shell: 'powershell.exe' }, (err, stdout, stderr) => {
                    resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: err?.code ?? 0 });
                });
            });
        }

        case '/skin/list': {
            return { ok: true, skins: listSkins().map(s => s.label) };
        }

        case '/skin/css': {
            const css = skinToCss(currentSkinVars);
            res.setHeader('Content-Type', 'text/css');
            res.writeHead(200);
            res.end(css);
            return null;
        }

        case '/skin/reload': {
            let xmlPath = p.path || 'default.xml';
            if (!path.isAbsolute(xmlPath)) xmlPath = path.join(__dirname, 'themes', xmlPath);
            changeSkin(xmlPath);
            return { ok: true, vars: Object.keys(currentSkinVars).length };
        }

        case '/input':
        case '/speech/submit': {
            const inputText = (p.text || '').trim();
            cvLog('/speech/submit called text=' + JSON.stringify(inputText.slice(0, 60)));
            if (!inputText) return { ok: true };
            await submitText(inputText);
            return { ok: true };
        }

        case '/speech/start': {
            startRecording();
            return { ok: true, status: 'recording' };
        }
        case '/speech/stop': {
            stopRecording();
            return { ok: true, status: 'stopping' };
        }
        case '/speech/toggle': {
            if (recState === 'idle') {
                startRecording();
                return { ok: true, action: 'start', status: 'recording' };
            } else {
                stopRecording();
                return { ok: true, action: 'stop', status: 'stopping' };
            }
        }
        case '/monitor/start': {
            startWatchdog();
            await new Promise(r => setTimeout(r, 1500)); // wait for Start-Process to write PID file
            return { ok: true, running: isWatchdogRunning(), pid: getWatchdogPid() };
        }
        case '/monitor/stop': {
            stopWatchdog();
            return { ok: true, running: false };
        }
        case '/monitor/status': {
            return { ok: true, running: isWatchdogRunning(), pid: getWatchdogPid() };
        }

        case '/speech/provider': {
            if (p.set) {
                const prov = String(p.set).toLowerCase();
                if (!['openai', 'gemini'].includes(prov)) throw new Error('Unknown provider: ' + prov);
                setSttProvider(prov);
                notifyPanel({ type: 'provider', provider: prov });
            }
            return { ok: true, provider: getSttProvider() };
        }

        case '/audio/devices': {
            const devices = await listAudioDevices();
            return { ok: true, devices, current: getAudioDevice() };
        }

        case '/audio/device': {
            if (p.set) {
                setAudioDevice(String(p.set));
            }
            return { ok: true, current: getAudioDevice() };
        }

        case '/audio/pick': {
            pickAudioDevice();
            return { ok: true };
        }

        case '/speech/status': {
            const txt = pendingText;
            if (txt) pendingText = null; // consume once
            return { ok: true, status: recState, text: txt || null };
        }

        case '/search': {
            await vscode.commands.executeCommand('workbench.action.findInFiles');
            await delay(400);
            await vscode.env.clipboard.writeText(p.query ?? p.text ?? '');
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            return {};
        }

        case '/focus': {
            const focusMap = {
                terminal: 'workbench.action.terminal.focus',
                editor:   'workbench.action.focusActiveEditorGroup',
                search:   'workbench.action.findInFiles',
                chat:     'claude-vscode.focus',
                explorer: 'workbench.view.explorer',
                problems: 'workbench.actions.view.problems',
            };
            await vscode.commands.executeCommand(focusMap[p.target] ?? p.target);
            return {};
        }

        case '/open': {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p.path));
            return {};
        }

        case '/editor/read': {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc) return { text: null };
            const text = doc.getText();
            return { text: text.slice(p.start ?? 0, p.end ?? text.length), lines: doc.lineCount, path: doc.uri.fsPath };
        }

        case '/editor/replace': {
            const ed2 = vscode.window.activeTextEditor;
            if (!ed2) throw new Error('No active editor');
            const fullRange = new vscode.Range(
                ed2.document.positionAt(0),
                ed2.document.positionAt(ed2.document.getText().length)
            );
            await ed2.edit(b => b.replace(fullRange, p.text));
            return {};
        }

        default:
            throw new Error(`Unknown endpoint: ${url}`);
    }
}

function startControlServer() {
    ctrlServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.writeHead(204); res.end(); return;
        }
        res.setHeader('Content-Type', 'application/json');
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let p = {};
            try { if (body) p = JSON.parse(body); } catch (e) {}
            cvLog('ctrl ' + req.method + ' ' + req.url + ' body=' + body.slice(0, 120));
            try {
                const result = await handleControl(req.url, p, res);
                if (result === null) return; // already responded (inject routes)
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...result }));
            } catch (e) {
                cvLog('ctrl error: ' + e.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    });
    ctrlServer.on('error', e => {
        cvLog('ctrlServer error: ' + e.message);
        if (e.code === 'EADDRINUSE') {
            cvLog('ctrlServer port ' + CTRL_PORT + ' busy — killing occupant and retrying in 1s');
            require('child_process').exec(
                `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${CTRL_PORT}') do taskkill /PID %a /F`,
                () => setTimeout(() => { try { ctrlServer.listen(CTRL_PORT, '127.0.0.1', () => cvLog('ctrl server up on ' + CTRL_PORT + ' (retry)')); } catch(e2) { cvLog('ctrlServer retry failed: ' + e2.message); } }, 1000)
            );
        }
    });
    ctrlServer.listen(CTRL_PORT, '127.0.0.1', () => cvLog('ctrl server up on ' + CTRL_PORT));
}

// ── Auto-patcher ───────────────────────────────────────────────────────────

function watchClaudeCodeExtension() {
    let dirs;
    try {
        dirs = fs.readdirSync(EXT_ROOT)
            .filter(d => d.startsWith('anthropic.claude-code-'))
            .map(d => path.join(EXT_ROOT, d));
    } catch (e) { return; }

    for (const dir of dirs) {
        const watchPath = path.join(dir, 'webview', 'index.js');
        if (!fs.existsSync(watchPath)) continue;
        let debounce = null;
        const watcher = fs.watch(watchPath, { persistent: false }, (event) => {
            if (event !== 'change') return;
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                try {
                    const src = fs.readFileSync(watchPath, 'utf8');
                    if (src.includes('__cbPoller')) return;
                } catch (e) { return; }
                const patchScript = path.join(__dirname, 'patch-webview.js');
                execFile('node', [patchScript], (err, stdout) => {
                    if (err) { vscode.window.showErrorMessage('Claude Voice: Auto-patch failed — ' + err.message); return; }
                    cvLog('Auto-patched: ' + stdout.trim());
                    vscode.window.showInformationMessage(
                        'Claude Voice: Re-patched. Reload window?', 'Reload Now', 'Later'
                    ).then(c => { if (c === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
                });
            }, 1500);
        });
        watchers.push(watcher);
    }
}

// ── Status bar ─────────────────────────────────────────────────────────────

function setIdle()         { statusBarItem.text = '⬛ $(comment-discussion) CBE';         statusBarItem.backgroundColor = undefined; statusBarItem.tooltip = 'Codex Black Ed. — Click to open chat (Ctrl+Shift+B). Speech: Ctrl+Shift+M'; }
function setListening()    { statusBarItem.text = '⬛ $(mic-filled) 🔴';  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); statusBarItem.tooltip = 'Codex Black: Recording — click to stop'; }
function setTranscribing() { statusBarItem.text = '⬛ $(loading~spin)';   statusBarItem.backgroundColor = undefined; statusBarItem.tooltip = 'Codex Black: Transcribing…'; }


// ── Wake-up ────────────────────────────────────────────────────────────────

const WAKE_UP_SENT_FILE = path.join(os.homedir(), '.claude', '.codexblack-wakeup-sent');

const WAKEUP_MSG = "[CBE-WAKEUP] Hey! Wake up! You're a code bot! Read C:\\Users\\moren\\.claude\\CLAUDE.md";
const WAKEUP_COOLDOWN = 5 * 60 * 1000; // 5 minutes

async function sendWakeUp(context) {
    // Per-PID marker so each fresh VSCode launch fires once
    const sentKey = WAKE_UP_SENT_FILE + '.' + process.pid;
    if (fs.existsSync(sentKey)) { cvLog('wakeup: already sent for PID ' + process.pid); return; }
    try { fs.writeFileSync(sentKey, Date.now().toString()); } catch(e) { cvLog('wakeup marker write failed: ' + e.message); return; }

    cvLog('wakeup: starting retry loop for PID ' + process.pid);
    for (let attempt = 1; attempt <= 5; attempt++) {
        cvLog('wakeup attempt ' + attempt + '/5');
        try {
            await submitText(WAKEUP_MSG);
            cvLog('wakeup sent OK on attempt ' + attempt);
            return;
        } catch(e) {
            cvLog('wakeup attempt ' + attempt + ' failed: ' + e.message);
            if (attempt < 5) await new Promise(r => setTimeout(r, 4000));
        }
    }
    cvLog('wakeup: all attempts failed');
}

// ── Skin system ───────────────────────────────────────────────────────────

let currentSkinVars = {};

// ── ThemeLoader ───────────────────────────────────────────────────────────
// Parses themes/*.xml into CSS custom properties.
// Supported tags:
//   <color name="x">value</color>         → --cb-x: value
//   <gradient name="x">value</gradient>   → --cb-x: value
//   <image name="x" repeat="y" size="z">url or svg-data</image>
//       → --cb-x-url, --cb-x-repeat, --cb-x-size
//   <effect name="x" type="drop-shadow">…child elements…</effect>
//       type=drop-shadow: children <x>, <y>, <blur>, <spread>, <color>
//       → --cb-x: drop-shadow(Xpx Ypx BLURpx SPREADpx COLOR)
//       type=box-shadow: same children → --cb-x: Xpx Ypx BLURpx SPREADpx COLOR

function loadSkinXml(xmlPath) {
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const vars = {};

    // color + gradient
    const reSimple = /<(?:color|gradient) name="([^"]+)">([^<]+)<\/(?:color|gradient)>/g;
    let m;
    while ((m = reSimple.exec(xml)) !== null) vars[m[1]] = m[2].trim();

    // image: <image name="x" repeat="repeat" size="48px 48px">data</image>
    const reImage = /<image([^>]*)>([\s\S]*?)<\/image>/g;
    while ((m = reImage.exec(xml)) !== null) {
        const attrs = m[1], data = m[2].trim();
        const nameM  = attrs.match(/name="([^"]+)"/);
        const repM   = attrs.match(/repeat="([^"]+)"/);
        const sizeM  = attrs.match(/size="([^"]+)"/);
        if (!nameM) continue;
        const n = nameM[1];
        vars[n + '-url']    = 'url("' + data.replace(/"/g, "'") + '")';
        vars[n + '-repeat'] = repM  ? repM[1]  : 'repeat';
        vars[n + '-size']   = sizeM ? sizeM[1] : 'auto';
    }

    // effect: <effect name="x" type="drop-shadow|box-shadow">children</effect>
    const reEffect = /<effect([^>]*)>([\s\S]*?)<\/effect>/g;
    while ((m = reEffect.exec(xml)) !== null) {
        const attrs = m[1], body = m[2];
        const nameM = attrs.match(/name="([^"]+)"/);
        const typeM = attrs.match(/type="([^"]+)"/);
        if (!nameM) continue;
        const n = nameM[1], type = typeM ? typeM[1] : 'box-shadow';
        const get = tag => { const r = body.match(new RegExp('<' + tag + '>([^<]+)</' + tag + '>')); return r ? r[1].trim() : '0'; };
        const x = get('x'), y = get('y'), blur = get('blur'), spread = get('spread'), color = get('color');
        if (type === 'drop-shadow') {
            vars[n] = 'drop-shadow(' + x + ' ' + y + ' ' + blur + ' ' + color + ')';
        } else {
            vars[n] = x + ' ' + y + ' ' + blur + ' ' + spread + ' ' + color;
        }
    }

    return vars;
}

function skinToCss(vars) {
    const lines = Object.entries(vars).map(([k, v]) => `  --cb-${k}: ${v};`);
    return `:root {\n${lines.join('\n')}\n}\n`;
}

function changeSkin(xmlPath) {
    try {
        currentSkinVars = loadSkinXml(xmlPath);
        cvLog('theme loaded: ' + path.basename(xmlPath) + ' (' + Object.keys(currentSkinVars).length + ' vars)');
    } catch(e) {
        cvLog('changeSkin error: ' + e.message);
    }
}

function listSkins() {
    const themesDir = path.join(__dirname, 'themes');
    try {
        return fs.readdirSync(themesDir)
            .filter(f => f.endsWith('.xml'))
            .map(f => ({ label: f.replace('.xml', ''), path: path.join(themesDir, f) }));
    } catch(e) { return []; }
}

async function pickAndApplySkin() {
    const skins = listSkins();
    if (!skins.length) { vscode.window.showWarningMessage('No themes found in themes/ folder.'); return; }
    const items = skins.map(s => ({ label: s.label, description: s.path }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a CBE theme' });
    if (!pick) return;
    changeSkin(pick.description);
    vscode.window.showInformationMessage('CBE theme applied: ' + pick.label);
}

// ── CLAUDE.md injection ───────────────────────────────────────────────────

async function injectClaudeMd() {
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
        vscode.window.showErrorMessage('Claude Voice: CLAUDE.md not found at ' + claudeMdPath);
        return;
    }
    await vscode.env.clipboard.writeText(claudeMdPath);
    vscode.window.showInformationMessage('Claude Voice: CLAUDE.md path copied.', 'Open File')
        .then(c => { if (c === 'Open File') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(claudeMdPath)); });
}

// ── Activate / Deactivate ──────────────────────────────────────────────────

function clearVSCodeCache() {
    const dirs = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'Cache'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'CachedData'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'CachedExtensions'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'GPUCache'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'Code Cache'),
    ];
    let cleared = 0;
    for (const dir of dirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            for (const entry of fs.readdirSync(dir)) {
                try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); cleared++; } catch (e) {}
            }
            cvLog('cache cleared: ' + dir);
        } catch (e) { cvLog('cache clear err ' + dir + ': ' + e.message); }
    }
    cvLog('clearVSCodeCache: removed ' + cleared + ' entries');

    // Trace: verify Anthropic webview bundle is patched (bootstrap present).
    // We don't rename Anthropic's panel title anymore, so check the bootstrap sentinel.
    try {
        const extBase = path.join(os.homedir(), '.vscode', 'extensions');
        const claudeDir = fs.readdirSync(extBase).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse()[0];
        if (claudeDir) {
            const bundlePath = path.join(extBase, claudeDir, 'webview', 'index.js');
            const extJsPath  = path.join(extBase, claudeDir, 'extension.js');
            const bundleOk = fs.existsSync(bundlePath) && fs.readFileSync(bundlePath, 'utf8').includes('__cbPoller');
            const extOk    = fs.existsSync(extJsPath)  && fs.readFileSync(extJsPath, 'utf8').includes('__cbPoller');
            cvLog('anthropic patch check — bundle=' + bundleOk + ' extension=' + extOk + ' dir=' + claudeDir);
        } else {
            cvLog('anthropic patch check — no anthropic.claude-code-* dir found');
        }
    } catch(e) { cvLog('patch check failed: ' + e.message); }
}

// Re-run the patcher synchronously at activation if Anthropic's bundle is unpatched
// (e.g. user reinstalled Claude Code while CBE was off, so the file watcher never
// fired). Idempotent: patch-webview.js no-ops on already-patched bundles.
function ensurePatchedAtStartup() {
    try {
        const extBase = path.join(os.homedir(), '.vscode', 'extensions');
        const claudeDir = fs.readdirSync(extBase).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse()[0];
        if (!claudeDir) { cvLog('ensurePatched: no anthropic dir'); return; }
        const bundle = path.join(extBase, claudeDir, 'webview', 'index.js');
        if (!fs.existsSync(bundle)) { cvLog('ensurePatched: no bundle'); return; }
        const needsPatch = !fs.readFileSync(bundle, 'utf8').includes('__cbPoller');
        if (!needsPatch) { cvLog('ensurePatched: already patched'); return; }
        const patchScript = path.join(__dirname, 'patch-webview.js');
        cvLog('ensurePatched: bundle unpatched — running ' + patchScript);
        execFile('node', [patchScript], (err, stdout) => {
            if (err) { cvLog('ensurePatched FAIL: ' + err.message); return; }
            cvLog('ensurePatched OK: ' + (stdout || '').trim().split('\n').pop());
        });
    } catch(e) { cvLog('ensurePatched err: ' + e.message); }
}

function activate(context) {
    try {
        cvLog('=== CODEX BLACK ACTIVATE START pid=' + process.pid + ' ===');
        cvLog('__dirname=' + __dirname);
        cvLog('INJECTS_DIR=' + INJECTS_DIR);
        cvLog('FFMPEG=' + FFMPEG);
        cvLog('LOG_PORT=' + LOG_PORT + ' CTRL_PORT=' + CTRL_PORT);

        try { clearVSCodeCache(); } catch(e) { cvLog('clearVSCodeCache FAILED: ' + e.message); }

        try {
            changeSkin(path.join(__dirname, 'themes', 'black.xml'));
        } catch(e) { cvLog('changeSkin FAILED: ' + e.message); }

        try {
            injector = new Injector(INJECTS_DIR);
            cvLog('Injector OK');
        } catch(e) {
            cvLog('Injector FAILED: ' + e.message + '\n' + e.stack);
            vscode.window.showErrorMessage('Codex Black: Injector failed — ' + e.message);
        }

        try { startLogServer(); cvLog('logServer started'); } catch(e) { cvLog('logServer FAILED: ' + e.message); }
        try { startControlServer(); cvLog('ctrlServer started'); } catch(e) { cvLog('ctrlServer FAILED: ' + e.message); }
        try { ensurePatchedAtStartup(); } catch(e) { cvLog('ensurePatched FAILED: ' + e.message); }
        try { watchClaudeCodeExtension(); } catch(e) { cvLog('watchClaude FAILED: ' + e.message); }

        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        statusBarItem.command = 'codexBlackEd.startRecording';
        setIdle();
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);

        context.subscriptions.push(
            /* Icon / status-bar / Ctrl+Shift+B — focus Anthropic's Claude Code chat
               (the surface where CBE's label-alpha pill + injects already render).
               CBE has no separate panel; the injects ARE the CBE UI. */
            vscode.commands.registerCommand('codexBlackEd.startRecording', () => {
                cvLog('startRecording (icon-click) → focusing Claude Code chat');
                vscode.commands.executeCommand('claude-vscode.editor.open').catch(() =>
                    vscode.commands.executeCommand('claude-vscode.sidebar.open').catch(() =>
                        vscode.commands.executeCommand('claude-vscode.focus').catch(() => {})
                    )
                );
            }),
            /* Separate command for actual STT — bound to Ctrl+Shift+M below. */
            vscode.commands.registerCommand('codexBlackEd.toggleSpeech', () => {
                cvLog('toggleSpeech command recState=' + recState);
                if (recState === 'idle')           startRecording();
                else if (recState === 'recording') stopRecording();
                else                                cvLog('toggleSpeech ignored recState=' + recState);
            }),
            vscode.commands.registerCommand('codexBlackEd.injectClaudeMd', () => injectClaudeMd()),
            vscode.commands.registerCommand('codexBlackEd.changeSkin', () => pickAndApplySkin()),
            vscode.commands.registerCommand('codexBlackEd.pickAudioDevice', () => pickAudioDevice()),
            /* Legacy alias kept for older menu/keybinding contributions. CBE has no
               panel of its own; route this to Anthropic's Claude Code chat. */
            vscode.commands.registerCommand('codexBlackEd.openPanel', () => {
                vscode.commands.executeCommand('claude-vscode.editor.open').catch(() =>
                    vscode.commands.executeCommand('claude-vscode.sidebar.open').catch(() =>
                        vscode.commands.executeCommand('claude-vscode.focus').catch(() => {})
                    )
                );
            }),
            vscode.commands.registerCommand('codexBlackEd.sendWakeup', () => {
                const sentKey = WAKE_UP_SENT_FILE + '.' + process.pid;
                try { if (fs.existsSync(sentKey)) fs.unlinkSync(sentKey); } catch(e) {}
                return sendWakeUp(context);
            }),
        );

        cvLog('=== CODEX BLACK ACTIVATE COMPLETE ===');
        vscode.window.showInformationMessage('Codex Black Ed. loaded — ports ' + LOG_PORT + '/' + CTRL_PORT);

        // Auto-wakeup disabled — it submitText()s into the currently-focused Claude Codex Black Ed. chat
        // and was polluting unrelated conversations. Fire manually via codexBlackEd.sendWakeup if needed.
        // setTimeout(() => sendWakeUp(context), 4000);

    } catch(e) {
        const msg = 'CODEX BLACK ACTIVATE CRASHED: ' + e.message + '\n' + e.stack;
        cvLog(msg);
        vscode.window.showErrorMessage('Codex Black CRASHED on startup: ' + e.message);
    }
}

function deactivate() {
    cvLog('deactivate');
    if (ffmpegProc) { try { ffmpegProc.kill(); } catch (e) {} }
    if (logServer)  logServer.close();
    if (ctrlServer) ctrlServer.close();
    if (injector)   injector.dispose();
    for (const w of watchers) { try { w.close(); } catch (e) {} }
    watchers = [];
}

module.exports = { activate, deactivate };
