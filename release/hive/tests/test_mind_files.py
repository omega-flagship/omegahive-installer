"""A file a person gives a swarm reaches its minds (tester report 11-09): a notice, a listing, a read.

Invented lives: Rosa runs a bakery swarm (minds Juno and Pax); Wren works in an orchard swarm; Ines and Tomas are
members with their own personal minds. Files are synthetic text and a fake PDF; no network, no real files.
"""
import hashlib
import importlib.util
import io
import json
import pathlib
import re
import urllib.error

import pytest

from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_linked_folders import tree  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
RECIPE = b"Rye sourdough: 500 g rye, 350 g water, 100 g starter. Bake at 230 C for 45 minutes.\n"
PDF = b"%PDF-1.4\n% invented one-page pricing sheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


def mind(hive, name, swarm_id, personal_of=None, owner=None):
    return hive.create_agent(name, "omega", swarm_id, "mock/echo", "", None, 0, None, None,
                             owner=owner, personal_of=personal_of)


def upload(client, data, mime, name, swarm_id, headers=None):
    r = client.post(f"/api/assets?swarm_id={swarm_id}&name={name}", content=data,
                    headers={"content-type": mime, **(headers or {})})
    assert r.status_code == 200, r.text
    return r.json()


def notices(hive, agent_id):
    return [r for r in hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' ORDER BY hub_seq", (agent_id,))
            if r["sender"] == "hive:files"]


def person(hive, pid, name, role="member"):
    hive.db.insert("people", {"id": pid, "email": f"{pid}@invented.example", "name": name, "role": role, "created_at": now()})
    return f"user:{pid}"


def session_for(hive, principal):
    token = "t-" + principal.replace(":", "-") + "-files"
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": principal})
    return {"Authorization": f"Bearer {token}", "Origin": "http://127.0.0.1:8700"}


@pytest.fixture()
def bakery(client):
    hive = client.app.state.hive
    rosa = person(hive, "u_rosa", "Rosa", role="admin")
    bakery = client.post("/api/swarms", json={"name": "Bakery"}).json()
    orchard = client.post("/api/swarms", json={"name": "Orchard"}).json()
    juno, pax = mind(hive, "Juno", bakery["id"]), mind(hive, "Pax", bakery["id"])
    wren = mind(hive, "Wren", orchard["id"])
    return {"hive": hive, "rosa": session_for(hive, rosa), "bakery": bakery, "orchard": orchard,
            "juno": juno, "pax": pax, "wren": wren}


def bridge(client, monkeypatch, agent, tmp_path):
    """hive_commons as a mind runs it (in its own folder), its HTTP calls answered by this hive with the mind's own token."""
    monkeypatch.chdir(tmp_path)
    spec = importlib.util.spec_from_file_location("hive_commons_mind_files", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)
    calls = []

    class Response(io.BytesIO):
        def __init__(self, data, headers):
            super().__init__(data)
            self.headers = headers

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(request, timeout=None):
        path = request.full_url[len("http://hive"):]
        calls.append((request.get_method(), path))
        r = client.request(request.get_method(), path, content=request.data,
                           headers={"Authorization": request.headers["Authorization"]})
        if r.status_code >= 400:
            raise urllib.error.HTTPError(request.full_url, r.status_code, "refused", {}, io.BytesIO(r.content))
        kept = {"Content-Type": r.headers.get("content-type", "")}
        if "x-hive-asset-type" in r.headers:
            kept["X-Hive-Asset-Type"] = r.headers["x-hive-asset-type"]
        return Response(r.content, kept)

    monkeypatch.setattr(hc.urllib.request, "urlopen", urlopen)
    monkeypatch.setenv("HIVE_API_URL", "http://hive")
    monkeypatch.setenv("HIVE_WS_TOKEN", agent["token"])
    return hc, calls


