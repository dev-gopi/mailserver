#!/usr/bin/env python3
"""Validate MailCore tar archives and safely extract regular files/directories.

The archive is scanned before extraction, then streamed a second time. No archive
paths are trusted: links, special files, absolute paths, traversal, and archives
above the configured member/size limits are rejected.
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile

DEFAULT_MAX_MEMBERS = 5_000_000
DEFAULT_MAX_BYTES = 20 * 1024**4  # 20 TiB; operators can lower this for their host.


def normalized_name(raw: str) -> str:
    if not raw or "\\" in raw or raw.startswith("/"):
        raise ValueError(f"unsafe archive member path: {raw!r}")
    name = raw
    while name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return "."
    path = PurePosixPath(name)
    if any(part == ".." for part in path.parts) or path.is_absolute():
        raise ValueError(f"unsafe archive member path: {raw!r}")
    normalized = str(path)
    if normalized in ("", "."):
        return "."
    return normalized


def open_stream(path: Path):
    if str(path) == "-":
        return tarfile.open(fileobj=sys.stdin.buffer, mode="r|*")
    return tarfile.open(path, "r|*")


def validate(
    path: Path,
    allowed: set[str] | None = None,
    required: set[str] | None = None,
    max_members: int = DEFAULT_MAX_MEMBERS,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> tuple[int, int]:
    count = 0
    total_bytes = 0
    found_required: set[str] = set()
    with open_stream(path) as tf:
        for member in tf:
            name = normalized_name(member.name)
            if name == ".":
                continue
            if not (member.isdir() or member.isreg()):
                raise ValueError(f"links and special files are not allowed: {name}")
            if allowed is not None and (name not in allowed or "/" in name):
                raise ValueError(f"unexpected backup member: {name}")
            if member.size < 0:
                raise ValueError(f"negative archive member size: {name}")
            if member.isfile():
                total_bytes += member.size
                if total_bytes > max_bytes:
                    raise ValueError(f"archive exceeds maximum uncompressed size ({max_bytes} bytes)")
            count += 1
            if count > max_members:
                raise ValueError(f"archive exceeds maximum member count ({max_members})")
            if required is not None and name in required:
                found_required.add(name)
    missing = (required or set()) - found_required
    if missing:
        raise ValueError("required archive member(s) missing: " + ", ".join(sorted(missing)))
    return count, total_bytes


def extract(
    path: Path,
    destination: Path,
    allowed: set[str] | None = None,
    required: set[str] | None = None,
    max_members: int = DEFAULT_MAX_MEMBERS,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> tuple[int, int]:
    validate(path, allowed, required, max_members, max_bytes)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = destination.resolve(strict=True)
    if any(root.iterdir()):
        raise ValueError(f"destination must be empty: {root}")
    count = 0
    total_bytes = 0
    with tarfile.open(path, "r|*") as tf:
        for member in tf:
            name = normalized_name(member.name)
            if name == ".":
                continue
            target = (root / name).resolve(strict=False)
            if os.path.commonpath((str(root), str(target))) != str(root):
                raise ValueError(f"member escapes restore directory: {name}")
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(target, flags, 0o600)
            try:
                source = tf.extractfile(member)
                if source is None:
                    raise ValueError(f"cannot read archive member: {name}")
                with source, os.fdopen(fd, "wb", closefd=True) as out:
                    fd = -1
                    while chunk := source.read(1024 * 1024):
                        out.write(chunk)
                        total_bytes += len(chunk)
                        if total_bytes > max_bytes:
                            raise ValueError(f"archive exceeds maximum extracted size ({max_bytes} bytes)")
            finally:
                if fd >= 0:
                    os.close(fd)
            count += 1
    return count, total_bytes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path, help="archive path or - to validate a tar stream from stdin")
    parser.add_argument("--allowed", action="append", default=None,
                        help="allow only these root members (repeat option)")
    parser.add_argument("--require", action="append", default=None,
                        help="require these member names to exist (repeat option)")
    parser.add_argument("--max-members", type=int, default=DEFAULT_MAX_MEMBERS)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--extract-to", type=Path)
    args = parser.parse_args()
    if args.max_members < 1 or args.max_bytes < 1:
        parser.error("--max-members and --max-bytes must be positive")
    allowed = set(args.allowed) if args.allowed else None
    required = set(args.require) if args.require else None
    if args.extract_to:
        if str(args.archive) == "-":
            parser.error("stream extraction is not supported; provide an archive path")
        count, size = extract(args.archive, args.extract_to, allowed, required, args.max_members, args.max_bytes)
        print(f"[PASS] safely extracted regular files={count} bytes={size} destination={args.extract_to}")
    else:
        count, size = validate(args.archive, allowed, required, args.max_members, args.max_bytes)
        print(f"[PASS] archive members validated={count} uncompressed_bytes={size}")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, tarfile.TarError, ValueError) as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        raise SystemExit(2)
