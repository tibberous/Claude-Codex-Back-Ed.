"""
scan_recursive.py — recursive collision scan between Anthropic Claude Code
and Claude Codex Black Ed.

Walks both extension trees, extracts identifiers across many classes, and
prints the intersection (real collisions) grouped by class, with file paths
showing where each collision appears in each extension.

Read-only. No file modifications.

Usage:  python scan_recursive.py [--json]
"""
import json, re, os, glob, sys
from collections import defaultdict

# Force UTF-8 stdout on Windows so unicode summary chars don't crash
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── Configuration ─────────────────────────────────────────────────────────────
HOME      = os.path.expanduser("~")
CBE_DIR   = os.path.dirname(os.path.abspath(__file__))
CC_BASE   = os.path.join(HOME, ".vscode", "extensions")

SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".vscode-test"}
SKIP_EXT  = {".bak", ".vsix", ".png", ".jpg", ".jpeg", ".gif", ".ico",
             ".svg", ".ttf", ".woff", ".woff2", ".otf", ".eot",
             ".mp3", ".wav", ".mp4", ".webm", ".pdf",
             ".zip", ".tar", ".gz", ".7z",
             ".lock", ".log"}
SCAN_EXT  = {".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
             ".json", ".html", ".css", ".py", ".ps1", ".ini",
             ".md", ".txt", ".sh", ".yaml", ".yml"}

# ── Anthropic extension discovery ─────────────────────────────────────────────
def find_cc_dir():
    matches = sorted(glob.glob(os.path.join(CC_BASE, "anthropic.claude-code-*")), reverse=True)
    if not matches:
        print(f"ERROR: anthropic.claude-code-* not found in {CC_BASE}", file=sys.stderr)
        sys.exit(1)
    return matches[0]

