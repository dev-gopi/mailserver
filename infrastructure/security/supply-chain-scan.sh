#!/usr/bin/env bash
# Produce a dependency SBOM and execute npm/Trivy vulnerability and secret scans.
# Fails closed on HIGH/CRITICAL findings or when required scanners are unavailable.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
MODE="${1:---scan}"
REPORT_DIR="$ROOT/infrastructure/reports/security"
mkdir -p "$REPORT_DIR"; chmod 0700 "$REPORT_DIR"
case "$MODE" in
  --check)
    missing=()
    for tool in node npm trivy; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
    if ((${#missing[@]})); then printf '[FAIL] Missing required supply-chain tools: %s\n' "${missing[*]}" >&2; exit 127; fi
    echo '[PASS] Node, npm and Trivy are available. Syft is optional when npm lockfile SBOM is generated.'
    exit 0 ;;
  --scan) ;;
  *) echo 'Usage: supply-chain-scan.sh [--check|--scan]' >&2; exit 2 ;;
esac
for tool in node npm; do command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 127; }; done
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
failures=0
warnings=0

# Always produce a package-lock-derived SBOM; Syft can additionally inventory source/system packages.
python3 "$ROOT/infrastructure/security/generate-npm-sbom.py"
if command -v syft >/dev/null 2>&1; then
  syft dir:apps/admin-api -o cyclonedx-json > "$REPORT_DIR/admin-api-syft-$STAMP.cdx.json" || failures=1
  syft dir:services -o cyclonedx-json > "$REPORT_DIR/services-syft-$STAMP.cdx.json" || failures=1
  syft dir:infrastructure -o cyclonedx-json > "$REPORT_DIR/infrastructure-syft-$STAMP.cdx.json" || failures=1
else
  echo '[WARN] Syft is unavailable; package-lock SBOM is present but full OS/source inventory is skipped.' >&2
  warnings=1
fi

npm_rc=0
npm --prefix apps/admin-api audit --json > "$REPORT_DIR/npm-audit-$STAMP.json" || npm_rc=$?
chmod 0600 "$REPORT_DIR/npm-audit-$STAMP.json"
if (( npm_rc != 0 )); then
  echo "[FAIL] npm audit returned $npm_rc; inspect private report $REPORT_DIR/npm-audit-$STAMP.json" >&2
  failures=1
fi

if command -v trivy >/dev/null 2>&1; then
  trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --exit-code 1 \
    --skip-dirs .git --skip-dirs node_modules --skip-dirs dist --skip-dirs backups \
    --skip-dirs secrets --skip-dirs infrastructure/reports --skip-files .env \
    --format json --output "$REPORT_DIR/trivy-fs-$STAMP.json" . || failures=1
  if command -v docker >/dev/null 2>&1 && docker compose config --images >/dev/null 2>&1; then
    while IFS= read -r image; do
      [[ -n "$image" ]] || continue
      safe="$(printf '%s' "$image" | tr '/:@' '___')"
      trivy image --severity HIGH,CRITICAL --exit-code 1 --format json \
        --output "$REPORT_DIR/trivy-image-$safe-$STAMP.json" "$image" || failures=1
    done < <(docker compose config --images | sort -u)
  else
    echo '[WARN] Docker image scan skipped (Docker Compose configuration/daemon unavailable).' >&2
    warnings=1
  fi
else
  echo '[FAIL] Trivy is required for the security release gate.' >&2
  failures=1
fi
python3 "$ROOT/infrastructure/security/check-security-exceptions.py" || failures=1

if (( failures )); then
  echo "[FAIL] Supply-chain scan has blockers. Reports: $REPORT_DIR" >&2
  exit 1
fi
if (( warnings )); then
  echo "[PARTIAL] Scans completed with missing optional inventories. Reports: $REPORT_DIR" >&2
  [[ "${REQUIRE_FULL_SBOM:-NO}" != YES ]] || exit 2
else
  echo "[PASS] Supply-chain scans completed. Reports: $REPORT_DIR"
fi
