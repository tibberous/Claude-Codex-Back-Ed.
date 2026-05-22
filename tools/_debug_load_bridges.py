"""Smoke test: list every bridge the runner discovers."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_runner import discover_bridges

bridges = discover_bridges(Path(__file__).resolve().parent.parent / "bridges")
print(f"Loaded {len(bridges)} bridges:\n")

cols = ("name", "kind", "port", "fastPath", "capabilities")
print(f"{cols[0]:<14} {cols[1]:<6} {cols[2]:<6} {cols[3]:<10} {cols[4]}")
print("-" * 100)
for name, b in sorted(bridges.items()):
    caps = ",".join(
        c for c, attrs in b.manifest.capabilities.items()
        if attrs.get("supported", "false") == "true"
    )
    print(f"{name:<14} {b.manifest.kind:<6} {b.manifest.bridge_port:<6} {str(b.manifest.fast_path):<10} {caps[:65]}")
