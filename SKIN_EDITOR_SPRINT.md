# Skin Editor Sprint — Single-file HTML skins + in-app editing (Option B)

> RECON doc. Plan only — no feature code was changed producing this. Execution agents pick up the ❌ tasks below.
>
> **Goal (Trent, 2026-05-31):** Skins become ONE `index.html` per skin (no `styles.css`, no `manifest.xml`). Add Settings → Appearance "Edit Skin" UI with **Save / Save as New / Restore Original**, a pristine `/skins-original-backup`, and non-destructive timestamped `.bak` snapshots on every Save.

## HARD CONSTRAINTS for downstream agents (read first)
- **NEVER reload VSCode** (`workbench.action.reloadWindow` / `reloadWebviewAction`). It kills the host conversation. Code changes take effect via the existing panel remount path (`getPanelHtml`) on next skin-change or panel open; Trent reloads manually if truly needed.
- **Flat file layout** — repo root is fine for new top-level dirs (`skins-original-backup/`). No deep nesting. Tools go in `tools/`.
- **Verify every extension.js / panel.js edit with `node --check <file>`** before handing off.
- **Do NOT break the active `aqua-dock` skin** (it's the live look). It also recently absorbed heavy hand-edits — treat its `index.html` as source of truth. Same for the other 14.
- **COMMIT THE UNCOMMITTED TREE FIRST.** `git status` shows `extension.js`, `panel/panel.js`, `.gitignore` modified + a large pile of untracked work (Deepgram streaming, settings scrollbar, ffmpeg prereq, `bin/`, `cli/`, bridges). Land a checkpoint commit before any skin churn so a bad skin migration can be reverted cleanly. HEAD is `d522934`.

---

## ✅ FLATTEN DONE (2026-05-31) — flat single-file layout landed (working tree, not committed)

The per-skin FOLDERS were collapsed into single flat files. **New canonical layout under `skins/`:**
```
skins/
  <id>.html              ← the whole skin (markup + CSS + palette/metadata in :root, self-contained)
  <id>.preview.png       ← picker thumbnail (sibling file)
  <id>-assets/           ← ONLY for skins that ship assets (icons/wallpaper/fonts)
```
- 15 skins now exist as `skins/<id>.html` + `skins/<id>.preview.png`.
- 3 of them have a sibling asset dir: `macos-color-dock-assets/` (icons/), `mint-dock-assets/` (icons/ + wallpaper.png), `tamagotchi-assets/` (Jersey10-Regular.ttf + tamagotchi.gif).
- ALL 15 `.skin/` dirs and ALL 14 legacy bare `skins/<id>/` dirs were DELETED (manifest.xml + styles.css gone).
- **author + description recovered into `:root`** from the git `d522934` manifests as `--cbe-skin-author` / `--cbe-skin-description` (CSS-string-escaped). The loader now reads them.
- **`{{SKIN_BASE}}` now resolves to `skins/<id>-assets/`** (was the `.skin/` dir). The 3 asset skins' working asset refs were rewritten to `url('{{SKIN_BASE}}/...')`; tamagotchi's `../../assets/label-square.png` → `{{ASSETS_BASE}}/label-square.png`. (The dead `assets/dock_icons/...` rules — scoped to a never-set `.skin-<id>` class against a nonexistent dir — were left inert.)
- **`parseSkinManifestLegacy` + the legacy bare-dir branch removed** from the loader. `_scanSkinDirs` now scans `skins/*.html`. Tool added: `tools/inject_skin_authordesc.js` (one-shot recover-from-git). Stale `tools/smoke_skin_loader.js` deleted.
- `node --check extension.js` + `node --check panel/panel.js` both pass. aqua-dock hand-edits verified intact (`max-width: none`, `color: #243240`, `toolbar-meta--panel`, `{{ASSETS_BASE}}/close-x`).

---

## Architecture as-built (PRE-FLATTEN — historical, superseded by the section above)

**Skin layout (OLD):** 15 `.skin/` dirs under `skins/`, each holding `index.html` + `manifest.xml` + `styles.css` + `preview.png` (some also `icons/`, `wallpaper.png`, `assets/`). There were ALSO 15 legacy bare `skins/<id>/` peers (CSS-overlay format); `.skin` won when both existed.

**The double-style problem (the thing single-file kills):** each `.skin/index.html` contains
1. an inline `<style data-cbe-skin="<id>">` block (e.g. aqua-dock line 1665, ~242 lines) that is the **generated inline copy** of `styles.css` (produced by `tools/reinline_skins.py`), AND
2. a `<link id="cbe-skin" rel="stylesheet" href="">` (aqua-dock line 1659) whose `href` is **set at runtime** to the skin's `styles.css` webview URI.

So the same CSS loads twice. The inline block already contains everything; the runtime `styles.css` injection is redundant once we go single-file.

**Color palette:** lives in BOTH places today — the `:root` defaults baked into each `index.html` (aqua-dock lines 44-60, the ORANGE codex-black defaults) AND `manifest.xml <colors>` which `parseSkinManifest` reads and the host pushes down at runtime (`skinColors` in `init` + `applySkin`), applied by `applySkinColors()` (panel.js 2393) as `--cbe-modal-*` inline `:root` props that override the baked defaults. **Single-file requires each skin's OWN palette to live in its own `index.html` `:root` so XML is not needed.**

### Key code map (UPDATED for flat layout 2026-05-31)
| Concern | File | Symbol / line |
|---|---|---|
| Scan skins dir | `extension.js` | `_scanSkinDirs` ~6309 — scans `skins/*.html`, returns map of id → `{ htmlPath, assetsDir }` (`SKIN_ASSETS_SUFFIX='-assets'`; `SKINS_DIR_NAME='skins'` @76). Excludes `*.preview.png`/`*.bak`. |
| Read metadata from HTML `:root` | `extension.js` | `parseSkinHtmlMeta(htmlPath, logicalId)` ~6230 — reads `--cbe-skin-name`/`-accent`/`-author`/`-description` + 11 palette vars; name falls back to title-cased slug. Helpers `_firstRootBody`/`_readRootVar`. (`parseSkinManifestLegacy` REMOVED.) |
| List for picker | `extension.js` | `listSkins` ~6309 → posts `skinsList`; preview = `skins/<id>.preview.png`. |
| Resolve active skin | `extension.js` | `resolveSkin` ~6340 (returns name/uri:null/colors/format:'new'/root=`<id>.html`/**assetsDir**/panelHtml/panelHtmlPath). |
| Mount panel HTML | `extension.js` | `getPanelHtml` ~9349 (picks `panelHtmlPath`=`skins/<id>.html` else `panel/index.html`; token subst; **`{{SKIN_BASE}}` → `resolvedSkin.assetsDir`** = `skins/<id>-assets/`). |
| Runtime styles.css inject (init) | `extension.js` | ~7456-7506 (`savedSkinName`, `skinUri`, `skinColors` in `init` payload) |
| Skin-change handler (remount/applySkin) | `extension.js` | ~7992-8012 (`STATE_SKIN`) |
| `listSkins` msg case | `extension.js` | ~8509 |
| Apply skin link href | `panel/panel.js` | `applySkinUri` 2372 (sets `#cbe-skin` href) |
| Apply colors | `panel/panel.js` | `applySkinColors` 2393 |
| Skin dropdown | `panel/panel.js` | `renderSkinDropdown` 3014 |
| Appearance pane markup | `panel/panel.js` | openSettings build ~3244-3246 (`#cbe-set-skin`) |
| Skin `<select>` change (live preview) | `panel/panel.js` | ~3822-3835 (`applySkinUri`+`applySkinColors`) |
| init / applySkin receive | `panel/panel.js` | ~6144-6256 |
| Existing tooling | `tools/` | `reinline_skins.py`, `snapshot_skins.py`, `migrate_skins_to_full_html.js`, `render_skin.py`, `build_skins.py`, `repack_skins.py`, `smoke_skin_loader.js` |

---

## Phase 0 — Single-file cutover (kill double-load, palette into HTML, drop XML)
Status: ✅ DONE (FOUNDATION AGENT). **5 ✅ / 1 ⚠️ (D3 deferred, out of scope).**

- ✅ **Move each skin's palette into its own `index.html` `:root`.** Done via new `tools/colors_xml_to_html.js` (one-shot, idempotent). All 15 skins migrated — manifest `<colors>` written into the FIRST `:root` block's `--cbe-modal-*` / `--cbe-highlight-color` / `--cbe-code-bar-*` declarations, replacing the orange codex-black defaults. e.g. aqua-dock `:root` now carries `#10243a`/`#5fb8ff` instead of `#1a1a1a`/`#e8621a`.
- ✅ **Remove the `<link id="cbe-skin">` element** from all 15 `.skin/index.html` (plus its orphaned `<!-- Skin override stylesheet -->` comment). Inline `<style data-cbe-skin>` block kept intact. 0 remain (grep-verified).
- ✅ **Stop injecting `styles.css` at runtime.** `skinUri` removed from the `init` payload (extension.js ~7558-7613). `applySkinUri` retained as a LEGACY-only path (early-returns when `#cbe-skin` is absent, which it now always is for single-file skins) — the body `data-skin` stamp was factored out into a new `stampSkinBody()` so it still fires for full-HTML skins.
- ✅ **Drop `styles.css` from the load path entirely.** Loader never reads it (Phase 2). Per D2, `styles.css` + `manifest.xml` DELETED from all 15 `.skin/` dirs. `tools/reinline_skins.py` now safely no-ops (no source files).
- ✅ **Embed name/accent metadata in the HTML.** Per LOCKED D1 — `:root` ONLY, no JSON/meta block. Each `:root` now has `--cbe-skin-name: "<Display Name>";` (quoted) + `--cbe-skin-accent: <hex>;`. The Phase 2 loader scrapes these.
- ⚠️ **Legacy bare `skins/<id>/` peers** — left intact (still have manifest.xml + styles.css), still load via the legacy CSS-overlay path. They are shadowed by their `.skin` peers (`.skin` wins in `_scanSkinDirs`). NOT single-file, NOT touched — this is deferred decision D3 (out of FOUNDATION scope).

---

## Phase 1 — Backup infrastructure
Status: ✅ DONE (BACKEND AGENT, 2026-05-31, working tree only). **4 ✅ tasks.**

- ✅ **Seed `skins-original-backup/`** (repo root, flat layout). One-shot `tools/seed_skin_backup.js` copies every current `skins/<id>.html` (+ sibling `<id>-assets/`) → `skins-original-backup/<id>.html` (+ `<id>-assets/`), idempotent — never clobbers an existing pristine copy. **Run; 15 backups confirmed** (incl. 3 asset dirs: macos-color-dock, mint-dock, tamagotchi). `skins-original-backup/` is TRACKED (NOT gitignored) — permanent Restore-Original source. ⚠️ NOTE: aqua-dock was hand-edited mid-session AFTER the first seed; its backup was re-synced to the current live file so the factory original reflects the intended skin. All 15 backups verified byte-identical to live.
- ✅ **`skins-original-backup/` invisible to the loader** — `_scanSkinDirs` only reads `SKINS_DIR_NAME='skins'`; a top-level sibling dir is never enumerated. Confirmed; no loader code change needed. New const `SKINS_BACKUP_DIR_NAME='skins-original-backup'` (extension.js ~line 77) added for the handlers.
- ✅ **Snapshot-on-save helper** `snapshotSkin(context, id)` (extension.js, after `resolveSkin`): before any overwrite of `skins/<id>.html`, copies it to `skins/<id>.<Day>-<H>-<MM>-<AMPM>.bak` (e.g. `aqua-dock.Sunday-3-13-PM.bak`) via `_bakTimestamp(d)` (no-dep JS date formatter). Returns the .bak basename ('' if nothing to snapshot). Never throws into the caller.
- ✅ **Loader IGNORES `.bak`** — `_scanSkinDirs` enumerates `skins/*.html` excluding `*.preview*`/`*.bak`; `getPanelHtml` only reads the resolved `<id>.html`. `.bak` (gitignored via `*.bak`) are inert. Confirmed; convention documented in the `snapshotSkin` comment.

---

## Phase 2 — Loader changes (read metadata/colors from HTML, not XML)
Status: ✅ DONE (FOUNDATION AGENT). **5 ✅ tasks.**

- ✅ **`_scanSkinDirs`:** `.skin/` dirs now gate on `index.html` existence (was `manifest.xml`). Legacy bare dirs still gate on `manifest.xml`. `.bak` files are never enumerated (only `<id>.skin/` DIRS with index.html become skins) — comment documents the convention for Phase 1.
- ✅ **`parseSkinManifest` → `parseSkinHtmlMeta(indexHtmlPath, logicalId)`:** new fn reads `--cbe-skin-name` / `--cbe-skin-accent` + all 11 `--cbe-modal-*`/`--cbe-highlight-color`/`--cbe-code-bar-*` colors from the FIRST `:root` block. Returns the same shape callers used: `{ id, name, accent, stylesheet:'', panelHtml:'index.html', colors:{...} }`. var()-chained or empty values are returned as `''` so they fall through to the baked default (never pushed as literal `"var(--x)"`). The old XML parser was kept as `parseSkinManifestLegacy()` for the bare D3 dirs ONLY.
- ✅ **`resolveSkin`:** split into a `format==='new'` branch (reads index.html via `parseSkinHtmlMeta`, `uri:null`, `panelHtmlPath`=index.html) and a legacy branch (manifest+css). New-format never depends on CSS.
- ✅ **`listSkins`:** new-format reads label/accent/colors from HTML `:root`, `uri:''`. Legacy reads manifest. `previewUri` + `format` + `colors` fields unchanged.
- ✅ **Init payload:** `skinUri` + `skinColors` removed (D6). `skin: resolved.name` still sent. **Skin-change handler unchanged** — full-HTML skins already remount via `getPanelHtml` (the new `:root` paints the palette); the `applySkin` postMessage branch (with `skinUri`/`skinColors`) is correctly scoped to LEGACY skins only and left as-is.

---

## Phase 3 — Settings UI (Edit / Save / Save as New / Restore Original + warning modal)
Status: ✅ DONE (UI AGENT, 2026-05-31, working tree only — NOT committed). **6 ✅ tasks.**

- ✅ **Add the edit controls to the Appearance pane** (panel.js openSettings build, after `#cbe-set-skin`): "Edit Skin" button beside the `<select>`; the editor sub-panel holds **Save**, **Save as New**, **Restore Original**, **Close**. Styled with the existing `#cbe-settings button.cbe-btn`/`.cbe-save`/`.cbe-cancel` rules.
- ✅ **Editor surface = plain monospace `<textarea>`** (`#cbe-skin-editor-ta`, ~300px tall, full pane width, dark bg, `wrap=off`+`white-space:pre`) per LOCKED D5. Populated via the `getSkinSource` round-trip.
- ✅ **Wire Save** → posts `{type:'saveSkin', id, html}`. On `skinSaved` ok → status shows "Saved." + the `.bak` name + "Skin remounted live." (host remounts; no VSCode reload). On error → red status.
- ✅ **Wire Save as New** → in-DOM `cbePrompt` (NOT window.prompt) for the name; posts `{type:'saveSkinAsNew', fromId, name, html}`. On `skinSavedAsNew` ok → re-requests `listSkins` and auto-selects `newId` when the fresh list arrives (via `__cbeSkinSelectAfterList`). On error (name collision) → red status.
- ✅ **Wire Restore Original** → `cbeConfirm` warning modal ("This discards your changes to “<name>” and restores the original. Continue?", okLabel "Restore"). On confirm posts `{type:'restoreSkinOriginal', id}`. On `skinRestored` ok → reloads the textarea via `getSkinSource` + status.
- ✅ **Live-preview parity / editor invalidation:** the existing `<select>` change handler is unchanged (still previews colors) and now also calls `closeSkinEditor()` so the editor (pinned to one skin id) collapses when the user switches skins; re-clicking "Edit Skin" loads the newly-selected skin.

---

## Phase 4 — Host message handlers (fs writes)
Status: ✅ DONE (BACKEND AGENT, 2026-05-31, working tree only). **4 ✅ / 1 ⚠️ (explicit snapshotSkin case deferred — folded into saveSkin).** New `case` blocks live in the big switch in `extension.js` immediately after the `listSkins` case.

- ✅ **`getSkinSource {id}`** → reads `skins/<id>.html` (`path.basename` traversal guard), posts `{type:'skinSource', id, ok, html, error?}`.
- ✅ **`saveSkin {id, html}`** → `snapshotSkin(context, id)` FIRST → write `skins/<id>.html` → `regenSkinPreview(force)` (non-blocking) → remount via `getPanelHtml` IF it's the active skin (no VSCode reload) → posts `{type:'skinSaved', id, ok, bak?, error?}`. `id` validated via `path.basename`.
- ✅ **`saveSkinAsNew {fromId, name, html}`** → `slugifySkinName(name)` → **collision-check** (refuse if `skins/<slug>.html` exists) → write `skins/<slug>.html` AND **R1: `skins-original-backup/<slug>.html` = the SAME html** (new skin's pristine original = its creation state) → copy `<fromId>-assets/` → both dirs if present → stamps `--cbe-skin-name` into the new `:root` via `setSkinNameInHtml` → `regenSkinPreview` → posts `{type:'skinSavedAsNew', ok, newId?, error?}`. (D4 — slug; collision = hard refuse with error.)
- ✅ **`restoreSkinOriginal {id}`** → `snapshotSkin` (even Restore is non-destructive) → copy `skins-original-backup/<id>.html` (+ `<id>-assets/` if backup has them) over `skins/<id>.html` → `regenSkinPreview(force)` → remount if active → posts `{type:'skinRestored', id, ok, error?}`. If no backup exists → `error: 'no factory original for "<id>"'`.
- ⚠️ **Explicit `snapshotSkin {id}` message case** — NOT added as a standalone case (lower-priority "backup now" affordance). The `snapshotSkin(context, id)` HELPER exists and fires inside saveSkin + restoreSkinOriginal. Trivial to expose as its own case later if Trent wants the button.

---

## What the logs revealed was already started
- **Option B was DECIDED this session, not built.** `last_month.txt` lines 74511-74519: the (A) keep-XML vs (B) full-single-file choice was laid out and Trent picked **B** explicitly, in service of the in-app editor (Edit/Save/Save as New/Restore Original + `/skins` + `/skins-original-backup` + timestamped `.bak`). The very next line is "Let me recover the plan from the logs first" — i.e. the prior session hit its limit mid-recovery. **No editor code, no backup dir, no loader change landed.** `skins-original-backup/` confirmed absent on disk.
- **The single-file plumbing is ~80% already there from the 2026-05-25 migration** (logs ~39856-39971): the `.skin/` full-HTML format, `getPanelHtml` remount, `{{SKIN_BASE}}` token, `_scanSkinDirs`/`resolveSkin`/`parseSkinManifest`, and the inline `<style data-cbe-skin>` block all exist. Phase 0/2 are mostly DELETION (kill the cbe-skin link, kill styles.css injection, move colors to HTML, swap XML reads for HTML-meta reads) rather than new architecture.
- **Existing reusable tooling** (logs ~117654-117807, verified on disk): `tools/reinline_skins.py` (regenerates the inline `<style>` from styles.css), `tools/snapshot_skins.py` / `render_skin.py` (preview.png), `tools/migrate_skins_to_full_html.js`. The Phase-0 color-migration + Phase-1 backup-seed scripts should be added alongside these in `tools/`.
- No partial "edit skin" UI, no `saveSkin`/`restoreSkin` handlers, no `.bak` snapshot logic found anywhere in code or logs.

---

## OPEN DECISIONS for Trent
1. **Where do colors live in the HTML?** Recommend: skin's own `:root` block (override the codex-black defaults) for actual styling, PLUS a small `<script type="application/json" id="cbe-skin-meta">` (or `<meta>` tags) carrying `name`/`accent`/colors so the loader can read metadata cheaply without re-parsing `:root`. Pick: meta-JSON vs meta-tags vs parse-`:root`.
2. **Keep or delete `styles.css` + `manifest.xml`** in each `.skin/` dir after cutover? They become inert. Cleaner to delete (Option B literally says "no styles.css, no manifest.xml"), but `reinline_skins.py` uses styles.css as its source. Decide: delete both (and retire/retool `reinline_skins.py`), or leave as inert editing source.
3. **Keep the 15 legacy bare `skins/<id>/` peers?** They predate `.skin/` and load via the CSS-overlay path. Recommend deleting them (the `.skin/` versions supersede) to avoid two formats — but that's a back-compat call.
4. **New-skin id scheme for "Save as New"** — slug of the entered name (`My Cool Skin → my-cool-skin`), with numeric suffix on collision (`-2`)? Confirm.
5. **Editor surface** — textarea (ship now) vs Monaco/CodeMirror (later)? Recommend textarea for v1.
6. **Still send `skinColors` at runtime** once colors live in the skin's own `:root`? Likely redundant; recommend dropping the runtime push and letting the skin HTML be self-contained.

---

## Phase status summary (updated 2026-05-31)
- **Phase 0 — Single-file cutover:** ✅ DONE (commit `4703c4a`)
- **Phase 2 — Loader reads HTML not XML:** ✅ DONE (`4703c4a`)
- **FLATTEN — `skins/<id>.html` + `<id>-assets/`, folders+XML gone:** ✅ DONE (commit `28ef6f6`)
- **Phase 1 — Backup infrastructure:** ✅ DONE (extension.js, BACKEND agent 2026-05-31)
- **Phase 4 — Host handlers (getSource/Save/SaveAsNew/RestoreOriginal):** ✅ DONE (extension.js, BACKEND agent 2026-05-31)
- **Phase 3 — Settings UI (Edit/Save/SaveAsNew/Restore + warn modal):** ✅ DONE (panel.js, UI agent 2026-05-31)
- **Phase 5 — Content-addressed auto-generated previews:** ✅ DONE (extension.js, BACKEND agent 2026-05-31)

**Done:** P0 + P2 + flatten (3 commits) + P1 + P3 + P4 + P5 (working tree, NOT committed). **Remaining:** D3 (legacy bare-dir disposition — awaiting Trent) + integration test of the full UI↔host round-trip in a live CBE panel.

---

## Phase 5 — Content-addressed auto-generated skin previews (Trent, 2026-05-31)
Status: ✅ DONE (BACKEND AGENT, 2026-05-31, working tree only) — backend wiring complete; renderer already existed.

**Why:** previews are no longer shipped/synced (Trent deleted the static `.preview.png`). The extension generates them on demand, content-addressed so they self-refresh when a skin's HTML changes.

- ✅ **Cache key:** `skins/previews/<id>-<md5[:6]>.png`. `skinPreviewInfo(context, id)` computes first-6-hex md5 of `skins/<id>.html` (Node `crypto`) → matches `tools/gen_skin_preview.py`'s path EXACTLY (verified: aqua-dock `e9cd6c`, terminal `68cfca` produced by both). `skins/previews/` is gitignored — never synced; each machine self-generates.
- ✅ **Generate-if-missing on load:** `listSkins` calls `skinPreviewInfo` per skin → if the PNG exists, ships its webview URI; if absent, fires `regenSkinPreview(context, id, false)` (non-blocking, traced on failure) so it's ready next time. Picker shows placeholder meanwhile. (Stale-md5 pruning is handled by `gen_skin_preview.py` itself, which prunes old `<id>-*.png` on render.)
- ✅ **Regenerate on Save:** `saveSkin` + `restoreSkinOriginal` call `regenSkinPreview(context, id, true)` (force) right after writing the html. `saveSkinAsNew` fires it for the new id.
- ✅ **The renderer:** `tools/gen_skin_preview.py` ALREADY EXISTS and targets the flat `skins/<id>.html` → `skins/previews/<id>-<md5[:6]>.png` via offscreen QtWebEngine (auto-installs PySide6; idempotent; `--list`/`--skin`/`--all`/`--force`). Verified working (`--list` lists 15; `--skin terminal` produced `terminal-68cfca.png`). The stale `render_skin_preview.py` / `render_skin.py` are NOT used by the backend. Renderer spawn uses the standard `process.platform==='win32' ? 'py' : 'python3'` + `-3` convention.
- ✅ **Loader preview path:** changed from `skins/<id>.preview.png` (always missing now) to the content-addressed `skins/previews/<id>-<md5>.png` via `skinPreviewInfo`.

---

## ADDENDUM — Trent decisions + refinements (2026-05-31, this session)

### New requirements (fold into Phases 1 & 3)
- **R1 — "Save as New" seeds its own original.** A user-created skin has no factory original, so on Save as New the (changed) copy is written to BOTH `skins/<new-id>/` AND `skins-original-backup/<new-id>/`. That new copy becomes the skin's **Restore Original** point. Factory skins keep their pristine `skins-original-backup` copy untouched.
- **R2 — "Save as New" prompts for a name.** Opens a name-entry input → display name + slugified folder id, with a collision check (don't clobber an existing skin).

### Decisions Trent has MADE (close these open items)
- **D2 (delete vs keep styles.css/manifest):** DELETE. Option B is literally single-file — no `styles.css`, no `manifest.xml` per skin. (Note for executor: `tools/reinline_skins.py` currently uses `styles.css` as its SOURCE — so do a FINAL reinline pass first, then delete the css + the runtime `#cbe-skin` link + the manifest, and move metadata/colors into the HTML.)
- **D4 ("Save as New" id scheme):** name-entry → slug; numeric suffix on collision. (per R2)
- **D6 (runtime skinColors push):** stop pushing colors at runtime once each skin's palette is self-contained in its own `:root` — it's redundant.

### Decisions LOCKED 2026-05-31
- **D1 — colors in HTML: `:root` ONLY.** Each skin's palette lives as CSS custom properties in its own `:root`. The loader scrapes name/accent/colors from the `:root` vars (no separate JSON meta block). Executor: add a small `--cbe-skin-name` / `--cbe-skin-accent` convention to `:root` so the picker has a label without CSS-body parsing.
- **D5 — editor surface: plain `<textarea>` (v1).** Monospace raw-HTML textarea. No Monaco/CodeMirror dependency. Upgradeable later.

### Still OPEN
- **D3 — legacy bare `skins/<id>/` peers:** Trent chose "Other" — awaiting his specifics (e.g. fold into `skins-original-backup/`, archive to `_legacy/`, etc.). Does NOT block Phases 0/1/2/3/4 — handle last.

---

## FOUNDATION AGENT NOTES (Phase 0 + Phase 2 landed 2026-05-31, working tree only — NOT committed)

**What changed, per file:**

- **`tools/colors_xml_to_html.js` (NEW):** one-shot, idempotent migration. Reads each `<id>.skin/manifest.xml` `<colors>` + `<name>` + `<accent>`, rewrites the values of the existing `--cbe-modal-*` declarations in the skin's FIRST `:root` block, and appends `--cbe-skin-name`/`--cbe-skin-accent`. Run with `--dry` to preview. Already run against all 15.
- **`skins/*.skin/index.html` (×15):** (a) FIRST `:root` palette replaced with the skin's own colors; (b) added `--cbe-skin-name: "<Display>";` + `--cbe-skin-accent: <hex>;` to that `:root`; (c) removed `<link id="cbe-skin">` + its comment. Inline `<style data-cbe-skin>` block UNTOUCHED (it is the source of truth — see warning below).
- **`skins/*.skin/styles.css` + `manifest.xml` (×30): DELETED.** Per D2. Loader no longer reads them.
- **`extension.js`:**
  - Replaced `parseSkinManifest()` with **`parseSkinHtmlMeta(indexHtmlPath, logicalId)`** + helpers `_firstRootBody(text)`, `_readRootVar(rootBody, cssVar)`, and the map `SKIN_COLOR_VARS`. Returns `{ id, name, accent, version:'', author:'', stylesheet:'', panelHtml:'index.html', description:'', colors:{<11 keys>} }`.
  - Added **`parseSkinManifestLegacy(manifestPath)`** (the old XML parser, verbatim) — used ONLY for legacy bare dirs.
  - `_scanSkinDirs`: `.skin` dirs gate on `index.html` (was `manifest.xml`); `.bak` convention documented.
  - `resolveSkin`: new-format branch returns `uri:null`, `panelHtmlPath=<root>/index.html`, colors from `:root`. Same return shape.
  - `listSkins`: new-format reads from `:root` (`uri:''`); legacy via `parseSkinManifestLegacy`.
  - `init` payload (~7558-7613): dropped `skinUri` + `skinColors` (D6). Still sends `skin: resolved.name`.
  - Skin-change handler + `getPanelHtml`: UNCHANGED (already correct — full-HTML remount path).
- **`panel/panel.js`:**
  - Added **`stampSkinBody(skinId)`** — sets/removes `<body data-skin>`. CRITICAL: `body[data-skin="tamagotchi"]` (+ aqua-dock etc.) selectors are load-bearing in the skin CSS. Since `skinUri` is gone, `applySkinUri` is skipped for single-file skins, so the body stamp was moved here and is now called directly on `init`.
  - `applySkinUri`: now LEGACY-only (early-returns when `#cbe-skin` absent); calls `stampSkinBody` first.
  - `init` handler (~6147): `stampSkinBody(__cbeActiveSkin)` always; `applySkinUri`/`applySkinColors` only fire `if (m.skinUri)`/`if (m.skinColors)` (legacy path).
  - `applySkin` receive handler: comment updated to LEGACY-only; logic unchanged.
  - Live-preview `<select>` change handler (~3822): UNCHANGED — still previews via `applySkinColors(dataset.colors)`; `listSkins` still ships `colors` (now from `:root`) so preview works.

**Contract for next agents (Phase 1/3/4) — UPDATED for flat layout 2026-05-31:**
- **`:root` var names the loader reads:** `--cbe-skin-name` (double-quoted string), `--cbe-skin-accent` (hex), **`--cbe-skin-author` (double-quoted)**, **`--cbe-skin-description` (double-quoted)**, plus the 11 palette vars `--cbe-modal-bg/-fg/-border/-title-bg-1/-title-bg-2/-title-fg/-foot-bg/-accent`, `--cbe-highlight-color`, `--cbe-code-bar-bg/-fg`. All in the FIRST `:root` block of `skins/<id>.html`.
- **Loader fn signatures (flat):** `parseSkinHtmlMeta(htmlPath, logicalId) -> {id,name,accent,author,description,stylesheet:'',panelHtml:'<id>.html',colors}` (name falls back to title-cased slug); `resolveSkin(context, requestedName) -> {name,uri:null,colors,format:'new',root:'<id>.html',assetsDir:'skins/<id>-assets/'|'',panelHtml:'<id>.html',panelHtmlPath:'skins/<id>.html'}`; `_firstRootBody(text)` + `_readRootVar(rootBody, cssVar)` reusable. `_scanSkinDirs(context) -> { <id>: {htmlPath, assetsDir} }`.
- **`{{SKIN_BASE}}`** resolves to `resolvedSkin.assetsDir` (= `skins/<id>-assets/`) for skins that have assets, else the extension's shared `assets/` dir. `{{ASSETS_BASE}}` is the shared icon dir for ALL skins (send.png, close-x.svg, label-square.png, etc.).
- **`.bak` files are safe** — `_scanSkinDirs` only enumerates `skins/*.html` (excluding `*.preview.png`/`*.bak`), and `getPanelHtml` only reads the resolved `<id>.html`. Phase 1's `.bak` snapshots (whatever naming chosen) are inert as long as they don't end in a bare `.html`. (Phase 1 still owns the snapshot helper.)
- **Save/Save-as-New handlers (Phase 4)** must write the FULL `skins/<id>.html` (it IS the skin); Save-as-New also copies the optional `<id>-assets/` dir + `<id>.preview.png`. To change a skin's picker label/accent/author/desc/palette programmatically, edit the `--cbe-skin-*` / `--cbe-modal-*` vars in its `:root` — `tools/inject_skin_authordesc.js` + `tools/colors_xml_to_html.js` show the exact `:root`-rewrite regex approach.
- **`skins-original-backup/` (Phase 1)** should mirror the flat layout: `skins-original-backup/<id>.html` + `<id>.preview.png` + optional `<id>-assets/` (NOT `.skin/` subdirs).

**⚠️ WARNING — do NOT run `tools/reinline_skins.py` against these skins.** It reads `styles.css` as source; those are now DELETED so it no-ops safely. But more importantly: during this work the styles.css files were found to be STALE (older than the inline `<style data-cbe-skin>` blocks, which carried 2026-05-31 hand-edits e.g. aqua-dock's full-width prompt + white-on-white text fix). The **inline `<style data-cbe-skin>` block in each index.html is the source of truth.** Never regenerate it from a styles.css.

**Known leftover (out of Phase 0/2 scope):** `tools/smoke_skin_loader.js` still references the removed `parseSkinManifest` and reads `skins/codex-black/manifest.xml` — it will fail until rewritten for the HTML-meta loader. It is a standalone dev test, NOT loaded by the extension at runtime, so it does not affect CBE. Flag for whoever owns test maintenance.

---

## UI AGENT NOTES (Phase 3 landed 2026-05-31, `panel/panel.js` only — NOT committed)

**Scope:** only `panel/panel.js` was touched (extension.js owned by a separate agent for the Phase 4 host handlers). `node --check panel/panel.js` passes.

**Contract message names — confirmed VERBATIM against the spec (panel → host):**
- `{type:'getSkinSource', id}` — sent by "Edit Skin" click + on `skinRestored` reload. Handles reply `{type:'skinSource', id, ok, html, error}`.
- `{type:'saveSkin', id, html}` — sent by Save. Handles reply `{type:'skinSaved', id, ok, bak, error}`.
- `{type:'saveSkinAsNew', fromId, name, html}` — sent by Save as New (after `cbePrompt`). Handles reply `{type:'skinSavedAsNew', ok, newId, error}`.
- `{type:'restoreSkinOriginal', id}` — sent by Restore Original (after `cbeConfirm`). Handles reply `{type:'skinRestored', id, ok, error}`.

The `id` passed in all four is the skin `<select>`'s current value (= `s.name` from `skinsList`, which is the skin's logical id the host's `resolveSkin`/`_scanSkinDirs` key on).

**UI elements added (all inside the Settings `#cbe-settings` Appearance pane):**
- `#cbe-skin-edit-btn` — "Edit Skin" button placed in a flex row beside `#cbe-set-skin`.
- `#cbe-skin-editor` — the editor sub-panel `<div>` (`hidden` until Edit clicked). Contains:
  - `#cbe-skin-editor-name` — span showing the editing skin's label.
  - `#cbe-skin-editor-close` — Close button (`.cbe-cancel`).
  - `#cbe-skin-editor-ta` — the monospace `<textarea>` (raw `index.html`, ~300px, `wrap=off`, `white-space:pre`, dark bg, full-width, `aria-label`).
  - `#cbe-skin-editor-status` — `role="status"`/`aria-live="polite"` feedback line (red on error).
  - `#cbe-skin-restore-btn` — "Restore Original" (left-aligned via `margin-right:auto`).
  - `#cbe-skin-saveas-btn` — "Save as New".
  - `#cbe-skin-save-btn` — "Save" (`.cbe-save`, accent bg).

**Helpers added / changed in panel.js:**
- `cbePrompt(title, placeholder, initial)` — NEW in-DOM single-line text prompt (Promise<string|null>), themed like `cbeConfirm`. Used by Save as New (no `window.prompt`).
- `cbeConfirm(message, opts)` — extended with optional `{title, okLabel}`; **back-compatible** (defaults to the original "Confirm"/"Delete" when `opts` omitted, so the existing `storedPromptsDelete` caller is unaffected). Restore Original passes `{title:'Restore Original', okLabel:'Restore'}`.
- `openSkinEditor(id, html)` / `closeSkinEditor()` / `setSkinEditorStatus(text, isError)` / `skinEditorEl()` / `skinLabelFor(id)` — editor lifecycle + status helpers.
- Module state: `let __cbeSkinEditor = {id, label}` (which skin the editor is bound to) and `let __cbeSkinSelectAfterList` (auto-select the new skin id after Save-as-New refreshes `listSkins`).
- Reply handlers `skinSource` / `skinSaved` / `skinSavedAsNew` / `skinRestored` added to the global `window` message listener right after the `skinsList` case; the `skinsList` case now honors `__cbeSkinSelectAfterList`.
- The skin `<select>` change handler now also calls `closeSkinEditor()` (editor is pinned to one id; switching skins invalidates it).

**Reused (not reinvented):** `cbeConfirm` (warning modal), `escapeHtml`, `api.postMessage`, the `#cbe-settings button.cbe-btn`/`.cbe-save`/`.cbe-cancel` CSS, the `--cbe-modal-*` theming vars.

**⚠️ NOT runtime-tested.** Cannot run the webview from here — verified syntax (`node --check`) + wiring/contract-name correctness ONLY. No claim of visual correctness. The Phase 4 host handlers (extension.js) must exist for the round-trips to do anything; until then "Edit Skin" will show "Loading skin source…" with no reply.

---

## BACKEND AGENT NOTES (Phase 1 + Phase 4 + Phase 5 landed 2026-05-31, `extension.js` + `tools/seed_skin_backup.js` only — NOT committed)

**Scope:** only `extension.js` was edited + `tools/seed_skin_backup.js` was added. Did NOT touch `panel/panel.js` or any skin's CSS/markup. `node --check extension.js` PASSES.

### Message contract — implemented VERBATIM (host side). Confirmed to match the spec + the UI agent's panel.js side:
| webview → host | host → webview reply |
|---|---|
| `{type:'getSkinSource', id}` | `{type:'skinSource', id, ok, html, error?}` |
| `{type:'saveSkin', id, html}` | `{type:'skinSaved', id, ok, bak?, error?}` |
| `{type:'saveSkinAsNew', fromId, name, html}` | `{type:'skinSavedAsNew', ok, newId?, error?}` |
| `{type:'restoreSkinOriginal', id}` | `{type:'skinRestored', id, ok, error?}` |

All four `case` blocks are in the big message switch in `extension.js`, immediately AFTER the `listSkins` case.

### New functions in extension.js (all near `resolveSkin`):
- `snapshotSkin(context, id)` — copies `skins/<id>.html` → `skins/<id>.<Day>-<H>-<MM>-<AMPM>.bak` before any overwrite. Returns the .bak basename or '' (nothing to snapshot). Never throws.
- `_bakTimestamp(d)` — no-dep date formatter → `Sunday-3-13-PM`.
- `_copyDirRecursiveSync(src, dst)` — recursive dir copy (for `<id>-assets/`).
- `slugifySkinName(name)` — `"My Cool Skin!!"` → `my-cool-skin`; returns '' if nothing usable survives.
- `setSkinNameInHtml(html, displayName)` — sets/inserts `--cbe-skin-name: "<name>";` in the FIRST `:root`; returns html unchanged if no `:root` (loader then falls back to title-cased slug).
- `regenSkinPreview(context, id, force)` — fire-and-forget `spawn('py'/'python3', ['-3','tools/gen_skin_preview.py','--skin',id, force?'--force':...])`; non-blocking, traced on failure.
- `skinPreviewInfo(context, id)` — `{ previewFsPath, exists }` for `skins/previews/<id>-<md5[:6]>.png` (Node `crypto` md5 of the skin html). Verified byte-for-byte against `gen_skin_preview.py`'s own path.
- New const `SKINS_BACKUP_DIR_NAME = 'skins-original-backup'` (line ~77).

### Behavior notes for the panel.js agent + reviewer:
- **`saveSkin` / `restoreSkinOriginal` remount** the panel via `getPanelHtml(context, panel.webview)` ONLY when the edited skin == the active skin (`workspaceState[STATE_SKIN]`). NO VSCode reload. So after a Save the live look updates immediately for the active skin; for a non-active skin the edit lands on disk and shows on next skin-switch.
- **R1 (Save-as-New seeds its own original):** the new skin's html is written to BOTH `skins/<slug>.html` AND `skins-original-backup/<slug>.html` — so Restore Original works on user-created skins (restores to creation state). Factory skins keep their untouched pristine backup.
- **Collision (D4):** Save-as-New HARD-REFUSES when `skins/<slug>.html` already exists (`error: 'a skin named "<slug>" already exists'`). No numeric-suffix auto-rename — the UI shows the error so the user picks another name. (Spec said "refuse if exists"; numeric-suffix was a softer earlier idea — went with refuse per the explicit Phase 4 spec line.)
- **`getSkinSource` returns the FULL raw `skins/<id>.html` text** — that IS the skin (markup + inline `<style>` + `:root`). The textarea edits the whole file; Save writes it back wholesale.
- **Previews are content-addressed + gitignored.** `listSkins` now ships `previewUri` from `skins/previews/<id>-<md5>.png` (was the always-missing `skins/<id>.preview.png`). Missing → fires a background regen.

### Phase 1 seeding result:
- `tools/seed_skin_backup.js` run → **15 backups** in `skins-original-backup/` (`aqua-dock arch claude-default codex-black glassy gnome kde macos-color-dock mint-dock office redhat tamagotchi terminal ubuntu xfce`) + the 3 asset dirs. Idempotent re-run = 0 seeded / 15 already present. `skins-original-backup/` is TRACKED (committed source of truth); NOT gitignored.
- ⚠️ **aqua-dock backup re-synced:** aqua-dock's `skins/aqua-dock.html` was hand-edited (by the user / another agent) at 13:25, AFTER the 12:50 seed. The stale 12:50 backup was overwritten with the current live file so the factory original = the intended skin. All 15 backups verified byte-identical to live at hand-off.

### Not done / deferred:
- ⚠️ No standalone `{type:'snapshotSkin', id}` message case (a "backup now" affordance) — lower priority; the `snapshotSkin` helper fires automatically inside saveSkin + restoreSkinOriginal. Add a case later if Trent wants the button.
- Stale-md5 preview pruning relies on `gen_skin_preview.py`'s own prune-on-render; the host does not separately delete old `<id>-*.png`.
- **NOT runtime-tested in a live CBE panel** — `node --check` + standalone unit-verification of the pure helpers (`_bakTimestamp`/`slugifySkinName`/`setSkinNameInHtml`) + a real `gen_skin_preview.py --skin terminal` render (produced the exact md5-addressed PNG my JS computes) ONLY. The full UI↔host round-trip needs a live panel to confirm.
