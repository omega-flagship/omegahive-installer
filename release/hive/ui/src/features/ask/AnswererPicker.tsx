/**
 * "Choose who answers": the one picker the Ask bar's chip and the thread's refusals share (answerer.ts says when).
 * Choosing a swarm saves it as the person's default Ask swarm (PUT /api/me/ask); from a refused request, its same
 * words are then sent once more. Plain words only: a swarm's coordinator answers; models are never mentioned here.
 */
import { useId, useRef, useState } from 'react'
import type { AskWho } from '../../api/ask'
import { useAdminView } from '../../lib/useAdmin'
import { bindEpoch } from '../../lib/identityEpoch'
import { href } from '../../lib/router'
import { askOrigin, useAskStore, type AskRow } from '../../store/ask'
import { useHive } from '../../store/store'
import { ADMIN_CHOOSES, CHANGE_WHO, CHOOSE_WHO, chipWords, HOST_SAY, MIND_RESTING, type AnswererChip, nativeAnswererWords, type NativeAnswererLook } from './answerer'
import { shownMind } from './words'
import { answererChoice, type AnswererTarget } from './answererChoice'
import { isPrivateHash } from './view'
import { usePopDismiss } from './popDismiss'

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
function SavedAnswererPicker({ op, onDone, btnClass = 'ask-btn' }: { op?: string; onDone?: () => void; btnClass?: string }) {
  const displayed = useRef(askOrigin())
  const choices = useAnswerChoices()
  const current = useAskStore((s) => s.settings?.swarm_id)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const choose = (x: { id: string; name: string; who?: string }) => {
    if (busy || !displayed.current.ok()) return
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
          setSaid(r === 'resent' ? `Saved as your default. Your words were sent again.` : r === 'saved-not-sent' ? 'Saved as your default. Your request wasn’t sent; your words are kept.' : `Saved as your default: ${x.name}.`)
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

/** Legacy refusal/private choices explicitly save the host preference. The bar
 * opts into the scoped chooser through `chip`, without changing retry semantics. */
export function AnswererPicker(props: { op?: string; onDone?: () => void; btnClass?: string; chip?: AnswererChip | null; may?: () => boolean; answering?: boolean }) {
  const epoch = useAskStore((s) => s.epoch)
  return props.chip !== undefined ? <ScopedAnswererChip key={epoch} chip={props.chip} may={props.may} answering={props.answering} /> : <SavedAnswererPicker key={epoch} {...props} />
}

function ScopedAnswererChip({ chip, answering, may = () => true, look }: { chip: AnswererChip | null; answering?: boolean; may?: () => boolean; look?: NativeAnswererLook }) {
  const displayed = useRef(askOrigin())
  const own = useAskStore((s) => s.personal)
  const eligible = useAskStore((s) => s.settings?.eligible)
  const defaultSwarm = useAskStore((s) => s.settings?.swarm_id)
  const thread = useAskStore((s) => s.thread)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [scope, setScope] = useState<'thread' | 'default'>('thread')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const owner = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const origin = useRef<ReturnType<typeof askOrigin> | null>(null)
  const id = useId()
  const privatePage = typeof window !== 'undefined' && isPrivateHash(window.location.hash || '')
  const choices: AnswererTarget[] = [
    ...(own?.swarm_id ? [{ kind: 'own' as const, mind: own.id, swarm: own.swarm_id, name: own.name }] : []),
    ...(eligible ?? []).map((s) => ({ kind: 'swarm' as const, swarm: s.id, name: s.name })),
    ...(thread ? [{ kind: 'thread' as const, mind: thread.mind.id, ...(thread.swarm ? { swarm: thread.swarm.id } : {}), name: thread.mind.name }] : []),
  ]
  const close = () => { setOpen(false); trigger.current?.focus() }
  usePopDismiss(open, (event) => {
    setOpen(false)
    if (event?.type === 'keydown') trigger.current?.focus()
  }, owner)
  const choose = async (target: AnswererTarget) => {
    const bound = origin.current
    if (busy || !may() || !displayed.current.ok() || !bound?.ok()) return
    const binding = bindEpoch(), epoch = useAskStore.getState().epoch
    if (scope === 'default' && target.kind === 'thread') { setSaid('Choose your mind or a swarm to make a default.'); return }
    setBusy(true)
    if (scope === 'default') {
      const state = useAskStore.getState(), latest = [...state.log].reverse().find((row) => row.kind === 'turn')
      const op = latest?.kind === 'turn' ? latest.op : undefined
      const result = await state.chooseAnswerer(target.kind === 'own' ? null : target.swarm!, op)
      binding.commit(() => {
        if (useAskStore.getState().epoch !== epoch || !bound.ok()) return
        setBusy(false)
        if (result === 'failed') { setSaid('That could not be saved. Nothing changed.'); return }
        const accepted = op ? useAskStore.getState().turns[op]?.resentMind?.name : null
        useHive.getState().toast({ tone: 'info', icon: 'check', title: 'Saved as your default', body: result === 'resent' ? accepted ? `${accepted} answers from ${target.name}; your words were sent again.` : 'Your words were sent again.' : result === 'saved-not-sent' ? 'Your request wasn’t sent. Your words are kept.' : target.name, ttl: 5000 })
        close()
      })
      return
    }
    binding.commit(() => {
      if (useAskStore.getState().epoch !== epoch || !bound.ok()) return
      if (!answererChoice.select(target, bound.ok)) { setBusy(false); return }
      setBusy(false)
      close()
    })
  }
  const shownChip = chip
  if (!shownChip || answering) return null
  return <span ref={owner} className="ask-scoped-answerer" data-native-answerer={look}>
    <span ref={(node) => { trigger.current = node?.querySelector('button') ?? null }}>
      <AnswererChipButton chip={shownChip} open={open} className={look ? "ask-native-answerer-trigger" : undefined} text={look ? nativeAnswererWords(shownChip, look) : undefined} showArrow={look !== 'still'} onToggle={() => {
        if (!may() || !displayed.current.ok()) return
        if (open) return close()
        origin.current = askOrigin(); setActive(0); setSaid(null); setScope('thread'); setOpen(true)
        requestAnimationFrame(() => { if (may() && displayed.current.ok() && origin.current?.ok()) list.current?.focus() })
      }} />
    </span>
    {open && <span className="ask-answerer-pop">
      {privatePage ? <SavedAnswererPicker onDone={close} /> : <>
        <div ref={list} role="listbox" aria-label="Who answers" tabIndex={0} aria-activedescendant={choices.length ? `${id}-${active}` : undefined} onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); setActive((n) => e.key === 'Home' ? 0 : e.key === 'End' ? Math.max(0, choices.length - 1) : choices.length ? (n + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0)
          } else if (e.key === 'Enter' && choices[active]) { e.preventDefault(); void choose(choices[active]) }
        }}>
          {choices.map((target, i) => <div key={`${target.kind}-${target.kind === 'swarm' ? target.swarm : target.mind}`} id={`${id}-${i}`} role="option" aria-selected={i === active} aria-disabled={busy || undefined} onMouseMove={() => setActive(i)} onClick={() => void choose(target)}>
            {target.name}{target.kind === 'own' ? ` · your mind${!defaultSwarm ? ' (default)' : ''}` : target.kind === 'thread' ? ' · current thread' : ''}
          </div>)}
          {!choices.length && <span>No answerers are available yet.</span>}
        </div>
        <span role="group" aria-label="Choice applies to">
          <button type="button" className="ask-btn" aria-pressed={scope === 'thread'} disabled={busy} onClick={() => setScope('thread')}>Just for this thread</button>
          <button type="button" className="ask-btn" aria-pressed={scope === 'default'} disabled={busy} onClick={() => setScope('default')}>Make default</button>
        </span>
      </>}
      {said && <span role="status">{said}</span>}
    </span>}
  </span>
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
 * The bar's chip: "Choose who answers", "Answering: <swarm> · change" or "Answering: <mind>". The person's own
 * mind’s chip opens the same answerer picker. Resting is accessible state, never a wake gate in the chip.
 */
