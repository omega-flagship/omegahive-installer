# Purpose: cost reservations: each paid call's worst case held against its limits before it is sent, then settled by
# itself, never by hand: at its real cost when it answers, released when its provider documents a refusal as unbilled,
# from OpenRouter's record of it, or, when its outcome stays unknown, at its worst case (a free model's at $0) as an
# estimate after an hour, which OpenRouter's record of the call, once it appears, or a person may correct for 30 days;
# and the spend-rate guard that paces what a mind spends on its own against every monthly allowance and cap the call is
# held against: the payer's, the hive's, and a team's or a mind's where one is set.
"""Host integration candidate: durable shared liabilities, no provider dispatch.

The host supplies current budgets/spend inside the admission transaction and
records actual usage inside settlement. This module grants no call authority.
"""
import contextlib,datetime,hashlib,json,math,re,time
from decimal import Decimal,InvalidOperation,ROUND_CEILING,ROUND_FLOOR
from zoneinfo import ZoneInfo

# A $0 model's admission floor (gateway.FREE_MODEL_RESERVE_USD). Not a worst case, so settling at it would hide a charge
# (sol R3 P1): such a hold, once unknown, blocks further calls to its model (gateway.free_reserve) until it settles, from
# OpenRouter's record or by the expiry at $0, the model's price, as an estimate a person may correct (expire_unknown).
FREE_FLOOR_MICROS=1

def micros(value,rounding=ROUND_CEILING):
    try:
        amount=Decimal(str(value))
    except InvalidOperation:   # None or a word where a cost belongs: a bad request, never a server error
        raise ValueError('Finite nonnegative cost required') from None
    if not amount.is_finite() or amount<0:raise ValueError('Finite nonnegative cost required')
    return int((amount*1_000_000).to_integral_value(rounding=rounding))

# A budget row's label is "<subject>:<period>"; the subject is what the limit is about (the hive, a team, a mind, a person,
# a key). Liabilities are counted by subject, so a rule that appears or changes after a call was reserved still sees it
# (OmegaReview FIX-FIRST r2 P1: a hold made under hive:hard-total was invisible to a later hive:month).
# own hive H1.1: keyuse:<hash> is a key-limit scope (key owner, key or *, grantee; ownhive.py), counted by subject like the rest.
SUBJECT=re.compile(r'^(hive|swarm:s_(?:[0-9a-f]{8}|[0-9a-f]{32})|agent:a_(?:[0-9a-f]{8}|[0-9a-f]{32})|person:u_(?:[0-9a-f]{8}|[0-9a-f]{32})|keyuse:[0-9a-f]{16}|key:(?:k_(?:[0-9a-f]{8}|[0-9a-f]{32})|env:[a-z0-9_-]+)):(day|month|total|hard-total)$')
def subject_of(label):
    m=SUBJECT.fullmatch(label)
    return m.group(1) if m else None


def _delegated_pending_micros(db, controller_id, label, subject):
    """Controller-only commitment from existing child and S5 books; no new ledger.

    Admission callers hold Database.transaction's existing shared lock. Active
    children retain their full unspent allocation; retired/released children keep
    actual spend and unresolved calls. Child S5 holds are inside, never added on
    top of the same funded allocation. Shared hive/swarm rows do not call this.
    """
    present = {r['name'] for r in db.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mind_children','mind_reservations')")}
    if not present:
        return 0
    if present != {'mind_children', 'mind_reservations'}:
        raise ValueError('Incomplete delegated budget ledger')
    rows = db.all("SELECT c.id AS child_id, r.id AS reservation_id, r.allocated_usd, r.released_at, "
                  "a.id AS stored_child, a.spent_usd FROM mind_children c "
                  "LEFT JOIN mind_reservations r ON r.child_id=c.id "
                  "LEFT JOIN agents a ON a.id=c.id WHERE c.controller_id=?", (controller_id,))
    if not rows:
        return 0
    from .budgets import period_start
    start = period_start(label.rsplit(':', 1)[1])
    total = 0
    for row in rows:
        if row['reservation_id'] is None or row['stored_child'] is None:
            raise ValueError('Incomplete delegated child budget identity')
        spent = micros(row['spent_usd'] or 0)
        allocation = micros(row['allocated_usd'])
        child_subject = 'agent:' + row['child_id']
        child_scopes = tuple(child_subject + ':' + p for p in ('day', 'month', 'total', 'hard-total'))
        held = db.one("SELECT COALESCE(SUM(r.maximum),0) AS m FROM cost_reservations r "
                      "LEFT JOIN cost_reservation_details d ON d.reservation=r.id "
                      "WHERE r.state IN ('reserved','dispatched','unknown') AND ("
                      "json_extract(d.metadata,'$.agent')=? OR "
                      "EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id AND j.subject=?) OR "
                      "EXISTS (SELECT 1 FROM cost_reservation_scopes s WHERE s.reservation=r.id AND s.scope IN (?,?,?,?)))",
                      (row['child_id'], child_subject, *child_scopes))['m']
        if held < 0:
            raise ValueError('Invalid delegated cost liability')
        if start is None:
            charge = spent + held
            if not row['released_at']:
                charge = max(allocation, charge)
        else:
            # The original UTC window and usage source, plus any stored spend
            # that cannot be placed in a recorded window (conservative).
            usage = db.one("SELECT COALESCE(SUM(cost_usd),0) AS all_spent, "
                           "COALESCE(SUM(CASE WHEN created_at>=? THEN cost_usd ELSE 0 END),0) AS period_spent "
                           "FROM usage WHERE agent_id=?", (start, row['child_id']))
            period_spent = micros(usage['period_spent']) + max(
                0, spent - micros(usage['all_spent'], ROUND_FLOOR))
            unspent = (max(0, allocation - micros(row['spent_usd'] or 0, ROUND_FLOOR))
                       if not row['released_at'] else 0)
            charge = period_spent + max(unspent, held)
        total += charge
    # Legacy/no-subject or explicit controller scopes can already count a known
    # child's S5 hold. Deduct that overlap once; unattributable holds stay held.
    overlap = db.one("SELECT COALESCE(SUM(r.maximum),0) AS m FROM cost_reservations r "
                     "LEFT JOIN cost_reservation_details d ON d.reservation=r.id "
                     "WHERE r.state IN ('reserved','dispatched','unknown') "
                     "AND EXISTS (SELECT 1 FROM mind_children c WHERE c.controller_id=? AND ("
                     "c.id=json_extract(d.metadata,'$.agent') OR "
                     "EXISTS (SELECT 1 FROM cost_reservation_subjects cj WHERE cj.reservation=r.id AND cj.subject='agent:'||c.id) OR "
                     "EXISTS (SELECT 1 FROM cost_reservation_scopes cs WHERE cs.reservation=r.id AND cs.scope IN "
                     "('agent:'||c.id||':day','agent:'||c.id||':month','agent:'||c.id||':total','agent:'||c.id||':hard-total')))) AND ("
                     "EXISTS (SELECT 1 FROM cost_reservation_scopes s WHERE s.reservation=r.id AND s.scope=?) OR "
                     "EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id AND j.subject IN (?, '*')) OR "
                     "NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id))",
                     (controller_id, label, subject))['m']
    if overlap < 0 or overlap > total:
        raise ValueError('Inconsistent delegated cost liability')
    return total - overlap


def pending_micros(db, label):
    """The original open S5 liabilities plus this controller's existing delegation.

    Shared with Minds.spawn so check+child insert and paid-call admission use the
    same books under the same Database.transaction lock.
    """
    subject=subject_of(label)
    open_=" r.state IN ('reserved','dispatched','unknown')"
    if subject=='hive':
        return db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_)['total']
    exact=' EXISTS (SELECT 1 FROM cost_reservation_scopes s WHERE s.reservation=r.id AND s.scope=?)'
    if subject is None:
        return db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_+' AND'+exact,(label,))['total']
    held = db.one('SELECT COALESCE(SUM(r.maximum),0) AS total FROM cost_reservations r WHERE'+open_+' AND ('+exact+
                  " OR EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id AND j.subject IN (?, '*'))"
                  ' OR NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation=r.id))',
                  (label,subject))['total']
    if subject.startswith('agent:'):
        held += _delegated_pending_micros(db, subject[6:], label, subject)
    return held


