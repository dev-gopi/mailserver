"""Small, non-shell dotenv reader and interactive helpers for load-test tools.

Values from the process environment take precedence over the private env file.
The file is parsed as KEY=VALUE; no shell expansion, command substitution or
execution is performed.
"""
from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path


def load_env_file(path: str | Path | None) -> None:
    if not path:
        return
    env_path = Path(path).expanduser()
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or not key.replace("_", "").isalnum():
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def missing_or_placeholder(value: str | None) -> bool:
    if not value or not value.strip():
        return True
    lowered = value.strip().lower()
    return any(token in lowered for token in ("replace-with", "change-me", "your-password", "<password>", "<email>"))



def prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def prompt_secret(label: str) -> str:
    return getpass.getpass(f"{label}: ")


def can_prompt() -> bool:
    return sys.stdin.isatty() and sys.stderr.isatty()
