bind_socket = "0.0.0.0:11332";
milter = yes;
# Antivirus rules return reject; ask Postfix to place those messages on HOLD
# instead of sending a rejection to the SMTP client.
quarantine_on_reject = true;
timeout = 120s;

upstream "local" {
  self_scan = true;
}
