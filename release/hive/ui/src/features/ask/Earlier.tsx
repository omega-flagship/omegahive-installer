/**
 * "Earlier": my own Ask turns as the hive keeps them (GET /api/ask; Surface missing-UI batch 1, audit item 4). The
 * thread on the page is this browser's; this list is the hive's record, so it is the same on any device. It says
 * plainly what is kept: every turn's row stays, a deleted thread's turn keeps no words, and admins can read the rows
 * in the Ask audit. The list is newest first and the hive returns at most 200 rows (no paging beyond that). An answer is
 * read a few pages at a time; a longer one says it is partial and offers to read on (r4).
 */
import { useEffect, useRef, useState } from 'react'
import { ASK_HISTORY_MAX, type AskTurnRecord } from '../../api/missingUi'
import type { AskEvent, AskTurnState } from '../../api/ask'
import { ago } from '../../lib/format'
import { errorMessage } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch, type EpochBinding } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import { money, REFUSAL_WORDS, shownMind } from './words'
import { OpenThreads } from './OpenThreads'

const STEPS = [20, 50, 100, ASK_HISTORY_MAX]

/** The words a kept turn shows: its text, or why it has none. */
export function keptWords(t: Pick<AskTurnRecord, 'text'>): { text: string; removed: boolean } {
  return t.text ? { text: t.text, removed: false } : { text: 'Words removed: this thread was deleted. The row stays for the audit.', removed: true }
}

/** One line for a turn's outcome, in the hive's own terms. */
export function turnOutcome(t: Pick<AskTurnRecord, 'state' | 'reason'>): string {
  if (t.state === 'done') return 'answered'
  // the person took over (host takeover route): their own act, said plainly, never as a refusal
  if (t.state === 'refused' && t.reason === 'takeover') return REFUSAL_WORDS.takeover.say
  if (t.state === 'refused') return t.reason && t.reason in REFUSAL_WORDS ? `not answered: ${REFUSAL_WORDS[t.reason as keyof typeof REFUSAL_WORDS].say}` : `not answered${t.reason ? ` (${t.reason})` : ''}`
  return t.state === 'thinking' ? 'still thinking' : 'waiting to start'
}

/** The answer text of a turn's frames, in order (frames are the hive's record; deleted ones are blank). */
export const answerText = (events: AskEvent[]): string =>
  events
    .filter((e) => e.phase === 'answer')
    .map((e) => String((e as { text?: unknown }).text ?? ''))
    .join('\n')
    .trim()

/** Pages read per click; a longer answer keeps a way to read on. */
export const ANSWER_PAGES = 5

/**
 * What has been read of one kept answer. `next` is where the hive's record continues (it said `more`), or null when
 * the whole answer is here; `stalled` is set when the hive said there was more but gave no later place to read from.
 * A partial answer is never shown as the whole one (r4, stand-in r3 item 3).
 */
export interface AnswerRead {
  events: AskEvent[]
  next: number | null
  stalled: boolean
}

/** Reads up to `pages` pages of a turn's frames from `from` on (GET /api/ask/{op}?after=). Pure apart from `read`. */
export async function readAnswer(
  read: (op: string, after: number) => Promise<AskTurnState>,
  op: string,
  from: AnswerRead = { events: [], next: 0, stalled: false },
  pages = ANSWER_PAGES,
): Promise<AnswerRead> {
  const events = [...from.events]
  let after = from.next ?? 0
  for (let i = 0; i < pages; i++) {
    const page = await read(op, after)
    events.push(...page.events)
    if (!page.more) return { events, next: null, stalled: false }
    const next = page.next_after
    if (typeof next !== 'number' || !(next > after)) return { events, next: null, stalled: true }
    after = next
  }
  return { events, next: after, stalled: false }
}

/** The plain note under a partly read answer, or null when it is whole. */
export function answerNote(a: Pick<AnswerRead, 'next' | 'stalled'>): string | null {
  if (a.stalled) return 'Only part of this answer is shown: the hive said there is more but not where it continues.'
  if (a.next !== null) return 'Only the first part of this answer is shown; the hive keeps more.'
  return null
}

/**
 * My kept turns (GET /api/ask). The answer, or the failure words, are handed on only while the identity that asked is
 * still the current one, checked in the same tick as the write (r5).
 */
export async function readHistory(client: Pick<HiveClient, 'askHistory'>, limit: number, binding: EpochBinding, take: (rows: AskTurnRecord[]) => void, fail: (words: string) => void): Promise<void> {
  try {
    const r = await client.askHistory!(limit)
    binding.commit(() => take(r))
  } catch (e) {
    binding.commit(() => fail(errorMessage(e)))
  }
}

/** What a turn shows: what was read so far (null before any), and the last read's failure, if it failed. */
interface Shown {
  read: AnswerRead | null
  failed?: string
}

/**
 * r5 (stand-in r4): the list and every opened answer are this person's. Keyed by the identity epoch, so an identity
 * change (another client, or a credential replaced on the same one) starts them empty, and every write after an
 * await goes through the binding made before it.
 */
export function AskEarlier({ onClose }: { onClose: () => void }) {
  const epoch = useIdentityEpoch()
  return <EarlierFor key={epoch} onClose={onClose} />
}

