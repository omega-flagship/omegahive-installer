# Purpose: where earlier releases kept each connector's logins and session keys in plain files (LEGACY), how a LEGACY
# path is matched under a folder, and the installer's carry of those files out of a code folder it is about to delete,
# so the hive's next start imports them (connectors.py). Standard library only: the installer runs this file with its
# toolchain's bare Python, before the hive's own packages are installed.
"""The plain files earlier releases kept connector secrets in, and the installer's carry of them across an update.

Up to #443 a connector kept its secret in the code folder: a Home Assistant URL and token in memory/, a WhatsApp
pairing beside its bridge. The hive's start imports such files (connectors.ConnectorStore.import_legacy) from two
places: the data folder's connectors folder, then the code folder it runs from. An update made by the Mac or Windows
installer replaces the code folder and deletes the old one before the hive starts again, so a file the old one held
would go with it. `carry` runs first: it moves each such file to the same relative path in the connectors folder, or,
where that path is taken, in the new code folder, and reports any it could put in neither place, which the installer
then leaves where it is with the old folder.

    python3 -I hive/core/connector_files.py OLD_CODE_FOLDER DATA_FOLDER NEW_CODE_FOLDER

prints one line per path acted on and exits 0 when the old folder holds nothing more to carry, 1 when something stays.
"""
from __future__ import annotations

import errno
import fnmatch
import os
import pathlib
import shutil
import sys

FOLDER = "connectors"

# What a checkout's connectors kept in plain files, as (connector, entry, path relative to the checkout or the data
# folder's connectors folder, how to read it). The first file found for an entry is imported. A path's last part may
# be a glob, as the repository's .gitignore names the bridges' pairing folders (*auth*: auth, auth_<label>).
LEGACY = (
    ("home_assistant", "settings", "memory/home_assistant.json", "ha-json"),
    ("librelinkup", "settings", "modules/health_glucose/memory/librelinkup.json", "llu-json"),
    ("librelinkup", "settings", "memory/librelinkup.json", "llu-json"),
    ("librelinkup", "session", "modules/health_glucose/memory/librelinkup_cache.json", "llu-cache"),
    ("librelinkup", "session", "memory/librelinkup_cache.json", "llu-cache"),
    ("agentverse", "seed", "memory/runtime/agentverse/local_seed.txt", "seed"),
    ("whatsapp", "*", "modules/channel_whatsapp/src/whatsapp_bridge/*auth*", "baileys"),
    ("whatsapp", "*", "channels/whatsapp_bridge/*auth*", "baileys"),
)
MOVING = ".moving"   # the suffix of the copy #443's move staged beside each secret's place, as .<name>.moving


def folder_unlinked(root, parent):
    """`root`/`parent` when it is a folder reached through no link, else None."""
    where = pathlib.Path(root)
    for part in pathlib.PurePosixPath(parent).parts:
        where = where / part
        if where.is_symlink() or not where.is_dir():
            return None
    return where


def matches(root, rel):
    """What a LEGACY path names under `root`: the path itself, or, when its last part is a glob, every entry of its
    folder that part matches, sorted, never an interrupted move's .moving copy."""
    parent, _, name = rel.rpartition("/")
    if not any(c in name for c in "*?["):
        return [rel] if os.path.lexists(pathlib.Path(root) / rel) else []
    where = folder_unlinked(root, parent)
    return [] if where is None else [f"{parent}/{n}" for n in sorted(os.listdir(where))
                                     if fnmatch.fnmatchcase(n, name) and not n.endswith(MOVING)]


def _through_link(root, parent):
    """Whether a link stands on the way from `root` to its folder `parent`, so what is under it lives elsewhere."""
    where = pathlib.Path(root)
    for part in pathlib.PurePosixPath(parent).parts:
        where = where / part
        if where.is_symlink():
            return True
        if not where.is_dir():
            return False
    return False


