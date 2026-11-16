import { describe, expect, it } from 'vitest'
import { contractFixture } from '../../api/sim/programs'
import { SimClient } from '../../api/sim/SimClient'
import type { WorkGraph } from '../../api/types'
import { classifyUnfold, groupsForChosen, indexGraph, layoutStage } from './layout'

const sim = new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1 })
const swarm = [...sim.swarms.keys()][0]
const describe0 = contractFixture().describe()
const load = () => sim.programView('contract-fixture', { swarm_id: swarm }) as Promise<WorkGraph>

describe('stage layouts', () => {
  it('unfold: supporting on one side, opposing on the other, qualifying above', async () => {
    const g = await load()
    const gi = indexGraph(g, describe0)
    const c = classifyUnfold(gi, 'c1')
    expect(c.get('e1')).toMatchObject({ depth: 1, side: 'left' })
    expect(c.get('e3')).toMatchObject({ depth: 1, side: 'right' })
    expect(c.get('a1')).toMatchObject({ depth: 1, side: 'top' })
    expect(c.get('g1')).toMatchObject({ depth: 2, side: 'top' })
    const L = layoutStage({ graph: g, describe: describe0, step: { stage: 'unfold', focus: 'c1' }, trail: [], width: 1100, height: 700 }, gi)
    const at = Object.fromEntries(L.nodes.map((n) => [n.id, n]))
    expect(at.e1.x).toBeLessThan(at.c1.x)
    expect(at.e3.x).toBeGreaterThan(at.c1.x)
    expect(at.a1.y).toBeLessThan(at.c1.y)
    expect(at.c1.tier).toBe('focus')
  })

  it('is deterministic and has no overlapping boxes', async () => {
    const g = await load()
    const gi = indexGraph(g, describe0)
    for (const stage of ['unfold', 'map', 'compare'] as const) {
      for (const width of [390, 1100]) {
        const input = { graph: g, describe: describe0, step: { stage, focus: 'q1' }, trail: [], width, height: 700 }
        const a = layoutStage(input, gi)
        const b = layoutStage(input, indexGraph(structuredClone(g), describe0))
        expect(a.nodes).toEqual(b.nodes)
        for (let i = 0; i < a.nodes.length; i++)
          for (let j = i + 1; j < a.nodes.length; j++) {
            const p = a.nodes[i]
            const q = a.nodes[j]
            const hit = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
            expect(hit, `${stage}@${width}: ${p.key} overlaps ${q.key}`).toBe(false)
          }
      }
    }
  })

  it('compare: conflict on opposing sides, overlapping groups shown twice as the same item, gaps as slots', async () => {
    const g = await load()
    const gi = indexGraph(g, describe0)
    const L = layoutStage({ graph: g, describe: describe0, step: { stage: 'compare', focus: 'q1' }, trail: [], width: 1200, height: 700 }, gi)
    const first = (id: string) => L.nodes.find((n) => n.key === id)!
    expect(Math.sign(first('e3').x - first('h1').x)).toBe(0) // same column
    expect(first('c1').x < first('h1').x || first('c1').x > first('h1').x).toBe(true)
    const dups = L.nodes.filter((n) => n.dupOf)
    expect(dups.map((n) => n.id).sort()).toEqual(['e1', 'e2'])
    expect(L.same).toHaveLength(2)
    expect(L.nodes.find((n) => n.id === 'g1')?.slot).toBe(true)
    expect(L.lanes.some((l) => l.tone === 'conflict')).toBe(true)
  })

  it('compare of chosen items groups each with its support, and opposition with the rival', async () => {
    const g = await load()
    const gi = indexGraph(g, describe0)
    const groups = groupsForChosen(gi, ['c1', 'h1'])
    expect(groups.find((x) => x.id === 'sel:c1')?.items).toEqual(expect.arrayContaining(['c1', 'e1', 'e2', 'a1']))
    expect(groups.find((x) => x.id === 'sel:h1')?.items).toEqual(['h1', 'e3'])
    expect(groups.some((x) => x.id === 'against:c1')).toBe(false) // e3 already stands with h1
    expect(groups.find((x) => x.id === 'gaps')?.items).toEqual(['g1'])
  })

  it('map: grows from the followed item and keeps earlier context, positions stable across focus', async () => {
    const g = await load()
    const gi = indexGraph(g, describe0)
    const a = layoutStage({ graph: g, describe: describe0, step: { stage: 'map', focus: 'c1' }, trail: [{ stage: 'map', focus: 'c1' }], width: 1100, height: 700 }, gi)
    const b = layoutStage({ graph: g, describe: describe0, step: { stage: 'map', focus: 'e3' }, trail: [{ stage: 'map', focus: 'c1' }, { stage: 'map', focus: 'e3' }], width: 1100, height: 700 }, gi)
    const pa = Object.fromEntries(a.nodes.map((n) => [n.id, n]))
    const pb = Object.fromEntries(b.nodes.map((n) => [n.id, n]))
    expect(pb.e3.tier).toBe('focus')
    expect(pb.c1.tier).not.toBe('focus')
    // one global layout: the arrangement keeps its shape as the map grows (directions are kept)
    const dir = (p: Record<string, { x: number; y: number; w: number; h: number }>, a: string, b: string) => [Math.sign(p[b].x + p[b].w / 2 - p[a].x - p[a].w / 2), Math.sign(p[b].y + p[b].h / 2 - p[a].y - p[a].h / 2)]
    expect(dir(pa, 'e3', 'h1')).toEqual(dir(pb, 'e3', 'h1'))
    expect(dir(pa, 'e3', 'c1')).toEqual(dir(pb, 'e3', 'c1'))
  })
})
