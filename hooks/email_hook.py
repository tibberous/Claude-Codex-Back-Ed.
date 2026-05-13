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
