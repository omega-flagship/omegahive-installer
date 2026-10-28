"""Linux mind isolation: unprivileged namespaces + Landlock. The Linux counterpart of the macOS sandbox-exec profile.

A mind on Linux runs as:  python landlock.py <profile.json> -- <command...>   (spawned by sandbox.wrap)

Process layout (all in the hive's process group, so the hive's stop() still ends every one):

  P  host namespaces. Owns one relay per allowed hive port: a unix socket in the mind's relay folder that is
     forwarded to 127.0.0.1:<port>. That relay is the ONLY way out.
  A  unshares user, mount, network, pid and ipc namespaces (no privilege needed), maps its own uid, then forks.
  B  pid 1 of the new pid namespace. Mounts a fresh /proc that shows only this namespace, brings up loopback, listens
     on 127.0.0.1:<port> inside the namespace and forwards each connection to P's unix relay. Restricts itself with
     Landlock, then forks.
  C  inherits every restriction and execs the mind.

What the mind can reach, and why:
- Files (Landlock, any ABI): read/execute the system runtime (/usr, /bin, /sbin, /lib*) plus a short literal list of
  /etc files the loader and libc need (never /etc as a whole: deployment secrets live there), and the listed
  runtime roots. Read/write only its own folder and /dev/null-like devices. Its own /proc only.
- Network: the namespace has only loopback, so there is no route anywhere (TCP, UDP or anything else). Only
  127.0.0.1:<hive port> answers, through the relay to the hive. With Landlock ABI 4+, TCP connect is also limited to
  those ports, and TCP bind is denied.
- Processes and IPC: its own pid namespace (it cannot name, signal or ptrace anything outside); its own ipc and
  network namespaces (SysV IPC and abstract unix sockets are private to it).

Out of scope, by design: Landlock and the bind view are path based, so a hard link to a host file planted in a mind
folder by the hive's own user would be followed. Only the hive's user can create one, and mind folders are created
fresh by the hive. The trusted runtime roots are re-read at every launch, so they must be trusted at launch time.

Fail closed: if namespaces or Landlock (ABI 1+) cannot be set up, the launcher exits 78 and the mind never starts.
That includes the network namespace (r14.4): right after unshare the launcher verifies it is in a NEW network
namespace (a different /proc/self/ns/net from the host's) that holds only the loopback interface; otherwise 78.
`available()` reports false when either is missing, and then a hive with HIVE_MIND_SANDBOX=1 refuses to start minds.
"""

import ctypes
import errno
import fcntl
import json
import os
import platform
import select
import signal
import socket
import struct
import sys
import threading

# Landlock system calls share one number on every architecture that uses the generic syscall table,
# which includes x86_64 and aarch64.
SYS_CREATE_RULESET, SYS_ADD_RULE, SYS_RESTRICT_SELF = 444, 445, 446
CREATE_RULESET_VERSION = 1
PR_SET_NO_NEW_PRIVS = 38
RULE_PATH_BENEATH, RULE_NET_PORT = 1, 2
CLONE_NEWNS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET = 0x00020000, 0x08000000, 0x10000000, 0x20000000, 0x40000000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC, MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 1, 2, 4, 8, 32, 4096, 16384, 1 << 18
MS_NOATIME, MS_NODIRATIME, MS_RELATIME = 1024, 2048, 1 << 21
MNT_DETACH = 2
SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1

FS_EXECUTE, FS_WRITE_FILE, FS_READ_FILE, FS_READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
FS_TRUNCATE, FS_IOCTL_DEV = 1 << 14, 1 << 15
ABI_FS = {1: (1 << 13) - 1}
ABI_FS[2] = ABI_FS[1] | (1 << 13)
ABI_FS[3] = ABI_FS[2] | FS_TRUNCATE
ABI_FS[4] = ABI_FS[3]
ABI_FS[5] = ABI_FS[4] | FS_IOCTL_DEV
NET_BIND_TCP, NET_CONNECT_TCP, NET_ABI = 1 << 0, 1 << 1, 4
READ = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV

