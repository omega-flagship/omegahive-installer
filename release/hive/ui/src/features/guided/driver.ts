/**
 * Plays one step of a guided demo: its screen action, then its wait, then finds what it points at. Everything goes
 * through an injected environment (the real one is `liveEnv`), so the step logic is tested without a browser.
 *
 * Client-side only (Platform, 2026-10-07): existing routes, the presence protocol's targets, navigation and harmless
 * UI. No host hook, no new route, nothing that decides, spends or changes the hive.
 */
import type { Route } from '../../lib/router'
import type { GuideAction, GuideStep, GuideTarget, GuideWait } from './types'

export interface Picks {
  mind: { id: string; name: string } | null
  swarm: { id: string; name: string } | null
  belief: string | null
}

export interface GuideEnv {
  go(route: Route): void
  picks(): Picks
  /** is this app on this hive and enabled? */
  appEnabled(id: string): boolean
  /** harmless UI; `ask-bar` folds the Ask's thread to its bar (a `read` step), the Ask itself stays */
  ui(kind: 'gallery' | 'palette' | 'help' | 'close' | 'ask-bar'): void
  experience(id: string | null): void
  press(tour: string, open: boolean): void
  find(targets: GuideTarget[], picks: Picks): Element | null
  /** bring it into view when it is on the page but scrolled away; `whole` (a reading step): all of it, above the Ask */
  reveal(el: Element, whole?: boolean): void
  sleep(ms: number): Promise<void>
}

export interface StepResult {
  el: Element | null
  /** an honest note when the step could not do what it says (no mind yet, the app is not on this hive) */
  note: string | null
}

export const TARGET_MS = 4000
const POLL_MS = 120

export const targetsOf = (t: GuideStep['target']): GuideTarget[] => (!t ? [] : Array.isArray(t) ? t : [t])

/** Fill `{mind}`, `{swarm}` and `{belief}` with what the demo picked, or plain words when the hive has none. */
export function fill(text: string, p: Picks): string {
  return text
    .replace(/\{mind\}/g, p.mind?.name ?? 'a mind')
    .replace(/\{swarm\}/g, p.swarm?.name ?? 'a swarm')
    .replace(/\{belief\}/g, p.belief ?? 'one of its beliefs')
}

/** Do a step's screen action. Returns an honest note when it could not. */
export function applyAction(a: GuideAction, env: GuideEnv, p: Picks): string | null {
  if ('go' in a) {
    env.go(a.go)
    return null
  }
  if ('mind' in a) {
    if (!p.mind) return 'This hive has no mind yet, so there is nothing to open here.'
    env.go({ name: 'dot', id: p.mind.id, tab: a.mind })
    return null
  }
  if ('swarm' in a) {
    if (!p.swarm) return 'This hive has no swarm yet, so there is nothing to open here.'
    if (a.belief && p.belief) env.go({ name: 'swarm', id: p.swarm.id, statement: p.belief })
    else env.go({ name: 'swarm', id: p.swarm.id, tab: a.swarm === 'home' ? undefined : a.swarm })
    return a.belief && !p.belief ? `${p.swarm.name} has no shared beliefs yet, so there is no belief to open.` : null
  }
  if ('app' in a) {
    if (!env.appEnabled(a.app)) {
      env.go({ name: 'programs' })
      return 'That app is not on this hive, so here are the apps that are.'
    }
    env.go({ name: 'program', id: a.app, ...(p.swarm ? { swarm: p.swarm.id } : {}) })
    return null
  }
  if ('room' in a) {
    env.go({ name: 'messages', room: a.room })
    return null
  }
  if ('ui' in a) {
    env.ui(a.ui)
    return null
  }
  if ('experience' in a) {
    env.experience(a.experience)
    return null
  }
  env.press(a.press, a.open ?? true)
  return null
}

const waitOf = (step: GuideStep): GuideWait => step.wait ?? (targetsOf(step.target).length ? { for: 'target' } : { for: 'time', ms: 400 })

/**
 * Play one step: action, wait, target. `alive()` turns false when the step is superseded (paused, stopped, another
 * step, a sign-in change); the step then ends at once and nothing more happens.
 */
export async function playStep(step: GuideStep, env: GuideEnv, alive: () => boolean): Promise<StepResult> {
  const p = env.picks()
  const note = step.do ? applyAction(step.do, env, p) : null
  if (step.read) env.ui('ask-bar')
  const targets = targetsOf(step.target)
  const w = waitOf(step)
  let el: Element | null = null
  if (w.for === 'time') {
    await env.sleep(w.ms)
    if (targets.length && alive()) el = env.find(targets, p)
  } else {
    const limit = w.for === 'you' ? Infinity : w.ms ?? TARGET_MS
    let waited = 0
    for (;;) {
      if (!alive()) return { el: null, note }
      el = env.find(targets, p)
      if (el || waited >= limit) break
      await env.sleep(POLL_MS)
      waited += POLL_MS
    }
  }
  if (el && alive()) env.reveal(el, step.read)
  return { el, note }
}

// ---------------------------------------------------------------- finding targets on the page

const SAFE = /^[A-Za-z0-9_.:-]{1,200}$/
const ASK_SEL = '#ask .ask-capsule, #ask .ask-still-line, .still .st-ask'

/** The selectors for one target (only safe values; the guide's own UI is never a target). */
export function selectorsOf(t: GuideTarget, p: Picks): string[] {
  const out: string[] = []
  if (t.entity) {
    const ref = t.entity === 'mind' ? p.mind?.id : p.swarm?.id
    if (ref && SAFE.test(ref)) out.push(`[data-presence-ref="${t.entity}:${ref}"]`)
  }
  if (t.feature && /^[a-z]+\.[a-z]+$/.test(t.feature)) out.push(`[data-presence-feature="${t.feature}"]`)
  if (t.region && /^[a-z][a-z0-9-]{0,40}$/.test(t.region)) out.push(`[data-presence-region="${t.region}"]`)
  if (t.tour && SAFE.test(t.tour)) out.push(`[data-tour="${t.tour}"]`)
  if (t.ask) out.push(ASK_SEL)
  return out
}

interface Rooted {
  querySelectorAll(sel: string): ArrayLike<Element>
}

/** The first target, in order, that is on the page with a real size and not under a modal or inert. */
export function findIn(root: Rooted, targets: GuideTarget[], p: Picks): Element | null {
  for (const t of targets) {
    for (const sel of selectorsOf(t, p)) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        if (el.closest('[inert],[aria-hidden="true"],.guide-ui')) continue
        return el
      }
    }
  }
  return null
}
