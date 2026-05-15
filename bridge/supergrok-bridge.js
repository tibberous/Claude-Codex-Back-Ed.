/* SuperGrokBridge — talks to SuperGrok's resident bridge service over TCP.
 *
 * Unlike BrowserBridge (which drives Chromium directly via CDP), this adapter
 * delegates everything to SuperGrok. SuperGrok already owns the logged-in
 * QWebEngine session for each provider it supports (grok / chatgpt / gemini /
 * future). CBE just sends JSON-over-TCP to 127.0.0.1:8767 and gets answers back.
 *
 * Lifecycle:
 *   const bridge = new SuperGrokBridge({ superGrokRoot, target, log });
 *   await bridge.ensureRunning();         // start service offscreen if needed
 *   for await (const delta of bridge.chat(msg)) yield delta;
 *   await bridge.openLoginWindow();       // user signs in (visible)
 *
 * Wire format: newline-terminated JSON. Action 'status' → service health.
 * Action 'chat' with async=true → returns {accepted, jobId}; then poll
 * 'chat-result' until {accepted:false, ok, answer}. SuperGrok's start.py uses
 * the same protocol in bridgeRequest(), so this is just a JS port.
 */

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_PORT = 8788;        /* matches config.ini [bridge] port=8788 */
const DEFAULT_HOST = '127.0.0.1'; /* matches config.ini [bridge] host=127.0.0.1 */
const DEFAULT_TIMEOUT_MS = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Read the live bridge transport from <superGrokRoot>/port.txt. start.py
 *  writes this atomically after the bridge service confirms it's listening,
 *  so reading it tells us exactly where the service is right now — no
 *  scanning, no guessing, no stale-config drift. Returns {host, port, pid, ts}
 *  on success, or null if the file is missing/malformed. Format on disk:
 *      host=127.0.0.1 port=8788 pid=12345 ts=2026-05-15T10:32:01.123
 */
function readPortFile(superGrokRoot) {
    try {
        const p = path.join(superGrokRoot, 'port.txt');
        if (!fs.existsSync(p)) return null;
        const text = fs.readFileSync(p, 'utf8').trim();
        if (!text) return null;
        const out = {};
        for (const tok of text.split(/\s+/)) {
            const [k, v] = tok.split('=', 2);
            if (k && v !== undefined) out[k] = v;
        }
        const port = parseInt(out.port, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
        return { host: out.host || DEFAULT_HOST, port, pid: out.pid || '', ts: out.ts || '' };
    } catch (e) {
        return null;
    }
}

/** Probe if anything is listening on a TCP port. Doesn't validate protocol. */
function tcpProbe(host, port, timeoutMs = 500) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (e) { console.error('[cbe.supergrok] tcpProbe.destroy', e && e.message); } resolve(ok); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('error', () => finish(false));
        sock.once('timeout', () => finish(false));
        try { sock.connect(port, host); } catch (e) { finish(false); }
    });
}

/** Send one newline-delimited JSON request, read one newline-delimited response.
 *  This mirrors SuperGrok's start.py:bridgeRequest() byte-for-byte. */
function tcpRequest(payload, { host = '127.0.0.1', port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        let received = '';
        let settled = false;
        const finish = (err, val) => {
            if (settled) return; settled = true;
            try { sock.destroy(); } catch (e) { console.error('[cbe.supergrok] tcpRequest.destroy', e && e.message); }
            if (err) reject(err); else resolve(val);
        };
        sock.setTimeout(timeoutMs);
        sock.once('error', err => finish(err));
        sock.once('timeout', () => finish(new Error(`tcp timeout after ${timeoutMs}ms`)));
        sock.on('data', chunk => {
            received += chunk.toString('utf8');
            const nl = received.indexOf('\n');
            if (nl < 0) return;
            const line = received.slice(0, nl);
            try { finish(null, JSON.parse(line)); }
            catch (e) { finish(new Error('malformed JSON from SuperGrok: ' + e.message)); }
        });
        sock.once('connect', () => {
            const body = JSON.stringify(payload) + '\n';
            sock.write(body);
        });
        sock.connect(port, host);
    });
}

