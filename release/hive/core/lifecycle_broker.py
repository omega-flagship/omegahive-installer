"""Lifecycle broker, adopted verbatim from OmegaPurple Codex (omegapurple/security/lifecycle_broker.py, sha256 a111c668d1fb5458).
Its original note: host-only; issue only after person-admin authorization; callbacks are trusted host adapters;
isolation_ready verifies deployment, not a client flag. Platform integration: hive/core/delegation.py.
"""
import asyncio
import math
import secrets
import sqlite3
import time
from pathlib import Path


class LifecycleBroker:
    def __init__(self, path, runtime, task_state, isolation_ready, membership, spend, *, clock=time.time):
        self.runtime, self.task_state, self.isolation_ready = runtime, task_state, isolation_ready
        self.membership, self.spend, self.clock = membership, spend, clock
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS runs (lease TEXT PRIMARY KEY, coordinator TEXT, specialist TEXT, task TEXT, expires REAL, budget REAL, baseline REAL, state TEXT)')
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS exclusive_mind ON runs(specialist) WHERE state IN ('issued','starting','running','stopping')")
        self.path.chmod(0o600)
        self.lock = asyncio.Lock()

    def db(self):
        db = sqlite3.connect(self.path); db.row_factory = sqlite3.Row
        return db

    def row(self, lease):
        with self.db() as db:
            row = db.execute('SELECT * FROM runs WHERE lease=?', (lease,)).fetchone()
        if row is None: raise PermissionError('unknown lifecycle lease')
        return dict(row)

    def issue(self, coordinator, specialist, task, *, seconds, budget_usd):
        # Trusted host operation; never expose directly without person-admin auth.
        if not math.isfinite(seconds) or not 0 < seconds <= 900 or not math.isfinite(budget_usd) or budget_usd <= 0:
            raise ValueError('finite bounded duration and budget required')
        if coordinator == specialist or not self.membership(coordinator, specialist):
            raise PermissionError('specialist outside coordinator scope')
        state = self.task_state(specialist, task)
        if state['task_status'] != 'open' or state.get('assignee') != specialist:
            raise PermissionError('open task must be assigned to exact specialist')
        if not self.isolation_ready(specialist): raise PermissionError('isolation unavailable')
        if 'budget_remaining' in state and budget_usd > state['budget_remaining']: raise PermissionError('run exceeds remaining hard cap')
        expiry=min(self.clock()+seconds,state.get('deadline_epoch') or self.clock()+seconds)
        if expiry<=self.clock(): raise PermissionError('task deadline expired')
        baseline = self.spend(specialist)
        if not math.isfinite(baseline) or baseline < 0: raise ValueError('invalid spending ledger')
        lease = secrets.token_hex(24)
        with self.db() as db:
            db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)', (lease, coordinator, specialist, task, expiry, budget_usd, baseline, 'issued'))
        return lease

    def bound(self, specialist, task, lease):
        row = self.row(lease)
        if (row['specialist'], row['task']) != (specialist, task):
            raise PermissionError('lifecycle binding mismatch')
        return row

    async def authorize(self, coordinator, specialist, task, lease):
        row = self.bound(specialist, task, lease)
        if row['coordinator'] != coordinator or row['state'] != 'issued' or not await self.valid(lease):
            raise PermissionError('lifecycle authority unavailable')
        return {'allowed': True, 'isolation_ready': self.isolation_ready(specialist),
                'expires_at_monotonic': time.monotonic()+max(0,row['expires']-self.clock())}

    async def valid(self, lease):
        row = self.row(lease)
        return (row['state'] in {'issued','starting','running'} and row['expires'] > self.clock()
                and self.membership(row['coordinator'],row['specialist']) and self.isolation_ready(row['specialist']))

    async def start(self, specialist, task, lease):
        async with self.lock:
            row = self.bound(specialist, task, lease)
            if row['state'] != 'issued' or not await self.valid(lease): raise PermissionError('lease cannot start')
            state = self.task_state(specialist,task)
            if state.get('assignee') != specialist or state.get('task_status') != 'open': raise PermissionError('task unavailable')
            if not await self.runtime.stopped(specialist): raise PermissionError('specialist already running outside lease')
            if (await self.observe(specialist,task,lease))['budget_exhausted']: raise PermissionError('run budget exhausted')
            with self.db() as db:
                changed = db.execute("UPDATE runs SET state='starting' WHERE lease=? AND state='issued'",(lease,)).rowcount
                if changed != 1: raise PermissionError('lease already redeemed')
            # Persist intent before effect; cleanup reconciles a lost start response.
            await self.runtime.start(specialist)
            with self.db() as db: db.execute("UPDATE runs SET state='running' WHERE lease=?",(lease,))

    async def observe(self, specialist, task, lease):
        row = self.bound(specialist,task,lease)
        state = dict(self.task_state(specialist,task))
        spent = self.spend(specialist)
        state['budget_exhausted'] = (not math.isfinite(spent) or spent < row['baseline'] or spent-row['baseline'] >= row['budget'])
        if state.get('assignee') != specialist: state['task_status']='cancelled'
        if state.get('deadline_epoch') is not None and state['deadline_epoch']<=self.clock():state['task_status']='failed'
        return state

    async def stop(self, specialist, task, lease):
        async with self.lock:
            row = self.bound(specialist,task,lease)
            if row['state'] in {'stopped','revoked-unstarted'}: return
            if row['state'] == 'issued':
                with self.db() as db: db.execute("UPDATE runs SET state='revoked-unstarted' WHERE lease=? AND state='issued'",(lease,))
                return
            with self.db() as db: db.execute("UPDATE runs SET state='stopping' WHERE lease=?",(lease,))
            await self.runtime.stop(specialist)
            if await self.runtime.stopped(specialist):
                with self.db() as db: db.execute("UPDATE runs SET state='stopped' WHERE lease=?",(lease,))

    async def stopped(self, specialist, task, lease):
        row = self.bound(specialist,task,lease)
        return row['state'] in {'stopped','revoked-unstarted'} and await self.runtime.stopped(specialist)

    def revoke(self, lease):
        with self.db() as db: db.execute('UPDATE runs SET expires=? WHERE lease=?',(self.clock(),lease))

    async def reconcile(self):
        """Host runs on startup and periodically even if coordinator has crashed."""
        with self.db() as db: rows = [dict(r) for r in db.execute("SELECT * FROM runs WHERE state IN ('issued','starting','running','stopping')")]
        receipts=[]
        for row in rows:
            try:
                observed = await self.observe(row['specialist'],row['task'],row['lease'])
                if row['state']=='stopping' or not await self.valid(row['lease']) or observed['task_status'] in {'completed','submitted','failed','cancelled'} or observed['budget_exhausted']:
                    await asyncio.wait_for(self.stop(row['specialist'],row['task'],row['lease']),10)
                    receipts.append({'specialist':row['specialist'],'stop_observed':await self.stopped(row['specialist'],row['task'],row['lease'])})
            except Exception:
                receipts.append({'specialist':row['specialist'],'stop_observed':False})
        return receipts
