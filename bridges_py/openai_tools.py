"""openai_tools.py — OpenAI function-calling tool definitions + dispatch.

Per whitepaper §8. GPT-4o gets these tools in REGISTERING / COLD / WARM /
PATCHING states. The hot path (HOT) is pure in-page JS — no OpenAI calls.

Tool inventory (13 total — 7 original + 6 new in v2):

  ORIGINAL SEVEN:
    get_offscreen_screenshot()      QWidget.grab() -> base64 PNG
    send_click(selector|xy)         click element on the page
    send_key(key)                   enter / tab / esc / arrows
    send_text(text)                 type literal into focused element
    eval_js(code)                   runJavaScript() -> JSON result
    install_bridge_script(source)   persist + inject __cbeBridge
    leave_feedback(message, sev)    append to feedback.log

  NEW IN V2:
    list_sources(glob)              ls captured page network responses
    grep_sources(pattern)           ripgrep over captures
    read_source(path)               read one captured file
    register_models(list)           persist GPT-4o-discovered model list
    set_credentials(user, pw)       write [bridge_credentials.<key>] to config.ini
    read_verification_email(addr)   poll IMAP for verification link

v1 SCAFFOLD STATUS:
    - All 13 schemas defined (OpenAI tool JSON format).
    - dispatch() routes function-call names to local handlers.
    - install_bridge_script / register_models / leave_feedback / list_sources
      / grep_sources / read_source all functional — they only need filesystem
      + the SourceCapture instance.
    - Browser tools (screenshot / click / key / text / eval_js) are stubs —
      they delegate to a `run_js(target, code)` callback that the next agent
      wires once start.py's --serve-bridge subprocess is talking back.
    - set_credentials lands in config.ini correctly.
    - read_verification_email returns the imap_verifier stub.
"""

from __future__ import annotations

import configparser
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import imap_verifier


# ── Tool JSON schemas (the payload OpenAI sees) ─────────────────────────────

TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_offscreen_screenshot",
            "description": "Capture a PNG screenshot of the per-target offscreen QWebEngineView via QWidget.grab(). Returns base64-encoded image data. Use after any DOM action to verify it landed.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_click",
            "description": "Click an element on the page. Prefer a CSS selector; fall back to viewport xy pixel coords if no stable selector exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector (preferred)"},
                    "x":        {"type": "integer", "description": "viewport X px (only if no selector)"},
                    "y":        {"type": "integer", "description": "viewport Y px (only if no selector)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_key",
            "description": "Press a named key on the focused element. Valid: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space.",
            "parameters": {
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_text",
            "description": "Type literal text into the focused element. Does NOT submit — pair with send_key('Enter') if needed.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "eval_js",
            "description": "Run JS in the page via runJavaScript(). Returns the JSON-serialized last expression. Use for DOM probing and for testing the candidate window.__cbeBridge.",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string"}},
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "install_bridge_script",
            "description": "Persist the authored window.__cbeBridge to state/providers/<key>.script.js and inject it into the page. Exits the bootstrap loop. Call ONLY when all three smoke-tests (healthCheck, poll, getHistory) have passed via eval_js.",
            "parameters": {
                "type": "object",
                "properties": {"source": {"type": "string", "description": "Complete self-contained JS source defining window.__cbeBridge."}},
                "required": ["source"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "leave_feedback",
            "description": "Append a note to feedback.log for the human. Use for concerns, ideas, questions, or BLOCKED conditions — anything you'd otherwise want to ask the user about.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message":  {"type": "string"},
                    "severity": {"type": "string", "enum": ["info", "concern", "question", "idea", "blocked"]},
                },
                "required": ["message"],
            },
        },
    },
    # ── New in v2 ───────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "list_sources",
            "description": "List captured page network response files in the current session's bridge_sources/<key>/<session>/ directory. Glob pattern (* matches anything).",
            "parameters": {
                "type": "object",
                "properties": {"glob": {"type": "string", "description": "e.g. '*.js' or '*models*'"}},
                "required": ["glob"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_sources",
            "description": "Search a regex across every captured source file. Returns list of {file, line_no, line} hits. Used for model discovery — grep_sources('\"gpt-[45]') etc.",
            "parameters": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_source",
            "description": "Read one captured file. Files larger than 256KB are truncated with a [truncated] note.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Filename within the current session dir."}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "register_models",
            "description": "Persist the discovered model list to state/providers/<key>.json. Call ONCE during WARM->HOT bootstrap after grepping the JS bundles.",
            "parameters": {
                "type": "object",
                "properties": {
                    "models": {
                        "type": "array",
                        "description": "Array of {name, id} objects. e.g. [{name:'GPT-5', id:'gpt-5'}, ...]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "id":   {"type": "string"},
                            },
                            "required": ["name"],
                        },
                    },
                },
                "required": ["models"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_credentials",
            "description": "Write or overwrite [bridge_credentials.<key>] in config.ini. Used during REGISTERING if you decide to deviate from the defaults the bridge generated (rare — usually use what you were given).",
            "parameters": {
                "type": "object",
                "properties": {
                    "username": {"type": "string"},
                    "password": {"type": "string"},
                },
                "required": ["username", "password"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_verification_email",
            "description": "Poll the user's IMAP inbox via gmail_api_hook for up to 90s, return the verification URL once a matching email arrives. Used during REGISTERING.",
            "parameters": {
                "type": "object",
                "properties": {
                    "address":                {"type": "string"},
                    "expected_sender_domain": {"type": "string"},
                    "expected_url_domain":    {"type": "string"},
                },
                "required": ["address"],
            },
        },
    },
]


