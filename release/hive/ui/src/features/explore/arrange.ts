import type { ExploreArrangement, ExploreNode } from '../../api/types'

/**
 * A person's arrangement of what the explorer shows: their order within each group, pins and collapsed groups.
 * It never changes the real structure; it is only how they like to see it. Pure, so it is testable.
 */

/** Apply a saved order: ids in the order first (as saved), then anything new, keeping the server's order. */
export function ordered<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order?.length) return items
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

/** Move one id within a group's order (by drag target or by one step), returning the new order for that group. */
export function moved(current: string[], id: string, to: number): string[] {
  const without = current.filter((x) => x !== id)
  const at = Math.max(0, Math.min(without.length, to))
  return [...without.slice(0, at), id, ...without.slice(at)]
}

export function toggled(list: string[] | undefined, id: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return [...set]
}

/** Pinned items first (in pin order), then the rest. */
export function pinnedFirst(items: ExploreNode[], pinned: string[] | undefined): { pinned: ExploreNode[]; rest: ExploreNode[] } {
  const pins = pinned ?? []
  const set = new Set(pins)
  return { pinned: ordered(items.filter((i) => set.has(i.id)), pins), rest: items.filter((i) => !set.has(i.id)) }
}

/** Holarchy: nest each item under its parent when both are present (a swarm's minds under it, a sub-swarm under its parent). */
export function nested(items: ExploreNode[]): { node: ExploreNode; depth: number }[] {
  const ids = new Set(items.map((i) => i.id))
  const children = new Map<string, ExploreNode[]>()
  const roots: ExploreNode[] = []
  for (const i of items) {
    if (i.parent && ids.has(i.parent) && i.parent !== i.id) children.set(i.parent, [...(children.get(i.parent) ?? []), i])
    else roots.push(i)
  }
  const out: { node: ExploreNode; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (n: ExploreNode, depth: number) => {
    if (seen.has(n.id) || depth > 8) return
    seen.add(n.id)
    out.push({ node: n, depth })
    for (const c of children.get(n.id) ?? []) walk(c, depth + 1)
  }
  roots.forEach((r) => walk(r, 0))
  return out
}

export const EMPTY_ARRANGEMENT: ExploreArrangement = { order: {}, pinned: [], collapsed: [], layout: 'list' }
