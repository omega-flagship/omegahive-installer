"""J3 host round R3 (O2 core): steps, executions, mount authority, piece custody, the write fence, outcomes, recovery.

Plan PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md: r1 §3.3-3.6, r1.1 (S3, S4.3-4, S5, S6, K7, K11), r1.2 (E3, E5, E7) and r1.3-r1.4
(F1-F4, G1-G5) where they still stand; every handoff, Stop, delivery and credential-file rule is the consolidated
PLATFORM_J3R4_HOST_HANDOFF_SPEC_R2.md r2.4 (studio_handoff.py; its own tests in test_studio_session_r3_handoff.py).
Synthetic only: temporary data directories, the real Supervisor (locks, transition, check, stop, verify_stopped) over a
fake process driver, a stand-in hub socket, invented keys, no provider call, no live hive. The O1 direction rows (R5
writes them) are inserted directly where a test needs them, and say so."""
import asyncio
import itertools
import json
import threading

import pytest

try:
    from hive.core import studio_steps as ST
except ImportError:          # absent before R3: each test then fails on its own assertions, not at collection
    import types
    ST = types.SimpleNamespace(PIECE_MIN_INTERVAL_S=0, START_WINDOW_SECONDS=0)
try:
    from hive.core import studio_handoff as SH
except ImportError:          # absent before the handoff round
    import types
    SH = types.SimpleNamespace(HOOK=None)
from hive.core.db import now
from hive.supervisor.drivers import Driver, Supervisor
from hive.tests.test_ask_intents import a, drain, held, release, token_of, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import MIA, MODEL, KEY, counts, err, record, s, submit  # noqa: F401

SCENE = "scene-1"
DIG = "sha256:" + "d" * 64


class Hub:
    """A stand-in hub connection: what the host sends to the maker over it."""

    def __init__(self):
        self.frames = []
        self.closed = None

    async def send_text(self, text):
        self.frames.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = code


class FakeDriver(Driver):
    """A process driver with no processes. Minds it does not know read as running (so the real check() leaves the rest
    of the world alone); a known mind runs between start and stop. Any call can be parked on a gate or made to raise."""
    name = "local"

    def __init__(self):
        self.procs, self.known, self.pending, self.calls = {}, set(), [], []
        self.gates, self.entered, self.fail, self.survive = {}, {}, {}, set()
        self.n = 0
        self.lock = threading.Lock()

    def park(self, op, aid):
        gate, entered = threading.Event(), threading.Event()
        self.gates[(op, aid)], self.entered[(op, aid)] = gate, entered
        return gate, entered

    def _call(self, op, aid):
        self.calls.append((op, aid))
        entered = self.entered.get((op, aid))
        if entered is not None:
            entered.set()
        gate = self.gates.get((op, aid))
        if gate is not None:
            assert gate.wait(60), f"{op} of {aid} parked too long"
        exc = self.fail.get((op, aid))
        if exc is not None:
            raise exc

    def start(self, agent, env):
        aid = agent["id"]
        self._call("start", aid)
        with self.lock:
            self.n += 1
            self.procs[aid] = f"local:{4000 + self.n}:{self.n}.5"
        self.known.add(aid)
        self.pending.append((aid, env.get("HIVE_TOKEN")))

    def stop(self, aid):
        self._call("stop", aid)
        if aid not in self.survive:
            self.procs.pop(aid, None)

    def status(self, aid):
        gate = self.gates.get(("status", aid))
        if gate is not None:                                           # a status read parked (process or Docker I/O)
            self.entered[("status", aid)].set()
            assert gate.wait(60), f"status of {aid} parked too long"
        return "running" if aid in self.procs or aid not in self.known else "exited"

    def execution(self, aid):
        return self.procs.get(aid)

    def logs(self, aid, tail=200):
        return []


@pytest.fixture()
def r3(s, monkeypatch, tmp_path):
    """The real Supervisor over FakeDriver: its start records a new execution boundary (Supervisor.start), its stop
    withdraws the hub connection, verify_stopped reads the driver. The maker's workspace starts with its creation token
    in the single legacy file, as every hive-made mind does; the first job's repair copies it into the per-epoch scheme."""
    hive = s.hive
    monkeypatch.setattr(ST, "PIECE_MIN_INTERVAL_S", 0)
    drv = FakeDriver()
    sup = Supervisor(hive.settings, drivers={"local": drv, "docker": drv})
    sup.attach(hive)
    sup.env = lambda agent: {"HIVE_TOKEN": sup.workspace.token(agent["id"])}
    monkeypatch.setattr(hive, "supervisor", sup)
    s.driver, s.sup, s.workspace = drv, sup, sup.workspace
    drv.known.add(s.maker["id"])
    root = sup.workspace.path(s.maker["id"])
    root.mkdir(parents=True, exist_ok=True)
    (root / "token").write_text(s.maker["token"])
    (root / "token").chmod(0o600)
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (s.maker["id"],))
    drv.procs[s.maker["id"]] = "local:3999:0.5"                        # the maker runs on its creation credential
    s.hubs = {}
    connect(s, s.maker["id"])
    yield s
    for gate in list(drv.gates.values()):                              # never leave a worker thread parked
        gate.set()
    if hasattr(SH, "HOOK"):
        SH.HOOK = None
    if hasattr(hive.studio, "worker"):
        hive.studio.worker.wait_idle(10)


def token_now(x, agent_id=None):
    return x.workspace.token(agent_id or x.maker["id"])


def connect(x, agent_id, token=None):
    """The mind's hub channel connects with the token its workspace holds: authenticate, the hub's registration fence
    (Hive._register_connection), then the studio capture, as agent_hub does."""
    hive = x.hive
    token = token or token_now(x, agent_id)
    agent = hive.authenticate_agent(token)
    if agent is None:
        return None
    hub = Hub()
    registered, _ = hive._register_connection(agent_id, hub, None)
    if not registered:
        return None
    x.hubs[agent_id] = hub
    hive.studio.connected(agent, hub)
    # the channel's first frame on every connect is its resume (hive_channel.py); the hub sends nothing live before it
    # is answered (port of upstream omegahive#21), so a helper standing in for the channel sends it too
    on_loop(x, hive.replay, agent_id, 0)
    return hub


def on_loop(x, fn, *args):
    """Run an async hive call on the app's own event loop (as the reconcile coroutine does)."""
    portal = getattr(x.client, "portal", None)
    if portal is not None:
        return portal.call(fn, *args)
    return asyncio.run(fn(*args))


def tick(x):
    async def go():
        await x.hive.studio.tick()
        if hasattr(x.hive.studio, "settle_deliveries"):
            await x.hive.studio.settle_deliveries()
    on_loop(x, go)


