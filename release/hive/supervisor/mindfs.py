"""Purpose: the hive's own reads and writes inside a mind's folder, without following anything the mind planted.

A mind runs OS-sandboxed and may write anything inside its folder (<data>/agents/<id>/), symlinks and hard links
included. The hive process is not sandboxed, so a plain open(root / "agent.log", "ab") made by the hive follows a link
the mind left there and writes (or reads, or deletes) a file anywhere the hive user can reach. Every hive access to a
path inside a mind folder goes through this module instead.

The rules, the same on Linux and macOS (openat-style calls with dir_fd and O_NOFOLLOW exist on both):
  * the mind root is created by the hive under agents_dir (not mind-writable); it is opened with O_NOFOLLOW and must be
    a real directory owned by the hive user;
  * every directory below it is opened one component at a time (O_DIRECTORY | O_NOFOLLOW, dir_fd of its parent): a
    component that is a symlink or not a directory is refused (UnsafeMindPath), or replaced where the caller asks
    (copy_tree); a missing one is created with mkdir(dir_fd=..., 0o700) and reopened the same way;
  * a file the hive writes whole is written to a fresh temporary name in the verified directory
    (O_CREAT | O_EXCL | O_NOFOLLOW, 0o600) and renamed over the final name (os.replace with dir fds): a rename replaces
    the directory entry itself, so an existing link is never written through;
  * a file the hive writes in place (agent.log, credential files) is opened with O_NOFOLLOW | O_NONBLOCK at the
    verified directory, then fstat-ed: anything but a regular file with one link, owned by the hive user, is unlinked
    (never followed) and created afresh with O_EXCL;
  * a file the hive reads is opened with O_RDONLY | O_NOFOLLOW | O_NONBLOCK and must be a regular file with one link
    (a hard link may point at any hive-user file), else UnsafeMindPath;
  * a symlink the hive makes is created under a temporary name inside the verified directory and renamed into place,
    which never replaces a real directory; removals unlink links and never descend them (shutil.rmtree with dir_fd).

UnsafeMindPath is an OSError, so callers that already treat an unreadable file as missing keep doing so.
"""

from __future__ import annotations

import contextlib
import errno
import fcntl
import os
import pathlib
import secrets
import shutil
import stat

__all__ = [
    "UnsafeMindPath", "LinkedWorkspaceFile", "ensure_root", "open_root", "open_dir", "ensure_dir", "require_dir", "lstat", "lexists",
    "listdir", "read_bytes", "read_text", "tail_bytes", "open_read", "open_source", "open_write", "open_rw", "write_bytes",
    "write_text", "symlink", "readlink", "unlink", "remove_tree", "replace", "copy_file", "copy_tree", "iter_files",
    "require_file", "require_contained_links",
]

_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_NOCTTY = getattr(os, "O_NOCTTY", 0)
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | _CLOEXEC
_LINK_ERRNOS = {errno.ELOOP, errno.ENOTDIR, errno.EMLINK, errno.ENXIO, errno.EISDIR, errno.EOPNOTSUPP,
                getattr(errno, "EFTYPE", errno.ELOOP)}
_RETRIES = 8


class UnsafeMindPath(OSError):
    """A path inside a mind folder that the hive will not follow: a symlink, a hard link, a non-regular file, a
    directory component that is not a real directory, or a root the hive does not own."""

    def __init__(self, message):
        super().__init__(errno.ELOOP, message)


class LinkedWorkspaceFile(UnsafeMindPath):
    """A regular workspace file has another name outside the writable tree."""

    def __init__(self, relative):
        super().__init__(f"{str(relative)!r} has a hard link outside the writable workspace")


def _parts(rel):
    """The components of a relative path inside a mind folder; '' is the root itself."""
    if rel in ("", None):
        return ()
    text = os.fspath(rel)
    if "\0" in text or text.startswith("/"):
        raise ValueError(f"not a relative mind path: {text!r}")
    parts = tuple(p for p in text.split("/") if p not in ("", "."))
    if any(p == ".." for p in parts):
        raise ValueError(f"not a relative mind path: {text!r}")
    return parts


def _split(rel):
    parts = _parts(rel)
    if not parts:
        raise ValueError("a file path inside the mind folder is needed, not the folder itself")
    return parts[:-1], parts[-1]


def _lstat_at(dirfd, name):
    try:
        return os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def ensure_root(root):
    """Create the mind root if it is missing (its parents are the hive's own), then verify it. Returns the Path."""
    root = pathlib.Path(root)
    os.close(open_root(root, create=True))
    return root


