/**
 * Cosmos's own rest and awake (CANDIDATE, cosmos-rest-r1; PLAN_ONE_EXPERIENCE_REST_TO_PRO_R1, Design's
 * COSMOS_REST_AWAKE_PRO_REVIEW_BAR_R1). The shell owns the state, the one Ask and power (shell/phase.ts); Cosmos draws
 * every state in its one scene (Scene.tsx: the Ω is the galaxy's own core, the camera flies) and these are the DOM
 * parts that follow it: real buttons and real text, never names painted only into the canvas.
 *
 * The named parts (cosmos rest ω, …) are registered in the real MeTTa space from ./parts.metta; every DOM part
 * here carries its atom's name in `data-ui-part`, and parts.test.ts checks the two agree.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { countPending, omegaGesture, plural, shown, useHive, usePhase, type ExperiencePhases, type PhaseRendererProps, type ShellPhase } from '../sdk'
import { typesIntoAsk, wakeIntoApps, wakeIntoAsk } from '../../shell/phase'
import { onePointerPress, readGesture, wheelIsNavigation, type PhaseEvent } from '../../shell/phase'
import { useAskStore } from '../../store/ask'
import { announcement, appClock, awakeStatus, firstLive, follow, omegaMarkLive, PRO_FOCUS_CHAIN, uGalaxy, uSky } from './phaseRig'
import { useOrbitApps } from './phaseApps'
import { LiveOmega } from '../../brand/LiveOmega'
import { useCosmos } from './state'
import './phases.css'

/** Registers a root that the scene writes the Ω's screen point into (--cx-ox, --cx-oy). */
function useFollowRoot() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    follow.roots.add(el)
    return () => {
      follow.roots.delete(el)
    }
  }, [])
  return ref
}

/**
 * The living Ω of a layer, told to the scene so it draws no star behind a mark that is showing (phaseRig): live only
 * while it is drawn AND its layer is the one in front, so a hidden layer's mark never keeps the star away.
 */
function useLayerMarkLive(layer: 'rest' | 'awake', on: boolean): (live: boolean) => void {
  const [live, setLive] = useState(false)
  useEffect(() => {
    omegaMarkLive.set(layer, live && on)
    return () => omegaMarkLive.set(layer, false)
  }, [layer, live, on])
  return setLive
}

/** The polite live line: derived during render from the shell's state (phaseRig.announcement). */
const useAnnounce = (phase: ShellPhase, from: ShellPhase | null, when: ShellPhase, words: string): string => announcement(phase, from, when, words)

/**
 * If the focused control is in a layer that just went away, focus moves to this state's own stable control (Design:
 * never trap focus in an invisible outgoing layer). Focus already somewhere live (the Ask, an app page) is left alone.
 */
function useFocusHome(on: boolean, home: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!on) return
    const t = window.setTimeout(() => {
      const a = document.activeElement as HTMLElement | null
      const gone = !a || a === document.body || !!a.closest('[inert], .cxp:not([data-on="1"])')
      if (gone) home.current?.focus({ preventScroll: true })
    }, 30)
    return () => window.clearTimeout(t)
  }, [on, home])
}

/** SIM ONLY: the browser checks read the shell's state and the scene's fades (never on a real hive). */
function useSimProbe() {
  const sim = useHive((s) => s.client?.mode === 'sim')
  useEffect(() => {
    if (!sim) return
    const w = window as unknown as { __cosmosPhase?: unknown }
    w.__cosmosPhase = { state: () => ({ ...usePhase.getState() }), fades: () => ({ galaxy: uGalaxy.value, sky: uSky.value }) }
    return () => {
      delete w.__cosmosPhase
    }
  }, [sim])
}

/** A press on the sky, read: an upward swipe, a tap, or any other drag (direct navigation). */
function surfaceEvent(dx: number, dy: number): PhaseEvent {
  const g = readGesture(dx, dy)
  return g === 'swipe' ? 'omega-swipe' : g === 'tap' ? 'omega-tap' : 'navigate'
}

/** Going to a page the person chose: their open thread sheet steps aside so the page is what they see (a pinned thread stays). */
function clearThreadFor() {
  const a = useAskStore.getState()
  if (a.threadOpen && !a.pinned) a.setThreadOpen(false)
}

/* ============================================================ rest */

