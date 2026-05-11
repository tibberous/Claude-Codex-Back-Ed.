// CBE Standalone Server — runs outside VS Code via Task Scheduler
// Port 57837 (ctrl), 57836 (log)

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn, exec } = require('child_process');

const CTRL_PORT  = 57837;
const LOG_PORT   = 57836;
const CBE_DIR    = __dirname;
const CONFIG_INI = path.join(CBE_DIR, 'config.ini');
const LOG_FILE   = path.join(os.homedir(), 'cbe-server.log');
const TMP_WAV    = path.join(os.tmpdir(), 'codex_black_rec.wav');

let watchdogTimer   = null; // inline watchdog — no separate process needed
let ffmpegProc      = null;
let recState        = 'idle';

function log(msg) {
    const line = new Date().toISOString().slice(11,19) + ' ' + msg;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function readConfig() {
    try { return fs.readFileSync(CONFIG_INI, 'utf8'); } catch(e) { return ''; }
}
function getKey(name) {
    const m = readConfig().match(new RegExp(name + '\\s*=\\s*(.+)'));
    return m ? m[1].trim() : null;
}
function getSttProvider() {
    const m = readConfig().match(/^\s*provider\s*=\s*(\S+)/m);
    return (m ? m[1].trim() : 'openai').toLowerCase();
}
function setSttProvider(p) {
    let ini = readConfig();
    if (/^\s*provider\s*=/m.test(ini)) ini = ini.replace(/^(\s*provider\s*=\s*).+/m, '$1' + p);
    else ini += '\nprovider = ' + p + '\n';
    fs.writeFileSync(CONFIG_INI, ini, 'utf8');
}

// ── Watchdog ──────────────────────────────────────────────────────────────
function isWatchdogRunning() { return watchdogTimer !== null; }

function startWatchdog() {
    if (watchdogTimer) return;
    log('watchdog started (inline)');
    watchdogTimer = setInterval(() => {
        exec('tasklist /FI "IMAGENAME eq Code.exe" /NH', (err, stdout) => {
            const running = stdout && stdout.toLowerCase().includes('code.exe');
            if (!running) {
                log('watchdog: Code.exe gone — relaunching');
                const codeCli = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
                exec('"' + codeCli + '"', err3 => { if (err3) log('watchdog: launch err: '+err3.message); });
                clearInterval(watchdogTimer);
                watchdogTimer = null;
                setTimeout(startWatchdog, 30000);
            }
        });
    }, 8000);
}

function stopWatchdog() {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    log('watchdog stopped');
}

// ── Whisper STT ───────────────────────────────────────────────────────────
function transcribeWhisper(wavPath, apiKey) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const boundary = '----CBEWhisper' + Date.now();
        const pre  = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n';
        const post = '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--' + boundary + '--\r\n';
        const fsize = fs.statSync(wavPath).size;
        const clen  = Buffer.byteLength(pre) + fsize + Buffer.byteLength(post);
        const req = https.request({ hostname:'api.openai.com', path:'/v1/audio/transcriptions', method:'POST',
            headers:{ Authorization:'Bearer '+apiKey, 'Content-Type':'multipart/form-data; boundary='+boundary, 'Content-Length':clen }
        }, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve((JSON.parse(b).text||'').trim());}catch(e){reject(new Error(b.slice(0,200)));} }); });
        req.on('error', reject);
        req.write(pre);
        const s = fs.createReadStream(wavPath);
        s.on('data',c=>req.write(c)); s.on('end',()=>{req.write(post);req.end();}); s.on('error',reject);
    });
}
function transcribeGemini(wavPath, apiKey) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const audio = fs.readFileSync(wavPath).toString('base64');
        const body  = JSON.stringify({ contents:[{ parts:[{text:'Transcribe this audio exactly. Return only the transcript.'},{inlineData:{mimeType:'audio/wav',data:audio}}] }] });
        const req   = https.request({ hostname:'generativelanguage.googleapis.com', path:'/v1beta/models/gemini-2.0-flash:generateContent?key='+apiKey, method:'POST',
            headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
        }, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve((JSON.parse(b).candidates[0].content.parts[0].text||'').trim());}catch(e){reject(new Error(b.slice(0,200)));} }); });
        req.on('error',reject); req.write(body); req.end();
    });
}

