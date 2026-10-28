"""Host integration candidate: durable shared liabilities, no provider dispatch.

The host supplies current budgets/spend inside the admission transaction and
records actual usage inside settlement. This module grants no call authority.
"""
import hashlib,json,re,time
from decimal import Decimal,ROUND_CEILING,ROUND_FLOOR

def micros(value,rounding=ROUND_CEILING):
    amount=Decimal(str(value))
    if not amount.is_finite() or amount<0:raise ValueError('Finite nonnegative cost required')
    return int((amount*1_000_000).to_integral_value(rounding=rounding))

# A budget row's label is "<subject>:<period>"; the subject is what the limit is about (the hive, a team, a mind, a person,
# a key). Liabilities are counted by subject, so a rule that appears or changes after a call was reserved still sees it
# (OmegaReview FIX-FIRST r2 P1: a hold made under hive:hard-total was invisible to a later hive:month).
# own hive H1.1: keyuse:<hash> is a key-limit scope (key owner, key or *, grantee; ownhive.py), counted by subject like the rest.
SUBJECT=re.compile(r'^(hive|swarm:s_[0-9a-f]{8}|agent:a_[0-9a-f]{8}|person:u_[0-9a-f]{8}|keyuse:[0-9a-f]{16}|key:(?:k_[0-9a-f]{8}|env:[a-z0-9_-]+)):(day|month|total|hard-total)$')
def subject_of(label):
    m=SUBJECT.match(label)
    return m.group(1) if m else None

class BudgetExhausted(ValueError):
    """A reservation refused by one budget row: which row (its label), its limit, the recorded spend, the open holds
    already counted against it and this call's ceiling, all in USD. The message is the one it always had."""
    def __init__(self,scope,limit,spent,held,estimate):
        super().__init__('Shared budget exhausted: '+scope)
        self.scope,self.limit_usd,self.spent_usd,self.held_usd,self.estimate_usd=scope,limit,spent,held,estimate

