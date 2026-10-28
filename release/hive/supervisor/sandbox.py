"""What a mind process may see: its environment and, on macOS, what the OS lets it touch.

Minds run as the hive's own OS user, so the hive's policy gate alone cannot stop a mind's shell or Python from
reading the hive's files, environment or Docker socket. Two OS-level boundaries close that:

1. mind_environment(): a mind gets an allowlisted environment, never the hive's (no Google secret, provider keys,
   app settings or launcher variables). Minds pay for models through the hive's gateway with their member token.
2. profile(): a sandbox-exec profile (deny by default). The mind may read only its own folder and the runtime it
   needs (system libraries, PeTTa, SWI-Prolog, the Python venv, the platform's code), write only its own folder,
   and connect only to the hive and the OmegaCode service on loopback. Every child process (shell, python) inherits
   it. So hive secrets, other minds' folders, private apps and the Docker socket are unreachable, and every model or
   network call has to go through the hive's gateway, where egress is policed.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import sys

PASS = {"PATH", "HOME", "LANG", "USER", "LOGNAME", "SHELL", "TERM", "PETTA_PATH", "PYTHONPATH", "VIRTUAL_ENV",
        "OMEGACODE_SRC", "OMEGACODE_URL", "SWI_HOME_DIR"}
# Set per mind by Supervisor.start only (J3 host R6.2): OMEGACLAW_EXTRA_MODULES loads modules/hive_studio into an omega
# mind while Studio sessions are on; a value in the hive's own environment must never reach any mind.
PER_MIND = {"OMEGACLAW_EXTRA_MODULES"}
SECRETISH = ("SECRET", "TOKEN", "KEY", "PASSWORD", "PASS", "CREDENTIAL", "COOKIE")


def mind_environment(hive_env, mind_env):
    """The hive's environment filtered to what minds need, then the mind's own variables on top."""
    out = {}
    for name, value in hive_env.items():
        if name in PASS or name.startswith("LC_"):
            out[name] = value
        elif name in PER_MIND:
            continue           # the supervisor's own per-mind switch: never inherited from the hive's environment
        elif name.startswith("OMEGACLAW_") and not any(s in name for s in SECRETISH):
            out[name] = value
    out.update(mind_env)
    return out


# Set only by the local-owner hive's first-boot preflight when a check failed (hive/supervisor/preflight.py, J1 r4
# ST3): from then on this process has no usable boundary, so minds and tools stay refused (never unsandboxed).
_REFUSED = None
# Set by the same preflight when the mind rows passed but the tool rows could not run (no Node configured, J1b r1.1):
# minds may run, tools stay refused, because nothing proved the tool path's boundary on this host.
_TOOLS_REFUSED = None


def mind_sandbox_requested(environ=None):
    """The one reading of HIVE_MIND_SANDBOX (J1b r1.1, stand-in r1.0 P1): exactly "1", nothing stripped or coerced.
    The launcher (drivers.py), delegation and the local-owner start check all ask this, so a value the start check
    accepts is always a value that sandboxes minds."""
    environ = os.environ if environ is None else environ
    return environ.get("HIVE_MIND_SANDBOX") == "1"


def refuse_tools(reason):
    """This process may run minds but no tools: the preflight could not verify the tool path."""
    global _TOOLS_REFUSED
    _TOOLS_REFUSED = str(reason or "the sandbox preflight did not verify the tool path")


def tools_refused():
    return _REFUSED or _TOOLS_REFUSED


def refuse(reason):
    """This process may not sandbox anything (the preflight failed); every wrap and availability check says none."""
    global _REFUSED
    _REFUSED = str(reason or "the sandbox preflight failed")


def refused():
    return _REFUSED


def interpreter():
    """The Linux launcher's interpreter (J1 r4 ST1, r4.1 K-1): HIVE_SANDBOX_PYTHON, read from the hive's own
    environment where wrap() runs (minds and tool runs alike), as ``python -I -S`` (landlock.py imports only the
    standard library); unset, the hive's own interpreter exactly as before."""
    chosen = os.environ.get("HIVE_SANDBOX_PYTHON", "").strip()
    if not chosen:
        return [sys.executable]
    if not os.path.isabs(chosen):
        raise RuntimeError("HIVE_SANDBOX_PYTHON must be an absolute path")
    return [chosen, "-I", "-S"]


def backend():
    """The OS isolation this host can enforce: 'sandbox-exec' (macOS), 'landlock' (Linux, ABI 4+), or None."""
    if _REFUSED is not None:
        return None
    if sys.platform == "darwin":
        return "sandbox-exec" if shutil.which("sandbox-exec") is not None else None
    if sys.platform.startswith("linux"):
        from . import landlock
        return "landlock" if landlock.available() else None   # namespaces + Landlock (ABI 1+)
    return None


def available():
    return backend() is not None


