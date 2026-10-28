"""Supervisor and drivers.  A driver only knows how to run one agent process.

Drivers implement ``start(agent, env) / stop(agent_id) / status(agent_id) ->
"running" | "exited" | "absent" / logs(agent_id, tail)``.  Built in: ``local``
(a process on this host) and ``docker`` (one container per agent).  Other
substrates (Kubernetes, VMs, Omega Cloud) are new drivers with the same shape.
"""

from __future__ import annotations

import contextlib
import ipaddress
import logging
import os
import re
import secrets
import pathlib
import signal
import subprocess
import sys

from .sandbox import available as sandbox_available, loopback_ports, mind_environment, mind_sandbox_requested, runtime_roots, wrap as sandbox_wrap
import threading
import time

from .workspace import Workspace

ITER_IMAGE_DEFAULT = "omegadots/iter:dev"
PREFLIGHT_SECONDS = 10


class StartRefused(RuntimeError):
    """A mind that cannot start here as configured, with a reason a person can act on. The hive records it as the
    mind's error and leaves the mind stopped instead of retrying blindly."""


def iter_preflight(image, run=subprocess.run, which=None):
    """Refuse an Iter start, plainly, when Docker or the Iter image is missing (2026-10-06: the daemon was down and
    the image presence unknown, and nothing said so)."""
    import shutil
    if (which or shutil.which)("docker") is None:
        raise StartRefused("an Iter runs in Docker, and the docker command is not installed on this machine")
    try:
        daemon = run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True,
                     timeout=PREFLIGHT_SECONDS)
    except subprocess.TimeoutExpired:
        raise StartRefused(f"the Docker daemon did not answer within {PREFLIGHT_SECONDS} s: start or restart Docker, "
                           "then start this Iter again") from None
    if daemon.returncode != 0:
        raise StartRefused("the Docker daemon is not running: start Docker, then start this Iter again")
    try:
        found = run(["docker", "image", "inspect", image], capture_output=True, text=True, timeout=PREFLIGHT_SECONDS)
    except subprocess.TimeoutExpired:
        raise StartRefused(f"Docker did not answer within {PREFLIGHT_SECONDS} s about the Iter image {image}") from None
    if found.returncode != 0:
        raise StartRefused(f"the Iter image {image} is not on this machine: build it with "
                           f"docker build -f hive/docker/iter.Dockerfile -t {image} hive/docker, then start this Iter again")


_UNKNOWN = object()   # a driver's execution identity that could not be read (Supervisor._evidence)


class Driver:
    name = "base"

    def start(self, agent, env):  # pragma: no cover - interface
        raise NotImplementedError

    def stop(self, agent_id):  # pragma: no cover - interface
        raise NotImplementedError

    def status(self, agent_id):  # pragma: no cover - interface
        raise NotImplementedError

    def logs(self, agent_id, tail=200):  # pragma: no cover - interface
        raise NotImplementedError

    def execution(self, agent_id):
        """An identity of the mind's running execution (a new one per process actually started), or None."""
        return None


def _tail(path, lines):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 256 * 1024))
            data = handle.read().decode("utf-8", errors="replace")
    except FileNotFoundError:
        return []
    return data.splitlines()[-lines:]


class ProcessObservationError(RuntimeError):
    """The local process table or ownership evidence could not be read reliably."""


