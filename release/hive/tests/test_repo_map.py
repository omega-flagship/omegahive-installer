"""Repository maps, Slice A (hive/core/repomap.py; PLATFORM_REPO_MAP_SLICE_A_CONTRACT_R1_20261011.md).

Synthetic data only. Two fixtures, copied verbatim into hive/tests/fixtures:
- repo-map-1.synthetic.json: Code's hand-written repo-map/1 shape fixture (FIXTURE_repo-map-1.synthetic.json).
- code-extractor-fixture-r1.json: Code's executed existing-extractor fixture (EXISTING_CODE_EXTRACTOR_FIXTURE_R1.json). It is
  not a repo-map/1 envelope, so ``code_fixture_envelope`` converts it here (see its docstring for the exact mapping).
"""

import copy
import importlib.util
import json
import pathlib

from hive.core import mcp, repomap
from hive.spaces import sexpr
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
SYNTHETIC = json.loads((FIXTURES / "repo-map-1.synthetic.json").read_text())
CODE_FIXTURE = json.loads((FIXTURES / "code-extractor-fixture-r1.json").read_text())
SHA1, SHA2 = "0000000000000000000000000000000000000001", "0000000000000000000000000000000000000002"
TDL_NOTE = "declared and static links only; not runtime coverage"


def code_fixture_envelope(fixture=CODE_FIXTURE):
    """Code's executed extractor fixture as a repo-map/1 envelope. The conversion (test-only, nothing added):
    - each `sources` [path, sha256] -> a file node `file:<path>`, source_digest `sha256:<hex>`, no refs (the census);
    - each `defines_name` fact -> a def node `def:<path>::<target>` and a `defines` edge from its file (basis syntax);
    - each `imports_module_candidate` fact -> an import node `import:<path>::<target>` (a candidate, not a resolved module);
    - each `dependencies` [from, to] pair -> an `imports` edge file -> file (basis syntax);
    - each `calls_expression` fact -> a `calls-expression` edge from its file to the bare name `name:<target>`, which is
      deliberately not a node: a call expression is not a resolved call;
    - `diagnostics` -> coverage.unresolved; `state`, `snapshot_digest` and `parser` pass through; `meaning` is the reason."""
    sources = {path: digest for path, digest in fixture["sources"]}
    nodes = [{"id": f"file:{p}", "kind": "file", "label": p, "source_digest": f"sha256:{d}", "refs": []} for p, d in fixture["sources"]]
    edges = []
    for i, fact in enumerate(fixture["facts"]):
        ref = [{"path": fact["path"], "line": fact["line"]}]
        if fact["kind"] == "defines_name":
            node_id = f"def:{fact['path']}::{fact['target']}"
            nodes.append({"id": node_id, "kind": "def", "label": fact["target"], "source_digest": f"sha256:{sources[fact['path']]}", "refs": ref})
            edges.append({"id": f"f{i}", "kind": "defines", "from": f"file:{fact['path']}", "to": node_id, "basis": "syntax", "refs": ref})
        elif fact["kind"] == "imports_module_candidate":
            nodes.append({"id": f"import:{fact['path']}::{fact['target']}", "kind": "import", "label": fact["target"],
                          "source_digest": f"sha256:{sources[fact['path']]}", "refs": ref})
        elif fact["kind"] == "calls_expression":
            edges.append({"id": f"f{i}", "kind": "calls-expression", "from": f"file:{fact['path']}", "to": f"name:{fact['target']}",
                          "basis": "syntax", "refs": ref})
        else:
            raise AssertionError(f"unmapped fact kind {fact['kind']}")
    for j, (src, dst) in enumerate(fixture["dependencies"]):
        edges.append({"id": f"d{j}", "kind": "imports", "from": f"file:{src}", "to": f"file:{dst}", "basis": "syntax", "refs": []})
    return {"schema": "repo-map/1", "repo": "code-fixture", "sha": "c0de" + "0" * 34 + "f1",
            "snapshot_digest": "sha256:" + fixture["snapshot_digest"],
            "extractor": {"id": "omegacode.repository_facts", "version": "fixture-r1", "parser": fixture["parser"]},
            "generated_at": "2026-10-11T00:00:00Z",
            "receipt": {"digest": "sha256:" + fixture["implementation_sha256"], "artifact_ref": "fixture://EXISTING_CODE_EXTRACTOR_FIXTURE_R1.json"},
            "state": fixture["state"], "reason": fixture["meaning"],
            "coverage": {"kinds": ["file", "def", "import"], "languages": ["python"],
                         "unresolved": [{"path": p, "issue": issue} for p, issue in fixture["diagnostics"]]},
            "nodes": nodes, "edges": edges, "truncated": False, "next_cursor": None}


def load(c, envelope, headers=None, **query):
    qs = "&".join(f"{k}={v}" for k, v in query.items())
    return c.post("/api/admin/repo-maps" + (f"?{qs}" if qs else ""), json=envelope, **({"headers": headers} if headers else {}))


def mind(c, swarm_name):
    hive = c.app.state.hive
    sw = c.post("/api/swarms", json={"name": swarm_name}).json()
    agent = hive.create_agent("M " + swarm_name, "module", sw["id"], "mock/echo")
    return sw, {"Authorization": f"Bearer {agent['token']}"}, agent


def q(c, sha, preset, params, repo="fixture-mini", headers=None, **extra):
    return c.post(f"/api/repo-maps/{repo}/{sha}/query", json={"preset": preset, "params": params, **extra},
                  **({"headers": headers} if headers else {}))


def mounted(c, repo, sha, atoms):
    """Wait for the loader's worker thread to finish mounting the revision's read-only space."""
    import time as _t
    maps = c.app.state.hive.repo_maps
    for _ in range(600):
        if maps.space(repo, sha)["status"] not in ("queued", "mounting"):
            break
        _t.sleep(0.05)
    assert maps.space(repo, sha) == {"id": f"repo:{repo}@{sha}", "kind": "read-only", "status": "mounted", "atoms": atoms}
    return maps.space(repo, sha)


def ids(items):
    return [i["id"] for i in items]


# ---- census, verbatim state, the one encoder ---------------------------------------------------------------------------

def test_synthetic_fixture_loads_with_its_exact_census_and_verbatim_state(client):
    r = load(client, SYNTHETIC)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["repo"] == "fixture-mini" and out["sha"] == SHA1 and out["state"] == "partial" and out["unchanged"] is False
    assert out["digest"] == repomap.digest_of(SYNTHETIC)
    assert out["counts"] == {"nodes": 6, "edges": 5, "refs": 10, "unresolved": 1,
                             "nodes_by_kind": {"def": 1, "doc": 1, "file": 3, "test": 1},
                             "edges_by_kind": {"calls-expression": 1, "defines": 1, "imports": 1, "test-doc-link": 2},
                             "edges_by_basis": {"declared": 1, "heuristic": 1, "syntax": 3}}
    head = client.get(f"/api/repo-maps/fixture-mini/{SHA1}").json()
    for key in ("schema", "state", "reason", "extractor", "generated_at", "receipt", "snapshot_digest", "coverage"):
        assert head[key] == SYNTHETIC[key], key                  # passed through verbatim
    assert "nodes" not in head and "edges" not in head and head["counts"] == out["counts"]
    listed = client.get("/api/repo-maps").json()
    assert [(m["repo"], m["sha"], m["state"], m["reason"]) for m in listed] == [("fixture-mini", SHA1, "partial", SYNTHETIC["reason"])]
    assert set(listed[0]) >= {"repo", "sha", "schema", "state", "reason", "extractor", "generated_at", "receipt", "counts"}


def test_the_host_derives_inert_atoms_with_one_encoder_and_no_excerpts(client):
    load(client, SYNTHETIC)
    hive = client.app.state.hive
    stored = [r["atom"] for r in hive.db.all("SELECT atom FROM repo_map_atoms WHERE repo = 'fixture-mini' ORDER BY seq")]
    assert stored == repomap.atoms(SYNTHETIC)
    assert len(stored) == 1 + 6 + 5 + 5 + 5 + 1               # header, nodes, node refs, edges, edge refs, unresolved
    assert stored[0] == ('(repo-map "fixture-mini" "0000000000000000000000000000000000000001" partial '
                         '"omegacode.repository_facts" "fixture" "sha256:synthetic-fixture-not-a-real-digest")')
    assert '(repo-edge "e3" calls-expression "file:pkg/util.py" "def:pkg/core.py::add" syntax)' in stored
    assert '(repo-ref "e3" "pkg/util.py" 6)' in stored
    assert '(repo-unresolved "pkg/broken.py" "SyntaxError line 3")' in stored
    heads = {sexpr.parse(a)[0] for a in stored}                # every atom parses, with no variables
    assert heads == {"repo-map", "repo-node", "repo-ref", "repo-edge", "repo-unresolved"}
    excerpts = [r["excerpt"] for item in SYNTHETIC["nodes"] + SYNTHETIC["edges"] for r in item["refs"]]
    assert not any(e in a for e in excerpts if len(e) > 8 for a in stored)
    assert not any(word in a for a in stored for word in ("stv", "Grant", "Current"))


