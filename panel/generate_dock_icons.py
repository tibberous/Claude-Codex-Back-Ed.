r"""Generate glassy 3D Aqua/Mint-style SVG icons for the CBE toolbar.

Per-skin templated SVG: rounded-square base, linear gradient, top shine,
inset highlight, glyph centered on top, soft drop shadow.

Output: panel\assets\dock_icons\macos\<id>.svg and \mint\<id>.svg
"""
import os

OUT = r"C:\Users\moren\Desktop\Claude Codex Black\panel\assets\dock_icons"

# (button_id, glyph_svg_inner, base_color_pair (top, bottom)) — same glyph in
# both skins, only the palette differs per skin.
# glyph_svg is rendered inside a <g> centered on (50,50). Use white fill.

GLYPHS = {
    # id              top color    bottom color (mac)
    "add": ("M50 28 V72 M28 50 H72", None),
    "storedPrompts": ("M28 30 H72 V70 H28 Z M28 42 H72 M28 54 H72 M28 66 H72", None),
    "chatHistory": ("M50 26 A24 24 0 1 1 26 50 L34 50 M28 38 L34 50 M50 36 V50 L62 56", None),  # clock + arrow
    "attachFile": ("M58 24 L34 48 A12 12 0 0 0 50 64 L70 44", None),  # paperclip
    "tts": ("M30 42 H42 L54 32 V68 L42 58 H30 Z M60 38 Q72 50 60 62", None),  # speaker waves
    "stt": ("M50 28 A8 12 0 0 1 58 40 V52 A8 12 0 0 1 42 52 V40 A8 12 0 0 1 50 28 Z M34 52 A16 16 0 0 0 66 52 M50 68 V76 M40 76 H60", None),  # microphone
    "autoReply": ("M30 50 A20 20 0 1 1 50 70 L42 64 M50 70 L42 76", None),  # circular arrow
    "wakeUp": ("M28 32 L36 26 M72 32 L64 26 M50 30 A20 20 0 1 1 49.9 30 Z M50 40 V52 L58 56", None),  # alarm clock
    "showCommands": ("M30 36 H70 M30 50 H70 M30 64 H50", None),  # menu lines
    "compact": ("M30 42 L42 30 H58 L70 42 M30 58 L42 70 H58 L70 58", None),  # compress arrows
    "handbook": ("M30 28 H62 A8 8 0 0 1 70 36 V72 H38 A8 8 0 0 1 30 64 Z M30 64 A8 8 0 0 1 38 56 H70", None),  # book
    "settings": ("M50 30 L54 38 H62 L66 46 L62 54 L66 62 L58 66 L54 74 L46 74 L42 66 L34 62 L38 54 L34 46 L42 38 Z M50 44 A6 6 0 1 0 50 56 A6 6 0 1 0 50 44", None),  # gear
    "extensions": ("M30 30 H46 V42 H58 V30 H70 V46 H58 V58 H70 V70 H58 V58 H46 V70 H30 V58 H42 V46 H30 Z", None),  # puzzle squares
    "projectFolder": ("M26 36 H46 L50 30 H72 V70 H26 Z", None),  # folder
    "browser": ("M50 26 A24 24 0 1 1 49.9 26 Z M26 50 H74 M50 26 Q34 50 50 74 M50 26 Q66 50 50 74", None),  # globe
    "monitor": ("M28 32 H72 V60 H28 Z M40 70 H60 M50 60 V70", None),  # monitor screen
    "terminal": ("M28 32 H72 V68 H28 Z M36 44 L46 50 L36 56 M48 58 H60", None),  # terminal w/ prompt
    "setup": ("M62 26 L74 38 L56 56 L48 62 L40 58 L40 50 L46 42 Z M40 58 L28 70 L34 76 L46 64", None),  # wrench
    "git": ("M40 26 A4 4 0 1 1 39.9 26 Z M40 30 V70 M40 70 A4 4 0 1 1 39.9 70 Z M40 50 H60 A4 4 0 1 1 59.9 50", None),  # git branch
    "github": ("M50 26 C35 26 26 36 26 50 C26 60 32 68 42 71 V63 C36 64 34 60 34 60 C33 58 31 57 31 57 C28 55 31 55 31 55 C34 55 35 58 35 58 C37 62 41 61 42 60 C42 58 43 56 45 55 C38 54 32 51 32 42 C32 39 33 37 35 35 C35 34 33 31 35 27 C35 27 38 27 42 30 C44 29 47 29 50 29 C53 29 56 29 58 30 C62 27 65 27 65 27 C67 31 65 34 65 35 C67 37 68 39 68 42 C68 51 62 54 55 55 C57 56 58 58 58 61 V71 C68 68 74 60 74 50 C74 36 65 26 50 26 Z", None),  # github cat
    "domains": ("M28 36 H72 M28 50 H72 M28 64 H72 M50 26 Q34 50 50 74 M50 26 Q66 50 50 74", None),  # globe lines
    "fontSize": ("M30 70 L42 30 L54 70 M34 56 H50 M62 50 L68 70 M64 64 H66", None),  # Aa
    "help": ("M50 26 A24 24 0 1 1 49.9 26 Z M40 42 Q40 32 50 32 Q60 32 60 42 Q60 50 50 52 V58 M50 64 V68", None),  # ? circle
    "tama": ("M30 36 H70 V64 H30 Z M30 40 A4 4 0 0 1 34 36 V64 A4 4 0 0 1 30 60 Z M42 50 A3 3 0 1 1 41.9 50 Z M58 50 A3 3 0 1 1 57.9 50 Z M42 58 H58", None),  # pet console
}

