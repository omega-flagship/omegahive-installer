import { useState, type FormEvent } from 'react'
import type { ConnectionAction, ConnectionAgreement, CreateRequestConnection, Swarm } from '../../api/types'
import { money } from '../../lib/format'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { ResourceView } from '../../ui/ResourceView'
import { Button } from '../../ui/primitives'
import { SimChip } from '../../ui/SimChip'
import { isTerminalRequest, requestStateLabel } from '../../lib/requestState'
import { reviewCancelRequest, reviewConnectionAction, reviewCreateConnection } from './connectionActions'
import { useConnectionUpdates } from './connectionLive'
import { RevokeConnectionDialog } from './RevokeConnection'
import { AnimatePresence } from 'framer-motion'
import { shown } from '../../lib/displayName'

export function SwarmConnections({ swarm }: { swarm: Swarm }) {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ConnectionAgreement | null>(null)
  const [reason, setReason] = useState('')
  const agreements = useResource(() => need(client, 'listConnections', 'Connection agreements')(swarm.id), { context: swarm.id, poll: 15000 })
  const requests = useResource(async () => (await need(client, 'listRequests', 'Requests')()).filter((r) => r.from_swarm === swarm.id || r.to_swarm === swarm.id), { context: swarm.id, poll: 15000 })
  useConnectionUpdates(swarm.id, agreements)
  const name = (id: string) => swarms[id]?.name ?? id
  const mindName = (id: string) => agents[id]?.name ?? id
  const act = async (c: ConnectionAgreement, action: ConnectionAction, days?: number) => {
    if (busy) return
    setBusy(c.id)
    try {
      const updated = await reviewConnectionAction(client, c, action, days, { swarm: name, mind: mindName })
      if (!updated) return
      agreements.mutate((data) => (data ?? []).map((item) => item.id === updated.id ? updated : item))
      agreements.reload(); requests.reload()
    } catch (e) { toast(actionFailure(e, 'Could not update connection')) }
    finally { setBusy(null) }
  }
  return <section aria-label="Swarm connections" className="space-y-5 px-1 pb-8">
    <ConfirmHost />
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lead font-semibold">Connection agreements</h2><Button disabled={!has(client, 'createConnection') || !!busy} onClick={() => setCreating(!creating)}>{creating ? 'Close form' : 'Connect a swarm'}</Button></div>
    {creating && <ConnectionForm swarm={swarm} onCreated={() => { setCreating(false); agreements.reload() }} />}
    <ResourceView res={agreements} errorTitle="Could not load connections" empty={{ title: 'No connection agreements', body: 'Connect swarms with a purpose, specific request permissions, a duration and a budget.' }}>
      {(items) => <div className="space-y-3">{items.map((c) => <article key={c.id} aria-label={`Connection: ${c.purpose}`} className="rounded-2xl border border-line-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-semibold break-words">{c.purpose}</h3><span className="rounded-lg border border-line-2 px-2 py-1 text-meta">{c.status}</span></div>
        <p className="mt-2 text-small text-ink-2">{name(c.from_swarm)} ↔ {name(c.to_swarm)}</p>
        <p className="text-meta text-ink-3">Coordinators: {mindName(c.from_coordinator)} ↔ {mindName(c.to_coordinator)}</p>
        <dl className="mt-3 space-y-1 text-small"><div><dt className="inline text-ink-3">Ends: </dt><dd className="inline">{c.until_revoked ? `Until revoked · review ${c.review_at ? new Date(c.review_at).toLocaleString() : 'unavailable'}` : c.ends_at ? new Date(c.ends_at).toLocaleString() : 'unavailable'}</dd></div><div><dt className="inline text-ink-3">Request allocation: </dt><dd className="inline">{money(c.allocated_usd)} of {money(c.budget_usd)} <SimChip /></dd></div>{c.deliverable && <div><dt className="inline text-ink-3">Deliverable: </dt><dd className="inline">{c.deliverable}</dd></div>}{c.success && <div><dt className="inline text-ink-3">Success: </dt><dd className="inline">{c.success}</dd></div>}</dl>
        <ul aria-label="Granted scopes" className="mt-3 space-y-1 text-small">{c.scopes.map((scope, i) => <li key={i} className="break-words rounded-lg bg-white/[0.04] p-2">{scope.kind === 'requests' ? `${scope.direction === 'from->to' ? `${name(c.from_swarm)} → ${name(c.to_swarm)}` : `${name(c.to_swarm)} → ${name(c.from_swarm)}`}: ${scope.kinds.join(', ')} requests` : `Read memory: ${mindName(scope.mind)} / ${scope.space}${scope.pattern ? ` · ${scope.pattern}` : ''}`}</li>)}</ul>
        <p className="mt-2 text-meta text-ink-3">{c.note}</p>
        <div className="mt-3 flex flex-wrap gap-2">{c.status === 'active' && <Button disabled={!!busy || !has(client, 'connectionAction')} onClick={() => void act(c, 'pause')}>Pause</Button>}{c.status === 'paused' && <Button disabled={!!busy || !has(client, 'connectionAction')} onClick={() => void act(c, 'resume')}>Resume</Button>}{c.status !== 'revoked' && <RenewControl disabled={!!busy || !has(client, 'connectionAction')} onRenew={(days) => void act(c, 'renew', days)} />}{(c.status === 'active' || c.status === 'paused') && <Button variant="danger" disabled={!!busy || !has(client, 'connectionAction')} onClick={() => (setReason(''), setRevoking({ ...c }))}>Revoke…</Button>}</div>
        <details className="mt-3 text-meta text-ink-3"><summary className="min-h-11 cursor-pointer py-3">History · {c.history.length}</summary><ol className="space-y-1">{c.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.event} · {h.by}{h.reason ? ` · ${h.reason}` : ''}</li>)}</ol></details>
        <p className="break-all font-mono text-meta text-ink-4">{c.id}</p>
      </article>)}</div>}
    </ResourceView>
    <AnimatePresence>{revoking && <RevokeConnectionDialog seen={revoking} live={agreements.data?.find((x) => x.id === revoking.id)} name={name} mind={mindName} reason={reason} setReason={setReason} onClose={() => setRevoking(null)} onDone={(updated) => { agreements.mutate((data) => (data ?? []).map((item) => item.id === updated.id ? updated : item)); agreements.reload(); requests.reload() }} />}</AnimatePresence>
    <h2 className="text-lead font-semibold">Requests involving this swarm</h2>
    <ResourceView res={requests} errorTitle="Could not load requests" empty={{ title: 'No requests', body: 'Coordinating minds send requests through their authenticated harness.' }}>
      {(items) => <ul className="space-y-2">{items.map((r) => <li key={r.id} className="rounded-xl border border-line p-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-body font-medium">{r.title}</span><span className="text-meta" data-state={r.state}>{requestStateLabel(r.state)}</span></div><p className="text-small text-ink-3">{name(r.from_swarm)} → {name(r.to_swarm)} · {r.kind}</p><p className="break-all font-mono text-meta text-ink-4">{r.id}{typeof r.connection_id === 'string' ? ` · ${r.connection_id}` : ''}</p>{!isTerminalRequest(r) && <Button disabled={!!busy || !has(client, 'cancelRequest')} onClick={async () => { setBusy(r.id); try { if (await reviewCancelRequest(client, r)) requests.reload() } catch(e) { toast(actionFailure(e, 'Could not cancel request')) } finally { setBusy(null) } }}>Cancel request</Button>}</li>)}</ul>}
    </ResourceView>
  </section>
}

