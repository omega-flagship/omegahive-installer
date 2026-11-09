"""Refusals never describe a key to someone who may not see it (sol and Kimi on f4bb6907: fix it once, at the boundary).

Every JSON refusal leaves through ONE projection (app.KeyViewResponses -> keyview.redact_error), for every caller but a
hive admin: a member's session, an outside harness's agent token, a signed-out caller. No key id, key:<id> budget
scope, key label or other person's principal reaches anyone the key policy (key_permit) does not let see that exact
key; a missing key is never visible. A provider's own error text is stripped of this hive's ids and people too.
The table drives every known error path (this round's and R1-R4's) and checks each answer the same way.
The world (test_studio_session_r7's): Mia and Bob are members; Ann's personal key is the provider default; Bob holds
his own key, labelled "Bob Personal Key". Invented keys, synthetic people, disposable hives; no network.
"""
import json

import pytest

from hive.core import keyview
from hive.tests.test_ask_intents import ORIGIN, a, held, release, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, err, s  # noqa: F401  (fixtures)
from hive.tests.test_studio_session_r7 import BOB, BOB_KEY, MODEL, personal_world

LABEL = "Bob Personal Key"
OTHER_MODEL = "anthropic/claude-sonnet-5-5"
FORBIDDEN = (BOB_KEY, LABEL, BOB)


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    """No network, ever (conftest deny_network), installed before any app fixture of this module builds a hive."""


@pytest.fixture()
def p(s, monkeypatch):
    x = personal_world(s, monkeypatch)
    x.monkeypatch = monkeypatch
    import httpx                                     # no network, ever: any call that gets past every check is refused here
    x.client.app.state.gateway.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(500, json={"error": "network blocked in tests"})))
    hive, c = x.hive, x.client
    hive.keyring.ring["keys"][BOB_KEY]["label"] = LABEL
    router = hive.keyring.provider("openrouter")
    monkeypatch.setattr(router, "prices", {**router.prices, MODEL.partition("/")[2]: {"in": 1, "out": 1}})
    # Mia's own mind, on Bob's key: an admin's assignment (the case every path below starts from)
    x.mine = c.post("/api/agents", headers=x.mg, json={"name": "Mia's harness", "kind": "omega", "model": MODEL, "budget_usd": 5}).json()
    assert c.patch(f"/api/agents/{x.mine['id']}", json={"options": {"key": BOB_KEY}}).status_code == 200
    x.bobs = c.post("/api/agents", headers=x.bob, json={"name": "Bob's helper", "kind": "omega", "model": MODEL,
                                                         "budget_usd": 1, "options": {"key": BOB_KEY}}).json()
    assert c.put(f"/api/agents/{x.bobs['id']}/visibility", headers=x.bob, json={"visibility": "public"}).status_code == 200
    return x


def chat(x, mind=None):
    return x.client.post("/llm/v1/chat/completions", headers=agent_headers(mind or x.mine),
                         json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})


def clean(response, forbidden=FORBIDDEN):
    """A refusal that names none of the forbidden things, anywhere in its body."""
    assert response.status_code >= 400, response.text
    for word in forbidden:
        assert word not in response.text, (word, response.text)
    return response


# ---- each path, as the caller who must not see Bob's key ------------------------------------------------------------

def path_patch_names_bobs_key(x):                       # R3: a member naming another person's key on her own mind
    fresh = x.client.post("/api/agents", headers=x.mg, json={"name": "Mia's notes", "kind": "omega", "model": MODEL,
                                                              "budget_usd": 1}).json()
    return x.client.patch(f"/api/agents/{fresh['id']}", headers=x.mg, json={"options": {"key": BOB_KEY}, "model": OTHER_MODEL})


def path_patch_model_only_on_bobs_mind(x):              # R4: a model-only edit that would strand a kept key
    return x.client.patch(f"/api/agents/{x.bobs['id']}", headers=x.mg, json={"model": OTHER_MODEL})


def path_patch_kept_deleted_key(x):                     # sol 1: a retained key that is gone, on a model-only edit
    del x.hive.keyring.ring["keys"][BOB_KEY]
    return x.client.patch(f"/api/agents/{x.mine['id']}", headers=x.mg, json={"model": OTHER_MODEL})


def path_gateway_key_gone(x):                           # R4 / Kimi 4: the gateway, to an agent token
    del x.hive.keyring.ring["keys"][BOB_KEY]
    return chat(x)


