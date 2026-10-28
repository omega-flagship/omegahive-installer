"""The address a mind dials (hub, API, LLM gateway). A local mind dials where the hive listens (HIVE_HOST,
HIVE_PORT), never the client-facing HIVE_PUBLIC_URL (on the cloud, the SSH-tunnel port 8710 the server does not listen
on: minds stayed 'starting' and never spent, 2026-10-08). A docker mind keeps HIVE_PUBLIC_URL, unchanged."""

import pytest

from hive.core.config import load_settings
from hive.supervisor.drivers import StartRefused, Supervisor


class Docker:
    def __init__(self, network):
        self.network = network


def supervisor(tmp_path, monkeypatch, public_url, port="8700", host=None, sandbox=False, default_driver=None,
               network="host"):
    env = {"HIVE_DATA_DIR": str(tmp_path), "HIVE_PUBLIC_URL": public_url, "HIVE_PORT": port, "HIVE_HOST": host,
           "HIVE_MIND_SANDBOX": "1" if sandbox else None, "HIVE_DRIVER": default_driver, "HIVE_MIND_SANDBOX_PORTS": None}
    for name, value in env.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    sup = Supervisor(load_settings(), drivers={"local": object(), "docker": Docker(network)})
    seen = []
    sup.workspace.env = lambda agent, hub_url, api_url, memory_dir=None: seen.append((hub_url, api_url)) or {}
    return sup, seen


def dialled(url):
    return [(url.replace("http", "ws", 1) + "/agent-hub", url)]


def test_a_local_mind_dials_the_hives_own_port_not_the_tunnel_address(tmp_path, monkeypatch):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://127.0.0.1:8710", sandbox=True)
    sup.env({"id": "a_1", "driver": "local"})
    sup.env({"id": "a_2", "driver": None})                     # no driver of its own: the default, local
    assert seen == dialled("http://127.0.0.1:8700") * 2


def test_the_mind_port_follows_hive_port(tmp_path, monkeypatch):
    sup, seen = supervisor(tmp_path, monkeypatch, "https://hive.example.org", port="9123")
    sup.env({"id": "a_1", "driver": "local"})
    assert seen == dialled("http://127.0.0.1:9123")


def test_a_bad_port_is_a_plain_refusal(tmp_path, monkeypatch):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://127.0.0.1:8710", port="abc")
    with pytest.raises(StartRefused, match="not a valid port"):
        sup.env({"id": "a_1", "driver": "local"})


@pytest.mark.parametrize("host", ["0.0.0.0", "localhost", "LOCALHOST", "127.0.0.1", "::ffff:127.0.0.1",
                                  "[::ffff:0.0.0.0]"])
def test_an_ipv4_wildcard_or_loopback_bind_is_dialled_on_loopback(tmp_path, monkeypatch, host):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://127.0.0.1:8710", host=host, sandbox=True)
    sup.env({"id": "a_1", "driver": "local"})
    assert seen == dialled("http://127.0.0.1:8700")


@pytest.mark.parametrize("host,url", [("10.0.0.5", "http://10.0.0.5:8700"), ("fd00::5", "http://[fd00::5]:8700"),
                                      ("::", "http://[::1]:8700"), ("[::]", "http://[::1]:8700"),
                                      ("::1", "http://[::1]:8700"), ("hive.internal", "http://hive.internal:8700"),
                                      ("127.0.0.2", "http://127.0.0.2:8700")])
def test_any_other_bind_is_dialled_as_itself_when_unsandboxed(tmp_path, monkeypatch, host, url):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://10.0.0.5:8700", host=host)
    sup.env({"id": "a_1", "driver": "local"})
    assert seen == dialled(url)


@pytest.mark.parametrize("host", ["10.0.0.5", "127.0.0.2", "::", "::1", "hive.internal", "[[::1"])
def test_a_sandboxed_mind_is_refused_a_bind_the_sandbox_cannot_reach(tmp_path, monkeypatch, host):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://10.0.0.5:8700", host=host, sandbox=True)
    with pytest.raises(StartRefused, match="listens on"):
        sup.env({"id": "a_1", "driver": "local"})
    assert seen == []


def test_a_scoped_ipv6_bind_is_refused(tmp_path, monkeypatch):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://127.0.0.1:8710", host="fe80::1%en0")
    with pytest.raises(StartRefused, match="scoped IPv6"):
        sup.env({"id": "a_1", "driver": "local"})


@pytest.mark.parametrize("network", ["host", "hive-net"])
def test_a_docker_mind_keeps_the_public_url(tmp_path, monkeypatch, network):
    sup, seen = supervisor(tmp_path, monkeypatch, "https://hive.example.org/", network=network)
    sup.env({"id": "a_1", "driver": "docker"})
    assert seen == [("wss://hive.example.org/agent-hub", "https://hive.example.org")]


def test_a_docker_default_driver_on_its_own_network_keeps_the_public_url(tmp_path, monkeypatch):
    sup, seen = supervisor(tmp_path, monkeypatch, "http://10.0.0.5:8700", default_driver="docker", network="hive-net")
    sup.env({"id": "a_1", "driver": None})
    assert seen == dialled("http://10.0.0.5:8700")


def test_a_local_mind_gets_the_hives_own_python_for_its_channel(tmp_path, monkeypatch):
    """The hub channel is a separate Python process; janus's embedded Python (the cloud's system python3) lacks the
    hive's packages, so every connect failed with "No module named 'websockets'" (2026-10-08)."""
    import sys
    sup, _ = supervisor(tmp_path, monkeypatch, "http://127.0.0.1:8710")
    sup.workspace.env = lambda agent, hub_url, api_url, memory_dir=None: {"HIVE_WS_URL": hub_url}
    assert sup.env({"id": "a_1", "driver": "local"})["HIVE_PYTHON"] == sys.executable
    assert "HIVE_PYTHON" not in sup.env({"id": "a_2", "driver": "docker"})      # the host's path means nothing in a container
