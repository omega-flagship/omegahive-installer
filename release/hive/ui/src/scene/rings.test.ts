import { describe, expect, it } from 'vitest'
import { CLOUD_HIVE, packCircles, PLACEHOLDER_R, slotRadius, universeLayout, type UniverseSwarm } from './rings'

/** The universe-of-galaxies layout (PLAN_HIVE_VIEW_SCALING r2 §2, §6 test 2). INVENTED ids only. */

/** n swarms over `people` hives (plus the cloud), sizes skewed, deterministic. */
function hive(n: number, people: number): UniverseSwarm[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s_${i}`, members: 1 + ((i * 7919) % 13), hive: i % 5 === 0 ? CLOUD_HIVE : `hive:user:p_${i % people}` }))
}

function overlaps(places: { x: number; y: number; r: number }[]): number {
  let n = 0
  for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) if (Math.hypot(places[i].x - places[j].x, places[i].y - places[j].y) < places[i].r + places[j].r - 1e-6) n++
  return n
}

describe('packing', () => {
  it('the same input gives the same places', () => {
    const a = universeLayout({ swarms: hive(150, 40) })
    const b = universeLayout({ swarms: hive(150, 40) })
    expect(JSON.stringify([...a.places], null, 0)).toBe(JSON.stringify([...b.places], null, 0))
    expect(a.galaxies).toEqual(b.galaxies)
  })

  for (const [n, people] of [[32, 15], [150, 40], [1000, 250], [3000, 600]] as const) {
    it(`no two swarms overlap, and no two galaxies overlap, at ${n} swarms`, () => {
      const u = universeLayout({ swarms: hive(n, people) })
      expect(u.places.size).toBe(n)
      expect(overlaps([...u.places.values()])).toBe(0)
      expect(overlaps(u.galaxies)).toBe(0)
      // every swarm sits inside its own galaxy's outline
      for (const s of hive(n, people)) {
        const p = u.places.get(s.id)!
        const g = u.galaxies.find((x) => x.id === s.hive)!
        expect(Math.hypot(p.x - g.x, p.y - g.y) + p.r).toBeLessThanOrEqual(g.r + 1e-6)
      }
    })
  }

  it('packCircles keeps clear of fixed circles', () => {
    const fixed = [{ id: 'f', x: 0, y: 0, r: 200 }]
    const out = packCircles(Array.from({ length: 20 }, (_, i) => ({ id: String(i), r: 50 })), fixed)
    expect(overlaps([...fixed, ...out.places])).toBe(0)
  })
})

describe('galaxies', () => {
  it('the cloud hive is in the middle; swarms owned by no named person are in it', () => {
    const u = universeLayout({ swarms: hive(40, 8) })
    const cloud = u.galaxies.find((g) => g.cloud)!
    expect(cloud.id).toBe(CLOUD_HIVE)
    expect(Math.hypot(cloud.x, cloud.y)).toBe(0)
    expect(cloud.swarms).toBe(hive(40, 8).filter((s) => s.hive === CLOUD_HIVE).length)
  })

  it('the reserved centre slot (the viewer’s own mind) is at its galaxy’s centre', () => {
    const u = universeLayout({ swarms: hive(40, 8), centre: { hive: 'hive:user:p_3', minds: 1 } })
    const g = u.galaxies.find((x) => x.id === 'hive:user:p_3')!
    expect(u.centre).toEqual({ x: g.x, y: g.y, hive: g.id })
  })

  it('a person with only their own mind still has a galaxy (the centre slot)', () => {
    const u = universeLayout({ swarms: hive(10, 2), centre: { hive: 'hive:user:p_new', minds: 1 } })
    expect(u.galaxies.some((g) => g.id === 'hive:user:p_new')).toBe(true)
  })

  it('without a centre slot the biggest swarm is the galaxy’s centre', () => {
    const swarms = [{ id: 's_a', members: 2, hive: 'hive:user:p_x' }, { id: 's_b', members: 9, hive: 'hive:user:p_x' }]
    const u = universeLayout({ swarms })
    const g = u.galaxies[0]
    expect(u.places.get('s_b')).toMatchObject({ x: g.x, y: g.y, r: slotRadius(9) })
  })

  it('a pinned galaxy stays where the person put it; the others pack around it without overlap', () => {
    const swarms = hive(60, 12)
    const free = universeLayout({ swarms })
    const target = free.galaxies[3].id
    const u = universeLayout({ swarms, pinned: { [target]: { x: 5000, y: -3000 } } })
    const g = u.galaxies.find((x) => x.id === target)!
    expect([g.x, g.y, g.pinned]).toEqual([5000, -3000, true])
    expect(overlaps(u.galaxies)).toBe(0)
  })

  it('pins for hives that are not on the map are ignored (they change nothing)', () => {
    const swarms = hive(60, 12)
    const a = universeLayout({ swarms })
    const b = universeLayout({ swarms, pinned: { 'hive:user:p_gone': { x: 1, y: 1 } } })
    expect(JSON.stringify({ g: b.galaxies, p: [...b.places], c: b.centre })).toBe(JSON.stringify({ g: a.galaxies, p: [...a.places], c: a.centre }))
  })
})

describe('placeholders (§4 P-2)', () => {
  it('are placed after every galaxy and move none of them; each has a fixed size; the cluster is outside every galaxy', () => {
    const swarms = hive(60, 12)
    const without = universeLayout({ swarms })
    for (const n of [1, 3, 17]) {
      const u = universeLayout({ swarms, placeholders: n })
      expect(JSON.stringify(u.galaxies)).toBe(JSON.stringify(without.galaxies))
      expect(JSON.stringify([...u.places])).toBe(JSON.stringify([...without.places]))
      const pc = u.privateCluster!
      expect(pc.slots).toHaveLength(n)
      for (const g of u.galaxies) expect(Math.hypot(pc.x - g.x, pc.y - g.y)).toBeGreaterThan(pc.r + g.r)
      for (let i = 0; i < pc.slots.length; i++) for (let j = i + 1; j < pc.slots.length; j++) expect(Math.hypot(pc.slots[i].x - pc.slots[j].x, pc.slots[i].y - pc.slots[j].y)).toBeGreaterThanOrEqual(2 * PLACEHOLDER_R)
    }
    expect(without.privateCluster).toBeNull()
  })
})
