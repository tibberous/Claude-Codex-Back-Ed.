/* ────────────────────────────────────────────────────────────────────────
   DotMatrix40 — 40x40 on/off pixel display engine for the Tamagotchi skin
   (and any future pixel-art surface CBE wants).

   Why exists: the Tamagotchi skin used a static GIF for its pet creature.
   The user wants a live dot-matrix display so the pet can animate, react
   to events, and surface poop / food / etc. without a frame of pre-rendered
   GIF. This engine is a tiny canvas-backed renderer + sprite library.

   Frame storage : Uint8Array of length cols*rows. 0 = OFF, 1 = ON.
   Render        : per-cell paint to a 2D canvas. Cell size + colors are
                   configurable so the same engine can render a classic
                   green-LCD Tamagotchi screen OR a black-on-amber pager OR
                   anything else.
   Sprite format : ASCII art strings. One char per pixel. '.', ' ' or '0'
                   = OFF; anything else = ON. Lines are rows top-to-bottom.
                   Lets the sprite library read like a quilt pattern instead
                   of an opaque uint8 dump.
   Animation     : pass an array of frames + fps to startAnimation. Each
                   "frame" is an ASCII sprite OR a Uint8Array OR a
                   pre-baked DotMatrix40.Frame instance.

   Public surface (window.DotMatrix40):
     new DotMatrix40(canvas, opts)
     .setPixel(x, y, on)
     .togglePixel(x, y)
     .clear() / .fill()
     .blit(sprite, ox, oy)              // draw smaller sprite onto the grid
     .setFrame(spriteOrUint8)           // replace whole frame
     .render()                          // paint to canvas
     .startAnimation(frames, fps)       // cycle through frames forever
     .stopAnimation()
     DotMatrix40.spriteFromAscii(text)  // → Uint8Array + width/height

   The sprite library (Tamagotchi creature frames, meat, eggplant, poop,
   buttons) lives in dotmatrix-tamagotchi.js so this engine stays generic.
   ──────────────────────────────────────────────────────────────────────── */

