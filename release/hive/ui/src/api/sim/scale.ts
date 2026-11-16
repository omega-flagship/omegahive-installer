/**
 * SIM: a hive at scale, for demos and tests of the universe-of-galaxies map (PLAN_HIVE_VIEW_SCALING r2). Every name is
 * INVENTED. `?sim=1&simscale=…` tops the invented hive up to:
 * - `cloud`: shaped like the cloud hive on 2026-10-09: 32 swarms, 64 minds, 15 people (the biggest swarm 9 minds);
 * - `big`: 150 swarms, 500 minds, 40 people;
 * - `<swarms>x<minds>` (e.g. `150x500`): that many, with a person for every four swarms (capped: 400 / 1,500 / 80).
 * Counts include what the sim already seeds. Each person has a personal-mind swarm (`personal_of`), which the map
 * never draws (and another person's is never shown at all, even though this sim host lists it: scene/visibleSet P8),
 * and a few swarms are private to someone else, which an admin's map shows only as unattributed placeholders.
 * The first person is the sim's own Ada (`user:p_ada`), so `simrole=person` has a hive of her own.
 */
import type { Agent, Swarm } from '../types'

export interface ScaleShape {
  swarms: number
  minds: number
  people: number
  biggest: number
  /** swarms private to someone other than the sim's visitor */
  privateSwarms: number
}

export const SCALES: Readonly<Record<string, ScaleShape>> = {
  cloud: { swarms: 32, minds: 64, people: 15, biggest: 9, privateSwarms: 2 },
  big: { swarms: 150, minds: 500, people: 40, biggest: 14, privateSwarms: 4 },
}

const FIRST = ['Ari', 'Bo', 'Cass', 'Dev', 'Esme', 'Finn', 'Gale', 'Hana', 'Ivo', 'Juno', 'Kit', 'Lior', 'Mara', 'Nico', 'Oona', 'Pax', 'Quill', 'Rhea', 'Sol', 'Teo']
const LAST = ['Ashdown', 'Brackwater', 'Cindervale', 'Dunmore', 'Elderfield', 'Fernhollow', 'Glimmerton', 'Hollins', 'Ironside', 'Juniper', 'Kestrel', 'Larkspur', 'Moorcroft', 'Nettleby', 'Oakhurst', 'Pellow', 'Quarrie', 'Rookwood', 'Saltash', 'Thornbury']
const TEAM = ['Harbor', 'Lantern', 'Orchard', 'Quarry', 'Meridian', 'Saltmarsh', 'Kestrel', 'Basalt', 'Juniper', 'Tessera', 'Cinder', 'Fathom', 'Willow', 'Cobalt', 'Ember', 'Thistle', 'Granite', 'Larch', 'Nimbus', 'Pewter']
const MIND = ['Vela', 'Orrin', 'Sable', 'Tamsin', 'Wren', 'Corvid', 'Lumen', 'Piper', 'Rook', 'Sedge', 'Talon', 'Umber', 'Vesper', 'Yarrow', 'Zephyr', 'Alder']

/** The shape a page address asks for (`simscale`), or null. Unknown words and malformed sizes: null (no change). */
export function scaleFromQuery(q: URLSearchParams): ScaleShape | null {
  const v = q.get('simscale')
  if (!v) return null
  if (Object.hasOwn(SCALES, v)) return SCALES[v]
  const m = /^(\d{1,4})x(\d{1,5})$/.exec(v)
  if (!m) return null
  const swarms = Math.min(400, Math.max(1, +m[1]))
  return { swarms, minds: Math.min(1500, Math.max(1, +m[2])), people: Math.min(80, Math.max(1, Math.ceil(swarms / 4))), biggest: 12, privateSwarms: 2 }
}

/** An invented person of the scale fixture: the first is the sim's Ada. */
export function scalePerson(i: number): { id: string; name: string } {
  if (i === 0) return { id: 'p_ada', name: 'Ada Brightwater' }
  const first = FIRST[i % FIRST.length]
  const last = LAST[Math.floor(i / FIRST.length + i) % LAST.length]
  return { id: `u_sc${String(i).padStart(3, '0')}`, name: `${first} ${last}${i >= FIRST.length * LAST.length ? ` ${i}` : ''}` }
}

