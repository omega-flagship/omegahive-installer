#!/usr/bin/env python3
"""Build a source ZIP from Git's tracked file list, with dotfiles and Unix modes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def release_names(root=ROOT):
    """The tracked files a source release ships, sorted: every tracked path but RELEASE_FILES.json and the submodules.
    A submodule (third_party/Omega, iter, iter-metta) is tracked as a gitlink, a pinned commit rather than a file;
    core-dependency.json names the same pins and scripts/setup_core.py fetches them. Raises on a missing required file
    and on any generated or private tracked file, so a release never ships one."""
    entries = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-s', '-z']).decode().split('\0')
    # each entry is "<mode> <object> <stage>\t<path>"; mode 160000 is a gitlink
    names = sorted(path for meta, _, path in (e.partition('\t') for e in entries if e)
                   if not meta.startswith('160000 ') and path != 'RELEASE_FILES.json')
    for required in ('.gitignore', '.dockerignore', '.gitattributes', '.github/workflows/ci.yml'):
        if required not in names:
            raise RuntimeError('Missing required tracked file: ' + required)
    if not any(n.startswith('.tours/') for n in names):
        raise RuntimeError('Missing .tours files')
    for name in names:
        path = root / name
        if (set(Path(name).parts) & {'.git', '.runtime', '__pycache__', 'node_modules', '.DS_Store'}
                or name.startswith(('third_party/', 'memory/')) or path.suffix in ('.pyc', '.pyo', '.key', '.pem')
                or (path.name.startswith('.env') and not path.name.endswith('.example'))):
            raise RuntimeError('Refusing generated/private file: ' + name)
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Not a regular source file: ' + name)
    return names


def build(destination):
    names = release_names()
    manifest = {name: {'sha256': hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
                       'mode': oct((ROOT / name).stat().st_mode & 0o777)} for name in names}
    (ROOT / 'RELEASE_FILES.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in names + ['RELEASE_FILES.json']:
            path = ROOT / name
            info = zipfile.ZipInfo('omegahive/' + name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100000 | (path.stat().st_mode & 0o777)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
    print(f'{destination}: {len(names) + 1} files, SHA256 {hashlib.sha256(Path(destination).read_bytes()).hexdigest()}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/build_release.py /path/to/release.zip')
    build(Path(sys.argv[1]).resolve())
