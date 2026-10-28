import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { readContext } from '../../lib/readContext'
import { useAuthContext } from '../../lib/useResource'
import { navigate } from '../../lib/router'
import { setResting } from '../../lib/resting'
import { countPending } from '../../store/reducer'
import { hiveBus, useHealthAlertCount, useHive } from '../../store/store'
import { useAskStore } from '../../store/ask'
import {
  alertLine,
  awayBarShown,
  awayChips,
  CHIP_VERB,
  liveAlerts,
  pressEndedBy,
  pressHeld,
  PRESS_ENDS,
  shieldShown,
  scrollIsPresence,
  chipDestination,
  isUrgent,
  restAlertFor,
  restBlocked,
  restChips,
  restCounts,
  restInitial,
  restReducer,
  TYPE_TARGETS,
  wakeFor,
  workingLine,
  type RestChipId,
  type RestInput,
  type RestProbe,
} from './rest'
import { clockParts, localeHour12 } from './restClocks'
import { RestFace } from './RestFaces'
import { useRestPrefs } from './menu'
import { embodimentOf } from './OffScreen'
import './power.css'

/** The minute clock: the only timer a rest keeps for its words (the scene, where there is one, draws itself). */
function useMinuteClock(on: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!on) return
    let t: ReturnType<typeof setTimeout>
    const arm = () => {
      const d = new Date()
      setNow(d)
      t = setTimeout(arm, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 20)
    }
    arm()
    return () => clearTimeout(t)
  }, [on])
  return now
}

/**
 * Whether the store's session (readContext(client, epoch), taken when the store last started a session) was taken under
 * the client's current sign-in. False in the moment after a credential change and before the store drops its data.
 */
function storeSessionCurrent(client: object | null | undefined, session: string): boolean {
  const head = readContext(client)
  return session.startsWith(`${head.slice(0, -1)},`)
}

/** Now, for an event handler (kept outside render so the purity lint can see it is never called while rendering). */
const stamp = () => Date.now()
const day = (d: Date) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

/** Everything that counts as the person being there, plus what tracks presses and input methods. */
const INPUTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'input', 'scroll', 'compositionstart', 'compositionend'] as const
const IDLE_CHECK_MS = 5000

function hasDraft(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled && el.value.trim() !== ''
  return el.isContentEditable && (el.textContent ?? '').trim() !== ''
}
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
const modalOpen = () => !!document.querySelector('[aria-modal="true"]')

/** The Ask (or the experience's own command line) a keystroke typed while resting goes to; null when there is none. */
function typeTarget(): HTMLElement | null {
  for (const sel of TYPE_TARGETS) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el && !el.closest('[inert]') && !(el as HTMLInputElement).disabled && el.getClientRects().length) return el
  }
  return null
}

/**
 * Resting (the owner, 2026-10-05: "when no user input for some time it just goes into a resting animation while it works
 * quietly in the background and subtle alerts are displayed along with a clock"). Per page, per person: after their
 * idle time the experience settles into its own rest while the hive keeps working. The hive's power wins: while it is
 * off (or lighting up) this page never rests, and a rest ends at once when it goes off.
 *
 *  - never starts while a dialog or confirm is open, mid-press or drag, mid-composition, or with words in a field;
 *  - ends on any input: a key (which goes on to where it was going, or into the Ask when nothing was focused), a wheel,
 *    a press elsewhere, a real pointer move; a press on the rest wakes on its click, so it never lands on the page;
 *  - ends when a dialog opens anyway (a rest never covers a confirm), and on pending decisions and budget refusals;
 *  - belongs to one sign-in (Review B1): everything it gathered is bound to readContext(client, store session) and
 *    dropped at once, in the same render, on any sign-in or credential change; late events and old callbacks are fenced;
 *  - entering it announces nothing (no focus move; the live line starts empty); its alerts are buttons, reachable;
 *  - costs little: the minute clock, and a scene drawn slowly only while visible (none under reduced motion).
 */
