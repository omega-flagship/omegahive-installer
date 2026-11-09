/**
 * First Light on screen (a lazy chunk, mounted by App.tsx once asked for). A living canvas: the journey happens ON the
 * real hive screens; this layer only adds the eight marks, a ring on what the step points at, and one small panel just
 * above the Ask with the caption, the person's choices and the card for the beat. No wizard, no stacked pages.
 *
 *  - Captions always (voice is off in this round: FL_VOICE); a screen reader hears each step once.
 *  - Keyboard: every control is a button; Escape in the panel pauses. Focus moves into a choice when it opens (live) and
 *    returns to where it was when the journey ends. No Enter handler and no form here: nothing is ever sent or spent by
 *    an implicit submit.
 *  - Reduced motion (the system's or the look's): no glide, no breathing; marks light without moving.
 *  - Under a true modal dialog it hides and goes inert (as the guided demos do).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { useLook } from '../../shell/uiVariant'
import { askUnderModal } from '../ask/placement'
import { liveEnv } from '../guided/store'
import type { GuideTarget } from '../guided/types'
import { useFlDoor } from './door'
import { useAuto } from './auto'
import { DEMO_PEOPLE, SIMULATED } from './demo'
import { panelParts } from './panel'
import { COMPANY_SEPARATE, canShowGreeting, cents, fillLine, helloView, limitLine, payerLine, usd } from './honest'
import { markWords, nextIndex, waitsForPerson } from './journey'
import { BEATS, choicesFor, type FlStep, type FlTarget } from './script'
import { ASK_HOW_MAX, ASK_NAME_MAX, askPurposeValue, askToSave, personaEditable, startApp } from './host'
import { factsOf, firstLightLimitLine, stepOf, useFirstLight, whoOf, type Run } from './store'
import './firstlight.css'
import { SingleScreen } from './SingleScreen'
import { profileSaveCopy } from './conditionalCopy'
import { FirstLightMark } from './FirstLightMark'

/** the Change experience sheet's width on a desktop (shell/ChangeUi: Sheet width 520) */
const GALLERY_W = 520
const ASK_SEL = '#ask .ask-capsule, #ask .ask-still-line, .still .st-ask'