def test_code_extractor_fixture_census_partial_syntax_and_provenance(client):
    envelope = code_fixture_envelope()
    out = load(client, envelope).json()
    assert out["counts"] == {"nodes": 8, "edges": 5, "refs": 7, "unresolved": 1,
                             "nodes_by_kind": {"def": 2, "file": 4, "import": 2},
                             "edges_by_kind": {"calls-expression": 1, "defines": 2, "imports": 2},
                             "edges_by_basis": {"syntax": 5}}
    sha = envelope["sha"]
    files = client.get(f"/api/repo-maps/code-fixture/{sha}/nodes?kind=file").json()["nodes"]
    census = {n["label"]: n["source_digest"] for n in files}
    assert census == {p: f"sha256:{d}" for p, d in CODE_FIXTURE["sources"]}   # all four, the malformed one included
    head = client.get(f"/api/repo-maps/code-fixture/{sha}").json()
    assert head["state"] == "partial" and head["coverage"]["unresolved"] == [
        {"path": "pkg/broken.py", "issue": "source could not be parsed; syntax facts unavailable"}]
    assert head["snapshot_digest"] == "sha256:" + CODE_FIXTURE["snapshot_digest"] and head["extractor"]["parser"] == CODE_FIXTURE["parser"]
    # no syntax fact is invented for the file that did not parse
    broken = client.get(f"/api/repo-maps/code-fixture/{sha}/nodes/file:pkg/broken.py").json()
    assert broken["edges"] == [] and broken["nodes"] == []
    deps = q(client, sha, "potential-dependents", {"path": "pkg/math.py"}, repo="code-fixture").json()
    assert [(e["from"], e["kind"]) for e in deps["edges"]] == [("file:pkg/use.py", "imports")]
    calls = q(client, sha, "calls-expression", {"path": "pkg/use.py"}, repo="code-fixture").json()
    assert [e["to"] for e in calls["edges"]] == ["name:square"]   # a name, not a resolved definition
    assert ids(calls["nodes"]) == ["file:pkg/use.py"] and calls["basis_note"] == "call expressions by name; not resolved calls"


# ---- presets and reads ----------------------------------------------------------------------------------------------------

def test_every_preset_on_the_synthetic_fixture(client):
    load(client, SYNTHETIC)
    presets = client.get("/api/repo-maps/fixture-mini/presets").json()["presets"]
    assert [p["preset"] for p in presets] == ["imports", "potential-dependents", "defines", "calls-expression", "source-search",
                                             "test-doc-links", "drift"]
    assert all(p["basis_note"] and p["params"]["type"] == "object" for p in presets)
    r = q(client, SHA1, "imports", {"path": "pkg/util.py"}).json()
    assert ids(r["edges"]) == ["e1"] and set(ids(r["nodes"])) == {"file:pkg/util.py", "file:pkg/core.py"}
    r = q(client, SHA1, "potential-dependents", {"path": "pkg/core.py"}).json()
    assert [(n["id"], n["distance"]) for n in r["nodes"]] == [("file:pkg/util.py", 1)] and ids(r["edges"]) == ["e1"]
    assert "not runtime impact" in r["basis_note"]
    r = q(client, SHA1, "defines", {"node_id": "file:pkg/core.py"}).json()
    assert ids(r["edges"]) == ["e2"]
    r = q(client, SHA1, "calls-expression", {"path": "pkg/util.py"}).json()
    assert ids(r["edges"]) == ["e3"]
    r = q(client, SHA1, "source-search", {"q": "ADD"}).json()
    assert ids(r["nodes"]) == ["def:pkg/core.py::add", "file:pkg/util.py", "test:tests/test_core.py::test_add"] and r["edges"] == []
    r = q(client, SHA1, "source-search", {"q": "add", "kind": "def"}).json()
    assert ids(r["nodes"]) == ["def:pkg/core.py::add"]
    r = q(client, SHA1, "test-doc-links", {"node_id": "def:pkg/core.py::add"}).json()
    assert ids(r["edges"]) == ["e4", "e5"] and [e["basis"] for e in r["edges"]] == ["heuristic", "declared"]
    assert r["basis_note"] == TDL_NOTE
    r = q(client, SHA1, "test-doc-links", {"path": "nowhere.py"}).json()
    assert r["edges"] == [] and r["basis_note"] == TDL_NOTE        # always carries its note, even when empty
    r = q(client, SHA1, "drift", {"from": SHA1}).json()
    assert r["added"] == r["removed"] == r["changed"] == r["moved"] == []
    assert q(client, SHA1, "who-calls", {}).json()["error"]["code"] == "unknown_preset"
    assert q(client, SHA1, "imports", {}).status_code == 400
    assert q(client, SHA1, "imports", {"path": "a", "node_id": "b"}).status_code == 400
    assert q(client, SHA1, "imports", {"path": "a", "pattern": "(x)"}).status_code == 400
    assert q(client, SHA1, "imports", {"path": "pkg/util.py"}, limit=0).status_code == 400
    assert q(client, SHA1, "imports", {"path": "pkg/util.py"}, limit=201).status_code == 400


def test_nodes_and_node_reads(client):
    load(client, SYNTHETIC)
    base = f"/api/repo-maps/fixture-mini/{SHA1}"
    assert ids(client.get(f"{base}/nodes").json()["nodes"]) == ids(SYNTHETIC["nodes"])
    assert ids(client.get(f"{base}/nodes?kind=file").json()["nodes"]) == ["file:pkg/core.py", "file:pkg/util.py", "file:pkg/broken.py"]
    assert ids(client.get(f"{base}/nodes?path_prefix=pkg/").json()["nodes"]) == [
        "file:pkg/core.py", "def:pkg/core.py::add", "file:pkg/util.py", "file:pkg/broken.py"]
    assert client.get(f"{base}/nodes?kind=class").status_code == 400
    one = client.get(f"{base}/nodes/def:pkg/core.py::add").json()
    assert one["node"]["label"] == "add" and ids(one["edges"]) == ["e2", "e3", "e4", "e5"]
    assert set(ids(one["nodes"])) == {"file:pkg/core.py", "file:pkg/util.py", "test:tests/test_core.py::test_add", "doc:docs/core.md"}
    assert client.get(f"{base}/nodes/def:nope").json()["error"]["code"] == "not_found"


def revision_two():
    """SHA2 from the synthetic map: util.py renamed with the same bytes (a move), core.py edited (its def changes with it),
    two new files with identical bytes (ambiguous: added, not moved) and the doc replaced by two identical docs (ambiguous)."""
    env = copy.deepcopy(SYNTHETIC)
    env["sha"] = SHA2
    for node in env["nodes"]:
        if node["id"] == "file:pkg/util.py":
            node.update(id="file:pkg/helpers.py", label="pkg/helpers.py", refs=[{"path": "pkg/helpers.py", "line": 1}])
        if node["source_digest"] == "sha256:a1":
            node["source_digest"] = "sha256:a9"
    env["nodes"] = [n for n in env["nodes"] if n["id"] != "doc:docs/core.md"] + [
        {"id": f"file:pkg/{name}.py", "kind": "file", "label": f"pkg/{name}.py", "source_digest": "sha256:f6", "refs": []}
        for name in ("new", "copy")] + [
        {"id": f"doc:docs/{name}.md", "kind": "doc", "label": f"docs/{name}.md", "source_digest": "sha256:e5", "refs": []}
        for name in ("guide", "guide2")]
    env["edges"] = [dict(e, **{"from": "file:pkg/helpers.py"}) if e["from"] == "file:pkg/util.py" else e
                    for e in env["edges"] if e["from"] != "doc:docs/core.md"]
    return env


