"""source_capture.py — QWebEngineUrlRequestInterceptor stub.

Per whitepaper §6, every captured response body goes to:

    bridge_sources/<key>/<session_id>/
        manifest.json     # url -> file mapping
        01_index.html
        02_main.<hash>.js
        ...

GPT-4o uses list_sources / grep_sources / read_source to investigate.

v1 SCAFFOLD STATUS:
    - The real interceptor will live inside the per-target QWebEngineView and
      requires Qt's `QWebEngineUrlRequestInterceptor` (intercept URLs only —
      response bodies need a separate `QWebEngineProfile` hook that varies by
      Qt 6.x point release).
    - For v1 we ship the filesystem layout, session id generation, and the
      manifest writer. Calling `captureResponse(url, body, mime, status)` from
      a later integration point will land bytes on disk in the right shape.
    - read_source / list_sources / grep_sources tools (openai_tools.py) read
      from this directory — so once anything is written here, GPT-4o can use it.

Hygiene: prune to the last 2 sessions per target on bridge boot.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


# Maximum captured-source file size before truncation (read_source tool honours
# this — anything bigger is returned with a "[truncated]" footer).
MAX_READ_SOURCE_BYTES = 256 * 1024

# Per-target retention. 2 means "the most-recent session plus the one before".
KEEP_SESSIONS_PER_TARGET = 2


def newSessionId(key: str) -> str:
    """ISO timestamp + target key. Used as bridge_sources/<key>/<session>/ dir."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    return f"{stamp}-{key}"


class SourceCapture:
    """One instance per target.

    Holds the path roots and the in-memory manifest for the current session.
    Thread-safe — Qt's request interceptor fires from arbitrary threads.
    """

    def __init__(self, key: str, bridge_sources_root: Path):
        self.key = key
        self.root = bridge_sources_root / key
        self.session_id: Optional[str] = None
        self.session_dir: Optional[Path] = None
        self._entries: List[Dict] = []
        self._lock = threading.RLock()
        self._sequence = 0

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def startSession(self) -> str:
        """Begin a new capture session. Returns the session id.

        Called when a target's offscreen view first navigates to the chat URL
        (or on every fresh login). Pre-existing sessions are kept up to
        KEEP_SESSIONS_PER_TARGET; older are pruned.
        """
        with self._lock:
            self.session_id = newSessionId(self.key)
            self.session_dir = self.root / self.session_id
            self.session_dir.mkdir(parents=True, exist_ok=True)
            self._entries = []
            self._sequence = 0
            self._pruneOldSessions()
            self._writeManifest()
            return self.session_id

    def _pruneOldSessions(self) -> None:
        """Delete all but the KEEP_SESSIONS_PER_TARGET most-recent sessions."""
        if not self.root.exists():
            return
        try:
            sessions = sorted(
                [d for d in self.root.iterdir() if d.is_dir()],
                key=lambda d: d.stat().st_mtime,
                reverse=True,
            )
            for stale in sessions[KEEP_SESSIONS_PER_TARGET:]:
                try:
                    shutil.rmtree(stale, ignore_errors=True)
                    print(f"[bridges_py] [{self.key}] pruned {stale.name}")
                except Exception as e:
                    print(f"[bridges_py] [{self.key}] prune failed: {e}")
        except Exception as e:
            print(f"[bridges_py] [{self.key}] prune scan failed: {e}")

    # ── Capture ─────────────────────────────────────────────────────────────

    def captureResponse(self, url: str, body: bytes, mime: str = "", status: int = 200) -> Optional[str]:
        """Tee one response body to disk. Returns the relative filename or None
        if no session is active.

        Stub for v1: the wiring from Qt's request interceptor lands later. The
        on-disk layout is correct so the read/list/grep tools work as soon as
        anything calls this.
        """
        with self._lock:
            if self.session_dir is None:
                return None
            self._sequence += 1
            ext = self._guessExtension(url, mime)
            url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
            fname = f"{self._sequence:02d}_{url_hash}{ext}"
            target = self.session_dir / fname
            try:
                target.write_bytes(body)
            except Exception as e:
                print(f"[bridges_py] [{self.key}] capture write failed: {e}")
                return None
            self._entries.append({
                "file":   fname,
                "url":    url,
                "mime":   mime,
                "status": int(status),
                "ts":     time.time(),
            })
            self._writeManifest()
            return fname

    def _guessExtension(self, url: str, mime: str) -> str:
        m = (mime or "").lower()
        if "javascript" in m or "ecmascript" in m: return ".js"
        if "json" in m:                            return ".json"
        if "html" in m:                            return ".html"
        if "css" in m:                             return ".css"
        if "svg" in m:                             return ".svg"
        u = url.lower().split("?", 1)[0]
        for ext in (".js", ".json", ".html", ".css", ".svg", ".png", ".jpg", ".gif", ".woff", ".woff2"):
            if u.endswith(ext):
                return ext
        return ".bin"

    def _writeManifest(self) -> None:
        if self.session_dir is None:
            return
        manifest = {
            "session_id":   self.session_id,
            "key":          self.key,
            "captured_at":  datetime.now(timezone.utc).isoformat(),
            "entries":      self._entries,
        }
        try:
            (self.session_dir / "manifest.json").write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as e:
            print(f"[bridges_py] [{self.key}] manifest write failed: {e}")

    # ── Read tools (used by openai_tools.py) ────────────────────────────────

    def listSources(self, glob_pattern: str = "*") -> List[str]:
        """list_sources tool. Returns filenames in the current session matching glob."""
        with self._lock:
            if self.session_dir is None or not self.session_dir.exists():
                return []
            return sorted(p.name for p in self.session_dir.glob(glob_pattern) if p.is_file())

    def readSource(self, filename: str) -> Dict:
        """read_source tool. Returns {ok, text, truncated, bytes_total}."""
        with self._lock:
            if self.session_dir is None:
                return {"ok": False, "reason": "no active session"}
            p = self.session_dir / filename
            if not p.exists() or not p.is_file():
                return {"ok": False, "reason": f"not found: {filename}"}
            total = p.stat().st_size
            if total > MAX_READ_SOURCE_BYTES:
                data = p.read_bytes()[:MAX_READ_SOURCE_BYTES]
                text = data.decode("utf-8", errors="replace")
                return {"ok": True, "text": text + "\n\n[truncated]", "truncated": True, "bytes_total": total}
            return {
                "ok":          True,
                "text":        p.read_text(encoding="utf-8", errors="replace"),
                "truncated":   False,
                "bytes_total": total,
            }

    def grepSources(self, pattern: str, max_hits: int = 200) -> List[Dict]:
        """grep_sources tool. Plain regex (no ripgrep dependency). Returns
        list of {file, line_no, line}."""
        with self._lock:
            if self.session_dir is None or not self.session_dir.exists():
                return []
            try:
                rx = re.compile(pattern)
            except re.error as e:
                return [{"file": "", "line_no": 0, "line": f"[regex error] {e}"}]
            hits: List[Dict] = []
            for p in sorted(self.session_dir.iterdir()):
                if not p.is_file() or p.name == "manifest.json":
                    continue
                try:
                    text = p.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue
                for i, line in enumerate(text.splitlines(), 1):
                    if rx.search(line):
                        hits.append({
                            "file":    p.name,
                            "line_no": i,
                            "line":    line[:500],  # cap super-long minified-JS lines
                        })
                        if len(hits) >= max_hits:
                            return hits
            return hits
