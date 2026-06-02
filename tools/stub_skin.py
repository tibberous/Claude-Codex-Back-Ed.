"""stub_skin.py — substitute {{...}} template placeholders in a CBE skin HTML
with local file:// paths so it renders standalone in the NN agent browser.
Usage: python tools/stub_skin.py skins/codex-black.html  -> writes a render stub
into the gitignored .skin_stubs/ dir (NEVER next to the source, so render-test
files never get committed alongside skins/*.html).
"""
import sys, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = (ROOT / "assets").as_uri()
STUB_DIR = ROOT / ".skin_stubs"

def stub(src: Path) -> Path:
    html = src.read_text(encoding="utf-8")
    repl = {
        "ASSETS_BASE": ASSETS,
        "PRISM_JS_URI": "",
        "PRISM_LANGS_URI": "",
        "SOUNDS_BASE": ASSETS,
        "HELP_URI": "",
    }
    for k, v in repl.items():
        html = html.replace("{{" + k + "}}", v)
    # blank out any remaining {{...}} placeholders
    html = re.sub(r"\{\{[^}]+\}\}", "", html)
    STUB_DIR.mkdir(exist_ok=True)
    out = STUB_DIR / (src.stem + ".stub.html")
    out.write_text(html, encoding="utf-8")
    return out

if __name__ == "__main__":
    for arg in sys.argv[1:]:
        p = Path(arg)
        if not p.is_absolute():
            p = ROOT / arg
        o = stub(p)
        print(o.as_uri())
