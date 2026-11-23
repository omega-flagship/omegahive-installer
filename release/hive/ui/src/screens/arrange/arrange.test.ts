// Purpose: the stage's arrangement as MeTTa composes it (screens/arrange/lib_arrange.metta): showing an item, the
// other items making room or vanishing, recalling one beside it, comparing two, and a dragged split learned for the
// same kinds, every item side by side or compared kept at its kind's least size, and the page's fold of a long log
// composing what the whole log composes, with seeded random cases for the claims that must hold for every stage, every
// set of items and every log. INVENTED items, ids and tasks.
import { describe, expect, it } from 'vitest'
import { ArrangeError, ArrangeSpace, foldLog, type ArrangeItem, type ArrangeState, type Arrangement, type Placed, type Source, type Statement } from './arrangeSpace'
import libArrange from './lib_arrange.metta?raw'

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
const putAway = (key: string): Statement => ({ say: 'putAway', key })
const compare = (a: string, b: string): Statement => ({ say: 'compare', a, b, task: tip })
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

  it('keeps the strips beside a tall picture, whose least size is its kind’s least area in the same shape', () => {
    // a 1 by 10 picture is shown about 85 px wide on this stage, under the image kind's least width of 200 but over its
    // least in that shape (about 55 by 548), and its height, which the strips do not take, is what bounds it
    const a = space.compose(state([show(photo)], { items: shaped([100, 1000]) }))
    const p = at(a.placed, photo)
    expect(p.h).toBeCloseTo(900 - 2 * MARGIN, 6)
    expect(at(a.placed, vega).role).toBe('beside')
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
    expect(a.dividers[0]).toMatchObject({ group: 'g', index: 0, dir: 'row', kinds: ['image', 'text'], shares: [0.5, 0.5] })
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

describe('(PutAway x) of what is shown, then (Recall x)', () => {
  it('keeps x in the tray even with nothing left in view, and a press brings it back', () => {
    const away = space.compose(state([show(photo), putAway(photo)]))
    expect([away.mode, away.placed, away.tray]).toEqual(['home', [], [photo]])
    const back = space.compose(state([show(photo), putAway(photo), recall(photo)]))
    expect([back.mode, back.placed.map((p) => p.key), back.tray]).toEqual(['focus', [photo, vega], []])
  })

  it('brings back one of a compared pair, and the shown item after another was recalled beside it', () => {
    const pair = space.compose(state([compare(photo, text), putAway(photo)]))
    expect([pair.mode, pair.tray]).toEqual(['focus', [photo]])
    expect(space.compose(state([compare(photo, text), putAway(photo), recall(photo)])).mode).toBe('compare')
    const side = space.compose(state([show(photo), recall(text), putAway(photo), recall(photo)]))
    expect([side.mode, side.placed.map((p) => p.key), side.tray]).toEqual(['side', [photo, text], []])
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
    const a = space.compose(state(side, { dragging: { group: 'g', index: 0, at: 0.25 } }))
    expect(a.dividers[0].shares).toEqual([0.25, 0.75])
    const d = a.dividers[0]
    // a pointer on the divider's centre reads back as the divider's own position
    expect((d.x + d.w / 2 - d.offset) / d.room).toBeCloseTo(0.25, 9)
    const tooFar = space.compose(state(side, { dragging: { group: 'g', index: 0, at: 0.01 } }))
    expect(tooFar.dividers[0].shares[0]).toBeCloseTo(d.lo, 9)
    // an image is never drawn under 200 px wide, nor a text under 220
    const room = 1440 - 2 * MARGIN - GAP
    expect(d.lo * room).toBeCloseTo(200, 6)
    expect((1 - d.hi) * room).toBeCloseTo(220, 6)
  })
})

describe('each divider moves alone', () => {
  it('names every group by its path, so a drag of one divider of a compared pair with a recalled item leaves the other', () => {
    // a row of the column (photo over text) and the mind: both groups start with the photo
    const log = [compare(photo, text), recall(vega)]
    const group = (x: Arrangement, id: string) => {
      const d = x.dividers.find((y) => y.group === id)
      if (!d) throw new Error(`no divider of group ${id}`)
      return d
    }
    const a = space.compose(state(log))
    expect(a.mode).toBe('side')
    expect(a.dividers.map((d) => [d.group, d.dir])).toEqual(expect.arrayContaining([['g', 'row'], ['g0', 'column']]))
    expect(a.dividers).toHaveLength(2)
    const inner = space.compose(state(log, { dragging: { group: 'g0', index: 0, at: 0.3 } }))
    expect(group(inner, 'g0').shares[0]).toBeCloseTo(0.3, 9)
    expect(group(inner, 'g').shares).toEqual(group(a, 'g').shares)
    const outer = space.compose(state(log, { dragging: { group: 'g', index: 0, at: 0.6 } }))
    expect(group(outer, 'g').shares[0]).toBeCloseTo(0.6, 9)
    expect(group(outer, 'g0').shares).toEqual(group(a, 'g0').shares)
  })

  it('refuses a group id that is not a path', () => {
    expect(() => space.compose(state([show(photo), recall(text)], { dragging: { group: photo, index: 0, at: 0.5 } }))).toThrow(ArrangeError)
  })
})

describe('on a small stage the strips give way before what is shown', () => {
  // a photo is never drawn under 200 x 150, and a mind's strip takes 24 + 180 + 12 px each side, so 632 px is the least
  // width that keeps the photo at its least size with a strip each side (632 - 2 x 216 = 200)
  it('keeps the strips while the shown item stays at its least size, and drops them just under that width', () => {
    const kept = space.compose(state([show(photo)], { stage: { w: 632, h: 400 } }))
    expect(at(kept.placed, photo).w).toBeCloseTo(200, 6)
    expect(at(kept.placed, vega).role).toBe('beside')
    const dropped = space.compose(state([show(photo)], { stage: { w: 631, h: 400 } }))
    expect(dropped.placed.map((p) => p.key)).toEqual([photo])
    // without strips the photo is shrunk only to fit the stage: here its height, 400 - 2 x 24
    expect(at(dropped.placed, photo).h).toBeCloseTo(400 - 2 * MARGIN, 6)
  })

  it('does the same with the strips above and below on a tall stage', () => {
    // a mind's strip there is 24 + 124 + 12 px tall each side, so 470 px keeps the photo 150 tall
    const kept = space.compose(state([show(photo)], { stage: { w: 300, h: 470 } }))
    expect(at(kept.placed, photo).h).toBeCloseTo(150, 6)
    expect(at(kept.placed, vega).role).toBe('beside')
    const dropped = space.compose(state([show(photo)], { stage: { w: 300, h: 469 } }))
    expect(dropped.placed.map((p) => p.key)).toEqual([photo])
    expect(at(dropped.placed, photo).w).toBeCloseTo(300 - 2 * MARGIN, 6)
  })

  it('never draws the shown item at zero or less, however small the stage', () => {
    for (const [w, h] of [[440, 400], [420, 400], [60, 60], [10, 10]]) {
      const p = at(space.compose(state([show(photo)], { stage: { w, h } })).placed, photo)
      expect(p.w, `${w}x${h}`).toBeGreaterThan(0)
      expect(p.h, `${w}x${h}`).toBeGreaterThan(0)
      expect(p.w / p.h, `${w}x${h}`).toBeCloseTo(640 / 480, 6)
    }
  })
})

describe('side by side and compared, every item keeps its kind’s least size', () => {
  // the least size each kind is drawn at, read from the rules themselves (KindLeast)
  const LEAST = Object.fromEntries([...libArrange.matchAll(/\(KindLeast (\w+) (\d+) (\d+)\)/g)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]))
  const pics = [1, 2, 3, 4, 5].map((i): ArrangeItem => ({ key: `ar_pic${i}`, source: 'artifact', stored: 'image' }))
  const [p1, p2, p3, p4, p5] = pics.map((p) => p.key)
  const withPics = { items: [...items, ...pics] }
  const atLeast = (a: Arrangement, why: string) => {
    for (const p of a.placed) {
      const [lw, lh] = LEAST[p.kind]
      expect(p.w, `${why}: ${p.key}'s width`).toBeGreaterThanOrEqual(lw - 1e-6)
      expect(p.h, `${why}: ${p.key}'s height`).toBeGreaterThanOrEqual(lh - 1e-6)
    }
  }
  // Jon's cases on stage 1: a phone at 390 x 760 with five pictures, and a drag at 200 x 200
  const phone = { w: 390, h: 760 }
  const five = [show(p1), recall(p2), recall(p3), recall(p4), recall(p5)]

  it('on a phone, five pictures each keep their least height: the oldest recalled waits in the tray, and a press brings it back as the newest', () => {
    // four pictures at least 150 high and the gaps between them fit in 760 - 2 x 24, five do not
    const a = space.compose(state(five, { ...withPics, stage: phone }))
    expect(a.mode).toBe('side')
    expect(a.placed.map((p) => p.key)).toEqual([p1, p3, p4, p5])
    expect(a.tray).toEqual([p2])
    atLeast(a, 'five on a phone')
    const back = space.compose(state([...five, recall(p2)], { ...withPics, stage: phone }))
    expect(back.placed.map((p) => p.key)).toEqual([p1, p4, p5, p2])
    expect(back.tray).toEqual([p3])
  })

  it('moves every divider there only between its neighbours’ least sizes, however far it is dragged', () => {
    for (let index = 0; index < 3; index++) {
      for (const to of [-5, 0, 0.5, 1, 5]) atLeast(space.compose(state(five, { ...withPics, stage: phone, dragging: { group: 'g', index, at: to } })), `divider ${index} at ${to}`)
    }
  })

  it('never draws a width under the least at 200 x 200: what cannot stand beside the shown item waits in the tray', () => {
    const a = space.compose(state([show(photo), recall(text)], { stage: { w: 200, h: 200 }, dragging: { group: 'g', index: 0, at: 0.01 } }))
    expect([a.mode, a.dividers, a.tray]).toEqual(['focus', [], [text]])
    for (const p of a.placed) expect(p.w > 0 && p.h > 0, p.key).toBe(true)
  })

  it('keeps both halves of a compared pair at their least when a recalled item is beside it in a column', () => {
    // on a phone the row is a column, and the pair's own column inside it needs both halves and the gap between them
    const log = [compare(photo, text), recall(vega)]
    const a = space.compose(state(log, { stage: phone }))
    expect(a.mode).toBe('side')
    expect(a.placed.map((p) => p.key)).toEqual([photo, text, vega])
    for (const to of [0, 1]) atLeast(space.compose(state(log, { stage: phone, dragging: { group: 'g', index: 0, at: to } })), `outer divider at ${to}`)
  })

  it('gives a compared pair that cannot stand one over the other to its first, the second waiting in the tray', () => {
    // a picture at least 150 high over a text at least 140 high needs 302 px, and 300 - 2 x 24 leaves 252
    const a = space.compose(state([compare(photo, text)], { stage: { w: 600, h: 300 } }))
    expect([a.mode, a.placed.map((p) => p.key), a.tray]).toEqual(['focus', [photo], [text]])
  })

  it('uses a learned split only while it is one, and holds each side at least at its least', () => {
    const side = [show(photo), recall(text)]
    const broken = space.compose(state(side, { shares: [{ dir: 'row', kinds: ['image', 'text'], shares: [-0.5, 1.5] }] }))
    expect(broken.dividers[0].shares).toEqual([0.5, 0.5])
    const thin = space.compose(state(side, { shares: [{ dir: 'row', kinds: ['image', 'text'], shares: [0.05, 0.95] }] }))
    // the picture is held at its least width, 200 px, and the text takes the rest
    close(at(thin.placed, photo).w, 200)
    close(at(thin.placed, text).w, 1440 - 2 * MARGIN - GAP - 200)
  })

  it('moves nothing for a divider its group no longer has, and refuses a divider index that is not a whole number', () => {
    // a mind can show something while the person holds a divider, so the divider may be gone by the next frame
    const side = [show(photo), recall(text)]
    expect(space.compose(state(side, { dragging: { group: 'g', index: 3, at: 0.2 } })).dividers[0].shares).toEqual([0.5, 0.5])
    for (const index of [0.5, -1]) expect(() => space.compose(state(side, { dragging: { group: 'g', index, at: 0.2 } })), String(index)).toThrow(ArrangeError)
  })

  it('draws nothing on a stage with no area, and keeps what was asked in the tray', () => {
    for (const stage of [{ w: 0, h: 600 }, { w: 390, h: 0 }, { w: -10, h: -10 }]) {
      const a = space.compose(state([show(photo), recall(text)], { stage }))
      expect([a.mode, a.placed, a.dividers, a.tray], `${stage.w}x${stage.h}`).toEqual(['home', [], [], [text, photo]])
    }
  })

  it('draws an item compared with itself once', () => {
    const a = space.compose(state([compare(photo, photo)]))
    expect(a.mode).toBe('focus')
    expect(a.placed.filter((p) => p.key === photo)).toHaveLength(1)
  })

  it('never draws an item side by side or compared under its least size, off the stage or over another (seeded cases)', () => {
    const keys = [photo, text, vega, orion, tip, p1, p2, p3, p4, p5]
    const kinds = ['image', 'text', 'mind', 'task']
    const say = (r: ReturnType<typeof random>): Statement => {
      const n = r.int(0, 9)
      return n < 2 ? show(r.pick(keys)) : n < 7 ? recall(r.pick(keys)) : n < 8 ? compare(r.pick(keys), r.pick(keys)) : n < 9 ? putAway(r.pick(keys)) : { say: 'clear' }
    }
    for (let seed = 1; seed <= 60; seed++) {
      const r = random(seed)
      const stage = r.next() < 0.3 ? r.pick([phone, { w: 760, h: 390 }, { w: 200, h: 200 }, { w: 0, h: 500 }]) : { w: r.int(1, 1800), h: r.int(1, 1100) }
      const log = Array.from({ length: r.int(1, 10) }, () => say(r))
      const split = r.next()
      const shares = r.next() < 0.5 ? [{ dir: r.pick(['row', 'column'] as const), kinds: [r.pick(kinds), r.pick(kinds)], shares: r.next() < 0.5 ? [split * 2 - 0.5, r.next()] : [split, 1 - split] }] : []
      const dragging = r.next() < 0.5 ? { group: r.pick(['g', 'g0']), index: r.int(0, 4), at: r.next() * 2 - 0.5 } : undefined
      const a = space.compose(state(log, { ...withPics, stage, shares, dragging }))
      const why = `seed ${seed}, stage ${stage.w}x${stage.h}`
      if (a.mode === 'side' || a.mode === 'compare') atLeast(a, why)
      // a divider moves between its two neighbours' least sizes, so those bounds never cross
      for (const d of a.dividers) expect(d.lo, `${why}: divider ${d.group} ${d.index}`).toBeLessThanOrEqual(d.hi + 1e-9)
      for (const p of a.placed) {
        expect(p.w > 0 && p.h > 0, `${why}: ${p.key} drawn`).toBe(true)
        expect(p.x >= -1e-6 && p.y >= -1e-6 && p.x + p.w <= stage.w + 1e-6 && p.y + p.h <= stage.h + 1e-6, `${why}: ${p.key} inside`).toBe(true)
      }
      for (let i = 0; i < a.placed.length; i++) for (let j = i + 1; j < a.placed.length; j++) expect(overlap(a.placed[i], a.placed[j]), `${why}: ${a.placed[i].key} and ${a.placed[j].key}`).toBe(false)
    }
  })
})

describe('interest is credited once per statement, in the task', () => {
  it('names what was in view for the newest statement, and nothing without a task', () => {
    expect(space.compose(state([show(photo)], { interest: { [tip]: { [text]: 1 } } })).seen).toEqual({ episode: 1, keys: [photo, text, vega] })
    expect(space.compose(state([show(photo, null)])).seen).toEqual({ episode: 1, keys: [] })
  })
})

describe('the page folds a long log into what MeTTa reads', () => {
  const gone = 'ar_gone01'
  const keys = [photo, text, vega, orion, tip, gone]
  const tasks = [tip, null, 'g_other01']
  const say = (r: ReturnType<typeof random>): Statement => {
    const n = r.int(0, 11)
    // a before the page only ever writes as the oldest statement turns up anywhere too, so the fold holds for every log
    return n < 2 ? show(r.pick(keys), r.pick(tasks)) : n < 6 ? recall(r.pick(keys)) : n < 7 ? { say: 'compare', a: r.pick(keys), b: r.pick(keys), task: r.pick(tasks) }
      : n < 10 ? putAway(r.pick(keys)) : n < 11 ? { say: 'clear' } : { say: 'before', keys: [...new Set([r.pick(keys), r.pick(keys)])], task: r.pick(tasks) }
  }
  const stages = [{ w: 1440, h: 900 }, { w: 390, h: 760 }, { w: 800, h: 500 }]

  it('composes what the whole log composes, folded at once or after every statement (seeded cases)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = random(seed)
      const log = Array.from({ length: r.int(0, 40) }, () => say(r))
      const st = state(log, { stage: r.pick(stages), interest: { [tip]: { [text]: r.int(0, 3), [orion]: r.int(0, 2) } } })
      const whole = space.compose(st)
      const folded = foldLog(log)
      let stepwise: Statement[] = []
      for (const s of log) stepwise = foldLog([...stepwise, s])
      expect(space.compose({ ...st, log: folded }), `seed ${seed}: folded at once`).toEqual(whole)
      expect(space.compose({ ...st, log: stepwise }), `seed ${seed}: folded after every statement`).toEqual(whole)
      expect(foldLog(folded), `seed ${seed}: a folded log folds to itself`).toEqual(folded)
    }
  })

  it('keeps the shown item and at most each named item’s newest statement after it, however long the session', () => {
    const r = random(7)
    let log: Statement[] = [show(photo)]
    for (let i = 0; i < 1000; i++) {
      log = foldLog([...log, r.next() < 0.5 ? recall(r.pick([text, vega, orion, tip, gone])) : putAway(r.pick([text, vega, orion, tip, gone]))])
      expect(log.length, `after ${i + 1} statements`).toBeLessThanOrEqual(keys.length + 2)
    }
    expect(log[0]).toEqual(show(photo))
    expect(at(space.compose(state(log)).placed, photo).role).toBe('shown')
  })

  it('composes a whole log of 1000 statements, where a rule recursing once per statement ran MeTTa out of stack', () => {
    const r = random(11)
    // the walk goes back through 999 recalls and put-aways to the one show
    const log = [show(photo), ...Array.from({ length: 999 }, () => (r.next() < 0.5 ? recall(r.pick([text, vega, orion, gone])) : putAway(r.pick([text, vega, orion, gone]))))]
    const whole = space.compose(state(log))
    expect(at(whole.placed, photo).role).toBe('shown')
    expect(space.compose(state(foldLog(log), { episode: log.length }))).toEqual(whole)
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
