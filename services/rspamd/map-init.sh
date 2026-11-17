#!/bin/sh
set -eu

MAP_DIR="${MAP_DIR:-/maps}"
MAP_UID="${MAP_UID:-1000}"
MAP_GID="${MAP_GID:-1000}"

fail() {
  printf '[rspamd-policy-map-init] ERROR: %s\n' "$1" >&2
  exit 1
}

printf '[rspamd-policy-map-init] preparing shared policy map volume at %s\n' "$MAP_DIR"
mkdir -p "$MAP_DIR" || fail "cannot create map directory: $MAP_DIR"

for file in allow_senders.map block_senders.map allow_domains.map block_domains.map block_extensions.map; do
  target="$MAP_DIR/$file"
  if [ ! -e "$target" ]; then
    (umask 022; : > "$target") || fail "cannot create $target"
  fi
  chmod 0644 "$target" || fail "cannot set mode 0644 on $target (check persistent-volume ownership/capabilities)"
done

settings_map="$MAP_DIR/settings.map"
if [ ! -s "$settings_map" ]; then
  temporary="$settings_map.init.$$"
  cat > "$temporary" <<'EOF'
settings {
  mailcore_bootstrap_default {
    priority = 1;
    rcpt = "/.*/";
    apply { actions { "add header" = 6.0; reject = 15.0; greylist = 4.0; } }
  }
}
EOF
  chmod 0644 "$temporary" || fail "cannot set mode 0644 on $temporary"
  mv -f "$temporary" "$settings_map" || fail "cannot publish initial settings.map"
fi

chmod 0644 "$settings_map" || fail "cannot set mode 0644 on $settings_map (check persistent-volume ownership/capabilities)"
chmod 0755 "$MAP_DIR" || fail "cannot set mode 0755 on $MAP_DIR"
chown -R "$MAP_UID:$MAP_GID" "$MAP_DIR" || fail "cannot assign shared-volume ownership to UID:GID $MAP_UID:$MAP_GID"

printf '[rspamd-policy-map-init] initialized %s (owner %s:%s)\n' "$MAP_DIR" "$MAP_UID" "$MAP_GID"
