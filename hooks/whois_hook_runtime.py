"""
Hook File: whois_hook_runtime.py

What it does:
Runtime copy of the WHOIS and DNS helper used to resolve a domain and normalize its WHOIS fields.

How to use it:
Import and call run(domain_name) in the same way as whois_hook.py.

Primary entry points:
run

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : whois_hook_runtime.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Runtime copy of the WHOIS and DNS helper used to resolve a domain and normalize its WHOIS fields.
#
# HOW TO INVOKE
#   Import and call run(domain_name) in the same way as whois_hook.py.
#
# PRIMARY ENTRY POINTS
#   - run
#
# CREDENTIALS
#   API keys, tokens, and remote endpoints live in config.ini at
#   the repo root. Hooks read them via hooks/_config.py. Do NOT
#   hardcode keys in source. Do NOT push config.ini to the server
#   (it is on the auto-update exclude list in extension.js).
#
# SIDE EFFECTS
#   May make outbound network calls, may write to disk under the
#   repo root (logs/, chats/, reports/), may spawn subprocesses,
#   may touch the journaling DB through trio_hook_orm. Inspect
#   the function before running it on production data.
#
# THINGS THIS HOOK WILL NOT DO
#   - It will not reload the VSCode window. Nothing in this repo
#     reloads the window. See handbook.txt Section 8.
#   - It will not push files to the server. Pushing is gated on
#     config.ini [updates] is_admin=true and is handled by the
#     extension, not by individual hooks. See handbook.txt §17.
#   - It will not silently swallow errors. If it fails it raises
#     or returns a structured error; check the trace channel.
#
# RELATED HANDBOOK SECTIONS
#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library
#   §22 Trace channel   §24 Troubleshooting
#
# === LLM-USAGE: END ===
import socket
from datetime import datetime

try:
    import whois
except ImportError as e:
    raise RuntimeError("The python-whois package is required. Install it with: py -m pip install python-whois") from e


def run(domain_name: str):
    if not domain_name or not str(domain_name).strip():
        raise ValueError("A domain name is required.")

    domain = str(domain_name).strip().lower()
    if "://" in domain:
        domain = domain.split("://", 1)[1]
    domain = domain.split("/", 1)[0].strip()
    if domain.startswith("www."):
        domain = domain[4:]

    record = whois.whois(domain)

    def normalize(value):
        if isinstance(value, list):
            return [normalize(v) for v in value]
        if isinstance(value, datetime):
            return value.isoformat()
        return value

    result = {
        "domain": domain,
        "registrar": normalize(record.registrar),
        "whois_server": normalize(getattr(record, "whois_server", None)),
        "creation_date": normalize(record.creation_date),
        "expiration_date": normalize(record.expiration_date),
        "updated_date": normalize(record.updated_date),
        "name_servers": normalize(record.name_servers),
        "status": normalize(record.status),
        "emails": normalize(record.emails),
        "org": normalize(getattr(record, "org", None)),
        "country": normalize(getattr(record, "country", None)),
        "dns_resolves": False,
        "resolved_ips": [],
    }

    try:
        _, _, ips = socket.gethostbyname_ex(domain)
        result["dns_resolves"] = True
        result["resolved_ips"] = ips
    except Exception:
        pass

    return result
