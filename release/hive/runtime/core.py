"""Install and verify the Singnet dependency; prepare the native Hive hooks.

One version source: ``core-dependency.json`` names the repository, path and full revision. It travels with every
form of the tree (git checkout, git archive, release ZIP, export mirror). In a git checkout the ``third_party/Omega``
gitlink must equal it; ``verify`` and ``tests/test_core_dependency.py`` refuse a mismatch, so the two cannot drift.

Git runs only at setup and in the hive process when the dependency changed. A mind never runs git: it checks the
dependency's content digest against the stamp the hive process wrote after its full git check (``stamp_path``).
Minds run inside the OS sandbox, where git cannot read its config (macOS: Apple's /usr/bin/git shim also needs a
cache under /var/folders), so a git call there would stop the mind from booting.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import os

ROOT = Path(__file__).resolve().parents[2]
STAMP = 'dependency.json'
_IGNORED_PARTS = {'__pycache__'}


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'safe.directory=' + str(Path(root).resolve()), '-C', str(root), *args],
                                   text=True, env=dict(os.environ, GIT_OPTIONAL_LOCKS='0')).strip()


def specification(root=ROOT):
    spec = json.loads((Path(root) / 'core-dependency.json').read_text())
    revision = str(spec.get('revision', ''))
    if len(revision) != 40 or any(c not in '0123456789abcdef' for c in revision):
        raise RuntimeError('core-dependency.json revision must be a full 40-character commit sha')
    return spec


def content_digest(dependency):
    """sha256 over the dependency's files (paths, modes and bytes), without its git metadata or bytecode caches."""
    dependency = Path(dependency)
    h = hashlib.sha256()
    for path in sorted(dependency.rglob('*')):
        relative = path.relative_to(dependency)
        if relative.parts[0] == '.git' or _IGNORED_PARTS & set(relative.parts) or path.suffix in ('.pyc', '.pyo'):
            continue
        if path.is_symlink():
            h.update(b'L' + str(relative).encode() + b'\0' + os.readlink(path).encode() + b'\0')
        elif path.is_file():
            h.update(b'F' + str(relative).encode() + b'\0' + oct(path.stat().st_mode & 0o111).encode() + b'\0')
            h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()


def stamp_path(root=ROOT):
    from hive.runtime.native_core import runtime_directory
    return runtime_directory(root) / STAMP


def _retired_check(root):
    retired = Path(root) / 'CORE_RETIRED_FILES.json'
    if retired.exists():
        remaining = [name for name in json.loads(retired.read_text()) if (Path(root) / name).exists()]
        if remaining:
            raise RuntimeError('Retired embedded core files remain; run python3 scripts/setup_core.py: ' + ', '.join(remaining))


def gitlink_revision(root=ROOT):
    """The superproject's recorded commit for the dependency path, or None outside a git checkout."""
    root = Path(root)
    if not (root / '.git').exists():
        return None
    spec = specification(root)
    try:
        line = git(root, 'ls-files', '--stage', '--', spec['path'])
    except (OSError, subprocess.CalledProcessError):
        return None
    if not line.startswith('160000 '):
        return None
    return line.split()[1]


def _git_verify(root, spec, dependency):
    if not (dependency / '.git').exists():
        raise RuntimeError('Missing Omega dependency. Run python3 scripts/setup_core.py')
    if git(dependency, 'rev-parse', 'HEAD') != spec['revision']:
        raise RuntimeError('Omega revision differs from core-dependency.json; run python3 scripts/setup_core.py')
    changes = [line for line in git(dependency, 'status', '--porcelain', '--untracked-files=all').splitlines()
               if not (_IGNORED_PARTS & set(Path(line[3:].strip('"')).parts) or line.endswith(('.pyc', '.pyo')))]
    if changes:
        raise RuntimeError('Omega dependency has local changes; refusing to overwrite them')
    link = gitlink_revision(root)
    if link is not None and link != spec['revision']:
        raise RuntimeError('third_party/Omega gitlink ' + link + ' differs from core-dependency.json; '
                           'one version source: update both in the same commit')


def verify(root=ROOT, use_git=True):
    """Return the dependency path after checking it matches the pin.

    use_git=True (setup, hive process): full git check (revision, clean tree, gitlink equals the pin).
    use_git=False (inside a mind): content digest against the stamp the hive process recorded; no subprocess.
    """
    root = Path(root)
    _retired_check(root)
    spec = specification(root)
    dependency = root / spec['path']
    if use_git:
        _git_verify(root, spec, dependency)
        return dependency
    try:
        stamp = json.loads(stamp_path(root).read_text())
    except (OSError, ValueError):
        raise RuntimeError('Omega dependency not verified on this host. Run python3 scripts/setup_core.py')
    if stamp.get('revision') != spec['revision']:
        raise RuntimeError('Omega revision differs from core-dependency.json; run python3 scripts/setup_core.py')
    if not dependency.is_dir() or stamp.get('digest') != content_digest(dependency):
        raise RuntimeError('Omega dependency changed since it was verified; run python3 scripts/setup_core.py')
    return dependency


