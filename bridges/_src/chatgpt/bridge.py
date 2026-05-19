"""ChatGPT bridge — drives chatgpt.com via DOM selectors.

Everything declared in this file is OPTIONAL except `SPEC`. The bridge
runner (tools/bridge_runner.py) implements the universal chat round-trip
loop and only calls into the optional hooks when they're defined.

The 90% case: declare SELECTORS + LOGIN_STRATEGY and you're done. The
runner does login + type + submit + scrape + return on its own.

Override hooks (in increasing order of how-much-you-want-to-rewrite):
    custom_isLoggedIn(mini)              -> bool
    custom_login(mini, email, password)  -> {ok, error?}
    custom_sendChat(mini, message)       -> {ok, answer, error?}
    custom_driveChat(mini, message,
                     email, password)    -> {ok, answer, error?}

If you need to override more than custom_driveChat, you probably shouldn't
be using the runner — just write a standalone bridge.
"""
from __future__ import annotations

SPEC = {
    "name": "chatgpt",
    "kind": "web",  # web | api
    # Declared capabilities — the bridge_runner only wires features the
    # bridge declares it supports. Missing capability == feature is
    # silently no-op for this bridge.
    "capabilities": {
        "chat":         True,   # basic text round-trip (every bridge has this)
        "file_send":    True,   # client can upload files to the chat (image, PDF, etc.)
        "file_receive": True,   # bridge can extract files the assistant emits (images, code blocks as files, attachments)
        "tool_calls":   True,   # supports server-side function/tool invocation pattern
        "streaming":    True,   # reply text streams; runner exposes incremental updates to caller
        "vision":       True,   # accepts image inputs in the chat (uses SELECTORS.file_input)
        "memory":       True,   # site has persistent conversations across runs (history is auto-preserved)
    },
}

# DOM selectors used by the bridge_runner's universal driver. Order
# matters — the first selector that matches a visible (>2px) element
# wins. Lists allow graceful fallbacks as the site rotates its DOM.
SELECTORS = {
    "composer": [
        "#prompt-textarea",
        'div#prompt-textarea[contenteditable="true"]',
        'textarea#prompt-textarea',
    ],
    "send_button": [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label*="Send"]',
        'button#composer-submit-button',
    ],
    "logged_in_check": "#prompt-textarea",   # if this exists + visible => logged in
    "login_email":    'input[name="email"], input[type="email"]',
    "login_password": 'input[name="password"], input[type="password"]',
    "login_submit":   'button[type="submit"]',
    "assistant_msg":  '[data-message-author-role="assistant"]',
    "file_input":     'input[type="file"]',  # for image-paste use cases
}

# Human-readable login flow description — passed verbatim to the vision
# pilot if a chrome session loses cookies. The fast-path bridge_runner
# doesn't need this (it uses SELECTORS), but the fallback vision pilot
# reads it as part of its goal prompt.
LOGIN_STRATEGY = (
    "ChatGPT — LOG IN FIRST. Anonymous chatgpt.com has aggressive rate "
    "limits AND won't let you chat past 1-2 messages. Click 'Log in' "
    "(top right), enter the email, click Continue, enter the password, "
    "click Continue. Use native OpenAI email login — do NOT route "
    "through Google/Microsoft/Apple. Only START chatting once the login "
    "completes and the composer appears on a logged-in surface."
)

# Tool-call protocol. CBE uses a TEXT-based tool-call convention: the
# bridge teaches the model to wrap shell commands in fenced code blocks
# tagged with `# !exec`, then the bridge parses those blocks out of the
# reply, runs them locally, and pastes the stdout/stderr back as the
# next user turn. This works on ANY model (no native function-calling
# API required) — it just needs the model to follow the convention.
#
# Sent ONCE at the start of a new conversation. The runner caches that
# this conversation has had the priming prompt and skips it on later
# turns. If you set TOOL_CALL_PRIMER to None, the bridge runner treats
# tool_calls capability as not really supported and skips the # !exec
# parse loop for this bridge.
TOOL_CALL_PRIMER = (
    "You have shell tool-call capability via a simple convention: whenever "
    "you want to run a command on the user's machine, emit a fenced code "
    "block tagged with `# !exec` on its own line at the top:\n"
    "\n"
    "```bash\n"
    "# !exec\n"
    "<your command here>\n"
    "```\n"
    "\n"
    "Languages supported: bash, powershell, python. The bridge runs the "
    "command, captures stdout+stderr+exitcode, and sends them back to "
    "you as the next user turn so you can chain. Cap is 8 iterations "
    "per chat. Use it freely — read files, run scripts, edit code. Don't "
    "ask permission for read-only operations; for destructive ones, "
    "explain first then emit the block."
)
