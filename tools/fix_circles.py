"""
fix_circles.py — Normalize the toolbar busy-indicator "circles" across every
skin's index.html so they obey Trent's canon (2026-05-27/28):

  * ALL toolbar busy-indicator rings render at the SAME size (32x32).
  * The VSCode monitor button shows exactly ONE green ring (the JS-injected
    `.cbe-monitor-ring` from panel.js cbeShowMonitorSpinner) — the baked-in
    `loading_green.svg` <img>.cbe-spinner is hidden so the two no longer
    stack into a juddering double circle.

Two CSS bugs lived (identically) in panel/index.html AND every
skins/<name>/index.html + skins/<name>.skin/index.html copy:

  A. #monitorBtn .cbe-spinner (img) + JS .cbe-monitor-ring both rendered ->
     doubled green circle.
  B. #autoReplyBtn .cbe-spinner and #ttsBtn .cbe-autoread-ring used
     width/height:100% (~43px) + scale(0.85->1.06) -> visibly bigger than the
     32px monitor/STT spinners.

panel/index.html is fixed by hand; this script fixes the 30 skin copies.
Idempotent: running twice is a no-op (already-fixed blocks are skipped).
"""

import glob
import re

FILES = sorted(set(glob.glob("skins/*/index.html") + glob.glob("skins/*.skin/index.html")))

# --- Fix B: the shared "width:100% / height:100% / scale(0.85)" geometry that
#     both #autoReplyBtn .cbe-spinner and #ttsBtn .cbe-autoread-ring use. ---
GEOM_OLD = (
    "  width: 100% !important;\n"
    "  height: 100% !important;\n"
    "  transform: translate(-50%, -50%) scale(0.85) !important;\n"
)
GEOM_NEW = (
    "  /* SAME-SIZE FIX (Trent \"those circles\" 2026-05-28): pinned to a FIXED\n"
    "     32x32 box so this ring matches the monitor / STT spinners exactly.\n"
    "     Was width/height:100% (~43px) + scale(0.85->1.06) -> too big. */\n"
    "  width: 32px !important;\n"
    "  height: 32px !important;\n"
    "  min-width: 32px !important;\n"
    "  min-height: 32px !important;\n"
    "  max-width: 32px !important;\n"
    "  max-height: 32px !important;\n"
    "  transform: translate(-50%, -50%) scale(0.92) !important;\n"
)

# Active-state pulse: scale(1.06) -> scale(1.0) so it never exceeds 32px.
PULSE_OLD = "  transform: translate(-50%, -50%) scale(1.06) !important;\n"
PULSE_NEW = "  transform: translate(-50%, -50%) scale(1.0) !important;\n"

# --- Fix A: hide the monitor button's baked-in <img> spinner so only the
#     JS-injected .cbe-monitor-ring renders (no doubled circle). We rewrite the
#     `#monitorBtn.is-monitoring .cbe-spinner { opacity: 1; }` rule to also kill
#     display, and add a base `display:none` so neither state shows the img. ---
MON_OPACITY_OLD = "#monitorBtn.is-monitoring .cbe-spinner { opacity: 1; }"
MON_OPACITY_NEW = (
    "/* DOUBLED-CIRCLE FIX (Trent \"those circles\" 2026-05-28): hide the baked-in\n"
    "   loading_green.svg img spinner so only the JS .cbe-monitor-ring renders\n"
    "   (the two used to stack into a thick juddering double ring). */\n"
    "#monitorBtn .cbe-spinner { display: none !important; }\n"
    "#monitorBtn.is-monitoring .cbe-spinner { display: none !important; }"
)


def fix(text):
    changed = []
    # Fix B — geometry appears exactly twice (autoReply + tts). replace all.
    if GEOM_OLD in text:
        n = text.count(GEOM_OLD)
        text = text.replace(GEOM_OLD, GEOM_NEW)
        changed.append(f"geom x{n}")
    # Active pulse — also exactly twice.
    if PULSE_OLD in text:
        n = text.count(PULSE_OLD)
        text = text.replace(PULSE_OLD, PULSE_NEW)
        changed.append(f"pulse x{n}")
    # Fix A — monitor doubled circle.
    if MON_OPACITY_OLD in text and "DOUBLED-CIRCLE FIX" not in text:
        text = text.replace(MON_OPACITY_OLD, MON_OPACITY_NEW, 1)
        changed.append("monitor")
    return text, changed


def main():
    for f in FILES:
        with open(f, encoding="utf-8") as fh:
            src = fh.read()
        out, changed = fix(src)
        if out != src:
            with open(f, "w", encoding="utf-8", newline="") as fh:
                fh.write(out)
            print(f"FIXED {f}: {', '.join(changed)}")
        else:
            print(f"skip  {f}: (already normalized)")


if __name__ == "__main__":
    main()