class BudgetExhausted(ValueError):
    """A reservation refused by one budget row: which row (its label), its limit, the recorded spend, the open holds
    already counted against it and this call's ceiling, all in USD. The message is the one it always had."""
    def __init__(self,scope,limit,spent,held,estimate):
        super().__init__('Shared budget exhausted: '+scope)
        self.scope,self.limit_usd,self.spent_usd,self.held_usd,self.estimate_usd=scope,limit,spent,held,estimate

def exhausted_limit(exc):
    """The limit a BudgetExhausted names, as Hive.note_refusal records it: its scope and period apart, its limit, the spend
    recorded against it, the worst cases already held against it and the refused call's own worst case, in USD."""
    scope,_,period=exc.scope.rpartition(':')
    return {'scope':scope or exc.scope,'period':period if scope else None,'limit_usd':exc.limit_usd,'spent_usd':round(exc.spent_usd,6),
            'held_usd':round(exc.held_usd,6),'call_usd':round(exc.estimate_usd,6)}

# ---- the spend-rate guard (#107, PR B) ----------------------------------------------------------------------------------
# GCRA, the one-number token bucket of ATM traffic control (ITU-T I.371 annex A; redis-cell's CL.THROTTLE and the Go
# throttled library's GCRARateLimiter are the same algorithm): each guarded limit keeps one theoretical arrival time,
# tat, in limit_rates. A month limit L refills at L / 30 days with a burst of L / 10, so a call of worst case c costs
# c x 30 days / L of tat time and is admitted while max(tat, now) + that cost <= now + 3 days (a tenth of 30 days, the
# burst's own time, whatever L is). A call bigger than the burst is admitted only when the guard is full (tat <= now),
# so it is never blocked for good. A refused call holds nothing. With $50 a month that is $1.67 a day and a $5 burst.
# Time ahead is money ahead at the limit's pace, so each row keeps the limit it was counted at (lim): when someone
# raises or lowers the limit, the next reservation scales the time ahead and the open charges by old / new, so the money
# ahead stays the same and a raised cap frees its larger burst at once instead of only shortening each wait.
# It paces only what a mind spends on its own, the runaway Jon asked it to stop (#299). A call a person's live work holds
# (Hive.present_for: their Studio session, Ask turn, Session, live Create plan or live Code request, or their message the
# mind is answering) is held by its limits alone and charges no tat (reserve's paced=False): that person is there and
# can stop it, and the work has its own budget or its person waits on it. Pacing it too held Make on a $1 month for 17
# hours after one 2-cent planner call, since each call reserves nearly the whole $0.10 burst, a Code helper on a $2
# month 13 hours after its first call, and a mind answering its person's chat once the burst was spent.
GUARD_MONTH_SECONDS=30*86400
GUARD_BURST_SECONDS=GUARD_MONTH_SECONDS/10

def guarded(label):
    """The limits the guard paces, every monthly figure someone set on spending: the payer's allowance
    (person:<id>:month), the hive's cap (hive:month), and a team's or a mind's cap where one is set (swarm:<id>:month,
    agent:<id>:month, the every-mind rule's month on a mind among them), so a runaway mind slows to the month's pace of
    the tightest one it meets (Jon on #299). A day rule is a pace already, a total has no month to pace over and a key's
    cap is its owner's own (OwnHive), so those are held by their limit alone."""
    scope,_,period=label.rpartition(':')
    return period=='month' and (scope=='hive' or scope.split(':',1)[0] in ('person','swarm','agent'))

class SpendRateLimited(ValueError):
    """A reservation the spend-rate guard refused: the guarded limit (its label and figure) and the whole seconds until
    a call of that worst case fits (retry_after, rounded up). Nothing was held."""
    def __init__(self,scope,limit,retry_after):
        super().__init__('Spending faster than this month allows: '+scope)
        self.scope,self.limit_usd,self.retry_after=scope,limit,max(1,math.ceil(retry_after))

def guard_charges(db,rows,ceiling,now):
    """Inside the reserve transaction: for each guarded row, (label, its new tat, the seconds this call charges, the limit
    in micros it is counted at), or SpendRateLimited for the first row the call doesn't fit. A row last counted at another
    limit first has its time ahead and its open charges scaled by old / new (the money ahead kept). Time: one tat read per
    guarded row (four at most: the payer's, the hive's, the team's and the mind's), and one update of that row's open
    charges when its limit changed."""
    out=[]
    for label,limit,_spent in rows:
        lim=micros(limit,ROUND_FLOOR) if guarded(label) else 0
        if lim<=0:continue
        stored=db.one('SELECT tat,lim FROM limit_rates WHERE label=?',(label,))
        tat=stored['tat'] if stored else now
        if stored and stored['lim'] and stored['lim']!=lim:
            scale=stored['lim']/lim
            tat=now+max(0.0,tat-now)*scale
            db.execute('UPDATE limit_rate_charges SET seconds=seconds*? WHERE label=?',(scale,label))
        tat=max(tat,now)
        cost=ceiling*GUARD_MONTH_SECONDS/lim
        # within the burst: admitted while tat + cost <= now + the burst's time; bigger than it: only from a full guard
        wait=tat+cost-GUARD_BURST_SECONDS-now if cost<=GUARD_BURST_SECONDS else tat-now
        if wait>0:raise SpendRateLimited(label,float(limit),wait)
        out.append((label,tat+cost,cost,lim))
    return out

# A reservation ends released (the whole charge back) or settled below its worst case (the difference back, in
# proportion), and the guard gives that time back, so it counts what was actually spent. One trigger covers every
# statement that ends a hold, here and in the Studio paths; a hold settled at its worst case (an expiry) gives nothing back.
GUARD_REFUND=("CREATE TRIGGER IF NOT EXISTS limit_rate_refund AFTER UPDATE OF state ON cost_reservations "
              "WHEN NEW.state IN ('released','settled') AND OLD.state IN ('reserved','dispatched','unknown') BEGIN "
              "UPDATE limit_rates SET tat=tat-(SELECT c.seconds*CASE WHEN NEW.state='released' THEN 1.0 "
              "WHEN NEW.actual IS NULL OR NEW.actual>=NEW.maximum THEN 0.0 ELSE (NEW.maximum-NEW.actual)*1.0/NEW.maximum END "
              "FROM limit_rate_charges c WHERE c.reservation=NEW.id AND c.label=limit_rates.label) "
              "WHERE label IN (SELECT label FROM limit_rate_charges WHERE reservation=NEW.id); "
              "DELETE FROM limit_rate_charges WHERE reservation=NEW.id; END")