/** The element a step points at, now (the person's own mind, First Light's controls, or a guided-demo target). */
function findTarget(targets: readonly FlTarget[] | undefined, run: Run, controls: HTMLElement | null): Element | null {
  for (const t of targets ?? []) {
    if ('personalMind' in t) {
      const id = run.facts.mindOnScreen ?? run.facts.mind?.id
      if (id && /^[A-Za-z0-9_.:-]{1,160}$/.test(id)) {
        const el = document.querySelector(`[data-presence-ref="mind:${id}"]`)
        if (el && el.getBoundingClientRect().width > 0) return el
      }
      continue
    }
    if ('flControls' in t) {
      if (controls) return controls
      continue
    }
    const el = liveEnv.find([t as GuideTarget], liveEnv.picks())
    if (el) return el
  }
  return null
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The run, re-rendered every second while a hello is being waited for (so "Still waking…" turns honest by itself). */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** Where the target is (polled lightly: pages move and sheets open under the journey), and whether a modal holds the screen. */
function useMeasure(run: Run | null, controls: HTMLElement | null, probe: HTMLElement | null) {
  const [box, setBox] = useState<Box | null>(null)
  const [ask, setAsk] = useState<Box | null>(null)
  const [under, setUnder] = useState(false)
  const step = stepOf(run)
  useEffect(() => {
    if (!run || (!step && !run.u1)) return
    const read = () => {
      const el = findTarget(step?.target, run, controls)
      const r = el?.getBoundingClientRect()
      setBox((b) => (r && r.width > 0 ? (b && Math.abs(b.left - r.left) < 1 && Math.abs(b.top - r.top) < 1 && Math.abs(b.width - r.width) < 1 && Math.abs(b.height - r.height) < 1 ? b : { left: r.left, top: r.top, width: r.width, height: r.height }) : null))
      const a = document.querySelector(ASK_SEL)?.getBoundingClientRect()
      setAsk((b) => (a && a.width > 0 ? (b && Math.abs(b.top - a.top) < 1 && Math.abs(b.height - a.height) < 1 ? b : { left: a.left, top: a.top, width: a.width, height: a.height }) : null))
      setUnder(askUnderModal(document, probe))
    }
    read()
    const t = setInterval(read, 250)
    window.addEventListener('resize', read)
    return () => {
      clearInterval(t)
      window.removeEventListener('resize', read)
    }
    // the step and run identity decide what is measured
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.token, controls, probe])
  return { box, ask, under }
}

export default function FirstLightLayer({ experience }: { experience: string }) {
  const asked = useFlDoor((s) => s.asked)
  const run = useFirstLight((s) => s.run)
  const providers = useHive((s) => s.providers)
  const look = useLook()
  const reducedSystem = useReducedMotion()
  const reduced = reducedSystem || look.motion === 'none'
  const [controls, setControls] = useState<HTMLElement | null>(null)
  const [probe, setProbe] = useState<HTMLElement | null>(null)
  const opener = useRef<Element | null>(null)
  /** a journey was on screen for this ask (so its end, not the moment before it starts, closes the door) */
  const seen = useRef(false)

  // asked for: start (once per ask)
  useEffect(() => {
    if (!asked) return
    opener.current = document.activeElement
    seen.current = false
    // not playable here (no hive yet, or the invented demo asked for on a real hive): the door closes, nothing shows
    void useFirstLight.getState().start({ ...asked, singleScreen: asked.mode === 'live' && !asked.beat }).then((ok) => {
      if (!ok) useFlDoor.getState().close()
    })
  }, [asked])
  // ended: put focus back where it was, and close the door
  useEffect(() => {
    if (run) {
      seen.current = true
      return
    }
    if (!asked || !seen.current) return
    seen.current = false
    const el = opener.current as HTMLElement | null
    if (el && el.isConnected && typeof el.focus === 'function') el.focus()
    useFlDoor.getState().close()
  }, [run, asked])

  useAuto(run)
  const { box, ask, under } = useMeasure(run, controls, probe)
  const singleScreen = !!run?.u1
  // U1 is a welcome over the working hive, not a second active interface.
  // Its portal and the usable Universal Ask portal remain outside #root.
  useLayoutEffect(() => {
    if (!singleScreen || under) return
    const root = document.getElementById('root')
    const inert = root?.inert
    const prior = document.body.getAttribute('data-firstlight-u1-active')
    if (root) root.inert = true
    document.body.setAttribute('data-firstlight-u1-active', '')
    return () => {
      if (root) root.inert = inert ?? false
      if (prior === null) document.body.removeAttribute('data-firstlight-u1-active')
      else document.body.setAttribute('data-firstlight-u1-active', prior)
    }
  }, [singleScreen, under])
  const waitingHello = !!run && (run.u1 || run.steps[run.i]?.beat === 'hello') && !run.facts.greeted && run.hello.postedAt !== null
  const now = useClock(waitingHello)

  if (!run) return null
  if (run.u1) return createPortal(<div className="fl-layer" data-experience={experience} data-mode="live" data-firstlight-u1="">
    <span className="fl-live" ref={setProbe} aria-hidden="true" />
    <div className="fl-u1-scrim" hidden={under} aria-hidden="true" />
    <div className="fl-u1-scene" hidden={under} inert={under ? true : undefined}>
      <FirstLightMark className="fl-u1-omega" />
      <section className="fl-panel fl-u1-panel" aria-label="First Light" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); useFirstLight.getState().toggle() } }}>
        <SingleScreen key={`${run.id}:${run.facts.mind?.id ?? 'unread'}`} run={run} now={now} providers={providers} />
      </section>
    </div>
  </div>, document.body)
  const step = stepOf(run)
  const parts = panelParts(run)
  const phone = typeof window !== 'undefined' && window.innerWidth < 640
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  // the panel sits just above the Ask (below it when the Ask sits high, as Still's question box can)
  const askHigh = !!ask && ask.top < vh * 0.45
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1440
  const base: CSSProperties = askHigh ? { top: ask!.top + ask!.height + 10 } : { bottom: ask ? Math.max(12, vh - ask.top + 10) : 96 }
  // the Change experience gallery is open (beat 2): the panel steps aside so it never covers the looks being tried — beside
  // the gallery's sheet on a desktop (it is 520 px at the right), at the top of a phone above its sheet
  const room = vw - GALLERY_W - 48
  const panelStyle: CSSProperties = !look.galleryOpen ? base : !phone && room >= 360 ? { ...base, left: 16 + Math.max(0, (room - Math.min(620, room)) / 2), translate: 'none', width: Math.min(620, room) } : { top: 8, bottom: 'auto' }

  return createPortal(
    <div className="fl-layer" data-experience={experience} data-reduced={reduced ? '' : undefined} data-phone={phone ? '' : undefined} data-path={run.path} data-beat={step?.beat} data-step={step?.id} data-mode={run.mode}>
      {/* the probe for "under a modal" (always mounted, so it never flip-flops: guided/underModal) */}
      <span className="fl-live" ref={setProbe} aria-hidden="true" />
      {!under && box && step?.beat !== 'look' && <div className={`fl-ring${step?.beat === 'hello' ? ' fl-ring--mind' : ''}${run.facts.greeted ? ' fl-ring--lit' : ''}`} style={{ left: box.left - 6, top: box.top - 6, width: box.width + 12, height: box.height + 12 }} aria-hidden="true" />}
      <section className="fl-panel" style={panelStyle} aria-label="First Light" hidden={under} inert={under ? true : undefined} onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          useFirstLight.getState().toggle()
        }
      }}>
        {/* the marks ride on the panel's top edge: they never cover the hive's own chrome in any look */}
        <Marks run={run} reduced={reduced} />
        {parts.sim && <p className="fl-sim" title={SIMULATED}><span className="fl-sim-tag">Simulated</span> {parts.sim}</p>}
        {parts.band && <p className="fl-band" role="note" data-testid="fl-guest-band">{parts.band}</p>}
        {run.notice && <p className="fl-notice" role="status">{run.notice}</p>}
        <Body run={run} step={step} now={now} />
        <Controls run={run} step={step} setRef={setControls} />
      </section>
    </div>,
    document.body,
  )
}

