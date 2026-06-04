"""bridge_service.py — the main entry point.

Per whitepaper §3 (process topology) + §16 (file layout). One unified Python
process that replaces the per-target C++ tray exes in `bridges_cpp/`. It:

  1. Walks `providers/*.xml` at startup, parses, builds an in-memory PROVIDERS
     table (one Target per manifest).
  2. Opens one TCP listener per provider key on its BRIDGE_PORTS port (per
     start.py:187-196). Wire format identical to v1 — newline-delimited JSON.
  3. Wires the per-target state machine (state_machine.TargetState) and the
     per-target source-capture sink (source_capture.SourceCapture).
  4. Delegates browser ops to `start.py --serve-bridge --target <key>` —
     stubbed for v1; next agent connects the subprocess.

v1 SCAFFOLD STATUS (this file):
  - Provider XML parsing: real.
  - TCP listener per target: real. Supports `{"action":"ping"}` returning
    current state, and `{"action":"chat", ...}` returning a "not yet
    implemented" error in the v1 wire shape.
  - State machine init + loadFromDisk hook: real.
  - SourceCapture init + prune-on-boot: real.
  - QWebEngine view per target: NOT started here. Next agent shells into
    `start.py --serve-bridge --target <key> --offscreen` and wires the
    bridge-cmd-server port (~8795 per memory `supergrok_qt_screenshot.md`).
  - OpenAI tool dispatcher per target: instantiated but never invoked yet —
    chat actions need the COLD/WARM/HOT routing first.

Usage:
    py -3 -m bridges_py.bridge_service \\
        --providers "C:/Users/moren/Desktop/Claude Codex Black/providers" \\
        --port-chatgpt 18788 --port-claude 18792 --port-qwen 18794

A smoke ping returns:
    $ echo '{"action":"ping"}' | nc 127.0.0.1 18792
    {"ok":true,"server":"CBE-bridge-py/2.0.0","state":"COLD","target":"claude"}
"""

from __future__ import annotations

import argparse
import json
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional
from xml.etree import ElementTree as ET

from . import SERVER_NAME, __version__
from .openai_tools import ToolDispatcher
from .source_capture import SourceCapture
from .state_machine import BridgeState, TargetState


# ── Defaults that match start.py BRIDGE_PORTS ──────────────────────────────
# Note: the SCAFFOLD smoke test uses high ports (18xxx) so it doesn't fight
# the running C++ tray. Production deployment would map to the canonical
# 8788..8794 set, gated behind config.ini [bridge] use_python=true.
DEFAULT_BRIDGE_PORTS = {
    "chatgpt":  8788,
    "grok":     8789,
    "copilot":  8790,
    "gemini":   8791,
    # claude web bridge removed — Claude uses the Anthropic API + logged-in
    # Claude Code, not a browser bridge. Port 8792 freed.
    "ollama":   8793,
    "deepseek": 8794,
}


# ── Provider manifest ──────────────────────────────────────────────────────

class Provider:
    """Parsed `providers/<key>.xml`. The single source of truth per §9."""

    def __init__(
        self,
        *,
        key: str,
        name: str,
        version: str,
        core: bool,
        release_date: str,
        urls: Dict[str, str],
        readme: str,
        manifest_path: Path,
    ):
        self.key = key
        self.name = name
        self.version = version
        self.core = core
        self.release_date = release_date
        self.urls = urls
        self.readme = readme
        self.manifest_path = manifest_path

    @classmethod
    def fromManifest(cls, manifest_path: Path) -> Optional["Provider"]:
        """Parse one XML manifest. Returns None + prints on parse failure
        (we don't want a single bad manifest to take down the service)."""
        try:
            tree = ET.parse(manifest_path)
        except Exception as e:
            print(f"[bridges_py] manifest parse failed: {manifest_path} ({e})")
            return None
        root = tree.getroot()

        def _text(tag: str, default: str = "") -> str:
            el = root.find(tag)
            return (el.text or default).strip() if el is not None and el.text else default

        key = _text("key")
        if not key:
            # Fall back to filename stem if <key> is missing.
            key = manifest_path.stem
        name = _text("name", key.title())
        version = _text("version", "0.0.0")
        release_date = _text("release_date", "")
        core_el = root.find("core")
        core = (core_el is not None and (core_el.text or "").strip().lower() == "true")

        urls: Dict[str, str] = {}
        urls_el = root.find("urls")
        if urls_el is not None:
            for child in urls_el:
                if child.tag and child.text:
                    urls[child.tag] = child.text.strip()

        readme = _text("readme", "")

        return cls(
            key=key,
            name=name,
            version=version,
            core=core,
            release_date=release_date,
            urls=urls,
            readme=readme,
            manifest_path=manifest_path,
        )


