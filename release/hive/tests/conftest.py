"""Hive test isolation from this machine's live services."""
import shutil
import tempfile
import threading

import pytest

# Every temp folder a test makes is removed when that test ends, pass or fail. Fixtures across hive/tests call
# tempfile.mkdtemp (hive-test-*, hive-personal-*, hive-media-*, hive-people-* and others), each holding a hive.db, its
# wal and agent folders; nothing removed them, and about 2,700 of them filled 12 GB of the Mac's temp folder. The
# tracker below wraps tempfile.mkdtemp (TemporaryDirectory goes through it too) once for the whole run: a folder made
# while a test runs (its function-scoped fixtures included) is removed at that test's teardown; a folder made by a
# module- or session-scoped fixture, which outlives one test, is removed when the run ends.
_REAL_MKDTEMP = tempfile.mkdtemp
_made = []                                                # every folder made this run, in order
_made_lock = threading.Lock()


def _tracked_mkdtemp(*args, **kwargs):
    path = _REAL_MKDTEMP(*args, **kwargs)
    with _made_lock:
        _made.append(path)
    return path


def _remove(paths):
    for path in reversed(paths):
        shutil.rmtree(path, ignore_errors=True)


@pytest.fixture(scope="session", autouse=True)
def _temp_dirs_removed_at_run_end():
    tempfile.mkdtemp = _tracked_mkdtemp
    try:
        yield
    finally:
        tempfile.mkdtemp = _REAL_MKDTEMP
        with _made_lock:
            left, _made[:] = list(_made), []
        _remove(left)


@pytest.fixture(autouse=True)
def _temp_dirs_removed_per_test(_temp_dirs_removed_at_run_end):
    with _made_lock:
        start = len(_made)
    try:
        yield
    finally:                                              # runs on failure and error too: teardown always runs
        with _made_lock:
            mine, _made[start:] = _made[start:], []
        _remove(mine)


@pytest.fixture(autouse=True)
def _code_release_guard_isolated(tmp_path_factory, monkeypatch):
    """The Code release guard reads the real Code service LaunchAgent. Tests must not depend on which release the live
    service happens to run, so by default it sees no agent; guard tests set their own agent, and
    test_the_code_service_on_this_machine_loads_the_intended_release reads the real file itself."""
    from hive.core.code import Code
    monkeypatch.setattr(Code, "CODE_AGENT_PLIST", str(tmp_path_factory.mktemp("no-agent") / "absent.plist"))


@pytest.fixture(autouse=True)
def _repo_map_seed_isolated(tmp_path_factory, monkeypatch):
    """The repo-map seed (hive/core/repomap_seed.py) reads envelopes from source folders that default to this machine's
    intake folder. Tests never load real maps: by default the seed looks only in an empty folder (every pinned revision
    then reports missing); seed tests set their own manifest and folder."""
    monkeypatch.setenv("HIVE_REPO_MAP_SEED_DIRS", str(tmp_path_factory.mktemp("no-seed")))
    monkeypatch.setenv("HIVE_REPO_MAP_LIVE", "off")   # repomap_live.py: its tests drive it directly
    monkeypatch.setenv("HIVE_REPO_MAP_TRACKING", "off")   # repomap_sources.py: no git fetches from tests unless asked
    monkeypatch.setenv("HIVE_SESSION_LAUNCH_SOCKET", "off")   # session_launch.py: socket tests turn it on themselves


@pytest.fixture()
def deny_network(monkeypatch):
    """No network, ever, for a test that asks for it (Dot, sol and Kimi on 04875179, 593fde34): every outbound
    connection or datagram fails, from any client (the gateway's, ProviderStore's, assets', code's, Google's, a raw
    socket), set up before the app is built when a test module makes it autouse. Allowed: unix sockets, loopback
    addresses (classified by ipaddress, so the expanded IPv6 forms too) and the exact name "localhost". Refused: every
    other address and name (a name such as "127.attacker.example" is a name, not loopback), and the unspecified
    addresses 0.0.0.0 and :: (decided: a self-connect through them is not needed by any test). A test that wants an
    answer injects its own transport (httpx.MockTransport), which never reaches a socket."""
    import ipaddress
    import socket

    def local(host):
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(str(host).split("%", 1)[0]).is_loopback
        except ValueError:
            return False                                  # any other name: refused, never resolved

    def refused(address):
        if not isinstance(address, tuple) or not address:
            return False                                  # a unix socket (a path)
        return not local(address[0])

    def guard(real):
        def call(self, address, *rest):
            if refused(address):
                raise OSError("network denied in tests: " + str(address[0]))
            return real(self, address, *rest)
        return call
    monkeypatch.setattr(socket.socket, "connect", guard(socket.socket.connect))
    monkeypatch.setattr(socket.socket, "connect_ex", guard(socket.socket.connect_ex))
    real_sendto = socket.socket.sendto

    def sendto(self, data, *args):                        # UDP: sendto(data, address) or sendto(data, flags, address)
        address = args[-1] if args else None
        if refused(address):
            raise OSError("network denied in tests: " + str(address[0]))
        return real_sendto(self, data, *args)
    monkeypatch.setattr(socket.socket, "sendto", sendto)
    real_sendmsg = socket.socket.sendmsg

    def sendmsg(self, buffers, *args):                   # sendmsg(buffers, ancdata, flags, address): a datagram too
        address = args[2] if len(args) > 2 else None
        if address is not None and refused(address):
            raise OSError("network denied in tests: " + str(address[0]))
        return real_sendmsg(self, buffers, *args)
    monkeypatch.setattr(socket.socket, "sendmsg", sendmsg)
    real_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(host, *args, **kwargs):              # a lookup is network too, except for a loopback name
        if host is None or local(host if not isinstance(host, bytes) else host.decode()):
            return real_getaddrinfo(host, *args, **kwargs)
        raise OSError("network denied in tests: " + str(host))
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    import httpx
    real_async, real_sync = httpx.AsyncHTTPTransport.handle_async_request, httpx.HTTPTransport.handle_request

    async def async_request(self, request):
        if not local(request.url.host):
            raise httpx.ConnectError("network denied in tests: " + request.url.host, request=request)
        return await real_async(self, request)

    def sync_request(self, request):
        if not local(request.url.host):
            raise httpx.ConnectError("network denied in tests: " + request.url.host, request=request)
        return real_sync(self, request)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_request)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", sync_request)
