"""OmegaReview next10 0db2ba6 request-scope probes, kept as regressions (setup made hidden-aware: a hidden request is
correctly absent from a member's list). A request is judged by every swarm it names; an unrelated public swarm in its
constraints can only make it stricter."""
import json
from hive.tests.test_core_api import client
from hive.tests.test_collab import mind,call,held_goal
from hive.tests.test_visibility import person
from hive.core.visibility import Viewer

def make_actual_request(client, hidden=False, misleading_scope=False):
    R,P=(client.post('/api/swarms',json={'name':n,'visibility':'public'}).json() for n in ('Invented requester','Invented planner'))
    r,p=mind(client,R,'Invented asker'),mind(client,P,'Invented plan')
    h=client.app.state.hive
    for a in (r,p): h.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?",(a['id'],))
    g=held_goal(client,R,r)
    if hidden:
        for sw in (R,P): h.db.execute("UPDATE swarms SET visibility = 'private' WHERE id = ?",(sw['id'],))
    public_hint=client.post('/api/swarms',json={'name':'Invented unrelated public hint','visibility':'public'}).json()['id'] if misleading_scope else None
    assert client.put('/api/swarms/'+P['id']+'/services',json={'kinds':['plan']}).status_code==200
    frames=[]
    original=h.events.publish
    def record(kind,**payload):
        if kind=='request.updated':frames.append(json.dumps({'type':kind,**payload}))
        original(kind,**payload)
    h.events.publish=record
    response=call(client,r,'POST','/api/agent/requests',{'kind':'plan','to_swarm':P['id'],'title':'Invented visible plan','from_goal':g['id'],'budget_usd':1,**({'constraints':{'swarm_id':public_hint}} if misleading_scope else {})})
    assert response.status_code==200,response.text
    member=person(client,'u_review_eventshape','member')
    rows=client.get('/api/requests',headers=member)
    assert rows.status_code==200 and ((response.json()['id'] in {row['id'] for row in rows.json()}) == (not hidden))
    assert frames
    return h,frames[-1],R,P

def test_public_request_actual_emitter_reaches_member(client):
    h,frame,_,_=make_actual_request(client)
    assert h.visibility.event_visible(Viewer('user:u_review_eventshape',False),frame), 'Member-readable public request.updated is silently withheld'

def test_hidden_request_cannot_borrow_an_unrelated_public_constraint_scope(client):
    h,frame,R,P=make_actual_request(client,hidden=True,misleading_scope=True)
    viewer=Viewer('user:u_review_eventshape',False)
    assert not viewer.sees(h.visibility._swarm(R['id'])) and not viewer.sees(h.visibility._swarm(P['id']))
    assert not h.visibility.event_visible(viewer,frame), 'Private request delivered using unrelated public constraints.swarm_id'


def test_hidden_request_is_not_delivered_to_real_member_socket(client):
    h,frame,_,_=make_actual_request(client,hidden=True,misleading_scope=True)
    header=person(client,'u_review_request_socket','member')
    token=header['Authorization'].split(' ',1)[1]
    generated=json.loads(frame)
    request_id=generated['request']['id']
    with client.websocket_connect('/api/events?token='+token) as ws:
        assert ws.receive_json()['type']=='hello'
        client.portal.call(lambda:h.events.publish('request.updated',request=generated['request']))
        ws.send_json({'type':'ping'})
        for _ in range(30):
            event=ws.receive_json()
            assert not(event.get('type')=='request.updated' and event.get('request',{}).get('id')==request_id), 'Private request payload reached actual member websocket'
            if event.get('type')=='pong':return
        raise AssertionError('No ping barrier')


def test_the_request_list_is_filled_with_visible_requests(client):
    """Surface P: LIMIT before the visibility filter shortened a member's page; it is filled now."""
    from hive.core.db import now
    from hive.tests.test_visibility import person as _person
    h = client.app.state.hive
    hidden = client.post("/api/swarms", json={"name": "HiddenR", "visibility": "private"}).json()["id"]
    pub_a = client.post("/api/swarms", json={"name": "PubA", "visibility": "public"}).json()["id"]
    pub_b = client.post("/api/swarms", json={"name": "PubB", "visibility": "public"}).json()["id"]
    def add(rid, frm, to, at):
        h.db.insert("requests", {"id": rid, "kind": "plan", "title": rid, "from_swarm": frm, "from_goal": None,
                                 "from_principal": "user:operator", "to_swarm": to, "receiving_goal": None, "subject": None,
                                 "context_refs": "{}", "constraints": "{}", "acceptance": "{}", "budget_root": rid,
                                 "limit_usd": 1, "allocated_usd": 0, "ancestry": "[]", "depth": 0, "cancelled_at": None,
                                 "created_at": at})
    add("rq_visible_old", pub_a, pub_b, "2000-01-01T00:00:00.000Z")
    for i in range(205):                                                 # newer, hidden requests crowd the top
        add(f"rq_hidden_{i:03d}", hidden, pub_a, now())
    ana = _person(client, "u_rqlist", "member")
    ids = [r["id"] for r in client.get("/api/requests", headers=ana).json()]
    assert "rq_visible_old" in ids and not any(i.startswith("rq_hidden") for i in ids)
