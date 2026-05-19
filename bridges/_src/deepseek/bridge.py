"""DeepSeek bridge — chat.deepseek.com via DOM selectors.

DeepSeek has a native email+password login form right on the sign_in
page. AVOID Google SSO — it triggers Google's CAPTCHA path which
GPT-4o-vision can't reliably solve.
"""

SPEC = {"name": "deepseek", "kind": "web"}

SELECTORS = {
    "composer": [
        'textarea[placeholder*="Message" i]',
        'textarea[placeholder*="Send a message" i]',
        'form textarea',
    ],
    "send_button": [
        'button[aria-label*="Send" i]',
        'form button[type="submit"]',
        'div[class*="ds-button"][role="button"]',
    ],
    "logged_in_check": 'textarea[placeholder*="Message" i], form textarea',
    "login_email":    'input[type="email"], input[type="text"][placeholder*="mail" i]',
    "login_password": 'input[type="password"]',
    "login_submit":   'div[class*="ds-button"], button[type="submit"]',
    "assistant_msg":  '[class*="message"][class*="assistant"], [class*="response"]',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "DeepSeek has native email+password login. The login form shows "
    "email and password fields directly on chat.deepseek.com/sign_in. "
    "Type the email, type the password, click the Sign in / Log in "
    "button. Do NOT click 'Continue with Google' — that triggers "
    "Google's CAPTCHA."
)

TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