SYSTEM_READ = ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/proc")
# literal /etc entries only (never the directory itself: deployment configuration and secrets live under /etc)
ETC_READ = ("/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/localtime", "/etc/nsswitch.conf",
            "/etc/passwd", "/etc/group", "/etc/hosts", "/etc/host.conf", "/etc/gai.conf", "/etc/mime.types",
            "/etc/alternatives", "/etc/python3", "/etc/python3.10", "/etc/python3.12")
DEV_RW = ("/dev/null", "/dev/zero", "/dev/full")   # never /dev/tty: TIOCSTI into the hive's terminal (Kimi r7)
DEV_READ = ("/dev/urandom", "/dev/random")
RELAY_DIR = ".hive-relay"


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]


class _PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class _NetPort(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


def _libc():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def _check(result, what):
    if result < 0:
        err = ctypes.get_errno()
        raise OSError(err, f"{what}: {os.strerror(err)}")
    return result


def abi_version():
    """The kernel's Landlock ABI version, or 0 when Landlock is missing or disabled (or this is not Linux)."""
    if platform.system() != "Linux":
        return 0
    try:
        n = _libc().syscall(SYS_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION))
    except (OSError, AttributeError):
        return 0
    return n if n > 0 else 0


def namespaces_available():
    """Unprivileged user namespaces are enabled (needed for the private network, pid, ipc and mount namespaces)."""
    if platform.system() != "Linux":
        return False
    try:
        with open("/proc/sys/kernel/unprivileged_userns_clone") as f:
            if f.read().strip() == "0":
                return False
    except OSError:
        pass   # the knob is Debian/Ubuntu-only; elsewhere user namespaces are on unless max is 0
    try:
        with open("/proc/sys/user/max_user_namespaces") as f:
            return int(f.read().strip() or 0) > 0
    except (OSError, ValueError):
        return False


def available():
    return abi_version() >= 1 and namespaces_available()


def profile(mind_dir, read_roots, ports, programs=()):
    """The JSON profile the launcher enforces. Paths are resolved; missing ones are skipped at enforcement.
    `programs`: absolute paths the job will exec besides argv[0] (an app runtime interpreter run by limits.sh), kept
    as configured so the launcher mirrors their symlink chain (programs_to_mirror)."""
    mind = os.path.realpath(str(mind_dir))
    # Only already-resolved roots: a root reached through a symlink could point anywhere, so it is dropped here
    # rather than trusted (sandbox.wrap resolves its roots first; this keeps the launcher safe on its own).
    reads = sorted({os.path.realpath(str(p)) for p in read_roots
                    if p and os.path.realpath(str(p)) == os.path.normpath(os.path.abspath(str(p)))})
    return {"version": 2, "mind_dir": mind, "read": list(SYSTEM_READ) + list(ETC_READ) + reads,
            "dev_rw": list(DEV_RW), "dev_read": list(DEV_READ), "connect_ports": sorted({int(p) for p in ports}),
            "programs": _programs_list(programs)}


MAX_PROGRAMS, MAX_PROGRAM_PATH = 8, 1024


def _programs_list(programs):
    """The host writer is as strict as the launcher (_check_profile): absolute, NUL-free, bounded, or an error."""
    out = sorted({str(p) for p in programs if p})
    if len(out) > MAX_PROGRAMS or any(not os.path.isabs(p) or "\x00" in p or len(p) > MAX_PROGRAM_PATH for p in out):
        raise ValueError(f"programs: at most {MAX_PROGRAMS} absolute paths of at most {MAX_PROGRAM_PATH} characters")
    return out


# ---- Landlock -------------------------------------------------------------------------------------------------

