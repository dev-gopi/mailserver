#!/bin/bash
set -e

# Ensure freshclam runs at container start (optional)
freshclam &

# Start clamd (daemon in foreground)
clamd &

# Start clamsmtpd
clamsmtpd -f -c /etc/clamsmtpd.conf
