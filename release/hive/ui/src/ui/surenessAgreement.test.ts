import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { surenessOf, truthWords, type Truth } from '../lib/beliefSentence'
import { freqRgb, surenessBucket, surenessColor, surenessMeter } from '../lib/color'
import { Constellation } from '../features/swarm/Constellation'
import { BeliefTable } from '../features/swarm/SwarmView'
import { clumpColour } from '../experiences/cosmos/clumpColour'
import { brightnessOf, byStrength } from '../forms/commons/model'
import { bySureness } from '../experiences/construct/model'
import { compareSureness } from '../lib/beliefSentence'
import type { Belief } from '../api/types'
import { Segs } from '../experiences/construct/Segs'
import { beliefRow } from '../experiences/construct/model'
import { SurenessMeter } from '../experiences/flux/SurenessMeter'
import { StillMeter } from '../experiences/still/StillMeter'

/**
 * uifix-r3.5 (stand-in P1 on r3.4; Kimi 1 and Kimi 5, "the sharpest"): ONE harness puts each belief through every
 * channel a person reads how sure it is from, and asserts they agree on direction: against (red, "doubts it"), none
 * (neutral, "tentative"), for (blue, a "yes" word). Below the no-evidence floor (c < 0.3) every channel is neutral.
 * Channels: the word, the colour, the meter, the glow bucket, the commons brightness, the Cosmos clump colour, and,
 * RENDERED, the constellation star (core fill and glow) and the commons table row (dot and word in the same row).
 * r3.6 (stand-in P1 and gap on r3.5): also RENDERED, the Construct `beliefs` row (its tint and its word, in one row), the
 * Flux meter (its colour and length) and the Still meter (its length). r3.7: the meters over time, below. The map scene's motes,
 * beliefs in flight and adopt ring are rendered in scene/surenessMotes.test.ts. INVENTED data.
 */

