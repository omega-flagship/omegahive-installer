/**
 * J3 r4.3 O3: "Directing Studio" in the shared Ask (every look renders it with the thread), the setup card, the receipt
 * cards (host records only; narration stays in the thread above), the Steer | Queue switch, the cost readout and the
 * one Stop. StudioLiveBar is the same Stop as a small bar above every experience and app.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { navigate, useRoute } from '../../lib/router'
import { useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { DrawingIdentity, DrawingModeChoice } from './drawingUi'
import { useCanvasInlineBar } from './canvasInlineBar'
import { acquirePageInlineBar } from './pageInlineBar'
import { costReadout, monthlyLine } from './cost'
import { CONSENT_DISCLOSURES, studioCapable, usdFromMicros } from './api'
import type { ReceiptCard } from './receipts'
import {
  DRAWING_TURN_LINK_WORDS, drawingTurnAssociation, canChooseDrawingMode, ELSEWHERE, OPENING_PIECE_WORDS, openLiveCanvas, openStudioSpace, UNSAVED_IN_STUDIO_WORDS, alsoQueue, confirmSetup, canCheckNext, checkNext, dismissControl, dismissPick, focusAsk, pickAgain, pickPiece, pieceOpening, refusedCardActions, reviewAgain, dismissSetup, dropHeld, dropNext, editNext, finishStopping, repairHandoff, pauseSession, resumeSession, retryHeld, sendNext, setDirectionMode, stopSession, useStudioLive,
  type LocalState,
} from './store'
import { heldWords, MONTHLY_TOTAL_REMEDY } from './refusals'
import { canOwnKeySheet, OwnKeySheet, type OwnKeyClient } from '../ownKey/OwnKeySheet'
import { alsoQueuedWords, directionWords, opIdHoldWords, remoteStopConfirmed, remoteWords, roleToolsWords, stepWords, stopProgressWords } from './words'
import './studioLive.css'

const usd = (n: number) => `$${n.toFixed(2)}`
const LOCAL_WORDS: Record<LocalState, string> = {
  receiving: 'Create is receiving',
  'waiting-for-studio': 'Open Create to watch it draw',
  'closed-unmount': 'Create isn’t open; the session waits for it',
  stopped: 'Stopped here',
  'host-paused': 'Paused by the hive: Create is not receiving until it resumes',
  'mount-lost': 'Another Create window is now the connected one (or this one’s connection lapsed), so this one stopped receiving. The piece here stays',
  'not-offered': 'This hive stopped offering live drawing; nothing more is sent',
  'held-reload': 'Held: this page was reloaded, so Create here neither receives nor reports for this session until its record is reconciled',
}
const MAX_WAITING = 20
// Keys live on the person's page ("You & your keys", registry money.keys)
const goRemedy = (go: 'me' | 'usage' | 'keys') => navigate(go === 'usage' ? { name: 'usage' } : { name: 'me' })
const ICON: Record<ReceiptCard['kind'], string> = { 'session-started': '▶', 'proposal-ready': '✎', drawn: '✓', refused: '!', 'step-other': '·', stopped: '■', billing: '$' }


function Cards({ cards }: { cards: ReceiptCard[] }) {
  if (!cards.length) return null
  return (
    <ul className="sl-cards" aria-label="Drawing receipts">
      {cards.map((c) => (
        <li key={c.id} className="sl-card" data-tone={c.tone} data-card={c.kind}>
          <span className="sl-card-icon" aria-hidden="true">{ICON[c.kind]}</span>
          <span className="sl-card-text">{c.text}</span>
          <span />
          {c.detail && <span className="sl-card-detail">{c.detail}</span>}
        </li>
      ))}
    </ul>
  )
}

function SetupCardView() {
  const card = useStudioLive((s) => s.setup)
  const omega = useAskStore((s) => card ? s.turns[card.proposal.operation_id]?.actingAs ?? null : null)
  // r1.6: a refreshed card after a resume refusal starts a NEW session only once the current one is confirmed stopped
  const acts = refusedCardActions(card?.refusal ?? null)
  const hiveClient = useHive((x) => x.client) as Partial<OwnKeyClient> | null
  const keyClient = canOwnKeySheet(hiveClient) ? hiveClient : null
  const waitStop = useStudioLive((s) => !!s.setup?.afterStop && !!s.ledger && !remoteStopConfirmed(s.ledger.state, s.ledger.stop))
  if (!card) return null
  const p = card.proposal
  const c = p.consent   // the host's omega-studio-consent-1 payload, rendered verbatim (Code R2.2 binding)
  const limit = c.monthly.limit_micros
  const month = limit === null
    ? 'Your total monthly limit: not set yet'
    : p.month_left_micros !== null ? `${usdFromMicros(p.month_left_micros)} of your month left (limit ${usdFromMicros(limit)})` : `Your monthly limit: ${usdFromMicros(limit)} (what is left: not known yet)`
  const payer = c.payer === 'own_key' ? `your own key “${p.key_label}”` : `this hive’s key “${p.key_label}”`
  const roleTools = roleToolsWords(c)
  const drawingName = omega ? `${omega.name} · drawing` : 'The drawing organ'
  return (
    <div className="sl-panel sl-setup" role="group" aria-label="Start live drawing in Create?" data-studio-setup={card.state}>
      <div className="sl-head"><span className="sl-title">Draw live in Create?</span></div>
      <p className="sl-month" data-studio-month="">{month}</p>
      <DrawingIdentity omega={omega} maker={{ id: c.maker_id, name: p.maker_name }} />
      {p.maker && <p data-studio-own-maker={p.maker.id}>Paid by {payer}. It works in your private Create space.</p>}
      <p>{drawingName} draws “{c.title}” step by step in Create while you watch, edit by hand, direct or stop it. Paid by {payer}; model {c.model}; {roleTools}.{c.coordinator_exclusive ? ' While it draws, the separate maker does nothing else.' : ''}</p>
      <p data-studio-exposure="">Most this session can spend: {usdFromMicros(c.cap_micros)}, within {c.window_minutes} minutes. Each step: at most {usdFromMicros(c.step_cap_micros)} and {c.step_window_s} s; up to {c.max_steps} steps. Both stay inside your monthly limit; a call already sent when you stop can still cost, and is shown until settled.</p>
      <p>Your unsaved piece, including hand edits, is shared with the separate maker ({c.model}) through this hive. Direction words are kept for this drawing session and can be read by {p.audience}.</p>
      <ul className="sl-lines" aria-label="Also confirm">{c.disclosures.map((d) => <li key={d} data-disclosure={d}>{CONSENT_DISCLOSURES[d]}</li>)}</ul>
      {card.state === 'needs-reconfirm' && !card.notice && <p role="status" data-studio-reconfirm="">{card.changed ? 'What you confirmed no longer matches what the hive has now, so nothing was started. These are the current values; check them and confirm again.' : 'You signed in again or left this page since this was shown, so nothing was started. Check it and confirm again.'}</p>}
      {card.notice && <p role="status" data-studio-card-notice="">{card.notice}</p>}
      {card.changes && card.changes.length > 0 && <ul className="sl-lines" aria-label="What changed" data-studio-card-changes="">{card.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
      {card.afterStop && <p role="status" data-studio-after-stop={waitStop ? 'waiting' : 'ready'}>{waitStop ? 'These are the current values for a new session. Stop the current session first (below); this card can start once the hive confirms it stopped.' : 'The earlier session has stopped. These are the current values; confirm to start a new session.'}</p>}
      {(card.state === 'refused' || card.state === 'refresh-failed') && card.refusal && <p role="alert" data-studio-refusal={card.refusal.code}>{card.refusal.words}</p>}
      {card.state === 'refused' && card.refusal?.keySetup && keyClient && (
        // Jon 11-05: the one add-your-key step, here; on success the r1.8 "Try again" path reads a fresh card (never the
        // refused values) with the person's words kept
        <OwnKeySheet setup={card.refusal.keySetup} client={keyClient} onDone={() => void reviewAgain()} buttonClass="sl-btn" />
      )}
      <div className="sl-row">
        {card.state === 'refreshing' || card.state === 'refresh-failed' || (card.stale && card.state !== 'refused') ? (
          // r1.9: the shown values were refused; only a freshly loaded card can be confirmed (never these)
          <button type="button" className="sl-btn" data-tone="primary" data-studio-reload="" disabled={card.state === 'refreshing'} onClick={() => void reviewAgain()}>
            {card.state === 'refreshing' ? 'Loading the updated card…' : 'Try loading again'}
          </button>
        ) : card.state === 'refused' ? (
          // r1.12: a refused card is never started again as it is. Its ways on: the remedy (Keys, Usage, Me), a NEW Ask
          // turn ("Ask what to draw"), or a deliberate "Try again" that reads the current card first (r1.8/r1.9 path)
          <>
            {card.refusal?.remedy && !(card.refusal.keySetup && keyClient) && <button type="button" className="sl-btn" data-tone="primary" data-studio-remedy={card.refusal.remedy.go} onClick={() => goRemedy(card.refusal!.remedy!.go)}>{card.refusal.remedy.label}</button>}
            {acts.ask && <button type="button" className="sl-btn" data-studio-ask-again="" onClick={focusAsk}>Ask what to draw</button>}
            {acts.pick && <button type="button" className="sl-btn" data-studio-pick-again="" onClick={pickAgain}>Pick a canvas</button>}
            {acts.again && <button type="button" className="sl-btn" data-studio-try-again="" onClick={() => void reviewAgain()}>{card.refusal?.code === 'admit_unavailable' ? 'Set up again' : 'Try again'}</button>}
          </>
        ) : (
          <button type="button" className="sl-btn" data-tone="primary" disabled={card.state === 'sending' || waitStop || !!card.stale} onClick={() => void confirmSetup()}>
            {card.state === 'sending' ? 'Starting…' : card.state === 'needs-reconfirm' ? 'Confirm again and start' : 'Start drawing'}
          </button>
        )}
        <button type="button" className="sl-btn" onClick={dismissSetup}>Not now</button>
      </div>
    </div>
  )
}

function SessionPanel() {
  const s = useStudioLive()
  const ask = useAskStore()
  const client = useHive((x) => x.client)
  const [edit, setEdit] = useState<string | null>(null)
  return <DrawingSessionView projection={projectDrawingSession(s, ask, client)} edit={edit} toggleEdit={(id) => setEdit((v) => v === id ? null : id)} />
}

/** Shared by the browser wrapper and explicit current-snapshot fixture adapter. It grants no action authority. */
export function projectDrawingSession(s: ReturnType<typeof useStudioLive.getState>, ask: ReturnType<typeof useAskStore.getState>, client: ReturnType<typeof useHive.getState>['client']) {
  const l = s.ledger
  const live = s.local !== 'stopped' && s.local !== 'held-reload' && s.local !== 'not-offered'
  return {
    s, thread: ask.thread, askOpen: !!ask.open, association: drawingTurnAssociation(),
    nextChecks: Object.fromEntries(s.next.map((n) => [n.id, canCheckNext(n.id)])),
    canDirect: !!l && live && (l.state === 'active' || l.state === 'paused' || l.state === 'held') && studioCapable(client as never, ask.settings) && canChooseDrawingMode(),
    directionsAvailable: client?.mode === 'sim' || (ask.settings?.capabilities as Record<string, unknown> | undefined)?.studio_directions === true,
  }
}

