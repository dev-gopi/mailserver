#!/usr/bin/env python3
"""Validate time-bounded, ticketed security scan exceptions; expired entries fail closed."""
import datetime as dt
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "infrastructure/security/security-exceptions.json")
data = json.loads(path.read_text(encoding="utf-8"))
if data.get("schemaVersion") != 1 or not isinstance(data.get("exceptions"), list):
    raise SystemExit("Invalid security exception schema")
today = dt.datetime.now(dt.timezone.utc).date()
seen = set()
ids = set()
for entry in data["exceptions"]:
    if not isinstance(entry, dict):
        raise SystemExit("Each exception must be an object")
    required = ("id", "ticket", "package", "vulnerability", "severity", "reason", "owner", "expires")
    if any(not isinstance(entry.get(k), str) or not entry[k].strip() for k in required):
        raise SystemExit("Exception missing required non-empty fields (id, ticket, package, vulnerability, severity, reason, owner, expires)")
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{2,80}", entry["id"], re.I):
        raise SystemExit(f"Invalid exception id: {entry['id']}")
    if entry["id"] in ids:
        raise SystemExit(f"Duplicate exception id: {entry['id']}")
    ids.add(entry["id"])
    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", entry["ticket"], re.I):
        raise SystemExit(f"Exception {entry['id']} must reference a ticket (e.g. SEC-123)")
    if entry["severity"] not in ("LOW", "MEDIUM", "HIGH", "CRITICAL"):
        raise SystemExit(f"Invalid severity for {entry['id']}")
    key = (entry["package"], entry["vulnerability"])
    if key in seen:
        raise SystemExit(f"Duplicate package/vulnerability exception: {key}")
    seen.add(key)
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{2,80}", entry["vulnerability"], re.I):
        raise SystemExit(f"Invalid vulnerability identifier: {entry['vulnerability']}")
    try:
        expiry = dt.date.fromisoformat(entry["expires"])
    except ValueError as exc:
        raise SystemExit(f"Invalid expiry for {entry['id']}: {exc}") from exc
    if expiry <= today:
        raise SystemExit(f"Security exception expired: {entry['id']} on {expiry}")
print(f"[PASS] {len(data['exceptions'])} active, ticketed security exceptions validated")