// ── CORS helper ───────────────────────────────────────────────────────────
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Routes ────────────────────────────────────────────────────────────────
async function handleCtrl(url, body, res) {
    switch(url) {
        case '/status':
            return { ok:true, recState, sttProvider: getSttProvider() };

        case '/monitor/start':  startWatchdog(); return { ok:true, running: isWatchdogRunning() };
        case '/monitor/stop':   stopWatchdog();  return { ok:true, running: false };
        case '/monitor/status': return { ok:true, running: isWatchdogRunning() };

        case '/speech/provider':
            if (body.set) setSttProvider(String(body.set));
            return { ok:true, provider: getSttProvider() };

        case '/speech/start': {
            if (recState !== 'idle') return { ok:false, error:'already recording' };
            const ffmpeg = 'ffmpeg';
            if (fs.existsSync(TMP_WAV)) fs.unlinkSync(TMP_WAV);
            recState = 'recording';
            ffmpegProc = spawn(ffmpeg, ['-y','-f','dshow','-i','audio=Microphone','-ar','16000','-ac','1',TMP_WAV], { stdio:'ignore' });
            ffmpegProc.on('error', e => { log('ffmpeg err: '+e.message); recState='idle'; });
            ffmpegProc.on('close', () => { if (recState==='recording') { recState='idle'; } });
            return { ok:true, status:'recording' };
        }
        case '/speech/stop': {
            if (recState !== 'recording' || !ffmpegProc) return { ok:false, error:'not recording' };
            recState = 'transcribing';
            try { exec('taskkill /PID '+ffmpegProc.pid+' /T /F'); } catch(e) {}
            ffmpegProc = null;

            await new Promise(r => setTimeout(r, 800));
            const exists = fs.existsSync(TMP_WAV);
            const size   = exists ? fs.statSync(TMP_WAV).size : 0;
            if (!exists || size < 1000) { recState='idle'; return { ok:false, error:'no audio recorded' }; }

            const provider = getSttProvider();
            const apiKey   = provider === 'gemini' ? getKey('gemini_api_key') : getKey('openai_api_key');
            if (!apiKey) { recState='idle'; return { ok:false, error:'no API key for '+provider }; }

            try {
                const text = provider === 'gemini'
                    ? await transcribeGemini(TMP_WAV, apiKey)
                    : await transcribeWhisper(TMP_WAV, apiKey);
                recState = 'idle';
                log('transcript: '+text.slice(0,80));
                return { ok:true, text };
            } catch(e) {
                recState = 'idle';
                return { ok:false, error: e.message };
            }
        }
        case '/speech/toggle':
            if (recState === 'idle') {
                return handleCtrl('/speech/start', body, res);
            } else {
                return handleCtrl('/speech/stop', body, res);
            }
        case '/speech/status':
            return { ok:true, status: recState, provider: getSttProvider() };

        case '/wakeup/reset':
            /* tells the webview to clear the cooldown lock so next load fires */
            return { ok:true, action:'clear localStorage.__cbWakeupLastFired in webview' };

        default:
            return { ok:false, error:'unknown: '+url };
    }
}

// ── Static file server for /lib/ ──────────────────────────────────────────
const MIME = { '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.woff2':'font/woff2' };
function serveStatic(url, res) {
    const rel = url.replace(/^\/lib\//, '');
    if (rel.includes('..') || rel.includes('/')) { res.writeHead(404); res.end('not found'); return true; }
    const fpath = path.join(CBE_DIR, 'lib', rel);
    if (!fs.existsSync(fpath)) { res.writeHead(404); res.end('not found'); return true; }
    const ext = path.extname(fpath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.writeHead(200);
    fs.createReadStream(fpath).pipe(res);
    return true;
}

// ── Server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/lib/')) { serveStatic(req.url, res); return; }
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        let p = {};
        try { if (body) p = JSON.parse(body); } catch(e) {}
        try {
            const result = await handleCtrl(req.url, p, res);
            res.writeHead(200);
            res.end(JSON.stringify({ ok:true, ...result }));
        } catch(e) {
            log('error: '+e.message);
            res.writeHead(500);
            res.end(JSON.stringify({ ok:false, error: e.message }));
        }
    });
});

server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
        log('Port '+CTRL_PORT+' already in use — another CBE instance running, exiting');
        process.exit(0);
    }
    log('server error: '+e.message);
});

server.listen(CTRL_PORT, '127.0.0.1', () => {
    log('CBE standalone server running on port '+CTRL_PORT);
    startWatchdog(); // auto-start watchdog on every boot
});

// Simple log server
http.createServer((req, res) => {
    cors(res); res.writeHead(200); res.end('ok');
}).listen(LOG_PORT, '127.0.0.1', () => log('log server on '+LOG_PORT));