# ── Per-target runtime ─────────────────────────────────────────────────────

class TargetRuntime:
    """Everything that hangs off one provider key at runtime.

    Owned by BridgeService; one instance per parsed manifest.

    Holds: the Provider, the TargetState (state machine), the SourceCapture
    (for read/grep/list_sources tools), and the ToolDispatcher (for OpenAI
    tool calls). The QWebEngineView lives in start.py's --serve-bridge child
    process; this object only knows how to talk to it. Next agent wires that.
    """

    def __init__(
        self,
        *,
        provider: Provider,
        state_dir: Path,
        bridge_sources_dir: Path,
        feedback_log_path: Path,
        config_ini_path: Path,
    ):
        self.provider = provider
        self.state = TargetState(provider.key, state_dir)
        self.source_capture = SourceCapture(provider.key, bridge_sources_dir)
        self.dispatcher = ToolDispatcher(
            target=self.state,
            source_capture=self.source_capture,
            feedback_log_path=feedback_log_path,
            config_ini_path=config_ini_path,
        )
        # Resume from disk: if a script+models pair exists, WARM is plausible.
        self.state.loadFromDisk()
        # Prune old sessions on boot (whitepaper §11 hygiene).
        self.source_capture._pruneOldSessions()

    def handleAction(self, payload: Dict) -> Dict:
        """Top-level wire handler. Mirrors the v1 C++ tray API shape:

            {"action": "ping"}            -> service health + state
            {"action": "status"}          -> richer state dump
            {"action": "chat", "message": ..., "model": ...} -> chat round-trip
                (v1 scaffold: returns not-implemented error in the v1 wire shape)

        Returns a dict that the TCP handler serializes as a JSON line.
        """
        action = (payload.get("action") or "").lower()
        if action in ("", "ping"):
            return {
                "ok":     True,
                "server": SERVER_NAME,
                "state":  self.state.state.name,
                "target": self.provider.key,
            }
        if action == "status":
            return {
                "ok":       True,
                "server":   SERVER_NAME,
                "target":   self.provider.key,
                "name":     self.provider.name,
                "core":     self.provider.core,
                "version":  self.provider.version,
                "urls":     self.provider.urls,
                "state":    self.state.asDict(),
                "models":   self.state.loadModels(),
            }
        if action == "chat":
            # v1 wire-compatible error so existing extension.js chat path can
            # be pointed at this service and get a clean failure mode.
            message = str(payload.get("message", ""))[:120]
            return {
                "ok":     False,
                "target": self.provider.key,
                "server": SERVER_NAME,
                "answer": "",
                "reason": ("bridges_py v1 scaffold: chat round-trip not yet "
                           "implemented. Next agent wires the QWebEngineView "
                           "via start.py --serve-bridge. Current state: "
                           f"{self.state.state.name}. Echo: {message!r}"),
            }
        return {"ok": False, "target": self.provider.key, "reason": f"unknown action: {action}"}


# ── TCP server ─────────────────────────────────────────────────────────────

class _JsonLineHandler(socketserver.StreamRequestHandler):
    """Newline-delimited JSON request/response. Matches v1 C++ tray wire format.

    One request per connection (the wire is `<json>\\n` -> `<json>\\n` then
    close). Multi-request connections are NOT supported in v1 — matches the
    legacy bridge_chat.py / extension.js usage pattern.
    """

    # `server` is the socketserver.ThreadingTCPServer; we attach our runtime
    # to it as `.runtime` in BridgeService.start().

    def handle(self) -> None:
        runtime: TargetRuntime = getattr(self.server, "runtime", None)  # type: ignore[assignment]
        if runtime is None:
            self._write({"ok": False, "reason": "internal: no runtime attached"})
            return
        try:
            line = self.rfile.readline()
            if not line:
                self._write({"ok": False, "reason": "empty request"})
                return
            try:
                payload = json.loads(line.decode("utf-8", errors="replace").strip() or "{}")
            except json.JSONDecodeError as e:
                self._write({"ok": False, "reason": f"json parse: {e}"})
                return
            if not isinstance(payload, dict):
                self._write({"ok": False, "reason": "request must be a JSON object"})
                return
            try:
                response = runtime.handleAction(payload)
            except Exception as e:
                response = {"ok": False, "reason": f"handler exception: {type(e).__name__}: {e}"}
            self._write(response)
        except Exception as e:
            # Last-ditch — never let the handler crash the server thread.
            try:
                self._write({"ok": False, "reason": f"handler fatal: {e}"})
            except Exception:
                pass

    def _write(self, obj: Dict) -> None:
        try:
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception:
            pass