def open_root(root, create=False):
    """An fd for the mind root: a real directory (the last component is never followed) owned by the hive user.
    create: a missing root is made first (0o700); its parents are the hive's own (agents_dir), made as usual."""
    if create:
        root = pathlib.Path(root)
        root.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.mkdir(root, 0o700)
        except FileExistsError:
            pass
    fd = _open_directory_path(root)
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
        os.close(fd)
        raise UnsafeMindPath(f"{root} is not a directory owned by the hive user")
    return fd


def _open_directory_path(path):
    try:
        return os.open(path, _DIR_FLAGS)
    except OSError as exc:
        if exc.errno in _LINK_ERRNOS:
            raise UnsafeMindPath(f"{path} is not a real directory") from None
        raise


def _child_dir(parent_fd, name, create, replace_links=False):
    """Open one directory component below parent_fd, never following it."""
    for _ in range(_RETRIES):
        try:
            fd = os.open(name, _DIR_FLAGS, dir_fd=parent_fd)
        except FileNotFoundError:
            if not create:
                raise
            try:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
            continue
        except OSError as exc:
            if exc.errno not in _LINK_ERRNOS:
                raise
            st = _lstat_at(parent_fd, name)
            if replace_links and st is not None and not stat.S_ISDIR(st.st_mode):
                os.unlink(name, dir_fd=parent_fd)          # the link itself, never what it points to
                continue
            raise UnsafeMindPath(f"{name} is not a real directory inside the mind folder") from None
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode):
            os.close(fd)
            raise UnsafeMindPath(f"{name} is not a real directory inside the mind folder")
        return fd
    raise UnsafeMindPath(f"{name} kept changing while the hive opened it")


def _walk(root_fd, parts, create, replace_links=False):
    """An fd for root/parts (the caller closes it); root_fd stays open."""
    fd = os.dup(root_fd)
    try:
        for name in parts:
            nxt = _child_dir(fd, name, create, replace_links)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_dir(root, rel="", create=False, replace_links=False):
    """An fd for a verified directory inside the mind folder (the caller closes it)."""
    rfd = open_root(root, create)
    try:
        return _walk(rfd, _parts(rel), create, replace_links)
    finally:
        os.close(rfd)


@contextlib.contextmanager
def _dir(root, parts, create=False, replace_links=False, *, source=False):
    rfd = _open_directory_path(root) if source else open_root(root, create)
    try:
        fd = _walk(rfd, parts, create, replace_links)
    finally:
        os.close(rfd)
    try:
        yield fd
    finally:
        os.close(fd)


def ensure_dir(root, rel):
    """Create (0o700) any missing directories of root/rel; a symlinked or non-directory component is refused."""
    os.close(open_dir(root, rel, create=True))


def require_dir(root, rel):
    """root/rel exists and is a real directory reached without links (refused otherwise)."""
    os.close(open_dir(root, rel))


def lstat(root, rel):
    """lstat of root/rel through verified directories, or None when it (or a directory on the way) is missing."""
    parents, name = _split(rel)
    try:
        with _dir(root, parents) as d:
            return _lstat_at(d, name)
    except FileNotFoundError:
        return None


def lexists(root, rel):
    return lstat(root, rel) is not None


def listdir(root, rel=""):
    with _dir(root, _parts(rel)) as d:
        return os.listdir(d)


def _check_read(fd, name):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise UnsafeMindPath(f"{name} is not a plain file inside the mind folder")
    return st


def _open_read_at(dirfd, name, flags=os.O_RDONLY):
    try:
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK | _NOCTTY | _CLOEXEC, dir_fd=dirfd)
    except OSError as exc:
        if exc.errno in _LINK_ERRNOS:
            raise UnsafeMindPath(f"{name} is not a plain file inside the mind folder") from None
        raise
    try:
        _check_read(fd, name)
        _blocking(fd)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _blocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    if flags & os.O_NONBLOCK:
        fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)


def open_read(root, rel):
    """A read-only fd for a regular, singly linked file root/rel (the caller closes it)."""
    parents, name = _split(rel)
    with _dir(root, parents) as d:
        return _open_read_at(d, name)


def open_source(root, rel):
    """Open a plain, singly linked input below a trusted, possibly root-owned source directory."""
    parents, name = _split(rel)
    with _dir(root, parents, source=True) as d:
        return _open_read_at(d, name)


