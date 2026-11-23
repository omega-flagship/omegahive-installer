"""Purpose: Define and launch the mind process environment and OS sandbox.

Minds run as the hive's own OS user, so the hive's policy gate alone cannot stop a mind's shell or Python from
reading the hive's files, environment or Docker socket. Two OS-level boundaries close that:

1. mind_environment(): a mind gets an allowlisted environment, never the hive's (no Google secret, provider keys,
   app settings or launcher variables). Minds pay for models through the hive's gateway with their member token.
   It does get where the hive's embedding model is cached (HF_HOME, HF_HUB_CACHE) and the offline switches, so a
   mind's memory can load the model read-only, and never a Hugging Face token: HF_TOKEN_PATH points at /dev/null and
   no variable huggingface_hub takes a token from (HF_TOKEN_SOURCES) reaches it.
   It also gets OMEGACODE_SRC, the hive's own Code release (code_client_src), so a hive with Code gives its minds the
   OmegaCode client the workspace skills call without any installer setting it.
2. profile(): a sandbox-exec profile (deny by default). The mind may read only its own folder and the runtime it
   needs (system libraries, PeTTa, SWI-Prolog, the Python venv, the platform's code), write only its own folder,
   and connect only to the hive and the OmegaCode service on loopback. Every child process (shell, python) inherits
   it. So hive secrets, other minds' folders, private apps and the Docker socket are unreachable, and every model or
   network call has to go through the hive's gateway, where egress is policed. An Iter worker's MeTTa runs as a
   swipl of its own (think_swipl), which the profile also keeps off the network and out of every folder but a
   scratch one, as Linux's Landlock keeps that MeTTa.
"""

from __future__ import annotations

import os
import math
import pathlib
import re
import shutil
import sys

PASS = {"PATH", "HOME", "LANG", "USER", "LOGNAME", "SHELL", "TERM", "PETTA_PATH", "PYTHONPATH", "VIRTUAL_ENV",
        "OMEGACODE_SRC", "OMEGACODE_URL", "SWI_HOME_DIR",
        "HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"}
# Set per mind by Supervisor.start only (J3 host R6.2): OMEGACLAW_EXTRA_MODULES loads modules/hive_studio into an omega
# mind while Studio sessions are on; a value in the hive's own environment must never reach any mind.
PER_MIND = {"OMEGACLAW_EXTRA_MODULES"}
SECRETISH = ("SECRET", "TOKEN", "KEY", "PASSWORD", "PASS", "CREDENTIAL", "COOKIE")
# Where huggingface_hub takes a token from before its token file (utils/_auth.py): an OIDC exchange when
# HF_OIDC_RESOURCE is set, then HF_TOKEN or HUGGING_FACE_HUB_TOKEN. None of them reaches a mind, even from its own
# variables.
HF_TOKEN_SOURCES = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_OIDC_RESOURCE", "HF_OIDC_ID_TOKEN")


def code_client_src(env):
    """The folder whose omegacode package holds the OmegaCode client a mind's workspace skills call (modules/code_workspace,
    module_requires' service:omegacode): OMEGACODE_SRC when the hive's environment sets it; else the release this
    hive's Code service runs, which Code's setup already names to the hive, HIVE_CODE_PYTHONPATH where Code runs in its
    own container (install/linux/setup-code.sh) and <HIVE_CODE_SERVICE_CONFIG's folder>/releases/<HIVE_CODE_SERVICE_RELEASE>
    on an own hive (install/macos/setup-code.sh unpacks it there). None when neither holds omegacode/client.py, so a
    hive without Code gives its minds no client and leaves the workspace skills out, as before. Jon's fourth follow-up
    on #596: no installer set OMEGACODE_SRC, so the workspace skills were off on every standard install, Macs running
    Code included; a client from the release the service runs also matches that service."""
    if env.get("OMEGACODE_SRC"):
        return env["OMEGACODE_SRC"]
    candidates = [env.get("HIVE_CODE_PYTHONPATH", "")]
    config, release = env.get("HIVE_CODE_SERVICE_CONFIG", ""), env.get("HIVE_CODE_SERVICE_RELEASE", "").strip()
    if config and release and "/" not in release:
        candidates.append(str(pathlib.Path(config).parent / "releases" / release))
    for candidate in candidates:
        if candidate and (pathlib.Path(candidate) / "omegacode" / "client.py").is_file():
            return candidate
    return None


