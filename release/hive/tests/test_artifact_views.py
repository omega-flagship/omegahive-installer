"""Artifact views (hive/core/views.py): a saved revision drawn as an interactive view. A view a mind writes in MeTTa
comes to a person shown it as its text, which their browser composes; a view that could not be drawn is refused as it
is saved; only the owning swarm changes a view, and a rule that asks first or denies holds over HTTP as at the gate.
An HTML view (MCP Apps) gets its resource and a short-lived document address; the document comes with a CSP whose
sandbox directive gives it an opaque origin, built from the domains the view declared minus anything that reaches the
hive; anyone else learns nothing. An artifact a mind names by id answers with its title the same way. Invented swarms,
minds and bodies only; disposable host."""
import base64
import ipaddress
import json
import pathlib
import random
import re
import time
import types
from urllib.parse import urlsplit

from hive.core import views
from hive.tests.test_collab import call
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

TIP = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tip</title>
<script>window.ready = () => localStorage.setItem('seen', '1')</script></head>
<body><h1>Tip calculator</h1><input id="bill" value="84.50"></body></html>"""
# the MeTTa tip calculator, kept as a file so every test that draws a view can share it
TIP_METTA = (pathlib.Path(__file__).resolve().parent / "fixtures" / "views-tip.metta").read_text()
# the change a mind makes to it: other tips, starting at 18%
TIP_METTA_2 = TIP_METTA.replace('(option "10" "10%") (option "15" "15%") (option "20" "20%")',
                                '(option "18" "18%") (option "20" "20%") (option "25" "25%")').replace(
    '(Start pct "15")', '(Start pct "18")')


def _maker(client, who):
    swarm = client.post("/api/swarms", headers=who, json={"name": "Invented sums"}).json()
    maker = client.post("/api/agents", headers=who, json={"name": "Wren", "kind": "module", "swarm_id": swarm["id"]}).json()
    return swarm, maker


def _save(client, maker, kind, title, body):
    made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": kind, "title": title, "body": body})
    assert made.status_code == 200, made.text
    return made.json()


def _run(client, who, artifact_id, revision=1, reach=False):
    """The person's own Run it (and, with reach, Allow for this version) on one revision of a view."""
    r = client.post(f"/api/artifacts/{artifact_id}/view/grants", headers=who, json={"revision": revision, "reach": reach})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_view_written_in_metta_comes_as_its_text_to_a_person_shown_it_and_has_no_document(client):
    ann, bob = person(client, "u_mview_ann"), person(client, "u_mview_bob")
    swarm, maker = _maker(client, ann)
    assert TIP_METTA_2 != TIP_METTA
    tip = _save(client, maker, "view", "Tip calculator", TIP_METTA)

    # nothing runs, and no text comes, until the person asks it to run
    got = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann)
    assert got.status_code == 200, got.text
    v = got.json()
    assert v == {"artifact_id": tip["id"], "kind": "view", "title": "Tip calculator", "swarm_id": swarm["id"],
                 "mind_id": maker["id"], "revision": 1, "digest": tip["digest"], "created_at": v["created_at"],
                 "carrier": "metta", "grant": {"ran": False, "reach": False}, "source": None}
    assert _run(client, ann, tip["id"]) == {"ran": True, "reach": False}
    v = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()
    assert (v["grant"], v["source"]) == ({"ran": True, "reach": False}, TIP_METTA)
    assert client.get(f"/api/artifacts/{tip['id']}/view", headers=bob).status_code == 404
    assert client.post(f"/api/artifacts/{tip['id']}/view/grants", headers=bob, json={"revision": 1}).status_code == 404

    # the mind's change is the latest revision, which a view already open takes up when it hears of it: the person's
    # run covers it, since a MeTTa view reaches nothing and its changes are meant to show live
    changed = call(client, maker, "POST", f"/api/agent/artifacts/{tip['id']}/revisions", {"body": TIP_METTA_2, "parent": 1})
    assert changed.status_code == 200, changed.text
    latest = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()
    assert (latest["revision"], latest["source"]) == (2, TIP_METTA_2)
    first = client.get(f"/api/artifacts/{tip['id']}/view?revision=1", headers=ann).json()
    assert (first["revision"], first["source"]) == (1, TIP_METTA)
    # a MeTTa view is never allowed to reach out
    refused = client.post(f"/api/artifacts/{tip['id']}/view/grants", headers=ann, json={"revision": 2, "reach": True})
    assert refused.status_code == 400 and "reaches no domain" in refused.json()["error"]["message"]