def drive(x, rounds=5, connect_started=True):
    """Worker jobs to completion, the started mind's hub connection, sweep ticks and deliveries."""
    studio = x.hive.studio
    for _ in range(rounds):
        assert studio.worker.wait_idle(15)
        while connect_started and x.driver.pending:
            aid, token = x.driver.pending.pop(0)
            connect(x, aid, token)
        tick(x)
    assert studio.worker.wait_idle(15)


def prepare(x, sid, rounds=5):
    """What R1.4's prepare() did, now through the handoff: open an attempt (if the session has work) and drive it."""
    on_loop(x, x.hive.studio.advance, sid)
    drive(x, rounds)


def run(coro):
    return asyncio.run(coro)


def body(seq=1, gen=1, text=None, revision=1):
    return text or json.dumps({"schema": "omega-studio-current-piece-1", "scene_ref": {"scene_id": SCENE, "revision": revision,
                                "digest": DIG}, "edit_generation": gen, "pending_fields": False,
                               "scene": {"schema": "omega-scene-1", "id": SCENE, "elements": [], "n": seq}, "owned": {}})


def open_session(x, **over):
    r = submit(x, record(x, **over).json()["intent_id"])
    assert r.status_code == 201, r.text
    return r.json()


def mount(x, sid, stream, expected=None, gen=1, attempt=None, who=None):
    return x.client.post(f"/api/studio-sessions/{sid}/mount", headers=who or x.mg,
                         json={"expected_epoch": expected, "receiver_generation": gen, "stream_id": stream,
                               "mount_id": "frame-0001", "attempt_id": attempt or f"att-{expected}-{gen}-x"})


def upload(x, sid, m, seq, gen=1, text=None, revision=1, who=None, **mount_over):
    fields = {"mount_token": m["mount_token"], "mount_epoch": m["mount_epoch"], "receiver_generation": m["receiver_generation"],
              **mount_over}
    return x.client.put(f"/api/studio-sessions/{sid}/piece", headers=who or x.mg,
                        json={"seq": seq, "body": body(seq, gen, text, revision),
                              "scene_ref": {"scene_id": SCENE, "revision": revision, "digest": DIG},
                              "edit_generation": gen, **fields})


def maker_headers(x):
    return {"Authorization": f"Bearer {token_now(x)}"}


def context(x, sid, execution_id=None, headers=None):
    q = f"?execution_id={execution_id}" if execution_id else ""
    return x.client.get(f"/api/agent/studio-sessions/{sid}/context{q}", headers=headers or maker_headers(x))


OP_SEQ = itertools.count(1)


def publish(x, session, execution_id, text="{\"schema\":\"omega-maker-revision-2\",\"items\":[]}", parent=None, headers=None,
            op_ids=None):
    """R4 (r1.8 L6): a proposal declares its op ids beside execution_id; by default fresh ones, unique in the test run."""
    payload = {"body": text, "parent": parent, "op_ids": op_ids or [f"op-{next(OP_SEQ)}"]}
    if execution_id is not None:
        payload["execution_id"] = execution_id
    return x.client.post(f"/api/agent/artifacts/{session['proposal_artifact_id']}/revisions",
                         headers=headers or maker_headers(x), json=payload)


def done(x, sid, n, execution_id, more=True, headers=None):
    return x.client.post(f"/api/agent/studio-sessions/{sid}/steps/{n}/done", headers=headers or maker_headers(x),
                         json={"more": more, "execution_id": execution_id})


def outcome(x, sid, n, m, prop, ack, result="applied", who=None, **over):
    """R4 (r1.8 L6): a validated outcome names the op ids the receiver read; by default exactly the step's declared ones."""
    data = {"mount_token": m["mount_token"], "mount_epoch": m["mount_epoch"], "receiver_generation": m["receiver_generation"],
            "proposal": prop, "outcome": result,
            "piece_upload": {k: ack[k] for k in ("seq", "body_sha256", "scene_ref", "edit_generation")},
            "piece_before": {"rev": 1}, "piece_after": {"rev": 2}, "receipt_digest": "sha256:" + "e" * 64, **over}
    declared = (x.hive.db.one("SELECT op_ids FROM studio_steps WHERE session_id = ? AND n = ?", (sid, n)) or {}).get("op_ids") \
        if x.hive.db.one("SELECT 1 FROM pragma_table_info('studio_steps') WHERE name = 'op_ids'") else None
    if "op_ids" not in over and declared and result != "unknown":
        data["op_ids"] = json.loads(declared)
    return x.client.post(f"/api/studio-sessions/{sid}/steps/{n}/outcome", headers=who or x.mg, json=data)


def step_row(x, sid, n):
    return x.hive.db.one("SELECT * FROM studio_steps WHERE session_id = ? AND n = ?", (sid, n))


def ses_row(x, sid):
    return x.hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (sid,))


def epoch_of(x, agent_id=None):
    return x.hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (agent_id or x.maker["id"],))["token_epoch"]


def started(x):
    """A session, mounted, with one acknowledged upload, and its maker handed off: step 1 is admitted and delivered."""
    session = open_session(x)
    sid = session["session_id"]
    m = mount(x, sid, session["stream_id"]).json()
    ack = upload(x, sid, m, 1).json()
    drive(x)
    step = step_row(x, sid, 1)
    assert step is not None and step["state"] == "admitted", (step, ses_row(x, sid)["state_reason"])
    return session, sid, m, ack, step


def in_step(x, sid, step):
    r = context(x, sid, step["execution_id"])
    assert r.status_code == 200 and r.json()["preview"] is False, r.text
    return r.json()


# ---- step 1, its execution and its message (r1.1 S6.4, D1; r1.3 F1, F3.3) ---------------------------------------------

def test_D1_no_step_before_the_first_upload_of_the_sessions_scene_then_one_step_in_a_new_execution(r3):
    hive = r3.hive
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    assert m["mount_epoch"] == 1 and m["mount_token"].startswith("mt_") and m["stream_id"] == session["stream_id"]
    prepare(r3, sid)
    assert step_row(r3, sid, 1) is None and hive.studio._latest_handoff(sid) is None   # null-scene hold: no work yet
    epoch0 = epoch_of(r3)
    assert upload(r3, sid, m, 1).status_code == 200
    drive(r3)
    step = step_row(r3, sid, 1)
    assert step["state"] == "admitted" and step["execution_id"].startswith("ex_")
    assert step["maker_execution"] == r3.driver.procs[r3.maker["id"]]     # the execution this handoff started
    assert ("stop", r3.maker["id"]) in r3.driver.calls                    # a verified stop came first
    assert step["token_epoch"] == epoch0 + 1                              # the execution's own credential (F1.1)
    # handoff spec §6: a step frame is never written to messages; it goes once to the k+1 connection, bound to its
    # delivery id and nonce, and carries no work
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", ("studio:" + sid,))["n"] == 0
    frames = [f for f in r3.hubs[r3.maker["id"]].frames if f.get("type") == "studio_step"]
    assert frames == [{"type": "studio_step", "session_id": sid, "step": 1, "epoch": epoch0 + 1,
                       "delivery_id": step["delivery_id"], "execution_id": step["execution_id"]}]
    assert step_row(r3, sid, 1)["delivered_at"] is not None
    drive(r3)
    assert hive.db.one("SELECT COUNT(*) AS n FROM studio_steps WHERE session_id = ?", (sid,))["n"] == 1   # E4a