class Reservations:
    def __init__(self,db):
        self.db=db
        db.execute('CREATE TABLE IF NOT EXISTS cost_reservations (id TEXT PRIMARY KEY, binding TEXT NOT NULL, maximum INTEGER NOT NULL, state TEXT NOT NULL, actual INTEGER)')
        db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_scopes (reservation TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(reservation,scope))')
        db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_details (reservation TEXT PRIMARY KEY, metadata TEXT NOT NULL, observation TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_subjects (reservation TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY(reservation,subject))')
        db.execute('CREATE INDEX IF NOT EXISTS cost_reservation_subjects_subject ON cost_reservation_subjects(subject)')
        db.execute('CREATE INDEX IF NOT EXISTS cost_reservation_scopes_scope ON cost_reservation_scopes(scope)')   # an Ask thread's own spend (sessions.py)
        db.execute('CREATE TABLE IF NOT EXISTS cost_overruns (reservation TEXT PRIMARY KEY, agent TEXT, maximum INTEGER NOT NULL, actual INTEGER NOT NULL, source TEXT NOT NULL, at REAL NOT NULL)')
        if 'dispatched_at' not in {r[1] for r in db._conn.execute('PRAGMA table_info(cost_reservations)')}:
            db.execute('ALTER TABLE cost_reservations ADD COLUMN dispatched_at REAL')
        if 'unknown_at' not in {r[1] for r in db._conn.execute('PRAGMA table_info(cost_reservations)')}:
            db.execute('ALTER TABLE cost_reservations ADD COLUMN unknown_at REAL')
        if 'reserved_at' not in {r[1] for r in db._conn.execute('PRAGMA table_info(cost_reservations)')}:
            db.execute('ALTER TABLE cost_reservations ADD COLUMN reserved_at REAL')
        # Schema only. Recovery of a previous process's calls is recover_startup, run once by the lifetime owner
        # (hive.core.exclusive.startup_recovery); constructing Reservations never rewrites a live liability (OPEN-17).
    @staticmethod
    def recover_startup(tx):
        """Startup step 1 of the one combined recovery, inside its transaction: a reservation still reserved or
        dispatched when the process starts has no live call behind it, so its outcome is unknown; keep the liability
        held and let a person resolve it. Returns the number of rows moved to unknown.
        r10 (Design 5d2c2a6b), kept in the assembly: recovery observes the unknown outcome now and starts its existing
        expiry clock (never inferring an earlier failure from dispatch time), and repairs older unknown rows that lack
        a clock; a second recovery keeps the earliest clock; terminal rows are unchanged."""
        observed = time.time()
        moved = tx.execute("UPDATE cost_reservations SET state='unknown', unknown_at=COALESCE(unknown_at,?) "
                           "WHERE state IN ('reserved','dispatched')", (observed,)).rowcount
        tx.execute("UPDATE cost_reservations SET unknown_at=? WHERE state='unknown' AND unknown_at IS NULL", (observed,))
        Reservations.backfill_subjects(tx)
        return moved   # the count reported is liabilities moved to unknown; clock repair and backfill are not counted
    @staticmethod
    def backfill_subjects(tx):
        """r3 (OmegaReview FIX-FIRST on f88ca6f): give every open reservation made before subjects were recorded its
        subjects, from what was recorded with it: the reserving mind, the mind's team (its CURRENT team: the team at
        reservation time was never recorded), the paying person (counted even if they paid with their own key, which
        was not recorded either: the conservative side) and the paying key. A hold that cannot be attributed in full
        gets the subject '*' as well, which every team, mind, person and key row counts. Idempotent: only reservations
        with no subject rows are touched. Inside the startup recovery transaction. Returns (backfilled, unattributed)."""
        tx.execute('CREATE TABLE IF NOT EXISTS cost_reservation_subjects (reservation TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY(reservation,subject))')
        rows=tx.execute("SELECT r.id, d.metadata FROM cost_reservations r LEFT JOIN cost_reservation_details d ON d.reservation=r.id "
                        "WHERE r.state IN ('reserved','dispatched','unknown') "
                        "AND NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id)").fetchall()
        has_agents=bool(tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").fetchone())
        done=unattributed=0
        for rid,raw in ((r[0],r[1]) for r in rows):
            subjects,whole={'hive'},True
            try:
                meta=json.loads(raw) if raw else None
            except ValueError:
                meta=None
            if not isinstance(meta,dict):
                meta,whole={},False
            agent=meta.get('agent')
            found=tx.execute('SELECT swarm_id FROM agents WHERE id=?',(agent,)).fetchone() if has_agents and isinstance(agent,str) else None
            if found is not None and SUBJECT.match('agent:'+agent+':total'):
                subjects.add('agent:'+agent)
                if found[0]:subjects.add('swarm:'+found[0])
            else:
                whole=False
            if 'payer' not in meta:
                whole=False
            elif isinstance(meta['payer'],str) and meta['payer'].startswith('user:u_'):
                if SUBJECT.match('person:'+meta['payer'][5:]+':month'):subjects.add('person:'+meta['payer'][5:])
                else:whole=False
            if 'key' not in meta:
                whole=whole and meta.get('kind')=='embeddings'   # embeddings never carried a key; chat and Ask always did
            elif meta['key']:
                if isinstance(meta['key'],str) and SUBJECT.match('key:'+meta['key']+':month'):subjects.add('key:'+meta['key'])
                else:whole=False
            if not whole:
                subjects.add('*');unattributed+=1
            for subject in sorted(subjects):
                tx.execute('INSERT OR IGNORE INTO cost_reservation_subjects(reservation,subject) VALUES(?,?)',(rid,subject))
            done+=1
        if done:
            print(f"[hive] reservation subjects backfilled for {done} open legacy holds; {unattributed} not fully attributable, "
                  "counted against every swarm, mind, person and key", flush=True)
        return done,unattributed
    def get(self,key):return self.db.one('SELECT * FROM cost_reservations WHERE id=?',(key,))
    def pending(self,label):
        """Micro-USD held by open reservations that a budget row applies to. By subject, whatever rows were in force when
        each was reserved: every open liability is the hive's; a team, mind, person or key row counts every call
        reserved for that subject, every hold marked '*' (not fully attributable) and every hold with no subjects at all (a
        legacy hold not yet backfilled): the conservative side. A label with no known subject (an Ask turn's own cap)
        counts exact-label holds only."""
        subject=subject_of(label)
        open_=" r.state IN ('reserved','dispatched','unknown')"
        if subject=='hive':
            return self.db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_)['total']
        exact=' EXISTS (SELECT 1 FROM cost_reservation_scopes s WHERE s.reservation=r.id AND s.scope=?)'
        if subject is None:
            return self.db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_+' AND'+exact,(label,))['total']
        return self.db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_+' AND ('+exact+
                           " OR EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id AND j.subject IN (?, '*'))"
                           ' OR NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id))',
                           (label,subject))['total']
    def reserve(self,key,payload,maximum,budgets,metadata=None,dispatched=False,subjects=None):
        """budgets() -> [(scope+period identifier, limit USD, recorded spend USD)].
        subjects: what the call spends against (host_subjects); recorded with the liability so every later row about
        any of them counts it. Without it, the subjects of the rows in force now (and the hive) are recorded.

        Callback runs under the same SQLite write transaction. Existing spend
        must exclude reservations; outstanding liabilities are added here.
        dispatched=True admits and marks the call dispatched in that one transaction, so a crash can never strand
        a 'reserved' row. Only a hash of the payload is kept, never the call content.
        """
        if not isinstance(key,str) or not key:raise ValueError('Request identity required')
        metadata={} if metadata is None else metadata
        if not isinstance(metadata,dict):raise ValueError('Host metadata required')
        details=json.dumps(metadata,sort_keys=True,separators=(',',':'),allow_nan=False)
        if len(details.encode())>4096:raise ValueError('Reservation metadata too large')
        ceiling=micros(maximum)
        if ceiling<=0:raise ValueError('Positive reservation required')
        payload_hash=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':'),allow_nan=False,default=str).encode()).hexdigest()
        metadata={**metadata,'payload_hash':payload_hash}
        details=json.dumps(metadata,sort_keys=True,separators=(',',':'),allow_nan=False)
        binding=hashlib.sha256(json.dumps({'payload':payload_hash,'maximum':ceiling,'metadata':metadata},sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        with self.db.transaction():
            prior=self.get(key)
            if prior:
                if prior['binding']!=binding:raise ValueError('Request identity reused with different cost or payload')
                return {**prior,'new':False}
            rows=list(budgets())
            if not rows or len({s for s,_,_ in rows})!=len(rows):raise ValueError('Exact shared budget scopes required')
            for scope,limit,spent in rows:
                held_now=self.pending(scope)
                if micros(spent)+held_now+ceiling>micros(limit,ROUND_FLOOR):
                    raise BudgetExhausted(scope,float(limit),float(spent),held_now/1_000_000,ceiling/1_000_000)
            held={'hive'}|{s for s in (subjects or ()) if s}|{s for s in (subject_of(l) for l,_,_ in rows) if s}
            self.db.execute("INSERT INTO cost_reservations(id,binding,maximum,state,dispatched_at,reserved_at) VALUES(?,?,?,?,?,?)",(key,binding,ceiling,'dispatched' if dispatched else 'reserved',time.time() if dispatched else None,time.time()))
            self.db.execute('INSERT INTO cost_reservation_details(reservation,metadata) VALUES(?,?)',(key,details))
            for scope,_,_ in rows:self.db.execute('INSERT INTO cost_reservation_scopes(reservation,scope) VALUES(?,?)',(key,scope))
            for subject in sorted(held):self.db.execute('INSERT INTO cost_reservation_subjects(reservation,subject) VALUES(?,?)',(key,subject))
            return {**self.get(key),'new':True}
    def dispatch(self,key):
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state']!='reserved':raise ValueError('Reservation cannot dispatch again')
            self.db.execute("UPDATE cost_reservations SET state='dispatched',dispatched_at=? WHERE id=?",(time.time(),key))
    def unknown(self,key):
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state'] not in {'dispatched','unknown'}:raise ValueError('No dispatched liability')
            self.db.execute("UPDATE cost_reservations SET state='unknown',unknown_at=COALESCE(unknown_at,?) WHERE id=?",(time.time(),key))
    def abort_before_dispatch(self,key):
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state']!='reserved':raise ValueError('Dispatched liability cannot be released')
            self.db.execute("UPDATE cost_reservations SET state='released' WHERE id=?",(key,))
    def settle(self,key,actual,record_usage,on_overrun=None):
        measured=micros(actual)
        with self.db.transaction():
            row=self.get(key)
            if not row:raise ValueError('Missing reservation')
            if row['state']=='settled':
                if row['actual']!=measured:raise ValueError('Settlement differs')
                return False
            if row['state']=='released':
                # A provider answered after a person released a stalled hold (Kimi N1, 2026-10-04): the money was spent,
                # so the cost is recorded and flagged, never silently dropped.
                record_usage()
                self.db.execute("UPDATE cost_reservations SET state='settled',actual=? WHERE id=?",(measured,key))
                note_overrun(self.db,key,0,measured,'late-after-release',on_overrun)
                return True
            if row['state'] not in {'dispatched','unknown'}:raise ValueError('No dispatched liability')
            # Even an unexpected overrun is recorded, never hidden by rejection.
            record_usage()
            self.db.execute("UPDATE cost_reservations SET state='settled',actual=? WHERE id=?",(measured,key))
            if measured>row['maximum']:note_overrun(self.db,key,row['maximum'],measured,'settle',on_overrun)
            return True

    def observe(self,key,observation):
        """Host-supplied provider identifiers, no authority or reconciliation claim."""
        if not isinstance(observation,dict) or set(observation)-{'response_id','resolved_model','usage_origin'}:raise ValueError('Bounded provider observation required')
        if any(not isinstance(v,str) or len(v)>200 for v in observation.values()):raise ValueError('Bounded provider observation required')
        raw=json.dumps(observation,sort_keys=True,separators=(',',':'))
        with self.db.transaction():
            if not self.get(key):raise ValueError('Missing reservation')
            self.db.execute('UPDATE cost_reservation_details SET observation=? WHERE reservation=?',(raw,key))
    def details(self,key):
        row=self.db.one('SELECT metadata,observation FROM cost_reservation_details WHERE reservation=?',(key,))
        if not row:return None
        return {'metadata':json.loads(row['metadata']),'observation':json.loads(row['observation']) if row['observation'] else None}


def host_subjects(hive,agent_id,key_id=None,payer=None,own_key=False):
    """Everything a call by this mind spends against, whether or not a rule on it exists yet: the hive, the mind, its
    team, the paying person (not on their own key, as Budgets.applicable) and the key."""
    fresh=hive._agent_row(agent_id)
    out=['hive','agent:'+fresh['id']]
    if fresh.get('swarm_id'):out.append('swarm:'+fresh['swarm_id'])
    if payer and str(payer).startswith('user:u_') and not own_key:out.append('person:'+str(payer)[5:])
    if key_id:out.append('key:'+key_id)
    out.extend(hive.ownhive.subjects(key_id,payer))   # own hive H1.1: the call's key-limit scopes, limit or not, so a later limit counts it
    return out


def host_budget_snapshot(hive,agent_id,key_id=None,payer=None,own_key=False):
    """Host-owned current caps/spend; call within Reservations.reserve transaction.

    Shared by chat and future image/video/vision routes. Period labels exclude
    a particular calendar window so unresolved prior liabilities stay held.
    """
    fresh=hive._agent_row(agent_id)   # the stored spend, not the view's 6-place rounding (OmegaReview r6)
    rows={}
    if hive.budgets.lifetime_cap_applies(fresh,None,payer,own_key):   # a $0 mind under a hive total is held by its auto limits instead (a personal mind: its person's allowance)
        rows["agent:"+fresh["id"]+":total"]=(fresh["budget_usd"] or 0,fresh["spent_usd"] or 0)
    cap=hive.budgets.hard_cap()   # HIVE_BUDGET_USD only seeds a hive with no total on the Limits page (the owner 2026-10-07)
    if cap:
        rows['hive:hard-total']=(cap,hive.budgets.hard_total_spent())
    for scope,period,limit,origin in hive.budgets.applicable(fresh,key_id,payer,own_key):
        label=scope+':'+period
        spent=hive.budgets.spent(scope,period)
        if label in rows:limit=min(limit,rows[label][0])
        rows[label]=(limit,spent)
    return [(scope,limit,spent) for scope,(limit,spent) in rows.items()]


# ---- resolving unknown liabilities (platform, 2026-10-04) ----------------------------------------
# A call whose outcome is unknown (provider error, cancellation, missing usage) keeps its worst-case
# reservation held so caps cannot be overrun.  Only a person resolves it: settle with the actual cost
# (from the provider's own billing) or release it with a reason.  Both are recorded; nothing is deleted.

def _resolutions(db):
    db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_resolutions (reservation TEXT PRIMARY KEY, action TEXT NOT NULL, '
               'actual INTEGER, reason TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at REAL NOT NULL)')


def note_overrun(db,key,maximum,actual,source,callback=None):
    """An actual cost above what was held is recorded (never hidden) and flagged to people."""
    d=db.one('SELECT metadata FROM cost_reservation_details WHERE reservation=?',(key,))
    agent=(json.loads(d['metadata']) if d else {}).get('agent')
    db.execute('INSERT OR REPLACE INTO cost_overruns VALUES (?,?,?,?,?,?)',(key,agent,maximum,actual,source,time.time()))
    if callback:
        try:callback({'reservation':key,'agent':agent,'held_usd':maximum/1_000_000,'actual_usd':actual/1_000_000,'source':source})
        except Exception:pass


def overruns(reservations):
    return [dict(r) for r in reservations.db.all('SELECT * FROM cost_overruns ORDER BY at')]


SHOWN_METADATA=('agent','model','payer','key','kind','payload_hash')


def outstanding(reservations, states=("unknown", "dispatched", "reserved")):
    db = reservations.db
    marks = ",".join("?" for _ in states)
    rows = db.all(f"SELECT r.id, r.maximum, r.state, r.dispatched_at, r.reserved_at, r.unknown_at, d.metadata, d.observation FROM cost_reservations r "
                  f"LEFT JOIN cost_reservation_details d ON d.reservation = r.id WHERE r.state IN ({marks}) ORDER BY r.rowid", tuple(states))
    out = []
    for r in rows:
        scopes = [s["scope"] for s in db.all("SELECT scope FROM cost_reservation_scopes WHERE reservation = ?", (r["id"],))]
        out.append({"id": r["id"], "state": r["state"], "held_usd": r["maximum"] / 1_000_000, "scopes": scopes,
                    "metadata": {k: v for k, v in (json.loads(r["metadata"]) if r["metadata"] else {}).items() if k in SHOWN_METADATA},
                    "observation": json.loads(r["observation"]) if r["observation"] else None,
                    # Surface audit 20: hold age, auto-settle and whether a person may resolve it now
                    "dispatched_at": r["dispatched_at"], "unknown_at": r["unknown_at"], "resolvable": resolvable(r),
                    "auto_settles_at": r["unknown_at"] + UNKNOWN_EXPIRY_SECONDS if r["unknown_at"] else None})
    return out


STALE_SECONDS = 900


def resolvable(row, moment=None):
    """Can a person resolve this liability now? An unknown one always; a dispatched or reserved one only once it has
    been stuck for STALE_SECONDS, measured from when it was sent, or reserved if never sent. A reserved call used to
    count as stuck at once (no dispatch time), so it could be released just before it was sent (Surface)."""
    if not row:
        return False
    if row["state"] == "unknown":
        return True
    if row["state"] not in ("dispatched", "reserved"):
        return False
    since = row.get("dispatched_at") or row.get("reserved_at")
    if since is None:
        return True            # rows from before reserved_at was recorded: older than this hive process
    return (moment or time.time()) - since > STALE_SECONDS


def resolve(reservations, key, action, reason, by, actual=None, record_usage=None, on_overrun=None):
    """action 'settle' (actual USD from the provider, recorded as usage) or 'release' (nothing was charged)."""
    db = reservations.db
    _resolutions(db)
    if action not in ("settle", "release"):
        raise ValueError("action is settle or release")
    reason = str(reason or "").strip()
    if not reason:
        raise ValueError("a reason is required")
    with db.transaction():
        row = reservations.get(key)
        if not resolvable(row):
            raise ValueError("only an unknown (or long-stuck) liability can be resolved")
        if action == "settle":
            measured = micros(actual)
            if record_usage:
                record_usage(measured / 1_000_000)
            db.execute("UPDATE cost_reservations SET state='settled', actual=? WHERE id=?", (measured, key))
            if measured > row["maximum"]:
                note_overrun(db, key, row["maximum"], measured, "resolve", on_overrun)
        else:
            measured = None
            db.execute("UPDATE cost_reservations SET state='released' WHERE id=?", (key,))
        db.execute("INSERT INTO cost_reservation_resolutions VALUES (?,?,?,?,?,?)",
                   (key, action, measured, reason[:500], str(by), time.time()))
    return reservations.get(key)


UNKNOWN_EXPIRY_SECONDS = 24 * 3600


def expire_unknown(reservations, record_usage_for, on_overrun=None, now=None, max_age=UNKNOWN_EXPIRY_SECONDS):
    """Kimi N2 (2026-10-04): an unknown-outcome hold must not wait on a person forever.  After max_age it settles at
    its held worst case (fail-safe: cost may be over-recorded, never lost), recorded as a resolution by 'hive:expiry'
    with an event.  record_usage_for(metadata, usd) records the usage for the call's mind."""
    import time as _time
    db = reservations.db
    _resolutions(db)
    now = now or _time.time()
    done = []
    for row in db.all("SELECT id, maximum, unknown_at FROM cost_reservations WHERE state='unknown' AND unknown_at IS NOT NULL AND unknown_at < ?",
                      (now - max_age,)):
        details = reservations.details(row["id"]) or {}
        with db.transaction():
            fresh = reservations.get(row["id"])
            if not fresh or fresh["state"] != "unknown":
                continue
            record_usage_for(details.get("metadata") or {}, row["maximum"] / 1_000_000)
            db.execute("UPDATE cost_reservations SET state='settled', actual=? WHERE id=?", (row["maximum"], row["id"]))
            db.execute("INSERT INTO cost_reservation_resolutions VALUES (?,?,?,?,?,?)",
                       (row["id"], "settle", row["maximum"], "auto: outcome unknown for 24h; settled at the held worst case",
                        "hive:expiry", now))
        done.append(row["id"])
        if on_overrun:
            with __import__("contextlib").suppress(Exception):
                on_overrun({"reservation": row["id"], "kind": "unknown-expired", "held_usd": row["maximum"] / 1_000_000,
                            "actual_usd": row["maximum"] / 1_000_000, "agent": (details.get("metadata") or {}).get("agent")})
    return done
