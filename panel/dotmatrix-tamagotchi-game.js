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
            this.isSleeping = opts.isSleeping ?? false;
            this.isAlive = opts.isAlive ?? true;
            this.currentAnimation = "idle";
            this.animationFrame = 0;
            this.tickCount = 0;
            this.poopSpritesOnScreen = opts.poopSpritesOnScreen ?? 0;
            this.lastFeedTime = Date.now();
            this.feedCooldown = 5000;  // 5s after feeding before poop chance

            // Animation override — when set (e.g. "eating"), takes priority over
            // mood-based animation for `eatingMs`. Decays each tick.
            this.animationOverride = null;
            this.animationOverrideUntil = 0;

            // Feed menu (Tamagotchi-style submenu). When `feedMenuOpen` is true,
            // pressing Feed cycles between "meat" and "eggplant"; pressing
            // Select commits the highlighted choice and closes the menu.
            this.feedMenuOpen = false;
            this.feedMenuChoice = "meat";  // "meat" | "eggplant"

            // Death-handling: only play sfxDeath ONCE on the transition.
            this._deathSfxPlayed = !this.isAlive;

            // Sound control
            this.audioContext = null;
            this.soundVolume = opts.soundVolume ?? 0.15;

            // Game loop
            this.tickInterval = null;
            this.tickRate = 100;  // ms per tick

            // Mute flag (static, applies to all instances)
            TamagotchiGame.muteSfx = opts.muteSfx ?? false;

            // External hooks. UI layer wires these to refresh the stat row,
            // feed-menu glyph, and game-over screen without the game needing
            // to know about DOM. Both are optional and called every tick.
            this.onStatsChange = opts.onStatsChange || null;
            this.onDeath = opts.onDeath || null;

            // Persistence key (localStorage). UI layer is responsible for
            // calling .saveState() / .loadState() — game does not auto-write
            // every tick to keep localStorage churn low.
            this.storageKey = opts.storageKey || "cbe-tamagotchi-v1";

            // Track last-saved timestamp so `tick()` can persist every ~10s
            // without spamming localStorage.
            this._lastSaveAt = Date.now();
            this._saveIntervalMs = 10_000;
        }

        /* ──── Persistence ──── */

        serialize() {
            return {
                hunger: this.hunger,
                happiness: this.happiness,
                health: this.health,
                cleanliness: this.cleanliness,
                age: this.age,
                isSleeping: this.isSleeping,
                isAlive: this.isAlive,
                poopSpritesOnScreen: this.poopSpritesOnScreen,
                savedAt: Date.now(),
            };
        }

        saveState() {
            try {
                const data = this.serialize();
                if (typeof localStorage !== "undefined") {
                    localStorage.setItem(this.storageKey, JSON.stringify(data));
                }
                this._lastSaveAt = Date.now();
            } catch (e) {
                console.warn("[Tamagotchi] saveState error:", e.message);
            }
        }

        static loadState(key) {
            try {
                if (typeof localStorage === "undefined") return null;
                const raw = localStorage.getItem(key || "cbe-tamagotchi-v1");
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (!data || typeof data !== "object") return null;
                /* Decay stats based on real time elapsed since save so the pet
                   feels "alive" between sessions. Same rates as tick(). */
                const elapsedMs = Math.max(0, Date.now() - (data.savedAt || Date.now()));
                const elapsedMin = elapsedMs / 60000;
                /* per-minute decay constants — match tick() decay scaled to 1 min */
                data.hunger      = Math.max(0, (data.hunger      ?? 100) - 0.15 * elapsedMin);
                data.happiness   = Math.max(0, (data.happiness   ?? 100) - 0.10 * elapsedMin);
                data.health      = Math.max(0, (data.health      ?? 100) - 0.05 * elapsedMin);
                data.cleanliness = Math.max(0, (data.cleanliness ?? 100) - 0.08 * elapsedMin);
                /* Death from offline starvation/sickness is possible. */
                if (data.hunger <= 0 || data.health <= 0) data.isAlive = false;
                return data;
            } catch (e) {
                console.warn("[Tamagotchi] loadState error:", e.message);
                return null;
            }
        }

        static clearSavedState(key) {
            try {
                if (typeof localStorage !== "undefined") {
                    localStorage.removeItem(key || "cbe-tamagotchi-v1");
                }
            } catch (_) { /* ignore */ }
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

        /* Trigger the "eating" animation for ~2s (the chewing motion).
           Called by feedMeat()/feedEggplant() so the creature visibly chews
           after each feed action regardless of mood-based animation. */
        _triggerEating(durationMs) {
            this.animationOverride = "eating";
            this.animationOverrideUntil = Date.now() + (durationMs || 2000);
        }

        feedMeat() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.sfxFeed();
            this.hunger = Math.min(100, this.hunger + 30);
            this.happiness = Math.min(100, this.happiness + 5);
            this.lastFeedTime = Date.now();
            this._triggerEating(2000);
        }

        feedEggplant() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.sfxFeed();
            this.hunger = Math.min(100, this.hunger + 20);
            this.health = Math.min(100, this.health + 10);
            this.lastFeedTime = Date.now();
            this._triggerEating(2000);
        }

        /* feed() — Tamagotchi-shell button "Feed". Opens the feed submenu on
           first press, cycles meat ↔ eggplant on subsequent presses. The
           commit-to-eat happens when the user presses Select. */
        feed() {
            if (!this.isAlive) return;
            this.sfxButton();
            if (!this.feedMenuOpen) {
                this.feedMenuOpen = true;
                this.feedMenuChoice = "meat";
            } else {
                this.feedMenuChoice = (this.feedMenuChoice === "meat") ? "eggplant" : "meat";
            }
        }

        /* select() — Tamagotchi-shell button "Select". When the feed menu is
           open, commits the highlighted choice. Otherwise no-op (room for
           future submenus: clean-confirm, lights-confirm, etc). */
        select() {
            if (!this.isAlive) return;
            this.sfxButton();
            if (this.feedMenuOpen) {
                if (this.feedMenuChoice === "meat") {
                    this.feedMeat();
                } else {
                    this.feedEggplant();
                }
                this.feedMenuOpen = false;
            }
        }

        cleanPoop() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.sfxClean();
            this.cleanliness = Math.min(100, this.cleanliness + 20);
            this.poopSpritesOnScreen = 0;
        }
        /* Alias matching button data-action="clean" so the wire-up layer can
           reference either name. */
        clean() { this.cleanPoop(); }

        play() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.sfxPlay();
            this.happiness = Math.min(100, this.happiness + 25);
            this.hunger = Math.max(0, this.hunger - 5);
        }

        giveShot() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.sfxShot();
            this.health = Math.min(100, this.health + 30);
            this.happiness = Math.max(0, this.happiness - 10);
        }
        /* Alias for button data-action="shot". */
        shot() { this.giveShot(); }

        toggleLight() {
            if (!this.isAlive) return;
            this.sfxButton();
            this.isSleeping = !this.isSleeping;
        }
        /* Alias for button data-action="light". */
        light() { this.toggleLight(); }

        /* Reset the world — UI wires this to a "Hatch new" button when the
           creature dies. */
        reset() {
            this.hunger = 100;
            this.happiness = 100;
            this.health = 100;
            this.cleanliness = 100;
            this.age = 0;
            this.isSleeping = false;
            this.isAlive = true;
            this.poopSpritesOnScreen = 0;
            this.feedMenuOpen = false;
            this.animationOverride = null;
            this.animationOverrideUntil = 0;
            this._deathSfxPlayed = false;
            this.lastFeedTime = Date.now();
            this.saveState();
        }

        /* ──── State & Animation ──── */

        updateAnimation() {
            if (!this.isAlive) {
                this.currentAnimation = "dead";
                return;
            }
            /* Animation override (e.g. "eating" right after feed) wins for
               its window, then falls back to mood-based selection. */
            if (this.animationOverride && Date.now() < this.animationOverrideUntil) {
                this.currentAnimation = this.animationOverride;
                return;
            }
            this.animationOverride = null;

            if (this.health < 20) {
                this.currentAnimation = "sick";
            } else if (this.isSleeping) {
                this.currentAnimation = "sleeping";
            } else if (this.hunger < 20 || this.cleanliness < 20) {
                this.currentAnimation = "sad";
            } else if (this.happiness > 70) {
                this.currentAnimation = "happy";
            } else {
                this.currentAnimation = "idle";
            }
        }

        render() {
            if (!this.matrix) return;
            const sprite = this.sprites[this.currentAnimation];
            if (!sprite) return;

            /* Animation frame advances on every ~4 ticks so a 4-frame array
               cycles roughly 2x per second at the default 100ms tick rate. */
            const frames = Array.isArray(sprite) ? sprite : [sprite];
            const frameIdx = Math.floor(this.animationFrame / 4) % frames.length;
            this.matrix.setFrame(frames[frameIdx]);

            /* Overlay poop sprites in the bottom-right corner so the user can
               see the hygiene problem accumulating. Each poop sprite is 12x12.
               The matrix is 40x40 so we tile up to 3 of them along the bottom
               edge: cols 0-11, 12-23, 24-35. setFrame already cleared and
               re-blitted the creature; blit() ADDs pixels without clearing. */
            if (this.poopSpritesOnScreen > 0 && this.sprites.poop) {
                const poopSprite = this.sprites.poop;
                const POOP_W = 11;  // visual width of poop sprite from ASCII
                const POOP_H = 11;
                for (let i = 0; i < Math.min(3, this.poopSpritesOnScreen); i++) {
                    const px = 1 + (i * (POOP_W + 1));
                    const py = this.matrix.rows - POOP_H - 1;
                    this.matrix.blit(poopSprite, px, py);
                }
            }

            /* When the feed menu is open, overlay the currently-highlighted
               item (meat or eggplant) in the top-right corner so the user
               knows which choice Select will commit. */
            if (this.feedMenuOpen && this.isAlive) {
                const item = this.feedMenuChoice === "meat" ? this.sprites.meat : this.sprites.eggplant;
                if (item) {
                    this.matrix.blit(item, this.matrix.cols - 12, 1);
                }
            }

            this.matrix.render();

            this.animationFrame = (this.animationFrame + 1) % (frames.length * 4);
        }

        tick(deltaMs) {
            deltaMs = deltaMs || this.tickRate;
            this.tickCount++;

            /* Even when dead we still tick — so the dead/ghost animation
               keeps cycling and the UI can show the "press a button to
               hatch a new one" prompt. We skip stat updates though. */
            if (this.isAlive) {
                const secondsPerTick = deltaMs / 1000;
                /* Decay rates are in units/min. Multiply by min-elapsed-this-tick. */
                const decayPerTick = secondsPerTick / 60;
                /* Stat decay slows when sleeping (rest restores nothing actively
                   but cuts hunger/happiness drain in half — gives the user a
                   strategy: sleep through inactive periods). */
                const sleepMul = this.isSleeping ? 0.5 : 1.0;
                this.hunger      = Math.max(0, this.hunger      - 0.15 * decayPerTick * sleepMul);
                this.happiness   = Math.max(0, this.happiness   - 0.10 * decayPerTick * sleepMul);
                this.health      = Math.max(0, this.health      - 0.05 * decayPerTick);
                this.cleanliness = Math.max(0, this.cleanliness - 0.08 * decayPerTick);

                /* Hygiene tax — accumulated poop slowly drains health
                   regardless of sleep state. Encourages keeping the screen clean. */
                if (this.poopSpritesOnScreen > 0) {
                    this.health = Math.max(0, this.health - 0.20 * decayPerTick * this.poopSpritesOnScreen);
                }

                /* Age in minutes — ~600 ticks at 100ms per tick = 1 minute. */
                if (this.tickCount % 600 === 0) this.age += 1;

                /* Death conditions — fired exactly once on the alive→dead edge. */
                if (this.hunger <= 0 || this.health <= 0) {
                    this.isAlive = false;
                    if (!this._deathSfxPlayed) {
                        this.sfxDeath();
                        this._deathSfxPlayed = true;
                    }
                    this.saveState();
                    if (typeof this.onDeath === "function") {
                        try { this.onDeath(this); } catch (e) { /* ignore */ }
                    }
                }

                /* Poop production — chance scales after feedCooldown elapses. */
                if (!this.isSleeping && Date.now() - this.lastFeedTime > this.feedCooldown) {
                    if (Math.random() < 0.005) {  // 0.5% per tick ≈ once per ~20s avg
                        this.poopSpritesOnScreen = Math.min(3, this.poopSpritesOnScreen + 1);
                        this.cleanliness = Math.max(0, this.cleanliness - 15);
                    }
                }

                /* Throttled persistence — save every ~10s. */
                if (Date.now() - this._lastSaveAt > this._saveIntervalMs) {
                    this.saveState();
                }
            }

            this.updateAnimation();
            this.render();

            /* Notify UI layer once per tick so the stat row + feed-menu glyph
               can refresh. Cheap — UI compares to last-rendered values. */
            if (typeof this.onStatsChange === "function") {
                try { this.onStatsChange(this); } catch (e) { /* ignore */ }
            }
        }

        start() {
            if (this.tickInterval) return;
            this.tickInterval = setInterval(() => this.tick(this.tickRate), this.tickRate);
        }

        stop() {
            /* Persist final state so opening the panel later doesn't lose
               progress — especially important if VSCode is closed while the
               game was running. */
            this.saveState();
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