export function AnswererChipButton({ chip, open, onToggle, className = 'ask-chip ask-chip-answerer', text, showArrow = true }: { chip: AnswererChip; open: boolean; onToggle: () => void; className?: string; text?: string; showArrow?: boolean }) {
  const state = chip.kind === 'personal' ? chip.resting ? 'resting. Asking wakes it.' : chip.status === 'awake' ? 'awake.' : chip.status === 'starting' ? 'waking.' : '' : ''
  const label = chip.kind === 'loading' ? chipWords(chip) : chip.kind === 'personal' ? `${chipWords(chip)}, your mind${state ? `, ${state}` : '.'} ${CHANGE_WHO}` : `${chipWords(chip)}. ${CHANGE_WHO}`
  return (
    <button type="button" className={className} data-answerer-chip={chip.kind} disabled={chip.kind === 'loading'} aria-busy={chip.kind === 'loading' || undefined} aria-label={label} aria-expanded={open} onClick={onToggle} title="Who answers what you ask">
      {chip.kind === 'personal' && <span className="ask-answerer-dot" data-awake={chip.status === 'awake'} aria-hidden="true" />}
      {text ? <span className="ask-native-answerer-label">{text}</span> : chipWords(chip)} {showArrow && chip.kind !== 'loading' && <span aria-hidden="true">▾</span>}
    </button>
  )
}

/** The chip and its picker inline, for the skins that draw their own bar (Professional, Still). `may`: the skin's gate. */
export function AnswererInline({ chip, answering, may = () => true, look }: { chip: AnswererChip | null; answering: boolean; may?: () => boolean; look?: NativeAnswererLook }) {
  const epoch = useAskStore((s) => s.epoch)
  return <ScopedAnswererChip key={epoch} chip={chip} answering={answering} may={may} look={look} />
}
