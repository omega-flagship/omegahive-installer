"""J3 host R8: image generation for each member's own Studio maker, inside its live session, on that member's own key.

Jon's POC scope: "lets stop at imagegen/live drawing/co-edit on studio"; "each member gets their own Studio maker mind that
runs on their own key". Two host gates stood in the way of a personal maker (Design's readback, 2026-10-20):

1. ``media.allowed()`` admits only an exact agent:/swarm: entry of HIVE_MEDIA_ALLOW (no wildcard), and personal makers
   and their private Studio swarms are minted per member, so they can never be listed;
2. ``MediaRoute.handle()`` enforces generate-image / generate-image-quality through policy, and the copied Design
   Director role's "*" deny refuses them (R7.1's STUDIO_STEP_SKILLS opened only the three canvas calls).

R8: a person's own maker (host studio_maker binding) that is the maker of that person's LIVE admitted session (Studio on,
active or paused, window open, epoch not fenced) is media-allowed through the binding, and both image skills join the
R7.1 carve-out for it. It pays only with the person's own key for the media provider, through the R4 Studio reservation
and send gate. Nothing else changes: the allowlist, the shared maker, other minds with the role, Studio off.
"""

import copy
import http.server
import json
import base64
import threading

import httpx
import pytest

import hive.tests.test_studio_session_r3 as R3
from hive.core import media as M
from hive.core.studio_sessions import step_label
from hive.tests.test_media_route import PIN as MEDIA_PIN, png
from hive.tests.test_studio_session_r3 import drive, mount, ses_row, step_row, upload  # noqa: F401
from hive.tests.test_studio_session_r3_handoff import control, stopped_and_released  # noqa: F401
from hive.tests.test_studio_session_r4 import (HeldTransport, before_reservation, chat, in_thread, media_on,  # noqa: F401
                                               r4, reservations_of)
from hive.tests.test_studio_session_r3 import started  # noqa: F401
from hive.tests.test_studio_session_r7 import (BOB_KEY, deny_all_role, hive_key, maker_of, modes, open_personal,  # noqa: F401
                                               pr, p, personal_world, setup, tables)
from hive.tests.test_studio_session_r3 import r3  # noqa: F401  (fixture)
from hive.tests.test_ask_intents import a  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, add_key, err, s  # noqa: F401

IMAGE_SKILLS = ("generate-image", "generate-image-quality")
STEP_SKILLS = ("hive-studio-context", "hive-studio-publish", "hive-studio-done")
OTHERS = ("hive-goals", "shell", "write-file", "hive-room-post")


class Vendor:
    """POST /images on 127.0.0.1 behind the real httpx transport (so the send gate fires where it does in production).
    Records each request that arrived with its Authorization header; answers with ``image``."""

    def __init__(self):
        self.posts, self.image, self.cost = [], png(), 0.035
        vendor = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                vendor.posts.append((self.path.rsplit("/", 1)[-1], self.headers.get("Authorization")))
                out = {"created": 1, "data": [{"b64_json": base64.b64encode(vendor.image).decode()}],
                       "usage": {"prompt_tokens": 0, "completion_tokens": 4175, "total_tokens": 4175, "cost": vendor.cost}}
                data = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"


@pytest.fixture()
def m8(media_on, pr, monkeypatch):  # noqa: F811
    """R7's personal-maker world with HIVE_MEDIA_ROUTE=on, both image ops pinned to a local vendor, an EMPTY allowlist,
    the hive's key as the OpenRouter default, and the exact Design Director copy ("*" deny) on every mind holding it."""
    hive = pr.hive
    pr.vendor = Vendor()
    provider = hive.settings.providers["openrouter"]
    monkeypatch.setattr(provider, "base_url", pr.vendor.url)
    monkeypatch.setattr(provider, "media", {"image.generate": copy.deepcopy(MEDIA_PIN),
                                            "image.generate-quality": copy.deepcopy(MEDIA_PIN)})
    monkeypatch.setattr(hive.settings, "media_allow", {})
    gw = pr.client.app.state.gateway
    pr.transport_held = HeldTransport()                 # the real transport; a test may hold a request in it (R8.1)
    monkeypatch.setattr(gw, "client", httpx.AsyncClient(transport=pr.transport_held, trust_env=False))
    hive_key(pr)                                    # what an unguarded media call would pay with: the hive's key
    deny_all_role(pr)
    yield pr
    pr.vendor.server.shutdown()


