import { describe, expect, it, vi } from 'vitest'
import { SPRITES_MOCK, installSceneGlobals, settle, type EngineInner } from './engineHarness.testkit'
import { freqRgb, surenessRgb } from '../lib/color'
import { truthWords, type Truth } from '../lib/beliefSentence'
import type { Agent, Belief, Swarm } from '../api/types'

vi.mock('./sprites', () => SPRITES_MOCK)
installSceneGlobals()

/**
 * uifix-r3.5 (Kimi 2 on r3.4): the map scene's belief motes, DRAWN. The engine runs headless on a recording 2D context;
 * the colour each mote is filled with must say what the word says: neutral for "tentative" (below the no-evidence
 * floor too), never the blue or red its likelihood alone would give. r3.6: also a belief in flight and the ring drawn
 * when a published belief is adopted, both driven through the engine's own event handler. INVENTED data.
 */

/** A canvas whose context records every fill and stroke colour set on it. */
function recordingCanvas(w: number, h: number) {
  const fills: string[] = []
  const strokes: string[] = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 8 })
      if (k === 'createPattern') return () => ({})
      return () => ({ addColorStop: () => undefined })
    },
    set(t, k: string, v) {
      if (k === 'fillStyle' && typeof v === 'string') fills.push(v)
      if (k === 'strokeStyle' && typeof v === 'string') strokes.push(v)
      t[k] = v
      return true
    },
  })
  const canvas = {
    width: w,
    height: h,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
  }
  return { canvas, fills, strokes }
}

const NOW = '2026-10-01T00:00:00Z'
const SW = 's_invented'
const swarm = { id: SW, name: 'Invented swarm', description: '', hue: 120, member_ids: ['a_1', 'a_2'], created_at: NOW } as unknown as Swarm
const agents = ['a_1', 'a_2'].map((id) => ({ id, name: id, kind: 'omega', swarm_id: SW, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as unknown as Agent)

async function moteFills(tv: Truth): Promise<string[]> {
  const { HiveEngine } = await import('./engine')
  const { canvas, fills } = recordingCanvas(1200, 800)
  const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined, onUserCamera: () => undefined }, { reducedMotion: true })
  const b = { swarm_id: SW, statement: '(--> vega star)', tv, sources: ['a_1'], stamp: [1], updated_at: NOW } as unknown as Belief
  e.setData({ agents, swarms: [swarm], thinking: {}, beliefs: { [SW]: { [b.statement]: b } }, universe: { hiveOf: { [SW]: 'hive:cloud' }, labels: { 'hive:cloud': 'Cloud hive' }, wanderHive: null, placeholders: 0 } })
  const inner = e as unknown as EngineInner
  fills.length = 0
  settle(inner)
  return [...fills]
}

const rgbOf = (t: [number, number, number]) => `rgb(${t.join(',')})`

describe('map scene: a belief mote is drawn in the colour its sureness word says (uifix-r3.5)', () => {
  it('the harness sees motes: a confident "yes" is drawn blue', async () => {
    const tv = { f: 1, c: 0.9 }
    const fills = await moteFills(tv)
    expect(fills).toContain(rgbOf(surenessRgb(tv)))
    expect(surenessRgb(tv)).not.toEqual(freqRgb(0.5))
  })
  it.each([
    [1, 0],
    [1, 0.29],
    [0, 0.29],
    [0.1, 0.1],
  ])('f %d, c %d reads "tentative" and is drawn neutral, never its likelihood colour', async (f, c) => {
    const tv = { f, c }
    expect(truthWords(tv)).toBe('tentative')
    const fills = await moteFills(tv)
    expect(fills).toContain(rgbOf(freqRgb(0.5)))
    expect(fills).not.toContain(rgbOf(freqRgb(f)))
    // nor the raw-expectation colour (the r3.4 defect: it bypassed the floor)
    const raw = rgbOf(freqRgb(c * (f - 0.5) + 0.5))
    if (raw !== rgbOf(freqRgb(0.5))) expect(fills).not.toContain(raw)
  })
  it('a doubted belief (c 0.30, f 0) is drawn red', async () => {
    const tv = { f: 0, c: 0.3 }
    expect(truthWords(tv)).toBe('doubts it')
    const fills = await moteFills(tv)
    expect(fills).toContain(rgbOf(surenessRgb(tv)))
    expect(surenessRgb(tv)[0]).toBeGreaterThan(freqRgb(0.5)[0])
  })
})

