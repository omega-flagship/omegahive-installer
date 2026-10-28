"""S4: the per-mind tool inventory, boot receipt and reasoning activity (L0/L1: disposable hive, synthetic data only)."""
import hashlib
import json
import pathlib
import re
import time

import pytest

from hive.core import inventory as inv
from hive.core.hive import HiveError
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

ROOT = pathlib.Path(__file__).resolve().parents[2]


def make_mind(client, name="Ada", **fields):
    swarm = client.post("/api/swarms", json={"name": "Inv " + name}).json()
    mind = client.post("/api/agents", json=dict({"name": name, "swarm_id": swarm["id"]}, **fields)).json()
    return mind


def awake(client, mind):
    """A (re)connection: awake, with a fresh host-issued boot nonce, as agent_connected does."""
    import secrets
    h = client.app.state.hive
    h.db.update("agents", mind["id"], {"status": "awake"})
    h.boot_nonce[mind["id"]] = secrets.token_hex(16)


def real_receipt(skip_module=None, loaded=True):
    """The receipt a real mind would build from this very tree, with a fake `Provides`/`Module` space dump."""
    from modules.hive.src import hive_commons
    parser = pytest.importorskip("src.helper_command_parser")
    ids = {}
    for toml in sorted((ROOT / "modules").glob("*/module.toml")):
        found = re.search(r'^id\s*=\s*"([^"]*)"', toml.read_text(), re.M)
        if found:
            ids[toml.parent.name] = found.group(1)
    enabled = parser._enabled_module_names(parser._active_module_loader_paths()[0])
    loaded_ids = [ids[d] for d in enabled if d in ids and d != skip_module] if loaded else []
    provides = " ".join(f"({ids['hive']} {s})" for s in ("hive-publish", "hive-query"))
    return hive_commons.inventory_receipt(f"({provides})", "(" + " ".join(loaded_ids) + ")", parser=parser), ids


def post(client, mind, receipt):
    """Post as a real mind does: echo the current connection's nonce unless the test supplies its own."""
    import secrets
    nonce = client.app.state.hive.boot_nonce.setdefault(mind["id"], secrets.token_hex(16))
    if isinstance(receipt, dict) and "boot_nonce" not in receipt:
        receipt = {**receipt, "boot_nonce": nonce}
    return client.post("/api/agent/inventory", headers=agent_headers(mind), json=receipt)


def skill(view, name):
    return next(s for s in view["skills"] if s["id"] == name)


def test_vendored_extractor_is_byte_identical_to_the_pin():
    path = ROOT / "hive/core/vendor/omegamatch_skill_metadata.py"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == inv.VENDOR_PIN


def test_source_digest_is_the_same_function_on_both_sides():
    from modules.hive.src import hive_commons
    files = sorted((ROOT / "modules/hive").glob("*.metta"))
    assert files and hive_commons._source_digest(files) == inv.source_digest(files)


def test_no_receipt_means_every_skill_is_unknown(client):
    mind = make_mind(client)
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["availability"] == "no-boot-receipt"
    assert view["inventory_revision"] is None and view["loaded_at"] is None and view["process"] is None
    assert view["modules"] == [] and view["skills"] == [] or {s["status"] for s in view["skills"]} == {"unknown"}
    assert "callable" not in {s["status"] for s in view["skills"]}


def test_receipt_makes_skills_callable_and_checks_source_digests(client):
    mind = make_mind(client)
    awake(client, mind)
    receipt, ids = real_receipt()
    out = post(client, mind, receipt)
    assert out.status_code == 200 and out.json()["stored"] is True
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["availability"] == "boot-receipt" and view["inventory_revision"] == out.json()["inventory_revision"]
    assert view["inventory_revision"].startswith("sha256:") and view["process"]["boot_id"] == receipt["boot_id"]
    publish, send = skill(view, "hive-publish"), skill(view, "send")
    assert publish["status"] == "callable" and publish["module"] == ids["hive"] and send["status"] == "callable"
    assert publish["signature"]["parser"] and publish["metadata"] == "verified-source"
    assert publish["help"] and publish["effects"] == ["swarm-belief-published"] and publish["risk"] == ["shared-memory-write"]
    assert publish["signature"]["declared"]["basis"] == "source-declarations-not-runtime-validation"
    assert all(m["source_verified"] for m in view["modules"] if m["source_digest"]) and view["core"]["source_verified"]
    # an identical receipt is not stored twice
    again = post(client, mind, receipt).json()
    assert again["stored"] is False and again["inventory_revision"] == view["inventory_revision"]