def image(x, op="op-r8-image-0001", headers=None, kind="image.generate"):
    return x.client.post("/llm/v1/media", headers=headers or R3.maker_headers(x),
                         json={"op": kind, "operation_id": op, "prompt": "a quiet garden at dusk"})


def in_step(x):
    """Mia's own session, mounted, one acknowledged upload, the maker handed off and reading step 1."""
    session = open_personal(x)
    sid = session["session_id"]
    m = mount(x, sid, session["stream_id"]).json()
    upload(x, sid, m, 1)
    drive(x)
    step = step_row(x, sid, 1)
    assert step is not None and step["state"] == "admitted", ses_row(x, sid)["state_reason"]
    assert R3.context(x, sid, step["execution_id"]).status_code == 200
    return sid, step


def secret(x, key_id):
    return "Bearer " + x.hive.keyring.ring["keys"][key_id]["secret"]


# ---- 1. a live personal maker generates on her own key, step-bound; a replay is one call ---------------------------------

def test_R8_a_live_personal_maker_generates_an_image_on_her_own_key_bound_to_its_step_and_a_replay_is_one_call(m8):
    hive, maker = m8.hive, m8.maker["id"]
    # before any session: an ordinary mind under its role, not allowlisted
    assert set(modes(m8, maker, IMAGE_SKILLS).values()) == {"deny"}
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (403, "media_not_allowed"), r.text
    assert m8.vendor.posts == [] and reservations_of(m8) == []
    sid, step = in_step(m8)
    assert modes(m8, maker, IMAGE_SKILLS) == {s_: "allow" for s_ in IMAGE_SKILLS}
    assert modes(m8, maker, STEP_SKILLS) == {s_: "allow" for s_ in STEP_SKILLS}          # R7.1 unchanged
    assert set(modes(m8, maker, OTHERS).values()) == {"deny"}                            # the role still denies the rest
    assert hive.policy.authorize(hive.agent(maker), '(generate-image "a garden")')["decision"] == "allow"
    r = image(m8)
    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "accepted" and r.json()["asset"]["width"] == 64
    assert m8.vendor.posts == [("images", secret(m8, KEY))]                              # sent with HER key's secret
    [res] = reservations_of(m8)
    meta = res["metadata"]
    assert (meta["payer"], meta["key"], meta["kind"]) == (MIA, KEY, "media:image.generate")
    assert (meta["studio_session"], meta["studio_step"], meta["execution_id"]) == (sid, 1, step["execution_id"])
    assert res["state"] == "settled" and res["dispatched_at"] is not None and step_label(sid, 1) in res["scopes"]
    usage = hive.db.all("SELECT payer, key_id FROM usage WHERE agent_id = ?", (maker,))
    assert [(u["payer"], u["key_id"]) for u in usage] == [(MIA, KEY)]
    assert hive.db.one("SELECT billing FROM media_results")["billing"] == "settled"
    assert ses_row(m8, sid)["state"] == "active"
    # the same operation again: the recorded result, never a second POST or reservation
    again = image(m8)
    assert again.status_code == 200 and again.json()["replay"] is True, again.text
    assert len(m8.vendor.posts) == 1 and len(reservations_of(m8)) == 1
    # the quality op too, under the same carve-out
    q = image(m8, op="op-r8-quality-0001", kind="image.generate-quality")
    assert q.status_code == 200, q.text
    assert m8.vendor.posts[-1] == ("images", secret(m8, KEY)) and len(reservations_of(m8)) == 2
    # the allowlist itself is untouched and still has no wildcard
    assert hive.settings.media_allow == {}
    assert M.allowed(hive.settings, "image.generate", hive.agent(maker)) is False


