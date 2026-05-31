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

## Architecture as-built (verified 2026-05-31)

**Skin layout:** 15 `.skin/` dirs under `skins/`, each holding `index.html` + `manifest.xml` + `styles.css` + `preview.png` (some also `icons/`, `wallpaper.png`, `assets/`). There are ALSO 15 legacy bare `skins/<id>/` peers (CSS-overlay format) kept for back-compat; `.skin` wins when both exist (`_scanSkinDirs` Pass 2 overwrites Pass 1).

**The double-style problem (the thing single-file kills):** each `.skin/index.html` contains
1. an inline `<style data-cbe-skin="<id>">` block (e.g. aqua-dock line 1665, ~242 lines) that is the **generated inline copy** of `styles.css` (produced by `tools/reinline_skins.py`), AND
2. a `<link id="cbe-skin" rel="stylesheet" href="">` (aqua-dock line 1659) whose `href` is **set at runtime** to the skin's `styles.css` webview URI.

So the same CSS loads twice. The inline block already contains everything; the runtime `styles.css` injection is redundant once we go single-file.

**Color palette:** lives in BOTH places today — the `:root` defaults baked into each `index.html` (aqua-dock lines 44-60, the ORANGE codex-black defaults) AND `manifest.xml <colors>` which `parseSkinManifest` reads and the host pushes down at runtime (`skinColors` in `init` + `applySkin`), applied by `applySkinColors()` (panel.js 2393) as `--cbe-modal-*` inline `:root` props that override the baked defaults. **Single-file requires each skin's OWN palette to live in its own `index.html` `:root` so XML is not needed.**

### Key code map
| Concern | File | Symbol / line |
|---|---|---|
| Scan skins dir | `extension.js` | `_scanSkinDirs` ~6226 (`SKINS_DIR_NAME='skins'` @76) |
| Parse XML metadata | `extension.js` | `parseSkinManifest` ~6171 (id/name/accent/stylesheet/panelHtml/colors) |
| List for picker | `extension.js` | `listSkins` ~6259 → posts `skinsList` |
| Resolve active skin | `extension.js` | `resolveSkin` ~6299 (returns name/uri/colors/format/root/panelHtml/panelHtmlPath) |
| Mount panel HTML | `extension.js` | `getPanelHtml` ~9323 (picks `panelHtmlPath` else `panel/index.html`; token subst; `{{SKIN_BASE}}`) |
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
Status: ❌ not started. **4 ❌ tasks.**

- ❌ **Seed `skins-original-backup/`** (repo root, flat layout — does NOT exist yet; verified). One-shot: copy the current 15 `.skin/` dirs into `skins-original-backup/<id>.skin/` AFTER Phase 0 has produced clean single-file skins (so the pristine copy is already single-file). Add a tool `tools/seed_skin_backup.js` so it's repeatable. ⚠️ Do this only once Phase 0 skins are verified good — the backup is the "Restore Original" source forever.
- ❌ **Add `skins-original-backup/` to the loader's ignore set** — `_scanSkinDirs` only reads `SKINS_DIR_NAME='skins'`, so a top-level sibling dir is already invisible to it. Confirm + add a comment. No code change likely needed (verify).
- ❌ **Write the snapshot-on-save helper** (extension.js, new fn e.g. `snapshotSkinFile(skinRoot)`): before any Save overwrites `<skinRoot>/index.html`, copy current `index.html` → `<id>.index.<Day>-<H>-<MM>-<AMPM>.bak` (human-readable, e.g. `aqua-dock.index.Sunday-3-13-PM.bak`) in the SAME `.skin/` dir. Format the timestamp with a small JS date formatter (no deps).
- ❌ **Make the loader IGNORE `.bak` files** — `getPanelHtml` only ever reads `index.html` (resolved via `panelHtmlPath`), so `.bak` siblings are already ignored at load. Confirm `_scanSkinDirs` keys on dir name + `manifest.xml` existence (Phase 2 changes that to `index.html`) and never enumerates loose files. Add a comment documenting the `.bak` convention.

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
Status: ❌ not started. **6 ❌ tasks.**

- ❌ **Add the edit controls to the Appearance pane** (panel.js openSettings build, after `#cbe-set-skin` @ ~3246): an "Edit Skin" button row with **Save**, **Save as New**, **Restore Original**. Style with the existing `--cbe-modal-*` button vars used elsewhere in the modal.
- ❌ **Editor surface for the selected skin's `index.html`.** Decide form (OPEN DECISION): (a) inline `<textarea>` showing the raw `index.html` (simplest, ships fast), (b) a full code editor (Monaco/CodeMirror — heavier, CSP work). Recommend (a) textarea for v1. Host must ship the current skin HTML text to the panel (new `getSkinSource` round-trip) to populate it.
- ❌ **Wire Save** → post `saveSkin {id, html}` to host. On success, re-mount via existing remount path so the edit shows live (NO VSCode reload).
- ❌ **Wire Save as New** → prompt for a new name; post `saveSkinAsNew {fromId, newName, html}`. Refresh dropdown (`renderSkinDropdown` after new `skinsList`).
- ❌ **Wire Restore Original** → show a warning modal ("This discards your changes to this skin and restores the factory version. Continue?") reusing the existing modal/confirm pattern in panel.js; on confirm post `restoreSkin {id}`.
- ❌ **Live-preview parity:** the existing `<select>` change handler (~3822-3835) calls `applySkinUri`+`applySkinColors`. After Phase 2 those may be no-ops; ensure skin SWITCH still remounts (host already remounts for full-HTML skins in the change path) and the editor textarea reloads for the newly selected skin.

