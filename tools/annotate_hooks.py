"""
annotate_hooks.py

Walks every *.py file in /hooks/ and injects (or refreshes) an
LLM-USAGE comment block immediately after the file's top docstring.

The LLM-USAGE block is the canonical, in-file documentation aimed at a
language-model consumer of the hook: what to call, what NOT to do,
where credentials live, side effects, and the link back to the
Aperture-flavored handbook for repo-wide rules.

Idempotent: re-running replaces the existing LLM-USAGE block in place
rather than stacking duplicates. Skips files that have no leading
docstring (those would need a hand-written header first).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent.parent / "hooks"

BEGIN = "# === LLM-USAGE: BEGIN ==="
END = "# === LLM-USAGE: END ==="

EXISTING_BLOCK_RE = re.compile(
    rf"\n?{re.escape(BEGIN)}.*?{re.escape(END)}\n?",
    re.DOTALL,
)

DOCSTRING_RE = re.compile(
    r'^(?P<shebang>#![^\n]*\n)?(?P<lead>\s*)(?P<q>"""|\'\'\')(?P<body>.*?)(?P=q)\s*\n',
    re.DOTALL,
)


def extractField(body: str, label: str) -> str:
    pattern = rf"{re.escape(label)}\s*:\s*\n(?P<v>.*?)(?:\n\s*\n|\Z)"
    m = re.search(pattern, body)
    if not m:
        return ""
    return m.group("v").strip()


def buildBlock(hookName: str, docstringBody: str) -> str:
    what = extractField(docstringBody, "What it does")
    how = extractField(docstringBody, "How to use it")
    entries = extractField(docstringBody, "Primary entry points")

    lines = [
        BEGIN,
        "#",
        f"# Hook        : {hookName}",
        "# Audience    : language-model agent (Claude, GPT, Gemini, etc.)",
        "# Surface     : flat top-level functions; no classes to subclass,",
        "#               no hidden state across process boundaries.",
        "#",
    ]

    if what:
        lines.append("# WHAT IT DOES")
        for ln in what.splitlines():
            lines.append(f"#   {ln.strip()}")
        lines.append("#")

    if how:
        lines.append("# HOW TO INVOKE")
        for ln in how.splitlines():
            lines.append(f"#   {ln.strip()}")
        lines.append("#")

    if entries:
        lines.append("# PRIMARY ENTRY POINTS")
        for chunk in [c.strip() for c in entries.replace("\n", ",").split(",") if c.strip()]:
            lines.append(f"#   - {chunk}")
        lines.append("#")

    lines.extend([
        "# CREDENTIALS",
        "#   API keys, tokens, and remote endpoints live in config.ini at",
        "#   the repo root. Hooks read them via hooks/_config.py. Do NOT",
        "#   hardcode keys in source. Do NOT push config.ini to the server",
        "#   (it is on the auto-update exclude list in extension.js).",
        "#",
        "# SIDE EFFECTS",
        "#   May make outbound network calls, may write to disk under the",
        "#   repo root (logs/, chats/, reports/), may spawn subprocesses,",
        "#   may touch the journaling DB through trio_hook_orm. Inspect",
        "#   the function before running it on production data.",
        "#",
        "# THINGS THIS HOOK WILL NOT DO",
        "#   - It will not reload the VSCode window. Nothing in this repo",
        "#     reloads the window. See handbook.txt Section 8.",
        "#   - It will not push files to the server. Pushing is gated on",
        "#     config.ini [updates] is_admin=true and is handled by the",
        "#     extension, not by individual hooks. See handbook.txt §17.",
        "#   - It will not silently swallow errors. If it fails it raises",
        "#     or returns a structured error; check the trace channel.",
        "#",
        "# RELATED HANDBOOK SECTIONS",
        "#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library",
        "#   §22 Trace channel   §24 Troubleshooting",
        "#",
        END,
    ])

    return "\n".join(lines) + "\n"


def processFile(path: Path) -> str:
    original = path.read_text(encoding="utf-8")
    text = EXISTING_BLOCK_RE.sub("\n", original, count=1)

    m = DOCSTRING_RE.match(text)
    if not m:
        return f"SKIP   {path.name}  (no top docstring)"

    body = m.group("body")
    block = buildBlock(path.name, body)

    insertAt = m.end()
    newText = text[:insertAt] + "\n" + block + text[insertAt:]

    if newText == original:
        return f"NOOP   {path.name}"

    path.write_text(newText, encoding="utf-8", newline="\n")
    action = "REFRESH" if BEGIN in original else "ADD    "
    return f"{action} {path.name}"


def main() -> int:
    if not HOOKS_DIR.is_dir():
        print(f"hooks directory not found: {HOOKS_DIR}", file=sys.stderr)
        return 2

    paths = sorted(HOOKS_DIR.glob("*.py"))
    if not paths:
        print(f"no *.py files under {HOOKS_DIR}", file=sys.stderr)
        return 1

    print(f"annotating {len(paths)} hook files in {HOOKS_DIR}")
    for p in paths:
        print(processFile(p))
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