export function RestHost({ experience, allowed, reduced, onResting, admin = false }: { experience: string; allowed: boolean; reduced: boolean; onResting: (r: boolean) => void; admin?: boolean }) {
  // ---- the sign-in this rest belongs to: the store's session primitive plus the client's credential handle. useAuthContext
  // re-renders on a credential change (re-login without a logout, another tab), and readContext reads the handle itself.
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  useAuthContext(client)
  const ctx = readContext(client, session)
  const minutes = useRestPrefs((s) => s.minutes)
  const [stored, dispatch] = useReducer(restReducer, ctx, (c: string) => restInitial(Date.now(), c))
  // Review B1: a different sign-in drops everything in this very render (nothing of the previous person is ever drawn
  // or acted on), and the reducer follows (React's adjust-state-while-rendering pattern; idempotent)
  const v = stored.ctx === ctx ? stored : restInitial(stored.lastInput, ctx)
  if (stored.ctx !== ctx) dispatch({ type: 'identity', ctx, at: stored.lastInput })
  const last = useRef(0)
  const realInput = useRef(0)
  const resting = useRef(false)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const pressedAt = useRef<number | null>(null)
  const composing = useRef(false)
  const chipFallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  // the viewer's scope for alerts as they are recorded (the bus subscription is made once)
  const adminRef = useRef(admin)
  useEffect(() => {
    adminRef.current = admin
  }, [admin])
  // the sign-in a click shield was raised under (null: none)
  const [shield, setShield] = useState<string | null>(null)
  const kind = embodimentOf(experience)
  const now = useMinuteClock(v.resting)

  useEffect(() => {
    resting.current = v.resting
    setResting(v.resting)
    onResting(v.resting)
  }, [v.resting, onResting])
  useEffect(() => () => setResting(false), [])

  useEffect(() => {
    last.current = Date.now()
    const release = () => {
      pressedAt.current = null
    }
    const on = (e: Event) => {
      const t = e.type
      const at0 = Date.now()
      if (t === 'compositionstart' || t === 'compositionend') {
        composing.current = t === 'compositionstart'
        last.current = realInput.current = at0
        return
      }
      if (t === 'scroll') {
        // a scroll continuing the person's own gesture (momentum) is presence; the page scrolling itself later is not
        if (scrollIsPresence(at0, realInput.current)) last.current = at0
        return
      }
      const pe = e as PointerEvent
      if (t === 'pointerdown') pressedAt.current = at0
      else if (t === 'pointermove' && pressEndedBy({ type: t, buttons: pe.buttons })) pressedAt.current = null
      if (e.isTrusted !== false) realInput.current = at0
      const at = t === 'pointermove' || t === 'pointerdown' ? { x: pe.screenX, y: pe.screenY } : null
      if (!resting.current) {
        last.current = at0
        if (at) pointer.current = at
        return
      }
      const ke = e as KeyboardEvent
      const target = e.target instanceof Element ? e.target : null
      const input: RestInput = {
        type: t as RestInput['type'],
        key: t === 'keydown' ? ke.key : undefined,
        mod: t === 'keydown' ? ke.metaKey || ke.ctrlKey || ke.altKey : undefined,
        x: at?.x,
        y: at?.y,
        onRest: !!target?.closest('.pw-rest'),
        onChip: !!target?.closest('.pw-rest [data-rest-chip]'),
        intoField: isField(document.activeElement),
      }
      const d = wakeFor(input, pointer.current)
      if (at && !pointer.current) pointer.current = at
      if (input.onChip && (t === 'pointerdown' || t === 'touchstart')) {
        // the alert's click wakes and goes there; if that click never comes (a drift, a cancelled long press), wake anyway
        if (chipFallback.current) clearTimeout(chipFallback.current)
        chipFallback.current = setTimeout(() => resting.current && dispatch({ type: 'input', at: Date.now() }), 900)
      }
      if (!d.wake) return
      last.current = at0
      // the keystroke is never consumed: focusing the Ask now lets this very key land in it
      if (d.typeIntoAsk) typeTarget()?.focus({ preventScroll: true })
      // a press that woke the rest: a transparent shield takes its click, so it never lands on the page beneath
      if (d.shield) {
        const st = useHive.getState()
        setShield(readContext(st.client, st.session))
      }
      dispatch({ type: 'input', at: last.current })
    }
    INPUTS.forEach((n) => window.addEventListener(n, on, { capture: true, passive: true }))
    PRESS_ENDS.forEach((n) => (n === 'visibilitychange' ? document : window).addEventListener(n, release, { capture: true, passive: true }))
    return () => {
      INPUTS.forEach((n) => window.removeEventListener(n, on, { capture: true }))
      PRESS_ENDS.forEach((n) => (n === 'visibilitychange' ? document : window).removeEventListener(n, release, { capture: true }))
      if (chipFallback.current) clearTimeout(chipFallback.current)
    }
  }, [])

  useEffect(() => {
    if (!shield) return
    const t = setTimeout(() => setShield(null), 700)
    return () => clearTimeout(t)
  }, [shield])

  // the idle check runs only while awake: at rest the minute clock is the only timer
  useEffect(() => {
    if (!allowed || !minutes || v.resting) return
    const t = setInterval(() => {
      const at = Date.now()
      const probe: RestProbe = { hidden: document.hidden, modal: modalOpen(), pointerDown: pressHeld(pressedAt.current, at), composing: composing.current, draft: hasDraft(document.activeElement) }
      dispatch({ type: 'tick', at, idleMs: minutes * 60_000, lastInput: last.current, blocked: restBlocked(probe) })
    }, IDLE_CHECK_MS)
    return () => clearInterval(t)
  }, [allowed, minutes, v.resting])

  // a dialog that opens anyway (a mind's proposal, a confirm) ends the rest: a rest never covers one
  useEffect(() => {
    if (!v.resting) return
    const mo = new MutationObserver(() => modalOpen() && dispatch({ type: 'input', at: Date.now() }))
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal'] })
    return () => mo.disconnect()
  }, [v.resting])

  // the page may no longer rest (not ready, signed out, the hive off): purge, never wake into an old summary
  useEffect(() => {
    if (!allowed) dispatch({ type: 'reset', ctx, at: Date.now() })
  }, [allowed, ctx])
  // a sign-in change drops any click shield (it is also fenced while drawing: same sign-in, a page allowed to rest)
  useEffect(() => () => setShield(null), [ctx])

  useEffect(
    () =>
      hiveBus.on((e) => {
        if (!resting.current) return
        if (isUrgent(e)) dispatch({ type: 'urgent', at: Date.now() })
        else {
          const a = restAlertFor(e)
          // admitted only under the identity current as it arrives (the reducer drops any other)
          const st = useHive.getState()
          // (and only while the store's session is the current sign-in's: a stream not yet re-read is the previous one's)
          if (a && storeSessionCurrent(st.client, st.session)) dispatch({ type: 'alert', alert: a, ctx: readContext(st.client, st.session), admin: adminRef.current })
        }
      }),
    [],
  )

  // one alert line at a time, a few seconds each
  useEffect(() => {
    if (!v.showing) return
    const t = setTimeout(() => dispatch({ type: 'next' }), 7000)
    return () => clearTimeout(t)
  }, [v.showing])

  useEffect(() => {
    if (!v.summary) return
    const t = setTimeout(() => dispatch({ type: 'clearSummary' }), 12_000)
    return () => clearTimeout(t)
  }, [v.summary])

  // what waits, and the quiet sign the hive is working (primitives, so a busy hive does not re-render the rest). Kimi 4:
  // these are this viewer's own store, filled only by its per-person reads and per-person event stream, through the same
  // selectors as the Inbox and Health badges; health and people's asks are shown to admins only.
  // r3 (Kimi r2): the ambient scene and counts are this sign-in's too. They are drawn only when the rest state and the
  // store's data both belong to the current sign-in; in any frame where either does not (a switch, or a credential
  // change the store has not yet re-read), they are empty: never the previous person's hive.
  const ambient = stored.ctx === ctx && storeSessionCurrent(client, session)
  const decisionsRaw = useHive((s) => countPending(s.approvals))
  const healthRaw = useHealthAlertCount()
  const pendingRaw = useHive((s) =>
    Object.values(s.approvals)
      .filter((a) => a.status === 'pending')
      .map((a) => a.id)
      .sort()
      .join(','),
  )
  const awakeRaw = useHive((s) => Object.values(s.agents).filter((a) => a.status === 'awake').length)
  const thinkingRaw = useHive((s) => Object.values(s.thinking).filter((p) => p !== 'idle').length)
  const huesRaw = useHive((s) =>
    Object.values(s.agents)
      .sort((a, b) => Number(b.status === 'awake') - Number(a.status === 'awake'))
      .slice(0, 14)
      .map((a) => a.hue)
      .join(','),
  )
  const decisions = ambient ? decisionsRaw : 0
  const health = ambient ? healthRaw : 0
  const pendingKey = ambient ? pendingRaw : ''
  const awake = ambient ? awakeRaw : 0
  const thinking = ambient ? thinkingRaw : 0
  const hueKey = ambient ? huesRaw : ''
  const hour12 = useMemo(() => localeHour12(), [])
  const clock = clockParts(now, hour12)
  const scene = useMemo(() => ({ hues: hueKey ? hueKey.split(',').map(Number) : [], awake, digits: clock.digits }), [hueKey, awake, clock.digits])
  // the away line's words are a HISTORY (what this page received, fixed once shown: v.summary); its buttons, the counts
  // and the rest's line are ACTIONS, from the alerts still live (a decision settled elsewhere is no longer offered)
  const pending = new Set(pendingKey ? pendingKey.split(',') : [])
  const liveAway = liveAlerts(v.away, pending, admin)
  const liveMissed = liveAlerts(v.missed, pending, admin)
  const showing = v.showing && liveAlerts([v.showing], pending, admin).length ? v.showing : null
  const chips = restChips(restCounts({ decisions, health }, liveAway, admin))
  const missedChips = awayChips(liveMissed, decisions)

  // a way in acts only for the sign-in it was offered under (a callback kept from before a switch does nothing)
  const offeredUnder = ctx
  const go = (id: RestChipId, from: typeof v.away) => {
    const st = useHive.getState()
    if (readContext(st.client, st.session) !== offeredUnder) return
    if (chipFallback.current) clearTimeout(chipFallback.current)
    const to = chipDestination(id, from)
    dispatch({ type: 'input', at: stamp() })
    // only this way in is used up; the others stay offered (the history stays until dismissed)
    dispatch({ type: 'acted', chip: id })
    if (to.name === 'thread') {
      if (document.querySelector('.ask-root')) useAskStore.getState().setThreadOpen(true)
      else navigate({ name: 'hive' })
    } else navigate(to)
  }
  const wake = () => dispatch({ type: 'input', at: stamp() })

  return (
    <>
      {v.resting && (
        // not a dialog and not focused: the page behind stays as it was, and entering announces nothing
        <div className={`pw-rest pw-rest-${kind}${reduced ? ' pw-reduced' : ''}`} data-rest={kind} onClick={wake}>
          <RestFace
            kind={kind}
            reduced={reduced}
            now={now}
            clock={clock}
            date={day(now)}
            line={showing ? alertLine(showing) : null}
            working={workingLine(awake, thinking)}
            busy={thinking > 0}
            chips={chips}
            scene={scene}
            onChip={(id) => go(id, liveAway)}
          />
        </div>
      )}
      {allowed && shieldShown(shield, ctx, v.resting) && <div className="pw-shield" aria-hidden="true" onClick={(e) => e.stopPropagation()} />}
      {!v.resting && awayBarShown(v.summary, missedChips.length) && (
        <div className={`pw-away pw-away-${kind}`} role="status" data-away="">
          <span>{v.summary}</span>
          {missedChips.map((c) => (
            <button key={c.id} type="button" className="pw-away-go" data-rest-chip={c.id} onClick={() => go(c.id, liveMissed)}>
              {CHIP_VERB[c.id]}
            </button>
          ))}
          <button type="button" aria-label="Dismiss" onClick={() => dispatch({ type: 'clearSummary' })}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
