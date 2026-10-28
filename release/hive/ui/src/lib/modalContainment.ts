/**
 * Pure logic for modal containment (ui/useModalContainment): where Tab goes, which background nodes become inert,
 * and how inert state is saved and restored exactly. No DOM access here, so it is testable in node.
 */

/** Where focus is relative to the dialog's ordered tabbable controls. */
export type TabFrom =
  /** On tabbable control `index`. */
  | { kind: 'at'; index: number }
  /** Inside the dialog but not on a tabbable control (a tabIndex=-1 heading, the dialog itself): `before` tabbables precede it. */
  | { kind: 'between'; before: number }
  /** Outside the dialog, or nowhere (document.body). */
  | { kind: 'outside' }

/**
 * The tabbable index Tab (or Shift-Tab) moves to, wrapping at both ends; null when the dialog has nothing tabbable
 * (focus then stays in, or moves to, the dialog itself). Never returns an index outside [0, count).
 */
export function tabStep(count: number, from: TabFrom, backward: boolean): number | null {
  if (count <= 0) return null
  switch (from.kind) {
    case 'at': {
      const i = Math.min(Math.max(from.index, 0), count - 1)
      return backward ? (i - 1 + count) % count : (i + 1) % count
    }
    case 'between': {
      const b = Math.min(Math.max(from.before, 0), count)
      if (backward) return b - 1 >= 0 ? b - 1 : count - 1
      return b < count ? b : 0
    }
    case 'outside':
      return backward ? count - 1 : 0
  }
}

/** The minimal tree shape outsideOf needs (an Element satisfies it). */
export interface TreeNode {
  readonly parentElement: TreeNode | null
  readonly children: ArrayLike<TreeNode>
}

/**
 * Every node that must become inert so that only `keep` (the dialog and anything it names as part of its layer) stays
 * live under `root` (document.body): the siblings of each node on the path from each kept node up to root. Ancestors of
 * kept nodes stay live (they contain the dialog); nothing inside a kept node is touched. Kept nodes not under root are
 * ignored. Works for portaled dialogs (a body child) and in-place ones (deep in the app) alike.
 */
export function outsideOf<N extends TreeNode>(keep: readonly N[], root: N): N[] {
  const path = new Set<TreeNode>()
  const chains: TreeNode[][] = []
  for (const k of keep) {
    const chain: TreeNode[] = []
    let n: TreeNode | null = k
    while (n && n !== root) {
      chain.push(n)
      n = n.parentElement
    }
    if (n !== root) continue // not under root
    chains.push(chain)
    for (const c of chain) path.add(c)
  }
  const out: N[] = []
  const seen = new Set<TreeNode>()
  for (const chain of chains) {
    for (const node of chain) {
      const parent = node.parentElement
      if (!parent) continue
      for (let i = 0; i < parent.children.length; i++) {
        const s = parent.children[i]
        if (path.has(s) || seen.has(s)) continue
        seen.add(s)
        out.push(s as N)
      }
    }
  }
  return out
}

/**
 * Saving and restoring inert state exactly. `saved` holds every node this module made inert (it was not inert
 * before). planInert says which nodes to make inert now and which to give back: a node that was already inert is
 * never recorded and so never "restored" to anything; a node we made inert goes back to not inert once no live layer
 * wants it.
 */
export function planInert<K>(saved: Set<K>, want: Iterable<K>, isInert: (k: K) => boolean): { set: K[]; release: K[] } {
  const wanted = new Set(want)
  const release: K[] = []
  for (const k of saved) if (!wanted.has(k)) release.push(k)
  const set: K[] = []
  for (const k of wanted) if (!saved.has(k) && !isInert(k)) set.push(k)
  return { set, release }
}

/** Open modal layers, newest last. Only the top layer is live; removing it makes the one below live again. */
export class LayerStack<T> {
  private items: { id: number; layer: T }[] = []
  private seq = 0
  push(layer: T): number {
    const id = ++this.seq
    this.items.push({ id, layer })
    return id
  }
  /** Removes a layer wherever it is; returns whether it was the top one. */
  remove(id: number): boolean {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return false
    const wasTop = i === this.items.length - 1
    this.items.splice(i, 1)
    return wasTop
  }
  top(): T | undefined {
    return this.items[this.items.length - 1]?.layer
  }
  has(match: (layer: T) => boolean): boolean {
    return this.items.some((x) => match(x.layer))
  }
  isTop(id: number): boolean {
    return this.items[this.items.length - 1]?.id === id
  }
  get size(): number {
    return this.items.length
  }
}