def test_a_module_the_mind_did_not_load_is_configured_not_callable(client):
    mind = make_mind(client)
    awake(client, mind)
    receipt, ids = real_receipt(skip_module="publishing")
    assert post(client, mind, receipt).status_code == 200
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    publishing = [s for s in view["skills"] if s["module"] == ids["publishing"]]
    assert publishing and {s["status"] for s in publishing} == {"configured"}
    assert skill(view, "hive-publish")["status"] == "callable"


def test_a_signature_without_a_loaded_module_is_not_callable(client):
    mind = make_mind(client)
    awake(client, mind)
    receipt, _ = real_receipt(loaded=False)
    post(client, mind, receipt)
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert skill(view, "hive-publish")["status"] == "configured"   # the parser knows the head; the module never loaded
    assert skill(view, "send")["status"] == "callable"              # a core head


def test_metadata_is_withheld_when_the_source_is_not_the_one_the_mind_loaded(client):
    mind = make_mind(client)
    awake(client, mind)
    receipt, ids = real_receipt()
    for m in receipt["modules"]:
        if m.get("id") == ids["hive"]:
            m["source_digest"] = "sha256:" + "0" * 64
    post(client, mind, receipt)
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    publish = skill(view, "hive-publish")
    assert publish["status"] == "callable" and publish["metadata"] == "unverified"
    assert publish["help"] is None and publish["effects"] is None and publish["signature"]["declared"] is None
    assert next(m for m in view["modules"] if m["id"] == ids["hive"])["source_verified"] is False


def test_a_restart_or_stop_makes_the_receipt_stale(client):
    mind = make_mind(client)
    awake(client, mind)
    receipt, _ = real_receipt()
    post(client, mind, receipt)
    h = client.app.state.hive
    h.set_status(mind["id"], "starting", desired="awake")
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["availability"] == "receipt-stale" and "restarted" in view["stale_reason"]
    assert view["inventory_revision"] and {s["status"] for s in view["skills"]} == {"unknown"}
    awake(client, mind)
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "receipt-stale"   # still the old boot
    assert post(client, mind, receipt).status_code == 409                                                 # replay refused
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "receipt-stale"
    receipt = {**receipt, "boot_id": receipt["boot_id"] + "-2"}                                          # genuinely new boot
    assert post(client, mind, receipt).json()["stored"] is True
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "boot-receipt"
    h.db.update("agents", mind["id"], {"status": "stopped"})
    stopped = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert stopped["availability"] == "receipt-stale" and "stopped" in stopped["stale_reason"]


def test_receipts_are_validated(client):
    mind = make_mind(client)
    receipt, _ = real_receipt()
    for broken in ({**receipt, "note": "free text"}, {**receipt, "boot_id": "a b"}, {**receipt, "pid": "1"},
                   {**receipt, "parser": {"x y": []}}, {**receipt, "provides": [["a"]]},
                   {**receipt, "modules": [{"dir": "../x"}]}, {**receipt, "core": {"source_digest": "nope"}}, []):
        assert post(client, mind, broken).status_code == 400, broken
    assert post(client, mind, receipt).status_code == 200
    assert client.post("/api/agent/inventory", json=receipt).status_code == 401


def test_an_outside_member_has_no_boot_receipt(client):
    member = make_mind(client, "Outside", kind="module")
    assert post(client, member, {"boot_id": "x", "modules": [], "parser": {}}).status_code == 400
    view = client.get(f"/api/agents/{member['id']}/inventory").json()
    assert view["availability"] == "no-boot-receipt" and view["skills"] == []


