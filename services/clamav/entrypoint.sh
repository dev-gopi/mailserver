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
# release accepts only a numeric OutAddress. Resolve Docker's postfix service
# name at startup so network recreation does not leave a stale IP in config.
postfix_ip=""
for _ in $(seq 1 30); do
  postfix_ip=$(getent ahostsv4 postfix | awk 'NR == 1 { print $1 }')
  [ -n "$postfix_ip" ] && break
  sleep 1
done
if [ -z "$postfix_ip" ]; then
  echo "[ERROR] Unable to resolve the postfix service" >&2
  exit 1
fi
sed "s|postfix:10025|${postfix_ip}:10025|" /etc/clamsmtpd.conf > /tmp/clamsmtpd.conf
rm -f /var/run/clamsmtpd.pid
clamsmtpd -f /tmp/clamsmtpd.conf -p /var/run/clamsmtpd.pid

# ClamSMTP daemonizes; keep PID 1 alive while supervising both daemons so a
# proxy crash is visible to Compose and results in a clean restart.
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
  if ! pgrep -x clamsmtpd >/dev/null 2>&1; then
    echo "[ERROR] clamsmtpd stopped unexpectedly" >&2
    exit 1
  fi
  sleep 2
done
wait "$clamd_pid"