# ── Dispatch ────────────────────────────────────────────────────────────────

class ToolDispatcher:
    """Routes OpenAI tool-call names to local Python handlers.

    Construction takes the per-target `TargetState`, the per-target
    `SourceCapture`, the path to feedback.log, and a `run_js(code)` callable
    that's wired by bridge_service.py to the actual offscreen view.

    v1 scaffold: the browser-driving tools (screenshot/click/key/text/eval_js)
    return a "not-wired" sentinel that the next agent replaces with real
    QWebEngine ops via start.py's --serve-bridge subprocess.
    """

    def __init__(
        self,
        *,
        target,                                  # state_machine.TargetState
        source_capture,                          # source_capture.SourceCapture
        feedback_log_path: Path,
        config_ini_path: Path,
        run_js: Optional[Callable[[str], str]] = None,
        screenshot_b64: Optional[Callable[[], str]] = None,
    ):
        self.target = target
        self.source_capture = source_capture
        self.feedback_log_path = feedback_log_path
        self.config_ini_path = config_ini_path
        self.run_js = run_js or self._notWiredJs
        self.screenshot_b64 = screenshot_b64 or self._notWiredScreenshot

    @staticmethod
    def _notWiredJs(code: str) -> str:
        return json.dumps({"ok": False, "reason": "run_js not wired in v1 scaffold"})

    @staticmethod
    def _notWiredScreenshot() -> str:
        return ""  # empty base64 — next agent wires QWidget.grab() via start.py

    # ── Top-level dispatch ──────────────────────────────────────────────────

    def dispatch(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Resolve `name` to a handler and call with `args`. Always returns a
        dict (becomes the `content` of the tool message). Exceptions are
        caught + returned as {"ok": False, "reason": "..."}.
        """
        handler = self._handlers().get(name)
        if handler is None:
            return {"ok": False, "reason": f"unknown tool: {name}"}
        try:
            return handler(args or {})
        except Exception as e:
            return {"ok": False, "reason": f"{type(e).__name__}: {e}"}

    def _handlers(self) -> Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]]:
        return {
            "get_offscreen_screenshot": self._getOffscreenScreenshot,
            "send_click":               self._sendClick,
            "send_key":                 self._sendKey,
            "send_text":                self._sendText,
            "eval_js":                  self._evalJs,
            "install_bridge_script":    self._installBridgeScript,
            "leave_feedback":           self._leaveFeedback,
            "list_sources":             self._listSources,
            "grep_sources":             self._grepSources,
            "read_source":              self._readSource,
            "register_models":          self._registerModels,
            "set_credentials":          self._setCredentials,
            "read_verification_email":  self._readVerificationEmail,
        }

    # ── Browser tools (v1: stubs — wired by next agent) ─────────────────────

    def _getOffscreenScreenshot(self, args: Dict[str, Any]) -> Dict[str, Any]:
        b64 = self.screenshot_b64()
        return {"ok": bool(b64), "image_b64": b64, "wired": bool(b64)}

    def _sendClick(self, args: Dict[str, Any]) -> Dict[str, Any]:
        sel = args.get("selector")
        if sel:
            code = f"(function(){{var e=document.querySelector({json.dumps(sel)});if(!e)return JSON.stringify({{ok:false,reason:'selector not found'}});e.click();return JSON.stringify({{ok:true}});}})()"
            return json.loads(self.run_js(code))
        # xy fallback — next agent wires real synthesized mouse via offscreen view
        return {"ok": False, "reason": "xy click not wired in v1 scaffold; pass a selector"}

    def _sendKey(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "reason": "send_key not wired in v1 scaffold"}

    def _sendText(self, args: Dict[str, Any]) -> Dict[str, Any]:
        text = args.get("text", "")
        code = f"(function(){{var e=document.activeElement;if(!e)return JSON.stringify({{ok:false,reason:'no active element'}});if('value' in e){{e.value+={json.dumps(text)};e.dispatchEvent(new Event('input',{{bubbles:true}}));return JSON.stringify({{ok:true}});}};return JSON.stringify({{ok:false,reason:'not an input'}});}})()"
        try:
            return json.loads(self.run_js(code))
        except Exception:
            return {"ok": False, "reason": "send_text relies on run_js which is not wired"}

    def _evalJs(self, args: Dict[str, Any]) -> Dict[str, Any]:
        code = args.get("code", "")
        try:
            raw = self.run_js(code)
            return {"ok": True, "result": raw}
        except Exception as e:
            return {"ok": False, "reason": str(e)}

    # ── Filesystem-only tools (fully functional in v1) ──────────────────────

    def _installBridgeScript(self, args: Dict[str, Any]) -> Dict[str, Any]:
        source = args.get("source", "")
        if not source or not isinstance(source, str):
            return {"ok": False, "reason": "source must be a non-empty string"}
        self.target.saveScript(source)
        return {"ok": True, "path": str(self.target.script_path), "bytes": len(source)}

    def _leaveFeedback(self, args: Dict[str, Any]) -> Dict[str, Any]:
        message = str(args.get("message", "")).strip()
        severity = str(args.get("severity", "info"))
        if severity not in ("info", "concern", "question", "idea", "blocked"):
            severity = "info"
        if not message:
            return {"ok": False, "reason": "message required"}
        stamp = datetime.now(timezone.utc).isoformat()
        line = f"[{stamp}] [{severity}] [{self.target.key}] {message}\n"
        self.feedback_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.feedback_log_path, "a", encoding="utf-8") as f:
            f.write(line)
        return {"ok": True, "logged_to": str(self.feedback_log_path)}

    def _listSources(self, args: Dict[str, Any]) -> Dict[str, Any]:
        glob = args.get("glob", "*")
        files = self.source_capture.listSources(glob)
        return {"ok": True, "files": files, "count": len(files)}

    def _grepSources(self, args: Dict[str, Any]) -> Dict[str, Any]:
        pattern = args.get("pattern", "")
        if not pattern:
            return {"ok": False, "reason": "pattern required"}
        hits = self.source_capture.grepSources(pattern)
        return {"ok": True, "hits": hits, "count": len(hits)}

    def _readSource(self, args: Dict[str, Any]) -> Dict[str, Any]:
        path = args.get("path", "")
        if not path:
            return {"ok": False, "reason": "path required"}
        return self.source_capture.readSource(path)

    def _registerModels(self, args: Dict[str, Any]) -> Dict[str, Any]:
        models = args.get("models", [])
        if not isinstance(models, list):
            return {"ok": False, "reason": "models must be an array"}
        # Normalise — accept either {name,id} or bare strings.
        norm: List[Dict[str, str]] = []
        for m in models:
            if isinstance(m, str):
                norm.append({"name": m, "id": m})
            elif isinstance(m, dict) and m.get("name"):
                norm.append({"name": str(m["name"]), "id": str(m.get("id") or m["name"])})
        self.target.saveModels(norm)
        return {"ok": True, "count": len(norm), "path": str(self.target.models_path)}

    def _setCredentials(self, args: Dict[str, Any]) -> Dict[str, Any]:
        username = args.get("username", "")
        password = args.get("password", "")
        if not username or not password:
            return {"ok": False, "reason": "username + password required"}
        cp = configparser.ConfigParser(interpolation=None)
        # Read existing config to preserve everything else.
        if self.config_ini_path.exists():
            try:
                cp.read(self.config_ini_path, encoding="utf-8")
            except Exception as e:
                return {"ok": False, "reason": f"config.ini read failed: {e}"}
        section = f"bridge_credentials.{self.target.key}"
        if not cp.has_section(section):
            cp.add_section(section)
        cp.set(section, "username", username)
        cp.set(section, "password", password)
        cp.set(section, "created", datetime.now(timezone.utc).isoformat())
        try:
            with open(self.config_ini_path, "w", encoding="utf-8") as f:
                cp.write(f)
        except Exception as e:
            return {"ok": False, "reason": f"config.ini write failed: {e}"}
        return {"ok": True, "section": section}

    def _readVerificationEmail(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return imap_verifier.readVerificationEmail(
            address=args.get("address", ""),
            timeout_seconds=int(args.get("timeout_seconds", 90)),
            expected_sender_domain=args.get("expected_sender_domain"),
            expected_url_domain=args.get("expected_url_domain"),
        )
