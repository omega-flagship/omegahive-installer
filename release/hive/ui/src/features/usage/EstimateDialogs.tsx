// Purpose: the two money decisions the Usage page's estimates open, each in a full inspection: correcting one estimate the hive settled at its worst case with the billed cost (or releasing it), and correcting or releasing all of them at once.
import { useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import type { EstimatedCall } from '../../api/moneyWork'
import { bindTo, decisionFailure, type DecisionResult } from '../../lib/decisionGate'
import { useNow } from '../../lib/hooks'
import { plural } from '../../lib/plural'
import { need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { useNamer } from './estimates'
import { bindEstimates, canCorrect, correctBlocked, ESTIMATE_FIELDS, ESTIMATE_WORDS, estimateSummary, estimateWords, exactUsd, heldReason, inWords, parseUsd, reasonBlocked, scopeWords, span } from './settle'



/** The facts a person reads about one estimate before correcting it, as the held call's dialog lists them. */
function estimateFacts(e: EstimatedCall, name: (kind: 'agent' | 'swarm' | 'key', id: string) => string, now: number): [string, ReactNode][] {
  const md = e.metadata
  const ob = e.observation
  return [
    ['Estimated', <span className="font-mono">{exactUsd(e.estimate_usd)}</span>],
    ['What that is', estimateWords(e)],
    ['Settled', `${span(now / 1000 - e.settled_at)} ago, by the hive, an hour after its cost went unknown`],
    ['Correct until', `${new Date(e.correctable_until * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${inWords(Math.max(0, e.correctable_until - now / 1000))} from now)`],
    ['Why it was held', heldReason(e)],
    ['Call', <span className="font-mono text-[12px]">{e.id}</span>],
    ['Mind', md.agent ? `${name('agent', md.agent)} (${md.agent})` : 'not recorded'],
    ['Model', md.model ?? 'not recorded'],
    ['Who pays', md.payer ? (/^(swarm|agent|key):/.test(md.payer) ? scopeWords(`${md.payer}:`, name).trim() : md.payer) : 'the hive'],
    ['Key', md.key ? name('key', md.key) : 'the hive’s'],
    [
      'Counted against',
      <ul className="space-y-0.5">
        {e.scopes.map((sc) => (
          <li key={sc}>
            {scopeWords(sc, name)} <span className="font-mono text-[11px] text-ink-4">{sc}</span>
          </li>
        ))}
      </ul>,
    ],
    ['Provider saw', ob ? [ob.response_id && `response ${ob.response_id}`, ob.resolved_model && `model ${ob.resolved_model}`, ob.usage_origin].filter(Boolean).join(' · ') || 'nothing' : 'nothing: no response id reached the hive'],
  ]
}

/** Correct one estimate: the cost the provider billed, or nothing billed (cost_reservations.correct). */
export function CorrectDialog({ seen, live, onClose, onDone }: { seen: EstimatedCall; live: EstimatedCall | undefined; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const name = useNamer()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const amountField = useRef<HTMLInputElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  // the clock as a hook reads it (a render may not read it directly): the facts' "ago" and "from now" stay current
  const now = useNow(30_000)
  const bound = bindTo(seen, live, ESTIMATE_FIELDS, (l) => (canCorrect(l, now) ? null : 'This estimate is past its 30 days, so it stands.'))
  const run = (action: 'settle' | 'release') => async (): Promise<DecisionResult> => {
    try {
      const body = action === 'settle' ? { action, actual_usd: parseUsd(amount) ?? NaN, reason: reason.trim() } : { action, reason: reason.trim() }
      const out = await need(client, 'correctReservation', 'Correcting an estimate')(seen.id, body)
      onDone()
      const billed = (out.actual ?? 0) / 1e6
      toast({
        tone: 'success',
        icon: 'coin',
        title: action === 'settle' ? `Corrected to ${exactUsd(billed)}` : 'Corrected: nothing was billed',
        body: billed > out.maximum / 1e6 ? `That is ${exactUsd(billed - out.maximum / 1e6)} more than was held; it is recorded as an overrun.` : `${exactUsd(seen.estimate_usd - billed)} less is counted against every budget above.`,
      })
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_correctable') onDone()
      return decisionFailure(e)
    }
  }
  return (
    <DecisionDialog
      icon="coin"
      eyebrow="A money decision"
      title={`Correct the ${exactUsd(seen.estimate_usd)} estimate for ${seen.metadata.agent ? name('agent', seen.metadata.agent) : 'a call'}?`}
      facts={estimateFacts(seen, name, now)}
      bound={bound}
      fields={{ amount: amountField, reason: reasonField }}
      thing="This estimate"
      onClose={onClose}
      actions={[
        { label: 'Correct to the billed cost', busyLabel: 'Correcting', tone: 'primary', blocked: correctBlocked(amount, reason), run: run('settle') },
        { label: 'Nothing was billed', busyLabel: 'Releasing', tone: 'plain', blocked: reasonBlocked(reason), run: run('release') },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Billed cost from the provider’s billing</span>
        <span className="mt-1 flex min-h-11 items-center rounded-xl border border-line bg-shade/30 px-3 focus-within:border-line-2">
          <span className="text-ink-3">$</span>
          <input ref={amountField} name="amount" inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="0.00" autoComplete="off" className="w-full bg-transparent px-1.5 font-mono text-[13px] text-ink outline-none" />
        </span>
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Reason, recorded with the correction</span>
        <textarea ref={reasonField} name="reason" value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} placeholder="Billing shows $0.02 for response msg_…" className="mt-1 w-full resize-y rounded-xl border border-line bg-shade/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <p className="text-meta leading-snug text-ink-4">The estimate stays in the record and a correction is added beside it, in the day and month the estimate was counted. More than was held is recorded as an overrun. A call is corrected once, and it can’t be undone.</p>
    </DecisionDialog>
  )
}

/**
 * Correct all (the bulk route): every estimate the person saw, released because the provider's billing shows nothing
 * was billed, or kept because it shows they cost what was estimated, as one decision with one reason; all or none.
 */
export function CorrectAllDialog({ seen, live, onClose, onDone }: { seen: EstimatedCall[]; live: EstimatedCall[] | undefined; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const name = useNamer()
  const [reason, setReason] = useState('')
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const now = useNow(30_000)
  const sum = estimateSummary(seen)
  const oldest = Math.min(...seen.map((e) => e.settled_at))
  const soonest = Math.min(...seen.map((e) => e.correctable_until))
  const total = <span className="font-mono">{exactUsd(sum.usd)}</span>
  const facts: [string, ReactNode][] = [
    ['Calls', `${sum.count} settled at their worst case`],
    ['Estimated in total', total],
    ['What that is', ESTIMATE_WORDS],
    [
      'Why they were held',
      <ul className="space-y-0.5">
        {sum.reasons.map((r) => (
          <li key={r.reason}>
            {r.count} × {r.reason}
          </li>
        ))}
      </ul>,
    ],
    [
      'By mind and model',
      <ul className="space-y-0.5">
        {sum.groups.map((g) => (
          <li key={`${g.agent}:${g.model}`}>
            {g.agent ? name('agent', g.agent) : 'a call'}
            {g.model ? ` on ${g.model}` : ''}: {plural(g.count, 'call')}, <span className="font-mono">{exactUsd(g.usd)}</span>
          </li>
        ))}
      </ul>,
    ],
    ['Oldest', `settled ${span(now / 1000 - oldest)} ago; the first can be corrected until ${new Date(soonest * 1000).toLocaleDateString()}`],
    ['Release all', <>records that nothing was billed, and takes {total} off every budget the calls counted toward</>],
    ['Keep all', <>records that the billing matches the estimates, and keeps {total} counted</>],
  ]
  const run = (action: 'settle' | 'release') => async (): Promise<DecisionResult> => {
    try {
      const out = await need(client, 'correctReservations', 'Correcting all estimates')({ action, ids: seen.map((e) => e.id), reason: reason.trim() })
      onDone()
      toast({
        tone: 'success',
        icon: 'coin',
        title: action === 'release' ? `Released ${plural(out.count, 'estimate')}` : `Kept ${plural(out.count, 'estimate')}`,
        body: action === 'release' ? `${exactUsd(out.estimate_usd)} no longer counts against any budget.` : 'Each estimate is recorded as what was billed.',
      })
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_correctable') onDone()   // read the list again: the binding then says which changed
      return decisionFailure(e)
    }
  }
  return (
    <DecisionDialog
      icon="coin"
      eyebrow="A money decision"
      title={`Correct or release all ${plural(sum.count, 'estimate')} (${exactUsd(sum.usd)})?`}
      facts={facts}
      bound={bindEstimates(seen, live)}
      fields={{ reason: reasonField }}
      thing="These estimates"
      onClose={onClose}
      actions={[
        { label: `Release all ${exactUsd(sum.usd)}`, busyLabel: 'Releasing', tone: 'primary', blocked: reasonBlocked(reason), run: run('release') },
        { label: `Keep all at ${exactUsd(sum.usd)}`, busyLabel: 'Keeping', tone: 'plain', blocked: reasonBlocked(reason), run: run('settle') },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Reason, recorded with each call</span>
        <textarea ref={reasonField} name="reason" value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} placeholder="Provider billing shows no charge for these calls" className="mt-1 w-full resize-y rounded-xl border border-line bg-shade/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <p className="text-meta leading-snug text-ink-4">Every estimate above is corrected together, or none is. An estimate made after this opened is not included. A call is corrected once, and it can’t be undone.</p>
    </DecisionDialog>
  )
}
