#!/usr/bin/env python3
"""Install the pinned Singnet dependency, or check it without writes."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hive.runtime.core import ROOT, compose, initialize, verify, verify_iter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--source', help='local clone, bare repository or git bundle to fetch the pinned revision from '
                                         '(offline hosts); the revision in core-dependency.json is checked either way')
    parser.add_argument('--bundle', type=Path, help='write a git bundle of the pinned revision to this path and exit')
    args = parser.parse_args()
    if args.bundle:
        from hive.runtime.core import write_bundle
        print(write_bundle(ROOT, args.bundle))
        return
    if args.cache:
        import os
        os.environ["OMEGACLAW_RUNTIME_CACHE"] = str(args.cache.expanduser().resolve())
    from hive.runtime.native_core import prepare, loop_path
    if args.verify:
        print(verify(ROOT))
        print(verify_iter(ROOT))
        print(verify_iter(ROOT, 'iter_metta'))
        print(loop_path())
    else:
        from hive.runtime.migration import retire
        for name in retire(ROOT):
            print("Removed retired core file:", name)
        print(initialize(ROOT, source=args.source))
        print(prepare(ROOT))
    if args.cache and not args.verify:
        print(compose(ROOT, args.cache))


if __name__ == '__main__':
    main()