# Mac color palette: vivid, varied per icon function
MAC_PALETTE = {
    "add":             ("#3FBC4F", "#0E7A1F"),      # green plus
    "storedPrompts":   ("#FFD23F", "#C49600"),      # yellow notepad
    "chatHistory":     ("#6F9CFF", "#1F4ECD"),      # blue clock
    "attachFile":      ("#9AA0A6", "#54585C"),      # gray clip
    "tts":             ("#FF7A45", "#C03A0E"),      # orange speaker
    "stt":             ("#E84B5A", "#9A1530"),      # red mic
    "autoReply":       ("#26C6DA", "#016C7C"),      # cyan reload
    "wakeUp":          ("#FFC400", "#B07A00"),      # amber alarm
    "showCommands":    ("#7E57C2", "#4527A0"),      # purple menu
    "compact":         ("#4FC3F7", "#0277BD"),      # light blue compress
    "handbook":        ("#FF6E40", "#BF360C"),      # orange-red book (iBooks-ish)
    "settings":        ("#90A4AE", "#37474F"),      # graphite gear
    "extensions":      ("#AB47BC", "#6A1B9A"),      # purple puzzle
    "projectFolder":   ("#FFCA28", "#C68400"),      # yellow folder (Finder yellow)
    "browser":         ("#42A5F5", "#1565C0"),      # Safari-blue globe
    "monitor":         ("#26A69A", "#00695C"),      # teal monitor
    "terminal":        ("#37474F", "#000000"),      # black terminal
    "setup":           ("#FFAB00", "#FF6F00"),      # orange wrench
    "git":             ("#F4511E", "#BF360C"),      # git orange
    "github":          ("#212121", "#000000"),      # black github
    "domains":         ("#5C6BC0", "#283593"),      # indigo globe
    "fontSize":        ("#EC407A", "#AD1457"),      # pink Aa
    "help":            ("#29B6F6", "#0277BD"),      # blue help
    "tama":            ("#66BB6A", "#2E7D32"),      # green pet
}

# Mint palette: darker glassy bases, mint-green accents on a couple
MINT_PALETTE = {
    "add":             ("#67B863", "#2E6A2B"),      # mint green plus
    "storedPrompts":   ("#5D4037", "#2E1A12"),      # dark brown notepad
    "chatHistory":     ("#455A64", "#1C313A"),      # slate clock
    "attachFile":      ("#607D8B", "#263238"),      # blue-grey clip
    "tts":             ("#388E3C", "#1B5E20"),      # mint green speaker
    "stt":             ("#C62828", "#7F0000"),      # red mic
    "autoReply":       ("#00838F", "#005662"),      # teal reload
    "wakeUp":          ("#F57F17", "#BF360C"),      # amber alarm
    "showCommands":    ("#37474F", "#102027"),      # dark slate menu
    "compact":         ("#2E7D32", "#1B5E20"),      # mint compress
    "handbook":        ("#6D4C41", "#3E2723"),      # leather book
    "settings":        ("#424242", "#212121"),      # dark gear
    "extensions":      ("#558B2F", "#33691E"),      # olive puzzle
    "projectFolder":   ("#827717", "#3E2723"),      # mint folder (olive)
    "browser":         ("#E65100", "#BF360C"),      # firefox orange
    "monitor":         ("#00695C", "#004D40"),      # teal monitor
    "terminal":        ("#212121", "#000000"),      # black terminal
    "setup":           ("#BF360C", "#7F0000"),      # red wrench
    "git":             ("#C62828", "#7F0000"),      # git red
    "github":          ("#212121", "#000000"),      # black github
    "domains":         ("#1565C0", "#0D47A1"),      # blue globe
    "fontSize":        ("#558B2F", "#33691E"),      # olive Aa
    "help":            ("#1976D2", "#0D47A1"),      # blue help
    "tama":            ("#388E3C", "#1B5E20"),      # mint pet
}

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{top}"/>
      <stop offset="100%" stop-color="{bot}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bottomGlow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.10"/>
    </linearGradient>
    <filter id="dropShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.2"/>
      <feOffset dy="1.5" result="off"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <!-- base rounded square -->
  <rect x="6" y="6" width="88" height="88" rx="22" ry="22" fill="url(#base)" filter="url(#dropShadow)"/>
  <!-- inner highlight ring -->
  <rect x="6.5" y="6.5" width="87" height="87" rx="21.5" ry="21.5" fill="none" stroke="#ffffff" stroke-opacity="0.30" stroke-width="1"/>
  <!-- top shine -->
  <rect x="8" y="8" width="84" height="46" rx="20" ry="20" fill="url(#shine)"/>
  <!-- bottom inner glow -->
  <rect x="8" y="54" width="84" height="38" rx="18" ry="18" fill="url(#bottomGlow)"/>
  <!-- glyph -->
  <g fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="{glyph}"/>
  </g>
</svg>
"""


def emitSet(skin, palette):
    outDir = os.path.join(OUT, skin)
    os.makedirs(outDir, exist_ok=True)
    for btnId, (glyph, _) in GLYPHS.items():
        top, bot = palette[btnId]
        svg = TEMPLATE.format(top=top, bot=bot, glyph=glyph)
        with open(os.path.join(outDir, btnId + ".svg"), "w", encoding="utf-8") as fh:
            fh.write(svg)
    print(skin, ":", len(GLYPHS), "icons written to", outDir)


emitSet("macos", MAC_PALETTE)
emitSet("mint", MINT_PALETTE)
