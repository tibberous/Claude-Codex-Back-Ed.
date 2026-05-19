"""
build_skins.py — Bake the prompt-bar theme pack into installable CBE skins.

Sources:
  * C:\\Users\\moren\\Desktop\\skins\\promptbar_theme_pack.zip   (8 themes)
  * C:\\Users\\moren\\Desktop\\skins\\glassy_promptbar_markup.zip (1 theme)
  * C:\\Users\\moren\\Desktop\\skins\\office_promptbar_markup.zip (1 theme)

What this does:
  1. Splits the 8-theme pack into 8 separate skin folders, each with its OWN
     :root vars (no more `body[data-theme="X"]` gate).
  2. Copies the standalone glassy + office skins as-is but rewrites their
     selectors to match the real CBE panel (`.glass-shell` -> `.prompt-shell`,
     `.glass-icon-button` -> `.tool-button`, etc).
  3. Writes <id>/manifest.xml describing the skin.
  4. Lays the folders into <extension>/skins/<id>/.
  5. Zips each folder back to C:\\Users\\moren\\Desktop\\skins\\<id>.zip so the
     skins can be distributed as packages.

All 10 skins target ONLY the real CBE selectors:
  .prompt-shell, .prompt-input-wrap, .prompt-input, .send-button,
  .prompt-toolbar, .toolbar-tools, .toolbar-meta, .tool-button,
  .label-button, .stop-button
"""

import shutil
import zipfile
from pathlib import Path

EXT_ROOT  = Path(r"c:\Users\moren\Desktop\Claude Codex Black")
SKIN_DIR  = EXT_ROOT / "skins"
DIST_DIR  = Path(r"C:\Users\moren\Desktop\skins")
PACK_DIR  = DIST_DIR / "_pack" / "promptbar_theme_pack"

# ── Modal palettes per theme. Picked to match/accent each theme's existing
#    body palette (NOT just the accent color — the modal needs a coherent
#    title bar, body, footer and border that read together).
DEFAULT_MODAL_PALETTE = {
    "modal_bg": "#1a1a1a", "modal_fg": "#e8e8e8", "modal_border": "#e8621a",
    "modal_title_bg_1": "#b83c00", "modal_title_bg_2": "#e8621a",
    "modal_title_fg": "#ffffff", "modal_foot_bg": "#111111", "modal_accent": "#e8621a",
    # High-contrast accent against modal_bg. Used by the panel via the
    # --cbe-highlight-color variable for selection highlights, focus rings,
    # active rows, etc. Picked to read clearly on each skin's body color.
    "highlight_color": "#ffd166",
}

MODAL_PALETTES = {
    "gnome": {  # Adwaita blue on near-black for contrast against the light shell
        "modal_bg": "#2e3436", "modal_fg": "#eaeef3", "modal_border": "#3584e4",
        "modal_title_bg_1": "#2a6dbf", "modal_title_bg_2": "#3584e4",
        "modal_title_fg": "#ffffff", "modal_foot_bg": "#232729", "modal_accent": "#3584e4",
        "highlight_color": "#f6d32d",   # Adwaita yellow on dark slate
    },
    "kde": {    # frosted dark with Plasma cyan accent
        "modal_bg": "#0f1825", "modal_fg": "#eef7ff", "modal_border": "#3daee9",
        "modal_title_bg_1": "#2a8bbb", "modal_title_bg_2": "#3daee9",
        "modal_title_fg": "#eef7ff", "modal_foot_bg": "#0a1018", "modal_accent": "#3daee9",
        "highlight_color": "#ff8c42",   # warm orange against deep navy
    },
    "ubuntu": { # aubergine body with Yaru orange chrome
        "modal_bg": "#2f2630", "modal_fg": "#f4ebe9", "modal_border": "#e95420",
        "modal_title_bg_1": "#b03c14", "modal_title_bg_2": "#e95420",
        "modal_title_fg": "#ffffff", "modal_foot_bg": "#1d171c", "modal_accent": "#e95420",
        "highlight_color": "#aef359",   # Yaru green pops on aubergine
    },
    "terminal": {  # phosphor green on near-pitch black, CRT vibe
        "modal_bg": "#020704", "modal_fg": "#7cffaa", "modal_border": "#28c763",
        "modal_title_bg_1": "#0b2112", "modal_title_bg_2": "#28c763",
        "modal_title_fg": "#7cffaa", "modal_foot_bg": "#010503", "modal_accent": "#33ff82",
        "highlight_color": "#ff007f",   # magenta cuts cleanly through green CRT
    },
    "xfce": {   # classic GTK greys, navy title bar
        "modal_bg": "#d8d8d8", "modal_fg": "#202020", "modal_border": "#686868",
        "modal_title_bg_1": "#3f72a8", "modal_title_bg_2": "#5b8dc4",
        "modal_title_fg": "#ffffff", "modal_foot_bg": "#c5c5c5", "modal_accent": "#3f72a8",
        "highlight_color": "#a03030",   # brick red against the grey panels
    },
    "arch": {   # dark cyan rice
        "modal_bg": "#0b0e14", "modal_fg": "#d7efff", "modal_border": "#1793d1",
        "modal_title_bg_1": "#0d6ba0", "modal_title_bg_2": "#1793d1",
        "modal_title_fg": "#d7efff", "modal_foot_bg": "#05070b", "modal_accent": "#1793d1",
        "highlight_color": "#fdb813",   # warm amber over near-black
    },
    "redhat": { # enterprise light grey, red accent
        "modal_bg": "#f2f4f5", "modal_fg": "#252b31", "modal_border": "#ee0000",
        "modal_title_bg_1": "#b30000", "modal_title_bg_2": "#ee0000",
        "modal_title_fg": "#ffffff", "modal_foot_bg": "#d5dadd", "modal_accent": "#ee0000",
        "highlight_color": "#001f3f",   # deep navy on the near-white body
    },
    "tamagotchi": {  # lime LCD with mossy green chrome
        "modal_bg": "#c9ee75", "modal_fg": "#315912", "modal_border": "#426d1d",
        "modal_title_bg_1": "#5f8d29", "modal_title_bg_2": "#79a936",
        "modal_title_fg": "#315912", "modal_foot_bg": "#acd85b", "modal_accent": "#4d8b18",
        "highlight_color": "#8e0e4e",   # bright magenta-purple on lime LCD
    },
}