def test_policy_provider_and_route_per_skill_carry_their_own_snapshots(client):
    mind = make_mind(client)
    awake(client, mind)
    h = client.app.state.hive
    h.policy.add_rule("agent:" + mind["id"], "generate-video", "deny", "synthetic")
    post(client, mind, real_receipt()[0])
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    video = skill(view, "generate-video")
    assert video["policy"]["decision"] == "deny" and video["policy"]["reason"] == "synthetic" and video["policy"]["snapshot_at"]
    assert video["route"] == {"kind": "video", "budget_route": "unknown", "host_metered": False,
                              "note": "the mind calls the vendor directly; no host metering route for media in this build"}
    assert skill(view, "send")["route"] == {"kind": "none-declared"} and skill(view, "send")["policy"]["decision"] == "allow"
    provider = view["provider"]
    assert provider["payer_kind"] == "hive" and provider["resolved_model"] is None and provider["snapshot_at"]
    assert f"agent:{mind['id']}:total" in provider["budget_route"]
    # inventory-test-timing r1: snapshot_at is the view's own time, loaded_at the receipt's. Both are millisecond stamps,
    # so comparing one view's pair can collide within a millisecond (job 7). Prove the property instead: a later view
    # keeps loaded_at and moves snapshot_at on.
    assert view["snapshot_at"] and view["loaded_at"] and view["snapshot_at"] >= view["loaded_at"]
    time.sleep(0.005)
    later = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert later["loaded_at"] == view["loaded_at"] and later["snapshot_at"] > view["snapshot_at"]


def test_no_secrets_in_the_inventory(client):
    mind = make_mind(client)
    awake(client, mind)
    post(client, mind, real_receipt()[0])
    text = json.dumps(client.get(f"/api/agents/{mind['id']}/inventory").json())
    assert mind["token"] not in text and "token_hash" not in text and "api_key" not in text.lower()


def test_owner_or_admin_and_the_mind_itself(client):
    ann, bob = person(client, "u_inv_ann"), person(client, "u_inv_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann inv", "visibility": "public"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Ivy", "swarm_id": sw["id"]}).json()
    url = f"/api/agents/{mind['id']}/inventory"
    assert client.get(url, headers=ann).status_code == 200
    assert client.get(url).status_code == 200   # the admin
    assert client.get(url, headers=bob).status_code == 404   # private: existence is not revealed
    client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "public"})
    assert client.get(f"/api/agents/{mind['id']}", headers=bob).status_code == 200
    denied = client.get(url, headers=bob)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "owner_or_admin"
    assert client.get(url + "/activity", headers=bob).status_code == 403
    assert client.get(url + "/activity", headers=ann).status_code == 200
    me = client.get("/api/agent/inventory", headers=agent_headers(mind))
    assert me.status_code == 200 and me.json()["mind_id"] == mind["id"]


def test_self_access_over_mcp_hive_capabilities(client):
    """S3 contract (s3-r1, MCP_S3.md): an outside member has no boot receipt, so nothing is claimed callable; each
    bridge skill carries this member's live policy decision; refusals are JSON-RPC errors with data.code."""
    from hive.tests.test_mcp_api import rpc

    def tool(c, code, name):
        body = rpc(c, code, "tools/call", {"name": name, "arguments": {}}, path="/mcp").json()
        if "error" in body:
            return None, body["error"]["data"]
        return body["result"]["structuredContent"], None

    swarm = client.post("/api/swarms", json={"name": "MCP inv"}).json()
    code = client.post("/api/harness-invites", json={"harness": "claude-code", "name": "Claude inv", "swarm_id": swarm["id"]}).json()["code"]
    names = [t["name"] for t in rpc(client, code, "tools/list", path="/mcp").json()["result"]["tools"]]
    assert "hive_capabilities" in names
    out, error = tool(client, code, "hive_capabilities")
    assert error is None and out["availability"] == "no-boot-receipt" and out["inventory_revision"] is None
    assert out["skills"] == [] and out["mcp_tools"]          # original S4 gate: no evidence, no skill claimed
    h = client.app.state.hive
    member = h.db.one("SELECT * FROM agents WHERE name = 'Claude inv'")
    h.policy.add_rule("agent:" + member["id"], "hive-capabilities", "deny", "synthetic")
    out, error = tool(client, code, "hive_capabilities")
    assert out is None and error["code"] == "policy_denied"