def test_F4_steps_are_never_admitted_while_studio_is_off(r3, monkeypatch):
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    upload(r3, sid, m, 1)
    prepare(r3, sid)
    assert step_row(r3, sid, 1) is None and r3.hive.studio._latest_handoff(sid) is None
    assert r3.driver.calls == []                                          # nothing was stopped or started


def test_F1e_the_old_token_is_401_after_rotation(r3):
    old = {"Authorization": f"Bearer {r3.maker['token']}"}
    session, sid, m, ack, step = started(r3)
    assert r3.client.get(f"/api/agent/studio-sessions/{sid}/context", headers=old).status_code == 401
    r = r3.client.post("/llm/v1/chat/completions", headers=old, json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 401


# ---- the in-step cycle: context, publication, done (E5, F1.3-1.4, F3.4, K11) ---------------------------------------------

def test_the_in_step_read_publish_done_cycle_and_its_fences(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    preview = context(r3, sid).json()                                    # no execution_id: preview, changes nothing
    assert preview["preview"] is True and step_row(r3, sid, 1)["read_at"] is None
    assert publish(r3, session, step["execution_id"]).json()["error"]["code"] == "stale_piece_read"   # not read yet
    c = in_step(r3, sid, step)
    assert c["piece"]["body"] == body(1) and c["piece"]["seq"] == 1 and c["step"]["execution_id"] == step["execution_id"]
    again = context(r3, sid, step["execution_id"]).json()                 # F3.4: one cycle per (sid, n, epoch)
    assert again["already_started"] is True and again["piece"] is None and again["directions"] == []
    assert publish(r3, session, None).json()["error"]["code"] == "execution_retired"     # no execution id
    assert publish(r3, session, "ex_" + "0" * 24).json()["error"]["code"] == "execution_retired"
    big = publish(r3, session, step["execution_id"], text="x" * (32 * 1024 + 1))
    assert (big.status_code, big.json()["error"]["code"]) == (413, "proposal_too_large")
    first = publish(r3, session, step["execution_id"])
    assert first.status_code == 200, first.text
    assert step_row(r3, sid, 1)["proposal_n"] == first.json()["n"] == 1
    second = publish(r3, session, step["execution_id"], parent=1)
    assert second.json()["error"]["code"] == "step_already_published"
    d = done(r3, sid, 1, step["execution_id"])
    assert d.status_code == 200 and d.json()["state"] == "finished"
    fenced = hive.db.one("SELECT * FROM studio_fenced_executions WHERE maker_id = ? AND token_epoch = ?",
                         (r3.maker["id"], step["token_epoch"]))
    assert (fenced["execution"], fenced["reason"]) == (step["maker_execution"], "done")
    assert done(r3, sid, 1, step["execution_id"]).status_code == 200                    # idempotent
    assert done(r3, sid, 1, step["execution_id"], more=False).json()["error"]["code"] == "operation_conflict"


def test_F1a_after_done_the_steps_execution_makes_no_paid_call_and_no_reservation(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    agent = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))
    assert hive.studio.gateway_fence(agent) is None                      # inside its own step: the door is open
    done(r3, sid, 1, step["execution_id"])
    reservations = hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]
    r = r3.client.post("/llm/v1/chat/completions", headers=maker_headers(r3),
                       json={"messages": [{"role": "user", "content": "more"}], "max_tokens": 10})
    assert (r.status_code, err(r)["code"]) == (409, "studio_fenced"), r.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == reservations


def test_F1_a_request_authenticated_with_the_old_epoch_is_refused_once_the_next_step_is_admitted(r3):
    """F1-b / E1-d at the door and at publication: the epoch captured at authentication, never the latest step."""
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    old_agent = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))   # authenticated before the restart
    old_headers = maker_headers(r3)
    publish(r3, session, step["execution_id"])
    done(r3, sid, 1, step["execution_id"])
    ack2 = upload(r3, sid, m, 2, gen=2).json()
    outcome(r3, sid, 1, m, {"artifact_id": session["proposal_artifact_id"], "revision": 1,
                            "digest": step_row(r3, sid, 1)["proposal_digest"]}, ack2)
    prepare(r3, sid)
    step2 = step_row(r3, sid, 2)
    assert step2["state"] == "admitted" and step2["token_epoch"] == step["token_epoch"] + 1
    assert hive.studio.gateway_fence(old_agent).code == "studio_fenced"
    with pytest.raises(Exception) as e:
        hive.studio.revision_fence(old_agent, hive.collab.artifact(session["proposal_artifact_id"]), "{}", None,
                                   step2["execution_id"])
    assert getattr(e.value, "code", None) == "execution_retired"
    assert publish(r3, session, step["execution_id"], headers=old_headers).status_code == 401   # its token is gone


# ---- retirement failures hold (F1.6, F2) -------------------------------------------------------------------------------

def test_F1f_a_stop_that_raises_holds_and_n_plus_1_is_never_admitted_until_retry(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=True)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("process group survived KILL")
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["state_reason"]) == ("held", "execution_retirement_failed")
    assert hive.studio._latest_handoff(sid)["state"] == "held"
    drive(r3)
    assert step_row(r3, sid, 2) is None                                   # nothing reopens a held row by itself
    del r3.driver.fail[("stop", r3.maker["id"])]
    c = r3.client.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
                       json={"control_id": "retry-0001", "action": "retry_retirement"})
    assert c.status_code == 200 and c.json()["retrying"] == "execution_retirement_failed"
    upload(r3, sid, m, 3, gen=3)                                          # keep the piece current
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_F1g_a_failed_start_or_an_unobserved_boundary_holds(r3, monkeypatch):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"])
    monkeypatch.setattr(SH, "PROOF_WINDOW_S", 0)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, connect_started=False)                                      # started, but never connects
    assert ses_row(r3, sid)["state_reason"] == "boundary_unobserved"
    r3.driver.pending.clear()
    r3.driver.fail[("start", r3.maker["id"])] = RuntimeError("no sandbox")
    r3.client.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
                   json={"control_id": "retry-0002", "action": "retry_retirement"})
    upload(r3, sid, m, 3, gen=3)
    drive(r3)
    assert ses_row(r3, sid)["state_reason"] == "restart_failed"
    assert step_row(r3, sid, 2) is None


# ---- transport (F3) ----------------------------------------------------------------------------------------------------