def test_a_view_runs_only_after_its_person_asks_and_reaches_its_domains_only_once_they_allow_that_revision(client):
    ann, carl = person(client, "u_grant_ann"), person(client, "u_grant_carl", role="admin")
    _, maker = _maker(client, ann)
    declared = {"connectDomains": ["https://api.example.com"], "resourceDomains": ["https://cdn.jsdelivr.net"]}
    body = json.dumps({"mimeType": views.MCP_APP_MIME, "text": TIP, "_meta": {"ui": {"csp": declared}}})
    chart = _save(client, maker, "view", "Chart", body)
    path = f"/api/artifacts/{chart['id']}/view"

    # before Run it: no document, nothing kept in its CSP, and the domains it declares wait on the person
    v = client.get(path, headers=ann).json()
    assert v["grant"] == {"ran": False, "reach": False} and v["document"] is None
    assert v["resource"]["_meta"]["ui"]["csp"] == {} and v["asks"] == declared

    # Run it: a document, served with connect-src 'none' and none of the declared domains, which still wait
    assert _run(client, ann, chart["id"]) == {"ran": True, "reach": False}
    v = client.get(path, headers=ann).json()
    assert v["asks"] == declared and v["resource"]["_meta"]["ui"]["csp"] == {}
    header = client.get(v["document"]).headers["content-security-policy"]
    assert "connect-src 'none';" in header and "example.com" not in header and "jsdelivr" not in header

    # Allow for this version: the next document reaches them, and nothing waits
    assert _run(client, ann, chart["id"], reach=True) == {"ran": True, "reach": True}
    v = client.get(path, headers=ann).json()
    assert v["asks"] == {} and v["resource"]["_meta"]["ui"]["csp"] == declared
    header = client.get(v["document"]).headers["content-security-policy"]
    assert "connect-src https://api.example.com;" in header and "https://cdn.jsdelivr.net" in header
    # a later Run it does not take the allowance back
    assert _run(client, ann, chart["id"]) == {"ran": True, "reach": True}

    # the consent is ann's: another person shown the view starts from the beginning
    other = client.get(path, headers=carl).json()
    assert other["grant"] == {"ran": False, "reach": False} and other["document"] is None

    # and it is for that revision: the mind's next version asks again, in full
    call(client, maker, "POST", f"/api/agent/artifacts/{chart['id']}/revisions", {"body": body, "parent": 1})
    v2 = client.get(path, headers=ann).json()
    assert v2["revision"] == 2 and v2["grant"] == {"ran": False, "reach": False} and v2["document"] is None

    # a grant is checked: the revision must exist and the fields be the two it takes
    for bad in ({"revision": 9}, {"revision": "1"}, {"revision": True}, {"revision": 1, "reach": "yes"}, {"revision": 1, "also": 1}, []):
        r = client.post(f"/api/artifacts/{chart['id']}/view/grants", headers=ann, json=bad)
        assert r.status_code in (400, 404), (bad, r.text)


def test_a_grant_is_tied_to_the_revision_it_was_given_for(client):
    ann = person(client, "u_grant_rev")
    _, maker = _maker(client, ann)
    declared = {"connectDomains": ["https://api.example.com"]}
    body = json.dumps({"mimeType": views.MCP_APP_MIME, "text": TIP, "_meta": {"ui": {"csp": declared}}})
    chart = _save(client, maker, "view", "Chart", body)
    path = f"/api/artifacts/{chart['id']}/view"

    # no one can answer for a revision that doesn't exist yet, so a mind's next version can't be allowed ahead of time
    r = client.post(f"{path}/grants", headers=ann, json={"revision": 2, "reach": True})
    assert r.status_code == 404, r.text
    assert _run(client, ann, chart["id"], revision=1, reach=True) == {"ran": True, "reach": True}
    call(client, maker, "POST", f"/api/agent/artifacts/{chart['id']}/revisions", {"body": body, "parent": 1})

    # revision 2 starts over: nothing is handed out, and its domains wait on the person again
    v2 = client.get(path, headers=ann).json()
    assert (v2["revision"], v2["grant"], v2["document"], v2["asks"]) == (2, {"ran": False, "reach": False}, None, declared)
    # revision 1 keeps its own answer, and only its document reaches the declared domain
    v1 = client.get(f"{path}?revision=1", headers=ann).json()
    assert v1["grant"] == {"ran": True, "reach": True}
    assert "connect-src https://api.example.com;" in client.get(v1["document"]).headers["content-security-policy"]
    # running revision 2 doesn't carry revision 1's allowance over
    assert _run(client, ann, chart["id"], revision=2) == {"ran": True, "reach": False}
    v2 = client.get(path, headers=ann).json()
    assert "connect-src 'none';" in client.get(v2["document"]).headers["content-security-policy"]

    # a view written in MeTTa reaches nothing, so a run of it is the one answer that carries to its next revision
    tip = _save(client, maker, "view", "Tip calculator", TIP_METTA)
    _run(client, ann, tip["id"])
    call(client, maker, "POST", f"/api/agent/artifacts/{tip['id']}/revisions", {"body": TIP_METTA_2, "parent": 1})
    m2 = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()
    assert (m2["revision"], m2["grant"], m2["source"]) == (2, {"ran": True, "reach": False}, TIP_METTA_2)


