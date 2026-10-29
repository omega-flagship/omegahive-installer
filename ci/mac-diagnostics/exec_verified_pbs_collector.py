"""Verify the fixed prepared PBS before executing the exact sealed collector.

Source candidate only. The workflow must authenticate this helper first. Missing
bootstrap bytes fail closed; the independent metadata fallback runs earlier.
"""
from pathlib import Path
import argparse
import hashlib
import os
import re
import resource
import signal
import stat
import sys
import time

PBS = Path('/private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12')
PBS_BYTES = 18652104
PBS_SHA256 = 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'
COLLECTOR_BYTES = 31539
COLLECTOR_SHA256 = 'c50bcb59496668389d15aec2c060cb6c38f69cc323da251a1e801c8afd17395a'
WALL_SECONDS = 15
RSS_BYTES = 128 * 1024**2
STARTED = None


class Refused(RuntimeError):
    pass


def need(ok):
    if not ok:
        raise Refused('preexec_PBS_or_collector_verification_refused')


def tick():
    need(STARTED is not None and 0 <= time.monotonic() - STARTED < WALL_SECONDS)
    need(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss <= RSS_BYTES)


def cancelled(_signum, _frame):
    raise Refused('preexec_cancel_or_original_alarm')


def directory_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid)


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def held_file(path, expected_bytes, expected_sha256, executable):
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)))
    need(type(expected_bytes) is int and 0 < expected_bytes <= 32 * 1024**2)
    chain, leaf = [], None
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        chain.append((None, '/', fd, directory_key(os.fstat(fd))))
        current = Path('/')
        for part in path.parts[1:-1]:
            tick()
            parent = fd
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
            current /= part
            info = os.fstat(fd)
            chain.append((parent, part, fd, directory_key(info)))
            shared_tmp = (current == Path('/private/tmp') and info.st_uid == 0
                          and stat.S_IMODE(info.st_mode) == 0o1777)
            need(info.st_uid in {0, os.getuid()}
                 and (info.st_mode & 0o022 == 0 or shared_tmp))
        leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                       dir_fd=fd)
        before = os.fstat(leaf)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid in {0, os.getuid()} and before.st_mode & 0o022 == 0
             and before.st_size == expected_bytes
             and (not executable or before.st_mode & 0o111 != 0))
        hasher, count = hashlib.sha256(), 0
        while True:
            tick()
            block = os.read(leaf, min(65536, expected_bytes + 1 - count))
            if not block:
                break
            count += len(block)
            need(count <= expected_bytes)
            hasher.update(block)
        need(count == expected_bytes and hasher.hexdigest() == expected_sha256)
        value = (path, chain, leaf, file_key(before))
        unchanged(value)
        return value
    except BaseException:
        close_descriptors([leaf] + [row[2] for row in reversed(chain)])
        raise


def close_descriptors(descriptors):
    failed = False
    for fd in descriptors:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                failed = True
    need(not failed)


def unchanged(value):
    path, chain, leaf, identity = value
    tick()
    for parent, name, fd, wanted in chain:
        need(directory_key(os.fstat(fd)) == wanted)
        if parent is not None:
            need(directory_key(os.stat(name, dir_fd=parent,
                                       follow_symlinks=False)) == wanted)
    need(file_key(os.fstat(leaf)) == identity
         == file_key(os.stat(path.name, dir_fd=chain[-1][2],
                             follow_symlinks=False)))


def main(argv=None):
    global STARTED
    STARTED = time.monotonic()
    need(sys.platform == 'darwin' and sys.flags.isolated and sys.flags.no_site
         and sys.dont_write_bytecode and not sys.flags.optimize)
    need(os.environ.get('PATH') == '/usr/bin:/bin:/usr/sbin:/sbin'
         and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.getuid() == os.geteuid() != 0)
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(number, cancelled)
    signal.alarm(WALL_SECONDS)
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--collector-root', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args(argv)
    need(args.collector_root.is_absolute()
         and args.collector_root.parts[-2:] == ('ci', 'mac-collect')
         and str(args.collector_root) == os.path.normpath(str(args.collector_root))
         and re.fullmatch('[a-f0-9]{64}', args.manifest_sha256))
    script = args.collector_root / 'collector_entry.py'
    held = []
    try:
        interpreter = held_file(PBS, PBS_BYTES, PBS_SHA256, True)
        held.append(interpreter)
        collector = held_file(script, COLLECTOR_BYTES, COLLECTOR_SHA256, False)
        held.append(collector)
        unchanged(collector)
        unchanged(interpreter)
        # Exec inherits no held descriptors (Python opens them non-inheritable).
        # The unchanged caller performs its own executable and source checks again.
        signal.alarm(0)
        os.execv(str(PBS), [str(PBS), '-I', '-B', '-S', str(script),
                           '--source-manifest', str(args.collector_root / 'MANIFEST.sha256'),
                           '--expected-manifest-sha256', args.manifest_sha256,
                           '--owner', 'dot-mac-ci', '--dedicated-ci-job', '--run'])
    finally:
        close_descriptors([fd for value in reversed(held)
                           for fd in [value[2]] + [row[2] for row in reversed(value[1])]])


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('PREEXEC_PBS_COLLECTOR_REFUSED', file=sys.stderr)
        raise SystemExit(1)
