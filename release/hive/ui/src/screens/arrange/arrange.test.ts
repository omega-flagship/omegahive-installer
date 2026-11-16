// Purpose: the stage's arrangement as MeTTa composes it (screens/arrange/lib_arrange.metta): showing an item, the
// other items making room or vanishing, recalling one beside it, comparing two, and a dragged split learned for the
// same kinds, with seeded random cases for the claims that must hold for every stage and every set of items.
// INVENTED items, ids and tasks.
import { describe, expect, it } from 'vitest'
import { ArrangeError, ArrangeSpace, type ArrangeItem, type ArrangeState, type Placed, type Source, type Statement } from './arrangeSpace'

const space = ArrangeSpace.open()
const photo = 'ar_photo01'
const text = 'ar_text01'
const vega = 'a_vega01'
const orion = 'a_orion01'
const tip = 'g_tip01'
const items: ArrangeItem[] = [
  { key: photo, source: 'artifact', stored: 'image' },
  { key: text, source: 'artifact', stored: 'note' },
  { key: vega, source: 'mind' },
  { key: orion, source: 'mind' },
  { key: tip, source: 'task' },
]
const MARGIN = 24
const GAP = 12

const state = (log: Statement[], over: Partial<ArrangeState> = {}): ArrangeState => ({
  stage: { w: 1440, h: 900 }, items, relates: [{ key: vega, task: tip }], interest: {}, shares: [], log, episode: log.length, ...over,
})
const show = (key: string, task: string | null = tip): Statement => ({ say: 'show', key, task })
const recall = (key: string): Statement => ({ say: 'recall', key })
const at = (placed: Placed[], key: string): Placed => {
  const p = placed.find((x) => x.key === key)
  if (!p) throw new Error(`${key} is not drawn`)
  return p
}
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6)
const overlap = (a: Placed, b: Placed) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

// A seeded generator (mulberry32), so a failing case names its seed and reruns exactly.
function random(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] }
}

describe('nothing shown', () => {
  it('draws nothing and keeps no tray', () => {
    const a = space.compose(state([]))
    expect(a).toEqual({ mode: 'home', task: null, placed: [], dividers: [], tray: [], seen: { episode: 0, keys: [] }, unknown: [] })
  })
})

describe('(Show x) puts x in the centre at its kind’s size', () => {
  it('in one composition, with the task’s related items beside it', () => {
    const a = space.compose(state([show(photo)]))
    expect(a.mode).toBe('focus')
    expect(a.task).toBe(tip)
    // an image is drawn 640 by 480, centred on a 1440 by 900 stage
    expect(at(a.placed, photo)).toEqual({ key: photo, kind: 'image', role: 'shown', x: 400, y: 210, w: 640, h: 480 })
    expect(at(a.placed, vega).role).toBe('beside')
  })

  it('gives way to a stage too small for it, keeping its aspect and never leaving the stage', () => {
    const r = random(20261115)
    for (let i = 0; i < 40; i++) {
      const w = r.int(320, 2560)
      const h = r.int(320, 1600)
      const a = space.compose(state([show(photo)], { stage: { w, h }, relates: [] }))
      const p = at(a.placed, photo)
      const seed = `stage ${w}x${h}`
      expect(p.w, seed).toBeLessThanOrEqual(640 + 1e-6)
      expect(p.x + p.w / 2, seed).toBeCloseTo(w / 2, 6)
      expect(p.y + p.h / 2, seed).toBeCloseTo(h / 2, 6)
      expect(p.w / p.h, seed).toBeCloseTo(640 / 480, 6)
      expect(p.x, seed).toBeGreaterThanOrEqual(MARGIN - 1e-6)
      expect(p.y, seed).toBeGreaterThanOrEqual(MARGIN - 1e-6)
    }
  })
})