def test_an_expired_ticket_opens_nothing_and_the_next_look_hands_out_a_fresh_one(client, monkeypatch):
    ann = person(client, "u_view_old")
    _, maker = _maker(client, ann)
    tip = _save(client, maker, "view", "Tip calculator", TIP)
    _run(client, ann, tip["id"])
    old = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["document"]
    assert "Tip calculator" in client.get(old).text   # it opens while it is fresh

    # a second past its ten minutes the same address opens nothing: the expired page, sandboxed, with no view in it
    later = time.time() + views.TICKET_SECONDS + 1
    monkeypatch.setattr(views, "time", types.SimpleNamespace(time=lambda: later))
    r = client.get(old)
    assert r.status_code == 404 and "Tip calculator" not in r.text and "expired" in r.text
    assert r.headers["content-security-policy"].startswith("sandbox;")
    # the person's next look at the view hands out a fresh address, which opens
    fresh = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["document"]
    assert fresh != old and "Tip calculator" in client.get(fresh).text


def test_a_domain_the_view_did_not_declare_is_refused_before_and_after_the_person_allows_its_own(client):
    ann = person(client, "u_view_undeclared")
    _, maker = _maker(client, ann)
    declared = {"connectDomains": ["https://api.example.com"], "resourceDomains": ["https://cdn.example.org"]}
    page = TIP.replace("</body>", "<script>fetch('https://undeclared.example/collect')</script></body>")
    body = json.dumps({"mimeType": views.MCP_APP_MIME, "text": page, "_meta": {"ui": {"csp": declared}}})
    chart = _save(client, maker, "view", "Chart", body)

    def served_csp():
        document = client.get(f"/api/artifacts/{chart['id']}/view", headers=ann).json()["document"]
        header = client.get(document).headers["content-security-policy"]
        directives = {d.split()[0]: d.split()[1:] for d in (part.strip() for part in header.split(";")) if d}
        return header, directives, {source for sources in directives.values() for source in sources if "://" in source}

    # run, not yet allowed: connect-src, frame-src and base-uri 'none', and no domain anywhere
    _run(client, ann, chart["id"])
    header, directives, domains = served_csp()
    assert [directives[d] for d in ("connect-src", "frame-src", "base-uri")] == [["'none'"]] * 3 and domains == set()

    # allowed: exactly the declared domains, each where it was declared, and the undeclared one in no directive
    _run(client, ann, chart["id"], reach=True)
    header, directives, domains = served_csp()
    assert domains == {"https://api.example.com", "https://cdn.example.org"} and "undeclared.example" not in header
    assert directives["connect-src"] == ["https://api.example.com"]
    assert [directives[d] for d in ("frame-src", "base-uri")] == [["'none'"]] * 2

    # an allowance can't name a domain of its own: the person allows what the revision declares, and nothing more
    r = client.post(f"/api/artifacts/{chart['id']}/view/grants", headers=ann,
                    json={"revision": 1, "reach": True, "domains": ["https://undeclared.example"]})
    assert r.status_code == 400, r.text
    assert served_csp()[0] == header


