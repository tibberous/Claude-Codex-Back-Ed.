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

const DEFAULT_PORT = 8767;
const DEFAULT_TIMEOUT_MS = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    constructor({ superGrokRoot, target, log = () => {}, port = DEFAULT_PORT, pythonExe = '' }) {
        this.root = superGrokRoot;
        this.target = target;           /* 'grok' | 'chatgpt' | 'gemini' */
        this.log = log;
        this.port = port;
        this.pythonExe = pythonExe || pickPython();
        this._spawning = null;
    }

    /** Check if SuperGrok's resident service answers. Returns the status payload
     *  on success, or null when nothing's listening. */
    async status() {
        if (!await tcpProbe('127.0.0.1', this.port, 400)) return null;
        try {
            const resp = await tcpRequest({ action: 'status' }, { port: this.port, timeoutMs: 5000 });
            return resp || null;
        } catch (e) {
            this.log(`status probe failed: ${e.message}`);
            return null;
        }
    }

    /** Ensure SuperGrok service is up. If already running, no-op. Otherwise
     *  spawns `start.py --serve-bridge --target <t> --offscreen` and waits up
     *  to ~20s for the TCP port to come live. */
    async ensureRunning() {
        const s = await this.status();
        if (s) return s;
        if (this._spawning) return this._spawning;
        this._spawning = this._doSpawn().finally(() => { this._spawning = null; });
        return this._spawning;
    }

    async _doSpawn() {
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
            '--no-stale-process-kill',
        ];
        this.log(`spawning SuperGrok service: ${this.pythonExe} ${args.join(' ')}`);
        const proc = cp.spawn(this.pythonExe, args, {
            cwd: this.root,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
        });
        proc.unref();   /* let SuperGrok run independently of CBE's lifecycle */
        /* Poll the port for up to 25s — SuperGrok's Qt/WebEngine bootstrap is
           the slow part. */
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            await sleep(400);
            const s = await this.status();
            if (s) return s;
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
    async chat(message, { timeoutMs = 240000, attachments = [] } = {}) {
        await this.ensureRunning();
        const jobId = `cbe-${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
        const ack = await tcpRequest({
            action: 'chat',
            target: this.target,
            deployment: '',
            message,
            attachments,
            timeoutSeconds: Math.ceil(timeoutMs / 1000),
            async: true,
            jobId,
        }, { port: this.port, timeoutMs: 30000 });
        if (!ack || ack.ok === false) {
            throw new Error('SuperGrok rejected chat: ' + JSON.stringify(ack));
        }
        if (!ack.accepted) {
            /* Synchronous answer (older service shape). */
            if (ack.answer) return String(ack.answer).replace(/\r/g, '');
            throw new Error('SuperGrok ack did not accept job: ' + JSON.stringify(ack));
        }
        const ackJobId = ack.jobId || jobId;
        const deadline = Date.now() + timeoutMs + 15000;
        while (Date.now() < deadline) {
            await sleep(700);
            let res;
            try {
                res = await tcpRequest({ action: 'chat-result', jobId: ackJobId }, { port: this.port, timeoutMs: 15000 });
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
                /* Still working; loop. */
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

    dispose() {
        /* No-op: SuperGrok runs detached. Use bridge.shutdown() to stop the
           service explicitly (via tray icon, kill cmd, or a future shutdown
           action over TCP). */
    }
}

function pickPython() {
    /* Find a python.exe on PATH. CBE doesn't bundle one. */
    if (process.platform === 'win32') {
        const candidates = ['python.exe', 'python3.exe', 'py.exe'];
        for (const cand of candidates) {
            const where = require('child_process').spawnSync('where', [cand], { encoding: 'utf8' });
            if (where.status === 0 && where.stdout) {
                const first = where.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
                if (first && fs.existsSync(first)) return first;
            }
        }
    }
    return 'python';
}

module.exports = { SuperGrokBridge, tcpRequest, tcpProbe };
