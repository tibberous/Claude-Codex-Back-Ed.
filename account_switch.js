/* account_switch.js — automated Claude account login orchestrator for CBE.
 *
 * CBE keeps ~11 Claude accounts so the user never sees a rate limit. When the
 * active account hits its cap, extension.js's rotateOnRateLimit() advances to
 * the next account and — for accounts that have NO stored apiKey (the
 * email/magic-link logins) — calls into here:
 *
 *     const accountSwitch = require('./account_switch.js');
 *     await accountSwitch.ensureClaudeAccountLogin(context, account, {
 *         extensionPath, postStatus,
 *     });
 *
 * Contract (do not break — extension.js depends on it):
 *   - module.exports.ensureClaudeAccountLogin(context, account, opts) -> Promise
 *   - MUST be safe to require even when incomplete: never throw on load.
 *   - On any unsupported / unfinished path, RESOLVE with
 *       { ok:false, needsManual:true, reason }
 *     rather than throwing. extension.js wraps the call in try/catch and falls
 *     through to the plain key-swap retry, so a rejected promise would only
 *     be logged — but resolving with a structured result is friendlier and
 *     lets the caller surface a precise status line.
 *   - opts.postStatus(text)   posts a status line to the chat UI (optional).
 *   - opts.extensionPath      the extension dir (also on context.extensionPath).
 *
 * ── The flow the user specified (their words, cleaned) ────────────────────
 *   "show Switching accounts…, then check email, find the Anthropic sign-in
 *    email, open the sign-in link, generate the OAuth URL with the code (the
 *    way Claude Code's login does), copy it into our app, load the page and
 *    fetch the activation, and drive it in an offscreen browser via JS."
 *
 * ── Credential approach: OAuth-token via the already-signed-in browser ────
 * We do NOT autofill credentials on every request (the user called raw JS
 * credential autofill "fragile af"). Instead the durable design is:
 *
 *   1. PER-ACCOUNT persistent offscreen browser profile
 *      (data/account-profiles/claude/<slug>/). A logged-in claude.ai session
 *      persists there, so later rotations just REUSE the profile and skip the
 *      whole email dance.
 *   2. ONE-TIME magic-link login per account (only if the profile's session
 *      is stale): fill email -> "Continue with email" -> claude.ai emails a
 *      magic link -> poll IMAP for it -> navigate the link -> signed in.
 *   3. Acquire a Claude Code-style PKCE OAuth token by driving the
 *      already-signed-in browser through claude.ai's /oauth/authorize consent
 *      page ("Authorize" button) and catching the ?code= on a localhost
 *      listener, then exchanging it for { access_token, refresh_token }.
 *      The token is stored on the account via extension.js's secret store
 *      (cbe.oauth.<providerId>.<accountId>.token). This is cleaner than
 *      cookie-scraping: it's a portable bearer credential CBE can present on
 *      the API path the same way Claude Code does.
 *
 * ── LIVE-VERIFIED vs STUBBED (recon run 2026-05-24, see SELECTORS below) ──
 *   LIVE-VERIFIED end-to-end in the nn4_agent_browser offscreen QtWebEngine:
 *     * claude.ai/login DOM selectors (email input + both Continue buttons).
 *     * Fill email + click "Continue with email" -> claude.ai sends the email
 *       and the page shows "click the link sent to <email>".
 *     * The magic-link email arrives within seconds; link shape is
 *       https://claude.ai/magic-link#<token>:<b64email> (FRAGMENT, not ?token=).
 *     * Navigating that link logs in and lands on claude.ai/new.
 *     * Session persists; navigating claude.ai/ when logged in -> /new
 *       (NOT /login). That's our fast "is the profile still valid" probe.
 *     * The OAuth authorize URL (claude.com/cai/oauth/authorize) redirects to
 *       claude.ai/oauth/authorize and renders the real consent page:
 *       "Claude Code would like to connect to your Claude chat account" with
 *       an "Authorize" and a "Decline" button.
 *   NOT-YET-EXECUTED (wired, needs one real run to confirm):
 *     * Clicking "Authorize" -> catching ?code= on the localhost listener ->
 *       exchanging at the token endpoint. The token endpoint URL in
 *       tools/claude_oauth.py is a best-guess (/cai/oauth/token) and must be
 *       confirmed against one real exchange. We never clicked Authorize during
 *       recon (it would burn a real auth code without a redirect listener
 *       bound to that account's profile).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

/* ── Constants ────────────────────────────────────────────────────────── */