def test_a_view_that_could_not_be_drawn_is_refused_as_it_is_saved_with_the_reason(client):
    ann = person(client, "u_mview_bad")
    _, maker = _maker(client, ann)
    bad = [("!(add-atom &self (Note x))", "nothing in it may start with !"),
           ('(Screen tip "Tip"', "a ( is never closed"),
           ('(Part tip 10 note ((text "x")))', "names its screen"),
           ('(Screen a "A")\n(Screen b "B")', "names one screen, and this one names 2"),
           ('(Screen tip "Tip") loose', "loose stands outside any expression"),
           ("Tip calculator", "a view is MeTTa"),
           ("{ not json", "not one JSON object"),
           ('{"mimeType": "text/plain", "text": "<!doctype html>"}', "needs mimeType")]
    for body, why in bad:
        made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "view", "title": "Broken", "body": body})
        assert made.status_code == 400 and made.json()["error"]["code"] == "bad_view", (body, made.text)
        assert why in made.json()["error"]["message"], (body, made.json())

    # a revision that breaks a good view is refused too, and the good one stays the latest
    tip = _save(client, maker, "view", "Tip calculator", TIP_METTA)
    broken = call(client, maker, "POST", f"/api/agent/artifacts/{tip['id']}/revisions",
                  {"body": TIP_METTA + "\n!(remove-atom &self (Start bill \"\"))", "parent": 1})
    assert broken.status_code == 400 and broken.json()["error"]["code"] == "bad_view"
    assert client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["revision"] == 1
    # an HTML view and a text plan are saved as before
    _save(client, maker, "view", "Tip page", TIP)
    _save(client, maker, "plan", "Weekend", "1. Pack.\n2. Go.")


def test_a_metta_view_is_read_the_way_metta_reads_strings_and_comments():
    ok = '(Screen tip "Tip (a \\"calc\\")") ; a comment with ( and "\n(Part tip 10 note ((text "a ; is not a comment here")))\n'
    assert views.metta_problem(ok) is None
    assert isinstance(views.view_of("view", "\ufeff  ; made by a mind\n" + ok), views.MettaView)
    assert views.metta_problem('(Screen tip "T")\n(Part tip 10 note ((text "x)))\n') == "line 2: a string is never closed"
    assert views.metta_problem('(Screen tip "T")\n\n(Part tip 10 note ())))') == "line 3: a ) closes nothing"
    assert views.metta_problem('(Screen tip "T")\n(Part tip 10 note (') == "line 2: a ( is never closed"
    assert views.metta_problem('((Screen tip "T"))') == 'a view names its screen first: (Screen <name> "Title")'
    assert views.metta_problem('(Screen tip "T")\n!(foo)') == \
        "line 2: a view holds declarations only, so nothing in it may start with !"
    assert views.metta_problem('(Screen tip "T")\n"loose"') == "line 2: a string stands outside any expression"
    # each kind of body is told by its first character; HTML and the resource keep their carriers
    assert views.view_of("view", TIP).carrier == "view"
    assert views.view_of("plan", TIP).carrier == "document" and views.view_of("plan", TIP_METTA) is None


def test_only_the_owning_swarm_changes_a_view_and_a_rule_that_asks_first_or_denies_holds_over_http(client):
    ann = person(client, "u_mview_rule")
    swarm, maker = _maker(client, ann)
    _, stranger = _maker(client, ann)
    tip = _save(client, maker, "view", "Tip calculator", TIP_METTA)
    path = f"/api/agent/artifacts/{tip['id']}/revisions"
    edit = {"body": TIP_METTA_2, "parent": 1}

    refused = call(client, stranger, "POST", path, edit)
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "forbidden"

    # a person asks to be asked first: the change waits for their approval, then goes through once
    assert client.post("/api/policy", json={"scope": f"swarm:{swarm['id']}", "skill": "hive-revision", "mode": "ask"}).status_code == 200
    held = call(client, maker, "POST", path, edit)
    assert held.status_code == 403 and held.json()["error"]["code"] == "approval_required", held.text
    approval = held.json()["error"]["approval_id"]
    pending = [a for a in client.get("/api/approvals?status=pending").json() if a["id"] == approval]
    assert pending and pending[0]["skill"] == "hive-revision" and tip["id"] in pending[0]["command"]
    assert client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["revision"] == 1
    assert client.post(f"/api/approvals/{approval}/approve", json={}).status_code == 200
    done = call(client, maker, "POST", path, edit)
    assert done.status_code == 200, done.text
    assert client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["revision"] == 2
    # the approval covered that text once: a different change asks again
    again = call(client, maker, "POST", path, {"body": TIP_METTA, "parent": 2})
    assert again.status_code == 403 and again.json()["error"]["code"] == "approval_required"

    # a rule that denies, for this mind, refuses
    assert client.post("/api/policy", json={"scope": f"agent:{maker['id']}", "skill": "hive-revision", "mode": "deny"}).status_code == 200
    denied = call(client, maker, "POST", path, {"body": TIP_METTA, "parent": 2})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "policy_denied"
    # creating a view answers to its own rule the same way
    assert client.post("/api/policy", json={"scope": f"agent:{maker['id']}", "skill": "hive-artifact-create", "mode": "deny"}).status_code == 200
    made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "view", "title": "Another", "body": TIP_METTA})
    assert made.status_code == 403 and made.json()["error"]["code"] == "policy_denied"