def test_dynamic_flow_entries_are_listed_apart_and_never_callable(client):
    mind = make_mind(client)
    awake(client, mind)
    post(client, mind, real_receipt()[0])
    h = client.app.state.hive
    first = client.get(f"/api/agents/{mind['id']}/inventory").json()     # Flow's method is installed since the merge
    assert first["dynamic_status"] == "ok" and first["dynamic"] == []
    catalogue = "sha256:" + "a" * 64
    h.flows.agent_dynamic_inventory = lambda agent: [{"kind": "flow-skill", "id": "tidy", "registry_revision": catalogue}]
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["dynamic"] == [{"kind": "flow-skill", "id": "tidy", "registry_revision": catalogue, "swarm_id": mind["swarm_id"], "status": "unknown"}]
    assert view["dynamic_status"] == "ok" and "tidy" not in {s["id"] for s in view["skills"]}

    def refused(agent):
        raise HiveError(403, "flow_policy_denied", "denied")
    h.flows.agent_dynamic_inventory = refused
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["dynamic"] == [] and view["dynamic_status"] == "refused:flow_policy_denied"


def record(client, mind, cycle, commands):
    client.app.state.hive.record_trace(client.app.state.hive.db.one("SELECT * FROM agents WHERE id = ?", (mind["id"],)),
                                       {"iteration": cycle, "response": "r", "commands": [{"command": c, "result": "ok"} for c in commands]})


def test_reasoning_activity_counts_from_traces_and_flags_dormancy(client):
    mind = make_mind(client)
    url = f"/api/agents/{mind['id']}/inventory/activity"
    empty = client.get(url).json()
    assert empty["cycles_observed"] == 0 and empty["dormant"] is False   # nothing observed is not "dormant"
    record(client, mind, 1, ['(send "hello")', '(remember "x")'])
    record(client, mind, 2, ["(query hello)"])
    quiet = client.get(url).json()
    assert quiet["cycles_observed"] == 2 and quiet["dormant"] is True and quiet["reasoning_ran"] == 0
    record(client, mind, 3, ["(nal-step (--> a b) (--> b c))", "(pln-step (A) (B))", "(nars-query kb t)", "(nars-derive a b)",
                             '(metta (+ 1 2))', '(belief-claim "x")', '(hive-publish (--> a b) 1.0 0.9)', "(test-metta (+ 1 1))"])
    busy = client.get(url).json()
    assert busy["dormant"] is False
    assert {k: v["ran"] for k, v in busy["reasoning"].items()} == {"nal": 1, "pln": 1, "nars": 2, "metta": 1}
    assert busy["belief_writes"]["mind"]["ran"] == 1 and busy["belief_writes"]["commons"]["ran"] == 1
    assert busy["belief_writes_ran"] == 2 and busy["reasoning_ran"] == 5
    # a window of one cycle sees only the newest
    assert client.get(url + "?cycles=1").json()["cycles_observed"] == 1
    # the oldest two cycles are outside a window of one: a quiet window after busy ones reads dormant
    record(client, mind, 4, ["(send \"x\")"])
    assert client.get(url + "?cycles=1").json()["dormant"] is True and client.get(url).json()["dormant"] is False


def test_commands_the_gate_denied_or_held_are_attempted_not_ran(client):
    mind = make_mind(client)
    h = client.app.state.hive
    h.policy.recent.setdefault(mind["id"], {})["(metta (shell-out))"] = "deny"
    h.policy.recent[mind["id"]]["(nal-step (a) (b))"] = "ask"
    record(client, mind, 1, ["(metta (shell-out))", "(nal-step (a) (b))", "(metta (+ 1 2))"])
    out = client.get(f"/api/agents/{mind['id']}/inventory/activity").json()
    assert out["reasoning"]["metta"] == {"attempted": 2, "ran": 1} and out["reasoning"]["nal"] == {"attempted": 1, "ran": 0}
    assert out["dormant"] is False


