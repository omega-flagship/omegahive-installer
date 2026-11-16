"""Remove known retired core files after copying V7 over an older checkout."""
from pathlib import Path
import hashlib
import json


def retire(root):
    root = Path(root).resolve()
    manifest = root / 'CORE_RETIRED_FILES.json'
    if not manifest.exists():
        return []
    pending = []
    conflicts = []
    for name, allowed in json.loads(manifest.read_text()).items():
        path = root / name
        if not path.exists() and not path.is_symlink():
            continue
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() not in allowed:
            conflicts.append(name)
        else:
            pending.append(path)
    # Preflight everything. Never partly clean a checkout containing unknown edits.
    if conflicts:
        raise RuntimeError('Retired core files contain unrecognized edits; nothing removed: ' + ', '.join(conflicts))
    for path in pending:
        path.unlink()
    return [str(path.relative_to(root)) for path in pending]