def test_R8_the_maker_pays_with_its_assigned_own_key_and_otherwise_her_own_key_for_the_media_provider(m8):
    """The maker's assigned key (the session's consented key) when it is hers and an OpenRouter key; when its key is for
    another provider, her own OpenRouter key; never the hive default (k_0000c0c1 here)."""
    hive = m8.hive
    sid, step = in_step(m8)
    makers, agent = hive.studio_makers, hive.agent(m8.maker["id"])
    add_key(hive, "k_0000a0b2", MIA)                                     # a second own OpenRouter key, newer
    r = image(m8)
    assert r.status_code == 200, r.text
    assert m8.vendor.posts == [("images", secret(m8, KEY))]              # the maker's assigned own key, as its chat
    [res] = reservations_of(m8)
    assert res["metadata"]["key"] == KEY
    assert makers.media_key(agent, MIA, "openrouter") == KEY
    add_key(hive, "k_0000a0b3", MIA, provider="openai")
    other_provider = {**agent, "options": json.dumps({"key": "k_0000a0b3"})}
    assert makers.media_key(other_provider, MIA, "openrouter") == KEY          # her earliest own OpenRouter key
    bobs = {**agent, "options": json.dumps({"key": BOB_KEY})}
    assert makers.media_key(bobs, MIA, "openrouter") == KEY                    # never another member's key
    hive.keyring.ring["keys"][KEY]["provider"] = "openai"
    hive.keyring.ring["keys"]["k_0000a0b2"]["provider"] = "openai"
    assert makers.media_key(agent, MIA, "openrouter") is None                  # none of hers: None (402 at the route)


# ---- 2. no own key for the media provider ---------------------------------------------------------------------------------

def test_R8_no_own_key_for_the_media_provider_is_402_own_key_needed_with_nothing_sent_or_reserved(m8):
    hive = m8.hive
    sid, step = in_step(m8)
    hive.keyring.ring["keys"][KEY]["provider"] = "openai"                # her only key is no longer an OpenRouter key
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (402, "own_key_needed"), r.text
    assert m8.vendor.posts == [] and reservations_of(m8) == []
    assert not hive.db.one("SELECT 1 FROM media_results")
    assert not hive.db.one("SELECT 1 FROM usage WHERE agent_id = ?", (m8.maker["id"],))


@pytest.mark.parametrize("key", ["hive", "other_member"])
def test_R8_a_live_makers_media_never_pays_with_the_hive_key_or_another_members(m8, key):
    """R7.2's _check_budget guard holds for media: her maker's assigned key reassigned (past PATCH) to a key not hers,
    and she has no other OpenRouter key: 402 own_key_needed before any reservation or send."""
    hive = m8.hive
    sid, step = in_step(m8)
    other = {"hive": "k_0000c0c1", "other_member": BOB_KEY}[key]
    hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": other}), m8.maker["id"]))
    hive.keyring.ring["keys"][KEY]["provider"] = "openai"
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (402, "own_key_needed"), r.text
    assert m8.vendor.posts == [] and reservations_of(m8) == []
    # and with the guard bypassed at selection (the gateway's own pick), check_budget still refuses it
    assert hive.studio_makers.key_refusal(m8.maker["id"], other, "call").code == "own_key_needed"


# ---- 3. outside the session, Stop, expiry, a fenced epoch -----------------------------------------------------------------

