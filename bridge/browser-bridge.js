/* BrowserBridge — drives a real headed Chromium-family browser session.
 *
 * Spawns Edge with a CBE-owned --user-data-dir so the user's main Edge profile
 * is untouched. Login cookies persist across CBE sessions because the profile
 * dir survives between launches. Remote debugging is enabled on a free local
 * port; only 127.0.0.1 connections are accepted by Chromium.
 *
 * Lifecycle:
 *   const bridge = new BrowserBridge({ profileDir, startUrl, target });
 *   await bridge.ensureRunning();        // launch + attach (idempotent)
 *   await bridge.sendPrompt('hello');    // inject + submit
 *   for await (const delta of bridge.streamResponse()) yield delta;
 *   bridge.dispose();                    // kill Edge and close ws
 *
 * The bridge is stateful: one tab per target. Re-using the same profile
 * means cookies persist; closing CBE doesn't log the user out.
 */

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { waitForDebugger, listTargets, pickPageTarget, Page } = require('./cdp-client');
const { buildSendScript, buildReadScript, buildPingScript } = require('./dom-scripts');

/* We try Chrome before Edge because some Win10/11 boxes have a broken Edge
   install at `Program Files (x86)\Microsoft\Edge\...` that throws a side-by-side
   manifest error on launch. Any Chromium-family browser with `--remote-debugging-port`
   works for our CDP needs. */
const BROWSER_PATHS = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);

function findBrowser() {
    for (const p of BROWSER_PATHS) {
        try { if (fs.existsSync(p)) return path.normalize(p); } catch (e) { console.error('[cbe.bridge] findBrowser.exists', p, e && e.message); }
    }
    throw new Error('No Chromium browser found (tried: ' + BROWSER_PATHS.join(', ') + ')');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Quick TCP probe: is anything listening at host:port? Used to detect the
    NSSM-managed Chrome service before spawning a new one. */
function tcpProbe(host, port, timeoutMs = 600) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => {
            if (done) return; done = true;
            try { sock.destroy(); } catch (e) { console.error('[cbe.bridge] tcpProbe.destroy', e && e.message); }
            resolve(ok);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('error',   () => finish(false));
        sock.once('timeout', () => finish(false));
        try { sock.connect(port, host); } catch (e) { finish(false); }
    });
}

class BrowserBridge {
    constructor({ profileDir, startUrl, target, log = () => {}, servicePort = 0 }) {
        this.profileDir = profileDir;
        this.startUrl = startUrl;
        this.target = target;   /* 'grok' | 'chatgpt' */
        this.log = log;
        this.proc = null;
        this.port = 0;
        this.page = null;
        this._launching = null;
        /* If non-zero, BrowserBridge first tries to attach to an existing
           Chrome at 127.0.0.1:servicePort (installed by install_bridge_service.ps1
           as an NSSM service). Only if that attach fails does it fall back
           to spawning its own Chrome on a random port. */
        this.servicePort = Number(servicePort) || 0;
        /* True iff the current attach used the NSSM service rather than a
           bridge-spawned Chrome. Controls whether dispose() kills a process
           it doesn't own (we don't). */
        this.attachedToService = false;
    }

    isRunning() {
        if (this.page && !this.page._closed) {
            if (this.attachedToService) return true;
            return !!this.proc && this.proc.exitCode === null;
        }
        return false;
    }

    async ensureRunning() {
        if (this.isRunning()) return;
        if (this._launching) return this._launching;
        this._launching = this._doLaunch().finally(() => { this._launching = null; });
        return this._launching;
    }

