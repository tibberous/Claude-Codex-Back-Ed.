/* Minimal Chrome DevTools Protocol client.
 *
 * Talks to a Chromium-family browser launched with --remote-debugging-port=N.
 * Operations needed by the web-bridge providers:
 *   - list targets (HTTP GET /json)
 *   - attach to a page target (WebSocket)
 *   - Runtime.evaluate with awaitPromise + returnByValue (for inject + read)
 *   - Page.navigate (used by openWebLogin to focus a tab)
 *
 * The full CDP surface is huge; we ship only what we need. Other ops are easy
 * to add: every call is `send(method, params)` returning a promise.
 */

const http = require('http');
const WebSocket = require('ws');

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                }
                try { resolve(JSON.parse(buf)); }
                catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Poll the debug endpoint until it answers or timeout. */
async function waitForDebugger(port, timeoutMs = 20000) {
    const start = Date.now();
    let lastErr;
    while (Date.now() - start < timeoutMs) {
        try {
            const v = await httpGet(`http://127.0.0.1:${port}/json/version`);
            return v;
        } catch (e) { lastErr = e; }
        await sleep(200);
    }
    throw new Error(`debugger never came up on port ${port}: ${lastErr && lastErr.message}`);
}

async function listTargets(port) {
    return httpGet(`http://127.0.0.1:${port}/json`);
}

/** Pick the most relevant page target (visible, matching URL fragment if given). */
function pickPageTarget(targets, hostHint) {
    const pages = targets.filter(t => t.type === 'page');
    if (!pages.length) return null;
    if (hostHint) {
        const matched = pages.find(t => (t.url || '').includes(hostHint));
        if (matched) return matched;
    }
    /* Otherwise the first page Chromium reports — which is usually the foreground tab. */
    return pages[0];
}

/** A live attached page session. */
class Page {
    constructor(target) {
        this.target = target;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();   /* method -> Set<fn> */
        this._closed = false;
    }

    async attach() {
        await new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.target.webSocketDebuggerUrl, {
                perMessageDeflate: false,
                maxPayload: 64 * 1024 * 1024,
            });
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
        });
        this.ws.on('message', data => this._onMessage(data));
        this.ws.on('close', () => {
            this._closed = true;
            for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
            this.pending.clear();
        });
        await this.send('Runtime.enable');
        await this.send('Page.enable');
    }

    _onMessage(raw) {
        let m;
        try { m = JSON.parse(raw.toString()); }
        catch (e) { return; }
        if (m.id != null && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(`CDP ${p.method}: ${m.error.message}`));
            else p.resolve(m.result);
            return;
        }
        if (m.method) {
            const lst = this.eventListeners.get(m.method);
            if (lst) for (const fn of lst) {
                try { fn(m.params); }
                catch (e) { console.error('[cbe.cdp] listener throw', m.method, e && e.message); }
            }
        }
    }

    send(method, params = {}) {
        if (this._closed) return Promise.reject(new Error('CDP closed'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    on(event, fn) {
        if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
        this.eventListeners.get(event).add(fn);
    }
    off(event, fn) {
        const s = this.eventListeners.get(event);
        if (s) s.delete(fn);
    }

    /** Run JS in the page and get the value back. Throws on page-side exceptions. */
    async evaluate(expression, { awaitPromise = true, timeout = 30000 } = {}) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise,
            timeout,
            userGesture: true,
        });
        if (res.exceptionDetails) {
            const ex = res.exceptionDetails;
            const detail = (ex.exception && (ex.exception.description || ex.exception.value))
                || ex.text || 'page exception';
            throw new Error('page eval: ' + detail);
        }
        return res.result && res.result.value;
    }

    async navigate(url) {
        return this.send('Page.navigate', { url });
    }

    close() {
        this._closed = true;
        try { this.ws && this.ws.close(); }
        catch (e) { console.error('[cbe.cdp] close.ws', e && e.message); }
    }
}

module.exports = { waitForDebugger, listTargets, pickPageTarget, Page };
