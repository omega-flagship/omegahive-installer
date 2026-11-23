"""A pytest plugin that runs one shard of the full run's hive/tests, which it splits by file across a matrix's jobs.

Loaded with `-p hive_shard` and scripts/ci on PYTHONPATH, it reads:
  HIVE_SHARD          "i/n": run shard i (0-based) of n
  HIVE_SHARD_REPORT   where to write this shard's report (JSON), which the aggregate job (hive-full) checks
  HIVE_SHARD_WEIGHTS  optional: a JSON object of seconds per test file, to balance the shards (scripts/ci/hive-shard-
                      weights.json, which hive-full's per-file times refresh); a file missing from it weighs its test
                      count times the median seconds per test of the files it has, and with no file every file weighs
                      its test count
  HIVE_SWITCH_FILES   optional: a file listing, one per line (# comments), the test files that need the AppArmor
                      userns switch (scripts/ci/hive-switch-files.txt). They leave the split and make the last shard,
                      i = n-1, the switch shard (scripts/ci/switch-shard.sh), so the other n-1 shards never need the
                      machine's restriction changed. A listed file the suite did not collect fails the collection, so a
                      rename cannot drop a file from the switch shard unseen.

Every shard collects the whole suite and keeps its own files, so the split is of the collected set, never a hand
list: a new test file lands in some shard on its first run. It splits by file, never by test: module-scoped fixtures
must see all of their module's tests in one process. The split is hive_shards.shards' (heaviest file to the lightest
shard, ties by name), the same on every machine for the same tree and weights, and the report names every collected
file with its test count, so hive-full can check that the shards agree on the suite and cover it exactly once.
"""
import json
import os
import statistics

import pytest

from hive_shards import shards


def parse_shard(value):
    """'i/n' -> (i, n), with 0 <= i < n."""
    index, _, count = value.partition("/")
    index, count = int(index), int(count)
    if not 0 <= index < count:
        raise ValueError(f"HIVE_SHARD={value!r}: want i/n with 0 <= i < n")
    return index, count


def file_of(nodeid):
    return nodeid.split("::", 1)[0]


def weights_for(counts, seconds=None):
    """Each file's weight: its seconds when known, else its test count times the median seconds per test of the
    files whose seconds are known, else its test count."""
    seconds = {f: float(s) for f, s in (seconds or {}).items() if f in counts and counts[f] and float(s) > 0}
    per_test = statistics.median(seconds[f] / counts[f] for f in seconds) if seconds else 1.0
    return {f: seconds.get(f, n * per_test) for f, n in counts.items()}


def split(weights, count):
    """The files of each of `count` shards, each list sorted, and each shard's load: hive_shards.shards (#305's
    longest-processing-time rule, by Mestto), fed this plugin's collected-file weights."""
    parts = shards(weights, count)
    return parts, [sum(weights[f] for f in part) for part in parts]


def read_switch_files(path):
    """The listed files of a HIVE_SWITCH_FILES list: one path per line, blank lines and # comments ignored."""
    with open(path) as fh:
        return [line.split("#", 1)[0].strip() for line in fh if line.split("#", 1)[0].strip()]


def split_with_switch(weights, count, switch):
    """split() over every file but `switch` into count-1 shards, then the switch files as the last shard."""
    missing = sorted(set(switch) - set(weights))
    if missing:
        raise pytest.UsageError(f"HIVE_SWITCH_FILES lists files the suite did not collect: {', '.join(missing)}")
    if count < 2:
        raise pytest.UsageError(f"HIVE_SWITCH_FILES needs at least 2 shards (one plain, one switch), got {count}")
    rest = {f: w for f, w in weights.items() if f not in set(switch)}
    parts, loads = split(rest, count - 1)
    return parts + [sorted(set(switch))], loads + [sum(weights[f] for f in set(switch))]


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    value = os.environ.get("HIVE_SHARD")
    if not value:
        return
    index, count = parse_shard(value)
    counts = {}
    for item in items:
        counts[file_of(item.nodeid)] = counts.get(file_of(item.nodeid), 0) + 1
    path = os.environ.get("HIVE_SHARD_WEIGHTS")
    seconds = {}
    if path and os.path.exists(path):
        with open(path) as fh:
            seconds = json.load(fh)
    switch_list = os.environ.get("HIVE_SWITCH_FILES")
    weights = weights_for(counts, seconds)
    if switch_list:
        parts, loads = split_with_switch(weights, count, read_switch_files(switch_list))
    else:
        parts, loads = split(weights, count)
    mine = set(parts[index])
    keep = [item for item in items if file_of(item.nodeid) in mine]
    drop = [item for item in items if file_of(item.nodeid) not in mine]
    if drop:
        config.hook.pytest_deselected(items=drop)
    items[:] = keep
    report = {
        "shard": index,
        "count": count,
        "collected": sum(counts.values()),
        "files": counts,
        "selected_files": parts[index],
        "selected": len(keep),
        "weight": loads[index],
        "weights_file": bool(seconds),
        "switch": bool(switch_list) and index == count - 1,
    }
    out = os.environ.get("HIVE_SHARD_REPORT")
    if out:
        with open(out, "w") as fh:
            json.dump(report, fh, indent=1, sort_keys=True)
    kind = " (the switch shard)" if report["switch"] else ""
    print(f"\nhive shard {index}/{count}{kind}: {len(keep)} of {sum(counts.values())} collected tests, "
          f"{len(mine)} of {len(counts)} files, weight {loads[index]:.0f}")
