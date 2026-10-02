"""Send a test email using the SMTP settings in .env.

Usage: python test_email.py someone@example.com
"""
import sys
import app as appmod

if len(sys.argv) != 2:
    sys.exit("Usage: python test_email.py recipient@example.com")
if not appmod.smtp_configured():
    sys.exit("SMTP isn't configured: set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env")

msg = appmod._make_message(sys.argv[1], "Attendance portal test email",
                           "If you're reading this, your SMTP settings work.\n")
print(f"Sent {appmod.send_emails([msg])} email(s) from: {msg['From']}")