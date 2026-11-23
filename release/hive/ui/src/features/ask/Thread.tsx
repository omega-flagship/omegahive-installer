/** Purpose: render Ask conversations and their decisions in each look.
 * The thread: a log of world changes, one row per host phase and per fast-path change (UNIVERSAL_ASK_DESIGN §1.1).
 * Shared by every skin; `variant` sets the grammar (Classic glass, Still's letter). A mind's answer is drawn as every
 * look draws words said in the hive (features/views/Words); nothing a mind writes, and no caption or label, is ever
 * rendered as HTML, and refusals are the page's own sentences.
 */
import { AnswerParagraph } from './answerText'
import { m } from 'framer-motion'
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useStickToBottom } from '../../lib/stickToBottom'
import { plural } from '../../lib/plural'
import { NewBelow } from '../../ui/NewBelow'
import { useReducedMotion } from '../../lib/hooks'
import { href, navigate, useRoute } from '../../lib/router'
import { useAdminView } from '../../lib/useAdmin'
import { focusCoordinatorPicker } from '../swarm/coordinatorPicker'
import { CreateOffers } from '../dot/CreateOffers'
import type { AskWho, ResearchCitation } from '../../api/ask'
import { askRetryContext, threadRows, useAskStore, type AskRow } from '../../store/ask'
import { useHive } from '../../store/store'
import { canOwnKeySheet, OwnKeySheet, type OwnKeyClient } from '../ownKey/OwnKeySheet'
import type { KeySetup } from '../ownKey/addOwnKey'
import { useLook } from '../../shell/uiVariant'
import { REFUSAL_WORDS, SIZE_WORDS, money, refusedSay, shownMind, steerUnreached, threadLabel, type Offer } from './words'
import { GoAheadRow } from './GoAheadRow'
import { GuideCard } from '../guided/GuideLayer'
import { openAskMemory } from './memoryNav'
import { currentEpoch } from '../../lib/identityEpoch'
import { AskEarlier } from './Earlier'
import { AnswererPicker, AnswererRefusal } from './AnswererPicker'
import { hasNotation } from '../../lib/beliefSentence'
import { AsWritten } from '../../ui/Belief'
import { Words } from '../views/Words'
import { PICKER_REASONS, threadInfo } from './answerer'
import { AutoWakeStatus } from './AutoWakeStatus'
import { useCompose } from '../../screens/useCompose'
import { Screen } from '../../screens/Screen'
import type { ScreenPlan } from '../../screens/screenSpace'
import { experienceById } from '../../experiences/registry'
import { DirectingStudio } from '../studioLive/DirectingStudio'
import { changeAskSize, halfSwitch, useAskSize } from './askSize'
import type { AskMode } from './placement'
import { StoppedTasks } from '../tasks/StoppedTasks'
import { AnswerPartsSlot } from './AnswerPartsSlot'

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

function Btn({ children, onClick, tone = 'plain', label }: { children: ReactNode; onClick: () => void; tone?: 'plain' | 'primary' | 'quiet'; label?: string }) {
  return (
    <button type="button" className="ask-btn" data-tone={tone} onClick={onClick} aria-label={label} data-takeover="">
      {children}
    </button>
  )
}

