"""The J1 launcher's setup helper: the host-side contract (new hive R1b-1; plan r1.1 §3 steps 1-6, r1.2.1 §B).

The J1 launcher runs this with the SAME J1-pinned Python as the hive (Code R1a binding: the parser identity includes
the patch version). It is the only holder of the sso-bootstrap bearer, and only in memory: never argv, a query
string, a file, a prompt or a log line. Every step is one the host already checks for itself; the helper adds no
authority.

    hello                      control socket (same uid)      -> port, instance
    bootstrap-begin            control socket                 -> attempt, one-use 60 s code, expected digests, runtime
    (runtime must equal ours; bytes come from the staged candidate cache (J1f) or the launcher's own preparation,
     and must equal the host's expected digests before anything is sent)
    POST /api/auth/local/exchange {code}   loopback, Origin   -> the bearer (kind sso-bootstrap), memory only
    POST /api/assets (receipt, then envelope), each read back byte for byte with GET /api/assets/{sha}
    POST /api/admin/repo-maps?visibility=hive&pinned=false     (the exact envelope; never pinned by the helper)
    GET /api/repo-maps/omegahive/{sha} until the digest matches and space.status == mounted (failed / incomplete stop;
     the attempt deadline stops; polling never extends anything)
    bootstrap-complete {token, repo, sha, map_digest, runtime}  control socket
    finally: bootstrap-retire {token} unless completed (best effort; the host's expiry/startup sweep does not depend on it)
    signin                     control socket                 -> a fresh one-use browser sign-in link

Outcomes are plain: ``{"ok": True, "url": ..., "receipt": ...}``; a setup failure ``{"ok": False, "stage": ...,
"reason": ..., "text": "Coding tools aren't ready yet", "action": "Try setup again"}``; or, when setup completed but the
browser link was not confirmed, ``{"ok": False, "state": "signin_unprepared" | "finish_signin", "stage": "browser_signin", "setup_completed": True,
"receipt": ...}`` with Design's copy (``SIGNIN_STATES``); ``retry_signin`` asks for the owner's link again, one request
per activation, and setup is never repeated. A failure never deletes data; running the
helper again is Resume setup.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import os
import pathlib
import socket
import time

from . import newhive

EXCHANGE = "/api/auth/local/exchange"
CONTROL_TIMEOUT = 120.0   # begin prepares the installed source on the host: allow for a large census
POLL_SECONDS = 0.5
# Design launcher-signin-recovery-r1 (DESIGN.md, pinned to 50e5f5c2): the browser-handoff states, exact copy. Setup
# completion is shown apart from sign-in; none of these says coding setup failed or reruns it. The last three are the
# launcher's own observations (browser launch / readback); the helper reports only the first three.
SIGNIN_STATES = {
    "signin_unprepared": {"heading": "Your coding tools are ready",
                          "text": "Sign-in couldn\u2019t be prepared. Your completed setup is saved.",
                          "action": "Try opening your hive again"},          # -> retry_signin (owner sign-in only)
    # R1b.2: the same recovery when the caller cannot confirm setup status (neutral: no readiness or loss claimed)
    "signin_unprepared_status_unknown": {"heading": "Let\u2019s open your hive",          # Design neutral-copy-r1
                                         "text": "Sign-in couldn\u2019t be prepared.",
                                         "action": "Try opening your hive again"},
    "finish_signin_status_unknown": {"heading": "Finish signing in",                       # Design neutral-copy-r1
                                     "text": "Continue sign-in in the OmegaHive launcher.",
                                     "action": "Continue sign-in"},
    "finish_signin": {"heading": "Finish signing in",
                      "text": "Your coding setup is saved. Continue sign-in in the OmegaHive launcher.",
                      "action": "Continue sign-in"},                          # -> the launcher's local-owner recovery
    "link_ready": {"heading": "Your hive is ready to open", "text": "Open it in your browser to continue.",
                   "action": "Open your hive"},
    "browser_failed": {"heading": "Let\u2019s open your hive", "text": "Setup is complete, but the browser didn\u2019t open.",
                       "action": "Open your hive"},
    "opening": {"heading": "Opening your hive", "text": "Waiting for your browser to connect. Your setup is saved.",
                "action": None},
}


class SetupStopped(Exception):
    def __init__(self, stage, reason):
        super().__init__(f"{stage}: {reason}")
        self.stage, self.reason = stage, reason


def control(socket_path, request, timeout=CONTROL_TIMEOUT):
    """One request on the same-uid control socket -> its JSON answer."""
    try:
        line = (json.dumps(request) + "\n").encode()
        if len(line) > 1024:
            raise SetupStopped("control", "request too large")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(str(socket_path))
            sock.sendall(line)
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                if chunk.endswith(b"\n"):
                    break
        return json.loads(b"".join(chunks) or b"null")
    except (TypeError, ValueError, RecursionError):
        raise SetupStopped("control", "the control socket did not answer JSON") from None


class LoopbackTransport:
    """HTTP to this computer's hive only: 127.0.0.1:<port>, its own Host and Origin."""

    def __init__(self, port):
        self.port = int(port)

    def request(self, method, path, headers=None, body=None, timeout=60.0):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=dict(headers or {}, Host=f"127.0.0.1:{self.port}"))
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()