def restrict_files(prof, abi=None):
    """Landlock: the filesystem rules (any ABI) and, with ABI 4+, TCP connect to the allowed ports only. Irreversible."""
    abi = abi_version() if abi is None else abi
    if abi < 1:
        raise OSError("Landlock is not available: refusing to start without file isolation")
    fs_all = ABI_FS[min(abi, 5)]
    net = (NET_BIND_TCP | NET_CONNECT_TCP) if abi >= NET_ABI else 0
    libc = _libc()
    attr = _RulesetAttr(fs_all, net)
    size = ctypes.sizeof(attr) if net else 8
    rs = _check(libc.syscall(SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0)),
                "landlock create_ruleset")
    try:
        def allow(path, access):
            try:
                fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                return
            try:
                if not os.path.isdir(path):
                    access &= FILE_RIGHTS
                rule = _PathBeneath(access & fs_all, fd)
                _check(libc.syscall(SYS_ADD_RULE, ctypes.c_int(rs), ctypes.c_int(RULE_PATH_BENEATH), ctypes.byref(rule),
                                    ctypes.c_uint32(0)), f"landlock add_rule {path}")
            finally:
                os.close(fd)

        for path in effective_read(prof["read"]):   # never a rule for a listed symlink that leads outside
            allow(path, READ)
        for path in prof.get("dev_read", ()):
            allow(path, FS_READ_FILE)
        for path in prof.get("dev_rw", ()):
            allow(path, FS_READ_FILE | FS_WRITE_FILE | FS_IOCTL_DEV)
        allow(prof["mind_dir"], fs_all)
        if net:
            for port in prof.get("connect_ports", ()):
                rule = _NetPort(NET_CONNECT_TCP, int(port))
                _check(libc.syscall(SYS_ADD_RULE, ctypes.c_int(rs), ctypes.c_int(RULE_NET_PORT), ctypes.byref(rule),
                                    ctypes.c_uint32(0)), f"landlock add_rule port {port}")
        _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")
        _check(libc.syscall(SYS_RESTRICT_SELF, ctypes.c_int(rs), ctypes.c_uint32(0)), "landlock restrict_self")
    finally:
        os.close(rs)


# ---- seccomp: no unix-domain sockets for the mind ----------------------------------------------------------------

PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 22, 2
SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO = 0x7FFF0000, 0x00050000
AUDIT_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}
SYS_SOCKET = {"x86_64": 41, "aarch64": 198}
SYS_SOCKETPAIR = {"x86_64": 53, "aarch64": 199}
SOCK_STREAM, SOCK_TYPE_MASK = 1, 0xF
SYS_IO_URING_SETUP = 425
AF_UNIX = 1
X32_BIT = 0x40000000


class _SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(_SockFilter))]


def deny_unix_sockets():
    """The mind may not create an ADDRESSABLE unix socket. socket(AF_UNIX) is refused; socketpair() is allowed only
    for SOCK_STREAM (a connected pair: it cannot be re-connected - EISCONN - nor listen), and datagram/seqpacket pairs
    are refused because their endpoints can be bound and connected to a host socket. io_uring rings are refused too.
    So no pathname or abstract unix socket anywhere can be reached; the hive relay (TCP 127.0.0.1 inside its namespace)
    stays the only way out. A foreign architecture or the x32 ABI is refused outright."""
    machine = platform.machine()
    if machine not in AUDIT_ARCH:
        raise OSError(f"seccomp filter not defined for {machine}")
    LD_W_ABS, JEQ, JGE, RET, AND_K = 0x20, 0x15, 0x35, 0x06, 0x54
    deny = SECCOMP_RET_ERRNO | errno.EPERM
    prog = [   # jt/jf are relative: a jump of n lands n+1 instructions on
        (LD_W_ABS, 0, 0, 4),                               # 0  arch
        (JEQ, 1, 0, AUDIT_ARCH[machine]),                  # 1
        (RET, 0, 0, SECCOMP_RET_ERRNO | errno.ENOSYS),     # 2  wrong architecture
        (LD_W_ABS, 0, 0, 0),                               # 3  syscall number
        (JGE, 0, 1, X32_BIT),                              # 4
        (RET, 0, 0, deny),                                 # 5  x32 ABI
        (JEQ, 0, 3, SYS_SOCKET[machine]),                  # 6  socket()? else -> 10
        (LD_W_ABS, 0, 0, 16),                              # 7    args[0]: family
        (JEQ, 0, 9, AF_UNIX),                              # 8    not unix -> 18 allow
        (RET, 0, 0, deny),                                 # 9    socket(AF_UNIX)
        (JEQ, 0, 4, SYS_SOCKETPAIR[machine]),              # 10 socketpair()? else -> 15
        (LD_W_ABS, 0, 0, 24),                              # 11   args[1]: type, with flags
        (AND_K, 0, 0, SOCK_TYPE_MASK),                     # 12
        (JEQ, 4, 0, SOCK_STREAM),                          # 13   connected stream pair -> 18 allow
        (RET, 0, 0, deny),                                 # 14   datagram/seqpacket pairs
        (LD_W_ABS, 0, 0, 0),                               # 15 syscall number again
        (JEQ, 0, 1, SYS_IO_URING_SETUP),                   # 16
        (RET, 0, 0, deny),                                 # 17 io_uring
        (RET, 0, 0, SECCOMP_RET_ALLOW),                    # 18
    ]
    arr = (_SockFilter * len(prog))(*[_SockFilter(c, jt, jf, k) for c, jt, jf, k in prog])
    fprog = _SockFprog(len(prog), arr)
    libc = _libc()
    _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")
    _check(libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0), "seccomp")