(function (global) {
    "use strict";

    if (global.DotMatrix40) return;

    const COLS = 40;
    const ROWS = 40;

    function spriteFromAscii(text) {
        /* Parse a multi-line string of '.'/'O' into {data:Uint8Array, w, h}.
           Trims trailing/leading blank lines so it's safe to author with a
           leading newline (which is more readable in JS). Uses the longest
           row as the width and pads shorter rows with OFF. */
        const lines = String(text || "").replace(/\r/g, "").split("\n");
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const h = lines.length;
        let w = 0;
        for (const line of lines) if (line.length > w) w = line.length;
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = lines[y];
            for (let x = 0; x < w; x++) {
                const ch = x < row.length ? row[x] : ".";
                if (ch !== "." && ch !== " " && ch !== "0") {
                    data[y * w + x] = 1;
                }
            }
        }
        return { data, w, h };
    }

    class DotMatrix40 {
        constructor(canvas, opts) {
            opts = opts || {};
            this.cols = COLS;
            this.rows = ROWS;
            this.cellSize = Math.max(1, Math.round(opts.cellSize || 5));
            this.gap = Math.max(0, Math.round(opts.gap || 0));   // optional inter-pixel gap
            this.onColor = opts.onColor || "#1a3010";
            this.offColor = opts.offColor || "#7fb83a";
            this.bgColor = opts.bgColor || "#86bd3e";
            this.cellShape = opts.cellShape || "rect"; // 'rect' | 'circle'
            this.canvas = canvas;
            this.ctx = canvas.getContext("2d");
            const pixSize = this.cellSize + this.gap;
            this.canvas.width = this.cols * pixSize - this.gap;
            this.canvas.height = this.rows * pixSize - this.gap;
            this.frame = new Uint8Array(this.cols * this.rows);
            this._anim = null;
            this.render();
        }

        _index(x, y) { return y * this.cols + x; }

        setPixel(x, y, on) {
            if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
            this.frame[this._index(x, y)] = on ? 1 : 0;
        }

        togglePixel(x, y) {
            if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
            const i = this._index(x, y);
            this.frame[i] = this.frame[i] ? 0 : 1;
        }

        clear() { this.frame.fill(0); }
        fill() { this.frame.fill(1); }

        /* Draw a smaller sprite at (ox,oy). sprite can be:
             - { data:Uint8Array, w, h } as returned by spriteFromAscii
             - a multi-line ASCII string (parsed via spriteFromAscii)
           Pixels off the grid are clipped. ON pixels SET; OFF pixels do NOT
           clear (so multiple sprites layer additively). Use blitOpaque to
           also write OFF pixels. */
        blit(sprite, ox, oy) {
            ox = ox | 0; oy = oy | 0;
            const s = (typeof sprite === "string") ? spriteFromAscii(sprite) : sprite;
            if (!s || !s.data) return;
            for (let y = 0; y < s.h; y++) {
                const ty = oy + y;
                if (ty < 0 || ty >= this.rows) continue;
                for (let x = 0; x < s.w; x++) {
                    if (!s.data[y * s.w + x]) continue;
                    const tx = ox + x;
                    if (tx < 0 || tx >= this.cols) continue;
                    this.frame[this._index(tx, ty)] = 1;
                }
            }
        }

        blitOpaque(sprite, ox, oy) {
            /* Writes both ON and OFF cells from the sprite — useful for
               replacing a region wholesale (e.g. a full 40x40 frame). */
            ox = ox | 0; oy = oy | 0;
            const s = (typeof sprite === "string") ? spriteFromAscii(sprite) : sprite;
            if (!s || !s.data) return;
            for (let y = 0; y < s.h; y++) {
                const ty = oy + y;
                if (ty < 0 || ty >= this.rows) continue;
                for (let x = 0; x < s.w; x++) {
                    const tx = ox + x;
                    if (tx < 0 || tx >= this.cols) continue;
                    this.frame[this._index(tx, ty)] = s.data[y * s.w + x] ? 1 : 0;
                }
            }
        }

        setFrame(spriteOrUint8) {
            /* Replace the entire 40x40 grid in one call. Accepts a sprite
               object, an ASCII string, or a flat Uint8Array of length 1600. */
            if (spriteOrUint8 instanceof Uint8Array && spriteOrUint8.length === this.cols * this.rows) {
                this.frame.set(spriteOrUint8);
                return;
            }
            this.clear();
            const s = (typeof spriteOrUint8 === "string") ? spriteFromAscii(spriteOrUint8) : spriteOrUint8;
            if (s && s.data) {
                /* Center the sprite if it's smaller than 40x40. */
                const ox = Math.max(0, Math.floor((this.cols - s.w) / 2));
                const oy = Math.max(0, Math.floor((this.rows - s.h) / 2));
                this.blitOpaque(s, ox, oy);
            }
        }

        render() {
            const ctx = this.ctx;
            const cs = this.cellSize;
            const step = cs + this.gap;
            ctx.fillStyle = this.bgColor;
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            const onColor = this.onColor;
            const offColor = this.offColor;
            const drawCircle = this.cellShape === "circle";
            const r = cs / 2;
            for (let y = 0; y < this.rows; y++) {
                for (let x = 0; x < this.cols; x++) {
                    const px = x * step;
                    const py = y * step;
                    const on = this.frame[y * this.cols + x] === 1;
                    ctx.fillStyle = on ? onColor : offColor;
                    if (drawCircle) {
                        ctx.beginPath();
                        ctx.arc(px + r, py + r, r * 0.92, 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        ctx.fillRect(px, py, cs, cs);
                    }
                }
            }
        }

        /* Animation. `frames` may be array of (sprite|ascii-string|Uint8Array).
           Each frame replaces the whole grid via setFrame(). At fps frames/sec.
           Loops forever until stopAnimation() is called. */
        startAnimation(frames, fps) {
            this.stopAnimation();
            if (!Array.isArray(frames) || !frames.length) return;
            const ms = Math.max(33, Math.round(1000 / Math.max(0.5, fps || 2)));
            let i = 0;
            const tick = () => {
                this.setFrame(frames[i % frames.length]);
                this.render();
                i++;
            };
            tick();
            this._anim = global.setInterval(tick, ms);
        }

        stopAnimation() {
            if (this._anim) {
                global.clearInterval(this._anim);
                this._anim = null;
            }
        }
    }

    DotMatrix40.spriteFromAscii = spriteFromAscii;
    DotMatrix40.COLS = COLS;
    DotMatrix40.ROWS = ROWS;
    global.DotMatrix40 = DotMatrix40;
})(typeof window !== "undefined" ? window : globalThis);
