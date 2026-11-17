#!/usr/bin/env python3
"""Generate a CycloneDX 1.5 SBOM with resolved edges from npm package-lock v2/v3."""
from __future__ import annotations
import datetime as dt
import json
import re
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[2]
lock_path = root / "apps/admin-api/package-lock.json"
if not lock_path.is_file():
    raise SystemExit(f"Missing {lock_path}")
lock = json.loads(lock_path.read_text(encoding="utf-8"))
packages = lock.get("packages")
if not isinstance(packages, dict):
    raise SystemExit("package-lock.json must contain a packages object (lockfileVersion 2 or 3)")


def package_name(path: str, info: dict) -> str | None:
    name = info.get("name")
    if name:
        return str(name)
    match = re.search(r"(?:^|/)node_modules/(.+)$", path)
    return match.group(1) if match else None


def purl(name: str, version: str) -> str:
    # Percent-encode the leading @ in scoped npm package names.
    encoded = "%40" + name[1:] if name.startswith("@") else name
    return f"pkg:npm/{encoded}@{version}"


def resolve_dependency(parent_path: str, dep_name: str) -> str | None:
    parts = parent_path.split("/") if parent_path else []
    module_positions = [i for i, part in enumerate(parts) if part == "node_modules"]
    name_parts = dep_name.split("/")
    for index in reversed(module_positions):
        candidate = "/".join(parts[: index + 1] + name_parts)
        if candidate in packages:
            return candidate
    candidate = "/".join(["node_modules"] + name_parts)
    return candidate if candidate in packages else None


path_to_purl: dict[str, str] = {}
components_by_purl: dict[str, dict] = {}
for path, info in sorted(packages.items()):
    if not path or not isinstance(info, dict) or not info.get("version"):
        continue
    name = package_name(path, info)
    if not name:
        continue
    version = str(info["version"])
    ref = purl(name, version)
    path_to_purl[path] = ref
    component = {
        "type": "library", "name": name, "version": version, "purl": ref,
        "scope": "excluded" if info.get("dev") else "required",
    }
    if info.get("license"):
        component["licenses"] = [{"license": {"name": str(info["license"])}}]
    # One component per purl even when npm hoists identical versions into more
    # than one physical node_modules location.
    existing = components_by_purl.get(ref)
    if existing is None or (existing.get("scope") == "excluded" and component["scope"] == "required"):
        components_by_purl[ref] = component

edges: dict[str, set[str]] = {}
for path, info in packages.items():
    if not isinstance(info, dict):
        continue
    parent_ref = path_to_purl.get(path)
    if path == "":
        root_name = str(info.get("name") or "mailcore-admin-api")
        root_version = str(info.get("version") or lock.get("version") or "0.0.0")
        parent_ref = purl(root_name, root_version)
    if not parent_ref:
        continue
    targets: set[str] = set()
    for field in ("dependencies", "optionalDependencies"):
        deps = info.get(field) or {}
        if not isinstance(deps, dict):
            continue
        for dep_name in deps:
            target_path = resolve_dependency(path, str(dep_name))
            if target_path and target_path in path_to_purl:
                targets.add(path_to_purl[target_path])
    edges.setdefault(parent_ref, set()).update(targets)

root_info = packages.get("", {})
root_name = str(root_info.get("name") or "mailcore-admin-api")
root_version = str(root_info.get("version") or lock.get("version") or "0.0.0")
root_ref = purl(root_name, root_version)
# Ensure root is declared, including the case where package lock has no name.
if not any(item.get("purl") == root_ref for item in components_by_purl.values()):
    root_component = {"type": "application", "name": root_name, "version": root_version, "purl": root_ref}
else:
    root_component = None

components = sorted(components_by_purl.values(), key=lambda item: item["purl"])
dependencies = [{"ref": ref, "dependsOn": sorted(targets)} for ref, targets in sorted(edges.items())]
# CycloneDX's root component is represented by metadata.component; it also
# appears as the root dependency ref, with edges resolved from package-lock.
bom = {
    "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
    "serialNumber": "urn:uuid:" + str(uuid.uuid4()),
    "metadata": {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "tools": {"components": [{"type": "application", "name": "MailCore npm lockfile SBOM generator", "version": "1.1.0"}]},
        "component": root_component or {"type": "application", "name": root_name, "version": root_version, "purl": root_ref},
    },
    "components": components,
    "dependencies": dependencies,
}
out_dir = root / "infrastructure/reports/security"
out_dir.mkdir(parents=True, exist_ok=True)
out = out_dir / "admin-api-package-lock.cdx.json"
out.write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
out.chmod(0o600)
print(f"[PASS] Generated {len(components)} locked npm components and {sum(len(x['dependsOn']) for x in dependencies)} dependency edges: {out}")
