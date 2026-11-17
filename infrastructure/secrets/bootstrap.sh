#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_ENV="$ROOT_DIR/.env"
API_ENV="$ROOT_DIR/apps/admin-api/.env"
SECRET_DIR="$ROOT_DIR/secrets/runtime"

if [[ ! -f "$ROOT_ENV" ]]; then
  echo "Missing .env. Copy .env.example to .env and configure it first." >&2
  exit 1
fi
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

python3 - "$ROOT_ENV" "$API_ENV" "$SECRET_DIR" <<'PY'
import base64
import os
import re
import secrets
import sys
from pathlib import Path

root_env_path, api_env_path, secret_dir_path = map(Path, sys.argv[1:])
secret_dir = secret_dir_path


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


root = read_env(root_env_path)
api = read_env(api_env_path)


def persist(name: str, candidate: str | None, *, required: bool = False) -> None:
    target = secret_dir / name
    if target.exists() and target.stat().st_size > 0:
        # Compose file-backed secrets are read-only bind mounts and do not
        # honor per-secret uid/gid remapping. Keep the host directory 0700 and
        # make each mounted file readable to the service's runtime UID.
        os.chmod(target, 0o444)
        return
    if not candidate:
        if required:
            raise SystemExit(f"Required secret {name} is missing. Configure it in .env or preserve the existing secrets/runtime file.")
        candidate = secrets.token_urlsafe(48)
    target.write_text(candidate.rstrip("\r\n") + "\n", encoding="utf-8")
    os.chmod(target, 0o444)


postgres_password = root.get("POSTGRES_PASSWORD", "")
if postgres_password in ("", "replace-with-a-strong-password"):
    existing_pg = secret_dir / "postgres_password"
    if not existing_pg.exists() or not existing_pg.read_text(encoding="utf-8").strip():
        raise SystemExit("Set a unique POSTGRES_PASSWORD in .env before bootstrapping secrets.")
if postgres_password and len(postgres_password) < 16:
    raise SystemExit("POSTGRES_PASSWORD must contain at least 16 characters.")
persist("postgres_password", postgres_password, required=True)

for env_key, filename in (
    ("API_DB_PASSWORD", "api_db_password"),
    ("POSTFIX_DB_PASSWORD", "postfix_db_password"),
    ("DOVECOT_DB_PASSWORD", "dovecot_db_password"),
    ("OPENDKIM_DB_PASSWORD", "opendkim_db_password"),
    ("REDIS_PASSWORD", "redis_password"),
):
    value = root.get(env_key, "") or None
    if value and len(value) < 16:
        raise SystemExit(f"{env_key} must contain at least 16 characters.")
    if env_key == "REDIS_PASSWORD" and value and not re.fullmatch(r"[A-Za-z0-9_-]{16,}", value):
        raise SystemExit("REDIS_PASSWORD must use at least 16 URL-safe letters, digits, underscores or hyphens.")
    persist(filename, value)

# Prometheus scrape and Grafana admin credentials are initialized in the persistent
# monitoring named volume by Compose. The initializer imports legacy host files when
# present, preserving existing credentials without requiring new bind-mounted files.

key = root.get("AUTH_ENCRYPTION_KEY", "") or api.get("AUTH_ENCRYPTION_KEY", "")
key_path = secret_dir / "auth_encryption_key"
if key_path.exists() and key_path.stat().st_size > 0:
    os.chmod(key_path, 0o444)
    key = key_path.read_text(encoding="utf-8").strip()
else:
    if not key:
        key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
    persist("auth_encryption_key", key, required=True)
try:
    decoded = base64.b64decode(key, validate=True)
except Exception as exc:
    raise SystemExit(f"AUTH_ENCRYPTION_KEY must be valid base64: {exc}")
if len(decoded) != 32:
    raise SystemExit("AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes.")

# Set strict permissions even when files pre-existed.
for item in secret_dir.iterdir():
    if item.is_file() and item.name != ".gitkeep":
        os.chmod(item, 0o444)

print("Docker secret files are ready (values were not displayed):")
password_names = (
    "postgres_password", "api_db_password", "postfix_db_password",
    "dovecot_db_password", "opendkim_db_password", "redis_password"
)
password_values = []
for name in password_names:
    path = secret_dir / name
    if not path.exists() or not path.stat().st_size:
        raise SystemExit(f"Secret file {name} is missing or empty.")
    password_values.append(path.read_text(encoding="utf-8").strip())
if any(len(value) < 16 for value in password_values):
    raise SystemExit("All PostgreSQL, service DB and Redis passwords must contain at least 16 characters.")
if len(set(password_values)) != len(password_values):
    raise SystemExit("PostgreSQL and service DB passwords must all be distinct.")

for name in (*password_names, "auth_encryption_key"):
    path = secret_dir / name
    if not path.exists() or not path.stat().st_size:
        raise SystemExit(f"Secret file {name} is missing or empty.")
    print(f"  - secrets/runtime/{name}")
PY
