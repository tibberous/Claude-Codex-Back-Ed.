"""
build_demo_extensions.py

Builds three demo .ext bundles (zip files renamed to .ext) and writes them
into c:\\Users\\moren\\Desktop\\Claude Codex Black\\extension\\extensions\\
so they can be pushed to /home/trentontompkins.com/cbe/extension/extensions/
via the existing WinSCP `vps` saved session.

Each .ext is a zip with:
  manifest.xml
  extension.html      (single-file self-contained UI; inline CSS+JS)

Run:
  python build_demo_extensions.py
"""

from __future__ import annotations

import io
import zipfile
from datetime import date
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "extensions"
TODAY = date.today().isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Calculator
# ─────────────────────────────────────────────────────────────────────────────

CALC_MANIFEST = f"""<?xml version="1.0" encoding="UTF-8"?>
<extension id="calculator" version="0.1.0">
  <name>Calculator</name>
  <author>tibberous</author>
  <description>Standard four-function calculator. Keyboard + click input. Self-contained HTML, no dependencies.</description>
  <created>{TODAY}</created>
  <url>https://trentontompkins.com/cbe/extension/extensions/calculator.ext</url>
  <entry>extension.html</entry>
  <icon>🧮</icon>
  <min_core>1.0.0</min_core>
  <tag>tools</tag>
  <tag>math</tag>
</extension>
"""

