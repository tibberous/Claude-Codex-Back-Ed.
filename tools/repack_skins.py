"""
repack_skins.py — pack a directory of skin assets into a `.skin` archive
(STORED, not deflated) with a standard manifest.xml at the root.

A .skin file is a plain zip with `.skin` extension that uses STORE
compression so the extension can mmap/stream files out without paying the
inflate cost. The on-disk layout inside the archive is:

    manifest.xml          <- required, defines author + entry points
    index.html            <- skin HTML at root
    styles.css            <- skin CSS at root
    script.js             <- optional JS hook
    assets/*.svg          <- icons referenced by relative path from index.html

Usage:
    # Pack an unpacked skin directory into <out>/<id>.skin
    python tools/repack_skins.py pack SRC_DIR OUT_DIR \
        --id glassy --name "Glassy" --description "Frosted-glass prompt bar"

    # Repack one of the legacy *_promptbar_markup.zip skins (auto-discovers
    # id/name/description from folder name + first <h1> / README).
    python tools/repack_skins.py repack-zip path/to/skin.zip OUT_DIR

(c) 2026 Trenton Tompkins. MIT.
"""
from __future__ import annotations
import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


AUTHOR = {
    "name":    "Trenton Tompkins",
    "email":   "trenttompkins@gmail.com",
    "phone":   "724-431-5207",
    "website": "https://trentontompkins.com",
    "github":  "https://www.github.com/tibberous",
}


def manifestXml(*, skin_id: str, name: str, version: str, description: str,
                html: str = "index.html", css: str = "styles.css",
                js: str = "script.js", assets: str = "assets/") -> str:
    """Generate the canonical manifest.xml body. Every .skin in the system
    has this exact shape so the loader can parse it deterministically."""
    e = escape
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<skin format="1">\n'
        f'  <id>{e(skin_id)}</id>\n'
        f'  <name>{e(name)}</name>\n'
        f'  <version>{e(version)}</version>\n'
        f'  <description>{e(description)}</description>\n'
        '  <author>\n'
        f'    <name>{e(AUTHOR["name"])}</name>\n'
        f'    <email>{e(AUTHOR["email"])}</email>\n'
        f'    <phone>{e(AUTHOR["phone"])}</phone>\n'
        f'    <website>{e(AUTHOR["website"])}</website>\n'
        f'    <github>{e(AUTHOR["github"])}</github>\n'
        '  </author>\n'
        '  <license>MIT</license>\n'
        '  <copyright>(c) 2026 Trenton Tompkins</copyright>\n'
        '  <entry>\n'
        f'    <html>{e(html)}</html>\n'
        f'    <css>{e(css)}</css>\n'
        f'    <js>{e(js)}</js>\n'
        f'    <assets>{e(assets)}</assets>\n'
        '  </entry>\n'
        '</skin>\n'
    )


def packSkin(src_dir: Path, out_path: Path, *, skin_id: str, name: str,
             description: str, version: str = "1.0.0") -> Path:
    """Zip `src_dir`'s contents into `out_path` (.skin) using STORED.

    A fresh manifest.xml is written into the archive root (any pre-existing
    manifest.xml in src_dir is replaced). Other files keep their relative
    paths under src_dir. Directories are NOT added as separate entries —
    they're implied by the file paths."""
    src_dir = src_dir.resolve()
    if not src_dir.is_dir():
        raise FileNotFoundError(f"skin source directory not found: {src_dir}")
    out_path = Path(out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = manifestXml(skin_id=skin_id, name=name, version=version,
                           description=description)

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.xml", manifest)
        for path in sorted(src_dir.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(src_dir).as_posix()
            # Don't double-write manifest.xml or any *.skin file the source
            # accidentally contains.
            if rel == "manifest.xml" or rel.endswith(".skin"):
                continue
            zf.write(path, arcname=rel, compress_type=zipfile.ZIP_STORED)
    return out_path


def repackZip(zip_path: Path, out_dir: Path) -> Path:
    """Repack a legacy `*_promptbar_markup.zip` into a `.skin`. Strips the
    leading folder prefix (everything inside the zip lives under a single
    top-level dir) so files land at the .skin root."""
    zip_path = Path(zip_path).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Derive a sensible id/name from the filename: e.g.
    # `glassy_promptbar_markup.zip` -> id=glassy, name="Glassy".
    stem = zip_path.stem
    skin_id = stem.split("_")[0].lower()
    name = skin_id.capitalize()
    description_map = {
        "glassy": "Frosted-glass prompt bar with translucent buttons and beveled highlights.",
        "office": "Office-ribbon-styled prompt bar with flat tool buttons.",
    }
    description = description_map.get(skin_id, f"{name} skin for the Claude Codex Black prompt bar.")

    with tempfile.TemporaryDirectory(prefix=f"skin_{skin_id}_") as td:
        td_path = Path(td)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(td_path)
        # Find the single top-level dir (legacy skin zips always have one).
        children = [p for p in td_path.iterdir() if p.is_dir() and not p.name.startswith(".")]
        if len(children) == 1:
            src_dir = children[0]
        else:
            src_dir = td_path  # fallback — files are already at root
        out_path = out_dir / f"{skin_id}.skin"
        return packSkin(src_dir, out_path,
                        skin_id=skin_id, name=name, description=description)


# ── CLI ────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    p_pack = sub.add_parser("pack", help="Pack a directory into a .skin")
    p_pack.add_argument("src_dir")
    p_pack.add_argument("out_dir")
    p_pack.add_argument("--id", required=True)
    p_pack.add_argument("--name", required=True)
    p_pack.add_argument("--description", required=True)
    p_pack.add_argument("--version", default="1.0.0")

    p_rezip = sub.add_parser("repack-zip", help="Convert a legacy promptbar-markup.zip into a .skin")
    p_rezip.add_argument("zip_path")
    p_rezip.add_argument("out_dir")

    args = p.parse_args(argv)
    if args.cmd == "pack":
        out = packSkin(Path(args.src_dir), Path(args.out_dir) / f"{args.id}.skin",
                       skin_id=args.id, name=args.name, description=args.description,
                       version=args.version)
        print(f"wrote {out} ({out.stat().st_size:,} bytes)")
    elif args.cmd == "repack-zip":
        out = repackZip(Path(args.zip_path), Path(args.out_dir))
        print(f"wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
