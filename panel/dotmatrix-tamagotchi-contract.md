# DotMatrix Tamagotchi — agent contract

Two agents are working in parallel on the Tamagotchi skin replacement.
They MUST agree on the names below or the integration will not work.

## File ownership

| File                                                | Owner          | Allowed to edit  |
| --------------------------------------------------- | -------------- | ---------------- |
| `panel/dotmatrix.js`                                | already shipped | DO NOT EDIT     |
| `panel/dotmatrix-tamagotchi-sprites.js`             | Agent A (art)  | sole owner       |
| `panel/dotmatrix-tamagotchi-game.js`                | Agent B (game) | sole owner       |
| `panel/index.html` (canvas + script tags + DOM)     | Agent B        | sole owner       |
| `skins/tamagotchi/styles.css` (visibility + layout) | Agent B        | sole owner       |
| `skins/tamagotchi/assets/`                          | both           | additive only    |

## Sprite identifiers Agent A MUST export

`window.TAMAGOTCHI_SPRITES` — single global object.

Each value is either an ASCII string OR an array of ASCII strings (animated).

```
window.TAMAGOTCHI_SPRITES = {
  // Creature animations — 30 frames TOTAL distributed across these states.
  // Each value is an array of frame strings. Frame format = ASCII art per
  // dotmatrix.js spriteFromAscii: '.', ' ', '0' = OFF, anything else = ON.
  // Creature sprites are 24x24 to leave LCD margin inside the 40x40 grid.
  idle:        [...],   // 4 frames — gentle bob + occasional blink
  walking:     [...],   // 4 frames
  eating:      [...],   // 4 frames — chewing motion
  sleeping:    [...],   // 4 frames — Z's float up
  happy:       [...],   // 4 frames — bouncing
  sad:         [...],   // 4 frames — droopy + tear
  sick:        [...],   // 3 frames — green tint cue + frown
  dead:        [...],   // 3 frames — ghost rising

  // Item sprites — 12x12 each, single frame strings (NOT arrays).
  meat:        "...",
  eggplant:    "...",
  poop:        "...",
  syringe:     "...",   // for shots
  ball:        "...",   // for play

  // Hardware-button glyphs — render INSIDE the .tama-btn-* DOM elements
  // (NOT on the dot-matrix canvas). 16x16 ASCII strings the game
  // converts to inline-SVG via DotMatrix40.spriteFromAscii so buttons
  // stay crisp at any DPI.
  btnFeed:     "...",
  btnClean:    "...",
  btnPlay:     "...",
  btnShot:     "...",
  btnLight:    "...",   // toggles sleep
  btnSelect:   "...",   // select option in feed menu (meat/eggplant)
};
```

Total animation frames the creature must cover: **30** across the 8 states
above. Distribute however reads best (the suggested 4/4/4/4/4/4/3/3 = 30
matches that). Static items + buttons are NOT counted in the 30.

## Game state Agent B exposes

`window.TamagotchiGame` — single global, instantiated by panel/index.html init:

```
class TamagotchiGame {
  constructor(matrix, sprites, opts) { ... }   // matrix = DotMatrix40 instance

  // Stats — clamped 0..100. Decay over time. Updated every tick().
  hunger      // 0 = starving (creature dies), 100 = full
  happiness   // 0 = depressed, 100 = thrilled
  health      // 0 = dies, 100 = perfect
  cleanliness // 0 = covered in poop, 100 = pristine
  age         // minutes since hatch
  isSleeping  // boolean
  isAlive     // boolean

  // Actions (wired to buttons by Agent B)
  feedMeat()       // +30 hunger, +5 happiness, may produce poop in 30s
  feedEggplant()   // +20 hunger, +10 health
  cleanPoop()      // removes poop sprite, +20 cleanliness
  play()           // +25 happiness, -5 hunger
  giveShot()       // +30 health, -10 happiness (shots hurt)
  toggleLight()    // toggles sleep state

  // Lifecycle
  tick(deltaMs)    // called by setInterval; advances stats + animation state
  start()
  stop()
}
```

## Sound contract

Use Web Audio API only — NO binary audio files (CSP nightmare in webview).
Synthesize short blips via OscillatorNode.

Required SFX names Agent B must define:
- `sfxFeed()` — short rising chirp
- `sfxClean()` — wet swoosh (white noise burst, lowpass)
- `sfxPlay()` — happy two-note jingle
- `sfxShot()` — descending zap
- `sfxButton()` — soft click for any button press
- `sfxDeath()` — somber descending tone

Mute toggle: `TamagotchiGame.muteSfx = true` should silence all of them.

## DOM Agent B adds to panel/index.html

Inside the existing `.demo-stage`, add a wrapper that ONLY renders when
the tamagotchi skin's CSS toggles its `display`:

```html
<div id="cbe-tama-shell" hidden>
  <canvas id="cbe-tama-screen"></canvas>
  <div id="cbe-tama-status" role="status" aria-live="polite">
    <span class="tama-stat" data-stat="hunger" data-tooltip="Hunger">🍖 100</span>
    <span class="tama-stat" data-stat="happiness" data-tooltip="Happiness">😀 100</span>
    <span class="tama-stat" data-stat="health" data-tooltip="Health">❤️ 100</span>
    <span class="tama-stat" data-stat="cleanliness" data-tooltip="Cleanliness">✨ 100</span>
    <span class="tama-stat" data-stat="age" data-tooltip="Age in minutes">⏱ 0</span>
  </div>
  <div id="cbe-tama-buttons">
    <button class="tama-btn" data-action="feed"   data-tooltip="Feed (meat / eggplant)"></button>
    <button class="tama-btn" data-action="clean"  data-tooltip="Clean poop"></button>
    <button class="tama-btn" data-action="play"   data-tooltip="Play"></button>
    <button class="tama-btn" data-action="shot"   data-tooltip="Give shot (heals when sick)"></button>
    <button class="tama-btn" data-action="light"  data-tooltip="Toggle light (sleep)"></button>
    <button class="tama-btn" data-action="select" data-tooltip="Select"></button>
  </div>
</div>
```

The `hidden` attribute is removed by tamagotchi/styles.css with a rule like
`body[data-skin="tamagotchi"] #cbe-tama-shell { display: block; }` OR
the script-loaded init flips it when the skin loads (Agent B's call).

## Skin CSS Agent B owns

`skins/tamagotchi/styles.css` must:
- HIDE the existing `.prompt-shell::before` GIF rule (replace with `display: none`).
- POSITION `#cbe-tama-shell` where the GIF used to live (left edge of prompt-shell, ~168px wide).
- Style the canvas as the green-LCD inner screen (pixelated rendering, dark green frame).
- Style the buttons as physical Tamagotchi shell buttons (raised, bevel, audible click feel via box-shadow).
- Style the status bar as a slim row above the screen.

## Done criteria

1. `dotmatrix-tamagotchi-sprites.js` and `dotmatrix-tamagotchi-game.js` are both syntactically valid (`node -c`).
2. All 6 buttons fire the correct `TamagotchiGame.<action>()` method.
3. All 5 SFX functions produce audible output (verified by Agent B's smoke test).
4. The canvas renders at least the idle animation when the page loads with skin=tamagotchi.
5. Stats decay over time (visible via the status row).
6. Tooltips render on hover (handled by the existing CBE tooltip system if any, OR a simple `title` attribute fallback).
