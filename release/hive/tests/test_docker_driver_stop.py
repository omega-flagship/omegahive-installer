"""DockerDriver.stop must not report a stop over a container still there (stand-in 5 on 94b5cff); no daemon needed."""
import subprocess

import pytest

from hive.supervisor.drivers import DockerDriver


def driver(answers):
    d = DockerDriver.__new__(DockerDriver)
    calls = []
    def fake(*args, check=False):
        calls.append(args[0])
        rc, out = answers.get(args[0], (0, ""))
        return subprocess.CompletedProcess(["docker", *args], rc, out)
    d._docker = fake
    d.calls = calls
    return d


def test_a_container_gone_after_stop_is_a_clean_stop():
    d = driver({"inspect": (1, f"Error: No such object: {DockerDriver.container('a_x')}")})
    d.stop("a_x")
    assert d.calls == ["stop", "rm", "inspect"]


def test_an_already_absent_container_is_fine():
    name = DockerDriver.container("a_x")
    d = driver({"stop": (1, f"Error response from daemon: No such container: {name}"),
                "rm": (1, f"Error response from daemon: No such container: {name}"),
                "inspect": (1, f"Error response from daemon: No such container: {name}")})
    d.stop("a_x")


def test_a_container_still_there_raises():
    d = driver({"stop": (1, "timeout"), "rm": (1, "device busy"), "inspect": (0, "true")})
    with pytest.raises(RuntimeError, match="still there"):
        d.stop("a_x")


def test_a_daemon_that_cannot_say_raises():
    d = driver({"inspect": (1, "Cannot connect to the Docker daemon")})
    with pytest.raises(RuntimeError, match="could not confirm"):
        d.stop("a_x")


@pytest.mark.parametrize("out", [
    "error during connect: dial unix /var/run/docker.sock: connect: no such file or directory",   # socket gone
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "Error: No such object: some-other-container",
    "",
])
def test_a_daemon_or_transport_failure_is_never_taken_for_gone(out):
    d = driver({"stop": (1, out), "rm": (1, out), "inspect": (1, out)})
    with pytest.raises(RuntimeError, match="could not confirm"):
        d.stop("a_x")


def test_the_missing_answer_needs_a_failing_exit_status():
    name = DockerDriver.container("a_x")
    ok = subprocess.CompletedProcess([], 0, f"Error: No such object: {name}")
    assert DockerDriver.missing_container(ok, name) is False


# ---- r6: verify_stopped is strict too (stand-in r5) ------------------------------------------------------------------

@pytest.mark.parametrize("answer", [
    (1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"),
    (1, "error during connect: dial unix /var/run/docker.sock: connect: no such file or directory"),
    (1, ""), (0, ""), (0, "<no value>"),
])
def test_verify_stopped_with_the_daemon_down_or_unclear_raises(answer):
    d = driver({"inspect": answer})
    with pytest.raises(RuntimeError, match="could not confirm"):
        d.verify_stopped("a_x")


def test_verify_stopped_accepts_only_missing_or_running_false():
    name = DockerDriver.container("a_x")
    assert driver({"inspect": (1, f"Error: No such object: {name}")}).verify_stopped("a_x") == "absent"
    assert driver({"inspect": (0, "false\n")}).verify_stopped("a_x") == "exited"
    with pytest.raises(RuntimeError, match="still running"):
        driver({"inspect": (0, "true")}).verify_stopped("a_x")


def test_the_supervisor_uses_the_drivers_strict_proof():
    from hive.supervisor.drivers import Supervisor
    sup = Supervisor.__new__(Supervisor)
    d = driver({"inspect": (1, "Cannot connect to the Docker daemon")})
    sup.drivers, sup.settings = {"docker": d}, type("S", (), {"default_driver": "docker"})()
    sup._agent = lambda agent_id: {"id": agent_id, "driver": "docker"}
    with pytest.raises(RuntimeError, match="could not confirm"):
        sup.verify_stopped("a_x")
