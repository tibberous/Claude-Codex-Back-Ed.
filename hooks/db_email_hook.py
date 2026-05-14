"""
Hook File: db_email_hook.py

What it does:
Basic SMTP form-mail example that sends a consultation request email using
hardcoded placeholders for the mail server.

How to use it:
Treat it as a starter example. Replace the SMTP settings first, then call
send_email_hook with the form fields.

Notes:
This comment block documents the current code in this file. Review
credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : db_email_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# CREDENTIALS
#   API keys, tokens, and remote endpoints live in config.ini at
#   the repo root. Hooks read them via hooks/_config.py. Do NOT
#   hardcode keys in source. Do NOT push config.ini to the server
#   (it is on the auto-update exclude list in extension.js).
#
# SIDE EFFECTS
#   May make outbound network calls, may write to disk under the
#   repo root (logs/, chats/, reports/), may spawn subprocesses,
#   may touch the journaling DB through trio_hook_orm. Inspect
#   the function before running it on production data.
#
# THINGS THIS HOOK WILL NOT DO
#   - It will not reload the VSCode window. Nothing in this repo
#     reloads the window. See handbook.txt Section 8.
#   - It will not push files to the server. Pushing is gated on
#     config.ini [updates] is_admin=true and is handled by the
#     extension, not by individual hooks. See handbook.txt §17.
#   - It will not silently swallow errors. If it fails it raises
#     or returns a structured error; check the trace channel.
#
# RELATED HANDBOOK SECTIONS
#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library
#   §22 Trace channel   §24 Troubleshooting
#
# === LLM-USAGE: END ===
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def send_email_hook(name, email, phone, subject, message, consent_contact):
    if not (name and email and consent_contact):
        return 'Validation failed'
    smtp_server = 'your_smtp_server'
    smtp_port = 587
    smtp_username = 'your_email@example.com'
    smtp_password = 'your_email_password'
    msg = MIMEMultipart()
    msg['From'] = smtp_username
    msg['To'] = email
    msg['Subject'] = subject or 'New Consultation Request'
    body = (
        f"Name: {name}\n"
        f"Email: {email}\n"
        f"Phone: {phone}\n"
        f"Message: {message}"
    )
    msg.attach(MIMEText(body, 'plain'))
    server = smtplib.SMTP(smtp_server, smtp_port)
    server.starttls()
    server.login(smtp_username, smtp_password)
    server.sendmail(smtp_username, [email], msg.as_string())
    server.quit()
    return 'Email sent successfully'