function OfferButtons({ offers, retry, mind, op, keySetup }: { offers: Offer[]; retry?: string; mind?: AskWho; op?: string; keySetup?: KeySetup }) {
  const s = useAskStore()
  const route = useRoute()
  const look = useLook()
  const place = JSON.stringify(route)
  const epoch = currentEpoch()
  const retryContext = op ? askRetryContext(op, epoch) : null
  const activation = useMemo(() => ({ epoch }), [epoch, s.epoch, place, look.current?.experience, op, retryContext])
  const authority = useRef<object | null>(null)
  useLayoutEffect(() => {
    authority.current = activation
    return () => { if (authority.current === activation) authority.current = null }
  }, [activation])
  const [open, setOpen] = useState<'swarm' | 'wake' | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const toggle = (k: 'swarm' | 'wake') => setOpen((o) => (o === k ? null : k))
  // a press that spends (asking again, going ahead) belongs to the render it was made in and the person signed in then
  const current = () => authority.current === activation && activation.epoch === currentEpoch()
  const run = (o: Offer) => {
    if (o.kind === 'choose-swarm') toggle('swarm')
    else if (o.kind === 'open-swarms') navigate({ name: 'swarms' })
    else if (o.kind === 'usage') navigate({ name: 'usage' })
    else if (o.kind === 'keys') navigate({ name: 'me' })
    else if (o.kind === 'sessions') navigate({ name: 'messages' })
    else if (o.kind === 'stop') void s.stop()
    else if (o.kind === 'wake') toggle('wake')
    else if (o.kind === 'retry' && retry && op && current()) void s.retryLast(op, activation.epoch, retryContext)
    // an expensive stop: its own words go again with go_ahead, never as a steer of a request running now
    else if (o.kind === 'go-ahead' && op && current())
      void s.goAheadAgain(op).then((r) => setSaid(r === 'busy' ? 'Another request is running. Go ahead once it finishes.' : r === 'gone' ? 'This one can’t go ahead from here. Ask again.' : null))
  }
  const sleeper = mind ?? s.thread?.mind
  // Jon 11-05: own_key_needed's way on is the one add-your-key step, right here; on success the person's last words are
  // asked again through the thread's own retry (never the Keys page and back)
  const hiveClient = useHive((x) => x.client) as Partial<OwnKeyClient> | null
  // the sheet only where this client can run it (P3): otherwise "Add your own key" (Keys) stays the way on
  const keyClient = canOwnKeySheet(hiveClient) ? hiveClient : null
  const sheet = !!(keySetup && keyClient && retry && op && retryContext)
  return (
    <>
      {sheet && <OwnKeySheet setup={keySetup!} client={keyClient!} action="ask" onDone={() => run({ kind: 'retry', label: 'Ask again' })} />}
      <span className="ask-offers">
        {offers
          // only the latest request can be asked again (retryLast: an old button never spends for a newer request), so
          // an older row offers no Try again that would do nothing when pressed
          .filter((o) => o.kind !== 'retry' || retryContext)
          .filter((o) => o.kind !== 'wake' || sleeper)
          .filter((o) => !(sheet && o.kind === 'keys'))
          .map((o) => (
            <Btn key={o.kind} onClick={() => run(o)} tone={o.kind === 'go-ahead' || o.kind === 'choose-swarm' ? 'primary' : 'plain'}>
              {o.kind === 'wake' && sleeper ? `Wake ${shownMind(sleeper.name, sleeper.id)}` : o.label}
            </Btn>
          ))}
      </span>
      {open === 'swarm' && <AnswererPicker op={op} onDone={() => setOpen(null)} />}
      {open === 'wake' && sleeper && (
        <span className="ask-offers" role="group" aria-label={`Wake ${shownMind(sleeper.name, sleeper.id)}?`}>
          <span className="ask-row-note">Waking {shownMind(sleeper.name, sleeper.id)} lets it think again, and thinking spends money. Wake it?</span>
          <Btn
            tone="primary"
            onClick={() =>
              void useHive
                .getState()
                .agentAction(sleeper.id, 'wake')
                .then((ok) => {
                  setOpen(null)
                  setSaid(ok ? `Waking ${shownMind(sleeper.name, sleeper.id)}. Ask again once it is awake.` : 'The hive refused. Nothing changed.')
                })
            }
          >
            Wake
          </Btn>
          <Btn onClick={() => setOpen(null)}>Not now</Btn>
        </span>
      )}
      {said && <span className="ask-row-note">{said}</span>}
    </>
  )
}

/** A note row; a stop that has a way on (an expensive stop: Go ahead; a limit: Usage & limits) offers it right there. */
export function NoteRow({ r, lastYou }: { r: AskRow; lastYou?: string }) {
  if (r.fixCoordinator && r.swarm) return <CoordinatorNote r={r} swarmId={r.swarm} />
  if (!r.offer?.length && !r.ending)
    return (
      <p className="ask-row ask-muted" data-kind="note" title={r.detail}>
        {r.text}
        {r.detail && <span className="sr-only">. {r.detail}.</span>}
      </p>
    )
  return (
    <div className="ask-row" data-kind="note" role="note">
      <span className="ask-row-text ask-muted">{r.text}</span>
      {!!r.offer?.length && <OfferButtons offers={r.offer} retry={lastYou} op={r.op} />}
      {r.ending && <EndingWayOn r={r} />}
    </div>
  )
}

/** The words an action of a composed plan says, by its intent: what its button shows, as MeTTa words it. */
function actionWords(plan: ScreenPlan, intent: string): string {
  for (const part of plan.parts) {
    if (part.block !== 'actions' || !Array.isArray(part.props.items)) continue
    for (const a of part.props.items) if (Array.isArray(a) && a[0] === 'action' && a[2] === intent && typeof a[1] === 'string') return a[1]
  }
  return ''
}

/**
 * Whether `until` (epoch ms) is still ahead: true until then, false from the moment it passes. The clock is a store React
 * reads as it renders, so a row re-rendered with another time is judged at that render, and one timer at `until`
 * re-renders it the moment the time passes.
 */
