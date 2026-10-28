/**
 * Search, in place. When the field does not understand what was typed, Still looks for exactly that text across
 * minds, swarms, goals and what the hive learned, and lists what it found under the field, keeping the words.
 * (The shared command palette is offered too, but it cannot be opened with a query from an experience.)
 */
import type { Belief, Goal } from '../sdk'
import type { Named } from './intent'
import { beliefSentence } from './language'

export type FoundKind = 'mind' | 'swarm' | 'goal' | 'belief'

export interface Found {
  kind: FoundKind
  /** mind/swarm/goal id; for a belief, its swarm id */
  id: string
  title: string
  /** Where it lives: the swarm, or "mind, awake". */
  sub: string
  /** beliefs only */
  statement?: string
}

export interface Searchable {
  minds: Named[]
  swarms: Named[]
  goals: Record<string, Pick<Goal, 'id' | 'swarm_id' | 'title' | 'detail' | 'status' | 'updated_at'>>
  beliefs: Record<string, Record<string, Pick<Belief, 'swarm_id' | 'statement' | 'tv' | 'updated_at'>>>
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase()
const words = (q: string) => fold(q).split(/[^\p{L}\p{N}#_-]+/u).filter((w) => w.length > 1 || /\p{N}/u.test(w))

/** Every word of the query must appear; things whose title starts with the query rank first. */
function score(q: string, ws: string[], title: string, extra = ''): number {
  const t = fold(title)
  const hay = `${t} ${fold(extra)}`
  if (!ws.length || !ws.every((w) => hay.includes(w))) return 0
  const fq = fold(q.trim())
  return t === fq ? 4 : t.startsWith(fq) ? 3 : ws.every((w) => t.includes(w)) ? 2 : 1
}

export function searchHive(query: string, d: Searchable, most = 12): Found[] {
  const ws = words(query)
  if (!ws.length) return []
  const out: (Found & { s: number; o: number })[] = []
  const swarmName = (id: string | null | undefined) => d.swarms.find((s) => s.id === id)?.name ?? ''
  for (const m of d.minds) {
    const s = score(query, ws, m.name, `${m.swarm ?? ''} ${m.id}`)
    if (s) out.push({ kind: 'mind', id: m.id, title: m.name, sub: `mind${m.swarm ? ` in ${m.swarm}` : ''}, ${m.awake ? 'awake' : 'asleep'}`, s, o: 0 })
  }
  for (const x of d.swarms) {
    const s = score(query, ws, x.name, x.id)
    if (s) out.push({ kind: 'swarm', id: x.id, title: x.name, sub: 'swarm', s, o: 1 })
  }
  for (const g of Object.values(d.goals)) {
    const s = score(query, ws, g.title, g.detail)
    if (s) out.push({ kind: 'goal', id: g.id, title: g.title, sub: `task for ${swarmName(g.swarm_id) || 'a swarm'}, ${g.status}`, s, o: 2 })
  }
  for (const sid in d.beliefs) {
    for (const st in d.beliefs[sid]) {
      const b = d.beliefs[sid][st]
      const said = beliefSentence(b, false)
      const s = score(query, ws, said, b.statement)
      if (s) out.push({ kind: 'belief', id: sid, title: said, sub: `learned in ${swarmName(sid) || 'a swarm'}`, statement: b.statement, s, o: 3 })
    }
  }
  return out
    .sort((a, b) => b.s - a.s || a.o - b.o || a.title.localeCompare(b.title))
    .slice(0, most)
    .map(({ s: _s, o: _o, ...f }) => f)
}
