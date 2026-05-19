"""Grok bridge — grok.com via DOM selectors."""

SPEC = {"name": "grok", "kind": "web"}

SELECTORS = {
    "composer": [
        'textarea[aria-label*="Ask" i]',
        'textarea[placeholder*="Ask" i]',
        'form textarea',
        'div[contenteditable="true"][role="textbox"]',
    ],
    "send_button": [
        'button[aria-label*="Submit" i]',
        'form button[type="submit"]',
        'button[data-testid="send"]',
    ],
    "logged_in_check": 'textarea[aria-label*="Ask" i], form textarea',
    "login_email":    'input[type="email"], input[name="email"]',
    "login_password": 'input[type="password"], input[name="password"]',
    "login_submit":   'button[type="submit"]',
    "assistant_msg":  '[data-testid*="message-content"], [class*="prose"]',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "Grok — LOG IN FIRST. Anonymous grok.com gates after a couple of "
    "messages with 'Sign up to keep chatting'. Click 'Sign in' (top "
    "right), use the native xAI/X email+password flow — type email, "
    "Continue, type password, Continue. Do NOT use Google SSO. Only "
    "start chatting after the login completes."
)

TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