def path_budget_on_bobs_key(x):                         # sol 2: a spend limit on the key itself, to an agent token
    x.hive.budgets.set(f"key:{BOB_KEY}", "month", 0.0)  # (Bob's own harness: an agent token sees no key id at all)
    return chat(x, x.bobs)


def path_no_key_grant(x):                               # sol 3: refused use, whose details name the key's owner
    x.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_mia'")   # her harness calls on: nobody pays for her
    return chat(x)


def path_refresh_bobs_key(x):                           # R1 follow-up: describing Bob's key by id
    return x.client.post(f"/api/keys/{BOB_KEY}/refresh", headers=x.mg)


#: what each path is for: the code it must reach (so a path never silently tests something else)
CODES = {"patch_names_bobs_key": "unknown_key", "patch_model_only_on_bobs_mind": "key_provider_mismatch",
         "patch_kept_deleted_key": "unknown_key", "gateway_key_gone": "key_unavailable", "budget_on_bobs_key": "spend_limit",
         "no_key_grant": "no_key_grant", "refresh_bobs_key": "not_found"}

PATHS = [path_patch_names_bobs_key, path_patch_model_only_on_bobs_mind, path_patch_kept_deleted_key,
         path_gateway_key_gone, path_budget_on_bobs_key, path_no_key_grant, path_refresh_bobs_key]


@pytest.mark.parametrize("path", PATHS, ids=[f.__name__[5:] for f in PATHS])
def test_no_refusal_describes_a_key_to_someone_who_may_not_see_it(p, path):
    p.forbidden_extra = ()
    r = path(p)
    assert r.json()["error"]["code"] == CODES[path.__name__[5:]], r.text
    clean(r, FORBIDDEN + tuple(w for w in p.forbidden_extra if w and w.startswith(("user:u_", "env:"))))


def test_the_budget_refusal_keeps_its_meaning_without_the_key(p):
    r = clean(path_budget_on_bobs_key(p))
    e = r.json()["error"]
    assert e["code"] == "spend_limit" and e.get("scope") == "key"      # still says a key's own limit stopped it


def test_an_admin_still_reads_every_refusal_in_full(p):
    r = p.client.patch(f"/api/agents/{p.bobs['id']}", json={"model": OTHER_MODEL})   # the operator: an admin
    assert r.status_code == 400 and "openrouter" in r.text              # the detailed words (its provider)
    assert LABEL not in r.text                                           # R7: no refusal names a key's label, ever


def test_a_missing_key_is_never_visible_to_a_member(p):
    """sol 1: key_permit's "not a key here" was visible; a mind on a key that is gone never shows the id."""
    del p.hive.keyring.ring["keys"][BOB_KEY]
    view = p.client.get(f"/api/agents/{p.mine['id']}", headers=p.mg).json()
    assert BOB_KEY not in json.dumps(view)


# ---- the projection itself ----------------------------------------------------------------------------------------

def test_redaction_keeps_what_the_caller_may_see_and_nothing_else():
    text = f"key:{BOB_KEY} has spent $1 of key:{BOB_KEY}:month; owner {BOB}; you {MIA}; env:openrouter; {LABEL} said no"
    hidden = keyview.redact_text(text, lambda key: False, MIA)
    assert BOB_KEY not in hidden and BOB not in hidden and "env:openrouter" not in hidden
    assert MIA in hidden and hidden.startswith("key has spent $1 of key:month")
    seen = keyview.redact_text(text, lambda key: key == BOB_KEY, MIA)
    assert BOB_KEY in seen and "env:openrouter" not in seen


def test_a_providers_own_words_never_carry_this_hives_ids_or_people():
    words = f'{{"error": "key {BOB_KEY} for {BOB} over quota", "detail": "env:openrouter"}}'
    stripped = keyview.strip_identities(words)
    assert BOB_KEY not in stripped and BOB not in stripped and "env:openrouter" not in stripped
    assert "over quota" in stripped


# ---- R6 (sol and Kimi on bef0f01b): direct regressions ---------------------------------------------------------------

def test_a_refused_reservation_names_no_key(p, monkeypatch):
    """reservation_refused ("Shared budget exhausted: key:<id>:month") after a preflight that let the call through."""
    monkeypatch.setattr(p.hive, "check_budget", lambda *a, **k: None)                # the race: admitted, then refused
    p.hive.budgets.set(f"key:{BOB_KEY}", "month", 0.0)
    r = chat(p, p.bobs)
    assert (r.status_code, r.json()["error"]["code"]) == (402, "reservation_refused"), r.text
    clean(r)


