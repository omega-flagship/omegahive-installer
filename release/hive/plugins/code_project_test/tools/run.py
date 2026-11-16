"""Pinned Python launcher. Run only through the existing sandbox:run boundary."""
import os
from pathlib import Path
import sys

from snapshot import MAX_INPUT, unpack_snapshot


def main():
    if len(sys.argv) != 2:
        raise ValueError('original host snapshot digest required')
    job = Path.cwd()
    # Flat runner input, read before any project code. No artifact is treated as
    # execution authentication; the host records its own original binding/result.
    fd = os.open(job/'snapshot.json', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'rb', closefd=False) as source:
            raw = source.read(MAX_INPUT + 1)
    finally:
        os.close(fd)
    payload = unpack_snapshot(raw, job/'project', expected_digest=sys.argv[1])
    if payload['interpreter'] != sys.executable:
        raise ValueError('configured sandbox Python differs from the bound runtime')
    os.chdir(job/'project')
    # Same process: the strict macOS mode can deny fork. Tests needing child
    # processes are explicitly unsupported in that mode, never run unsandboxed.
    os.execv(sys.executable, payload['argv'])


if __name__ == '__main__':
    main()