function RenewControl({ disabled, onRenew }: { disabled: boolean; onRenew: (days: number) => void }) {
  const [days, setDays] = useState(7)
  return <div className="flex items-center gap-2"><label className="text-meta">Renew days <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-16 rounded-lg border border-control bg-abyss px-2 py-2" /></label><Button disabled={disabled || !Number.isFinite(days) || days < 1 || days > 365} onClick={() => onRenew(days)}>Renew</Button></div>
}

function ConnectionForm({ swarm, onCreated }: { swarm: Swarm; onCreated: () => void }) {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [target, setTarget] = useState('')
  const [purpose, setPurpose] = useState('')
  const [deliverable, setDeliverable] = useState('')
  const [success, setSuccess] = useState('')
  const [kinds, setKinds] = useState('')
  const [days, setDays] = useState(7)
  const [budget, setBudget] = useState(0)
  const [onEnd, setOnEnd] = useState<'drain' | 'cancel'>('drain')
  const [busy, setBusy] = useState(false)
  const receiver = swarms[target]
  const valid = !!swarm.coordinator_id && !!receiver?.coordinator_id && !!purpose.trim() && !!kinds.trim() && Number.isFinite(days) && days > 0 && days <= 365 && Number.isFinite(budget) && budget >= 0 && budget <= 100000
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!valid || busy) return
    const body: CreateRequestConnection = { from_swarm: swarm.id, to_swarm: target, from_coordinator: swarm.coordinator_id!, to_coordinator: receiver.coordinator_id!, purpose: purpose.trim(), deliverable, success, scopes: [{ kind: 'requests', direction: 'from->to', kinds: [...new Set(kinds.split(',').map((s) => s.trim()).filter(Boolean))] }], days, budget_usd: budget, on_end: onEnd }
    if (!body.scopes[0].kinds.length) return
    setBusy(true)
    try { if (await reviewCreateConnection(client, body, { swarm: (id) => swarms[id]?.name ?? id, mind: (id) => agents[id]?.name ?? id })) onCreated() } catch(e) { toast(actionFailure(e, 'Could not create connection')) } finally { setBusy(false) }
  }
  const input = 'mt-1 w-full rounded-xl border border-control bg-abyss px-3 py-2 text-body'
  return <form onSubmit={(e) => void submit(e)} aria-label="New swarm connection" className="space-y-3 rounded-2xl border border-control p-4">
    <h3 className="text-body font-semibold">Request agreement</h3>
    <label className="block text-small">Receiving swarm<select value={target} onChange={(e) => setTarget(e.target.value)} className={input} required><option value="">Choose a swarm</option>{Object.values(swarms).filter((s) => s.id !== swarm.id).map((s) => <option key={s.id} value={s.id}>{shown(s.name)}</option>)}</select></label>
    {(!swarm.coordinator_id || (receiver && !receiver.coordinator_id)) && <p className="text-small text-warn">Both swarms need a designated coordinating mind.</p>}
    <label className="block text-small">Purpose<input required maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} className={input} /></label>
    <label className="block text-small">Deliverable<input maxLength={500} value={deliverable} onChange={(e) => setDeliverable(e.target.value)} className={input} /></label>
    <label className="block text-small">Success criteria<input maxLength={500} value={success} onChange={(e) => setSuccess(e.target.value)} className={input} /></label>
    <label className="block text-small">Allowed request kinds, comma separated<input required value={kinds} onChange={(e) => setKinds(e.target.value)} className={input} placeholder="code-review" /></label>
    <div className="grid grid-cols-2 gap-3"><label className="block text-small">Duration in days<input type="number" min={1} max={365} required value={days} onChange={(e) => setDays(Number(e.target.value))} className={input} /></label><label className="block text-small">Request allocation limit ($)<input type="number" min={0} max={100000} step="0.01" required value={budget} onChange={(e) => setBudget(Number(e.target.value))} className={input} /></label></div>
    <label className="block text-small">When paused or expired<select value={onEnd} onChange={(e) => setOnEnd(e.target.value as 'drain' | 'cancel')} className={input}><option value="drain">Let running requests finish</option><option value="cancel">Cancel running requests</option></select></label>
    <Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? 'Creating…' : 'Review connection'}</Button>
  </form>
}
