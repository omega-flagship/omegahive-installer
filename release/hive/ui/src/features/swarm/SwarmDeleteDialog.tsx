import { m } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SwarmDeletePreview } from '../../api/client'
import { shown } from '../../lib/displayName'
import { useEscape } from '../../lib/hooks'
import { bindEpoch, currentEpoch } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { useModalContainment } from '../../ui/useModalContainment'
import { closeSwarmDelete, noteArchived, useSwarmDelete, type SwarmDeleteOpen } from './deleteRequest'
import {
  addAttempt,
  afterFinishRefusal,
  fetchPreview,
  knownReleased,
  nameMatches,
  NO_PROGRESS,
  outcomeUnknown,
  pressDelete,
  previewWords,
  reconcile,
  reconciledWords,
  refusalWords,
  resultWords,
  UNKNOWN_WORDS,
  type DoneWords,
  type Progress,
} from './deleteWithMinds'

/**
 * "Delete swarm and its minds" (host swarm-delete r3): the host's read-only preview in plain words, the typed exact
 * name and one press. ONE mount for every page and experience (App), opened by the swarm's settings, the archived
 * swarms list or the Ask. Bound throughout to the identity that opened it: made under it (the open request carries its
 * epoch), every call dispatched and every answer written only while it holds (deleteWithMinds.ts, binding.commit), and
 * closed at once by any identity change (deleteRequest.ts). It never sends the plain DELETE to learn what the swarm holds.
 *
 * r2 (stand-in r1 FIX-FIRST): a swarm with no minds left is previewed too, so a cleanup left pending stays finishable
 * from settings, the archived list and the Ask (P2-1); a renamed swarm sends the retry back to a typed confirmation of
 * the host's expected name (P2-2); a lost answer is "not known", read again before anything else (P2-3); totals are
 * kept across attempts (P2-4).
 */

type Phase =
  | { kind: 'checking' }
  | { kind: 'warn'; preview: SwarmDeletePreview; refusal?: string; refusedMinds?: string[]; note?: string }
  | { kind: 'sending'; preview: SwarmDeletePreview }
  | { kind: 'done'; words: DoneWords; confirm: string; retrying?: boolean; refusal?: string }
  /** a partial result whose swarm was renamed meanwhile: type the host's expected name to finish */
  | { kind: 'reconfirm'; name: string; words: DoneWords; refusal: string; retrying?: boolean }
  /** the answer was lost: reading again (or the read failed too) */
  | { kind: 'unknown'; title: string; body: string; reading: boolean }
  | { kind: 'say'; title: string; body: string }

export default function SwarmDeleteDialog() {
  const open = useSwarmDelete((s) => s.open)
  if (!open) return null
  return <DeleteWithMinds key={open.seq} open={open} />
}