def test_F3b_the_pull_inbox_is_refused_while_the_session_is_live(r3):
    session, sid, m, ack, step = started(r3)
    r = r3.client.get("/api/agent/inbox", headers=maker_headers(r3))
    assert (r.status_code, err(r)["code"]) == (409, "studio_hub_only")


# ---- E5: directions are used up only by an admitted step's own read (A15) ------------------------------------------------

def _direction(x, sid, seq, text):
    """Stand-in for R5's O1 interception: a queued studio direction row in ask_steers."""
    x.hive.db.insert("ask_steers", {"principal": MIA, "steer_id": f"st-{seq:04d}", "turn_id": "t_x", "body_digest": "sha256:" + "0" * 64,
                                    "text": text, "via": "ask", "at_seq": 0, "seq": None, "room_message_id": "",
                                    "delivery_message_id": "", "created_at": now(), "outcome": "studio", "new_operation_id": None,
                                    "studio_session_id": sid, "studio_seq": seq, "studio_step": None, "studio_read_at": None})


def test_A15_paused_context_read_then_resume_keeps_queued_directions(r3):
    """SIMULATED DIRECTIONS (r1.4 G5c): direction rows and pause/resume are written directly, standing in for R5's O1
    steer route and controls. This qualifies the context semantics only; R5 re-runs it through POST /api/ask/{op}/steer,
    and only that run counts as contract acceptance #15."""
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=False)                   # no more work of its own
    hive.db.execute("UPDATE studio_sessions SET state = 'paused' WHERE id = ?", (sid,))      # stand-in for R5's pause
    _direction(r3, sid, 1, "bigger headline")
    _direction(r3, sid, 2, "warmer")
    seen = context(r3, sid).json()                                        # the done execution is fenced: nothing at all
    assert seen["directions"] == []
    prepare(r3, sid)
    assert step_row(r3, sid, 2) is None and hive.studio._latest_handoff(sid)["state"] == "done"   # paused: no attempt
    assert [d["state"] for d in r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["directions"]] == ["queued"] * 2
    hive.db.execute("UPDATE studio_sessions SET state = 'active' WHERE id = ?", (sid,))      # stand-in for R5's resume
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    step2 = step_row(r3, sid, 2)
    assert step2 is not None and json.loads(step2["direction_seqs"]) == [1, 2]
    ledger = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()
    assert [d["state"] for d in ledger["directions"]] == ["delivered"] * 2
    c = in_step(r3, sid, step2)
    assert [d["text"] for d in c["directions"]] == ["bigger headline", "warmer"]
    ledger = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()
    assert [d["state"] for d in ledger["directions"]] == ["read"] * 2


def test_A15_context_with_old_execution_id_is_preview_only(r3):
    """SIMULATED DIRECTIONS (r1.4 G5c): the direction row is inserted directly; R5 re-runs this through the steer route."""
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    _direction(r3, sid, 1, "warmer")
    r = context(r3, sid, "ex_" + "f" * 24).json()
    assert r["preview"] is True and step_row(r3, sid, 1)["read_at"] is None
    assert hive.db.one("SELECT studio_read_at FROM ask_steers WHERE studio_seq = 1")["studio_read_at"] is None


# ---- E3: mount authority -----------------------------------------------------------------------------------------------

def test_E3_mount_compare_and_swap_tokens_retired_tokens_and_attempt_readback(r3):
    c = r3.client
    session = open_session(r3)
    sid, stream = session["session_id"], session["stream_id"]
    a1 = mount(r3, sid, stream, None, attempt="attempt-a1").json()
    lost = mount(r3, sid, stream, None, attempt="attempt-a1")             # a lost answer: the same attempt replays
    assert lost.json() == a1
    racing = mount(r3, sid, stream, None, attempt="attempt-r2")           # E3-a/b: the same expected epoch loses
    assert (racing.status_code, err(racing)["code"], err(racing)["mount_epoch"]) == (409, "mount_conflict", 1)
    back = c.get(f"/api/studio-sessions/{sid}/mount?attempt_id=attempt-r2", headers=r3.mia).json()
    assert back["attempt"]["outcome"] == "mount_conflict" and "mount_token" not in back["attempt"]
    assert c.get(f"/api/studio-sessions/{sid}/mount?attempt_id=attempt-a1", headers=r3.mia).json()["attempt"]["mount_token"] == a1["mount_token"]
    b = mount(r3, sid, stream, 1, gen=2, attempt="attempt-b1").json()     # A -> B
    a2 = mount(r3, sid, stream, 2, gen=3, attempt="attempt-a2").json()    # B -> A again: a new epoch and token
    assert [a1["mount_epoch"], b["mount_epoch"], a2["mount_epoch"]] == [1, 2, 3]
    assert len({a1["mount_token"], b["mount_token"], a2["mount_token"]}) == 3
    old = upload(r3, sid, a1, 1)                                          # E3-c: A's first token stays retired
    assert (old.status_code, err(old)["code"]) == (409, "stale_mount")
    gen = upload(r3, sid, a2, 1, receiver_generation=2)                   # E3-e
    assert (gen.status_code, err(gen)["code"]) == (409, "stale_receiver")
    assert upload(r3, sid, a2, 1).status_code == 200
    assert mount(r3, sid, "as_" + "0" * 24, 3, attempt="attempt-x1").json()["error"]["code"] == "stream_mismatch"
    gone = c.request("DELETE", f"/api/studio-sessions/{sid}/mount", headers=r3.mg, json={"mount_token": a2["mount_token"]})
    assert gone.status_code == 200 and gone.json()["piece_state"] == "revoked"
    for r in (upload(r3, sid, a2, 2, gen=2),                              # E3-d
              c.post(f"/api/studio-sessions/{sid}/mount/heartbeat", headers=r3.mg,
                     json={k: a2[k] for k in ("mount_token", "mount_epoch", "receiver_generation")})):
        assert (r.status_code, err(r)["code"]) == (409, "stale_mount")
    assert c.request("DELETE", f"/api/studio-sessions/{sid}/mount", headers=r3.mg,
                     json={"mount_token": a2["mount_token"]}).status_code == 200            # idempotent


def test_E3_another_persons_bearer_gets_404_and_a_stolen_current_token_from_another_sign_in_pauses(r3):
    from hive.tests.test_studio_session_g1 import session_headers
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    assert upload(r3, sid, m, 1, who=r3.jg).status_code == 404            # another person
    other_sign_in = session_headers(r3.hive, MIA)
    r = upload(r3, sid, m, 1, who=other_sign_in)
    assert r.status_code == 404
    row = r3.hive.db.one("SELECT state, state_reason FROM studio_sessions WHERE id = ?", (sid,))
    assert (row["state"], row["state_reason"]) == ("paused", "mount_revoked")


# ---- E7: freshness and the refresh -------------------------------------------------------------------------------------