describe('a shown item keeps its own shape once the page knows it', () => {
  const shaped = (shape: readonly [number, number]) => items.map((it) => (it.key === photo ? { ...it, shape } : it))

  it('takes its kind’s area in that shape, so a tall picture is shown tall and a wide one wide', () => {
    // a 4:3 picture is drawn at the image kind's own 640 by 480
    expect(at(space.compose(state([show(photo)], { items: shaped([4, 3]) })).placed, photo)).toEqual({ key: photo, kind: 'image', role: 'shown', x: 400, y: 210, w: 640, h: 480 })
    for (const [w, h] of [[1920, 1080], [3, 4], [1000, 1000]] as const) {
      const p = at(space.compose(state([show(photo)], { items: shaped([w, h]), relates: [] })).placed, photo)
      expect(p.w / p.h, `${w}x${h}`).toBeCloseTo(w / h, 6)
      expect(p.w * p.h, `${w}x${h}`).toBeCloseTo(640 * 480, 3)
    }
  })

  it('gives way to any stage still in its own shape, centred and inside the margin (seeded cases)', () => {
    const r = random(20261116)
    for (let i = 0; i < 40; i++) {
      const w = r.int(320, 2560)
      const h = r.int(320, 1600)
      const sw = r.int(1, 40)
      const sh = r.int(1, 40)
      const p = at(space.compose(state([show(photo)], { stage: { w, h }, relates: [], items: shaped([sw, sh]) })).placed, photo)
      const seed = `stage ${w}x${h}, shape ${sw}x${sh}`
      expect(p.w / p.h, seed).toBeCloseTo(sw / sh, 6)
      expect(p.w * p.h, seed).toBeLessThanOrEqual(640 * 480 + 1e-3)
      expect(p.x + p.w / 2, seed).toBeCloseTo(w / 2, 6)
      expect(p.y + p.h / 2, seed).toBeCloseTo(h / 2, 6)
      expect(p.x, seed).toBeGreaterThanOrEqual(MARGIN - 1e-6)
      expect(p.y, seed).toBeGreaterThanOrEqual(MARGIN - 1e-6)
    }
  })

  it('refuses a shape that is none', () => {
    for (const shape of [[0, 3], [4, -1], [Number.NaN, 2], [Number.POSITIVE_INFINITY, 2]] as const) {
      expect(() => space.compose(state([show(photo)], { items: shaped(shape) })), String(shape)).toThrow(ArrangeError)
    }
  })
})

describe('with x in focus, the other items make room or vanish', () => {
  it('draws an item with interest or a relation in the task beside x, and hides one with neither', () => {
    const a = space.compose(state([show(photo)], { interest: { [tip]: { [text]: 2 } } }))
    const keys = a.placed.map((p) => p.key)
    // the text has been in view with the task twice and the mind holds it; the other mind and the task have no history
    expect(keys).toEqual([photo, text, vega])
    expect(keys).not.toContain(orion)
    const f = at(a.placed, photo)
    for (const k of [text, vega]) {
      const p = at(a.placed, k)
      expect(p.x + p.w <= f.x - GAP + 1e-6 || p.x >= f.x + f.w + GAP - 1e-6).toBe(true)
    }
  })

  it('never overlaps, never leaves the stage, and draws exactly the items with interest or a relation (seeded cases)', () => {
    const sources: readonly Source[] = ['artifact', 'mind', 'task', 'decision', 'message']
    const stored = ['image', 'note', 'view', 'plan', 'deck', 'photo']
    for (let seed = 1; seed <= 40; seed++) {
      const r = random(seed)
      const count = r.int(2, 9)
      const all: ArrangeItem[] = Array.from({ length: count }, (_, i) => {
        const source = r.pick(sources)
        return source === 'artifact' ? { key: `ar_x${seed}_${i}`, source, stored: r.pick(stored) } : { key: `${source.slice(0, 1)}_x${seed}_${i}`, source }
      })
      const focus = all[0].key
      const interest: Record<string, number> = {}
      const relates: ArrangeState['relates'] = []
      for (const it of all.slice(1)) {
        if (r.next() < 0.5) interest[it.key] = r.int(1, 5)
        if (r.next() < 0.3) relates.push({ key: it.key, task: tip })
      }
      const stage = { w: r.int(480, 2560), h: r.int(400, 1600) }
      const a = space.compose({ stage, items: all, relates, interest: { [tip]: interest }, shares: [], log: [show(focus)], episode: 1 })
      const why = `seed ${seed}, stage ${stage.w}x${stage.h}`
      for (const p of a.placed) {
        expect(p.x, why).toBeGreaterThanOrEqual(MARGIN - 1e-6)
        expect(p.y, why).toBeGreaterThanOrEqual(MARGIN - 1e-6)
        expect(p.x + p.w, why).toBeLessThanOrEqual(stage.w - MARGIN + 1e-6)
        expect(p.y + p.h, why).toBeLessThanOrEqual(stage.h - MARGIN + 1e-6)
      }
      for (let i = 0; i < a.placed.length; i++) for (let j = i + 1; j < a.placed.length; j++) expect(overlap(a.placed[i], a.placed[j]), `${why}: ${a.placed[i].key} and ${a.placed[j].key}`).toBe(false)
      const relevant = new Set([...Object.keys(interest), ...relates.map((x) => x.key)])
      for (const p of a.placed) if (p.key !== focus) expect(relevant.has(p.key), `${why}: ${p.key}`).toBe(true)
      for (const it of all) if (it.key !== focus && !relevant.has(it.key)) expect(a.placed.some((p) => p.key === it.key), `${why}: ${it.key}`).toBe(false)
    }
  })

  it('stacks the strips above and below on a tall stage', () => {
    const a = space.compose(state([show(photo)], { stage: { w: 800, h: 1400 } }))
    const f = at(a.placed, photo)
    const v = at(a.placed, vega)
    expect(v.y + v.h <= f.y - GAP + 1e-6 || v.y >= f.y + f.h + GAP - 1e-6).toBe(true)
  })

  it('shrinks x on a narrow stage just enough for the smallest item beside it to be drawn', () => {
    // a mind is never drawn under 180 px wide, so an 800 px stage leaves the photo 800 - 2 x (24 + 180 + 12) = 368 px
    const a = space.compose(state([show(photo)], { stage: { w: 800, h: 600 } }))
    expect(at(a.placed, photo).w).toBeCloseTo(368, 6)
    expect(at(a.placed, vega).w).toBeCloseTo(180, 6)
  })
})

