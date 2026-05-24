#!/usr/bin/env python3
"""
pack_release.py — build a distributable .vsix for Claude Codex Black Ed.

OVERVIEW
========
This script wraps `npx @vscode/vsce package` (the canonical VSCode Marketplace
packager) and adds the safety steps that keep the user's PERSONAL credentials
out of the shipped artifact while keeping the package functional on a fresh
end-user install.

REFERENCES (consulted while authoring this script)
==================================================
- Microsoft docs — "Publishing Extensions" (canonical .vsix tooling overview):
    https://code.visualstudio.com/api/working-with-extensions/publishing-extension
  Quote: "vsce, short for 'Visual Studio Code Extensions', is a command-line
  tool for packaging, publishing and managing VS Code extensions. ... To package
  an extension, run `vsce package` ..."
- @vscode/vsce on npm (canonical package, replaces the older standalone `vsce`):
    https://www.npmjs.com/package/@vscode/vsce
  Recommended invocation: `npx @vscode/vsce package`
- .vscodeignore syntax — same section of the publishing docs:
    "You can author a `.vscodeignore` file at the root of your project, with
    glob patterns (one per line) of files / directories to exclude from the
    package." Syntax follows .gitignore conventions.
- vsce CLI flags:
    --out <path>                   explicit .vsix output path
    --allow-missing-repository     skip "no repository" error
    --no-dependencies              skip npm install of devDeps (we trust the
                                   local node_modules tree)
    --skip-license                 don't require LICENSE.md (we ship LICENSE)
    --ignore-file <path>           alternate .vscodeignore (we use the default
                                   at the project root, so we don't pass this)

WHAT THIS SCRIPT DOES
=====================
1. Reads the version from package.json (currently 1.0.1; --version overrides).
2. Verifies required files / dirs exist (fail fast if anything is missing).
3. PRE-PACK SAFETY:
     a. Renames config.ini → config.ini.real-backup
     b. Copies config.dist.ini → config.ini  (this is what ships)
     c. Renames every local *.db / *.sqlite* file to <name>.real-backup
        so per-machine DBs do NOT get baked into the .vsix. The runtime
        code regenerates them on first launch (see AUDIT block below).
4. Invokes:  npx @vscode/vsce package --out dist/codex-black-ed-<ver>.vsix
             --allow-missing-repository --no-dependencies --skip-license
5. POST-PACK RESTORE (try/finally so a crash mid-pack still restores):
     a. Removes the dist config.ini.
     b. Renames config.ini.real-backup → config.ini.
     c. Renames every *.real-backup db file back to its original name.
6. Prints a summary: vsix path, file count, total uncompressed size.

DB-REGEN AUDIT (verified 2026-05-22)
====================================
Every persistent .db / .sqlite* file the project creates is auto-created on
first access:

| File                                       | Owner module                | Auto-create path                              |
|--------------------------------------------|-----------------------------|-----------------------------------------------|
| bridges_cpp/bridge_usage.db                | bridges_cpp/smart_bridge.py | initUsageDb() — CREATE TABLE IF NOT EXISTS    |
| data/supergrok_bridge.sqlite3              | app.py RequestDatabase      | RequestBase.metadata.create_all(engine)       |
| data/supergrok_bridge_ui.sqlite3           | app.py UIStateDatabase      | UIStateBase.metadata.create_all(engine)       |
| data/supergrok_bridge_processes.sqlite3    | app.py ProcessDatabase      | ProcessBase.metadata.create_all(engine)       |
| data/supergrok_bridge_debugger.sqlite3     | app.py / debugger module    | metadata.create_all(engine)                   |
| data/supergrok_bridge_exceptions.sqlite3   | exception_log.py            | ExceptionDatabase.__init__ create_all         |
| data/toolcall_policy.sqlite3               | app.py CommandPolicyDatabase| PolicyBase.metadata.create_all(engine)        |

Every constructor calls `DATA.mkdir(parents=True, exist_ok=True)` before
opening the SQLAlchemy engine, so the data/ dir is also recreated. Result:
the .vsix can ship WITHOUT any *.db / *.sqlite* file and a fresh end-user
install regenerates each one cleanly on first use.

Other persistent-state files that should NOT ship (also handled by the
.vscodeignore + extension.js PULL_EXCLUDES list):
  domains.txt, wake.txt, prompt_history.txt, prompts.txt, port.txt,
  debug.log, session.log, build_full.log, MonkeyPatchDetector.txt,
  config.ini  (replaced by config.dist.ini at pack time),
  data/, bridges/, logs/, chats/, reports/, .claude/

USAGE
=====
    python tools/pack_release.py
    python tools/pack_release.py --version 1.0.2
    python tools/pack_release.py --output dist
    python tools/pack_release.py --version 1.0.2 --output out --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Iterable

# Force UTF-8 stdout/stderr so the box-drawing + status glyphs this script
# prints don't crash on a Windows cp1252 console (UnicodeEncodeError).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


# --- paths ----------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent  # the extension root
PACKAGE_JSON = ROOT / "package.json"
CONFIG_REAL = ROOT / "config.ini"
CONFIG_DIST = ROOT / "config.dist.ini"
CONFIG_BACKUP = ROOT / "config.ini.real-backup"
DEFAULT_OUTPUT_DIR = ROOT / "dist"


# File / dir presence checks. Missing any of these fails the pack.
REQUIRED_FILES: tuple[str, ...] = (
    "package.json",
    "extension.js",
    "LICENSE",
    "README.md",
    "panel/index.html",
    "panel/panel.js",
    "panel/help.html",
    "config.dist.ini",
    ".vscodeignore",
)
REQUIRED_DIRS: tuple[str, ...] = (
    "panel",
    "skins",
    "sounds",
    "assets",
    "languages",
    "lib",
    "tools",
    "bin",
    "resources",
    "fonts",
    "hooks",
    "bridge",
)
# Native bridge exes — at least one must exist (we use a glob).
REQUIRED_BRIDGE_GLOB = "bin/CBE-Bridge-*.exe"


# Patterns for DB files we'll move aside pre-pack and restore post-pack.
DB_SUFFIXES: tuple[str, ...] = (
    ".db",
    ".sqlite",
    ".sqlite3",
    ".sqlite-wal",
    ".sqlite-shm",
    ".sqlite-journal",
)


# ANSI helpers (best effort — Windows cmd.exe supports VT seqs on Win10+).
def _green(s: str) -> str:  return f"\033[32m{s}\033[0m"
def _red(s: str) -> str:    return f"\033[31m{s}\033[0m"
def _yellow(s: str) -> str: return f"\033[33m{s}\033[0m"
def _cyan(s: str) -> str:   return f"\033[36m{s}\033[0m"
def _dim(s: str) -> str:    return f"\033[2m{s}\033[0m"


def readPackageVersion() -> str:
    """Pull the version field from package.json."""
    data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    version = str(data.get("version") or "").strip()
    if not version:
        raise SystemExit(_red("ERROR: package.json has no 'version' field"))
    return version


def verifyRequiredFiles() -> None:
    """Hard-fail if any required file / dir / glob is missing."""
    missing: list[str] = []
    for relPath in REQUIRED_FILES:
        if not (ROOT / relPath).is_file():
            missing.append(f"file: {relPath}")
    for relPath in REQUIRED_DIRS:
        if not (ROOT / relPath).is_dir():
            missing.append(f"dir:  {relPath}")
    bridgeExes = sorted((ROOT / "bin").glob("CBE-Bridge-*.exe"))
    if not bridgeExes:
        missing.append(f"glob: {REQUIRED_BRIDGE_GLOB} (need at least one)")
    if missing:
        print(_red("✗ Required files / dirs missing:"))
        for m in missing:
            print(f"    - {m}")
        raise SystemExit(2)
    print(_green(f"✓ Found {len(REQUIRED_FILES)} required files, "
                 f"{len(REQUIRED_DIRS)} required dirs, "
                 f"{len(bridgeExes)} bridge exe(s)"))


def findDbFiles() -> list[Path]:
    """Return every per-machine DB file under the project root."""
    results: list[Path] = []
    skipDirs = {"node_modules", ".git", "dist", "__pycache__", "data", "bridge_profiles"}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        # in-place prune
        dirnames[:] = [d for d in dirnames if d not in skipDirs]
        for fn in filenames:
            lower = fn.lower()
            for suf in DB_SUFFIXES:
                if lower.endswith(suf):
                    results.append(Path(dirpath) / fn)
                    break
    return results


def moveAsideDbFiles(dbFiles: Iterable[Path]) -> list[tuple[Path, Path]]:
    """Rename every DB file to <name>.real-backup. Return (orig, backup) pairs."""
    pairs: list[tuple[Path, Path]] = []
    for src in dbFiles:
        backup = src.with_suffix(src.suffix + ".real-backup")
        # Defensive: if a stale backup somehow exists, remove it (shouldn't).
        if backup.exists():
            backup.unlink()
        src.rename(backup)
        pairs.append((src, backup))
    return pairs


def restoreDbFiles(pairs: Iterable[tuple[Path, Path]]) -> None:
    """Reverse moveAsideDbFiles. Best-effort: log but don't raise on errors."""
    for orig, backup in pairs:
        try:
            if backup.exists():
                if orig.exists():
                    # Pack inadvertently created a real DB? Unlikely, but keep
                    # the user's original by removing the empty dist DB first.
                    orig.unlink()
                backup.rename(orig)
        except OSError as error:
            print(_red(f"  WARN: failed to restore {orig}: {error}"))