def mind_environment(hive_env, mind_env):
    """The hive's environment filtered to what minds need, then the mind's own variables on top, less any Hugging
    Face token source, then HF_TOKEN_PATH, which nothing overrides. OMEGACODE_SRC is the hive's Code release where
    the hive's environment doesn't set it (code_client_src)."""
    out = {}
    for name, value in hive_env.items():
        if name in PASS or name.startswith("LC_"):
            out[name] = value
        elif name in PER_MIND:
            continue           # the supervisor's own per-mind switch: never inherited from the hive's environment
        elif name.startswith("OMEGACLAW_") and not any(s in name for s in SECRETISH):
            out[name] = value
    src = code_client_src(hive_env)
    if src:
        out["OMEGACODE_SRC"] = src
    out.update(mind_env)
    for name in HF_TOKEN_SOURCES:
        out.pop(name, None)
    # huggingface_hub reads its token file, HF_HOME/token by default, before every model load, and treats only a
    # missing file as no token. A mind may not read HF_HOME (runtime_roots grants its hub cache alone), so the token
    # path points at /dev/null, which every sandbox lets a mind read and which holds no token. It is set after the
    # mind's own variables, so no caller's overlay can point it back at a real token.
    out["HF_TOKEN_PATH"] = os.devnull
    return out


# Set only by the local-owner hive's first-boot preflight when a check failed (hive/supervisor/preflight.py, J1 r4
# ST3): from then on this process has no usable boundary, so minds and tools stay refused (never unsandboxed).
_REFUSED = None
# Set by the same preflight when the mind rows passed but the tool rows could not run (no Node configured, J1b r1.1):
# minds may run, tools stay refused, because nothing proved the tool path's boundary on this host.
_TOOLS_REFUSED = None


def mind_sandbox_requested(environ=None):
    """The one reading of HIVE_MIND_SANDBOX: minds run in the OS sandbox unless it is exactly "0", the explicit
    opt-out, so unset means on (#111). Nothing is stripped or coerced (J1b r1.1), so " 0", "false" or "off" leave the
    sandbox on rather than turning it off by accident. The launcher (drivers.py), delegation and the local-owner start
    check all ask this, so a value the start check accepts is always a value that sandboxes minds."""
    environ = os.environ if environ is None else environ
    return environ.get("HIVE_MIND_SANDBOX") != "0"


NO_BACKEND = ("this host has no OS sandbox the hive can use (macOS sandbox-exec, or Linux Landlock with unprivileged "
              "user namespaces)")
OPT_OUT = "set HIVE_MIND_SANDBOX=0 to run minds without OS isolation on this host"
PROBE_SECONDS = 30
# What probe_minds found at this process's start: {"state": "on" | "off" | "unavailable", "backend", "reason"}.
_MIND_STATUS = None