# ---- relays ---------------------------------------------------------------------------------------------------

def _pump(a, b):
    """Copy bytes both ways until either side closes."""
    socks = [a, b]
    try:
        while True:
            ready, _, _ = select.select(socks, [], [])
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return
    finally:
        for s in socks:
            try:
                s.close()
            except OSError:
                pass


def _serve(listener, connect):
    def loop():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            try:
                upstream = connect()
            except OSError:
                conn.close()
                continue
            threading.Thread(target=_pump, args=(conn, upstream), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()


def _relay_dir(prof):
    return os.path.join(prof["mind_dir"], RELAY_DIR)


def _relay_name(port):
    """Relative to the relay folder: unix socket paths are limited to about 100 bytes, mind folders can be deep."""
    return f"{int(port)}.sock"


def _host_relays(prof):
    """In the host namespaces: unix socket -> 127.0.0.1:<port>, one per allowed port."""
    os.makedirs(_relay_dir(prof), mode=0o700, exist_ok=True)
    os.chdir(_relay_dir(prof))   # P only relays; binding by a short relative name
    listeners = []
    for port in prof.get("connect_ports", ()):
        path = _relay_name(port)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(path)
        s.listen(64)
        listeners.append((s, int(port)))
    return listeners


def _serve_host(listeners):
    for s, port in listeners:
        _serve(s, lambda p=port: socket.create_connection(("127.0.0.1", p), 10))


def _inner_relays(prof):
    """Inside the mind's network namespace: 127.0.0.1:<port> -> the host relay's unix socket (bound here, served
    only after the mind is forked, so the fork happens while B is still single-threaded)."""
    listeners = []
    for port in prof.get("connect_ports", ()):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", int(port)))
        s.listen(64)
        listeners.append(s)
    return listeners


def _serve_inner(listeners):
    for s in listeners:
        def connect(port=s.getsockname()[1]):   # B's working directory is the relay folder
            u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            u.connect(_relay_name(port))
            return u
        _serve(s, connect)


# ---- namespaces -----------------------------------------------------------------------------------------------

def _write(path, text):
    with open(path, "w") as f:
        f.write(text)


def _netns_id():
    """Identity of the calling process's network namespace (device, inode of /proc/self/ns/net)."""
    st = os.stat("/proc/self/ns/net")
    return (st.st_dev, st.st_ino)


def _interfaces():
    return sorted(name for _, name in socket.if_nameindex())


def _verify_fresh_netns(host_netns):
    """r14.4 (promised to Code): the tool's network is a NEW namespace with nothing but loopback, checked rather than
    assumed. Any doubt (the same namespace as the host, another interface, /proc unreadable) refuses: 78."""
    inside = _netns_id()
    if inside == tuple(host_netns):
        raise OSError("network namespace was not unshared: refusing to run with the host network")
    ifaces = _interfaces()
    if ifaces != ["lo"]:
        raise OSError(f"network namespace is not empty (interfaces {ifaces}): refusing")


def _enter_namespaces(uid, gid):
    libc = _libc()
    _check(libc.unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWIPC), "unshare")
    _write("/proc/self/setgroups", "deny")
    _write("/proc/self/uid_map", f"{uid} {uid} 1")
    _write("/proc/self/gid_map", f"{gid} {gid} 1")


