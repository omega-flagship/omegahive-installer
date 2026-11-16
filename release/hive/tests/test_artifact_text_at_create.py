"""Purpose: a mind's new artifact carries its text: one call saves it as revision 1, or, refused, leaves no artifact at
all, and a field the create would not keep is refused rather than dropped; the answer to its first saved text names
hive-show with its id, since saving shows it to nobody.

A tester's v0.24 hive listed four plans with nothing saved in them. On a fresh v0.24 hive a mind named a plan with
hive-artifact-create, looked up how to save it, named a second plan (the first id no longer in view) and saved into
that one, so the first stayed empty. Invented swarms, minds and bodies only; disposable host."""
import importlib.util
import pathlib

from hive.tests.test_collab import call, mind
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hive_commons_create", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

PLAN = "Day 1: the north bank; lunch at the weir.\nDay 2: the old mill and back by \"the long way\"."


def _maker(client, name="Juniper"):
    swarm = client.post("/api/swarms", json={"name": "Invented trips"}).json()
    return swarm, mind(client, swarm, name)


def test_a_create_with_a_body_saves_it_as_revision_1_and_the_artifacts_page_lists_it_saved(client):
    swarm, maker = _maker(client)
    made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Walk by the river", "body": PLAN})
    assert made.status_code == 200, made.text
    art = made.json()
    assert art["revision"] == 1 and art["digest"].startswith("sha256:")
    listed = next(r for r in client.get("/api/artifacts").json() if r["artifact_id"] == art["id"])
    assert (listed["revision"], listed["digest"], listed["swarm_id"]) == (1, art["digest"], swarm["id"])
    first = call(client, maker, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").json()
    assert first["body"] == PLAN and first["parent"] is None
    # the next revision builds on it as on any other
    second = call(client, maker, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": PLAN + "\nDay 3: rest.", "parent": 1})
    assert second.status_code == 200, second.text
    assert second.json()["n"] == 2


def test_a_create_whose_body_is_refused_leaves_no_artifact(client):
    _, maker = _maker(client)
    before = client.get("/api/artifacts").json()
    for body in ("", None, "x" * (256 * 1024 + 1), {"text": "an object the hive never parses"}):
        refused = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Refused", "body": body})
        assert refused.status_code == 400, refused.text
    assert client.get("/api/artifacts").json() == before


def test_a_create_refuses_a_field_it_would_not_keep_instead_of_dropping_it(client):
    _, maker = _maker(client)
    before = client.get("/api/artifacts").json()
    for extra in ({"content": PLAN}, {"text": PLAN}, {"parent": None, "body": PLAN}, {"dependency_graph": {"a": []}}):
        refused = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Walk by the river", **extra})
        assert refused.status_code == 400, refused.text
        assert "takes kind, title" in refused.json()["error"]["message"]
    assert client.get("/api/artifacts").json() == before


def test_a_create_without_a_body_names_an_artifact_with_nothing_saved_for_text_sent_in_parts(client):
    _, maker = _maker(client)
    made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Long outline"}).json()
    assert "revision" not in made
    listed = next(r for r in client.get("/api/artifacts").json() if r["artifact_id"] == made["id"])
    assert (listed["revision"], listed["digest"]) == (None, None)


def test_the_minds_answer_says_what_was_saved_and_names_the_save_step_when_nothing_was(client, monkeypatch):
    _, maker = _maker(client)

    def through_the_hive(method, path, payload=None):
        r = client.request(method, path, headers=agent_headers(maker), json=payload)
        return (r.json(), None) if r.status_code < 400 else (None, f"HIVE-ERROR {r.json()['error']['code']}: {r.json()['error']['message']}")
    monkeypatch.setattr(hc, "_call", through_the_hive)

    saved = hc.artifact_create('{"kind": "plan", "title": "Walk by the river", "body": {"days": ["north bank", "old mill"]}}')
    assert saved.startswith("HIVE-ARTIFACT ar_") and " (plan) Walk by the river r1 sha256:" in saved
    art = saved.split()[1]
    body = call(client, maker, "GET", f"/api/agent/artifacts/{art}/revisions/1").json()["body"]
    assert '"north bank"' in body and body.lstrip().startswith("{")   # an object body is stored as its JSON text

    # saving puts it on nobody's screen, so the answer names the step that does, with this id, apart from the digest
    assert saved.endswith(f" - to show it to the person you are answering, in the middle of their screen: hive-show {art}")
    digest = next(t for t in saved.split() if t.startswith("sha256:"))
    assert len(digest) == 7 + 64 and digest[7:].isalnum()

    named = hc.artifact_create('{"kind": "plan", "title": "Long outline"}')
    art = named.split()[1]
    assert named.startswith(f"HIVE-ARTIFACT {art} (plan) Long outline. Nothing is saved in it yet")
    assert f'hive-revision {art} {{"body": "...", "parent": null}}' in named
    assert "hive-show" not in named   # nothing to show until its text is saved
    # its first saved text is when it can first be shown; a later revision changes what is shown and names no step
    first = hc.revision(art, '{"body": "Day 1: the north bank.", "parent": null}')
    assert first.startswith(f"HIVE-REVISION {art} r1 sha256:") and first.endswith(f"their screen: hive-show {art}")
    later = hc.revision(art, '{"body": "Day 1: the north bank.\\nDay 2: the mill.", "parent": 1}')
    assert later.startswith(f"HIVE-REVISION {art} r2 sha256:") and "hive-show" not in later

    # what a mind reads before it saves says so too: the create help and the screen line of its catalog
    catalog = (ROOT / "modules" / "hive" / "catalog.metta").read_text()
    create_help = next(line for line in catalog.splitlines() if line.startswith('(SkillHelp "hive-artifact-create" "hive-artifact-create'))
    screen = next(line for line in catalog.splitlines() if line.startswith('(SkillCatalog "Hive screen:'))
    assert "hive-show ar_id then puts it in the middle of the screen of the person you are answering" in create_help
    assert "to show the person you are answering what you made, on their screen" in screen

    # a field the create would not keep comes back as an error, never as HIVE-ARTIFACT
    refused = hc.artifact_create('{"kind": "plan", "title": "Walk by the river", "content": "Day 1: the north bank"}')
    assert refused.startswith("HIVE-ERROR bad_request: an artifact create takes kind, title")
