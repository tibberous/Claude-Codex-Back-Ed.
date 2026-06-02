"""propagate_promptrow.py — apply the 2026-06-01 prompt-row LAYOUT v2 to the
14 non-codex-black CBE skins.

Layout v2 (Trent):
  • input row:  [textarea] … [Stop] [Send]   (Send pinned FAR RIGHT, right of Stop)
  • under-box row: centered [label] [project-folder]  (.prompt-meta-row)
  • label image at NATURAL size (no width/height clamp, no breakpoint shrink)

It does TWO replacements per skin:
  1. MARKUP: reorder the .toolbar-meta--inline children → Stop, Send, then a new
     .prompt-meta-row wrapping label-pill + project-path. The standalone trailing
     <button id="sendBtn"> sibling is folded into the cluster.
  2. CSS: swap the whole "2026-05-31 UNIVERSAL prompt-row normalize" block (header
     comment → closing @media(max-width:620px){...}) for the v2 block below.

aqua-dock has no label-pill/project-path and already nests Send/Stop in the
cluster — handled as a special case (only the CSS swap + Send/Stop reorder).
"""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKINS = ROOT / "skins"

# 13 standard skins (NOT codex-black, NOT aqua-dock)
STANDARD = ["arch", "ubuntu", "glassy", "gnome", "kde", "redhat", "mint-dock",
            "macos-color-dock", "xfce", "terminal", "office", "tamagotchi",
            "claude-default"]

# ---- 1. standard markup: OLD (label, project, stop) + trailing sendBtn ----
OLD_MARKUP = '''          <div class="toolbar-meta toolbar-meta--inline">
            <button id="label-pill" class="label-button" type="button" data-tooltip="Open settings" data-i18n-tip="tooltip.settings" aria-label="Current assistant profile">
              <img id="brandLabelImg" src="{{ASSETS_BASE}}/labels/en.svg" data-cbe-brand alt="Claude Codex — Black Edition" />
            </button>
            <div id="project-path" class="project-path" data-tooltip="No project folder — click the folder button to pick one" data-i18n-tip="label.no_project" aria-label="Active project folder" title=""></div>
            <button id="stopBtn" class="stop-button" type="button" data-tooltip="Stop generation" data-i18n-tip="tooltip.stop" aria-label="Stop generation">
              <span class="stop-button__icon" aria-hidden="true"></span>
              <span class="stop-button__label">Stop</span>
            </button>
          </div>
          <button id="sendBtn" class="send-button" type="button" data-tooltip="Send message" data-i18n-tip="tooltip.send" aria-label="Send message"></button>'''

NEW_MARKUP = '''          <!-- 2026-06-01 layout v2 (Trent): prompt row reads [textarea] … [Stop]
               [Send] with Send rightmost; brand label + project folder sit in a
               CENTERED row (.prompt-meta-row) directly UNDER the prompt box. -->
          <div class="toolbar-meta toolbar-meta--inline">
            <button id="stopBtn" class="stop-button" type="button" data-tooltip="Stop generation" data-i18n-tip="tooltip.stop" aria-label="Stop generation">
              <span class="stop-button__icon" aria-hidden="true"></span>
              <span class="stop-button__label">Stop</span>
            </button>
            <button id="sendBtn" class="send-button" type="button" data-tooltip="Send message" data-i18n-tip="tooltip.send" aria-label="Send message"></button>
            <div class="prompt-meta-row">
              <button id="label-pill" class="label-button" type="button" data-tooltip="Open settings" data-i18n-tip="tooltip.settings" aria-label="Current assistant profile">
                <img id="brandLabelImg" src="{{ASSETS_BASE}}/labels/en.svg" data-cbe-brand alt="Claude Codex — Black Edition" />
              </button>
              <div id="project-path" class="project-path" data-tooltip="No project folder — click the folder button to pick one" data-i18n-tip="label.no_project" aria-label="Active project folder" title=""></div>
            </div>
          </div>'''

# ---- aqua-dock markup: Send, Stop nested, no pills. Just reorder to Stop, Send.
AQUA_OLD = '''          <div class="toolbar-meta toolbar-meta--inline">
            <button id="sendBtn" class="send-button" type="button" data-tooltip="Send message" data-i18n-tip="tooltip.send" aria-label="Send message"></button>
            <button id="stopBtn" class="stop-button" type="button" data-tooltip="Stop generation" data-i18n-tip="tooltip.stop" aria-label="Stop generation">
              <span class="stop-button__icon" aria-hidden="true"></span>
              <span class="stop-button__label">Stop</span>
            </button>
          </div>'''

AQUA_NEW = '''          <!-- 2026-06-01 layout v2 (Trent): [textarea] … [Stop] [Send], Send rightmost. -->
          <div class="toolbar-meta toolbar-meta--inline">
            <button id="stopBtn" class="stop-button" type="button" data-tooltip="Stop generation" data-i18n-tip="tooltip.stop" aria-label="Stop generation">
              <span class="stop-button__icon" aria-hidden="true"></span>
              <span class="stop-button__label">Stop</span>
            </button>
            <button id="sendBtn" class="send-button" type="button" data-tooltip="Send message" data-i18n-tip="tooltip.send" aria-label="Send message"></button>
          </div>'''

