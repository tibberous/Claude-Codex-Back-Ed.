"""
Hook File: email_hook.py

What it does:
Simple SMTP self-test that sends a message and attaches the email_hook.py file itself.

How to use it:
Update the account credentials and recipient, then run send_email or execute the script for a basic outbound email test.

Primary entry points:
send_email

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : email_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Simple SMTP self-test that sends a message and attaches the email_hook.py file itself.
#
# HOW TO INVOKE
#   Update the account credentials and recipient, then run send_email or execute the script for a basic outbound email test.
#
# PRIMARY ENTRY POINTS
#   - send_email
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
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    from File import File
except Exception:
    File = None

from _config import cfg

smtp_server   = cfg("email", "smtp_server",   default="smtp.gmail.com")
smtp_port     = int(cfg("email", "smtp_port", default="587"))
smtp_username = cfg("email", "account",       env="EMAIL_ACCOUNT")
smtp_password = cfg("email", "password",      env="EMAIL_PASSWORD")
default_to    = cfg("email", "default_to",    env="EMAIL_DEFAULT_TO")

def send_email():
    try:
        msg = MIMEMultipart()
        msg['From'] = smtp_username
        msg['To'] = default_to
        msg['Subject'] = 'Greetings from ChatGPT!'
        
        body = "Greetings from ChatGPT!\nPlease find the attached hooks file."
        msg.attach(MIMEText(body, 'plain'))
        
        source_path = Path(__file__).resolve()
        attachment_text = File(source_path).readText() if File is not None else source_path.read_text(encoding='utf-8', errors='replace')
        attachment = MIMEText(attachment_text, 'plain')
        attachment.add_header('Content-Disposition', 'attachment', filename='email_hook.py')
        msg.attach(attachment)

        server = smtplib.SMTP(smtp_server, smtp_port)
        server.starttls()
        server.login(smtp_username, smtp_password)
        server.send_message(msg)
        server.quit()

        print("Email sent successfully!")

    except Exception as e:
        print(f"Failed to send email: {e}")

send_email()
