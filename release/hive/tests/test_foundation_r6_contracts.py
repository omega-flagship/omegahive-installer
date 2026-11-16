"""Source-only R6 controls: real binding selector and canonical template methods.

No Hive, model, provider, native worker or app factory is constructed here.
These controls are unrun; the original Foundation app controls remain separate.
"""
import copy
from types import SimpleNamespace

import pytest

from hive.core.db import Database
from hive.core.foundation import CODE, REVIEW, foundation_budget_ids
from hive.core.minds import Minds


@pytest.fixture
def side_db(tmp_path):
    db = Database(tmp_path / "foundation-r6.db", hive_schema=False)
    try:
        yield db
    finally:
        db._conn.close()


def binding_table(db):
    db.execute("CREATE TABLE person_minds (principal TEXT, purpose TEXT, swarm_id TEXT, agent_id TEXT)")


def template_fields():
    return {"template_id": "invented.source-control", "harness": "native", "model_id": "mock/echo",
            "role_id": None, "max_allocation_usd": .25, "controls": ["stop", "retire"],
            "lifecycle_modes": ["deliver", "bounded"]}


def test_absent_binding_table_is_empty_without_schema_or_write(side_db):
    before = side_db.all("SELECT name,sql FROM sqlite_master ORDER BY name")
    changes = side_db._conn.total_changes
    side_db.execute("PRAGMA query_only = ON")
    assert foundation_budget_ids(side_db) == (frozenset(), frozenset())
    assert side_db.all("SELECT name,sql FROM sqlite_master ORDER BY name") == before
    assert side_db._conn.total_changes == changes


def test_binding_selector_uses_only_existing_exact_purposes_readonly(side_db):
    binding_table(side_db)
    for row in [("user:one", CODE, "s_code", "a_code"),
                ("user:two", REVIEW, "s_review", "a_review"),
                ("user:duplicate", CODE, "s_code", "a_code"),
                ("user:other", "personal", "s_other", "a_other"),
                ("user:other", CODE + "-lookalike", "s_named_code", "a_named_code"),
                ("user:partial", REVIEW, None, ""),
                ("user:partial", CODE, "", None)]:
        side_db.execute("INSERT INTO person_minds VALUES (?,?,?,?)", row)
    before = side_db.all("SELECT * FROM person_minds ORDER BY rowid")
    changes = side_db._conn.total_changes
    side_db.execute("PRAGMA query_only = ON")
    swarms, minds = foundation_budget_ids(side_db)
    assert (swarms, minds) == (frozenset({"s_code", "s_review"}), frozenset({"a_code", "a_review"}))
    assert type(swarms) is type(minds) is frozenset
    assert side_db.all("SELECT * FROM person_minds ORDER BY rowid") == before
    assert side_db._conn.total_changes == changes


def test_binding_selector_has_no_identity_cache(side_db):
    binding_table(side_db)
    side_db.execute("INSERT INTO person_minds VALUES (?,?,?,?)", ("user:one", CODE, "s_old", "a_old"))
    assert foundation_budget_ids(side_db) == (frozenset({"s_old"}), frozenset({"a_old"}))
    side_db.execute("UPDATE person_minds SET swarm_id=?,agent_id=? WHERE purpose=?", ("s_new", "a_new", CODE))
    assert foundation_budget_ids(side_db) == (frozenset({"s_new"}), frozenset({"a_new"}))
    side_db.execute("DELETE FROM person_minds WHERE purpose=?", (CODE,))
    assert foundation_budget_ids(side_db) == (frozenset(), frozenset())


@pytest.mark.parametrize("scopes", [["s_one"], ["s_two", "s_one"], ["s_one", "s_one"]])
def test_native_scope_keyword_preserves_legacy_wire_normalization(scopes):
    entry = template_fields()
    before = copy.deepcopy(entry)
    legacy = Minds._template(dict(entry, teams=scopes))
    native = Minds._template(entry, swarm_ids=scopes)
    assert native == legacy
    assert native["teams"] == sorted(set(scopes))
    assert entry == before


def test_explicit_legacy_scope_keeps_original_precedence():
    entry = dict(template_fields(), teams=["s_old"])
    assert Minds._template(entry, swarm_ids=["s_new"]) == Minds._template(entry)


@pytest.mark.parametrize("scopes", [None, [], "s_one", ("s_one",), [""], [None], [1]])
def test_native_scope_keyword_keeps_original_validation(scopes):
    with pytest.raises(ValueError):
        Minds._template(template_fields(), swarm_ids=scopes)


def test_exact_registration_is_single_scope_and_default_membership_is_unchanged():
    single = dict(template_fields(), teams=["s_one"])
    multiple = dict(single, template_id="invented.multiple", teams=["s_one", "s_two"])
    duplicate = dict(single, template_id="invented.duplicate", teams=["s_one", "s_one"])
    other = dict(single, template_id="invented.other", teams=["s_two"])
    original = {row["template_id"]: row for row in (single, multiple, duplicate, other)}
    store = SimpleNamespace(templates=original)
    snapshot = copy.deepcopy(original)
    assert Minds.registered(store, "s_one") == [single, multiple, duplicate]
    assert Minds.registered(store, "s_one", exact=True) == [single]
    assert Minds.registered(store, "missing", exact=True) == []
    assert original == snapshot


