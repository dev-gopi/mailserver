#!/usr/bin/env python3
"""Summarize Postfix `postqueue -j` JSON Lines without qshape/Perl dependencies."""
import json
import sys
import time
from collections import Counter

now = time.time()
classes = Counter()
buckets = Counter()
oldest = 0.0
items = 0
bytes_total = 0
unknown_age = 0

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        item = json.loads(line)
    except json.JSONDecodeError as exc:
        print(f"invalid postqueue JSON line: {exc}", file=sys.stderr)
        raise SystemExit(2)
    items += 1
    queue_name = str(item.get("queue_name", "unknown"))
    classes[queue_name] += 1
    try:
        age = max(0.0, now - float(item["arrival_time"]))
        oldest = max(oldest, age)
        if age < 3600:
            bucket = "under_1h"
        elif age < 6 * 3600:
            bucket = "1h_to_6h"
        elif age < 24 * 3600:
            bucket = "6h_to_24h"
        else:
            bucket = "over_24h"
        buckets[bucket] += 1
    except (KeyError, TypeError, ValueError):
        unknown_age += 1
    try:
        bytes_total += int(item.get("message_size", 0))
    except (TypeError, ValueError):
        pass

if items == 0:
    print("queue=empty")
else:
    print(f"queue_total={items} bytes_total={bytes_total} oldest_age_seconds={int(oldest)} unknown_age={unknown_age}")
    print("queue_classes=" + ",".join(f"{k}:{v}" for k, v in sorted(classes.items())))
    print("age_buckets=" + ",".join(f"{k}:{buckets.get(k, 0)}" for k in ("under_1h", "1h_to_6h", "6h_to_24h", "over_24h")))