    /** Attempt to attach to a Chrome already listening on 127.0.0.1:port —
        used to reuse the NSSM-managed service Chrome. Returns true on success
        (this.page is now live), false if the port doesn't answer or has no
        usable page target. */
    async _tryAttachExisting(port) {
        try {
            const alive = await tcpProbe('127.0.0.1', port, 600);
            if (!alive) return false;
            /* Probe /json/version too — a port could be open but not Chrome. */
            const targets = await listTargets(port).catch(() => null);
            if (!Array.isArray(targets) || !targets.length) return false;
            let target = pickPageTarget(targets, hostFromUrl(this.startUrl));
            if (!target) target = pickPageTarget(targets);
            if (!target || !target.webSocketDebuggerUrl) return false;
            this.page = new Page(target);
            await this.page.attach();
            /* Navigate to the provider URL so we have the right page even if
               the service Chrome started on about:blank. */
            try {
                const cur = await this.page.evaluate('location.href');
                if (typeof cur !== 'string' || !cur.startsWith(this.startUrl.replace(/\/$/, ''))) {
                    await this.page.navigate(this.startUrl);
                    const navStart = Date.now();
                    while (Date.now() - navStart < 12000) {
                        try {
                            const s = await this.page.evaluate(buildPingScript());
                            if (s && s.url && s.url !== 'about:blank' && s.ready === 'complete') break;
                        } catch (e) {}
                        await sleep(250);
                    }
                }
            } catch (e) { this.log(`service-attach navigate skipped: ${e.message}`); }
            this.port = port;
            this.attachedToService = true;
            this.proc = null;
            this.log(`attached to existing service Chrome at 127.0.0.1:${port} target=${target.url || '?'}`);
            return true;
        } catch (e) {
            this.log(`tryAttachExisting failed: ${e.message}`);
            return false;
        }
    }

    /* Per-provider Chrome launch log — sits next to the profile dir so it's
       easy to find and survives across launches (opened with 'a'). */
    _chromeLogPath() {
        return path.join(path.dirname(this.profileDir), `chrome-${this.target || 'bridge'}.log`);
    }

    /* Last N lines of the Chrome launch log — surfaced in the thrown error so
       the panel's error message shows Chrome's actual failure reason. */
    _chromeLogTail(lines) {
        try {
            const txt = fs.readFileSync(this._chromeLogPath(), 'utf8');
            const all = txt.split(/\r?\n/);
            return all.slice(-Math.max(1, lines || 20)).join('\n').trim() || '(chrome log empty)';
        } catch (e) {
            return `(no chrome log: ${e && e.message})`;
        }
    }

    /* Kill any Chrome/Edge process still holding THIS bridge's profile dir.
       Root cause of the "Chrome started on port A but we polled port B" bug:
       Chrome is single-instance per --user-data-dir. If a bridge Chrome from a
       previous (failed) attempt is still alive, the freshly-spawned chrome.exe
       just forwards its args to that old instance — which is listening on the
       OLD --remote-debugging-port — and exits. We poll the NEW port forever.
       The bridge profile dir is dedicated (web-profiles/<provider>/), so
       matching it in a process command line only ever hits bridge Chromes,
       never the user's real browser. Windows-only; no-op elsewhere. */
    _killStaleProfileChromes() {
        if (process.platform !== 'win32') return;
        try {
            const needle = String(this.profileDir).replace(/'/g, "''");
            const ps =
                `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" ` +
                `| Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } ` +
                `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId } catch {} }`;
            const out = cp.execFileSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', ps],
                { encoding: 'utf8', timeout: 8000, windowsHide: true },
            ).trim();
            if (out) this.log(`killed stale profile Chrome PID(s): ${out.split(/\s+/).filter(Boolean).join(',')}`);
        } catch (e) {
            this.log(`killStaleProfileChromes: ${e && e.message}`);
        }
    }

    /* Remove Chrome's profile singleton guards before a spawn. A crashed prior
       Chrome leaves these behind; the next launch then self-exits. Safe to
       delete — they're recreated on a clean launch. */
    _cleanProfileLocks() {
        const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
        for (const n of names) {
            const p = path.join(this.profileDir, n);
            try {
                if (fs.existsSync(p)) {
                    fs.rmSync(p, { force: true, recursive: false });
                    this.log(`removed stale profile lock: ${n}`);
                }
            } catch (e) {
                this.log(`could not remove stale lock ${n}: ${e && e.message}`);
            }
        }
    }

