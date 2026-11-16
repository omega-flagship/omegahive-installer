"""R19: one explorer over minds, swarms, apps and rooms: filter and group on the server, counts first, pages after."""
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def q(client, headers=None, **spec):
    r = client.post("/api/explore", json=spec, headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


def test_every_kind_is_a_node_with_the_same_facets(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    client.post("/api/rooms", json={"kind": "group", "name": "Plan", "members": [f"agent:{a['id']}"]})
    out = q(client)
    kinds = {n["kind"] for n in out["items"]}
    assert {"mind", "swarm", "room"} <= kinds
    assert set(out["facet_names"]) >= {"kind", "where", "state", "purpose", "owner", "visibility"}
    mind = next(n for n in out["items"] if n["id"] == a["id"])
    assert mind["parent"] == swarm["id"] and mind["facets"]["state"] == "not started" and mind["facets"]["where"] == "this hive"
    assert out["facets"]["kind"]["mind"] >= 2


def test_filters_groups_counts_and_paging(client):
    swarm, _ = make_swarm_and_agents(client, n=5)
    client.post(f"/api/agents/{_[0]['id']}/start")
    out = q(client, kinds=["mind"], filters={"swarm": ["Alpha"]}, group_by=["state"])
    states = {g["value"]: g for g in out["groups"]}
    assert out["total"] == 5 and {v: g["count"] for v, g in states.items()} == {"not started": 4, "working": 1}   # just started: active in the last two minutes
    assert all(g["items"] is None for g in out["groups"])                       # collapsed: counts only
    path = states["not started"]["path"]
    opened = q(client, kinds=["mind"], filters={"swarm": ["Alpha"]}, group_by=["state"], open=[path], limit=3)
    g = next(g for g in opened["groups"] if g["path"] == path)
    assert len(g["items"]) == 3 and g["next"] == 3
    more = q(client, kinds=["mind"], filters={"swarm": ["Alpha"]}, group_by=["state"], open=[path], limit=3, cursor={path: 3})
    assert len(next(x for x in more["groups"] if x["path"] == path)["items"]) == 1
    # nested group-by: the inner level stays collapsed until its parent is opened
    nested = q(client, kinds=["mind", "swarm"], group_by=["kind", "state"])
    minds = next(x for x in nested["groups"] if x["value"] == "mind")
    assert minds["groups"] is None
    nested = q(client, kinds=["mind", "swarm"], group_by=["kind", "state"], open=[minds["path"]])
    assert next(x for x in nested["groups"] if x["value"] == "mind")["groups"]
    # facet counts ignore their own filter, so other choices stay visible
    f = q(client, kinds=["mind"], filters={"state": ["resting"]})
    assert "not started" in f["facets"]["state"]
    assert q(client, q="dot3")["total"] >= 1
    assert client.post("/api/explore", json={"group_by": ["nope"]}).status_code == 400


def test_people_see_only_what_they_may_and_keep_their_own_views(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    client.post("/api/agents", headers=ann, json={"name": "Ada", "kind": "module", "swarm_id": sw["id"]})
    assert any(n["name"] == "Ada" for n in q(client, ann)["items"])
    assert not any(n["name"] in ("Ada", "Ann's lab") for n in q(client, bob)["items"])
    view = client.post("/api/explore/views", headers=ann, json={"name": "My work", "spec": {"group_by": ["state"]},
                                                                 "arrangement": {"order": {"state": ["working", "resting"]}, "pinned": [sw["id"]]}}).json()
    assert [v["name"] for v in client.get("/api/explore/views", headers=ann).json()] == ["My work"]
    assert client.get("/api/explore/views", headers=bob).json() == []
    assert client.put(f"/api/explore/views/{view['id']}", headers=bob, json={"name": "x"}).status_code == 404
    assert client.post("/api/explore/views", headers=ann, json={"name": "bad", "spec": {"group_by": ["nope"]}}).status_code == 400
    upd = client.put(f"/api/explore/views/{view['id']}", headers=ann, json={"name": "My work", "spec": {"group_by": ["kind"]}, "arrangement": {"collapsed": ["kind=app"]}}).json()
    assert upd["spec"]["group_by"] == ["kind"] and upd["arrangement"]["collapsed"] == ["kind=app"]
    assert client.delete(f"/api/explore/views/{view['id']}", headers=ann).json()["deleted"]


def test_tags_purpose_and_personal_groups_filter_and_group_like_any_facet(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Lab", "visibility": "public"}).json()
    m1 = client.post("/api/agents", headers=ann, json={"name": "Ada", "kind": "module", "swarm_id": sw["id"], "visibility": "public"}).json()
    m2 = client.post("/api/agents", headers=ann, json={"name": "Bo", "kind": "module", "swarm_id": sw["id"], "visibility": "public"}).json()
    assert client.put(f"/api/explore/meta/{m1['id']}", headers=ann, json={"purpose": "Soil science", "tags": ["Science", "garden"]}).json()["tags"] == ["garden", "science"]
    assert client.put(f"/api/explore/meta/{m1['id']}", headers=bob, json={"tags": ["x"]}).status_code == 403      # not bob's
    client.put(f"/api/explore/meta/{m2['id']}", headers=ann, json={"tags": ["garden"]})
    by_tag = q(client, ann, kinds=["mind"], group_by=["tag"], filters={"swarm": ["Lab"]})
    assert {g["value"]: g["count"] for g in by_tag["groups"]} == {"garden": 2, "science": 1}       # Ada appears under both tags
    assert q(client, ann, kinds=["mind"], filters={"tag": ["science"]})["total"] == 1
    assert next(n for n in q(client, bob, kinds=["mind"], filters={"tag": ["science"]})["items"])["facets"]["purpose"] == "Soil science"   # shared on the thing
    # groups are personal: Ann's groups never show for Bob
    g = client.post("/api/explore/groups", headers=ann, json={"name": "Ben's demo"}).json()
    assert client.post("/api/explore/groups", headers=ann, json={"name": "ben's demo"}).status_code == 409
    client.post(f"/api/explore/groups/{g['id']}/members", headers=ann, json={"add": [m1["id"], sw["id"]]})
    assert client.post(f"/api/explore/groups/{g['id']}/members", headers=ann, json={"add": ["a_nope"]}).status_code == 404
    grouped = q(client, ann, group_by=["group"])
    assert {x["value"]: x["count"] for x in grouped["groups"]}["Ben's demo"] == 2
    assert "Ben's demo" not in q(client, bob, group_by=["group"])["facets"]["group"]
    assert client.post(f"/api/explore/groups/{g['id']}/members", headers=bob, json={"add": [m1["id"]]}).status_code == 404
    client.post(f"/api/explore/groups/{g['id']}/members", headers=ann, json={"remove": [sw["id"]]})
    assert q(client, ann, filters={"group": ["Ben's demo"]})["total"] == 1
    assert client.delete(f"/api/explore/groups/{g['id']}", headers=ann).json()["deleted"]