def probe_minds(data_dir, preflight=None):
    """Find at start whether minds can run in the OS sandbox here, and record it for mind_sandbox_status().

    A local-owner hive passes its preflight receipt (hive/supervisor/preflight.py), which has already proved or failed
    the mind path through this same wrap(), so its verdict stands and nothing more is launched.

    It starts one trivial process (/bin/sh -c 'exit 0') through the same wrap() every mind gets, so a host that has
    the backend but can't use it is found before any mind starts. On Ubuntu 23.10 and later that is AppArmor's
    unprivileged userns restriction when the launcher's profile isn't loaded or doesn't attach to its path: the
    launcher exits 78 and its stderr says why (landlock.apparmor_refusal). A failed launch refuses minds and tools
    for this process with that reason (refuse), never runs them unsandboxed. With HIVE_MIND_SANDBOX=0 nothing is
    launched. Time: one launcher start, a few hundred ms, bounded by PROBE_SECONDS."""
    global _MIND_STATUS
    import subprocess
    kind = backend()
    status = _status_without_launch(kind)
    if status is None and preflight is not None:
        status = ({"state": "on", "backend": kind, "reason": None} if preflight.get("minds") else
                  {"state": "unavailable", "backend": kind, "reason": preflight.get("reason") or "the sandbox preflight failed"})
    if status is None:
        probe = pathlib.Path(data_dir) / "sandbox" / "probe"
        shutil.rmtree(probe, ignore_errors=True)
        (probe / "mind" / "tmp").mkdir(parents=True, mode=0o700)
        why = None
        try:
            argv, _profile = wrap(["/bin/sh", "-c", "exit 0"], probe / "mind", [], probe / "profiles", "probe", ports=())
            done = subprocess.run(argv, cwd=probe / "mind", env={"PATH": "/usr/bin:/bin", "TMPDIR": str(probe / "mind" / "tmp")},
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=PROBE_SECONDS)
            if done.returncode != 0:
                said = [line.strip() for line in done.stderr.splitlines() if line.strip()]
                why = f"a test launch through the sandbox exited {done.returncode}" + (f": {said[-1]}" if said else "")
        except subprocess.TimeoutExpired:
            why = f"a test launch through the sandbox did not finish in {PROBE_SECONDS} s"
        except (OSError, RuntimeError, ValueError) as exc:
            why = f"a test launch through the sandbox could not start: {exc}"
        finally:
            shutil.rmtree(probe, ignore_errors=True)
        if why is None:
            status = {"state": "on", "backend": kind, "reason": None}
        else:
            refuse(why)
            status = {"state": "unavailable", "backend": kind, "reason": why}
    _MIND_STATUS = status
    return dict(status)


def mind_sandbox_status():
    """What this hive says about its mind sandbox: what probe_minds found at start, or, before it ran (a process that
    never started the hive), what the setting and the backend alone say."""
    if _MIND_STATUS is not None:
        return dict(_MIND_STATUS)
    kind = backend()
    return _status_without_launch(kind) or {"state": "on", "backend": kind, "reason": None}


def describe(status, default_driver):
    """The sandbox's state as one sentence for the operator: the hive's start line and its settings summary.

    Only the local driver wraps minds in it (drivers.LocalDriver; a docker mind runs in its container), so on a hive
    whose default driver (HIVE_DRIVER) is another the sentence says it covers minds on the local driver only, instead of
    calling this hive's minds sandboxed, or refused when the sandbox can't run here."""
    scope, tail = ("", "") if default_driver == "local" else (
        " for minds on the local driver",
        f"; this hive's default driver is {default_driver}, whose minds this sandbox doesn't cover")
    if status["state"] == "on":
        return f"mind sandbox: on ({status['backend']}){scope}{tail}"
    if status["state"] == "off":
        return f"mind sandbox: off{scope}: {status['reason']}{tail}"
    minds = "they" if scope else "minds"
    return f"mind sandbox: unavailable{scope}, so {minds} won't start: {status['reason']}; {OPT_OUT}{tail}"


def report(default_driver):
    """mind_sandbox_status() with the hive's default driver and its describe() sentence, as the admin settings summary
    shows it."""
    status = mind_sandbox_status()
    return dict(status, default_driver=default_driver, summary=describe(status, default_driver))


def _status_without_launch(kind):
    """The answer the setting and the backend give on their own: off, unavailable, or None when only a launch can tell."""
    if not mind_sandbox_requested():
        return {"state": "off", "backend": kind, "reason": "minds run without OS isolation (HIVE_MIND_SANDBOX=0)"}
    if kind is None:
        return {"state": "unavailable", "backend": None, "reason": refused() or NO_BACKEND}
    return None


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
    if not (os.path.isfile(chosen) and os.access(chosen, os.X_OK)):   # else every launch fails in env, exit 127
        raise RuntimeError(f"HIVE_SANDBOX_PYTHON {chosen} is not an executable file")
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


_RUNNER_PLACEMENT_FLAG = "--hive-runner-placement-v1"
_RUNNER_WORKSPACE_FLAG = "--hive-runner-workspace-v1"


