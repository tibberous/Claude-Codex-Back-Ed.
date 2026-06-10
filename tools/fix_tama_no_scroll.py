"""fix_tama_no_scroll.py — add `overflow:hidden` to the baseline #cbe-tama-shell
rule across panel/index.html + every skins/<id>.html so the floating pet widget
can never raise a scrollbar (Trent 2026-06-02: "the pet has scrollbars").

The baseline rule sizes the shell to its content (no max-height), so the only
way a scrollbar appears is a stray sub-pixel spill — clipping it is the
belt-and-suspenders guard. Idempotent: skips files already carrying the marker.

CRLF-aware (skins are CRLF on disk under core.autocrlf=true): preserves each
file's dominant EOL so git sees ONLY this one-line change.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [ROOT / "panel" / "index.html"] + sorted((ROOT / "skins").glob("*.html"))

# The exact tail of the baseline #cbe-tama-shell rule (LF-normalized).
OLD = (
    "      box-shadow: 0 12px 32px rgba(0,0,0,0.55);\n"
    "      border-radius: 14px;\n"
    "      user-select: none;\n"
    "    }\n"
    "    #cbe-tama-shell[hidden] { display: none !important; }"
)
NEW = (
    "      box-shadow: 0 12px 32px rgba(0,0,0,0.55);\n"
    "      border-radius: 14px;\n"
    "      user-select: none;\n"
    "      /* NO SCROLLBARS (Trent 2026-06-02): the shell sizes to its content,\n"
    "         so clip any sub-pixel spill rather than ever raising a scrollbar. */\n"
    "      overflow: hidden;\n"
    "    }\n"
    "    #cbe-tama-shell[hidden] { display: none !important; }"
)

for p in FILES:
    raw = p.read_bytes()
    use_crlf = raw.count(b"\r\n") > raw.count(b"\n") - raw.count(b"\r\n")
    html = raw.decode("utf-8").replace("\r\n", "\n")
    if "NO SCROLLBARS (Trent 2026-06-02)" in html and "#cbe-tama-shell {" in html \
       and "overflow: hidden;\n    }\n    #cbe-tama-shell[hidden]" in html:
        print(f"{p.name:24s} -> already patched"); continue
    if OLD not in html:
        print(f"{p.name:24s} -> MISS (baseline tail not found)"); continue
    html = html.replace(OLD, NEW, 1)
    if use_crlf:
        html = html.replace("\n", "\r\n")
    p.write_bytes(html.encode("utf-8"))
    print(f"{p.name:24s} -> patched")