@pytest.mark.parametrize("case", ["stop", "window_passed", "expired", "fenced", "held"])
def test_R8_after_stop_expiry_or_a_fence_media_is_refused_with_nothing_reserved_or_sent(m8, case):
    hive, maker = m8.hive, m8.maker["id"]
    sid, step = in_step(m8)
    assert image(m8, op="op-r8-before-0001").status_code == 200        # one call inside the step
    posts, held = len(m8.vendor.posts), len(reservations_of(m8))
    if case == "stop":
        assert control(m8, sid, "stop").status_code == 200
        stopped_and_released(m8, sid)
    elif case == "window_passed":
        # the window has ended but the expiry sweep has not run yet: still 'active', the step still admitted
        hive.db.execute("UPDATE studio_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", (sid,))
        assert ses_row(m8, sid)["state"] == "active" and step_row(m8, sid, 1)["state"] == "admitted"
    elif case == "expired":
        hive.db.execute("UPDATE studio_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", (sid,))
        assert hive.studio.expire_session(sid) is True
    elif case == "fenced":
        assert R3.done(m8, sid, 1, step["execution_id"], more=True).status_code == 200
    else:
        hive.db.execute("UPDATE studio_sessions SET state = 'held' WHERE id = ?", (sid,))
    r = image(m8, op="op-r8-after-0001")
    assert r.status_code in (403, 409), r.text
    assert err(r)["code"] in ("media_not_allowed", "studio_fenced", "studio_step_closed", "execution_retired"), r.text
    assert len(m8.vendor.posts) == posts and len(reservations_of(m8)) == held       # nothing reserved or sent
    if case != "fenced":
        assert set(modes(m8, maker, IMAGE_SKILLS).values()) == {"deny"}            # the role's answer again
    # a replay of the earlier operation never makes a second paid call
    again = image(m8, op="op-r8-before-0001")
    assert again.status_code in (200, 403, 409), again.text
    assert len(m8.vendor.posts) == posts and len(reservations_of(m8)) == held


# ---- 4. an exact rule still decides ----------------------------------------------------------------------------------------

def test_R8_a_rule_naming_an_image_skill_exactly_still_decides(m8):
    hive, maker = m8.hive, m8.maker["id"]
    sid, step = in_step(m8)
    hive.db.insert("policy_rules", {"id": "r_r8exact", "scope": f"agent:{maker}", "skill": "generate-image", "mode": "deny",
                                    "note": "a person said never", "created_at": "2026-10-20T00:00:00.000Z"})
    assert modes(m8, maker, IMAGE_SKILLS) == {"generate-image": "deny", "generate-image-quality": "allow"}
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (403, "policy_denied"), r.text
    assert m8.vendor.posts == [] and reservations_of(m8) == []
    hive.db.execute("UPDATE policy_rules SET mode = 'ask' WHERE id = 'r_r8exact'")
    assert modes(m8, maker, ("generate-image",)) == {"generate-image": "ask"}       # an exact ask is kept too


# ---- 5. every other mind is unchanged ---------------------------------------------------------------------------------------

def test_R8_an_ordinary_mind_with_the_same_role_and_the_shared_maker_stay_denied_and_the_allowlist_is_as_before(m8, monkeypatch):
    hive, template, shared = m8.hive, m8.template["id"], m8.shared["id"]
    hive.db.execute("UPDATE agents SET role_id = ? WHERE id = ?", (m8.role["id"], shared))
    hive.roles.apply(shared)
    in_step(m8)                                                            # Mia's maker is live meanwhile
    for mind in (template, shared):
        assert set(modes(m8, mind, IMAGE_SKILLS).values()) == {"deny"}
    tmpl = {"Authorization": f"Bearer {m8.template['token']}"}
    r = image(m8, headers=tmpl)
    assert (r.status_code, err(r)["code"]) == (403, "media_not_allowed"), r.text
    # the ordinary allowlist is exactly as before: listed, the role's deny still refuses it through policy
    monkeypatch.setattr(hive.settings, "media_allow", {"image.generate": [f"agent:{template}"]})
    r = image(m8, headers=tmpl)
    assert (r.status_code, err(r)["code"]) == (403, "policy_denied"), r.text
    assert M.allowed(hive.settings, "image.generate", hive.agent(template)) is True
    assert M.allowed(hive.settings, "image.generate", hive.agent(m8.maker["id"])) is False
    assert m8.vendor.posts == []
    # a personal maker with NO live session is not media-allowed by its binding
    assert hive.studio_makers.live_media_person(hive.agent(template)) is None