# ---- 2. new universal CSS block (replaces everything from the header comment
#         through the closing @media(max-width:620px){...}) ----
NEW_CSS = '''/* ════════════════════════════════
   2026-06-01 — UNIVERSAL prompt-row LAYOUT v2 (Trent). New shape:
     • input row:  [textarea] … [Stop] [Send]  — Send pinned FAR RIGHT,
       right of Stop (both anchored bottom-right of the wrap).
     • under-box row: a centered [label] [project-folder] cluster sitting
       directly UNDER the prompt box (.prompt-meta-row, full width, centered).
     • label image renders at its NATURAL size (no width/height clamps,
       no breakpoint shrink) so the brand logo never looks too small.
   .toolbar-meta--inline is display:contents so its children flow inside the
   wrap; Stop+Send are absolutely positioned, .prompt-meta-row is normal flow.
   ════════════════════════════════ */
.prompt-input-wrap,
#input-box.prompt-input-wrap {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: flex-start !important;
  position: relative !important;
  /* bottom padding reserves room for the absolutely-pinned Stop/Send row */
  padding: 12px 14px 52px 14px !important;
  margin-bottom: 14px !important;
}
.prompt-input-wrap > textarea.prompt-input,
.prompt-input-wrap #promptBox {
  display: block !important;
  flex: 1 1 100% !important;
  width: 100% !important;
}
.toolbar-meta--inline {
  position: static !important;
  display: contents !important;
}
/* Show the brand pill (Trent v2 wants the label visible + centered under box). */
#label-pill,
.label-button,
.toolbar-meta--inline #label-pill {
  display: inline-flex !important;
}
/* SEND — far right, right of Stop. */
#sendBtn {
  position: absolute !important;
  left: auto !important;
  right: 14px !important;
  top: auto !important;
  bottom: 12px !important;
  transform: none !important;
}
/* STOP — immediately to the LEFT of Send. */
.toolbar-meta--inline #stopBtn {
  position: absolute !important;
  right: 56px; bottom: 11px;
  top: auto !important;
  left: auto !important;
  margin: 0 !important;
  transform: none !important;
}
/* Under-box centered row: [label] [project-folder] */
.prompt-meta-row {
  flex: 1 1 100% !important;
  width: 100% !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 10px !important;
}
/* Label image at NATURAL size — stop downscaling it. The brand SVG has a
   932×148 viewBox but no intrinsic width/height; pin the HEIGHT and let width
   scale by the SVG's own ratio so the logo is full-size + crisp on every skin. */
.prompt-meta-row #label-pill,
.toolbar-meta--inline #label-pill,
.prompt-meta-row .label-button {
  position: static !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  flex: 0 0 auto !important;
}
.prompt-meta-row #label-pill img,
.prompt-meta-row .label-button img {
  width: auto !important;
  height: 40px !important;
  max-width: none !important;
  object-fit: contain !important;
}
.toolbar-meta--inline #project-path,
.prompt-meta-row #project-path {
  position: static !important;
  margin: 0 !important;
  max-width: 240px !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 4px !important;
  height: auto !important;
  color: inherit !important;   /* readable on light + dark skins alike */
  flex: 0 1 auto !important;
}
.toolbar-meta--inline #project-path:empty::before,
.prompt-meta-row #project-path:empty::before {
  color: currentColor !important;
  font-style: italic;
  opacity: 0.55;
}
@media (max-width: 620px) {
  .toolbar-meta--inline #project-path { display: none !important; }
}'''

# Regex to capture the existing universal block: from the OPENING "/*" of the
# comment block that CONTAINS "2026-05-31 — UNIVERSAL prompt-row" (the marker
# sits inside that comment, so we anchor to the last "/*" before it that has no
# intervening "*/"), through the first "@media (max-width: 620px) { ... }".
# `[^/]` / tempered prefix keeps the start from latching onto an earlier "/*".
CSS_RE = re.compile(
    r"/\*(?:(?!\*/).)*?2026-05-31 — UNIVERSAL prompt-row.*?"
    r"@media \(max-width: 620px\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}",
    re.DOTALL,
)

def process(name: str) -> str:
    p = SKINS / f"{name}.html"
    # Read preserving the file's existing newline bytes (skins are CRLF on disk
    # under core.autocrlf=true). We translate our LF-authored replacement
    # strings to match the file's dominant EOL on write so git sees ONLY the
    # layout block as changed — not a whole-file EOL flip.
    raw = p.read_bytes()
    use_crlf = raw.count(b"\r\n") > raw.count(b"\n") - raw.count(b"\r\n")
    html = raw.decode("utf-8")
    # normalize to LF in-memory for matching (our marker strings are LF)
    html = html.replace("\r\n", "\n")
    notes = []

    # markup
    if name == "aqua-dock":
        if AQUA_OLD in html:
            html = html.replace(AQUA_OLD, AQUA_NEW, 1)
            notes.append("markup(aqua)")
        else:
            notes.append("MARKUP-MISS")
    else:
        if OLD_MARKUP in html:
            html = html.replace(OLD_MARKUP, NEW_MARKUP, 1)
            notes.append("markup")
        else:
            notes.append("MARKUP-MISS")

    # css
    m = CSS_RE.search(html)
    if m:
        html = html[:m.start()] + NEW_CSS + html[m.end():]
        notes.append("css")
    else:
        notes.append("CSS-MISS")

    if use_crlf:
        html = html.replace("\n", "\r\n")
    p.write_bytes(html.encode("utf-8"))
    return " ".join(notes)

if __name__ == "__main__":
    for n in STANDARD + ["aqua-dock"]:
        print(f"{n:20s} -> {process(n)}")