def _runner_placement_words(value):
    """Private runner transport DATA, never a public profile or readiness proof.

    Actual descriptor ownership/pass_fds and original process+leaf confirmation
    remain with the runner. Numbers cannot adopt a root, leaf or foreign PID.
    """
    if type(value) is not tuple or len(value) != 4:
        raise ValueError("runner placement needs three owned descriptors and an absolute deadline")
    descriptors, until = value[:3], value[3]
    if (any(type(fd) is not int or not 3 <= fd <= 2**31 - 1 for fd in descriptors)
            or len(set(descriptors)) != 3 or type(until) is not float
            or not math.isfinite(until) or until <= 0):
        raise ValueError("invalid private runner placement transport")
    return [str(fd) for fd in descriptors] + [until.hex()]


def launcher():
    """The command that starts the Linux launcher: by its own path, so its AppArmor profile attaches on Ubuntu 23.10+,
    with the interpreter its shebang runs passed in HIVE_SANDBOX_PYTHON, since the launcher gets the minds' filtered
    environment and a shebang can read only a variable (see landlock.py's docstring)."""
    path = str(pathlib.Path(__file__).with_name("landlock.py"))
    if "=" in path:   # env would read it as one more assignment and run the next argument instead
        raise RuntimeError(f"the launcher's path must not contain '=': {path}")
    if not os.access(path, os.X_OK):   # else env exits 126 on every launch and the probe blames the tool's runtime
        raise RuntimeError(f"the launcher {path} is not executable (a copy or package that dropped file modes?)")
    return ["/usr/bin/env", "HIVE_SANDBOX_PYTHON=" + interpreter()[0], path]


def wrap(command, mind_dir, read_roots, profile_dir, agent_id, ports=None, programs=(), *, think=None,
         _runner_placement=None, _runner_workspace=None, _runner_workspace_until=None):
    """`command` wrapped in this host's OS boundary; writes the profile it enforces and returns (command, path).
    think: see profile(); only the macOS backend enforces it, so any other refuses it."""
    placement = None if _runner_placement is None else _runner_placement_words(_runner_placement)
    workspace = []
    if _runner_workspace is not None:
        if type(_runner_workspace) is not int or not 3 <= _runner_workspace <= 2**31 - 1:
            raise ValueError("invalid private runner workspace descriptor")
        workspace = [_RUNNER_WORKSPACE_FLAG, str(_runner_workspace)]
        if placement is None:
            if (type(_runner_workspace_until) is not float or not math.isfinite(_runner_workspace_until)
                    or _runner_workspace_until <= 0):
                raise ValueError("standalone workspace requires an absolute deadline")
            workspace.append(_runner_workspace_until.hex())
        elif str(_runner_workspace) in placement[:3] or _runner_workspace_until is not None:
            raise ValueError("placed workspace requires a distinct original fourth descriptor")
    ports = loopback_ports() if ports is None else ports
    kind = backend()
    if think is not None and kind != "sandbox-exec":
        raise RuntimeError("limits for one executable inside a mind's sandbox are kept only by the macOS sandbox")
    if (placement is not None or workspace) and kind != "landlock":
        raise RuntimeError("private workspace and placement require the Linux Landlock launcher")
    profile_dir = pathlib.Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    if kind == "sandbox-exec":
        from . import mindfs
        mindfs.require_contained_links(mind_dir)
        path = profile_dir / f"{agent_id}.sb"
        path.write_text(profile(mind_dir, read_roots, ports, think))
        return ["sandbox-exec", "-f", str(path)] + list(command), str(path)
    if kind == "landlock":
        import json
        from . import landlock
        path = profile_dir / f"{agent_id}.landlock.json"
        if _runner_workspace is None:
            path.write_text(json.dumps(landlock.profile(mind_dir, safe_roots(read_roots), ports, programs), indent=1))
        else:
            encoded = json.dumps(landlock.profile(mind_dir, safe_roots(read_roots), ports, programs), indent=1)
            if len(encoded.encode()) > 65536:
                raise ValueError("private runner profile exceeds64KiB")
            path.write_text(encoded)
        # Every launch goes by the launcher's own path, so its AppArmor profile attaches (flagship #2). Its shebang runs
        # HIVE_SANDBOX_PYTHON with -I -B -S, which ignores site, PYTHONPATH and user startup for the trusted P bootstrap;
        # the actual caller separately passes exactly the three placement descriptors, which env and the shebang's exec
        # inherit.
        placed = [] if placement is None else [_RUNNER_PLACEMENT_FLAG, *placement]
        return launcher() + [str(path), *placed, *workspace, "--"] + list(command), str(path)
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


