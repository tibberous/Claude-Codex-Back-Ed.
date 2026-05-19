"""Copilot bridge — copilot.microsoft.com via DOM selectors.

Microsoft account login (separate from Gmail). The bing-video bridge
shares this login since it's the same MS account.
"""

SPEC = {"name": "copilot", "kind": "web"}

SELECTORS = {
    "composer": [
        'cib-text-input textarea#userInput',
        'cib-text-input textarea',
        'textarea#userInput',
        'textarea[aria-label*="message" i]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="ask" i]',
        'textarea[placeholder*="copilot" i]',
    ],
    "send_button": [
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
        'cib-button[aria-label*="Submit"]',
    ],
    "logged_in_check": 'cib-text-input textarea#userInput, textarea[placeholder*="message" i]',
    "login_email":    'input[name="loginfmt"], input[type="email"]',
    "login_password": 'input[name="passwd"], input[type="password"]',
    "login_submit":   'input[type="submit"], button[type="submit"]',
    "assistant_msg":  'cib-message[type="text"][source="bot"], [class*="response"]',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "Copilot needs a Microsoft account. If logged out, navigate to "
    "https://login.live.com/, type the email, Next, type the password, "
    "Next. (Microsoft account — not work/school.) Only start chatting "
    "after you land back on copilot.microsoft.com logged in."
)

TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