def test_the_view_worker_script_is_served_with_no_network_and_no_code_generation():
    assert views.VIEW_WORKER_SCRIPT.fullmatch("assets/viewSandbox.worker-Ab_3-x9.js")
    for other in ("assets/viewSandbox.worker-Ab3.js.map", "assets/index-Ab3.js", "viewSandbox.worker-Ab3.js",
                  "assets/viewSandbox.worker-Ab3.js/x", "assets/sub/viewSandbox.worker-Ab3.js"):
        assert not views.VIEW_WORKER_SCRIPT.fullmatch(other), other
    csp = [d.strip() for d in views.VIEW_WORKER_CSP.split(";")]
    assert csp == ["default-src 'none'", "script-src 'self'", "connect-src 'none'"]


def test_the_view_a_minds_prompt_teaches_is_metta_the_hive_can_draw():
    prompt = (pathlib.Path(__file__).resolve().parents[1] / "templates" / "omega" / "prompt.txt").read_text()
    line = next(text for text in prompt.splitlines() if "save it as a view" in text)
    example, _ = json.JSONDecoder().raw_decode(line[line.index('{"kind":"view"'):])
    assert isinstance(views.view_of("view", example["body"]), views.MettaView)
    assert "<!doctype" not in prompt.lower() and "text/html" not in prompt   # minds are taught MeTTa views only


def test_a_person_shown_a_view_opens_it_sandboxed_and_no_one_else_learns_it_exists(client):
    ann, bob = person(client, "u_view_ann"), person(client, "u_view_bob")
    swarm, maker = _maker(client, ann)
    tip = _save(client, maker, "view", "Tip calculator", TIP)

    _run(client, ann, tip["id"])
    got = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann)
    assert got.status_code == 200, got.text
    v = got.json()
    assert (v["artifact_id"], v["kind"], v["title"], v["swarm_id"], v["revision"], v["carrier"]) == \
        (tip["id"], "view", "Tip calculator", swarm["id"], 1, "view")
    assert v["mind_id"] == maker["id"] and v["digest"] == tip["digest"]
    assert v["resource"] == {"uri": f"ui://hive/artifacts/{tip['id']}/r1", "mimeType": "text/html;profile=mcp-app",
                             "_meta": {"ui": {"csp": {}, "permissions": {}}}}
    assert (v["allow"], v["refused"]) == ("", [])
    assert re.fullmatch(rf"/api/views/{tip['id']}\.1\.\d+\.0\.[A-Za-z0-9_-]{{43}}", v["document"])
    assert "localStorage" not in got.text   # the answer carries no body

    doc = client.get(v["document"], headers={"Authorization": ""})   # the document needs no session
    assert doc.status_code == 200, doc.text
    assert doc.headers["content-type"] == "text/html; charset=utf-8"
    csp = [d.strip() for d in doc.headers["content-security-policy"].split(";")]
    assert csp[0] == "sandbox allow-scripts allow-forms" and "allow-same-origin" not in csp[0]
    for directive in ("default-src 'none'", "connect-src 'none'", "frame-src 'none'", "base-uri 'none'",
                      "object-src 'none'", "form-action 'none'", "frame-ancestors 'self'",
                      "script-src 'unsafe-inline' 'unsafe-eval' blob: data:", "img-src data: blob:"):
        assert directive in csp, directive
    assert "'self'" not in doc.headers["content-security-policy"].replace("frame-ancestors 'self'", "")
    for name, value in views.DOCUMENT_HEADERS.items():
        assert doc.headers[name] == value
    assert doc.text.startswith("<!doctype html><script>") and doc.text.endswith(TIP[len("<!doctype html>"):])

    # one who doesn't see the swarm, a revision never saved, an artifact that doesn't exist: all missing
    for who, path in ((bob, f"/api/artifacts/{tip['id']}/view"), (ann, f"/api/artifacts/{tip['id']}/view?revision=2"),
                      (ann, "/api/artifacts/ar_nope/view")):
        missing = client.get(path, headers=who)
        assert missing.status_code == 404 and "document" not in missing.text