def test_an_assigned_environment_key_is_never_named_to_an_agent_token(p, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    p.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", ('{"key": "env:openrouter"}', p.mine["id"]))
    r = chat(p)
    assert r.status_code >= 400, r.text
    clean(r, FORBIDDEN + ("env:openrouter",))


def test_ask_refusal_frames_are_projected_at_their_source_for_the_asker(p):
    """A real frame of Mia's own Ask turn, built where every frame is (Ask._frame): what is published and what is stored
    for replay (both HTTP 200, never seen by the response projection) carry nothing of Bob's key."""
    hive = p.hive
    tid = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-mia-turn-01'")["id"]
    fields = {"limit": {"kind": "key", "scope": f"key:{BOB_KEY}", "owner": BOB}, "say": f"{BOB_KEY} has no room",
              "error": "spend_limit"}
    with hive.db.transaction():
        published = hive.ask._frame(tid, "thinking_note", **json.loads(json.dumps(fields)))
    stored = hive.db.one("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 1", (tid,))
    for text in (json.dumps(published), stored["frame"] if stored else ""):
        assert BOB_KEY not in text and LABEL not in text and BOB not in text, text
    assert published["limit"]["kind"] == "key" and published["error"] == "spend_limit"   # protocol fields untouched
    frame = dict(fields)
    assert hive.ask._frame_for_asker("user:operator", frame) == fields                # an admin: as it was


def test_the_gateway_never_relays_a_providers_own_words():
    import httpx
    from hive.core.gateway import upstream_refusal
    words = json.dumps({"error": {"message": "Key \\u006b_0000b0b1 of Bob over quota", "title": "Bob's helper"}})
    exc = upstream_refusal("openrouter", httpx.Response(429, text=words))
    assert exc.status == 429 and exc.code == "upstream_error"
    assert exc.message == "OpenRouter refused the request (rate_limited, 429)."


def test_protocol_fields_are_never_rewritten_at_any_depth_and_nothing_in_a_text_can_steer_the_pass():
    body = {"error": {"code": "spend_limit", "message": f"spend_limit reached for {MIA} on {BOB_KEY}", "owner": MIA,
                      "limit": {"kind": "key", "scope": f"key:{BOB_KEY}", "reason": "monthly_total_required"}}}
    out = keyview.redact_error(body, lambda key: False, MIA)["error"]
    assert out["code"] == "spend_limit" and out["owner"] == MIA and MIA in out["message"] and BOB_KEY not in out["message"]
    assert out["limit"] == {"kind": "key", "scope": "key", "reason": "monthly_total_required"}   # kind/reason untouched
    smuggled = {"detail": {"code": BOB_KEY, "id": f"key:{BOB_KEY}", "error": BOB, "type": [BOB_KEY], "message": BOB_KEY}}
    assert keyview.redact_error(smuggled, lambda key: False)["detail"] == {
        "code": "a key", "id": "key", "error": "someone", "type": ["a key"], "message": "a key"}
    # keyview R9 (Dot on a0975c2f): no field is exempt; an id or principal in a code, an id, an error or a list is
    # caught too, while a real code (never an id) comes out exactly as it went in
    for trap in ("\x000\x00", "\x00999\x00", "\x00", "a key", "someone"):                  # one pass: no placeholders
        assert keyview.redact_text(trap + " " + BOB_KEY, lambda key: False) == trap + " a key"


def test_an_mcp_tool_error_names_no_key_label_or_person(p):
    from hive.core.hive import HiveError
    out = p.hive.harnesses._fail(1, HiveError(402, "spend_limit", f"key:{BOB_KEY} for {BOB} has no room",
                                             {"scope": f"key:{BOB_KEY}", "owner": BOB}), p.hive.keyring)
    assert out["error"]["data"]["code"] == "spend_limit" and BOB_KEY not in json.dumps(out) and BOB not in json.dumps(out), out


def test_a_deleted_keys_former_owner_still_recognises_it_and_nobody_else_does(p):
    p.hive.keyring.remove_key_id(BOB_KEY)                                            # Bob's mind still names it
    assert p.client.get(f"/api/agents/{p.bobs['id']}", headers=p.bob).json()["options"].get("key") == BOB_KEY
    assert "key" not in p.client.get(f"/api/agents/{p.bobs['id']}", headers=p.mg).json()["options"]
    assert BOB_KEY not in json.dumps(p.client.get(f"/api/agents/{p.bobs['id']}", headers=p.mg).json())


def test_no_network_is_reachable_from_these_tests():
    import asyncio

    import httpx

    async def reach():
        async with httpx.AsyncClient() as client:
            await client.get("https://example.com/")
    with pytest.raises(httpx.ConnectError):
        asyncio.run(reach())



# ---- R7 (sol and Kimi on 593fde34): no label substitution; identities by grammar only; tombstones; access; network ----

def test_an_echoed_label_is_no_oracle_a_held_one_and_a_made_up_one_read_the_same(p):
    """sol P1: substitution turned 'no agent Bob Personal Key' into 'no agent a key' only when that label existed."""
    held = p.client.get("/api/agents/Bob%20Personal%20Key", headers=p.mg)
    madeup = p.client.get("/api/agents/Nobody%20Has%20This", headers=p.mg)
    assert (held.status_code, held.json()) == (madeup.status_code, madeup.json()), (held.text, madeup.text)


#: interpolations of a ['label'] that are not a key's, each with its reason
LABEL_ALLOWED = {("code.py", "t['label']"): "a Code target's label (a repository the person opens), never a key's",
                 ("program.py", "g['label']"): "Commons Explorer's belief-graph group label, never a key's"}


def test_no_call_anywhere_interpolates_a_label_except_the_known_non_keys():
    """keyview R7/R8 (Dot on 1edef3b4): labels never reach a refusal (no substitution to fall back on). Every call in
    every Python package under hive/ (tests and the UI aside) whose arguments interpolate a ['label'] is either on the
    allowlist above, with its reason, or a failure: a refusal, a log line or anything else built from a key's label."""
    import ast
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[1]
    hits = []
    for path in root.rglob("*.py"):
        if {"tests", "ui", "node_modules"} & set(path.relative_to(root).parts):
            continue
        src = path.read_text(errors="replace")
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for arg in [*node.args, *(k.value for k in node.keywords)]:
                for js in ast.walk(arg):
                    if not isinstance(js, ast.JoinedStr):
                        continue
                    for part in ast.walk(js):
                        if isinstance(part, ast.Subscript) and isinstance(part.slice, ast.Constant) and part.slice.value == "label":
                            seg = ast.get_source_segment(src, part) or ""
                            if (path.name, seg) not in LABEL_ALLOWED:
                                hits.append(f"{path.relative_to(root)}:{node.lineno}: {seg}")
    assert hits == [], hits


def test_a_tombstone_keeps_no_principal_and_goes_once_no_mind_names_the_key(p):
    store = p.hive.keyring
    store.remove_key_id(BOB_KEY)                                                    # Bob's mind and Mia's still name it
    assert BOB not in json.dumps(store.ring.get("removed")) and store.removed_by(BOB_KEY, BOB)
    assert not store.removed_by(BOB_KEY, MIA)
    p.hive.update_agent(p.bobs["id"], {"options": {}}, by=BOB)
    assert BOB_KEY in store.ring["removed"], "Mia's mind still names it"
    p.hive.update_agent(p.mine["id"], {"options": {}})
    assert BOB_KEY not in store.ring.get("removed", {}), "nobody names it: forgotten"


def test_a_disabled_person_is_projected_as_seeing_no_key(p):
    mias_own = p.hive.keyring.ring["keys"].get(KEY)
    p.hive.keyring.ring["keys"]["k_0000aaaa"] = {"id": "k_0000aaaa", "provider": "openrouter", "label": "x",
                                                 "owner": MIA, "secret": "sk-or-mia-invented-aaaa", "created_at": 0}
    assert p.hive.key_seer_for(MIA)("k_0000aaaa") is True
    p.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_mia'")
    assert p.hive.key_seer_for(MIA)("k_0000aaaa") is False
    assert mias_own is None or True


def test_the_provider_log_line_keeps_no_body(caplog):
    import httpx
    from hive.core.gateway import upstream_refusal
    upstream_refusal("openrouter", httpx.Response(401, text="echo sk-or-v1-" + "a" * 40 + " for " + BOB))
    assert "sk-or-v1" not in caplog.text and BOB not in caplog.text and "401" in caplog.text


def test_the_network_fence_has_no_back_door():
    import socket
    for address in (("127.attacker.example", 80), ("::", 9), ("0.0.0.0", 9), ("203.0.113.9", 443)):
        s = socket.socket(socket.AF_INET6 if ":" in address[0] else socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(OSError, match="network denied"):
                s.connect(address)
        finally:
            s.close()
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        with pytest.raises(OSError, match="network denied"):
            u.sendto(b"x", ("203.0.113.9", 53))
    finally:
        u.close()
    with pytest.raises(OSError, match="network denied"):
        socket.getaddrinfo("127.attacker.example", 80)
    loop = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:   # an expanded IPv6 loopback is loopback: not refused by the fence (nothing listens, so the OS refuses instead)
        with pytest.raises(OSError) as no_one:
            loop.connect(("0:0:0:0:0:0:0:1", 9))
        assert "network denied" not in str(no_one.value)
    finally:
        loop.close()


# ---- R8 (sol and Kimi on 1edef3b4): the provider-side tail ----------------------------------------------------------

def _provider_answers(p, status, body):
    import httpx
    p.hive.keyring.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status, text=body)))


