import { useEffect, useState } from 'react'
import type { AskAuditRow, AskAuditTurn } from '../../api/missingUi'
import { ago } from '../../lib/format'
import { useMe } from '../../lib/useAdmin'
import { errorMessage, has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch, type EpochBinding } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import { Button } from '../../ui/primitives'
import { keptWords, turnOutcome } from '../ask/Earlier'

const PAGE = 50

/** One frame of an audited turn as a plain line: its phase and what it carried (text is shown as text, never HTML). Pure. */
export function frameLine(e: AskAuditTurn['events'][number]): string {
  const f = e as unknown as Record<string, unknown>
  const text = typeof f.text === 'string' ? f.text : typeof f.say === 'string' ? f.say : typeof f.step === 'string' ? f.step : ''
  const extra = e.phase === 'refused' && typeof f.reason === 'string' ? ` (${f.reason})` : e.phase === 'done' && typeof f.turn_spent_usd === 'number' ? ` ($${f.turn_spent_usd.toFixed(4)})` : ''
  return `${e.phase}${extra}${text ? `: ${text}` : e.phase === 'answer' ? ': (words removed)' : ''}`
}

/** The next page's `before`: the oldest row's created_at (the host's filter is strict). Pure. */
export const nextBefore = (rows: Pick<AskAuditRow, 'created_at'>[]): string | null => (rows.length ? rows[rows.length - 1].created_at : null)

/**
 * The Ask audit (GET /api/ask/audit and /api/ask/audit/{turn}; admins; Surface missing-UI batch 1, audit item 9):
 * every person's Ask turns, newest first, and one turn's frames. Everyone who asks is told admins can review it (the
 * line under every Ask thread). A deleted thread's turns keep their rows without words; that is shown, not hidden.
 */
export function AskAudit() {
  const client = useHive((s) => s.client)
  const { admin, loaded } = useMe()
  // r5: everything read here is the signed-in admin's view; a new identity starts it empty (keyed by the epoch)
  const epoch = useIdentityEpoch()
  if (!loaded || !admin || !has(client, 'askAudit')) return null
  return <AuditList key={epoch} />
}

function AuditList() {
  const [principal, setPrincipal] = useState('')
  const [applied, setApplied] = useState('')
  return (
    <section className="rounded-2xl border border-line bg-tint/[0.02] p-4" aria-labelledby="ask-audit-h" data-ask-audit>
      <h2 id="ask-audit-h" className="eyebrow pb-1">Ask audit</h2>
      <p className="pb-3 text-[12.5px] text-ink-3">Every person’s Ask turns, newest first, as the hive keeps them. People are told under every Ask thread that admins can review it. A deleted thread keeps its rows without words.</p>
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(principal.trim())
        }}
      >
        <label className="block min-w-[200px] flex-1">
          <span className="text-[12px] text-ink-3">Only one person (their id, like user:p_ada)</span>
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="Everyone" className="mt-1 min-h-10 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2" />
        </label>
        <Button type="submit" variant="subtle">Show</Button>
        {applied && <Button type="button" variant="ghost" onClick={() => (setPrincipal(''), setApplied(''))}>Everyone</Button>}
      </form>
      {/* a new filter is a fresh list (keyed): nothing from the previous filter's pages survives */}
      <AuditRows key={applied} applied={applied} />
    </section>
  )
}

/**
 * One page of the audit (GET /api/ask/audit). The answer, or the failure words, are handed on only while the identity
 * that asked is still the current one, checked in the same tick as the write (r5).
 */
export async function readAuditPage(client: HiveClient | null, q: { limit: number; principal?: string; before?: string }, binding: EpochBinding, take: (rows: AskAuditRow[]) => void, fail: (words: string) => void): Promise<void> {
  try {
    const r = await need(client, 'askAudit', 'Ask audit')(q)
    binding.commit(() => take(r))
  } catch (e) {
    binding.commit(() => fail(errorMessage(e)))
  }
}