def profile(mind_dir, read_roots, ports=None, think=None):
    """A deny-by-default sandbox-exec profile for one mind. think: (swipl, scratch) for an Iter worker whose kit metta
    runs PeTTa as a swipl of its own (think_swipl), scratch a folder inside the mind's, joined to the resolved folder
    as written. That one executable then gets what Linux's Landlock gives the kit's PeTTa
    (templates/iter/tools/_think_sandbox.py): no network, no program of its own, and writes only beneath scratch."""
    ports = loopback_ports() if ports is None else ports
    outbound = " ".join(f'(remote ip "localhost:{p}")' for p in ports)
    mind_dir = pathlib.Path(mind_dir).resolve()
    reads = sorted({p for p in safe_roots(read_roots) if pathlib.Path(p).exists()})
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork)",
        "(allow process-exec)",
        "(allow signal (target same-sandbox))",
        "(allow sysctl-read)",
        # Mach services, including the Keychain broker, trustd and cfprefsd, stay denied.
        # Minds have loopback only and tools have no network. Revisit native trust and
        # preferences dependencies before allowing outbound TLS via Security.framework.
        "(allow ipc-posix-shm)",
        # path resolution needs metadata (existence, size) anywhere; contents are what is restricted
        "(allow file-read-metadata)",
        "(allow file-read* (literal \"/\") " + " ".join(f"(subpath {_q(p)})" for p in MAC_SYSTEM_READ) + ")",
        "(allow file-read* " + " ".join(f"(subpath {_q(p)})" for p in reads) + ")" if reads else "",
        f"(allow file-read* file-write* (subpath {_q(mind_dir)}))",
        # Never /dev/tty: the hive's controlling terminal would let a mind inject input (TIOCSTI), as on Linux.
        # /dev/dtracehelper is the dyld/DTrace registration device every macOS process writes at start-up.
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
        # Without a filter this rule allows all outbound traffic.
        f"(allow network-outbound {outbound})" if outbound else "",
        "(allow network-bind (local ip \"localhost:*\"))",
    ]
    if think is not None:
        swipl, scratch = think
        who = f"(process-path {_q(pathlib.Path(swipl).resolve())})"
        # sandbox-exec takes the last rule that matches, so these come last, and each names the operations the rules
        # above allow: on macOS 26.4.1 a trailing (deny network* ...) left this swipl the loopback port allowed above,
        # while naming network-outbound refused it. So probed, as this swipl PeTTa connects nowhere, binds no port,
        # starts no program and writes nothing outside scratch, while the worker's own processes still do all four.
        lines += [f"(deny network-outbound network-inbound network-bind {who})",
                  f"(deny process-exec process-fork {who})",
                  f"(deny file-write* (require-all {who} (require-not (subpath {_q(mind_dir / scratch)}))"
                  " (require-not (literal \"/dev/null\")) (require-not (literal \"/dev/dtracehelper\"))))"]
    return "\n".join(line for line in lines if line) + "\n"


# The name of the swipl the kit's PeTTa runs as on macOS: a copy beside this host's swipl, so it loads as swipl does,
# under a path of its own that a mind's profile can limit (profile's think), since macOS refuses a sandbox inside a
# mind's own (templates/iter/tools/_think_sandbox.py).
THINK_SWIPL = "swipl-think"


def think_swipl():
    """The kit's PeTTa's own swipl on this host, a copy beside the swipl on PATH, made again when that one changes.
    Its resolved path, or None where there is no swipl or its folder can't take the copy, and then the kit's metta
    asks the hive's gate each use. Time: two stats, plus one copy of swipl when it changed."""
    found = shutil.which("swipl")
    if not found:
        return None
    real = pathlib.Path(os.path.realpath(found))
    copy = real.with_name(THINK_SWIPL)
    try:
        source = real.stat()
        have = copy.stat() if copy.exists() else None
        if have is None or (have.st_size, have.st_mtime_ns) != (source.st_size, source.st_mtime_ns):
            fresh = copy.with_name(f".{THINK_SWIPL}.{os.getpid()}")
            shutil.copy2(real, fresh)   # with its mode and times, so the next start finds it current
            os.replace(fresh, copy)     # whole or not at all, even with two workers starting at once
    except OSError:
        return None
    return copy