class SuperGrokBridge {
    constructor({ superGrokRoot, target, log = () => {}, port = null, host = null, pythonExe = '' }) {
        this.root = superGrokRoot;
        this.target = target;           /* 'grok' | 'chatgpt' | 'gemini' (no Claude bridge) */
        this.log = log;
        // Port resolution order: explicit arg > port.txt published by start.py > DEFAULT_PORT.
        // Same for host. This keeps the JS client locked to wherever the Python
        // side is actually listening, even when start.py's incremental fallback
        // moved off the canonical port.
        const fromFile = readPortFile(superGrokRoot);
        this.port = port || (fromFile && fromFile.port) || DEFAULT_PORT;
        this.host = host || (fromFile && fromFile.host) || DEFAULT_HOST;
        if (fromFile) {
            this.log(`SuperGrok port.txt → host=${fromFile.host} port=${fromFile.port} pid=${fromFile.pid} ts=${fromFile.ts}`);
        }
        this.pythonExe = pythonExe || pickPython();
        this._spawning = null;
    }

    /** Re-read port.txt on every transport operation so the JS side picks up
     *  a server restart that moved to a new port. Cheap (single fs.readFileSync).
     *  Updates this.port/this.host in place and returns them. */
    refreshPortFromFile() {
        const fromFile = readPortFile(this.root);
        if (fromFile && (fromFile.port !== this.port || fromFile.host !== this.host)) {
            this.log(`SuperGrok port.txt changed → host=${fromFile.host} port=${fromFile.port}`);
            this.port = fromFile.port;
            this.host = fromFile.host;
        }
        return { host: this.host, port: this.port };
    }

    /** Check if SuperGrok's resident service answers. Returns the status payload
     *  on success, or null when nothing's listening. Always re-reads port.txt
     *  first so we hit the server's current port even after a restart. */
    async status() {
        const { host, port } = this.refreshPortFromFile();
        if (!await tcpProbe(host, port, 400)) return null;
        try {
            const resp = await tcpRequest({ action: 'status' }, { host, port, timeoutMs: 5000 });
            return resp || null;
        } catch (e) {
            this.log(`status probe failed: ${e.message}`);
            return null;
        }
    }

    /** Ensure SuperGrok service is up. If already running, no-op. Otherwise
     *  spawns `start.py --serve-bridge --target <t> --offscreen` and waits up
     *  to ~25s for the TCP port to come live. `onProgress(step)` is called
     *  with human-readable status strings so the panel can show what's
     *  happening instead of looking hung. */
    async ensureRunning(onProgress = () => {}) {
        onProgress('Checking SuperGrok service…');
        const s = await this.status();
        if (s) { onProgress('SuperGrok service already running.'); return s; }
        if (this._spawning) { onProgress('Waiting for SuperGrok to finish starting…'); return this._spawning; }
        this._spawning = this._doSpawn(onProgress).finally(() => { this._spawning = null; });
        return this._spawning;
    }

    async _doSpawn(onProgress = () => {}) {
        const startPy = path.join(this.root, 'start.py');
        if (!fs.existsSync(startPy)) {
            throw new Error(`SuperGrok start.py not found at ${startPy}`);
        }
        const args = [
            startPy,
            '--serve-bridge',
            '--target', this.target,
            '--bridge-port', String(this.port),
            '--offscreen',
        ];
        this.log(`spawning SuperGrok service: ${this.pythonExe} ${args.join(' ')}`);
        onProgress(`Starting SuperGrok server (${this.target})…`);
        const proc = cp.spawn(this.pythonExe, args, {
            cwd: this.root,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
        });
        proc.unref();   /* let SuperGrok run independently of CBE's lifecycle */
        /* If the python binary is bad (e.g. a broken py-launcher shim), spawn
           emits 'error' asynchronously — capture it so we fail loud instead
           of silently polling a port nothing will ever bind. */
        let spawnErr = null;
        proc.once('error', (e) => { spawnErr = e; });
        /* Poll the port for up to 25s — SuperGrok's Qt/WebEngine bootstrap is
           the slow part. Emit a ticking progress line so the panel shows life. */
        const startedAt = Date.now();
        const deadline = startedAt + 25000;
        while (Date.now() < deadline) {
            await sleep(400);
            if (spawnErr) {
                throw new Error(`SuperGrok python failed to launch: ${spawnErr.message}. ` +
                    `pythonExe=${this.pythonExe}`);
            }
            const s = await this.status();
            if (s) { onProgress('SuperGrok server is up.'); return s; }
            const secs = Math.round((Date.now() - startedAt) / 1000);
            onProgress(`Starting SuperGrok server… (${secs}s)`);
        }
        throw new Error('SuperGrok service did not come up within 25s. Check C:/SuperGrok/logs/bridge_service.log');
    }