def test_an_artifact_named_by_id_answers_with_its_title_only_to_a_person_shown_it(client):
    ann, bob = person(client, "u_ref_ann"), person(client, "u_ref_bob")
    _, maker = _maker(client, ann)
    tip = _save(client, maker, "view", "Tip calculator", TIP)
    listed = next(r for r in client.get("/api/artifacts", headers=ann).json() if r["artifact_id"] == tip["id"])
    got = client.get(f"/api/artifacts/{tip['id']}", headers=ann)
    assert got.status_code == 200, got.text
    assert got.json() == listed   # the row the Artifacts list gives, whatever the list's length
    assert (listed["title"], listed["kind"], listed["revision"], listed["mind_id"]) == ("Tip calculator", "view", 1, maker["id"])
    assert "localStorage" not in got.text   # metadata only, never the body
    # one who doesn't see the swarm, and an id that names nothing: the same answer, so neither learns it exists
    for who, art in ((bob, tip["id"]), (ann, "ar_" + "0" * 32)):
        missing = client.get(f"/api/artifacts/{art}", headers=who)
        assert missing.status_code == 404 and "Tip calculator" not in missing.text


def test_a_ticket_opens_only_its_own_revision_and_a_forged_or_spent_one_opens_nothing(client):
    ann = person(client, "u_view_tix")
    _, maker = _maker(client, ann)
    tip = _save(client, maker, "view", "Tip calculator", TIP)
    _run(client, ann, tip["id"])
    path = client.get(f"/api/artifacts/{tip['id']}/view", headers=ann).json()["document"]
    ticket = path.rsplit("/", 1)[1]
    artifact_id, n, expiry, reach, signature = ticket.split(".")
    assert reach == "0"
    forged = [f"{artifact_id}.2.{expiry}.{reach}.{signature}", f"{artifact_id}.{n}.{int(expiry) + 600}.{reach}.{signature}",
              f"{artifact_id}.{n}.{expiry}.{reach}.{signature[:-1]}{'A' if signature[-1] != 'A' else 'B'}",
              f"ar_other.{n}.{expiry}.{reach}.{signature}", "nothing", f"{ticket}.extra",
              f"{artifact_id}.\u00b2.{expiry}.{reach}.{signature}",
              # the reach bit is signed: a ticket cannot be made to reach the declared domains
              f"{artifact_id}.{n}.{expiry}.1.{signature}", f"{artifact_id}.{n}.{expiry}.2.{signature}",
              f"{artifact_id}.{n}.{expiry}.{signature}"]
    for bad in forged:
        r = client.get(f"/api/views/{bad}")
        assert r.status_code == 404 and "Tip calculator" not in r.text
        assert r.headers["content-security-policy"].startswith("sandbox;")
        assert "expired" in r.text

    clock = [1_000_000.0]
    tickets = views.Tickets(key=b"k" * 32, clock=lambda: clock[0])
    t = tickets.mint("ar_abc", 3)
    assert tickets.redeem(t) == ("ar_abc", 3, False)
    assert tickets.redeem(tickets.mint("ar_abc", 3, reach=True)) == ("ar_abc", 3, True)
    clock[0] += views.TICKET_SECONDS
    assert tickets.redeem(t) == ("ar_abc", 3, False)
    clock[0] += 1
    assert tickets.redeem(t) is None
    assert views.Tickets(key=b"x" * 32, clock=lambda: 1_000_000.0).redeem(t) is None   # another process's key


