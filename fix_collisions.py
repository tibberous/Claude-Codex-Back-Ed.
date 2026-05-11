"""
fix_collisions.py — compare Claude ext vs Codex Black, find collisions, auto-fix them.
Usage:  python fix_collisions.py [--dry-run]
"""
import json, re, os, sys, subprocess, shutil

EXT_DIR  = os.path.dirname(os.path.abspath(__file__))
DRY_RUN  = "--dry-run" in sys.argv

# ── Run both scanners ─────────────────────────────────────────────────────────
def run_scanner(script):
    r = subprocess.run([sys.executable, script], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERROR running {script}:\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout)

print("Running scanners...")
claude  = run_scanner(os.path.join(EXT_DIR, "scan_claude_ext.py"))
codex   = run_scanner(os.path.join(EXT_DIR, "scan_codex_black.py"))

# ── Flatten all identifiers from each side ────────────────────────────────────
def flatten(data, prefix=""):
    ids = set()
    if isinstance(data, dict):
        for k, v in data.items():
            ids |= flatten(v, prefix)
    elif isinstance(data, list):
        for v in data:
            if isinstance(v, str) and v.strip():
                ids.add(v.strip())
    elif isinstance(data, str) and data.strip():
        ids.add(data.strip())
    return ids

def flatten_ext(scan):
    ids = set()
    ids |= flatten(scan.get("package", {}))
    ids |= flatten(scan.get("extension_js", {}))
    ids |= flatten(scan.get("webview_js", {}))
    ids |= flatten(scan.get("patch_webview", {}))
    for inj in scan.get("injects", {}).values():
        ids |= flatten(inj)
    return ids

claude_ids = flatten_ext(claude)
codex_ids  = flatten_ext(codex)

# ── Find collisions ───────────────────────────────────────────────────────────
# Exclude intentional cross-calls (we call claude-vscode.focus on purpose)
INTENTIONAL = {
    "claude-vscode.focus",
    "claude-vscode.newChat",
    "workbench.action.reloadWindow",
    "editor.action.clipboardPasteAction",
    "type",
    "vscode.open",
    "workbench.view.explorer",
    "workbench.actions.view.problems",
    "workbench.action.findInFiles",
    "workbench.action.terminal.focus",
    "workbench.action.focusActiveEditorGroup",
    "onStartupFinished",  # VS Code API value shared by all extensions
}

collisions = sorted((claude_ids & codex_ids) - INTENTIONAL)

print(f"\n{'='*60}")
print(f"Claude ext identifiers:     {len(claude_ids)}")
print(f"Codex Black identifiers:    {len(codex_ids)}")
print(f"Collisions (excl intentional): {len(collisions)}")
print(f"{'='*60}")

if not collisions:
    print("\nNo collisions found.")
    sys.exit(0)

print("\nCollisions found:")
for c in collisions:
    print(f"  {c}")

# ── Build fix map ─────────────────────────────────────────────────────────────
# For each collision, propose a safe rename for Codex Black's copy.
def make_safe(s):
    """Turn a colliding string into a CB-namespaced version."""
    # window globals: __xxx -> __cb_xxx (if not already __cb)
    if s.startswith("__") and not s.startswith("__cb"):
        return "__cb" + s[2:]
    # DOM IDs: __cv_xxx -> __cb_xxx
    if "__cv_" in s:
        return s.replace("__cv_", "__cb_")
    # VSCode command IDs like "claude-voice.xxx" -> "codexBlackEd.xxx"
    if s.startswith("claude-voice."):
        return s.replace("claude-voice.", "codexBlackEd.")
    # CSS classes like "cv-xxx"
    if s.startswith("cv-"):
        return "cb-" + s[3:]
    # Port collisions: shouldn't happen since we use 57836/57837
    # Fallback: prefix with cb_
    return "cb_" + re.sub(r'[^a-zA-Z0-9_\-\.]', '_', s)

fix_map = {}
for c in collisions:
    safe = make_safe(c)
    if safe != c:
        fix_map[c] = safe

print(f"\nAuto-fix map ({len(fix_map)} replacements):")
for old, new in fix_map.items():
    print(f"  {old!r:50s} -> {new!r}")

if not fix_map:
    print("\nNo auto-fixes available — manual review needed.")
    sys.exit(0)

# ── Apply fixes to Codex Black files ─────────────────────────────────────────
FILES_TO_FIX = (
    [os.path.join(EXT_DIR, "extension.js"),
     os.path.join(EXT_DIR, "patch-webview.js"),
     os.path.join(EXT_DIR, "package.json")]
    + [os.path.join(EXT_DIR, "injects", f)
       for f in os.listdir(os.path.join(EXT_DIR, "injects"))
       if f.endswith(".js") or f.endswith(".css")]
    + [os.path.join(EXT_DIR, "hooks", f)
       for f in os.listdir(os.path.join(EXT_DIR, "hooks"))
       if os.path.isfile(os.path.join(EXT_DIR, "hooks", f))]
)

changed_files = []
for fpath in FILES_TO_FIX:
    if not os.path.exists(fpath):
        continue
    with open(fpath, encoding="utf-8", errors="replace") as f:
        original = f.read()
    patched = original
    for old, new in fix_map.items():
        patched = patched.replace(old, new)
    if patched != original:
        changed_files.append(fpath)
        if not DRY_RUN:
            bak = fpath + ".collision-bak"
            if not os.path.exists(bak):
                shutil.copy2(fpath, bak)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(patched)
            print(f"  FIXED: {os.path.relpath(fpath, EXT_DIR)}")
        else:
            print(f"  DRY-RUN would fix: {os.path.relpath(fpath, EXT_DIR)}")

if not changed_files:
    print("\nNo files needed changes.")
elif not DRY_RUN:
    print(f"\n{len(changed_files)} file(s) fixed. Originals backed up as .collision-bak")
    print("\nNext: re-run  node patch-webview.js  to rebundle the injects.")
else:
    print(f"\nDry-run complete. {len(changed_files)} file(s) would be changed.")
    print("Run without --dry-run to apply fixes.")
