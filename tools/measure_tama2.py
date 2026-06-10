"""measure_tama2.py — like measure_tama.py but ROBUST against the offscreen
harness failing to auto-run the deferred panel.js: if applyLabelPos is missing
we inject panel.js source synchronously, then exercise applyLabelPos for each of
the 3 allowed anchor positions and report the stacked-column geometry +
scrollbar state. Verifies BOTH the no-scroll fix and the label/folder stacking.
"""
import sys, os, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_skin_preview as g

SKIN = sys.argv[1] if len(sys.argv) > 1 else "tamagotchi"
RW, RH = 900, 1200
PANEL_JS = (Path(__file__).resolve().parent.parent / "panel" / "panel.js").read_text(encoding="utf-8")

g._ensure_deps()
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--disable-gpu --no-sandbox --disable-software-rasterizer")
from PySide6.QtCore import QUrl, QTimer, QRect
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

tmp = g._prepare_html(SKIN)
app = QApplication.instance() or QApplication(sys.argv[:1])
view = QWebEngineView(); view.resize(RW, RH); view.move(-32000, -32000); view.show()

def run_probe():
    page = view.page()
    def after_inject(_):
        probe = r"""
        (function(){
          var res = {skin: "%s", positions: {}};
          var shell = document.getElementById('cbe-tama-shell');
          if (shell) { shell.hidden = false; shell.removeAttribute('hidden'); }
          if (shell) {
            res.petScroll = {
              vScroll: shell.scrollHeight > shell.clientHeight + 1,
              hScroll: shell.scrollWidth  > shell.clientWidth  + 1,
              scrollH: shell.scrollHeight, clientH: shell.clientHeight,
              overflow: getComputedStyle(shell).overflow,
              maxH: getComputedStyle(shell).maxHeight
            };
          }
          res.hasFn = (typeof applyLabelPos);
          res.hasSheet = !!document.getElementById('cbe-promptrow-shared');
          var posMap = {'left':'flex-start','center':'center','right':'flex-end'};
          for (var key in posMap) {
            try {
              document.body.setAttribute('data-skin','%s');
              if (typeof applyLabelPos === 'function') {
                document.body.setAttribute('data-cbe-label-pos', key);
                if (typeof ensurePromptRowSharedCss === 'function') ensurePromptRowSharedCss();
              }
              var row = document.querySelector('.prompt-meta-row');
              var lp = document.getElementById('label-pill');
              var pp = document.getElementById('project-path');
              var rcs = row ? getComputedStyle(row) : {};
              var entry = { dir: rcs.flexDirection, align: rcs.alignItems };
              if (lp && pp) {
                var lr = lp.getBoundingClientRect(), pr = pp.getBoundingClientRect();
                entry.folderBelowLabel = pr.top >= lr.bottom - 2;
              }
              res.positions[key] = entry;
            } catch(e) { res.positions[key] = {err:String(e)}; }
          }
          return JSON.stringify(res);
        })()
        """ % (SKIN, SKIN)
        def show(r):
            print("RESULT:", json.dumps(json.loads(r), indent=2) if r else r)
            out = Path(__file__).resolve().parent / ("_tama2_%s.png" % SKIN)
            view.resize(RW, RH); view.grab(QRect(0,0,RW,RH)).save(str(out), "PNG")
            print("screenshot:", out); app.quit()
        page.runJavaScript(probe, show)
    # Inject panel.js only if the deferred load didn't run.
    page.runJavaScript("typeof applyLabelPos", lambda t: (
        after_inject(None) if t == "function"
        else page.runJavaScript(PANEL_JS, after_inject)))

view.loadFinished.connect(lambda ok: QTimer.singleShot(1400, run_probe))
QTimer.singleShot(20000, lambda: (print("TIMEOUT"), app.quit()))
view.load(QUrl.fromLocalFile(str(tmp)))
app.exec()
try: tmp.unlink()
except OSError: pass