def test_a_view_saved_as_a_resource_keeps_only_the_domains_and_permissions_the_hive_grants(client):
    ann = person(client, "u_view_res")
    _, maker = _maker(client, ann)
    resource = {"mimeType": "text/html; profile=mcp-app", "text": TIP, "_meta": {"ui": {
        "csp": {"connectDomains": ["https://api.example.com", "'self'", "*", "https:", "http://127.0.0.1:8700",
                                   "http://localhost:9", "https://testserver", "https://api.example.com/path"],
                "resourceDomains": ["https://cdn.jsdelivr.net", "https://*.example.org", "https://*.com",
                                    "https://cdn.jsdelivr.net; script-src *"],
                "frameDomains": ["https://www.youtube.com"]},
        "permissions": {"clipboardWrite": {}, "camera": {}}, "prefersBorder": False}}}
    chart = _save(client, maker, "view", "Chart", json.dumps(resource))
    _run(client, ann, chart["id"], reach=True)
    v = client.get(f"/api/artifacts/{chart['id']}/view", headers=ann).json()
    assert v["carrier"] == "resource"
    assert v["resource"]["_meta"]["ui"] == {
        "csp": {"connectDomains": ["https://api.example.com"],
                "resourceDomains": ["https://cdn.jsdelivr.net", "https://*.example.org"],
                "frameDomains": ["https://www.youtube.com"]},
        "permissions": {"clipboardWrite": {}}, "prefersBorder": False}
    assert v["allow"] == "clipboard-write"
    assert set(v["refused"]) == {"'self'", "*", "https:", "http://127.0.0.1:8700", "http://localhost:9",
                                 "https://testserver", "https://api.example.com/path", "https://*.com",
                                 "https://cdn.jsdelivr.net; script-src *", "permission camera"}
    header = client.get(v["document"]).headers["content-security-policy"]
    assert "connect-src https://api.example.com;" in header
    assert "script-src 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.jsdelivr.net https://*.example.org;" in header
    assert "frame-src https://www.youtube.com;" in header
    assert "127.0.0.1" not in header and "testserver" not in header and "script-src *" not in header

    # base64 HTML is the resource's other form; a wrong MIME type or no HTML is refused with the reason, as it is saved
    blob = _save(client, maker, "view", "Blob", json.dumps({"mimeType": views.MCP_APP_MIME,
                                                            "blob": base64.b64encode(TIP.encode()).decode()}))
    assert client.get(f"/api/artifacts/{blob['id']}/view", headers=ann).json()["carrier"] == "resource"
    for body, reason in ((json.dumps({"mimeType": "text/html", "text": TIP}), "needs mimeType"),
                         (json.dumps({"mimeType": views.MCP_APP_MIME}), "as text or blob"),
                         (json.dumps({"mimeType": views.MCP_APP_MIME, "blob": "%%%"}), "not base64")):
        made = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "view", "title": "Bad", "body": body})
        assert made.status_code == 400 and made.json()["error"]["code"] == "bad_view" and reason in made.json()["error"]["message"]
    # a view saved before views were checked on save still opens as 415 with the reason
    kept = _save(client, maker, "view", "Kept", json.dumps({"mimeType": views.MCP_APP_MIME, "text": TIP}))
    client.app.state.hive.db.execute("UPDATE artifact_revisions SET body = ? WHERE artifact_id = ?",
                                     (json.dumps({"mimeType": "text/html", "text": TIP}), kept["id"]))
    r = client.get(f"/api/artifacts/{kept['id']}/view", headers=ann)
    assert r.status_code == 415 and r.json()["error"]["code"] == "not_a_view" and "needs mimeType" in r.json()["error"]["message"]


def test_a_plan_that_is_an_html_document_can_be_viewed_and_a_text_plan_cannot(client):
    ann = person(client, "u_view_plan")
    _, maker = _maker(client, ann)
    page = _save(client, maker, "plan", "Agenda", "\n  <!DOCTYPE html>\n<h1>Day 1</h1>")
    text = _save(client, maker, "plan", "Walk", "Day 1: the north bank; <b>lunch</b> at the weir")
    viewed = client.get(f"/api/artifacts/{page['id']}/view", headers=ann).json()
    assert viewed["carrier"] == "document" and viewed["document"] is None   # it runs only when the person asks
    _run(client, ann, page["id"])
    assert client.get(f"/api/artifacts/{page['id']}/view", headers=ann).json()["document"].startswith("/api/views/")
    r = client.get(f"/api/artifacts/{text['id']}/view", headers=ann)
    assert r.status_code == 415 and r.json()["error"]["code"] == "not_a_view"
    # the latest saved revision unless one is named
    call(client, maker, "POST", f"/api/agent/artifacts/{text['id']}/revisions", {"body": "<html><p>Now a page</p></html>", "parent": 1})
    latest = client.get(f"/api/artifacts/{text['id']}/view", headers=ann)
    assert latest.status_code == 200 and latest.json()["revision"] == 2
    assert client.get(f"/api/artifacts/{text['id']}/view?revision=1", headers=ann).status_code == 415


def test_html_documents_are_told_from_text_by_their_opening():
    """The same cases the page's rule is tested against (hive/ui/src/features/views/htmlDocument.ts)."""
    cases = json.loads((pathlib.Path(__file__).parent / "fixtures" / "html_document_cases.json").read_text())
    for doc in cases["document"]:
        assert views.is_html_document(doc), doc
    for text in cases["text"]:
        assert not views.is_html_document(text), text