    /** Spawn a VISIBLE login window for this target. Non-blocking — returns
     *  once the spawn fires; user clicks through OAuth themselves. Cookies
     *  persist in SuperGrok's profile dir. */
    async openLoginWindow() {
        const startPy = path.join(this.root, 'start.py');
        if (!fs.existsSync(startPy)) throw new Error(`start.py not found at ${startPy}`);
        const flag = ({ chatgpt: '--chatgpt', grok: '--chat', gemini: '--gemini' })[this.target] || '--chat';
        const args = this.target === 'grok'
            ? [startPy, '--serve-bridge', '--show-bridge', '--target', 'grok']
            : [startPy, flag];
        this.log(`spawning SuperGrok login window: ${args.join(' ')}`);
        const proc = cp.spawn(this.pythonExe, args, {
            cwd: this.root,
            stdio: 'ignore',
            detached: true,
            windowsHide: false,   /* MUST be visible for login */
        });
        proc.unref();
        return { pid: proc.pid };
    }

    /** Synchronous chat: send one user turn, get the full assistant reply.
     *  Uses async=true under the hood so we don't tie up the TCP socket while
     *  SuperGrok streams; we poll chat-result until done.
     *
     *  Returns the full answer string. Throws on error/auth-blocked. */
    /** Direct CLI shell-out: `python start.py --<target> "<message>"`.
     *  SuperGrok's start.py spawns its own QWebEngine page, drives the DOM,
     *  captures the answer, prints it to stdout (line 1824: print(answer,
     *  flush=True)) and exits. We just capture stdout. Slower per-call than
     *  a resident TCP service (each call cold-starts the browser, ~30-60s)
     *  but bulletproof — there's no service-startup race, no port conflict,
     *  no pickPython shim weirdness inside a long-lived service. */
    async chatViaCli(message, { onProgress = () => {}, timeoutMs = 240000 } = {}) {
        const startPy = path.join(this.root, 'start.py');
        if (!fs.existsSync(startPy)) throw new Error(`SuperGrok start.py not found at ${startPy}`);
        /* target → CLI flags. Grok uses "--chat grok <msg>"; the others use
           a single dedicated flag. Mirrors SuperGrok argparse. */
        const flagsForTarget = {
            grok:    ['--chat', 'grok'],
            chatgpt: ['--chatgpt'],
            gemini:  ['--gemini'],
        };
        const flags = flagsForTarget[this.target] || ['--chat', this.target];
        const args = [startPy, ...flags, message, '--no-stale-process-kill'];
        onProgress(`Launching SuperGrok (${this.target}) — cold start may take 30-60s…`);
        this.log(`CLI spawn: ${this.pythonExe} ${args.join(' ')}`);
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let lastProgressTick = Date.now();
            const proc = cp.spawn(this.pythonExe, args, {
                cwd: this.root,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGTERM'); } catch (_) {}
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000);
                reject(new Error(`SuperGrok CLI timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            proc.on('error', (e) => {
                clearTimeout(killTimer);
                reject(new Error(`SuperGrok CLI launch failed: ${e.message}. pythonExe=${this.pythonExe}`));
            });
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            proc.stderr.on('data', (chunk) => {
                const s = chunk.toString('utf8');
                stderr += s;
                /* Throttle progress to one tick/sec to avoid spamming the
                   panel. Surface the LAST non-empty line as a status string. */
                const now = Date.now();
                if (now - lastProgressTick > 1000) {
                    const lines = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
                    if (lines.length) {
                        const tail = lines[lines.length - 1];
                        if (tail.length > 4) {
                            lastProgressTick = now;
                            onProgress(tail.slice(0, 160));
                        }
                    }
                }
            });
            proc.on('exit', (code) => {
                clearTimeout(killTimer);
                if (code !== 0) {
                    /* Show the last ~400 chars of stderr — usually the real error. */
                    const tail = stderr.replace(/\r/g, '').trim().slice(-400) || '(no stderr)';
                    return reject(new Error(`SuperGrok CLI exit ${code}\n${tail}`));
                }
                /* Clean stdout by removing status/progress/debug lines that got mixed in.
                   Status lines have recognizable prefixes: [TRACE:, [LOG:, [STATUS:, [WARN:, [ERROR:, [PHASE:, [profile], [INFO:, [DEBUG:, [bridge-client], etc.
                   Keep only lines that don't start with [ followed by a tag name. */
                const cleaned = stdout.replace(/\r/g, '').split('\n')
                    .filter(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return false;  /* Skip empty lines */
                        /* Skip status/debug lines (start with [ and look like [TAG:...) */
                        if (trimmed.match(/^\[([A-Za-z\-:]+)\]/)) return false;
                        return true;
                    })
                    .join('\n')
                    .trim();
                if (!cleaned) {
                    return reject(new Error('SuperGrok CLI returned no answer after filtering status output (likely needs a one-time visible login: ' +
                        `python ${startPy} ${flags[0]}${flags[1] ? ' ' + flags[1] : ''})`));
                }
                resolve(cleaned);
            });
        });
    }

    async chat(message, { timeoutMs = 240000, attachments = [], onProgress = () => {} } = {}) {
        /* Primary path: CLI shell-out (always works if start.py works). The
           old TCP-service path is kept below as a fallback for users who
           install the NSSM service (tools/install_supergrok_service.ps1)
           since that's faster per-call when warm. */
        try {
            return await this.chatViaCli(message, { onProgress, timeoutMs });
        } catch (cliErr) {
            this.log(`CLI failed, falling back to TCP service: ${cliErr.message}`);
            onProgress(`CLI path failed — trying resident TCP service…`);
        }
        /* Settings-only policy: do NOT auto-spawn the bridge here. The bridge
           must already be installed + running via the Settings provider
           dropdown (which fires installBridgeServiceFor). If the user lands
           in chat() with no bridge running, error out cleanly so the panel
           shows a real "pick a provider in Settings" message instead of
           silently popping a QtWebEngine window. */
        const _bridgeStatus = await this.status();
        if (!_bridgeStatus) {
            throw new Error(`No ${this.target} bridge running. Open CBE Settings, pick a ${this.target} provider — that installs and starts the bridge as a Windows service. The bridge stays up until you click Close in its tray icon.`);
        }
        onProgress(`Sending message to ${this.target}…`);
        const jobId = `cbe-${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
        const xport = this.refreshPortFromFile();
        const ack = await tcpRequest({
            action: 'chat',
            target: this.target,
            deployment: '',
            message,
            attachments,
            timeoutSeconds: Math.ceil(timeoutMs / 1000),
            async: true,
            jobId,
        }, { host: xport.host, port: xport.port, timeoutMs: 30000 });
        if (!ack || ack.ok === false) {
            throw new Error('SuperGrok rejected chat: ' + JSON.stringify(ack));
        }
        if (!ack.accepted) {
            /* Synchronous answer (older service shape). */
            if (ack.answer) return String(ack.answer).replace(/\r/g, '');
            throw new Error('SuperGrok ack did not accept job: ' + JSON.stringify(ack));
        }
        const ackJobId = ack.jobId || jobId;
        onProgress(`Waiting for ${this.target} to respond…`);
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs + 15000;
        while (Date.now() < deadline) {
            await sleep(700);
            let res;
            try {
                res = await tcpRequest({ action: 'chat-result', jobId: ackJobId }, { host: this.host, port: this.port, timeoutMs: 15000 });
            } catch (e) {
                this.log(`chat-result poll failed: ${e.message} (will retry)`);
                continue;
            }
            if (!res) continue;
            if (res.ok === false) {
                /* Service doesn't know the job — fatal. */
                throw new Error(res.error || 'SuperGrok lost the job');
            }
            if (res.pending === true) {
                /* Still working; loop. Tick a progress line every few seconds. */
                const secs = Math.round((Date.now() - startedAt) / 1000);
                if (secs > 0 && secs % 3 === 0) onProgress(`Waiting for ${this.target} to respond… (${secs}s)`);
                continue;
            }
            if (res.pending === false && res.result) {
                /* Final. result has {ok, answer, error, hint, ...} from the chat job. */
                const r = res.result;
                if (!r.ok) {
                    throw new Error(r.hint || r.error || 'SuperGrok chat failed');
                }
                return String(r.answer || '').replace(/\r/g, '');
            }
            /* Unknown shape — log and continue. */
            this.log(`chat-result unknown shape: ${JSON.stringify(res).slice(0, 200)}`);
        }
        throw new Error(`SuperGrok chat timed out after ${timeoutMs}ms`);
    }

    /** Generator wrapper so the existing chatStream contract in extension.js
     *  works unchanged. SuperGrok doesn't stream over TCP — it returns the full
     *  answer when done — so we yield one chunk. */
    async* chatStream(message, opts = {}) {
        const answer = await this.chat(message, opts);
        if (answer) yield answer;
    }

    /** Generator that yields {progress} status objects AS THEY HAPPEN, then a
     *  final {text} object with the answer. The caller can render progress
     *  lines transiently and the text as the actual reply. This is what the
     *  panel uses so a slow cold-start doesn't look hung. */
    async* chatStreamWithProgress(message, opts = {}) {
        const queue = [];
        let waiter = null;
        const push = (v) => { queue.push(v); if (waiter) { const w = waiter; waiter = null; w(); } };
        const onProgress = (step) => push({ progress: step });
        /* Kick the chat off; it drains progress into the queue, then the answer. */
        const done = this.chat(message, { ...opts, onProgress })
            .then((answer) => push({ text: answer || '', __done: true }))
            .catch((err) => push({ __err: err }));
        for (;;) {
            if (queue.length) {
                const v = queue.shift();
                if (v.__err) throw v.__err;
                if (v.__done) { if (v.text) yield { text: v.text }; return; }
                yield v;
            } else {
                await new Promise((r) => { waiter = r; });
            }
        }
        /* (done is awaited implicitly via the queue drain above) */
        void done;
    }

    dispose() {
        /* No-op: SuperGrok runs detached. Use bridge.shutdown() to stop the
           service explicitly (via tray icon, kill cmd, or a future shutdown
           action over TCP). */
    }
}

function pickPython() {
    /* Find a python.exe on PATH that ACTUALLY RUNS. CBE doesn't bundle one.
       The bare `python.exe` on this machine is often a broken launcher shim
       (resolves to a non-existent `C:\PythonNN\python.exe`), so each
       candidate is validated by running `--version` — a shim that points at
       a missing interpreter fails this and gets skipped. The `py` launcher
       is tried first because it's the most reliable on Windows. */
    const run = (exe, args) => {
        try { return require('child_process').spawnSync(exe, args, { encoding: 'utf8', timeout: 5000 }); }
        catch (e) { return { status: -1, error: e }; }
    };
    const works = (exe) => {
        const r = run(exe, ['--version']);
        return r && r.status === 0 && /python\s*3/i.test((r.stdout || '') + (r.stderr || ''));
    };
    if (process.platform === 'win32') {
        /* `py -3` first — the Windows launcher rarely breaks. */
        if (works('py')) return 'py';
        const candidates = ['python.exe', 'python3.exe'];
        for (const cand of candidates) {
            const where = run('where', [cand]);
            if (where.status === 0 && where.stdout) {
                for (const line of where.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
                    if (fs.existsSync(line) && works(line)) return line;
                }
            }
        }
        if (works('python')) return 'python';
        /* Last resort — let spawn fail loudly with a clear error rather than
           silently hanging on a port nothing binds. */
        return 'py';
    }
    return 'python3';
}

module.exports = { SuperGrokBridge, tcpRequest, tcpProbe };
