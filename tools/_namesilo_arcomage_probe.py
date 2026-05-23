#!/usr/bin/env python3
"""One-shot NameSilo probe: confirm arcomage.org is in the account and
dump every current DNS record so we know what (if anything) needs to
change before adding an A record for the VPS."""
import configparser, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

CFG = Path(r"C:\Users\moren\Desktop\Claude Codex Black\config.ini")
cp = configparser.ConfigParser(); cp.read(CFG, encoding="utf-8")
key = cp["namesilo"]["api_key"]
base = cp["namesilo"]["base_url"]

def call(op, **params):
    params.update({"version": "1", "type": "xml", "key": key})
    url = f"{base}/{op}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return ET.fromstring(r.read())

# 1) listDomains — confirm arcomage.org is registered to this NameSilo account
root = call("listDomains")
code = root.findtext("reply/code")
status = root.findtext("reply/detail")
domains = [d.text for d in root.findall("reply/domains/domain")]
print(f"listDomains  rc={code}  {status}")
print(f"  {len(domains)} domain(s) in account")
match = [d for d in domains if "arcomage" in (d or "").lower()]
print(f"  arcomage match: {match}")
if not match:
    print("  WARNING: arcomage.org not in NameSilo account — wrong registrar?")
    print("  first 5 in account:", domains[:5])

# 2) dnsListRecords for arcomage.org — full DNS picture
print()
print("=== arcomage.org current DNS ===")
try:
    r = call("dnsListRecords", domain="arcomage.org")
    code = r.findtext("reply/code"); det = r.findtext("reply/detail")
    print(f"  rc={code}  {det}")
    for rec in r.findall("reply/resource_record"):
        rid   = rec.findtext("record_id")
        rtype = rec.findtext("type")
        host  = rec.findtext("host")
        value = rec.findtext("value")
        ttl   = rec.findtext("ttl")
        prio  = rec.findtext("distance") or "-"
        print(f"  [{rid}] {rtype:6s} {host:30s} {value:50s} ttl={ttl} pri={prio}")
except urllib.error.HTTPError as e:
    print(f"  HTTP error: {e}")
