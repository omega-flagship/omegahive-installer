import type { WorkSource } from '../../api/types'
import type { GraphIndex } from './layout'

export interface SourceUse {
  /** One source row (deduplicated: the same source cited by two items is one row). */
  source: WorkSource
  /** The items that cite it; `via` names the subject item it was reached from, when not the subject itself. */
  citedBy: { id: string; via?: string; rel?: string }[]
}

export interface OriginGroup {
  /** The shared origin, or null when the program gave none (then each source stands alone). */
  origin: string | null
  uses: SourceUse[]
  /** Two or more distinct sources share this origin: they are not independent. */
  shared: boolean
}

/**
 * The sources behind the subject items: their own, then those of the items directly linked to them
 * (the evidence a claim rests on), grouped by origin.
 */
export function collectSources(gi: GraphIndex, subjects: string[]): { own: number; via: number; groups: OriginGroup[] } {
  const uses = new Map<string, SourceUse>()
  const keyOf = (s: WorkSource) => `${s.id}\u0000${s.origin ?? ''}\u0000${s.url ?? s.local_ref ?? ''}`
  let own = 0
  let via = 0
  const add = (s: WorkSource, cite: SourceUse['citedBy'][number]) => {
    const k = keyOf(s)
    const u = uses.get(k)
    if (!u) uses.set(k, { source: s, citedBy: [cite] })
    else if (!u.citedBy.some((c) => c.id === cite.id)) u.citedBy.push(cite)
  }
  const subjectSet = new Set(subjects)
  for (const id of subjects) {
    const it = gi.items.get(id)
    if (!it) continue
    for (const s of it.sources ?? []) {
      own++
      add(s, { id })
    }
  }
  for (const id of subjects) {
    for (const e of gi.adj.get(id) ?? []) {
      if (subjectSet.has(e.other)) continue
      const other = gi.items.get(e.other)!
      for (const s of other.sources ?? []) {
        via++
        add(s, { id: e.other, via: id, rel: e.link.rel })
      }
    }
  }
  const byOrigin = new Map<string, SourceUse[]>()
  for (const u of uses.values()) {
    const k = u.source.origin ? `o:${u.source.origin}` : `n:${keyOf(u.source)}`
    byOrigin.set(k, [...(byOrigin.get(k) ?? []), u])
  }
  const groups: OriginGroup[] = [...byOrigin.entries()].map(([k, list]) => {
    const distinct = new Set(list.map((u) => u.source.id)).size
    return { origin: k.startsWith('o:') ? k.slice(2) : null, uses: list, shared: k.startsWith('o:') && distinct >= 2 }
  })
  groups.sort((a, b) => Number(b.shared) - Number(a.shared) || b.uses.length - a.uses.length)
  return { own, via, groups }
}
