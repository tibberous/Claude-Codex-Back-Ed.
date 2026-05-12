/* Standalone smoke test for the CDP path. Not shipped — run from CLI:
 *     node bridge/_smoke.js
 * Launches Edge against about:blank in a throwaway profile, evals
 * `1+document.title.length`, prints it, kills Edge.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BrowserBridge } = require('./browser-bridge');

(async () => {
    const profile = path.join(os.tmpdir(), 'cbe-smoke-' + Date.now());
    const bridge = new BrowserBridge({
        profileDir: profile,
        startUrl: 'https://example.com/',
        target: 'grok',
        log: (m) => console.log('[bridge]', m),
    });
    try {
        await bridge.ensureRunning();
        const ping = await bridge.ping();
        console.log('ping:', ping);
        const r = await bridge.page.evaluate('({title: document.title, h1: (document.querySelector("h1")||{}).innerText})');
        console.log('eval result:', r);
        console.log('SMOKE OK');
    } catch (e) {
        console.error('SMOKE FAIL:', e.message);
        process.exitCode = 1;
    } finally {
        bridge.dispose();
        /* Best-effort wipe of throwaway profile. */
        setTimeout(() => {
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
            process.exit(process.exitCode || 0);
        }, 800);
    }
})();