CALC_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Calculator</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; background: #1c1f24; color: #e7eaef;
         margin: 0; padding: 16px; user-select: none; }
  .calc { width: 240px; margin: 0 auto; }
  #display { width: 100%; box-sizing: border-box; padding: 12px 14px; font: 22px ui-monospace;
             background: #0f1116; color: #ffd84d; border: 1px solid #2b313b; border-radius: 8px;
             text-align: right; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  button { padding: 14px 0; font: 18px ui-monospace; background: #2b313b; color: #e7eaef;
           border: 1px solid #3a414c; border-radius: 8px; cursor: pointer; }
  button:hover { background: #3a414c; }
  button:active { background: #1c1f24; }
  .op { background: #3a2f55; color: #d4b3ff; }
  .eq { background: #285b3f; color: #b8ffd0; grid-column: span 2; }
  .clr { background: #5b2828; color: #ffb8b8; }
</style>
<div class="calc">
  <input id="display" value="0" readonly>
  <div class="grid">
    <button class="clr" data-k="C">C</button>
    <button data-k="(">(</button>
    <button data-k=")">)</button>
    <button class="op" data-k="/">÷</button>
    <button data-k="7">7</button>
    <button data-k="8">8</button>
    <button data-k="9">9</button>
    <button class="op" data-k="*">×</button>
    <button data-k="4">4</button>
    <button data-k="5">5</button>
    <button data-k="6">6</button>
    <button class="op" data-k="-">−</button>
    <button data-k="1">1</button>
    <button data-k="2">2</button>
    <button data-k="3">3</button>
    <button class="op" data-k="+">+</button>
    <button data-k="0">0</button>
    <button data-k=".">.</button>
    <button class="eq" data-k="=">=</button>
  </div>
</div>
<script>
  (function () {
    const d = document.getElementById('display');
    let expr = '';
    function render() { d.value = expr || '0'; }
    function press(k) {
      if (k === 'C') { expr = ''; return render(); }
      if (k === '=') {
        try {
          // Restricted eval: only digits, ops, parens, decimal points
          if (/^[0-9+\\-*/().\\s]+$/.test(expr)) {
            const v = Function('"use strict";return (' + expr + ')')();
            expr = String(v);
          } else { expr = 'ERR'; }
        } catch (_) { expr = 'ERR'; }
        return render();
      }
      if (expr === 'ERR' || expr === 'Infinity' || expr === 'NaN') expr = '';
      expr += k;
      render();
    }
    document.querySelectorAll('button[data-k]').forEach(b => {
      b.onclick = () => press(b.getAttribute('data-k'));
    });
    window.addEventListener('keydown', (e) => {
      if (/^[0-9+\\-*/().]$/.test(e.key)) { press(e.key); return; }
      if (e.key === 'Enter' || e.key === '=') { press('='); e.preventDefault(); return; }
      if (e.key === 'Backspace') { expr = expr.slice(0, -1); render(); return; }
      if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') { press('C'); return; }
    });
    render();
  })();
</script>
"""


# ─────────────────────────────────────────────────────────────────────────────
# 2. Minesweeper
# ─────────────────────────────────────────────────────────────────────────────

MINES_MANIFEST = f"""<?xml version="1.0" encoding="UTF-8"?>
<extension id="minesweeper" version="0.1.0">
  <name>Minesweeper</name>
  <author>tibberous</author>
  <description>Classic minesweeper. 9x9 grid, 10 mines. Left-click to reveal, right-click to flag, double-click revealed cells to chord.</description>
  <created>{TODAY}</created>
  <url>https://trentontompkins.com/cbe/extension/extensions/minesweeper.ext</url>
  <entry>extension.html</entry>
  <icon>💣</icon>
  <min_core>1.0.0</min_core>
  <tag>game</tag>
  <tag>puzzle</tag>
</extension>
"""

MINES_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Minesweeper</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; background: #1c1f24; color: #e7eaef;
         margin: 0; padding: 16px; user-select: none; }
  h3 { margin: 0 0 8px 0; text-align: center; }
  #info { text-align: center; margin-bottom: 8px; font-size: 13px; color: #b9bec7; }
  #grid { display: grid; gap: 2px; margin: 0 auto; width: max-content;
          grid-template-columns: repeat(9, 28px); }
  .cell { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
          font: 600 14px ui-monospace; background: #3a414c; color: #e7eaef; cursor: pointer;
          border: 1px solid #4a525e; }
  .cell.revealed { background: #1c1f24; border-color: #2b313b; cursor: default; }
  .cell.mine { background: #5b2828; color: #ffb8b8; }
  .cell.flag { color: #ffd84d; }
  .n1 { color: #6fb0ff; } .n2 { color: #7fd58a; } .n3 { color: #ff8a8a; }
  .n4 { color: #c08aff; } .n5 { color: #ff8a4a; } .n6 { color: #4adcff; }
  button { display: block; margin: 8px auto 0; padding: 6px 12px; background: #2b313b;
           color: #e7eaef; border: 1px solid #3a414c; border-radius: 6px; cursor: pointer;
           font: 13px ui-monospace; }
</style>
<h3>Minesweeper</h3>
<div id="info">Flags: <span id="flags">0</span>/10 · <span id="status">…</span></div>
<div id="grid"></div>
<button id="reset">Reset</button>
<script>
  (function () {
    const W = 9, H = 9, MINES = 10;
    const grid = document.getElementById('grid');
    const flagsEl = document.getElementById('flags');
    const statusEl = document.getElementById('status');
    let board, revealed, flagged, dead, won;

    function init() {
      board = Array.from({length: H}, () => Array(W).fill(0));
      revealed = Array.from({length: H}, () => Array(W).fill(false));
      flagged = Array.from({length: H}, () => Array(W).fill(false));
      dead = false; won = false;
      let placed = 0;
      while (placed < MINES) {
        const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H);
        if (board[y][x] === -1) continue;
        board[y][x] = -1; placed++;
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (board[y][x] === -1) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (board[ny][nx] === -1) c++;
        }
        board[y][x] = c;
      }
      render();
    }

    function reveal(x, y) {
      if (dead || won) return;
      if (revealed[y][x] || flagged[y][x]) return;
      revealed[y][x] = true;
      if (board[y][x] === -1) {
        dead = true;
        for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++)
          if (board[yy][xx] === -1) revealed[yy][xx] = true;
        return;
      }
      if (board[y][x] === 0) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          reveal(nx, ny);
        }
      }
    }

    function checkWin() {
      let safe = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (board[y][x] !== -1 && revealed[y][x]) safe++;
      }
      if (safe === W * H - MINES) won = true;
    }

    function render() {
      grid.innerHTML = '';
      let flagCount = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = document.createElement('div');
        c.className = 'cell';
        if (flagged[y][x]) { flagCount++; c.classList.add('flag'); c.textContent = '⚑'; }
        if (revealed[y][x]) {
          c.classList.add('revealed');
          if (board[y][x] === -1) { c.classList.add('mine'); c.textContent = '✸'; }
          else if (board[y][x] > 0) { c.classList.add('n' + board[y][x]); c.textContent = board[y][x]; }
        }
        c.oncontextmenu = (e) => {
          e.preventDefault();
          if (dead || won || revealed[y][x]) return;
          flagged[y][x] = !flagged[y][x];
          render();
        };
        c.onclick = () => { reveal(x, y); checkWin(); render(); };
        grid.appendChild(c);
      }
      flagsEl.textContent = flagCount;
      statusEl.textContent = dead ? '💥 BOOM' : (won ? '🎉 WIN' : 'playing');
    }
    document.getElementById('reset').onclick = init;
    init();
  })();
</script>
"""


# ─────────────────────────────────────────────────────────────────────────────
# 3. Emoji / special character picker
# ─────────────────────────────────────────────────────────────────────────────

EMOJI_MANIFEST = f"""<?xml version="1.0" encoding="UTF-8"?>
<extension id="emoji-picker" version="0.1.0">
  <name>Emoji Picker</name>
  <author>tibberous</author>
  <description>Searchable grid of common emoji and special unicode characters (arrows, math, currency, punctuation). Click to copy to clipboard.</description>
  <created>{TODAY}</created>
  <url>https://trentontompkins.com/cbe/extension/extensions/emoji-picker.ext</url>
  <entry>extension.html</entry>
  <icon>😀</icon>
  <min_core>1.0.0</min_core>
  <tag>tools</tag>
  <tag>unicode</tag>
</extension>
"""

EMOJI_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Emoji Picker</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #1c1f24; color: #e7eaef;
         margin: 0; padding: 16px; user-select: none; }
  #search { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f1116;
            color: #e7eaef; border: 1px solid #2b313b; border-radius: 6px; margin-bottom: 10px;
            font: 14px ui-monospace; }
  h4 { margin: 12px 0 6px 0; font-size: 12px; color: #b9bec7; text-transform: uppercase;
       letter-spacing: 0.06em; }
  .grid { display: grid; gap: 4px; grid-template-columns: repeat(10, 1fr); }
  .pick { padding: 6px 0; font-size: 20px; text-align: center; background: #2b313b;
          border: 1px solid #3a414c; border-radius: 6px; cursor: pointer; }
  .pick:hover { background: #3a414c; }
  #status { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
            background: #285b3f; color: #b8ffd0; padding: 6px 12px; border-radius: 6px;
            font: 12px ui-monospace; opacity: 0; transition: opacity .2s; }
  #status.show { opacity: 1; }
</style>
<input id="search" placeholder="search…" autofocus>
<div id="out"></div>
<div id="status">copied</div>
<script>
  (function () {
    const CATEGORIES = {
      "Faces": "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵".split(' '),
      "Gestures": "👋 🤚 ✋ 🖐️ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏".split(' '),
      "Animals": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🦂 🕷️ 🐙 🦀 🐠 🐟 🐬 🐳 🦈 🐊 🐅 🐆 🦓 🦒 🐘 🦏 🦛 🐪 🐫 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊️".split(' '),
      "Food": "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🫔 🥙 🧆 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾".split(' '),
      "Travel": "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🛺 🚲 🛴 🛹 🛼 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥".split(' '),
      "Symbols": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭".split(' '),
      "Arrows": "← → ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ⇐ ⇒ ⇑ ⇓ ⇔ ⇕ ↩ ↪ ⤴ ⤵ ⬅ ➡ ⬆ ⬇ ⬈ ⬉ ⬊ ⬋ ➤ ➜ ➥ ➦ ➧ ➨ ➩ ➪ ➫ ➬ ➭ ➮ ➯ ➱ ➲ ➳ ➵ ➸ ➻ ➼ ➽".split(' '),
      "Math":   "± × ÷ ≈ ≠ ≤ ≥ √ ∞ ∑ ∏ ∫ ∂ ∇ ∈ ∉ ⊂ ⊃ ⊆ ⊇ ∪ ∩ ∧ ∨ ¬ ⊕ ⊗ ⊥ ∥ ° ′ ″ π τ φ θ μ Δ Σ Ω α β γ δ ε ζ η λ ρ σ".split(' '),
      "Currency": "$ € £ ¥ ¢ ₹ ₽ ₩ ₪ ₫ ₱ ₦ ฿ ₴ ₸ ₺ ₼ ₾ ₿ ¤".split(' '),
      "Punctuation": "— – · • … ‹ › « » “ ” ‘ ’ ¶ § † ‡ ※ ¿ ¡ ‰ ‱ ✓ ✗ ✘ ✔ ★ ☆ ✦ ✧ ✪ ✫ ✬ ✭ ✮ ✯ ✰".split(' '),
    };
    const out = document.getElementById('out');
    const status = document.getElementById('status');
    const search = document.getElementById('search');

    function render(filter) {
      out.innerHTML = '';
      const q = (filter || '').toLowerCase().trim();
      for (const [cat, chars] of Object.entries(CATEGORIES)) {
        const matched = q ? chars.filter(c => c.toLowerCase().includes(q) || cat.toLowerCase().includes(q)) : chars;
        if (!matched.length) continue;
        const h = document.createElement('h4'); h.textContent = cat; out.appendChild(h);
        const g = document.createElement('div'); g.className = 'grid';
        for (const c of matched) {
          const b = document.createElement('div');
          b.className = 'pick'; b.textContent = c; b.title = c;
          b.onclick = () => {
            try { navigator.clipboard.writeText(c); } catch (_) {}
            status.textContent = 'copied "' + c + '"';
            status.classList.add('show');
            setTimeout(() => status.classList.remove('show'), 800);
          };
          g.appendChild(b);
        }
        out.appendChild(g);
      }
    }
    search.addEventListener('input', () => render(search.value));
    render('');
  })();
</script>
"""


# ─────────────────────────────────────────────────────────────────────────────
# Build all three .ext files
# ─────────────────────────────────────────────────────────────────────────────

DEFINITIONS = [
    ("calculator",   CALC_MANIFEST,  CALC_HTML),
    ("minesweeper",  MINES_MANIFEST, MINES_HTML),
    ("emoji-picker", EMOJI_MANIFEST, EMOJI_HTML),
]


def build_one(ext_id: str, manifest_xml: str, extension_html: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{ext_id}.ext"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.xml", manifest_xml)
        zf.writestr("extension.html", extension_html)
    out.write_bytes(buf.getvalue())
    return out


def main() -> int:
    for ext_id, manifest, html in DEFINITIONS:
        path = build_one(ext_id, manifest, html)
        print(f"WROTE {path}  bytes={path.stat().st_size}")
    print(f"\ndone. {len(DEFINITIONS)} demo .ext files in {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