class Reservations:
    def __init__(self,db,clock=time.time):
        self.db,self.clock=db,clock
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
        db.execute('CREATE TABLE IF NOT EXISTS limit_rates (label TEXT PRIMARY KEY, tat REAL NOT NULL, lim INTEGER)')
        if 'lim' not in {r[1] for r in db._conn.execute('PRAGMA table_info(limit_rates)')}:
            db.execute('ALTER TABLE limit_rates ADD COLUMN lim INTEGER')   # a row from before: counted at its next charge
        db.execute('CREATE TABLE IF NOT EXISTS limit_rate_charges (reservation TEXT NOT NULL, label TEXT NOT NULL, seconds REAL NOT NULL, PRIMARY KEY(reservation,label))')
        db.execute(GUARD_REFUND)
        # Schema only. Recovery of a previous process's calls is recover_startup, run once by the lifetime owner
        # (hive.core.exclusive.startup_recovery); constructing Reservations never rewrites a live liability (OPEN-17).
    @staticmethod
    def recover_startup(tx):
        """Startup step 1 of the one combined recovery, inside its transaction: a reservation still reserved or
        dispatched when the process starts has no live call behind it, so its outcome is unknown; keep the liability
        held until it settles by itself (from OpenRouter's record, or at the expiry). Returns the number of rows moved
        to unknown.
        r10 (Design 5d2c2a6b), kept in the assembly: recovery observes the unknown outcome now and starts its existing
        expiry clock (never inferring an earlier failure from dispatch time), and repairs older unknown rows that lack
        a clock; a second recovery keeps the earliest clock; terminal rows are unchanged."""
        observed = time.time()
        from .gateway import RESTART_CAUSE
        tx.execute("UPDATE cost_reservation_details SET observation=json_set(COALESCE(observation,'{}'),'$.cause',?) "
                   "WHERE reservation IN (SELECT id FROM cost_reservations WHERE state IN ('reserved','dispatched'))",
                   (RESTART_CAUSE,))
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
            if found is not None and SUBJECT.fullmatch('agent:'+agent+':total'):
                subjects.add('agent:'+agent)
                if found[0]:subjects.add('swarm:'+found[0])
            else:
                whole=False
            if 'payer' not in meta:
                whole=False
            elif isinstance(meta['payer'],str) and meta['payer'].startswith('user:u_'):
                if SUBJECT.fullmatch('person:'+meta['payer'][5:]+':month'):subjects.add('person:'+meta['payer'][5:])
                else:whole=False
            if 'key' not in meta:
                whole=whole and meta.get('kind')=='embeddings'   # embeddings never carried a key; chat and Ask always did
            elif meta['key']:
                if isinstance(meta['key'],str) and SUBJECT.fullmatch('key:'+meta['key']+':month'):subjects.add('key:'+meta['key'])
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
    def free_unknown(self,model):
        """When the expiry settles the oldest $0 call to this model (held at the one-micro-dollar floor) whose outcome is
        unknown, in epoch seconds, or None when there is none (gateway.free_reserve refuses the model until then)."""
        row=self.db.one("SELECT MIN(r.unknown_at) AS at FROM cost_reservations r JOIN cost_reservation_details d ON d.reservation=r.id "
                        "WHERE r.state='unknown' AND r.maximum<=? AND json_extract(d.metadata,'$.model')=?",(FREE_FLOOR_MICROS,model))
        return None if row is None or row['at'] is None else row['at']+UNKNOWN_EXPIRY_SECONDS
    def settled(self,label):
        """gateway r1a (plan §2.2): the settled cost, in USD, of every reservation recorded under this exact label (an Ask
        turn's askturn:<id>, an Ask thread's askthread:<id>), in whatever way it settled (a late settle after a release
        counts the same). Open holds are not counted: pending() counts those. The one source Sessions.thread_spent uses."""
        return settled_usd(self.db,label)
    def pending(self,label):
        """Micro-USD open S5 and delegated commitments for the existing budget subject."""
        return pending_micros(self.db, label)
    def reserve(self,key,payload,maximum,budgets,metadata=None,dispatched=False,subjects=None,paced=True):
        """budgets() -> [(scope+period identifier, limit USD, recorded spend USD)].
        subjects: what the call spends against (host_subjects); recorded with the liability so every later row about
        any of them counts it. Without it, the subjects of the rows in force now (and the hive) are recorded.

        Callback runs under the same SQLite write transaction. Existing spend
        must exclude reservations; outstanding liabilities are added here.
        dispatched=True admits and marks the call dispatched in that one transaction, so a crash can never strand
        a 'reserved' row. Only a hash of the payload is kept, never the call content.
        The spend-rate guard (guard_charges) then paces each monthly allowance and cap it is held against (guarded): a call
        that fits its limits but not their pace raises SpendRateLimited and holds nothing. paced=False is a call a
        person's own live work holds (Hive.present_for): its limits alone hold it and it charges the guard nothing.
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
            charges=guard_charges(self.db,rows,ceiling,self.clock()) if paced else []
            held={'hive'}|{s for s in (subjects or ()) if s}|{s for s in (subject_of(l) for l,_,_ in rows) if s}
            self.db.execute("INSERT INTO cost_reservations(id,binding,maximum,state,dispatched_at,reserved_at) VALUES(?,?,?,?,?,?)",(key,binding,ceiling,'dispatched' if dispatched else 'reserved',time.time() if dispatched else None,time.time()))
            self.db.execute('INSERT INTO cost_reservation_details(reservation,metadata) VALUES(?,?)',(key,details))
            for scope,_,_ in rows:self.db.execute('INSERT INTO cost_reservation_scopes(reservation,scope) VALUES(?,?)',(key,scope))
            for subject in sorted(held):self.db.execute('INSERT INTO cost_reservation_subjects(reservation,subject) VALUES(?,?)',(key,subject))
            for label,tat,seconds,lim in charges:
                self.db.execute('INSERT INTO limit_rates(label,tat,lim) VALUES(?,?,?) ON CONFLICT(label) DO UPDATE SET tat=excluded.tat,lim=excluded.lim',(label,tat,lim))
                self.db.execute('INSERT INTO limit_rate_charges(reservation,label,seconds) VALUES(?,?,?)',(key,label,seconds))
            return {**self.get(key),'new':True}
    def dispatch(self,key):
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state']!='reserved':raise ValueError('Reservation cannot dispatch again')
            self.db.execute("UPDATE cost_reservations SET state='dispatched',dispatched_at=? WHERE id=?",(time.time(),key))
    def unknown(self,key,cause=None):
        """A sent call whose cost is not known: held at its worst case for a person. cause (gateway.held_cause) is why, in
        the hive's own words, kept in its observation for the person who resolves it."""
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state'] not in {'dispatched','unknown'}:raise ValueError('No dispatched liability')
            self.db.execute("UPDATE cost_reservations SET state='unknown',unknown_at=COALESCE(unknown_at,?) WHERE id=?",(time.time(),key))
            if cause:
                self.db.execute("UPDATE cost_reservation_details SET observation=json_set(COALESCE(observation,'{}'),'$.cause',?) "
                                "WHERE reservation=?",(str(cause)[:200],key))
    def abort_before_dispatch(self,key):
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state']!='reserved':raise ValueError('Dispatched liability cannot be released')
            self.db.execute("UPDATE cost_reservations SET state='released' WHERE id=?",(key,))
    def release_unbilled(self,key,status):
        """A sent call the provider refused in a way it documents as unbilled (gateway.unbilled: an Anthropic or OpenRouter
        error answer in the provider's own error shape, with no usage or cost in the body; never a timeout or dropped connection):
        its hold is released, with a resolution by 'hive:provider-refusal' naming the status. Only a reserved or dispatched row; an unknown one stays for a person (resolve). Returns True if released;
        False if it was already released (a replay) or is in any other state, which is left untouched. A charge that
        arrives anyway still settles (settle's late-after-release path) and is flagged."""
        _resolutions(self.db)
        with self.db.transaction():
            row=self.get(key)
            if not row or row['state'] not in {'reserved','dispatched'}:return False
            self.db.execute("UPDATE cost_reservations SET state='released' WHERE id=?",(key,))
            self.db.execute("INSERT OR IGNORE INTO cost_reservation_resolutions VALUES (?,?,?,?,?,?)",
                            (key,'release',None,f'provider refused the call (HTTP {int(status)}); nothing was billed',
                             'hive:provider-refusal',time.time()))
            return True
    def settle(self,key,actual,record_usage,on_overrun=None):
        measured=micros(actual)
        with self.db.transaction():
            row=self.get(key)
            if not row:raise ValueError('Missing reservation')
            if row['state']=='settled':
                if row['actual']!=measured:raise ValueError('Settlement differs')
                return False
            if row['state']=='released':
                # A provider answered after its hold was released (Kimi N1, 2026-10-04): the money was spent,
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
        """Host-supplied provider identifiers, no authority or reconciliation claim. Replaces what was observed before,
        except the cause an unknown outcome recorded (unknown), which stays."""
        if not isinstance(observation,dict) or set(observation)-{'response_id','resolved_model','usage_origin'}:raise ValueError('Bounded provider observation required')
        if any(not isinstance(v,str) or len(v)>200 for v in observation.values()):raise ValueError('Bounded provider observation required')
        raw=json.dumps(observation,sort_keys=True,separators=(',',':'))
        with self.db.transaction():
            if not self.get(key):raise ValueError('Missing reservation')
            self.db.execute("UPDATE cost_reservation_details SET observation=CASE WHEN json_extract(observation,'$.cause') IS NULL "
                            "THEN ? ELSE json_set(?,'$.cause',json_extract(observation,'$.cause')) END WHERE reservation=?",(raw,raw,key))
    def details(self,key):
        row=self.db.one('SELECT metadata,observation FROM cost_reservation_details WHERE reservation=?',(key,))
        if not row:return None
        return {'metadata':json.loads(row['metadata']),'observation':json.loads(row['observation']) if row['observation'] else None}


