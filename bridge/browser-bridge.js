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
        try { if (fs.existsSync(p)) return path.normalize(p); } catch (e) {}
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

class BrowserBridge {
    constructor({ profileDir, startUrl, target, log = () => {} }) {
        this.profileDir = profileDir;
        this.startUrl = startUrl;
        this.target = target;   /* 'grok' | 'chatgpt' */
        this.log = log;
        this.proc = null;
        this.port = 0;
        this.page = null;
        this._launching = null;
    }

    isRunning() {
        return !!this.proc && this.proc.exitCode === null && this.page && !this.page._closed;
    }

    async ensureRunning() {
        if (this.isRunning()) return;
        if (this._launching) return this._launching;
        this._launching = this._doLaunch().finally(() => { this._launching = null; });
        return this._launching;
    }

    async _doLaunch() {
        this.port = await freePort();
        fs.mkdirSync(this.profileDir, { recursive: true });
        const exe = findBrowser();
        this.log(`launching browser exe=${exe} port=${this.port} profile=${this.profileDir} url=${this.startUrl}`);
        this.proc = cp.spawn(exe, [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=msEdgeNewTabPage,EdgeShoppingAssistant',
            `--remote-debugging-port=${this.port}`,
            `--user-data-dir=${this.profileDir}`,
            '--new-window',
            this.startUrl,
        ], {
            stdio: 'ignore',
            detached: false,
            windowsHide: false,
        });
        this.proc.on('exit', code => {
            this.log(`browser exited code=${code}`);
            this.proc = null;
            if (this.page) { try { this.page.close(); } catch (e) {} this.page = null; }
        });
        await waitForDebugger(this.port, 25000);
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

    dispose() {
        try { if (this.page) this.page.close(); } catch (e) {}
        this.page = null;
        try { if (this.proc) this.proc.kill(); } catch (e) {}
        this.proc = null;
    }
}

function hostFromUrl(u) {
    try { return new URL(u).hostname; } catch (e) { return ''; }
}

module.exports = { BrowserBridge, findBrowser };
