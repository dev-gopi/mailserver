# Antivirus scanning permits a retry and can require up to 22 seconds.
# Keep the global task lifetime above that bound so messages are not cut off
# before the mandatory ClamAV check completes.
task_timeout = 30s;