def settled_usd(db,label):
    """Reservations.settled without an instance (sessions.py reads it from the hive's database): one query, one source."""
    if not db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cost_reservation_scopes'"):return 0.0
    n=db.one("SELECT COALESCE(SUM(r.actual),0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
             "ON c.reservation=r.id WHERE c.scope=? AND r.state='settled'",(label,))['n']
    return n/1_000_000


def held_usd(db,label):
    """What calls not yet settled hold against one limit's label (pending_micros, the count admission adds to its spend),
    in USD: shown beside the limit's spend wherever a limit is shown, so a limit whose spend leaves room but whose holds
    fill it says so. 0 on a hive whose reservations were never set up.
    Time: pending_micros' indexed queries for one label."""
    if not db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cost_reservation_subjects'"):return 0.0
    return round(pending_micros(db,label)/1_000_000,6)


def host_subjects(hive,agent_id,key_id=None,payer=None,own_key=False,turn_bound=False):
    """Everything a call by this mind spends against, whether or not a rule on it exists yet: the hive, the mind, its
    team, the paying person (not on their own key, as Budgets.applicable) and the key."""
    fresh=hive._agent_row(agent_id)
    out=['hive','agent:'+fresh['id']]
    if fresh.get('swarm_id'):out.append('swarm:'+fresh['swarm_id'])
    if payer and str(payer).startswith('user:u_') and (not own_key or turn_bound):
        out.append('person:'+str(payer)[5:])   # gateway r1a: a turn-bound own-key call also counts under an admin's person rule
    if key_id:out.append('key:'+key_id)
    out.extend(hive.ownhive.subjects(key_id,payer))   # own hive H1.1: the call's key-limit scopes, limit or not, so a later limit counts it
    return out


def host_use_check(hive,agent_id,key_id=None,payer=None,user=None):
    """Call within Reservations.reserve's budgets callback, before any liability is accepted: the preflight's own use
    authorization (OwnHive.use_check, from Budgets.check) read again now, for the same key, payer and calling person.
    A person disabled or a grant revoked since admission leaves the payer unchanged on the hive's keys, so the payer
    re-check alone would not see it; this raises the same 402 (no_key_grant, own_key_needed, ...) and nothing is held."""
    hive.ownhive.use_check(hive._agent_row(agent_id),key_id,payer,user)


def host_budget_snapshot(hive,agent_id,key_id=None,payer=None,own_key=False,turn_bound=False):
    """Host-owned current caps/spend; call within Reservations.reserve transaction.

    Shared by chat and future image/video/vision routes. Period labels exclude
    a particular calendar window so unresolved prior liabilities stay held.
    turn_bound (gateway r1a, plan §2.6; only the personal-mind gateway passes True): the person's ONE monthly total
    (Budgets.monthly_total) is always a row, and without one nothing is reserved (ValueError monthly_total_required).
    """
    fresh=hive._agent_row(agent_id)   # the stored spend, not the view's 6-place rounding (OmegaReview r6)
    rows={}
    if hive.budgets.lifetime_cap_applies(fresh,None,payer,own_key,key_id,turn_bound):   # a $0 mind under a hive cap is held by it, its payer's allowance and the caps set instead (a personal mind: its person's allowance)
        rows["agent:"+fresh["id"]+":total"]=(fresh["budget_usd"] or 0,fresh["spent_usd"] or 0)
    foundation=getattr(hive,'foundation',None)
    ceiling=foundation.controller_ceiling(agent_id) if foundation is not None else None
    if ceiling is not None:
        label='agent:'+fresh['id']+':total'
        # The same pure host-bound ceiling governs own calls and delegated admission.
        # Lower existing own caps, including a governing zero, remain effective.
        prior=rows.get(label)
        rows[label]=(min(prior[0],ceiling) if prior else ceiling,fresh['spent_usd'] or 0)
    research=getattr(hive,'research',None)
    month=research.controller_month(agent_id) if research is not None else None
    if month is not None:
        # The Research coordinator (research.py) never spends itself: its spawn ceiling is the Research month cap, so the
        # researchers' past months (which _delegated_pending_micros counts against a lifetime row forever) never block it.
        from .budgets import period_start
        rows.pop('agent:'+fresh['id']+':total',None)
        own=hive.db.one('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE agent_id=? AND created_at>=?',
                        (fresh['id'],period_start('month')))['s']
        rows['agent:'+fresh['id']+':month']=(month,own)
    cap=hive.budgets.hard_cap()   # HIVE_BUDGET_USD only seeds a hive with no total on the Limits page (Jon 2026-10-07)
    if cap:
        rows['hive:hard-total']=(cap,hive.budgets.hard_total_spent())
    found=list(hive.budgets.applicable(fresh,key_id,payer,own_key,turn_bound))
    if turn_bound:
        governing=hive.budgets.monthly_total(fresh,payer,own_key,key_id)
        if governing is None:
            raise ValueError('monthly_total_required')
        found.append(governing)   # the governing row, named explicitly (r1.1 §C, T-MT3); merged below if already present
    for scope,period,limit,origin in found:
        label=scope+':'+period
        spent=hive.budgets.spent(scope,period)
        if label in rows:limit=min(limit,rows[label][0])
        rows[label]=(limit,spent)
    return [(scope,limit,spent) for scope,(limit,spent) in rows.items()]