const PROVIDER_ID = 'anthropic';            /* Claude's providerId in extension.js */

/* OAuth secret key prefix MUST match extension.js (OAUTH_SECRET_PREFIX). */
const OAUTH_SECRET_PREFIX = 'cbe.oauth.';   /* + <providerId>.<accountId>.token */
/* IMAP app-password secret prefix MUST match extension.js (EMAIL_SECRET_PREFIX). */
const EMAIL_SECRET_PREFIX = 'cbe.email.';   /* + <accountId> + '.password' */
const EMAIL_ACCOUNTS_SECTION = 'email_accounts';

/* nn4_agent_browser.py action server. The orchestrator spawns a per-account
 * instance on a private port so two rotations can't fight over one view. */
const NN4_HOST = '127.0.0.1';
const NN4_BASE_PORT = 9785;                 /* shared default; we offset per-account */
const NN4_DEVTOOLS_BASE_PORT = 9786;

/* OAuth localhost callback listener (claude_oauth.py owns the listener; we
 * just pick the port and tell the harness which redirect_uri to expect). */
const OAUTH_CALLBACK_PORT = 58957;

/* ── LIVE-OBSERVED SELECTORS ──────────────────────────────────────────────
 * Captured against https://claude.ai/login in the nn4 offscreen QtWebEngine
 * on 2026-05-24. If claude.ai changes its DOM, re-run the recon (navigate +
 * eval_js the inventory snippet in the recon notes) and update these.
 */
const SEL = {
    /* The email text input. id=email AND data-testid=email AND type=email all
     * present; we try all three for resilience. */
    emailInput: 'input#email, input[data-testid="email"], input[type="email"]',
    /* "Continue with email" — sends the magic link. */
    continueEmailBtn: 'button[data-testid="continue"]',
    /* "Continue with Google" — for the 7 Gmail accounts (NOT auto-driven; see
     * note in loginWithGoogle). */
    continueGoogleBtn: 'button[data-testid="login-with-google"]',
    /* OAuth consent "Authorize" button has no stable testid/aria — match by
     * visible text (handled in JS via XPath). */
    authorizeByText: 'Authorize',
};

/* claude.ai magic-link shape, LIVE-VERIFIED 2026-05-24. NOTE the '#': the link
 * is a fragment, e.g. https://claude.ai/magic-link#<hex>:<base64email>. The
 * old bridge_magic_login.py default ('magic-link?token=') would never match. */
const MAGIC_LINK_REGEX = 'https://claude\\.ai/magic-link#[^ "<>]+';
const ANTHROPIC_FROM_FILTER = 'anthropic.com';
/* Subject LIVE-VERIFIED: "Secure link to log in to Claude.ai". 'log in'
 * matches; the old 'sign in' default would miss it. We leave subject-filter
 * off and rely on from-filter + the link regex, which is the most robust. */

/* IMAP provider preset inference from an email address. Mirrors
 * extension.js seedAllEmailAccounts()'s pickProvider + imap_read.py presets.
 * Google-Workspace domains use Gmail's IMAP servers. */
const WORKSPACE_GMAIL_DOMAINS = new Set(['acquisitioninvest.com']);
function inferImapProvider(email) {
    const dom = String(email || '').split('@')[1] || '';
    const d = dom.toLowerCase();
    if (d === 'gmail.com' || WORKSPACE_GMAIL_DOMAINS.has(d)) return 'gmail';
    if (d === 'yahoo.com') return 'yahoo';
    if (d === 'hotmail.com' || d === 'outlook.com' || d === 'live.com') return 'outlook';
    return null;
}

/* ── Small helpers ────────────────────────────────────────────────────── */

function _log(msg) {
    /* extension.js has trace(); we can't import it (would create a cycle), so
     * log to stderr-ish console. The host captures extension console output. */
    try { console.log('[account_switch] ' + msg); } catch (_) { /* ignore */ }
}