def test_E7_refresh_generation_rules_and_heartbeats_never_renew_freshness(r3):
    hive, c = r3.hive, r3.client
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    first = upload(r3, sid, m, 1, gen=4).json()
    assert first["refresh"] is False and first["seq"] == 1
    lost = upload(r3, sid, m, 1, gen=4)                                   # a lost response: the same tuple
    assert lost.json()["seq"] == 1 and lost.json()["body_sha256"] == first["body_sha256"]
    assert err(upload(r3, sid, m, 2, gen=4, text="other bytes"))["code"] == "generation_reused"        # E7-b
    assert err(upload(r3, sid, m, 2, gen=5, text=body(1, 4)))["code"] == "generation_without_change"
    assert err(upload(r3, sid, m, 2, gen=3, text="older"))["code"] == "stale_generation"
    hive.db.execute("UPDATE studio_piece SET at = '2026-01-01T00:00:00.000Z' WHERE session_id = ?", (sid,))
    beat = c.post(f"/api/studio-sessions/{sid}/mount/heartbeat", headers=r3.mg,
                  json={k: m[k] for k in ("mount_token", "mount_epoch", "receiver_generation")})
    assert beat.status_code == 200 and beat.json()["piece_state"] == "stale"                            # E7-c
    refresh = upload(r3, sid, m, 2, gen=4, text=body(1, 4)).json()       # E7-a: same bytes, same generation
    assert refresh["refresh"] is True and refresh["seq"] == 2 and refresh["body_sha256"] == first["body_sha256"]
    assert hive.studio.piece_state(hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (sid,))) == "current"
    assert err(upload(r3, sid, m, 9, gen=6, text="new"))["code"] == "stale_piece"
    other_scene = c.put(f"/api/studio-sessions/{sid}/piece", headers=r3.mg,
                        json={"seq": 3, "body": "x", "scene_ref": {"scene_id": "scene-B", "revision": 1, "digest": DIG},
                              "edit_generation": 6, **{k: m[k] for k in ("mount_token", "mount_epoch", "receiver_generation")}})
    assert err(other_scene)["code"] == "scene_mismatch"                   # S3-b


def test_S3a_a_stale_piece_hides_the_body_and_holds_the_next_step(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    hive.db.execute("UPDATE studio_piece SET at = '2026-01-01T00:00:00.000Z' WHERE session_id = ?", (sid,))
    c = context(r3, sid, step["execution_id"]).json()
    assert c["piece"] is None and c["piece_state"] == "stale"
    assert err(publish(r3, session, step["execution_id"]))["code"] == "stale_piece_read"


def test_K11_a_hand_edit_uploaded_during_the_step_refuses_the_publication(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    assert upload(r3, sid, m, 2, gen=2, text="hand edit").status_code == 200
    assert err(publish(r3, session, step["execution_id"]))["code"] == "stale_piece_read"


# ---- write fences (r1.1 S4) --------------------------------------------------------------------------------------------

def test_S4_another_mind_and_any_person_are_refused_on_the_proposal_and_minds_on_the_live_piece_source(r3):
    hive, c = r3.hive, r3.client
    src = hive.collab.create_artifact({"id": r3.maker["id"], "swarm_id": r3.home["id"]}, {"kind": "studio-source", "title": "P"},
                                      principal=MIA)
    session = open_session(r3, piece={"scene_id": SCENE, "source_ref": {"artifact_id": src["id"]}})
    other = c.post("/api/agents", json={"name": "Other", "swarm_id": r3.home["id"], "model": MODEL}).json()
    r = c.post(f"/api/agent/artifacts/{session['proposal_artifact_id']}/revisions",
               headers={"Authorization": f"Bearer {other['token']}"}, json={"body": "x", "parent": None})
    assert (r.status_code, err(r)["code"]) == (403, "not_session_maker")
    r = c.post(f"/api/agent/artifacts/{src['id']}/revisions", headers={"Authorization": f"Bearer {other['token']}"},
               json={"body": "x", "parent": None})
    assert (r.status_code, err(r)["code"]) == (409, "session_piece_person_only")
    with pytest.raises(Exception) as e:                                   # a person's write to the proposal artifact
        hive.collab.add_revision({"id": None, "swarm_id": r3.home["id"]}, session["proposal_artifact_id"], {"body": "x"},
                                 principal=MIA)
    assert getattr(e.value, "code", None) == "not_session_maker"
    kept = hive.collab.add_revision({"id": None, "swarm_id": r3.home["id"]}, src["id"], {"body": "kept", "parent": None},
                                    principal=MIA)                       # the person's own Keep stays its own authority
    assert kept["n"] == 1
    # S4-d: another studio-proposals artifact is not this session's and is not fenced as a proposal
    loose = hive.collab.create_artifact({"id": other["id"], "swarm_id": r3.home["id"]}, {"kind": "studio-proposals", "title": "L"})
    r = c.post(f"/api/agent/artifacts/{loose['id']}/revisions", headers={"Authorization": f"Bearer {other['token']}"},
               json={"body": "x", "parent": None})
    assert r.status_code == 200
    assert hive.db.one("SELECT COUNT(*) AS n FROM studio_steps WHERE proposal_n IS NOT NULL")["n"] == 0


def test_S4c_rebind_after_the_persons_keep_moves_the_fence(r3):
    hive, c = r3.hive, r3.client
    session = open_session(r3)
    sid = session["session_id"]
    other = c.post("/api/agents", json={"name": "Other", "swarm_id": r3.home["id"], "model": MODEL}).json()
    src = hive.collab.create_artifact({"id": None, "swarm_id": r3.home["id"]}, {"kind": "studio-source", "title": "P"},
                                      principal=MIA)
    hive.collab.add_revision({"id": None, "swarm_id": r3.home["id"]}, src["id"], {"body": "kept", "parent": None}, principal=MIA)
    r = c.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
               json={"control_id": "rebind-0001", "action": "rebind_source", "artifact_id": src["id"]})
    assert r.status_code == 200 and r.json()["source_artifact_id"] == src["id"]
    again = c.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
                   json={"control_id": "rebind-0001", "action": "rebind_source", "artifact_id": src["id"]})
    assert again.json() == r.json()
    r = c.post(f"/api/agent/artifacts/{src['id']}/revisions", headers={"Authorization": f"Bearer {other['token']}"},
               json={"body": "x", "parent": 1})
    assert err(r)["code"] == "session_piece_person_only"
    minds_own = hive.collab.create_artifact({"id": other["id"], "swarm_id": r3.home["id"]}, {"kind": "studio-source", "title": "M"})
    hive.collab.add_revision({"id": other["id"], "swarm_id": r3.home["id"]}, minds_own["id"], {"body": "m", "parent": None})
    r = c.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
               json={"control_id": "rebind-0002", "action": "rebind_source", "artifact_id": minds_own["id"]})
    assert err(r)["code"] == "source_not_bindable"                        # only the person's own kept source


