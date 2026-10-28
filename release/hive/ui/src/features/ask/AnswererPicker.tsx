/**
 * "Choose who answers": the one picker the Ask bar's chip and the thread's refusals share (answerer.ts says when).
 * Choosing a swarm saves it as the person's default Ask swarm (PUT /api/me/ask); from a refused request, its same
 * words are then sent once more. Plain words only: a swarm's coordinator answers; models are never mentioned here.
 */
import { useState } from 'react'
import type { AskWho } from '../../api/ask'
import { useAdminView } from '../../lib/useAdmin'
import { bindEpoch } from '../../lib/identityEpoch'
import { href } from '../../lib/router'
import { useAskStore, type AskRow } from '../../store/ask'
import { useHive } from '../../store/store'
import { ADMIN_CHOOSES, CHANGE_WHO, CHOOSE_WHO, chipWords, HOST_SAY, MIND_RESTING, type AnswererChip } from './answerer'
import { shownMind } from './words'

/** The swarms one may pick: the host's list (GET /api/me/ask eligible); without it, swarms with a coordinator in view. */
function useAnswerChoices(): { id: string; name: string; who?: string }[] {
  const eligible = useAskStore((s) => s.settings?.eligible)
  const swarms = useHive((h) => h.swarms)
  const agents = useHive((h) => h.agents)
  return (
    eligible?.map((x) => ({ id: x.id, name: x.name, who: x.orchestrator?.name })) ??
    Object.values(swarms)
      .filter((x) => x.coordinator_id && agents[x.coordinator_id] && !x.archived_at)
      .map((x) => ({ id: x.id, name: x.name, who: agents[x.coordinator_id!]?.name }))
  )
}

/** The picker itself. `op`: the refused request to send once more after the choice (none from the bar's chip). */
export function AnswererPicker({ op, onDone, btnClass = 'ask-btn' }: { op?: string; onDone?: () => void; btnClass?: string }) {
  const choices = useAnswerChoices()
  const current = useAskStore((s) => s.settings?.swarm_id)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const choose = (x: { id: string; name: string; who?: string }) => {
    if (busy) return
    setBusy(true)
    // after the await, only for the same person and sign-in it was chosen under (identity epoch and the Ask's own)
    const bind = bindEpoch()
    const epoch = useAskStore.getState().epoch
    void useAskStore
      .getState()
      .chooseAnswerer(x.id, op)
      .then((r) =>
        bind.commit(() => {
          if (useAskStore.getState().epoch !== epoch) return
          setBusy(false)
          if (r === 'failed') return setSaid('That could not be saved. Nothing changed.')
          setSaid(r === 'resent' ? `${x.name} answers you now; your words were sent again.` : `${x.name} answers you now.`)
          onDone?.()
        }),
      )
  }
  return (
    <span className="ask-offers" role="group" aria-label={CHOOSE_WHO} data-answerer-picker="">
      {choices.length ? (
        choices.map((x) => (
          <button key={x.id} type="button" className={btnClass} data-takeover="" aria-pressed={current === x.id || undefined} disabled={busy} onClick={() => choose(x)}>
            {x.name}
            {x.who ? ` · ${shownMind(x.who)}` : ''}
          </button>
        ))
      ) : (
        <span className="ask-muted">No swarm you take part in has a coordinator yet. An admin can choose one in the swarm’s settings.</span>
      )}
      {said && (
        <span className="ask-row-note" role="status">
          {said}
        </span>
      )}
    </span>
  )
}

/**
 * A refusal about who answers, in the thread: the host's own words (no_mind, no_orchestrator), or the person's own
 * mind resting (mind_asleep for their mind), with the picker right there.
 */
