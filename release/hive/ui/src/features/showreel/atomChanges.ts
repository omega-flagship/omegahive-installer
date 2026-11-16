/** What a step wrote: each atom after it, new, changed (its text or truth value) or the same. */
import type { TraceAtom } from './types'

export type Change = 'new' | 'changed' | 'same'

export function changes(before: TraceAtom[], after: TraceAtom[]): Record<string, Change> {
  const was = new Map(before.map((a) => [a.id, a]))
  const out: Record<string, Change> = {}
  for (const a of after) {
    const b = was.get(a.id)
    out[a.id] = !b ? 'new' : b.text !== a.text || String(b.stv) !== String(a.stv) ? 'changed' : 'same'
  }
  return out
}