# ---- outcomes (r1.1 S3.5; §3.3) ----------------------------------------------------------------------------------------

def test_outcomes_are_bound_idempotent_and_gate_the_next_step(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    pub = publish(r3, session, step["execution_id"]).json()
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub["n"], "digest": pub["digest"]}
    done(r3, sid, 1, step["execution_id"], more=True)
    upload(r3, sid, m, 2, gen=2)
    prepare(r3, sid)
    assert step_row(r3, sid, 2) is None and hive.studio._latest_handoff(sid)["state"] == "done"   # O2-h: no attempt yet
    wrong = outcome(r3, sid, 1, m, {**prop, "revision": 9}, ack)
    assert err(wrong)["code"] == "wrong_proposal"
    no_custody = outcome(r3, sid, 1, m, prop, {**ack, "body_sha256": "sha256:" + "1" * 64})
    assert err(no_custody)["code"] == "piece_custody_missing"             # S3-e
    assert outcome(r3, sid, 1, m, prop, ack, who=r3.jg).status_code == 404
    ack2 = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["piece_custody"]["latest"]
    first = outcome(r3, sid, 1, m, prop, ack2, result="refused", reason="conflict on headline")
    assert first.status_code == 200 and first.json()["frame_reported"] is True
    assert first.json()["execution_id"] == step["execution_id"]
    assert outcome(r3, sid, 1, m, prop, ack2, result="refused", reason="conflict on headline").json() == first.json()
    assert err(outcome(r3, sid, 1, m, prop, ack2, result="applied"))["code"] == "operation_conflict"
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"                     # a terminal refusal permits n+1


def test_an_unknown_outcome_holds_n_plus_1_until_its_original_binding_settles(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    pub = publish(r3, session, step["execution_id"]).json()
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub["n"], "digest": pub["digest"]}
    done(r3, sid, 1, step["execution_id"], more=True)
    assert outcome(r3, sid, 1, m, prop, ack, result="unknown").status_code == 200
    prepare(r3, sid)
    assert step_row(r3, sid, 2) is None
    assert outcome(r3, sid, 1, m, prop, ack, result="applied").status_code == 200
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert step_row(r3, sid, 2) is not None


# ---- step-time checks: budget and drift (contract §6, r1.1 S5) ------------------------------------------------------------

def test_the_step_pre_check_pauses_when_the_session_has_no_room_for_a_step(r3):
    hive = r3.hive
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    # 1.90 settled under studio:<sid> leaves 0.10 of the 2.00 cap: less than the 0.25 step ceiling (the reader is
    # stubbed; R4 puts real reservations under that label). The pre-check runs inside the admission transaction
    from hive.core.studio_sessions import StudioSessions
    original = StudioSessions.scope_spent
    hive.studio.scope_spent = lambda label: 1.90 if label == "studio:" + sid else original(hive.studio, label)
    upload(r3, sid, m, 1)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["state_reason"]) == ("paused", "budget_exhausted") and step_row(r3, sid, 1) is None


def test_S5_a_tools_change_mid_session_holds_with_binding_drift(r3):
    hive = r3.hive
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": KEY, "tools": ["t@1"]}), r3.maker["id"]))
    upload(r3, sid, m, 1)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["state_reason"]) == ("held", "binding_drift:role_drift") and step_row(r3, sid, 1) is None


# ---- deadlines and delivery (E4c) ---------------------------------------------------------------------------------------

def test_E4c_an_unread_step_times_out_unread_is_readmitted_once_then_holds_delivery_failed(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    hive.db.execute("UPDATE studio_steps SET deadline = '2026-01-01T00:00:00.000Z' WHERE session_id = ?", (sid,))
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert step_row(r3, sid, 1)["state"] == "timed_out_unread"
    assert hive.studio.fenced(r3.maker["id"], step["token_epoch"])
    step2 = step_row(r3, sid, 2)
    assert step2["readmit_of"] == 1 and step2["state"] == "admitted"
    hive.db.execute("UPDATE studio_steps SET deadline = '2026-01-01T00:00:00.000Z' WHERE session_id = ? AND n = 2", (sid,))
    upload(r3, sid, m, 3, gen=3)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["state_reason"]) == ("held", "delivery_failed") and step_row(r3, sid, 3) is None


# ---- recovery (r1.1 S6.5, Kimi R2 P2-2) ---------------------------------------------------------------------------------

def test_startup_interrupts_the_open_step_fences_its_execution_and_needs_a_new_boundary(r3):
    from hive.core import exclusive
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    holder = held(hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, hive)["studio"] == 1
    finally:
        release(holder)
    assert step_row(r3, sid, 1)["state"] == "interrupted"
    assert hive.studio.fenced(r3.maker["id"], step["token_epoch"])
    agent = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))
    assert hive.studio.gateway_fence(agent).code == "studio_fenced"       # the old execution can never call again


def test_P2_2_a_crash_after_admission_commit_replays_the_answer_and_admits_one_step_1(r3, monkeypatch):
    hive = r3.hive
    iid = record(r3).json()["intent_id"]

    def crash(goal_id):
        raise RuntimeError("process died after the admission commit")
    monkeypatch.setattr(hive.goals, "_emit", crash)
    first = submit(r3, iid)                       # S3: linked, so the recorded answer is returned despite the crash
    monkeypatch.setattr(hive.goals, "_emit", lambda goal_id: None)
    replay = submit(r3, iid)
    assert replay.status_code == 201 and first.status_code == 201 and replay.content == first.content
    sid = replay.json()["session_id"]
    assert submit(r3, iid).content == replay.content
    m = mount(r3, sid, replay.json()["stream_id"]).json()
    upload(r3, sid, m, 1)
    drive(r3, rounds=8)
    assert hive.db.one("SELECT COUNT(*) AS n FROM studio_steps WHERE session_id = ?", (sid,))["n"] == 1


# ---- events and audit (K7) ----------------------------------------------------------------------------------------------

def test_studio_step_events_reach_the_person_and_not_another_member_and_the_audit_is_admin_only(r3):
    c, hive = r3.client, r3.hive
    zed = person(hive, "u_zed", role="member")
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    with c.websocket_connect(f"/api/events?token={token_of(r3.mia)}") as mia_ws, \
            c.websocket_connect(f"/api/events?token={token_of(zed)}") as zed_ws:
        for ws in (mia_ws, zed_ws):
            assert ws.receive_json()["type"] == "hello"
        upload(r3, sid, m, 1)
        drive(r3)
        mine, theirs = drain(mia_ws), drain(zed_ws)
    steps = [f for f in mine if f.get("type") == "studio.step"]
    assert [(f["step"], f["phase"], f["stream_id"]) for f in steps] == [(1, "admitted", session["stream_id"])]
    assert "body" not in steps[0] and not [f for f in theirs if f.get("type") == "studio.step"]
    audit = c.get(f"/api/studio-sessions/{sid}/audit", headers=r3.jon)
    assert audit.status_code == 200 and audit.json()["steps"][0]["execution_id"] == step_row(r3, sid, 1)["execution_id"]
    assert audit.json()["handoffs"]["rows"][0]["state"] == "done" and "classes" in audit.json()["worker"]
    assert "body" not in json.dumps(audit.json()["piece"]) or audit.json()["piece"]["latest"].get("body") is None
    assert body(1) not in audit.text
    assert c.get(f"/api/studio-sessions/{sid}/audit", headers=r3.mia).status_code in (403, 404)