export function AnswererRefusal({ r, wake }: { r: AskRow; wake?: AskWho }) {
  const [open, setOpen] = useState(false)
  const { adminView } = useAdminView()
  const resent = useAskStore((s) => (r.op ? !!s.turns[r.op]?.resent : false))
  const say = r.reason === 'mind_asleep' ? MIND_RESTING : HOST_SAY[r.reason ?? 'no_mind'] ?? HOST_SAY.no_mind!
  return (
    <div className="ask-row" data-kind="refused" data-answerer={r.reason} role="note">
      <span className="ask-row-text">{say}</span>
      {r.reason === 'no_orchestrator' && (
        <span className="ask-row-note">
          {ADMIN_CHOOSES}
          {adminView && r.swarm && (
            <>
              {' '}
              <a className="ask-link" href={href({ name: 'swarm', id: r.swarm, tab: 'settings' })} data-takeover="">
                Open the swarm’s settings
              </a>
            </>
          )}
        </span>
      )}
      {!resent && (
        <span className="ask-offers">
          <button type="button" className="ask-btn" data-tone="primary" data-takeover="" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {CHOOSE_WHO}
          </button>
          {wake && <WakeOwn mind={wake} />}
        </span>
      )}
      {open && !resent && <AnswererPicker op={r.op} onDone={() => setOpen(false)} />}
      {resent && <span className="ask-row-note">You chose who answers; your words were sent again below.</span>}
    </div>
  )
}

/** Waking the person's own mind: behind a plain confirm (thinking spends money). */
function WakeOwn({ mind }: { mind: AskWho }) {
  const [ask, setAsk] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  if (said) return <span className="ask-row-note">{said}</span>
  if (!ask)
    return (
      <button type="button" className="ask-btn" data-takeover="" onClick={() => setAsk(true)}>
        Wake {shownMind(mind.name)}
      </button>
    )
  return (
    <span className="ask-offers" role="group" aria-label={`Wake ${shownMind(mind.name)}?`}>
      <span className="ask-row-note">Waking your mind lets it think again, and thinking spends money. Wake it?</span>
      <button
        type="button"
        className="ask-btn"
        data-tone="primary"
        data-takeover=""
        onClick={() => {
          const bind = bindEpoch()
          const epoch = useAskStore.getState().epoch
          void useHive
            .getState()
            .agentAction(mind.id, 'wake')
            .then((ok) =>
              bind.commit(() => {
                if (useAskStore.getState().epoch === epoch) setSaid(ok ? 'Waking your mind. Ask again once it is awake.' : 'The hive refused. Nothing changed.')
              }),
            )
        }}
      >
        Wake
      </button>
      <button type="button" className="ask-btn" data-takeover="" onClick={() => setAsk(false)}>
        Not now
      </button>
    </span>
  )
}

/**
 * The bar's chip: "Choose who answers", "Answering: <swarm> · change" or "Answering: you (<mind>)". The person's own
 * mind's chip is a link to it (#/me/mind), so they can see the mind that answers them, with a small "Change" beside it
 * that opens the same picker.
 */
export function AnswererChipButton({ chip, open, onToggle, className = 'ask-chip ask-chip-answerer' }: { chip: AnswererChip; open: boolean; onToggle: () => void; className?: string }) {
  if (chip.kind === 'personal')
    return (
      <>
        <a className={className} data-answerer-chip={chip.kind} href={href({ name: 'me', view: 'mind' })} aria-label={`${chipWords(chip)}: open your mind`} title="Your personal mind answers: open it">
          {chipWords(chip)}
        </a>
        <button type="button" className={className} data-answerer-change="" aria-label={CHANGE_WHO} aria-expanded={open} onClick={onToggle} title={CHANGE_WHO}>
          Change
        </button>
      </>
    )
  return (
    <button type="button" className={className} data-answerer-chip={chip.kind} aria-expanded={open} onClick={onToggle} title="Who answers what you ask">
      {chipWords(chip)}
    </button>
  )
}

/** The chip and its picker inline, for the skins that draw their own bar (Professional, Still). `may`: the skin's gate. */
export function AnswererInline({ chip, answering, may = () => true }: { chip: AnswererChip | null; answering: boolean; may?: () => boolean }) {
  const [open, setOpen] = useState(false)
  if (!chip || answering) return null
  return (
    <div className="ask-answerer-inline">
      <AnswererChipButton chip={chip} open={open} onToggle={() => { if (may()) setOpen((o) => !o) }} />
      {open && <AnswererPicker onDone={() => setOpen(false)} />}
    </div>
  )
}
