"""build_changelog.py — generate panel/change_log.html from git log.

Walks the repo's commit history (newest first) and emits a styled HTML page
that the panel renders inside an iframe-srcdoc, matching help.html's layout.

Each commit becomes one section with:
  - short SHA + author + relative date
  - title line (first line of the commit message)
  - bullet list of every other non-empty line in the body

Run after every commit (or as part of CI). The panel host reads the result
on activate and ships it in the init payload as window.__cbeChangelogHtml.
"""

from __future__ import annotations

import html
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
OUTPUT_FH  = ROOT / "panel" / "change_log.html"

GIT_FORMAT = "%x1f".join([
    "%H",       # full hash
    "%h",       # short hash
    "%an",      # author name
    "%ae",      # author email
    "%aI",      # ISO 8601 author date
    "%s",       # subject (first line of message)
    "%b",       # body (rest of message)
]) + "%x1e"     # record separator


def _git_log() -> list[dict[str, str]]:
    out = subprocess.run(
        ["git", "-C", str(ROOT), "log", f"--pretty=format:{GIT_FORMAT}", "--no-merges"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if out.returncode != 0:
        print(f"git log rc={out.returncode}: {out.stderr.strip()[:300]}", file=sys.stderr)
        return []
    rows: list[dict[str, str]] = []
    for record in out.stdout.split("\x1e"):
        record = record.strip("\n\r")
        if not record:
            continue
        parts = record.split("\x1f")
        if len(parts) < 7:
            continue
        rows.append({
            "hash":    parts[0],
            "short":   parts[1],
            "author":  parts[2],
            "email":   parts[3],
            "iso":     parts[4],
            "subject": parts[5],
            "body":    parts[6],
        })
    return rows


def _relative(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        delta = now - dt
        secs = int(delta.total_seconds())
        if secs < 60:        return "just now"
        if secs < 3600:      return f"{secs // 60}m ago"
        if secs < 86400:     return f"{secs // 3600}h ago"
        if secs < 30 * 86400:  return f"{secs // 86400}d ago"
        if secs < 365 * 86400: return f"{secs // (30 * 86400)}mo ago"
        return f"{secs // (365 * 86400)}y ago"
    except Exception:
        return iso


def _commit_html(c: dict[str, str], index: int) -> str:
    short    = html.escape(c["short"])
    full     = html.escape(c["hash"])
    author   = html.escape(c["author"])
    subject  = html.escape(c["subject"])
    iso      = html.escape(c["iso"])
    rel      = html.escape(_relative(c["iso"]))
    body     = c["body"] or ""
    # body lines — skip Co-Authored-By trailers + bare blanks
    bullets: list[str] = []
    for raw in body.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.lower().startswith("co-authored-by:"):
            continue
        bullets.append(line)
    body_html = ""
    if bullets:
        body_html = "<ul>" + "".join(f"<li>{html.escape(b)}</li>" for b in bullets) + "</ul>"
    return f"""
<section class="commit" id="c-{short}">
  <header>
    <h2><span class="num">{index}.</span> {subject}</h2>
    <div class="meta">
      <code class="sha" title="{full}">{short}</code>
      <span class="author">{author}</span>
      <time datetime="{iso}" title="{iso}">{rel}</time>
    </div>
  </header>
  {body_html}
</section>"""


def build_html() -> str:
    rows = _git_log()
    commit_section = "\n".join(_commit_html(c, i) for i, c in enumerate(rows, 1)) if rows else (
        "<p class='empty'>No commits found. Run <code>git init</code> + a first commit, "
        "or check that this script runs from the repo root.</p>"
    )
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    count     = len(rows)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Codex Black — Change Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{
    --bg: #16181d;
    --surface: #1f2229;
    --surface-2: #262a33;
    --border: #353a45;
    --text: #e7eaef;
    --muted: #aab1bd;
    --accent: #4ea8ff;
    --accent-soft: rgba(78,168,255,0.12);
  }}
  * {{ box-sizing: border-box; }}
  html, body, .app {{ margin: 0; padding: 0; height: 100%;
                     background: var(--bg); color: var(--text);
                     font: 14.5px/1.55 ui-sans-serif, system-ui, -apple-system,
                     "Segoe UI", sans-serif; }}
  .app {{ display: flex; flex-direction: column; }}
  header.page {{
    padding: 18px 26px; border-bottom: 1px solid var(--border);
    display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  }}
  header.page h1 {{ margin: 0; font-size: 18px; }}
  header.page .meta {{ color: var(--muted); font-size: 12px; font-family: ui-monospace, Consolas, monospace; }}
  main {{ flex: 1 1 auto; overflow-y: auto; padding: 16px 26px 32px 26px; }}
  section.commit {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 18px; margin: 0 0 14px 0;
  }}
  section.commit header {{ display: flex; align-items: baseline;
    justify-content: space-between; gap: 16px; flex-wrap: wrap; }}
  section.commit h2 {{ margin: 0; font-size: 15px; font-weight: 600; line-height: 1.35; }}
  section.commit .num {{ color: var(--muted); margin-right: 6px; font-weight: 400; }}
  section.commit .meta {{ display: flex; gap: 12px; align-items: center;
    color: var(--muted); font-size: 12px; }}
  section.commit code.sha {{
    background: #0f1116; padding: 2px 7px; border-radius: 4px;
    border: 1px solid #2b313b; font-family: ui-monospace, Consolas, monospace;
    color: var(--accent); cursor: help;
  }}
  section.commit ul {{ margin: 10px 0 0 0; padding-left: 22px; color: var(--text); }}
  section.commit ul li {{ margin: 3px 0; line-height: 1.5; }}
  p.empty {{ padding: 32px; text-align: center; color: var(--muted); }}
  *::-webkit-scrollbar {{ width: 10px; height: 10px; }}
  *::-webkit-scrollbar-track {{ background: var(--bg); }}
  *::-webkit-scrollbar-thumb {{ background: var(--surface-2); border-radius: 5px; }}
  *::-webkit-scrollbar-thumb:hover {{ background: var(--border); }}
</style>
</head>
<body>
<div class="app">
  <header class="page">
    <h1>Change Log</h1>
    <div class="meta">{count} commits · generated {generated}</div>
  </header>
  <main>
    {commit_section}
  </main>
</div>
</body>
</html>
"""


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    html_doc = build_html()
    OUTPUT_FH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FH.write_text(html_doc, encoding="utf-8")
    size = OUTPUT_FH.stat().st_size
    print(f"wrote {OUTPUT_FH.relative_to(ROOT)}  bytes={size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