function EarlierFor({ onClose }: { onClose: () => void }) {
  const client = useHive((s) => s.client)
  const [step, setStep] = useState(0)
  const [rows, setRows] = useState<AskTurnRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, Shown>>({})
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  const head = useRef<HTMLDivElement>(null)
  const limit = STEPS[step]
  useEffect(() => {
    let live = true
    if (!client?.askHistory) return
    void readHistory(client, limit, bindEpoch(), (r) => live && (setRows(r), setError(null)), (e) => live && setError(e))
    return () => {
      live = false
    }
  }, [client, limit])
  useEffect(() => head.current?.focus(), [])
  if (!client?.askHistory) return null

  // reads the first pages of an answer, or the next pages of a partly read one; a failure keeps what was read
  const readOn = async (op: string) => {
    if (!client.askTurn || reading.has(op)) return
    const ask = client.askTurn.bind(client)
    const from = answers[op]?.read ?? undefined
    const binding = bindEpoch()
    const mark = (on: boolean) => setReading((r) => {
      const n = new Set(r)
      if (on) n.add(op)
      else n.delete(op)
      return n
    })
    mark(true)
    try {
      const got = await readAnswer(ask, op, from)
      binding.commit(() => setAnswers((a) => ({ ...a, [op]: { read: got } })))
    } catch (e) {
      binding.commit(() => setAnswers((a) => ({ ...a, [op]: { read: from ?? null, failed: `Could not read it: ${errorMessage(e)}` } })))
    } finally {
      // back to idle: a reset, never the earlier person's data
      mark(false)
    }
  }
  const show = async (t: AskTurnRecord) => {
    if (open === t.operation_id) return setOpen(null)
    setOpen(t.operation_id)
    if (answers[t.operation_id]?.read) return
    await readOn(t.operation_id)
  }

  const full = rows !== null && rows.length < limit
  return (
    <div className="ask-card" role="region" aria-label="Earlier Ask turns" data-ask-earlier>
      <div ref={head} tabIndex={-1} className="ask-row-text" style={{ outline: 'none' }}>
        <strong>Earlier, kept by the hive</strong>
      </div>
      <p className="ask-row-note">
        Your own turns, newest first, the same on any device. Every turn keeps a row; a deleted thread keeps no words. Admins can read these rows in the Ask audit.
      </p>
      <OpenThreads />
      {error && <p className="ask-row-note" role="alert">Could not load them: {error}</p>}
      {!error && rows === null && <p className="ask-muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="ask-muted">Nothing kept yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="ask-earlier-list" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((t) => {
            const w = keptWords(t)
            return (
              <li key={t.turn_id} style={{ padding: '6px 0', borderTop: '1px solid rgb(255 255 255 / 0.06)' }}>
                <div className="ask-row-text" style={w.removed ? { opacity: 0.7, fontStyle: 'italic' } : undefined}>{w.text}</div>
                <div className="ask-row-note">
                  {ago(t.created_at)}
                  {t.thread ? ` · ${shownMind(t.thread.mind.name)}` : ''} · {turnOutcome(t)}
                  {typeof t.turn_spent_usd === 'number' ? ` · ${money(t.turn_spent_usd)}` : ''}
                </div>
                {!w.removed && client.askTurn && (
                  <button type="button" className="ask-btn" data-tone="quiet" aria-expanded={open === t.operation_id} onClick={() => void show(t)}>
                    {open === t.operation_id ? 'Hide the answer' : 'Show the answer'}
                  </button>
                )}
                {open === t.operation_id && (() => {
                  const busy = reading.has(t.operation_id)
                  const shown = answers[t.operation_id]
                  const a = shown?.read ?? null
                  const note = a ? answerNote(a) : null
                  return (
                    <>
                      {a ? (
                        <p className="ask-row-text" style={{ whiteSpace: 'pre-wrap' }}>
                          {answerText(a.events) || (note ? 'No answer words in the part read so far.' : 'No answer was kept for this turn.')}
                        </p>
                      ) : busy || !shown ? (
                        <p className="ask-row-text">Loading…</p>
                      ) : null}
                      {note && <p className="ask-row-note" data-answer-partial>{note}</p>}
                      {shown?.failed && !busy && <p className="ask-row-note" role="alert">{shown.failed}</p>}
                      {((a && a.next !== null) || (shown?.failed && !a)) && (
                        <button type="button" className="ask-btn" data-tone="quiet" disabled={busy} onClick={() => void readOn(t.operation_id)}>
                          {busy ? 'Reading…' : a ? 'Read more of the answer' : 'Try again'}
                        </button>
                      )}
                    </>
                  )
                })()}
              </li>
            )
          })}
        </ul>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {rows && !full && step < STEPS.length - 1 && (
          <button type="button" className="ask-btn" onClick={() => setStep((s) => s + 1)}>
            Load earlier
          </button>
        )}
        {rows && !full && step === STEPS.length - 1 && <span className="ask-row-note">The hive shows at most the {ASK_HISTORY_MAX} newest turns here.</span>}
        <button type="button" className="ask-btn" data-tone="quiet" onClick={onClose}>
          Close
        </button>
      </span>
    </div>
  )
}