# ---- r1.4 G1: the consuming transactions re-check the execution; done commits finished + fence together ----------------

def test_F1a0_done_commits_finished_and_fence_in_one_txn(r3, monkeypatch):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)

    def fault(session_id, n, phase):                      # runs after both writes, inside done's transaction
        raise RuntimeError("fault inside done's transaction")
    monkeypatch.setattr(hive.studio, "_step_event", fault)
    with pytest.raises(RuntimeError):
        done(r3, sid, 1, step["execution_id"])
    assert step_row(r3, sid, 1)["state"] == "admitted"                    # neither change
    assert not hive.studio.fenced(r3.maker["id"], step["token_epoch"])
    monkeypatch.undo()
    monkeypatch.setattr(ST, "PIECE_MIN_INTERVAL_S", 0)
    assert done(r3, sid, 1, step["execution_id"]).status_code == 200      # both
    assert step_row(r3, sid, 1)["state"] == "finished" and hive.studio.fenced(r3.maker["id"], step["token_epoch"])


def test_G1_a_capture_of_e_n_after_done_is_refused_by_context_and_publication_inside_their_transactions(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    captured = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))   # authenticated before done
    done(r3, sid, 1, step["execution_id"])
    c = hive.studio.context(captured, sid, step["execution_id"])
    assert c["fenced"] is True and c["piece"] is None and c["directions"] == []
    with pytest.raises(Exception) as e:
        hive.studio.revision_fence(captured, hive.collab.artifact(session["proposal_artifact_id"]), "{}", None,
                                   step["execution_id"])
    assert getattr(e.value, "code", None) in ("step_closed", "execution_retired")
    again = run(hive.studio.done(captured, sid, 1, {"more": True, "execution_id": step["execution_id"]}))
    assert again["state"] == "finished"                                   # the done path itself: the same answer


# ---- r1.4 G2: hub-only lives in Hive.inbox (REST and MCP) ------------------------------------------------------------------

def test_G2_hive_inbox_itself_refuses_a_live_maker_and_serves_every_other_mind(r3):
    hive = r3.hive
    started(r3)
    with pytest.raises(Exception) as e:
        hive.inbox(r3.maker["id"])                                        # the function MCP's inbox tool also calls
    assert getattr(e.value, "code", None) == "studio_hub_only"
    other = r3.client.post("/api/agents", json={"name": "Other", "swarm_id": r3.home["id"], "model": MODEL}).json()
    assert "messages" in hive.inbox(other["id"])


# ---- r1.4 G3: scoped to the maker; rotation is a compare-and-swap that serialises with consuming transactions ------------

def test_G3_other_minds_unaffected_during_live_step(r3):
    hive, c = r3.hive, r3.client
    other_home = c.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()
    peers = [c.post("/api/agents", json={"name": f"Peer {i}", "swarm_id": sw, "model": MODEL}).json()
             for i, sw in enumerate((r3.home["id"], other_home["id"]))]

    def all_clear():
        for peer in peers:
            row = hive.db.one("SELECT * FROM agents WHERE id = ?", (peer["id"],))
            assert hive.studio.gateway_fence(row) is None and not hive.studio.studio_owns(peer["id"])
            assert c.get("/api/agent/inbox", headers={"Authorization": f"Bearer {peer['token']}"}).status_code == 200
    session, sid, m, ack, step = started(r3)                               # an admitted step, after one rotation
    all_clear()
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"])                                 # a done
    all_clear()
    upload(r3, sid, m, 2, gen=2)
    drive(r3)                                                              # and another rotation
    assert step_row(r3, sid, 2) is not None
    all_clear()


def test_G3_rotate_token_is_a_compare_and_swap(r3):
    from hive.core.hive import token_hash
    hive = r3.hive
    epoch = hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))["token_epoch"]
    assert hive.rotate_token(r3.maker["id"], epoch, "tok-one") == epoch + 1
    with pytest.raises(Exception) as e:
        hive.rotate_token(r3.maker["id"], epoch, "tok-two")               # a stale expected epoch
    assert getattr(e.value, "code", None) == "rotation_conflict"
    row = hive.db.one("SELECT token_hash, token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))
    assert (row["token_hash"], row["token_epoch"]) == (token_hash("tok-one"), epoch + 1)


def test_G3_rotation_and_reservation_serialize(r3):
    """Two threads, one Database: a rotation waits for a consuming transaction that is open, and vice versa."""
    import threading
    import time as _time
    hive = r3.hive
    epoch = hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))["token_epoch"]
    finished = threading.Event()

    def rotate():
        hive.rotate_token(r3.maker["id"], epoch, "tok-thread")
        finished.set()
    with hive.db.transaction():                                            # a consuming transaction holds the connection
        seen = hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))["token_epoch"]
        worker = threading.Thread(target=rotate)
        worker.start()
        _time.sleep(0.3)
        assert not finished.is_set()                                       # the rotation is waiting
        assert hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))["token_epoch"] == seen
    worker.join(5)
    assert finished.is_set()
    assert hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (r3.maker["id"],))["token_epoch"] == epoch + 1


# ---- r1.4 G4: the ordered credential handoff ------------------------------------------------------------------------------

def _ready_for_step_2(x):
    session, sid, m, ack, step = started(x)
    in_step(x, sid, step)
    done(x, sid, 1, step["execution_id"], more=True)
    return session, sid, m, step


def test_G4e_a_boundary_without_a_hub_socket_of_the_new_epoch_admits_nothing(r3, monkeypatch):
    hive = r3.hive
    session, sid, m, step = _ready_for_step_2(r3)
    old_agent = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))
    monkeypatch.setattr(SH, "PROOF_WINDOW_S", 0)
    upload(r3, sid, m, 2, gen=2)
    hive.studio.worker.wait_idle(10)
    drive(r3, connect_started=False)
    hub = Hub()                                                            # a socket registered with the OLD epoch
    hive._register_connection(r3.maker["id"], hub, None)
    hive.studio.connected(old_agent, hub)
    drive(r3, connect_started=False)
    assert step_row(r3, sid, 2) is None
    assert ses_row(r3, sid)["state_reason"] == "boundary_unobserved"