    async _doLaunch() {
        /* Prefer the NSSM-installed service Chrome at the fixed port. If the
           user has installed the bridge service for this provider, Chrome is
           already running at boot and we just CDP-attach — no spawn, no UAC,
           no fresh-profile login screen. Fall through to spawn if the port
           is dead (service not installed, or stopped, or crashed). */
        if (this.servicePort) {
            const attached = await this._tryAttachExisting(this.servicePort);
            if (attached) return;
            this.log(`servicePort ${this.servicePort} unreachable — falling back to ephemeral spawn`);
        }
        this.attachedToService = false;
        this.port = await freePort();
        fs.mkdirSync(this.profileDir, { recursive: true });
        /* Kill any LIVE bridge Chrome still holding this profile first — a
           leftover from a prior failed attempt is single-instance-squatting
           the dir, so the new chrome.exe just forwards args to it (on the OLD
           debug port) and exits. Then clear stale singleton lock files that a
           CRASHED prior Chrome left behind. Both produce the same downstream
           symptom: the debug port never opens and waitForDebugger fails with
           ECONNREFUSED / "browser process exited". Order matters — kill first,
           then the now-released lock files can be deleted. */
        this._killStaleProfileChromes();
        this._cleanProfileLocks();
        const exe = findBrowser();
        const args = [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=msEdgeNewTabPage,EdgeShoppingAssistant',
            `--remote-debugging-port=${this.port}`,
            `--remote-debugging-address=127.0.0.1`,
            `--user-data-dir=${this.profileDir}`,
            '--new-window',
            this.startUrl,
        ];
        /* Capture Chrome's own stdout/stderr to a per-provider log file.
           With stdio:'ignore' a failed launch is completely invisible — all we
           ever saw was the downstream ECONNREFUSED. With the log we get
           Chrome's actual complaint (profile lock, GPU process crash, an
           enterprise policy blocking --remote-debugging-port, etc). */
        const chromeLogPath = this._chromeLogPath();
        let chromeLogFd = null;
        try { chromeLogFd = fs.openSync(chromeLogPath, 'a'); }
        catch (e) { this.log(`chrome log open failed (${chromeLogPath}): ${e.message}`); }
        this.log(`launching browser exe=${exe} port=${this.port} profile=${this.profileDir} url=${this.startUrl} chromeLog=${chromeLogPath}`);
        this.log(`spawn args: ${args.join(' ')}`);
        this.proc = cp.spawn(exe, args, {
            stdio: chromeLogFd != null ? ['ignore', chromeLogFd, chromeLogFd] : 'ignore',
            detached: false,
            windowsHide: false,
        });
        this.log(`browser spawned pid=${this.proc.pid != null ? this.proc.pid : '<none>'}`);
        let exitedBeforeAttach = false;
        let exitCode = null;
        this.proc.on('exit', code => {
            exitCode = code;
            exitedBeforeAttach = (this.page == null);
            this.log(`browser exited code=${code}${exitedBeforeAttach ? ' (BEFORE CDP attach — launch failed)' : ''}`);
            this.proc = null;
            if (this.page) {
                try { this.page.close(); }
                catch (e) { console.error('[cbe.bridge] page.close on exit', e && e.message); }
                this.page = null;
            }
        });
        this.proc.on('error', err => {
            this.log(`browser spawn error: ${err && err.message}`);
        });
        try {
            /* Abort the wait the instant Chrome dies — no point polling a port
               for 25s when the process is already gone. */
            await waitForDebugger(this.port, 25000, () => this.proc != null && !exitedBeforeAttach);
        } catch (waitErr) {
            const tail = this._chromeLogTail(25);
            const reason = exitedBeforeAttach
                ? `Chrome exited (code ${exitCode}) before the debug port opened — usually a stale profile lock or an enterprise policy blocking --remote-debugging-port. Chrome log tail:\n${tail}`
                : `${waitErr.message}\nChrome log tail:\n${tail}`;
            this.log(`LAUNCH FAILED: ${reason}`);
            throw new Error(reason);
        }
        /* Give the new tab a moment to register; CDP /json sometimes returns
           the chrome:// blank page before the requested URL is loaded. */
        let target;
        const start = Date.now();
        while (Date.now() - start < 8000) {
            const targets = await listTargets(this.port);
            target = pickPageTarget(targets, hostFromUrl(this.startUrl)) || pickPageTarget(targets);
            if (target && target.webSocketDebuggerUrl) break;
            await sleep(150);
        }
        if (!target) throw new Error('no page target appeared after launch');
        this.page = new Page(target);
        await this.page.attach();
        this.log(`attached to ${target.url}`);
        /* Wait for the page to navigate away from about:blank and reach
           document.readyState === 'complete'. Caps at 12s — past that we
           proceed and let the per-action retries handle it. */
        const navStart = Date.now();
        while (Date.now() - navStart < 12000) {
            try {
                const s = await this.page.evaluate(buildPingScript());
                if (s && s.url && s.url !== 'about:blank' && s.ready === 'complete') break;
            } catch (e) { /* swallow during nav */ }
            await sleep(250);
        }
    }