function Marks({ run, reduced }: { run: Run; reduced: boolean }) {
  const step = stepOf(run)
  const cur = BEATS.find((b) => b.id === step?.beat)
  return (
    <nav className="fl-marks" aria-label="First Light, eight beats" data-reduced={reduced ? '' : undefined}>
      <ol>
        {BEATS.map((b) => {
          const s = run.beats[b.id]
          const state = b.id === step?.beat && s.state === 'active' ? 'active' : s.state
          return (
            <li key={b.id} className="fl-mark" data-state={state} aria-current={b.id === step?.beat ? 'step' : undefined} aria-label={`${b.n} of 8, ${b.name}: ${markWords(state)}`} title={`${b.name}: ${markWords(state)}`}>
              <span className="fl-dot" aria-hidden="true" />
            </li>
          )
        })}
      </ol>
      {cur && (
        <p className="fl-where">
          First Light · {String(cur.n).padStart(2, '0')}/08 · {cur.name}
        </p>
      )}
    </nav>
  )
}

function Body({ run, step, now }: { run: Run; step: FlStep | undefined; now: number }) {
  if (run.status === 'loading') return <p className="fl-caption" aria-live="polite">Getting your hive ready…</p>
  if (run.loadError)
    return (
      <div className="fl-body">
        <p className="fl-caption" aria-live="polite">
          <State state="blocked" /> {run.loadError}
        </p>
        <div className="fl-chips">
          <button type="button" className="fl-btn" data-tone="primary" onClick={() => void useFirstLight.getState().reload()}>
            Try again
          </button>
        </div>
      </div>
    )
  if (!step) {
    return (
      <p className="fl-caption" aria-live="polite">
        That’s all of First Light for now.
      </p>
    )
  }
  const f = run.facts
  const text = run.limit.limitUncertain && step.beat === 'models' ? firstLightLimitLine(run) : fillLine(step.say, { name: f.name, host: f.host, limit: f.limit, look: f.lookName, monthly: f.limit?.chosen_usd ?? null, mind: f.mind?.name ?? null, app: startApp(f.apps)?.name ?? null })
  const beat = run.beats[step.beat]
  const mindWords = step.voice === 'mind'
  return (
    <div className="fl-body">
      {!mindWords && (
        <p className="fl-caption" aria-live="polite">
          <span className="fl-cc" aria-hidden="true">
            CC
          </span>{' '}
          {text}
        </p>
      )}
      {(beat.state === 'blocked' || beat.state === 'ready' || beat.state === 'skipped') && beat.line && step.beat !== 'hello' && !(run.limit.limitUncertain && step.beat === 'models') && (
        <p className="fl-state" data-state={beat.state} role="status">
          <State state={beat.state} /> {beat.line}
        </p>
      )}
      <Choices run={run} step={step} />
      {step.card && <Card run={run} step={step} now={now} />}
    </div>
  )
}

