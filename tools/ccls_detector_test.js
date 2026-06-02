/* ccls_detector_test.js — unit + live check for the CCLS output-stream
   session-limit detector added to extension.js.

   Mirrors the exact CCLS_LIMIT_RE + cclsTextHasLimit predicate from
   extension.js (they're module-internal, so we re-declare the identical
   source here) and proves:
     1. the canonical cap sentence MATCHES,
     2. all tolerant variants MATCH,
     3. normal assistant output does NOT match,
     4. the switch GET path actually reaches the live :3333 service.

   Run: node tools/ccls_detector_test.js
*/
'use strict';

/* ── verbatim copy of the detector regex + predicate from extension.js ── */
const CCLS_LIMIT_RE = new RegExp(
    'hit your session limit'                          + '|' +
    'session limit\\s*[·:]\\s*resets'            + '|' +
    "you'?ve hit your (usage|session) limit"          + '|' +
    'weekly (usage|session) limit'                    + '|' +
    'rate_?limit_?exceeded'                           + '|' +
    'usage limit reached',
    'i'
);
function cclsTextHasLimit(text) {
    return !!(text && CCLS_LIMIT_RE.test(String(text)));
}

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name); }
}

console.log('— MUST MATCH —');
[
    'You\'ve hit your session limit · resets 1:50am (America/New_York)',
    'you\'ve hit your session limit · resets 3:10am (America/New_York)',
    'You\'ve hit your usage limit · resets May 25, 12am',
    'session limit: resets 6am',
    'weekly session limit reached',
    'weekly usage limit',
    'Error: rate_limit_exceeded',
    'ratelimitexceeded',   /* rate_?limit_?exceeded — underscores optional */
    'usage limit reached for this account',
].forEach((s) => ok(JSON.stringify(s.slice(0, 48)), cclsTextHasLimit(s)));

console.log('— MUST NOT MATCH (normal output) —');
[
    'Here is the function you asked for. It limits the array to 10 items.',
    'The session started fine and everything resets cleanly on reboot.',
    'I set a rate limiter on the API but it is not exceeded yet.',
    'Done. No issues found.',
    '',
    null,
    undefined,
].forEach((s) => ok(JSON.stringify(String(s).slice(0, 48)), !cclsTextHasLimit(s)));

(async () => {
    console.log('— LIVE switch GET (proves call path) —');
    const url = process.env.CCLS_SWITCH_URL || 'http://127.0.0.1:3333/switch';
    try {
        const res = await fetch(url, { method: 'GET' });
        const body = (await res.text()).slice(0, 200);
        console.log(`  switch GET ${url} -> HTTP ${res.status}`);
        console.log('  body: ' + body);
        ok('switch endpoint reachable (any HTTP status proves the path)', true);
    } catch (e) {
        console.log('  switch GET failed: ' + ((e && e.message) || e));
        ok('switch endpoint reachable', false);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