def launcher_prepare(manifest_path, source_root, extractor_dir):
    """The launcher's own preparation with the same library and runtime as the host (deterministic bytes)."""
    manifest = newhive.parse_manifest(newhive.read_manifest(manifest_path))
    adapter = newhive.load_pinned_extractor(extractor_dir, (manifest.extractor or {}).get("files"))
    return newhive.prepare_map(newhive.collect_sources(source_root, manifest), adapter)


def _expected(begin, prepared):
    return (prepared.map_digest, prepared.receipt_sha256, prepared.envelope_sha256) == \
        (begin["map_digest"], begin["receipt_sha256"], begin["envelope_sha256"])


def run_setup(socket_path, transport=None, prepare=None, staged=None, clock=time.time, sleep=time.sleep,
              poll_seconds=POLL_SECONDS):
    """One setup attempt (or Resume setup). ``prepare``: callable -> newhive.Prepared (the launcher's own derivation);
    ``staged``: a newhive_update.Staged from the J1f candidate cache, used when its digests are the host's."""
    try:
        hello = control(socket_path, {"op": "hello"})
    except (OSError, SetupStopped) as exc:
        return _stopped("control", "control_unavailable" if isinstance(exc, OSError) else "control_invalid")
    if not isinstance(hello, dict):
        return _stopped("control", "control_invalid")
    port = hello.get("port")
    if hello.get("ok") is not True or type(port) is not int or not 1 <= port <= 65535:
        return _stopped("control", "hello_refused")
    origin = f"http://127.0.0.1:{port}"
    transport = transport or LoopbackTransport(port)
    try:
        begin = control(socket_path, {"op": "bootstrap-begin"})
    except (OSError, SetupStopped) as exc:
        return _stopped("begin", "control_unavailable" if isinstance(exc, OSError) else "control_invalid")
    if not isinstance(begin, dict):
        return _stopped("begin", "control_invalid")
    if begin.get("ok") is not True:
        return _stopped(*begin_refusal(begin))
    if not begin.get("completed"):
        token = None
        try:
            if begin.get("runtime") != newhive.runtime_identity():
                raise SetupStopped("runtime", {"host": begin.get("runtime"), "launcher": newhive.runtime_identity()})
            prepared = staged.prepared if staged is not None and _expected(begin, staged.prepared) else None
            if prepared is None:
                if prepare is None:
                    raise SetupStopped("prepare", "no staged candidate and no preparation")
                prepared = prepare()
            if not _expected(begin, prepared):
                raise SetupStopped("prepare", "the launcher's bytes are not the host's expected digests")
            status, raw = transport.request("POST", EXCHANGE, {"Origin": origin, "Content-Type": "application/json"},
                                            json.dumps({"code": begin["code"]}).encode())
            if status != 200:
                raise SetupStopped("signin", f"exchange answered {status}")
            token = json.loads(raw)["token"]
            bearer = {"Authorization": f"Bearer {token}"}
            for name, data, digest in (("receipt", prepared.receipt_bytes, prepared.receipt_sha256),
                                       ("envelope", prepared.envelope_bytes, prepared.envelope_sha256)):
                status, _ = transport.request("POST", f"/api/assets?local_only=true&name={name}",
                                              dict(bearer, Origin=origin, **{"Content-Type": "application/json"}), data)
                if status != 200:
                    raise SetupStopped("assets", f"{name} upload answered {status}")
                status, back = transport.request("GET", f"/api/assets/{digest}", bearer)
                if status != 200 or back != data:
                    raise SetupStopped("assets", f"{name} did not read back byte for byte")
            status, raw = transport.request("POST", "/api/admin/repo-maps?visibility=hive&pinned=false",
                                            dict(bearer, Origin=origin, **{"Content-Type": "application/json"}),
                                            prepared.envelope_bytes)
            if status != 200:
                raise SetupStopped("map", f"the map load answered {status}")
            while True:
                if clock() >= begin["deadline"]:
                    raise SetupStopped("expired", "the setup attempt reached its 10-minute deadline")
                status, raw = transport.request("GET", f"/api/repo-maps/{prepared.repo}/{prepared.sha}", bearer)
                if status != 200:
                    raise SetupStopped("map", f"the map read answered {status}")
                header = json.loads(raw)
                if header.get("digest") != prepared.map_digest:
                    raise SetupStopped("map", "the loaded map is not the expected digest")
                state = (header.get("space") or {}).get("status")
                if state == "mounted":
                    break
                if state in ("failed", "incomplete"):
                    raise SetupStopped("mount", state)
                sleep(poll_seconds)
            done = control(socket_path, {"op": "bootstrap-complete", "token": token, "repo": prepared.repo,
                                         "sha": prepared.sha, "map_digest": prepared.map_digest,
                                         "runtime": newhive.runtime_identity()})
            if not done.get("ok"):
                raise SetupStopped(done.get("stage") or "complete", done.get("error"))
            receipt = done.get("receipt")
            token = None   # completed: the host already retired it exactly
        except SetupStopped as exc:
            return _stopped(exc.stage, exc.reason)
        except (OSError, ValueError, KeyError) as exc:
            return _stopped("helper", type(exc).__name__)
        finally:
            if token is not None:
                with contextlib.suppress(Exception):
                    control(socket_path, {"op": "bootstrap-retire", "token": token})
            token = None
    else:
        receipt = begin.get("receipt")
    return _handoff(socket_path, origin, receipt)