def _reached(root, rel):
    """What a LEGACY path names under `root` when links are followed, as `matches` names it without them."""
    parent, _, name = rel.rpartition("/")
    where = pathlib.Path(root) / parent
    if not any(c in name for c in "*?["):
        return [rel] if os.path.lexists(where / name) else []
    return [f"{parent}/{n}" for n in sorted(os.listdir(where)) if fnmatch.fnmatchcase(n, name)] if where.is_dir() else []


def _make_folders(root, parent):
    """Make `root`, when it is missing, and each missing folder of `parent` under it the owner's alone (0700), as the
    connectors folder is, never passing through a link below `root`: a secret is never written where a link sends it."""
    where = pathlib.Path(root)
    if not where.exists():
        where.mkdir(mode=0o700)
    for part in pathlib.PurePosixPath(parent).parts:
        where = where / part
        if where.is_symlink():
            raise OSError(errno.ELOOP, f"{where} is a link")
        if not where.exists():
            where.mkdir(mode=0o700)
    return where


def _move(source, target):
    """Move `source` to `target` by rename. Across file systems, a copy staged beside `target` as .<name>.moving is
    renamed in before `source` goes, so a stopped move leaves the original where it was and at most a staged copy,
    which the hive's start removes from the connectors folder (connectors._unfinished_moves)."""
    try:
        os.rename(source, target)
        return
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
    staged = target.with_name(f".{target.name}{MOVING}")
    if staged.is_dir() and not staged.is_symlink():
        shutil.rmtree(staged)
    elif os.path.lexists(staged):
        staged.unlink()
    if source.is_dir() and not source.is_symlink():
        shutil.copytree(source, staged, symlinks=True)
    else:
        shutil.copy2(source, staged, follow_symlinks=False)
    os.rename(staged, target)
    if source.is_dir() and not source.is_symlink():
        shutil.rmtree(source)
    else:
        source.unlink()


# Time: one listing per LEGACY folder and one rename per file found, so nothing is read when none is left.
def carry(retired, data_dir, code_root):
    """Move every LEGACY path the code folder `retired` holds, which an installer is about to delete, to the same
    relative path in the data folder's connectors folder (`data_dir`/FOLDER), or, where that path is taken, in the code
    folder `code_root` that replaces it: the two places the hive's next start imports from, in that order. Returns one
    line per path acted on and how many stay in `retired`, because both places hold that path already or the move
    failed. A path reached through a link in `retired` lives where the link points, which deleting `retired` doesn't
    touch, and is only reported."""
    retired = pathlib.Path(retired)
    # Each place as (the folder its paths start from, the folders a carried path's own come under there).
    places = ((pathlib.Path(data_dir), FOLDER), (pathlib.Path(code_root), ""))
    lines, kept = [], 0
    for _connector, _entry, rel, _how in LEGACY:
        parent = rel.rpartition("/")[0]
        if folder_unlinked(retired, parent) is None:
            if _through_link(retired, parent):
                lines += [f"left {found}: a link in {retired} reaches it, and deleting {retired} keeps what it points to"
                          for found in _reached(retired, rel)]
            continue
        for found in matches(retired, rel):
            source, where = retired / found, found.rpartition("/")[0]
            free = [(base, prefix) for base, prefix in places if not os.path.lexists(base / prefix / found)]
            if not free:
                kept += 1
                lines.append(f"kept {found} in {retired}: {places[0][0] / FOLDER} and {places[1][0]} hold it already")
                continue
            base, prefix = free[0]
            target = base / prefix / found
            try:
                _make_folders(base, f"{prefix}/{where}".strip("/"))
                _move(source, target)
                lines.append(f"carried {found} to {target}")
            except OSError as exc:
                kept += 1
                lines.append(f"kept {found} in {retired}: {exc.strerror or exc}")
    return lines, kept


def main(argv):
    if len(argv) != 3:
        print("usage: connector_files.py OLD_CODE_FOLDER DATA_FOLDER NEW_CODE_FOLDER", file=sys.stderr)
        return 2
    lines, kept = carry(*argv)
    for line in lines:
        print(line)
    return 1 if kept else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
