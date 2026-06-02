#!/usr/bin/env python
"""_redraw_lineart_icons.py — back up + redraw toolbar SVGs as 1.5px line-art.

Target: the ~28 toolbar icons referenced from `panel/index.html` lines
1697-1820. Trent (2026-05-26) wants the toolbar to read more like the
official Anthropic Claude Code extension — minimal, single-color (currentColor),
no fills, 1.5px stroke, rounded caps/joins. Lucide / Heroicons / Feather
Icons aesthetic.

Behavior:
  * Back up each ORIGINAL svg to assets/_pre_lineart_backup_2026-05-26/<name>.svg
    before overwriting.
  * Write a clean 24×24 viewBox SVG with the standard line-art header in place.
  * Skip icons that are already clean line-art (LEAVE_ALONE list).

Run once. Idempotent re-runs are safe because the backups won't be
overwritten if they already exist (we never restore from the live file
once it's been replaced).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
ASSETS_DIR = ROOT / "assets"
BACKUP_DIR = ASSETS_DIR / "_pre_lineart_backup_2026-05-26"

LEAVE_ALONE = {
    "attach_file.svg",
    "compact.svg",
    "email.svg",
    "browser.svg",
    "terminal.svg",
    "setup.svg",
    "domain.svg",
    "help.svg",
}

# Standard line-art header for every redrawn icon. 24×24 viewBox,
# stroke="currentColor", stroke-width="1.5", fill="none", round caps + joins.
HEADER = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
    'fill="none" stroke="currentColor" stroke-width="1.5" '
    'stroke-linecap="round" stroke-linejoin="round" aria-label="{label}">'
)
FOOTER = "</svg>\n"


def build(label: str, body: str) -> str:
    return HEADER.format(label=label) + "\n" + body.rstrip() + "\n" + FOOTER


# Lucide-inspired minimalist redraws. Each body string is the inner SVG
# elements only; the header + footer are added by build(). Keep stroke
# attributes off elements (they inherit from the root <svg>).

REDRAWS: dict[str, tuple[str, str]] = {
    # add — "+" plus sign (Lucide `plus`)
    "add.svg": (
        "Add",
        '<line x1="12" y1="5" x2="12" y2="19"/>'
        '<line x1="5" y1="12" x2="19" y2="12"/>',
    ),

    # stored_prompts — bookmark + lines (Lucide `bookmark` over text-rows)
    "stored_prompts.svg": (
        "Stored prompts",
        '<path d="M6 3h12v18l-6-4-6 4z"/>'
        '<line x1="9" y1="8" x2="15" y2="8"/>'
        '<line x1="9" y1="12" x2="15" y2="12"/>',
    ),

    # chat_history — speech bubble with a clock dial inside (simpler)
    "chat_history.svg": (
        "Chat history",
        # Speech bubble outline
        '<path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12z"/>'
        # Clock hands
        '<line x1="12" y1="9.5" x2="12" y2="12"/>'
        '<line x1="12" y1="12" x2="14" y2="13"/>',
    ),

    # attach_file — already line-art (skipped — kept for reference)

    # tts — speaker + 2 sound waves (Lucide `volume-2`)
    "tts.svg": (
        "Read aloud",
        '<path d="M11 5 6 9H3v6h3l5 4z"/>'
        '<path d="M15.5 8.5a5 5 0 0 1 0 7"/>'
        '<path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    ),

    # stt — microphone (Lucide `mic`)
    "stt.svg": (
        "Speech to text",
        '<rect x="9" y="3" width="6" height="11" rx="3"/>'
        '<path d="M5 11a7 7 0 0 0 14 0"/>'
        '<line x1="12" y1="18" x2="12" y2="21"/>'
        '<line x1="9" y1="21" x2="15" y2="21"/>',
    ),

    # auto_reply — bubble with lightning (matches purpose; Heroicons-ish)
    "auto_reply.svg": (
        "Auto reply",
        '<path d="M21 11.5a8 8 0 0 1-11.3 7.3L4 20l1.3-5.7A8 8 0 1 1 21 11.5z"/>'
        # Lightning bolt inside
        '<path d="M13 7l-3 5h2.5L11 16l3-5h-2.5z"/>',
    ),

    # wake_up — alarm clock (Lucide `alarm-clock`)
    "wake_up.svg": (
        "Wake up",
        '<circle cx="12" cy="13" r="7"/>'
        '<line x1="12" y1="10" x2="12" y2="13"/>'
        '<line x1="12" y1="13" x2="14.5" y2="14.5"/>'
        # Bells
        '<path d="M4 6l3-3"/>'
        '<path d="M20 6l-3-3"/>',
    ),

    # show_command_menu — chevron + slash (Lucide-ish terminal/command)
    "show_command_menu.svg": (
        "Show command menu",
        '<path d="M4 7h2"/>'
        '<path d="M4 12h2"/>'
        '<path d="M4 17h2"/>'
        '<line x1="9" y1="7" x2="20" y2="7"/>'
        '<line x1="9" y1="12" x2="20" y2="12"/>'
        '<line x1="9" y1="17" x2="20" y2="17"/>',
    ),

    # compact — already line-art (skipped — kept for reference)

    # handbook — open book (Lucide `book-open`)
    "handbook.svg": (
        "Handbook",
        '<path d="M3 5.5C5.5 4.3 8.5 4.3 11 5.5V20c-2.5-1.2-5.5-1.2-8 0z"/>'
        '<path d="M21 5.5C18.5 4.3 15.5 4.3 13 5.5V20c2.5-1.2 5.5-1.2 8 0z"/>',
    ),

    # settings — gear with center circle (Lucide `settings`, simplified)
    "settings.svg": (
        "Settings",
        # 8-toothed gear outline. Approximation of Lucide's settings shape.
        '<path d="M12 3.5l1 2.2a7.5 7.5 0 0 1 2 .8l2.2-.8 1.6 1.6-.8 2.2'
        ' c.4.6.6 1.3.8 2l2.2 1V14l-2.2 1c-.2.7-.4 1.4-.8 2l.8 2.2-1.6 1.6'
        '-2.2-.8a7.5 7.5 0 0 1-2 .8l-1 2.2h-2l-1-2.2a7.5 7.5 0 0 1-2-.8'
        'l-2.2.8-1.6-1.6.8-2.2c-.4-.6-.6-1.3-.8-2L1 14v-2.6l2.2-1'
        'c.2-.7.4-1.4.8-2L3.2 6.2 4.8 4.6l2.2.8a7.5 7.5 0 0 1 2-.8l1-2.2z"/>'
        '<circle cx="12" cy="12" r="3"/>',
    ),

    # accounts — user (Lucide `user`)
    "accounts.svg": (
        "Accounts",
        '<circle cx="12" cy="8" r="4"/>'
        '<path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    ),

    # extensions — puzzle piece outline (Lucide `puzzle`)
    "extensions.svg": (
        "Extensions",
        '<path d="M9 3.5a2 2 0 1 1 4 0V5h4a1 1 0 0 1 1 1v4h1.5a2 2 0 1 1 0 4H18v4'
        ' a1 1 0 0 1-1 1h-4v-1.5a2 2 0 1 0-4 0V19H5a1 1 0 0 1-1-1v-4H2.5'
        ' a2 2 0 1 1 0-4H4V6a1 1 0 0 1 1-1h4z"/>',
    ),

    # email — already line-art (skipped)

    # project_folder — folder with code brackets inside (Lucide-ish)
    "project_folder.svg": (
        "Project folder",
        '<path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2H19.5A1.5 1.5 0 0 1 21 9v9'
        ' a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>'
        # </>
        '<polyline points="10.5 12 8.5 14 10.5 16"/>'
        '<polyline points="13.5 12 15.5 14 13.5 16"/>',
    ),

    # browser — already line-art (skipped)

    # vscode_monitor — monitor + heartbeat line
    "vscode_monitor.svg": (
        "VSCode monitor",
        '<rect x="3" y="4" width="18" height="12" rx="1.5"/>'
        # Heartbeat
        '<path d="M6 11h2.5l1.5-3 2 6 1.5-3H18"/>'
        # Stand
        '<line x1="9" y1="20" x2="15" y2="20"/>'
        '<line x1="12" y1="16" x2="12" y2="20"/>',
    ),

    # terminal — already line-art (skipped)

    # setup — already line-art (skipped)

    # git — branch graph (Lucide `git-branch`)
    "git.svg": (
        "Git",
        '<line x1="6" y1="3" x2="6" y2="15"/>'
        '<circle cx="6" cy="18" r="2.25"/>'
        '<circle cx="6" cy="5.25" r="2.25"/>'
        '<circle cx="18" cy="7" r="2.25"/>'
        '<path d="M18 9.25v.75a4 4 0 0 1-4 4H10a4 4 0 0 0-4 4"/>',
    ),

    # github — minimalist octocat (outline-only, Feather-ish)
    "github.svg": (
        "GitHub",
        # Body — single contiguous outline derived from Feather Icons.
        '<path d="M9 19c-4 1.3-4-2-6-2.5M15 22v-3.5a3 3 0 0 0-.8-2.3c2.8-.3 5.5-1.4'
        ' 5.5-6.1a4.7 4.7 0 0 0-1.3-3.3 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3'
        ' a11.6 11.6 0 0 0-6 0C6.5 2.2 5.5 2.5 5.5 2.5a4.4 4.4 0 0 0-.1 3.3'
        ' 4.7 4.7 0 0 0-1.3 3.3c0 4.7 2.7 5.8 5.5 6.1a3 3 0 0 0-.8 2.3V22"/>',
    ),

    # domain — already line-art (skipped)

    # font_size — large A + small A (Lucide `case-sensitive`-ish)
    "font_size.svg": (
        "Font size",
        # Big A
        '<path d="M3 18 8 5l5 13"/>'
        '<line x1="5" y1="14" x2="11" y2="14"/>'
        # Small a
        '<path d="M15.5 18 18 12l2.5 6"/>'
        '<line x1="16.5" y1="16" x2="19.5" y2="16"/>',
    ),

    # help — already line-art (skipped)

    # tamagotchi — egg silhouette with screen + buttons (line-art)
    "tamagotchi.svg": (
        "Tamagotchi",
        # Egg outline
        '<path d="M12 2.5c5 0 8 6 8 11 0 4.5-3.5 8-8 8s-8-3.5-8-8c0-5 3-11 8-11z"/>'
        # Inner screen
        '<rect x="7" y="6.5" width="10" height="7" rx="1.2"/>'
        # 3 buttons
        '<circle cx="9.5" cy="17.5" r="1"/>'
        '<circle cx="12" cy="17.5" r="1"/>'
        '<circle cx="14.5" cy="17.5" r="1"/>',
    ),
}


def main() -> int:
    if not ASSETS_DIR.exists():
        print(f"missing {ASSETS_DIR}", file=sys.stderr)
        return 1
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    redrawn: list[str] = []
    skipped: list[str] = []
    missing: list[str] = []
    backed_up: list[str] = []

    for name, (label, body) in REDRAWS.items():
        src = ASSETS_DIR / name
        if not src.exists():
            missing.append(name)
            continue
        if name in LEAVE_ALONE:
            # Should never happen — LEAVE_ALONE names are not in REDRAWS,
            # but be defensive.
            skipped.append(name)
            continue
        # Back up original (preserve first run; do not clobber an earlier
        # backup with a redrawn version on idempotent re-run).
        bak = BACKUP_DIR / name
        if not bak.exists():
            bak.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            backed_up.append(name)
        # Redraw
        src.write_text(build(label, body), encoding="utf-8")
        redrawn.append(name)

    for name in LEAVE_ALONE:
        src = ASSETS_DIR / name
        if src.exists():
            skipped.append(name)
        else:
            missing.append(name)

    print(f"Redrawn:  {len(redrawn)}")
    for n in redrawn:
        print(f"  {n}")
    print(f"Backed up: {len(backed_up)} (first-time backups)")
    print(f"Skipped (already line-art): {len(skipped)}")
    for n in skipped:
        print(f"  {n}")
    if missing:
        print(f"Missing source files: {len(missing)}", file=sys.stderr)
        for n in missing:
            print(f"  {n}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