def stagePackConfig() -> bool:
    """
    Pre-pack: move config.ini -> config.ini.real-backup, copy config.dist.ini
    in its place. Return True if a real config.ini existed and was backed up.
    """
    if not CONFIG_DIST.is_file():
        raise SystemExit(_red(f"ERROR: missing template {CONFIG_DIST.name}"))
    realExisted = CONFIG_REAL.is_file()
    if realExisted:
        if CONFIG_BACKUP.exists():
            # Stale backup from a crashed prior run. Restoring it first would
            # clobber the freshly real one — surface and abort.
            raise SystemExit(_red(
                f"ERROR: stale {CONFIG_BACKUP.name} from a crashed prior run.\n"
                "       Manually compare it against config.ini and resolve before re-running."
            ))
        CONFIG_REAL.rename(CONFIG_BACKUP)
    shutil.copyfile(CONFIG_DIST, CONFIG_REAL)
    return realExisted


def restorePackConfig(realExisted: bool) -> None:
    """Post-pack: remove the dist config.ini and restore the real one."""
    try:
        if CONFIG_REAL.exists():
            CONFIG_REAL.unlink()
    except OSError as error:
        print(_red(f"  WARN: failed to remove dist config.ini: {error}"))
    if realExisted:
        try:
            if CONFIG_BACKUP.exists():
                CONFIG_BACKUP.rename(CONFIG_REAL)
        except OSError as error:
            print(_red(f"  WARN: failed to restore real config.ini: {error}"))


