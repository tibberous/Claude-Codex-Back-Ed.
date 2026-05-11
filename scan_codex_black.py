"""
scan_codex_black.py — extract all significant identifiers from Claude Codex Black Ed.
Outputs JSON to stdout.
"""
import json, re, os, glob, sys

EXT_DIR = os.path.dirname(os.path.abspath(__file__))

def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

def extract_package(pkg_path):
    try:
        d = json.loads(read(pkg_path))
    except Exception:
        return {}
    out = {
        "publisher_name": f"{d.get('publisher','')}.{d.get('name','')}",
        "display_name":   d.get("displayName", ""),
        "commands":       [],
        "config_keys":    [],
        "view_ids":       [],
        "view_containers":[],
        "keybindings":    [],
        "activation_events": d.get("activationEvents", []),
    }
    for cmd in d.get("contributes", {}).get("commands", []):
        out["commands"].append(cmd.get("command", ""))
    for key in d.get("contributes", {}).get("configuration", {}).get("properties", {}):
        out["config_keys"].append(key)
    for v in d.get("contributes", {}).get("views", {}).values():
        for view in v:
            out["view_ids"].append(view.get("id", ""))
    for vc in d.get("contributes", {}).get("viewsContainers", {}).values():
        for c in vc:
            out["view_containers"].append(c.get("id", ""))
    for kb in d.get("contributes", {}).get("keybindings", []):
        out["keybindings"].append(kb.get("command", ""))
    return out

def extract_js(src, label=""):
    out = {
        "window_globals":    [],
        "webview_panels":    [],
        "vscode_commands":   [],
        "dom_ids":           [],
        "css_classes":       [],
        "ports":             [],
        "temp_files":        [],
        "register_commands": [],
    }
    out["window_globals"]    = sorted(set(re.findall(r'window\.(__[a-zA-Z][a-zA-Z0-9_]*)', src)))
    out["webview_panels"]    = sorted(set(re.findall(r"createWebviewPanel\(['\"]([^'\"]+)['\"]", src)))
    out["vscode_commands"]   = sorted(set(re.findall(r"executeCommand\(['\"]([^'\"]+)['\"]", src)))
    out["register_commands"] = sorted(set(re.findall(r"registerCommand\(['\"]([^'\"]+)['\"]", src)))
    ids = re.findall(r"getElementById\(['\"]([^'\"]+)['\"]", src)
    ids += re.findall(r'\.id\s*=\s*["\']([^"\']+)["\']', src)
    out["dom_ids"]    = sorted(set(ids))
    out["css_classes"]= sorted(set(re.findall(r"classList\.\w+\(['\"]([^'\"]+)['\"]", src)))
    out["ports"]      = sorted(set(re.findall(r'\b(5\d{4}|4[89]\d{3})\b', src)))
    out["temp_files"] = sorted(set(re.findall(r"tmpdir\(\)[^'\"]*['\"]([^'\"]+)['\"]", src)))
    return out

def main():
    result = {
        "extension_dir": EXT_DIR,
        "package":       extract_package(os.path.join(EXT_DIR, "package.json")),
        "extension_js":  {},
        "patch_webview": {},
        "injects":       {},
    }

    ext_js = os.path.join(EXT_DIR, "extension.js")
    if os.path.exists(ext_js):
        result["extension_js"] = extract_js(read(ext_js), "extension.js")

    patch_js = os.path.join(EXT_DIR, "patch-webview.js")
    if os.path.exists(patch_js):
        result["patch_webview"] = extract_js(read(patch_js), "patch-webview.js")

    injects_dir = os.path.join(EXT_DIR, "injects")
    for fname in sorted(os.listdir(injects_dir)) if os.path.isdir(injects_dir) else []:
        if fname.endswith(".js") or fname.endswith(".css"):
            src = read(os.path.join(injects_dir, fname))
            result["injects"][fname] = extract_js(src, fname)

    print(json.dumps(result, indent=2))
    print(f"\nScanned: {EXT_DIR}", file=sys.stderr)

if __name__ == "__main__":
    main()