/** Publish a belief that the commons adopts, then run frames until it has landed and its ring has been drawn. */
async function adoptFills(tv: Truth): Promise<{ flight: string[]; ring: string[] }> {
  const { HiveEngine } = await import('./engine')
  const { canvas, fills, strokes } = recordingCanvas(1200, 800)
  const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined, onUserCamera: () => undefined }, { reducedMotion: true })
  e.setData({ agents, swarms: [swarm], thinking: {}, beliefs: {}, universe: { hiveOf: { [SW]: 'hive:cloud' }, labels: { 'hive:cloud': 'Cloud hive' }, wanderHive: null, placeholders: 0 } })
  const inner = e as unknown as EngineInner
  settle(inner)
  e.handleEvent({ type: 'belief.published', swarm_id: SW, assertion: { agent_id: 'a_1', statement: '(--> vega star)', tv, outcome: 'adopted' } } as never)
  const flight: string[] = []
  const ring: string[] = []
  for (let i = 0; i < 40; i++) {
    inner.update(0.1)
    fills.length = 0
    strokes.length = 0
    inner.render()
    // the belief in flight is filled, the adopt ring is stroked (scene/engine.ts); only rgb() colours are sureness ones
    for (const f of fills) if (/^rgb\(/.test(f)) flight.push(f)
    for (const f of strokes) if (/^rgb\(/.test(f)) ring.push(f)
  }
  return { flight, ring }
}

describe('map scene: a belief in flight and its adopt ring say what the word says (uifix-r3.6)', () => {
  it('a confident "yes" flies and rings blue (the harness sees both)', async () => {
    const tv = { f: 1, c: 0.9 }
    const { flight, ring } = await adoptFills(tv)
    expect(flight).toContain(rgbOf(surenessRgb(tv)))
    expect(ring).toContain(rgbOf(surenessRgb(tv)))
  })
  it.each([
    [1, 0],
    [1, 0.29],
    [0, 0.29],
  ])('f %d, c %d ("tentative") flies and rings neutral', async (f, c) => {
    const tv = { f, c }
    const { flight, ring } = await adoptFills(tv)
    expect(flight).toContain(rgbOf(freqRgb(0.5)))
    expect(ring).toContain(rgbOf(freqRgb(0.5)))
    expect([...flight, ...ring].filter((x) => x !== rgbOf(freqRgb(0.5)))).toEqual([])
  })
  it('a doubted belief (f 0, c 0.30) flies and rings red', async () => {
    const tv = { f: 0, c: 0.3 }
    const { flight, ring } = await adoptFills(tv)
    expect(flight).toContain(rgbOf(surenessRgb(tv)))
    expect(ring).toContain(rgbOf(surenessRgb(tv)))
  })
})

describe('rings without a sureness tone keep the identity colour (uifix-r3.7, Kimi 4 on r3.6)', () => {
  it('a new mind\'s birth ring is drawn in its own hue, never a sureness colour', async () => {
    const { HiveEngine } = await import('./engine')
    const { canvas, strokes } = recordingCanvas(1200, 800)
    const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined, onUserCamera: () => undefined }, { reducedMotion: true })
    const data = (list: Agent[]) => ({ agents: list, swarms: [{ ...swarm, member_ids: list.map((a) => a.id) } as Swarm], thinking: {}, beliefs: {}, universe: { hiveOf: { [SW]: 'hive:cloud' }, labels: { 'hive:cloud': 'Cloud hive' }, wanderHive: null, placeholders: 0 } })
    e.setData(data(agents))
    const inner = e as unknown as EngineInner
    settle(inner)
    const born = { ...agents[0], id: 'a_3', hue: 33 } as Agent
    e.setData(data([...agents, born]))
    const seen: string[] = []
    for (let i = 0; i < 10; i++) {
      inner.update(0.1)
      strokes.length = 0
      inner.render()
      seen.push(...strokes)
    }
    expect(seen).toContain('hsl(33 100% 80%)')
    expect(seen.filter((x) => /^rgb\(/.test(x))).toEqual([])
  })
})