def wrap(command, mind_dir, read_roots, profile_dir, agent_id, ports=None, programs=()):
    """`command` wrapped in this host's OS boundary; writes the profile it enforces and returns (command, path)."""
    ports = loopback_ports() if ports is None else ports
    kind = backend()
    profile_dir = pathlib.Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    if kind == "sandbox-exec":
        path = profile_dir / f"{agent_id}.sb"
        path.write_text(profile(mind_dir, read_roots, ports))
        return ["sandbox-exec", "-f", str(path)] + list(command), str(path)
    if kind == "landlock":
        import json
        from . import landlock
        path = profile_dir / f"{agent_id}.landlock.json"
        path.write_text(json.dumps(landlock.profile(mind_dir, safe_roots(read_roots), ports, programs), indent=1))
        return interpreter() + [str(pathlib.Path(__file__).with_name("landlock.py")), str(path), "--"] + list(command), str(path)
    raise RuntimeError("no OS isolation is available on this host")


# What every macOS profile lets a mind or tool read (besides "/" itself, literally): one list, used by profile() and by
# admission checks that must know what the sandbox grants (sandbox_run._granted).
MAC_SYSTEM_READ = ("/System", "/usr", "/bin", "/sbin", "/Library/Frameworks", "/Library/Developer",
                   "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc", "/dev")


def _q(path):
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def loopback_ports(environ=None):
    """The loopback ports a mind may reach: this hive's own (HIVE_PORT, default 8700) and the operator's extras
    (HIVE_MIND_SANDBOX_PORTS, comma-separated). The live layout (nothing set) keeps the OmegaCode service port 8724;
    a host on any other port never inherits access to ports that belong to another host."""
    environ = os.environ if environ is None else environ
    def port(raw):
        raw = str(raw).strip()
        if not raw.isdigit() or not 1 <= int(raw) <= 65535:
            raise ValueError(f"not a port: {raw!r}")
        return int(raw)
    hive = port(environ.get("HIVE_PORT") or 8700)
    extra_raw = environ.get("HIVE_MIND_SANDBOX_PORTS")
    if extra_raw is None and not environ.get("HIVE_PORT"):
        extra_raw = "8724"
    extras = [port(p) for p in (extra_raw or "").split(",") if p.strip()]
    return tuple(dict.fromkeys([hive, *extras]))


def profile(mind_dir, read_roots, ports=None):
    """A deny-by-default sandbox-exec profile for one mind."""
    ports = loopback_ports() if ports is None else ports
    mind_dir = pathlib.Path(mind_dir).resolve()
    reads = sorted({p for p in safe_roots(read_roots) if pathlib.Path(p).exists()})
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork)",
        "(allow process-exec)",
        "(allow signal (target same-sandbox))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix-shm)",
        # path resolution needs metadata (existence, size) anywhere; contents are what is restricted
        "(allow file-read-metadata)",
        "(allow file-read* (literal \"/\") " + " ".join(f"(subpath {_q(p)})" for p in MAC_SYSTEM_READ) + ")",
        "(allow file-read* " + " ".join(f"(subpath {_q(p)})" for p in reads) + ")" if reads else "",
        f"(allow file-read* file-write* (subpath {_q(mind_dir)}))",
        # Never /dev/tty: the hive's controlling terminal would let a mind inject input (TIOCSTI), as on Linux.
        # /dev/dtracehelper is the dyld/DTrace registration device every macOS process writes at start-up.
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
        "(allow network-outbound " + " ".join(f'(remote ip "localhost:{p}")' for p in ports) + ")",
        "(allow network-bind (local ip \"localhost:*\"))",
    ]
    return "\n".join(line for line in lines if line) + "\n"


def runtime_roots(petta_path, core_root, extra=()):
    """What a mind must be able to read to run at all (never the hive's data directory)."""
    home = pathlib.Path.home()
    roots = [petta_path, core_root, home / "swipl-patched", "/opt/homebrew", "/usr/local/lib", "/usr/local/opt"]
    swipl = shutil.which("swipl")   # wherever this host's SWI-Prolog lives (e.g. /opt/omegahive/runtime/swipl on Linux)
    if swipl:
        executable = pathlib.Path(os.path.realpath(swipl))
        swipl_root = executable.parent.parent
        # Linux SWI installs bin/<arch>/swipl below its home alongside boot.prc and library/.
        if executable.name == "swipl" and swipl_root.name == "bin" and swipl_root.parent.name == "swipl":
            swipl_root = swipl_root.parent
        roots.append(str(swipl_root))
    venv = pathlib.Path(os.environ.get("VIRTUAL_ENV") or pathlib.Path(core_root).parent / ".runtime" / "venv312")
    roots += [venv, os.environ.get("OMEGACODE_SRC")]
    cfg = venv / "pyvenv.cfg"   # the interpreter the venv was made from (its standard library)
    if cfg.exists():
        for line in cfg.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home" and value.strip():
                roots.append(str(pathlib.Path(os.path.realpath(value.strip())).parent))
    return safe_roots(list(roots) + list(extra))


def safe_roots(roots):
    """Refuse any root that would open too much: '/', the home folder, or an ancestor of either."""
    home = pathlib.Path.home().resolve()
    out = []
    for r in roots:
        if not r:
            continue
        p = pathlib.Path(r).resolve()
        if p == pathlib.Path("/") or p == home or p in home.parents:
            continue
        out.append(str(p))
    return out
