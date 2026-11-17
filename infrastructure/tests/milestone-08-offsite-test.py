#!/usr/bin/env python3
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class OffsiteAndRestoreSafetyTests(unittest.TestCase):
    def test_safe_archive_extracts_and_rejects_parent_traversal(self) -> None:
        helper = ROOT / "infrastructure/backup/safe_archive.py"
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            good = base / "good.tar.gz"
            with tarfile.open(good, "w:gz") as tf:
                data = b"mail-payload"
                info = tarfile.TarInfo("./domain/user/cur/msg:2,S")
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            destination = base / "restore"
            subprocess.run([sys.executable, str(helper), str(good), "--extract-to", str(destination)],
                           check=True, capture_output=True, text=True)
            self.assertEqual((destination / "domain/user/cur/msg:2,S").read_bytes(), b"mail-payload")

            bad = base / "bad.tar.gz"
            with tarfile.open(bad, "w:gz") as tf:
                data = b"outside"
                info = tarfile.TarInfo("../../outside")
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            blocked = subprocess.run([sys.executable, str(helper), str(bad), "--extract-to", str(base / "blocked")],
                                     capture_output=True, text=True)
            self.assertNotEqual(blocked.returncode, 0)

            limited = subprocess.run([sys.executable, str(helper), str(good), "--max-bytes", "2"],
                                     capture_output=True, text=True)
            self.assertNotEqual(limited.returncode, 0)
            self.assertIn("maximum uncompressed size", limited.stderr)

    def test_offsite_sync_is_verified_and_idempotent(self) -> None:
        script = ROOT / "infrastructure/backup/offsite-sync.sh"
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            backups = base / "backups"
            backups.mkdir()
            archive = backups / "mail-20261117T000000Z.tar.gz"
            nested = base / "maildata.tar.gz"
            with tarfile.open(nested, "w:gz") as mail_tf:
                info = tarfile.TarInfo("domain/user/cur/probe:2,S")
                payload = b"mail-payload"
                info.size = len(payload)
                mail_tf.addfile(info, io.BytesIO(payload))
            with tarfile.open(archive, "w:gz") as tf:
                for name, payload in (("database.dump", b"db"), ("maildata.tar.gz", nested.read_bytes())):
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    tf.addfile(info, io.BytesIO(payload))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            (backups / (archive.name + ".sha256")).write_text(f"{digest}  {archive.name}\n", encoding="utf-8")

            password = base / "restic-password"
            password.write_text("this-is-a-test-only-restic-password\n", encoding="utf-8")
            password.chmod(0o600)
            config = base / "offsite.env"
            config.write_text(
                f"RESTIC_REPOSITORY=s3:https://example.invalid/bucket/mailcore\n"
                f"RESTIC_PASSWORD_FILE={password}\nRESTIC_HOST=test-host\n"
                f"RESTIC_CACHE_DIR={base / 'restic-cache'}\nRESTIC_CHECK_INTERVAL_HOURS=24\n",
                encoding="utf-8")
            config.chmod(0o600)

            mockbin = base / "bin"
            mockbin.mkdir()
            state = base / "restic-state.json"
            mock = mockbin / "restic"
            mock.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state = Path(os.environ['RESTIC_MOCK_STATE'])
data = json.loads(state.read_text()) if state.exists() else []
if args[:1] == ['snapshots']:
    print(json.dumps(data))
elif args[:1] == ['backup']:
    tags = []
    for i, item in enumerate(args[:-1]):
        if item == '--tag': tags.append(args[i + 1])
    data.append({'id': '0123456789abcdef', 'tags': tags, 'hostname': 'test-host', 'paths': args[-2:]})
    state.write_text(json.dumps(data))
    print(json.dumps({'message_type':'summary','snapshot_id':'0123456789abcdef'}))
elif args[:1] in (['check'], ['forget']):
    print('mock-ok')
else:
    print('unexpected restic args: ' + repr(args), file=sys.stderr); sys.exit(2)
""", encoding="utf-8")
            mock.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "OFFSITE_ENV_FILE": str(config), "BACKUP_DIR": str(backups),
                "BACKUP_FILE": str(archive), "RESTIC_MOCK_STATE": str(state),
                "PATH": f"{mockbin}{os.pathsep}{env['PATH']}",
                "XDG_CACHE_HOME": str(base / "xdg-cache"),
            })
            first = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertEqual(len(json.loads(state.read_text())), 1)
            second = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertEqual(len(json.loads(state.read_text())), 1)
            self.assertIn("Already replicated", second.stdout)

    def test_offsite_config_rejects_local_repository(self) -> None:
        common = ROOT / "infrastructure/backup/offsite-common.sh"
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            password = base / "password"
            password.write_text("test-password-long-enough\n", encoding="utf-8")
            password.chmod(0o600)
            config = base / "offsite.env"
            config.write_text(f"RESTIC_REPOSITORY=/local/path\nRESTIC_PASSWORD_FILE={password}\n", encoding="utf-8")
            config.chmod(0o600)
            result = subprocess.run(["bash", "-c", f'source "{common}"; load_offsite_config'],
                                    env={**os.environ, "OFFSITE_ENV_FILE": str(config)},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("remote backend", result.stderr)


if __name__ == "__main__":
    unittest.main()
