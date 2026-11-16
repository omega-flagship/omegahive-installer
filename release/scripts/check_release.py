#!/usr/bin/env python3
"""Verify a V8 source copy, including hidden files and executable permissions."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fix-modes', action='store_true', help='Restore shipped executable modes only')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / 'RELEASE_FILES.json').read_text())
    errors = []
    for name, info in manifest.items():
        path = root / name
        if not path.is_file() or path.is_symlink():
            errors.append('Missing regular file: ' + name)
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != info['sha256']:
            errors.append('Changed file: ' + name)
        mode = int(info['mode'], 8)
        if sys.platform != 'win32' and path.stat().st_mode & 0o777 != mode:
            if args.fix_modes:
                path.chmod(mode)
            else:
                errors.append('Wrong permissions: ' + name + '; use --fix-modes')
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'Verified {len(manifest)} release files, including hidden files and modes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
