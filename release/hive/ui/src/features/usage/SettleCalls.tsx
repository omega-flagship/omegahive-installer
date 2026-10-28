import { AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { heldCount, useHeldCalls } from './heldCalls'
import type { CostReservation } from '../../api/moneyWork'
import { bindTo, decisionFailure, type DecisionResult } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { errorMessage, has, isForbidden, need, useResource } from '../../lib/useResource'
import { hiveBus, useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button, Skeleton } from '../../ui/primitives'
import { useNow } from '../../lib/hooks'
import { canSettle, exactUsd, heldTiming, overrunUsd, parseUsd, releaseBlocked, scopeWords, SEEN_FIELDS, settleBlocked, splitReservations } from './settle'

/**
 * Calls whose cost is held because their outcome is unknown (the stream broke, the provider never said what it
 * charged), or that have been in flight too long. A person reads the provider's billing and settles the real cost, or
 * releases the hold; an unknown call nobody settles is settled by the hive at its held worst case after a day
 * (cost_reservations.expire_unknown). A money decision, so it is only ever taken in a full inspection (Review R2/R3).
 * Admins. Timing and `resolvable` come from Platform's coming fields; without them the panel says less, never guesses.
 */
export function SettleCalls() {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'listReservations', 'Held costs')(), { poll: 15_000, isEmpty: () => false })
  const over = useResource(() => need(client, 'listOverruns', 'Overruns')(), { poll: 60_000 })
  // budget.overrun (audit drift): a new overrun is read at once instead of at the next 60 s poll
  const reloads = useRef([over.reload, res.reload])
  useEffect(() => {
    reloads.current = [over.reload, res.reload]
  })
  useEffect(() => hiveBus.on((e) => { if (e.type === 'budget.overrun') reloads.current.forEach((r) => r()) }), [])
  const [open, setOpen] = useState<CostReservation | null>(null)
  const name = useNamer()
  const now = useNow(30_000)
  // the Usage badge follows what this panel read (a settle here clears it at once)
  useEffect(() => {
    if (res.data) useHeldCalls.setState({ count: heldCount(res.data) })
  }, [res.data])
  if (!has(client, 'listReservations') || res.status === 'unsupported') return null
  if (res.status === 'error' && isForbidden(res.error)) return null

  const split = res.data ? splitReservations(res.data) : null
  return (
    <section aria-labelledby="settle-h" className="rounded-2xl border border-line bg-white/[0.02] p-4" data-tour="settle-calls">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="settle-h" className="eyebrow">
          Calls to settle
        </h2>
        {split && (
          <span className="text-meta text-ink-4">
            {split.toSettle.length} waiting on a person · {split.inFlight.length} in flight
          </span>
        )}
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
        When a model call ends without saying what it cost, its worst case stays held against every budget it counts toward. Read the provider’s billing, then settle the real cost or release the hold. If nobody does, the hive settles an unknown call at its held worst case after a day.
      </p>

      {res.status === 'loading' ? (
        <Skeleton className="mt-3 h-16 rounded-xl" />
      ) : res.status === 'error' ? (
        <p className="mt-3 text-[13px] text-bad">
          Could not read held costs: {errorMessage(res.error)}{' '}
          <button className="underline" onClick={res.reload}>
            Try again
          </button>
        </p>
      ) : split ? (
        <div className="mt-3 space-y-3">
          {split.toSettle.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-4">Nothing waiting: every call’s cost is known.</p>
          ) : (
            <ul className="overflow-hidden rounded-xl border border-warn/30 bg-warn/[0.04]">
              {split.toSettle.map((r, i) => (
                <li key={r.id} className={i ? 'flex flex-wrap items-center gap-3 border-t border-line px-3 py-2.5' : 'flex flex-wrap items-center gap-3 px-3 py-2.5'}>
                  <Icon name="coin" size={16} className="shrink-0 text-warn" />
                  <div className="min-w-0 flex-1 text-[13px]">
                    <div className="text-ink">
                      <span className="font-mono">{exactUsd(r.held_usd)}</span> held for {r.metadata.agent ? name('agent', r.metadata.agent) : 'a call'}
                      {r.metadata.model && <span className="text-ink-3"> on {r.metadata.model}</span>}
                    </div>
                    <div className="truncate text-meta text-ink-4">
                      {heldTiming(r, now).stuck ? `in flight too long (${r.state})` : (r.observation?.usage_origin ?? 'the provider never reported usage')} · {r.id}
                    </div>
                    <Timing r={r} now={now} />
                  </div>
                  <Button variant="subtle" className="min-h-9 px-3 text-[12.5px]" onClick={() => setOpen({ ...r, scopes: [...r.scopes], metadata: { ...r.metadata }, observation: r.observation && { ...r.observation } })}>
                    Review and settle…
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {split.inFlight.length > 0 && (
            <details className="text-[12.5px]">
              <summary className="min-h-9 cursor-pointer py-1 text-ink-3 hover:text-ink">Still in flight ({split.inFlight.length}): these settle themselves when the call answers</summary>
              <ul className="mt-1 space-y-1 text-ink-3">
                {split.inFlight.map((r) => (
                  <li key={r.id} className="flex gap-2">
                    <span className="font-mono text-ink-2">{exactUsd(r.held_usd)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.metadata.agent ? name('agent', r.metadata.agent) : 'a call'} · {r.metadata.model ?? r.metadata.kind ?? ''} · {r.state}
                      {heldTiming(r, now).held ? ` · ${heldTiming(r, now).held}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {over.data && over.data.length > 0 && (
            <div>
              <h3 className="mb-1 text-[12px] font-medium text-ink-2">Cost more than was held</h3>
              <ul className="space-y-1 text-[12.5px]">
                {over.data.slice(-8).reverse().map((o) => {
                  const u = overrunUsd(o)
                  return (
                    <li key={`${o.reservation}:${o.at}`} className="flex flex-wrap gap-x-2 text-ink-3">
                      <span className="text-bad">+{exactUsd(u.over)}</span>
                      <span>
                        {o.agent ? name('agent', o.agent) : 'a call'}: held {exactUsd(u.held)}, cost {exactUsd(u.actual)}
                      </span>
                      <span className="text-ink-4">
                        {o.source === 'resolve' ? 'settled by a person' : o.source === 'late-after-release' ? 'reported after its hold was released' : 'reported by the provider'} · {ago(new Date(o.at * 1000).toISOString())}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      <AnimatePresence>{open && <SettleDialog seen={open} live={res.data?.find((r) => r.id === open.id)} onClose={() => setOpen(null)} onDone={res.reload} />}</AnimatePresence>
    </section>
  )
}

/** How long it has been held, and when the hive settles it itself: only from fields the hive sent. */
function Timing({ r, now }: { r: CostReservation; now: number }) {
  const t = heldTiming(r, now)
  if (!t.held && !t.autoSettle) return null
  return (
    <div className="text-meta text-ink-3" data-held-timing>
      {[t.held, t.autoSettle].filter(Boolean).join(' · ')}
    </div>
  )
}

function useNamer() {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const keys = useHive((s) => s.keys)
  return (kind: 'agent' | 'swarm' | 'key', id: string) => {
    if (kind === 'agent') return agents[id] ? shown(agents[id].name) : id
    if (kind === 'swarm') return swarms[id] ? shown(swarms[id].name) : id
    const k = keys?.find((x) => x.id === id)
    return k ? `${k.label} ${k.hint}` : id
  }
}

function SettleDialog({ seen, live, onClose, onDone }: { seen: CostReservation; live: CostReservation | undefined; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const name = useNamer()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const bound = bindTo(seen, live, SEEN_FIELDS, (l) => (canSettle(l) ? null : `This call is ${l.state} now and not resolvable, so a person does not settle it.`))
  const timing = heldTiming(seen)
  const md = seen.metadata
  const ob = seen.observation
  const facts: [string, ReactNode][] = [
    ['Held', <span className="font-mono">{exactUsd(seen.held_usd)}</span>],
    ['State', seen.state === 'unknown' ? 'outcome unknown' : `${seen.state}, in flight too long`],
    ['Held for', timing.held ?? 'not reported by this hive'],
    ['If nobody settles it', timing.autoSettle ?? (seen.state === 'unknown' ? 'the hive settles it at the held amount a day after its outcome became unknown (exact time not reported by this hive)' : 'it stays held until its call answers or a person resolves it')],
    ['Call', <span className="font-mono text-[12px]">{seen.id}</span>],
    ['Mind', md.agent ? `${name('agent', md.agent)} (${md.agent})` : 'not recorded'],
    ['Model', md.model ?? 'not recorded'],
    ['Kind', md.kind ?? 'not recorded'],
    ['Who pays', md.payer ? (/^(swarm|agent|key):/.test(md.payer) ? scopeWords(`${md.payer}:`, name).trim() : md.payer) : 'the hive'],
    ['Key', md.key ? name('key', md.key) : 'the hive’s'],
    [
      'Counts against',
      <ul className="space-y-0.5">
        {seen.scopes.map((sc) => (
          <li key={sc}>
            {scopeWords(sc, name)} <span className="font-mono text-[11px] text-ink-4">{sc}</span>
          </li>
        ))}
      </ul>,
    ],
    ['Provider saw', ob ? [ob.response_id && `response ${ob.response_id}`, ob.resolved_model && `model ${ob.resolved_model}`, ob.usage_origin].filter(Boolean).join(' · ') || 'nothing' : 'nothing: no response id reached the hive'],
    ['Request digest', md.payload_hash ? <span className="font-mono text-[11px]">{md.payload_hash}</span> : 'not recorded'],
  ]
  const run = (action: 'settle' | 'release') => async (): Promise<DecisionResult> => {
    try {
      const body = action === 'settle' ? { action, actual_usd: parseUsd(amount) ?? NaN, reason: reason.trim() } : { action, reason: reason.trim() }
      const out = await need(client, 'resolveReservation', 'Settling a call')(seen.id, body)
      onDone()
      const actual = out.actual === null ? null : out.actual / 1e6
      toast({
        tone: 'success',
        icon: 'coin',
        title: action === 'settle' ? `Settled at ${exactUsd(actual ?? 0)}` : 'Hold released',
        body: action === 'settle' && actual !== null && actual > seen.held_usd ? `That is ${exactUsd(actual - seen.held_usd)} more than was held; it is recorded as an overrun.` : `${exactUsd(seen.held_usd)} is no longer held.`,
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  }
  return (
    <DecisionDialog
      icon="coin"
      eyebrow="A money decision"
      title={`Settle ${exactUsd(seen.held_usd)} held for ${md.agent ? name('agent', md.agent) : 'a call'}?`}
      facts={facts}
      bound={bound}
      thing="This call"
      onClose={onClose}
      actions={[
        { label: 'Settle the real cost', busyLabel: 'Settling', tone: 'primary', blocked: settleBlocked(amount, reason), run: run('settle') },
        { label: 'Release the hold', busyLabel: 'Releasing', tone: 'plain', blocked: releaseBlocked(reason), run: run('release') },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Real cost from the provider’s billing (to settle)</span>
        <span className="mt-1 flex min-h-11 items-center rounded-xl border border-line bg-black/30 px-3 focus-within:border-line-2">
          <span className="text-ink-3">$</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoComplete="off" className="w-full bg-transparent px-1.5 font-mono text-[13px] text-ink outline-none" />
        </span>
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Reason, recorded with the decision</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Billing shows $0.31 for response msg_…" className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <p className="text-meta leading-snug text-ink-4">Settling records the real cost against every budget above (more than was held is recorded as an overrun). Releasing frees the hold and charges nothing. Neither can be undone.</p>
    </DecisionDialog>
  )
}
