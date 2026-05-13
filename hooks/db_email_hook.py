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