/** Add invented swarms and minds until the hive holds `shape`. Deterministic for a given rng. */
export function seedScale(
  shape: ScaleShape,
  hive: { swarms: Map<string, Swarm>; agents: Map<string, Agent> },
  rng: () => number,
  register: (a: Agent) => void,
  nowIso: string,
): { people: { id: string; name: string }[] } {
  const live = () => [...hive.swarms.values()].filter((s) => !s.archived_at).length
  const people = Array.from({ length: shape.people }, (_, i) => scalePerson(i))
  const who = (p: number) => `user:${people[p].id}`
  let n = 0
  const mind = (swarm: Swarm, extra: Partial<Agent> = {}): Agent => {
    const id = `a_sc${String(n).padStart(4, '0')}`
    const a: Agent = {
      id,
      name: `${MIND[n % MIND.length]}${n >= MIND.length ? `-${Math.floor(n / MIND.length) + 1}` : ''}`,
      kind: n % 5 === 0 ? 'iter' : 'omega',
      swarm_id: swarm.id,
      model: 'anthropic/claude-haiku-5',
      persona: 'An invented mind for scale tests.',
      hue: Math.floor(rng() * 360),
      status: rng() < 0.6 ? 'awake' : 'asleep',
      driver: 'local',
      budget_usd: 5,
      spent_usd: 0,
      connected: true,
      last_active_at: null,
      created_at: nowIso,
      idle_sleep_minutes: 0,
      ...extra,
    }
    n++
    swarm.member_ids.push(a.id)
    register(a)
    return a
  }
  const swarm = (id: string, name: string, extra: Partial<Swarm>): Swarm => {
    const s: Swarm = { id, name, description: 'Invented for scale tests.', hue: Math.floor(rng() * 360), member_ids: [], created_at: nowIso, ...extra }
    hive.swarms.set(id, s)
    return s
  }
  // 1. a personal-mind swarm per person: one asleep mind, private to that person
  for (let p = 0; p < people.length; p++) {
    const s = swarm(`s_pm${p}`, people[p].name.split(' ')[0], { owner: who(p), visibility: 'private', personal_of: who(p) })
    mind(s, { name: people[p].name.split(' ')[0], status: 'asleep', owner: who(p), visibility: 'private', personal_of: who(p) })
  }
  // 2. swarms private to someone other than the sim's visitor (never the first person, Ada)
  for (let h = 0; h < shape.privateSwarms && people.length > 1; h++) {
    const p = 1 + (h % (people.length - 1))
    mind(swarm(`s_priv${h}`, `Private ${h + 1}`, { owner: who(p), visibility: 'private' }))
  }
  // 3. team swarms up to the total: owned by a person (most), or by no one (the cloud hive's)
  const added: Swarm[] = []
  let t = 0
  while (live() < shape.swarms) {
    const r = rng()
    const owner = r < 0.2 ? null : who(Math.floor(rng() * people.length))
    const name = `${TEAM[t % TEAM.length]}${t >= TEAM.length ? ` ${Math.floor(t / TEAM.length) + 1}` : ''}`
    added.push(swarm(`s_tm${t}`, name, { ...(owner ? { owner } : {}), visibility: rng() < 0.75 ? 'public' : 'shared' }))
    t++
  }
  // 4. minds, skewed so early swarms fill first (Zipf-ish), one swarm holding `biggest`
  if (added.length) {
    const big = added[0]
    while (big.member_ids.length < shape.biggest && hive.agents.size < shape.minds) mind(big)
    let i = 0
    while (hive.agents.size < shape.minds && i++ < 50_000) {
      const s = added[Math.min(added.length - 1, Math.floor(rng() ** 1.6 * added.length))]
      if (s.member_ids.length < shape.biggest - 1 || added.every((x) => x.member_ids.length >= shape.biggest - 1)) mind(s)
    }
  }
  return { people }
}
