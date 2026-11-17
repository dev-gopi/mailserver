#!/usr/bin/env python3
"""Capture or restore local Docker image IDs for a single-project Compose stack."""
import json
import subprocess
import sys
from pathlib import Path

mode, path = sys.argv[1:3]
def run(args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True)
if mode == "capture":
    ids = run(["docker", "compose", "ps", "-aq"]).stdout.split()
    if not ids:
        raise SystemExit("No Compose containers found to capture")
    records = {}
    for cid in ids:
        data = json.loads(run(["docker", "inspect", cid]).stdout)[0]
        labels = data.get("Config", {}).get("Labels") or {}
        service = labels.get("com.docker.compose.service")
        if not service or not data.get("Image"):
            continue
        state = data.get("State", {})
        if not state.get("Running", False):
            continue
        records[service] = {
            "service": service,
            "image_ref": data["Config"].get("Image"),
            "image_id": data["Image"],
            "container_id": cid,
        }
    if not records:
        raise SystemExit("No running Compose services could be captured")
    stamp = Path(path)
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"schemaVersion": 1, "services": records}, indent=2) + "\n", encoding="utf-8")
    stamp.chmod(0o600)
    for item in records.values():
        tag = f"mailcore-rollback/{item['service']}:{stamp.stem}"
        run(["docker", "image", "tag", item["image_id"], tag])
        item["rollback_tag"] = tag
    stamp.write_text(json.dumps({"schemaVersion": 1, "services": records}, indent=2) + "\n", encoding="utf-8")
    stamp.chmod(0o600)
    print(f"[PASS] Captured {len(records)} running service images: {stamp}")
elif mode == "restore":
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or not isinstance(data.get("services"), dict):
        raise SystemExit("Invalid image-state snapshot")
    services = []
    for name, item in data["services"].items():
        if item.get("service") != name or not item.get("image_ref") or not item.get("rollback_tag"):
            raise SystemExit(f"Invalid service record: {name}")
        run(["docker", "image", "tag", item["rollback_tag"], item["image_ref"]])
        services.append(name)
    print(" ".join(sorted(services)))
else:
    raise SystemExit("mode must be capture or restore")
