"""Combined viewer + native rooms boundary, invented records only."""
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_visibility import person
from hive.core.visibility import Viewer
import json


def test_room_membership_does_not_expand_private_app_swarm_and_viewer_stays_actual(client,monkeypatch):
    ann,bob = person(client,'u_combo_ann'),person(client,'u_combo_bob')
    sw = client.post('/api/swarms',headers=ann,json={'name':'Invented private app context'}).json()
    room = client.post('/api/rooms',headers=ann,json={'kind':'group','name':'Invented shared conversation',
                       'members':['user:u_combo_bob']}).json()
    assert client.get('/api/rooms/'+room['id'],headers=bob).status_code == 200
    module = client.app.state.hive.programs._ready('contract-fixture')['module']
    original,seen = module.view,[]
    def observe(ctx,focus,stage):
        seen.append((ctx.viewer,ctx.actor,ctx.command))
        return original(ctx,focus,stage)
    monkeypatch.setattr(module,'view',observe)
    route = '/api/programs/contract-fixture/view'
    assert client.post(route,headers=bob,json={'swarm_id':sw['id']}).status_code == 404
    assert not seen
    assert client.post(route,headers=ann,json={'swarm_id':sw['id']}).status_code == 200
    who,actor,command = seen[0]
    assert who['principal']=='user:u_combo_ann' and who['person_id']=='u_combo_ann'
    assert actor is None and command is None


def test_room_event_privacy_retained_with_mind_id_visibility_extension(client):
    ann,bob = person(client,'u_combo_event_ann'),person(client,'u_combo_event_bob')
    room = client.post('/api/rooms',headers=ann,json={'kind':'group','name':'Invented private room'}).json()
    event = json.dumps({'type':'room','room_id':room['id'],'what':'members'})
    vis = client.app.state.hive.visibility
    assert vis.event_visible(Viewer('user:u_combo_event_ann',False),event)
    assert not vis.event_visible(Viewer('user:u_combo_event_bob',False),event)
