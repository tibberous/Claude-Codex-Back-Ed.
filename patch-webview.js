/**
 * patch-webview.js — bundles all injects/ directly into Claude Code's webview index.js
 * No fetch/CSP issues — everything runs inline via nonce'd script tags.
 * Run:  node patch-webview.js
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXT_ROOT    = path.join(os.homedir(), '.vscode', 'extensions');
const INJECTS_DIR = path.join(__dirname, 'injects');
const LOG_PORT    = 57836;
const CTRL_PORT   = 57837;

// ── Read all inject files at patch time ──────────────────────────────────────
function loadInjects() {
    if (!fs.existsSync(INJECTS_DIR)) return [];
    return fs.readdirSync(INJECTS_DIR)
        .filter(f => f.endsWith('.js') || f.endsWith('.css'))
        .sort()
        .map(f => ({ name: f, content: fs.readFileSync(path.join(INJECTS_DIR, f), 'utf8') }));
}

// ── Bootstrap — tiny inline poller. Pulls /injects/bundle from CBE ctrl server,
//     re-executes when manifest version changes. Each inject IIFE is idempotent.
//     This eliminates the need to reload the webview on every inject change.
function buildBootstrap(injects) {
    return `(function(){
  if(window.__cbPoller)return;
  window.__cbPoller=true;
  var CTRL='http://127.0.0.1:${CTRL_PORT}';
  var applied=0;
  console.error('[cb-boot] poller starting, CTRL='+CTRL);
  async function tick(){
    try{
      var mr=await fetch(CTRL+'/injects/manifest',{cache:'no-store'});
      if(!mr.ok)throw new Error('manifest http '+mr.status);
      var m=await mr.json();
      if(m.version!==applied){
        var br=await fetch(CTRL+'/injects/bundle',{cache:'no-store'});
        if(!br.ok)throw new Error('bundle http '+br.status);
        var code=await br.text();
        try{(new Function(code))();}catch(e){console.error('[cb-boot] bundle exec error:',e);}
        applied=m.version;
        console.error('[cb-boot] applied v='+m.version+' files='+(m.files||[]).length);
      }
    }catch(e){
      console.error('[cb-boot] tick error:',e&&e.message);
    }
    setTimeout(tick,2000);
  }
  // Smoke test: red outline so we know the poller bootstrap ran
  document.documentElement.style.outline='4px solid red';
  setTimeout(function(){document.documentElement.style.outline='';},3000);
  tick();
})();
`;
}

// ── Inline SVGs ──────────────────────────────────────────────────────────────
const SVG_BUBBLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" style="display:block"><path d="M2 3a1 1 0 011-1h14a1 1 0 011 1v9a1 1 0 01-1 1H7l-5 4V3z"/></svg>';
const SVG_REC    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="15" height="15" style="display:block"><circle cx="10" cy="10" r="8" fill="#e53e3e"/></svg>';
const SVG_ERR    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="15" height="15" style="display:block"><line x1="5" y1="5" x2="15" y2="15" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/><line x1="15" y1="5" x2="5" y2="15" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/></svg>';

const COMPONENT_DEF = `
var __cbBubble='${SVG_BUBBLE}';
var __cbRec='${SVG_REC}';
var __cbErr='${SVG_ERR}';

function CodexBlackMicBtn(){
  var R=E3.default;
  var[active,setActive]=R.useState(false);
  var[icon,setIcon]=R.useState("bubble");
  var[errTip,setErrTip]=R.useState("");
  var recRef=R.useRef(null);

  function log(msg){
    console.error("[codex-black]",msg);
    try{fetch("http://127.0.0.1:${LOG_PORT}",{method:"POST",mode:"no-cors",body:String(msg)});}catch(e){}
    (window.__cbLog=window.__cbLog||[]).push(new Date().toISOString()+" "+msg);
  }

  function showErr(err){
    log("ERR: "+err);setIcon("err");setErrTip(err);setActive(false);
    setTimeout(function(){setIcon("bubble");setErrTip("");},5000);
  }

  function pasteAndSubmit(txt){
    log("pasteAndSubmit: "+JSON.stringify(txt.slice(0,80)));
    if(typeof window.__cbPaste==='function'){window.__cbPaste(txt);}
    else{log("pasteAndSubmit: __cbPaste not loaded yet");}
  }

  function startSapi(){
    log("startSapi");setIcon("rec");setActive(true);
    fetch("http://127.0.0.1:${CTRL_PORT}/speech/start",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
      .then(function(){
        var poll=setInterval(function(){
          fetch("http://127.0.0.1:${CTRL_PORT}/speech/status")
            .then(function(r){return r.json();})
            .then(function(d){
              if(d.status==="idle"&&active){
                clearInterval(poll);setActive(false);setIcon("bubble");
              }
              if(d.status==="done"||d.text){
                clearInterval(poll);setActive(false);setIcon("bubble");
                if(d.text){log("SAPI text: "+d.text);pasteAndSubmit(d.text);}
              }
            }).catch(function(){clearInterval(poll);setActive(false);setIcon("bubble");});
        },600);
      }).catch(function(e){showErr("SAPI start failed: "+e);});
  }

  function start(){
    var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){log("no SR — using SAPI");startSapi();return;}
    log("start SR");
    var r=new SR();
    r.lang=navigator.language||"en-US";r.continuous=true;r.interimResults=false;
    r.onstart=function(){log("SR onstart");setIcon("rec");};
    r.onresult=function(e){
      var txt="";
      for(var i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)txt+=e.results[i][0].transcript+" ";}
      txt=txt.trim();if(!txt)return;
      log("SR result: "+txt);pasteAndSubmit(txt);
    };
    r.onerror=function(e){
      if(e.error==="no-speech")return;
      if(e.error==="not-allowed"||e.error==="service-not-allowed"){log("SR denied — SAPI");startSapi();}
      else showErr(e.error);
    };
    r.onend=function(){log("SR onend");setActive(false);setIcon("bubble");};
    try{recRef.current=r;r.start();setActive(true);}catch(ex){showErr("start threw: "+ex);}
  }

  function stop(){
    log("stop");
    if(recRef.current){recRef.current.stop();recRef.current=null;}
    fetch("http://127.0.0.1:${CTRL_PORT}/speech/stop",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).catch(function(){});
    setActive(false);setIcon("bubble");
  }

  var iconHtml=icon==="rec"?__cbRec:icon==="err"?__cbErr:__cbBubble;
  return E3.default.createElement("button",{
    type:"button",
    title:errTip||(active?"Click to stop recording":"Voice input"),
    onClick:active?stop:start,
    style:{background:"none",border:"none",cursor:"pointer",padding:"3px 5px",lineHeight:1,
      opacity:active?1:0.75,transition:"opacity .15s",display:"flex",alignItems:"center",
      animation:active?"__micPulse 1s ease-in-out infinite":""}
  },E3.default.createElement("span",{dangerouslySetInnerHTML:{__html:iconHtml}}));
}
`;

// ── Search / replace markers ──────────────────────────────────────────────────
const BEFORE_KT1  = 'function Kt1({onInsertAtMention:$,onAttachFile:Z,browserIntegrationSupported:J,onTerminalCollaborator:Y})';
const KT1_USAGE   = 'createElement(Kt1,{onInsertAtMention:V,onAttachFile:U,browserIntegrationSupported:H,onTerminalCollaborator:void 0}),';
const KT1_REPLACE = KT1_USAGE + 'o9.default.createElement(CodexBlackMicBtn,null),';
const SENTINEL    = '__cbPoller';

// ── Main ──────────────────────────────────────────────────────────────────────
let patched = 0, skipped = 0, failed = 0;

const injects = loadInjects();
console.log(`Loaded ${injects.length} injects: ${injects.map(i => i.name).join(', ')}`);

const BOOTSTRAP = buildBootstrap(injects);

const dirs = fs.readdirSync(EXT_ROOT)
    .filter(d => d.startsWith('anthropic.claude-code-'))
    .map(d => path.join(EXT_ROOT, d));

if (!dirs.length) { console.error('No anthropic.claude-code-* found in', EXT_ROOT); process.exit(1); }

for (const dir of dirs) {
    const file = path.join(dir, 'webview', 'index.js');
    if (!fs.existsSync(file)) { console.log(`SKIP: ${path.basename(dir)}`); continue; }

    let src = fs.readFileSync(file, 'utf8');

    if (src.includes(SENTINEL)) {
        const bak = file + '.original.bak';
        if (fs.existsSync(bak)) { src = fs.readFileSync(bak, 'utf8'); console.log(`  restoring backup: ${path.basename(dir)}`); }
        else { console.log(`ALREADY PATCHED (no bak): ${path.basename(dir)}`); skipped++; continue; }
    }

    if (!src.includes(BEFORE_KT1)) { console.log(`WARN: Kt1 marker missing: ${path.basename(dir)}`); failed++; continue; }
    if (!src.includes(KT1_USAGE))  { console.log(`WARN: Kt1 usage missing: ${path.basename(dir)}`);  failed++; continue; }

    const bak = file + '.original.bak';
    if (!fs.existsSync(bak)) { fs.copyFileSync(file, bak); console.log(`  backed up`); }

    // Component def goes before Kt1; bootstrap goes at END of file so DOM is ready
    src = src.replace(BEFORE_KT1, COMPONENT_DEF + BEFORE_KT1);
    src = src.replace(KT1_USAGE, KT1_REPLACE);
    src = src + '\n' + BOOTSTRAP;

    fs.writeFileSync(file, src, 'utf8');
    console.log(`PATCHED: ${path.basename(dir)} (${injects.length} injects bundled inline)`);
    patched++;
}

console.log(`\nDone: ${patched} patched, ${skipped} skipped, ${failed} failed.`);

// ── Patch Anthropic extension.js — panel title + inline bootstrap injection ──
for (const dir of dirs) {
    const extJs = path.join(dir, 'extension.js');
    if (!fs.existsSync(extJs)) continue;

    const extBak = extJs + '.original.bak';
    let extSrc = fs.existsSync(extBak) ? fs.readFileSync(extBak, 'utf8') : fs.readFileSync(extJs, 'utf8');

    let extChanged = false;

    // 1. Rename panel title
    const OLD_TITLE = '"claudeVSCodePanel","Claude Code"';
    const NEW_TITLE = '"claudeVSCodePanel","Claude Codex Black Ed."';
    if (extSrc.includes(OLD_TITLE)) {
        extSrc = extSrc.replace(OLD_TITLE, NEW_TITLE);
        extChanged = true;
        console.log('PATCHED extension.js: panel title → "Claude Codex Black Ed."');
    } else {
        console.log('extension.js: panel title marker not found (already patched or changed)');
    }

    // 2. Inject bootstrap as inline <script nonce="${q}"> in the HTML template.
    //    We insert before the first </body> which is inside the getHtmlForWebview template literal.
    //    At runtime ${q} evaluates to the correct nonce — guaranteed CSP-allowed execution.
    //    We must escape backticks and ${ sequences so they don't break the template literal.
    if (!extSrc.includes('__cbPoller')) {
        const BOOTSTRAP_ESC = BOOTSTRAP
            .replace(/\\/g, '\\\\')       // escape backslashes first
            .replace(/`/g, '\\`')          // escape backticks (would end the template literal)
            .replace(/\$\{/g, '\\${');     // escape ${ (would be evaluated as template expression)

        // The getHtmlForWebview template ends with:
        //   type="module"></script>\n      </body>\n      </html>`
        // This is UNIQUE to that template (j20 doesn't have type="module").
        // We insert our inline script AFTER the module script tag, before </body>.
        const ANCHOR = 'type="module"></script>';
        const INLINE_SCRIPT = ANCHOR + '\n        <script nonce="' + '${q}' + '">\n' + BOOTSTRAP_ESC + '\n        </script>';

        const anchorIdx = extSrc.indexOf(ANCHOR);
        if (anchorIdx !== -1) {
            extSrc = extSrc.slice(0, anchorIdx) + INLINE_SCRIPT + extSrc.slice(anchorIdx + ANCHOR.length);
            extChanged = true;
            console.log('PATCHED extension.js: bootstrap injected as inline nonce script (after module script)');
        } else {
            console.log('WARN extension.js: module script anchor not found — inline inject skipped');
        }
    } else {
        console.log('extension.js: inline bootstrap already present');
    }

    // 3. Patch CSP to allow connect-src to our localhost ports
    const CSP_OLD = `default-src 'none'; \${D}; \${M}; \${w}; script-src 'nonce-\${q}'; \${G};`;
    const CSP_NEW = `default-src 'none'; \${D}; \${M}; \${w}; script-src 'nonce-\${q}' 'unsafe-eval'; \${G}; connect-src http://127.0.0.1:57835 http://127.0.0.1:57836 http://127.0.0.1:57837;`;
    if (extSrc.includes(CSP_OLD)) {
        extSrc = extSrc.replace(CSP_OLD, CSP_NEW);
        extChanged = true;
        console.log('PATCHED extension.js: CSP expanded to allow 57836/57837');
    } else if (!extSrc.includes('57836') || !extSrc.includes('connect-src')) {
        console.log('WARN extension.js: CSP marker not found — localhost fetches may be blocked');
    } else {
        console.log('extension.js: CSP already patched');
    }

    if (extChanged) {
        if (!fs.existsSync(extBak)) { fs.copyFileSync(path.join(dir, 'extension.js'), extBak); console.log('  extension.js backed up'); }
        fs.writeFileSync(extJs, extSrc, 'utf8');
    }
}

// ── Clear VSCode CachedData so patched extension.js is recompiled on next load ─
const cachedData = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'CachedData');
let cleared = 0;
if (fs.existsSync(cachedData)) {
    for (const entry of fs.readdirSync(cachedData)) {
        try { fs.rmSync(path.join(cachedData, entry), { recursive: true, force: true }); cleared++; } catch(e) {}
    }
}
console.log(`Cleared CachedData: ${cleared} entries removed`);

if (patched > 0) console.log('→ Reload VSCode window (Ctrl+Shift+P → Developer: Reload Window)');
