#!/bin/bash
set -e

# Signature downloads must never run at image-build time: the ClamAV CDN can
# throttle builds. The persistent /var/lib/clamav volume keeps databases across restarts.
freshclam || echo "[WARN] ClamAV signatures were not updated; retaining existing database."

# Run clamd in the background, but do not start the SMTP proxy until its
# scanner socket is accepting connections. Starting both at once made
# clamsmtpd exit immediately with "connection refused", causing the restart loop.
clamd -F &
clamd_pid=$!

for _ in $(seq 1 30); do
  if (echo > /dev/tcp/127.0.0.1/3310) 2>/dev/null; then break; fi
  if ! kill -0 "$clamd_pid" 2>/dev/null; then wait "$clamd_pid"; exit $?; fi
  sleep 1
done

if ! (echo > /dev/tcp/127.0.0.1/3310) 2>/dev/null; then
  echo "[ERROR] clamd did not become ready on 127.0.0.1:3310" >&2
  exit 1
fi

# clamsmtpd accepts its configuration file as a positional argument and this
# release accepts only a numeric OutAddress. The postfix container IP can change
# whenever the container is recreated (e.g. after a restart). To avoid ClamSMTP
# forwarding to a stale IP, we use a wrapper loop that re-resolves the hostname
# and re-launches clamsmtpd whenever it exits. This also means a Postfix restart
# does not require a manual clamav container restart.

restart_clamsmtpd() {
  local postfix_ip=""
  for _ in $(seq 1 30); do
    postfix_ip=$(getent ahostsv4 postfix | awk 'NR == 1 { print $1 }')
    [ -n "$postfix_ip" ] && break
    sleep 1
  done
  if [ -z "$postfix_ip" ]; then
    echo "[ERROR] Unable to resolve the postfix service" >&2
    return 1
  fi
  sed "s|postfix:10025|${postfix_ip}:10025|" /etc/clamsmtpd.conf > /tmp/clamsmtpd.conf
  rm -f /var/run/clamsmtpd.pid
  clamsmtpd -f /tmp/clamsmtpd.conf -p /var/run/clamsmtpd.pid
}

restart_clamsmtpd

# Wait for clamsmtpd to write its PID file and confirm it is running.
for _ in $(seq 1 10); do
  if [ -s /var/run/clamsmtpd.pid ] && kill -0 "$(cat /var/run/clamsmtpd.pid)" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ ! -s /var/run/clamsmtpd.pid ] || ! kill -0 "$(cat /var/run/clamsmtpd.pid)" 2>/dev/null; then
  echo "[ERROR] clamsmtpd did not become ready" >&2
  exit 1
fi

while kill -0 "$clamd_pid" 2>/dev/null; do
  if ! kill -0 "$(cat /var/run/clamsmtpd.pid 2>/dev/null)" 2>/dev/null; then
    echo "[WARN] clamsmtpd stopped; re-resolving postfix IP and restarting..." >&2
    restart_clamsmtpd || exit 1
  fi
  sleep 2
done
wait "$clamd_pid"