def test_the_boot_script_goes_after_the_doctype_so_the_document_keeps_standards_mode():
    rng = random.Random(20261112)
    prologs = ["", "\ufeff", "\n  ", "<!-- made by Wren -->", "\ufeff<!-- a -->\n<!--b-->  "]
    for _ in range(200):
        prolog = rng.choice(prologs)
        doctype = rng.choice(["<!doctype html>", "<!DOCTYPE html>", "<!DocType HTML PUBLIC \"x\">"])
        rest = rng.choice(["<html><head></head><body>hi</body></html>", "<p>hi", ""])
        html = prolog + doctype + rest
        served = views.document(html)
        assert served == prolog + doctype + views.BOOT_SCRIPT + rest
    # no doctype: at the very start, after a byte order mark
    assert views.document("<p>hi") == views.BOOT_SCRIPT + "<p>hi"
    assert views.document("\ufeff<p>hi") == "\ufeff" + views.BOOT_SCRIPT + "<p>hi"
    # an unterminated comment is not skipped, so the script never lands inside it
    assert views.document("<!-- open <!doctype html>") == views.BOOT_SCRIPT + "<!-- open <!doctype html>"


_GRAMMAR = re.compile(r"(https|wss|http|ws)://(\*\.)?[a-z0-9.\-\[\]:]+(:\d{1,5})?")


def test_a_kept_domain_is_always_an_explicit_origin_that_cannot_reach_the_hive():
    own = {"hive.example.net", "127.0.0.1", ""}
    good = ["https://api.example.com", "wss://live.example.com:8443", "https://*.cdn.example.org", "http://10.0.0.7:3000",
            "https://[2001:db8::1]", "HTTPS://API.EXAMPLE.COM"]
    bad = ["'self'", "'unsafe-inline'", "*", "https:", "data:", "blob:", "https://", "https://api.example.com/",
           "https://api.example.com/x", "https://api.example.com:0", "https://api.example.com:70000",
           "https://-bad.example.com", "https://*.com", "https://*.*.example.com", "https://a b.com",
           "https://a.com;x", "https://a.com'", 'https://a.com"', "ftp://a.com", "javascript:alert(1)",
           "https://hive.example.net", "https://hive.example.net:444", "https://*.example.net",
           "http://127.0.0.1:9000", "http://localhost", "http://app.localhost:3000", "http://[::1]:8700",
           "https://[zz::1]", "https://a.com\n", "https://a.com\nX-Header: 1", None, 7, ["https://a.com"]]
    assert all(views.allowed_source(g, own) for g in good), [g for g in good if not views.allowed_source(g, own)]
    assert not any(views.allowed_source(b, own) for b in bad), [b for b in bad if views.allowed_source(b, own)]
    # generated entries: whatever is kept matches the origin grammar, carries no separator, and is none of the hive's
    rng = random.Random(1865)
    alphabet = "abcz09-.*:/[];'\" \n"
    pieces = ["https://", "http://", "wss://", "ws://", "*.", "hive.example.net", "example.com", "localhost", "127.0.0.1",
              ":8700", ":443", "/", "'self'", ";", " ", "[::1]"]
    for _ in range(4000):
        entry = "".join(rng.choice(pieces) if rng.random() < 0.7 else rng.choice(alphabet) for _ in range(rng.randint(1, 6)))
        if views.allowed_source(entry, own):
            low = entry.lower()
            assert _GRAMMAR.fullmatch(low) and not re.search(r"[;'\" \n]", low), entry
            # the host as urllib reads it, a second parser: never the hive's, never a loopback name beside a loopback hive
            host = urlsplit(low).hostname or ""
            bare = host[2:] if host.startswith("*.") else host
            assert bare and bare != "hive.example.net" and not "hive.example.net".endswith("." + bare), entry
            assert bare != "localhost" and not bare.endswith(".localhost"), entry
            try:
                assert not ipaddress.ip_address(bare).is_loopback, entry
            except ValueError:
                pass


def test_the_policy_never_lets_the_hive_origin_or_a_keyword_into_any_directive():
    rng = random.Random(42)
    junk = ["'self'", "*", "https:", "https://testserver", "http://127.0.0.1:8700", "https://ok.example.com", "x; y", 3]
    for _ in range(300):
        meta = {"csp": {k: rng.sample(junk, rng.randint(0, len(junk))) for k in views._CSP_KEYS if rng.random() < 0.8}}
        p = views.policy(meta, {"testserver", "127.0.0.1"})
        body = p.header.replace("frame-ancestors 'self'", "")
        assert "'self'" not in body and "testserver" not in body and "127.0.0.1" not in body
        assert " * " not in f" {body} ".replace(";", " ") and "https: " not in body.replace("https://", "")
        assert p.header.startswith("sandbox allow-scripts allow-forms; default-src 'none';")
        assert p.header.endswith("object-src 'none'; form-action 'none'; frame-ancestors 'self'")
