bind_socket = "172.30.0.2:11332";
milter = yes;
# Ask Postfix to HOLD messages rejected by the Rspamd milter. This preserves
# high-confidence spam/malware evidence for audited administrator review.
quarantine_on_reject = true;
timeout = 120s;

upstream "local" {
  self_scan = true;
}

# Postfix needs only the Milter protocol; disable file/SHM message inputs.
allow_file_and_shm_inputs = false;