# ── File walking ──────────────────────────────────────────────────────────────
def iter_files(root):
    """Yield (abs_path, rel_path) for every scannable file under root."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in SKIP_EXT:
                continue
            if SCAN_EXT and ext not in SCAN_EXT and ext != "":
                continue
            # Skip our own backups even if extension fooled us
            if fn.endswith(".original.bak") or fn.endswith(".collision-bak"):
                continue
            ap = os.path.join(dirpath, fn)
            rp = os.path.relpath(ap, root)
            yield ap, rp

def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

# ── Identifier extractors ─────────────────────────────────────────────────────
# Each returns dict[class] -> set[str]

PATTERNS = {
    # VS Code contributions / API
    "register_command":    [r"registerCommand\(\s*['\"]([^'\"]+)['\"]"],
    "execute_command":     [r"executeCommand\(\s*['\"]([^'\"]+)['\"]"],
    "register_view_prov":  [r"registerWebviewViewProvider\(\s*['\"]([^'\"]+)['\"]",
                            r"registerWebviewPanelSerializer\(\s*['\"]([^'\"]+)['\"]"],
    "create_webview_pnl":  [r"createWebviewPanel\(\s*['\"]([^'\"]+)['\"]"],
    "viewType":            [r"viewType\s*[:=]\s*['\"]([^'\"]+)['\"]",
                            r"onWebviewPanel:([A-Za-z][\w\-.]+)"],
    "set_context":         [r"setContext['\"]?\s*,\s*['\"]([^'\"]+)['\"]"],
    "status_bar_id":       [r"createStatusBarItem\([^)]*['\"]([^'\"]+)['\"]"],
    # Globals
    "window_global":       [r"window\.(__[A-Za-z_][\w]*)",
                            r"globalThis\.(__[A-Za-z_][\w]*)"],
    "window_property":     [r"window\.([A-Za-z_][\w]+)\s*=",
                            r"globalThis\.([A-Za-z_][\w]+)\s*="],
    # postMessage tags
    "postmsg_type":        [r"postMessage\(\s*\{\s*type:\s*['\"]([^'\"]+)['\"]",
                            r"postMessage\(\s*\{\s*command:\s*['\"]([^'\"]+)['\"]"],
    # HTTP routes
    "http_route":          [r"\bapp\.(?:get|post|put|delete|patch|use)\(\s*['\"](\/[^'\"]+)['\"]",
                            r"req\.url\s*===?\s*['\"](\/[^'\"]+)['\"]",
                            r"pathname\s*===?\s*['\"](\/[^'\"]+)['\"]"],
    # Ports
    "port":                [r"\.listen\(\s*(\d{4,5})\b",
                            r"127\.0\.0\.1:(\d{4,5})",
                            r"localhost:(\d{4,5})"],
    # DOM
    "dom_id":              [r"getElementById\(\s*['\"]([^'\"]+)['\"]",
                            r"\.id\s*=\s*['\"]([^'\"]+)['\"]",
                            r"<[A-Za-z][^>]*\sid\s*=\s*['\"]([^'\"]+)['\"]"],
    "css_class":           [r"classList\.\w+\(\s*['\"]([^'\"]+)['\"]",
                            r"className\s*[:=]\s*['\"]([^'\"]+)['\"]"],
    # CSS selectors written in JS strings (only namespaced-looking ones)
    "css_selector_id":     [r"['\"]#(__[A-Za-z][\w_-]+)['\"]"],
    "css_selector_cls":    [r"['\"]\.(__[A-Za-z][\w_-]+|cb[\-_][\w_-]+|cv[\-_][\w_-]+)['\"]"],
    # Sentinels
    "sentinel_var":        [r"WAKE_UP_SENT_FILE",
                            r"__cbInjector",
                            r"__cvInjector"],
    # process.env
    "process_env":         [r"process\.env\.([A-Z][A-Z0-9_]+)"],
    # Temp files
    "temp_filename":       [r"tmpdir\(\)[^'\"]*['\"]([^'\"\\\/]+)['\"]"],
}

# Patterns that should never be reported as collisions even when they match
GLOBAL_IGNORE_TOKENS = {
    # generic API value
    "onStartupFinished",
    # VS Code built-ins
    "type", "vscode.open", "editor.action.clipboardPasteAction",
    "workbench.action.reloadWindow", "workbench.action.findInFiles",
    "workbench.action.terminal.focus", "workbench.action.focusActiveEditorGroup",
    "workbench.actions.view.problems", "workbench.view.explorer",
    # CBE intentionally calls these Anthropic commands
    "claude-vscode.focus", "claude-vscode.newConversation",
    # postMessage common verbs
    "ready", "init", "done", "ok", "error", "log", "stop", "start", "result",
    # generic JS
    "true", "false", "null", "undefined",
}

def extract_from(src):
    """Return dict[class] -> set[str] for one file's source."""
    out = defaultdict(set)
    for klass, regexes in PATTERNS.items():
        for rx in regexes:
            for m in re.finditer(rx, src):
                # capture group 1 if present, else whole match
                tok = m.group(1) if m.groups() else m.group(0)
                tok = tok.strip()
                if not tok or tok in GLOBAL_IGNORE_TOKENS:
                    continue
                out[klass].add(tok)
    return out

# ── package.json contribution extraction ──────────────────────────────────────
def extract_package_json(path):
    """dict[class] -> set[str]"""
    out = defaultdict(set)
    try:
        d = json.loads(read(path))
    except Exception:
        return out
    out["pkg_publisher"].add(f"{d.get('publisher','')}.{d.get('name','')}")
    contrib = d.get("contributes", {})
    for c in contrib.get("commands", []):
        if c.get("command"): out["pkg_command"].add(c["command"])
    for k in contrib.get("configuration", {}).get("properties", {}):
        out["pkg_config_key"].add(k)
    cfg = contrib.get("configuration", {})
    if isinstance(cfg, list):
        for c in cfg:
            for k in c.get("properties", {}):
                out["pkg_config_key"].add(k)
    for vc_list in contrib.get("viewsContainers", {}).values():
        for v in vc_list:
            if v.get("id"): out["pkg_view_container"].add(v["id"])
    for v_list in contrib.get("views", {}).values():
        for v in v_list:
            if v.get("id"): out["pkg_view_id"].add(v["id"])
            if v.get("type"): pass
    for kb in contrib.get("keybindings", []):
        if kb.get("command"): out["pkg_keybind_cmd"].add(kb["command"])
        if kb.get("key"):     out["pkg_keybind_key"].add(kb["key"])
    for ev in d.get("activationEvents", []):
        out["pkg_activation"].add(ev)
        m = re.match(r"onWebviewPanel:(.+)$", ev)
        if m:
            out["viewType"].add(m.group(1))
    for w in contrib.get("walkthroughs", []):
        if w.get("id"): out["pkg_walkthrough"].add(w["id"])
    return out

