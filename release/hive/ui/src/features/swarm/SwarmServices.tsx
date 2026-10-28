import { AnimatePresence } from 'framer-motion'
import { useState, type FormEvent } from 'react'
import type { SwarmServices as Services } from '../../api/moneyWork'
import type { ConnectionAgreement, Swarm } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago, until } from '../../lib/format'
import { actionFailure, errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button, Skeleton } from '../../ui/primitives'
import { normKinds, serviceGrants, type ServiceGrant } from './swarmEdit'
import { useConnectionUpdates } from './connectionLive'
import { RevokeReason } from './RevokeConnection'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'

/**
 * What this swarm serves other swarms (request kinds it accepts), and which connections grant requests it does not
 * offer to everyone. Advertising a kind proves nothing about ability; a connection grants it for its time and budget.
 * Admins change offers and revoke grants.
 */
export function SwarmServices({ swarm }: { swarm: Swarm }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const me = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const admin = me.data ? me.data.kind === 'password' || me.data.role === 'admin' : false
  const res = useResource(() => need(client, 'swarmServices', 'Services')(swarm.id), { context: swarm.id, isEmpty: () => false })
  const conns = useResource(() => need(client, 'listConnections', 'Connections')(swarm.id), { context: swarm.id, poll: 30_000 })
  useConnectionUpdates(swarm.id, conns)
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<'public' | 'connection'>('public')
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<ServiceGrant | null>(null)
  if (!has(client, 'swarmServices') || res.status === 'unsupported') return null
  const name = (id: string) => shown(swarms[id]?.name ?? id)
  const canEdit = admin && has(client, 'setSwarmServices')
  const grants = conns.data ? serviceGrants(swarm.id, conns.data) : null

  const save = async (next: Services, done: string) => {
    setBusy(true)
    try {
      const out = await need(client, 'setSwarmServices', 'Changing services')(swarm.id, { kinds: next.kinds, connection_only_kinds: next.connection_only_kinds })
      res.mutate(() => out)
      toast({ tone: 'success', title: done })
      return true
    } catch (e) {
      toast(actionFailure(e, 'Could not change services'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const cur = res.data
    const kinds = normKinds(draft)
    if (!cur || !kinds.length) return
    const next = scope === 'public'
      ? { ...cur, kinds: normKinds([...cur.kinds, ...kinds]), connection_only_kinds: cur.connection_only_kinds.filter((k) => !kinds.includes(k)) }
      : { ...cur, connection_only_kinds: normKinds([...cur.connection_only_kinds, ...kinds]), kinds: cur.kinds.filter((k) => !kinds.includes(k)) }
    if (await save(next, `${name(swarm.id)} now offers ${kinds.join(', ')}`)) setDraft('')
  }
  const withdraw = (kind: string) => {
    const cur = res.data
    if (!cur) return
    void save({ ...cur, kinds: cur.kinds.filter((k) => k !== kind), connection_only_kinds: cur.connection_only_kinds.filter((k) => k !== kind) }, `${kind} withdrawn: requests already made carry on`)
  }

  return (
    <section aria-labelledby="svc-h" className="mb-4 rounded-2xl border border-line bg-white/[0.02] p-4" data-tour="swarm-services">
      <h2 id="svc-h" className="eyebrow">
        Services to other swarms
      </h2>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
        The kinds of request {name(swarm.id)} takes from other swarms. Offering a kind is a promise to look, not proof of ability.
      </p>
      {res.status === 'loading' ? (
        <Skeleton className="mt-3 h-16 rounded-xl" />
      ) : res.status === 'error' ? (
        <p className="mt-3 text-[13px] text-bad">Could not read services: {errorMessage(res.error)}</p>
      ) : res.data ? (
        <div className="mt-3 space-y-3">
          <Kinds title="Offered to every swarm that can see it" kinds={res.data.kinds} onWithdraw={canEdit && !busy ? withdraw : undefined} empty="Nothing offered to everyone." />
          <Kinds title="Only through a connection" kinds={res.data.connection_only_kinds} onWithdraw={canEdit && !busy ? withdraw : undefined} empty="Nothing kept for connections." />
          {canEdit && (
            <form onSubmit={add} className="flex flex-wrap items-center gap-2">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="code-review, plan" aria-label="Request kinds to offer" className="min-h-10 min-w-[160px] flex-1 rounded-xl border border-line bg-black/30 px-3 text-[13px] text-ink outline-none focus:border-line-2" />
              <select value={scope} onChange={(e) => setScope(e.target.value as 'public' | 'connection')} aria-label="Offered to" className="min-h-10 rounded-xl border border-line bg-black/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
                <option value="public">to everyone who can see it</option>
                <option value="connection">only through a connection</option>
              </select>
              <Button type="submit" variant="subtle" icon="plus" disabled={busy || !normKinds(draft).length} className="min-h-10">
                Offer
              </Button>
            </form>
          )}
        </div>
      ) : null}

      {grants && (grants.toUs.length > 0 || grants.fromUs.length > 0) && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[12px] font-medium text-ink-2">Granted through connections</h3>
          <ul className="overflow-hidden rounded-xl border border-line bg-black/20 text-[12.5px]">
            {[...grants.toUs, ...grants.fromUs].map((g, i) => (
              <li key={`${g.connection.id}:${g.asker}:${g.kinds.join()}`} className={i ? 'flex items-start gap-2 border-t border-line px-3 py-2' : 'flex items-start gap-2 px-3 py-2'}>
                <Icon name="link" size={15} className="mt-0.5 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="text-ink">
                    {name(g.asker)} may ask {name(g.server)} for <span className="font-medium">{g.kinds.join(', ')}</span>
                  </div>
                  <div className="text-meta text-ink-4">
                    “{g.connection.purpose}” · {g.connection.status}
                    {g.connection.ends_at ? ` · ends ${until(g.connection.ends_at)}` : g.connection.until_revoked ? ' · until revoked' : ''} · ${g.connection.allocated_usd.toFixed(2)} of ${g.connection.budget_usd.toFixed(2)} used
                  </div>
                </div>
                {admin && has(client, 'connectionAction') && (
                  <Button variant="danger" className="min-h-9 px-2.5 text-[12px]" onClick={() => setRevoking({ ...g, connection: structuredClone(g.connection) })}>
                    Revoke…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AnimatePresence>
        {revoking && (
          <RevokeGrant
            grant={revoking}
            live={conns.data?.find((c) => c.id === revoking.connection.id)}
            name={name}
            onClose={() => setRevoking(null)}
            onDone={conns.reload}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

function Kinds({ title, kinds, onWithdraw, empty }: { title: string; kinds: string[]; onWithdraw?: (k: string) => void; empty: string }) {
  return (
    <div>
      <div className="mb-1 text-[12px] text-ink-3">{title}</div>
      {kinds.length === 0 ? (
        <div className="text-[12.5px] text-ink-4">{empty}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <span key={k} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-white/[0.04] pr-1 pl-2.5 text-[12.5px] text-ink">
              {k}
              {onWithdraw ? (
                <button onClick={() => onWithdraw(k)} aria-label={`Withdraw ${k}`} title={`Withdraw ${k}`} className="flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-white/[0.08] hover:text-ink">
                  <Icon name="x" size={13} />
                </button>
              ) : (
                <span className="w-1.5" />
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Revoking the connection behind a service grant, bound to the identity it was pressed under (r5). */
export function revokeGrantRun(d: { client: HiveClient | null; id: string; reason: string; onDone: () => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    try {
      await need(d.client, 'connectionAction', 'Revoking a connection')(d.id, 'revoke', undefined, d.reason.trim())
      binding.commit(() => {
        d.onDone()
        d.toast({ tone: 'success', icon: 'ban', title: 'Connection revoked', body: 'No new requests through it. What was already read stays read.' })
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

function RevokeGrant({ grant, live, name, onClose, onDone }: { grant: ServiceGrant; live: ConnectionAgreement | undefined; name: (id: string) => string; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [reason, setReason] = useState('')
  const c = grant.connection
  const scopes = c.scopes.map((s) => (s.kind === 'requests' ? `${name(s.direction === 'from->to' ? c.from_swarm : c.to_swarm)} may ask for ${s.kinds.join(', ')}` : `${s.mind} shares ${s.space}${s.pattern ? ` (only “${s.pattern}”)` : ''} with the other side`))
  return (
    <DecisionDialog
      icon="ban"
      eyebrow="Revoke a connection"
      title={`Stop ${name(grant.asker)} asking ${name(grant.server)} for ${grant.kinds.join(', ')}?`}
      facts={[
        ['Connection', `${name(c.from_swarm)} ↔ ${name(c.to_swarm)} (${c.id})`],
        ['Purpose', c.purpose],
        ['Everything it grants', <ul className="space-y-0.5">{scopes.map((s) => <li key={s}>{s}</li>)}</ul>],
        ['Status', c.status],
        ['Time', c.ends_at ? `ends ${new Date(c.ends_at).toLocaleString()} (${until(c.ends_at)})` : c.until_revoked ? 'until revoked' : 'no end set'],
        ['Budget', `$${c.allocated_usd.toFixed(2)} of $${c.budget_usd.toFixed(2)} allocated`],
        ['Requests in flight', c.on_end === 'drain' ? 'left to finish' : 'cancelled'],
        ['Made', `${ago(c.created_at)} by ${c.created_by}`],
      ]}
      bound={bindTo(c, live, ['id', 'status', 'scopes', 'ends_at', 'budget_usd', 'on_end'], (l) => (l.status === 'revoked' || l.status === 'ended' ? `This connection is already ${l.status}.` : null))}
      thing="This connection"
      onClose={onClose}
      actions={[
        {
          label: 'Revoke the connection',
          busyLabel: 'Revoking',
          tone: 'danger',
          run: revokeGrantRun({ client, id: c.id, reason, onDone, toast }),
        },
      ]}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Revoking ends the whole connection, not just this kind: every grant above stops at once and cannot be resumed. It cannot erase what was already read. A new connection can be made later.
      </p>
      <RevokeReason value={reason} onChange={setReason} />
    </DecisionDialog>
  )
}