/** Rest: the real sky, dim and slow, one warm star at its heart, and the faint question beneath it. Nothing else. */
function CosmosRest({ phase, from, reduced, waiting, ask }: PhaseRendererProps) {
  const [spokenWaiting, setSpokenWaiting] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setSpokenWaiting(phase === 'rest' && waiting > 0 ? `${plural(waiting, 'notice')} waiting.` : ''), 1000)
    return () => window.clearTimeout(t)
  }, [phase, waiting])
  const on = phase === 'rest'
  const markLive = useLayerMarkLive('rest', on)
  useSimProbe()
  const root = useFollowRoot()
  const omega = useRef<HTMLButtonElement>(null)
  const gesture = useMemo(() => omegaGesture(), [])
  const surface = useMemo(() => onePointerPress(), [])
  useFocusHome(on, omega)
  const said = useAnnounce(phase, from, 'rest', 'Resting. Your minds keep working. Press the Ω, or start typing, to wake.')

  // a key typed at rest wakes the view and lands in the one Ask (never consumed). Listened to after the focused
  // control's own handler (bubble phase), so a control that takes a key for itself keeps it (Kimi r1 #5)
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (!typesIntoAsk(e, e.target)) return
      wakeIntoAsk('type')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])

  return (
    <div ref={root} className="cxp cxp-rest" data-on={on ? '1' : '0'} data-reduced={reduced ? '1' : undefined} inert={!on ? true : undefined} aria-hidden={!on ? true : undefined}>
      {/* the whole sky answers too: a tap or an upward swipe anywhere wakes (the Ω below is the focusable way) */}
      <div
        className="cxp-surface"
        aria-hidden="true"
        onPointerDown={(e) => surface.down(e)}
        onPointerUp={(e) => {
          const t = surface.up(e)
          if (t) usePhase.getState().send(surfaceEvent(t.dx, t.dy))
        }}
        onPointerCancel={(e) => surface.cancel(e)}
        // a wheel on the sky is direct navigation too: it wakes at once, never swallowed. A pinch (two fingers, or a
        // trackpad pinch's ctrl-wheel) is the page's own zoom and wakes nothing (stand-in r2 #1, Kimi r2 #2)
        onWheel={(e) => {
          if (wheelIsNavigation(e)) void usePhase.getState().send('navigate')
        }}
      />
      <button ref={omega} type="button" className="cxp-omega cxp-omega-rest" data-ui-part="cosmos rest ω" aria-label="Omega, resting. Wake" {...gesture}>
        <LiveOmega look="cosmos" size="hero" pace="still" className="cxp-omega-live" fallback={null} onLive={markLive} />
        <span className="cxp-omega-mark" aria-hidden="true" />
      </button>
      <button type="button" className="cxp-question" data-ui-part="cosmos rest question" onClick={() => wakeIntoAsk('omega-tap')}>
        What do you want me to be?
      </button>
      <button type="button" className="cxp-rest-apps" data-ui-part="cosmos rest apps" data-intent="shell.apps" onClick={() => { if (ask.alive()) wakeIntoApps() }}>
        Your apps
      </button>
      {/* the rest draws no toasts; one quiet count says how many wait for the wake (shell/restNotices) */}
      {waiting > 0 && <p className="cxp-rest-waiting" aria-hidden="true">{plural(waiting, 'notice')} waiting</p>}
      {/* the count has its own polite live node, said a moment after it settles (Dot R3.1: the first rest has no
          announcement of its own to carry it; a burst of notices is said once) */}
      <p className="cxp-sr" role="status" aria-live="polite">{spokenWaiting}</p>
      <p className="cxp-sr" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  )
}

/* ============================================================ awake */

/** The name the Ω answers to: the person's own mind's name when the hive has one for them, else Omega. */
function useOmegaName(): string {
  const personal = useAskStore((s) => s.personal)
  const n = shown(personal?.name ?? '').trim()
  return n && !/^omega$/i.test(n) ? n : 'Omega'
}

