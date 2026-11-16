// Purpose: the open page's composed screens as the page draws them (Screen.tsx), for the stage: each of their parts can be
// arranged beside what a mind shows and drawn there by the block that draws it on the page, through the page's own host.
import { createContext, useSyncExternalStore } from 'react'
import type { DrawnPart, ScreenPlan } from './plan'
import type { ScreenHost } from './Screen'

export interface OpenScreen {
  plan: ScreenPlan
  /** The page's host as it last drew the screen: read when a part is drawn, so the stage acts on the page's data now. */
  host: () => ScreenHost
}

/** A screen drawn inside something that is not the page itself (a view's frame, a stage tile) is not the page's. */
export const NotThePage = createContext(false)

const plans = new Map<symbol, ScreenPlan>()
const hosts = new Map<symbol, ScreenHost>()
let snapshot: OpenScreen[] = []
const subs = new Set<() => void>()
const rebuild = () => {
  snapshot = [...plans.entries()].map(([owner, plan]) => ({ plan, host: () => hosts.get(owner)! }))
  subs.forEach((f) => f())
}

/** A page's screen as it draws now, or gone (null). A new host alone changes nothing anyone reads until a part is drawn. */
export function publishScreen(owner: symbol, plan: ScreenPlan | null, host?: ScreenHost): void {
  if (plan === null) {
    hosts.delete(owner)
    if (plans.delete(owner)) rebuild()
    return
  }
  if (host) hosts.set(owner, host)
  if (plans.get(owner) !== plan) {
    plans.set(owner, plan)
    rebuild()
  }
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}
/** The open page's screens. */
export const useOpenScreens = (): OpenScreen[] => useSyncExternalStore(subscribe, () => snapshot, () => snapshot)

/** A part's key on the stage: its screen and order, in the shape the stage takes ids in. */
export const partKey = (screen: string, order: number): string => `p_${screen.replace(/[^A-Za-z0-9_-]/g, '-')}_${order}`

/** The parts of the open page the stage may arrange: every drawn part but an island, which is the page's own component
 *  with its own state (one holding an iframe reloads when its node moves), so it stays with its page. */
export function pageParts(screens: OpenScreen[]): { key: string; part: DrawnPart; screen: OpenScreen }[] {
  return screens.flatMap((s) => s.plan.parts.filter((p) => p.block && p.block !== 'island').map((part) => ({ key: partKey(s.plan.screen, part.order), part, screen: s })))
}
