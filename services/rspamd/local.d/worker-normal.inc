# HTTP /checkv2 is reachable only on scanadminnet (not published to the host).
bind_socket = "172.32.0.2:11333";

# TCP clients must never cause Rspamd to open arbitrary local paths or shared memory.
allow_file_and_shm_inputs = false;