/** Awake: the Ω named, the field (the shell's one Ask) below, real apps in orbit, Pro at top right, power bottom left. */
function CosmosAwake({ phase, from, reduced, ask, apps: shellApps, presence }: PhaseRendererProps) {
  const on = phase === 'awake'
  const markLive = useLayerMarkLive('awake', on)
  const root = useFollowRoot()
  const omega = useRef<HTMLButtonElement>(null)
  const name = useOmegaName()
  const width = useViewportWidth()
  // the hive's apps are read only once the view is awake (Kimi r1 #7), never at rest
  const apps = useOrbitApps(shellApps, width)
  const surface = useMemo(() => onePointerPress(), [])
  const minds = useHive((s) => Object.values(s.agents).length)
  const lit = useHive((s) => Object.values(s.agents).filter((a) => a.status === 'awake').length)
  const waiting = useHive((s) => countPending(s.approvals))
  const send = usePhase((s) => s.send)
  const gesture = useMemo(
    () =>
      omegaGesture({
        // a tap on the named Ω is "I want to say something": the one field takes focus
        onTap: () => ask.focus(),
        onSwipe: () => void usePhase.getState().send('omega-swipe'),
      }),
    [ask],
  )
  useFocusHome(on, omega)
  const said = useAnnounce(phase, from, 'awake', `${name} is awake. Ask below, open an app, or choose Pro for the full Cosmos.`)
  const open = useCallback((a: { open(): boolean }) => {
    clearThreadFor()
    a.open()
  }, [])
  const toApps = () => {
    clearThreadFor()
    apps.openAll()
  }
  const hold = (d: number) => () => {
    appClock.hold = Math.max(0, appClock.hold + d)
  }
  // a label that goes away while held (the state changed under the pointer) never leaves the orbit frozen
  useEffect(() => {
    if (!on) appClock.hold = 0
  }, [on])
  const toDecisions = () => {
    send('pro')
    useCosmos.getState().setApprovals(true)
  }

  return (
    <div ref={root} className="cxp cxp-awake" data-on={on ? '1' : '0'} data-reduced={reduced ? '1' : undefined} inert={!on ? true : undefined} aria-hidden={!on ? true : undefined}>
      {/* the awake view is the Ω's own: a tap on empty space is quiet; a drag or a wheel is direct navigation, which
          takes the person into Pro at once (Kimi r1 #2) rather than being swallowed */}
      <div
        className="cxp-surface"
        aria-hidden="true"
        onPointerDown={(e) => surface.down(e)}
        onPointerUp={(e) => {
          const t = surface.up(e)
          if (t && surfaceEvent(t.dx, t.dy) !== 'omega-tap') usePhase.getState().send('navigate')
        }}
        onPointerCancel={(e) => surface.cancel(e)}
        // a pinch zooms the page and stays awake; it is never a way into Pro (Kimi r2 #2)
        onWheel={(e) => {
          if (wheelIsNavigation(e)) void usePhase.getState().send('navigate')
        }}
      />
      <button ref={omega} type="button" className="cxp-omega cxp-omega-awake" data-ui-part="cosmos awake ω" aria-label={`${name}. Swipe up on it, or choose Pro, for the full Cosmos`} {...gesture}>
        <LiveOmega look="cosmos" size="hero" pace={on ? 'awake' : 'still'} className="cxp-omega-live" fallback={null} presence={presence ? { state: presence.presence, level: presence.level } : undefined} pulse={presence?.pulse} hold={presence?.hold} onLive={markLive} />
        <span className="cxp-omega-mark" aria-hidden="true" />
      </button>
      <div className="cxp-name" data-ui-part="cosmos awake name">
        <h1 className="cxp-name-word">{name}</h1>
        <p className="cxp-status">
          {awakeStatus(minds, lit)}
          {waiting > 0 && (
            <>
              {' · '}
              <button type="button" className="cxp-waiting" onClick={toDecisions}>
                {waiting} waiting for you
              </button>
            </>
          )}
        </p>
      </div>
      <ul className="cxp-apps" data-ui-part="cosmos awake app-orbit" aria-label="Apps">
        {apps.shown.map((a, i) => (
          <li key={a.id} className="cxp-app-slot" ref={(el) => void (el ? follow.apps.set(i, el) : follow.apps.delete(i))} style={{ ['--cxp-i' as string]: i }}>
            <button type="button" className="cxp-app" style={{ ['--cxp-hue' as string]: a.color }} onClick={() => open(a)} onPointerEnter={hold(1)} onPointerLeave={hold(-1)} onFocus={hold(1)} onBlur={hold(-1)} aria-label={`Open ${a.name}, an app in your hive`}>
              <span className="cxp-app-name">{a.name}</span>
              <span className="cxp-badge" aria-hidden="true" title="An app in your hive">
                Ω
              </span>
            </button>
          </li>
        ))}
      </ul>
      {apps.loaded && apps.total === 0 && (
        <button type="button" className="cxp-allapps" onClick={toApps}>
          No apps yet · find apps
        </button>
      )}
      {apps.total > apps.shown.length && (
        <button type="button" className="cxp-allapps" onClick={toApps}>
          All {plural(apps.total, 'app')}
        </button>
      )}
      <button type="button" className="cxp-pro" data-ui-part="cosmos awake pro-gesture" onClick={() => send('pro')} aria-label="Pro: the full Cosmos">
        <span>Pro</span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          <ellipse cx="8" cy="8" rx="6.4" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1" />
          <ellipse cx="8" cy="8" rx="6.4" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1" transform="rotate(60 8 8)" />
        </svg>
      </button>
      <button type="button" className="cxp-power" data-ui-part="cosmos awake power" onClick={() => send('power')} aria-label="Rest this screen. Your minds keep working" title="Rest (this screen only)">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 1.8v5.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
          <path d="M4.6 4.2a5.2 5.2 0 1 0 6.8 0" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <p className="cxp-sr" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  )
}

function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth))
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/**
 * The hooks: the scene flies by itself (it reads the shell's state), so these only keep focus and the keyboard
 * honest. Pro is the Cosmos as built: nothing is reset, cleared or re-seeded on the way in or out.
 */
export const phases: ExperiencePhases = {
  rest: CosmosRest,
  awake: CosmosAwake,
  toPro: () => {
    // focus that was on an awake control follows into Pro, always to a named place (Kimi r1 #4): Pro's way back to the
    // Ω, else the one Ask, else Cosmos's root (labelled "Cosmos, the full view"); tried over a few frames while Pro's
    // chrome arrives, never left on the body
    let tries = 0
    const land = () => {
      const a = document.activeElement as HTMLElement | null
      if (a && a !== document.body && !a.closest('.cxp')) return
      const sel = firstLive(PRO_FOCUS_CHAIN, (q) => document.querySelector<HTMLElement>(q))
      if (sel) document.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true })
      else if (++tries < 10) window.setTimeout(land, 60)
    }
    window.setTimeout(land, 30)
  },
  fromPro: () => undefined,
}

