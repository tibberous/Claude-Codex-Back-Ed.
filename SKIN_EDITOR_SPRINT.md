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
Status: ❌ not started. **6 ❌ tasks.**

- ❌ **Move each skin's palette into its own `index.html` `:root`.** For every `skins/<id>.skin/index.html`: read `<colors>` from that skin's `manifest.xml`, and write those values as the `--cbe-modal-*` / `--cbe-highlight-color` / `--cbe-code-bar-*` declarations in the skin's `:root` (overriding the orange codex-black defaults currently baked in at e.g. aqua-dock lines 44-60). Do this with a one-shot migration script (extend or add to `tools/`, e.g. `tools/colors_xml_to_html.js`) so it's repeatable across all 15. ⚠️ The map is: `modal-bg→--cbe-modal-bg`, `modal-fg→--cbe-modal-fg`, `modal-border`, `modal-title-bg-1`, `modal-title-bg-2`, `modal-title-fg`, `modal-foot-bg`, `modal-accent`, `highlight-color→--cbe-highlight-color`, `code-bar-bg`, `code-bar-fg` (see `applySkinColors` map @ panel.js 2400-2412).
- ❌ **Remove the `<link id="cbe-skin">` element** from all 15 `.skin/index.html` (aqua-dock line 1659). The inline `<style data-cbe-skin>` block already holds the full stylesheet, so removal is safe. Keep the inline block.
- ❌ **Stop injecting `styles.css` at runtime.** In `getPanelHtml`/init the host still computes `skinUri` and pushes it; `applySkinUri` sets the now-removed link. Decide (see OPEN DECISION) whether to keep `applySkinUri` as a no-op shim or delete it. Minimum: it must not break when `#cbe-skin` is gone (it already early-returns `if (!link) return;` so it's safe, but the dead round-trip should go).
- ❌ **Drop `styles.css` from the load path entirely** for new-format skins. The file can remain on disk as a human-editing SOURCE if Trent wants, but the loader must never read it. (OPEN DECISION: delete `styles.css` from `.skin/` dirs, or leave as inert source?)
- ❌ **Embed name/accent metadata in the HTML** so the loader can read it without XML — e.g. a `<meta name="cbe-skin-name" content="Aqua Dock">` + `<meta name="cbe-skin-accent" content="#5fb8ff">` (or a `<script type="application/json" id="cbe-skin-meta">{...}</script>`) in each `index.html` `<head>`. This is the metadata contract the Phase 2 loader reads. (OPEN DECISION: meta tags vs JSON script block.)
- ❌ **Retire the legacy bare `skins/<id>/` peers** from the cutover scope OR confirm they stay for back-compat. They will still load via the CSS-overlay path; if kept, document that they are NOT single-file and not editable via the new UI.

---

## Phase 1 — Backup infrastructure
Status: ❌ not started. **4 ❌ tasks.**

- ❌ **Seed `skins-original-backup/`** (repo root, flat layout — does NOT exist yet; verified). One-shot: copy the current 15 `.skin/` dirs into `skins-original-backup/<id>.skin/` AFTER Phase 0 has produced clean single-file skins (so the pristine copy is already single-file). Add a tool `tools/seed_skin_backup.js` so it's repeatable. ⚠️ Do this only once Phase 0 skins are verified good — the backup is the "Restore Original" source forever.
- ❌ **Add `skins-original-backup/` to the loader's ignore set** — `_scanSkinDirs` only reads `SKINS_DIR_NAME='skins'`, so a top-level sibling dir is already invisible to it. Confirm + add a comment. No code change likely needed (verify).
- ❌ **Write the snapshot-on-save helper** (extension.js, new fn e.g. `snapshotSkinFile(skinRoot)`): before any Save overwrites `<skinRoot>/index.html`, copy current `index.html` → `<id>.index.<Day>-<H>-<MM>-<AMPM>.bak` (human-readable, e.g. `aqua-dock.index.Sunday-3-13-PM.bak`) in the SAME `.skin/` dir. Format the timestamp with a small JS date formatter (no deps).
- ❌ **Make the loader IGNORE `.bak` files** — `getPanelHtml` only ever reads `index.html` (resolved via `panelHtmlPath`), so `.bak` siblings are already ignored at load. Confirm `_scanSkinDirs` keys on dir name + `manifest.xml` existence (Phase 2 changes that to `index.html`) and never enumerates loose files. Add a comment documenting the `.bak` convention.

---

## Phase 2 — Loader changes (read metadata/colors from HTML, not XML)
Status: ❌ not started. **5 ❌ tasks.**

- ❌ **`_scanSkinDirs` (~6226):** change the validity gate from `manifest.xml` existence to `index.html` existence for `.skin/` dirs. (Legacy bare dirs still gate on `manifest.xml` if kept.)
- ❌ **`parseSkinManifest` (~6171):** replace with a `parseSkinHtmlMeta(indexHtmlPath)` that reads the `<meta name="cbe-skin-*">` (or JSON `<script id="cbe-skin-meta">`) chosen in Phase 0. Must return the same shape callers expect: `{ id, name, accent, colors:{...}, panelHtml }`. ⚠️ `colors` should be derived from the HTML `:root` (or duplicated in the meta block — see OPEN DECISION) so `applySkinColors` keeps working OR is made unnecessary (since colors now live in the skin's own `:root`, the runtime push may be redundant — decide whether to keep pushing `skinColors` at all).
- ❌ **`resolveSkin` (~6299):** drop the `styles.css` resolution + `uri` field for new-format (or keep `uri:null`). Keep `panelHtmlPath`/`panelHtml`/`root`. Update the `format==='legacy' && !cssExists → miss` guard so new-format never depends on CSS.
- ❌ **`listSkins` (~6259):** read label/accent/colors from HTML meta instead of XML; `uri` becomes `''` for new-format (already optional). Keep `previewUri` (preview.png) + `format`.
- ❌ **Init + applySkin payloads (~7456-7506, ~7992-8012):** stop computing/sending `skinUri`. Decide whether `skinColors` is still sent (redundant if colors are in the skin `:root`). The new-format remount path (`getPanelHtml`) already does the right thing — just ensure it no longer relies on XML.

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

### Still OPEN — need Trent before Phase 0/2 execution
- **D1 — where colors live in the HTML:** `:root` custom properties only, or `:root` + a small machine-readable metadata block (name/accent/colors) so the loader + skin-picker can read them without parsing CSS? (recon rec: both — `:root` for rendering + a tiny `<script type="application/json" id="cbe-skin-meta">` block for the loader.)
- **D3 — legacy bare `skins/<id>/` peers:** delete the 15 old non-`.skin/` folders, or leave them inert?
- **D5 — editor surface:** plain `<textarea>` for v1 (ship fast), or Monaco/CodeMirror (syntax highlight, bigger lift)?