describe('(Recall y) brings y back beside x', () => {
  it('draws the two side by side filling the stage, and puts the rest away', () => {
    // orion was shown before the photo, so it is one of the rest
    const a = space.compose(state([show(orion), show(photo), recall(text)], { interest: { [tip]: { [orion]: 4 } } }))
    expect(a.mode).toBe('side')
    expect(a.placed.map((p) => p.key)).toEqual([photo, text])
    const x = at(a.placed, photo)
    const y = at(a.placed, text)
    expect([x.x, x.y, x.h]).toEqual([MARGIN, MARGIN, 900 - 2 * MARGIN])
    close(y.x, x.x + x.w + GAP)
    close(y.x + y.w, 1440 - MARGIN)
    close(x.w, y.w)
    expect(a.tray).toEqual([orion])
    expect(a.dividers).toHaveLength(1)
    expect(a.dividers[0]).toMatchObject({ group: photo, index: 0, dir: 'row', kinds: ['image', 'text'], shares: [0.5, 0.5] })
  })

  it('puts a third recalled item after the others, at equal shares', () => {
    const a = space.compose(state([show(photo), recall(text), recall(vega)]))
    expect(a.placed.map((p) => p.key)).toEqual([photo, text, vega])
    const [p, t, v] = a.placed
    close(p.w, t.w)
    close(t.w, v.w)
  })

  it('lays the two along a tall stage’s length, one over the other', () => {
    const a = space.compose(state([show(photo), recall(text)], { stage: { w: 390, h: 760 } }))
    const [x, y] = [at(a.placed, photo), at(a.placed, text)]
    expect([x.x, x.w]).toEqual([y.x, y.w])
    close(y.y, x.y + x.h + GAP)
    expect(a.dividers[0].dir).toBe('column')
  })

  it('takes back what a newer statement undid, and names what the page does not have', () => {
    expect(space.compose(state([show(photo), recall(text), { say: 'putAway', key: text }])).placed.map((p) => p.key)).toEqual([photo, vega])
    expect(space.compose(state([show(photo), { say: 'putAway', key: text }, recall(text)])).mode).toBe('side')
    const cleared = space.compose(state([show(photo), recall(text), { say: 'clear' }]))
    expect([cleared.mode, cleared.placed, cleared.tray]).toEqual(['home', [], []])
    // the tray lists what was shown since the stage last emptied
    expect(space.compose(state([show(orion), { say: 'clear' }, show(photo), recall(text), { say: 'putAway', key: text }])).tray).toEqual([text])
    const missing = space.compose(state([show('ar_gone01')]))
    expect([missing.mode, missing.unknown]).toEqual(['home', ['ar_gone01']])
  })
})