def _loopback_up():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        ifr = struct.pack("16sH14s", b"lo", 0, b"\x00" * 14)
        flags = struct.unpack("16sH14s", fcntl.ioctl(s, SIOCGIFFLAGS, ifr))[1]
        fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack("16sH14s", b"lo", flags | IFF_UP, b"\x00" * 14))
    finally:
        s.close()


def _mount(src, target, fstype, flags, data=None):
    enc = lambda v: v.encode() if isinstance(v, str) else v
    _check(_libc().mount(enc(src), enc(target), enc(fstype), ctypes.c_ulong(flags), enc(data)), f"mount {target}")


def _locked_flags(path):
    """The mount flags a remount inside a user namespace must keep (the kernel locks them from the parent)."""
    f = os.statvfs(path).f_flag
    out = 0
    for st, ms in ((1, MS_RDONLY), (2, MS_NOSUID), (4, MS_NODEV), (8, MS_NOEXEC), (1024, MS_NOATIME),
                   (2048, MS_NODIRATIME), (4096, MS_RELATIME)):
        if f & st:
            out |= ms
    return out


def _mkdirs(path):
    """Create `path` and any missing parents as 0755, whatever the hive's umask (never group/other-writable)."""
    missing = []
    while path and path != "/" and not os.path.lexists(path):
        missing.append(path)
        path = os.path.dirname(path)
    for d in reversed(missing):
        os.mkdir(d, 0o755)
        os.chmod(d, 0o755)


def _bind(root, path, writable):
    """Bind host `path` at the same place inside `root`; read-only unless `writable`."""
    target = root + path
    if os.path.isdir(path):
        _mkdirs(target)
    else:
        _mkdirs(os.path.dirname(target))
        open(target, "a").close()
    _mount(path, target, None, MS_BIND | MS_REC)
    if not writable:
        _readonly_tree(target)


class _MountAttr(ctypes.Structure):
    _fields_ = [("attr_set", ctypes.c_uint64), ("attr_clr", ctypes.c_uint64), ("propagation", ctypes.c_uint64),
                ("userns_fd", ctypes.c_uint64)]


SYS_MOUNT_SETATTR, MOUNT_ATTR_RDONLY, AT_FDCWD, AT_RECURSIVE = 442, 0x1, -100, 0x8000


def _readonly_tree(target):
    """Read-only for the bind AND every mount nested under it (Review r5): a recursive bind remounted read-only at
    the top would leave a writable child mount (a tmpfs inside a runtime root) truncatable. mount_setattr(2) with
    AT_RECURSIVE (Linux 5.12+) applies it to the whole subtree in one step; then every mount under `target` is
    checked, and anything still writable stops the mind from starting (fail closed). Mounts the host adds later
    never appear inside: the mind's mount namespace was made private before any bind."""
    attr = _MountAttr(MOUNT_ATTR_RDONLY, 0, 0, 0)
    libc = _libc()
    rc = libc.syscall(SYS_MOUNT_SETATTR, ctypes.c_int(AT_FDCWD), target.encode(), ctypes.c_uint(AT_RECURSIVE),
                      ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)))
    # No fallback (Kimi r6): a per-mount remount relies on /proc/self/mountinfo seeing exactly the tree the bind
    # copied. Without mount_setattr (Linux < 5.12) the mind is refused rather than isolated by a weaker method.
    _check(rc, "mount_setattr read-only (needs Linux 5.12+)")
    still = [m for m in _mounts_under(target) if not os.statvfs(m).f_flag & 1]
    if still:
        raise OSError(f"runtime mount still writable, refusing: {still[0]}")


