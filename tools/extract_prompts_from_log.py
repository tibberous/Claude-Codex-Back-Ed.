"""
extract_prompts_from_log.py

Reads C:\\Users\\moren\\Desktop\\log.txt (a years-deep dump of prompts mixed
with API keys, project metadata, URLs, and dev notes), scores each paragraph,
drops anything that looks like a secret/identifier, dedupes, and writes the
top-quality prompts to c:\\Users\\moren\\Desktop\\Claude Codex Black\\prompts.txt
as one prompt per blank-line-separated block.

Scoring favors paragraphs that:
  - have actual verbs and prose (not just blobs of base64 / alphanumeric)
  - are long enough to be meaningful (>= 50 chars) but not absurdly long
  - contain imperative or question phrasing
  - are NOT detected as API keys, URLs, file paths, project IDs
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(r"C:\Users\moren\Desktop\log.txt")
DST = Path(r"c:\Users\moren\Desktop\Claude Codex Black\prompts.txt")

IMPERATIVE_VERBS = {
    "make", "create", "add", "fix", "build", "write", "generate", "translate",
    "implement", "refactor", "rewrite", "show", "check", "verify", "ensure",
    "use", "do", "save", "load", "open", "close", "push", "pull", "run",
    "install", "remove", "delete", "update", "convert", "register", "wire",
    "hit", "find", "list", "scan", "skip", "stop", "start", "review",
    "audit", "diff", "merge", "split", "extract", "embed", "package",
    "test", "deploy", "publish", "render", "draw", "design", "explain",
    "walk", "trace", "log", "debug", "inspect", "spin", "center", "search",
}

# Strings that immediately disqualify a paragraph
DISQUALIFY_PATTERNS = [
    re.compile(r"^[A-Z0-9_]+=", re.M),                              # env-var lines
    re.compile(r"\bsk-(proj|live|ant)-[A-Za-z0-9_-]{20,}"),         # OpenAI / Stripe keys
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),                     # Anthropic keys
    re.compile(r"^https?://\S+\s*$", re.M),                         # bare URLs
    re.compile(r"^[A-Za-z0-9+/=]{40,}\s*$", re.M),                  # base64 blobs
    re.compile(r"^[A-Za-z0-9_\-]{30,}\s*$"),                        # opaque tokens
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"),                        # Google API
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),                          # GitHub PAT
    re.compile(r"projects?/\d{6,}"),                                # GCP project ID
]

# Strings that indicate boilerplate metadata, not a prompt
METADATA_HINTS = [
    "API Key", "ChatGPT secret", "Trio secret", "Resource group",
    "Status", "Project number", "Project name", "Region",
]


def looks_like_prompt(block: str) -> bool:
    """Return True if this paragraph looks like a real prompt worth keeping."""
    text = block.strip()
    if len(text) < 30:
        return False
    if len(text) > 4000:
        return False
    # Disqualify if any secret/url-only pattern hits
    for pat in DISQUALIFY_PATTERNS:
        if pat.search(text):
            return False
    # Disqualify if it's just dashes / ASCII banner
    if re.match(r"^[=\-*#_~]{6,}\s*$", text):
        return False
    # Disqualify metadata blocks (short label lines)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) <= 4 and all(len(ln) < 40 for ln in lines):
        return False
    # Disqualify if more than half the lines look like metadata
    meta_hits = sum(1 for ln in lines if any(h in ln for h in METADATA_HINTS))
    if meta_hits >= max(1, len(lines) // 2):
        return False
    # Must contain SOME prose word — at least one imperative verb OR
    # a sentence-ending ? / .
    lowered = text.lower()
    has_verb = any(f" {v} " in f" {lowered} " or lowered.startswith(v + " ") for v in IMPERATIVE_VERBS)
    has_sentence = "?" in text or "." in text
    if not (has_verb or has_sentence):
        return False
    return True


def score(block: str) -> int:
    text = block.strip()
    s = 0
    s += min(len(text), 800) // 10            # length bonus, capped
    s += sum(2 for v in IMPERATIVE_VERBS if f" {v} " in f" {text.lower()} ")
    s += text.count("?") * 3                  # questions are great prompts
    s += text.count(",") * 1                  # punctuation = real prose
    if text[:1].isupper(): s += 4              # starts capitalised
    if "buddy" in text.lower(): s += 6         # the user's signature voice
    return s


def main() -> int:
    if not SRC.is_file():
        print(f"missing: {SRC}")
        return 1
    raw = SRC.read_text(encoding="utf-8", errors="replace")
    # Split on blank lines (one or more consecutive empty lines)
    blocks = re.split(r"\n\s*\n+", raw)
    candidates: list[tuple[int, str]] = []
    seen: set[str] = set()
    for b in blocks:
        b = b.strip()
        if not b:
            continue
        if not looks_like_prompt(b):
            continue
        # Dedupe by the first 80 chars normalized (catches near-duplicates from
        # the user copying the same prompt twice with whitespace differences).
        key = re.sub(r"\s+", " ", b[:80].lower())
        if key in seen:
            continue
        seen.add(key)
        candidates.append((score(b), b))
    # Sort by descending score
    candidates.sort(key=lambda p: -p[0])
    # Cap at the top 80 (more than that is noise for a curated list)
    top = candidates[:80]
    DST.parent.mkdir(parents=True, exist_ok=True)
    body_parts = [
        "# Curated prompts — extracted from log.txt by tools/extract_prompts_from_log.py.",
        "# Top-scored, deduped, secret-stripped. One prompt per blank-line block.",
        f"# Source: {SRC} ({SRC.stat().st_size} bytes)",
        f"# Kept: {len(top)} of {len(candidates)} candidates",
        "",
    ]
    for _, text in top:
        body_parts.append(text)
        body_parts.append("")
    DST.write_text("\n".join(body_parts), encoding="utf-8")
    print(f"WROTE {DST}")
    print(f"  candidates_passing_filter = {len(candidates)}")
    print(f"  kept_top                  = {len(top)}")
    if top:
        print(f"  highest_score             = {top[0][0]}")
        print(f"  preview                   = {top[0][1][:100]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