def test_drift_between_two_revisions_moves_only_on_explicit_evidence(client):
    load(client, SYNTHETIC)
    assert load(client, revision_two()).status_code == 200
    r = client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA1}&to={SHA2}").json()
    assert [(m["from"]["id"], m["to"]["id"], m["basis"]) for m in r["moved"]] == [
        ("file:pkg/util.py", "file:pkg/helpers.py", "unique source_digest match")]
    assert sorted(a["node"]["id"] for a in r["added"]) == ["doc:docs/guide.md", "doc:docs/guide2.md", "file:pkg/copy.py", "file:pkg/new.py"]
    assert [x["node"]["id"] for x in r["removed"]] == ["doc:docs/core.md"]           # identical content twice: no move
    assert [(x["id"], x["basis"]) for x in r["changed"]] == [("file:pkg/core.py", "source_digest changed"),
                                                             ("def:pkg/core.py::add", "source_digest changed")]
    assert all(x["basis"] for group in ("added", "removed", "changed", "moved") for x in r[group])
    assert r["truncated"] is False and r["next_cursor"] is None and r["state"] == "ready"
    via_preset = q(client, SHA2, "drift", {"from": SHA1}).json()
    assert {k: via_preset[k] for k in ("added", "removed", "changed", "moved")} == {k: r[k] for k in ("added", "removed", "changed", "moved")}
    paged = client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA1}&to={SHA2}&limit=3").json()
    assert paged["truncated"] is True and sum(len(paged[g]) for g in ("added", "removed", "changed", "moved")) == 3
    assert client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA1}").status_code == 400


def test_a_query_past_the_time_bound_answers_partial(client, monkeypatch):
    load(client, SYNTHETIC)
    monkeypatch.setattr(repomap, "TIME_BOUND", -1)
    r = q(client, SHA1, "imports", {"path": "pkg/util.py"}).json()
    assert (r["state"], r["reason"]) == ("partial", "time_bound")
    load(client, revision_two())
    d = client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA1}&to={SHA2}").json()
    assert (d["state"], d["reason"]) == ("partial", "time_bound") and d["moved"] == []


# ---- visibility ------------------------------------------------------------------------------------------------------------

def test_maps_a_caller_cannot_see_answer_404_like_unknown_ones(client):
    hive = client.app.state.hive
    sw_a, mind_a, _ = mind(client, "Alpha")
    _, mind_b, _ = mind(client, "Beta")
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    hive.db.execute("UPDATE swarms SET visibility = 'shared', shared_with = ? WHERE id = ?", (json.dumps(["user:u_ann"]), sw_a["id"]))
    private = dict(copy.deepcopy(SYNTHETIC), repo="fixture-private")
    assert load(client, private, visibility=f"swarm:{sw_a['id']}").status_code == 200
    assert load(client, SYNTHETIC).status_code == 200                                     # visibility hive (the default)
    assert load(client, dict(SYNTHETIC, repo="x", sha="abcdef1"), visibility="swarm:s_none").status_code == 400
    base = f"/api/repo-maps/fixture-private/{SHA1}"
    reads = [("GET", base), ("GET", f"{base}/nodes"), ("GET", f"{base}/nodes/file:pkg/core.py"),
             ("GET", "/api/repo-maps/fixture-private/presets"), ("GET", f"/api/repo-maps/fixture-private/drift?from={SHA1}&to={SHA1}"),
             ("POST", f"{base}/query")]
    unknown = client.get(f"/api/repo-maps/fixture-nope/{SHA1}", headers=bob).json()
    for who, allowed in ((mind_a, True), (ann, True), (client.headers, True), (mind_b, False), (bob, False)):
        listed = {m["repo"] for m in client.get("/api/repo-maps", headers=who).json()}
        assert ("fixture-private" in listed) is allowed and "fixture-mini" in listed
        for method, path in reads:
            r = client.request(method, path, headers=who, json={"preset": "imports", "params": {"path": "pkg/util.py"}} if method == "POST" else None)
            if allowed:
                assert r.status_code == 200, (path, r.text)
            else:
                assert r.status_code == 404 and r.json() == unknown, (path, r.text)       # indistinguishable from unknown
        assert client.get(f"/api/repo-maps/fixture-mini/{SHA1}", headers=who).status_code == 200
    assert client.get("/api/repo-maps", headers={"Authorization": ""}).status_code == 401


# ---- cursors and truncation ------------------------------------------------------------------------------------------------

def test_cursors_are_bound_to_principal_repo_sha_preset_and_params_and_expire(client, monkeypatch):
    load(client, SYNTHETIC)
    load(client, revision_two())
    ann = person(client, "u_ann")
    base = f"/api/repo-maps/fixture-mini/{SHA1}"
    seen, cursor = [], None
    while True:
        page = client.get(f"{base}/nodes?limit=2" + (f"&cursor={cursor}" if cursor else "")).json()
        seen += ids(page["nodes"])
        if not page["next_cursor"]:
            assert page["truncated"] is False
            break
        assert page["truncated"] is True and len(page["nodes"]) == 2
        cursor = page["next_cursor"]
    assert seen == ids(SYNTHETIC["nodes"])                                               # every node once, in order
    first = client.get(f"{base}/nodes?limit=2").json()["next_cursor"]
    mismatches = [client.get(f"{base}/nodes?limit=2&cursor={first}", headers=ann),         # another principal
                  client.get(f"{base}/nodes?kind=file&cursor={first}"),                   # other params
                  client.get(f"/api/repo-maps/fixture-mini/{SHA2}/nodes?cursor={first}"),  # another revision
                  q(client, SHA1, "source-search", {"q": "p"}, cursor=first),              # another preset
                  client.get(f"{base}/nodes?cursor={first[:-1]}{'0' if first[-1] != '0' else '1'}"),   # tampered
                  client.get(f"{base}/nodes?cursor=not-a-cursor")]
    for r in mismatches:
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_cursor", r.text
    assert client.get(f"{base}/nodes?limit=5&cursor={first}").status_code == 200        # the limit may change between pages
    qc = q(client, SHA1, "source-search", {"q": "p"}, limit=1).json()["next_cursor"]
    assert q(client, SHA1, "source-search", {"q": "pk"}, cursor=qc).json()["error"]["code"] == "invalid_cursor"
    assert q(client, SHA1, "source-search", {"q": "p"}, cursor=qc).status_code == 200
    monkeypatch.setattr(repomap, "CURSOR_SECONDS", -1)                                   # every cursor is now over an hour old
    r = client.get(f"{base}/nodes?limit=2&cursor={first}")
    assert r.status_code == 410 and r.json()["error"]["code"] == "cursor_expired"


def big_map(n=60):
    nodes = [{"id": f"file:big/f{i:03}.py", "kind": "file", "label": f"big/f{i:03}.py", "source_digest": f"sha256:{i}",
              "refs": [{"path": f"big/f{i:03}.py", "line": k, "excerpt": "x" * repomap.EXCERPT_MAX} for k in range(repomap.MAX_REFS)]}
             for i in range(n)]
    return dict(copy.deepcopy(SYNTHETIC), repo="fixture-big", sha="b16b16b", state="ready", reason=None,
                coverage={"unresolved": []}, nodes=nodes, edges=[])


def test_pages_stop_at_256_kib_and_continue_by_cursor(client):
    assert load(client, big_map()).status_code == 200
    seen, cursor, pages = [], None, 0
    while True:
        r = client.get("/api/repo-maps/fixture-big/b16b16b/nodes?limit=200" + (f"&cursor={cursor}" if cursor else ""))
        assert len(r.content) <= repomap.RESPONSE_CAP
        page = r.json()
        seen += ids(page["nodes"])
        pages += 1
        if not page["next_cursor"]:
            break
        assert page["truncated"] is True and len(page["nodes"]) < 200
        cursor = page["next_cursor"]
    assert pages > 1 and seen == [f"file:big/f{i:03}.py" for i in range(60)]


# ---- loading: admin only, idempotent, 409, 413, 422, retention -------------------------------------------------------------

