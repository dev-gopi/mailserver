require ["fileinto"];

# SpamAssassin adds this header when the message score reaches required_score.
# Deliver it directly to the IMAP Junk mailbox instead of INBOX.
if header :contains "X-Spam-Flag" "YES" {
  fileinto "Junk";
  stop;
}