function _slug(s) {
    return String(s || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
}

/* Resolve the bundled python.exe, else the py launcher (matches the pattern in
 * extension.js findPython()). Returns { cmd, prefixArgs }. */
function _resolvePython(extensionPath) {
    try {
        const bundled = path.join(extensionPath, 'resources', 'python', 'python.exe');
        if (fs.existsSync(bundled)) return { cmd: bundled, prefixArgs: [] };
    } catch (_) { /* ignore */ }
    if (process.platform === 'win32') return { cmd: 'py', prefixArgs: ['-3'] };
    return { cmd: 'python3', prefixArgs: [] };
}

/* Run a python tool and capture {code, stdout, stderr}. Secrets are passed via
 * env (NEVER on argv — argv is visible in tasklist). Never throws. */
function _runPython(extensionPath, scriptRelPath, args, extraEnv, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        try {
            const { cmd, prefixArgs } = _resolvePython(extensionPath);
            const script = path.isAbsolute(scriptRelPath)
                ? scriptRelPath
                : path.join(extensionPath, scriptRelPath);
            const argv = prefixArgs.concat([script], args || []);
            const env = Object.assign({}, process.env, extraEnv || {});
            const child = spawn(cmd, argv, { cwd: extensionPath, env });
            let out = '';
            let err = '';
            const killer = setTimeout(() => {
                try { child.kill(); } catch (_) { /* ignore */ }
                done({ code: -1, stdout: out, stderr: err + '\n[timeout]', timedOut: true });
            }, timeoutMs || 180000);
            child.stdout.on('data', (c) => { out += c.toString('utf8'); });
            child.stderr.on('data', (c) => { err += c.toString('utf8'); });
            child.on('error', (e) => {
                clearTimeout(killer);
                done({ code: -1, stdout: out, stderr: err + '\n' + (e && e.message || e), spawnError: true });
            });
            child.on('close', (code) => {
                clearTimeout(killer);
                done({ code, stdout: out, stderr: err });
            });
        } catch (e) {
            done({ code: -1, stdout: '', stderr: String(e && e.message || e), spawnError: true });
        }
    });
}

/* Parse the last JSON line of a tool's stdout (our tools print one JSON object
 * per line; the final line is the result). Returns null if unparseable. */
function _lastJson(stdout) {
    const lines = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch (_) { /* keep scanning up */ }
    }
    return null;
}

/* Newline-delimited JSON client for nn4_agent_browser.py. One action per call;
 * resolves with the parsed reply or { ok:false, error }. Never throws. */
function _nn4Call(port, action, fields, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        let buf = '';
        const sock = new net.Socket();
        const to = setTimeout(() => {
            try { sock.destroy(); } catch (_) { /* ignore */ }
            done({ ok: false, error: 'nn4 call timeout' });
        }, timeoutMs || 45000);
        sock.connect(port, NN4_HOST, () => {
            try {
                sock.write(JSON.stringify(Object.assign({ action }, fields || {})) + '\n');
            } catch (e) {
                clearTimeout(to);
                done({ ok: false, error: 'nn4 write failed: ' + (e && e.message || e) });
            }
        });
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const idx = buf.indexOf('\n');
            if (idx >= 0) {
                clearTimeout(to);
                const line = buf.slice(0, idx);
                try { done(JSON.parse(line)); }
                catch (e) { done({ ok: false, error: 'nn4 bad json: ' + (e && e.message || e), raw: line.slice(0, 300) }); }
                try { sock.end(); } catch (_) { /* ignore */ }
            }
        });
        sock.on('error', (e) => { clearTimeout(to); done({ ok: false, error: 'nn4 socket: ' + (e && e.message || e) }); });
        sock.on('close', () => { if (!settled) { clearTimeout(to); done({ ok: false, error: 'nn4 closed before reply' }); } });
    });
}

/* Is a TCP port already accepting connections on localhost? (Detect a
 * harness we can reuse vs. needing to spawn one.) */