def denial_reply(body=None, *, status="401 Unauthorized", headers=None):
    body = body if body is not None else b'{"error":"authentication_required","message":"a scoped bearer capability is required"}'
    values = [("Content-Length",str(len(body))), ("Content-Type","application/json")]
    values = values if headers is None else headers
    return ("HTTP/1.1 " + status + "\r\n" + "\r\n".join(k+": "+v for k,v in values) + "\r\n\r\n").encode("ascii") + body


def probe_world(monkeypatch, reply, *, times=None):
    # Only the socket and clock boundary is modeled. The real method builds,
    # bounds, parses and checks the protocol; this creates no OS socket.
    import hive.core.foundation as module
    class Connection:
        def __init__(self):
            self.data = reply
            self.sent = b""
            self.endpoint = None
            self.closed = False
            self.timeouts = []
        def __enter__(self):
            return self
        def __exit__(self,*exc):
            self.closed = True
        def settimeout(self,value):
            self.timeouts.append(value)
        def connect(self,endpoint):
            self.endpoint = endpoint
        def sendall(self,data):
            self.sent += data
        def recv(self,limit):
            part,self.data = self.data[:limit],self.data[limit:]
            return part
    connection = Connection()
    constructors = []
    def original_socket(family,kind):
        constructors.append((family,kind))
        return connection
    clock = (lambda: next(times)) if times is not None else (lambda: 0.0)
    monkeypatch.setattr(module,"socket",SimpleNamespace(AF_INET=2,SOCK_STREAM=1,socket=original_socket))
    monkeypatch.setattr(module,"time",SimpleNamespace(monotonic=clock))
    foundation = object.__new__(module.HiveFoundation)
    foundation.db = SimpleNamespace(_conn=SimpleNamespace(in_transaction=False))
    foundation.hive = SimpleNamespace(error=lambda *args: RuntimeError(args[-1]))
    return foundation,connection,constructors


def test_code_denial_observation_is_owned_anonymous_and_bounded(monkeypatch):
    foundation,connection,constructors = probe_world(monkeypatch,denial_reply())
    service = {"id":"svc_invented","address":"http://127.0.0.1:8724","capability_secret":"must-not-be-sent"}
    assert foundation._code_reachable(service) is True
    assert constructors == [(2,1)] and connection.endpoint == ("127.0.0.1",8724)
    assert connection.sent == (b"GET /v1/capabilities HTTP/1.1\r\nHost: 127.0.0.1:8724\r\n"
                               b"Accept: application/json\r\nConnection: close\r\n\r\n")
    assert connection.closed and connection.timeouts and all(0 < t <= 1 for t in connection.timeouts)


@pytest.mark.parametrize("address", [None,"http://localhost:8724","https://127.0.0.1:8724",
    "http://127.0.0.1:8724/","http://127.0.0.1:8724?x=1","http://127.0.0.1:8724#x",
    "http://user@127.0.0.1:8724","http://127.0.0.2:8724","http://[::1]:8724",
    "http://127.0.0.1:80","http://127.0.0.1:65536","http://127.0.0.1:8724\n"])
def test_code_denial_observation_rejects_nonexact_endpoints_without_a_socket(monkeypatch,address):
    foundation,connection,constructors = probe_world(monkeypatch,denial_reply())
    assert foundation._code_reachable({"address":address}) is False
    assert constructors == [] and connection.endpoint is None


@pytest.mark.parametrize("reply", [
    denial_reply(status="200 OK"),
    denial_reply(status="302 Found",headers=[("Location","http://elsewhere.invalid")]),
    denial_reply(b'{"error":"other","message":"a scoped bearer capability is required"}'),
    denial_reply(b'{"error":"other","error":"authentication_required","message":"a scoped bearer capability is required"}'),
    denial_reply(b'{"error":"authentication_required","message":"a scoped bearer capability is required","extra":true}'),
    denial_reply(b'\xff'),
    denial_reply(b'['*1500+b']'*1500),
    denial_reply(headers=[("Content-Length","5000"),("Content-Type","application/json")]),
    denial_reply(headers=[("Content-Length","0"),("Content-Length","0"),("Content-Type","application/json")]),
    denial_reply(headers=[("Transfer-Encoding","chunked"),("Content-Type","application/json")]),
    denial_reply(headers=[("Content-Length","0"),("Content-Type","text/plain")]),
    denial_reply() + b'extra',
    b'HTTP/1.1 401 Unauthorized\r\nX: ' + b'x'*4096,
    b'',
])
def test_code_denial_observation_refuses_unbound_or_oversize_protocol(monkeypatch,reply):
    foundation,connection,constructors = probe_world(monkeypatch,reply)
    assert foundation._code_reachable({"address":"http://127.0.0.1:8724"}) is False
    assert constructors == [(2,1)] and connection.closed


def test_code_denial_observation_has_one_total_deadline(monkeypatch):
    foundation,connection,constructors = probe_world(monkeypatch,denial_reply(),
        times=iter([0.0,0.0,0.1,0.2,0.3,1.01]))
    assert foundation._code_reachable({"address":"http://127.0.0.1:8724"}) is False
    assert connection.closed and constructors == [(2,1)]
    assert connection.timeouts == [1.0,.9,.8,.7]


def test_code_denial_observation_refuses_inside_database_transaction(monkeypatch):
    foundation,connection,constructors = probe_world(monkeypatch,denial_reply())
    foundation.db._conn.in_transaction = True
    with pytest.raises(RuntimeError,match="precede atomic admission"):
        foundation._code_reachable({"address":"http://127.0.0.1:8724"})
    assert constructors == []