/** Actual session JSX: no external-store hooks, server snapshots or hidden .getState() reads in this view. */
export function DrawingSessionView({ projection, edit, toggleEdit }: { projection: ReturnType<typeof projectDrawingSession>; edit: string | null; toggleEdit(id: string): void }) {
  const { s, thread, askOpen, association, canDirect, directionsAvailable, nextChecks } = projection
  const l = s.ledger
  const omega = association.state === 'known' ? association.omega : null
  if (!l) return s.admission ? <div className="sl-panel" role="status">Drawing session started; reading its record…</div> : null
  const cost = costReadout(l.budget, { drift: s.moneyDrift })
  const opIdHolds = s.reports.filter((e) => !s.retired.includes(e) && e.state.kind === 'held' && e.state.why.startsWith('op-ids'))
  const waitingResult = s.reports.some((e) => !s.retired.includes(e) && e.state.kind === 'held' && e.state.why === 'custody')
  const waiting = l.directions.filter((d) => d.state !== 'read').length
  const stopRemote = remoteWords(l.state, l.stop)
  const textOf = (steer: string) => s.sent.find((x) => x.steer_id === steer)?.text
  const canStop = s.local !== 'stopped'
  // host R5 controls, offered only where the host accepts them: pause from active, resume from the person's own pause,
  // and the ONE Finish stopping for a parked Stop (afterwards the host's own words name the administrator)
  const sending = s.control?.state === 'sending'
  const live = s.local !== 'stopped' && s.local !== 'held-reload' && s.local !== 'not-offered'
  const canPause = live && l.state === 'active'
  const canResume = live && l.state === 'paused'
  const canFinish = l.stop.finish_stopping && !s.finishUsed && s.local !== 'not-offered'
  const canRepair = l.state === 'stopping' && l.credential_reason === 'namespace_conflict' && l.stop.release_phase === 'installed' && s.local !== 'not-offered'
  const stopProgress = stopProgressWords(l.state, l.stop)
  return (
    <section className="sl-panel" aria-label="Directing Create" data-studio-session={l.state} data-studio-local={s.local ?? ''}>
      <div className="sl-head">
        <span className="sl-title">Directing Create</span>
        <span className="sl-state" data-studio-status="">{s.local ? LOCAL_WORDS[s.local] : ''} · {stopRemote}{l.state === 'active' ? ` · ${stepWords(l.steps)}` : ''}</span>
      </div>
      <DrawingIdentity omega={omega} maker={{ id: l.maker_id }} />
      <DrawingModeChoice mode={s.directionMode} available={canDirect} steerAvailable={directionsAvailable && association.state === 'known'} steerReason={association.state === 'known' ? undefined : DRAWING_TURN_LINK_WORDS} change={(mode) => { setDirectionMode(mode) }} />
      <ul className="sl-lines" aria-label="Cost">
        <li data-first="">{monthlyLine(l.budget.monthly).text}</li>
        <li>{cost.session}</li>
        <li>{cost.step}</li>
        {cost.held && <li>{cost.held}</li>}
        {cost.unknown && <li data-tone="warn">{cost.unknown}</li>}
      </ul>
      {(waiting > 0 || s.sent.length > 0) && (
        <>
          <p className="sl-hint" data-studio-waiting={waiting}>{waiting} of {MAX_WAITING} directions waiting for the maker</p>
          <ul className="sl-dirs" aria-label="Your directions">
            {l.directions.slice(-6).map((d) => {
              const mine = s.sent.find((x) => x.steer_id === d.steer_id)
              return (
                <li key={d.steer_id} data-studio-chip={d.state}>
                  {textOf(d.steer_id) ?? `Direction ${d.seq}`}
                  <span className="sl-chip">→ steering the drawing (your whole message) · {directionWords(d.state, l.state)}</span>
                  {mine && !mine.queuedToo && mine.context && d.state === 'queued' && <button type="button" className="sl-btn sl-chip-btn" onClick={() => alsoQueue(d.steer_id)}>Also queue as new work</button>}
                  {mine && !mine.queuedToo && mine.context && d.state === 'cancelled' && <button type="button" className="sl-btn sl-chip-btn" data-studio-chip-cancelled="" onClick={() => alsoQueue(d.steer_id)}>Ask it as new work</button>}
                  {mine?.queuedToo && <span data-studio-also-queued={d.state}>{alsoQueuedWords(d.state)}</span>}
                </li>
              )
            })}
            {s.sent.filter((x) => x.seq === null).map((x) => <li key={x.steer_id}>{x.text}<span>sending…</span></li>)}
          </ul>
        </>
      )}
      {s.held.map((h) => (
        <div key={h.id} className="sl-held" role="alert" data-studio-held={h.refusal.code}>
          <div>“{h.text}”</div>
          <div className="sl-hint">{h.refusal.words}</div>
          <div className="sl-row">
            {h.refusal.remedy ? <button type="button" className="sl-btn" onClick={() => goRemedy(h.refusal.remedy!.go)}>{h.refusal.remedy.label}</button> : null}
            <button type="button" className="sl-btn" onClick={() => void retryHeld(h.id)}>Send again</button>
            <button type="button" className="sl-btn" onClick={() => dropHeld(h.id)}>Remove</button>
          </div>
        </div>
      ))}
      {s.next.map((n) => {
        const held = n.handoff === 'uncertain' || n.handoff === 'checking'
        const checkable = nextChecks[n.id] === true
        const recovery = n.handoff === 'checking' ? 'Checking the original operation; no replacement is started.' : checkable ? 'Check again to resolve the original operation; no replacement is started.' : 'An original-operation check is not available here. Open the Ask to review it; these words stay held.'
        const reason = held ? recovery : askOpen ? 'The Ask is still answering. This draft waits for a separate turn.' : ''
        return <div key={n.id} className="sl-next" data-studio-next="">
          {!n.handoff && <div className="sl-hint">Next: a new Ask turn{thread ? `, paid from your monthly limit (this thread: ${usd(thread.spent_usd)} of ${usd(thread.budget_usd)})` : ', paid from your monthly limit'}. It starts when the current answer ends complete, or when you send it.</div>}
          {held && <div className="sl-hint" role="status">The Ask has not confirmed this handoff. Your words stay here. {recovery}</div>}
          {n.handoff === 'not-admitted' && <div className="sl-hint" role="status">The original handoff was not admitted. Your editable draft is kept; Send now is a new request you choose.</div>}
          {n.handoff === 'edited' && <div className="sl-hint" role="status">The original words were admitted. Your edited draft is kept; only you can send it as new work.</div>}
          {reason && <p id={`studio-next-${n.id}`} className="sl-hint">{reason}</p>}
          {edit === n.id ? <textarea aria-label="Your next turn" rows={2} value={n.text} onChange={(e) => editNext(n.id, e.target.value)} /> : <div>“{n.text}”</div>}
          <div className="sl-row">
            <button type="button" className="sl-btn" onClick={() => toggleEdit(n.id)}>{edit === n.id ? 'Done' : 'Edit'}</button>
            {held && (checkable || n.handoff === 'checking') && <button type="button" className="sl-btn" disabled={!checkable} aria-describedby={`studio-next-${n.id}`} onClick={() => void checkNext(n.id)}>{n.handoff === 'checking' ? 'Checking…' : 'Check again'}</button>}
            {held && !checkable && n.handoff !== 'checking' && <button type="button" className="sl-btn" aria-describedby={`studio-next-${n.id}`} onClick={focusAsk}>Open Ask</button>}
            <button type="button" className="sl-btn" disabled={askOpen || held} title={reason || undefined} aria-describedby={reason ? `studio-next-${n.id}` : undefined} onClick={() => void sendNext(n.id)}>Send now</button>
            <button type="button" className="sl-btn" onClick={() => dropNext(n.id)}>Remove</button>
          </div>
        </div>
      })}
      <Cards cards={s.cards} />
      {(l.state === 'held' || (l.state === 'paused' && l.reason)) && <p className="sl-hint" role="status" data-studio-held-reason={l.reason ?? ''}>{heldWords(l.reason)}</p>}
      {s.remount === 'held' && <p className="sl-hint" role="status" data-studio-remount="held">Create reopened. New directions will apply from here. Earlier steps are not applied to this view again.</p>}
      {waitingResult && <p className="sl-hint" role="status" data-studio-result-held="">This step’s result hasn’t been confirmed yet.</p>}
      {opIdHolds.map((e) => e.state.kind === 'held' && (e.state.why === 'op-ids-missing' || e.state.why === 'op-ids-malformed' || e.state.why === 'op-ids-differ' || e.state.why === 'op-ids-refused') ? <p key={e.key} className="sl-hint" role="status" data-studio-opids-held={e.state.why}>{opIdHoldWords(e.state.why, e.n)}</p> : null)}
      {s.local === 'not-offered' && <p className="sl-hint" role="status" data-studio-not-offered="">This hive stopped offering live drawing, so nothing more is sent. The piece here stays.</p>}
      {s.openHold && <p className="sl-hint" role="status" data-studio-open-hold="">{s.openHold}</p>}
      {pieceOpening(s) && <p className="sl-hint" role="status" data-studio-opening="">{s.frameDirty ? UNSAVED_IN_STUDIO_WORDS : OPENING_PIECE_WORDS}</p>}
      {(s.openHold === ELSEWHERE || s.local === 'waiting-for-studio' || s.local === 'closed-unmount') && l.state !== 'stopped' && (
        <div className="sl-row"><button type="button" className="sl-btn" data-studio-open-home={l.swarm_id} onClick={openLiveCanvas}>Open Create where it draws</button></div>
      )}
      {stopProgress && <p className="sl-hint" role="status" data-studio-stop-progress={l.stop.in_flight ?? ''}>{stopProgress}</p>}
      {canRepair && <div className="sl-hint" role="status" data-studio-namespace-repair="">
        This mind’s workspace conflicts with another identity. After the workspace is corrected, check it to finish stopping.
        <button type="button" className="sl-btn" disabled={sending} onClick={() => void repairHandoff()}>{sending && s.control?.action === 'repair_handoff' ? 'Checking workspace…' : 'Check workspace and finish stopping'}</button>
      </div>}
      {l.stop.message && <p className="sl-hint" role="status" data-studio-stop-message="">{l.stop.message}</p>}
      {s.control?.state === 'refused' && s.control.refusal && (
        <div className="sl-held" role="alert" data-studio-control-refused={s.control.refusal.code}>
          <div className="sl-hint">{s.control.refusal.words}</div>
          <div className="sl-row">
            {s.control.refusal.remedy && <button type="button" className="sl-btn" onClick={() => goRemedy(s.control!.refusal!.remedy!.go)}>{s.control.refusal.remedy.label}</button>}
            <button type="button" className="sl-btn" onClick={dismissControl}>Dismiss</button>
          </div>
        </div>
      )}
      {(s.custody.fresh === 'stale' || l.piece_state === 'stale') && s.local === 'receiving' && <p className="sl-hint" role="status" data-studio-stale="">The piece the maker can see is more than 30 s old, so drawing waits for a fresh one.</p>}
      {s.custody.state === 'held' && s.custody.reason && <p className="sl-hint" role="status">{s.custody.reason}</p>}
      {s.stopError && <p className="sl-hint" role="alert">The hive did not confirm the stop yet: {s.stopError.words} Create has already stopped receiving here.</p>}
      <div className="sl-row">
        {canPause && <button type="button" className="sl-btn" disabled={sending} onClick={() => void pauseSession()} data-studio-pause="">{sending && s.control?.action === 'pause' ? 'Pausing…' : 'Pause'}</button>}
        {canResume && <button type="button" className="sl-btn" disabled={sending} onClick={() => void resumeSession()} data-studio-resume="">{sending && s.control?.action === 'resume' ? 'Resuming…' : 'Resume'}</button>}
        {canFinish && <button type="button" className="sl-btn" disabled={sending} onClick={() => void finishStopping()} data-studio-finish="">Finish stopping</button>}
        <button type="button" className="sl-btn" data-tone="stop" disabled={!canStop} onClick={() => void stopSession()} data-studio-stop="">{canStop ? 'Stop' : 'Stopped here'}</button>
      </div>
    </section>
  )
}