# ── Walk one extension ────────────────────────────────────────────────────────
def scan_extension(root, *, anthropic=False):
    """Return (combined_ids: dict[class] -> set[str], where: dict[(class,id)] -> set[rel_path])"""
    combined = defaultdict(set)
    where    = defaultdict(set)

    pkg_path = os.path.join(root, "package.json")
    if os.path.exists(pkg_path):
        for k, vs in extract_package_json(pkg_path).items():
            for v in vs:
                combined[k].add(v)
                where[(k, v)].add("package.json")

    for ap, rp in iter_files(root):
        # If scanning Anthropic and this is webview/index.js, prefer the .original.bak
        if anthropic and rp.replace("\\", "/") == "webview/index.js":
            bak = ap + ".original.bak"
            if os.path.exists(bak):
                ap = bak
                rp = rp + ".original.bak"
        src = read(ap)
        if not src:
            continue
        for k, vs in extract_from(src).items():
            for v in vs:
                combined[k].add(v)
                where[(k, v)].add(rp)
    return combined, where

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    cc_dir = find_cc_dir()
    print(f"[scan] Anthropic Claude Code: {cc_dir}", file=sys.stderr)
    print(f"[scan] Codex Black:           {CBE_DIR}", file=sys.stderr)

    cc_ids,  cc_where  = scan_extension(cc_dir,  anthropic=True)
    cbe_ids, cbe_where = scan_extension(CBE_DIR, anthropic=False)

    all_classes = sorted(set(cc_ids) | set(cbe_ids))

    # Print summary
    print("\n══════════ identifier counts (per class) ══════════")
    print(f"{'class':28s} {'CC':>6} {'CBE':>6} {'∩':>6}")
    print("─" * 50)
    grand_collisions = []
    for k in all_classes:
        a, b = cc_ids.get(k, set()), cbe_ids.get(k, set())
        inter = sorted(a & b)
        print(f"{k:28s} {len(a):>6} {len(b):>6} {len(inter):>6}")
        for v in inter:
            grand_collisions.append((k, v))

    # Detailed collision report
    print("\n══════════ COLLISIONS (intersection) ══════════")
    if not grand_collisions:
        print("(none)")
    else:
        # group by class
        by_class = defaultdict(list)
        for k, v in grand_collisions:
            by_class[k].append(v)
        for k in sorted(by_class):
            print(f"\n── {k} ── ({len(by_class[k])})")
            for v in sorted(by_class[k]):
                cc_files  = sorted(cc_where.get((k, v), set()))
                cbe_files = sorted(cbe_where.get((k, v), set()))
                print(f"  {v!r}")
                print(f"     CC : {', '.join(cc_files[:5])}{' ...' if len(cc_files)>5 else ''}")
                print(f"     CBE: {', '.join(cbe_files[:5])}{' ...' if len(cbe_files)>5 else ''}")

    # JSON dump if requested
    if "--json" in sys.argv:
        out = {
            "cc_dir": cc_dir,
            "cbe_dir": CBE_DIR,
            "collisions": [
                {
                    "class": k, "id": v,
                    "cc_files":  sorted(cc_where.get((k, v), set())),
                    "cbe_files": sorted(cbe_where.get((k, v), set())),
                }
                for k, v in grand_collisions
            ],
        }
        with open(os.path.join(CBE_DIR, "collision_report.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        print(f"\n[scan] JSON report written: collision_report.json", file=sys.stderr)

if __name__ == "__main__":
    main()