def _mounts_under(target):
    """Every mount point at or below `target` in this mount namespace (from /proc/self/mountinfo)."""
    import re
    unescape = lambda raw: re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m.group(1), 8)]), raw)   # \040 -> space
    base = os.fsencode(target).rstrip(b"/")
    out = []
    with open("/proc/self/mountinfo", "rb") as f:
        for line in f:
            point = unescape(line.split()[4])   # exact bytes: no text decoding of the kernel's octal escapes
            if point == base or point.startswith(base + b"/"):
                out.append(os.fsdecode(point))
    return out


def allowed_roots(read):
    """The real paths a profile may expose: its entries that are NOT symlinks. A listed symlink (/lib -> usr/lib,
    /etc/localtime -> ../usr/share/zoneinfo/...) is honoured only when it lands inside one of these, so a listed
    symlink can never smuggle an outside target (a secret) into the view or into a Landlock rule."""
    return sorted({os.path.realpath(p) for p in read if p != "/proc" and os.path.exists(p) and not os.path.islink(p)})


def _inside(real, roots):
    return any(real == r or real.startswith(r.rstrip("/") + "/") for r in roots)


def effective_read(read):
    """The read entries that are safe to grant: non-symlinks, and symlinks whose real target is inside an allowed root."""
    roots = allowed_roots(read)
    return [p for p in read if p == "/proc" or not os.path.islink(p) or _inside(os.path.realpath(p), roots)]


def _allowed(prof, path):
    """Only these may ever be bound into the mind's view: the system runtime, the literal /etc entries and the declared
    read roots (all real paths). A symlink leading anywhere else stays dangling inside (Kimi r7: no window onto
    arbitrary host paths through operator-controlled links)."""
    return _inside(os.path.realpath(path), prof["_allowed"])


def programs_to_mirror(environ, prof=None):
    """Programs besides argv[0] that the mind starts by absolute path, named by the hive in the mind's environment:
    HIVE_PYTHON, the interpreter of the mind's hub channel (hive/supervisor/drivers.py Supervisor.env). Mirrored like
    _exe, through every symlink hop (a venv's python -> uv's version alias -> the real interpreter): a root listed by
    its real path alone leaves the alias missing inside the view, and the channel failed with ENOENT (2026-10-08).
    Also the profile's own `programs` (host-written by sandbox.wrap: an app runtime such as a venv python run through
    limits.sh, which failed with "exec: ...: not found" for the same reason, 2026-10-08).
    _mirror binds only targets inside the profile's allowed roots, so a name here can never widen the view."""
    path = str(environ.get("HIVE_PYTHON") or "")
    named = [path] if os.path.isabs(path) else []
    listed = [str(p) for p in ((prof or {}).get("programs") or []) if isinstance(p, str) and os.path.isabs(p)]
    return list(dict.fromkeys(named + listed))


def _mirror(root, path, prof, depth=0, seen=None):
    """Make `path` resolve inside `root` as on the host: every symlinked component along the way is recreated as the
    same symlink, and the final real target is bound read-only when it is an allowed path and not already visible."""
    seen = set() if seen is None else seen
    if depth > 40:
        raise OSError(f"too many symlinks resolving {path}")
    cur = ""
    for part in path.strip("/").split("/"):
        cur += "/" + part
        if os.path.islink(cur):
            st = os.lstat(cur)
            if (st.st_dev, st.st_ino) in seen:   # a symlink loop: refuse at once, before any further bind
                raise OSError(f"symlink loop resolving {path}")
            seen.add((st.st_dev, st.st_ino))
            if not os.path.lexists(root + cur):
                _mkdirs(os.path.dirname(root + cur))
                os.symlink(os.readlink(cur), root + cur)
            target = os.path.normpath(os.path.join(os.path.dirname(cur), os.readlink(cur)))
            return _mirror(root, target + path[len(cur):], prof, depth + 1, seen)
    if not _allowed(prof, path):
        return   # outside the profile: never bound; the link (if any) dangles inside the mind's view
    if not os.path.lexists(root + path):
        _bind(root, path, writable=False)


def _devices(prof):
    """(path, writable) for every device the profile lists; either list may be absent (r14.4: never list + tuple)."""
    rw = list(prof.get("dev_rw") or [])
    return [(p, p in rw) for p in list(prof.get("dev_read") or []) + rw]


