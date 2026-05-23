"""bridges_py — unified Python+PySide6 bridge service.

Replaces the per-target C++ tray exes in `bridges_cpp/` (v1) with one process
that drives every provider via PySide6's QWebEngine, per `docs/BRIDGE_WHITEPAPER.md`
v2. v1 is gated behind `config.ini` `[bridge] use_python = false`; flip it on
to route extension.js bridge calls into this service.

Modules:
    bridge_service  — TCP listener + provider manifest walker + state machine wiring
    openai_tools    — OpenAI function-calling tool definitions + dispatch
    source_capture  — QWebEngineUrlRequestInterceptor stub (tees response bodies)
    state_machine   — 6-state FSM (COLD / REGISTERING / WARM / HOT / PATCHING / BLOCKED)
    imap_verifier   — REGISTERING email verification (stub; wraps gmail_api_hook.py)

v1 scaffold goal: boot, parse providers/*.xml, accept TCP pings, return COLD.
Chat round-trip + real state transitions land in the next agent.
"""

__version__ = "2.0.0"
SERVER_NAME = "CBE-bridge-py/2.0.0"
