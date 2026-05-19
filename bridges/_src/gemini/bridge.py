"""Gemini bridge — gemini.google.com/app via DOM selectors.

Composer is a Quill ProseMirror contenteditable. Login is Google SSO —
navigate to accounts.google.com in the SAME tab and the session
carries over once the user comes back to /app.
"""

SPEC = {"name": "gemini", "kind": "web"}

SELECTORS = {
    "composer": [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        '.ql-editor[contenteditable="true"]',
    ],
    "send_button": [
        'button[aria-label*="Send" i]',
        'button.send-button',
        'button[mat-icon-button][aria-label*="Send"]',
    ],
    "logged_in_check": 'rich-textarea .ql-editor[contenteditable="true"]',
    "login_email":    'input[type="email"]',
    "login_password": 'input[type="password"]',
    "login_submit":   '#identifierNext button, #passwordNext button, button[type="submit"]',
    "assistant_msg":  'model-response, .model-response-text',
    "file_input":     'input[type="file"]',
}

LOGIN_STRATEGY = (
    "Gemini needs a Google account. If the page isn't already logged "
    "in, navigate to https://accounts.google.com/signin in the SAME "
    "tab, type the email, Next, type the password, Next. Then navigate "
    "back to https://gemini.google.com/app — it will pick up the "
    "active Google session. If Google demands a CAPTCHA, solve it via "
    "the image-grid vision path."
)

TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via this convention: wrap "
    "commands in fenced code tagged with `# !exec`:\n\n"
    "```bash\n# !exec\nls -la\n```\n\n"
    "Languages: bash, powershell, python. The bridge runs the command, "
    "feeds back stdout/stderr/rc, you continue. Cap 8 iterations/chat."
)