class _ThreadedTcpServer(socketserver.ThreadingTCPServer):
    """One server per provider port. daemon_threads + allow_reuse_address."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass, *, runtime: TargetRuntime):
        super().__init__(server_address, RequestHandlerClass)
        self.runtime = runtime


# ── Top-level service ──────────────────────────────────────────────────────

class BridgeService:
    """Walks providers/, builds runtimes, starts listeners.

    Construction is cheap. Call `start()` to bind ports + serve. `stop()`
    shuts everything down (used in tests; the production process just runs
    until Ctrl+C).
    """

    def __init__(
        self,
        *,
        repo_root: Path,
        providers_dir: Path,
        port_overrides: Optional[Dict[str, int]] = None,
        bind_host: str = "127.0.0.1",
    ):
        self.repo_root = repo_root
        self.providers_dir = providers_dir
        self.port_overrides = port_overrides or {}
        self.bind_host = bind_host

        # State/runtime trees per whitepaper §11.
        self.state_dir = repo_root / "state" / "providers"
        self.bridge_sources_dir = repo_root / "bridge_sources"
        self.bridge_profiles_dir = repo_root / "bridge_profiles"
        self.bridge_logs_dir = repo_root / "bridge_logs"
        self.feedback_log_path = repo_root / "feedback.log"
        self.config_ini_path = repo_root / "config.ini"

        for d in (self.state_dir, self.bridge_sources_dir, self.bridge_profiles_dir, self.bridge_logs_dir):
            d.mkdir(parents=True, exist_ok=True)

        self.providers: Dict[str, Provider] = {}
        self.runtimes: Dict[str, TargetRuntime] = {}
        self.servers: List[_ThreadedTcpServer] = []
        self.threads: List[threading.Thread] = []
        self._stop_evt = threading.Event()

    # ── Provider discovery ──────────────────────────────────────────────────

    def loadProviders(self) -> None:
        if not self.providers_dir.exists():
            print(f"[bridges_py] providers dir not found: {self.providers_dir}")
            return
        found: List[str] = []
        for xml_path in sorted(self.providers_dir.glob("*.xml")):
            p = Provider.fromManifest(xml_path)
            if p is None:
                continue
            self.providers[p.key] = p
            found.append(f"{p.key} ({'core' if p.core else 'ext'})")
        if not found:
            print(f"[bridges_py] no providers parsed from {self.providers_dir}")
        else:
            print(f"[bridges_py] providers parsed: {', '.join(found)}")

    def buildRuntimes(self) -> None:
        for key, provider in self.providers.items():
            self.runtimes[key] = TargetRuntime(
                provider=provider,
                state_dir=self.state_dir,
                bridge_sources_dir=self.bridge_sources_dir,
                feedback_log_path=self.feedback_log_path,
                config_ini_path=self.config_ini_path,
            )

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def _portFor(self, key: str) -> Optional[int]:
        """Resolve per-target port. Precedence: --port-<key> CLI override,
        then DEFAULT_BRIDGE_PORTS. Returns None if the provider isn't in the
        port table (e.g. a third-party provider with no allocated port yet)."""
        if key in self.port_overrides:
            return self.port_overrides[key]
        return DEFAULT_BRIDGE_PORTS.get(key)

    def start(self) -> List[int]:
        """Bind one TCP listener per provider runtime. Returns the list of
        bound ports (for logging)."""
        bound: List[int] = []
        for key, runtime in self.runtimes.items():
            port = self._portFor(key)
            if port is None:
                print(f"[bridges_py] [{key}] no port allocated — skipping listener")
                continue
            try:
                srv = _ThreadedTcpServer((self.bind_host, port), _JsonLineHandler, runtime=runtime)
            except OSError as e:
                print(f"[bridges_py] [{key}] bind {self.bind_host}:{port} failed ({e}) — "
                      "is the C++ tray still up? Use --port-<key> for a high port.")
                continue
            t = threading.Thread(target=srv.serve_forever, name=f"bridge-{key}-{port}", daemon=True)
            t.start()
            self.servers.append(srv)
            self.threads.append(t)
            bound.append(port)
            print(f"[bridges_py] [{key}] listening on {self.bind_host}:{port}")
        return bound

    def stop(self) -> None:
        self._stop_evt.set()
        for srv in self.servers:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                pass

    def waitForever(self) -> None:
        try:
            while not self._stop_evt.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("[bridges_py] Ctrl+C — shutting down")
            self.stop()


# ── CLI ────────────────────────────────────────────────────────────────────

def _buildArgParser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bridges_py.bridge_service",
        description="Unified CBE bridge service (Python+PySide6, v2). See docs/BRIDGE_WHITEPAPER.md.",
    )
    p.add_argument("--providers", required=False,
                   help="Path to the providers/ directory. Defaults to ../providers relative to this module.")
    p.add_argument("--repo-root", required=False,
                   help="Repo root for state/, bridge_sources/, feedback.log, config.ini. "
                        "Defaults to one level above the providers dir.")
    p.add_argument("--bind", default="127.0.0.1", help="Host to bind. Default 127.0.0.1.")
    # Per-target port overrides — used by the scaffold smoke test to dodge
    # the live C++ tray on the canonical 8788..8794. We accept --port-<key>
    # for any provider key (including ones outside DEFAULT_BRIDGE_PORTS, e.g.
    # third-party providers like `qwen` that don't have a stock port allocation).
    for key in DEFAULT_BRIDGE_PORTS:
        p.add_argument(f"--port-{key}", type=int,
                       help=f"Override {key}'s TCP port (default {DEFAULT_BRIDGE_PORTS[key]}).")
    # Extra port flags for third-party providers — picked up post-parse via
    # `parse_known_args` in main().
    p.add_argument("--version", action="version", version=SERVER_NAME)
    return p


def _harvestExtraPortFlags(extra: List[str]) -> Dict[str, int]:
    """Pull `--port-<key> <value>` pairs out of an unparsed-args list.

    `argparse` can't pre-declare ports for providers it doesn't know about
    (third-party manifests). This pass scans whatever argparse rejected.
    """
    overrides: Dict[str, int] = {}
    i = 0
    while i < len(extra):
        arg = extra[i]
        if arg.startswith("--port-"):
            key = arg[len("--port-"):]
            # Support both `--port-foo 1234` and `--port-foo=1234`.
            if "=" in key:
                key, _, val = key.partition("=")
                try:
                    overrides[key] = int(val)
                except ValueError:
                    print(f"[bridges_py] ignoring bad port override: {arg}")
                i += 1
                continue
            if i + 1 < len(extra):
                try:
                    overrides[key] = int(extra[i + 1])
                except ValueError:
                    print(f"[bridges_py] ignoring bad port override: {arg} {extra[i+1]}")
                i += 2
                continue
        i += 1
    return overrides


def main(argv: Optional[List[str]] = None) -> int:
    parser = _buildArgParser()
    args, extra = parser.parse_known_args(argv)

    # Resolve providers/ + repo root.
    if args.providers:
        providers_dir = Path(args.providers).expanduser().resolve()
    else:
        providers_dir = Path(__file__).resolve().parent.parent / "providers"
    if args.repo_root:
        repo_root = Path(args.repo_root).expanduser().resolve()
    else:
        repo_root = providers_dir.parent

    print(f"[bridges_py] v{__version__} booting")
    print(f"[bridges_py] providers dir: {providers_dir}")
    print(f"[bridges_py] repo root:     {repo_root}")

    port_overrides: Dict[str, int] = {}
    for key in DEFAULT_BRIDGE_PORTS:
        val = getattr(args, f"port_{key}", None)
        if val:
            port_overrides[key] = val
    # Pick up `--port-<key>` overrides for third-party providers argparse
    # didn't pre-declare (e.g. `--port-qwen` for the qwen.xml manifest).
    extra_overrides = _harvestExtraPortFlags(extra)
    port_overrides.update(extra_overrides)

    service = BridgeService(
        repo_root=repo_root,
        providers_dir=providers_dir,
        port_overrides=port_overrides,
        bind_host=args.bind,
    )
    service.loadProviders()
    service.buildRuntimes()
    bound = service.start()
    if not bound:
        print("[bridges_py] no listeners bound — exiting")
        return 1
    print(f"[bridges_py] listening on {' '.join(str(p) for p in bound)}")
    service.waitForever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