def test_an_upload_to_a_swarm_tells_its_minds_once_and_never_shows_the_contents(client, bakery):
    hive, b = bakery["hive"], bakery
    up = upload(client, RECIPE, "text/plain", "rye-recipe.txt", b["bakery"]["id"], b["rosa"])
    for m in (b["juno"], b["pax"]):
        [note] = notices(hive, m["id"])
        assert note["text"].startswith(f"[FILE-ADDED {up['sha256'][:12]}] Rosa added rye-recipe.txt (text/plain, ")
        assert note["text"].endswith(f"read it with hive-asset-get {up['sha256']} -")
        assert "sourdough" not in note["text"]                                        # name, type, size: never contents
        assert json.loads(note["extra"]) == {"event": "file_added", "sha256": up["sha256"], "swarm_id": b["bakery"]["id"]}
    assert notices(hive, b["wren"]["id"]) == []                                       # another swarm hears nothing
    upload(client, RECIPE, "text/plain", "rye-recipe-again.txt", b["bakery"]["id"], b["rosa"])
    assert len(notices(hive, b["juno"]["id"])) == 1                                   # the same file is noticed once
    pdf = upload(client, PDF, "application/pdf", "prices.pdf", b["bakery"]["id"])      # the operator, a PDF
    note = notices(hive, b["pax"]["id"])[-1]["text"]
    assert "The hive operator added prices.pdf (application/pdf, " in note and pdf["sha256"] in note
    assert not any(call[0] == "start" for call in client.supervisor.calls)            # a notice never wakes a mind


def test_a_mind_lists_its_swarms_files_and_another_swarm_sees_none(client, bakery, monkeypatch, tmp_path):
    b = bakery
    up = upload(client, RECIPE, "text/plain", "rye-recipe.txt", b["bakery"]["id"], b["rosa"])
    pdf = upload(client, PDF, "application/pdf", "prices.pdf", b["bakery"]["id"], b["rosa"])
    listing = client.get("/api/agent/assets", headers=agent_headers(b["juno"])).json()
    assert {f["sha256"] for f in listing["files"]} == {up["sha256"], pdf["sha256"]} and listing["total"] == 2
    recipe = next(f for f in listing["files"] if f["sha256"] == up["sha256"])
    assert recipe | {"added_at": None} == {"sha256": up["sha256"], "name": "rye-recipe.txt", "mime": "text/plain",
                                            "bytes": len(RECIPE), "added_at": None, "added_by": "user:u_rosa",
                                            "added_by_name": "Rosa", "source": "swarm", "where": "-",
                                            "read": f"hive-asset-get {up['sha256']} -"}
    page = client.get("/api/agent/assets?limit=1", headers=agent_headers(b["juno"])).json()
    assert len(page["files"]) == 1 and page["next_cursor"] == "1"
    rest = client.get("/api/agent/assets?limit=1&cursor=1", headers=agent_headers(b["juno"])).json()
    assert rest["next_cursor"] is None and rest["files"][0]["sha256"] != page["files"][0]["sha256"]
    assert client.get("/api/agent/assets?cursor=x", headers=agent_headers(b["juno"])).status_code == 400
    # Wren, in the orchard, lists nothing and reads nothing of the bakery's
    assert client.get("/api/agent/assets", headers=agent_headers(b["wren"])).json()["files"] == []
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(b["wren"])).status_code == 404
    # the skill, as the mind runs it (hive-asset-list -> hive_commons.asset_list -> GET /api/agent/assets)
    hc, calls = bridge(client, monkeypatch, b["juno"], tmp_path)
    shown = hc.decode(hc.asset_list("-"))
    assert shown.startswith("HIVE-ASSETS 2 of 2") and f'{up["sha256"]} "rye-recipe.txt" text/plain' in shown and "by Rosa" in shown
    assert calls == [("GET", "/api/agent/assets?limit=50")]
    hc, _ = bridge(client, monkeypatch, b["wren"], tmp_path)
    assert "(no files yet)" in hc.asset_list("-")


