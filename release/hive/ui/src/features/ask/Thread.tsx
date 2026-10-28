/**
 * The thread: a log of world changes, one row per host phase and per fast-path change (UNIVERSAL_ASK_DESIGN §1.1).
 * Shared by every skin; `variant` sets the grammar (Classic glass, Still's letter). Everything is plain text: the
 * mind's words, captions and labels are never rendered as HTML, and refusals are the page's own sentences.
 */
import { m } from 'framer-motion'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useStickToBottom } from '../../lib/stickToBottom'
import { NewBelow } from '../../ui/NewBelow'
import { useReducedMotion } from '../../lib/hooks'
import { href, navigate } from '../../lib/router'
import { useAdminView } from '../../lib/useAdmin'
import { focusCoordinatorPicker } from '../swarm/coordinatorPicker'
import type { AskWho } from '../../api/ask'
import { threadRows, useAskStore, type AskRow } from '../../store/ask'
import { useHive } from '../../store/store'
import { useLook } from '../../shell/uiVariant'
import { REFUSAL_WORDS, money, raiseSteps, refusedSay, shownMind, spendRefusalOffers, threadLabel, type Offer } from './words'
import { GuideCard } from '../guided/GuideLayer'
import { openAskMemory } from './memoryNav'
import { AskEarlier } from './Earlier'
import { AnswererPicker, AnswererRefusal } from './AnswererPicker'
import { hasNotation, plainText } from '../../lib/beliefSentence'
import { AsWritten } from '../../ui/Belief'
import { PICKER_REASONS, threadInfo } from './answerer'
import { DirectingStudio } from '../studioLive/DirectingStudio'

/** glass: Classic · letter: Still · transmission: Cosmos · liquid: Flux · terminal: Construct · note: Canvas */
export type ThreadVariant = 'glass' | 'letter' | 'transmission' | 'liquid' | 'terminal' | 'note'

/** How each grammar introduces the mind's answer (the letter needs none: it is a letter). */
const ANSWER_FROM: Record<ThreadVariant, ((who: string) => string) | null> = {
  glass: (w) => w,
  letter: null,
  transmission: (w) => `Incoming transmission · ${w}`,
  liquid: (w) => w,
  terminal: (w) => `${w.toLowerCase()}@hive`,
  note: (w) => `A note from ${w}`,
}

/** The thread's rows, derived from the ordered log (store/ask threadRows), recomputed only when it changes. */
export function useThreadRows(): AskRow[] {
  const log = useAskStore((s) => s.log)
  const turns = useAskStore((s) => s.turns)
  const thread = useAskStore((s) => s.thread)
  const local = useAskStore((s) => s.local)
  return useMemo(() => threadRows({ log, turns, thread, local }), [log, turns, thread, local])
}