ECHO = json.dumps({"error": {"message": f"key sk-or-v1-{'a' * 40} ({BOB_KEY}) of {BOB} for {LABEL}", "code": BOB_KEY}})


def test_the_endpoints_refresh_never_relays_the_providers_words(p):
    """By whoever may cause the fetch (keyview R12: the default key's own route, here Ann's); anyone else is refused it."""
    from hive.tests.test_key_entitlement import ANN, session_for
    _provider_answers(p, 500, ECHO)
    off = p.client.get("/api/providers/openrouter/endpoints/test/maker?refresh=1", headers=p.mg)
    assert (off.status_code, off.json()["error"]["code"]) == (403, "refresh_not_allowed") and "answered" not in off.text
    r = p.client.get("/api/providers/openrouter/endpoints/test/maker?refresh=1", headers=session_for(p.hive, ANN))
    assert r.status_code >= 400
    assert all(w not in r.text for w in ("sk-or-v1", BOB_KEY, BOB, LABEL)), r.text
    assert "answered 500 (unavailable)" in r.text


def test_a_failed_key_check_never_relays_the_providers_words(p):
    import asyncio

    from hive.core.providers import ProviderError
    _provider_answers(p, 500, ECHO)
    with pytest.raises(ProviderError) as refused:
        asyncio.run(p.hive.keyring.verify("openrouter", "sk-or-mia-invented-0123"))
    assert refused.value.message == "OpenRouter answered 500 (unavailable)" or "(unavailable)" in refused.value.message
    assert all(w not in refused.value.message for w in ("sk-or-v1", BOB_KEY, BOB, LABEL))


