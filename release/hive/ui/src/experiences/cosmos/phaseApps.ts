import { useMemo } from 'react'
import { hsl, shown } from '../sdk'
import { hashStr } from './layout'
import { orbitCount } from './phaseRig'
import type { Program } from '../../api/types'
import type { AwakeApps } from '../../shell/awakeApps'

export interface AwakeApp {
  id: string
  name: string
  /** the app's own accent (its identity, as the person chose to see it), else a colour from its id */
  color: string
}

/** The apps an orbit can carry: what the hive lists, enabled and without an error (pure, tested). Order as listed. */
export function orbitApps(programs: Program[] | null | undefined, colorOf: (p: Program) => string | null): AwakeApp[] {
  return (programs ?? [])
    .filter((p) => p.enabled && !p.error)
    .map((p) => ({ id: p.id, name: shown(p.name) || p.id, color: colorOf(p) ?? hsl(hashStr(p.id) % 360, 80, 66) }))
}

/**
 * The awake orbit's apps, from the shell's one list (Ask-and-apps contract R1.1 §3: GET /api/me/apps, only what this
 * person can open, identity-bound in shell/awakeApps). Cosmos only colours and fits them: `shown` is what the orbit
 * carries at this width, `total` every app the person can open, `loaded` false until the hive has answered. The
 * colour is the app's own identity accent from the catalogue when the person can see it there, else one from its id.
 */
export function useOrbitApps(apps: AwakeApps, width: number): { shown: (AwakeApp & { open(): boolean })[]; total: number; loaded: boolean; openAll(): void } {
  const n = orbitCount(width)
  const all = apps.shown
  const key = all.slice(0, n).map((a) => `${a.id}\u0000${a.name}\u0000${a.identityColour}`).join('\u0001')
  // stable while the same apps (ids, names and colours) are shown: a rename shows at once
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shownApps = useMemo(() => all.slice(0, n).map((a) => ({ id: a.id, name: shown(a.name) || a.id, color: a.identityColour, open: () => a.open() })), [key])
  return { shown: shownApps, total: all.length + apps.more, loaded: apps.loaded, openAll: apps.openAll }
}