/** r1.13: choose the saved canvas to draw on (from the person's own Studio space), before any card. */
function PiecePicker() {
  const p = useStudioLive((s) => s.pick)
  if (!p) return null
  const openSpace = () => { if (p.swarm) openStudioSpace(p.programId, p.swarm) }
  return (
    <div className="sl-panel sl-setup" role="group" aria-label="Choose a canvas to draw on" data-studio-pick={p.state}>
      <div className="sl-head"><span className="sl-title">Draw live on which canvas?</span></div>
      {(p.state === 'listing' || p.state === 'reading') && <p role="status">{p.state === 'listing' ? 'Reading your saved canvases…' : 'Reading that canvas…'}</p>}
      {p.state === 'list' && (
        <ul className="sl-lines" aria-label="Your saved canvases">
          {p.pieces.map((x) => (
            <li key={`${x.artifact_id}@${x.revision}`}><button type="button" className="sl-btn" data-studio-piece={x.artifact_id} onClick={() => void pickPiece(x)}>{x.title}</button></li>
          ))}
        </ul>
      )}
      {p.note && <p role="status" data-studio-pick-note="">{p.note}</p>}
      <div className="sl-row">
        {p.state === 'none' && p.swarm && <button type="button" className="sl-btn" data-tone="primary" data-studio-open-space="" onClick={openSpace}>Open Create in your space</button>}
        <button type="button" className="sl-btn" onClick={dismissPick}>Not now</button>
      </div>
    </div>
  )
}
/** In the Ask thread (every look): the canvas pick, the setup card, or the running session. */
export function DirectingStudio() {
  const has = useStudioLive((s) => !!s.pick || !!s.setup || !!s.ledger || !!s.admission)
  if (!has) return null
  return (
    <div className="sl-wrap" data-studio-live="">
      <PiecePicker />
      <SetupCardView />
      <SessionPanel />
    </div>
  )
}