def host_admission_view(hive,agent_id,key_id=None,payer=None,own_key=False,turn_bound=False):
    """READ-ONLY. host_budget_snapshot's rows as Reservations.reserve admits a call against them: each limit, the spend
    recorded against it, the worst cases held against it by calls not yet settled (pending_micros) and the room left,
    least room first, so the first row is the one that refuses the mind's next call once its worst case passes that
    room. Read outside the admission transaction, so a call in flight can move it; it decides nothing.
    Time: r rows, each one spend query and one held query."""
    return admission_rows(hive.db,host_budget_snapshot(hive,agent_id,key_id,payer,own_key,turn_bound))


def admission_rows(db,snapshot):
    """READ-ONLY. Each (label, limit, spent) of a budget snapshot as Reservations.reserve admits against it: the limit,
    the spend recorded against it, the worst cases held against it by calls not yet settled (pending_micros) and the room
    left (limit floored, spend ceilinged, as reserve counts), least room first. Shared by host_admission_view and
    Budgets.request_bound. Time: r rows, one held query each."""
    out=[]
    for label,limit,spent in snapshot:
        held=pending_micros(db,label)
        room=max(0,micros(limit,ROUND_FLOOR)-micros(spent)-held)
        scope,_,period=label.rpartition(':')
        out.append({'label':label,'scope':scope,'period':period,'limit_usd':float(limit),'spent_usd':round(float(spent),6),
                    'held_usd':held/1_000_000,'room_usd':room/1_000_000})
    return sorted(out,key=lambda r:(r['room_usd'],r['label']))


# ---- unknown liabilities settle themselves (platform, 2026-10-04; nobody settles by hand since 2026-11-12) ----------
# A call whose outcome is unknown (provider error, cancellation, missing usage) keeps its worst-case reservation held
# so caps cannot be overrun, and settles by itself: an OpenRouter answer the hive holds a generation id for from
# OpenRouter's own record of it (settle_from_record), any other within the hour at its worst case as an estimate
# (expire_unknown), which OpenRouter's record still corrects when it comes after the hour (estimates_with_records) and a
# person may correct with the billed cost for 30 days (correct, correct_all). The one place a person is asked is a call
# that would cross a limit they set: admission refuses it. All are recorded; nothing is deleted.

def _resolutions(db):
    db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_resolutions (reservation TEXT PRIMARY KEY, action TEXT NOT NULL, '
               'actual INTEGER, reason TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at REAL NOT NULL)')
    # the expiry's estimates by when they were made (_ESTIMATES), which the reconcile reads every pass
    db.execute('CREATE INDEX IF NOT EXISTS cost_reservation_resolutions_by ON cost_reservation_resolutions '
               '(decided_by, decided_at)')


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
    """The calls whose cost is still held, oldest first, each with how the hive settles it by itself; nobody settles a
    held call by hand. `settles` is 'record' for an unknown call OpenRouter keeps a record of (from_provider_records),
    'estimate' for any other unknown call, and 'answer' for a call still in flight, which settles when it answers (a
    restart turns it unknown). An unknown call nothing settles first is estimated at `auto_settles_at` (expire_unknown).
    Time: one read of the held rows, n = their count, plus n scope reads."""
    db = reservations.db
    marks = ",".join("?" for _ in states)
    rows = db.all(f"SELECT r.id, r.maximum, r.state, r.dispatched_at, r.unknown_at, d.metadata, d.observation FROM cost_reservations r "
                  f"LEFT JOIN cost_reservation_details d ON d.reservation = r.id WHERE r.state IN ({marks}) ORDER BY r.rowid", tuple(states))
    out = []
    for r in rows:
        scopes = [s["scope"] for s in db.all("SELECT scope FROM cost_reservation_scopes WHERE reservation = ?", (r["id"],))]
        meta = json.loads(r["metadata"]) if r["metadata"] else {}
        seen = json.loads(r["observation"]) if r["observation"] else None
        unknown = r["state"] == "unknown"
        out.append({"id": r["id"], "state": r["state"], "held_usd": r["maximum"] / 1_000_000, "scopes": scopes,
                    "metadata": {k: v for k, v in meta.items() if k in SHOWN_METADATA}, "observation": seen,
                    "dispatched_at": r["dispatched_at"], "unknown_at": r["unknown_at"],
                    "settles": ("record" if provider_record_id(meta, seen) else "estimate") if unknown else "answer",
                    "auto_settles_at": r["unknown_at"] + UNKNOWN_EXPIRY_SECONDS if unknown and r["unknown_at"] else None})
    return out


def settle_from_record(reservations, key, usd, reason, record_usage=None, on_overrun=None):
    """An unknown call settled at the cost OpenRouter's own record of it reports (the reconcile pass reads it through
    from_provider_records and Gateway.generation_cost), with a resolution by 'hive:provider-record' whose reason names
    the record; a cost above the hold is flagged as an overrun the provider reported (source 'provider-record').
    record_usage(usd) records it for the call's mind.
    Returns True when it settled, or False when the call is no longer unknown (it settled or was released meanwhile),
    which changes nothing."""
    db = reservations.db
    _resolutions(db)
    measured = micros(usd)
    with db.transaction():
        row = reservations.get(key)
        if not row or row["state"] != "unknown":
            return False
        if record_usage:
            record_usage(measured / 1_000_000)
        db.execute("UPDATE cost_reservations SET state='settled', actual=? WHERE id=?", (measured, key))
        if measured > row["maximum"]:
            note_overrun(db, key, row["maximum"], measured, "provider-record", on_overrun)
        db.execute("INSERT INTO cost_reservation_resolutions VALUES (?,?,?,?,?,?)",
                   (key, "settle", measured, str(reason)[:500], "hive:provider-record", time.time()))
    return True


def provider_record_id(meta, observation):
    """The generation id OpenRouter keeps a record of a held call's cost under (gateway.Gateway.generation_cost): the
    "gen-…" response id an OpenRouter model's answer named, from the call's parsed metadata and observation; None for
    any other model or answer."""
    generation = observation.get("response_id") if isinstance(observation, dict) else None
    if isinstance(meta, dict) and str(meta.get("model") or "").startswith("openrouter/") and isinstance(generation, str) \
            and generation.startswith("gen-"):
        return generation
    return None


def from_provider_records(reservations, after=0, limit=None):
    """Unknown OpenRouter calls the hive holds a generation id for (provider_record_id), as (row number, reservation,
    paying key id, generation id, metadata): an answer that came back without usage the hive could price. OpenRouter
    keeps a record of each one's cost (gateway.Gateway.generation_cost). A timeout or a restart left no id, so those wait
    for the expiry. With a limit, at most that many: the ones after row number `after` first, then from the oldest, so a
    pass that carries the last row number it took on to the next goes round them all and a call whose record never
    appears cannot keep the others waiting. Time: one indexed read of the unknown rows, n = their count."""
    rows = reservations.db.all("SELECT r.rowid AS n, r.id, d.metadata, d.observation FROM cost_reservations r "
                               "JOIN cost_reservation_details d "
                               "ON d.reservation = r.id WHERE r.state = 'unknown' AND d.observation IS NOT NULL ORDER BY r.rowid")
    out = []
    for row in rows:
        meta, seen = json.loads(row["metadata"] or "{}"), json.loads(row["observation"] or "{}")
        generation = provider_record_id(meta, seen)
        if generation:
            out.append((row["n"], row["id"], meta.get("key"), generation, meta))
    if limit is None:
        return out
    return ([c for c in out if c[0] > after] + [c for c in out if c[0] <= after])[:limit]