def test_the_boot_hook_parses_what_the_space_query_prints():
    """The exact text a disposable PeTTa probe printed for the hook's two collapse/match queries (L1, stub in place of the hive)."""
    from modules.hive.src import hive_commons
    provides = "((omegaclaw.a hive-publish) (omegaclaw.a hive-query) (omegaclaw.b gen-img))"
    assert hive_commons._pairs(provides) == [("omegaclaw.a", "hive-publish"), ("omegaclaw.a", "hive-query"), ("omegaclaw.b", "gen-img")]
    assert hive_commons._atoms("(omegaclaw.a omegaclaw.b)") == ["omegaclaw.a", "omegaclaw.b"] and hive_commons._atoms("()") == []
    assert hive_commons.post_inventory.__doc__.startswith("Boot hook")


def test_the_boot_hook_never_stops_a_boot(monkeypatch):
    from modules.hive.src import hive_commons
    monkeypatch.delenv("HIVE_API_URL", raising=False)
    monkeypatch.delenv("HIVE_WS_TOKEN", raising=False)
    assert hive_commons.post_inventory("()", "()").startswith("HIVE-INVENTORY-SKIPPED")   # off the hive: nothing to tell
    monkeypatch.setattr(hive_commons, "_call", lambda *a, **k: ({"boot_nonce": "0" * 32}, None))   # on the hive
    monkeypatch.setattr(hive_commons, "inventory_receipt", lambda *a: (_ for _ in ()).throw(OSError("unreadable tree")))
    assert hive_commons.post_inventory("()", "()") == "HIVE-INVENTORY-SKIPPED OSError"



def test_a_receipt_from_an_earlier_connection_generation_is_not_current(client):
    """OmegaReview 2026-10-04: receipts bind to the host-observed connection generation."""
    mind = make_mind(client)
    awake(client, mind)
    h = client.app.state.hive
    receipt, _ = real_receipt()
    assert post(client, mind, receipt).json()["stored"] is True
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "boot-receipt"
    h.boot_nonce[mind["id"]] = "f" * 32                    # the mind reconnected: a new process, a new nonce
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["availability"] == "receipt-stale" and {s["status"] for s in view["skills"]} == {"unknown"}



def test_a_receipt_built_for_an_earlier_connection_is_refused_on_first_delivery(client):
    """OmegaReview residual: build during connection 1, withhold, deliver during connection 2."""
    mind = make_mind(client)
    awake(client, mind)
    old_nonce = client.app.state.hive.boot_nonce[mind["id"]]
    receipt, _ = real_receipt()
    built = {**receipt, "boot_nonce": old_nonce}
    awake(client, mind)                                    # reconnect before delivery
    r = post(client, mind, built)
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_boot"
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "no-boot-receipt"


def test_a_hive_restart_makes_every_stored_receipt_stale(client):
    """OmegaReview residual: a restart must not revive persisted evidence (nonces are random and in memory)."""
    mind = make_mind(client)
    awake(client, mind)
    post(client, mind, real_receipt()[0])
    h = client.app.state.hive
    h.boot_nonce.clear()                                   # what a hive restart does
    view = client.get(f"/api/agents/{mind['id']}/inventory").json()
    assert view["availability"] == "receipt-stale" and {s["status"] for s in view["skills"]} == {"unknown"}
    awake(client, mind)                                    # first connection after restart: a new random nonce
    assert client.get(f"/api/agents/{mind['id']}/inventory").json()["availability"] == "receipt-stale"


def test_a_receipt_without_a_nonce_is_refused(client):
    mind = make_mind(client)
    awake(client, mind)
    r = client.post("/api/agent/inventory", headers=agent_headers(mind), json=real_receipt()[0])
    assert r.status_code == 409


def test_a_disconnected_mind_has_no_current_nonce(client):
    """Kimi 2026-10-04: an ended connection must not keep accepting receipts until the next connect."""
    mind = make_mind(client)
    awake(client, mind)
    h = client.app.state.hive
    nonce = h.boot_nonce[mind["id"]]
    ws = object()
    h.connections[mind["id"]] = ws
    h.agent_disconnected(mind["id"], ws)
    assert mind["id"] not in h.boot_nonce
    r = client.post("/api/agent/inventory", headers=agent_headers(mind), json={**real_receipt()[0], "boot_nonce": nonce})
    assert r.status_code == 409
    assert client.get("/api/agent/inventory/nonce", headers=agent_headers(mind)).status_code == 409


