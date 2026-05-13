"""
Hook File: zip_hook.py

What it does:
Zip archive utility for creating, extracting, listing, extending, and inspecting zip files while logging activity to MariaDB.

How to use it:
Run `python zip_hook.py <action> ...` with the zip, unzip, list, add, or info actions documented in the file.

Primary entry points:
db_connect, ensure_log_table, log, add_to_zip, action_zip, action_unzip, action_list, action_add, action_info, zip, unzip, list_zip

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""

import sys
import os
import zipfile
import datetime
from trio_hook_orm import ensure_log_table, log_hook

def log(msg, is_error=0):
    try:
        ensure_log_table("zip_hook_log")
        log_hook("zip_hook_log", msg, int(is_error))
    except Exception as e:
        print(f"[zip_hook] log error: {e}", file=sys.stderr)

def add_to_zip(zf, source, arcname_base=None):
    source = os.path.abspath(source)
    if os.path.isfile(source):
        arcname = arcname_base if arcname_base else os.path.basename(source)
        zf.write(source, arcname)
    elif os.path.isdir(source):
        base = arcname_base if arcname_base else os.path.basename(source)
        for root, dirs, files in os.walk(source):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, os.path.dirname(source))
                zf.write(full_path, rel_path)
    else:
        raise FileNotFoundError(f"Source not found: {source}")

def action_zip(source, dest):
    source = os.path.abspath(source)
    dest   = os.path.abspath(dest)
    if not os.path.exists(source):
        raise FileNotFoundError(f"Source not found: {source}")
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        add_to_zip(zf, source)
    size_mb = os.path.getsize(dest) / (1024 * 1024)
    msg = f"Zipped '{source}' -> '{dest}' ({size_mb:.2f} MB)"
    log(msg)
    print(msg)

def action_unzip(source, dest_dir):
    source   = os.path.abspath(source)
    dest_dir = os.path.abspath(dest_dir)
    if not os.path.exists(source):
        raise FileNotFoundError(f"Archive not found: {source}")
    os.makedirs(dest_dir, exist_ok=True)
    with zipfile.ZipFile(source, "r") as zf:
        zf.extractall(dest_dir)
    msg = f"Extracted '{source}' -> '{dest_dir}'"
    log(msg)
    print(msg)

def action_list(source):
    source = os.path.abspath(source)
    if not os.path.exists(source):
        raise FileNotFoundError(f"Archive not found: {source}")
    with zipfile.ZipFile(source, "r") as zf:
        names = zf.namelist()
    for n in names:
        print(n)
    log(f"Listed {len(names)} entries in '{source}'")
    return names

def action_add(source_zip, file_or_dir):
    source_zip  = os.path.abspath(source_zip)
    file_or_dir = os.path.abspath(file_or_dir)
    if not os.path.exists(source_zip):
        raise FileNotFoundError(f"Archive not found: {source_zip}")
    if not os.path.exists(file_or_dir):
        raise FileNotFoundError(f"Source not found: {file_or_dir}")
    with zipfile.ZipFile(source_zip, "a", zipfile.ZIP_DEFLATED) as zf:
        add_to_zip(zf, file_or_dir)
    msg = f"Added '{file_or_dir}' to '{source_zip}'"
    log(msg)
    print(msg)

def action_info(source):
    source = os.path.abspath(source)
    if not os.path.exists(source):
        raise FileNotFoundError(f"Archive not found: {source}")
    with zipfile.ZipFile(source, "r") as zf:
        names  = zf.namelist()
        infos  = zf.infolist()
        total  = sum(i.file_size for i in infos)
        comp   = sum(i.compress_size for i in infos)
    size_mb   = os.path.getsize(source) / (1024 * 1024)
    ratio     = (1 - comp / total) * 100 if total > 0 else 0
    print(f"Archive : {source}")
    print(f"Files   : {len(names)}")
    print(f"Uncompressed : {total / (1024*1024):.2f} MB")
    print(f"Compressed   : {size_mb:.2f} MB")
    print(f"Ratio        : {ratio:.1f}% savings")
    log(f"Info on '{source}': {len(names)} files, {size_mb:.2f} MB")

def zip(source, dest):       action_zip(source, dest)
def unzip(source, dest_dir): action_unzip(source, dest_dir)
def list_zip(source):        return action_list(source)
def add(source_zip, item):   action_add(source_zip, item)
def info(source):            action_info(source)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    cmd = sys.argv[1].lower()
    try:
        if cmd == "zip" and len(sys.argv) >= 4:
            action_zip(sys.argv[2], sys.argv[3])
        elif cmd == "unzip" and len(sys.argv) >= 4:
            action_unzip(sys.argv[2], sys.argv[3])
        elif cmd == "list" and len(sys.argv) >= 3:
            action_list(sys.argv[2])
        elif cmd == "add" and len(sys.argv) >= 4:
            action_add(sys.argv[2], sys.argv[3])
        elif cmd == "info" and len(sys.argv) >= 3:
            action_info(sys.argv[2])
        else:
            print(__doc__)
            sys.exit(1)
    except Exception as e:
        log(str(e), is_error=1)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)