# An unknown outcome is held for an hour, then the books close on its worst case: the limits plan on
# omega-flagship/omegahive#107, after RFC 4006's Validity-Time (a hold is good for a fixed time). Most such calls are a
# slow provider or a broken stream, so the worst case is an upper bound that is usually more than was billed; an
# OpenRouter answer with a generation id is settled from OpenRouter's own record first (from_provider_records), and an
# estimate of one is corrected to that record when it comes later (estimates_with_records).
UNKNOWN_EXPIRY_SECONDS = 3600
# How long a person may correct an estimate with what the provider billed (correct, the same plan): a provider's
# billing for a day is out well within it, and the month the estimate was charged to has closed by then.
CORRECTION_SECONDS = 30 * 86400


def expire_unknown(reservations, record_usage_for, on_estimated=None, now=None, max_age=UNKNOWN_EXPIRY_SECONDS):
    """An unknown-outcome hold must not wait on a person forever (Kimi N2, 2026-10-04). After max_age it settles at its
    held worst case (fail-safe: cost may be over-recorded, never lost) as an estimate: a resolution by 'hive:expiry'
    and a usage row marked estimated that names its call, which OpenRouter's record of the call
    (estimates_with_records) or a person may correct with the billed cost for CORRECTION_SECONDS (correct). A $0
    model's call is held at a floor that is no worst case (FREE_FLOOR_MICROS), so it settles at $0, its price, which
    lets its model be called again; a charge it did make shows in OpenRouter's record or on the provider's billing and
    is corrected the same way. record_usage_for(metadata, usd, estimated=1, reservation=id) records it for the call's
    mind. A pass that settles anything calls on_estimated once with what it settled (estimated_summary), never once per
    call. A call that cannot be settled stays held for the next pass and is named in the log; the calls after it still
    settle. Returns the ids settled, oldest outcome first.
    Time: one read of the unknown rows past the expiry, then one transaction per call settled."""
    db = reservations.db
    _resolutions(db)
    now = now or time.time()
    settled = []
    for row in db.all("SELECT id, maximum FROM cost_reservations WHERE state='unknown' AND unknown_at IS NOT NULL "
                      "AND unknown_at < ? ORDER BY unknown_at, rowid", (now - max_age,)):
        meta = (reservations.details(row["id"]) or {}).get("metadata") or {}
        free = row["maximum"] <= FREE_FLOOR_MICROS
        amount = 0 if free else row["maximum"]
        try:
            with db.transaction():
                fresh = reservations.get(row["id"])
                if not fresh or fresh["state"] != "unknown":
                    continue
                record_usage_for(meta, amount / 1_000_000, estimated=1, reservation=row["id"])
                db.execute("UPDATE cost_reservations SET state='settled', actual=? WHERE id=?", (amount, row["id"]))
                db.execute("INSERT INTO cost_reservation_resolutions VALUES (?,?,?,?,?,?)",
                           (row["id"], "settle", amount, "auto: outcome still unknown at the expiry; settled at "
                            + ("$0, the free model's price," if free else "its worst case")
                            + " as an estimate, which a person may correct with the billed cost",
                            "hive:expiry", now))
        except Exception as exc:   # one call's failure leaves it held for the next pass and never stops the rest
            print(f"[hive] expiry could not settle {row['id']}: {exc!r}", flush=True)
            continue
        settled.append((row["id"], amount, meta.get("payer"), meta.get("model")))
    if settled and on_estimated:
        with contextlib.suppress(Exception):   # telling people never undoes what was recorded
            on_estimated(estimated_summary(settled))
    return [rid for rid, *_ in settled]


def estimated_summary(settled):
    """What one expiry pass settled, as budget.estimated carries it: how many calls and their total, the same by who
    pays (a person's principal, or 'hive' for a call that named nobody), the largest total first, the free models whose
    calls it settled at $0, their price (`free`, the most calls first: once their block lifts, this and the admins' day
    line are the only sign a $0 model's calls end unknown), and the calls' ids.
    settled: [(reservation id, micro-dollars, payer, model)]. Summed in micro-dollars, as the hive holds them.
    Time: n dictionary updates + p log p + f log f to sort, n = calls, p = payers, f = free models."""
    by, free = {}, {}
    for _, amount, payer, model in settled:
        who = payer if isinstance(payer, str) and payer else "hive"
        count, total = by.get(who, (0, 0))
        by[who] = (count + 1, total + amount)
        if amount == 0:   # a worst case is never $0: only a free model's floor settles at its price
            free[model or "a model"] = free.get(model or "a model", 0) + 1
    return {"count": len(settled), "total_usd": sum(amount for _, amount, _, _ in settled) / 1_000_000,
            "payers": [{"payer": who, "count": count, "total_usd": total / 1_000_000}
                       for who, (count, total) in sorted(by.items(), key=lambda item: (-item[1][1], item[0]))],
            "free": [{"model": m, "count": n} for m, n in sorted(free.items(), key=lambda item: (-item[1], item[0]))],
            "reservations": [rid for rid, *_ in settled]}


# ---- correcting estimates ------------------------------------------------------------------------
# An estimate is corrected once, with the billed cost or with nothing billed. Usage stays append-only: the estimate's
# row is kept and an adjusting row of the difference is added, dated with the estimate so each day's and month's spend
# takes it where the estimate was charged and a correction never gives a later month room its allowance never had.

def _corrections(db):
    db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_corrections (reservation TEXT PRIMARY KEY, action TEXT NOT NULL, '
               'estimate INTEGER NOT NULL, actual INTEGER NOT NULL, reason TEXT NOT NULL, decided_by TEXT NOT NULL, '
               'decided_at REAL NOT NULL)')


# The calls the expiry settled at an estimate after the bound given that nobody has corrected (amounts in micro-dollars).
_ESTIMATES = ("SELECT r.id, r.maximum, r.actual, v.decided_at FROM cost_reservations r "
              "JOIN cost_reservation_resolutions v ON v.reservation = r.id "
              "WHERE v.decided_by = 'hive:expiry' AND v.action = 'settle' AND r.state = 'settled' AND v.decided_at > ? "
              "AND NOT EXISTS (SELECT 1 FROM cost_reservation_corrections c WHERE c.reservation = r.id)")


class NotCorrectable(ValueError):
    """A correction of a call that is no estimate a person may correct now."""


def still_estimated(db, alias="u"):
    """SQL true for a usage row that is still an estimate: the expiry's worst case that nobody has corrected. A
    corrected estimate keeps its row (usage is append-only) with its adjusting row beside it, so every read that marks
    estimates (Hive.usage, estimated_lines) asks this rather than the row's own flag."""
    _corrections(db)
    return (f"({alias}.estimated = 1 AND NOT EXISTS (SELECT 1 FROM cost_reservation_corrections c "
            f"WHERE c.reservation = {alias}.reservation))")


def _expired(db, key):
    return db.one("SELECT 1 FROM cost_reservation_resolutions WHERE reservation = ? AND decided_by = 'hive:expiry' "
                  "AND action = 'settle'", (key,)) is not None


def _not_correctable(db, key):
    """Why a call cannot be corrected now, in words."""
    if not _expired(db, key):
        return f"call {key} was not settled at an estimate, so there is nothing to correct"
    if db.one("SELECT 1 FROM cost_reservation_corrections WHERE reservation = ?", (key,)):
        return f"call {key} was corrected already"
    return f"call {key} was estimated more than {CORRECTION_SECONDS // 86400} days ago, so its estimate stands"


def _estimate_stamp(db, key, decided_at):
    """When an estimate was charged, as usage rows date it: its own usage row's created_at, or, for an estimate made
    before usage rows named their call, the moment the expiry settled it (it recorded the usage in that same step)."""
    row = db.one("SELECT created_at FROM usage WHERE reservation = ? AND estimated = 1 ORDER BY id LIMIT 1", (key,))
    if row:
        return row["created_at"]
    return _stamp(datetime.datetime.fromtimestamp(decided_at, datetime.timezone.utc))