function _portOpen(port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let resolved = false;
        const finish = (v) => { if (!resolved) { resolved = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
        sock.setTimeout(timeoutMs || 800);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, NN4_HOST);
    });
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ── Per-account profile dir (durable session) ────────────────────────────
 * Flat layout under the repo: data/account-profiles/claude/<slug>/. The
 * profile holds claude.ai cookies/localStorage so later rotations skip the
 * email dance. */
function _profileDir(extensionPath, account) {
    const slug = _slug(account.email || account.label || account.id);
    return path.join(extensionPath, 'data', 'account-profiles', 'claude', slug);
}

/* Spawn a per-account nn4_agent_browser pointed at this account's profile dir.
 * Returns { ok, port, devtoolsPort, child } or { ok:false, reason }. We pick a
 * private port offset by a hash of the slug so concurrent rotations don't
 * collide on 9785. Never throws. */
async function _spawnAccountBrowser(extensionPath, account) {
    const profileDir = _profileDir(extensionPath, account);
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) { /* ignore */ }

    /* Deterministic-ish private port from the slug so the same account reuses
     * the same port across rotations (a running instance can be reused). */
    const slug = _slug(account.email || account.id);
    let h = 0;
    for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) & 0xffff;
    const port = NN4_BASE_PORT + 100 + (h % 300);            /* 9885..10184 */
    const devtoolsPort = NN4_DEVTOOLS_BASE_PORT + 100 + (h % 300);

    /* Reuse a live harness on that port if one's already up for this account. */
    if (await _portOpen(port, 600)) {
        _log('reusing live nn4 harness on ' + port + ' for ' + slug);
        return { ok: true, port, devtoolsPort, reused: true, child: null };
    }

    try {
        const { cmd, prefixArgs } = _resolvePython(extensionPath);
        const script = path.join(extensionPath, 'tools', 'nn4_agent_browser.py');
        if (!fs.existsSync(script)) {
            return { ok: false, reason: 'nn4_agent_browser.py missing at ' + script };
        }
        const argv = prefixArgs.concat([
            script,
            '--port', String(port),
            '--devtools-port', String(devtoolsPort),
            '--start-url', 'https://claude.ai/',
        ]);
        const env = Object.assign({}, process.env, { NN4_PROFILE_DIR: profileDir });
        const child = spawn(cmd, argv, { cwd: extensionPath, env, detached: false });
        child.on('error', (e) => _log('nn4 spawn error: ' + (e && e.message || e)));
        child.stderr && child.stderr.on('data', () => { /* swallow Qt noise */ });

        /* Wait for the action port to come up (Qt + Chromium boot is slow). */
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (await _portOpen(port, 700)) {
                _log('nn4 harness up on ' + port + ' (profile ' + slug + ')');
                return { ok: true, port, devtoolsPort, reused: false, child };
            }
            await _sleep(500);
        }
        try { child.kill(); } catch (_) { /* ignore */ }
        return { ok: false, reason: 'nn4 harness did not bind ' + port + ' within 30s' };
    } catch (e) {
        return { ok: false, reason: 'spawn nn4 failed: ' + (e && e.message || e) };
    }
}

/* ── Stage 0: existing-token / live-session fast path ─────────────────────── */

/* True if a stored OAuth token looks usable (present + not obviously expired).
 * We can't fully validate without an API call; the request path will surface a
 * 401 and re-trigger login if the token is dead. */
async function _hasUsableToken(context, accountId) {
    try {
        const key = OAUTH_SECRET_PREFIX + PROVIDER_ID + '.' + accountId + '.token';
        const raw = await context.secrets.get(key);
        if (!raw) return false;
        let tok;
        try { tok = JSON.parse(raw); } catch (_) { return false; }
        if (!tok || !tok.access_token) return false;
        /* If we recorded an absolute expiry, honor it with a 5-min skew. */
        if (Number.isFinite(tok.expires_at) && Date.now() > (tok.expires_at - 300000)) return false;
        return true;
    } catch (_) { return false; }
}

/* Navigate the harness to claude.ai/ and report whether the session is logged
 * in. LIVE-VERIFIED: logged-in -> redirects to /new; logged-out -> /login. */
