"""Private-context and trusted-witness controls. No service/process/provider calls.

The end-to-end genuine-capability controls remain a separate required qualification.
"""
import asyncio
from types import SimpleNamespace

import pytest
from hive.core import code_mind_proof as proof
from hive.core.code import CodeError

ARGS = dict(task_id="task_a", repository_id="repo_a", workspace_id="ws_a", suggestion_id="suggestion_a")
AGENT = dict(id="agent_a", swarm_id="sw_a", token_hash="epoch_a")


def test_missing_context_refuses():
    async def run():
        with pytest.raises(proof.ProofError):
            await proof.prove(AGENT, ARGS)
    asyncio.run(run())


@pytest.mark.parametrize("args", [None, {}, {**ARGS, "token": "secret-never-reflected"},
    {**ARGS, "actions": ["write"]}, {**ARGS, "workspace_id": "../other"},
    {**ARGS, "workspace_id": "ws_a?scope=other"}, {**ARGS, "repository_id": "https://other"},
    {**ARGS, "task_id": "x" * 201}, {**ARGS, "suggestion_id": ""}])
def test_closed_inputs_do_not_reflect_secret(args):
    with pytest.raises(proof.ProofError) as failure:
        proof.validate_inputs(args)
    assert "secret-never-reflected" not in str(failure.value)


def test_context_parallel_batch_and_child_task_isolation():
    async def run():
        async def request(name):
            agent = dict(AGENT, id=name)
            with proof.member_request(object(), object(), agent, "private-" + name):
                current = proof._CONTEXT.get()
                for _ in range(2):  # sequential batch calls retain exactly this request's context
                    await asyncio.sleep(0)
                    assert proof._CONTEXT.get() is current
                    assert current.member_id == name
                async def inherited():
                    with pytest.raises(proof.ProofError):
                        await proof.prove(agent, ARGS)
                await asyncio.create_task(inherited())
            assert not current.active and current.credential is None
            assert proof._CONTEXT.get() is None
        await asyncio.gather(request("first"), request("second"))
    asyncio.run(run())


def test_cancellation_invalidates_inherited_context():
    async def run():
        entered = asyncio.Event()
        retained = []
        async def request():
            with proof.member_request(object(), object(), AGENT, "private-token"):
                retained.append(proof._CONTEXT.get())
                entered.set()
                await asyncio.Event().wait()
        task = asyncio.create_task(request())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert retained[0].credential is None and not retained[0].active
        assert proof._CONTEXT.get() is None
    asyncio.run(run())


def test_witness_is_not_http_status_or_untyped_scope_data():
    path = "/api/agent/code/relay/v1/workspaces/ws_a/suggestions/suggestion_a/candidate"
    witness = proof.GateWitness(path)
    scope = {"method": "GET", "path": path, "query_string": b"", proof._SCOPE_KEY: witness}
    # Service 404 returns a tuple in the wrapper and never calls this trusted exception hook.
    assert not witness.denied
    proof.note_host_denial(scope, CodeError(404, "different", "not a guard denial"))
    assert not witness.denied
    proof.note_host_denial(dict(scope, query_string=b"query"), CodeError(404, "not_relayed", "denied"))
    assert not witness.denied
    proof.note_host_denial(scope, CodeError(404, "not_relayed", "denied"))
    assert witness.denied
    proof.note_host_denial({**scope, proof._SCOPE_KEY: {"denied": False}}, CodeError(404, "not_relayed", "denied"))


def test_wrong_member_epoch_closed_goal_and_revocation_refuse():
    async def run():
        live = dict(AGENT)
        goal = dict(claimed_by=AGENT["id"], status="claimed", swarm_id=AGENT["swarm_id"])
        hive = SimpleNamespace(authenticate_agent=lambda token, surface=None: live,
                               db=SimpleNamespace(one=lambda *a: goal))
        app = SimpleNamespace(state=SimpleNamespace(hive=hive))
        with proof.member_request(app, hive, AGENT, "private-token", eligible=True, owned_tasks={"task_a"}):
            context = proof._CONTEXT.get()
            proof._member(context, AGENT, ARGS)
            for changed in [dict(AGENT, id="other"), dict(AGENT, token_hash="rotated"), dict(AGENT, swarm_id="other")]:
                with pytest.raises(proof.ProofError): proof._member(context, changed, ARGS)
            for field, value in [("claimed_by", "other"), ("status", "done"), ("status", "open"), ("swarm_id", "other")]:
                old = goal[field]; goal[field] = value
                with pytest.raises(proof.ProofError): proof._member(context, AGENT, ARGS)
                goal[field] = old
            live = None
            with pytest.raises(proof.ProofError): proof._member(context, AGENT, ARGS)
    asyncio.run(run())


