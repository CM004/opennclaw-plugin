import smtplib
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv
from pathlib import Path

# Load .env from project root regardless of where this file is called from
load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

def send_email(recipient: str, subject: str, body: str) -> dict:
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")
    sender    = os.environ.get("EMAIL_FROM", smtp_user)

    if not smtp_user or not smtp_pass:
        return {
            "success": False,
            "error": "SMTP_USER and SMTP_PASS not set in .env"
        }

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = sender
    msg["To"]      = recipient
    msg.attach(MIMEText(body, "plain"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.ehlo()
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(sender, recipient, msg.as_string())
        return {"success": True, "recipient": recipient}
    except Exception as e:
        return {"success": False, "error": str(e)}