describe('(Compare image text) puts the image over its text', () => {
  it('each half of the stage', () => {
    const a = space.compose(state([show(photo), recall(text), { say: 'compare', a: photo, b: text, task: tip }]))
    expect(a.mode).toBe('compare')
    const i = at(a.placed, photo)
    const t = at(a.placed, text)
    expect([i.x, i.y, i.w]).toEqual([MARGIN, MARGIN, 1440 - 2 * MARGIN])
    expect([t.x, t.w]).toEqual([i.x, i.w])
    close(i.h, t.h)
    close(t.y, i.y + i.h + GAP)
    close(t.y + t.h, 900 - MARGIN)
  })
})

describe('a dragged split is learned for the same kinds', () => {
  const side = [show(photo), recall(text)]

  it('uses the shares a person dragged the same kinds to, read in either order', () => {
    for (const learned of [{ dir: 'row' as const, kinds: ['image', 'text'], shares: [1 / 3, 2 / 3] }, { dir: 'row' as const, kinds: ['text', 'image'], shares: [2 / 3, 1 / 3] }]) {
      const a = space.compose(state(side, { shares: [learned] }))
      const room = 1440 - 2 * MARGIN - GAP
      close(at(a.placed, photo).w, room / 3)
      close(at(a.placed, text).w, (2 * room) / 3)
      expect(a.dividers[0].shares[0]).toBeCloseTo(1 / 3, 9)
    }
    // shares learned for other kinds change nothing here
    const other = space.compose(state(side, { shares: [{ dir: 'row', kinds: ['view', 'text'], shares: [0.2, 0.8] }] }))
    close(at(other.placed, photo).w, at(other.placed, text).w)
  })

  it('moves share between the divider’s two neighbours only, never past either one’s least size', () => {
    const a = space.compose(state(side, { dragging: { group: photo, index: 0, at: 0.25 } }))
    expect(a.dividers[0].shares).toEqual([0.25, 0.75])
    const d = a.dividers[0]
    // a pointer on the divider's centre reads back as the divider's own position
    expect((d.x + d.w / 2 - d.offset) / d.room).toBeCloseTo(0.25, 9)
    const tooFar = space.compose(state(side, { dragging: { group: photo, index: 0, at: 0.01 } }))
    expect(tooFar.dividers[0].shares[0]).toBeCloseTo(d.lo, 9)
    // an image is never drawn under 200 px wide, nor a text under 220
    const room = 1440 - 2 * MARGIN - GAP
    expect(d.lo * room).toBeCloseTo(200, 6)
    expect((1 - d.hi) * room).toBeCloseTo(220, 6)
  })
})

describe('interest is credited once per statement, in the task', () => {
  it('names what was in view for the newest statement, and nothing without a task', () => {
    expect(space.compose(state([show(photo)], { interest: { [tip]: { [text]: 1 } } })).seen).toEqual({ episode: 1, keys: [photo, text, vega] })
    expect(space.compose(state([show(photo, null)])).seen).toEqual({ episode: 1, keys: [] })
  })
})

describe('the arrangement space', () => {
  it('keeps its vocabulary whole', () => {
    expect(space.guards()).toEqual({ kindsWithoutSize: [], kindsWithoutLeast: [], leastAboveSize: [] })
  })

  it('refuses a key that could be read as a MeTTa word, and keeps nothing stated after a refusal', () => {
    expect(() => space.compose(state([show('empty')]))).toThrow(ArrangeError)
    expect(() => space.compose(state([], { items: [{ key: 'first', source: 'mind' }] }))).toThrow(ArrangeError)
    expect(() => space.compose(state([], { items: [...items, { key: vega, source: 'task' }] }))).toThrow(ArrangeError)
    expect(space.compose(state([]))).toMatchObject({ mode: 'home', placed: [] })
  })
})
