require ["fileinto"];

# Deliver spam directly to the IMAP Junk mailbox instead of INBOX.
if anyof (
  header :contains "X-Spam-Flag" "YES",
  header :contains "X-Spam-Status" "Yes"
) {
  fileinto "Junk";
  stop;
}
