"""Candidate app lifecycle: reviewed existing minds, stable hooks, revoke first.

No fleet, budget increase or remote identity. Named-admin authority is stored for
audited reconciliation; background retries do not invent an approving person.
"""
import asyncio
import datetime
import fnmatch
import hashlib
import json
from .db import new_id, now
from .programs import ProgramContext
from .program_actions import named_person, digest


class ProgramAttachments:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self.lock = asyncio.Lock()
        self.db.execute("CREATE TABLE IF NOT EXISTS app_activations(program TEXT,swarm TEXT,active INTEGER,by_person TEXT,PRIMARY KEY(program,swarm))")
        self.db.execute("""CREATE TABLE IF NOT EXISTS app_attachments(id TEXT PRIMARY KEY,program TEXT,swarm TEXT,mind TEXT,actor TEXT,scope TEXT,policy TEXT,expires TEXT,status TEXT,by_person TEXT,revoked_by TEXT,request_key TEXT,payload_digest TEXT,UNIQUE(by_person,program,request_key))""")
        if 'binding' not in {c['name'] for c in self.db.all('PRAGMA table_info(app_attachments)')}:
            self.db.execute('ALTER TABLE app_attachments ADD COLUMN binding TEXT')   # r2.6: optional program-owned binding object
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS app_one_attachment ON app_attachments(program,mind) WHERE status IN ('binding','active')")

    def admin(self, actor):
        if actor.get('kind') != 'person' or actor.get('role') != 'admin' or actor.get('local_operator') or not named_person(actor.get('principal')):
            raise self.hive.error(403,'person_required','a named signed-in admin must review app access')

    # ---- J3 host R7: the one exception to admin-only attachment (studio_makers.py) ---------------------------------------

    @staticmethod
    def host_key(mind_id):
        """request_key of the host's attachment row for one personal Studio maker (unique per person, program and mind)."""
        from .studio_makers import HOST_ATTACH_KEY
        return f"{HOST_ATTACH_KEY}:{mind_id}"

    @staticmethod
    def is_host_row(row):
        from .studio_makers import HOST_ATTACH_KEY
        return str((row or {}).get('request_key') or '').startswith(HOST_ATTACH_KEY + ':')

    @staticmethod
    def hooked(entry):
        return all(callable(getattr(entry['module'], hook, None)) for hook in ('offer', 'bind', 'unbind'))

    @staticmethod
    def member_attach(entry):
        """J3 host R8.3 (Dot -> Design contract 2026-10-20): the app's own declaration that a person's host-made Studio
        maker may hold exactly these actions without an admin act, read from the module attribute ``member_attach``. Valid
        only as a dict with exactly the keys actions and channels; channels None or []; actions a non-empty list of unique
        strings, each one the app offers to minds. "Offered" is computed WITHOUT calling the app's admin-gated hooks: the
        host-loaded describe()'s actions with agents True (exactly what the reviewed Design offer() returns). Returns a
        copy of that exact scope, or None when absent or malformed (fails closed: treated as absent).
        Kimi on Design 0.4.21: subset OR EQUAL (the 0.4.21 declaration names every action offered to minds). The copy is
        deep (new lists, scalars only), so nothing stored ever references the module's dict; an existing attachment's
        scope is the stored row's and is never re-read from the live module. The declaration is honoured only for an
        entry loaded from its digest-pinned release (pinned_member_attach); any change to it needs a new reviewed,
        pinned app version."""
        try:
            declared = getattr(entry['module'], 'member_attach', None)
            if type(declared) is not dict or set(declared) != {'actions', 'channels'}:
                return None
            actions, channels = declared['actions'], declared['channels']
            if not (channels is None or (type(channels) is list and not channels)):
                return None
            offered = {a.get('id') for a in ((entry.get('describe') or {}).get('actions') or [])
                       if isinstance(a, dict) and a.get('agents') is True}
            if (type(actions) is not list or not actions or len(actions) != len(set(actions))
                    or any(type(a) is not str or a not in offered for a in actions)):
                return None
            return {'actions': list(actions), 'channels': None if channels is None else []}
        except Exception:   # noqa: BLE001
            return None

    def pinned_member_attach(self, entry):
        """J3 host R8.3 (Kimi on Design 0.4.21): member_attach bound to the reviewed app identity. Honoured only when the
        loaded entry is the digest-pinned release (HIVE_APP_PINS through Programs.pinned_release, which re-runs _ready and
        so the pin's integrity check), its loaded source digest equals the pin's, and it has a release path. An unpinned
        entry, a digest that differs or cannot be verified, or any error: None (fail closed). Changing the declaration
        therefore needs a new reviewed, pinned version of the app."""
        try:
            pinned = self.hive.programs.pinned_release(entry['id'])
            if (not isinstance(pinned, dict) or not entry.get('path') or not isinstance(pinned.get('digest'), str)
                    or not pinned['digest'].startswith('sha256:') or entry.get('digest') != pinned['digest']):
                return None
        except Exception:   # noqa: BLE001
            return None
        return self.member_attach(entry)

    def host_scope(self, entry):
        """The scope the host may attach a personal Studio maker with, or None (refused 409 studio_maker_attach_unsupported;
        studio_makers.template_ready False). A hook-free app: every action it offers minds, no channels (R7, unchanged).
        J3 host R8.3: a hooked app (offer/bind/unbind) only with a valid member_attach declaration from its digest-pinned
        release, and then exactly the declared scope; no hook is ever called. A partly hooked app (e.g. bind alone), or a hooked app with no valid
        declaration, stays refused."""
        if self.hooked(entry):
            return self.pinned_member_attach(entry)
        if callable(getattr(entry['module'], 'bind', None)):
            return None
        actions = [a['id'] for a in ((entry.get('describe') or {}).get('actions') or []) if a.get('agents') is True]
        return {'actions': actions, 'channels': None}

    def host_attach_studio_maker(self, program, mind_id, principal):
        """Jon 2026-10-19 ("each member gets their own Studio maker mind that runs on their own key"): the host attaches a
        person's own Studio maker to the Studio app, in place of an admin. Narrow and audited: only the Studio program
        (HIVE_STUDIO_PROGRAM), only the mind the host made and bound to this person (person_minds), in its own Studio
        swarm and owned by them. Anything else is 403 attachment_refused and nothing is written. No activation row is
        written (one would make the app's attachments required in every swarm, ProgramAttachments.required); R8.2: the
        app is active in that one swarm through host_studio_active, derived from this row and the binding. No app hook
        runs: an app that has attachment hooks (offer/bind/unbind) is refused 409 studio_maker_attach_unsupported, because
        running its bind for a member is a reviewed admin act. Idempotent: an active row for this mind is returned.
        J3 host R8.3: a hooked app that exports a valid ``member_attach`` declaration (member_attach above) is attached
        with exactly that declared scope, still running no hook (so its unbind never runs either: finish_unbind ends a
        host row without hooks), recorded as HOST_ACTOR and audited with the declared scope; every check above is unchanged."""
        from .studio_makers import HOST_ACTOR, program_setting
        makers = getattr(self.hive, 'studio_makers', None)
        refused = self.hive.error(403, 'attachment_refused', 'active unexpired reviewed attachment required')
        if makers is None or program != program_setting() or not named_person(principal) or makers.person_of(mind_id) != principal:
            raise refused
        binding = makers.binding(principal)
        mind = self.db.one('SELECT * FROM agents WHERE id=? AND deleted=0', (mind_id,))
        if mind is None or binding is None or binding['agent_id'] != mind_id or mind['swarm_id'] != binding['swarm_id'] \
                or mind.get('owner') != principal:
            raise refused
        entry = self.hive.programs._ready(program)
        scope = self.host_scope(entry)
        if scope is None:
            raise self.hive.error(409, 'studio_maker_attach_unsupported', 'This Studio app attaches minds through its own '
                                  'review; ask an admin to attach your maker.')
        live = self.db.one("SELECT * FROM app_attachments WHERE program=? AND mind=? AND status IN ('binding','active')",
                           (program, mind_id))
        if live is not None:
            if live['status'] == 'active' and live['swarm'] == mind['swarm_id']:
                return self.view(live)
            raise self.hive.error(409, 'already_attached', 'mind already has an attachment for this app')
        declared = self.hooked(entry)        # R8.3: the scope is the app's member_attach declaration, exactly
        policy = {a: 'ask' for a in scope['actions']}
        key = self.host_key(mind_id)
        row = {'id': new_id('at'), 'program': program, 'swarm': mind['swarm_id'], 'mind': mind_id, 'actor': HOST_ACTOR,
               'scope': json.dumps(scope), 'binding': None, 'policy': json.dumps(policy), 'expires': None, 'status': 'active',
               'by_person': principal, 'revoked_by': None, 'request_key': key,
               'payload_digest': digest({'program': program, 'mind': mind_id, 'swarm': mind['swarm_id'], 'by': HOST_ACTOR})}
        with self.db.transaction():
            # an ended row with this key (an earlier attachment of the same mind, revoked) is kept, renamed; never reopened
            self.db.execute("UPDATE app_attachments SET request_key = request_key || ':ended:' || id WHERE by_person=? AND "
                            "program=? AND request_key=? AND status IN ('revoked','unbind_pending')", (principal, program, key))
            self.db.insert('app_attachments', row)
            makers._audit(principal, mind_id, 'attached', attachment=row['id'], program=program, swarm_id=mind['swarm_id'],
                          **({'by': HOST_ACTOR, 'scope_source': 'member_attach', 'actions': scope['actions'],
                              'channels': scope['channels']} if declared else {}))
        self.hive.events.publish('program.attachment', attachment=self.view(self.row(row['id'])))
        return self.view(self.row(row['id']))

    def entry(self, program):
        entry = self.hive.programs._ready(program)
        if not all(callable(getattr(entry['module'], hook, None)) for hook in ('offer','bind','unbind')):
            raise self.hive.error(409,'hooks_missing','program does not provide reviewed attachment hooks')
        return entry

    def required(self, entry):
        # P14: a person app's scoped activation (app_person_activations) is never read here, so activating it for one
        # person makes the app attachment-required nowhere else
        return callable(getattr(entry['module'],'bind',None)) or bool(self.db.one('SELECT 1 FROM app_activations WHERE program=?',(entry['id'],)))

    def row(self, aid):
        row = self.db.one('SELECT * FROM app_attachments WHERE id=?',(aid,))
        if not row: raise self.hive.error(404,'not_found','attachment not found')
        return row

    def view(self, row):
        scope = json.loads(row['scope'])
        return {'id':row['id'],'program':row['program'],'swarm_id':row['swarm'],'mind_id':row['mind'],'actor':row['actor'],**scope,'policy':json.loads(row['policy']),'expires_at':row['expires'],**({'binding':json.loads(row['binding'])} if row.get('binding') else {}),'status':row['status'],'granted_by':row['by_person'],'revoked_by':row['revoked_by']}

    def expired(self, value):
        return bool(value and datetime.datetime.fromisoformat(value.replace("Z", "+00:00")) <= datetime.datetime.now(datetime.timezone.utc))

    def active(self, program, swarm):
        row = self.db.one('SELECT active FROM app_activations WHERE program=? AND swarm=?',(program,swarm))
        if row is not None:
            return bool(row['active'])     # an admin's row decides, its deactivation included
        return self.host_studio_active(program, swarm) or self.host_person_active(program, swarm)

    def host_person_active(self, program, swarm):
        """P14: a person app is active in one person's own context, and only there, derived from the host's scoped
        activation, its binding and the current install review (person_apps.active_here). Like host_studio_active it is
        never an app_activations row, so required() and every other swarm are unchanged. Fails closed."""
        apps = getattr(self.hive, 'person_apps', None)
        return bool(apps is not None and apps.active_here(program, swarm))

    def host_studio_active(self, program, swarm):
        """J3 host R8.2 (Design, Mac UI): the Studio program is active in a person's own Studio swarm, and only there,
        derived from the host's audited setup (never a stored activation row: any row makes the app's attachments
        required in every swarm, see required). True only while Studio is on, ``program`` is the Studio program, ``swarm``
        is the swarm a person_minds studio_maker binding names, that swarm is open and owned by that person, and the
        host's own attachment row for the bound maker is active, unexpired and theirs in that swarm. required() reads
        app_activations alone, so no other swarm's activation or attachment requirement changes. Fails closed."""
        try:
            from .studio_makers import PURPOSE, program_setting
            makers = getattr(self.hive, 'studio_makers', None)
            if makers is None or not makers.enabled() or program != program_setting():
                return False
            b = self.db.one('SELECT principal, agent_id FROM person_minds WHERE swarm_id=? AND purpose=? AND agent_id IS NOT NULL',
                            (swarm, PURPOSE))
            if b is None:
                return False
            home = self.db.one('SELECT owner FROM swarms WHERE id=? AND archived_at IS NULL', (swarm,))
            if home is None or home.get('owner') != b['principal']:
                return False
            att = self.db.one("SELECT * FROM app_attachments WHERE program=? AND swarm=? AND mind=? AND status='active' "
                              "AND request_key=?", (program, swarm, b['agent_id'], self.host_key(b['agent_id'])))
            return bool(att) and att['by_person'] == b['principal'] and not self.expired(att['expires'])
        except Exception:   # noqa: BLE001
            return False

    async def activate(self, actor, program, swarm):
        self.admin(actor); self.entry(program); self.hive.swarm(swarm)
        async with self.lock:
            self.db.execute('INSERT INTO app_activations VALUES (?,?,1,?) ON CONFLICT(program,swarm) DO UPDATE SET active=1,by_person=excluded.by_person',(program,swarm,actor['principal']))
        self.hive.events.publish('program.activation',program=program,swarm_id=swarm,active=True)
        return {'program':program,'swarm_id':swarm,'active':True}

    async def offer(self, actor, program, mind_id):
        self.admin(actor); entry = self.entry(program); mind = self.hive._agent_row(mind_id)
        if not self.active(program,mind['swarm_id']): raise self.hive.error(403,'app_inactive','activate the app in this swarm first')
        ctx = ProgramContext(self.hive,mind['swarm_id'],entry); ctx.actor = actor
        return await self.hive.programs._call(entry,entry['module'].offer,ctx,{'id':mind_id,'swarm_id':mind['swarm_id']})

    def context(self, row, principal):
        entry = self.entry(row['program']); ctx = ProgramContext(self.hive,row['swarm'],entry)
        ctx.actor = self.hive.program_actions.person_actor({'principal':principal,'kind':'person'},'admin',row['swarm'])
        ctx.command = {'idempotency_key':row['id']}
        return entry, ctx

    async def attach(self, actor, program, data):
        self.admin(actor)
        if set(data)-{'mind_id','actions','channels','policy','expires_at','idempotency_key','binding'}:
            raise self.hive.error(400,'bad_request','unknown attachment fields')
        key = data.get('idempotency_key')
        if not isinstance(key,str) or not 1<=len(key)<=120: raise self.hive.error(400,'bad_request','stable request key required')
        offered = await self.offer(actor,program,str(data.get('mind_id','')))
        mind = self.hive._agent_row(data['mind_id']); actions = data.get('actions'); channels = data.get('channels'); policy = data.get('policy')
        declared = {a['id'] for a in self.entry(program)['describe']['actions'] if a.get('agents') is True}
        if not isinstance(actions,list) or not actions or any(not isinstance(a,str) or a not in declared or a not in offered['actions_offered'] for a in actions) or len(actions)!=len(set(actions)):
            raise self.hive.error(400,'bad_scope','review a subset of offered actions')
        if channels is not None and (not isinstance(channels,list) or any(not isinstance(c,str) or c not in offered['channels_offered'] for c in channels) or len(channels)!=len(set(channels))):
            raise self.hive.error(400,'bad_scope','review a subset of offered channels')
        if not isinstance(policy,dict) or set(policy)!=set(actions) or any(v not in ('allow','ask') for v in policy.values()):
            raise self.hive.error(400,'bad_scope','one allow/ask decision per action required')
        expires = data.get('expires_at')
        if expires is not None:
            try:
                parsed = datetime.datetime.fromisoformat(expires.replace('Z','+00:00'))
                if not parsed.tzinfo or parsed<=datetime.datetime.now(datetime.timezone.utc): raise ValueError()
                expires = parsed.astimezone(datetime.timezone.utc).isoformat().replace('+00:00','Z')
            except (ValueError,TypeError,AttributeError): raise self.hive.error(400,'bad_request','future timezone-aware expiry required')
        binding = data.get('binding')
        if binding is not None:
            text = lambda v: isinstance(v,str) and 0<len(v)<=200
            if (not isinstance(binding,dict) or set(binding)!={'kind','id','version','artifact_id','revision','digest'}
                    or not all(text(binding[k]) for k in ('kind','id','version','artifact_id','digest'))
                    or not isinstance(binding['revision'],int) or isinstance(binding['revision'],bool) or binding['revision']<1):
                raise self.hive.error(400,'bad_request','binding is {kind, id, version, artifact_id, revision, digest}')
            if getattr(self.entry(program)['module'],'BIND_ACCEPTS_BINDING',False) is not True:
                raise self.hive.error(409,'binding_unsupported','this app does not accept a binding (BIND_ACCEPTS_BINDING)')
        payload = digest(data)   # includes the binding
        async with self.lock:
            row = self.db.one('SELECT * FROM app_attachments WHERE by_person=? AND program=? AND request_key=?',(actor['principal'],program,key))
            if row:
                if row['payload_digest']!=payload: raise self.hive.error(409,'idempotency_conflict','review payload changed')
                if row['status']=='active': return self.view(row)
                if row['status']!='binding': raise self.hive.error(409,'attachment_ended','review a new attachment')
            else:
                if self.db.one("SELECT id FROM app_attachments WHERE program=? AND mind=? AND status IN ('binding','active')",(program,mind['id'])):
                    raise self.hive.error(409,'already_attached','mind already has an attachment for this app')
                row = {'id':new_id('at'),'program':program,'swarm':mind['swarm_id'],'mind':mind['id'],'actor':None,'scope':json.dumps({'actions':actions,'channels':channels}),'binding':json.dumps(binding,sort_keys=True) if binding else None,'policy':json.dumps(policy),'expires':expires,'status':'binding','by_person':actor['principal'],'revoked_by':None,'request_key':key,'payload_digest':payload}
                self.db.insert('app_attachments',row)
            await self.finish_bind(row)
            return self.view(self.row(row['id']))

    def queue_notice(self, row, phase, principal):
        """Persist alongside the authority transition; never wake or start a mind."""
        seq = self.db.one('SELECT COALESCE(MAX(hub_seq),0) AS seq FROM messages WHERE agent_id=?',(row['mind'],))['seq'] + 1
        scope = json.loads(row['scope'])
        metadata = {'type':'program.attachment','phase':phase,'attachment_id':row['id'],'program':row['program'],'swarm_id':row['swarm'],'actor':row.get('actor'),'policy':json.loads(row['policy']),**scope,'expires_at':row['expires']}
        text = (f"Access to {row['program']} is active within the reviewed scope. Existing policies and spending limits still apply."
                if phase == 'active' else f"Host access to {row['program']} has ended. Do not submit new actions under this attachment. Committed history remains; app cleanup may still be pending.")
        message = {'id':'m_'+hashlib.sha256((row['id']+':'+phase).encode()).hexdigest()[:24], 'agent_id':row['mind'],'conversation_id':'c_'+row['mind'],
                   'direction':'in','sender':principal,'text':text,'hub_seq':seq,'created_at':now(),'extra':json.dumps(metadata)}
        self.db.insert('messages',message)
        return message

    async def publish_notice(self, message):
        self.hive.events.publish('message',message=self.hive.message_view(message))
        # Delivery to an existing connection is best effort; durable inbox replay
        # covers disconnect/failure. Unlike send_to_agent this never calls wake.
        await self.hive.deliver(message['agent_id'],message)

    async def finish_bind(self, row):
        row = self.row(row['id'])
        if row['status'] != 'binding' or not self.active(row['program'],row['swarm']) or self.expired(row['expires']): return
        entry,ctx = self.context(row,row['by_person'])
        args = [ctx,{'id':row['mind'],'swarm_id':row['swarm']},json.loads(row['scope']),row['id']]
        if getattr(entry['module'],'BIND_ACCEPTS_BINDING',False) is True and row.get('binding'):   # older hooks never see it
            args.append(json.loads(row['binding']))
        result = await self.hive.programs._call(entry,entry['module'].bind,*args)
        if not isinstance(result,dict) or not isinstance(result.get('actor'),str) or not result['actor']:
            raise self.hive.error(400,'bad_binding','bind must return stable actor')
        if not self.active(row['program'],row['swarm']) or self.expired(row['expires']): return
        with self.db._lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                for action,mode in json.loads(row['policy']).items():
                    self.db.insert('policy_rules',{'id':new_id('r'),'scope':'agent:'+row['mind'],'skill':'program:'+row['program']+':'+action,'mode':mode,'note':'attachment:'+row['id'],'created_at':now(),'granted_by':row['by_person']})
                self.db.update('app_attachments',row['id'],{'status':'active','actor':result['actor']})
                message = self.queue_notice(dict(row,actor=result['actor']),'active',row['by_person'])
                self.db.execute('COMMIT')
            except Exception:
                self.db.execute('ROLLBACK'); raise
        self.hive.events.publish('program.attachment',attachment=self.view(self.row(row['id'])))
        await self.publish_notice(message)

    async def revoke(self, actor, aid):
        self.admin(actor)
        async with self.lock:
            row = self.row(aid)
            message = None
            if row['status'] not in ('revoked','unbind_pending'):
                with self.db._lock:
                    self.db.execute('BEGIN IMMEDIATE')
                    try:
                        self.db.execute('DELETE FROM policy_rules WHERE note=?',('attachment:'+aid,))
                        self.db.update('app_attachments',aid,{'status':'unbind_pending','revoked_by':actor['principal']})
                        message = self.queue_notice(row,'revoked',actor['principal'])
                        self.db.execute('COMMIT')
                    except Exception: self.db.execute('ROLLBACK'); raise
            if message is not None: await self.publish_notice(message)
            await self.finish_unbind(self.row(aid))
            return self.view(self.row(aid))

    async def finish_unbind(self,row):
        if row['status']=='revoked': return
        if self.is_host_row(row):
            # R7: the host's own row for a personal Studio maker ran no app hook when it was made, so none runs now
            self.db.update('app_attachments',row['id'],{'status':'revoked'})
            self.hive.events.publish('program.attachment',attachment=self.view(self.row(row['id'])))
            return
        entry,ctx = self.context(row,row['revoked_by'] or row['by_person'])
        try:
            await self.hive.programs._call(entry,entry['module'].unbind,ctx,self.view(row),row['id'])
        except Exception:
            self.db.update('app_attachments',row['id'],{'status':'unbind_pending'}); raise
        self.db.update('app_attachments',row['id'],{'status':'revoked'})
        self.hive.events.publish('program.attachment',attachment=self.view(self.row(row['id'])))

    async def deactivate(self,actor,program,swarm):
        self.admin(actor)
        self.db.execute('UPDATE app_activations SET active=0 WHERE program=? AND swarm=?',(program,swarm))
        for row in self.db.all("SELECT * FROM app_attachments WHERE program=? AND swarm=? AND status IN ('binding','active','unbind_pending')",(program,swarm)):
            try: await self.revoke(actor,row['id'])
            except Exception: pass  # access already stopped by inactive activation
        return {'program':program,'swarm_id':swarm,'active':False}

    def authorize(self,program,agent,action):
        row = self.db.one("SELECT * FROM app_attachments WHERE program=? AND mind=? AND status='active'",(program,agent['id']))
        if not row or row['swarm'] != agent['swarm_id'] or not self.active(program,agent['swarm_id']) or self.expired(row['expires']) or action not in json.loads(row['scope'])['actions']:
            raise self.hive.error(403,'attachment_refused','active unexpired reviewed attachment required')
        rules = self.db.all('SELECT * FROM policy_rules WHERE note=? AND skill=?',('attachment:'+row['id'],'program:'+program+':'+action))
        if len(rules)!=1: raise self.hive.error(403,'attachment_refused','attachment rule unavailable')
        # An attachment cannot weaken another explicit app-action restriction.
        scopes = {'agent:'+agent['id'], 'swarm:'+agent['swarm_id'], 'hive'}
        skill = 'program:'+program+':'+action
        modes = [r['mode'] for r in self.db.all("SELECT * FROM policy_rules WHERE skill LIKE 'program:%' AND (expires_at IS NULL OR expires_at > ?)",(__import__('time').time(),))
                 if r['scope'] in scopes and not (r.get('note') or '').startswith('attachment:') and fnmatch.fnmatchcase(skill,r['skill'])]
        mode = 'deny' if 'deny' in modes else 'ask' if 'ask' in modes else rules[0]['mode']
        out = {'id':row['id'],'actor':row['actor'],'channels':json.loads(row['scope'])['channels']}
        if row.get('binding'): out['binding'] = json.loads(row['binding'])
        return out,mode

    async def reconcile(self):
        for row in self.db.all("SELECT * FROM app_attachments WHERE status IN ('binding','active','unbind_pending')"):
            if self.is_host_row(row) and row['status'] != 'unbind_pending':
                continue    # R7: a personal Studio maker's host row lives with its binding (studio_makers), no activation
            try:
                if row['status']=='unbind_pending':
                    async with self.lock: await self.finish_unbind(row)
                elif not self.active(row['program'],row['swarm']) or self.expired(row['expires']):
                    actor = self.hive.program_actions.person_actor({'principal':row['by_person'],'kind':'person'},'admin',row['swarm'])
                    await self.revoke(actor,row['id'])
                elif row['status']=='binding':
                    async with self.lock: await self.finish_bind(row)
            except Exception: pass  # pending states retain zero authority; retry later
