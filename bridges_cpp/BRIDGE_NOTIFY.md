# Bridge → user popup (how to surface errors)

The bridge tray exes already use `urllib.request` for HTTP POST. To pop a message to the user when something goes wrong (login failed, captcha shown, rate-limited, browser crashed, etc.), POST a small JSON payload to the CBE extension and it shows a `vscode.window.showWarningMessage` / `showErrorMessage` for you.

## Endpoint (TODO on the extension side)

`POST http://127.0.0.1:57835/bridge/notify`

JSON body:
```json
{
  "level": "info" | "warn" | "error",
  "title": "Short title (one line)",
  "message": "Longer detail (one paragraph).",
  "bridge_id": "chatgpt" | "claude" | "grok" | "gemini" | "copilot" | "ollama"
}
```

The extension side endpoint isn't wired into `extension.js` yet — when added, it should accept POST on the existing ctrl server (port 57835), parse the body, and route by `level`:
- `info` → `vscode.window.showInformationMessage(\`[${bridge_id}] ${title}\`, message)`
- `warn` → `vscode.window.showWarningMessage(...)`
- `error` → `vscode.window.showErrorMessage(...)`

Until the endpoint lands, the helper falls back to a native Windows MessageBox via PowerShell so notifications still reach the user.

## Pattern A: call our helper from any bridge

```bash
python "C:\Users\moren\Desktop\Claude Codex Black\bin\bridge_notify.py" \
    --bridge chatgpt --level error \
    --title "Login failed" \
    --message "chatgpt.com rejected the password — re-enter via Accounts modal."
```

Exits 0 if the popup was shown (either by extension OR by the fallback MessageBox). Non-zero if both failed.

## Pattern B: inline call from Python (matches existing bridge style)

```python
import json, urllib.request, urllib.error

def notify(level, title, message, bridge_id):
    body = json.dumps({
        "level": level, "title": title,
        "message": message, "bridge_id": bridge_id,
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:57835/bridge/notify",
        data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except urllib.error.URLError:
        return False  # caller can fall back to MessageBox
```

## Pattern C: inline call from C++ tray (WinHTTP)

If the C++ tray exe wants to call directly (no Python dependency), use `WinHttpOpen` / `WinHttpSendRequest`. Or `system("python bridge_notify.py --bridge claude --level error ...")` — short-lived process, no DLL hassle.

## Logging (separate concern, already supported)

The bridges already log to `logs/spawn_bridge.log` and `logs/bridge_service.log` via the existing log pipeline in extension.js. Use that for trace; use `notify()` only for things the user needs to SEE.