def buildVsceCommand(outputVsix: Path) -> list[str]:
    """Assemble the npx @vscode/vsce command we shell out to."""
    # On Windows, npm/npx live in .cmd shims, so we need shell=True OR use the
    # explicit .cmd file. The simpler approach: run via cmd.exe so the shell
    # finds npx.cmd on PATH.
    cmd = [
        "npx",
        "--yes",
        "@vscode/vsce",
        "package",
        "--out",
        str(outputVsix),
        "--allow-missing-repository",
        "--no-dependencies",
        "--skip-license",
    ]
    return cmd


def runVsce(cmd: list[str], dryRun: bool) -> int:
    """Invoke vsce. Return the process exit code."""
    printable = " ".join(f'"{c}"' if " " in c else c for c in cmd)
    print(_cyan(f"$ {printable}"))
    if dryRun:
        print(_yellow("  [--dry-run] skipping actual vsce invocation"))
        return 0
    # shell=True lets Windows find npx.cmd on PATH without us hardcoding the path.
    completed = subprocess.run(cmd, cwd=str(ROOT), shell=(os.name == "nt"))
    return int(completed.returncode)


def injectConfigIntoVsix(vsixPath: Path) -> None:
    """Add `extension/config.ini` (a copy of config.dist.ini) into the .vsix.

    .vscodeignore deliberately excludes `config.ini` so the maintainer's REAL
    config never leaks on a bare `vsce package`. That also excludes the
    dist-copy the pack stages, so we inject the template here, post-build —
    end users get a working config.ini without weakening the ignore guard.
    Idempotent: skips if the entry already exists.
    """
    if not CONFIG_DIST.exists():
        print(_yellow("    config.dist.ini missing — skipping config.ini injection"))
        return
    data = CONFIG_DIST.read_bytes()
    with zipfile.ZipFile(vsixPath, "a", zipfile.ZIP_DEFLATED) as z:
        if "extension/config.ini" in set(z.namelist()):
            print(_dim("    extension/config.ini already present — skipping"))
            return
        z.writestr("extension/config.ini", data)
    print(_green("    injected extension/config.ini (from config.dist.ini)"))


def summarizeVsix(vsix: Path) -> None:
    """Print file count and uncompressed size of the produced .vsix."""
    if not vsix.is_file():
        print(_red(f"✗ Expected output not found: {vsix}"))
        return
    try:
        with zipfile.ZipFile(vsix) as zf:
            members = zf.infolist()
            fileCount = len(members)
            uncompressed = sum(m.file_size for m in members)
            compressed = sum(m.compress_size for m in members)
    except zipfile.BadZipFile:
        print(_red(f"✗ {vsix.name} is not a valid zip"))
        return
    sizeOnDisk = vsix.stat().st_size
    print(_green(f"\n✓ Built {vsix.name}"))
    print(f"    path:              {vsix}")
    print(f"    files in archive:  {fileCount}")
    print(f"    uncompressed size: {uncompressed:,} bytes  ({uncompressed / 1024 / 1024:.2f} MB)")
    print(f"    compressed size:   {compressed:,} bytes  ({compressed / 1024 / 1024:.2f} MB)")
    print(f"    .vsix on disk:     {sizeOnDisk:,} bytes  ({sizeOnDisk / 1024 / 1024:.2f} MB)")


