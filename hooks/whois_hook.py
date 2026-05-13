"""
Hook File: whois_hook.py

What it does:
Domain WHOIS and DNS helper that normalizes a domain, reads WHOIS data, and reports whether the domain resolves.

How to use it:
Import and call run(domain_name) after installing python-whois.

Primary entry points:
run

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

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