def test_a_providers_key_count_is_the_callers_own(p):
    def count(headers=None):
        return next(v for v in p.client.get("/api/providers", headers=headers).json() if v["name"] == "openrouter")["keys"]
    before = count(p.mg)
    p.hive.keyring.ring["keys"]["k_0000b0b2"] = {"id": "k_0000b0b2", "provider": "openrouter", "label": "Bob's second",
                                                 "owner": BOB, "secret": "sk-or-bob-invented-second", "created_at": 0}
    assert count(p.mg) == before, "Bob's inventory never shows in Mia's count"
    assert count() >= before + 2, "an admin counts every key"


def test_the_providers_update_frame_never_reaches_a_member(p):
    """providers.updated is an admin event (visibility.EVENT_AUDIENCE): a member never receives it at all, so no
    count, hint or account in it can reach one; an admin's connection gets it whole."""
    from hive.tests.test_ask_intents import drain, token_of
    hive = p.hive
    hive.keyring.accounts[BOB_KEY] = {"label": LABEL, "usage": 1.0}
    hive.keyring.ring["defaults"]["openrouter"] = BOB_KEY                           # Bob's key pays by default now
    with p.client.websocket_connect(f"/api/events?token={token_of(p.mg)}") as ws:
        assert ws.receive_json()["type"] == "hello"
        hive.events.publish("providers.updated", providers=hive.keyring.list())
        hive.events.publish("programs.updated", programs=[], marker="end")
        frames = [f for f in drain(ws) if f.get("type") == "providers.updated"]
    assert frames == [], frames


def test_a_tombstone_goes_with_the_last_mind_that_named_its_key_and_orphans_go_at_reconcile(p):
    store, hive = p.hive.keyring, p.hive
    store.remove_key_id(BOB_KEY)
    hive.delete_agent(p.bobs["id"])
    assert BOB_KEY in store.ring["removed"], "Mia's mind still names it"
    hive.delete_agent(p.mine["id"])
    assert BOB_KEY not in store.ring.get("removed", {}), "deleted with the last mind that named it"
    store.ring.setdefault("removed", {})["k_0000dead"] = "x" * 32                    # an orphan from before
    hive.reconcile_removed_keys()
    assert "k_0000dead" not in store.ring["removed"]


