#!/bin/sh
# One downloaded script. The published artifact embeds the reviewed bundle.
# This Source template deliberately refuses before filesystem or sudo effects.
set -eu
ROOT_BOUND_RELEASE=0
BUNDLE_BYTES=0
BUNDLE_SHA256=UNBOUND

if [ "$ROOT_BOUND_RELEASE" != 1 ]; then
    printf '%s\n' 'This OmegaHive installer is a review copy and has not been published yet.' >&2
    exit 64
fi
if [ "$#" -ne 0 ]; then
    printf '%s\n' 'Run the installer on its own, with nothing after it. Once it’s installed, use: omegahive open' >&2
    exit 64
fi
umask 077
unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME
exec /usr/bin/python3 -I -B -S - "$0" "$BUNDLE_BYTES" "$BUNDLE_SHA256" <<'PY'
import base64
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import tempfile

def refuse():
    print('This download is damaged or incomplete. Please download the installer again.', file=sys.stderr)
    raise SystemExit(64)

def installer_environment(ambient):
    value = {'HOME': ambient.get('HOME', ''), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'):
        if name in ambient:
            value[name] = ambient[name]
    return value

script, size, digest = sys.argv[1:]
if not size.isdecimal() or not 0 < int(size) <= 64 * 1024**2 or not re.fullmatch('[a-f0-9]{64}', digest):
    refuse()
fd = os.open(script, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 96 * 1024**2:
        refuse()
    with os.fdopen(fd, 'rb', closefd=False) as source:
        body = source.read(96 * 1024**2 + 1)
finally:
    os.close(fd)
marker = b'\n__OMEGAHIVE_BUNDLE_BASE64__\n'
if body.count(marker) != 1:
    refuse()
try:
    raw = base64.b64decode(body.split(marker, 1)[1].strip(), validate=True)
except Exception:
    refuse()
if len(raw) != int(size) or hashlib.sha256(raw).hexdigest() != digest:
    refuse()
root = Path(tempfile.mkdtemp(prefix='omegahive-installer-'))
seen = set()
total = 0
try:
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as bundle:
        count = 0
        for member in bundle:
            count += 1
            if count > 128:
                refuse()
            name = member.name
            rel = PurePosixPath(name)
            if (not member.isfile() or rel.is_absolute() or str(rel) != name or '..' in rel.parts
                    or '\\' in name or '\x00' in name or name in seen
                    or not 0 <= member.size <= 64 * 1024**2):
                refuse()
            seen.add(name)
            total += member.size
            if total > 128 * 1024**2:
                refuse()
            destination = root / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                refuse()
            remaining = member.size
            with source, destination.open('xb') as out:
                while remaining:
                    block = source.read(min(65536, remaining))
                    if not block:
                        refuse()
                    out.write(block)
                    remaining -= len(block)
                if source.read(1):
                    refuse()
                out.flush()
                os.fsync(out.fileno())
            destination.chmod(0o600)
        if count == 0:
            refuse()
    if not {'install.py', 'release-manifest.json'} <= seen:
        refuse()
    os.execve(sys.executable, [sys.executable, '-I', '-B', '-S', str(root / 'install.py'),
                             'install', '--bundle', str(root)], installer_environment(os.environ))
except (OSError, tarfile.TarError, ValueError):
    refuse()
PY
__OMEGAHIVE_BUNDLE_BASE64__
