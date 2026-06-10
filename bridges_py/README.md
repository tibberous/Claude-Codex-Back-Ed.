# bridges_py

Unified Python+PySide6 bridge service. Replaces the per-target C++ tray exes
in `bridges_cpp/` (v1) with one process that drives every provider via Qt's
QWebEngine. Architecture lives in [`../docs/BRIDGE_WHITEPAPER.md`](../docs/BRIDGE_WHITEPAPER.md)
— don't skim that, the implementation must match its contract exactly.

## Status — v1 scaffold

What this scaffold does **today**:

- Walks `providers/*.xml` at startup and parses each manifest.
- Opens one TCP listener per provider key on its `BRIDGE_PORTS` port
  (newline-delimited JSON, same wire as v1).
- Replies to `{"action":"ping"}` with the current state machine state
  (`COLD` by default).
- Replies to `{"action":"chat", ...}` with a clean "not implemented" error
  in the v1 wire shape — extension.js code paths that route here get a
  predictable failure mode.
- Wires the 6-state machine (`state_machine.py`), the source-capture
  filesystem layout (`source_capture.py`), and 13 OpenAI tool schemas
  (`openai_tools.py`) — the filesystem-only tools (`install_bridge_script`,
  `register_models`, `leave_feedback`, `list/read/grep_sources`,
  `set_credentials`) are functional.

What it does **not** do yet — pickup items for the next agent:

- Start the per-target QWebEngineView. The whitepaper §3 plan is to shell
  into `start.py --serve-bridge --target <key> --offscreen` and talk to it
  via the bridge-cmd-server port (~8795 per memory `supergrok_qt_screenshot.md`).
- Real OpenAI tool dispatch in the COLD/REGISTERING/WARM/PATCHING flows.
  The dispatcher class is constructed; nothing invokes it yet.
- Real chat round-trip (HOT state). Needs `runJavaScript()` plumbed through
  to the offscreen view.
- IMAP polling for REGISTERING — `imap_verifier.py` returns a not-implemented
  sentinel for now.
- The patcher loop (HOT → PATCHING → HOT).

## Running standalone

```powershell
# From the repo root. Use high (1xxxx) ports so we don't fight the live C++ tray.
py -3 -m bridges_py.bridge_service `
    --providers "C:/Users/moren/Desktop/Codex Black/providers" `
    --port-chatgpt 18788 `
    --port-claude  18792 `
    --port-qwen    18794
```

Expected boot log:

```
[bridges_py] v2.0.0 booting
[bridges_py] providers dir: C:\Users\moren\Desktop\Codex Black\providers
[bridges_py] repo root:     C:\Users\moren\Desktop\Codex Black
[bridges_py] providers parsed: azure (ext), chatgpt (core), claude (ext), copilot (ext), ...
[bridges_py] [chatgpt] listening on 127.0.0.1:18788
[bridges_py] [claude]  listening on 127.0.0.1:18792
[bridges_py] [qwen]    no port allocated — skipping listener
[bridges_py] listening on 18788 18792
```

## Smoke test the TCP listener

PowerShell:

```powershell
$c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 18792)
$s = $c.GetStream()
$w = New-Object System.IO.StreamWriter($s); $w.AutoFlush = $true
$r = New-Object System.IO.StreamReader($s)
$w.WriteLine('{"action":"ping"}')
$r.ReadLine()
$c.Close()
```

Returns:

```json
{"ok":true,"server":"CBE-bridge-py/2.0.0","state":"COLD","target":"claude"}
```

`{"action":"status"}` returns a richer dump including provider URLs and
discovered-model list (empty until WARM→HOT runs).

## File layout

```
bridges_py/
    __init__.py             # SERVER_NAME, __version__
    bridge_service.py       # entry point + TCP listener + provider walker
    openai_tools.py         # 13 OpenAI tool schemas + ToolDispatcher
    source_capture.py       # session-aware capture sink + list/read/grep
    state_machine.py        # BridgeState enum + TargetState (per provider)
    imap_verifier.py        # REGISTERING email verification (stub)
    README.md               # this file
```

Runtime state lives outside this directory, per whitepaper §11:

```
state/providers/<key>.script.js   # GPT-4o-authored window.__cbeBridge
state/providers/<key>.json        # GPT-4o-discovered model list
bridge_sources/<key>/<session>/   # captured page network responses
bridge_profiles/<key>/            # Qt's persistent profile (cookies, IDB)
bridge_logs/                      # debug traces when BRIDGE_TRACE=1
feedback.log                      # GPT-4o's notes to the human
```

All of those paths are gitignored — they're per-machine and GPT-generated.

## Gating it from extension.js

The C++ tray ecosystem in `bridges_cpp/` remains the default. This scaffold
is a parallel ecosystem until v2 ships in earnest. Toggle:

```ini
# config.ini
[bridge]
use_python = true
```

When the toggle is OFF (default), extension.js's `ensureBridge()` keeps
launching `bin/CBE-Bridge-<Pretty>.exe`. When ON, it prefers
`bridges_py/bridge_service.py` if the directory exists. Wiring lives in
`extension.js` near `BRIDGE_EXE_NAME` (line ~103).
