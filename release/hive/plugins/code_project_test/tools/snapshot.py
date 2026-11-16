"""Bounded data format shared by the host and its pinned sandbox launcher.

This module conveys no execution authority. The Code host adapter must obtain
source through the authenticated service and validate the request and budget.
It does not extract archives or follow project-provided links.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import unicodedata

SCHEMA = 'hive-code-project-snapshot/1'
MAX_INPUT = 20 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
MAX_FILES = 2000
MAX_SOURCE = 15 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{64}')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _hex(value):
    if not isinstance(value, str):
        raise ValueError('digest must be a string')
    value = value.removeprefix('sha256:')
    if HEX.fullmatch(value) is None:
        raise ValueError('invalid sha256 digest')
    return value


def _path(value):
    if (not isinstance(value, str) or not value or len(value.encode('utf-8')) > 1024
            or unicodedata.normalize('NFC', value) != value or '\\' in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('invalid project path')
    pieces = value.split('/')
    if (len(pieces) > 32 or any(p in ('', '.', '..') or unicodedata.normalize('NFD', p).casefold() == '.git' for p in pieces)
            or PurePosixPath(value).is_absolute()):
        raise ValueError('project path must be a plain relative file')
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _command(argv, interpreter):
    if (not isinstance(interpreter, str) or not os.path.isabs(interpreter)
            or '\x00' in interpreter or not isinstance(argv, list)
            or not 1 <= len(argv) <= 32 or argv[0] != interpreter
            or any(not isinstance(a, str) or not a or '\x00' in a
                   or len(a.encode('utf-8')) > 4096 for a in argv)):
        raise ValueError('exact configured interpreter and argv required')


def _validate(payload):
    if (not isinstance(payload, dict) or set(payload) != {
            'schema', 'binding', 'manifest', 'tree_digest', 'argv', 'interpreter', 'files'}
            or payload['schema'] != SCHEMA or not isinstance(payload['binding'], dict)
            or not payload['binding'] or len(canonical(payload['binding'])) > 65536):
        raise ValueError('invalid snapshot shape')
    _command(payload['argv'], payload['interpreter'])
    manifest = payload['manifest']
    if (not isinstance(manifest, dict) or set(manifest) != {'files'}
            or not isinstance(manifest['files'], dict)
            or not isinstance(payload['files'], dict)
            or set(manifest['files']) != set(payload['files'])
            or len(payload['files']) > MAX_FILES
            or digest(canonical(manifest)) != _hex(payload['tree_digest'])):
        raise ValueError('snapshot tree mismatch')
    names = set(payload['files'])
    output = {}
    total = 0
    # Portable snapshots refuse aliases of any directory prefix as well as
    # leaves. Linux is intentionally restricted to the same portable namespace.
    prefixes = {}
    for name in sorted(names):
        _path(name)
        parts = name.split('/')
        for count in range(1, len(parts)+1):
            prefix = '/'.join(parts[:count])
            folded = unicodedata.normalize('NFD', prefix).casefold()
            if folded in prefixes and prefixes[folded] != prefix:
                raise ValueError('portable path prefix alias')
            prefixes[folded] = prefix
        if any('/'.join(name.split('/')[:i]) in names for i in range(1, len(name.split('/')))):
            raise ValueError('file and directory collide')
        meta = manifest['files'][name]
        if (not isinstance(meta, dict) or set(meta) != {'digest', 'size', 'executable'}
                or type(meta['size']) is not int or not 0 <= meta['size'] <= MAX_FILE
                or type(meta['executable']) is not bool
                or not isinstance(payload['files'][name], str)):
            raise ValueError('invalid file metadata')
        encoded = payload['files'][name]
        if len(encoded) > 4 * ((MAX_FILE + 2) // 3):
            raise ValueError('encoded file exceeds limit')
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ValueError('invalid file encoding') from exc
        if (len(data) != meta['size'] or digest(data) != _hex(meta['digest'])
                or base64.b64encode(data).decode('ascii') != encoded):
            raise ValueError('snapshot file mismatch')
        total += len(data)
        if total > MAX_SOURCE:
            raise ValueError('snapshot source limit')
        output[name] = data
    return output


def encode_snapshot(binding, manifest, files, argv, interpreter, *, expected_tree_digest):
    """Serialize already-authorized bytes, without granting access to any path."""
    if (not isinstance(files, dict) or len(files) > MAX_FILES
            or any(type(v) is not bytes or len(v) > MAX_FILE for v in files.values())
            or sum(map(len, files.values())) > MAX_SOURCE):
        raise ValueError('invalid snapshot source')
    payload = dict(schema=SCHEMA, binding=binding, manifest=manifest,
                   tree_digest=_hex(expected_tree_digest), argv=argv, interpreter=interpreter,
                   files={k: base64.b64encode(v).decode('ascii') for k, v in files.items()})
    raw = canonical(payload)
    if len(raw) > MAX_INPUT:
        raise ValueError('snapshot exceeds existing sandbox input cap')
    _validate(payload)
    return raw


def decode_snapshot(raw, *, expected_digest=None):
    if type(raw) is not bytes or len(raw) > MAX_INPUT:
        raise ValueError('snapshot input limit')
    if expected_digest is not None and digest(raw) != _hex(expected_digest):
        raise ValueError('snapshot digest mismatch')
    try:
        payload = json.loads(raw, object_pairs_hook=_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
    except (UnicodeError, RecursionError, TypeError) as exc:
        raise ValueError('invalid snapshot JSON') from exc
    if canonical(payload) != raw:
        raise ValueError('snapshot must use canonical JSON')
    return payload, _validate(payload)


def unpack_snapshot(raw, destination, *, expected_digest=None):
    """Called by the reviewed launcher INSIDE the sandbox, before project execution.

    The destination must be absent in the fresh job. Creation is exclusive and
    no-follow; case-folding filesystem collisions refuse instead of overwriting.
    The runner owns cleanup of a partial or failed job.
    """
    payload, files = decode_snapshot(raw, expected_digest=expected_digest)
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, data in files.items():
        target = destination.joinpath(*name.split('/'))
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
            os.fchmod(fd, 0o700 if payload['manifest']['files'][name]['executable'] else 0o600)
        finally:
            os.close(fd)
    return payload
