#!/usr/bin/env bash
# Validate and atomically publish a versioned TLS pair. Does not reload services.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TLS_DIR="$ROOT/secrets/tls"
RELEASES="$TLS_DIR/releases"
MODE="${1:-}"

ensure_root_links() {
  local name link tmp
  for spec in 'cert.pem:current/fullchain.pem' 'privkey.key:current/privkey.pem'; do
    name="${spec%%:*}"; link="${spec#*:}"
    if [[ -e "$TLS_DIR/$name" && ! -L "$TLS_DIR/$name" ]]; then
      echo "Unexpected regular TLS path remains; refusing to overwrite: $TLS_DIR/$name" >&2
      return 1
    fi
    tmp="$TLS_DIR/.$name.$$.${RANDOM}"
    ln -s "$link" "$tmp"
    mv -Tf "$tmp" "$TLS_DIR/$name"
  done
}

ensure_legacy_layout() {
  mkdir -p "$TLS_DIR" "$RELEASES"
  if [[ -L "$TLS_DIR/current" ]]; then
    local target
    target="$(readlink "$TLS_DIR/current")"
    [[ "$target" =~ ^releases/[A-Za-z0-9._-]{1,100}$ && -s "$TLS_DIR/$target/fullchain.pem" && -s "$TLS_DIR/$target/privkey.pem" ]] || {
      echo 'Existing TLS current symlink is invalid or incomplete' >&2; return 1;
    }
    ensure_root_links
    return 0
  fi
  if [[ -f "$TLS_DIR/cert.pem" && ! -L "$TLS_DIR/cert.pem" && -f "$TLS_DIR/privkey.key" && ! -L "$TLS_DIR/privkey.key" ]]; then
    local legacy
    legacy="legacy-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
    mkdir -m 0750 "$RELEASES/$legacy"
    cp -p "$TLS_DIR/cert.pem" "$RELEASES/$legacy/fullchain.pem"
    cp -p "$TLS_DIR/privkey.key" "$RELEASES/$legacy/privkey.pem"
    chmod 0644 "$RELEASES/$legacy/fullchain.pem"
    chmod 0600 "$RELEASES/$legacy/privkey.pem"
    ln -s "releases/$legacy" "$TLS_DIR/.current-bootstrap.$$"
    mv -Tf "$TLS_DIR/.current-bootstrap.$$" "$TLS_DIR/current"
    rm -f "$TLS_DIR/cert.pem" "$TLS_DIR/privkey.key"
  elif [[ -e "$TLS_DIR/cert.pem" || -e "$TLS_DIR/privkey.key" ]]; then
    echo 'Legacy TLS layout is incomplete; restore a matching certificate/key pair before migration' >&2
    return 1
  fi
  ensure_root_links
}

publish_pointer() {
  local target="$1" tmp
  [[ "$target" =~ ^releases/[A-Za-z0-9._-]{1,100}$ ]] || { echo 'Invalid TLS release target' >&2; return 2; }
  [[ -s "$TLS_DIR/$target/fullchain.pem" && -s "$TLS_DIR/$target/privkey.pem" ]] || { echo "TLS release is incomplete: $target" >&2; return 1; }
  tmp="$TLS_DIR/.current.$$.${RANDOM}"
  ln -s "$target" "$tmp"
  mv -Tf "$tmp" "$TLS_DIR/current"
  ensure_root_links
}

if [[ "$MODE" == --bootstrap ]]; then
  ensure_legacy_layout
  [[ -L "$TLS_DIR/current" ]] || { echo 'No existing TLS pair to bootstrap; install a certificate first' >&2; exit 2; }
  printf '%s\n' "$(readlink "$TLS_DIR/current")"
  exit 0
fi
if [[ "$MODE" == --rollback ]]; then
  TARGET="${2:-}"
  [[ -n "$TARGET" ]] || { echo 'Usage: install-certificate.sh --rollback releases/<release-id>' >&2; exit 2; }
  ensure_legacy_layout
  publish_pointer "$TARGET"
  echo "[PASS] TLS pointer restored to $TARGET" >&2
  exit 0
fi