# ── Theme variable sets — copied verbatim from the pack, one block per theme.
THEMES = {
    "gnome": {
        "label": "GNOME / Adwaita",
        "author": "OpenAI ChatGPT",
        "description": "Clean Adwaita-style light shell with blue accent, soft shadow.",
        "accent": "#3584e4",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 20% 15%, rgba(53,132,228,.16), transparent 26%),
    linear-gradient(180deg, #25292e 0%, #1c1f23 100%);
  --shell-bg: linear-gradient(180deg, #f7f7f7 0%, #e9e9e9 100%);
  --shell-border: #c6c6c6;
  --shell-radius: 18px;
  --button-bg: linear-gradient(180deg, #ffffff 0%, #eeeeee 100%);
  --button-hover: linear-gradient(180deg, #ffffff 0%, #e8f2ff 100%);
  --button-active: linear-gradient(180deg, #dcdcdc 0%, #eeeeee 100%);
  --button-border: #b5b5b5;
  --button-radius: 10px;
  --button-text: #2e3436;
  --accent: #3584e4;
  --accent-glow: rgba(53,132,228,.28);
  --field-bg: #ffffff;
  --field-text: #303030;
  --field-border: #c1c1c1;
""",
    },
    "kde": {
        "label": "KDE Plasma",
        "author": "OpenAI ChatGPT",
        "description": "Frosted Plasma-style glass with cyan / violet halo.",
        "accent": "#3daee9",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 10% 10%, rgba(61,174,233,.22), transparent 26%),
    radial-gradient(circle at 82% 18%, rgba(142,91,255,.18), transparent 25%),
    linear-gradient(180deg, #172030 0%, #0e1420 100%);
  --shell-bg: linear-gradient(180deg, rgba(230,246,255,.72) 0%, rgba(106,153,204,.22) 100%);
  --shell-border: rgba(208,240,255,.55);
  --shell-shadow: 0 20px 44px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.55);
  --button-bg: linear-gradient(180deg, rgba(255,255,255,.35) 0%, rgba(66,118,174,.16) 100%);
  --button-hover: linear-gradient(180deg, rgba(255,255,255,.52) 0%, rgba(66,174,233,.24) 100%);
  --button-active: linear-gradient(180deg, rgba(45,78,122,.30) 0%, rgba(255,255,255,.14) 100%);
  --button-border: rgba(210,239,255,.46);
  --button-radius: 12px;
  --button-text: #e9f7ff;
  --accent: #3daee9;
  --accent-glow: rgba(61,174,233,.34);
  --field-bg: rgba(255,255,255,.76);
  --field-text: #24324a;
  --field-border: rgba(215,238,255,.70);
  --icon-filter: brightness(0) saturate(100%) invert(94%) sepia(15%) saturate(1432%) hue-rotate(172deg) brightness(102%) contrast(99%);
""",
    },
    "ubuntu": {
        "label": "Ubuntu / Yaru",
        "author": "OpenAI ChatGPT",
        "description": "Aubergine + orange Yaru styling, light prompt field.",
        "accent": "#e95420",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 20% 12%, rgba(233,84,32,.26), transparent 28%),
    radial-gradient(circle at 76% 18%, rgba(119,41,83,.22), transparent 30%),
    linear-gradient(180deg, #2c001e 0%, #171015 100%);
  --shell-bg: linear-gradient(180deg, #4b3140 0%, #2f2630 100%);
  --shell-border: #7e5369;
  --button-bg: linear-gradient(180deg, #5a4050 0%, #3a2e38 100%);
  --button-hover: linear-gradient(180deg, #704d5e 0%, #4d3444 100%);
  --button-active: linear-gradient(180deg, #2e252d 0%, #4a3944 100%);
  --button-border: #87546a;
  --button-radius: 7px;
  --button-text: #f4ebe9;
  --accent: #e95420;
  --accent-glow: rgba(233,84,32,.34);
  --field-bg: #f7f1ef;
  --field-text: #3a3035;
  --field-placeholder: #66585f;
  --field-border: #a87a8d;
  --icon-filter: brightness(0) saturate(100%) invert(96%) sepia(9%) saturate(408%) hue-rotate(318deg) brightness(104%) contrast(90%);
""",
    },
    "terminal": {
        "label": "Terminal Hacker",
        "author": "OpenAI ChatGPT",
        "description": "Black + phosphor-green CRT with scanlines and glow.",
        "accent": "#33ff82",
        "blocky": True,
        "vars": """\
  --stage-bg:
    repeating-linear-gradient(0deg, rgba(51,255,142,.035) 0 1px, transparent 1px 4px),
    radial-gradient(circle at 50% 50%, rgba(30,255,125,.14), transparent 38%),
    linear-gradient(180deg, #031006 0%, #010603 100%);
  --shell-bg: linear-gradient(180deg, #08160d 0%, #030a05 100%);
  --shell-border: #27e66d;
  --shell-radius: 0;
  --shell-shadow: 0 0 26px rgba(38,255,117,.22), 0 18px 40px rgba(0,0,0,.55);
  --inner-shadow: inset 0 0 0 1px rgba(38,255,117,.22);
  --button-bg: linear-gradient(180deg, #0b2112 0%, #041008 100%);
  --button-hover: linear-gradient(180deg, #12351d 0%, #072111 100%);
  --button-active: linear-gradient(180deg, #020804 0%, #0d2a16 100%);
  --button-border: #28c763;
  --button-radius: 0;
  --button-text: #6dff9d;
  --accent: #33ff82;
  --accent-glow: rgba(51,255,130,.38);
  --field-bg: #020704;
  --field-text: #7cffaa;
  --field-placeholder: #57d985;
  --field-border: #2ece69;
  --font-ui: "Consolas", "Lucida Console", monospace;
  --font-mono: "Consolas", "Lucida Console", monospace;
  --icon-filter: brightness(0) saturate(100%) invert(86%) sepia(52%) saturate(730%) hue-rotate(75deg) brightness(106%) contrast(105%);
""",
    },
    "xfce": {
        "label": "Classic GTK / XFCE",
        "author": "OpenAI ChatGPT",
        "description": "Square classic GTK bevels — flat grey, no rounded corners.",
        "accent": "#3f72a8",
        "blocky": True,
        "vars": """\
  --stage-bg:
    linear-gradient(135deg, #59606a 0%, #303842 100%);
  --shell-bg: #d8d8d8;
  --shell-border: #858585;
  --shell-radius: 0;
  --shell-shadow: 0 16px 30px rgba(0,0,0,.42);
  --inner-shadow: inset 2px 2px 0 #ffffff, inset -2px -2px 0 #8d8d8d;
  --button-bg: #d6d6d6;
  --button-hover: #e6e6e6;
  --button-active: #bdbdbd;
  --button-border: #686868;
  --button-radius: 0;
  --button-text: #202020;
  --accent: #3f72a8;
  --accent-glow: rgba(63,114,168,.25);
  --field-bg: #ffffff;
  --field-text: #242424;
  --field-placeholder: #5e5e5e;
  --field-border: #777777;
""",
    },
    "arch": {
        "label": "Arch Minimalist Rice",
        "author": "OpenAI ChatGPT",
        "description": "Dark translucent shell, sharp 3px corners, Arch cyan accent.",
        "accent": "#1793d1",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 78% 12%, rgba(23,147,209,.20), transparent 25%),
    linear-gradient(180deg, #0b0e14 0%, #05070b 100%);
  --shell-bg: rgba(15, 18, 26, .82);
  --shell-border: rgba(23, 147, 209, .48);
  --shell-radius: 4px;
  --shell-shadow: 0 20px 42px rgba(0,0,0,.55), 0 0 32px rgba(23,147,209,.12);
  --inner-shadow: inset 0 1px 0 rgba(255,255,255,.06);
  --button-bg: rgba(16, 22, 32, .92);
  --button-hover: rgba(20, 40, 58, .94);
  --button-active: rgba(9, 12, 18, .95);
  --button-border: rgba(23,147,209,.45);
  --button-radius: 3px;
  --button-text: #d7efff;
  --accent: #1793d1;
  --accent-glow: rgba(23,147,209,.35);
  --field-bg: rgba(6, 9, 14, .92);
  --field-text: #d7efff;
  --field-placeholder: #86aec7;
  --field-border: rgba(23,147,209,.5);
  --icon-filter: brightness(0) saturate(100%) invert(79%) sepia(59%) saturate(2905%) hue-rotate(168deg) brightness(91%) contrast(83%);
""",
    },
    "redhat": {
        "label": "Red Hat Enterprise",
        "author": "OpenAI ChatGPT",
        "description": "Crisp enterprise grey + red accent, sharp 3px corners.",
        "accent": "#ee0000",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 18% 10%, rgba(238,0,0,.18), transparent 25%),
    linear-gradient(180deg, #24292f 0%, #171b20 100%);
  --shell-bg: linear-gradient(180deg, #f2f4f5 0%, #d5dadd 100%);
  --shell-border: #aab2b8;
  --shell-radius: 3px;
  --button-bg: linear-gradient(180deg, #ffffff 0%, #e1e5e8 100%);
  --button-hover: linear-gradient(180deg, #ffffff 0%, #f5e3e3 100%);
  --button-active: linear-gradient(180deg, #cbd0d3 0%, #f0f2f3 100%);
  --button-border: #929ca4;
  --button-radius: 3px;
  --button-text: #252b31;
  --accent: #ee0000;
  --accent-glow: rgba(238,0,0,.22);
  --field-bg: #ffffff;
  --field-text: #2b3035;
  --field-border: #a6adb4;
""",
    },
    "tamagotchi": {
        "label": "Tamagotchi",
        "author": "OpenAI ChatGPT",
        "description": "Pixel-pet LCD lime-green look with retro chunky shadows.",
        "accent": "#4d8b18",
        "blocky": True,
        # Extra CSS appended after the base — only the Tamagotchi skin needs
        # this so the LCD pet panel doesn't bloat every other skin's stylesheet.
        "extra_css": """\

/* ── Tamagotchi pet panel ──────────────────────────────────────────────
   Pure-CSS injection of assets/tamagotchi.gif on the left edge of the
   prompt shell via a ::before pseudo-element. No DOM/JS changes — the
   GIF is loaded as a background-image (animation works in
   background-image just like in <img>). The frame uses the same chunky
   inset bevel + pulsing green glow the original demo had. */
.prompt-shell {
  position: relative !important;
  padding-left: 168px !important;
}
.prompt-shell::before {
  content: "";
  position: absolute;
  left: 16px;
  top: 16px;
  width: 132px;
  height: 138px;
  padding: 10px;
  border: 3px solid #416b18;
  background:
    url('assets/tamagotchi.gif') center/92px 92px no-repeat,
    #86bd3e;
  box-shadow:
    inset 4px 4px 0 rgba(233,255,172,.55),
    inset -4px -4px 0 rgba(49,86,17,.62),
    0 0 0 2px rgba(98,165,31,.65),
    8px 8px 0 rgba(0,0,0,.32),
    0 0 18px rgba(144,255,64,.55);
  image-rendering: pixelated;
  animation: cbe-tamagotchi-glow 1.35s ease-in-out infinite;
  pointer-events: none;
  z-index: 1;
}
@keyframes cbe-tamagotchi-glow {
  0%, 100% {
    box-shadow:
      inset 4px 4px 0 rgba(233,255,172,.55),
      inset -4px -4px 0 rgba(49,86,17,.62),
      0 0 0 2px rgba(98,165,31,.65),
      8px 8px 0 rgba(0,0,0,.32),
      0 0 12px rgba(144,255,64,.40);
  }
  50% {
    box-shadow:
      inset 4px 4px 0 rgba(233,255,172,.55),
      inset -4px -4px 0 rgba(49,86,17,.62),
      0 0 0 2px rgba(172,255,80,.92),
      8px 8px 0 rgba(0,0,0,.32),
      0 0 28px rgba(144,255,64,.85);
  }
}
""",
        "vars": """\
  --stage-bg:
    radial-gradient(circle at 20% 15%, rgba(155, 215, 68, .24), transparent 28%),
    linear-gradient(180deg, #2d3b18 0%, #111a0a 100%);
  --shell-bg: #c9ee75;
  --shell-border: #5f9e22;
  --shell-radius: 0;
  --shell-shadow: 10px 10px 0 rgba(0,0,0,.45), 0 0 26px rgba(142, 240, 54, .18);
  --inner-shadow: inset 4px 4px 0 rgba(255,255,255,.35), inset -4px -4px 0 rgba(68,122,20,.55);
  --button-bg: #acd85b;
  --button-hover: #c9f36f;
  --button-active: #79a936;
  --button-border: #426d1d;
  --button-radius: 0;
  --button-text: #315912;
  --accent: #4d8b18;
  --accent-glow: rgba(144,255,64,.50);
  --field-bg: #dff7a0;
  --field-text: #315912;
  --field-placeholder: #4f7726;
  --field-border: #5f8d29;
  --font-ui: "Consolas", "Lucida Console", monospace;
  --font-mono: "Consolas", "Lucida Console", monospace;
  --icon-filter: brightness(0) saturate(100%) invert(27%) sepia(72%) saturate(775%) hue-rotate(52deg) brightness(95%) contrast(91%);
""",
    },
}

# Base CSS template — targets the REAL CBE selectors, parameterized by the
# CSS variables defined per skin. Loaded AFTER CBE's inline <style> via the
# <link id="cbe-skin"> tag, so these rules override the panel defaults.
BASE_CSS = """\
/* ────────────────────────────────────────────────────────────────────────
   CBE skin — overrides the panel via CSS variables. Skin styles.css is
   loaded after the panel's inline <style>, so these rules win the cascade.
   Generated from promptbar_theme_pack — selectors remapped to real CBE
   class names (.prompt-shell, .prompt-input-wrap, .tool-button,
   .label-button, .stop-button, etc).
   ──────────────────────────────────────────────────────────────────────── */
:root {
{VARS}\
}

body {
  background: var(--stage-bg, inherit) !important;
}

/* ── Prompt shell + input frame ─────────────────────────────────────── */
.prompt-shell {
  border-radius: var(--shell-radius, 14px) !important;
  border: 1px solid var(--shell-border, rgba(255,255,255,0.08)) !important;
  background: var(--shell-bg) !important;
  box-shadow: var(--shell-shadow, 0 18px 40px rgba(0,0,0,.35)),
              var(--inner-shadow, inset 0 1px 0 rgba(255,255,255,.06)) !important;
}

.prompt-input-wrap {
  border-radius: calc(var(--button-radius, 10px) + 6px) !important;
  border: 1px solid var(--field-border) !important;
  background: var(--field-bg) !important;
  box-shadow:
    inset 0 1px 2px rgba(0,0,0,.08),
    inset 0 1px 0 rgba(255,255,255,.85) !important;
}

.prompt-input {
  color: var(--field-text) !important;
  font-family: var(--font-mono) !important;
}

.prompt-input::placeholder {
  color: var(--field-placeholder, color-mix(in srgb, var(--field-text), transparent 60%)) !important;
}

/* ── Send button — keep the panel's arrow PNG visible.
   The original .send-button uses `background: transparent url(send.png)`
   for its arrow. Overriding `background` here wipes the image and leaves
   a solid-colored square. Only nudge border + glow; let the PNG show. */
.send-button {
  border-radius: calc(var(--button-radius, 10px) + 2px) !important;
  filter: drop-shadow(0 0 8px var(--accent-glow));
}

/* ── Toolbar (all .tool-button children inherit) ─────────────────────── */
.prompt-toolbar {
  font-family: var(--font-ui) !important;
}

/* Skins pack the icon row tighter than the default 10px gap + 48x48 buttons.
   With 21 buttons (Help + Domains added), the default layout wraps. Shrinking
   to 38x38 + 4px gap keeps every button on a single row at common widths
   (~840px) and gives the skinned look a denser, app-bar feel.
   `justify-content: flex-start` is critical — the default is `center`, which
   combined with overflow makes the leftmost buttons inaccessible (centered
   overflow extends past x=0 and gets clipped). Keep overflow visible so the
   row never scroll-clips; prompt-shell padding absorbs minor spill. */
.toolbar-tools {
  gap: 4px !important;
  flex-wrap: nowrap !important;
  justify-content: flex-start !important;
  overflow-x: visible !important;
}
.tool-button {
  width: 38px !important;
  height: 38px !important;
}
.tool-button img {
  width: 20px !important;
  height: 20px !important;
}

.tool-button {
  border: 1px solid var(--button-border) !important;
  border-radius: var(--button-radius, 10px) !important;
  background: var(--button-bg) !important;
  color: var(--button-text) !important;
  box-shadow: var(--inner-shadow, inset 0 1px 0 rgba(255,255,255,.06)),
              0 5px 12px rgba(0,0,0,.12) !important;
  transition: transform .12s ease, filter .12s ease, background .12s ease,
              box-shadow .12s ease, border-color .12s ease, color .12s ease !important;
}

.tool-button img {
  filter: var(--icon-filter, none) !important;
  opacity: .94;
}

.tool-button:hover {
  background: var(--button-hover) !important;
  border-color: var(--accent) !important;
  box-shadow: var(--inner-shadow, inset 0 1px 0 rgba(255,255,255,.06)),
              0 7px 15px rgba(0,0,0,.16),
              0 0 0 2px var(--accent-glow) !important;
  transform: translateY(-1px);
}

.tool-button:active {
  background: var(--button-active) !important;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.22) !important;
  transform: translateY(1px);
}

/* ── Label pill — DELIBERATELY UNSTYLED ──────────────────────────────
   The label is a self-contained PNG with its own rounded border. Drawing
   a skin button-chrome behind it stacks two borders + two backgrounds
   and creates a visible orange/skin frame around the pill. Keep the
   skin out of this button's way. */
.label-button {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

/* ── Project-path pill ───────────────────────────────────────────────── */
.project-path {
  border: 1px solid var(--button-border) !important;
  background: var(--field-bg) !important;
  color: var(--field-text) !important;
}

/* ── Stop button — text + square get the accent ─────────────────────── */
.stop-button {
  border: 1px solid var(--button-border) !important;
  border-radius: var(--button-radius, 10px) !important;
  background: var(--button-bg) !important;
  color: var(--button-text) !important;
  font-family: var(--font-ui) !important;
  box-shadow: var(--inner-shadow, inset 0 1px 0 rgba(255,255,255,.06)),
              0 5px 12px rgba(0,0,0,.12) !important;
}

.stop-button:hover {
  background: var(--button-hover) !important;
  border-color: var(--accent) !important;
}

.stop-button__icon {
  background: var(--accent) !important;
  border-radius: max(0px, calc(var(--button-radius, 10px) / 3)) !important;
}

/* ── Tooltip ─────────────────────────────────────────────────────────── */
.tooltip {
  background: var(--shell-bg) !important;
  color: var(--field-text) !important;
  border: 1px solid var(--button-border) !important;
}
"""

# Append-only CSS used by every "blocky" theme (square corners, hard bevels).
# Replaces the rounded label-alpha.png with assets/label-square.png and bumps
# the .label-button so the pill reads legibly instead of getting squished into
# the 280x40 default. Path is relative to the skin's styles.css —
#   <ext>/skins/<id>/styles.css → ../../assets/label-square.png → <ext>/assets/
BLOCKY_LABEL_CSS = """

/* ── Blocky label override ──────────────────────────────────────────────
   Replace the default round label-alpha.png with the Win9x-bevel square
   variant. The panel <img> is hidden; the button paints the new label as
   a background so the rest of the markup stays untouched. */
.label-button {
  width: 360px !important;
  height: 50px !important;
  background:
    url('../../assets/label-square.png') center/contain no-repeat !important;
  border: 0 !important;
  box-shadow: none !important;
  padding: 0 !important;
}
.label-button img { display: none !important; }
"""

MANIFEST_XML = """\
<?xml version="1.0" encoding="utf-8"?>
<skin>
  <id>{id}</id>
  <name>{label}</name>
  <version>1.0</version>
  <author>{author}</author>
  <accent>{accent}</accent>
  <stylesheet>styles.css</stylesheet>
  <description>{description}</description>
  <!-- Modal chrome. Pushed onto :root as --cbe-modal-* CSS variables at
       apply time so the panel's modals (Settings, Domains, Setup wizard,
       Handbook, Stored prompts, Help, Source viewer, right-click menu)
       paint in the theme's accent without duplicating modal markup. -->
  <colors>
    <modal-bg>{modal_bg}</modal-bg>
    <modal-fg>{modal_fg}</modal-fg>
    <modal-border>{modal_border}</modal-border>
    <modal-title-bg-1>{modal_title_bg_1}</modal-title-bg-1>
    <modal-title-bg-2>{modal_title_bg_2}</modal-title-bg-2>
    <modal-title-fg>{modal_title_fg}</modal-title-fg>
    <modal-foot-bg>{modal_foot_bg}</modal-foot-bg>
    <modal-accent>{modal_accent}</modal-accent>
    <!-- Universal high-contrast accent. Read by the panel as
         --cbe-highlight-color and used wherever a one-off attention
         element needs to pop on this skin (Auto Prompt countdown,
         focus rings, selection bars, etc). Picked per-skin to read
         clearly on the skin's modal-bg. -->
    <highlight-color>{highlight_color}</highlight-color>
  </colors>
</skin>
"""

# ── Standalone bespoke skins (glassy + office). Their CSS is hand-written,
#    not variable-driven, so we ship the original styles with selectors
#    remapped to the real CBE class names.

GLASSY_CSS = """\
/* CBE skin — Glassy Beveled. Frosted-pane translucency with cyan glow.
   Rewritten from glassy_promptbar_markup using real CBE selectors. */
:root {
  --glass-text: #eef6ff;
  --glass-text-muted: #d7e7ff;
  --glass-stroke-1: rgba(255, 255, 255, 0.65);
  --accent-1: #8fd6ff;
  --accent-2: #56b7ff;
  --accent-3: #2d8dff;
  --shadow-deep: rgba(5, 12, 24, 0.52);
  --shadow-soft: rgba(39, 129, 255, 0.22);
}

body {
  background:
    radial-gradient(circle at 15% 20%, rgba(93, 186, 255, 0.22), transparent 26%),
    radial-gradient(circle at 82% 14%, rgba(162, 106, 255, 0.24), transparent 22%),
    radial-gradient(circle at 55% 78%, rgba(31, 131, 255, 0.17), transparent 28%),
    linear-gradient(180deg, #0f1828 0%, #0a101a 100%) !important;
}

.prompt-shell {
  border-radius: 26px !important;
  border: 1px solid rgba(255, 255, 255, 0.28) !important;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.09) 8%, rgba(170,210,255,0.08) 100%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.65),
    inset 0 -1px 0 rgba(255,255,255,0.07),
    0 22px 44px var(--shadow-deep),
    0 0 0 1px rgba(147, 204, 255, 0.08),
    0 0 28px rgba(95, 176, 255, 0.18) !important;
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
}

.prompt-input-wrap {
  border-radius: 20px !important;
  border: 1px solid var(--glass-stroke-1) !important;
  background: linear-gradient(180deg, rgba(255,255,255,0.76) 0%, rgba(238,246,255,0.54) 100%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.82),
    inset 0 -1px 0 rgba(148, 188, 255, 0.22),
    0 7px 18px rgba(3, 9, 21, 0.18) !important;
}

.prompt-input { color: #2f425e !important; }
.prompt-input::placeholder { color: #384a65 !important; opacity: .95 !important; }

.tool-button,
.stop-button {
  border: 1px solid var(--glass-stroke-1) !important;
  border-radius: 14px !important;
  background: linear-gradient(180deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.12) 42%, rgba(96,143,210,0.10) 100%) !important;
  color: var(--glass-text) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.82),
    inset 0 -1px 0 rgba(255,255,255,0.05),
    0 8px 16px rgba(7, 16, 30, 0.26),
    0 0 0 1px rgba(120, 186, 255, 0.08) !important;
}

/* Keep the arrow PNG on the send button; only add a cyan glow. */
.send-button {
  border-radius: 14px !important;
  filter: drop-shadow(0 0 10px var(--shadow-soft));
}

.toolbar-tools {
  gap: 4px !important;
  flex-wrap: nowrap !important;
  justify-content: flex-start !important;
  overflow-x: visible !important;
}
.tool-button {
  width: 38px !important;
  height: 38px !important;
}
.tool-button img {
  width: 20px !important;
  height: 20px !important;
  filter: brightness(0) saturate(100%) invert(92%) sepia(26%) saturate(544%) hue-rotate(183deg) brightness(103%) contrast(101%) !important;
}

.label-button {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.tool-button:hover,
.stop-button:hover {
  border-color: rgba(198, 231, 255, 0.92) !important;
  background: linear-gradient(180deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.16) 44%, rgba(105,165,245,0.14) 100%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.90),
    inset 0 -1px 0 rgba(140, 194, 255, 0.14),
    0 10px 18px rgba(6, 17, 36, 0.32),
    0 0 0 1px rgba(152, 218, 255, 0.22),
    0 0 20px var(--shadow-soft) !important;
}

.tool-button:hover img {
  filter: brightness(0) saturate(100%) invert(89%) sepia(85%) saturate(715%) hue-rotate(172deg) brightness(109%) contrast(106%) drop-shadow(0 0 5px rgba(133, 218, 255, 0.62)) !important;
}

.stop-button__icon {
  background: linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(214,229,255,0.82) 100%) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), 0 0 10px rgba(255,255,255,0.22) !important;
}
"""

OFFICE_CSS = """\
/* CBE skin — Square Office. Classic Windows 9x bevel UI: hard corners,
   white/grey inner highlights, blue accents. Rewritten from
   office_promptbar_markup for the real CBE selectors. */
:root {
  --office-blue: #244372;
  --office-blue-hot: #2f66b1;
  --button-face: #e9eef6;
  --button-face-2: #cbd6e5;
  --button-hover: #f7fbff;
  --button-hover-2: #cfe2ff;
  --button-active: #b8c5d8;
}

body {
  background:
    radial-gradient(circle at 30% 0%, rgba(255,255,255,.08), transparent 38%),
    linear-gradient(180deg, #303741 0%, #20262d 100%) !important;
  font-family: "Segoe UI", Tahoma, Arial, sans-serif !important;
  color: #1b2535 !important;
}

.prompt-shell {
  border-radius: 0 !important;
  border-width: 3px !important;
  border-style: solid !important;
  border-color: #f7fbff #7f8a9a #596372 #f7fbff !important;
  background: linear-gradient(180deg, #eef4fb 0%, #dbe3ef 38%, #c8d2e1 100%) !important;
  box-shadow:
    inset 2px 2px 0 rgba(255,255,255,.92),
    inset -2px -2px 0 rgba(86,98,115,.58),
    0 20px 34px rgba(0,0,0,.42) !important;
}

.prompt-input-wrap {
  border-radius: 0 !important;
  border-width: 3px !important;
  border-style: solid !important;
  border-color: #717b89 #ffffff #ffffff #717b89 !important;
  background: #ffffff !important;
  box-shadow:
    inset 2px 2px 0 #c8cdd4,
    inset -2px -2px 0 #f8fbff !important;
}

.prompt-input {
  color: #4a4f58 !important;
  font: 400 18px/1.28 "Consolas", "Lucida Console", monospace !important;
}

.prompt-input::placeholder { color: #515761 !important; opacity: .92 !important; }

.tool-button,
.stop-button {
  border-radius: 0 !important;
  border-width: 3px !important;
  border-style: solid !important;
  border-color: #ffffff #6b7584 #5d6674 #ffffff !important;
  background: linear-gradient(180deg, var(--button-face) 0%, #dbe4f0 46%, var(--button-face-2) 100%) !important;
  color: var(--office-blue) !important;
  box-shadow:
    inset 2px 2px 0 rgba(255,255,255,.9),
    inset -2px -2px 0 rgba(78,88,104,.35) !important;
}

/* Keep the arrow PNG visible — Office accent is just on hover-glow. */
.send-button {
  border-radius: 0 !important;
  filter: drop-shadow(0 0 3px rgba(94,149,220,.55));
}

.toolbar-tools {
  gap: 4px !important;
  flex-wrap: nowrap !important;
  justify-content: flex-start !important;
  overflow-x: visible !important;
}
.tool-button {
  width: 38px !important;
  height: 38px !important;
}
.tool-button img {
  width: 20px !important;
  height: 20px !important;
  filter:
    brightness(0) saturate(100%)
    invert(21%) sepia(38%) saturate(1144%) hue-rotate(181deg)
    brightness(88%) contrast(88%) !important;
}

.label-button {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.tool-button:hover,
.stop-button:hover {
  color: #143d79 !important;
  background: linear-gradient(180deg, var(--button-hover) 0%, #e4f0ff 45%, var(--button-hover-2) 100%) !important;
  border-color: #ffffff #3e6da9 #356196 #ffffff !important;
  box-shadow:
    inset 2px 2px 0 #ffffff,
    inset -2px -2px 0 rgba(47,92,147,.45),
    0 0 0 2px rgba(94,149,220,.38) !important;
}

.tool-button:active,
.stop-button:active {
  background: linear-gradient(180deg, var(--button-active) 0%, #ccd7e8 100%) !important;
  border-color: #56606f #ffffff #ffffff #56606f !important;
  box-shadow:
    inset 3px 3px 0 rgba(70,80,96,.5),
    inset -1px -1px 0 rgba(255,255,255,.75) !important;
}

.stop-button__icon {
  background: linear-gradient(135deg, #446fb0 0%, #1d3b70 100%) !important;
  border: 2px solid #7f9ccc !important;
  border-radius: 0 !important;
  box-shadow:
    inset 2px 2px 0 rgba(255,255,255,.35),
    inset -2px -2px 0 rgba(0,0,0,.25) !important;
}

.project-path { border-radius: 0 !important; background: #ffffff !important; color: #1b2535 !important; }
"""

CODEX_BLACK_CSS = """\
/* CBE skin — Codex Black (the original). Empty by design: the panel's
   inline <style> block IS the Black Edition look. Selecting this skin
   simply swaps the previous skin's <link href> away so the inline rules
   apply unmodified. Kept as a named, distributable package so the user
   can pick "Codex Black" in the dropdown to return to the default. */
/* (no overrides) */
"""

BESPOKE = {
    "codex-black": {
        "label": "Codex Black (Original)",
        "author": "Trenton Tompkins",
        "description": "The original Claude Codex Black Edition look — dark shell, orange accent, monospace prompt.",
        "accent": "#e8621a",
        "css": CODEX_BLACK_CSS,
        # Stays on the defaults — orange-on-black is the original look.
        # Highlight = cyan so it cuts through the orange shell + black body.
        "palette": {**DEFAULT_MODAL_PALETTE, "highlight_color": "#3ec6e0"},
    },
    "glassy": {
        "label": "Glassy Beveled",
        "author": "OpenAI ChatGPT",
        "description": "Frosted translucent shell with cyan glow and beveled buttons.",
        "accent": "#56b7ff",
        "css": GLASSY_CSS,
        "palette": {
            "modal_bg": "#142440",       # deep frosted navy
            "modal_fg": "#eef6ff",
            "modal_border": "#8fd6ff",   # cyan accent
            "modal_title_bg_1": "#2d8dff",
            "modal_title_bg_2": "#56b7ff",
            "modal_title_fg": "#eef6ff",
            "modal_foot_bg": "#0e1a2e",
            "modal_accent": "#56b7ff",
            "highlight_color": "#ffd470",  # warm gold over frosted navy
        },
    },
    "office": {
        "label": "Square Office",
        "author": "OpenAI ChatGPT",
        "description": "Hard-corner Windows-9x bevel UI with blue Office accent.",
        "accent": "#244372",
        "css": OFFICE_CSS + BLOCKY_LABEL_CSS,
        "palette": {
            "modal_bg": "#ece9d8",       # classic Win2K beige
            "modal_fg": "#1b2535",
            "modal_border": "#244372",
            "modal_title_bg_1": "#0a246a",  # Win 95/98 active title gradient
            "modal_title_bg_2": "#a6caf0",
            "modal_title_fg": "#ffffff",
            "modal_foot_bg": "#d4d0c8",  # toolbar / 3D face grey
            "modal_accent": "#244372",
            "highlight_color": "#800000",  # classic maroon hyperlink hot
        },
    },
}


def writeSkin(skinId, label, author, description, accent, css, extra=None, palette=None):
    """Drop the skin's manifest.xml + styles.css (+ optional extra files) into
    <extension>/skins/<id>/. The 'palette' dict carries the modal color keys
    that go into <colors> in the manifest — missing keys fall back to the
    default Codex Black orange/black palette. The 'extra' map is
    {relPath: bytes} for copying additional assets (e.g. tamagotchi.gif).
    Overwrites prior content. """
    root = SKIN_DIR / skinId
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    pal = dict(DEFAULT_MODAL_PALETTE)
    if palette:
        pal.update(palette)
    (root / "manifest.xml").write_text(MANIFEST_XML.format(
        id=skinId, label=label, author=author, description=description, accent=accent,
        **pal,
    ), encoding="utf-8")
    (root / "styles.css").write_text(css, encoding="utf-8")
    if extra:
        for rel, blob in extra.items():
            dst = root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(blob)
    print(f"  wrote skin: {root}")


def zipSkin(skinId):
    """Zip <extension>/skins/<id>/ -> C:\\Users\\moren\\Desktop\\skins\\<id>.zip."""
    src = SKIN_DIR / skinId
    if not src.exists():
        return
    out = DIST_DIR / f"{skinId}.zip"
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(src.parent))
    print(f"  zipped:     {out}")


def main():
    SKIN_DIR.mkdir(parents=True, exist_ok=True)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # ── 8 parametric themes from the pack
    for sid, meta in THEMES.items():
        css = BASE_CSS.replace("{VARS}", meta["vars"]) + meta.get("extra_css", "")
        if meta.get("blocky"):
            css += BLOCKY_LABEL_CSS
        extra = None
        if sid == "tamagotchi":
            # Bundle the pixel-pet GIF — the Tamagotchi skin's extra_css
            # references it via `url('assets/tamagotchi.gif')`, resolved
            # relative to the skin's styles.css when the webview loads it.
            gif = PACK_DIR / "assets" / "tamagotchi.gif"
            if gif.exists():
                extra = {"assets/tamagotchi.gif": gif.read_bytes()}
        writeSkin(sid, meta["label"], meta["author"], meta["description"],
                  meta["accent"], css, extra, palette=MODAL_PALETTES.get(sid))
        zipSkin(sid)

    # ── 2 bespoke skins
    for sid, meta in BESPOKE.items():
        writeSkin(sid, meta["label"], meta["author"], meta["description"],
                  meta["accent"], meta["css"], palette=meta.get("palette"))
        zipSkin(sid)

    # ── Drop the old single-file mint.css; new skins use the folder format.
    legacy = SKIN_DIR / "mint.css"
    if legacy.exists():
        legacy.unlink()
        print(f"  removed legacy: {legacy}")

    print(f"\nDone. {len(THEMES) + len(BESPOKE)} skins built in {SKIN_DIR}")
    print(f"      Distribution zips in {DIST_DIR}")


if __name__ == "__main__":
    main()