def test_only_an_admin_loads_and_minds_have_no_write_path(client):
    _, mind_a, agent = mind(client, "Alpha")
    member = person(client, "u_mem")
    r = load(client, SYNTHETIC, headers=member)
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
    assert load(client, SYNTHETIC, headers=mind_a).status_code == 401                    # a mind token is not a session
    assert load(client, SYNTHETIC, headers={"Authorization": ""}).status_code == 401
    assert client.get("/api/repo-maps").json() == []
    assert load(client, SYNTHETIC).status_code == 200
    hive = client.app.state.hive
    before = [hive.db.one(f"SELECT COUNT(*) n FROM {t}")["n"] for t in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms")]
    assert client.get(f"/api/repo-maps/fixture-mini/{SHA1}", headers=mind_a).status_code == 200   # minds read as themselves
    assert q(client, SHA1, "imports", {"path": "pkg/util.py"}, headers=mind_a).status_code == 200
    for method in ("POST", "PUT", "PATCH", "DELETE"):                                      # no other write route
        assert client.request(method, f"/api/repo-maps/fixture-mini/{SHA1}", headers=mind_a, json=SYNTHETIC).status_code in (404, 405)
        assert client.request(method, "/api/repo-maps", headers=member, json=SYNTHETIC).status_code in (404, 405)
    after = [hive.db.one(f"SELECT COUNT(*) n FROM {t}")["n"] for t in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms")]
    assert before == after
    views = mcp.TOOL_INDEX["hive_repo_query"]["inputSchema"]["properties"]["view"]["enum"]
    assert set(views) == {"maps", "map", "presets", "nodes", "node", "query", "drift"}     # reads only
    hive.policy.add_rule(f"agent:{agent['id']}", "repo-query", "deny", "synthetic")
    r = client.get("/api/repo-maps", headers=mind_a)
    assert r.status_code == 403 and r.json()["error"]["code"] == "policy_denied"


def test_load_is_idempotent_and_never_changes_a_revision_in_place(client, monkeypatch):
    first = load(client, SYNTHETIC).json()
    again = load(client, SYNTHETIC)
    assert again.status_code == 200 and {k: v for k, v in again.json().items() if k != "space"} == {
        k: v for k, v in dict(first, unchanged=True).items() if k != "space"}
    edited = copy.deepcopy(SYNTHETIC)
    edited["nodes"][1]["label"] = "add_two"
    r = load(client, edited)
    assert r.status_code == 409 and r.json()["error"]["code"] == "map_exists"
    assert client.get(f"/api/repo-maps/fixture-mini/{SHA1}/nodes/def:pkg/core.py::add").json()["node"]["label"] == "add"
    r = load(client, dict(SYNTHETIC, schema="repo-map/2"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "schema_unsupported"
    for bad in (dict(SYNTHETIC, extra=1), dict(SYNTHETIC, state="green"), dict(SYNTHETIC, truncated=True),
                dict(SYNTHETIC, sha="NOT-HEX"), dict(SYNTHETIC, nodes=SYNTHETIC["nodes"] + [SYNTHETIC["nodes"][0]]),
                dict(SYNTHETIC, nodes=[dict(SYNTHETIC["nodes"][0], refs=[{"path": "../etc/passwd", "line": 1}])], edges=[]),
                dict(SYNTHETIC, edges=[dict(SYNTHETIC["edges"][0], basis="runtime")]),
                dict(SYNTHETIC, edges=[dict(SYNTHETIC["edges"][0], **{"from": "file:missing.py"})])):
        r = load(client, dict(bad, repo="fixture-bad"))
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request", r.text
    monkeypatch.setattr(repomap, "MAX_NODES", 5)
    r = load(client, dict(SYNTHETIC, repo="fixture-many"))
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    monkeypatch.setattr(repomap, "MAX_BODY", 1024)
    r = load(client, dict(SYNTHETIC, repo="fixture-huge"))
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    assert {m["repo"] for m in client.get("/api/repo-maps").json()} == {"fixture-mini"}


def test_retention_keeps_the_last_five_revisions_plus_pinned(client):
    hive = client.app.state.hive
    shas = [f"{i:040x}" for i in range(1, 8)]
    for i, sha in enumerate(shas):
        assert load(client, dict(SYNTHETIC, sha=sha), **({"pinned": "true"} if i == 0 else {})).status_code == 200
    kept = {m["sha"] for m in client.get("/api/repo-maps").json()}
    assert kept == {shas[0]} | set(shas[2:])
    assert hive.db.one("SELECT COUNT(*) n FROM repo_map_nodes WHERE sha = ?", (shas[1],))["n"] == 0
    assert hive.db.one("SELECT COUNT(*) n FROM repo_map_atoms WHERE sha = ?", (shas[1],))["n"] == 0


# ---- minds: the MCP tool and the repo-query skill call the same engine ------------------------------------------------------

def _call(c, code, args):
    from hive.tests.test_mcp_api import rpc
    body = rpc(c, code, "tools/call", {"name": "hive_repo_query", "arguments": args}, path="/mcp").json()
    return (None, body["error"]["data"]) if "error" in body else (body["result"]["structuredContent"], None)


def test_mcp_hive_repo_query_reads_as_the_member(client):
    load(client, SYNTHETIC)
    load(client, revision_two())
    sw = client.post("/api/swarms", json={"name": "MCP repo"}).json()
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    load(client, dict(SYNTHETIC, repo="fixture-private"), visibility=f"swarm:{other['id']}")
    code = client.post("/api/harness-invites", json={"harness": "mcp", "name": "Mapper", "swarm_id": sw["id"]}).json()["code"]
    from hive.tests.test_mcp_api import rpc
    assert "hive_repo_query" in [t["name"] for t in rpc(client, code, "tools/list", path="/mcp").json()["result"]["tools"]]
    out, err = _call(client, code, {"view": "maps"})
    assert err is None and {m["repo"] for m in out["maps"]} == {"fixture-mini"}
    out, _ = _call(client, code, {"view": "query", "repo": "fixture-mini", "sha": SHA1, "preset": "test-doc-links",
                                  "params": {"node_id": "def:pkg/core.py::add"}})
    assert ids(out["edges"]) == ["e4", "e5"] and out["basis_note"] == TDL_NOTE
    http = q(client, SHA1, "test-doc-links", {"node_id": "def:pkg/core.py::add"}).json()
    assert {k: out[k] for k in ("nodes", "edges", "basis_note")} == {k: http[k] for k in ("nodes", "edges", "basis_note")}
    out, _ = _call(client, code, {"view": "drift", "repo": "fixture-mini", "from": SHA1, "to": SHA2})
    assert [m["to"]["id"] for m in out["moved"]] == ["file:pkg/helpers.py"]
    out, _ = _call(client, code, {"view": "nodes", "repo": "fixture-mini", "sha": SHA1, "limit": 2})
    nxt, _ = _call(client, code, {"view": "nodes", "repo": "fixture-mini", "sha": SHA1, "limit": 2, "cursor": out["next_cursor"]})
    assert ids(nxt["nodes"]) == ids(SYNTHETIC["nodes"])[2:4]
    _, err = _call(client, code, {"view": "map", "repo": "fixture-private", "sha": SHA1})
    assert (err["code"], err["http_status"]) == ("not_found", 404)
    _, err = _call(client, code, {"view": "load", "repo": "fixture-mini"})
    assert err["code"] == "bad_request"
    _, err = _call(client, code, {"view": "query", "repo": "fixture-mini", "sha": SHA1})
    assert err["code"] == "bad_request"
    member = client.app.state.hive.db.one("SELECT id FROM agents WHERE name = 'Mapper'")
    client.app.state.hive.policy.add_rule(f"agent:{member['id']}", "repo-query", "deny", "synthetic")
    _, err = _call(client, code, {"view": "maps"})
    assert err["code"] == "policy_denied"


def test_repo_query_skill_calls_the_same_routes_as_the_mind(client, monkeypatch):
    load(client, SYNTHETIC)
    _, mind_a, _ = mind(client, "Skill")
    spec = importlib.util.spec_from_file_location("hive_commons_repo", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)
    calls = []

    def through_the_app(method, path, payload=None):
        calls.append((method, path.split("?")[0]))
        r = client.request(method, path, json=payload, headers=mind_a)
        if r.status_code >= 400:
            return None, f"HIVE-ERROR {r.json()['error']['code']}: {r.json()['error']['message']}"
        return r.json(), None

    monkeypatch.setattr(hc, "_call", through_the_app)
    out = hc.repo_query(json.dumps({"view": "query", "repo": "fixture-mini", "sha": SHA1, "preset": "defines",
                                    "params": {"path": "pkg/core.py"}}))
    assert out.startswith("HIVE-REPO ") and ids(json.loads(out[10:])["edges"]) == ["e2"]
    assert hc.repo_query('{"view": "maps"}').startswith("HIVE-REPO [")
    out = hc.repo_query(json.dumps({"view": "node", "repo": "fixture-mini", "sha": SHA1, "node_id": "def:pkg/core.py::add"}))
    assert json.loads(out[10:])["node"]["id"] == "def:pkg/core.py::add"
    for view, extra in (("map", {}), ("presets", {}), ("nodes", {"kind": "file"}), ("drift", {"from": SHA1, "to": SHA1})):
        assert hc.repo_query(json.dumps({"view": view, "repo": "fixture-mini", "sha": SHA1, **extra})).startswith("HIVE-REPO "), view
    assert hc.repo_query('{"view": "map", "repo": "fixture-mini", "sha": "abcdef1"}').startswith("HIVE-ERROR not_found")
    assert hc.repo_query('{"view": "load"}').startswith("HIVE-ERROR bad_request")
    assert all(m == "GET" or p.endswith("/query") for m, p in calls)                       # reads only; never the loader
    assert not any("/admin/" in p for _, p in calls)
    assert "repo_query" in hc.SKILLS
    for path, needle in (("modules/hive/skills.metta", "(= (repo-query $request)"), ("modules/hive/signatures.metta", "(SkillSignature repo-query"),
                         ("modules/hive/entry.metta", "(Skill repo-query)"), ("modules/hive/module.toml", '"skill:repo-query"'),
                         ("modules/hive/catalog.metta", '(SkillHelp "repo-query"')):
        assert needle in (ROOT / path).read_text(), path


# ---- r1.1: revision state apart from operation state; transitive dependents; the read-only space ----------------------------

def test_reads_of_a_partial_map_carry_its_revision_state_apart_from_the_operation_state(client, monkeypatch):
    load(client, SYNTHETIC)
    load(client, revision_two())
    base = f"/api/repo-maps/fixture-mini/{SHA1}"
    reads = [client.get(f"{base}/nodes").json(), client.get(f"{base}/nodes/def:pkg/core.py::add").json(),
             q(client, SHA1, "defines", {"path": "pkg/core.py"}).json(), q(client, SHA1, "potential-dependents", {"path": "pkg/core.py"}).json(),
             q(client, SHA1, "source-search", {"q": "add"}).json(), client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA2}&to={SHA1}").json()]
    for r in reads:
        assert (r["state"], r["reason"]) == ("ready", None)                                  # the read itself completed
        assert (r["revision_state"], r["revision_reason"]) == ("partial", SYNTHETIC["reason"])   # the source did not
    head = client.get(base).json()
    assert (head["revision_state"], head["revision_reason"]) == ("partial", SYNTHETIC["reason"]) == (head["state"], head["reason"])
    assert all(m["revision_state"] == "partial" for m in client.get("/api/repo-maps").json())
    drift = reads[-1]
    assert (drift["from_revision_state"], drift["from_revision_reason"]) == ("partial", SYNTHETIC["reason"])
    monkeypatch.setattr(repomap, "TIME_BOUND", -1)
    late = q(client, SHA1, "potential-dependents", {"path": "pkg/core.py"}).json()
    assert (late["state"], late["reason"], late["revision_state"]) == ("partial", "time_bound", "partial")


def chain_map(cycle=False):
    """A <- B <- C (B imports A, C imports B), plus D calling A by expression; cycle=True adds A importing C."""
    files = ["a", "b", "c", "d"]
    nodes = [{"id": f"file:{f}.py", "kind": "file", "label": f"{f}.py", "source_digest": f"sha256:{f}", "refs": []} for f in files]
    edges = [{"id": "ba", "kind": "imports", "from": "file:b.py", "to": "file:a.py", "basis": "syntax", "refs": []},
             {"id": "cb", "kind": "imports", "from": "file:c.py", "to": "file:b.py", "basis": "syntax", "refs": []},
             {"id": "da", "kind": "calls-expression", "from": "file:d.py", "to": "file:a.py", "basis": "syntax", "refs": []}]
    if cycle:
        edges.append({"id": "ac", "kind": "imports", "from": "file:a.py", "to": "file:c.py", "basis": "syntax", "refs": []})
    return dict(copy.deepcopy(SYNTHETIC), repo="fixture-chain", sha="c4a10000" if not cycle else "c4a1c1c1", state="ready", reason=None,
                coverage={"unresolved": []}, nodes=nodes, edges=edges)


def test_potential_dependents_is_the_transitive_closure_with_distances(client):
    for cycle in (False, True):
        env = chain_map(cycle)
        assert load(client, env).status_code == 200
        r = q(client, env["sha"], "potential-dependents", {"path": "a.py"}, repo="fixture-chain").json()
        assert [(n["id"], n["distance"]) for n in r["nodes"]] == [("file:b.py", 1), ("file:d.py", 1), ("file:c.py", 2)]
        assert ids(r["edges"]) == ["ba", "da", "cb"]                       # the edge that reached each dependent
        direct = q(client, env["sha"], "potential-dependents", {"path": "a.py", "max_depth": "1"}, repo="fixture-chain").json()
        assert [(n["id"], n["distance"]) for n in direct["nodes"]] == [("file:b.py", 1), ("file:d.py", 1)]
        first = q(client, env["sha"], "potential-dependents", {"path": "a.py"}, repo="fixture-chain", limit=2).json()
        rest = q(client, env["sha"], "potential-dependents", {"path": "a.py"}, repo="fixture-chain", cursor=first["next_cursor"]).json()
        assert first["truncated"] is True and ids(first["nodes"]) + ids(rest["nodes"]) == ids(r["nodes"])
        assert q(client, env["sha"], "potential-dependents", {"path": "a.py", "max_depth": "1"}, repo="fixture-chain",
                 cursor=first["next_cursor"]).json()["error"]["code"] == "invalid_cursor"
    for bad in ("0", "x", "-1"):
        assert q(client, "c4a10000", "potential-dependents", {"path": "a.py", "max_depth": bad}, repo="fixture-chain").status_code == 400


def test_each_revision_is_a_read_only_space_written_only_by_the_loader(client):
    hive = client.app.state.hive
    out = load(client, SYNTHETIC).json()
    space_id, handle = hive.spaces.repo_space("fixture-mini", SHA1)
    assert out["space"]["id"] == f"repo:fixture-mini@{SHA1}" and out["space"]["status"] in ("queued", "mounting", "mounted")
    mounted(client, "fixture-mini", SHA1, 23)
    assert space_id == f"repo:fixture-mini@{SHA1}" and handle.startswith("&repo_") and len(handle) == len("&repo_") + 24
    assert client.get(f"/api/repo-maps/fixture-mini/{SHA1}").json()["space"] == mounted(client, "fixture-mini", SHA1, 23)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 23
    assert hive.spaces.repo_match("fixture-mini", SHA1, "(repo-edge $id calls-expression $from $to $basis)") == [
        '(repo-edge "e3" calls-expression "file:pkg/util.py" "def:pkg/core.py::add" syntax)']
    assert sorted(hive.spaces.repo_match("fixture-mini", SHA1, "(repo-unresolved $p $i)")) == ['(repo-unresolved "pkg/broken.py" "SyntaxError line 3")']
    # idempotent load keeps the space; a lost space is mounted again from the database, as after a restart
    hive.spaces.unmount_repo("fixture-mini", SHA1)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 0
    fresh = repomap.RepoMaps(hive)
    import time as _t
    for _ in range(200):
        if fresh.space("fixture-mini", SHA1)["status"] == "mounted":
            break
        _t.sleep(0.05)
    assert fresh.space("fixture-mini", SHA1)["atoms"] == 23 and hive.spaces.repo_count("fixture-mini", SHA1) == 23
    # retention takes the space with the rows
    for i in range(2, 8):
        load(client, dict(SYNTHETIC, sha=f"{i:040x}"))
    mounted(client, "fixture-mini", f"{7:040x}", 23)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 0 and hive.spaces.repo_count("fixture-mini", f"{7:040x}") == 23
    # nothing else writes it: the commons write paths name &commons_/&vocab_/&hive_acl only, and an atom with a variable
    # or a line break never reaches the interpreter
    import pytest
    from hive.spaces import sexpr as _sx
    with pytest.raises(_sx.SexprError):
        hive.spaces.mount_repo("fixture-x", "abcdef1", ["(repo-node $x file \"l\" \"d\")"])
    bad = copy.deepcopy(SYNTHETIC)
    bad["nodes"][1]["label"] = "add\n!(remove-atom &hive_acl $x)"
    assert load(client, dict(bad, repo="fixture-newline")).status_code == 400


# ---- r1.2: every response within the byte cap as sent; refusal, never a cut ---------------------------------------------

def unicode_bound_map(n_nodes=2):
    """Code's boundary case (HOST_RESPONSE_BOUND_e4008ac_R2): nodes and one imports edge, each with MAX_REFS refs whose path is
    511 allowed CJK characters and whose excerpt is EXCERPT_MAX four-byte characters. Valid; about 90 KB per item as sent."""
    refs = [{"path": "源" * 508 + ".py", "line": i + 1, "excerpt": "🔬" * repomap.EXCERPT_MAX} for i in range(repomap.MAX_REFS)]
    nodes = [{"id": f"file:{i}.py", "kind": "file", "label": f"{i}.py", "source_digest": "sha256:" + "a" * 64,
              "refs": copy.deepcopy(refs)} for i in range(n_nodes)]
    return dict(copy.deepcopy(SYNTHETIC), repo="valid-unicode-bound", sha="b" * 40, state="ready", reason=None,
                coverage={"unresolved": []}, nodes=nodes,
                edges=[{"id": "import-1", "kind": "imports", "from": nodes[0]["id"], "to": nodes[1]["id"], "basis": "syntax",
                        "refs": copy.deepcopy(refs)}])


def test_oversized_results_are_refused_and_every_response_fits_as_sent(client):
    env = unicode_bound_map(3)
    assert load(client, env).status_code == 200
    base = f"/api/repo-maps/valid-unicode-bound/{'b' * 40}"
    # an edge with both of its nodes (~270 KB) cannot be sent whole: refused, never cut or skipped
    r = q(client, "b" * 40, "imports", {"node_id": "file:0.py"}, repo="valid-unicode-bound", limit=1)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    # node detail: the base node counts; its one edge plus the neighbour no longer fit beside it
    r = client.get(f"{base}/nodes/file:0.py?limit=1")
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    # a node with no edges still reads, whole
    r = client.get(f"{base}/nodes/file:2.py")
    assert r.status_code == 200 and len(r.content) <= repomap.RESPONSE_CAP and r.json()["node"] == env["nodes"][2]
    # the nodes page splits between units, with every ref intact, and each page fits in the bytes actually sent
    seen, cursor = [], None
    while True:
        r = client.get(f"{base}/nodes?limit=200" + (f"&cursor={cursor}" if cursor else ""))
        assert r.status_code == 200 and len(r.content) <= repomap.RESPONSE_CAP
        assert len(r.content) == repomap._size(r.json())        # _size is exactly the JSONResponse encoding
        seen += r.json()["nodes"]
        cursor = r.json()["next_cursor"]
        if not cursor:
            break
        assert r.json()["truncated"] is True and r.json()["nodes"]   # a cursor always advances past what was sent
    assert seen == env["nodes"]


def test_pages_near_the_cap_count_multibyte_text_exactly(client):
    nodes = [{"id": f"file:u/{i:03}.py", "kind": "file", "label": f"u/{i:03}.py", "source_digest": f"sha256:{i}",
              "refs": [{"path": f"u/{i:03}.py", "line": k, "excerpt": ("é\"🔬" * 333)[:repomap.EXCERPT_MAX]} for k in range(repomap.MAX_REFS)]}
             for i in range(40)]
    env = dict(copy.deepcopy(SYNTHETIC), repo="fixture-mb", sha="abcabc1", state="ready", reason=None,
               coverage={"unresolved": []}, nodes=nodes, edges=[])
    assert load(client, env).status_code == 200
    seen, cursor, sizes = [], None, []
    while True:
        r = client.get("/api/repo-maps/fixture-mb/abcabc1/nodes?limit=200" + (f"&cursor={cursor}" if cursor else ""))
        sizes.append(len(r.content))
        seen += r.json()["nodes"]
        cursor = r.json()["next_cursor"]
        if not cursor:
            break
    assert max(sizes) <= repomap.RESPONSE_CAP and max(sizes) > repomap.RESPONSE_CAP - 70_000 and len(sizes) > 2
    assert seen == nodes


def test_a_coverage_too_big_for_the_header_is_refused_at_load(client):
    env = dict(copy.deepcopy(SYNTHETIC), repo="fixture-cov",
               coverage={"unresolved": [], "notes": ["x" * 1000] * (repomap.COVERAGE_MAX // 1000 + 1)})
    r = load(client, env)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


# ---- r1.2: mount sequencing, cleanup and the incomplete state ------------------------------------------------------------

class _FakeInterpreter:
    """Stands in for the PeTTa worker at the job boundary: records each job, can fail or block a chosen one. Source-level
    evidence for the sequencing and cleanup paths, not native atom semantics."""

    def __init__(self):
        import threading
        self.jobs, self.atoms, self.fail, self.block, self.lock = [], {}, {}, {}, threading.Lock()
        self.reply = {}   # (kind, n) -> a raw reply to return instead

    def run(self, code, timeout=30):
        kind = "add" if "add-atom" in code else "clear" if "remove-atom" in code else "count" if "length" in code else "other"
        with self.lock:
            n = sum(1 for j in self.jobs if j[0] == kind) + 1
            self.jobs.append((kind, n, timeout))
        if (kind, n) in self.block:
            self.block[(kind, n)].wait(10)
        if (kind, n) in self.fail:
            raise self.fail[(kind, n)]
        handle = code.split("&repo_")[1].split()[0] if "&repo_" in code else None
        with self.lock:
            if kind == "add":
                self.atoms[handle] = self.atoms.get(handle, 0) + code.count("add-atom")
            elif kind == "clear":
                removed, self.atoms[handle] = self.atoms.get(handle, 0), 0
                return [str(removed)]
            elif kind == "count":
                return [self.reply.get((kind, n), str(self.atoms.get(handle, 0)))]
        return ["()"]


def _fake_service(interp):
    from hive.spaces.service import SpaceService
    svc = SpaceService.__new__(SpaceService)
    svc._interp = interp
    return svc


ATOMS_2001 = [f'(repo-node "n{i}" file "l" "d")' for i in range(2001)]


def test_mount_validates_before_clearing_and_clears_after_a_failed_batch():
    import pytest
    from hive.spaces import service as sv
    interp = _FakeInterpreter()
    svc = _fake_service(interp)
    with pytest.raises(sexpr.SexprError):
        svc.mount_repo("r", "abcdef1", ATOMS_2001[:5] + ["(repo-node $x file \"l\" \"d\")"])
    assert interp.jobs == []                                                  # nothing cleared for an invalid atom list
    assert svc.mount_repo("r", "abcdef1", ATOMS_2001) == 2001
    assert [j[0] for j in interp.jobs] == ["clear", "count", "add", "add", "count"]
    # Code's witness: 2001 atoms, the second batch fails -> the prefix is cleared before the error propagates
    interp = _FakeInterpreter()
    svc = _fake_service(interp)
    interp.fail[("add", 2)] = RuntimeError("second batch")
    with pytest.raises(RuntimeError, match="second batch"):
        svc.mount_repo("r", "abcdef1", ATOMS_2001)
    assert [j[0] for j in interp.jobs] == ["clear", "count", "add", "add", "clear", "count"] and set(interp.atoms.values()) == {0}
    assert interp.jobs[-1][2] == interp.jobs[-2][2] == sv.REPO_SETTLE_SECONDS                       # cleanup waits for the queue to settle
    # a count that disagrees is a failure too: cleared, then raised
    interp = _FakeInterpreter()
    svc = _fake_service(interp)
    real = interp.run
    interp.reply[("count", 2)] = "5"                                         # the count after the adds
    with pytest.raises(sv.SpaceError, match="holds 5 atoms"):
        svc.mount_repo("r", "abcdef1", ATOMS_2001)
    assert interp.jobs[-2][0] == "clear" and set(interp.atoms.values()) == {0}


def test_counts_and_clears_must_answer_a_typed_non_negative_integer():
    import pytest
    from hive.spaces import service as sv
    for bad in ("()", "", "1.75", '"1"', "-1", "(1)", "abc", "("):
        interp = _FakeInterpreter()
        svc = _fake_service(interp)
        interp.reply[("count", 1)] = bad
        with pytest.raises(sv.SpaceError):
            svc.repo_count("r", "abcdef1")
    for good, value in (("0", 0), ("1", 1), ("74674", 74674)):
        interp = _FakeInterpreter()
        interp.reply[("count", 1)] = good
        assert _fake_service(interp).repo_count("r", "abcdef1") == value
    # a clear whose follow-up count is malformed, or not zero, is not a finished clear: incomplete, never failed/atoms 0
    for bad in ("()", "3"):
        interp = _FakeInterpreter()
        interp.reply[("count", 1)] = bad
        with pytest.raises(sv.RepoMountIncomplete):
            _fake_service(interp).unmount_repo("r", "abcdef1")


def test_a_cleanup_that_does_not_finish_is_reported_incomplete():
    import concurrent.futures
    import pytest
    from hive.spaces import service as sv
    interp = _FakeInterpreter()
    svc = _fake_service(interp)
    interp.fail[("add", 2)] = concurrent.futures.TimeoutError()               # the job timed out (it may still run)
    interp.fail[("clear", 2)] = concurrent.futures.TimeoutError()             # and the cleanup behind it did not settle
    with pytest.raises(sv.RepoMountIncomplete):
        svc.mount_repo("r", "abcdef1", ATOMS_2001)
    interp.fail[("clear", 3)] = RuntimeError("clear failed")
    with pytest.raises(sv.RepoMountIncomplete):
        svc.unmount_repo("r", "abcdef1")


def test_same_revision_mounts_never_interleave_and_commons_calls_pass_between_chunks():
    import threading
    interp = _FakeInterpreter()
    one, two = _fake_service(interp), _fake_service(interp)                 # two service instances, one interpreter
    gate = threading.Event()
    interp.block[("add", 1)] = gate                                          # the first mount stalls inside its first chunk
    first = threading.Thread(target=one.mount_repo, args=("r", "abcdef1", ATOMS_2001))
    second = threading.Thread(target=two.mount_repo, args=("r", "abcdef1", ATOMS_2001))
    first.start()
    while not interp.jobs:
        pass
    second.start()
    assert one.beliefs("s_commons") == []                                    # a commons read is not held by the repo lock
    assert two.query(["s_commons"], "(Current $s $t $st)") == []
    gate.set()
    first.join(10)
    second.join(10)
    repo_jobs = [j[0] for j in interp.jobs if j[0] != "other"]
    assert repo_jobs == ["clear", "count", "add", "add", "count"] * 2                 # each sequence whole, one after the other
    assert list(interp.atoms.values()) == [2001]


def test_repo_maps_reports_failed_and_incomplete_and_retries(client, monkeypatch):
    from hive.spaces.service import RepoMountIncomplete
    hive = client.app.state.hive
    load(client, SYNTHETIC)
    mounted(client, "fixture-mini", SHA1, 23)
    real = hive.spaces.mount_repo
    monkeypatch.setattr(hive.spaces, "mount_repo", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    assert hive.repo_maps._mount("fixture-mini", SHA1) == {"id": f"repo:fixture-mini@{SHA1}", "kind": "read-only",
                                                           "status": "failed", "atoms": 0, "reason": "mount failed; the space was cleared"}
    monkeypatch.setattr(hive.spaces, "mount_repo", lambda *a: (_ for _ in ()).throw(RepoMountIncomplete("held")))
    state = hive.repo_maps._mount("fixture-mini", SHA1)
    assert state["status"] == "incomplete" and state["atoms"] is None                 # never a claimed zero
    assert client.get(f"/api/repo-maps/fixture-mini/{SHA1}").json()["space"]["status"] == "incomplete"
    monkeypatch.setattr(hive.spaces, "mount_repo", real)
    assert load(client, SYNTHETIC).json()["unchanged"] is True                         # the idempotent retry remounts
    mounted(client, "fixture-mini", SHA1, 23)


def test_overlapping_retries_of_one_revision_end_mounted_once(client):
    import threading
    hive = client.app.state.hive
    load(client, SYNTHETIC)
    mounted(client, "fixture-mini", SHA1, 23)
    threads = [threading.Thread(target=hive.repo_maps._mount, args=("fixture-mini", SHA1)) for _ in range(3)]
    threads += [threading.Thread(target=lambda: load(client, SYNTHETIC))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 23                           # not 46 or 69: whole sequences only
    assert hive.repo_maps.space("fixture-mini", SHA1)["status"] == "mounted"
    # a mount that runs after retention dropped the revision mounts nothing
    hive.db.execute("DELETE FROM repo_maps WHERE repo = 'fixture-mini' AND sha = ?", (SHA1,))
    hive.repo_maps._unmount("fixture-mini", SHA1)
    hive.repo_maps._mount("fixture-mini", SHA1)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 0 and hive.repo_maps.space("fixture-mini", SHA1)["status"] == "unmounted"


def test_node_detail_reserves_its_base_node_and_pages_the_rest(client):
    big = [{"path": "big.py", "line": k, "excerpt": "🔬" * repomap.EXCERPT_MAX} for k in range(repomap.MAX_REFS)]
    nodes = [{"id": "file:big.py", "kind": "file", "label": "big.py", "source_digest": "sha256:b", "refs": big}]
    nodes += [{"id": f"file:s{i}.py", "kind": "file", "label": f"s{i}.py", "source_digest": f"sha256:{i}",
               "refs": [{"path": f"s{i}.py", "line": 1, "excerpt": "é" * repomap.EXCERPT_MAX}]} for i in range(120)]
    edges = [{"id": f"e{i}", "kind": "imports", "from": f"file:s{i}.py", "to": "file:big.py", "basis": "syntax", "refs": []}
             for i in range(120)]
    env = dict(copy.deepcopy(SYNTHETIC), repo="fixture-detail", sha="de7a11d", state="ready", reason=None,
               coverage={"unresolved": []}, nodes=nodes, edges=edges)
    assert load(client, env).status_code == 200
    seen, cursor, pages = [], None, 0
    while True:
        r = client.get("/api/repo-maps/fixture-detail/de7a11d/nodes/file:big.py?limit=200" + (f"&cursor={cursor}" if cursor else ""))
        assert r.status_code == 200 and len(r.content) <= repomap.RESPONSE_CAP, r.text[:200]
        assert r.json()["node"] == nodes[0]                                   # the base node, whole, on every page
        seen += [e["id"] for e in r.json()["edges"]]
        pages += 1
        cursor = r.json()["next_cursor"]
        if not cursor:
            break
    assert pages > 1 and seen == [e["id"] for e in edges]


def test_a_revision_dropped_while_its_mount_waits_is_left_empty(client, monkeypatch):
    import threading
    hive = client.app.state.hive
    load(client, SYNTHETIC)
    mounted(client, "fixture-mini", SHA1, 23)
    real, done = hive.spaces.mount_repo, threading.Event()

    def retention_strikes_mid_mount(repo, sha, atoms, progress=None):
        def drop():
            hive.db.execute("DELETE FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
            hive.repo_maps._unmount(repo, sha)
            done.set()
        threading.Thread(target=drop).start()
        done.wait(1)                       # with the revision's lock held, retention's unmount must wait for this mount
        return real(repo, sha, atoms, progress)

    monkeypatch.setattr(hive.spaces, "mount_repo", retention_strikes_mid_mount)
    hive.repo_maps._mount("fixture-mini", SHA1)
    assert done.wait(30)
    assert hive.spaces.repo_count("fixture-mini", SHA1) == 0 and hive.repo_maps.space("fixture-mini", SHA1)["status"] == "unmounted"



# ---- r1.2 review follow-ups (stand-in and Kimi on 0d32f8a) ---------------------------------------------------------------

def test_every_preset_and_read_answers_partial_once_the_clock_has_run_out(client, monkeypatch):
    load(client, SYNTHETIC)
    load(client, revision_two())
    monkeypatch.setattr(repomap, "TIME_BOUND", -1)
    params = {"imports": {"path": "pkg/util.py"}, "potential-dependents": {"path": "pkg/core.py"},
              "defines": {"path": "pkg/core.py"}, "calls-expression": {"path": "pkg/util.py"}, "source-search": {"q": "add"},
              "test-doc-links": {"node_id": "def:pkg/core.py::add"}, "drift": {"from": SHA2}}
    assert set(params) == set(repomap.PRESETS)
    reads = []
    real_all = client.app.state.hive.db.all

    def counting_all(sql, params=()):
        rows = real_all(sql, params)
        reads.append(len(rows) if "repo_map" in sql else 0)
        return rows

    monkeypatch.setattr(client.app.state.hive.db, "all", counting_all)
    for preset, p in params.items():
        reads.clear()
        r = q(client, SHA1, preset, p)
        assert r.status_code == 200 and (r.json()["state"], r.json()["reason"]) == ("partial", "time_bound"), preset
        assert r.json()["revision_state"] == "partial", preset
        body = r.json()
        assert all(body[k] == [] for k in ("nodes", "edges", "added", "removed", "changed", "moved") if k in body), preset
        assert sum(reads) == 0, preset          # the fetch itself stopped at the clock: no map rows were read at all
    base = f"/api/repo-maps/fixture-mini/{SHA1}"
    for path in (f"{base}/nodes", f"{base}/nodes/def:pkg/core.py::add", f"/api/repo-maps/fixture-mini/drift?from={SHA1}&to={SHA2}"):
        r = client.get(path)
        assert r.status_code == 200 and (r.json()["state"], r.json()["reason"]) == ("partial", "time_bound"), path


def test_drift_past_the_clock_after_reading_both_revisions_claims_no_moves(client, monkeypatch):
    load(client, SYNTHETIC)
    load(client, revision_two())

    class AfterScans(repomap._Deadline):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def late(self):                      # both revisions read (one clock check each), then the bound has passed
            self.calls += 1
            self.hit = self.hit or self.calls > 2
            return self.hit

    monkeypatch.setattr(repomap, "_Deadline", AfterScans)
    seen_clocks, real = [], repomap.drift_entries
    monkeypatch.setattr(repomap, "drift_entries", lambda before, after, clock=None: (seen_clocks.append(clock), real(before, after, clock))[1])
    r = client.get(f"/api/repo-maps/fixture-mini/drift?from={SHA1}&to={SHA2}").json()
    assert (r["state"], r["reason"]) == ("partial", "time_bound") and r["moved"] == [] and r["changed"] == []
    assert len(seen_clocks) == 1 and isinstance(seen_clocks[0], AfterScans)        # the comparison runs on the read's clock
    # and on that clock, a comparison past the bound claims no change and no move (only the cheap added/removed sets)
    clock = AfterScans()
    clock.calls = 2
    before = {n["id"]: {k: n[k] for k in ("id", "kind", "label", "source_digest")} for n in SYNTHETIC["nodes"]}
    after = {n["id"]: {k: n[k] for k in ("id", "kind", "label", "source_digest")} for n in revision_two()["nodes"]}
    entries = real(before, after, clock)
    assert clock.hit and {e["change"] for e in entries} == {"added", "removed"}


def test_a_clock_that_runs_out_mid_page_stops_with_an_advancing_cursor(client, monkeypatch):
    load(client, SYNTHETIC)

    class Twice(repomap._Deadline):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def late(self):
            self.calls += 1
            self.hit = self.hit or self.calls > 2
            return self.hit

    monkeypatch.setattr(repomap, "_Deadline", Twice)
    first = client.get(f"/api/repo-maps/fixture-mini/{SHA1}/nodes").json()
    assert ids(first["nodes"]) == ids(SYNTHETIC["nodes"])[:2] and first["state"] == "partial" and first["truncated"] is True
    monkeypatch.undo()
    rest = client.get(f"/api/repo-maps/fixture-mini/{SHA1}/nodes?cursor={first['next_cursor']}").json()
    assert ids(first["nodes"]) + ids(rest["nodes"]) == ids(SYNTHETIC["nodes"]) and rest["state"] == "ready"


def test_retention_during_a_mount_never_lets_a_chunk_land_after_its_clear(client, monkeypatch):
    """Kimi #1, at the interpreter queue: the retention unmount's clear is submitted only after the running mount has
    submitted its last chunk and its count, so no add can be queued behind the clear."""
    import threading
    from hive.spaces import service as sv
    hive = client.app.state.hive
    load(client, SYNTHETIC)
    mounted(client, "fixture-mini", SHA1, 23)
    fake = _FakeInterpreter()
    monkeypatch.setattr(hive.spaces, "_interp", fake)
    monkeypatch.setattr(sv, "REPO_CHUNK", 5)
    gate = threading.Event()
    fake.block[("add", 1)] = gate
    mount = threading.Thread(target=hive.repo_maps._mount, args=("fixture-mini", SHA1))
    mount.start()
    while not any(j[0] == "add" for j in fake.jobs):
        pass

    def retention():
        hive.db.execute("DELETE FROM repo_maps WHERE repo = 'fixture-mini' AND sha = ?", (SHA1,))
        hive.repo_maps._unmount("fixture-mini", SHA1)

    drop = threading.Thread(target=retention)
    drop.start()
    drop.join(1)                                                                    # give retention every chance to run now
    assert drop.is_alive()                                                          # it waits: the mount holds the lock
    assert hive.repo_maps.space("fixture-mini", SHA1)["status"] == "mounting"      # progress is visible meanwhile
    assert hive.repo_maps.space("fixture-mini", SHA1)["total"] == 23
    gate.set()
    mount.join(10)
    drop.join(10)
    kinds = [j[0] for j in fake.jobs if j[0] != "other"]
    assert kinds == ["clear", "count"] + ["add"] * 5 + ["count"] + ["clear", "count"]
    assert max(i for i, k in enumerate(kinds) if k == "add") < max(i for i, k in enumerate(kinds) if k == "clear")
    assert set(fake.atoms.values()) == {0} and hive.repo_maps.space("fixture-mini", SHA1)["status"] == "unmounted"


def test_boot_mounts_the_newest_and_pinned_revisions_and_the_rest_on_demand(client, monkeypatch):
    hive = client.app.state.hive
    shas = [f"{i:040x}" for i in range(1, 4)]
    load(client, dict(SYNTHETIC, sha=shas[0]), pinned="true")
    for sha in shas[1:]:
        load(client, dict(SYNTHETIC, sha=sha))
    load(client, dict(SYNTHETIC, repo="fixture-other"))
    for sha in shas:
        mounted(client, "fixture-mini", sha, 23)
    assert set(hive.repo_maps._boot_revisions()) == {("fixture-mini", shas[2]), ("fixture-mini", shas[0]), ("fixture-other", SHA1)}
    for sha in shas:                                                   # a restart: PeTTa holds nothing
        hive.spaces.unmount_repo("fixture-mini", sha)
    hive.spaces.unmount_repo("fixture-other", SHA1)
    fresh = repomap.RepoMaps(hive)
    monkeypatch.setattr(hive, "repo_maps", fresh)
    assert fresh.space("fixture-mini", shas[1]) == {"id": f"repo:fixture-mini@{shas[1]}", "kind": "read-only", "status": "unmounted", "atoms": 0}
    mounted(client, "fixture-mini", shas[2], 23)
    mounted(client, "fixture-mini", shas[0], 23)
    mounted(client, "fixture-other", SHA1, 23)
    assert hive.spaces.repo_count("fixture-mini", shas[1]) == 0                     # not mounted, and not claimed
    head = fresh.header(repomap.Caller("user:u_reader"), "fixture-mini", shas[1])    # first asked for (the header route's call)
    assert head["space"]["status"] in ("queued", "mounting", "mounted")
    mounted(client, "fixture-mini", shas[1], 23)


def test_a_remount_whose_count_disagrees_is_cleared_and_reported(client, monkeypatch):
    hive = client.app.state.hive
    load(client, SYNTHETIC)
    mounted(client, "fixture-mini", SHA1, 23)
    fake = _FakeInterpreter()
    fake.reply[("count", 2)] = "22"                                    # the count after the adds disagrees with 23 stored rows
    monkeypatch.setattr(hive.spaces, "_interp", fake)
    hive.repo_maps._remount([("fixture-mini", SHA1)])
    assert hive.repo_maps.space("fixture-mini", SHA1)["status"] == "failed" and set(fake.atoms.values()) == {0}


def test_an_idempotent_reload_says_when_visibility_or_pin_did_not_change(client):
    sw = client.post("/api/swarms", json={"name": "Vis"}).json()
    first = load(client, SYNTHETIC).json()
    assert "visibility_unchanged" not in first and "pinned_unchanged" not in first
    same = load(client, SYNTHETIC).json()
    assert same["unchanged"] is True and "visibility_unchanged" not in same and "pinned_unchanged" not in same
    asked = load(client, SYNTHETIC, visibility=f"swarm:{sw['id']}", pinned="true").json()
    assert asked["unchanged"] is True
    assert (asked["visibility_unchanged"], asked["visibility"], asked["pinned_unchanged"], asked["pinned"]) == (True, "hive", True, False)
    assert client.get("/api/repo-maps").json()[0]["visibility"] == "hive"
    assert "visibility_unchanged" not in load(client, SYNTHETIC, visibility="hive", pinned="false").json()


def test_the_skill_never_cuts_a_reply(client, monkeypatch):
    many = [{"id": f"file:m/{i:03}.py", "kind": "file", "label": f"m/{i:03}.py", "source_digest": f"sha256:{i}",
             "refs": [{"path": f"m/{i:03}.py", "line": 1, "excerpt": "x" * 900}]} for i in range(60)]
    big = {"id": "file:huge.py", "kind": "file", "label": "huge.py", "source_digest": "sha256:h",
           "refs": [{"path": "huge.py", "line": k, "excerpt": "y" * repomap.EXCERPT_MAX} for k in range(repomap.MAX_REFS)]}
    load(client, dict(copy.deepcopy(SYNTHETIC), repo="fixture-skill", sha="5c111ed", state="ready", reason=None,
                      coverage={"unresolved": []}, nodes=many + [big], edges=[]))
    _, mind_a, _ = mind(client, "Skillcap")
    spec = importlib.util.spec_from_file_location("hive_commons_cap", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)

    def through_the_app(method, path, payload=None):
        r = client.request(method, path, json=payload, headers=mind_a)
        if r.status_code >= 400:
            return None, f"HIVE-ERROR {r.json()['error']['code']}: {r.json()['error']['message']}"
        return r.json(), None

    monkeypatch.setattr(hc, "_call", through_the_app)
    seen, cursor = [], None
    while True:
        out = hc.repo_query(json.dumps({"view": "nodes", "repo": "fixture-skill", "sha": "5c111ed", "kind": "file",
                                        "path_prefix": "m/", **({"cursor": cursor} if cursor else {})}))
        assert out.startswith("HIVE-REPO ") and len(out) <= hc.REPO_TEXT_MAX + 10
        page = json.loads(out[10:])                                   # always whole, valid JSON
        seen += ids(page["nodes"])
        cursor = page["next_cursor"]
        if not cursor:
            break
        assert page["truncated"] is True and page["nodes"]
    assert seen == ids(many)
    out = hc.repo_query(json.dumps({"view": "node", "repo": "fixture-skill", "sha": "5c111ed", "node_id": "file:huge.py", "limit": 1}))
    assert out.startswith("HIVE-ERROR too_large") and "HIVE-REPO" not in out