def test_R8_a_listed_ordinary_mind_without_a_deny_role_generates_exactly_as_before_on_its_key(m8, monkeypatch):
    hive = m8.hive
    plain = m8.client.post("/api/agents", json={"name": "Plain painter", "swarm_id": m8.home["id"], "model": "openrouter/test/maker",
                                                "budget_usd": 5}).json()
    monkeypatch.setattr(hive.settings, "media_allow", {"image.generate": [f"agent:{plain['id']}"]})
    r = image(m8, headers={"Authorization": f"Bearer {plain['token']}"})
    assert r.status_code == 200, r.text
    [res] = reservations_of(m8, plain["id"])
    assert res["metadata"]["key"] == "k_0000c0c1" and "studio_session" not in res["metadata"]   # the hive default, no Studio
    assert [path for path, _auth in m8.vendor.posts] == ["images"]       # sent as before (the provider's configured secret)


# ---- 6. Studio off ----------------------------------------------------------------------------------------------------------

def test_R8_with_studio_off_a_live_session_row_never_opens_media_for_the_personal_maker(m8, monkeypatch):
    hive, maker = m8.hive, m8.maker["id"]
    in_step(m8)
    monkeypatch.setattr(hive.studio, "enabled", False)
    assert set(modes(m8, maker, IMAGE_SKILLS).values()) == {"deny"}
    assert hive.studio_makers.live_media_person(hive.agent(maker)) is None
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (403, "media_not_allowed"), r.text
    assert m8.vendor.posts == [] and reservations_of(m8) == []


# ---- 7. a billed-then-refused image is reported honestly, on her key and the step ----------------------------------------

def test_R8_a_billed_then_refused_image_is_reported_as_billed_refused_on_her_key_and_the_step(m8):
    hive = m8.hive
    sid, step = in_step(m8)
    m8.vendor.image = png(32, 32)                                          # the wrong geometry: refused after billing
    r = image(m8)
    assert (r.status_code, err(r)["code"]) == (502, "output_refused"), r.text
    assert "billed_refused" in err(r)["message"]
    assert m8.vendor.posts == [("images", secret(m8, KEY))]
    [res] = reservations_of(m8)
    assert res["state"] == "settled" and res["metadata"]["key"] == KEY and step_label(sid, 1) in res["scopes"]
    row = hive.db.one("SELECT billing, refusal, asset_sha256 FROM media_results")
    assert (row["billing"], row["refusal"], row["asset_sha256"]) == ("billed_refused", "output_dimensions", None)
    usage = hive.db.all("SELECT payer, key_id, cost_usd FROM usage WHERE agent_id = ?", (m8.maker["id"],))
    assert [(u["payer"], u["key_id"]) for u in usage] == [(MIA, KEY)] and usage[0]["cost_usd"] > 0
    # its replay says the same and sends nothing
    again = image(m8)
    assert (again.status_code, err(again)["code"]) == (409, "output_refused") and len(m8.vendor.posts) == 1


# ---- R8.1 (stand-in R8.0 FIX-FIRST P1): the session window is re-checked in the reservation and at the send gate ---------
# For every Studio-bound call (chat, embeddings, media; personal and shared makers): a call admitted and reserved inside
# the window that crosses expires_at before it is sent is refused at the send gate, its hold released, nothing sent.

PAST = "2020-01-01T00:00:00.000Z"


def window_ends(x, sid):
    x.hive.db.execute("UPDATE studio_sessions SET expires_at = ? WHERE id = ?", (PAST, sid))


def test_R81_media_reserved_before_expiry_that_crosses_it_while_awaiting_transport_is_never_sent_and_released(m8):
    sid, step = in_step(m8)
    entered, go = threading.Event(), threading.Event()
    m8.transport_held.hold = (entered, go)
    t, out = in_thread(image, m8)
    try:
        assert entered.wait(15)                                            # in the transport, not yet sent
        [res] = reservations_of(m8)
        assert res["state"] == "reserved" and res["dispatched_at"] is None
        window_ends(m8, sid)                                               # the window ends; no sweep has run
        assert ses_row(m8, sid)["state"] == "active"
    finally:
        go.set()
    t.join(15)
    r = out["r"]
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text
    assert err(r)["reason"] == "window_ended"
    assert m8.vendor.posts == []                                           # no vendor POST
    [res] = reservations_of(m8)
    assert res["state"] == "released" and res["dispatched_at"] is None    # the hold released
    row = m8.hive.db.one("SELECT billing, refusal FROM media_results WHERE reservation = ?", (res["id"],))
    assert (row["billing"], row["refusal"]) == ("released", "studio_retired")
    assert not m8.hive.db.one("SELECT 1 FROM usage WHERE agent_id = ?", (m8.maker["id"],))


