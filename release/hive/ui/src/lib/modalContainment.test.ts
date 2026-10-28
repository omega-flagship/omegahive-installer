import { describe, expect, it } from 'vitest'
import { LayerStack, outsideOf, planInert, tabStep, type TreeNode } from './modalContainment'

describe('tabStep: Tab never leaves the dialog', () => {
  it('cycles forward and backward through the controls, wrapping at both ends', () => {
    expect(tabStep(3, { kind: 'at', index: 0 }, false)).toBe(1)
    expect(tabStep(3, { kind: 'at', index: 2 }, false)).toBe(0)
    expect(tabStep(3, { kind: 'at', index: 0 }, true)).toBe(2)
    expect(tabStep(3, { kind: 'at', index: 1 }, true)).toBe(0)
  })
  it('Review B1: Shift-Tab as the first key from the initially focused heading goes to the last control, not out', () => {
    // heading sits before every control
    expect(tabStep(4, { kind: 'between', before: 0 }, true)).toBe(3)
    expect(tabStep(4, { kind: 'between', before: 0 }, false)).toBe(0)
  })
  it('from a non-tabbable point in the middle, steps to the neighbouring controls', () => {
    expect(tabStep(4, { kind: 'between', before: 2 }, false)).toBe(2)
    expect(tabStep(4, { kind: 'between', before: 2 }, true)).toBe(1)
    expect(tabStep(4, { kind: 'between', before: 4 }, false)).toBe(0)
    expect(tabStep(4, { kind: 'between', before: 4 }, true)).toBe(3)
  })
  it('from outside (or nowhere), enters at the first or last control', () => {
    expect(tabStep(2, { kind: 'outside' }, false)).toBe(0)
    expect(tabStep(2, { kind: 'outside' }, true)).toBe(1)
  })
  it('a single control keeps focus on itself both ways', () => {
    expect(tabStep(1, { kind: 'at', index: 0 }, false)).toBe(0)
    expect(tabStep(1, { kind: 'at', index: 0 }, true)).toBe(0)
    expect(tabStep(1, { kind: 'between', before: 0 }, true)).toBe(0)
  })
  it('no control (loading, empty, error): null, so focus stays on the dialog', () => {
    for (const from of [{ kind: 'outside' as const }, { kind: 'between' as const, before: 0 }, { kind: 'at' as const, index: 0 }]) {
      expect(tabStep(0, from, false)).toBeNull()
      expect(tabStep(0, from, true)).toBeNull()
    }
  })
  it('never returns an index out of range, even for stale positions', () => {
    for (let count = 1; count < 6; count++)
      for (let i = -2; i < count + 3; i++)
        for (const back of [false, true]) {
          for (const from of [{ kind: 'at' as const, index: i }, { kind: 'between' as const, before: i }]) {
            const to = tabStep(count, from, back)
            expect(to).not.toBeNull()
            expect(to!).toBeGreaterThanOrEqual(0)
            expect(to!).toBeLessThan(count)
          }
        }
  })
})

// a tiny tree: body > [root > [nav, main > [bg, dialogInPlace]], portal > dialog, toast]
interface N extends TreeNode {
  name: string
  parentElement: N | null
  children: N[]
}
function tree() {
  const mk = (name: string, children: N[] = []): N => {
    const n: N = { name, parentElement: null, children }
    for (const c of children) c.parentElement = n
    return n
  }
  const dialogInPlace = mk('dialogInPlace', [mk('heading'), mk('button')])
  const main = mk('main', [mk('bg'), dialogInPlace])
  const root = mk('root', [mk('nav'), main])
  const dialog = mk('dialog', [mk('confirm')])
  const portal = mk('portal', [dialog])
  const scrim = mk('scrim')
  const body = mk('body', [root, portal, mk('toast'), scrim])
  const by = (n: N, name: string): N | undefined => (n.name === name ? n : n.children.map((c) => by(c, name)).find(Boolean))
  return { body, get: (name: string) => by(body, name)! }
}
const names = (ns: N[]) => ns.map((n) => n.name).sort()

describe('outsideOf: what becomes inert', () => {
  it('a portaled dialog: every other body child', () => {
    const t = tree()
    expect(names(outsideOf([t.get('dialog')], t.body))).toEqual(['root', 'scrim', 'toast'])
  })
  it('a dialog rendered in place (not portaled): the siblings along its whole path, never its ancestors', () => {
    const t = tree()
    expect(names(outsideOf([t.get('dialogInPlace')], t.body))).toEqual(['bg', 'nav', 'portal', 'scrim', 'toast'])
  })
  it('a backdrop that is the dialog’s sibling stays live when kept with it', () => {
    const t = tree()
    expect(names(outsideOf([t.get('dialog'), t.get('scrim')], t.body))).toEqual(['root', 'toast'])
  })
  it('a kept app layer (the tour) deep in the app keeps its path live', () => {
    const t = tree()
    expect(names(outsideOf([t.get('dialog'), t.get('nav')], t.body))).toEqual(['main', 'scrim', 'toast'])
  })
  it('never inerts anything inside the dialog, and ignores nodes that are not under root', () => {
    const t = tree()
    const out = outsideOf([t.get('dialog'), { name: 'detached', parentElement: null, children: [] } as N], t.body)
    expect(out.some((n) => n.name === 'confirm')).toBe(false)
    expect(names(out)).toEqual(['root', 'scrim', 'toast'])
  })
})

describe('planInert: exact restore', () => {
  it('only nodes it made inert are ever given back; already-inert nodes are untouched', () => {
    const inert = new Set(['toast'])
    const saved = new Set<string>()
    const p1 = planInert(saved, ['root', 'toast', 'scrim'], (k) => inert.has(k))
    expect(p1.set.sort()).toEqual(['root', 'scrim'])
    expect(p1.release).toEqual([])
    for (const k of p1.set) saved.add(k)
    // closing: nothing wanted any more
    const p2 = planInert(saved, [], (k) => inert.has(k) || saved.has(k))
    expect(p2.release.sort()).toEqual(['root', 'scrim'])
    expect(p2.set).toEqual([])
    expect(p2.release).not.toContain('toast')
  })
  it('stacking: a dialog over a dialog moves the inert set; closing the top gives back exactly the lower set', () => {
    const t = tree()
    const saved = new Set<N>()
    const apply = (want: N[]) => {
      const p = planInert(saved, want, () => false)
      for (const k of p.release) saved.delete(k)
      for (const k of p.set) saved.add(k)
    }
    apply(outsideOf([t.get('dialogInPlace')], t.body))
    const lower = names([...saved])
    apply(outsideOf([t.get('dialog')], t.body)) // a decision opened from the in-place dialog, portaled
    expect(names([...saved])).toEqual(['root', 'scrim', 'toast'])
    apply(outsideOf([t.get('dialogInPlace')], t.body)) // the top one closes
    expect(names([...saved])).toEqual(lower)
    apply([])
    expect(saved.size).toBe(0)
  })
})

describe('LayerStack: only the newest layer is live', () => {
  it('push, top, and removal in any order', () => {
    const s = new LayerStack<string>()
    const a = s.push('a')
    const b = s.push('b')
    expect(s.top()).toBe('b')
    expect(s.isTop(b)).toBe(true)
    expect(s.remove(a)).toBe(false) // a lower layer closing does not change the live one
    expect(s.top()).toBe('b')
    expect(s.remove(b)).toBe(true)
    expect(s.top()).toBeUndefined()
    expect(s.remove(b)).toBe(false)
    expect(s.size).toBe(0)
  })
})