def open_rw(root, rel):
    """A read-write fd for an existing regular, singly linked file owned by the hive user (no create, no follow)."""
    parents, name = _split(rel)
    with _dir(root, parents) as d:
        fd = _open_read_at(d, name, os.O_RDWR)
        if os.fstat(fd).st_uid != os.geteuid():
            os.close(fd)
            raise UnsafeMindPath(f"{name} is not owned by the hive user")
        return fd


def read_bytes(root, rel, limit=None):
    fd = open_read(root, rel)
    try:
        chunks, left = [], limit
        while left is None or left > 0:
            chunk = os.read(fd, 1 << 20 if left is None else min(1 << 20, left))
            if not chunk:
                break
            chunks.append(chunk)
            if left is not None:
                left -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def read_text(root, rel, encoding="utf-8", errors="strict"):
    return read_bytes(root, rel).decode(encoding, errors)


def tail_bytes(root, rel, size):
    """The last `size` bytes of a regular, singly linked file (FileNotFoundError when it is missing)."""
    fd = open_read(root, rel)
    try:
        end = os.lseek(fd, 0, os.SEEK_END)
        os.lseek(fd, max(0, end - int(size)), os.SEEK_SET)
        out = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            out.append(chunk)
        return b"".join(out)
    finally:
        os.close(fd)


def open_write(root, rel, append=False, mode=0o600, create_dirs=True):
    """An fd open for writing root/rel in place (append, or truncated to empty), never through a link: anything at the
    name but a regular file with one link owned by the hive user is unlinked and the file created afresh."""
    parents, name = _split(rel)
    flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK | _NOCTTY | _CLOEXEC | (os.O_APPEND if append else 0)
    with _dir(root, parents, create=create_dirs) as d:
        for _ in range(_RETRIES):
            try:
                fd = os.open(name, flags | os.O_CREAT, mode, dir_fd=d)
            except OSError as exc:
                if exc.errno not in _LINK_ERRNOS and exc.errno != errno.EEXIST:
                    raise
                fd = None
            if fd is not None:
                st = os.fstat(fd)
                if stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid():
                    _blocking(fd)
                    if not append:
                        os.ftruncate(fd, 0)
                    return fd
                os.close(fd)
            st = _lstat_at(d, name)
            if st is not None and stat.S_ISDIR(st.st_mode):
                raise UnsafeMindPath(f"{name} is a directory inside the mind folder; refusing to write it")
            if st is not None:
                os.unlink(name, dir_fd=d)                 # a link, hard link, FIFO or foreign file: drop the name only
            try:
                fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, mode, dir_fd=d)
            except FileExistsError:
                continue                                  # something was planted again meanwhile: look again
            os.fchmod(fd, mode)
            _blocking(fd)
            return fd
    raise UnsafeMindPath(f"{name} kept changing while the hive opened it")


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("write made no progress")
        view = view[written:]


def write_bytes(root, rel, data, mode=0o600, fsync=False, create_dirs=True, replace_links=False):
    """Write root/rel whole: a fresh temporary file in the verified directory, renamed over the name. replace_links:
    a directory component that is a symlink or a file is replaced by a real directory instead of refused."""
    parents, name = _split(rel)
    with _dir(root, parents, create=create_dirs, replace_links=replace_links) as d:
        for _ in range(_RETRIES):
            tmp = f".{name[:64]}.{secrets.token_hex(6)}.hive-tmp"
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | _CLOEXEC, 0o600, dir_fd=d)
            except FileExistsError:
                continue
            try:
                try:
                    os.fchmod(fd, mode)
                    _write_all(fd, bytes(data))
                    if fsync:
                        os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(tmp, name, src_dir_fd=d, dst_dir_fd=d)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp, dir_fd=d)
                raise
            return
    raise OSError(f"could not create a temporary file for {name}")


def write_text(root, rel, text, encoding="utf-8", mode=0o600, fsync=False, create_dirs=True):
    write_bytes(root, rel, str(text).encode(encoding), mode=mode, fsync=fsync, create_dirs=create_dirs)