/** Words to light up in answers (Still: what the orchestrator is referring to). */
function lit(text: string, words: string[]): ReactNode {
  const ws = words.filter((w) => w.length >= 2)
  if (!ws.length) return text
  const re = new RegExp(`(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="ask-lit-word">{part}</mark> : <Fragment key={i}>{part}</Fragment>))
}

function Btn({ children, onClick, tone = 'plain', label, pressed }: { children: ReactNode; onClick: () => void; tone?: 'plain' | 'primary' | 'quiet'; label?: string; pressed?: boolean }) {
  return (
    <button type="button" className="ask-btn" data-tone={tone} onClick={onClick} aria-label={label} aria-pressed={pressed} data-takeover="">
      {children}
    </button>
  )
}

function OfferButtons({ offers, retry, mind, op }: { offers: Offer[]; retry?: string; mind?: AskWho; op?: string }) {
  const s = useAskStore()
  const [open, setOpen] = useState<'swarm' | 'wake' | 'raise' | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const toggle = (k: 'swarm' | 'wake' | 'raise') => setOpen((o) => (o === k ? null : k))
  const run = (o: Offer) => {
    if (o.kind === 'choose-swarm') toggle('swarm')
    else if (o.kind === 'open-swarms') navigate({ name: 'swarms' })
    else if (o.kind === 'usage') navigate({ name: 'usage' })
    else if (o.kind === 'keys') navigate({ name: 'me' })
    else if (o.kind === 'sessions') navigate({ name: 'messages' })
    else if (o.kind === 'new-thread') void s.newThread()
    else if (o.kind === 'raise-budget') toggle('raise')
    else if (o.kind === 'stop') void s.stop()
    else if (o.kind === 'wake') toggle('wake')
    else if (o.kind === 'retry' && retry) void s.retryLast()
  }
  const sleeper = mind ?? s.thread?.mind
  const steps = raiseSteps(s.settings?.max_thread_budget_usd)
  const own = s.thread ? money(s.thread.budget_usd) : null
  return (
    <>
      <span className="ask-offers">
        {offers
          .filter((o) => o.kind !== 'wake' || sleeper)
          .map((o) => (
            <Btn key={o.kind} onClick={() => run(o)} tone={o.kind === 'raise-budget' || o.kind === 'choose-swarm' ? 'primary' : 'plain'}>
              {o.kind === 'wake' && sleeper ? `Wake ${shownMind(sleeper.name)}` : o.label}
            </Btn>
          ))}
      </span>
      {open === 'swarm' && <AnswererPicker op={op} onDone={() => setOpen(null)} />}
      {open === 'wake' && sleeper && (
        <span className="ask-offers" role="group" aria-label={`Wake ${shownMind(sleeper.name)}?`}>
          <span className="ask-row-note">Waking {shownMind(sleeper.name)} lets it think again, and thinking spends money. Wake it?</span>
          <Btn
            tone="primary"
            onClick={() =>
              void useHive
                .getState()
                .agentAction(sleeper.id, 'wake')
                .then((ok) => {
                  setOpen(null)
                  setSaid(ok ? `Waking ${shownMind(sleeper.name)}. Ask again once it is awake.` : 'The hive refused. Nothing changed.')
                })
            }
          >
            Wake
          </Btn>
          <Btn onClick={() => setOpen(null)}>Not now</Btn>
        </span>
      )}
      {open === 'raise' && (
        // an open thread's limit is fixed when it starts (the host has no route to raise it): this sets new threads'
        <span className="ask-offers" role="group" aria-label="Raise the limit for new threads">
          <span className="ask-row-note">
            {own ? `This thread keeps its ${own} limit. ` : ''}Choose the limit for new threads (up to {money(steps.at(-1) ?? 5)}):
          </span>
          {steps.map((v) => (
            <Btn key={v} pressed={pick === v} tone={pick === v ? 'primary' : 'plain'} onClick={() => setPick(v)}>
              {money(v)}
            </Btn>
          ))}
          <Btn
            tone="primary"
            label={pick ? `Save ${money(pick)} for new threads` : 'Save (choose an amount first)'}
            onClick={() => {
              if (pick === null) return setSaid('Choose an amount first.')
              void s.setThreadLimit(pick).then((ok) => {
                setSaved(ok ? pick : null)
                setSaid(ok ? `Saved. New threads start with a ${money(pick)} limit; this thread keeps its limit.` : 'The new limit could not be saved. Nothing changed. New thread still starts a thread at the current limit.')
                if (ok) setOpen(null)
              })
            }}
          >
            Save
          </Btn>
        </span>
      )}
      {saved !== null && (
        <span className="ask-offers">
          <Btn tone="primary" onClick={() => void s.newThread()}>
            {`Start a new thread at ${money(saved)}`}
          </Btn>
        </span>
      )}
      {said && <span className="ask-row-note">{said}</span>}
    </>
  )
}

/** A note row; a stop that has a way on (spend_cap: New thread, the raise for new threads) offers it right there. */
export function NoteRow({ r, lastYou }: { r: AskRow; lastYou?: string }) {
  if (r.fixCoordinator && r.swarm) return <CoordinatorNote r={r} swarmId={r.swarm} />
  if (!r.offer?.length)
    return (
      <p className="ask-row ask-muted" data-kind="note" title={r.detail}>
        {r.text}
        {r.detail && <span className="sr-only">. {r.detail}.</span>}
      </p>
    )
  return (
    <div className="ask-row" data-kind="note" role="note">
      <span className="ask-row-text ask-muted">{r.text}</span>
      <OfferButtons offers={r.offer} retry={lastYou} op={r.op} />
    </div>
  )
}

/** ask-fix r2: the quiet rerouted note; an admin also gets the one-click way to the swarm's coordinator picker. */
function CoordinatorNote({ r, swarmId }: { r: AskRow; swarmId: string }) {
  const { adminView } = useAdminView()
  const name = useHive((s) => s.swarms[swarmId]?.name)
  return (
    <p className="ask-row ask-muted" data-kind="note" title={r.detail}>
      {r.text}
      {r.detail && <span className="sr-only">. {r.detail}.</span>}
      {adminView && name && (
        <>
          {' '}
          <a
            className="ask-link"
            href={href({ name: 'swarm', id: swarmId, tab: 'settings' })}
            data-takeover=""
            onClick={(e) => {
              e.preventDefault()
              navigate({ name: 'swarm', id: swarmId, tab: 'settings' })
              focusCoordinatorPicker()
            }}
          >
            Set a coordinator for {shownMind(name)}
          </a>
        </>
      )}
    </p>
  )
}

function UiRow({ r }: { r: AskRow }) {
  const s = useAskStore()
  const look = useLook()
  // the preview bar's own Keep and Undo settle it too: the row follows the look actually showing
  const state = r.state === 'preview' && look.preview !== r.prefs ? (look.saved === r.prefs ? 'kept' : 'undone') : r.state
  return (
    <>
      <span className="ask-row-text">{r.text}</span>
      {state === 'preview' ? (
        <span className="ask-offers">
          <Btn tone="primary" onClick={() => void s.keepUi(r.id)}>
            Keep
          </Btn>
          <Btn onClick={() => s.undoUi(r.id)}>Undo</Btn>
        </span>
      ) : (
        <span className="ask-muted"> · {state === 'kept' ? 'kept' : state === 'failed' ? 'could not be kept' : state === 'replaced' ? 'replaced' : 'undone'}</span>
      )}
      {!!r.dropped?.length && <span className="ask-row-note">Left out: {r.dropped.join('; ')}.</span>}
    </>
  )
}

/** The trail of the mind's moves this turn: every page it opened, each one clickable. */
function Trail({ moves }: { moves: AskRow[] }) {
  const s = useAskStore()
  return (
    <nav className="ask-trail" aria-label="Pages the orchestrator opened">
      <span className="ask-muted">Moves:</span>
      {moves.map((r, i) => (
        <Fragment key={r.id}>
          {i > 0 && (
            <span aria-hidden className="ask-muted">
              ›
            </span>
          )}
          <button type="button" className="ask-trail-step" data-takeover="" data-state={r.state} onClick={() => s.revisit(r.id)} aria-current={window.location.hash === r.route ? 'page' : undefined} aria-label={r.state === 'reverted' ? `${r.label} (reverted)` : r.label}>
            {r.state === 'reverted' ? <s>{r.label}</s> : r.label}
          </button>
        </Fragment>
      ))}
    </nav>
  )
}

function Row({ r, variant, words, lastYou, trail }: { r: AskRow; variant: ThreadVariant; words: string[]; lastYou?: string; trail?: AskRow[] }) {
  const s = useAskStore()
  switch (r.kind) {
    case 'you':
      return (
        <p className="ask-row" data-kind="you">
          <span className="ask-row-mark" aria-hidden>
            ›
          </span>
          <span className="ask-row-text">{r.text}</span>
          {r.where && <span className="ask-where">{r.where}</span>}
        </p>
      )
    case 'local':
    case 'nav':
      return (
        <p className="ask-row" data-kind="change" data-state={r.state}>
          <span className="ask-row-mark" aria-hidden>
            {r.state === 'sending' || r.state === 'waiting' ? '…' : r.state === 'failed' ? '!' : '✓'}
          </span>
          <span className="ask-row-text">{r.state === 'reverted' ? <s aria-label={`${r.text} (reverted)`}>{r.text}</s> : r.text}</span>
          {r.state === 'reverted' && <span className="ask-muted ask-tiny">reverted</span>}
          {r.kind === 'local' && r.undo && (
            <Btn tone="quiet" onClick={() => void s.runUndo(r.id)}>
              {r.undo === 'back' ? 'Back' : 'Undo'}
            </Btn>
          )}
          {r.kind === 'nav' && r.state === 'applied' && (
            <Btn tone="quiet" onClick={() => s.goTo(r.id)}>
              Back
            </Btn>
          )}
          {trail && trail.length > 1 && <Trail moves={trail} />}
        </p>
      )
    case 'steer':
      return (
        <p className="ask-row" data-kind="steer" data-state={r.state}>
          <span className="ask-row-mark" aria-hidden>
            ↳
          </span>
          <span className="ask-row-text">{r.text}</span>
          {r.state === 'sending' && <span className="ask-muted ask-tiny">sending</span>}
          {r.state === 'failed' && <span className="ask-row-note">Didn’t reach the orchestrator. It is still answering your first words.</span>}
        </p>
      )
    case 'step':
      return (
        <p className="ask-row ask-step-row" data-kind="step">
          {r.text}
        </p>
      )
    case 'revert-offer':
      return (
        <div className="ask-card" data-kind="revert-offer">
          <span className="ask-row-text">{r.text}</span>
          {r.state === 'waiting' ? (
            <span className="ask-offers">
              <Btn tone="primary" onClick={() => void s.answerRevertOffer(r.id, true)}>
                Undo it
              </Btn>
              <Btn onClick={() => void s.answerRevertOffer(r.id, false)}>Keep it</Btn>
            </span>
          ) : (
            <span className="ask-muted"> · {r.state === 'reverted' ? 'undone' : 'kept'}</span>
          )}
        </div>
      )
    case 'go':
      return (
        <div className="ask-card" data-kind="go">
          <span className="ask-row-text">{r.text}</span>
          <Btn tone="primary" onClick={() => s.goTo(r.id)}>
            Go
          </Btn>
        </div>
      )
    case 'answer':
      return (
        <div className="ask-row" data-kind="answer">
          {ANSWER_FROM[variant] && <span className="ask-who">{ANSWER_FROM[variant]!(shownMind(r.who))}</span>}
          {r.incomplete && <p className="ask-row-note">Incomplete: steps before this answer could not be loaded.</p>}
          {/* uifix-r3 (S3): beliefs and truth numbers in an answer read as words; the exact answer is "as written" */}
          {r.text.split(/\n{2,}/).map((p, i) => (
            <p key={i} className="ask-answer">
              {lit(plainText(p), words)}
            </p>
          ))}
          {hasNotation(r.text) && <AsWritten text={r.text} className="ask-row-note" />}
        </div>
      )
    case 'gap':
      return (
        <div className="ask-row ask-muted" data-kind="gap" data-state={r.state} role="note">
          <span className="ask-row-text">{r.text}</span>
          {r.state === 'failed' && r.op && (
            <Btn tone="quiet" onClick={() => void s.retryRecover(r.op!)}>
              Try loading again
            </Btn>
          )}
        </div>
      )
    case 'checking':
      // Review B1 (45392df): whether the hive received it is not known; never shown as refused, never sent twice
      return (
        <div className="ask-row ask-muted" data-kind="checking" data-state={r.state} role="status">
          <span className="ask-row-text">{r.text}</span>
          {r.state === 'failed' && r.op && (
            <Btn tone="quiet" onClick={() => void s.checkAgain(r.op!)}>
              Check again
            </Btn>
          )}
        </div>
      )
    case 'ui':
      return (
        <div className="ask-card" data-kind="ui">
          <UiRow r={r} />
        </div>
      )
    case 'note':
      return <NoteRow r={r} lastYou={lastYou} />
    case 'ui-change':
      return (
        <p className="ask-row ask-muted" data-kind="note">
          {r.text}
        </p>
      )
    case 'confirm':
      return (
        <div className="ask-card" data-kind="confirm">
          <span className="ask-row-text">{r.text}</span>
          {r.state === 'waiting' ? (
            <Btn tone="primary" onClick={() => s.openConfirm(r.id)}>
              Review
            </Btn>
          ) : (
            <span className="ask-muted"> · {r.state === 'confirmed' ? 'done, as you confirmed' : 'declined; nothing was done'}</span>
          )}
        </div>
      )
    case 'refused': {
      // who answers: the host's words with the picker right there (and the person's own mind resting, Platform P2)
      if (r.reason && PICKER_REASONS.includes(r.reason)) return <AnswererRefusal r={r} />
      if (r.reason === 'mind_asleep' && r.own) return <AnswererRefusal r={r} wake={r.mind} />
      const w = REFUSAL_WORDS[r.reason ?? 'not_available']
      // j0-fixes r1: the thread raise only when the thread's own budget is the visible block (words.spendRefusalOffers)
      const offers = r.reason === 'spend_limit' ? spendRefusalOffers(s.thread) : w.offer
      return (
        <div className="ask-row" data-kind="refused" role="note">
          <span className="ask-row-text">{refusedSay(r.reason, r.spentUsd)}</span>
          {offers && <OfferButtons offers={offers} retry={lastYou} mind={r.mind} op={r.op} />}
        </div>
      )
    }
  }
}

/** The thread header: who answers (never called Omega), spend over budget, New thread, Delete (behind a confirm). */
export function ThreadHead({ variant, onClose, pinnable }: { variant: ThreadVariant; onClose?: () => void; pinnable?: boolean }) {
  const s = useAskStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [failed, setFailed] = useState(false)
  const [earlier, setEarlier] = useState(false)
  const kept = useHive((h) => !!h.client?.askHistory)
  const t = s.thread
  const personal = useAskStore((x) => x.personal)
  const swarms = useHive((h) => h.swarms)
  const any = s.log.length > 0
  // "<coordinator> about <mind>" when the latest turn addressed a mind (the host routes by context.mind)
  const lastTurn = [...s.log].reverse().find((e) => e.kind === 'turn')
  const about = lastTurn?.kind === 'turn' ? s.turns[lastTurn.op]?.about : undefined
  return (
    <div className="ask-head">
      <div className="ask-head-line">
        <span className="ask-head-title">{t ? threadLabel(t.mind.name, about ?? t.about?.name) : variant === 'letter' ? 'Today’s page' : 'Ask'}</span>
        {t && (
          <span className="ask-spend" title="Spent / limit">
            {money(t.spent_usd)} / {money(t.budget_usd)}
            <span className="sr-only"> spent of the limit</span>
          </span>
        )}
        <span className="ask-head-tools">
          {pinnable && (
            <Btn tone="quiet" onClick={() => s.setPinned(!s.pinned)} label={s.pinned ? 'Unpin the thread' : 'Pin the thread beside the page'}>
              {s.pinned ? 'Unpin' : 'Pin'}
            </Btn>
          )}
          <Btn tone="quiet" onClick={openAskMemory} label="What the Ask knows about you, kept in this browser">
            Memory
          </Btn>
          {kept && (
            <Btn tone="quiet" onClick={() => setEarlier((v) => !v)} label="Earlier turns kept by the hive">
              Earlier
            </Btn>
          )}
          {(t || any) && (
            <Btn tone="quiet" onClick={() => void s.newThread()}>
              New thread
            </Btn>
          )}
          {(t || any) && (
            <Btn tone="quiet" onClick={() => setConfirmDelete(true)}>
              Delete
            </Btn>
          )}
          {onClose && (
            <Btn tone="quiet" onClick={onClose} label="Close the thread">
              ✕
            </Btn>
          )}
        </span>
      </div>
      {confirmDelete && (
        <div className="ask-card" role="group" aria-label="Delete this thread?">
          <span className="ask-row-text">Delete this thread? Its messages are removed for good; nothing else changes.</span>
          <Btn
            tone="primary"
            onClick={() =>
              void s.deleteThread().then((ok) => {
                setFailed(!ok)
                setConfirmDelete(!ok ? true : false)
              })
            }
          >
            Delete
          </Btn>
          <Btn onClick={() => (setConfirmDelete(false), setFailed(false))}>Keep it</Btn>
          {failed && <span className="ask-row-note">This hive could not delete it yet. Nothing was removed.</span>}
        </div>
      )}
      {earlier && <AskEarlier onClose={() => setEarlier(false)} />}
      {t && (
        <p className="ask-info">
          {threadInfo(t, personal, shownMind, (id) => swarms[id])}
        </p>
      )}
    </div>
  )
}

export function Thread({ variant, words = [] }: { variant: ThreadVariant; words?: string[] }) {
  // J3 r4.3 O3: while a live Studio session runs (or its setup card is open), Directing Studio sits under the thread in
  // every look: receipt cards from host records, the Steer | Queue switch, the cost readout and the one Stop
  return (
    <>
      <ThreadLog rows={useThreadRows()} variant={variant} words={words} />
      <DirectingStudio />
    </>
  )
}

/** The log itself, from rows (Thread reads them from the store; tests render it with rows of their own). */
export function ThreadLog({ rows, variant, words = [] }: { rows: AskRow[]; variant: ThreadVariant; words?: string[] }) {
  const reduced = useReducedMotion()
  // follow the newest row and streamed words only while the reader is at the end; scrolled up, their place holds and
  // "New messages ↓" says there is more (lib/stickToBottom, mind-chat r1)
  const { box: logBox, content: logContent, handlers: logHandlers, unseen: logUnseen, toEnd: logToEnd } = useStickToBottom([rows])
  const lastYou = [...rows].reverse().find((r) => r.kind === 'you')?.text
  // the trail of the mind's moves, shown once per turn under its latest move
  const trails = new Map<string, AskRow[]>()
  for (const r of rows) if (r.kind === 'nav' && r.op) trails.set(r.op, [...(trails.get(r.op) ?? []), r])
  return (
    <>
      <div className="ask-log-frame">
      <div
        ref={logBox}
        {...logHandlers}
        className="ask-log"
        role="log"
        aria-live="polite"
        aria-label="Ask thread"
        data-variant={variant}
        data-presence-region="thread"
      >
        <div ref={logContent}>
        {!rows.length && <p className="ask-muted ask-empty">{variant === 'letter' ? 'Nothing asked yet today.' : variant === 'transmission' ? 'Channel clear. Transmit anything: “open Lyra”, “make it calmer”, or a question for the swarm’s orchestrator.' : variant === 'terminal' ? 'no requests yet. commands still work; anything else is asked: “open Lyra”, “make it calmer”, or a question.' : variant === 'note' ? 'No notes yet. Write anything: “open Lyra”, “make it calmer”, or a question for the swarm’s orchestrator.' : 'Ask for anything: “open Lyra”, “make it calmer”, or a question for the swarm’s orchestrator.'}</p>}
        {rows.map((r) => (
          <m.div key={r.id} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}>
            <Row r={r} variant={variant} words={words} lastYou={lastYou} trail={r.kind === 'nav' && r.op && trails.get(r.op)?.at(-1) === r ? trails.get(r.op) : undefined} />
          </m.div>
        ))}
        </div>
      </div>
      <NewBelow show={logUnseen} onClick={logToEnd} className="ask-new-below" />
      </div>
      <GuideCard />
    </>
  )
}