def test_loaded_reviewed_guard_and_epoch_are_bound():
    from hive.core.code import Code
    async def run():
        hive = SimpleNamespace(code=Code.__new__(Code),
            updates=SimpleNamespace(running_build="a" * 40, started_at="synthetic-start"))
        app = SimpleNamespace(state=SimpleNamespace(hive=hive))
        with proof.member_request(app, hive, AGENT, "private-token", eligible=True, owned_tasks={"task_a"}):
            context = proof._CONTEXT.get()
            before = proof._epoch(context)
            assert before[3] == proof.REVIEWED_CODE_SHA256
            hive.updates.started_at = "changed-start"
            assert proof._epoch(context) != before
            hive.code = SimpleNamespace(relay_agent=lambda: None)
            with pytest.raises(proof.ProofError): proof._epoch(context)
    asyncio.run(run())


def _reviewed_epoch_hive():
    from hive.core.code import Code
    return SimpleNamespace(code=Code.__new__(Code),
        updates=SimpleNamespace(running_build="a" * 40, started_at="synthetic-start"))


def test_reviewed_literal_matches_actual_source_and_real_epoch():
    import hashlib
    from pathlib import Path
    from hive.core import code as code_module
    source = Path(code_module.__file__).read_bytes()
    assert hashlib.sha256(source).hexdigest() == proof.REVIEWED_CODE_SHA256
    hive = _reviewed_epoch_hive()
    context = SimpleNamespace(hive=hive)
    base = (id(hive.code), "a" * 40, "synthetic-start", hashlib.sha256(source).hexdigest())
    assert proof._epoch(context) == (*base, code_module.INTENDED_SERVICE_RELEASE)
    hive.code.intended_service_release = code_module.LOCAL_ENROLMENT_SERVICE_RELEASE
    assert proof._epoch(context) == (*base, code_module.LOCAL_ENROLMENT_SERVICE_RELEASE)


def test_changed_source_refuses_before_capability_post(tmp_path, monkeypatch):
    from pathlib import Path
    source = Path(proof.__file__).with_name("code.py").read_bytes()
    (tmp_path / "code.py").write_bytes(source + b"\n# synthetic changed source\n")
    monkeypatch.setattr(proof, "__file__", str(tmp_path / "code_mind_proof.py"))
    calls = []
    hive = _reviewed_epoch_hive()
    hive.authenticate_agent = lambda token, surface=None: dict(AGENT)
    hive.db = SimpleNamespace(one=lambda *args: dict(
        claimed_by=AGENT["id"], status="claimed", swarm_id=AGENT["swarm_id"]))
    async def app(scope, receive, send):
        calls.append((scope["method"], scope["path"]))
        raise AssertionError("changed source must refuse before any ASGI request")
    app.state = SimpleNamespace(hive=hive)
    async def run():
        with proof.member_request(app, hive, AGENT, "private-token", eligible=True,
                                  owned_tasks={"task_a"}):
            with pytest.raises(proof.ProofError):
                await proof.prove(AGENT, ARGS)
        assert proof._CONTEXT.get() is None
    asyncio.run(run())
    assert calls == []


def test_real_epoch_refuses_changed_loaded_relay():
    hive = _reviewed_epoch_hive()
    async def different_relay(self, *args, **kwargs):
        raise AssertionError("unreviewed relay must never be called")
    hive.code.relay_agent = different_relay.__get__(hive.code, type(hive.code))
    with pytest.raises(proof.ProofError):
        proof._epoch(SimpleNamespace(hive=hive))


@pytest.mark.parametrize("change", ["wrong_code_type", "invalid_host_build"])
def test_real_epoch_refuses_wrong_loaded_identity(change):
    hive = _reviewed_epoch_hive()
    if change == "wrong_code_type":
        hive.code = SimpleNamespace(relay_agent=lambda: None)
    else:
        hive.updates.running_build = "not-a-reviewed-build"
    with pytest.raises(proof.ProofError):
        proof._epoch(SimpleNamespace(hive=hive))