def symlink(root, rel, target):
    """Make root/rel a symlink to target, replacing a file or link there (never a real directory)."""
    parents, name = _split(rel)
    with _dir(root, parents, create=True) as d:
        for _ in range(_RETRIES):
            tmp = f".{name[:64]}.{secrets.token_hex(6)}.hive-link"
            try:
                os.symlink(os.fspath(target), tmp, dir_fd=d)
            except FileExistsError:
                continue
            try:
                st = _lstat_at(d, name)
                if st is not None and stat.S_ISDIR(st.st_mode):
                    raise UnsafeMindPath(f"{name} is a real directory; refusing to replace it")
                os.replace(tmp, name, src_dir_fd=d, dst_dir_fd=d)
            except BaseException as exc:
                with contextlib.suppress(OSError):
                    os.unlink(tmp, dir_fd=d)
                if isinstance(exc, (IsADirectoryError, NotADirectoryError)) or getattr(exc, "errno", None) in (
                        errno.EISDIR, errno.ENOTEMPTY, errno.EEXIST):
                    raise UnsafeMindPath(f"{name} is a real directory; refusing to replace it") from None
                raise
            return
    raise OSError(f"could not create a temporary link for {name}")


def readlink(root, rel):
    """The target text of the symlink root/rel; None when it is missing or is not a symlink."""
    parents, name = _split(rel)
    try:
        with _dir(root, parents) as d:
            st = _lstat_at(d, name)
            if st is None or not stat.S_ISLNK(st.st_mode):
                return None
            return os.readlink(name, dir_fd=d)
    except FileNotFoundError:
        return None


def unlink(root, rel, missing_ok=True):
    """Remove the entry root/rel (a link is removed, never followed); a directory is refused."""
    parents, name = _split(rel)
    try:
        with _dir(root, parents) as d:
            st = _lstat_at(d, name)
            if st is None:
                raise FileNotFoundError(errno.ENOENT, "not found", name)
            if stat.S_ISDIR(st.st_mode):
                raise IsADirectoryError(errno.EISDIR, "is a directory", name)
            os.unlink(name, dir_fd=d)
    except FileNotFoundError:
        if not missing_ok:
            raise


def remove_tree(root, rel, missing_ok=True):
    """Remove root/rel and everything under it, never following a link: a symlink is unlinked, a directory is removed
    by shutil.rmtree relative to the verified parent fd (its fd-based walk never descends links)."""
    parents, name = _split(rel)
    try:
        with _dir(root, parents) as d:
            st = _lstat_at(d, name)
            if st is None:
                raise FileNotFoundError(errno.ENOENT, "not found", name)
            if stat.S_ISDIR(st.st_mode):
                shutil.rmtree(name, dir_fd=d)
            else:
                os.unlink(name, dir_fd=d)
    except FileNotFoundError:
        if not missing_ok:
            raise


def replace(root, src_rel, dst_rel):
    """Rename root/src_rel over root/dst_rel (rename moves and replaces directory entries; it follows neither end)."""
    sp, sn = _split(src_rel)
    dp, dn = _split(dst_rel)
    with _dir(root, sp) as s, _dir(root, dp) as t:
        os.replace(sn, dn, src_dir_fd=s, dst_dir_fd=t)


def _file_mode(source_mode):
    return 0o700 if source_mode & stat.S_IXUSR else 0o600


def copy_file(source, root, rel, replace_links=True):
    """Copy a singly linked source into a fresh file, replacing linked destination entries."""
    source = pathlib.Path(source)
    with os.fdopen(open_source(source.parent, source.name), "rb") as opened:
        data = opened.read()
        observed = os.fstat(opened.fileno())
        if observed.st_nlink != 1:
            raise UnsafeMindPath(f"{source} is multiply linked")
    write_bytes(root, rel, data, mode=_file_mode(observed.st_mode), replace_links=replace_links)


def copy_tree(source, root, rel="", skip=frozenset()):
    """Copy a trusted source tree into root/rel. Destination directories are opened without following links; one
    that is a symlink or a file is replaced by a real directory; files are written whole (never through a link).
    skip: names of files and directories left out at every depth (as shutil.copytree's ignore)."""
    source = pathlib.Path(source)
    base = _parts(rel)
    ensure = set()
    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        filenames = [f for f in filenames if f not in skip]
        sub = pathlib.Path(dirpath).relative_to(source).parts
        target = base + sub
        if target not in ensure:
            os.close(open_dir(root, "/".join(target), create=True, replace_links=True))
            ensure.add(target)
        for filename in sorted(filenames):
            src = pathlib.Path(dirpath, filename)
            if not src.is_file():
                continue
            dst = "/".join(target + (filename,))
            st = lstat(root, dst)
            if st is not None and stat.S_ISDIR(st.st_mode):
                raise UnsafeMindPath(f"{dst} is a directory inside the mind folder; refusing to replace it")
            copy_file(src, root, dst)


