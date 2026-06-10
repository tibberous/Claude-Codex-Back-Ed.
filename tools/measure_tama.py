"""measure_tama.py — offscreen QtWebEngine render of a skin to MEASURE the
tamagotchi pet widget: does #cbe-tama-shell scroll (scrollHeight>clientHeight)?
and verify the .prompt-meta-row label/folder STACK + anchor. Text-first output
plus a PNG screenshot of the live pet for visual confirmation.

Usage: python tools/measure_tama.py [skin_id]   (default: tamagotchi)
"""
import sys, os, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_skin_preview as g

SKIN = sys.argv[1] if len(sys.argv) > 1 else "tamagotchi"
RW, RH = 900, 1200

g._ensure_deps()
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--disable-gpu --no-sandbox --disable-software-rasterizer")
from PySide6.QtCore import QUrl, QTimer, QRect
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

tmp = g._prepare_html(SKIN)
app = QApplication.instance() or QApplication(sys.argv[:1])
view = QWebEngineView(); view.resize(RW, RH); view.move(-32000, -32000); view.show()

PROBE = r"""
(function(){
  try {
    document.body.setAttribute('data-skin', '%s');
    if (typeof applyLabelPos === 'function') applyLabelPos('%s');
    var shell = document.getElementById('cbe-tama-shell');
    if (shell) { shell.hidden = false; shell.removeAttribute('hidden'); }
    var out = {};
    if (shell) {
      var cs = getComputedStyle(shell);
      out.shell = {
        scrollH: shell.scrollHeight, clientH: shell.clientHeight,
        scrollW: shell.scrollWidth, clientW: shell.clientWidth,
        vScroll: shell.scrollHeight > shell.clientHeight + 1,
        hScroll: shell.scrollWidth  > shell.clientWidth  + 1,
        overflow: cs.overflow, maxH: cs.maxHeight, pos: cs.position,
        w: cs.width, h: cs.height
      };
    } else { out.shell = 'MISSING'; }
    var row = document.querySelector('.prompt-meta-row');
    var pp  = document.getElementById('project-path');
    var lp  = document.getElementById('label-pill');
    if (row) {
      var rcs = getComputedStyle(row);
      out.metaRow = { dir: rcs.flexDirection, align: rcs.alignItems,
        labelPos: document.body.getAttribute('data-cbe-label-pos') };
      if (pp && lp) {
        var pr = pp.getBoundingClientRect(), lr = lp.getBoundingClientRect();
        out.metaRow.folderBelowLabel = pr.top >= lr.bottom - 2;
        out.metaRow.labelTop = Math.round(lr.top);
        out.metaRow.folderTop = Math.round(pr.top);
      }
    } else { out.metaRow = 'MISSING'; }
    return JSON.stringify(out);
  } catch(e){ return JSON.stringify({err: String(e)}); }
})()
""" % (SKIN, SKIN)

def done():
    def cb(res):
        print("MEASURE[%s]:" % SKIN, json.dumps(json.loads(res), indent=2) if res else res)
        out = Path(__file__).resolve().parent / ("_tama_%s.png" % SKIN)
        view.resize(RW, RH)
        pix = view.grab(QRect(0, 0, RW, RH))
        pix.save(str(out), "PNG")
        print("screenshot:", out)
        app.quit()
    view.page().runJavaScript(PROBE, cb)

view.loadFinished.connect(lambda ok: QTimer.singleShot(1400, done))
QTimer.singleShot(20000, lambda: (print("TIMEOUT"), app.quit()))
view.load(QUrl.fromLocalFile(str(tmp)))
app.exec()
try: tmp.unlink()
except OSError: pass
