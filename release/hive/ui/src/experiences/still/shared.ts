import { useEffect, useMemo, useState } from 'react'
import { askFlags, hsl, readAskFlags, shown, useHive, useReducedMotion, type Agent } from '../sdk'
import type { Named, World } from './intent'

/** Ink tone of a mind's identity colour: muted enough to sit on paper. */
export const inkOf = (hue: number) => hsl(hue, 46, 40)

export const isAwake = (a: Pick<Agent, 'status'>) => a.status === 'awake' || a.status === 'starting'

/** A clock that ticks (for "3 minutes ago" and the greeting). */
export function useNow(ms = 20_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** What Still shows of a mind. Spending and activity times are left out, so usage events do not re-render prose. */
export type Lite = Pick<Agent, 'id' | 'name' | 'hue' | 'status' | 'swarm_id'> & { mayRemind: boolean; maySleep: boolean; isMine: boolean; awakeNow: boolean; personal: boolean }

const SEP = '\u0001'
const ROW = '\u0002'
/** Minds by id, stable until a name, colour, status or swarm actually changes. */
export function useMinds(): Record<string, Lite> {
  const sig = useHive((s) => {
    let out = ''
    for (const id in s.agents) {
      const a = s.agents[id]
      out += `${a.id}${SEP}${a.name}${SEP}${a.hue}${SEP}${a.status}${SEP}${a.swarm_id ?? ''}${SEP}${askFlags(a, !!(a.swarm_id && s.swarms[a.swarm_id]?.personal_of))}${ROW}`
    }
    return out
  })
  return useMemo(() => {
    const out: Record<string, Lite> = {}
    for (const row of sig.split(ROW)) {
      if (!row) continue
      const [id, name, hue, status, swarm, flags] = row.split(SEP)
      out[id] = { id, name, hue: Number(hue), status: status as Agent['status'], swarm_id: swarm || null, ...readAskFlags(flags) }
    }
    return out
  }, [sig])
}

export function useWorld(): World {
  const agents = useMinds()
  const swarms = useHive((s) => s.swarms)
  const approvals = useHive((s) => s.approvals)
  return useMemo(() => {
    const minds: Named[] = Object.values(agents)
      .map((a) => ({ id: a.id, name: shown(a.name), awake: isAwake(a), swarm: a.swarm_id ? shown(swarms[a.swarm_id]?.name) || '' : '', mayRemind: a.mayRemind, maySleep: a.maySleep, isMine: a.isMine, awakeNow: a.awakeNow, personal: a.personal }))
      .sort((a, b) => Number(b.awake) - Number(a.awake) || a.name.localeCompare(b.name))
    const sw: Named[] = Object.values(swarms).map((s) => ({ id: s.id, name: shown(s.name) })).sort((a, b) => a.name.localeCompare(b.name))
    let pending = 0
    for (const id in approvals) if (approvals[id].status === 'pending') pending++
    return { minds, swarms: sw, pending }
  }, [agents, swarms, approvals])
}

/** Motion presets: soft springs, or nothing at all when the person asks for less motion. */
export function useSprings() {
  const reduced = useReducedMotion()
  return useMemo(
    () => ({
      reduced,
      soft: reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 170, damping: 26, mass: 1 },
      snappy: reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 32 },
      gentle: reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 90, damping: 22 },
      fade: reduced ? { duration: 0 } : { duration: 0.35, ease: [0.2, 0.7, 0.2, 1] as const },
    }),
    [reduced],
  )
}