def _stamp(moment):
    """A moment as usage rows and period_start write it ("2026-11-12T13:00:00.000Z"), so the two compare as text."""
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _correct_one(reservations, key, estimate, action, billed, reason, by, record_usage_for, on_overrun, now,
                 source="correct"):
    """One correction inside the caller's transaction (correct, correct_all): the adjusting usage row (none when the
    billed cost is the estimate), the call's actual, an overrun flag above its hold under source, and the correction's
    own row."""
    db = reservations.db
    delta = billed - estimate["actual"]
    if delta and record_usage_for:
        meta = (reservations.details(key) or {}).get("metadata") or {}
        record_usage_for(meta, delta / 1_000_000, reservation=key, created_at=_estimate_stamp(db, key, estimate["decided_at"]))
    db.execute("UPDATE cost_reservations SET actual = ? WHERE id = ?", (billed, key))
    if billed > estimate["maximum"]:
        note_overrun(db, key, estimate["maximum"], billed, source, on_overrun)
    db.execute("INSERT INTO cost_reservation_corrections VALUES (?,?,?,?,?,?,?)",
               (key, action, estimate["actual"], billed, reason[:500], str(by), now))
    return {"id": key, "state": "settled", "maximum": estimate["maximum"], "actual": billed,
            "estimate": estimate["actual"], "action": action}


def correct(reservations, key, action, reason, by, actual=None, record_usage_for=None, on_overrun=None, now=None,
            source="correct"):
    """A person, or OpenRouter's record of the call once it appears (by 'hive:provider-record', source
    'provider-record'), corrects an estimate (expire_unknown) with what the provider billed: 'settle' with that cost in
    USD, or 'release' when it billed nothing. The call's actual becomes the billed cost and an adjusting usage row of
    the billed cost minus the estimate is recorded, dated with the estimate (none when they are equal); a cost above
    what was held is flagged as an overrun under source, as settle flags one. record_usage_for(metadata, usd,
    reservation=key, created_at=stamp) records the adjusting row. Within CORRECTION_SECONDS of the estimate and once,
    else NotCorrectable and nothing changes. Returns the call after it: its id, state, held maximum, actual, estimate
    and the action taken."""
    if action not in ("settle", "release"):
        raise ValueError("action is settle or release")
    reason = str(reason or "").strip()
    if not reason:
        raise ValueError("a reason is required")
    billed = micros(actual) if action == "settle" else 0
    db = reservations.db
    _resolutions(db)
    _corrections(db)
    now = now or time.time()
    with db.transaction():
        estimate = db.one(_ESTIMATES + " AND r.id = ?", (now - CORRECTION_SECONDS, key))
        if estimate is None:
            raise NotCorrectable(_not_correctable(db, key))
        return _correct_one(reservations, key, estimate, action, billed, reason, by, record_usage_for, on_overrun, now,
                            source)


def correct_all(reservations, keys, action, reason, by, record_usage_for=None, on_overrun=None, now=None):
    """Correct all: every listed estimate (expire_unknown) kept as billed ('settle') or corrected to nothing billed
    ('release'), as one decision with one reason, all or none. Each key must be an estimate a person may correct now,
    else NotCorrectable says why for the first that is not and nothing changes, so the total a person confirmed is the
    total decided. Each estimate gets its own correction row, as correct gives it. record_usage_for(metadata, usd,
    **fields) records an adjusting row for the call's mind. Returns the count, the estimates' total in USD and each call
    after the decision, in the order given.
    Time: k estimate reads and k correction writes (plus up to k usage writes), k = len(keys), in one transaction."""
    db = reservations.db
    if action not in ("settle", "release"):
        raise ValueError("action is settle or release")
    if not str(reason or "").strip():
        raise ValueError("a reason is required")
    if not isinstance(keys, list) or not keys or not all(isinstance(k, str) and k for k in keys):
        raise ValueError("the estimates to correct are required")
    if len(set(keys)) != len(keys):
        raise ValueError("each estimate is listed once")
    _resolutions(db)
    _corrections(db)
    now = now or time.time()
    with db.transaction():
        estimates = [db.one(_ESTIMATES + " AND r.id = ?", (now - CORRECTION_SECONDS, k)) for k in keys]
        missing = next((k for k, e in zip(keys, estimates) if e is None), None)
        if missing is not None:
            raise NotCorrectable(f"{_not_correctable(db, missing)}; read the estimates again")
        corrected = [_correct_one(reservations, k, e, action, e["actual"] if action == "settle" else 0, str(reason).strip(),
                                  by, record_usage_for, on_overrun, now) for k, e in zip(keys, estimates)]
    return {"action": action, "count": len(keys), "estimate_usd": sum(e["actual"] for e in estimates) / 1_000_000,
            "corrected": corrected}


def estimated(reservations, now=None):
    """The estimates a person may still correct: calls the expiry settled at their worst case within CORRECTION_SECONDS
    and nobody has corrected, newest first, each with its estimate in USD, when it was settled and until when it may be
    corrected (epoch seconds), its shown metadata, what the provider was seen to say and the limits it counts against.
    Time: one read of the expiry's resolutions in the window, n = the estimates, plus n detail and scope reads."""
    db = reservations.db
    _resolutions(db)
    _corrections(db)
    now = now or time.time()
    out = []
    for r in db.all(_ESTIMATES + " ORDER BY v.decided_at DESC, r.rowid DESC", (now - CORRECTION_SECONDS,)):
        found = reservations.details(r["id"]) or {}
        out.append({"id": r["id"], "estimate_usd": r["actual"] / 1_000_000, "settled_at": r["decided_at"],
                    "correctable_until": r["decided_at"] + CORRECTION_SECONDS,
                    "metadata": {k: v for k, v in (found.get("metadata") or {}).items() if k in SHOWN_METADATA},
                    "observation": found.get("observation"),
                    "scopes": [s["scope"] for s in db.all("SELECT scope FROM cost_reservation_scopes WHERE reservation = ?",
                                                          (r["id"],))]})
    return out


# ---- OpenRouter's record after the hour ------------------------------------------------------------------------------
# The record pass reads unknown calls only and the expiry runs in the same pass, so a record that comes after the hour,
# or one that a pass after a sleep did not reach before the expiry, would never set its call's cost; the plan's review
# accepted the worst case because the record and the 30-day correction follow it (omega-flagship/omegahive#107,
# note 3). So the reconcile asks for estimates' records too, with the lookups the unknown calls leave, and corrects an
# estimate to what its record reports (correct, by 'hive:provider-record').

def _record_asks(db):
    db.execute('CREATE TABLE IF NOT EXISTS cost_reservation_record_asks (reservation TEXT PRIMARY KEY, '
               'asked_at REAL NOT NULL)')