function DeleteWithMinds({ open }: { open: SwarmDeleteOpen }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const goals = useHive((s) => s.goals)
  const goalsLoaded = useHive((s) => !!s.goalsLoaded[open.swarmId])
  const live = swarms[open.swarmId]
  const { admin, loaded } = useMe()
  const id = useId()
  // the swarm the warning is for: its id, and a name to show until the host's preview gives the exact one (an archived
  // swarm is not in the store after a reload, so the opener's name stands in; the host decides whether it exists)
  const [seen] = useState(() => ({ id: open.swarmId, name: live?.name ?? open.name ?? '' }))
  const binding = useRef(bindEpoch())
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  // every attempt so far, together (P2-4)
  const progress = useRef<Progress>(NO_PROGRESS)
  // mind names as they were when the warning opened (a deleted mind leaves the store, its name is still owed in words)
  const names = useRef<Record<string, string>>(Object.fromEntries(Object.values(agents).map((a) => [a.id, a.name])))
  const nameOf = (mid: string) => shown(agents[mid]?.name ?? names.current[mid] ?? mid)
  const box = useRef<HTMLDivElement>(null)
  useModalContainment(box)
  const inFlight = phase.kind === 'sending' || ((phase.kind === 'done' || phase.kind === 'reconfirm') && !!phase.retrying) || (phase.kind === 'unknown' && phase.reading)
  // a delete answer has come back (whole or partial): closing then returns to the swarms
  const [acted, setActed] = useState(false)
  const close = () => {
    if (inFlight) return
    closeSwarmDelete()
    // after a delete (whole or partial) the swarm is gone or archived: back to the swarms
    if (acted || phase.kind === 'done') navigate({ name: 'swarms' })
  }
  useEscape(close)

  // the minds the page knows in this swarm, for naming them beside the host's count
  const mindIds = useMemo(() => new Set(Object.values(agents).filter((a) => a.swarm_id === open.swarmId && a.kind !== 'module').map((a) => a.id)), [agents, open.swarmId])
  const mindNames = useMemo(() => Object.values(agents).filter((a) => mindIds.has(a.id)).map((a) => shown(a.name)).sort((a, b) => a.localeCompare(b)), [agents, mindIds])
  const releasedKnown = useMemo(() => (goalsLoaded ? knownReleased(Object.values(goals), mindIds) : []), [goals, goalsLoaded, mindIds])

  const check = useCallback(() => {
    const b = binding.current
    if (open.epoch !== currentEpoch() || !b.current()) return closeSwarmDelete()
    if (!admin) return setPhase({ kind: 'say', title: 'Admins only', body: 'Only admins can delete a swarm. Nothing was changed.' })
    const preview = client?.deleteSwarmPreview?.bind(client)
    if (!preview || !client?.deleteSwarmWithMinds) return setPhase({ kind: 'say', title: 'Not available here', body: "This hive can't delete a swarm together with its minds. Nothing was changed." })
    setPhase({ kind: 'checking' })
    void fetchPreview(seen, { binding: b, preview }).then((r) =>
      b.commit(() => {
        if (!r) return
        if (!r.ok) return setPhase({ kind: 'say', title: 'Could not check the swarm', body: r.words })
        // no minds left is previewed too: it may be a swarm whose earlier delete left cleanup pending (P2-1)
        setPhase({ kind: 'warn', preview: r.preview })
      }),
    )
  }, [admin, client, open.epoch, seen])

  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !loaded) return
    asked.current = true
    check()
  }, [loaded, check])

  /** The answer was lost: read what is there (never resend) and say what that shows (P2-3). Under the binding. */
  const readAgain = (name: string) => {
    const b = binding.current
    const preview = client?.deleteSwarmPreview?.bind(client)
    if (!preview) return setPhase({ kind: 'unknown', title: 'Not known yet', body: UNKNOWN_WORDS, reading: false })
    setPhase({ kind: 'unknown', title: 'Not known yet', body: UNKNOWN_WORDS, reading: true })
    void reconcile(seen, { binding: b, preview }).then((r) =>
      b.commit(() => {
        if (!r) return
        const w = reconciledWords(name, r)
        if ('failed' in r) return setPhase({ kind: 'unknown', title: w.title, body: w.body, reading: false })
        if (r.gone) {
          noteArchived({ id: seen.id, name }, true)
          return setPhase({ kind: 'done', confirm: name, words: { title: w.title, body: w.body, detached: progress.current.detached, partial: false } })
        }
        setTyped('')
        setPhase({ kind: 'warn', preview: r.preview, note: w.body })
      }),
    )
  }

  /** One delete sent with `confirm`; every answer written under the binding. `back` handles a refusal. */
  const send = async (confirm: string, back: (error: unknown) => void) => {
    if (!client?.deleteSwarmWithMinds) return
    const b = binding.current
    const r = await pressDelete({ id: seen.id, name: confirm }, confirm, { binding: b, del: client.deleteSwarmWithMinds.bind(client) })
    b.commit(() => {
      if (!r) return
      if (r.ok) {
        progress.current = addAttempt(progress.current, r.result)
        setActed(true)
        const words = resultWords(shown(confirm), r.result, progress.current, nameOf)
        noteArchived({ id: seen.id, name: confirm }, r.result.swarm === 'deleted' && !r.result.error)
        setPhase({ kind: 'done', words, confirm })
        toast({ tone: words.partial ? 'error' : 'success', icon: 'trash', title: words.title })
      } else if (outcomeUnknown(r.error)) readAgain(shown(confirm))
      else back(r.error)
    })
  }

  const press = async () => {
    if (phase.kind !== 'warn' || phase.preview.busy) return
    const preview = phase.preview
    if (!nameMatches(typed, preview.name)) return
    setPhase({ kind: 'sending', preview })
    await send(typed, (error) => {
      const ref = refusalWords(error, preview.name)
      // the host's exact name, when it says the swarm is now called something else: that is what must be typed
      setPhase({ kind: 'warn', preview: ref.expected ? { ...preview, name: ref.expected } : preview, refusal: ref.words, refusedMinds: ref.minds })
    })
  }

  /** A partial answer: the same request again finishes it (the host's hint); a rename sends it back to typing (P2-2). */
  const finish = async (confirm: string, words: DoneWords) => {
    setPhase((p) => (p.kind === 'done' || p.kind === 'reconfirm' ? { ...p, retrying: true } : p))
    await send(confirm, (error) => {
      const next = afterFinishRefusal(error, confirm)
      if (next.kind === 'reconfirm') {
        setTyped('')
        setPhase({ kind: 'reconfirm', name: next.name, words, refusal: next.refusal })
      } else setPhase({ kind: 'done', words, confirm, refusal: next.refusal })
    })
  }

  const preview = phase.kind === 'warn' || phase.kind === 'sending' ? phase.preview : null
  const name = preview ? shown(preview.name) : phase.kind === 'reconfirm' ? shown(phase.name) : shown(seen.name)
  const words = preview ? previewWords(name, preview) : null
  const sending = phase.kind === 'sending'
  const title =
    phase.kind === 'done' || phase.kind === 'reconfirm'
      ? phase.words.title
      : phase.kind === 'say' || phase.kind === 'unknown'
        ? phase.title
        : preview && !preview.counts.minds
          ? `Finish deleting ${name}?`
          : `Delete ${name || 'this swarm'} and its minds?`

  const confirmInput = (exact: string, disabled: boolean) => (
    <label className="mt-4 block">
      <span className="text-[12.5px] text-ink-3">
        Type <span className="font-mono text-ink">{exact}</span> exactly to confirm (capitals and spaces count)
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        aria-label={`Type ${exact} to confirm`}
        disabled={disabled}
        data-testid="swarm-delete-confirm"
        className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13.5px] text-ink outline-none focus:border-line-2"
      />
    </label>
  )

  const doneBody = (w: DoneWords) => (
    <>
      <p className="mt-4 text-[13.5px] text-ink-2" role="status" data-testid="swarm-delete-result">
        {w.body}
      </p>
      {w.partial && (
        <div className="mt-3 rounded-xl border border-warn/30 bg-warn/[0.06] p-3 text-[13px]" data-testid="swarm-delete-pending">
          <p>
            {w.pending ? 'Cleanup pending.' : 'Stopped partway.'} Nothing is running; the rest finishes when you press Finish the delete. If you close this, it stays finishable from the swarm’s
            settings, Archived swarms, or the Ask.
          </p>
          {w.remaining && w.remaining.length > 0 && (
            <p className="mt-1.5 text-ink-2" data-testid="swarm-delete-remaining">
              Finish the delete also deletes: {w.remaining.join(', ')}
            </p>
          )}
        </div>
      )}
      {w.detached.length > 0 && (
        <div className="mt-3 rounded-xl border border-line p-3">
          <div className="text-[12.5px] text-ink-3">These swarms were inside its minds and now stand on their own:</div>
          <ul className="mt-1.5 list-disc pl-5 text-[13px] text-ink" data-testid="detached-swarms">
            {w.detached.map((d) => (
              <li key={d}>{shown(swarms[d]?.name ?? d)}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )

  return createPortal(
    <m.div className="xc-dress xc-backdrop fixed inset-0 z-[80] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        data-testid="swarm-delete-dialog"
        onClick={(e) => e.stopPropagation()}
        className="xc-frame glass-strong thin-scroll relative max-h-[min(90dvh,820px)] w-full max-w-[560px] overflow-y-auto rounded-[24px] p-5"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-bad/15 text-bad">
            <Icon name="trash" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Delete swarm and its minds</div>
            <h2 id={`${id}-t`} className="mt-0.5 font-display text-[19px] font-semibold [overflow-wrap:anywhere]">
              {title}
            </h2>
          </div>
          <button type="button" onClick={close} disabled={inFlight} aria-label="Close" className="flex size-10 items-center justify-center rounded-xl text-ink-3 hover:bg-tint/[0.07] hover:text-ink">
            <Icon name="x" size={18} />
          </button>
        </div>

        {phase.kind === 'checking' && (
          <p className="mt-4 text-[13px] text-ink-3" role="status">
            Checking what deleting {name || 'the swarm'} would remove… Nothing changes yet.
          </p>
        )}

        {phase.kind === 'say' && (
          <>
            <p className="mt-4 text-[13.5px] text-ink-2" role="status">
              {phase.body}
            </p>
            <div className="mt-5 flex justify-end">
              <Button variant="subtle" onClick={close}>
                Close
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'unknown' && (
          <>
            <p className="mt-4 text-[13.5px] text-ink-2" role="status" data-testid="swarm-delete-unknown">
              {phase.body}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={phase.reading}>
                Close
              </Button>
              <Button variant="subtle" onClick={() => readAgain(name)} disabled={phase.reading}>
                {phase.reading ? 'Reading…' : 'Check again'}
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            {doneBody(phase.words)}
            {phase.refusal && (
              <div role="alert" className="mt-3 text-[12.5px] text-bad" data-testid="swarm-delete-refusal">
                {phase.refusal}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              {phase.words.partial ? (
                <>
                  <Button variant="ghost" onClick={close} disabled={phase.retrying}>
                    Close
                  </Button>
                  <Button variant="danger" onClick={() => void finish(phase.confirm, phase.words)} disabled={phase.retrying} data-testid="swarm-delete-finish">
                    {phase.retrying ? 'Finishing…' : 'Finish the delete'}
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={close}>
                  Back to swarms
                </Button>
              )}
            </div>
          </>
        )}

        {phase.kind === 'reconfirm' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (nameMatches(typed, phase.name)) void finish(typed, phase.words)
            }}
          >
            {doneBody(phase.words)}
            <div role="alert" className="mt-3 text-[12.5px] text-bad" data-testid="swarm-delete-refusal">
              {phase.refusal}
            </div>
            {confirmInput(phase.name, !!phase.retrying)}
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={close} disabled={phase.retrying}>
                Close
              </Button>
              <Button type="submit" variant="danger" className="flex-[1.6]" disabled={phase.retrying || !nameMatches(typed, phase.name)} data-testid="swarm-delete-finish">
                {phase.retrying ? 'Finishing…' : 'Finish the delete'}
              </Button>
            </div>
          </form>
        )}

        {preview && words && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void press()
            }}
          >
            {phase.kind === 'warn' && phase.note && (
              <p className="mt-4 rounded-xl border border-line p-3 text-[13px] text-ink-2" role="status" data-testid="swarm-delete-reconciled">
                {phase.note}
              </p>
            )}
            <ul className="mt-4 space-y-2 text-[13.5px] text-ink" data-testid="swarm-delete-preview" data-tour="swarm-delete-preview">
              <li>
                {words.minds}
                {preview.counts.minds > 0 && mindNames.length > 0 && <span className="block text-[12.5px] text-ink-3">{mindNames.join(', ')}</span>}
              </li>
              {words.awake && <li className="text-warn">{words.awake}</li>}
              <li>
                {words.tasks}
                {releasedKnown.length > 0 && (
                  <span className="block text-[12.5px] text-ink-3">
                    Among them: {releasedKnown.slice(0, 5).map((g) => g.title).join('; ')}
                    {releasedKnown.length > 5 ? `; and ${releasedKnown.length - 5} more` : ''}
                  </span>
                )}
              </li>
              {words.kept.map((k) => (
                <li key={k} className="text-ink-2">
                  {k}
                </li>
              ))}
            </ul>
            <p className={`mt-4 rounded-xl border p-3 text-[13px] ${preview.would === 'delete' ? 'border-bad/30 bg-bad/[0.06]' : 'border-warn/30 bg-warn/[0.06]'}`} data-testid="swarm-fate">
              {words.fate}
            </p>
            {words.busy && (
              <div role="status" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-warn/30 p-3 text-[13px]" data-testid="swarm-delete-busy">
                <span>{words.busy}</span>
                <Button type="button" variant="subtle" onClick={check} disabled={sending}>
                  Check again
                </Button>
              </div>
            )}
            {confirmInput(preview.name, sending)}
            {phase.kind === 'warn' && phase.refusal && (
              <div role="alert" className="mt-3 text-[12.5px] text-bad" data-testid="swarm-delete-refusal">
                {phase.refusal}
                {phase.refusedMinds && phase.refusedMinds.length > 0 && <span className="block text-ink-2">{phase.refusedMinds.join(', ')}</span>}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={close} disabled={sending}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" className="flex-[1.6]" disabled={sending || !!preview.busy || !nameMatches(typed, preview.name)} data-testid="swarm-delete-press" data-tour="swarm-delete-press">
                {sending ? 'Deleting…' : preview.counts.minds ? 'Delete swarm and its minds' : 'Finish deleting the swarm'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </m.div>,
    document.body,
  )
}