def _private_root(prof):
    """A filesystem view containing ONLY the runtime (read-only), the mind's folder (read-write) and a few devices.
    Every other host path - other folders, files to truncate, pathname unix sockets - simply does not exist inside."""
    _mount(None, "/", None, MS_REC | MS_PRIVATE)
    root = prof["_root"]
    _mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755")
    _mkdirs(root + "/tmp")   # first, so binds below /tmp (a mind folder there) stay visible
    _mount("tmpfs", root + "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777")
    prof["_allowed"] = allowed_roots(prof["read"])
    prof["read"] = effective_read(prof["read"])
    for path in prof["read"]:
        if path != "/proc" and os.path.exists(path):
            _mirror(root, path, prof)
    if prof.get("_exe"):
        _mirror(root, prof["_exe"], prof)   # the program the mind runs, through every symlink hop (venv -> base python)
    for program in prof.get("_programs") or ():
        _mirror(root, program, prof)        # other host-named programs the mind starts (its hub channel's Python)
    for path, writable in _devices(prof):
        if os.path.exists(path):
            _bind(root, path, writable=writable)
    _bind(root, prof["mind_dir"], writable=True)
    _mkdirs(root + "/proc")
    try:
        _mount("proc", root + "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC)   # only this pid namespace
        has_proc = True
    except OSError:
        has_proc = False   # e.g. inside a container with masked /proc: then the mind has no /proc at all
    old = root + "/.oldroot"
    os.makedirs(old, exist_ok=True)
    _check(_libc().syscall(155 if platform.machine() == "x86_64" else 41, root.encode(), old.encode()), "pivot_root")
    os.chdir("/")
    _check(_libc().umount2(b"/.oldroot", MNT_DETACH), "umount old root")
    os.rmdir("/.oldroot")
    return has_proc


def _status(code):
    if os.WIFEXITED(code):
        return os.WEXITSTATUS(code)
    return 128 + os.WTERMSIG(code) if os.WIFSIGNALED(code) else 1


def _wait(pid):
    while True:
        try:
            return _status(os.waitpid(pid, 0)[1])
        except ChildProcessError:
            return 1
        except InterruptedError:
            continue


def _pid1(prof, argv):
    """B: init of the mind's pid namespace."""
    if not _private_root(prof):
        prof = dict(prof, read=[p for p in prof["read"] if p != "/proc"])
    _loopback_up()
    os.chdir(_relay_dir(prof))
    inner = _inner_relays(prof)
    restrict_files(prof)
    mind = os.fork()
    if mind == 0:
        for s in inner:
            s.close()
        os.chdir(prof["_cwd"] if os.path.isdir(prof["_cwd"]) else prof["mind_dir"])
        try:
            deny_unix_sockets()
        except OSError as e:
            sys.stderr.write(f"mind isolation failed, not starting: {e}\n")
            os._exit(78)
        os.execvp(argv[0], argv)
    _serve_inner(inner)
    signal.signal(signal.SIGTERM, lambda *_: (os.kill(mind, signal.SIGKILL), os._exit(143)))
    code = 1
    while True:   # reap everything; leave when the mind itself ends (taking the whole namespace with it)
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        except InterruptedError:
            continue
        if pid == mind:
            code = _status(status)
            break
    os._exit(code)


def _setup_failed(exc, root, listeners):
    """P's setup failed before any namespace child exists: release what P made (relay listeners, the empty root) and
    exit 78, never a traceback."""
    sys.stderr.write(f"mind isolation failed, not starting: {exc}\n")
    for s, _ in listeners:
        try:
            s.close()
        except OSError:
            pass
    if root:
        try:
            os.rmdir(root)
        except OSError:
            pass
    return 78


def launch(prof, argv):
    import shutil
    import tempfile
    uid, gid = os.getuid(), os.getgid()
    root = None
    try:   # r14.4: P's own setup fails closed with 78 too (never a traceback exit), before anything is forked
        host_netns = _netns_id()
        root = tempfile.mkdtemp(prefix="hive-mind-root-")   # an empty mountpoint; the private view is built on it
        prof = dict(prof, _cwd=os.getcwd(), _root=root, _exe=shutil.which(argv[0]) or "",
                    _programs=programs_to_mirror(os.environ, prof))
        listeners = _host_relays(prof)
    except Exception as e:
        return _setup_failed(e, root, [])
    try:
        a = os.fork()
    except OSError as e:   # r14.4 stand-in: a failed first fork (EAGAIN, ENOMEM) is a setup failure too: 78
        return _setup_failed(e, root, listeners)
    if a == 0:
        try:
            for s, _ in listeners:
                s.close()
            _enter_namespaces(uid, gid)
            _verify_fresh_netns(host_netns)
            b = os.fork()   # the first child after unshare(CLONE_NEWPID) is pid 1 of the new namespace
            if b == 0:
                try:
                    _pid1(prof, argv)
                except BaseException as e:   # never fall through to an unisolated mind
                    sys.stderr.write(f"mind isolation failed, not starting: {e}\n")
                    os._exit(78)
            os._exit(_wait(b))
        except BaseException as e:
            sys.stderr.write(f"mind isolation failed, not starting: {e}\n")
            os._exit(78)
    _serve_host(listeners)   # threads only after the fork: the namespace children start single-threaded

    def cleanup():
        try:
            os.rmdir(root)
        except OSError:
            pass
    signal.signal(signal.SIGTERM, lambda *_: (os.kill(a, signal.SIGKILL), cleanup(), os._exit(143)))
    code = _wait(a)
    cleanup()
    return code


def _check_profile(prof):
    """Every field the launcher consumes, with its exact shape, checked before anything starts (r14.3), and returned
    normalised (r14.4): every list present (absent optional lists become []), every path absolute and free of NUL
    bytes. The launcher runs only on the returned profile, so no consumer meets an absent or mistyped field."""
    def path(x):
        return isinstance(x, str) and x.startswith("/") and "\x00" not in x

    def paths(name):
        if name not in prof:
            return []   # absent: an empty list. Present, it must be a list (null is refused like any other shape)
        v = prof[name]
        if not isinstance(v, list) or not all(path(x) for x in v):
            raise ValueError(f"{name} must be a list of absolute paths without NUL bytes")
        return list(v)
    if not isinstance(prof, dict):
        raise ValueError("profile is not an object")
    if not path(prof.get("mind_dir")):
        raise ValueError("mind_dir must be an absolute path without NUL bytes")
    ports = prof.get("connect_ports", [])
    if not isinstance(ports, list) or not all(isinstance(x, int) and not isinstance(x, bool) and 0 < x < 65536 for x in ports):
        raise ValueError("connect_ports must be a list of port numbers")
    # Only the fields the launcher consumes: launcher-internal keys ("_root", "_cwd", ...) never come from the file.
    return {"mind_dir": prof["mind_dir"], "read": paths("read"), "dev_rw": paths("dev_rw"),
            "dev_read": paths("dev_read"), "connect_ports": list(ports), "programs": _bounded(paths("programs"))}


def _bounded(programs):
    if len(programs) > MAX_PROGRAMS or any(len(p) > MAX_PROGRAM_PATH for p in programs):
        raise ValueError(f"programs must be at most {MAX_PROGRAMS} paths of at most {MAX_PROGRAM_PATH} characters")
    return programs


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) < 3 or argv[1] != "--":
        sys.stderr.write("usage: landlock.py <profile.json> -- <command...>\n")
        return 2
    try:
        with open(argv[0], encoding="utf-8") as f:
            prof = json.load(f)
        prof = _check_profile(prof)
    except (OSError, ValueError, UnicodeError, TypeError) as exc:   # unreadable or malformed: fail closed, like the rest
        sys.stderr.write(f"mind isolation failed, not starting: bad profile ({exc})\n")
        return 78
    if not available():
        sys.stderr.write("mind isolation failed, not starting: Landlock or unprivileged namespaces unavailable\n")
        return 78
    return launch(prof, argv[2:])


if __name__ == "__main__":
    sys.exit(main())