function AuditRows({ applied }: { applied: string }) {
  const client = useHive((s) => s.client)
  const [rows, setRows] = useState<AskAuditRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void readAuditPage(client, { limit: PAGE, principal: applied || undefined }, bindEpoch(), (r) => live && (setRows(r), setMore(r.length === PAGE), setError(null)), (e) => live && setError(e))
    return () => {
      live = false
    }
  }, [client, applied])

  const older = async () => {
    const before = rows ? nextBefore(rows) : null
    if (!before) return
    setBusy(true)
    try {
      await readAuditPage(client, { limit: PAGE, principal: applied || undefined, before }, bindEpoch(), (r) => (setRows((cur) => [...(cur ?? []), ...r]), setMore(r.length === PAGE)), setError)
    } finally {
      // back to idle: a reset, never the earlier person's data
      setBusy(false)
    }
  }

  return (
    <>
      {error && <p role="alert" className="text-[12.5px] text-bad">Could not load the audit: {error}</p>}
      {!error && rows === null && <p className="text-[12.5px] text-ink-4">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-[12.5px] text-ink-4">No Ask turns{applied ? ` from ${applied}` : ''}.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const w = keptWords(r)
            return (
              <li key={r.turn_id} className="py-2 text-[13px]">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-3">
                  <span className="text-ink-2">{r.principal}</span>
                  <span>{ago(r.created_at)}</span>
                  <span>· {r.thread?.mind.name ?? r.mind_id ?? 'no mind'}</span>
                  <span>· {turnOutcome(r)}</span>
                </div>
                <div className={w.removed ? 'text-ink-4 italic' : 'text-ink [overflow-wrap:anywhere]'}>{w.text}</div>
                <button type="button" className="mt-0.5 text-[12px] text-accent hover:text-ink" aria-expanded={open === r.turn_id} onClick={() => setOpen(open === r.turn_id ? null : r.turn_id)}>
                  {open === r.turn_id ? 'Hide what happened' : 'What happened'}
                </button>
                {open === r.turn_id && <AuditTurn turnId={r.turn_id} />}
              </li>
            )
          })}
        </ul>
      )}
      {rows && more && (
        <Button className="mt-2" variant="subtle" disabled={busy} onClick={() => void older()}>
          {busy ? 'Loading…' : 'Load older'}
        </Button>
      )}
    </>
  )
}

function AuditTurn({ turnId }: { turnId: string }) {
  const client = useHive((s) => s.client)
  const [turn, setTurn] = useState<AskAuditTurn | null>(null)
  const [frames, setFrames] = useState<AskAuditTurn['events']>([])
  const [error, setError] = useState<string | null>(null)
  const take = (t: AskAuditTurn) => {
    setTurn(t)
    setFrames((f) => [...f, ...t.events])
  }
  const more = (after: number) => {
    const binding = bindEpoch()
    return client!.askAuditTurn!(turnId, after).then(
      (t) => binding.commit(() => take(t)),
      (e) => binding.commit(() => setError(errorMessage(e))),
    )
  }
  useEffect(() => {
    // one read per opened turn; "More" pages on
    let live = true
    const binding = bindEpoch()
    client!.askAuditTurn!(turnId, 0).then(
      (t) => live && binding.commit(() => (setTurn(t), setFrames((f) => [...f, ...t.events]))),
      (e) => live && binding.commit(() => setError(errorMessage(e))),
    )
    return () => {
      live = false
    }
  }, [client, turnId])
  if (error) return <p className="text-[12px] text-bad">{error}</p>
  if (!turn) return <p className="text-[12px] text-ink-4">Loading…</p>
  return (
    <div className="mt-1 rounded-xl border border-line bg-shade/20 px-3 py-2 text-[12px]">
      <ol className="space-y-0.5 text-ink-3">
        {frames.map((e) => (
          <li key={e.seq} className="[overflow-wrap:anywhere]">
            <span className="text-ink-4">{e.seq}.</span> {frameLine(e)}
          </li>
        ))}
      </ol>
      {turn.more && (
        <Button className="mt-1" variant="ghost" onClick={() => void more(turn.next_after)}>
          More
        </Button>
      )}
    </div>
  )
}