def _handoff(socket_path, origin, receipt):
    """The browser handoff is its own step. Link-ready only with signin ok AND a non-empty URL of this hive's own
    loopback origin (a prepared link is not a signed-in person: ``signed_in`` stays False). Otherwise the completed
    setup stays completed (receipt kept, readiness untouched): a known missing owner goes to the launcher's
    local-owner recovery (``finish_signin``, never retried automatically); anything else is ``signin_unprepared``,
    whose one remedy is ``retry_signin``. Details carry only a bounded, non-secret category; never the URL."""
    try:
        signin = control(socket_path, {"op": "signin"})
    except (OSError, SetupStopped) as exc:
        signin = {"ok": False, "error": "control_unavailable" if isinstance(exc, OSError) else "control_invalid"}
    signin = signin if isinstance(signin, dict) else {"ok": False, "error": "control_invalid"}
    url = signin.get("url")
    if signin.get("ok") is True and isinstance(url, str) and url.startswith(origin + "/"):
        return dict(SIGNIN_STATES["link_ready"], ok=True, state="link_ready", url=url, receipt=receipt,
                    setup_completed=True, signed_in=False)
    state = "finish_signin" if signin.get("error") == "no_owner" else "signin_unprepared"
    category = signin.get("error") if signin.get("error") in ("no_owner", "control_unavailable", "control_invalid") \
        else ("signin_refused" if signin.get("ok") is not True else "no_usable_link")
    return dict(SIGNIN_STATES[state], ok=False, state=state, stage="browser_signin", setup_completed=True,
                receipt=receipt, reason=category, signed_in=False)


