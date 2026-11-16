"""The local-owner hello's self identity (localowner.self_identity): Linux states exe {dev, ino} and listener_inode, in
the shape the installer's front door checks (deploy/linux control.exe_matches / listener_matches); other platforms
state nothing. No PeTTa, no live hive, no network."""

import os
import socket
import sys

import pytest

from hive.core import localowner

HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"


def tcp_line(n, local, remote, state, uid, inode):
    return (f"{n:4d}: {local} {remote} {state} 00000000:00000000 00:00000000 00000000 {uid:5d}        0 {inode} 1 "
            "0000000000000000 100 0 0 10 0\n")


def installer_exe_ok(hello, real):
    """control.exe_matches's attested-executable rule, verbatim in effect (release/hive-20261109)."""
    exe = hello["exe"]
    return (type(exe) is dict and set(exe) == {"dev", "ino"} and all(type(exe[k]) is int for k in exe)
            and (exe["dev"], exe["ino"]) == (real.st_dev, real.st_ino))


def installer_listener_ok(hello):
    """control.listener_matches's attested-inode rule (release/hive-20261109)."""
    inode = hello.get("listener_inode", None)
    return not ("listener_inode" in hello and (type(inode) is not str or not inode.isdecimal() or inode == "0"))


@pytest.fixture(autouse=True)
def _reset_exe():
    saved = localowner._EXE_AT_START
    yield
    localowner._EXE_AT_START = saved


# ---- shape ----------------------------------------------------------------------------------------------------------