# ---- r1.4 G5: re-read when the piece changed; requeue on an unsettled end; lazy retirement --------------------------------

def test_G5a_reread_after_hand_edit_refreshes_piece_read_and_publishes(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    upload(r3, sid, m, 2, gen=2, text="hand edit")
    assert err(publish(r3, session, step["execution_id"]))["code"] == "stale_piece_read"
    again = context(r3, sid, step["execution_id"]).json()
    assert again["already_started"] is True and again["piece"]["seq"] == 2 and again["piece"]["body"] == "hand edit"
    assert step_row(r3, sid, 1)["piece_read_seq"] == 2 and step_row(r3, sid, 1)["cycle_started_at"] is not None
    assert publish(r3, session, step["execution_id"]).status_code == 200


def test_G5a_reread_without_change_is_empty(r3):
    session, sid, m, ack, step = started(r3)
    first = in_step(r3, sid, step)
    again = context(r3, sid, step["execution_id"]).json()
    assert again["already_started"] is True and again["piece"] is None and again["directions"] == []
    assert step_row(r3, sid, 1)["cycle_started_at"] is not None and first["piece"]["seq"] == 1


def test_G5a_directions_requeued_on_unsettled_step_end(r3):
    """SIMULATED DIRECTIONS: rows inserted directly (R5 writes them through the steer route)."""
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    _direction(r3, sid, 1, "warmer")
    c = in_step(r3, sid, step)
    assert [d["seq"] for d in c["directions"]] == [1]
    _direction(r3, sid, 2, "and bigger")
    later = context(r3, sid, step["execution_id"]).json()                  # G5a: directions queued since are added
    assert [d["seq"] for d in later["directions"]] == [2] and later["already_started"] is True
    hive.db.execute("UPDATE studio_steps SET deadline = '2026-01-01T00:00:00.000Z' WHERE session_id = ?", (sid,))
    tick(r3)                                           # timed out, nothing published
    ledger = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()
    assert [d["state"] for d in ledger["directions"]] == ["queued", "queued"]


def test_G5b_no_retirement_without_next_step(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=False)
    stops = list(r3.driver.calls)
    assert hive.studio.has_work(ses_row(r3, sid)) is False                 # nothing queued: no restart
    prepare(r3, sid)
    assert r3.driver.calls == stops and step_row(r3, sid, 2) is None
    r = r3.client.post("/llm/v1/chat/completions", headers=maker_headers(r3),
                       json={"messages": [{"role": "user", "content": "idle"}], "max_tokens": 10})
    assert (r.status_code, err(r)["code"]) == (409, "studio_fenced")       # the idle finished execution is fenced


def test_G5d_the_self_check_needs_pause_resume_and_stop_controls(r3, monkeypatch):
    studio = r3.hive.studio
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    assert "controls: pause, resume, stop" not in studio.self_check()[1]          # R5 offers all three
    monkeypatch.setattr(studio, "CONTROL_ACTIONS", ("stop", "finish_stopping"))   # a build without pause/resume
    assert "controls: pause, resume, stop" in studio.self_check()[1]


def test_F3c_no_hub_connection_under_the_current_epoch_holds_boundary_unobserved(r3, monkeypatch):
    hive = r3.hive
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    monkeypatch.setattr(SH, "PROOF_WINDOW_S", 0)
    old = r3.maker["token"]
    upload(r3, sid, m, 1)
    hive.studio.worker.wait_idle(10)
    drive(r3, rounds=1, connect_started=False)
    assert connect(r3, r3.maker["id"], old) is None                       # the old epoch's token: 401 at the hub
    drive(r3, connect_started=False)
    assert step_row(r3, sid, 1) is None
    assert ses_row(r3, sid)["state_reason"] == "boundary_unobserved"      # the boundary alone is never enough


def test_F3d_an_old_step_frame_read_by_the_next_execution_gets_only_a_preview(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=True)
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    step2 = step_row(r3, sid, 2)
    old = context(r3, sid, step["execution_id"]).json()                  # the step-1 frame's execution id
    assert old["preview"] is True and step_row(r3, sid, 2)["read_at"] is None and step_row(r3, sid, 1)["read_at"] is not None
    assert context(r3, sid, step2["execution_id"]).json()["preview"] is False


def _files(x):
    root = x.workspace.path(x.maker["id"])
    return sorted(p.name for p in root.iterdir() if p.name.startswith(("token", "pending", "current")))


def test_G4a_a_stop_that_raises_or_leaves_an_execution_installs_no_credential_and_rotates_nothing(r3):
    hive = r3.hive
    session, sid, m, step = _ready_for_step_2(r3)
    before = (token_now(r3), epoch_of(r3))
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("group survived KILL")
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert (token_now(r3), epoch_of(r3)) == before                         # no install (a pending file may exist)
    assert ses_row(r3, sid)["state_reason"] == "execution_retirement_failed"
    # a stop that returns while the driver still reports the process is not verified either
    del r3.driver.fail[("stop", r3.maker["id"])]
    r3.driver.survive.add(r3.maker["id"])
    r3.client.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
                   json={"control_id": "retry-g4a1", "action": "retry_retirement"})
    drive(r3)
    assert (token_now(r3), epoch_of(r3)) == before
    assert ses_row(r3, sid)["state_reason"] == "execution_retirement_failed"
    assert step_row(r3, sid, 2) is None


def test_G4c_a_credential_write_failure_holds_and_the_maker_keeps_running_on_k(r3):
    hive = r3.hive
    session, sid, m, step = _ready_for_step_2(r3)
    running = r3.driver.procs[r3.maker["id"]]

    def refuse(kind, path):
        if kind == "write" and path.name.startswith("pending-token"):
            raise OSError("disk full")
    SH.HOOK = refuse
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert ses_row(r3, sid)["state_reason"] == "credential_write_failed"
    assert step_row(r3, sid, 2) is None and r3.driver.procs[r3.maker["id"]] == running   # never stopped


def test_G4d_credential_files_are_0600_and_installed_by_rename(r3):
    import os
    hive = r3.hive
    session, sid, m, step = _ready_for_step_2(r3)
    renamed = []
    SH.HOOK = lambda kind, path: renamed.append(path.name) if kind == "rename" else None
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    e2 = step_row(r3, sid, 2)["token_epoch"]
    assert renamed[:2] == [f"token-e{e2}", "current"]                      # pending -> token-e<k+1>, current.tmp -> current
    root = r3.workspace.path(r3.maker["id"])
    assert (os.stat(root / f"token-e{e2}").st_mode & 0o777) == 0o600 and not (root / "current.tmp").exists()
    assert hive.authenticate_agent(token_now(r3))["token_epoch"] == e2
    assert _files(r3) == ["current", f"token-e{e2}"]                       # older files cleaned up after admission