/** The same Stop as a small bar over every experience and app, while a session has a record. */
export function StudioLiveBar({ inline = false, canvas = false, pageOwned = false, inlineReady = true }: { inline?: boolean; canvas?: boolean; pageOwned?: boolean; inlineReady?: boolean }) {
  const s = useStudioLive()
  const route = useRoute()
  const l = s.ledger
  const inlineRow = useRef<HTMLDivElement>(null)
  const pageInline = inline && pageOwned && route.name !== 'hive' && route.name !== 'program' && !!l
  const pageLeaseReady = pageInline && inlineReady
  const pageInactive = pageInline && !pageLeaseReady
  useLayoutEffect(() => {
    if (!pageLeaseReady || !inlineRow.current) return
    return acquirePageInlineBar(document.body, inlineRow.current)
  }, [pageLeaseReady])
  useCanvasInlineBar(!!l && inline && canvas && route.name === 'hive')
  // on an app page the bar sits in the page's own flow (ProgramPage), so it never covers the app's toolbar (Design P2)
  if (!l || (pageOwned && !pageInline) || (!inline && route.name === 'program')) return null
  const stopRemote = remoteWords(l.state, l.stop)
  const unknown = Math.max(l.stop.unknown_usd ?? 0, l.budget.unknown ?? 0)
  // r1.13 (Design phone P2): the money figure is never the part cut off. On a narrow bar the step words give way first
  // (ellipsis); spent-of-cap, or the not-settled amount after Stop, stays whole beside Direct and Stop
  const stopped = s.local === 'stopped'
  const text = stopped ? `Stopped here · ${stopRemote}` : `Create · ${stepWords(l.steps)}`
  const money = stopped
    ? (unknown > 0 ? `${usd(unknown)} not settled yet` : null)
    : costReadout(l.budget, { drift: s.moneyDrift }).compact   // one readout for bar and panel
  return (
    <div ref={inlineRow} className="sl-bar" role="status" aria-label="Live drawing session" data-live={s.local ?? ''} data-studio-bar="" data-xc-keep-clear="" data-inline={inline ? '' : undefined} data-inline-owner={pageInline ? 'page' : undefined} data-inline-ready={pageLeaseReady ? '' : undefined} aria-hidden={pageInactive || undefined} inert={pageInactive || undefined} style={pageInactive ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}>
      <span className="sl-dot" aria-hidden="true" />
      <span className="sl-bar-text">{text}</span>
      {money && <span className="sl-bar-money" data-studio-bar-money="">{money}</span>}
      <button type="button" className="sl-btn" disabled={pageInactive} onClick={() => useAskStore.getState().setThreadOpen(true)}>Direct</button>
      {s.local !== 'stopped' && <button type="button" className="sl-btn" data-tone="stop" disabled={pageInactive} onClick={() => void stopSession()}>Stop</button>}
    </div>
  )
}

export { MONTHLY_TOTAL_REMEDY }