def test_a_file_listed_by_a_live_review_request_is_listed_for_the_reviewer(client):
    hive = client.app.state.hive
    R, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("Studio", "Critics"))
    maker = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": R["id"]}).json()
    role = client.post("/api/roles", json={"name": "Craft r", "prompt": "p", "mandate": {"id": "craft", "version": "1"}}).json()["id"]
    critic = client.post("/api/agents", json={"name": "Critic", "kind": "module", "swarm_id": V["id"], "role_id": role}).json()
    up = client.post("/api/agent/assets?name=deck.pptx", content=b"PK invented deck", headers={**agent_headers(maker), "content-type": "application/octet-stream"}).json()
    assert client.get("/api/agent/assets", headers=agent_headers(critic)).json()["files"] == []
    g = client.post(f"/api/swarms/{R['id']}/goals", json={"title": "deck", "assignee": "Maker"}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(maker))
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    art = client.post("/api/agent/artifacts", headers=agent_headers(maker), json={"kind": "deck", "title": "Pitch"}).json()
    manifest = {"originals": [{"path": "deck.pptx", "sha256": up["sha256"], "mime": up["mime"]}], "previews": []}
    client.post(f"/api/agent/artifacts/{art['id']}/revisions", headers=agent_headers(maker), json={"body": json.dumps(manifest), "parent": None})
    rq = client.post("/api/agent/requests", headers=agent_headers(maker), json={"kind": "review", "to_swarm": V["id"], "title": "review deck",
         "from_goal": g["id"], "subject": {"artifact_id": art["id"], "revision": 1}, "constraints": {"mandates": [{"id": "craft", "version": "1"}]}}).json()
    client.post(f"/api/agent/goals/{rq['receiving_goal']}/claim", headers=agent_headers(critic))
    [entry] = client.get("/api/agent/assets", headers=agent_headers(critic)).json()["files"]
    assert entry["sha256"] == up["sha256"] and entry["source"] == "request" and entry["where"] == f"{art['id']} 1"
    assert entry["read"] == f"hive-asset-get {up['sha256']} {art['id']} 1"
    # once the request is cancelled it is no longer live, and the file leaves the list
    hive.db.execute("UPDATE requests SET cancelled_at = ? WHERE id = ?", (now(), rq["id"]))
    assert client.get("/api/agent/assets", headers=agent_headers(critic)).json()["files"] == []


def test_a_persons_own_mind_lists_and_reads_their_files_and_no_one_elses(client, monkeypatch, tmp_path):
    hive = client.app.state.hive
    ines, tomas = person(hive, "u_ines", "Ines"), person(hive, "u_tomas", "Tomas")
    ines_home = hive.create_swarm("Ines", "Personal mind", owner=ines, visibility="private")
    tomas_home = hive.create_swarm("Tomas", "Personal mind", owner=tomas, visibility="private")
    hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (ines, ines_home["id"]))
    hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (tomas, tomas_home["id"]))
    ines_mind = mind(hive, "Ines's mind", ines_home["id"], personal_of=ines, owner=ines)
    tomas_mind = mind(hive, "Tomas's mind", tomas_home["id"], personal_of=tomas, owner=tomas)
    garden = hive.create_swarm("Garden club", owner=ines, visibility="private")   # Ines's, her mind is not in it
    up = upload(client, b"Plant garlic in October; harvest in July.\n", "text/plain", "garlic.txt", garden["id"])
    listing = client.get("/api/agent/assets", headers=agent_headers(ines_mind)).json()
    assert listing["person"] == ines
    [entry] = [f for f in listing["files"] if f["sha256"] == up["sha256"]]
    assert entry["source"] == "person" and entry["name"] == "garlic.txt" and entry["where"] == "-"
    got = client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(ines_mind))
    assert got.status_code == 200 and got.content.startswith(b"Plant garlic") and "garlic.txt" in got.headers["content-disposition"]
    # Tomas's own mind, and an ordinary mind, see none of it
    assert up["sha256"] not in {f["sha256"] for f in client.get("/api/agent/assets", headers=agent_headers(tomas_mind)).json()["files"]}
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(tomas_mind)).status_code == 404
    # read through the skill: hive-asset-get sha - shows a text file's content in the result
    hc, calls = bridge(client, monkeypatch, ines_mind, tmp_path)
    out = hc.decode(hc.asset_get(up["sha256"], "-"))
    assert out.startswith(f"HIVE-ASSET-SAVED files/assets/{up['sha256']}") and "Plant garlic in October" in out
    assert calls == [("GET", f"/api/agent/assets/{up['sha256']}")]
    # a disabled person's mind gets nothing extra
    hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_ines'")
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(ines_mind)).status_code == 404
    assert client.get("/api/agent/assets", headers=agent_headers(ines_mind)).json()["person"] is None


