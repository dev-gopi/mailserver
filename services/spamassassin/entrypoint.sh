#!/bin/bash
# set -e

# # Start cron in the background
# service cron start

# # Ensure permissions
# chown -R spamd:spamd /var/lib/spamassassin/.spamassassin || true

# # Start spamd in foreground
# exec spamd -c -m5 --nouser-config --syslog-socket=none \
#   --listen=0.0.0.0 --allowed-ips=172.16.0.0/12 --port=783 \
#   --pidfile=/var/run/spamd.pid --username spamd \
#   --helper-home-dir /home/spamd/ -s /home/spamd/spamd.log

set -e

echo "[INIT] Starting container services..."

# 1. Start cron
echo "[INIT] Starting cron..."
service cron start

# 2. Update ClamAV signatures (freshclam)
echo "[INIT] Updating ClamAV database..."
# freshclam || true

# 3. Start ClamAV daemon
echo "[INIT] Starting ClamAV (clamd)..."
# clamd &

# Wait a bit to ensure clamd starts
# sleep 3

# 4. Fix permissions for SpamAssassin Bayes DB (if exists)
DBPATH=/var/lib/spamassassin/.spamassassin
if [ -d "$DBPATH" ]; then
  echo "[INIT] Fixing permissions on $DBPATH"
  chown -R spamd:spamd "$DBPATH" || true
fi

# 5. Start spamd (SpamAssassin daemon)
echo "[INIT] Starting SpamAssassin (spamd)..."
exec spamd -c -m5 --nouser-config --syslog-socket=none \
  --listen=0.0.0.0 --allowed-ips=172.16.0.0/12 --port=783 \
  --pidfile=/var/run/spamd.pid --username spamd \
  --helper-home-dir /home/spamd/ -s /home/spamd/spamd.log