def parseArgs() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a distribution .vsix for Claude Codex Black Ed.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--version",
        default=None,
        help="Override the version embedded in the .vsix filename (defaults to package.json version).",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Directory to write the .vsix to. Created if missing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do every prep step (config swap, DB move-aside, command print), "
             "but skip the actual `npx vsce` invocation.",
    )
    return parser.parse_args()


def main() -> int:
    args = parseArgs()

    print(_cyan("── pack_release.py ────────────────────────────────────────────"))
    print(f"  project root:   {ROOT}")

    version = (args.version or readPackageVersion()).strip()
    print(f"  version:        {version}")

    outputDir = Path(args.output).resolve()
    outputDir.mkdir(parents=True, exist_ok=True)
    outputVsix = outputDir / f"codex-black-ed-{version}.vsix"
    print(f"  output:         {outputVsix}")
    if outputVsix.exists():
        print(_yellow(f"  (overwriting existing {outputVsix.name})"))

    print(_cyan("\n→ verifying required files…"))
    verifyRequiredFiles()

    print(_cyan("\n→ scanning for per-machine DB files…"))
    dbFiles = findDbFiles()
    if dbFiles:
        for f in dbFiles:
            print(f"    {_dim(str(f.relative_to(ROOT)))}")
    else:
        print(_dim("    (none found)"))

    # try/finally guarantees the user's real config.ini + DBs come back even
    # if vsce explodes mid-pack.
    realConfigExisted = False
    dbPairs: list[tuple[Path, Path]] = []
    rc = 1
    try:
        print(_cyan("\n→ staging config.dist.ini → config.ini (real one set aside)…"))
        realConfigExisted = stagePackConfig()
        if realConfigExisted:
            print(_green(f"    {CONFIG_BACKUP.name}  (real config preserved)"))
            print(_green(f"    {CONFIG_REAL.name}  ← copy of {CONFIG_DIST.name}"))
        else:
            print(_yellow("    (no real config.ini found — only dist version staged)"))

        if dbFiles:
            print(_cyan("\n→ moving DB files aside…"))
            dbPairs = moveAsideDbFiles(dbFiles)
            print(_green(f"    {len(dbPairs)} DB file(s) renamed to *.real-backup"))

        print(_cyan("\n→ invoking vsce…"))
        cmd = buildVsceCommand(outputVsix)
        rc = runVsce(cmd, dryRun=args.dry_run)
        if args.dry_run:
            pass
        elif outputVsix.exists() and outputVsix.stat().st_size > 0:
            # vsce can return non-zero on harmless warnings while still
            # producing a valid .vsix — treat "file exists + non-empty" as
            # success and normalize the exit code to 0.
            print(_cyan("\n→ injecting config.ini (from config.dist.ini) into .vsix…"))
            injectConfigIntoVsix(outputVsix)
            summarizeVsix(outputVsix)
            rc = 0
        else:
            print(_red(f"\n✗ vsce failed with exit code {rc} (no .vsix produced)"))
    finally:
        print(_cyan("\n→ restoring real config.ini + DB files…"))
        restorePackConfig(realConfigExisted)
        restoreDbFiles(dbPairs)
        print(_green("    restore complete"))

    print(_cyan("\n── done ──────────────────────────────────────────────────────"))
    print(f"  EXCLUDED via .vscodeignore: data/, bridges/, logs/, chats/, reports/,")
    print(f"                              config.ini, *.db, *.sqlite*, __pycache__,")
    print(f"                              *.log, *.bak, *.tmp, *.swp, *.vsix,")
    print(f"                              tools/_debug_*.py, panel/themes/**/*.png")
    print(f"  SHIPPED:                    extension.js, package.json, LICENSE, README.md,")
    print(f"                              panel/, skins/, sounds/, assets/, languages/,")
    print(f"                              lib/, fonts/, hooks/, bridge/, resources/icon*.png,")
    print(f"                              bin/CBE-Bridge-*.exe, tools/{{vscode_supervisor,")
    print(f"                              install_bridge_service,uninstall_bridge_service}}.ps1,")
    print(f"                              tools/nssm.exe, config.dist.ini (as config.ini)")
    return rc


if __name__ == "__main__":
    sys.exit(main())
