import { describe, expect, it } from 'vitest'
import type { ExploreNode } from '../../api/types'
import { moved, nested, ordered, pinnedFirst, toggled } from './arrange'

const n = (id: string, parent: string | null = null) => ({ id, parent, kind: 'mind', name: id, facets: {}, detail: {} }) as unknown as ExploreNode

describe('explorer arrangement', () => {
  it('keeps a saved order and puts new things after it', () => {
    expect(ordered([n('a'), n('b'), n('c'), n('d')], ['c', 'a']).map((x) => x.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(ordered([n('a')], undefined).map((x) => x.id)).toEqual(['a'])
  })
  it('moves an item to a position (drag) or by one step', () => {
    expect(moved(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
    expect(moved(['a', 'b'], 'z', 99)).toEqual(['a', 'b', 'z'])
  })
  it('pins and collapses by toggling', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
    const { pinned, rest } = pinnedFirst([n('a'), n('b'), n('c')], ['c', 'a'])
    expect(pinned.map((x) => x.id)).toEqual(['c', 'a'])
    expect(rest.map((x) => x.id)).toEqual(['b'])
  })
  it('nests the holarchy: minds under their swarm, sub-swarms under their parent, never looping', () => {
    const out = nested([n('s1'), n('m1', 's1'), n('s2', 's1'), n('m2', 's2'), n('x', 'missing'), n('loop', 'loop')])
    expect(out.map((o) => `${o.node.id}:${o.depth}`)).toEqual(['s1:0', 'm1:1', 's2:1', 'm2:2', 'x:0', 'loop:0'])
  })
})
