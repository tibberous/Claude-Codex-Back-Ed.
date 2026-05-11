"""
scan_claude_ext.py — extract all significant identifiers from the Anthropic Claude Code extension.
Outputs JSON to stdout.
"""
import json, re, os, glob, sys

def find_ext_dir():
    base = os.path.join(os.path.expanduser("~"), ".vscode", "extensions")
    matches = sorted(glob.glob(os.path.join(base, "anthropic.claude-code-*")), reverse=True)
    if not matches:
        print("ERROR: anthropic.claude-code-* not found in", base, file=sys.stderr)
        sys.exit(1)
    return matches[0]

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

def extract_js(src):
    out = {
        "window_globals":  [],
        "webview_panels":  [],
        "vscode_commands": [],
        "dom_ids":         [],
        "css_classes":     [],
        "ports":           [],
        "temp_files":      [],
        "register_commands": [],
    }
    # window.__xxx globals
    out["window_globals"] = sorted(set(re.findall(r'window\.(__[a-zA-Z][a-zA-Z0-9_]*)', src)))
    # createWebviewPanel type IDs
    out["webview_panels"] = sorted(set(re.findall(r"createWebviewPanel\(['\"]([^'\"]+)['\"]", src)))
    # executeCommand calls
    out["vscode_commands"] = sorted(set(re.findall(r"executeCommand\(['\"]([^'\"]+)['\"]", src)))
    # registerCommand calls
    out["register_commands"] = sorted(set(re.findall(r"registerCommand\(['\"]([^'\"]+)['\"]", src)))
    # DOM IDs (getElementById, .id = )
    ids = re.findall(r"getElementById\(['\"]([^'\"]+)['\"]", src)
    ids += re.findall(r'\.id\s*=\s*["\']([^"\']+)["\']', src)
    out["dom_ids"] = sorted(set(ids))
    # CSS classes added via classList
    out["css_classes"] = sorted(set(re.findall(r"classList\.\w+\(['\"]([^'\"]+)['\"]", src)))
    # Port numbers (3-5 digit standalone numbers that look like ports)
    out["ports"] = sorted(set(re.findall(r'\b(5\d{4}|4[89]\d{3})\b', src)))
    # Temp file paths
    out["temp_files"] = sorted(set(re.findall(r"tmpdir\(\)[^'\"]*['\"]([^'\"]+)['\"]", src)))
    return out

def main():
    ext_dir = find_ext_dir()
    print(f"Scanning: {ext_dir}", file=sys.stderr)

    result = {
        "extension_dir": ext_dir,
        "package": extract_package(os.path.join(ext_dir, "package.json")),
        "extension_js": {},
        "webview_js": {},
    }

    ext_js_path = os.path.join(ext_dir, "extension.js")
    if os.path.exists(ext_js_path):
        result["extension_js"] = extract_js(read(ext_js_path))

    # Use original backup if available (avoids scanning our own injected code)
    webview_path = os.path.join(ext_dir, "webview", "index.js")
    webview_bak  = webview_path + ".original.bak"
    scan_path    = webview_bak if os.path.exists(webview_bak) else webview_path
    if os.path.exists(scan_path):
        print(f"  webview: {'(original backup)' if scan_path == webview_bak else '(patched — no bak found)'}", file=sys.stderr)
        result["webview_js"] = extract_js(read(scan_path))

    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
