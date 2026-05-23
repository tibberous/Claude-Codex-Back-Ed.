"""imap_verifier.py — REGISTERING email verification.

Per whitepaper §4.1 / §8 — when GPT-4o calls `read_verification_email(addr)`
during the COLD -> REGISTERING signup flow, this module polls the user's
Gmail inbox via `hooks/gmail_api_hook.py` for up to 90 seconds, scans new
messages for a verification URL matching the provider's domain, and returns
it. Bridge then navigates to that URL and the signup continues.

v1 SCAFFOLD STATUS:
    - Function signature matches what openai_tools.read_verification_email
      will call.
    - Returns {"ok": False, "reason": "not implemented"} for now.
    - Next agent wires `hooks/gmail_api_hook.py` once REGISTERING is actually
      driven by the OpenAI tool dispatcher.
"""

from __future__ import annotations

import re
import time
from typing import Optional


# Common verification-link patterns. Most providers use one of these.
_VERIFY_URL_PATTERNS = [
    re.compile(r"https?://\S*?verif\S*", re.IGNORECASE),
    re.compile(r"https?://\S*?confirm\S*", re.IGNORECASE),
    re.compile(r"https?://\S*?activate\S*", re.IGNORECASE),
    re.compile(r"https?://\S*?token=\S+", re.IGNORECASE),
]


def readVerificationEmail(
    address: str,
    *,
    timeout_seconds: int = 90,
    expected_sender_domain: Optional[str] = None,
    expected_url_domain: Optional[str] = None,
) -> dict:
    """Poll IMAP / Gmail API for a verification link to `address`.

    Args:
        address: the inbox we wrote into config.ini during REGISTERING.
        timeout_seconds: how long to block waiting for the email.
        expected_sender_domain: e.g. "openai.com" — only consider mail from
            this domain when extracting the link.
        expected_url_domain: e.g. "chatgpt.com" — only return links pointing
            here, even if multiple show up.

    Returns:
        {"ok": True,  "url": "https://...verify..."}  on success
        {"ok": False, "reason": "..."}                on timeout / failure

    v1 SCAFFOLD: returns not-implemented. Next agent wires gmail_api_hook.
    """
    _ = (address, timeout_seconds, expected_sender_domain, expected_url_domain)
    return {
        "ok":     False,
        "reason": "imap_verifier.readVerificationEmail not implemented in v1 scaffold "
                  "(wire hooks/gmail_api_hook.py in next pass — see "
                  "docs/BRIDGE_WHITEPAPER.md §4.1 + §8)",
    }


def _extractVerificationUrl(body_text: str, expected_url_domain: Optional[str]) -> Optional[str]:
    """Future helper — pull the first verification-looking URL out of an email
    body. Filters by expected_url_domain if given. Not called in v1."""
    if not body_text:
        return None
    for pattern in _VERIFY_URL_PATTERNS:
        for match in pattern.finditer(body_text):
            url = match.group(0).rstrip(").,;'\"")
            if expected_url_domain and expected_url_domain.lower() not in url.lower():
                continue
            return url
    return None


def _sleepUntil(deadline: float, step: float = 2.0) -> bool:
    """Sleep in `step` chunks until deadline. Returns True if deadline reached."""
    while time.time() < deadline:
        time.sleep(min(step, max(0.0, deadline - time.time())))
    return True