async function _sessionIsLoggedIn(port) {
    const nav = await _nn4Call(port, 'navigate', { url: 'https://claude.ai/', waitMs: 12000 }, 20000);
    if (!nav || !nav.ok) return { loggedIn: false, error: (nav && nav.error) || 'navigate failed' };
    await _nn4Call(port, 'wait', { ms: 2500 }, 6000);
    const u = await _nn4Call(port, 'page_url', {}, 8000);
    const url = (u && u.url) || '';
    return { loggedIn: !!url && !/\/login\b/.test(url), url };
}

/* ── Stage 1: magic-link login (one-time per account) ─────────────────────── */

/* Fill the email + click "Continue with email" so claude.ai sends the link.
 * Uses the native value setter so React registers the change. Returns
 * { ok } or { ok:false, error }. */
async function _submitEmailForMagicLink(port, email) {
    /* Ensure we're on the login page. */
    const nav = await _nn4Call(port, 'navigate', { url: 'https://claude.ai/login', waitMs: 12000 }, 20000);
    if (!nav || !nav.ok) return { ok: false, error: 'login nav failed: ' + (nav && nav.error) };
    await _nn4Call(port, 'wait', { ms: 2500 }, 6000);

    const js =
        '(function(){' +
        '  var e=document.querySelector(' + JSON.stringify(SEL.emailInput) + ');' +
        '  if(!e) return JSON.stringify({ok:false,err:"email input not found"});' +
        '  try{var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;setter.call(e,' + JSON.stringify(email) + ');}catch(_){e.value=' + JSON.stringify(email) + ';}' +
        '  e.dispatchEvent(new Event("input",{bubbles:true}));' +
        '  e.dispatchEvent(new Event("change",{bubbles:true}));' +
        '  var b=document.querySelector(' + JSON.stringify(SEL.continueEmailBtn) + ');' +
        '  if(!b) return JSON.stringify({ok:false,err:"continue-email button not found"});' +
        '  b.click();' +
        '  return JSON.stringify({ok:true});' +
        '})();';
    const r = await _nn4Call(port, 'eval_js', { js }, 15000);
    let res = r && r.result;
    if (typeof res === 'string') { try { res = JSON.parse(res); } catch (_) { /* leave */ } }
    if (!r || !r.ok || !res || !res.ok) {
        return { ok: false, error: (res && res.err) || (r && r.error) || 'fill/submit failed' };
    }
    return { ok: true };
}

/* Poll IMAP for the Anthropic magic-link via imap_read.py. The IMAP
 * app-password comes from the MATCHING email-account row's secret
 * (cbe.email.<id>.password) — see sourceImapPassword(). Returns
 * { ok, link } or { ok:false, error }. */