def test_a_linked_folder_is_noticed_and_listed_read_only(client, bakery, tree):
    b, hive = bakery, bakery["hive"]
    f = client.post("/api/folders", json={"path": str(tree["proj"]), "swarm_id": b["bakery"]["id"], "label": "Recipes"}).json()
    [note] = notices(hive, b["juno"]["id"])
    assert note["text"] == f"[FOLDER-LINKED {f['id']}] The hive operator linked the folder Recipes (read-only); see it with hive-asset-list -"
    folders = client.get("/api/agent/assets", headers=agent_headers(b["juno"])).json()["folders"]
    assert folders == [{"id": f["id"], "label": "Recipes", "owner_swarm": b["bakery"]["id"], "writable": False,
                        "added_at": folders[0]["added_at"], "added_by": "user:operator", "added_by_name": None, "source": "swarm",
                        "list": f"/api/agent/folders/{f['id']}/list?path=", "file": f"/api/agent/folders/{f['id']}/file?path=<path>"}]
    assert client.get(folders[0]["list"], headers=agent_headers(b["juno"])).status_code == 200
    assert client.get("/api/agent/assets", headers=agent_headers(b["wren"])).json()["folders"] == []
    assert notices(hive, b["wren"]["id"]) == []


class FakeModel:
    """A scripted model: on a person's question about a file it calls hive-asset-get on the sha its notice named, then
    answers from the tool's result (echoing the file's content)."""

    def __init__(self):
        self.prompts = []

    def __call__(self, messages):
        self.prompts.append(messages)
        tool = [m for m in messages if m["role"] == "tool"]
        if not tool:
            sha = re.search(r"hive-asset-get ([0-9a-f]{64}) -", "\n".join(m["content"] for m in messages)).group(1)
            return f"hive-asset-get {sha} -"
        content = tool[-1]["content"].split("--- content ---\n", 1)[1].split("\n--- end of content ---", 1)[0]
        return f"The file you gave me says: {content.strip()}"


def skill_bindings():
    """MeTTa skill name -> hive_commons function, read from modules/hive/skills.metta (Hyperon carries the dispatch)."""
    text = (ROOT / "modules" / "hive" / "skills.metta").read_text()
    return dict(re.findall(r"\(= \((hive-[a-z-]+)[^)]*\)\s*\(py-call \(hive_commons\.([a-z_]+)", text))


def test_a_fake_model_turn_answers_about_the_file_through_hive_asset_get(client, bakery, monkeypatch, tmp_path):
    b, hive = bakery, bakery["hive"]
    up = upload(client, RECIPE, "text/plain", "rye-recipe.txt", b["bakery"]["id"], b["rosa"])
    from hive.runtime.extensions import helper_command_parser as parser   # moved from src/ with the Singnet core port (#49)
    parser.reload_signature_commands(ROOT / "modules" / "hive" / "signatures.metta")
    try:
        hc, calls = bridge(client, monkeypatch, b["juno"], tmp_path)
        bindings = skill_bindings()
        assert bindings["hive-asset-get"] == "asset_get" and bindings["hive-asset-list"] == "asset_list"
        model = FakeModel()
        inbox = [{"role": "user", "content": json.loads(hive.envelope(m))["text"]} for m in
                 hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' ORDER BY hub_seq", (b["juno"]["id"],))]
        turn = inbox + [{"role": "user", "content": "What's in the file I just gave you?"}]
        command = model(turn)
        parsed = parser.signature_balance_parentheses(command)   # the mind's own command parser, hive signatures
        head, *args = re.findall(r'\((hive-[a-z-]+)|"([^"]*)"', parsed)
        skill, args = head[0], [a[1] for a in args]
        assert (skill, args) == ("hive-asset-get", [up["sha256"], "-"])
        result = hc.decode(getattr(hc, bindings[skill])(*args))
        turn.append({"role": "tool", "content": result})
        answer = model(turn)
    finally:
        parser.reload_signature_commands()
    assert calls == [("GET", f"/api/agent/assets/{up['sha256']}")]          # the tool path: the mind's asset read
    assert answer == "The file you gave me says: " + RECIPE.decode().strip()
    assert hashlib.sha256(RECIPE).hexdigest() == up["sha256"]
