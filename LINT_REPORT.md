# CBE Lint & Dead-Code Triage Report

**Repo:** `C:\Users\moren\Desktop\Codex Black\`
**Date:** 2026-05-31
**Mode:** READ-ONLY analysis. No source modified, no auto-fix applied.
**Toolchain (all pre-installed):** Biome 2.4.15, ESLint 10.3, Knip 6.13, Ruff 0.15.13, Vulture 2.16.

---

## Scope

**Analyzed (real source):** `extension.js` (13k lines), `panel/panel.js` (8k), `account_switch.js`, `cli/cbe.js`,
`stt-host-capture.js`, `stt-host-stream-el.js`, `bridge/cdp-client.js`, `bridge/dom-scripts.js`,
`panel/dotmatrix*.js`, `tools/*.py` (57), `bridges_cpp/*.py` (3).

**Excluded as per-machine junk / generated (not source):** `data/` (browser-profile WASM TTS engines —
ESLint's raw `.` run hit ~1100 findings here alone), `bridges/` / `bridge_profiles/` (Chromium profiles),
`node_modules/`, `skins/` + `skins-original-backup/` (HTML), `dist/`, `logs/`, `emails/`, `*.vsix`.

> **Note on Biome's raw `biome check .`** It reports **1262 errors / 10478 warnings** — but ~11k of those are
> from `extensions/*/extension.html` (demo extension HTML), the translated `panel/help.<lang>.html` files, and
> `skins/*.html`. These are NOT real JS source. The numbers below are Biome scoped to the real `.js` files only.

> **Known editor false-positives (NOT from these tools, do not conflate):** the 17 VSCode
> `css-lcurlyexpected` errors on `skins/*.html` are the CSS language server choking on `{{ASSETS_BASE}}` /
> `{{SKIN_BASE}}` template tokens inside inline `<style>`. They are an LSP artifact, substituted at runtime —
> not reported by Biome/ESLint/Ruff.

---

## Per-tool summary

| Tool | Command | Exit | Findings (scoped to source) |
|---|---|---|---|
| Biome | `biome check <src .js files>` | 0* | ~1050 (mostly style) |
| ESLint | `eslint <src .js files> --format json` | 1 | 9 errors, 444 warnings |
| Knip | `knip --no-progress` | 0 | 15 "unused files", 5 "unused exports" |
| Ruff | `ruff check tools/` / `bridges_cpp/` | 1 | 33 (tools) + 2 (bridges_cpp) |
| Ruff (B) | `ruff check tools/ --select B` | 1 | 5 bug-class |
| Vulture | `vulture tools/ bridges_cpp/ --min-confidence 70` | 3 | 6 unused imports/vars |

\* Biome exits 0 even with errors emitted (it only fails CI via `--error-on-warnings` or the npm wrapper).

---

## 🔴 TIER 1 — LIKELY BUGS

### 1. Duplicate `case` label — unreachable code  ⚠️ REAL BUG
**`extension.js:9651`** (`lint/suspicious/noDuplicateCase`)
`case 'claudeCodeSwitchAccount':` appears **twice in the same `switch`** — first at **8077**, again at **9651**
(verified: zero `switch(` statements between them). The 8077 block (just calls `claude-vscode.logout`) wins;
the 9651 block is **dead/unreachable**. The 9651 block has the richer comment ("show CBE's OWN rebranded auth
picker… 3 buttons") — strongly suggests **the second block is the intended behavior** and the first is a stale
leftover. Needs human judgment on which to keep. **This is the only clear correctness bug.**

### 2. `return` inside `finally` — silences exceptions  ⚠️ SMELL
**`tools/faster_whisper_stream.py:212`** (`ruff B012`)
A `return` inside a `finally` block swallows any in-flight exception from the `try`. If the transcribe path
throws, the error is silently discarded. Worth reviewing.

### 3. `raise` without `from` inside `except`  ⚠️ MINOR
**`tools/translate_languages.py:170`** (`ruff B904`)
Re-raising inside an `except` without `raise … from err` loses the original traceback chain. Cosmetic for
debugging, not a runtime bug.

### Reviewed and cleared (NOT bugs — false positives):
- **`extension.js:9651` is the only true correctness issue.** Everything else flagged in the "suspicious"
  category is benign:
- `noFunctionAssign` @ `panel/panel.js:7168` — intentional monkey-patch wrap
  (`const _origSetProjectFolder = setProjectFolder; … setProjectFolder = …`). Deliberate.
- `useIterableCallbackReturn` (×4: `extension.js:5623`, `panel/panel.js:3929/3935`) — `forEach` callbacks that
  return the value of `trace()` / `classList.toggle()`. Harmless; return value is ignored by `forEach`.
- `noControlCharactersInRegex` (×14, e.g. `extension.js:11468`) — **intentional** `/[\x00-\x08…]/g` to strip
  control chars from malformed JSON before `JSON.parse`. Comment confirms. False positive.
- `noUselessCatch` @ `extension.js:11391` — `catch(e){ throw e; }` rethrow-only. Harmless, just removable.
- `noSwitchDeclarations` @ `extension.js:8455` — `const _provider` in a `case` without a block. Style; the var
  is used only in its own clause. Low risk.
- `noInnerDeclarations` (×2, `panel/panel.js:7348/7376`) — `var ta` / `var html` inside if/else. `var` hoisting
  style, not a bug.
- `no-undef` (×9, all `Prism` in `panel/panel.js`) — `Prism` is loaded via a `<script>` tag in the webview HTML
  before `panel.js`; defined at runtime. False positive (ESLint can't see the HTML).
- `noGlobalIsNan` (×2, `panel/panel.js:2977/4704`) — prefer `Number.isNaN`; behavioral-edge nit, not a bug here.
- `noAssignInExpressions` (×16) — assignments inside conditionals (`while ((m = re.exec()))` patterns). Common
  idiom; none look accidental.

---

## 🟡 TIER 2 — DEAD CODE

**Knip raw:** 15 unused files + 5 unused exports. **After cross-checking CBE's dynamic-dispatch patterns, only
2 files are genuinely dead.** CBE loads webview scripts via `webview.asWebviewUri()` string substitution and
host scripts via `require(path.join(...))` — Knip's static graph can't follow either, so it over-reports.

### Genuinely dead (safe to remove):
| File | Evidence |
|---|---|
| **`bridge/cdp-client.js`** | Chrome DevTools Protocol client. Referenced ONLY in `.git`, old `chats/*.log`, and `.vscodeignore` — **zero** references in any live `.js` or `.py`. Abandoned CDP web-bridge approach (project pivoted to C++ bridge exes per memory `cbe_bridge_exes`). |
| **`bridge/dom-scripts.js`** | Same as above — companion to `cdp-client.js`, no live references. |

### Knip "unused files" that are FALSE POSITIVES (keep — loaded dynamically):
- `panel/panel.js` — loaded via `webview.asWebviewUri` (`extension.js:9911`), `{{PANEL_JS_URI}}` substitution.
- `panel/dotmatrix.js`, `panel/dotmatrix-tamagotchi-sprites.js`, `panel/dotmatrix-tamagotchi-game.js` — same
  webview-URI load (`extension.js:9918-9920`).
- `lib/prism.min.js`, `lib/prism-langs.min.js` — webview `{{PRISM_JS_URI}}` (`extension.js:9903-9907`).
- `stt-host-capture.js` — `require(path.join(...,'stt-host-capture.js'))` (`extension.js:3045/4758`).
- `stt-host-stream-el.js` — `require(path.join(...))` (`extension.js:4081/4300/4674`).
- `tools/_skin_helpers_test.js`, `tools/colors_xml_to_html.js`, `tools/inject_skin_authordesc.js`,
  `tools/migrate_skins_to_full_html.js`, `tools/seed_skin_backup.js` — standalone `node tools/x.js` CLI/migration
  utilities, referenced in `SKIN_EDITOR_SPRINT.md`. Intentional one-off tools, not app code. Not "dead" in the
  app sense; leave or archive per preference.

### Knip "unused exports" — ALL FALSE POSITIVES:
`account_switch.js` exports `ensureClaudeAccountLogin`, `sourceImapPassword`, `inferImapProvider`, `SEL`,
`MAGIC_LINK_REGEX`. The module IS required (`extension.js:12559`) and `ensureClaudeAccountLogin` IS called
(`extension.js:12562`) via dynamic `require('./account_switch.js')`. Knip can't trace the dynamic require, so it
thinks the exports are unconsumed. Keep.

### Vulture (Python) — low-value, no dead functions:
| Location | Item | Conf |
|---|---|---|
| `tools/cdp_minicomputer.py:835` | unused `exc_type`, `tb` (likely `__exit__` signature) | 100% |
| `tools/gpt_vision_pilot.py:404` | unused import `_norm` | 90% |
| `tools/render_skin.py:174/175` | unused imports `QEventLoop`, `QPixmap` | 90% |
| `bridges_cpp/smart_bridge.py:225` | unused variable `label` | 100% |

No dead **functions** flagged at min-confidence 70/90 — the Python `tools/` are well-pruned CLIs. The
`exc_type`/`tb` are likely context-manager `__exit__` params (intentional signature) — verify before removing.

---

## ⚪ TIER 3 — STYLE / NOISE (counts only)

### Biome (real `.js` source — `extension.js`, `panel/panel.js`, `account_switch.js`, `cli/cbe.js`, stt/bridge/dotmatrix):
| Rule | Count |
|---|---|
| `lint/style/useTemplate` (prefer template literals over `+`) | ~450 |
| `lint/complexity/useOptionalChain` | ~467 |
| `lint/suspicious/noEmptyBlockStatements` | ~303 |
| `lint/correctness/noUnusedVariables` | ~88 |
| `lint/correctness/noUnusedFunctionParameters` | ~20 |
| `lint/suspicious/noRedundantUseStrict` | 7 |
| `lint/suspicious/noPrototypeBuiltins` | 7 |
| `lint/style/useConst` | 4 |
| `lint/complexity/noUselessEscapeInRegex` | 3 |

### ESLint (scoped to source):
| Rule | Count |
|---|---|
| `no-unused-vars` (warn) | 443 |
| `no-undef` (error) | 9 — all `Prism` false-positives (see Tier 1) |
| 1 stale `eslint-disable` directive | `panel/panel.js:5074` (unused `no-control-regex` disable) |

### Ruff (`tools/`):
| Code | Count | Meaning |
|---|---|---|
| `F401` unused-import | 16 | auto-fixable |
| `F541` f-string-missing-placeholders | 15 | auto-fixable |
| `F841` unused-variable | 2 | auto-fixable (`tools/cdp_minicomputer.py:277` `mode`, +1) |

### Ruff (`bridges_cpp/`):
| Code | Count |
|---|---|
| `F541` f-string-missing-placeholders | 2 |

---

## Recommended actions

### Fix now (judgment required — DO NOT auto-fix):
1. **`extension.js:9651` duplicate `case 'claudeCodeSwitchAccount'`** — decide which block is correct (the 9651
   "rebranded picker" block is unreachable today; the comment implies it's the intended one). Delete the loser.
   *This is the headline finding.*
2. **`tools/faster_whisper_stream.py:212` `return` in `finally`** — restructure so exceptions aren't swallowed.

### Safely auto-fixable (mechanical, no behavior change) — when you choose to clean up:
- `ruff check tools/ --fix` → clears 31 of 33 (F401 unused imports, F541 empty f-strings). Run `bridges_cpp/`
  too (2 F541).
- `ruff check tools/ bridges_cpp/ --select F401,F841 --fix` for the unused imports/vars Vulture also flagged.
- `biome check --write <src .js>` → fixes `useConst`, `noUselessEscapeInRegex`, the rethrow-only catch, and the
  `noSwitchDeclarations` block-wrap. **Scope to the real `.js` files** — do NOT run `biome check --write .` or it
  will rewrite the demo HTML / skins / translated help files.
- `eslint <src> --fix` → removes the stale `eslint-disable` at `panel/panel.js:5074`.

### Ignore (false positives / intentional):
- All `no-undef` `Prism` errors (loaded via webview `<script>`).
- All `noControlCharactersInRegex` (intentional JSON control-char scrubbing).
- All Knip "unused exports" on `account_switch.js` + the 13 webview/host/CLI "unused files" (dynamic load).
- `noFunctionAssign` @ `panel/panel.js:7168` (intentional monkey-patch wrap).
- The ~1050 Biome style warnings + 443 ESLint `no-unused-vars` — pre-existing baseline; a big diff for little
  value. Leave unless doing a dedicated cleanup pass.

### Genuinely-dead files to consider deleting:
- `bridge/cdp-client.js` and `bridge/dom-scripts.js` (abandoned CDP bridge; zero live refs). Confirm against
  any out-of-tree consumer before removing, but nothing in this repo uses them.

---

## CBE dynamic-dispatch patterns (why static dead-code tools over-report here)

Cross-checked all "dead" candidates against these to avoid false flags:
1. **Webview script injection** — `webview.asWebviewUri()` + `html.split('{{X_URI}}').join(...)` string
   substitution loads `panel/panel.js`, `dotmatrix*.js`, `prism*.js`. Static graphs miss this entirely.
2. **Path-based host `require`** — `require(path.join(context.extensionPath, 'stt-host-capture.js'))` etc.
   Dynamic require is invisible to Knip.
3. **Message-type `switch` dispatch** — the giant `switch (msg.type)` in `extension.js` is the main handler
   router; many functions are reached only via these string-keyed cases (this is also *why* the duplicate-case
   bug matters — a whole branch is silently shadowed).
4. **Python CLIs** — `tools/*.py` and `bridges_cpp/*.py` are spawned as subprocesses / run via `python x.py`;
   their top-level functions look "unused" to Vulture but are `__main__` entry points.
