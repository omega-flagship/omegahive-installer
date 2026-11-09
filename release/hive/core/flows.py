"""OmegaFlow candidate: durable, actor-scoped, goals-only flow reconciliation.

A SQLite transaction admits a deterministic goal and its transition record
jointly. Notifications follow commit and may be replayed; worker discovery is
from durable goals. No guarantees about exactly-once external worker effects.
"""
import hashlib
import contextlib
import json
import math
import time

from .db import now, new_id
from .goals import MAX_BINDING_BYTES, UNFINISHED, binding_digest
from .result_schema import check_schema, SchemaError, validate as validate_result
from ..flow_ir.model import canonical, digest, revision
from ..flow_ir.admission import prepare

SCHEMA = [
    '''CREATE TABLE IF NOT EXISTS flow_layouts (artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
       version INTEGER NOT NULL, layout TEXT NOT NULL, PRIMARY KEY(artifact_id,revision))''',
    '''CREATE TABLE IF NOT EXISTS flow_adoptions (artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
       digest TEXT NOT NULL, adopted_by TEXT NOT NULL, adopted_at TEXT NOT NULL, PRIMARY KEY(artifact_id,revision))''',
    '''CREATE TABLE IF NOT EXISTS flow_runs (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
       digest TEXT NOT NULL, swarm_id TEXT NOT NULL, actor TEXT NOT NULL, session_hash TEXT NOT NULL,
       client_key TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       UNIQUE(actor,client_key))''',
    '''CREATE TABLE IF NOT EXISTS flow_steps (run_id TEXT NOT NULL, transition_id TEXT NOT NULL,
       goal_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, binding TEXT NOT NULL,
       PRIMARY KEY(run_id,transition_id))''',
]
TERMINAL = {'done','failed','cancelled','skipped'}