def test_R81_chat_of_an_r4_shared_maker_reserved_before_expiry_is_refused_at_the_send_gate_and_released(r4):
    session, sid, m, ack, step = started(r4)
    r4.transport.before[r4.maker["id"]] = lambda: window_ends(r4, sid)    # after the reservation, before the send
    r = chat(r4)
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text
    [res] = reservations_of(r4)
    assert res["state"] == "released" and res["dispatched_at"] is None
    assert r4.transport.sent == []


def test_R81_chat_whose_window_ends_between_the_door_and_the_reservation_reserves_nothing(r4, monkeypatch):
    session, sid, m, ack, step = started(r4)
    before_reservation(r4, monkeypatch, lambda: window_ends(r4, sid))
    r = chat(r4)
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text
    assert reservations_of(r4) == [] and r4.transport.sent == []
    assert ses_row(r4, sid)["state"] == "active"                          # the expiry Stop, not this refusal, ends it


# ---- R8.2 (Design, Mac UI): Studio is active in the person's own Studio swarm, and only there ---------------------------------
# On a hive where Studio is activated anywhere (an app_activations row), ProgramAttachments.required is True for every
# swarm, so the person's own "<Name>'s Studio" swarm (no row: one would be global) refused their save-source 403
# app_inactive. R8.2 derives the activation from the host's audited binding + attachment, for that one swarm; it writes
# no app_activations row, so required() and every other swarm are unchanged.

STUDIO_APP = """
def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [],
            "actions": [{"id": "trace", "label": "Trace", "applies_to": ["k"], "agents": True},
                        {"id": "save-source", "label": "Keep", "applies_to": ["k"], "person_activity": True}]}

def view(ctx, focus, stage):
    return {"revision": "r1", "items": [{"id": "src1", "kind": "k", "label": "studio-source"}]}

def act(ctx, action, items, params):
    return {"status": "done", "detail": {"swarm": ctx.swarm_id if hasattr(ctx, "swarm_id") else None}}
"""


def studio_program(x, tmp_path, monkeypatch):
    """A real loaded Studio program (hook-free, as the live omegadesign), replacing R7's stub entry."""
    folder = tmp_path / "omegadesign"
    folder.mkdir(parents=True)
    (folder / "plugin.json").write_text(json.dumps({"id": "omegadesign", "name": "OmegaDesign", "capabilities": []}))
    (folder / "program.py").write_text(STUDIO_APP)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    x.client.post("/api/programs/reload").raise_for_status()
    x.entry = x.hive.programs.programs["omegadesign"]
    assert not x.entry["error"], x.entry["error"]
    return x.entry


def save_source(x, swarm_id, who=None, key="keep-0001"):
    from hive.tests.test_program_confirm import mint
    body = {"swarm_id": swarm_id, "action": "save-source", "items": [], "params": {"scene": "s1"}, "idempotency_key": key}
    r = mint(x.client, who or x.mg, "omegadesign", body)
    if r.status_code != 200:
        return r
    return x.client.post("/api/programs/omegadesign/act", headers=who or x.mg, json=dict(body, confirm_token=r.json()["confirm_token"]))


def activations(hive):
    return [dict(r) for r in hive.db.all("SELECT * FROM app_activations ORDER BY program, swarm")]


@pytest.fixture()
def studio_elsewhere(p, tmp_path, monkeypatch):
    """The Mac's shape: Studio activated by an admin in another (team) swarm, so attachments are required everywhere."""
    entry = studio_program(p, tmp_path, monkeypatch)
    p.team = p.client.post("/api/swarms", json={"name": "Design team", "visibility": "public"}).json()["id"]
    p.hive.db.execute("INSERT INTO app_activations VALUES ('omegadesign', ?, 1, 'user:u_jon')", (p.team,))
    assert p.hive.app_attachments.required(entry) is True
    return p


