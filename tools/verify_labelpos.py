"""verify_labelpos.py — verify the panel.js single-source label-position layout
in the live NN agent browser. Loads a real token-substituted skin (so panel.js
actually runs), exercises applyLabelPos() for a left/center/right skin, reads
back the computed .prompt-meta-row justify-content + folder order, and grabs one
screenshot of the right-anchored case. Text-first so it's cheap to read."""
import sys, json, socket, base64, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_skin_preview as g  # reuse the token-substitution + temp-html prep

HOST, PORT = "127.0.0.1", 9785

def call(obj):
    s = socket.create_connection((HOST, PORT), timeout=40)
    f = s.makefile("rwb")
    f.write((json.dumps(obj) + "\n").encode()); f.flush()
    line = f.readline(); s.close()
    return json.loads(line.decode())

def ev(js):
    return call({"action": "eval_js", "js": js})

tmp = g._prepare_html("codex-black")
try:
    print("navigate:", call({"action": "navigate", "url": tmp.as_uri()}).get("ok"))
    call({"action": "wait", "ms": 1600})

    # Sanity: did panel.js inject the shared sheet + expose applyLabelPos?
    setup = ev("(function(){return JSON.stringify({"
               "sheet: !!document.getElementById('cbe-promptrow-shared'),"
               "fn: typeof applyLabelPos,"
               "metaRow: !!document.querySelector('.prompt-meta-row'),"
               "map: (typeof CBE_LABEL_POS!=='undefined')?Object.keys(CBE_LABEL_POS).length:-1"
               "});})()")
    print("setup:", setup.get("result"))

    # Layout is now a STACKED column (label on top, project-folder directly
    # under it) anchored to one of the 3 allowed spots via align-items.
    for skin, expect in [("terminal", "flex-start"), ("codex-black", "center"), ("tamagotchi", "flex-end")]:
        r = ev("(function(){"
               "document.body.setAttribute('data-skin','%s');"
               "applyLabelPos('%s');"
               "var row=document.querySelector('.prompt-meta-row');"
               "var pp=document.getElementById('project-path');"
               "var cs=row?getComputedStyle(row):{};"
               "var ppcs=pp?getComputedStyle(pp):{};"
               "return JSON.stringify({pos:document.body.getAttribute('data-cbe-label-pos'),"
               "dir:cs.flexDirection,align:cs.alignItems,folderOrder:ppcs.order});"
               "})()" % (skin, skin))
        got = r.get("result")
        ok = False
        if got:
            d = json.loads(got)
            ok = (d.get("align") == expect and d.get("dir") == "column" and d.get("folderOrder") == "1")
        print(f"  {skin:14s} -> {got}   {'OK' if ok else 'MISMATCH (expect align=%s dir=column folderOrder=1)' % expect}")

    # one screenshot of the right-anchored (tamagotchi) state
    shot = call({"action": "screenshot"})
    if shot.get("ok"):
        out = Path(__file__).resolve().parent / "_labelpos_right.png"
        out.write_bytes(base64.b64decode(shot["png_b64"]))
        print("screenshot:", out, shot.get("w"), shot.get("h"))
finally:
    try: tmp.unlink()
    except OSError: pass