def runtime_roots(petta_path, core_root, extra=()):
    """What a mind must be able to read to run at all (never the hive's data directory)."""
    home = pathlib.Path.home()
    from hive.runtime.native_core import runtime_directory
    roots = [runtime_directory(core_root), petta_path, core_root, home / "swipl-patched", "/opt/homebrew", "/usr/local/lib", "/usr/local/opt"]
    swipl = shutil.which("swipl")   # wherever this host's SWI-Prolog lives (e.g. /opt/omegahive/runtime/swipl on Linux)
    if swipl:
        roots.append(str(pathlib.Path(os.path.realpath(swipl)).parent.parent))
    venv = pathlib.Path(os.environ.get("VIRTUAL_ENV") or pathlib.Path(core_root).parent / ".runtime" / "venv312")
    roots += [venv, code_client_src(os.environ)]
    roots.append(hf_hub_cache(os.environ))
    cfg = venv / "pyvenv.cfg"   # the interpreter the venv was made from (its standard library)
    if cfg.exists():
        for line in cfg.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home" and value.strip():
                roots.append(str(pathlib.Path(os.path.realpath(value.strip())).parent))
    return safe_roots(list(roots) + list(extra))


# posixpath.expandvars' own pattern: $name or ${name}
_VAR = re.compile(r"\$(\w+|\{[^}]*\})", re.ASCII)


def hf_path(value, env):
    """A path as huggingface_hub reads it, os.path.expandvars(os.path.expanduser(value)) (its constants.py does this
    to HF_HOME, HF_HUB_CACHE and HF_TOKEN_PATH), with env in place of the process environment."""
    if value == "~" or value.startswith("~/"):
        if "HOME" in env:   # even when empty, as posixpath.expanduser
            home = env["HOME"]
        else:
            import pwd
            try:
                home = pwd.getpwuid(os.getuid()).pw_dir
            except KeyError:
                home = None
        if home is not None:
            value = (home.rstrip("/") + value[1:]) or "/"
    elif value.startswith("~"):
        value = os.path.expanduser(value)   # ~user comes from the password database, not the environment
    # ${name} loses its outer braces only, as in posixpath.expandvars: ${{x} names "{x"
    return _VAR.sub(lambda m: env.get(m.group(1)[1:-1] if m.group(1)[0] == "{" else m.group(1), m.group(0)), value)


def hf_hub_cache(env):
    """The Hugging Face hub cache a mind may read, or None: HF_HUB_CACHE, else HF_HOME/hub, where the deployment names
    one, read as huggingface_hub reads it, and only an existing folder that holds no token. HF_HOME also holds a
    person's token (HF_HOME/token, or HF_TOKEN_PATH, with stored_tokens beside it), so inside HF_HOME only its hub
    folder is granted, and never a cache that is HF_HOME, an ancestor of it such as ~/.cache, a file, a folder
    holding the token file, or a relative path."""
    hf_home = env.get("HF_HOME")
    cache = env.get("HF_HUB_CACHE") or (os.path.join(hf_home, "hub") if hf_home else None)
    if not cache:
        return None
    # huggingface_hub's own default when HF_HOME is unset
    home = pathlib.Path(hf_path(hf_home or os.path.join(env.get("XDG_CACHE_HOME", "~/.cache"), "huggingface"),
                                env)).resolve()
    tokens = {home / "token"}
    if env.get("HF_TOKEN_PATH"):
        tokens.add(pathlib.Path(hf_path(env["HF_TOKEN_PATH"], env)).resolve())
    cache = hf_path(cache, env)
    if not os.path.isabs(cache):   # a mind runs in its own folder, so a relative cache never names the hive's
        return None
    cache = pathlib.Path(cache).resolve()
    hub = home / "hub"
    if not cache.is_dir() or cache == home or cache in home.parents:
        return None
    if home in cache.parents and cache != hub and hub not in cache.parents:   # inside HF_HOME, only hub/
        return None
    if any(cache == token or cache in token.parents for token in tokens):
        return None
    return str(cache)


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