def test_R82_after_setup_the_person_saves_and_views_studio_sources_in_her_own_studio_swarm(studio_elsewhere):
    x, hive = studio_elsewhere, studio_elsewhere.hive
    before = activations(hive)
    setup(x)
    home = hive.studio_makers.binding(MIA)["swarm_id"]
    r = save_source(x, home)
    assert r.status_code == 200 and r.json()["status"] == "done", r.text
    v = x.client.post("/api/programs/omegadesign/view", headers=x.mg, json={"swarm_id": home})
    assert v.status_code == 200 and v.json()["items"][0]["id"] == "src1", v.text
    assert hive.app_attachments.active("omegadesign", home) is True
    assert activations(hive) == before                                     # no activation row written anywhere


def test_R82_no_other_swarm_or_program_changes_and_the_requirement_is_not_widened(p, tmp_path, monkeypatch):
    hive = p.hive
    entry = studio_program(p, tmp_path, monkeypatch)
    assert hive.app_attachments.required(entry) is False                   # a hive with no activation row anywhere
    setup(p)
    home = hive.studio_makers.binding(MIA)["swarm_id"]
    assert activations(hive) == [] and hive.app_attachments.required(entry) is False   # still not required anywhere
    att = hive.app_attachments
    assert att.active("omegadesign", home) is True
    other = p.client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()["id"]
    assert att.active("omegadesign", other) is False                       # any other swarm: as before
    assert att.active("omegadesign", p.home["id"]) is False
    assert att.active("some-other-app", home) is False                     # any other program in her swarm: as before
    # Bob (no setup) has nothing active; his save in Mia's swarm is not his to reach
    hive.db.execute("INSERT INTO app_activations VALUES ('omegadesign', ?, 1, 'user:u_jon')", (other,))
    assert att.required(entry) is True
    r = save_source(p, home, who=p.bob, key="keep-bob-01")
    assert r.status_code in (403, 404), r.text
    # an admin's explicit deactivation in her swarm is honoured (the row decides when there is one)
    hive.db.execute("INSERT INTO app_activations VALUES ('omegadesign', ?, 0, 'user:u_jon')", (home,))
    assert att.active("omegadesign", home) is False
    assert (save_source(p, home, key="keep-0002").json().get("error") or {}).get("code") == "app_inactive"


def test_R82_studio_off_writes_nothing_and_activates_nothing(studio_elsewhere, monkeypatch):
    x, hive = studio_elsewhere, studio_elsewhere.hive
    setup(x)
    home = hive.studio_makers.binding(MIA)["swarm_id"]
    monkeypatch.setattr(hive.studio, "enabled", False)
    before = (activations(hive), tables(hive))
    assert setup(x).status_code == 404
    assert (activations(hive), tables(hive)) == before
    assert hive.app_attachments.active("omegadesign", home) is False      # Studio off: exactly as before R8.2
    r = save_source(x, home)
    assert (r.status_code, (r.json().get("error") or {}).get("code")) == (403, "app_inactive"), r.text


def test_R82_setup_is_idempotent_and_the_activation_follows_the_host_attachment(studio_elsewhere):
    x, hive = studio_elsewhere, studio_elsewhere.hive
    first = setup(x).json()["maker"]
    home = hive.studio_makers.binding(MIA)["swarm_id"]
    before = (activations(hive), tables(hive))
    again = setup(x).json()["maker"]
    assert (again["id"], again["swarm_id"]) == (first["id"], home) and (activations(hive), tables(hive)) == before
    rows = hive.db.all("SELECT * FROM app_attachments WHERE program = 'omegadesign' AND mind = ? AND status = 'active'", (first["id"],))
    assert len(rows) == 1
    assert save_source(x, home).status_code == 200
    assert save_source(x, home).status_code == 200                         # the same intent again: its recorded result
    # the host attachment revoked (an admin's revoke): her swarm is no longer active
    hive.db.execute("UPDATE app_attachments SET status = 'revoked' WHERE id = ?", (rows[0]["id"],))
    assert hive.app_attachments.active("omegadesign", home) is False
    assert (save_source(x, home, key="keep-0003").json().get("error") or {}).get("code") == "app_inactive"
