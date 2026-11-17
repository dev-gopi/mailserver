#!/usr/bin/env python3
"""Opt-in SMTP submission benchmark. Sends only to the configured test recipient."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
import smtplib
import ssl
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from pathlib import Path

from load_test_config import can_prompt, load_env_file, missing_or_placeholder, percentile, prompt_secret, prompt_text, write_json_report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default=str(Path(__file__).with_name('load-test.env')),
                        help='private KEY=VALUE file; process environment overrides it')
    parser.add_argument('--host')
    parser.add_argument('--port', type=int)
    parser.add_argument('--mode', choices=['starttls', 'smtps'])
    parser.add_argument('--count', type=int, default=20)
    parser.add_argument('--concurrency', type=int, default=2)
    parser.add_argument('--timeout', type=int, default=15)
    parser.add_argument('--sender')
    parser.add_argument('--recipient')
    parser.add_argument('--username')
    parser.add_argument('--password')
    parser.add_argument('--ca-file', help='optional CA PEM for private/self-signed test TLS')
    parser.add_argument('--json-report', help='write a private JSON benchmark report to this path')
    parser.add_argument('--check-config', action='store_true', help='validate settings without connecting or sending mail')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_file(args.env_file)
    host = args.host or os.getenv('SMTP_HOST', '127.0.0.1')
    port = args.port or int(os.getenv('SMTP_PORT', '587'))
    mode = args.mode or os.getenv('SMTP_MODE', 'starttls')
    username = args.username or os.getenv('SMTP_USERNAME')
    password = args.password or os.getenv('SMTP_PASSWORD')
    sender = args.sender or os.getenv('SMTP_TEST_SENDER') or username
    recipient = args.recipient or os.getenv('SMTP_TEST_RECIPIENT') or username
    username = None if missing_or_placeholder(username) else username
    password = None if missing_or_placeholder(password) else password
    sender = None if missing_or_placeholder(sender) else sender
    recipient = None if missing_or_placeholder(recipient) else recipient

    if not args.check_config and can_prompt():
        username = username or prompt_text('SMTP username')
        password = password or prompt_secret('SMTP password')
        sender = sender or prompt_text('Test sender address', username)
        recipient = recipient or prompt_text('Test recipient address', username)

    missing = [name for name, value in {
        'SMTP_USERNAME': username, 'SMTP_PASSWORD': password,
        'SMTP_TEST_SENDER': sender, 'SMTP_TEST_RECIPIENT': recipient,
    }.items() if not value or not value.strip()]
    if missing:
        print('Missing configuration: ' + ', '.join(missing), file=sys.stderr)
        print('Run: bash infrastructure/performance/setup-load-test-env.sh', file=sys.stderr)
        return 2
    if args.count < 1 or args.count > 10000 or args.concurrency < 1 or args.concurrency > 50:
        print('count must be 1..10000 and concurrency 1..50', file=sys.stderr)
        return 2
    if args.timeout < 1 or port < 1 or port > 65535:
        print('timeout and port must be positive; port must be <= 65535', file=sys.stderr)
        return 2
    if mode not in ('starttls', 'smtps'):
        print('SMTP_MODE must be starttls or smtps', file=sys.stderr)
        return 2
    ca_file = args.ca_file or os.getenv('SMTP_CA_FILE') or None
    if ca_file and not Path(ca_file).is_file():
        print(f'SMTP CA file does not exist: {ca_file}', file=sys.stderr)
        return 2

    print(f'config_ok host={host} port={port} mode={mode} sender={sender} recipient={recipient} '
          f'count={args.count} concurrency={args.concurrency} tls_verification=enabled')
    if args.check_config:
        print('[PASS] SMTP load-test configuration (no connection attempted)')
        return 0

    context = ssl.create_default_context(cafile=ca_file)
    def send(index: int) -> tuple[bool, float, str]:
        started = time.perf_counter()
        message = EmailMessage()
        message['From'] = sender
        message['To'] = recipient
        message['Subject'] = f'MailCore M08 controlled load test {uuid.uuid4()}'
        message['X-MailCore-Load-Test'] = 'true'
        message.set_content(f'Controlled SMTP benchmark message {index}; safe to delete.')
        try:
            if mode == 'smtps':
                with smtplib.SMTP_SSL(host, port, timeout=args.timeout, context=context) as client:
                    client.login(username, password)
                    client.send_message(message)
            else:
                with smtplib.SMTP(host, port, timeout=args.timeout) as client:
                    client.ehlo()
                    client.starttls(context=context)
                    client.ehlo()
                    client.login(username, password)
                    client.send_message(message)
            return True, time.perf_counter() - started, ''
        except Exception as exc:  # report the error, never print credentials
            return False, time.perf_counter() - started, f'{type(exc).__name__}: {exc}'

    started_at = datetime.now(timezone.utc).isoformat()
    started = time.perf_counter()
    results = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(send, i) for i in range(args.count)]
        for future in as_completed(futures):
            results.append(future.result())
    elapsed = time.perf_counter() - started
    succeeded = sum(result[0] for result in results)
    latencies = sorted(result[1] for result in results)
    error_counts: dict[str, int] = {}
    for result in results:
        if result[2]:
            error_counts[result[2]] = error_counts.get(result[2], 0) + 1
    report = {
        'tool': 'smtp_load', 'started_at': started_at, 'host': host, 'port': port,
        'mode': mode, 'count': len(results), 'concurrency': args.concurrency,
        'success': succeeded, 'failed': len(results) - succeeded,
        'error_rate': (len(results) - succeeded) / len(results) if results else 0.0,
        'elapsed_seconds': round(elapsed, 6),
        'throughput_messages_per_second': round(succeeded / elapsed, 6) if elapsed else 0.0,
        'latency_seconds': {
            'min': min(latencies) if latencies else 0.0,
            'mean': sum(latencies) / len(latencies) if latencies else 0.0,
            'p50': percentile(latencies, .50), 'p95': percentile(latencies, .95),
            'p99': percentile(latencies, .99), 'max': max(latencies) if latencies else 0.0,
        },
        'tls_verification': 'enabled', 'error_counts': error_counts,
    }
    print(f'total={len(results)} success={succeeded} failed={len(results)-succeeded} elapsed_s={elapsed:.2f} '
          f'throughput_msg_s={report["throughput_messages_per_second"]:.2f} '
          f'p50_s={report["latency_seconds"]["p50"]:.3f} '
          f'p95_s={report["latency_seconds"]["p95"]:.3f} '
          f'p99_s={report["latency_seconds"]["p99"]:.3f}')
    for error, count in sorted(error_counts.items()):
        print(f'ERROR ({count}):', error)
    if args.json_report:
        write_json_report(args.json_report, report)
        print(f'[PASS] Private JSON benchmark report: {args.json_report}')
    return 0 if succeeded == len(results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