def verify_and_stamp(root=ROOT):
    """Hive-process check: reuse a matching stamp, else run the full git check once and record the digest."""
    root = Path(root).resolve()
    try:
        return verify(root, use_git=False)
    except RuntimeError:
        pass
    dependency = verify(root, use_git=True)
    spec = specification(root)
    path = stamp_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    temporary.write_text(json.dumps({'revision': spec['revision'], 'digest': content_digest(dependency)}, indent=2) + '\n')
    temporary.replace(path)
    return dependency


def initialize(root=ROOT, source=None):
    """Fetch or move the dependency to the pinned revision; never commit, stage or reset the user's work.

    source: optional local clone, bare repository or git bundle to fetch from instead of the pinned repository URL
    (offline hosts, cloud deploys that ship a bundle). The pinned revision is checked either way.
    """
    root = Path(root).resolve()
    spec = specification(root)
    dependency = root / spec['path']
    origin = str(source) if source else spec['repository']
    # The dependency has its own Git metadata. Never initialize, stage, or
    # reconfigure the parent checkout (ZIP installs need no parent Git repo).
    if not (dependency / '.git').exists():
        if dependency.exists() and any(dependency.iterdir()):
            raise RuntimeError('Nonempty dependency directory; refusing to overwrite it')
        dependency.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '-q', origin, str(dependency)], check=True)
        if source:
            subprocess.run(['git', '-C', str(dependency), 'remote', 'set-url', 'origin', spec['repository']], check=True)
    head = git(dependency, 'rev-parse', 'HEAD^{commit}') if _has_head(dependency) else None
    if head != spec['revision']:
        if head and git(dependency, 'status', '--porcelain', '--untracked-files=no'):
            raise RuntimeError('Omega dependency has local changes; refusing to move it to the pinned revision')
        if subprocess.run(['git', '-C', str(dependency), 'cat-file', '-e', spec['revision'] + '^{commit}'],
                          capture_output=True).returncode != 0:
            subprocess.run(['git', '-C', str(dependency), 'fetch', '-q', origin, spec['revision']], check=True)
        subprocess.run(['git', '-C', str(dependency), '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach',
                        spec['revision']], check=True)
    verify_and_stamp(root)
    if source is None:
        # Iter is pinned beside Omega (core-dependency.json "iter" and "iter_metta"). A host that passes a
        # source is offline and brings Omega alone; it gets Iter when its first Iter mind is made
        # (Workspace.iter_source).
        initialize_iter(root)
        initialize_iter(root, 'iter_metta')
    return dependency


def write_bundle(root, destination):
    """Write a git bundle holding exactly the pinned revision, for hosts that fetch with --source (no network)."""
    root = Path(root).resolve()
    dependency = verify(root, use_git=True)
    destination = Path(destination).resolve()
    subprocess.run(['git', '-C', str(dependency), 'bundle', 'create', '-q', str(destination), 'HEAD'], check=True,
                   capture_output=True)
    return destination


def _has_head(dependency):
    return subprocess.run(['git', '-C', str(dependency), 'rev-parse', '-q', '--verify', 'HEAD^{commit}'],
                          capture_output=True).returncode == 0


def verify_iter(root=ROOT, key='iter'):
    """A pinned Iter clone (core-dependency.json "iter" or "iter_metta"): present, at its revision, unmodified."""
    spec = specification(root).get(key)
    if not spec:
        return None
    dependency = Path(root) / spec['path']
    if not (dependency / '.git').exists():
        raise RuntimeError(f'Missing Iter dependency {spec["path"]}. Run python3 scripts/setup_core.py')
    if git(dependency, 'rev-parse', 'HEAD') != spec['revision']:
        raise RuntimeError(f'Iter revision of {spec["path"]} differs from core-dependency.json; refusing to reset it')
    if git(dependency, 'status', '--porcelain', '--untracked-files=all'):
        raise RuntimeError(f'Iter dependency {spec["path"]} has local changes; refusing to overwrite them')
    return dependency


def initialize_iter(root=ROOT, key='iter'):
    """Clone a pinned Iter like Omega; never commit or reset the user's work."""
    root = Path(root).resolve()
    spec = specification(root).get(key)
    if not spec:
        return None
    dependency = root / spec['path']
    if not (dependency / '.git').exists():
        if dependency.exists() and any(dependency.iterdir()):
            raise RuntimeError(f'Nonempty Iter dependency directory {spec["path"]}; refusing to overwrite it')
        dependency.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '-b', spec.get('branch', 'master'), spec['repository'], str(dependency)], check=True)
        subprocess.run(['git', '-C', str(dependency), 'checkout', '--detach', spec['revision']], check=True)
    return verify_iter(root, key)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compose(root, cache):
    root = Path(root).resolve()
    if not (root / 'core-dependency.json').exists():
        return root
    from hive.runtime.native_core import prepare
    prepare(root)
    return root
