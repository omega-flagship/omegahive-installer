import type { Agent, Swarm } from '../sdk'
import { groupHelpers, type HelperGroup } from '../../scene/helperGroups'

/** Deterministic randomness: the same hive always draws the same galaxy. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export type V3 = [number, number, number]

export interface SystemLayout {
  id: string
  name: string
  hue: number
  center: V3
  members: string[]
  /** Radius of the belief belt (outside the outermost orbit). */
  belt: number
  /** Camera distance that frames the whole system. */
  frame: number
}

export interface PlanetLayout {
  id: string
  systemId: string | null
  orbit: number
  speed: number
  phase: number
  incline: number
  node: number
  size: number
  /** Wanderers: drift anchor. */
  anchor: V3
  /** A team's folded request helpers (scene/helperGroups): one small, dim world that opens to show them. */
  group?: HelperGroup
  /** A request helper's label ("Helper <n>"), never its template id. */
  label?: string
}

export interface CosmosLayout {
  systems: SystemLayout[]
  planets: PlanetLayout[]
  systemById: Record<string, SystemLayout>
  planetById: Record<string, PlanetLayout>
  /** Rough extent of the populated galaxy (for the overview camera). */
  extent: number
}

/** A folded helper group's world: smaller than any mind's. */
export const GROUP_SIZE = 0.26

export const kindSize = (a: Agent) => (a.kind === 'omega' ? 0.62 : a.kind === 'iter' ? 0.46 : 0.34)

/**
 * The galaxy's layout. Finished request helpers fold into one quiet world per team (scene/helperGroups groupHelpers,
 * the same rule the classic map draws by): `helpers.expanded` names the open groups, `helpers.reveal` a mind that must
 * stay drawn (the one open), `helpers.now` the time it is judged at.
 */
export function buildLayout(swarms: Record<string, Swarm>, all: Record<string, Agent>, helpers: { now?: number; expanded?: ReadonlySet<string>; reveal?: string | null } = {}): CosmosLayout {
  const folded = groupHelpers(Object.values(all), helpers.now ?? Date.now(), helpers)
  const agents: Record<string, Agent> = {}
  for (const a of folded.shown) agents[a.id] = a
  const groupOf = new Map(folded.groups.map((g) => [g.teamId, g]))
  const list = Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const systems: SystemLayout[] = []
  const planets: PlanetLayout[] = []
  const placed = new Set<string>()
  list.forEach((s, i) => {
    const r = 30 + 13 * Math.sqrt(i)
    const ang = i * 2.39996 + 0.7
    const rnd = seeded(hashStr(s.id))
    const center: V3 = [Math.cos(ang) * r, (rnd() - 0.5) * 6, Math.sin(ang) * r]
    const members = s.member_ids.filter((id) => agents[id]).sort((a, b) => agents[a].created_at.localeCompare(agents[b].created_at) || a.localeCompare(b))
    // minds that say they belong here but are not listed
    for (const a of Object.values(agents)) if (a.swarm_id === s.id && !members.includes(a.id)) members.push(a.id)
    let orbit = 3.1
    members.forEach((id, k) => {
      const a = agents[id]
      const prng = seeded(hashStr(id))
      const size = kindSize(a)
      orbit += k === 0 ? 0 : 1.15 + size * 1.4
      planets.push({
        id,
        systemId: s.id,
        orbit,
        speed: 0.9 / Math.pow(orbit, 1.5),
        phase: prng() * Math.PI * 2,
        incline: (prng() - 0.5) * 0.16,
        node: prng() * Math.PI * 2,
        size,
        anchor: center,
        ...(a.name !== all[id]?.name ? { label: a.name } : {}),
      })
      placed.add(id)
    })
    const g = groupOf.get(s.id)
    if (g) {
      // the folded helpers: a small world on the next orbit out, slow, never pulsing (Scene GroupWorld)
      const prng = seeded(hashStr(g.id))
      orbit += members.length ? 1.15 + GROUP_SIZE * 1.4 : 0
      planets.push({ id: g.id, systemId: s.id, orbit, speed: 0.3 / Math.pow(orbit, 1.5), phase: prng() * Math.PI * 2, incline: (prng() - 0.5) * 0.16, node: prng() * Math.PI * 2, size: GROUP_SIZE, anchor: center, group: g })
    }
    const belt = orbit + 1.9
    systems.push({ id: s.id, name: s.name, hue: s.hue, center, members, belt, frame: belt * 2.3 + 7 })
  })
  const wanderers = Object.values(agents).filter((a) => !placed.has(a.id)).sort((a, b) => a.id.localeCompare(b.id))
  wanderers.forEach((a, i) => {
    const prng = seeded(hashStr(a.id))
    const ang = i * 1.9 + 2.2 + prng() * 0.4
    const r = 46 + i * 3 + prng() * 6
    planets.push({
      id: a.id,
      systemId: null,
      orbit: 2.4 + prng() * 2,
      speed: 0.05 + prng() * 0.03,
      phase: prng() * Math.PI * 2,
      incline: 0.5,
      node: prng() * Math.PI * 2,
      size: kindSize(a),
      anchor: [Math.cos(ang) * r, 5 + (prng() - 0.5) * 10, Math.sin(ang) * r],
      ...(a.name !== all[a.id]?.name ? { label: a.name } : {}),
    })
  })
  const systemById: Record<string, SystemLayout> = {}
  for (const s of systems) systemById[s.id] = s
  const planetById: Record<string, PlanetLayout> = {}
  for (const p of planets) planetById[p.id] = p
  let extent = 30
  for (const s of systems) extent = Math.max(extent, Math.hypot(s.center[0], s.center[2]) + s.belt)
  for (const p of planets) if (!p.systemId) extent = Math.max(extent, Math.hypot(p.anchor[0], p.anchor[2]) + 3)
  return { systems, planets, systemById, planetById, extent }
}

/** Where a planet is at cosmic time t (writes into out). */
export function planetPos(p: PlanetLayout, t: number, out: { x: number; y: number; z: number }) {
  const a = p.phase + p.speed * t
  if (p.systemId) {
    const x = Math.cos(a) * p.orbit
    const z = Math.sin(a) * p.orbit
    // incline the orbit plane about its node line
    const cn = Math.cos(p.node)
    const sn = Math.sin(p.node)
    const across = -x * sn + z * cn
    out.x = p.anchor[0] + x
    out.y = p.anchor[1] + across * Math.sin(p.incline)
    out.z = p.anchor[2] + z
    return out
  }
  out.x = p.anchor[0] + Math.cos(a) * p.orbit
  out.y = p.anchor[1] + Math.sin(a * 1.7) * 0.9
  out.z = p.anchor[2] + Math.sin(a) * p.orbit * 0.6
  return out
}

/** The cosmic clock, advanced once per frame by the scene (frozen under reduced motion). */
export const cosmicClock = { t: 0, real: 0 }

export const statusWord = (a: Agent, thinking?: string) =>
  thinking === 'llm' ? 'THINKING' : thinking === 'skills' ? 'ACTING' : a.status === 'awake' ? 'AWAKE' : a.status === 'asleep' ? 'DORMANT' : a.status === 'starting' ? 'IGNITING' : a.status === 'error' ? 'FAULT' : a.status === 'stopped' ? 'OFFLINE' : 'NASCENT'

export const isLit = (a: Agent) => a.status === 'awake' || a.status === 'starting'
