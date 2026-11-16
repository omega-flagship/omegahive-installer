"""The line protocol a suite run speaks on stdout.

Every event is one line ``@@bench {json}``; anything else is log output.

Events:
  {"type": "case", ...Case}    one finished test or benchmark
  {"type": "log", "text": ...} a progress note worth showing live
  {"type": "end", "status": ...}

A Case is::

  {id, name, group, status: passed|failed|skipped|error, duration_ms,
   message?, metrics?: [Metric], series?: [Series], notes?}
  Metric = {name, value, unit, better: "lower"|"higher"|"equal", target?, ok?}
  Series = {name, unit?, x?, kind: "line"|"bar"|"step", points: [[x, y], ...]}
"""

from __future__ import annotations

import json
import sys

PREFIX = "@@bench "


def emit(kind, **payload):
    sys.stdout.write("\n" + PREFIX + json.dumps(dict(type=kind, **payload), default=str) + "\n")
    sys.stdout.flush()


def parse(line):
    # pytest may print progress dots on the same line before an event.
    at = line.find(PREFIX)
    if at < 0:
        return None
    try:
        return json.loads(line[at + len(PREFIX):])
    except ValueError:
        return None
