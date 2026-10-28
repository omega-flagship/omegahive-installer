#!/usr/bin/env python3
"""Mirror live the agent terminal output without corrupting the capture file.

The supervisor used to let ``script`` write directly to terminal.log while a
separate trimmer truncated that same file. ``script`` kept its old file offset
after truncation, which created sparse null-byte holes. This process owns both
append and trim, so the public diagnostics log stays a small current-events
surface rather than a corrupted persistence layer.
"""

import os
import pathlib
import sys
import time


TRIM_INTERVAL_SECONDS = 5.0


def _clean(chunk: bytes) -> bytes:
    return chunk.replace(b"\x00", b"")


def _trim(path: pathlib.Path, max_bytes: int) -> None:
    try:
        if max_bytes <= 0 or not path.exists() or path.stat().st_size <= max_bytes:
            return
        with path.open("rb") as handle:
            handle.seek(-max_bytes, os.SEEK_END)
            data = _clean(handle.read())
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    except OSError:
        return


def mirror(log_path: str, max_bytes: int) -> int:
    path = pathlib.Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    last_trim = time.monotonic()
    while True:
        chunk = sys.stdin.buffer.read1(8192)
        if not chunk:
            break
        chunk = _clean(chunk)
        if not chunk:
            continue
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        with path.open("ab") as log:
            log.write(chunk)
            log.flush()
        now = time.monotonic()
        if now - last_trim >= TRIM_INTERVAL_SECONDS:
            _trim(path, max_bytes)
            last_trim = now
    _trim(path, max_bytes)
    return 0


def main(argv) -> int:
    if len(argv) != 2:
        print("usage: terminal_mirror.py LOG_PATH MAX_BYTES", file=sys.stderr)
        return 2
    try:
        max_bytes = int(argv[1])
    except ValueError:
        max_bytes = 1_000_000
    return mirror(argv[0], max_bytes)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