def test_linux_states_exactly_exe_and_listener_inode(monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", {"dev": 2049, "ino": 131})
    monkeypatch.setattr(localowner, "_listener_inode_now", lambda port: "4242")
    out = localowner.self_identity(8700, platform="linux")
    assert out == {"exe": {"dev": 2049, "ino": 131}, "listener_inode": "4242"}
    assert set(out["exe"]) == {"dev", "ino"} and all(type(v) is int for v in out["exe"].values())
    assert installer_listener_ok(out)


def test_unestablished_values_are_null_never_guessed(monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", None)
    monkeypatch.setattr(localowner, "_exe_identity_now", lambda: None)
    monkeypatch.setattr(localowner, "_listener_inode_now", lambda port: None)
    out = localowner.self_identity(8700, platform="linux")
    assert out == {"exe": None, "listener_inode": None}
    assert not installer_listener_ok(out)   # null is a refusal at the installer's front door, not a pass


@pytest.mark.parametrize("platform", ["darwin", "win32", "freebsd14"])
def test_other_platforms_state_nothing(platform, monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", {"dev": 1, "ino": 2})
    monkeypatch.setattr(localowner, "_listener_inode_now", lambda port: pytest.fail("must not read /proc"))
    assert localowner.self_identity(8700, platform=platform) == {}


def test_the_exe_returned_is_a_copy(monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", {"dev": 1, "ino": 2})
    monkeypatch.setattr(localowner, "_listener_inode_now", lambda port: None)
    localowner.self_identity(8700, platform="linux")["exe"]["dev"] = 99
    assert localowner._EXE_AT_START == {"dev": 1, "ino": 2}


# ---- the listener: only this account's LISTEN socket on 127.0.0.1:<port> that this process holds -----------------------

def test_listen_inodes_reads_only_loopback_listen_on_the_port_for_this_uid():
    raw = HEADER + "".join([
        tcp_line(0, "0100007F:21FC", "00000000:0000", "0A", 1000, 4242),   # 127.0.0.1:8700 LISTEN, ours
        tcp_line(1, "0100007F:21FD", "00000000:0000", "0A", 1000, 5000),   # another port
        tcp_line(2, "00000000:21FC", "00000000:0000", "0A", 1000, 5001),   # 0.0.0.0:8700, not loopback
        tcp_line(3, "0100007F:21FC", "0100007F:A000", "01", 1000, 5002),   # established, not LISTEN
        tcp_line(4, "0100007F:21FC", "00000000:0000", "0A", 1001, 5003),   # another account
        tcp_line(5, "0100007F:21FC", "00000000:0000", "0A", 1000, 0),      # inode 0
    ])
    assert localowner.listen_inodes(raw, 8700, 1000) == {"4242"}


def test_socket_inodes_reads_only_socket_links():
    assert localowner.socket_inodes(["socket:[4242]", "pipe:[7]", "/dev/null", "socket:[x]", "anon_inode:[eventfd]",
                                     "socket:[17]"]) == {"4242", "17"}


def test_listener_inode_is_the_one_held_listener_or_null(monkeypatch):
    raw = HEADER + tcp_line(0, "0100007F:21FC", "00000000:0000", "0A", os.getuid(), 4242)
    monkeypatch.setattr(localowner, "_read_self_tcp", lambda: raw)
    monkeypatch.setattr(localowner, "_own_fd_targets", lambda: ["socket:[4242]", "socket:[9]"])
    assert localowner._listener_inode_now(8700) == "4242"
    monkeypatch.setattr(localowner, "_own_fd_targets", lambda: ["socket:[9]"])      # someone else's listener
    assert localowner._listener_inode_now(8700) is None
    two = raw + tcp_line(1, "0100007F:21FC", "00000000:0000", "0A", os.getuid(), 4243)
    monkeypatch.setattr(localowner, "_read_self_tcp", lambda: two)
    monkeypatch.setattr(localowner, "_own_fd_targets", lambda: ["socket:[4242]", "socket:[4243]"])
    assert localowner._listener_inode_now(8700) is None                               # ambiguous: null
    monkeypatch.setattr(localowner, "_read_self_tcp", lambda: None)                  # oversized table
    assert localowner._listener_inode_now(8700) is None

    def gone():
        raise OSError("no /proc")
    monkeypatch.setattr(localowner, "_read_self_tcp", gone)
    assert localowner._listener_inode_now(8700) is None


# ---- nothing beyond device and inode numbers ----------------------------------------------------------------------------

def test_nothing_leaks_beyond_numbers(monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", {"dev": 2049, "ino": 131})
    monkeypatch.setattr(localowner, "_listener_inode_now", lambda port: "4242")
    out = localowner.self_identity(8700, platform="linux")
    assert set(out) == {"exe", "listener_inode"}
    assert set(out["exe"]) == {"dev", "ino"} and all(type(v) is int for v in out["exe"].values())
    assert type(out["listener_inode"]) is str and out["listener_inode"].isdecimal()
    text = repr(out)
    for word in ("/", "python", "proc", "socket", sys.executable):
        assert word not in text


def test_prepare_process_captures_exe_before_not_dumpable(monkeypatch):
    calls = []
    monkeypatch.setattr(localowner.sys, "platform", "linux")
    monkeypatch.setattr(localowner, "_exe_identity_now", lambda: calls.append("exe") or {"dev": 3, "ino": 4})
    import ctypes

    class Libc:
        def prctl(self, *args):
            calls.append(("prctl",) + args)
            return 0
    monkeypatch.setattr(ctypes, "CDLL", lambda *a, **k: Libc())
    import resource
    from hive.core import redact
    out, err, umask, core = sys.stdout, sys.stderr, os.umask(0o022), resource.getrlimit(resource.RLIMIT_CORE)
    try:
        localowner.prepare_process()
    finally:
        os.umask(umask)
        sys.stdout, sys.stderr = out, err
        redact.REDACTOR.enabled = False
        try:
            resource.setrlimit(resource.RLIMIT_CORE, core)
        except (ValueError, OSError):
            pass
    assert calls[0] == "exe" and calls[1] == ("prctl", 4, 0, 0, 0, 0)
    assert localowner._EXE_AT_START == {"dev": 3, "ino": 4}


# ---- live, on Linux only: this test process's own executable and a real loopback listener ------------------------------

@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux /proc only")
def test_linux_live_identity_matches_the_installer_checks(monkeypatch):
    monkeypatch.setattr(localowner, "_EXE_AT_START", None)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        out = localowner.self_identity(port)
        assert installer_exe_ok(out, os.stat(os.path.realpath(sys.executable)))
        assert out["listener_inode"] == str(os.fstat(listener.fileno()).st_ino)
        assert installer_listener_ok(out)
    finally:
        listener.close()