    async ping() {
        await this.ensureRunning();
        return this.page.evaluate(buildPingScript());
    }

    async navigateHome() {
        await this.ensureRunning();
        await this.page.navigate(this.startUrl);
    }

    async sendPrompt(text) {
        await this.ensureRunning();
        const r = await this.page.evaluate(buildSendScript(this.target, text));
        if (!r || !r.ok) throw new Error('send failed: ' + (r && r.error || 'unknown'));
        this.log(`send dispatched via=${r.via} tag=${r.tag}`);
        return r;
    }

    /** Async generator: yield assistant text deltas until done or timeout.
     *  Polls the page DOM. Emits the cumulative-diff so each yield is just the
     *  new tail since the last poll. */
    async *streamResponse({ timeoutMs = 180000, pollMs = 450, stableMs = 1500 } = {}) {
        await this.ensureRunning();
        const start = Date.now();
        let prev = '';
        let lastChange = Date.now();
        let sawAnyText = false;
        while (Date.now() - start < timeoutMs) {
            let r;
            try { r = await this.page.evaluate(buildReadScript(this.target)); }
            catch (e) {
                /* Transient eval failures (e.g. page navigating) — retry briefly. */
                await sleep(pollMs);
                continue;
            }
            if (r && r.authBlocked) {
                throw new Error('Login required. Run "Claude Codex Black: Open Web Login" and sign in, then retry.');
            }
            const text = (r && typeof r.text === 'string') ? r.text : '';
            if (text && text !== prev) {
                sawAnyText = true;
                const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
                if (delta) yield delta;
                prev = text;
                lastChange = Date.now();
            }
            if (sawAnyText && r && r.done && Date.now() - lastChange > stableMs) {
                return;
            }
            await sleep(pollMs);
        }
        if (!sawAnyText) throw new Error('Timed out waiting for response. The site may be on a login wall — check the browser window.');
        /* Hit the timeout while still streaming. Emit nothing more and return; the
           caller still got whatever deltas streamed up to this point. */
    }

    async dispose() {
        /* Two modes:
           1. attachedToService=true → we don't own the Chrome process. Just
              close our CDP socket; the NSSM service stays running so the
              next attach is instant. Killing it would also crash the boot
              service.
           2. We spawned Chrome ourselves → graceful close so Chrome writes
              session cookies before exit. SIGTERM/proc.kill is the
              fallback if Chrome doesn't honor Browser.close in time;
              Chrome treats abrupt termination as a crash, marks
              profile.exit_type='Crashed', and disables session restore
              on the next launch (= login screen reappears). */
        if (this.attachedToService) {
            try { if (this.page) this.page.close(); }
            catch (e) { console.error('[cbe.bridge] dispose.page.close(service)', e && e.message); }
            this.page = null;
            return;
        }
        try { if (this.page) await this.page.browserClose(); }
        catch (e) { console.error('[cbe.bridge] dispose.browserClose', e && e.message); }
        try { if (this.page) this.page.close(); }
        catch (e) { console.error('[cbe.bridge] dispose.page.close', e && e.message); }
        this.page = null;
        const proc = this.proc;
        if (proc) {
            const exited = new Promise((resolve) => {
                if (proc.exitCode !== null) return resolve(true);
                proc.once('exit', () => resolve(true));
                setTimeout(() => resolve(false), 3500);
            });
            const ok = await exited;
            if (!ok) {
                try { proc.kill(); }
                catch (e) { console.error('[cbe.bridge] dispose.proc.kill', e && e.message); }
            }
        }
        this.proc = null;
    }
}

function hostFromUrl(u) {
    try { return new URL(u).hostname; } catch (e) { return ''; }
}

module.exports = { BrowserBridge, findBrowser };
