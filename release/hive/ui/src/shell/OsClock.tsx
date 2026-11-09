import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useAppStage } from './appStage'
import { KEEP_CLEAR } from './experienceStage'
import { useHive } from '../store/store'
import { browserTicker, clockShown, clockText, minuteTicker, setHourCycle, useHourCycle } from './clockModel'
import './osClock.css'
import { useJumpReading, useTimeJump } from '../brand/timeJump'
import { useReducedMotion } from '../lib/hooks'

const SKINS = new Set(['classic', 'still', 'canvas', 'cosmos', 'flux', 'construct'])

/**
 * What the clock steps aside for, read from the page itself: the rest ('rest': a `[data-rest]` screen is up, which
 * shows its own big clock), or a modal layer ('modal': an aria-modal dialog, or modal containment made the clock inert,
 * as a nav menu or the phone More sheet does; never visible-but-unreachable). '' when neither.
 */
function useStepAside(self: RefObject<HTMLElement | null>): '' | 'rest' | 'modal' {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'inert', 'data-rest'] })
      return () => mo.disconnect()
    },
    () => (document.querySelector('[data-rest]') ? 'rest' : document.querySelector('[aria-modal="true"]') || self.current?.closest('[inert]') ? 'modal' : ''),
    () => '',
  )
}

const noop = () => () => {}
/** The current minute (ms since the epoch, whole minutes), refreshed at each boundary while `on`; no timer while the tab is hidden. */
function useMinute(on: boolean): number {
  const subscribe = useCallback((changed: () => void) => minuteTicker(changed, browserTicker()), [])
  return useSyncExternalStore(on ? subscribe : noop, () => Math.floor(Date.now() / 60_000) * 60_000)
}

/**
 * The OS clock: one host clock in the bottom-right corner of every experience, page and app form, mirroring Ω in the
 * bottom-left (geometry and the keep-clear contract: shell/clockModel.ts). Hours and minutes in the person's locale and
 * hour cycle; the long date shows on hover and on focus (a tap on a touch screen). Only its dressing follows the
 * experience (shell/osClock.css); its place and size never do. It steps aside for the rest (which shows its own big
 * clock), for a modal dialog, and for a full-bleed app (which owns the whole stage by contract, PROGRAMS.md §9c).
 */
export function OsClock({ experience }: { experience: string }) {
  const stage = useAppStage()
  const ref = useRef<HTMLDivElement>(null)
  const aside = useStepAside(ref)
  const cycle = useHourCycle()
  const shown = clockShown({ resting: aside === 'rest', modal: aside === 'modal', stage: stage?.mode ?? null })
  const minute = useMinute(shown)
  const text = useMemo(() => clockText(new Date(minute), undefined, cycle), [minute, cycle])
  const reading = useJumpReading()
  const jumped = useTimeJump()   // the Easter egg (brand/timeJump): a second clock, at the time jumped to, for a moment

  // the clock's slot is reserved for as long as the clock is mounted, shown or stepped aside (osClock.css
  // --os-clock-slot / --os-clock-room): its own box never grows past the slot, so nothing around it ever has to move
  // when it returns from a modal, widens with the hour cycle, or ticks to a wider minute (Review r3)
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.osClock = ''
    return () => {
      delete root.dataset.osClock
    }
  }, [])
  // SIM ONLY: the browser checks switch the hour cycle in place (scripts/os-clock-check.mjs)
  const sim = useHive((s) => s.client?.mode === 'sim')
  useEffect(() => {
    if (!sim) return
    const w = window as unknown as { __osClock?: unknown }
    w.__osClock = { setHourCycle }
    return () => {
      delete w.__osClock
    }
  }, [sim])

  // always mounted (hidden when it steps aside), so its inert state and its box stay observable (useStageFit watches it)
  return (
    <div
      ref={ref}
      hidden={!shown}
      className="os-clock"
      data-skin={SKINS.has(experience) ? experience : 'classic'}
      {...{ [KEEP_CLEAR]: '' }}
      role="timer"
      aria-live="off"
      aria-label={text.label}
      tabIndex={0}
    >
      <time className="os-clock-time" dateTime={text.iso} aria-hidden="true">
        {text.time}
        {text.meridiem && <span className="os-clock-ampm">{text.meridiem}</span>}
      </time>
      {jumped !== null && (
        <span className="os-clock-then" aria-hidden="true">
          <span className="os-clock-then-gw">⚡ {reading}</span>
          <ThenTime to={jumped} cycle={cycle} />
        </span>
      )}
      <span className="os-clock-date" aria-hidden="true">
        {text.meridiem && <span className="os-clock-date-time">{`${text.time} ${text.meridiem} · `}</span>}
        {text.date}
      </span>
    </div>
  )
}

/** The second clock's time: it rolls from now to the time jumped to (a quick spin back or forward), then holds there. */
function ThenTime({ to, cycle }: { to: string; cycle: ReturnType<typeof useHourCycle> }) {
  const reduce = useReducedMotion()
  const target = /^\d{4}-\d\d-\d\dT/.test(to) ? Date.parse(to) : null
  const [at, setAt] = useState<number | null>(target === null || reduce ? target : Date.now())
  useEffect(() => {
    if (target === null || reduce) { setAt(target); return }
    const from = Date.now(), t0 = performance.now(), ms = 1100
    let raf = 0
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - u, 3)
      setAt(from + (target - from) * e)
      if (u < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, reduce])
  if (target === null) return <>{to || '…'}</>
  return <>{clockText(new Date(at ?? target), undefined, cycle).time}</>
}