async function _pollMagicLink(context, extensionPath, account, opts) {
    const provider = inferImapProvider(account.email);
    if (!provider) return { ok: false, error: 'no IMAP provider preset for ' + account.email };

    const cred = await sourceImapPassword(context, account.email);
    if (!cred.ok) return { ok: false, error: cred.error };

    const envName = 'CBE_IMAP_PWD_SWITCH';
    const extraEnv = {};
    extraEnv[envName] = cred.password;

    const args = [
        '--provider', provider,
        '--email', account.email,
        '--password-env', envName,
        '--since-minutes', '6',
        '--from-filter', ANTHROPIC_FROM_FILTER,
        '--extract-links', MAGIC_LINK_REGEX,
        '--wait', String((opts && opts.imapWaitSeconds) || 90),
        '--poll', '4',
        '--max', '6',
    ];
    /* imap_read.py lives in the user's shared claude-tools dir; fall back to a
     * repo-local copy if present. */
    const sharedTool = path.join(process.env.USERPROFILE || (process.env.HOME || ''), 'claude-tools', 'imap_read.py');
    const repoTool = path.join(extensionPath, 'tools', 'imap_read.py');
    const tool = fs.existsSync(sharedTool) ? sharedTool : repoTool;

    const r = await _runPython(extensionPath, tool, args, extraEnv, ((opts && opts.imapWaitSeconds) || 90) * 1000 + 30000);
    const j = _lastJson(r.stdout);
    if (!j) return { ok: false, error: 'imap_read.py no JSON (code ' + r.code + '): ' + (r.stderr || '').slice(0, 200) };
    if (!j.ok) return { ok: false, error: 'imap_read.py: ' + (j.error || j.note || 'no match') };
    for (const em of (j.emails || [])) {
        for (const link of (em.links || [])) {
            if (/\/magic-link#/.test(link)) return { ok: true, link };
        }
    }
    return { ok: false, error: 'no magic-link in matched email(s)' };
}

/* Drive the harness to the magic link -> signs in. Returns { ok } / {ok:false}. */
async function _consumeMagicLink(port, link) {
    const nav = await _nn4Call(port, 'navigate', { url: link, waitMs: 15000 }, 25000);
    if (!nav || !nav.ok) return { ok: false, error: 'magic-link nav failed: ' + (nav && nav.error) };
    await _nn4Call(port, 'wait', { ms: 4000 }, 8000);
    const sess = await _sessionIsLoggedIn(port);
    return sess.loggedIn ? { ok: true } : { ok: false, error: 'still not logged in after magic link (url=' + sess.url + ')' };
}

/* ── Stage 2: OAuth-token acquisition via the signed-in browser ──────────────
 * tools/claude_oauth.py does the PKCE + localhost listener + token exchange and
 * drives the consent page over the SAME nn4 action protocol. Its `login`
 * subcommand: build URL -> navigate harness to authorize URL -> click
 * Authorize -> catch ?code= on the listener -> exchange. We point it at this
 * account's harness port. Returns the parsed { ok, token } or { ok:false }.
 *
 * NOT-YET-EXECUTED against a live consent click (see file header). Wired and
 * ready; the token endpoint in claude_oauth.py needs one real confirmation. */
async function _acquireOAuthToken(extensionPath, port, opts) {
    const args = [
        'login',
        '--port', String((opts && opts.callbackPort) || OAUTH_CALLBACK_PORT),
        '--nn4-port', String(port),
        '--timeout', '120',
    ];
    const r = await _runPython(extensionPath, path.join('tools', 'claude_oauth.py'), args, {}, 150000);
    const j = _lastJson(r.stdout);
    if (!j) return { ok: false, error: 'claude_oauth.py no JSON (code ' + r.code + '): ' + (r.stderr || '').slice(0, 200) };
    if (!j.ok) return { ok: false, error: 'claude_oauth.py: ' + (j.error || 'token flow failed'), phase: j.phase };
    return { ok: true, token: j.token };
}

/* ── IMAP app-password sourcing ───────────────────────────────────────────
 * Gmail/Yahoo IMAP need an APP PASSWORD, not the login password. Source of
 * truth: the email-account row whose email matches this LLM account's `email`,
 * with the app-password in VS Code secrets at cbe.email.<id>.password (written
 * by extension.js addEmailAccount). We find the matching row by reading the
 * [email_accounts] list from config.ini and matching on email.
 *
 * Returns { ok, password } or { ok:false, error }. */
async function sourceImapPassword(context, email) {
    try {
        if (!context || !context.secrets) return { ok: false, error: 'no context.secrets' };
        /* Read [email_accounts].list from config.ini. We avoid importing
         * extension.js (cycle); read the ini directly via a tiny parser. */
        const iniPath = path.join(context.extensionPath, 'config.ini');
        let listRaw = null;
        try {
            const txt = fs.readFileSync(iniPath, 'utf8');
            listRaw = _iniGet(txt, EMAIL_ACCOUNTS_SECTION, 'list');
        } catch (_) { /* ignore */ }
        if (!listRaw) return { ok: false, error: 'no [email_accounts].list in config.ini (open the Email panel to seed)' };
        let rows;
        try { rows = JSON.parse(listRaw); } catch (e) { return { ok: false, error: 'email_accounts JSON parse: ' + (e && e.message) }; }
        const row = (rows || []).find(a => a && a.email && a.email.toLowerCase() === String(email).toLowerCase());
        if (!row) return { ok: false, error: 'no email-account row for ' + email + ' (add it in the Email panel)' };
        const pw = await context.secrets.get(EMAIL_SECRET_PREFIX + row.id + '.password');
        if (!pw) return { ok: false, error: 'no stored IMAP password for ' + email };
        return { ok: true, password: pw, emailAccountId: row.id };
    } catch (e) {
        return { ok: false, error: 'sourceImapPassword: ' + (e && e.message || e) };
    }
}

/* Minimal INI getter: pull section.key out of raw text. config.ini values can
 * be long JSON blobs on one line, so we read to end-of-line. Returns null. */
function _iniGet(text, section, key) {
    const lines = String(text || '').split(/\r?\n/);
    let inSect = false;
    for (const line of lines) {
        const s = line.trim();
        if (/^\[.*\]$/.test(s)) { inSect = (s.slice(1, -1) === section); continue; }
        if (!inSect) continue;
        const eq = s.indexOf('=');
        if (eq < 0) continue;
        if (s.slice(0, eq).trim() === key) return s.slice(eq + 1).trim();
    }
    return null;
}

/* ── The exported entry point ─────────────────────────────────────────────── */

/* Ensure the given Claude account is logged in and has a usable credential.
 * Resolves with a structured result; NEVER rejects on a normal unsupported /
 * unfinished path. opts: { extensionPath, postStatus, imapWaitSeconds,
 * callbackPort, skipOAuth }. */
async function ensureClaudeAccountLogin(context, account, opts) {
    opts = opts || {};
    const post = (typeof opts.postStatus === 'function') ? opts.postStatus : function () {};
    const extensionPath = opts.extensionPath || (context && context.extensionPath);

    try {
        post('Switching accounts…');

        if (!account || account.type !== 'email_password' || !account.email) {
            return { ok: false, needsManual: true, reason: 'account is not an email_password login (nothing to do here)' };
        }
        if (!extensionPath) {
            return { ok: false, needsManual: true, reason: 'no extensionPath' };
        }
        if (!context || !context.secrets) {
            return { ok: false, needsManual: true, reason: 'no context.secrets (cannot read app passwords / store token)' };
        }

        /* Stage 0a — already have a usable OAuth token? Fast return. */
        if (await _hasUsableToken(context, account.id)) {
            post('Reusing saved session for ' + (account.label || account.email));
            return { ok: true, via: 'stored-oauth-token', account: account.id };
        }

        /* Spin up (or reuse) this account's persistent offscreen browser. */
        post('Opening secure browser for ' + (account.label || account.email) + '…');
        const browser = await _spawnAccountBrowser(extensionPath, account);
        if (!browser.ok) {
            return { ok: false, needsManual: true, reason: browser.reason };
        }
        const port = browser.port;

        /* Stage 0b — is the persisted session still logged in? If so, skip the
         * whole email dance and go straight to (optional) OAuth. */
        let loggedIn = false;
        const sess0 = await _sessionIsLoggedIn(port);
        loggedIn = sess0.loggedIn;
        if (loggedIn) {
            post('Existing session valid for ' + (account.label || account.email));
        }

        /* Stage 1 — magic-link login (only if the session is stale). The 7
         * Gmail accounts use "Continue with Google", which we don't auto-drive
         * (Google's flow has MFA/passkey friction the user called "fragile");
         * those accounts should be logged in once by hand into their profile,
         * after which Stage 0b reuses the session. We still attempt the
         * email/magic-link path for any address (it works for Gmail too —
         * claude.ai will email the magic link to a Gmail address), so this is
         * the durable, no-Google-popup route. */
        if (!loggedIn) {
            const provider = inferImapProvider(account.email);
            if (!provider) {
                return { ok: false, needsManual: true, reason: 'no IMAP preset for ' + account.email + ' (cannot read magic-link email)' };
            }
            post('Requesting sign-in link for ' + account.email + '…');
            const sub = await _submitEmailForMagicLink(port, account.email);
            if (!sub.ok) {
                return { ok: false, needsManual: true, reason: 'email submit failed: ' + sub.error, browserPort: port };
            }
            post('Checking inbox for Anthropic sign-in link…');
            const ml = await _pollMagicLink(context, extensionPath, account, opts);
            if (!ml.ok) {
                return { ok: false, needsManual: true, reason: 'magic-link not found: ' + ml.error, browserPort: port };
            }
            post('Opening sign-in link…');
            const con = await _consumeMagicLink(port, ml.link);
            if (!con.ok) {
                return { ok: false, needsManual: true, reason: 'magic-link login failed: ' + con.error, browserPort: port };
            }
            loggedIn = true;
            post('Signed in to claude.ai for ' + account.email);
        }

        /* Stage 2 — acquire an OAuth token from the signed-in session. This is
         * the durable credential extension.js will swap in. The consent-click +
         * exchange is wired but NOT-YET-EXECUTED against a live flow (token
         * endpoint unconfirmed). Gate it so a failure here still reports the
         * session as logged-in (cookie-jar reuse remains a valid fallback). */
        if (opts.skipOAuth) {
            return { ok: true, via: 'session-only', oauth: 'skipped', account: account.id, browserPort: port };
        }
        post('Authorizing CBE for ' + account.email + '…');
        const tok = await _acquireOAuthToken(extensionPath, port, opts);
        if (!tok.ok) {
            /* Session is logged in; OAuth not yet confirmed. Report logged-in so
             * the caller can choose to fall back to cookie-jar reuse. */
            return {
                ok: true,
                via: 'session-only',
                oauth: 'unconfirmed',
                oauthError: tok.error,
                needsManual: true,
                reason: 'logged in (session persisted) but OAuth token exchange not confirmed: ' + tok.error,
                account: account.id,
                browserPort: port,
            };
        }

        /* Persist the token on the account using extension.js's secret schema
         * so the request path / future fast-path can read it. */
        try {
            const token = Object.assign({}, tok.token);
            if (Number.isFinite(token.expires_in)) token.expires_at = Date.now() + token.expires_in * 1000;
            const key = OAUTH_SECRET_PREFIX + PROVIDER_ID + '.' + account.id + '.token';
            await context.secrets.store(key, JSON.stringify(token));
        } catch (e) {
            return { ok: true, via: 'oauth-token', stored: false, storeError: (e && e.message || e), account: account.id };
        }
        post('Account ' + (account.label || account.email) + ' ready.');
        return { ok: true, via: 'oauth-token', stored: true, account: account.id };
    } catch (e) {
        /* Absolute safety net — the contract says never throw out of here. */
        _log('ensureClaudeAccountLogin unexpected: ' + (e && e.stack || e));
        return { ok: false, needsManual: true, reason: 'unexpected: ' + (e && e.message || e) };
    }
}

module.exports = {
    ensureClaudeAccountLogin,
    /* Exported for tests / the standalone CLI below. */
    sourceImapPassword,
    inferImapProvider,
    SEL,
    MAGIC_LINK_REGEX,
};

/* ── Standalone smoke CLI ──────────────────────────────────────────────────
 * `node account_switch.js --self-test` checks the module loads and the python
 * tools it depends on are present, WITHOUT touching VS Code secrets or driving
 * a real login. Safe to run anytime. */
if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--self-test')) {
        const extPath = __dirname;
        const checks = {
            'tools/nn4_agent_browser.py': fs.existsSync(path.join(extPath, 'tools', 'nn4_agent_browser.py')),
            'tools/claude_oauth.py': fs.existsSync(path.join(extPath, 'tools', 'claude_oauth.py')),
            'imap_read.py (shared)': fs.existsSync(path.join(process.env.USERPROFILE || process.env.HOME || '', 'claude-tools', 'imap_read.py')),
            'config.ini': fs.existsSync(path.join(extPath, 'config.ini')),
        };
        console.log('account_switch self-test:');
        for (const k of Object.keys(checks)) console.log('  [' + (checks[k] ? 'ok' : '--') + '] ' + k);
        console.log('  inferImapProvider("x@yahoo.com") =', inferImapProvider('x@yahoo.com'));
        console.log('  inferImapProvider("x@gmail.com")  =', inferImapProvider('x@gmail.com'));
        console.log('  inferImapProvider("admin@acquisitioninvest.com") =', inferImapProvider('admin@acquisitioninvest.com'));
        console.log('  MAGIC_LINK_REGEX =', MAGIC_LINK_REGEX);
        process.exit(0);
    }
    console.log('account_switch.js — require this module and call ensureClaudeAccountLogin(context, account, opts).');
    console.log('Run with --self-test to verify dependencies.');
}
