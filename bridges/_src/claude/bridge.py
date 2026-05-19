"""Claude bridge — claude.ai via DOM selectors.

claude.ai uses ProseMirror for the composer and is magic-link OR Google
SSO for login (no native password field). The bridge's default login
flow can't complete the magic-link path autonomously — if logged out,
custom_login surfaces a clear 'run sign_in_helper.py claude once' error.
"""

SPEC = {"name": "claude", "kind": "web"}

SELECTORS = {
    "composer": [
        'div.ProseMirror[contenteditable="true"]',
        '[data-testid="chat-input"] .ProseMirror',
        'fieldset div.ProseMirror[contenteditable="true"]',
    ],
    "send_button": [
        'button[aria-label="Send Message"]',
        'button[aria-label*="Send"]',
    ],
    "logged_in_check": 'div.ProseMirror[contenteditable="true"]',
    "login_email":    'input[name="email"], input[type="email"]',
    "login_password": 'input[name="password"], input[type="password"]',
    "login_submit":   'button[type="submit"]',
    "assistant_msg":  '[data-testid="assistant-message"], div[class*="font-claude-message"]',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "Claude is magic-link OR Google-SSO login (no native password). "
    "Click 'Continue with email', type the email, click Continue. If a "
    "password field appears, type the password. If only the magic-link "
    "path is offered and you can't reach the inbox, emit fail() — the "
    "operator will sign in manually once via "
    "`python tools/sign_in_helper.py claude`. Once cookies are banked "
    "the bridge skips the login wall on every subsequent run."
)


def custom_login(mini, email: str, password: str) -> dict:
    """Magic-link can't be auto-solved without inbox API. Bail with a
    clear pointer to sign_in_helper.py instead of looping a doomed
    login attempt."""
    return {
        "ok": False,
        "error": "Claude requires one-time manual sign-in (magic-link). "
                 "Run `python tools/sign_in_helper.py claude` once — "
                 "cookies persist after.",
    }


TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
