#!/usr/bin/env python3
"""
nn4_proxy_sidecar.py — frame-busting HTTP proxy for CBE's in-panel NN4 browser.

Spawned by extension.js when the NN4 Browser webview opens.  Listens on a
randomly-picked free 127.0.0.1 port (printed as the FIRST line of stdout as
'PORT=<n>' so the parent can read it back), accepts GET/POST at /proxy?url=...
and:

  - Fetches the target server-side via urllib (stdlib, no deps)
  - Strips X-Frame-Options / CSP frame-ancestors / Set-Cookie / HSTS so
    the result will iframe-embed cleanly
  - Injects <base href> + rewrites <a href>/<form action> through this proxy
  - SSRF-guards private/loopback hosts
  - Logs each request to stderr so the VSCode "Codex Black Ed." output channel
    (which captures the child's stderr via the trace pipe) sees what failed

This mirrors proxy.php from the repo root, but runs locally — no server
deploy needed, no roundtrip latency, no rate limits.

Usage (CLI):
    python nn4_proxy_sidecar.py [--port 0] [--host 127.0.0.1]

When --port is 0 (default) an ephemeral free port is chosen.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import ipaddress
import json
import re
import socket
import ssl
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import quote, urlparse

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Response headers we strip before forwarding to the iframe.  Anything in this
# set would either block the embed (XFO/CSP), leak the target's session
# (Set-Cookie), or confuse the iframe's parsing (transfer-encoding etc.).
STRIP_HEADERS = {
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "set-cookie",
    "transfer-encoding",
    "content-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "public-key-pins",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    "permissions-policy",
    "feature-policy",
}


def log(msg: str) -> None:
    """Stderr-log with timestamp prefix.  Parent extension.js pipes stderr
    into trace() so every line lands in the 'Codex Black Ed.' output channel."""
    ts = time.strftime("%H:%M:%S")
    sys.stderr.write(f"[nn4-proxy {ts}] {msg}\n")
    sys.stderr.flush()


def is_blocked_host(host: str) -> Optional[str]:
    """Return a string reason if host resolves to a private/loopback IP, else None."""
    try:
        # If already an IP, validate directly
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = ipaddress.ip_address(socket.gethostbyname(host))
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            return f"host {host} resolves to disallowed IP {ip}"
        return None
    except (socket.gaierror, ValueError) as e:
        return f"DNS lookup failed for {host}: {e}"


def rewrite_html(body: bytes, final_url: str, self_base: str) -> bytes:
    """Inject <base href> + rewrite <a href>/<form action> through self_base."""
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body

    parts = urlparse(final_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    path = parts.path or "/"
    base_path = re.sub(r"/[^/]*$", "/", path)
    base_href = origin + base_path

    # Inject <base href> + a tiny postMessage listener so the panel's Print
    # button (which can't call frame.contentWindow.print() across origins)
    # can ask the page to print itself.  The listener runs inside the page's
    # own origin, so window.print() is allowed.  Same listener also handles
    # 'cbe-getsource' — read documentElement.outerHTML and post it back to
    # the panel via parent.postMessage.  See panel/nn4-browser.html
    # btnPrint / File-menu handlers for the matching sender side.
    # Listener handles three panel->page messages, all of which must run in
    # the page's OWN origin (the panel is vscode-webview:// and can't touch
    # this DOM or call window.print() across origins):
    #   cbe-print     -> window.print(); acks back so the panel can trace it
    #   cbe-getsource -> post documentElement.outerHTML back to the panel
    #   cbe-zoom      -> set documentElement/body style.zoom (CSS zoom applied
    #                    INSIDE the page works; setting it on the cross-origin
    #                    <iframe> element from the panel does not). factor is
    #                    clamped 0.3..3.0 to match the panel-side clamp.
    # The same script also captures `contextmenu` IN THE PAGE'S ORIGIN
    # (a cross-origin <iframe> swallows the event; the panel never sees it)
    # and relays the cursor coords up to the panel so the NN4-skinned
    # right-click menu can be shown at the correct position.
    print_helper = (
        "<script>(function(){try{"
        "document.addEventListener('contextmenu',function(ev){"
        "try{ev.preventDefault();"
        "parent.postMessage({type:'cbe-ctxmenu',x:ev.clientX,y:ev.clientY},'*');}"
        "catch(_){}} ,true);"
        "window.addEventListener('message',"
        "function(e){var d=e&&e.data;"
        "if(d&&(d==='cbe-print'||d.type==='cbe-print')){"
        "try{window.print();parent.postMessage({type:'cbe-print-ack',ok:true},'*');}"
        "catch(err){parent.postMessage({type:'cbe-print-ack',ok:false,error:String(err&&err.message||err)},'*');}}"
        "else if(d&&d.type==='cbe-zoom'){"
        "try{var f=parseFloat(d.factor);if(!f||isNaN(f))f=1;"
        "if(f<0.3)f=0.3;if(f>3)f=3;"
        "var de=document.documentElement;if(de)de.style.zoom=String(f);"
        "if(document.body)document.body.style.zoom=String(f);"
        "parent.postMessage({type:'cbe-zoom-ack',ok:true,factor:f},'*');}"
        "catch(err){parent.postMessage({type:'cbe-zoom-ack',ok:false,error:String(err&&err.message||err)},'*');}}"
        "else if(d&&d.type==='cbe-getsource'){"
        "try{var h=document.documentElement?document.documentElement.outerHTML:'';"
        "parent.postMessage({type:'cbe-source',reqId:d.reqId||'',url:location.href,html:h},'*');}"
        "catch(err){parent.postMessage({type:'cbe-source',reqId:d.reqId||'',error:String(err&&err.message||err)},'*');}}"
        # cbe-find: run the search IN the page's own origin (the panel is
        # cross-origin to this document and cannot call window.find on it).
        # Prefer the native window.find(); if the engine lacks it, fall back
        # to a TreeWalker scan + scrollIntoView on the first text match.
        # Acks {type:'cbe-find-result', found, count} AND legacy
        # {type:'cbe-find-ack',...} so either panel listener shape works.
        "else if(d&&d.type==='cbe-find'){"
        "try{var q=String(d.query||d.text||'');var fwd=(d.forward!==false);"
        "var ok=false,cnt=0;"
        "if(typeof window.find==='function'){"
        "try{ok=window.find(q,false,!fwd,true,false,false,false);}catch(_f){ok=false;}}"
        "if(!ok&&q){"
        "var tw=document.createTreeWalker(document.body||document.documentElement,"
        "NodeFilter.SHOW_TEXT,null,false);var ql=q.toLowerCase();var node,hit=null;"
        "while((node=tw.nextNode())){var tx=node.nodeValue||'';"
        "if(tx.toLowerCase().indexOf(ql)>=0){cnt++;if(!hit)hit=node;}}"
        "if(hit){ok=true;try{var rg=document.createRange();"
        "var pos=(hit.nodeValue||'').toLowerCase().indexOf(ql);"
        "rg.setStart(hit,pos);rg.setEnd(hit,pos+q.length);"
        "var sel=window.getSelection();sel.removeAllRanges();sel.addRange(rg);"
        "var pe=hit.parentElement;if(pe&&pe.scrollIntoView)"
        "pe.scrollIntoView({block:'center'});}catch(_s){}}}"
        "parent.postMessage({type:'cbe-find-result',found:ok,count:cnt,query:q},'*');"
        "parent.postMessage({type:'cbe-find-ack',found:ok,count:cnt,query:q},'*');}"
        "catch(err){parent.postMessage({type:'cbe-find-result',found:false,error:String(err&&err.message||err)},'*');}}"
        "},false);}catch(_){}})();</script>"
    )
    inject = f'<base href="{base_href}">' + print_helper
    # insert after <head ...>
    head_re = re.compile(r"(<head[^>]*>)", re.IGNORECASE)
    if head_re.search(text):
        text = head_re.sub(r"\1" + inject, text, count=1)
    else:
        text = inject + text

    def absolutize(url: str) -> str:
        """Return absolute URL or empty if it should be skipped."""
        low = url.lower()
        if low.startswith(("data:", "javascript:", "mailto:", "tel:", "about:", "#")):
            return ""
        if self_base + "?url=" in url:
            return ""
        if url.startswith("//"):
            return "https:" + url
        if url.startswith("/"):
            return origin + url
        if re.match(r"^[a-z]+://", url, re.IGNORECASE):
            return url
        return base_href + url

    def make_rewriter(tags: tuple, attr: str):
        """Build a (pattern, repl) pair for <tag attr="...">.
        Routes attr URLs through the proxy."""
        tag_alt = "|".join(tags)
        pat = re.compile(
            r'(<(?:' + tag_alt + r')\b[^>]*?\s' + attr + r'=)(["\'])([^"\']*)\2',
            re.IGNORECASE,
        )

        def repl(m):
            url = m.group(3)
            absu = absolutize(url)
            if not absu:
                return m.group(0)
            new = self_base + "?url=" + quote(absu, safe="")
            return m.group(1) + m.group(2) + new + m.group(2)

        return pat, repl

    # Rewrite ALL externally-loaded assets through the proxy. Without this
    # the webview's CSP blocks direct cross-origin fetches and the page
    # renders unstyled / image-less / script-less. Order matters only for
    # readability; each pass is independent.
    rewrites = (
        (("a", "form", "area"),              "href"),    # links + form posts
        (("a", "form", "area"),              "action"),  # form posts
        (("link",),                          "href"),    # stylesheets, icons
        (("img", "script", "iframe",
          "source", "audio", "video"),       "src"),     # media + scripts
        (("img", "source"),                  "srcset"),  # responsive images (basic — first URL only)
    )
    for tags, attr in rewrites:
        pat, repl = make_rewriter(tags, attr)
        text = pat.sub(repl, text)

    return text.encode("utf-8")


def _fmt_cert_time(s: str) -> str:
    """Convert ssl getpeercert() time strings like 'Jan 15 00:00:00 2026 GMT'
    into ISO 8601 UTC ('2026-01-15T00:00:00Z'). On failure, return the raw."""
    if not s:
        return ""
    try:
        # ssl uses the C locale format consistently
        dt = _dt.datetime.strptime(s, "%b %d %H:%M:%S %Y %Z")
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return s


def _name_to_dict(name_tuple) -> dict:
    """getpeercert() returns subject/issuer as a tuple of tuples of (key,val)
    pairs. Flatten to a dict using the short field names ssl gives us."""
    out: dict = {}
    if not name_tuple:
        return out
    for rdn in name_tuple:
        for k, v in rdn:
            out[k] = v
    return out


def fetch_cert(host: str, port: int = 443, timeout: float = 8.0) -> dict:
    """Connect to host:port over TLS and return a JSON-serialisable summary of
    the peer certificate. Returns {"ok": False, "error": "..."} on any failure
    (DNS, TCP, TLS handshake, cert validation, etc.).

    Uses ssl.create_default_context() so an EXPIRED or HOSTNAME-MISMATCH cert
    surfaces as ok=False with the verify error message — exactly what the user
    asked the UI to display."""
    if not host:
        return {"ok": False, "error": "empty host"}
    blocked = is_blocked_host(host)
    if blocked:
        return {"ok": False, "error": "Blocked: " + blocked}
    ctx = ssl.create_default_context()
    raw = b""
    cert: Optional[dict] = None
    fp_sha256 = ""
    err_msg = ""
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert()
                try:
                    raw = ssock.getpeercert(binary_form=True) or b""
                except Exception:
                    raw = b""
    except ssl.SSLCertVerificationError as e:
        err_msg = f"cert verify failed: {e.verify_message or e}"
    except ssl.SSLError as e:
        err_msg = f"SSL error: {e}"
    except (socket.gaierror, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        err_msg = f"connection failed: {e}"
    except Exception as e:
        err_msg = f"unexpected: {e!r}"

    # Verify-failure path: try again with an unverified context so we can still
    # show the user what cert the server PRESENTED (issuer/dates/etc.).
    if err_msg and cert is None:
        try:
            unv = ssl._create_unverified_context()  # type: ignore[attr-defined]
            with socket.create_connection((host, port), timeout=timeout) as sock:
                with unv.wrap_socket(sock, server_hostname=host) as ssock:
                    try:
                        raw = ssock.getpeercert(binary_form=True) or b""
                    except Exception:
                        raw = b""
                    # getpeercert() with no validation returns {} — derive what
                    # we can from the binary DER instead (see below).
                    cert = {}
        except Exception:
            pass

    if raw:
        fp_sha256 = ":".join(
            f"{b:02X}" for b in hashlib.sha256(raw).digest()
        )

    if not cert and not raw:
        return {"ok": False, "host": host, "port": port, "error": err_msg or "no certificate"}

    subj = _name_to_dict(cert.get("subject")) if cert else {}
    iss = _name_to_dict(cert.get("issuer")) if cert else {}
    san_raw = cert.get("subjectAltName") if cert else None
    san = [v for (k, v) in (san_raw or []) if k.lower() == "dns"]

    return {
        "ok": not err_msg,
        "scheme": "https",
        "host": host,
        "port": port,
        "subject_cn": subj.get("commonName", ""),
        "subject_o":  subj.get("organizationName", ""),
        "issuer_cn":  iss.get("commonName", ""),
        "issuer_o":   iss.get("organizationName", ""),
        "not_before": _fmt_cert_time(cert.get("notBefore", "")) if cert else "",
        "not_after":  _fmt_cert_time(cert.get("notAfter", "")) if cert else "",
        "serial":     cert.get("serialNumber", "") if cert else "",
        "version":    cert.get("version", "") if cert else "",
        "san":        san,
        "fingerprint_sha256": fp_sha256,
        "error":      err_msg,
    }


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "CBENn4Proxy/1.0"

    # Suppress default per-request stderr logging — we do our own.
    def log_message(self, format, *args):  # noqa: A002
        pass

    def _send_error(self, code: int, msg: str) -> None:
        body = (
            "<!doctype html><meta charset=utf-8>"
            "<style>body{font:14px/1.4 -apple-system,Segoe UI,sans-serif;"
            "padding:1em;background:#fff;color:#111}</style>"
            f"<h2>Proxy error {code}</h2><p>{msg}</p>"
        ).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_proxy(self, method: str) -> None:
        # Parse query
        from urllib.parse import parse_qs

        qs = urlparse(self.path).query
        params = parse_qs(qs)
        target = (params.get("url") or [""])[0]
        if not target:
            log("400 missing url param")
            return self._send_error(400, "Missing ?url=")
        parts = urlparse(target)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            log(f"400 bad url {target!r}")
            return self._send_error(400, "Only http(s) URLs allowed")

        blocked = is_blocked_host(parts.hostname or "")
        if blocked:
            log(f"403 SSRF {blocked}")
            return self._send_error(403, "Blocked: " + blocked)

        # Read POST body if applicable
        body = None
        if method in ("POST", "PUT", "PATCH"):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""

        # Build outbound request
        req = urlrequest.Request(target, data=body, method=method)
        req.add_header("User-Agent", UA)
        req.add_header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        req.add_header("Accept-Language", "en-US,en;q=0.9")
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)

        t0 = time.time()
        try:
            resp = urlrequest.urlopen(req, timeout=30)
        except urlerror.HTTPError as e:
            # Forward upstream status + body so the iframe shows the real
            # 404/500 page instead of a generic proxy error.
            log(f"upstream HTTP {e.code} {target} ({int((time.time()-t0)*1000)}ms)")
            self.send_response(e.code)
            data = e.read() if hasattr(e, "read") else b""
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/html"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        except (urlerror.URLError, TimeoutError, socket.timeout) as e:
            log(f"502 fetch fail {target}: {e}")
            return self._send_error(502, f"Fetch failed: {e}")
        except Exception as e:
            log(f"500 unexpected {target}: {e!r}")
            return self._send_error(500, f"Unexpected: {e}")

        status = resp.status
        final_url = resp.url or target
        content_type = resp.headers.get("Content-Type", "")
        data = resp.read()
        elapsed_ms = int((time.time() - t0) * 1000)
        log(f"{status} {method} {target} -> {final_url} ({elapsed_ms}ms, {len(data)}B, {content_type})")

        # Rewrite HTML so links keep going through the proxy
        if "text/html" in content_type.lower():
            self_base = f"http://{self.server.server_address[0]}:{self.server.server_address[1]}/proxy"
            data = rewrite_html(data, final_url, self_base)

        # Send headers (skip the blocked set)
        self.send_response(status)
        for name, val in resp.headers.items():
            if name.lower() in STRIP_HEADERS:
                continue
            self.send_header(name, val)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def _serve_raw(self) -> None:
        """GET /raw?url=<full_url>  — fetch the target and return its body verbatim
        as text/plain so the panel's View Source modal displays the real source
        instead of our proxy-rewritten HTML. Same SSRF guard + UA forging +
        redirect-following as /proxy; no header stripping (response isn't going
        into an iframe), no <base href> injection, no link rewriting."""
        from urllib.parse import parse_qs

        qs = urlparse(self.path).query
        params = parse_qs(qs)
        target = (params.get("url") or [""])[0]
        if not target:
            log("400 raw missing url param")
            return self._send_error(400, "Missing ?url=")
        parts = urlparse(target)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            log(f"400 raw bad url {target!r}")
            return self._send_error(400, "Only http(s) URLs allowed")
        blocked = is_blocked_host(parts.hostname or "")
        if blocked:
            log(f"403 raw SSRF {blocked}")
            return self._send_error(403, "Blocked: " + blocked)

        req = urlrequest.Request(target, method="GET")
        req.add_header("User-Agent", UA)
        req.add_header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        req.add_header("Accept-Language", "en-US,en;q=0.9")

        t0 = time.time()
        try:
            resp = urlrequest.urlopen(req, timeout=30)
            data = resp.read()
            status = resp.status
            final_url = resp.url or target
        except urlerror.HTTPError as e:
            log(f"raw upstream HTTP {e.code} {target} ({int((time.time()-t0)*1000)}ms)")
            data = e.read() if hasattr(e, "read") else b""
            status = e.code
            final_url = target
        except (urlerror.URLError, TimeoutError, socket.timeout) as e:
            log(f"502 raw fetch fail {target}: {e}")
            return self._send_error(502, f"Fetch failed: {e}")
        except Exception as e:
            log(f"500 raw unexpected {target}: {e!r}")
            return self._send_error(500, f"Unexpected: {e}")

        elapsed_ms = int((time.time() - t0) * 1000)
        log(f"raw {status} {target} -> {final_url} ({elapsed_ms}ms, {len(data)}B)")

        # Force text/plain so the response is shown as source, not rendered.
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def _serve_cert(self) -> None:
        """GET /cert?host=<hostname>[&port=443]  or  /cert?url=<full_url>.
        Returns JSON cert summary (see fetch_cert)."""
        from urllib.parse import parse_qs

        qs = urlparse(self.path).query
        params = parse_qs(qs)
        host = (params.get("host") or [""])[0].strip()
        port_s = (params.get("port") or ["443"])[0].strip()
        url = (params.get("url") or [""])[0].strip()
        if url and not host:
            try:
                up = urlparse(url)
                if up.scheme == "http":
                    body = json.dumps({
                        "ok": False, "scheme": "http", "host": up.hostname or "",
                        "error": "This connection is not encrypted.",
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(body)
                    log(f"cert HTTP url -> not encrypted ({up.hostname})")
                    return
                host = up.hostname or ""
                if up.port:
                    port_s = str(up.port)
            except Exception as e:
                return self._send_error(400, f"Bad url: {e}")
        if not host:
            return self._send_error(400, "Missing ?host= or ?url=")
        try:
            port = int(port_s)
        except ValueError:
            port = 443
        t0 = time.time()
        info = fetch_cert(host, port)
        ms = int((time.time() - t0) * 1000)
        log(f"cert {host}:{port} ok={info.get('ok')} ({ms}ms)")
        body = json.dumps(info).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # ── Routing ────────────────────────────────────────────────────────────
    def _route(self, method: str) -> None:
        path = urlparse(self.path).path
        if path == "/proxy":
            return self._serve_proxy(method)
        if path == "/raw":
            return self._serve_raw()
        if path == "/cert":
            return self._serve_cert()
        if path == "/health":
            body = json.dumps({"ok": True, "ts": time.time()}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        self._send_error(404, "Not found")

    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_HEAD(self):  # noqa: N802
        # HEAD probes from the panel's pre-flight check
        path = urlparse(self.path).path
        if path == "/proxy":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        self._send_error(404, "Not found")


def pick_port(host: str, requested: int) -> int:
    """If requested is 0, ask the OS for a free port; else use as-is."""
    if requested != 0:
        return requested
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0, help="0 = ephemeral free port")
    args = ap.parse_args()

    port = pick_port(args.host, args.port)
    srv = ThreadingHTTPServer((args.host, port), ProxyHandler)
    # First line of stdout = port number, so the parent can read it.
    sys.stdout.write(f"PORT={port}\n")
    sys.stdout.flush()
    log(f"listening on http://{args.host}:{port}/proxy")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("interrupted, shutting down")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