def retry_signin(socket_path, receipt=None, setup_completed=None):
    """Only the owner's browser sign-in, again (no setup, no bearer, nothing deleted).
    R1b.2 (Design launcher-retry-signin-rebase-readback-r1): this stays browser-sign-in recovery on every path. A hello
    refusal, exception or unreadable answer never sends the person back to coding setup and never marks coding unready.
    The caller's previously confirmed completion (``receipt`` / ``setup_completed``) is passed through unchanged; when
    it is unknown (None) the copy is neutral and claims neither readiness nor loss."""
    try:
        hello = control(socket_path, {"op": "hello"})
    except (OSError, SetupStopped) as exc:
        hello = {"ok": False, "error": "control_unavailable" if isinstance(exc, OSError) else "control_invalid"}
    if not isinstance(hello, dict):
        hello = {"ok": False, "error": "control_invalid"}
    port = hello.get("port")
    if hello.get("ok") is not True or isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        reason = hello.get("error") if hello.get("error") in ("control_unavailable", "control_invalid") else "hello_refused"
        return _signin_retry_state(receipt, setup_completed, reason)
    out = _handoff(socket_path, f"http://127.0.0.1:{port}", receipt)
    if not out.get("ok"):
        return _signin_retry_state(receipt, setup_completed, out.get("reason"), out.get("state"))
    # a prepared sign-in link is not coding-completion evidence: keep the caller's own tri-state and receipt
    out["setup_completed"], out["receipt"] = setup_completed, receipt
    return out


def _signin_retry_state(receipt, setup_completed, reason, state=None):
    """Browser sign-in recovery with the caller's own setup status; neutral copy when that status is unknown."""
    if state == "finish_signin":
        copy = SIGNIN_STATES["finish_signin" if setup_completed is True else "finish_signin_status_unknown"]
    elif setup_completed is True:
        copy, state = SIGNIN_STATES["signin_unprepared"], "signin_unprepared"
    else:
        copy, state = SIGNIN_STATES["signin_unprepared_status_unknown"], "signin_unprepared"
    return dict(copy, ok=False, state=state, stage="browser_signin", setup_completed=setup_completed,
                receipt=receipt, reason=reason, signed_in=False)


# A refused bootstrap-begin is passed on as a fixed stage and a known code only: never the host's message, path or view
# (Kimi R1b.3 P2). The codes are newhive.py's source/map refusals (Code BEGIN_REFUSAL_REASON_CODES_R1 inventory of
# 2efadaeb); the test keeps them in step with every SourceRefused literal there.
BEGIN_STAGES = frozenset({"hello", "begin", "source", "map", "install", "signin", "control"})
BEGIN_STAGE_ALIASES = {"assets": "install", "verifying": "begin", "restart": "source"}
BEGIN_ERRORS = frozenset({"no_owner", "setup_busy", "setup_held"})
BEGIN_REASON_CODES = newhive.BEGIN_REASON_CODES


def begin_refusal(begin):
    """(stage, reason) for a refused bootstrap-begin: a known stage (else "begin") and a known code (else "unexpected")."""
    stage = begin.get("stage")
    stage = BEGIN_STAGE_ALIASES.get(stage, stage) if isinstance(stage, str) else None
    reason = begin.get("reason")
    code = reason.get("code") if isinstance(reason, dict) else None
    if isinstance(code, str) and code in BEGIN_REASON_CODES:
        category = code
    elif isinstance(begin.get("error"), str) and begin["error"] in BEGIN_ERRORS:
        category = begin["error"]
    else:
        category = "unexpected"
    return (stage if stage in BEGIN_STAGES else "begin"), category


def _stopped(stage, reason):
    return {"ok": False, "stage": stage, "reason": reason, "text": newhive.COPY["not_ready"],
            "action": newhive.COPY["retry"]}