function State({ state }: { state: string }) {
  return (
    <span className="fl-state-tag" data-state={state}>
      {markWords(state as Parameters<typeof markWords>[0])}
    </span>
  )
}

function Choices({ run, step }: { run: Run; step: FlStep }) {
  const g = useFirstLight.getState()
  const first = useRef<HTMLButtonElement | null>(null)
  const [amount, setAmount] = useState('')
  const choices = step.wait?.for === 'choice' ? choicesFor(step, run.path) : []
  // a choice opening takes focus (the person's journey; never in the demo, which plays itself)
  useLayoutEffect(() => {
    if (run.mode !== 'live' || !choices.length) return
    const a = document.activeElement
    if (a && a !== document.body && (a as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return
    first.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.token])
  if (step.wait?.for === 'look')
    return (
      <div className="fl-chips">
        <button type="button" className="fl-btn" onClick={() => g.keepCurrent()} disabled={run.status !== 'playing'}>
          Keep the look I have
        </button>
      </div>
    )
  if (!choices.length) return null
  return (
    <div className="fl-chips" role="group" aria-label={step.wait?.for === 'choice' && step.wait.field === 'role' ? 'What you will mostly do' : 'Your monthly limit'}>
      {choices.map((c, i) => (
        <button key={c.label} ref={i === 0 ? first : undefined} type="button" className="fl-btn" data-tone={i === 0 ? 'primary' : undefined} disabled={run.limit.busy || run.status !== 'playing'} onClick={() => void g.choose(c.value)}>
          {c.label}
        </button>
      ))}
      {run.limit.other && (
        <span className="fl-other">
          <label>
            <span className="fl-sr">Monthly amount in dollars</span>
            <input type="number" inputMode="decimal" min={0} max={10000} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="fl-input" aria-label="Monthly amount in dollars" placeholder="$ a month" />
          </label>
          <button type="button" className="fl-btn" data-tone="primary" disabled={!amount.trim() || run.limit.busy || run.status !== 'playing'} onClick={() => void g.choose(Number(amount))}>
            Set
          </button>
        </span>
      )}
      {run.limit.error && <p className="fl-error" role="alert">{run.limit.error}</p>}
    </div>
  )
}

function Card({ run, step, now }: { run: Run; step: FlStep; now: number }) {
  const w = whoOf(run)
  const l = run.facts.limit
  const g = useFirstLight.getState()
  switch (step.card) {
    case 'key':
      return (
        <CardBox region="fl-key" title="Your own keys">
          <p>{run.facts.ownKeys > 0 ? (run.mode === 'demo' && run.persona === 'pip' ? `${DEMO_PEOPLE.pip.key!.provider} key ${DEMO_PEOPLE.pip.key!.shown} (invented) is in.` : `${run.facts.ownKeys} key${run.facts.ownKeys === 1 ? '' : 's'} of your own.`) : 'No key of your own yet.'}</p>
          <p className="fl-pays">{payerLine(w)}</p>
          {step.wait?.for === 'key' && (
            <div className="fl-chips">
              <button type="button" className="fl-btn" data-tone="primary" onClick={() => void g.checkKey()}>
                I’ve added it
              </button>
              <button type="button" className="fl-btn" onClick={() => g.skipBeat()}>
                Not now
              </button>
            </div>
          )}
        </CardBox>
      )
    case 'own-limit':
      return (
        <CardBox region="fl-own-limit" title="Your monthly limit">
          <p data-testid="fl-limit-line">{firstLightLimitLine(run)}</p>
          <p className="fl-small">{COMPANY_SEPARATE}</p>
          <p className="fl-pays">{payerLine(w)}</p>
        </CardBox>
      )
    case 'limit':
      return (
        <CardBox region="fl-limit" title="What your minds may spend">
          <p data-testid="fl-limit-line">{firstLightLimitLine(run)}</p>
          {l?.enforced && <p className="fl-small">{COMPANY_SEPARATE}</p>}
          <p className="fl-pays">{payerLine(w)}</p>
        </CardBox>
      )
    case 'guest-limit':
      return <GuestLimit run={run} />
    case 'wake':
      return <Wake run={run} />
    case 'hello':
      return <HelloCard run={run} now={now} />
    case 'apps':
      return <AppsCard run={run} step={step} />
    case 'ask':
      return <AskCard run={run} step={step} />
    case 'start':
      return <StartCard run={run} />
    default:
      return null
  }
}

function CardBox({ region, title, children }: { region: string; title: string; children: ReactNode }) {
  return (
    <div className="fl-card" data-presence-region={region} role="group" aria-label={title}>
      <p className="fl-card-title">{title}</p>
      {children}
    </div>
  )
}

/** The guest's limit card: their limit (as the host enforces it), whose key pays, and asking for more. */
export function GuestLimit({ run }: { run: Run }) {
  const l = run.facts.limit
  const host = run.facts.host
  const g = useFirstLight.getState()
  // in the store, not here: the journey holds still while the amounts are open (store autoHeld)
  const asking = run.ask.choosing
  const setAsking = (open: boolean) => g.askChoosing(open)
  const enforced = !!l?.enforced && l.limit_usd !== null
  const share = enforced && l!.limit_usd! > 0 ? Math.min(1, (l!.spent_usd ?? 0) / l!.limit_usd!) : 0
  const pending = run.ask.sent ?? (l?.pending_request ? { amount: l.pending_request.amount_usd } : null)
  const asks = enforced ? [Math.max(1, l!.limit_usd! * 2), l!.limit_usd! + 10] : [5, 10]
  return (
    <CardBox region="fl-guest-limit" title={`Your limit in ${host}’s hive`}>
      {enforced ? (
        <>
          <p className="fl-amount">
            {cents(l!.limit_usd!)} a month · used {cents(l!.spent_usd ?? 0)}
          </p>
          <div className="fl-bar" role="meter" aria-label="Used this month" aria-valuemin={0} aria-valuemax={l!.limit_usd!} aria-valuenow={l!.spent_usd ?? 0}>
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          <p className="fl-pays">
            Paid from {host}’s key. You never see {host}’s key. The hive stops your minds at {cents(l!.limit_usd!)}.
          </p>
        </>
      ) : (
        <>
          <p data-testid="fl-limit-line">{limitLine(l, whoOf(run))}</p>
          <p className="fl-pays">{payerLine(whoOf(run))}</p>
        </>
      )}
      {pending ? (
        <p className="fl-small" role="status">
          You asked {host} for {usd(pending.amount)} a month. {host} decides.
        </p>
      ) : asking ? (
        <div className="fl-chips" role="group" aria-label={`Ask ${host} for a monthly limit`}>
          {asks.map((a) => (
            <button key={a} type="button" className="fl-btn" disabled={run.ask.busy} onClick={() => void g.askForMore(Math.round(a * 100) / 100)}>
              Ask for {usd(Math.round(a * 100) / 100)} a month
            </button>
          ))}
          <button type="button" className="fl-btn" data-tone="quiet" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="fl-chips">
          <button type="button" className="fl-btn" data-tone="primary" onClick={() => setAsking(true)}>
            Ask {host} for {enforced ? 'more' : 'a limit'}
          </button>
          <button type="button" className="fl-btn" onClick={() => g.next()}>
            Start my own hive later
          </button>
        </div>
      )}
      {run.ask.error && <p className="fl-error" role="alert">{run.ask.error}</p>}
    </CardBox>
  )
}

/** Wake: the person presses it themselves (waking can spend). A refusal shows its reason, and no greeting. */
export function Wake({ run }: { run: Run }) {
  const g = useFirstLight.getState()
  const mind = run.facts.mind?.name ?? 'your mind'
  const ref = run.hello.refusal
  const w = whoOf(run)
  return (
    <CardBox region="fl-wake" title="Wake your mind">
      <p>
        {run.facts.name ? `${run.facts.name}, your mind` : 'Your mind'}
        {run.facts.mind && run.facts.mind.name !== run.facts.name ? `, ${mind},` : ''} is asleep.
      </p>
      <p className="fl-pays">Waking it can spend: {payerLine(w)}</p>
      {run.path === 'guest' && run.mode === 'demo' && <p className="fl-small">In this demo, {DEMO_PEOPLE.juno.name.split(' ')[0]} presses Wake.</p>}
      {run.path === 'owner' && run.mode === 'demo' && <p className="fl-small">In this demo, {DEMO_PEOPLE.pip.name.split(' ')[0]} presses Wake.</p>}
      {ref && (
        <p className="fl-error" role="alert" data-testid="fl-refusal">
          <State state="blocked" /> {ref.sentence}
        </p>
      )}
      <div className="fl-chips">
        <button type="button" className="fl-btn fl-wake" data-tone="primary" disabled={run.hello.busy || run.status === 'ended'} onClick={() => void g.wake()}>
          {run.hello.busy ? 'Waking…' : 'Wake'}
        </button>
        {ref && (ref.code === 'no_key' || ref.code === 'own_key_required') && run.path === 'owner' && (
          <button type="button" className="fl-btn" onClick={() => g.goBeat('models')}>
            Add a key
          </button>
        )}
        {ref && (ref.code === 'spend_limit' || ref.code === 'no_budget') && run.path === 'guest' && (
          <button type="button" className="fl-btn" onClick={() => g.goBeat('models')}>
            Ask {run.facts.host} for more
          </button>
        )}
        <button type="button" className="fl-btn" data-tone="quiet" onClick={() => g.skipBeat()}>
          Later
        </button>
      </div>
    </CardBox>
  )
}

/** The hello: only the mind's own words, and only once the host says it greeted. "Try again" only when retryable. */
export function HelloCard({ run, now }: { run: Run; now: number }) {
  const g = useFirstLight.getState()
  const v = helloView(run.hello.hello, run.hello.postedAt, Math.max(now, run.hello.at), run.facts.mind?.name ?? null)
  const ref = run.hello.refusal
  const greeting = canShowGreeting(run.hello.hello) ? v.greeting : null
  return (
    <CardBox region="fl-hello" title={run.facts.mind?.name ?? 'Your mind'}>
      {ref ? (
        <p className="fl-error" role="alert" data-testid="fl-refusal">
          <State state="blocked" /> {ref.sentence}
        </p>
      ) : greeting ? (
        <>
          <p className="fl-small">{v.line}{run.mode === 'demo' ? ' (simulated: an invented answer, no model was called)' : ''}</p>
          <blockquote className="fl-greeting" data-testid="fl-greeting">
            {greeting}
          </blockquote>
          <div className="fl-chips">
            <button type="button" className="fl-btn" onClick={() => run.facts.mind && run.mode === 'live' && navigate({ name: 'dot', id: run.facts.mind.id, tab: 'chat' })} disabled={run.mode !== 'live'}>
              Open the chat
            </button>
          </div>
        </>
      ) : (
        <p className="fl-small" role="status" aria-live="polite">
          {v.line || 'Your mind hasn’t been woken yet.'}
        </p>
      )}
      {!greeting && (
        <div className="fl-chips">
          {v.tryAgain && (
            <button type="button" className="fl-btn" data-tone="primary" disabled={run.hello.busy} onClick={() => void g.wake()}>
              Try again
            </button>
          )}
          {v.phase === 'lost' && (
            <button type="button" className="fl-btn" disabled={run.hello.busy} onClick={() => void g.wake()}>
              Wake
            </button>
          )}
        </div>
      )}
      {run.path === 'guest' && !greeting && !ref && <p className="fl-pays">{payerLine(whoOf(run))}</p>}
    </CardBox>
  )
}

/** R3 beat 5: the apps ready for this person, each with one Open (P14: no setup screens; it opens in their own space). */
export function AppsCard({ run, step }: { run: Run; step: FlStep }) {
  const g = useFirstLight.getState()
  const apps = run.facts.apps ?? []
  const first = useRef<HTMLButtonElement | null>(null)
  const waiting = step.wait?.for === 'apps'
  useLayoutEffect(() => {
    if (run.mode === 'live' && waiting) first.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.token])
  return (
    <CardBox region="fl-apps" title="Your apps">
      {apps.length ? (
        <ul className="fl-apps" aria-label="Apps ready for you">
          {apps.map((a, i) => (
            <li key={a.id}>
              <span className="fl-app-name">{a.name}</span>
              <span className="fl-small">{a.tagline ?? 'Ready for you'}</span>
              <button ref={i === 0 ? first : undefined} type="button" className="fl-btn" data-tone={i === 0 ? 'primary' : undefined} disabled={run.status === 'ended'} onClick={() => g.openApp(a.id)} aria-label={`Open ${a.name}`}>
                Open
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fl-small">{run.facts.apps === null ? 'I can’t see your apps just now.' : 'No apps are ready for you yet.'}</p>
      )}
      {waiting && (
        <div className="fl-chips">
          <button type="button" className="fl-btn" onClick={() => g.appsNext()} disabled={run.status !== 'playing'}>
            Next
          </button>
        </div>
      )}
      {run.mode === 'demo' && <p className="fl-small">Simulated: nothing opens here.</p>}
    </CardBox>
  )
}

/** R3 beat 6: name the Ask and say how it should be. Two fields and an explicit Save: no form, so no implicit submit. */
export function AskCard({ run, step }: { run: Run; step: FlStep }) {
  const g = useFirstLight.getState()
  const editing = step.wait?.for === 'ask'
  const [name, setName] = useState(run.facts.mind?.name ?? '')
  const [how, setHow] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => {
    if (run.mode === 'live' && editing) nameRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.token])
  const howShown = how ?? askPurposeValue(run.facts.askHow)
  if (!editing)
    return (
      <CardBox region="fl-ask" title="Your Ask">
        <p className="fl-app-name">{run.facts.mind?.name ?? 'Your mind'}</p>
        {run.facts.askHow ? <p className="fl-small">{run.facts.askHow}</p> : null}
      </CardBox>
    )
  return (
    <CardBox region="fl-ask" title="Your Ask">
      <label className="fl-field">
        <span>Its name</span>
        <input ref={nameRef} className="fl-input" value={name} maxLength={ASK_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" disabled={run.askForm.busy} />
      </label>
      <label className="fl-field">
        <span>Its purpose</span>
        {run.facts.askHow !== null && !personaEditable(run.facts.askHow) ? (
          <p className="fl-small">It already has longer words of its own. Change them on your mind’s page; saving here keeps them.</p>
        ) : (
          <textarea className="fl-input" rows={2} value={howShown} maxLength={ASK_HOW_MAX} onChange={(e) => setHow(e.target.value)} placeholder="For example: warm and brief, plain words" disabled={run.askForm.busy || run.facts.askHow === null} />
        )}
        {run.facts.askHow === null && <p className="fl-small">Its current words aren’t available yet. Saving its name keeps them unchanged.</p>}
      </label>
      {run.askForm.error && (
        <p className="fl-error" role="alert">
          {run.askForm.error}
        </p>
      )}
      {run.askForm.saves && !run.askForm.busy && !run.askForm.error && <p role="status">{profileSaveCopy(run.askForm.saves)}</p>}
      {run.askForm.saves?.readback && <details><summary>Here’s what {run.askForm.saves.readback.name} has now</summary><p>Name: {run.askForm.saves.readback.name}</p><p className="fl-u1-readback">Purpose: {run.askForm.saves.readback.purpose}</p></details>}
      <div className="fl-chips">
        <button type="button" className="fl-btn" data-tone="primary" disabled={run.askForm.busy || !name.trim() || run.status === 'ended'} onClick={() => void g.saveAsk(askToSave(name, how, run.facts.askHow))}>
          {run.askForm.busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="fl-btn" disabled={run.askForm.busy} onClick={() => g.skipBeat()}>
          Not now
        </button>
      </div>
    </CardBox>
  )
}

/** R3 hand-off: one press into the app the person will talk in; First Light ends there. */
export function StartCard({ run }: { run: Run }) {
  const g = useFirstLight.getState()
  const app = startApp(run.facts.apps)
  const ref = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (run.mode === 'live') ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.token])
  if (!app) return null
  return (
    <CardBox region="fl-start" title="Start talking">
      <div className="fl-chips">
        <button ref={ref} type="button" className="fl-btn" data-tone="primary" onClick={() => g.startTalking()}>
          Open {app.name}
        </button>
      </div>
      {run.mode === 'demo' && <p className="fl-small">Simulated: nothing opens here.</p>}
    </CardBox>
  )
}

function Controls({ run, step, setRef }: { run: Run; step: FlStep | undefined; setRef: (el: HTMLElement | null) => void }) {
  const g = useFirstLight.getState()
  const ended = run.status === 'ended' || !step
  const last = !!step && nextIndex(run.steps, run.i, factsOf(run)) < 0
  const waits = waitsForPerson(step) && !(step?.wait?.for === 'first-answer' && run.facts.greeted)
  return (
    <div className="fl-controls" ref={setRef} role="group" aria-label="First Light controls">
      <button type="button" className="fl-btn" onClick={() => g.back()} disabled={ended || run.i === 0 || run.status === 'loading'}>
        Back
      </button>
      <button type="button" className="fl-btn" aria-pressed={run.status === 'paused'} onClick={() => g.toggle()} disabled={ended || run.status === 'loading'}>
        {run.status === 'paused' ? 'Resume' : 'Pause'}
      </button>
      {!last && (
        <button type="button" className="fl-btn" data-tone="primary" onClick={() => g.next()} disabled={ended || waits || run.status === 'loading'}>
          Next
        </button>
      )}
      {step && step.beat !== 'hello' && !last && (
        <button type="button" className="fl-btn" onClick={() => g.skipBeat()} disabled={run.status === 'loading'} title="Skip this part; it stays on Finish setting up">
          Later
        </button>
      )}
      <button type="button" className="fl-btn" data-tone="quiet" onClick={() => g.stop()}>
        {last ? 'Close' : 'Stop'}
      </button>
    </div>
  )
}