---

## Phase 4 — Host message handlers (fs writes)
Status: ❌ not started. **5 ❌ tasks.** All new `case` blocks go in the big switch in `extension.js` near the existing skin cases (~8509 `listSkins`, ~7992 skin-change).

- ❌ **`getSkinSource {id}`** → resolve skin root, read `index.html`, post `skinSource {id, html}` back (feeds the editor textarea).
- ❌ **`saveSkin {id, html}`** → resolve root; call `snapshotSkinFile(root)` (Phase 1) FIRST; then write `index.html` with the new content; remount if it's the active skin; post `skinSaved {id, ok, bak}`. ⚠️ Validate `id` via `path.basename` (traversal guard already used in `resolveSkin` @6315) and confirm the resolved root is under `skins/`.
- ❌ **`saveSkinAsNew {fromId, newName, html}`** → derive a safe new id (slugify newName; collision check); `mkdir skins/<newid>.skin/`; copy sibling assets (`icons/`, `wallpaper.png`, `assets/`, `preview.png`) from source; write `index.html`; post fresh `skinsList`. (OPEN DECISION: id scheme — slug of name? name + numeric suffix on collision?)
- ❌ **`restoreSkin {id}`** → copy `skins-original-backup/<id>.skin/index.html` (and assets if they can drift) over `skins/<id>.skin/`; snapshot the pre-restore `index.html` to `.bak` first (so even Restore is non-destructive); remount if active; post `skinRestored {id, ok}`. ⚠️ If no backup exists for that id (e.g. a user-created skin), reply with an error the UI shows ("No factory original for this skin").
- ❌ **`snapshotSkin {id}`** (optional explicit-snapshot case, or fold into saveSkin) → just the snapshot step, for a "backup now" affordance if Trent wants one. Lower priority.

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

## Phase status summary
- **Phase 0 — Single-file cutover:** ❌ not started — 6 tasks
- **Phase 1 — Backup infrastructure:** ❌ not started — 4 tasks
- **Phase 2 — Loader changes:** ❌ not started — 5 tasks
- **Phase 3 — Settings UI:** ❌ not started — 6 tasks
- **Phase 4 — Host handlers:** ❌ not started — 5 tasks

**Total: 26 ❌ tasks, 0 ✅, 0 ⚠️.** Pre-req before any of it: commit the dirty tree (HEAD `d522934`).

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

**Contract for next agents (Phase 1/3/4):**
- **`:root` var names the loader reads:** `--cbe-skin-name` (double-quoted string), `--cbe-skin-accent` (hex), plus the 11 palette vars `--cbe-modal-bg/-fg/-border/-title-bg-1/-title-bg-2/-title-fg/-foot-bg/-accent`, `--cbe-highlight-color`, `--cbe-code-bar-bg/-fg`. All in the FIRST `:root` block of `index.html`.
- **Loader fn signatures:** `parseSkinHtmlMeta(indexHtmlPath, logicalId) -> {id,name,accent,stylesheet:'',panelHtml:'index.html',colors}`; `resolveSkin(context, requestedName) -> {name,uri,colors,format,root,panelHtml,panelHtmlPath}` (new-format: `uri:null`, `panelHtmlPath=<root>/index.html`); `_firstRootBody(text)` + `_readRootVar(rootBody, cssVar)` are reusable for any future `:root` reads.
- **`.bak` files are already safe** — `_scanSkinDirs` only treats `<id>.skin/` DIRS containing `index.html` as skins, and `getPanelHtml` only reads `index.html`. Phase 1's `.bak` snapshots in the same dir are inert. (Phase 1 still owns adding the snapshot helper + comment.)
- **Save/Save-as-New handlers (Phase 4)** must write the FULL `index.html` (it IS the skin). To change a skin's picker label/accent/palette programmatically, edit the `--cbe-skin-*` / `--cbe-modal-*` vars in its `:root` — `tools/colors_xml_to_html.js` shows the exact regex approach.

**⚠️ WARNING — do NOT run `tools/reinline_skins.py` against these skins.** It reads `styles.css` as source; those are now DELETED so it no-ops safely. But more importantly: during this work the styles.css files were found to be STALE (older than the inline `<style data-cbe-skin>` blocks, which carried 2026-05-31 hand-edits e.g. aqua-dock's full-width prompt + white-on-white text fix). The **inline `<style data-cbe-skin>` block in each index.html is the source of truth.** Never regenerate it from a styles.css.

**Known leftover (out of Phase 0/2 scope):** `tools/smoke_skin_loader.js` still references the removed `parseSkinManifest` and reads `skins/codex-black/manifest.xml` — it will fail until rewritten for the HTML-meta loader. It is a standalone dev test, NOT loaded by the extension at runtime, so it does not affect CBE. Flag for whoever owns test maintenance.