type Dir = 'against' | 'none' | 'for'
const MID = freqRgb(0.5)
const wordDir = (w: string): Dir => (w === 'doubts it' ? 'against' : w === 'tentative' ? 'none' : 'for')
const rgbDir = ([r, g, b]: number[]): Dir => (b === undefined ? ('missing' as Dir) : r === MID[0] && g === MID[1] && b === MID[2] ? 'none' : r > MID[0] ? 'against' : 'for')
const parseRgb = (s: string) => (s.match(/rgb\((\d+)[ ,]+(\d+)[ ,]+(\d+)/) ?? []).slice(1).map(Number)
const valueDir = (v: number, mid: number): Dir => (Math.abs(v - mid) < 1e-12 ? 'none' : v < mid ? 'against' : 'for')

const F = [0, 0.1, 0.4, 0.5, 0.6, 0.9, 1]
const C = [0, 0.1, 0.29, 0.3, 0.31, 0.5, 0.9, 1]
const CASES: Truth[] = F.flatMap((f) => C.map((c) => ({ f, c })))

const belief = (tv: Truth, i = 0): Belief =>
  ({ swarm_id: 's_invented', statement: `(--> vega star${i})`, tv, sources: ['a_invented'], stamp: [1], updated_at: '2026-10-01T00:00:00Z' }) as unknown as Belief

/** Every channel's direction for one truth value. */
function channels(tv: Truth): Record<string, Dir> {
  const star = renderToStaticMarkup(createElement(Constellation, { beliefs: [belief(tv)], hue: 200, onSelect: () => undefined, pulses: {}, swarmId: 's_invented' }))
  const starG = star.slice(star.indexOf('data-statement'))
  const core = parseRgb((starG.match(/fill="(rgb\([^"]+\))"/) ?? [])[1] ?? '')
  const glow = Number((starG.match(/url\(#sg-(\d+)\)/) ?? [])[1])
  const row = renderToStaticMarkup(createElement(BeliefTable, { beliefs: [belief(tv)], onSelect: () => undefined }))
  const dot = parseRgb((row.match(/background:(rgb\([^;"]+\))/) ?? [])[1] ?? '')
  const rowWord = (['near certain', 'confident', 'fairly sure', 'tentative', 'doubts it'].find((w) => row.includes(`>${w}<`)) ?? 'missing')
  const construct = renderToStaticMarkup(createElement(Segs, { segs: beliefRow(belief(tv)) }))
  const tint = (construct.match(/class="cx-c-(\w+)"/) ?? [])[1]
  const constructWord = (['near certain', 'confident', 'fairly sure', 'tentative', 'doubts it'].find((w) => construct.includes(`>${w}`)) ?? 'missing')
  const flux = renderToStaticMarkup(createElement(SurenessMeter, { tv }))
  const fluxColour = parseRgb((flux.match(/background:(rgb\([^;"]+\))/g) ?? []).map((x) => x.slice(11)).find((x) => !x.includes('/')) ?? '')
  const fluxWidth = Number((flux.match(/width:([\d.]+)%/) ?? [])[1]) / 100
  const still = renderToStaticMarkup(createElement(StillMeter, { tv }))
  const stillLength = Number((still.match(/scaleX\(([\d.]+)\)/) ?? [])[1])
  const clump = clumpColour(tv)
  const bright = 0.35 + 1.1 * tv.c
  const clumpRgb = clump.map((x) => Math.round((x / bright) * 255))
  return {
    word: wordDir(truthWords(tv)),
    decision: surenessOf(tv).direction,
    colour: rgbDir(parseRgb(surenessColor(tv))),
    meter: valueDir(surenessMeter(tv), 0.5),
    glowBucket: valueDir(surenessBucket(tv), 5),
    commonsBrightness: valueDir(brightnessOf({ truth: tv } as never), 0.35 + 0.65 * 0.5),
    cosmosClump: rgbDir(clumpRgb),
    renderedStarCore: rgbDir(core),
    renderedStarGlow: valueDir(glow, 5),
    renderedRowDot: rgbDir(dot),
    renderedRowWord: wordDir(rowWord),
    renderedConstructTint: tint === 'amber' ? 'against' : tint === 'txt' ? 'none' : tint === 'hi' ? 'for' : ('missing' as Dir),
    renderedConstructWord: wordDir(constructWord),
    renderedFluxColour: rgbDir(fluxColour),
    renderedFluxLength: valueDir(fluxWidth, 0.5),
    renderedStillLength: stillLength < 0.5 - 1e-9 ? 'against' : stillLength > 0.5 + 1e-9 ? 'for' : 'none',
  }
}

describe('the word and every certainty visual agree on direction (uifix-r3.5, one harness)', () => {
  it.each(CASES.map((t) => [t.f, t.c, t] as const))('f %d, c %d: every channel says the same', (_f, c, tv) => {
    const ch = channels(tv)
    const want = ch.word
    expect(ch, JSON.stringify(ch)).toEqual(Object.fromEntries(Object.keys(ch).map((k) => [k, want])))
    // below the no-evidence floor nothing is directional
    if (c < 0.3) expect(want).toBe('none')
  })

  it('the floor is where the stand-in found it: c 0.29 neutral, c 0.30 directional, for a "no" and a "yes"', () => {
    expect(channels({ f: 0, c: 0.29 }).renderedStarCore).toBe('none')
    expect(channels({ f: 0, c: 0.3 }).renderedStarCore).toBe('against')
    expect(channels({ f: 1, c: 0.29 }).renderedStarCore).toBe('none')
    expect(channels({ f: 1, c: 0.3 }).renderedStarCore).toBe('for')
    // Kimi 1: {f 1, c 0} reads "tentative", so it is drawn neutral, never full blue
    expect(surenessColor({ f: 1, c: 0 })).toBe(`rgb(${MID.join(' ')})`)
  })

  it('a tentative belief is drawn exactly neutral, whatever its likelihood', () => {
    for (const f of F) for (const c of [0, 0.1, 0.29]) {
      expect(surenessColor({ f, c })).toBe(`rgb(${MID.join(' ')})`)
      expect(surenessMeter({ f, c })).toBe(0.5)
      expect(surenessBucket({ f, c })).toBe(5)
    }
  })

  it('a directional band never rounds into the neutral glow (e 0.45 "doubts it", e 0.55 "fairly sure")', () => {
    expect(truthWords({ f: 0.4, c: 0.5 })).toBe('doubts it')
    expect(surenessBucket({ f: 0.4, c: 0.5 })).toBe(4)
    expect(truthWords({ f: 0.6, c: 0.5 })).toBe('fairly sure')
    expect(surenessBucket({ f: 0.6, c: 0.5 })).toBe(6)
  })

  // uifix-r3.6 (Kimi 1 and "sharpest" on r3.5): position is a sureness channel too. Every list ordered by how sure puts
  // all "yes" rows first, then tentative, then doubts; raw expectation would put a neutral {1, 0.29} above {0.6, 0.5}.
  const RANK: Record<Dir, number> = { for: 2, none: 1, against: 0, missing: -1 } as Record<Dir, number>
  const nonIncreasing = (dirs: Dir[]) => dirs.every((d, i) => i === 0 || RANK[d] <= RANK[dirs[i - 1]])
  it('the rendered table order agrees with direction (Classic swarm table, "How sure" descending)', () => {
    const rows = renderToStaticMarkup(createElement(BeliefTable, { beliefs: CASES.map((tv, i) => belief(tv, i)), onSelect: () => undefined }))
    const words = [...rows.matchAll(/>(near certain|confident|fairly sure|tentative|doubts it)</g)].map((m) => m[1])
    expect(words.length).toBe(CASES.length)
    expect(nonIncreasing(words.map(wordDir)), words.join(' | ')).toBe(true)
    // Kimi's pair: the faintly blue "fairly sure" row is above the neutral one
    const pair = renderToStaticMarkup(createElement(BeliefTable, { beliefs: [belief({ f: 1, c: 0.29 }, 1), belief({ f: 0.6, c: 0.5 }, 2)], onSelect: () => undefined }))
    expect([...pair.matchAll(/>(fairly sure|tentative)</g)].map((m) => m[1])).toEqual(['fairly sure', 'tentative'])
  })
  it('Construct, Still and the commons sky order the same way', () => {
    const rows = CASES.map((tv, i) => ({ id: i, tv, truth: tv }))
    for (const sorted of [[...rows].sort(bySureness), [...rows].sort((a, b) => compareSureness(b.tv, a.tv)), [...rows].sort((a, b) => byStrength(a as never, b as never))]) {
      expect(nonIncreasing(sorted.map((r) => surenessOf(r.tv).direction as Dir))).toBe(true)
    }
  })
})

/**
 * uifix-r3.7 (stand-in P1 on r3.6): the meters over time. r3.6 sprang the Flux width from 0 on mount and from the
 * previous value on update, so 95% → tentative still drew 80% at 100 ms beside "tentative". The meters are now pure
 * functions of the truth value with no time dimension: no animation library, no transition, no timer. This samples what
 * is drawn at 0, 50, 100 and 300 ms (fake timers) after each change, and pins the "no time dimension" by construction.
 * (This repo's tests run in node, without a DOM, so a mount is a render of the current props at each instant.)
 */
const drawn = (tv: Truth) => {
  const flux = renderToStaticMarkup(createElement(SurenessMeter, { tv }))
  const fill = flux.slice(flux.indexOf('<div', 1))
  return {
    fluxWidth: Number((fill.match(/width:([\d.]+)%/) ?? [])[1]),
    fluxColour: parseRgb((fill.match(/background:(rgb\([^;"]+\))/) ?? [])[1] ?? ''),
    stillLength: Number((renderToStaticMarkup(createElement(StillMeter, { tv })).match(/scaleX\(([\d.]+)\)/) ?? [])[1]),
    markup: flux,
  }
}
describe('the meters over time: drawn = what the word says at every instant (uifix-r3.7)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it.each([
    ['near certain → tentative', { f: 0.95, c: 0.9 }, { f: 1, c: 0.29 }],
    ['doubts it → tentative', { f: 0, c: 0.9 }, { f: 0, c: 0.1 }],
    ['tentative → near certain', { f: 1, c: 0 }, { f: 0.95, c: 0.9 }],
    ['tentative → doubts it', { f: 0.5, c: 0.9 }, { f: 0, c: 0.9 }],
  ] as const)('%s: at 0, 50, 100 and 300 ms the width is the semantic value and the colour agrees with the word', (_n, from, to) => {
    vi.useFakeTimers()
    drawn(from) // mounted with the first value
    let now = 0
    for (const t of [0, 50, 100, 300]) {
      vi.advanceTimersByTime(t - now)
      now = t
      const d = drawn(to)
      expect(d.fluxWidth, `${t} ms`).toBeCloseTo(surenessMeter(to) * 100, 9)
      expect(d.stillLength, `${t} ms`).toBeCloseTo(Math.max(0.06, surenessMeter(to)), 9)
      expect(rgbDir(d.fluxColour), `${t} ms`).toBe(wordDir(truthWords(to)))
    }
  })
  it('a tentative mount draws exactly 50% from the first instant, never under or over', () => {
    vi.useFakeTimers()
    for (const tv of [{ f: 1, c: 0 }, { f: 0, c: 0.29 }, { f: 0.5, c: 1 }]) {
      for (const t of [0, 16, 50, 100, 300]) {
        vi.advanceTimersByTime(t ? 16 : 0)
        expect(drawn(tv).fluxWidth).toBe(50)
        expect(drawn(tv).stillLength).toBe(0.5)
      }
    }
  })
  it('the meters have no time dimension: no animation library, no transition or animation in what is drawn', () => {
    for (const tv of [{ f: 1, c: 0 }, { f: 0.95, c: 0.9 }, { f: 0, c: 0.9 }]) {
      expect(drawn(tv).markup).not.toMatch(/transition|animation|will-change/)
      expect(renderToStaticMarkup(createElement(StillMeter, { tv }))).not.toMatch(/transition|animation|will-change/)
    }
  })
  it('two routes to 0.5 are told apart by construction (Kimi 3, r3.6): tentative is 0.5, a faint "yes" is not', () => {
    expect(surenessMeter({ f: 1, c: 0.29 })).toBe(0.5)
    expect(surenessMeter({ f: 0.6, c: 0.5 })).not.toBe(0.5)
    expect(surenessMeter({ f: 0.6, c: 0.5 })).toBeGreaterThan(0.5)
  })
})

describe('commons sky order: deliberate for unassessed stars and rivals (uifix-r3.7, Kimi 2 on r3.6)', () => {
  const star = (id: string, truth?: Truth) => ({ id, statement: id, truth }) as never
  it('stars with no truth value sort after every assessed star, doubts included (as before r3.6)', () => {
    const stars = [star('none-1'), star('doubt', { f: 0, c: 0.9 }), star('none-2'), star('tentative', { f: 1, c: 0 }), star('yes', { f: 1, c: 0.9 })]
    const order = [...stars].sort(byStrength).map((s: { id: string }) => s.id)
    expect(order.slice(0, 3)).toEqual(['yes', 'tentative', 'doubt'])
    expect(order.slice(3).sort()).toEqual(['none-1', 'none-2'])
  })
  it('a rival pair: a thin "fairly sure" {0.6, 0.5} ranks above a well-evidenced coin flip {0.5, 0.9} (direction first, on purpose)', () => {
    const order = [star('coin-flip', { f: 0.5, c: 0.9 }), star('fairly-sure', { f: 0.6, c: 0.5 })].sort(byStrength).map((s: { id: string }) => s.id)
    expect(order).toEqual(['fairly-sure', 'coin-flip'])
  })
})