def iter_files(root, skip=lambda parts: False):
    """(relative parts, bytes, stat) for every regular, singly linked file under root, in sorted path order, never
    descending a link. `skip(parts)` prunes a file or directory before it is opened."""
    rfd = open_root(root)
    try:
        yield from _iter_files(rfd, (), skip)
    finally:
        os.close(rfd)


def _iter_files(dfd, prefix, skip):
    for name in sorted(os.listdir(dfd)):
        parts = prefix + (name,)
        if skip(parts):
            continue
        st = _lstat_at(dfd, name)
        if st is None or stat.S_ISLNK(st.st_mode):
            continue
        if stat.S_ISDIR(st.st_mode):
            try:
                child = _child_dir(dfd, name, create=False)
            except (FileNotFoundError, UnsafeMindPath):
                continue
            try:
                yield from _iter_files(child, parts, skip)
            finally:
                os.close(child)
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        try:
            fd = _open_read_at(dfd, name)
        except (FileNotFoundError, UnsafeMindPath):
            continue
        try:
            fst = os.fstat(fd)
            chunks = []
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(fd)
        yield parts, b"".join(chunks), fst


def require_file(root, rel):
    """root/rel is a regular, singly linked file reached without links (refused otherwise)."""
    os.close(open_read(root, rel))


def require_contained_links(root, rel=""):
    """Check a stopped workspace before exposing it. Every regular file's names must stay in its writable tree."""
    parts = _parts(rel)
    links = {}
    with contextlib.ExitStack() as opened:
        root_fd = open_root(root)
        opened.callback(os.close, root_fd)
        device = os.fstat(root_fd).st_dev
        directory = root_fd
        if parts:
            directory = _walk(root_fd, parts, create=False)
            opened.callback(os.close, directory)
        workspace = os.fstat(directory)
        relative = pathlib.PurePosixPath(*parts)
        if workspace.st_dev != device:
            raise UnsafeMindPath(f"{relative} crosses a workspace mount")
        _check_entries(directory, device, relative, {workspace.st_ino}, links)
    for (total, _changed), count, example in links.values():
        if count != total:
            raise LinkedWorkspaceFile(example)


# Time: one walk and one descriptor check per regular file or directory.
# Space: one descriptor per level and one record per directory or multiply linked inode.
def _check_entries(directory, device, relative, seen_dirs, links):
    with os.scandir(directory) as entries:
        for entry in entries:
            child = relative / entry.name
            before = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                fd = _child_dir(directory, entry.name, create=False)
                try:
                    current = os.fstat(fd)
                    if (current.st_dev != device or current.st_ino != before.st_ino
                            or current.st_ino != entry.inode() or current.st_ino in seen_dirs):
                        raise UnsafeMindPath(f"{child} crosses a workspace mount or changed during admission")
                    seen_dirs.add(current.st_ino)
                    _check_entries(fd, device, child, seen_dirs, links)
                finally:
                    os.close(fd)
            elif stat.S_ISREG(before.st_mode):
                flags = getattr(os, "O_PATH", os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK | _NOCTTY | _CLOEXEC
                try:
                    fd = os.open(entry.name, flags, dir_fd=directory)
                except OSError as exc:
                    if exc.errno in _LINK_ERRNOS:
                        raise UnsafeMindPath(f"{child} changed during workspace admission") from None
                    raise
                try:
                    current = os.fstat(fd)
                finally:
                    os.close(fd)
                stamp = current.st_nlink, current.st_ctime_ns
                if (not stat.S_ISREG(current.st_mode) or current.st_dev != device
                        or current.st_ino != before.st_ino or stamp != (before.st_nlink, before.st_ctime_ns)
                        or current.st_nlink < 1):
                    raise UnsafeMindPath(f"{child} crossed a workspace mount or changed during admission")
                if current.st_nlink > 1 or current.st_ino in links:
                    # A mounted name must not count as a second link to its underlying inode.
                    if current.st_ino != entry.inode():
                        raise UnsafeMindPath(f"{child} crosses a workspace mount or changed during admission")
                    expected, count, example = links.get(current.st_ino, (stamp, 0, child))
                    if stamp != expected:
                        raise UnsafeMindPath(f"{child} changed during workspace admission")
                    links[current.st_ino] = expected, count + 1, example