def test_the_fence_also_guards_sendmsg():
    import socket
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        with pytest.raises(OSError, match="network denied"):
            u.sendmsg([b"x"], [], 0, ("203.0.113.9", 53))
    finally:
        u.close()


# ---- R9 (sol and Kimi on a0975c2f): no field exemption; no existence oracle; tombstones once settled; one grammar -----

def test_another_members_private_key_changes_nothing_a_member_is_shown(p):
    """sol P1 / Kimi P2: storing a private key made a provider 'connected' (and its models listed) for everyone."""
    c = p.client
    def openai(headers=None):
        return next(v for v in c.get("/api/providers", headers=headers).json() if v["name"] == "openai")
    def openai_models(headers=None):
        return [m["id"] for m in c.get("/api/models", headers=headers).json() if m["provider"] == "openai"]
    before, before_models = openai(p.mg), openai_models(p.mg)
    p.hive.keyring.ring["keys"]["k_0000b0b3"] = {"id": "k_0000b0b3", "provider": "openai", "label": "Bob's openai",
                                                 "owner": BOB, "secret": "sk-bob-openai-invented-0003", "created_at": 0}
    after = openai(p.mg)
    fields = ("connected", "configured", "source", "readiness", "answer_ready", "keys", "key_hint", "account")
    assert {f: after.get(f) for f in fields} == {f: before.get(f) for f in fields}, (before, after)
    assert after["connected"] is False and after["keys"] == 0
    assert openai_models(p.mg) == before_models == []
    assert openai()["connected"] is True and openai_models(), "an admin sees the hive as it is"


def test_a_swarms_delete_with_minds_settles_the_tombstones_of_keys_only_its_minds_named(p):
    hive, c, store = p.hive, p.client, p.hive.keyring
    sw = c.post("/api/swarms", json={"name": "Old lab"}).json()
    inside = c.post("/api/agents", json={"name": "Lab mind", "kind": "omega", "swarm_id": sw["id"], "model": MODEL,
                                         "budget_usd": 1, "options": {"key": BOB_KEY}}).json()
    hive.db.execute("UPDATE agents SET options = '{}' WHERE id IN (?, ?)", (p.mine["id"], p.bobs["id"]))   # only it
    store.remove_key_id(BOB_KEY)
    assert BOB_KEY in store.ring["removed"]
    hive.delete_swarm_with_minds(sw["id"], "Old lab", by="user:operator")
    assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (inside["id"],))["deleted"] == 1
    assert BOB_KEY not in store.ring.get("removed", {})


def test_startup_reconcile_is_one_scan_and_one_keyring_write(p, monkeypatch):
    hive, store = p.hive, p.hive.keyring
    for i in range(5):
        store.ring.setdefault("removed", {})[f"k_0000dea{i}"] = "x" * 32
    writes, scans = [], []
    real_commit, real_all = store._commit, hive.db.all
    monkeypatch.setattr(store, "_commit", lambda mutate: (writes.append(1), real_commit(mutate))[1])
    monkeypatch.setattr(hive.db, "all", lambda sql, *a: (scans.append(sql) if "FROM agents" in sql else None, real_all(sql, *a))[1])
    hive.reconcile_removed_keys()
    assert not any(k.startswith("k_0000dea") for k in store.ring["removed"])
    assert len(writes) == 1 and len(scans) == 1, (writes, scans)


def test_every_module_takes_the_one_key_id_grammar():
    from hive.core import keyids, me_decisions, ownhive, studio_sessions
    from hive.core.providers import clean_options
    for good in ("k_0000b0b1", "k_" + "a" * 32, "env:openrouter"):
        assert clean_options({"key": good})["key"] == good
        assert ownhive.HOLD_KEY.match(good) and studio_sessions.KEY_ID.fullmatch(good)
        assert keyview.redact_text(good, lambda key: False) == "a key"
    for bad in ("k_0000B0B1", "k_000", "k_" + "a" * 16):
        assert not ownhive.HOLD_KEY.match(bad) and not studio_sessions.KEY_ID.fullmatch(bad)
    assert me_decisions.KEY.match("k_" + "a" * 32) and not me_decisions.KEY.match("env:openrouter")
    assert keyids.KEY_ID in keyview.IDENTITY.pattern
