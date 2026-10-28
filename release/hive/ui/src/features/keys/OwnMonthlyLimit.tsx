import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { bindOperation } from '../../lib/boundOperation'
import { bindEpoch, currentEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { money } from '../../lib/format'
import { useHive } from '../../store/store'
import { Button } from '../../ui/primitives'
import { parseLimit, readOwnLimit, saveOwnLimit, type OwnLimitState } from './ownLimit'

/**
 * r1.14b (Design walk 144100Z): the person's monthly total on their OWN keys, the self / all-keys limit
 * (key_limits owner = you, grantee self, key_id '*') that paid work on an own key checks first (Studio's
 * `monthly_total_required`). Read from GET /api/me/key-limits; saved with the existing PUT /api/me/key-limits/self
 * {key_id:'*', month_usd}. Not the hive's per-person allowance (Limits), which governs the hive's keys only.
 *
 * Identity (Design 145300Z #1, 145800Z #2): the body is keyed by the identity epoch, which moves on every sign-in change: everything shown, typed or said under the earlier person is
 * dropped with it, and every later state write goes through the binding it began under.
 */
export function OwnMonthlyLimit() {
  // keyed by the identity epoch itself (every sign-in change: another client, a credential-only re-login, a re-init),
  // so nothing shown, typed or said under the earlier person survives it (Design 145800Z #2)
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  return <OwnMonthlyLimitBody key={epoch} />
}

export const SAVE_UNCONFIRMED_WORDS = 'The change could not be confirmed. It may or may not have been saved; read it again before any paid work.'
export const SAVE_REFUSED_WORDS = 'The hive did not save it. Nothing changed.'

function OwnMonthlyLimitBody() {
  const client = useHive((s) => s.client)
  const [view, setView] = useState<OwnLimitState | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [readNo, setReadNo] = useState(0)
  const mounted = useRef(true)
  const read = client?.myKeyLimits
  const write = client?.setOwnKeyLimit
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!read) return
    let live = true
    const b: EpochBinding = bindEpoch()   // the answer is shown only to the person it was asked for
    read.call(client).then(
      (v) => { if (live) b.commit(() => setView(readOwnLimit(v))) },
      () => { if (live) b.commit(() => setView({ state: 'unreadable' })) },
    )
    return () => { live = false }
  }, [client, read, readNo])
  if (!read || !write) return null
  const save = (e: FormEvent) => {
    e.preventDefault()
    const month = parseLimit(text)
    if (month === null) return setSaid('Enter an amount in dollars, like 50 or 12.50.')
    setBusy(true)
    setSaid(null)
    // one chain bound to this sign-in and this page: the write, then the host's own readback before "saved" is said
    const op = bindOperation(() => mounted.current)
    const commit = (fn: () => void) => { op.binding.commit(() => { if (mounted.current) fn() }) }
    void saveOwnLimit(op, { write: (b) => write.call(client, b), read: () => read.call(client) }, month).then((out) => commit(() => {
      setBusy(false)
      if (out.kind === 'stopped') return
      if (out.kind === 'saved') { setView(out.view); setText(''); setSaid(`Saved: up to ${money(month)} a month on your own keys.`) }
      else if (out.kind === 'refused') setSaid(SAVE_REFUSED_WORDS)
      else { if (out.view) setView(out.view); setSaid(SAVE_UNCONFIRMED_WORDS) }
    }))
  }
  return (
    <section aria-labelledby="own-limit-h" data-own-monthly-limit={view?.state ?? 'reading'} className="rounded-2xl border border-line bg-white/[0.03] p-4">
      <h2 id="own-limit-h" className="eyebrow">Monthly total on your own keys</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        {view === null ? 'Reading…'
          : view.state === 'set' ? `Up to ${money(view.limit.month_usd)} a month${view.limit.spent_usd !== null ? ` · ${money(view.limit.spent_usd)} spent this month` : ''}.`
          : view.state === 'unset' ? 'Not set yet. Paid work on your own keys, such as live drawing in Studio, waits until you set it.'
          : 'Could not read it right now.'}
      </p>
      {view && view.state !== 'unreadable' && view.ownKeys === 0 && <p className="mt-1 text-[12px] text-ink-4">It applies once you add a key of your own above.</p>}
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={save}>
        <label className="text-[12.5px]" htmlFor="own-limit-amount">{view?.state === 'set' ? 'Change it to' : 'Set it to'} $</label>
        <input id="own-limit-amount" inputMode="decimal" className="w-28 rounded-lg border border-line bg-transparent px-2 py-1 text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="50" aria-label="Monthly total on your own keys, in dollars" />
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        {(view?.state === 'unreadable' || said === SAVE_UNCONFIRMED_WORDS) && <Button variant="subtle" disabled={busy} onClick={() => { setSaid(null); setReadNo((n) => n + 1) }}>Read it again</Button>}
      </form>
      {said && <p role="status" className="mt-2 text-[12px]">{said}</p>}
    </section>
  )
}