def _scripted_call(script, seen):
    def call(method, path, payload=None):
        seen.append((method, path, (payload or {}).get("boot_nonce")))
        return script.pop(0) if script else (None, "HIVE-ERROR not_connected: still down")
    return call


def _join_boot_thread():
    import threading
    for t in threading.enumerate():
        if t.name == "hive-inventory-boot":
            t.join(5)


def test_the_boot_hook_waits_for_the_connection_and_posts_a_fresh_receipt(monkeypatch):
    """Root (Tools r5): the hook runs before the hub connection; only not_connected is retried, under a fresh nonce."""
    from modules.hive.src import hive_commons
    seen, built = [], []
    script = [(None, "HIVE-ERROR not_connected: connect first"), (None, "HIVE-ERROR not_connected: connect first"),
              ({"boot_nonce": "a" * 32}, None), ({"inventory_revision": "r1"}, None)]
    monkeypatch.setattr(hive_commons, "_call", _scripted_call(script, seen))
    monkeypatch.setattr(hive_commons, "inventory_receipt", lambda *a: built.append(1) or {"boot_id": "b"})
    assert hive_commons.post_inventory("()", "()", wait_seconds=5, sleep=lambda s: None) == "HIVE-INVENTORY-WAITING not_connected"
    _join_boot_thread()
    assert seen[-1] == ("POST", "/api/agent/inventory", "a" * 32)
    assert len(built) == 1                                  # built only once a nonce was captured, never before


def test_the_boot_hook_does_not_retry_other_errors(monkeypatch):
    from modules.hive.src import hive_commons
    seen = []
    monkeypatch.setattr(hive_commons, "_call", _scripted_call([(None, "HIVE-ERROR stale_boot: no")], seen))
    out = hive_commons.post_inventory("()", "()", wait_seconds=5, sleep=lambda s: None)
    assert out.startswith("HIVE-INVENTORY-SKIPPED HIVE-ERROR stale_boot") and len(seen) == 1


def test_the_boot_hook_gives_up_at_its_time_limit(monkeypatch):
    from modules.hive.src import hive_commons
    import time
    seen = []
    monkeypatch.setattr(hive_commons, "_call", _scripted_call([], seen))       # never connects
    started = time.monotonic()
    hive_commons.post_inventory("()", "()", wait_seconds=0.3, sleep=lambda s: time.sleep(0.05))
    _join_boot_thread()
    assert time.monotonic() - started < 3 and all(m == "GET" for m, _, _ in seen)



def test_mcp_capabilities_match_the_native_inventory_in_every_state(client):
    """OmegaReview B2: the MCP projection equals the native S4 view - current, stale, disconnected, revoked and denied."""
    from hive.tests.test_mcp_api import rpc

    def over_mcp(mind):
        body = rpc(client, mind["token"], "tools/call", {"name": "hive_capabilities", "arguments": {}}, path="/mcp").json()
        return body.get("result", {}).get("structuredContent"), body.get("error", {}).get("data")

    def same(mind):
        native = client.get(f"/api/agents/{mind['id']}/inventory").json()
        out, err = over_mcp(mind)
        assert err is None
        for key in ("availability", "inventory_revision", "stale_reason"):
            assert out[key] == native[key], key
        assert [(s["id"], s["status"]) for s in out["skills"]] == [(s["id"], s["status"]) for s in native["skills"]]
        return out

    h = client.app.state.hive
    mind = make_mind(client, name="Parity")
    awake(client, mind)
    assert post(client, mind, real_receipt()[0]).status_code == 200
    assert same(mind)["availability"] == "boot-receipt"                       # current
    h.boot_nonce[mind["id"]] = "e" * 32
    assert same(mind)["availability"] == "receipt-stale"                      # stale: a newer connection
    h.boot_nonce.pop(mind["id"], None)
    assert same(mind)["availability"] == "receipt-stale"                      # disconnected
    h.policy.add_rule("agent:" + mind["id"], "hive-capabilities", "deny", "synthetic")
    out, err = over_mcp(mind)
    assert out is None and err["code"] == "policy_denied"                      # denied: refused, not emptied
