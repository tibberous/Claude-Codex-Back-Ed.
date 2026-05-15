/* ────────────────────────────────────────────────────────────────────────
   TamagotchiGame — Complete game state, lifecycle, and sound synthesis.

   Manages:
   - Stats: hunger, happiness, health, cleanliness, age (decay over time)
   - Animation state: idle, eating, sleeping, happy, sad, sick, dead
   - Button actions: feed (meat/eggplant), clean, play, shot, toggle light
   - Web Audio API synthesis for 6 retro 8-bit sounds (no binary files)
   - Integration with DotMatrix40 sprite renderer and TAMAGOTCHI_SPRITES

   Sound contract (synthesized via OscillatorNode):
   - sfxFeed()    — rising chirp (happy)
   - sfxClean()   — wet swoosh (white noise burst, lowpass)
   - sfxPlay()    — happy two-note jingle
   - sfxShot()    — descending zap
   - sfxButton()  — soft click for any button press
   - sfxDeath()   — somber descending tone

   Mute control: TamagotchiGame.muteSfx = true silences all.
   ──────────────────────────────────────────────────────────────────────── */

(function (global) {
    "use strict";

    if (global.TamagotchiGame) return;

    class TamagotchiGame {
        constructor(matrix, sprites, opts) {
            opts = opts || {};
            this.matrix = matrix;
            this.sprites = sprites || window.TAMAGOTCHI_SPRITES || {};

            // Stats (0..100)
            this.hunger = opts.hunger ?? 100;
            this.happiness = opts.happiness ?? 100;
            this.health = opts.health ?? 100;
            this.cleanliness = opts.cleanliness ?? 100;
            this.age = opts.age ?? 0;  // minutes since hatch

            // State
            this.isSleeping = false;
            this.isAlive = true;
            this.currentAnimation = "idle";
            this.animationFrame = 0;
            this.tickCount = 0;
            this.poopSpritesOnScreen = 0;
            this.lastFeedTime = Date.now();
            this.feedCooldown = 5000;  // 5s after feeding before poop chance

            // Sound control
            this.audioContext = null;
            this.soundVolume = opts.soundVolume ?? 0.15;

            // Game loop
            this.tickInterval = null;
            this.tickRate = 100;  // ms per tick

            // Mute flag (static, applies to all instances)
            TamagotchiGame.muteSfx = opts.muteSfx ?? false;
        }

        /* ──── Audio Context ──── */
        getAudioContext() {
            if (!this.audioContext) {
                const AC = global.AudioContext || global.webkitAudioContext;
                if (AC) {
                    this.audioContext = new AC();
                }
            }
            return this.audioContext;
        }

        playSound(fn) {
            if (TamagotchiGame.muteSfx) return;
            try {
                const ctx = this.getAudioContext();
                if (ctx && typeof fn === 'function') {
                    fn.call(this, ctx);
                }
            } catch (e) {
                console.warn("[Tamagotchi] Sound error:", e.message);
            }
        }

        /* ──── Synthesized SFX (Web Audio API only) ──── */

        sfxFeed() {
            /* Rising chirp: start at 400Hz, rise to 800Hz over 0.1s */
            this.playSound((ctx) => {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = "sine";
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.exponentialRampToValueAtTime(800, now + 0.1);

                gain.gain.setValueAtTime(this.soundVolume, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

                osc.start(now);
                osc.stop(now + 0.1);
            });
        }

        sfxClean() {
            /* Wet swoosh: white noise burst, lowpass, 0.15s */
            this.playSound((ctx) => {
                const now = ctx.currentTime;

                // White noise via empty AudioBuffer (random values)
                const len = ctx.sampleRate * 0.15;
                const noise = ctx.createBufferSource();
                const buf = ctx.createBuffer(1, len, ctx.sampleRate);
                const ch = buf.getChannelData(0);
                for (let i = 0; i < len; i++) {
                    ch[i] = Math.random() * 2 - 1;
                }
                noise.buffer = buf;

                // Lowpass filter to shape the swoosh
                const filter = ctx.createBiquadFilter();
                filter.type = "lowpass";
                filter.frequency.setValueAtTime(2000, now);
                filter.frequency.exponentialRampToValueAtTime(200, now + 0.15);

                const gain = ctx.createGain();
                gain.gain.setValueAtTime(this.soundVolume * 0.6, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

                noise.connect(filter);
                filter.connect(gain);
                gain.connect(ctx.destination);

                noise.start(now);
                noise.stop(now + 0.15);
            });
        }

        sfxPlay() {
            /* Happy two-note jingle: 600Hz → 900Hz, two quick notes */
            this.playSound((ctx) => {
                const now = ctx.currentTime;

                // First note: 600Hz, 0.08s
                const osc1 = ctx.createOscillator();
                const gain1 = ctx.createGain();
                osc1.connect(gain1);
                gain1.connect(ctx.destination);
                osc1.type = "sine";
                osc1.frequency.setValueAtTime(600, now);
                gain1.gain.setValueAtTime(this.soundVolume, now);
                gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
                osc1.start(now);
                osc1.stop(now + 0.08);

                // Second note: 900Hz, 0.08s, offset by 0.1s
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.type = "sine";
                osc2.frequency.setValueAtTime(900, now + 0.1);
                gain2.gain.setValueAtTime(this.soundVolume, now + 0.1);
                gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
                osc2.start(now + 0.1);
                osc2.stop(now + 0.18);
            });
        }

        sfxShot() {
            /* Descending zap: 1200Hz → 300Hz over 0.15s */
            this.playSound((ctx) => {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = "square";
                osc.frequency.setValueAtTime(1200, now);
                osc.frequency.exponentialRampToValueAtTime(300, now + 0.15);

                gain.gain.setValueAtTime(this.soundVolume * 0.7, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

                osc.start(now);
                osc.stop(now + 0.15);
            });
        }

        sfxButton() {
            /* Soft click: brief 800Hz chirp, ~0.05s */
            this.playSound((ctx) => {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = "sine";
                osc.frequency.setValueAtTime(800, now);

                gain.gain.setValueAtTime(this.soundVolume * 0.4, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

                osc.start(now);
                osc.stop(now + 0.05);
            });
        }

        sfxDeath() {
            /* Somber descending tone: 500Hz → 100Hz over 0.4s */
            this.playSound((ctx) => {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = "sine";
                osc.frequency.setValueAtTime(500, now);
                osc.frequency.exponentialRampToValueAtTime(100, now + 0.4);

                gain.gain.setValueAtTime(this.soundVolume * 0.8, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

                osc.start(now);
                osc.stop(now + 0.4);
            });
        }

        /* ──── Game Actions (wired to buttons) ──── */

        feedMeat() {
            this.sfxButton();
            this.sfxFeed();
            this.hunger = Math.min(100, this.hunger + 30);
            this.happiness = Math.min(100, this.happiness + 5);
            this.lastFeedTime = Date.now();
        }

        feedEggplant() {
            this.sfxButton();
            this.sfxFeed();
            this.hunger = Math.min(100, this.hunger + 20);
            this.health = Math.min(100, this.health + 10);
            this.lastFeedTime = Date.now();
        }

        cleanPoop() {
            this.sfxButton();
            this.sfxClean();
            this.cleanliness = Math.min(100, this.cleanliness + 20);
            this.poopSpritesOnScreen = 0;
        }

        play() {
            this.sfxButton();
            this.sfxPlay();
            this.happiness = Math.min(100, this.happiness + 25);
            this.hunger = Math.max(0, this.hunger - 5);
        }

        giveShot() {
            this.sfxButton();
            this.sfxShot();
            this.health = Math.min(100, this.health + 30);
            this.happiness = Math.max(0, this.happiness - 10);
        }

        toggleLight() {
            this.sfxButton();
            this.isSleeping = !this.isSleeping;
        }

        /* ──── State & Animation ──── */

        updateAnimation() {
            if (!this.isAlive) {
                this.currentAnimation = "dead";
            } else if (this.health < 20) {
                this.currentAnimation = "sick";
            } else if (this.isSleeping) {
                this.currentAnimation = "sleeping";
            } else if (this.hunger < 20) {
                this.currentAnimation = "sad";
            } else if (this.happiness > 70) {
                this.currentAnimation = "happy";
            } else {
                this.currentAnimation = "idle";
            }
        }

        render() {
            const sprite = this.sprites[this.currentAnimation];
            if (!sprite) return;

            const frames = Array.isArray(sprite) ? sprite : [sprite];
            const frame = frames[this.animationFrame % frames.length];
            this.matrix.setFrame(frame);
            this.matrix.render();

            // Advance animation frame
            this.animationFrame = (this.animationFrame + 1) % (frames.length * 4);  // 4 ticks per frame
        }

        tick(deltaMs) {
            if (!this.isAlive) return;

            deltaMs = deltaMs || this.tickRate;
            this.tickCount++;
            const secondsPerTick = deltaMs / 1000;

            // Stat decay (per second, scaled to tick interval)
            const decayPerTick = secondsPerTick / 60;  // per-minute base
            this.hunger = Math.max(0, this.hunger - 0.15 * decayPerTick);
            this.happiness = Math.max(0, this.happiness - 0.10 * decayPerTick);
            this.health = Math.max(0, this.health - 0.05 * decayPerTick);
            this.cleanliness = Math.max(0, this.cleanliness - 0.08 * decayPerTick);

            // Age (1 minute per ~600 ticks @ 100ms)
            if (this.tickCount % 600 === 0) {
                this.age += 1;
            }

            // Death conditions
            if (this.hunger <= 0 || this.health <= 0) {
                this.isAlive = false;
                this.sfxDeath();
            }

            // Poop production (after cooldown, small chance per tick)
            if (!this.isSleeping && Date.now() - this.lastFeedTime > this.feedCooldown) {
                if (Math.random() < 0.01) {  // 1% chance per tick
                    this.poopSpritesOnScreen = Math.min(3, this.poopSpritesOnScreen + 1);
                    this.cleanliness = Math.max(0, this.cleanliness - 15);
                }
            }

            // Update animation state and render
            this.updateAnimation();
            this.render();
        }

        start() {
            if (this.tickInterval) return;
            this.tickInterval = setInterval(() => this.tick(this.tickRate), this.tickRate);
        }

        stop() {
            if (this.tickInterval) {
                clearInterval(this.tickInterval);
                this.tickInterval = null;
            }
            if (this.audioContext) {
                try {
                    this.audioContext.close();
                } catch (e) {
                    // Ignore
                }
                this.audioContext = null;
            }
        }
    }

    global.TamagotchiGame = TamagotchiGame;

})(typeof window !== "undefined" ? window : global);