def estimates_with_records(reservations, now=None, least=0.0, limit=None):
    """The estimates whose OpenRouter record is due to be asked for, as (reservation, paying key id, generation id,
    metadata): the expiry's estimates nobody has corrected, within CORRECTION_SECONDS, of OpenRouter calls the hive
    holds a generation id for (provider_record_id). One is due when it was never asked, or once its age has doubled
    since it was last asked: asked when a seconds old, it is due max(least, a) seconds later, so a record that never
    appears is asked for about log2(CORRECTION_SECONDS / least) times. The longest due first, at most limit of them.
    Time: one read of the window's estimates through the resolutions' (decided_by, decided_at) index, joined to their
    details and asks by key and filtered in SQL, n = the estimates in the window; at most limit rows reach Python."""
    db = reservations.db
    _resolutions(db)
    _corrections(db)
    _record_asks(db)
    now = now or time.time()
    due = "COALESCE(a.asked_at + MAX(?, a.asked_at - e.decided_at), e.decided_at)"
    rows = db.all(f"SELECT e.id, d.metadata, d.observation, {due} AS due FROM ({_ESTIMATES}) e "
                  "JOIN cost_reservation_details d ON d.reservation = e.id "
                  "LEFT JOIN cost_reservation_record_asks a ON a.reservation = e.id "
                  "WHERE substr(json_extract(d.metadata, '$.model'), 1, 11) = 'openrouter/' "
                  "AND substr(CASE WHEN json_valid(d.observation) THEN json_extract(d.observation, '$.response_id') END, 1, 4) "
                  f"= 'gen-' AND {due} <= ? ORDER BY due, e.id LIMIT ?",
                  (least, now - CORRECTION_SECONDS, least, now, -1 if limit is None else limit))
    out = []
    for row in rows:
        meta = json.loads(row["metadata"] or "{}")
        generation = provider_record_id(meta, json.loads(row["observation"] or "{}"))
        if generation:
            out.append((row["id"], meta.get("key"), generation, meta))
    return out


def record_asked(reservations, key, now=None):
    """OpenRouter had no record of an estimate's call when asked at now: estimates_with_records waits until the
    estimate's age has doubled before it asks again."""
    _record_asks(reservations.db)
    reservations.db.execute("INSERT OR REPLACE INTO cost_reservation_record_asks VALUES (?, ?)", (key, now or time.time()))


# ---- the day's line about estimates ---------------------------------------------------------------

def _usd(amount):
    """Dollars for a notice: cents, or four places below a cent, so a tenth of a cent never reads as $0.00."""
    return f"${amount:.2f}" if amount >= 0.01 or amount == 0 else f"${amount:.4f}"


def estimated_words(count, usd, admin, when, free=()):
    """The line a person reads about estimates, with the plan's words and the upper-bound clause the review asked for:
    "Yesterday, 3 calls were estimated at $0.15. That's their worst case, an upper bound that's usually lower; you can
    correct them in Usage from the provider's billing within 30 days." It says they can be corrected and asks nobody to
    (held calls settle themselves). Anyone not an admin reads of their own calls and that an admin corrects them. An
    admin also reads of the free models' calls the expiry settled at $0, their price, by model (free: [(model, count)]),
    since once their block lifts nothing else says a $0 model's calls end unknown; a person's own line leaves them out,
    as they moved no spend. when: "Yesterday", or "Since 9 Nov" when the line covers more than a day."""
    days = CORRECTION_SECONDS // 86400
    parts = []
    if count:
        calls = f"{count} {'call' if count == 1 else 'calls'}" if admin else f"{count} of your calls" if count > 1 else "1 of your calls"
        them = "it" if count == 1 else "them"
        bound = f"That's {'its' if count == 1 else 'their'} worst case, an upper bound that's usually lower"
        fix = (f"you can correct {them} in Usage from the provider's billing within {days} days" if admin else
               f"an admin can correct {them} from the provider's billing within {days} days")
        parts.append(f"{when}, {calls} {'was' if count == 1 else 'were'} estimated at {_usd(usd)}. {bound}; {fix}.")
    freed = sum(n for _, n in free) if admin else 0
    if freed:
        one = freed == 1
        said = (f"{freed} {'call' if one else 'calls'} to a free model ({', '.join(m for m, _ in free)}) had an unknown "
                f"outcome and {'was' if one else 'were'} settled at $0, {'its' if one else 'their'} price")
        parts.append(f"{said}." if count else
                     f"{when}, {said}; if the provider's billing shows a charge, you can correct {'it' if one else 'them'} "
                     f"in Usage within {days} days.")
    return " ".join(parts)


def estimated_lines(db, recipients, post, now=None):
    """One line a day to each person about the estimates (expire_unknown) they have not been told of: an admin about
    every estimate, anyone else about the ones they paid for. budget.estimated reaches open screens at once; this is
    what a person reads later, through their notices, so quiet hours hold it for the morning digest. It goes on the
    first pass of the person's local day and counts the estimates made before that day began, leaving out any
    corrected since, so a night of expiries is one line the next morning; estimates made today wait for tomorrow's.
    estimated_lines(principal, day, through) records each day's check, so a restart never sends a second line that day
    and no estimate is counted twice. recipients: [(principal, admin, tz)]; post(principal, text) sends the line.
    Returns the principals told.
    Time: one indexed max read when no estimate exists; else per recipient one marker read, and once a day one
    aggregate over its estimated usage rows past its mark (the usage_estimated index)."""
    db.execute("CREATE TABLE IF NOT EXISTS estimated_lines (principal TEXT NOT NULL, day TEXT NOT NULL, "
               "through INTEGER NOT NULL, PRIMARY KEY (principal, day))")
    still = still_estimated(db)
    newest = db.one("SELECT COALESCE(MAX(id), 0) AS n FROM usage WHERE estimated = 1")["n"]
    if not newest:
        return []
    moment = datetime.datetime.fromtimestamp(now or time.time(), datetime.timezone.utc)
    oldest = _stamp(moment - datetime.timedelta(seconds=CORRECTION_SECONDS))
    told = []
    for principal, admin, tz in recipients:
        local = moment.astimezone(ZoneInfo(tz or "UTC"))
        day = local.date().isoformat()
        last = db.one("SELECT day, through FROM estimated_lines WHERE principal = ? ORDER BY day DESC LIMIT 1", (principal,))
        if last and (last["day"] == day or last["through"] >= newest):
            continue
        today = local.replace(hour=0, minute=0, second=0, microsecond=0)
        yesterday = datetime.datetime.combine(local.date() - datetime.timedelta(days=1), datetime.time(), local.tzinfo)
        # a worst-case estimate is above $0; a free model's is $0 (its price), which only admins read of, by model
        window = ("FROM usage u WHERE u.estimated = 1 AND u.id > ? AND u.created_at < ? AND u.created_at >= ?"
                  + ("" if admin else " AND u.payer = ?"))
        args = (last["through"] if last else 0, _stamp(today), oldest, *(() if admin else (principal,)))
        found = db.one(f"SELECT MAX(u.id) AS top, COALESCE(SUM({still} AND u.cost_usd > 0), 0) AS n, "
                       f"COALESCE(SUM(CASE WHEN {still} AND u.cost_usd > 0 THEN u.cost_usd END), 0) AS usd, "
                       f"MIN(CASE WHEN {still} AND (u.cost_usd > 0 OR ?) THEN u.created_at END) AS first " + window,
                       (1 if admin else 0, *args))
        free = [(r["model"], r["n"]) for r in db.all(f"SELECT u.model, COUNT(*) AS n {window} AND {still} AND u.cost_usd = 0 "
                                                      "GROUP BY u.model ORDER BY n DESC, u.model", args)] if admin else []
        if found["top"] is None:
            continue   # nothing estimated before today that this person has not heard of
        if found["n"] or free:
            first = datetime.datetime.fromisoformat(found["first"].replace("Z", "+00:00")).astimezone(local.tzinfo)
            when = "Yesterday" if first >= yesterday else f"Since {first.day} {first.strftime('%b')}"
            try:
                post(principal, estimated_words(found["n"], found["usd"], admin, when, free))
            except Exception as exc:   # a person who cannot take notices now is asked again on the next pass
                print(f"[hive] estimated line for {principal} not sent: {exc!r}", flush=True)
                continue
            told.append(principal)
        db.execute("INSERT OR REPLACE INTO estimated_lines (principal, day, through) VALUES (?, ?, ?)",
                   (principal, day, found["top"]))
    return told
