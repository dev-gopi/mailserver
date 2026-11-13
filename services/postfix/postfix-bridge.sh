#!/bin/sh
set -eu
IFS= read -r command || exit 0
case "$command" in
  STATUS) exec postqueue -p ;;
  FLUSH) exec postqueue -f ;;
  *) printf '%s\n' 'Unsupported command' >&2; exit 64 ;;
esac