class LocalDriver(Driver):
    """Runs each agent as a process group on this host."""

    name = "local"

    def __init__(self, workspace: Workspace, petta_path):
        self.workspace = workspace
        self.petta_path = petta_path
        self.procs: dict[str, subprocess.Popen] = {}
        self.isolation: dict[str, dict] = {}  # agent_id -> the boundary the running process actually has

    # A mind runs in its own session, so it outlives a hive restart. Its process group is recorded in mind.pid, and
    # after a restart the hive adopts a mind that is still running instead of starting a duplicate; stop always ends
    # the recorded group. (Found 2026-10-04: a restart left an orphan and a second worker on the same goal.)
    def _pidfile(self, agent_id):
        return self.workspace.path(agent_id) / "mind.pid"

    @staticmethod
    def _group_members(pgid):
        """Live (non-zombie) processes in a process group, with their commands."""
        try:
            result = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat=,command="], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ProcessObservationError(f"could not inspect process group {pgid}") from exc
        if result.returncode != 0:
            raise ProcessObservationError(f"could not inspect process group {pgid} (ps exit {result.returncode})")
        out = result.stdout
        members = []
        for line in out.splitlines():
            parts = line.split(None, 3)
            if len(parts) >= 3 and parts[1] == str(pgid) and not parts[2].startswith("Z"):
                members.append((int(parts[0]), parts[3] if len(parts) > 3 else ""))
        return members

    def _recorded_group(self, agent_id):
        """The live process group recorded for this mind, verified to be running this mind's own program. A group
        whose leader has exited still counts while any member runs from this mind's workspace (found by OmegaDesign,
        2026-10-04: a child outlived its leader and the mind looked stopped)."""
        try:
            pgid = int(self._pidfile(agent_id).read_text().strip())
        except FileNotFoundError:
            proc = self.procs.get(agent_id)
            if proc is None:
                return None
            pgid = proc.pid   # an in-memory child remains custody when its PID file is missing
        except (OSError, ValueError) as exc:
            raise ProcessObservationError(f"could not read the process record for {agent_id}") from exc
        proc = self.procs.get(agent_id)
        if proc is not None and proc.pid != pgid:
            raise ProcessObservationError(f"conflicting process group records for {agent_id}")
        if pgid <= 1:
            raise ProcessObservationError(f"invalid process group in the record for {agent_id}")
        root = os.path.realpath(self.workspace.path(agent_id))
        members = self._group_members(pgid)
        if any(root in cmd for _, cmd in members):
            return pgid
        for pid, _ in members:
            if self._cwd(pid) == root:
                return pgid
        if members:
            # A child may legitimately change cwd/command after its leader exits.
            # A nonmatching group cannot be distinguished from PGID reuse by these
            # observations, so retain custody without signaling or claiming absence.
            raise ProcessObservationError(f"could not verify ownership of surviving process group {pgid} for {agent_id}")
        return None

    @staticmethod
    def _cwd(pid):
        """Return a positively observed cwd; unavailable or failed observations stay unknown."""
        try:
            proc = pathlib.Path(f"/proc/{pid}/cwd")
            if proc.exists():
                # realpath alone is non-strict and can return an unreadable link's
                # pathname. Read the kernel link first so that failure is explicit.
                target = os.readlink(proc)
                if not os.path.isabs(target):
                    raise ProcessObservationError(f"invalid cwd observation for process {pid}")
                return os.path.realpath(target)
        except OSError as exc:
            raise ProcessObservationError(f"could not observe cwd for process {pid}") from exc
        try:
            result = subprocess.run(["lsof", "-a", "-d", "cwd", "-p", str(pid), "-Fn"],
                                    capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ProcessObservationError(f"could not query cwd for process {pid}") from exc
        # Failed lsof may still emit a matching path. It is never ownership proof.
        if result.returncode != 0:
            raise ProcessObservationError(f"cwd query failed for process {pid}")
        names = [line[1:] for line in result.stdout.splitlines() if line.startswith("n")]
        if len(names) != 1 or not os.path.isabs(names[0]):
            raise ProcessObservationError(f"incomplete or ambiguous cwd observation for process {pid}")
        return os.path.realpath(names[0])

    def _end_group(self, pgid, proc=None):
        """TERM the whole group, wait for every member to exit, then KILL what is left and wait again. Ownership was
        proven before the first signal, so it is not re-proven between signals."""
        for sig, wait in ((signal.SIGTERM, 10.0), (signal.SIGKILL, 5.0)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                pass   # still confirm absence below; a signal result alone is not the observation
            except OSError as exc:
                raise ProcessObservationError(f"could not signal process group {pgid}") from exc
            deadline = time.time() + wait
            while time.time() < deadline:
                if proc is not None:
                    proc.poll()                      # reap our own leader so it does not linger as a zombie
                if not self._group_members(pgid):
                    return True
                time.sleep(0.1)
        return not self._group_members(pgid)

    def start(self, agent, env):
        if self.status(agent["id"]) == "running":
            return
        if agent.get("kind") == "iter" and os.environ.get("HIVE_ALLOW_LOCAL_ITER") != "1":
            raise StartRefused("Iter workers rewrite their own tools and must run sandboxed: use the docker "
                               "driver, or set HIVE_ALLOW_LOCAL_ITER=1 to accept running one on this host")
        root = self.workspace.path(agent["id"])
        log = open(root / "agent.log", "ab")
        # minds never inherit the hive's environment (secrets, keys, app settings): an allowlist only
        full_env = mind_environment(os.environ, dict(env, TMPDIR=str(root / "tmp")))
        (root / "tmp").mkdir(exist_ok=True)
        command = self.workspace.command(agent, self.petta_path)
        requested = mind_sandbox_requested()
        if requested and not sandbox_available():
            log.close()
            raise RuntimeError("OS isolation was requested (HIVE_MIND_SANDBOX=1) but this host has none "
                               "(macOS sandbox-exec, or Linux Landlock ABI 4+): refusing to start the mind without it")
        self.isolation[agent["id"]] = {"environment": "allowlisted", "os_sandbox": bool(requested),
                                       "profile": None, "started_at": time.time()}
        if requested:
            # an OS boundary around the whole process tree (hive/supervisor/sandbox.py)
            command, prof = sandbox_wrap(command, root, runtime_roots(self.petta_path, self.workspace.settings.core_root,
                                                                       [self.workspace.settings.data_dir / "libs"]),
                                         self.workspace.settings.data_dir / "sandbox", agent["id"])
            self.isolation[agent["id"]]["profile"] = prof
        self.procs[agent["id"]] = subprocess.Popen(
            command,
            cwd=root, env=full_env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        log.close()
        self._pidfile(agent["id"]).write_text(str(self.procs[agent["id"]].pid))   # session leader = process group id

    def stop(self, agent_id):
        proc = self.procs.get(agent_id)
        groups = []
        if proc is not None and proc.poll() is None:
            groups.append(proc.pid)                  # a live child proves its group; an exited leader does not
        adopted = self._recorded_group(agent_id)     # a mind from before a hive restart, or a leader whose child lives on
        if adopted is not None and adopted not in groups:
            groups.append(adopted)
        ended = all([self._end_group(g, proc if proc is not None and g == proc.pid else None) for g in groups])
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        if not ended:
            raise RuntimeError(f"{agent_id}: its processes did not exit after TERM and KILL; the record is kept")
        if proc is not None and self.procs.get(agent_id) is proc:
            self.procs.pop(agent_id)
        try:
            self._pidfile(agent_id).unlink()
        except OSError:
            pass

    def status(self, agent_id):
        proc = self.procs.get(agent_id)
        if proc is not None and proc.poll() is None:
            return "running"
        # A reaped leader is not proof its children ended. Preserve uncertainty
        # here too, so verify_stopped cannot mistake a surviving group for exited.
        if self._recorded_group(agent_id) is not None:
            return "running"
        return "exited" if proc is not None else "absent"

    def logs(self, agent_id, tail=200):
        return _tail(self.workspace.path(agent_id) / "agent.log", tail)

    def execution(self, agent_id):
        proc = self.procs.get(agent_id)
        if proc is not None:
            if proc.poll() is not None and self._recorded_group(agent_id) is None:
                return None
            # A positively owned surviving child keeps this execution identity;
            # leader exit alone is not a genuinely new Ask context boundary.
            return f"local:{proc.pid}:{(self.isolation.get(agent_id) or {}).get('started_at')}"
        group = self._recorded_group(agent_id)
        return f"local:{group}:adopted" if group is not None else None


class DockerDriver(Driver):
    """One container per agent from the omegadots agent image.

    The checkout and the chromadb library are mounted read-only; the agent's
    memory directory is the only writable mount.
    """

    name = "docker"

    def __init__(self, workspace: Workspace, image=None, network=None, command=None):
        self.workspace = workspace
        self.image = image or os.environ.get("HIVE_AGENT_IMAGE", "omegadots/agent:dev")
        self.network = network or os.environ.get("HIVE_DOCKER_NETWORK", "host")
        self.command = command or ["sh", "/opt/PeTTa/run.sh", "/agent/run.metta"]

    @staticmethod
    def container(agent_id):
        return f"hive-agent-{agent_id}"

    def _docker(self, *args, check=False):
        return subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, check=check)

    def start(self, agent, env):
        name = self.container(agent["id"])
        if agent.get("kind") == "iter":
            iter_preflight(os.environ.get("HIVE_ITER_IMAGE", ITER_IMAGE_DEFAULT))
        if self.status(agent["id"]) == "running":
            return
        self._docker("rm", "-f", name)
        root = self.workspace.path(agent["id"])
        settings = self.workspace.settings
        if agent.get("kind") == "iter":
            args = ["run", "-d", "--name", name, "--network", self.network, "--label", "omegadots.agent=" + agent["id"],
                    "--memory", "1g", "--pids-limit", "256", "-v", f"{root}:/agent", "-w", "/agent"]
            for key, value in env.items():
                args += ["-e", f"{key}={value}"]
            args += [os.environ.get("HIVE_ITER_IMAGE", ITER_IMAGE_DEFAULT), "python3", "/agent/iter.py"]
            result = self._docker(*args)
            if result.returncode != 0:
                raise RuntimeError(f"docker run failed: {result.stdout.strip()}")
            return
        env = dict(env, OMEGACLAW_MEMORY_DIR="/agent/memory")
        args = ["run", "-d", "--name", name, "--network", self.network,
                "--label", "omegadots.agent=" + agent["id"],
                "-v", f"{root / 'memory'}:/agent/memory",
                "-v", f"{root / 'run.metta'}:/agent/run.metta:ro",
                "-v", f"{settings.core_root}:/agent/repos/OmegaClaw-Core:ro",
                "-v", f"{self.workspace.chromadb_lib()}:/agent/repos/petta_lib_chromadb:ro",
                "-w", "/agent"]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args += [self.image, *self.command]
        result = self._docker(*args)
        if result.returncode != 0:
            raise RuntimeError(f"docker run failed: {result.stdout.strip()}")

    def stop(self, agent_id):
        """Stop and remove the container, then confirm it is gone. A container already absent is fine; one still there,
        or a daemon that cannot say, raises, so no caller records a stop (or a delete) over a mind still running."""
        name = self.container(agent_id)
        self._docker("stop", "-t", "10", name)        # an absent container fails here; rm and the check below decide
        removed = self._docker("rm", "-f", name)
        check = self._docker("inspect", "-f", "{{.State.Running}}", name)
        if check.returncode == 0:
            raise RuntimeError(f"{agent_id}: container {name} is still there after stop and rm -f "
                               f"({(removed.stdout or '').strip()[:300]})")
        if not self.missing_container(check, name):   # only docker's own "no such object/container" means gone
            raise RuntimeError(f"{agent_id}: could not confirm container {name} is gone "
                               f"({(check.stdout or '').strip()[:300]})")

    def verify_stopped(self, agent_id):
        """Strict proof for Supervisor.verify_stopped (stand-in r5): docker's own missing-container answer, or an inspect
        that succeeds with State.Running exactly false. A daemon error, empty or odd output raises."""
        name = self.container(agent_id)
        check = self._docker("inspect", "-f", "{{.State.Running}}", name)
        if self.missing_container(check, name):
            return "absent"
        if check.returncode == 0 and (check.stdout or "").strip() == "false":
            return "exited"
        if check.returncode == 0 and (check.stdout or "").strip() == "true":
            raise RuntimeError(f"{agent_id}: still running after stop")
        raise RuntimeError(f"{agent_id}: could not confirm container {name} is stopped "
                           f"({(check.stdout or '').strip()[:300]})")

    @staticmethod
    def missing_container(result, name):
        """Docker's specific answer for a container that does not exist, with a failing exit status. Anything else (a
        daemon that is down, a socket that is missing: "no such file or directory", a timeout) is not proof it is gone."""
        if result.returncode == 0:
            return False
        out = (result.stdout or "").strip()
        return bool(re.fullmatch(rf"(?is)(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):\s*{re.escape(name)}\s*", out))

    def status(self, agent_id):
        result = self._docker("inspect", "-f", "{{.State.Running}}", self.container(agent_id))
        if result.returncode != 0:
            return "absent"
        return "running" if result.stdout.strip() == "true" else "exited"

    def logs(self, agent_id, tail=200):
        result = self._docker("logs", "--tail", str(int(tail)), self.container(agent_id))
        return result.stdout.splitlines() if result.returncode == 0 else []

    def execution(self, agent_id):
        result = self._docker("inspect", "-f", "{{.State.Running}} {{.Id}} {{.State.StartedAt}}", self.container(agent_id))
        parts = result.stdout.split() if result.returncode == 0 else []
        return f"docker:{parts[1]}:{parts[2]}" if len(parts) == 3 and parts[0] == "true" else None


class Supervisor:
    """Owns drivers and keeps agents in their desired state."""

    def __init__(self, settings, drivers=None):
        self.settings = settings
        self.workspace = Workspace(settings)
        self.drivers = drivers or {
            "local": LocalDriver(self.workspace, settings.petta_path),
            "docker": DockerDriver(self.workspace),
        }
        self.hive = None
        self._restarts: dict[str, list[float]] = {}
        self._stop = threading.Event()
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self._transitions: dict[str, int] = {}   # minds whose stop/sleep/start-then-record is in progress on its lock
        self._generations: dict[str, int] = {}   # per mind, bumped by every start and stop (hub admission fence)

    def lock(self, agent_id):
        """One re-entrant lock per mind. Start, stop, reconfigure and each reconciliation decision hold it, and so does
        every caller's stop-then-record sequence, so a completed stop is never undone by an in-flight restart
        (Root r6 stop/reconcile race, 2026-10-05)."""
        with self._locks_guard:
            return self._locks.setdefault(agent_id, threading.RLock())

    @contextlib.contextmanager
    def transition(self, agent_id):
        """The mind's lock, held for a whole lifecycle change (effect then record), marked as in progress.
        The lock is re-entrant, so the lock alone does not stop a reconciliation that runs on the same thread inside
        the change (Root r6 reproducer: check() injected from the driver's stop); _reconcile skips a marked mind.
        Other threads block on the lock and see the recorded outcome. Cleared on every exit, errors included."""
        with self.lock(agent_id):
            with self._locks_guard:
                self._transitions[agent_id] = self._transitions.get(agent_id, 0) + 1
            try:
                yield
            finally:
                with self._locks_guard:
                    left = self._transitions.get(agent_id, 1) - 1
                    if left:
                        self._transitions[agent_id] = left
                    else:
                        self._transitions.pop(agent_id, None)

    def in_transition(self, agent_id):
        with self._locks_guard:
            return bool(self._transitions.get(agent_id))

    def generation(self, agent_id):
        """The mind's lifecycle generation: every start and every stop (stop, sleep, delete, move, shutdown) moves it on,
        under the mind's lock. A hub admission records it; the registration after the socket is accepted must still see
        it, so a connection admitted before a stop (or a stop and a new start) is never registered (Review B1)."""
        with self._locks_guard:
            return self._generations.get(agent_id, 0)

    def _next_generation(self, agent_id):
        with self._locks_guard:
            self._generations[agent_id] = self._generations.get(agent_id, 0) + 1

    def shutdown(self):
        """The hive is shutting down: no reconciliation pass restarts anything from here on, including one already
        running on a worker thread when the reconcile task was cancelled (BYPASS-2/SEM-3)."""
        self._stop.set()

    def attach(self, hive):
        self.hive = hive
        self.workspace.programs = hive.programs

    def driver(self, agent):
        return self.drivers[agent.get("driver") or self.settings.default_driver]

    def _agent(self, agent_id):
        # Internal stop/driver bookkeeping must not recurse into read-triggered
        # revocation cleanup. Starts have their own final current-authority gate.
        if getattr(self.hive, "person_swarms", None) is not None:
            return self.hive.agent_view(self.hive._agent_row(agent_id, guard=False), guard=False)
        return self.hive.agent(agent_id)

    def prepare(self, agent, token):
        self.workspace.create(agent, token)

    def reconfigure(self, agent):
        with self.lock(agent["id"]):
            self.workspace.write_prompt(agent)

    def reconfigure_tools(self, agent):
        with self.transition(agent['id']):
            return self._reconfigure_tools_locked(agent)

    def _reconfigure_tools_locked(self, agent):
        # The supervisor owns stop/rebuild/resume; the LocalDriver profile is
        # unchanged. Preflight before interrupting an existing process.
        plan = self.workspace.tools_plan(agent) if (agent.get('options') or {}).get('tools') else None
        was_running = self.driver(agent).status(agent['id']) == 'running'
        self.stop(agent['id'])
        try:
            self.workspace.write_tools(agent, plan)
        except Exception:
            self.hive.set_status(agent['id'], 'error', desired='stopped', error='Tools wrapper rebuild failed')
            raise
        if was_running:
            self.start(agent['id'])

    def mind_url(self, agent):
        """The address a mind dials the hive at (API, hub, LLM gateway), recomputed at every start as the sandbox
        profile is (wrap): the two stay in lockstep only while neither caches.

        A local mind dials where the hive listens, HIVE_HOST and HIVE_PORT, never the client-facing HIVE_PUBLIC_URL: on
        the cloud that is the SSH-tunnel port 8710, which the server does not listen on, and minds that dialled it
        stayed 'starting' and never reached the hub or the gateway (2026-10-08). The port is the sandbox's own source
        (sandbox.loopback_ports). A bind of 127.0.0.1 or the IPv4 wildcard (IPv4-mapped forms and "localhost"
        included) is dialled on 127.0.0.1, the one address both OS sandboxes allow (the Linux relay forwards only
        there). Any other bind (another 127/8 address, IPv6 with "::" dialled as ::1, a specific address or a name) is
        dialled as itself, which an OS-sandboxed mind cannot reach, so that start is refused. A docker mind keeps
        HIVE_PUBLIC_URL, unchanged."""
        driver = agent.get("driver") or self.settings.default_driver
        if driver != "local":
            return self.settings.public_url.rstrip("/")
        try:
            port = loopback_ports()[0]
        except ValueError as exc:
            raise StartRefused(f"HIVE_PORT or HIVE_MIND_SANDBOX_PORTS is not a valid port ({exc})") from None
        raw = os.environ.get("HIVE_HOST", "").strip() or "127.0.0.1"
        bare = raw[1:-1] if raw.startswith("[") and raw.endswith("]") else raw
        try:
            ip = ipaddress.ip_address(bare)
        except ValueError:
            ip = ipaddress.ip_address("127.0.0.1") if bare.lower() == "localhost" else None
        if ip is not None and ip.version == 6 and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if ip is not None and ip.version == 4 and str(ip) in ("127.0.0.1", "0.0.0.0"):
            return f"http://127.0.0.1:{port}"
        if mind_sandbox_requested():
            raise StartRefused(f"OS isolation (HIVE_MIND_SANDBOX=1) lets a mind reach only 127.0.0.1:{port}, but this "
                               f"hive listens on {raw} (HIVE_HOST): bind the hive to 127.0.0.1 or 0.0.0.0")
        if ip is None:
            return f"http://{bare}:{port}"
        if ip.version == 6:
            if ip.scope_id:
                raise StartRefused(f"a mind cannot dial the scoped IPv6 bind {raw} (HIVE_HOST): use a global address, "
                                   f"loopback or a wildcard")
            return f"http://[{'::1' if ip.is_unspecified else ip.compressed}]:{port}"
        return f"http://{ip.compressed}:{port}"

    def env(self, agent):
        api_url = self.mind_url(agent)
        env = self.workspace.env(agent, api_url.replace("http", "ws", 1) + "/agent-hub", api_url)
        # A new identity for every launch: the hub channel tells its own daemon from an earlier launch's by it, since
        # pids repeat in a mind's own pid namespace (modules/channel_hive _launch_id).
        env["HIVE_LAUNCH_ID"] = secrets.token_hex(8)
        if (agent.get("driver") or self.settings.default_driver) == "local":
            # The mind's hub channel runs as its own Python process (modules/channel_hive). Inside PeTTa the Python is
            # the one SWI-Prolog's janus embeds, which on the cloud is the system python3 without the hive's packages
            # (websockets): the channel failed every connect and the mind never joined (2026-10-08). A local mind
            # gets this hive's own interpreter, which carries them and which both OS sandboxes already admit.
            env["HIVE_PYTHON"] = sys.executable
        return env

    STUDIO_MODULE = "hive_studio"     # J3 host R6.1: modules/hive_studio (workspace.STUDIO_MODULE names the same)

    def _studio_skills(self, agent):
        """J3 host R6.1: None for a mind that never takes Studio steps (not omega); else whether Studio sessions are on."""
        if agent.get("kind") != "omega":
            return None
        studio = getattr(self.hive, "studio", None) if self.hive is not None else None
        return bool(getattr(studio, "enabled", False))

    def execution(self, agent_id):
        try:
            return self.driver(self._agent(agent_id)).execution(agent_id)
        except Exception:
            return None

    @staticmethod
    def _evidence(driver, agent_id):
        """The driver's running execution identity, or _UNKNOWN when it cannot say (never fails a start)."""
        try:
            return driver.execution(agent_id)
        except Exception:
            return _UNKNOWN

    def start(self, agent_id):
        with self.transition(agent_id):
            # Lifecycle (8833a3d): every start moves the generation first, no-op starts included; it is the hub
            # admission fence, not evidence of an execution, and Ask never reads it.
            self._next_generation(agent_id)
            agent = self._agent(agent_id)
            person_swarms = getattr(self.hive, "person_swarms", None)
            if person_swarms is not None:
                person_swarms.require_current(agent_id)
            driver = self.driver(agent)
            before = self._evidence(driver, agent_id)
            env = self.env(agent)
            env.pop("OMEGACLAW_EXTRA_MODULES", None)   # R6.2: the supervisor owns this switch for every mind
            studio = self._studio_skills(agent)
            if studio is not None:          # an omega mind: the Studio maker skills follow the hive's Studio setting
                write = getattr(getattr(self, "workspace", None), "write_studio_skills", None)
                if callable(write):         # a supervisor built without a workspace (tests) has no run.metta to keep
                    write(agent, studio)
                if studio:
                    env["OMEGACLAW_EXTRA_MODULES"] = self.STUDIO_MODULE
            if person_swarms is not None:
                person_swarms.require_current(agent_id)
            driver.start(agent, env)
            after = self._evidence(driver, agent_id)
            # Ask: owner evidence of a genuinely new execution, inside the same transition: start returned and the
            # running identity changed from a known one. A start that found the mind running, failed, or could not
            # read the identity is no context boundary (OmegaReview 7bfad52 B1; ask.py note_boundary).
            ask = getattr(self.hive, "ask", None) if self.hive is not None else None
            if ask is not None and _UNKNOWN not in (before, after) and after is not None and after != before:
                ask.note_boundary(agent_id, after)

    def stop(self, agent_id):
        with self.transition(agent_id):
            self._next_generation(agent_id)   # first: an admission taken before this stop can no longer register
            try:
                agent = self._agent(agent_id)
            except Exception:
                return
            self.driver(agent).stop(agent_id)
            # A connection registered before this stop won is withdrawn and closed, under the same lock, so the
            # registration and the withdrawal are serialized. External members (kind module) keep their connection.
            withdraw = getattr(self.hive, "withdraw_connection", None)
            if agent.get("kind") != "module" and callable(withdraw):
                withdraw(agent_id)

    def verify_stopped(self, agent_id):
        """Positive proof a mind is not running, after a stop (Kimi K1 on 021ef16): its driver reports it absent or
        exited. A stop can do nothing (a mind this supervisor does not track, or one it cannot read), so a mind that
        cannot be read, or a driver that says running (or anything else), raises, and no delete is recorded over it."""
        try:
            agent = self._agent(agent_id)
        except Exception as exc:
            raise RuntimeError(f"{agent_id}: cannot verify it stopped ({exc})") from exc
        driver = self.driver(agent)
        strict = getattr(driver, "verify_stopped", None)
        if callable(strict):          # a driver with its own strict proof (Docker) decides; its uncertainty raises
            strict(agent_id)
            return
        status = driver.status(agent_id)
        if status not in ("absent", "exited", "stopped"):   # positive answers only; None or anything else is no proof
            raise RuntimeError(f"{agent_id}: still {status or 'unknown'} after stop")

    def logs(self, agent_id, tail=200):
        return self.driver(self._agent(agent_id)).logs(agent_id, tail)

    def check(self):
        """One reconciliation pass: restart crashed agents that should be awake."""
        if self.hive is None or self._stop.is_set():
            return
        # J3 host R3 (handoff spec r2.4 §1, §8.1): with Studio sessions on, a Studio worker may hold a mind's lock across
        # a slow driver stop or start, so every mind's lock is taken non-blocking and a busy mind is skipped for this
        # pass (reconciled on a later one, with a fresh re-read under its lock). With Studio off nothing but the
        # existing callers takes these locks and the pass blocks per mind exactly as before.
        studio = getattr(self.hive, "studio", None)
        skip_busy = bool(getattr(studio, "enabled", False))
        for listed in self.hive.db.all("SELECT id FROM agents WHERE deleted = 0 AND kind != 'module'"):
            if not skip_busy:
                with self.lock(listed["id"]):
                    self._reconcile_logged(listed["id"])
                continue
            lock = self.lock(listed["id"])
            if not lock.acquire(blocking=False):
                continue
            try:
                self._reconcile_logged(listed["id"])
            finally:
                lock.release()

    def _reconcile_logged(self, agent_id):
        try:
            self._reconcile(agent_id)
        except ProcessObservationError as exc:
            logging.getLogger("hive").warning("reconcile could not observe mind %s (%s); tracking retained",
                                               agent_id, type(exc).__name__)
        except Exception as exc:
            # A failed stop (including a verified but stubborn group)
            # must not prevent reconciliation of every later mind.
            logging.getLogger("hive").warning("reconcile failed for mind %s (%s); continuing other minds",
                                               agent_id, type(exc).__name__)

    def _reconcile(self, agent_id):
        if self.in_transition(agent_id):
            return   # a stop, sleep or start of this mind is mid-way on this thread: it records the outcome, not us
        if self._stop.is_set():
            return   # shutting down: the shutdown stops keep desired=awake, so the row alone would restart the mind
        # Re-read under the mind's lock: a row captured before a stop finished must not restart it.
        row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0 AND kind != 'module'", (agent_id,))
        if row is None or row["desired"] != "awake":
            return
        swarms = getattr(self.hive, "person_swarms", None)
        if swarms is not None:
            binding, reason = swarms.current(agent_id)
            if binding is not None and reason is not None:
                swarms.read_row(row)
                return
        studio = getattr(self.hive, "studio", None)
        if studio is not None and studio.studio_owns(agent_id):
            return   # J3 R3 (handoff spec r2.4 §2): under the lock, after the re-read: Studio alone starts its maker
        agent = self.hive.agent_view(row)
        state = self.driver(agent).status(agent["id"])
        if state == "running":
            return
        minds = getattr(self.hive, "minds", None)
        if minds is not None and minds.is_child(agent["id"]):
            minds.exited(agent["id"])   # r2.12 §7: a child that ended is observed, never restarted automatically
            return
        recent = [t for t in self._restarts.get(agent["id"], []) if time.time() - t < 300]
        if len(recent) >= 5:
            if row["status"] != "error":
                tail = " | ".join(line.strip() for line in self.logs(agent["id"], 5) if line.strip())
                self.hive.set_status(agent["id"], "error",
                                     error=f"crashed 5 times in 5 minutes; last log: {tail[-400:]}")
            return
        recent.append(time.time())
        self._restarts[agent["id"]] = recent
        self.hive.set_status(agent["id"], "starting")
        try:
            self.start(agent["id"])
        except Exception as exc:
            self.hive.set_status(agent["id"], "error", error=f"start failed: {exc}")