CERT_SOURCE="${1:-}"
KEY_SOURCE="${2:-}"
DOMAIN="${3:-}"
[[ -n "$CERT_SOURCE" && -n "$KEY_SOURCE" && -n "$DOMAIN" ]] || {
  echo 'Usage: install-certificate.sh <fullchain.pem> <privkey.pem> <dns-name> | --rollback releases/<release-id>' >&2
  exit 2
}
[[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || { echo 'Invalid certificate DNS name' >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required' >&2; exit 127; }
resolve_source() {
  local candidate="$1" resolved
  if [[ -L "$candidate" ]]; then
    resolved="$(readlink -f -- "$candidate")"
    [[ "$resolved" == /etc/letsencrypt/archive/* ]] || { echo "Refusing source symlink outside Certbot archive: $candidate" >&2; return 1; }
  else
    resolved="$(realpath -e -- "$candidate")"
  fi
  [[ -f "$resolved" && -s "$resolved" ]] || { echo "Certificate source missing or empty: $candidate" >&2; return 1; }
  printf '%s' "$resolved"
}
CERT_SOURCE="$(resolve_source "$CERT_SOURCE")"
KEY_SOURCE="$(resolve_source "$KEY_SOURCE")"
mkdir -p "$TLS_DIR" "$RELEASES"
chmod 0700 "$TLS_DIR" "$RELEASES"
work="$(mktemp -d "$RELEASES/.candidate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

ensure_legacy_layout

openssl x509 -in "$CERT_SOURCE" -out "$work/leaf.pem"
openssl pkey -in "$KEY_SOURCE" -out "$work/privkey.pem"
# Preserve the supplied fullchain, not just the leaf.
cp "$CERT_SOURCE" "$work/fullchain.pem"
chmod 0644 "$work/leaf.pem" "$work/fullchain.pem"
chmod 0600 "$work/privkey.pem"
openssl x509 -in "$work/leaf.pem" -noout -checkhost "$DOMAIN" 2>&1 | grep -q 'does match certificate' || { echo "Certificate does not cover $DOMAIN" >&2; exit 1; }
openssl x509 -in "$work/leaf.pem" -noout -checkend 2592000 >/dev/null || { echo 'Certificate expires in less than 30 days or is not yet valid' >&2; exit 1; }
openssl pkey -in "$work/privkey.pem" -check -noout >/dev/null 2>&1 || { echo 'Private key validation failed' >&2; exit 1; }
cert_pub="$(openssl x509 -in "$work/leaf.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
key_pub="$(openssl pkey -in "$work/privkey.pem" -pubout -outform DER | sha256sum | awk '{print $1}')"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'Certificate/private-key mismatch' >&2; exit 1; }

ca_bundle="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
if [[ -n "$ca_bundle" && -f "$ca_bundle" ]]; then
  awk 'BEGIN{n=0} /-----BEGIN CERTIFICATE-----/{n++} n==1{print} /-----END CERTIFICATE-----/ && n==1{exit}' "$work/fullchain.pem" > "$work/leaf-only.pem"
  awk 'BEGIN{n=0} /-----BEGIN CERTIFICATE-----/{n++} n>=2{print}' "$work/fullchain.pem" > "$work/intermediates.pem"
  if [[ -s "$work/intermediates.pem" ]]; then
    openssl verify -CAfile "$ca_bundle" -untrusted "$work/intermediates.pem" "$work/leaf-only.pem" >/dev/null
  else
    openssl verify -CAfile "$ca_bundle" "$work/leaf-only.pem" >/dev/null
  fi
fi

release="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 6)"
mkdir -m 0750 "$RELEASES/$release"
install -m 0644 "$work/fullchain.pem" "$RELEASES/$release/fullchain.pem"
install -m 0600 "$work/privkey.pem" "$RELEASES/$release/privkey.pem"
# Verify the material in its final release location before pointer switch.
openssl x509 -in "$RELEASES/$release/fullchain.pem" -noout >/dev/null
openssl pkey -in "$RELEASES/$release/privkey.pem" -noout >/dev/null
publish_pointer "releases/$release"
printf '%s\n' "releases/$release"
