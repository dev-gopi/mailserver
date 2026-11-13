#!/bin/bash
set -e

# Signature downloads must never run at image-build time: the ClamAV CDN can
# throttle builds. The persistent /var/lib/clamav volume keeps databases across restarts.
freshclam || echo "[WARN] ClamAV signatures were not updated; retaining existing database."

# Start clamd (daemon in foreground)
clamd &

# Start clamsmtpd
clamsmtpd -f -c /etc/clamsmtpd.conf