function useBefore(until: number): boolean {
  const subscribe = useCallback((wake: () => void) => {
    let id: ReturnType<typeof setTimeout> | undefined
    // a browser's timer holds at most 2^31-1 ms (about 24.8 days), so a later time sets the next timer when it fires
    const arm = () => {
      const left = until - Date.now()
      if (left > 0) id = setTimeout(arm, Math.min(left, 2_147_483_647))
      else wake()
    }
    arm()
    return () => clearTimeout(id)
  }, [until])
  const ahead = useCallback(() => until > Date.now(), [until])
  return useSyncExternalStore(subscribe, ahead, ahead)
}

/**
 * The way on from a request's end, composed by MeTTa (thread.metta ask-stopped) from the facts the store states on its
 * closing row: Continue once it ended before its answer, is the thread's latest and is still kept. Continue sends its
 * own words as the person's next request (store/ask continueStopped), under the same guards as Ask again.
 */
export function EndingWayOn({ r }: { r: AskRow }) {
  const s = useAskStore()
  const look = useLook()
  const compose = useCompose(experienceById(look.current?.experience).id)
  const epoch = currentEpoch()
  const context = r.op ? askRetryContext(r.op, epoch) : null
  const early = !!r.ending?.early
  const latest = !!r.ending?.latest
  const kept = useBefore(r.ending?.until ?? 0)
  const plan = useMemo(() => compose('ask-stopped', { flags: { 'ask.ended-early': early, 'ask.latest': latest, 'ask.kept': kept } }), [compose, early, latest, kept])
  if (!plan.parts.length) return null
  return (
    <div className="ask-offers" data-ask-ending="">
      <Screen plan={plan} host={{ data: {}, onAction: (action) => {
        if (action === 'continue' && r.op) void s.continueStopped(r.op, epoch, context, actionWords(plan, 'continue'))
      } }} />
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

/** The steer that did not get through, named for who is answering (words.ts steerUnreached). */
function SteerUnreached() {
  const thread = useAskStore((s) => s.thread)
  const personal = useAskStore((s) => s.personal)
  return <span className="ask-row-note">{steerUnreached(thread, personal)}</span>
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

/**
 * A mind's answer, in the look's grammar: its little markdown kept (answerText), each run drawn as every look draws
 * words said in the hive (features/views/Words: an artifact id a chip that opens it, a belief or truth number said in
 * English), what was asked about lit up, and the exact answer once, "as written", at its end (uifix-r3, S3). Under it,
 * what MeTTa composes for it (answer.metta): where it came from, and research its turn held back (AnswerPartsSlot).
 */
export function AnswerRow({ r, variant, words }: { r: AskRow; variant: ThreadVariant; words: string[] }) {
  return (
    <div className="ask-row" data-kind="answer">
      {ANSWER_FROM[variant] && <span className="ask-who">{ANSWER_FROM[variant]!(shownMind(r.who, r.whoId))}</span>}
      {r.incomplete && <p className="ask-row-note">Incomplete: steps before this answer could not be loaded.</p>}
      {r.text.split(/\n{2,}/).map((p, i) => (
        <AnswerParagraph key={i} className="ask-answer" text={p} mark={(run) => <Words text={run} written={false} mark={(w) => lit(w, words)} />} />
      ))}
      {hasNotation(r.text) && <AsWritten text={r.text} className="ask-row-note" />}
      <AnswerPartsSlot r={r} />
    </div>
  )
}

/** A source a claim cites: its title (else its site) as a link to the https address the report names. */
function Source({ c }: { c: ResearchCitation }) {
  let site = c.url
  try {
    site = new URL(c.url).host
  } catch {
    // the address stays as written
  }
  return (
    <a className="ask-source" href={c.url} target="_blank" rel="noopener noreferrer" title={c.verified ? 'A page the researcher opened' : 'Not a page the researcher opened'}>
      {c.title || site}
    </a>
  )
}

/**
 * A research report back at its turn, as the conductor said it would come (research.deliver): the words for how it
 * ended, then its title, summary and how many claims cite a page the researcher opened; the sections, each claim with
 * its sources, and the open questions on request. A researcher's words from the web: plain text only.
 */
export function ResearchRow({ r }: { r: AskRow }) {
  const [open, setOpen] = useState(false)
  const report = r.research?.report
  return (
    <div className="ask-card" data-kind="research" data-state={r.state} role="note">
      <span className="ask-row-text">{r.text}</span>
      {report && (
        <>
          <p>
            <strong>{r.research!.title}</strong>
          </p>
          <p className="ask-answer">{report.summary}</p>
          <p className="ask-row-note">
            The researcher opened a page for {report.checks.cited} of {plural(report.checks.claims, 'claim')}.
          </p>
          <span className="ask-offers">
            <Btn tone="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide the report' : 'Show the report'}
            </Btn>
          </span>
          {open && (
            <div className="ask-report">
              {report.sections.map((s, i) => (
                <section key={i}>
                  <p className="ask-who">{s.heading}</p>
                  <ul>
                    {s.claims.map((c, j) => (
                      <li key={j}>
                        {c.text}
                        {c.citations.map((x, k) => (
                          <Fragment key={k}>
                            {' '}
                            <Source c={x} />
                          </Fragment>
                        ))}
                        {!c.cited && <span className="ask-muted"> · no page the researcher opened</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {report.open_questions.length > 0 && (
                <section>
                  <p className="ask-who">Still open</p>
                  <ul>
                    {report.open_questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
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
          {r.state === 'failed' && <SteerUnreached />}
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
      return <AnswerRow r={r} variant={variant} words={words} />
    case 'research':
      return <ResearchRow r={r} />
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
    case 'go-ahead':
      return <GoAheadRow r={r} />
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
      return (
        <div className="ask-row" data-kind="refused" role="note">
          <span className="ask-row-text">{refusedSay(r.reason, r.spentUsd)}</span>
          {w.offer && <OfferButtons offers={w.offer} retry={lastYou} mind={r.mind} op={r.op} keySetup={r.keySetup} />}
          {r.ending && <EndingWayOn r={r} />}
        </div>
      )
    }
  }
}

/**
 * The thread header: who answers (never called Omega), what the thread has spent, New thread, Delete (behind a confirm). `sizes`,
 * where the host's Ask draws this thread (askSize.ts): the switch between the bubble and the half size for this mode,
 * and the collapse where the look has no other place for it (`collapse`); at half, Pin goes, since the thread already
 * has its column.
 */
export function ThreadHead({ variant, onClose, pinnable, sizes }: { variant: ThreadVariant; onClose?: () => void; pinnable?: boolean; sizes?: { mode: AskMode; collapse?: boolean } }) {
  const s = useAskStore()
  const size = useAskSize()
  const sw = sizes ? halfSwitch(size, sizes.mode) : null
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
  // the mind whose voice answered the latest turn (speaks_as): the person's own mind on a swarm's thread, by name
  const voice = lastTurn?.kind === 'turn' ? s.turns[lastTurn.op]?.speaksAs : undefined
  return (
    <div className="ask-head">
      <div className="ask-head-line">
        <span className="ask-head-title">{t ? threadLabel(voice?.name ?? t.mind.name, about ?? t.about?.name, voice?.mind_id ?? t.mind.id, t.about?.id) : variant === 'letter' ? 'Today’s page' : 'Ask'}</span>
        {t && (
          // a thread has no cap of its own (Jon on #294): its spend only
          <span className="ask-spend" title="Spent in this thread">
            {money(t.spent_usd)}
            <span className="sr-only"> spent in this thread</span>
          </span>
        )}
        <span className="ask-head-tools">
          {sw && (
            <Btn tone="quiet" onClick={() => changeAskSize(sw.to)} label={sw.label}>
              {sw.text}
            </Btn>
          )}
          {sizes?.collapse && (
            <Btn tone="quiet" onClick={() => changeAskSize('collapsed')} label={SIZE_WORDS.collapse.label}>
              {SIZE_WORDS.collapse.text}
            </Btn>
          )}
          {pinnable && size !== 'half' && (
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
          {threadInfo(t, personal, shownMind, (id) => swarms[id], voice)}
        </p>
      )}
    </div>
  )
}

/** The thread: today's rows, then what the Ask shows with or without them (AskCards). */
export function Thread({ variant, words = [] }: { variant: ThreadVariant; words?: string[] }) {
  return (
    <>
      <ThreadLog rows={useThreadRows()} variant={variant} words={words} />
      <AskCards />
    </>
  )
}

/**
 * What waits on the person in the Ask, drawn under the thread and, where a look keeps its Ask on the page without the
 * thread (Professional's card before it has rows or with its conversation hidden, Still's question box before today's
 * page), in the thread's place, so a person told to press Start finds the card in the Ask whatever its thread shows.
 * The tasks minds stopped, then every mind's open offers to build in Create with Start (createOffer.metta), then, J3 r4.3
 * O3, while a live Studio session runs or its setup card is open, Directing Studio: receipt cards from host records, the
 * Steer | Queue switch, the cost readout and the one Stop. Each draws nothing while it has nothing to show.
 */
export function AskCards() {
  return (
    <>
      <StoppedTasks />
      <CreateOffers />
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
            {r.kind === 'you' && r.op && <AutoWakeStatus op={r.op} words={r.text} />}
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