class Flows:
    def __init__(self,hive):
        self.hive,self.db=hive,hive.db
        for sql in SCHEMA:self.db.execute(sql)
        columns={r['name'] for r in self.db.all('PRAGMA table_info(flow_runs)')}
        for name,definition in {'actor_kind':"TEXT NOT NULL DEFAULT 'person'",'actor_ref':'TEXT',
                                'actor_token_hash':'TEXT','skill_name':'TEXT'}.items():
            if name not in columns:self.db.execute(f'ALTER TABLE flow_runs ADD COLUMN {name} {definition}')
        self.db.execute("UPDATE flow_runs SET actor_ref=actor WHERE actor_ref IS NULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS flow_skills (
            owner_swarm TEXT NOT NULL,name TEXT NOT NULL,purpose TEXT NOT NULL,
            flow_artifact TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
            status TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,retired_at TEXT,
            PRIMARY KEY(owner_swarm,name))""")
        # Only tests replace this with a crash injection. Not exposed to callers.
        self._fault=lambda stage:None

    def error(self,status,code,message):
        return self.hive.error(status,code,message)

    @contextlib.contextmanager
    def transaction(self):
        # One transaction/callback/rollback authority, including nesting under an existing host transaction.
        with self.db.transaction():
            yield

    def access(self,session,swarm_id,write=False,expired_ok=False):
        if write:self.hive.require_open_swarm(swarm_id)   # nothing new is published or run in a retired swarm
        # expired_ok: an admitted run outlives its starter's sign-in lifetime; a signed-out (deleted) session or a person
        # who is disabled, demoted or no longer owns the swarm still stops it.
        fresh=self.db.one('SELECT * FROM sessions WHERE token_hash=?',(session.get('token_hash'),))
        principal=(fresh or {}).get('principal')
        if not fresh or fresh.get('kind') not in {'sso','member_password'} or not isinstance(principal,str) or not principal.startswith('user:u_') or (not expired_ok and fresh.get('expires_at') and fresh['expires_at']<=time.time()):
            raise self.error(401,'named_person_required','a current named person session is required')
        person=self.db.one('SELECT * FROM people WHERE id=?',(principal[5:],))
        if not person or person['disabled'] or person['role'] not in {'admin','member'}:
            raise self.error(403,'actor_revoked','the actor is no longer enabled')
        is_admin=person['role']=='admin' and fresh['kind']=='sso'
        swarm=self.db.one('SELECT * FROM swarms WHERE id=?',(swarm_id,))
        from .visibility import Viewer
        if not swarm or not Viewer(principal,is_admin).sees(swarm):
            raise self.error(404,'not_found','no such flow scope')
        if write and not is_admin and swarm.get('owner')!=principal:
            raise self.error(403,'flow_owner_required','only the swarm owner or a named admin may change or run flows')
        return principal

    def agent_access(self,agent,skill):
        fresh=self.db.one('SELECT * FROM agents WHERE id=? AND token_hash=? AND deleted=0',(agent['id'],agent.get('token_hash')))
        if fresh:self.hive.agent(fresh['id']);self.hive.require_open_swarm(fresh.get('swarm_id'))
        if not fresh or fresh['id']!=agent['id'] or fresh.get('moved_to') or fresh.get('status')=='error':
            raise self.error(403,'actor_revoked','the mind is no longer eligible')
        mode,reason=self.hive.policy.decide(fresh,skill)
        if mode!='allow':raise self.error(403,'flow_policy_denied',reason)
        return fresh

    def agent_read(self,agent,artifact_id,n):
        fresh=self.agent_access(agent,'hive-flow-read')
        art=self.hive.collab.artifact(artifact_id)
        if art['owner_swarm']!=fresh['swarm_id']:raise self.error(404,'not_found','no such flow')
        _,row,flow=self.source(artifact_id,n)
        side=self.db.one('SELECT * FROM flow_layouts WHERE artifact_id=? AND revision=?',(artifact_id,n))
        return {'artifact_id':artifact_id,'swarm_id':art['owner_swarm'],'revision':n,'body':flow,
                'digest':row['digest'][7:],'layout':json.loads(side['layout']) if side else {},'execution_authorized':False}

    def agent_drafts(self,agent):
        fresh=self.agent_access(agent,'hive-flows')
        return self.db.all("""SELECT a.id AS artifact_id,a.title,MAX(r.n) AS revision
            FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.id
            WHERE a.kind='flow' AND a.owner_swarm=? GROUP BY a.id ORDER BY a.created_at DESC LIMIT 100""",(fresh['swarm_id'],))

    def agent_draft(self,agent,data,artifact_id=None):
        if not isinstance(data,dict) or set(data)-{'body','layout','title','parent'}:
            raise self.error(400,'invalid_flow','unknown draft fields')
        try:r=revision(data['body'],data.get('layout',{}))
        except (ValueError,TypeError,KeyError,RecursionError) as exc:raise self.error(400,'invalid_flow',str(exc)) from None
        if len(canonical(r))>262144:raise self.error(413,'flow_limit','draft exceeds size limit')
        # Agent-authored descriptions stay drafts, even if imported data asserts adoption.
        if any(e['meta']['revision_state']!='draft' for e in r['body']['elements']):
            raise self.error(400,'draft_required','agent authoring requires draft element states')
        with self.transaction():
            fresh=self.agent_access(agent,'hive-flow-revise' if artifact_id else 'hive-flow-draft')
            if artifact_id:
                art=self.hive.collab.artifact(artifact_id)
                if art['kind']!='flow' or art['owner_swarm']!=fresh['swarm_id']:
                    raise self.error(404,'not_found','no such flow')
                if type(data.get('parent')) is not int:raise self.error(400,'parent_required','revision requires exact parent')
            else:
                if data.get('parent') is not None:raise self.error(400,'invalid_parent','new draft has no parent')
                title=data.get('title')
                if not isinstance(title,str) or not title.strip() or len(title)>200:raise self.error(400,'title_required','bounded title required')
                art=self.hive.collab.create_artifact(fresh,{'kind':'flow','title':title})
                artifact_id=art['id']
            out=self.hive.collab.add_revision(fresh,artifact_id,{'body':canonical(r['body']),'parent':data.get('parent')})
            self.db.execute('INSERT INTO flow_layouts VALUES (?,?,?,?)',(artifact_id,out['n'],1,canonical(r['layout'])))
            return self.agent_read(agent,artifact_id,out['n'])

    def agent_skills(self,agent):
        fresh=self.agent_access(agent,'hive-flows')
        rows=self.db.all("SELECT name,purpose,owner_swarm,flow_artifact,revision,digest,status FROM flow_skills WHERE owner_swarm=? AND status='published' ORDER BY name LIMIT 100",(fresh['swarm_id'],))
        return [r | {"input_schema":{"type":"object","properties":{},"additionalProperties":False}} for r in rows]

    def agent_dynamic_inventory(self,agent):
        """S4 registry metadata only; no boot receipt or callable claim.

        The revision binds the complete permitted published catalogue, not an
        individual executable module. Existing invocation rechecks stay separate.
        """
        fresh=self.agent_access(agent,'hive-flows')
        rows=self.db.all("SELECT name,purpose,owner_swarm,flow_artifact,revision,digest,status FROM flow_skills WHERE owner_swarm=? AND status='published' ORDER BY name",(fresh['swarm_id'],))
        registry_revision='sha256:'+digest(rows)
        return [{'kind':'flow-skill','id':row['name'],'registry_revision':registry_revision} for row in rows]

    def register_skill(self,agent,data):
        if not isinstance(data,dict) or set(data)!={'name','purpose','artifact_id','revision','digest'}:
            raise self.error(400,'invalid_skill','registration requires exact bounded fields')
        import re
        if not isinstance(data['name'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}',data['name']):
            raise self.error(400,'invalid_skill','invalid skill name')
        if not isinstance(data['purpose'],str) or not 1<=len(data['purpose'])<=2000:
            raise self.error(400,'invalid_skill','bounded purpose required')
        with self.transaction():
            fresh=self.agent_access(agent,'hive-flow-publish')
            art,row,flow=self.source(data['artifact_id'],data['revision'])
            if art['owner_swarm']!=fresh['swarm_id']:raise self.error(404,'not_found','no such flow')
            if row['digest']!='sha256:'+str(data['digest']):raise self.error(409,'digest_mismatch','exact skill digest required')
            self.plan(flow,fresh['swarm_id'])
            if self.db.one('SELECT 1 FROM flow_skills WHERE owner_swarm=? AND name=?',(fresh['swarm_id'],data['name'])):
                raise self.error(409,'skill_name_exists','skill names preserve history; choose a new revision name')
            self.db.insert('flow_skills',{'owner_swarm':fresh['swarm_id'],'name':data['name'],'purpose':data['purpose'],
                'flow_artifact':art['id'],'revision':data['revision'],'digest':row['digest'],'status':'published',
                'created_by':'agent:'+fresh['id'],'created_at':now(),'retired_at':None})
        return {'name':data['name'],'digest':row['digest'],'execution_authorized':False}

    async def retire_skill(self,agent,name):
        with self.transaction():
            fresh=self.agent_access(agent,'hive-flow-publish')
            skill=self.db.one('SELECT * FROM flow_skills WHERE owner_swarm=? AND name=?',(fresh['swarm_id'],name))
            if not skill:raise self.error(404,'not_found','no such skill')
            self.db.execute("UPDATE flow_skills SET status='retired',retired_at=? WHERE owner_swarm=? AND name=?",(now(),fresh['swarm_id'],name))
            goals=[]
            for run in self.db.all("SELECT id FROM flow_runs WHERE swarm_id=? AND skill_name=? AND status='running'",(fresh['swarm_id'],name)):
                self.db.update('flow_runs',run['id'],{'status':'cancelled','reason':'skill_retired','updated_at':now()})
                goals+=self._cancel_goals(run['id'])
        for gid in goals:self.hive.goals._emit(gid);await self.notify_cancelled(gid)
        return {'name':name,'status':'retired'}

    def agent_run_access(self,run):
        fresh=self.db.one('SELECT * FROM agents WHERE id=? AND token_hash=? AND deleted=0',(run['actor_ref'],run['actor_token_hash']))
        if not fresh:raise self.error(403,'actor_revoked','mind identity revoked')
        self.agent_access(fresh,'hive-flow-run')
        if fresh['swarm_id']!=run['swarm_id']:raise self.error(403,'actor_revoked','mind changed swarm')
        skill=self.db.one("SELECT * FROM flow_skills WHERE owner_swarm=? AND name=? AND status='published'",(run['swarm_id'],run['skill_name']))
        if not skill or (skill['flow_artifact'],skill['revision'],skill['digest'])!=(run['artifact_id'],run['revision'],run['digest']):
            raise self.error(409,'skill_retired','published skill no longer matches the run')

    def agent_start(self,agent,name,data):
        if not isinstance(data,dict) or set(data)!={'params','client_key'} or data['params']!={}:
            raise self.error(400,'invalid_params','first slice requires empty params and client_key only')
        key=data['client_key']
        if not isinstance(key,str) or not 1<=len(key)<=200:raise self.error(400,'client_key_required','bounded client key required')
        with self.transaction():
            fresh=self.agent_access(agent,'hive-flow-run')
            skill=self.db.one("SELECT * FROM flow_skills WHERE owner_swarm=? AND name=? AND status='published'",(fresh['swarm_id'],name))
            if not skill:raise self.error(404,'not_found','no such published skill')
            art,row,flow=self.source(skill['flow_artifact'],skill['revision'])
            if art['owner_swarm']!=fresh['swarm_id'] or row['digest']!=skill['digest']:raise self.error(409,'digest_mismatch','skill binding changed')
            if not self.db.one('SELECT 1 FROM flow_adoptions WHERE artifact_id=? AND revision=? AND digest=?',(art['id'],skill['revision'],row['digest'])):
                raise self.error(409,'not_adopted','exact person adoption required')
            params=self.plan(flow,fresh['swarm_id']);principal='agent:'+fresh['id']
            old=self.db.one('SELECT * FROM flow_runs WHERE actor=? AND client_key=?',(principal,key))
            if old:
                if (old['artifact_id'],old['revision'],old['digest'],old['skill_name'])!=(art['id'],skill['revision'],row['digest'],name):
                    raise self.error(409,'idempotency_conflict','client key already binds another skill')
                return self.view(old)
            rid='fr_'+digest([principal,key,art['id'],skill['revision'],row['digest']])[:32];stamp=now()
            run={'id':rid,'artifact_id':art['id'],'revision':skill['revision'],'digest':row['digest'],
                'swarm_id':fresh['swarm_id'],'actor':principal,'actor_kind':'agent','actor_ref':fresh['id'],
                'actor_token_hash':fresh['token_hash'],'skill_name':name,'session_hash':'',
                'client_key':key,'status':'running','reason':None,'created_at':stamp,'updated_at':stamp}
            self.hive.insert_into_open_swarm('flow_runs',run,run['swarm_id'])   # write-guarded against archive (Kimi)
            for tid,p in params.items():
                binding={'flow_run_id':rid,'flow_transition_id':tid,'flow_revision_digest':row['digest'],
                         'flow_actor':principal,'flow_intent_digest':digest(p),'review':p['review']}
                if 'result_schema' in p:binding['result_schema']=p['result_schema']
                gid='g_flow_'+digest([rid,tid])[:32]
                self.db.execute('INSERT INTO flow_steps VALUES (?,?,?,?,?)',(rid,tid,gid,'pending',canonical(binding)))
        return self.view(run)

    def agent_run_get(self,agent,rid):
        fresh=self.agent_access(agent,'hive-flow-read')
        run=self.db.one('SELECT * FROM flow_runs WHERE id=?',(rid,))
        if not run or run['actor_kind']!='agent' or run['actor_ref']!=fresh['id'] or run['swarm_id']!=fresh['swarm_id']:
            raise self.error(404,'not_found','no such own run')
        return self.view(run)

    async def agent_cancel(self,agent,rid):
        with self.transaction():
            self.agent_run_get(agent,rid);self.agent_access(agent,'hive-flow-run')
            self.db.update('flow_runs',rid,{'status':'cancelled','updated_at':now()});goals=self._cancel_goals(rid)
        for gid in goals:self.hive.goals._emit(gid);await self.notify_cancelled(gid)
        return self.agent_run_get(agent,rid)

    def source(self,artifact_id,n):
        art=self.hive.collab.artifact(artifact_id)
        if art['kind']!='flow' or type(n) is not int or n<1:raise self.error(404,'not_found','no such flow revision')
        row=self.db.one('SELECT * FROM artifact_revisions WHERE artifact_id=? AND n=?',(artifact_id,n))
        if not row:raise self.error(404,'not_found','no such flow revision')
        try:
            flow=json.loads(row['body']);r=revision(flow)
        except (ValueError,TypeError,KeyError,RecursionError):raise self.error(409,'invalid_flow','stored flow is not a valid IR revision') from None
        if row['body']!=canonical(flow) or row['digest']!='sha256:'+r['digest']:
            raise self.error(409,'digest_mismatch','stored revision fingerprint does not match canonical content')
        return art,row,flow

    def read(self,session,artifact_id,n):
        art=self.hive.collab.artifact(artifact_id);self.access(session,art['owner_swarm'])
        _,row,flow=self.source(artifact_id,n)
        side=self.db.one('SELECT * FROM flow_layouts WHERE artifact_id=? AND revision=?',(artifact_id,n))
        adopted=self.db.one('SELECT * FROM flow_adoptions WHERE artifact_id=? AND revision=?',(artifact_id,n))
        return {'artifact_id':artifact_id,'swarm_id':art['owner_swarm'],'revision':n,'body':flow,'digest':row['digest'][7:],'host_digest':row['digest'],
                'layout':json.loads(side['layout']) if side else {},'layout_version':side['version'] if side else 0,
                'adoption':adopted}

    def list(self,session,swarm_id):
        self.access(session,swarm_id)
        return self.db.all("""SELECT a.id AS artifact_id,a.title,MAX(r.n) AS revision
            FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.id
            WHERE a.kind='flow' AND a.owner_swarm=? GROUP BY a.id ORDER BY a.created_at DESC LIMIT 100""",(swarm_id,))

    def publish(self,session,swarm_id,data):
        try:r=revision(data['body'],data.get('layout',{}))
        except (ValueError,TypeError,KeyError,RecursionError) as exc:raise self.error(400,'invalid_flow',str(exc)) from None
        if len(canonical(r['layout']))>131072:raise self.error(413,'layout_limit','layout exceeds size limit')
        with self.transaction():
            principal=self.access(session,swarm_id,True)
            actor={'swarm_id':swarm_id}
            artifact_id=data.get('artifact_id')
            if artifact_id:
                art=self.hive.collab.artifact(artifact_id)
                if art['owner_swarm']!=swarm_id or art['kind']!='flow':raise self.error(404,'not_found','no such flow')
            else:
                if data.get('parent') is not None:raise self.error(400,'invalid_parent','a new artifact has no parent')
                title=data.get('title')
                if not isinstance(title,str) or not title.strip():raise self.error(400,'title_required','flow title required')
                art=self.hive.collab.create_artifact(actor,{'kind':'flow','title':title},principal=principal);artifact_id=art['id']
            out=self.hive.collab.add_revision(actor,artifact_id,{'body':canonical(r['body']),'parent':data.get('parent')},principal=principal)
            self.db.execute('INSERT INTO flow_layouts VALUES (?,?,?,?)',(artifact_id,out['n'],1,canonical(r['layout'])))
        return self.read(session,artifact_id,out['n'])

    def layout(self,session,artifact_id,n,data):
        art=self.hive.collab.artifact(artifact_id)
        with self.transaction():
            self.access(session,art['owner_swarm'],True);_,_,flow=self.source(artifact_id,n)
            try:value=revision(flow,data['layout'])['layout']
            except (ValueError,TypeError,KeyError) as exc:raise self.error(400,'invalid_layout',str(exc)) from None
            if len(canonical(value))>131072:raise self.error(413,'layout_limit','layout exceeds size limit')
            old=self.db.one('SELECT * FROM flow_layouts WHERE artifact_id=? AND revision=?',(artifact_id,n))
            if type(data.get('expected_version')) is not int or not old or old['version']!=data['expected_version']:
                raise self.error(409,'stale_layout','layout version changed')
            self.db.execute('UPDATE flow_layouts SET version=version+1, layout=? WHERE artifact_id=? AND revision=?',(canonical(value),artifact_id,n))
        return self.read(session,artifact_id,n)

    def plan(self,flow,swarm_id):
        preflight=prepare(flow)
        if not preflight['structurally_eligible']:
            raise self.error(409,'unsupported_flow','flow fails execution preflight: '+','.join(sorted({e['code'] for e in preflight['findings']})))
        if sum(e['kind']=='transition' for e in flow['elements'])>100:
            raise self.error(400,'flow_limit','first subset permits at most 100 transitions')
        result={}
        for t in flow['elements']:
            if t['kind']!='transition':continue
            if t['action']['kind']!='goal' or t['action']['target']!=swarm_id:
                raise self.error(400,'unsupported_action','this candidate only creates tasks in its own swarm')
            p=t['action']['params']
            allowed={'title','detail','priority','assignee','result_schema','review','deadline_minutes'}
            if not set(p)<=allowed or not isinstance(p.get('title'),str) or not 0<len(p['title'].strip())<=300:
                raise self.error(400,'invalid_goal_params','bounded title and supported task parameters required')
            detail=p.get('detail','');priority=p.get('priority',.5);deadline=p.get('deadline_minutes',60)
            if not isinstance(detail,str) or len(detail)>4000 or type(priority) not in (int,float) or not math.isfinite(priority) or not 0<=priority<=1 or type(deadline) not in (int,float) or not math.isfinite(deadline) or not 0<deadline<=1440:
                raise self.error(400,'invalid_goal_params','invalid detail, priority or deadline')
            assignee=p.get('assignee')
            if assignee is not None:
                if not isinstance(assignee,str):raise self.error(400,'invalid_assignee','stable assignee id required')
                a=self.db.one('SELECT * FROM agents WHERE id=? AND swarm_id=? AND deleted=0',(assignee,swarm_id))
                if not a:raise self.error(400,'invalid_assignee','assignee must be a current mind in this swarm')
            review=p.get('review','none')
            if review not in ('none','person'):raise self.error(400,'unsupported_review','first subset supports none or person review')
            normalized={'title':p['title'].strip(),'detail':detail,'priority':priority,'assignee':assignee,'deadline_minutes':deadline,'review':review}
            if 'result_schema' in p:
                try:check_schema(p['result_schema'])
                except SchemaError as exc:raise self.error(400,'invalid_result_schema',str(exc)) from None
                normalized['result_schema']=p['result_schema']
            if len(canonical(normalized))>MAX_BINDING_BYTES-1024:raise self.error(413,'goal_binding_limit','task parameters exceed binding limit')
            result[t['id']]=normalized
        return result

    def adopt(self,session,artifact_id,n,data):
        art=self.hive.collab.artifact(artifact_id)
        with self.transaction():
            principal=self.access(session,art['owner_swarm'],True);_,row,flow=self.source(artifact_id,n)
            self.plan(flow,art['owner_swarm'])
            if data.get('digest')!=row['digest'][7:]:raise self.error(409,'digest_mismatch','adoption requires the exact semantic digest')
            self.db.execute('INSERT OR IGNORE INTO flow_adoptions VALUES (?,?,?,?,?)',(artifact_id,n,row['digest'],principal,now()))
        return self.read(session,artifact_id,n)

    def revoke(self,session,artifact_id,n):
        art=self.hive.collab.artifact(artifact_id)
        with self.transaction():
            self.access(session,art['owner_swarm'],True);self.source(artifact_id,n)
            self.db.execute('DELETE FROM flow_adoptions WHERE artifact_id=? AND revision=?',(artifact_id,n))
        return {'revoked':True}

    def start(self,session,artifact_id,n,data):
        art=self.hive.collab.artifact(artifact_id);key=data.get('client_key')
        if not isinstance(key,str) or not key.strip() or len(key)>200:raise self.error(400,'client_key_required','a bounded idempotency key is required')
        with self.transaction():
            principal=self.access(session,art['owner_swarm'],True);_,row,flow=self.source(artifact_id,n)
            if data.get('digest')!=row['digest'][7:]:raise self.error(409,'digest_mismatch','start requires exact semantic digest')
            if not self.db.one('SELECT 1 FROM flow_adoptions WHERE artifact_id=? AND revision=? AND digest=?',(artifact_id,n,row['digest'])):
                raise self.error(409,'not_adopted','a named owner must adopt this exact revision before running it')
            params=self.plan(flow,art['owner_swarm'])
            old=self.db.one('SELECT * FROM flow_runs WHERE actor=? AND client_key=?',(principal,key))
            if old:
                if (old['artifact_id'],old['revision'],old['digest'])!=(artifact_id,n,row['digest']):raise self.error(409,'idempotency_conflict','client key already binds another revision')
                return self.view(old)
            rid='fr_'+digest([principal,key,artifact_id,n,row['digest']])[:32];stamp=now()
            run={'id':rid,'artifact_id':artifact_id,'revision':n,'digest':row['digest'],'swarm_id':art['owner_swarm'],
                 'actor':principal,'session_hash':session['token_hash'],'client_key':key,'status':'running','reason':None,'created_at':stamp,'updated_at':stamp}
            self.hive.insert_into_open_swarm('flow_runs',run,run['swarm_id'])   # write-guarded against archive (Kimi)
            for tid,p in params.items():
                binding={'flow_run_id':rid,'flow_transition_id':tid,'flow_revision_digest':row['digest'],
                         'flow_actor':principal,'flow_intent_digest':digest(p),'review':p['review']}
                if 'result_schema' in p:binding['result_schema']=p['result_schema']
                gid='g_flow_'+digest([rid,tid])[:32]
                self.db.execute('INSERT INTO flow_steps VALUES (?,?,?,?,?)',(rid,tid,gid,'pending',canonical(binding)))
        return self.view(run)

    def view(self,run):
        return {k:v for k,v in run.items() if k not in {'session_hash','actor_token_hash'}} | {'steps':self.db.all('SELECT transition_id,goal_id,status FROM flow_steps WHERE run_id=? ORDER BY transition_id',(run['id'],))}

    def get(self,session,rid):
        row=self.db.one('SELECT * FROM flow_runs WHERE id=?',(rid,))
        if not row:raise self.error(404,'not_found','no such run')
        self.access(session,row['swarm_id']);return self.view(row)

    def owns_goal(self,gid):
        return bool(self.db.one("""WITH RECURSIVE ancestors(id,parent_id) AS (
            SELECT id,parent_id FROM goals WHERE id=? UNION
            SELECT g.id,g.parent_id FROM goals g JOIN ancestors a ON g.id=a.parent_id)
            SELECT 1 FROM ancestors a JOIN flow_steps s ON s.goal_id=a.id LIMIT 1""",(gid,)))

    def family(self,gid):
        return self.db.all("""WITH RECURSIVE family(id) AS (
            SELECT id FROM goals WHERE id=? UNION SELECT g.id FROM goals g JOIN family f ON g.parent_id=f.id)
            SELECT g.* FROM goals g JOIN family f ON g.id=f.id""",(gid,))

    def _cancel_goals(self,rid):
        cancelled=[]
        for step in self.db.all('SELECT * FROM flow_steps WHERE run_id=?',(rid,)):
            for goal in self.family(step['goal_id']):
                if goal['status'] in UNFINISHED:
                    self.db.update('goals',goal['id'],{'status':'cancelled','updated_at':now()});cancelled.append(goal['id'])
            if step['status'] not in TERMINAL:
                self.db.execute('UPDATE flow_steps SET status=? WHERE run_id=? AND transition_id=?',('cancelled',rid,step['transition_id']))
        return cancelled

    async def notify_cancelled(self,gid):
        try:await self.hive.goals.notify_cancelled(gid)
        except Exception as exc:
            from .hive import HiveError
            if not isinstance(exc,HiveError) or exc.status!=404:raise
            goal=self.hive.goals.get(gid)
            recipients={goal.get('claimed_by'),goal.get('assignee')}-{None}
            if not any(not self.db.one('SELECT 1 FROM agents WHERE id=? AND deleted=0',(aid,)) for aid in recipients):raise
            # A deleted holder cannot acknowledge; notify any remaining recipient.
            for aid in recipients:
                if self.db.one('SELECT 1 FROM agents WHERE id=? AND deleted=0',(aid,)):
                    await self.hive.send_to_agent(aid,f"[GOAL-CANCELLED {gid}] stop and acknowledge with cancel-ack",sender='hive:goals',extra={'event':'goal_cancelled','goal_id':gid})

    async def cancel(self,session,rid):
        with self.transaction():
            run=self.db.one('SELECT * FROM flow_runs WHERE id=?',(rid,))
            if not run:raise self.error(404,'not_found','no such run')
            self.access(session,run['swarm_id'],True)
            self.db.update('flow_runs',rid,{'status':'cancelled','updated_at':now()});goals=self._cancel_goals(rid)
        for gid in goals:self.hive.goals._emit(gid);await self.notify_cancelled(gid)
        return self.get(session,rid)

    def completion(self,goal,params):
        if goal['status']!='done':return
        if any(g['id']!=goal['id'] and g['status'] in UNFINISHED for g in self.family(goal['id'])):
            raise self.error(409,'delegated_work_incomplete','completion leaves unfinished subtasks')
        data=json.loads(goal.get('result_data') or '{}')
        binding=json.loads(goal['binding'])
        if not goal.get('claimed_by') or not isinstance(data,dict) or not str(goal.get('result') or '').strip() or (data.get('binding')!=binding and data.get('binding_digest')!=binding_digest(binding)):
            raise self.error(409,'completion_unverified','completion lacks a bound worker result')
        if 'result_schema' in params and ('proposal' not in data or validate_result(data['proposal'],params['result_schema'])):
            raise self.error(409,'completion_unverified','completion no longer satisfies its result schema')
        if params['review']=='person':
            result_digest='sha256:'+hashlib.sha256((goal.get('result_data') or goal.get('result') or '').encode()).hexdigest()
            acceptance=self.db.one("SELECT 1 FROM goal_reviews WHERE goal_id=? AND action='accept' AND by=? AND result_digest=?",(goal['id'],goal.get('reviewed_by'),result_digest))
            if not (goal.get('reviewed_by') or '').startswith('user:u_') or not acceptance:
                raise self.error(409,'completion_unreviewed','completion lacks a matching named-person acceptance')

    def _advance(self,rid):
        announcements=[];cancelled=[]
        with self.transaction():
            run=self.db.one('SELECT * FROM flow_runs WHERE id=?',(rid,))
            if not run or run['status']!='running':return announcements,cancelled
            try:
                if run['actor_kind']=='agent':self.agent_run_access(run)
                else:self.access({'token_hash':run['session_hash']},run['swarm_id'],True,expired_ok=True)
                _,row,flow=self.source(run['artifact_id'],run['revision'])
                if row['digest']!=run['digest'] or not self.db.one('SELECT 1 FROM flow_adoptions WHERE artifact_id=? AND revision=? AND digest=?',(run['artifact_id'],run['revision'],run['digest'])):
                    raise self.error(409,'adoption_revoked','revision adoption is no longer current')
                params=self.plan(flow,run['swarm_id'])
                es={e['id']:e for e in flow['elements']}
                steps={s['transition_id']:s for s in self.db.all('SELECT * FROM flow_steps WHERE run_id=?',(rid,))}
                for tid,step in steps.items():
                    goal=self.db.one('SELECT * FROM goals WHERE id=?',(step['goal_id'],))
                    if goal:
                        binding=json.loads(goal.get('binding') or '{}');p=params[tid]
                        if binding!=json.loads(step['binding']) or goal['swarm_id']!=run['swarm_id'] or goal['created_by']!=run['actor'] or (goal['title'],goal['detail'],goal['assignee'],goal['priority'])!=(p['title'],p['detail'],p['assignee'],p['priority']):
                            raise self.error(409,'goal_binding_changed','a transition task no longer matches its admitted intent')
                        self.completion(goal,p)
                        if goal['status']=='stalled':raise self.error(409,'step_stalled','step requires attention')
                        step['status']=goal['status']
                for tid,step in steps.items():
                    if step['status']!='pending':continue
                    t=es[tid];event=es[t['trigger']]
                    ready=event['type']=='run.start'
                    if not ready:
                        source=steps[event['props']['source_transition']]
                        expected='done' if event['type']=='goal.done' else 'failed'
                        ready=source['status']==expected
                        if source['status'] in TERMINAL and not ready:step['status']='skipped'
                    if not ready:continue
                    p=params[tid]
                    self.hive.goals._create_record(run['swarm_id'],p['title'],p['detail'],p['priority'],
                        created_by=run['actor'],assignee=p['assignee'],binding=json.loads(step['binding']),
                        deadline_minutes=p['deadline_minutes'],goal_id=step['goal_id'],emit=False)
                    step['status']='open';announcements.append(step['goal_id'])
                    self._fault('after-goal-insert')
                for tid,step in steps.items():self.db.execute('UPDATE flow_steps SET status=? WHERE run_id=? AND transition_id=?',(step['status'],rid,tid))
                if all(s['status'] in TERMINAL for s in steps.values()):
                    status='failed' if any(s['status'] in {'failed','cancelled'} for s in steps.values()) else 'done'
                    self.db.update('flow_runs',rid,{'status':status,'updated_at':now()})
                self._fault('before-commit')
            except Exception as exc:
                # Domain refusals atomically halt existing work; infrastructure errors
                # roll back and retry. Do not convert a partial insert into success.
                from .hive import HiveError
                if not isinstance(exc,HiveError):raise
                self.db.update('flow_runs',rid,{'status':'blocked','reason':exc.code,'updated_at':now()})
                cancelled=self._cancel_goals(rid);announcements=[]
        self._fault('after-commit')
        return announcements,cancelled

    async def reconcile(self):
        for run in self.db.all("SELECT id FROM flow_runs WHERE status='running' ORDER BY created_at LIMIT 100"):
            announcements,cancelled=self._advance(run['id'])
            for gid in announcements:
                goal=self.hive.goals._emit(gid)
                # Recheck cancellation before notifications; notifications themselves
                # are advisory, and may be lost/replayed across process failure.
                if goal['status']!='cancelled':await self.hive.goals.announce(goal)
            for gid in cancelled:self.hive.goals._emit(gid);await self.notify_cancelled(gid)
