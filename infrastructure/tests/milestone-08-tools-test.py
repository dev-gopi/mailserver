#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PERF = ROOT / 'infrastructure' / 'performance'
sys.path.insert(0, str(PERF))
from load_test_config import load_env_file, missing_or_placeholder  # noqa: E402


class Milestone08ToolsTest(unittest.TestCase):
    def test_env_file_parser_and_process_env_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / 'test.env'
            env_path.write_text('A=from-file\nB=contains#hash\nC="quoted value"\n', encoding='utf-8')
            os.environ['A'] = 'from-process'
            try:
                load_env_file(env_path)
                self.assertEqual(os.environ['A'], 'from-process')
                self.assertEqual(os.environ['B'], 'contains#hash')
                self.assertEqual(os.environ['C'], 'quoted value')
            finally:
                for name in ('A', 'B', 'C'):
                    os.environ.pop(name, None)

    def test_placeholder_values_are_rejected(self) -> None:
        self.assertTrue(missing_or_placeholder('replace-with-a-secret'))
        self.assertTrue(missing_or_placeholder(''))
        self.assertFalse(missing_or_placeholder('a-real-test-secret'))

    def test_postqueue_jsonl_summary(self) -> None:
        now = int(time.time())
        records = [
            {'queue_name': 'active', 'arrival_time': now - 60, 'message_size': 1024},
            {'queue_name': 'deferred', 'arrival_time': now - 7200, 'message_size': 2048},
        ]
        completed = subprocess.run(
            [sys.executable, str(PERF / 'postfix-queue-age.py')],
            input=''.join(json.dumps(record) + '\n' for record in records),
            text=True, capture_output=True, check=True,
        )
        self.assertIn('queue_total=2', completed.stdout)
        self.assertIn('active:1', completed.stdout)
        self.assertIn('deferred:1', completed.stdout)
        self.assertIn('under_1h:1', completed.stdout)
        self.assertIn('1h_to_6h:1', completed.stdout)


if __name__ == '__main__':
    unittest.main()
