// Purpose: verify the hive map keeps its minds and every word it draws out of the room the HUD and the docked Ask keep.
// On a fresh hive at 1440x900 in the classic look, a team that arrives after the first fit is fitted with the rest, so
// every mind, its name and every team's name sits below the stats bar, right of the rail and above the Ask; and however
// the camera is moved, no word is drawn in that room. INVENTED data only.
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'
import { installSceneGlobals, mockCanvas, settle, SPRITES_MOCK, type EngineInner } from './engineHarness.testkit'
import { combineInsets } from './sceneStore'
import { geometry } from '../shell/layout'
import { askRoom } from '../features/ask/askRoom'

vi.mock('./sprites', () => SPRITES_MOCK)
installSceneGlobals()

const NOW = '2026-10-01T00:00:00Z'
const team = (id: string, name: string, member: string): Swarm => ({ id, name, description: '', hue: 120, member_ids: [member], created_at: NOW }) as unknown as Swarm
const mind = (id: string, name: string, swarmId: string | null, status = 'asleep'): Agent => ({ id, name, kind: 'omega', swarm_id: swarmId, model: 'm', persona: '', hue: 200, status, driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as unknown as Agent

/** A fresh hive as barbara's v0.34 first view had it: two foundation teams, the person's own mind, then research. */
const FOUNDATION = { swarms: [team('s_code', 'Create · Code', 'a_code'), team('s_rev', 'Review', 'a_rev')], agents: [mind('a_code', 'Create · Code controller', 's_code'), mind('a_rev', 'Review controller', 's_rev'), mind('a_you', 'You', null)] }
const RESEARCH = { swarms: [team('s_res', 'Research', 'a_res')], agents: [mind('a_res', 'Research controller', 's_res', 'awake')] }
const OWN = 'hive:user:p_owner'
const universe = { hiveOf: { s_code: OWN, s_rev: OWN, s_res: OWN }, labels: { [OWN]: 'Your hive' }, wanderHive: OWN, placeholders: 0 }

/** The room App reports for the classic look's rail layout with the rail open, and the room the docked Ask reports. */
const HUD = geometry('rail', true).inset
const ASK = askRoom({ bottom: 18 }, false, 0)
const W = 1440
const H = 900
const free = { top: HUD.top, left: HUD.left, right: W, bottom: H - Math.max(HUD.bottom, ASK) }

interface Word { text: string; left: number; top: number; right: number; bottom: number; alpha: number }
type Engine = EngineInner & { ctx: Record<string, unknown>; dots: Map<string, { angle: number; sy: number; sr: number; name: string }> }

/** Every word the next render draws, with its box (centred, top baseline, a line of 1.3 times its size) and alpha. */
function recordWords(inner: Engine): Word[] {
  const words: Word[] = []
  const ctx = inner.ctx
  ctx.fillText = (text: string, x: number, y: number) => {
    const px = Number(/(\d+)px/.exec(String(ctx.font))?.[1] ?? 12)
    const half = (ctx.measureText as (s: string) => { width: number })(text).width / 2
    words.push({ text, left: x - half, top: y, right: x + half, bottom: y + px * 1.3, alpha: Number(ctx.globalAlpha) })
  }
  inner.render()
  return words
}

async function freshHive() {
  const { HiveEngine } = await import('./engine')
  const e = new HiveEngine(mockCanvas(W, H) as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined }, { reducedMotion: true })
  const inner = e as unknown as Engine
  e.setInsets(combineInsets({ hud: HUD, ask: { bottom: ASK } }))
  e.setData({ ...FOUNDATION, thinking: {}, beliefs: {}, universe })
  // the owner (local-owner mode) is the hive's admin: the first view is the whole map, fitted at once
  e.land(null, true)
  settle(inner)
  return { e, inner }
}

describe('the hive map keeps clear of the HUD and the docked Ask (1440x900, classic)', () => {
  it('a team that arrives after the first fit is fitted with the rest: every mind and word inside the free room', async () => {
    const { e, inner } = await freshHive()
    const before = { ...inner.camT }
    e.setData({ swarms: [...FOUNDATION.swarms, ...RESEARCH.swarms], agents: [...FOUNDATION.agents, ...RESEARCH.agents], thinking: {}, beliefs: {}, universe })
    expect(inner.camT).not.toEqual(before)
    settle(inner)
    // every mind at every point of its orbit, and every word drawn there
    for (let k = 0; k < 72; k++) {
      for (const d of inner.dots.values()) d.angle = (k / 72) * Math.PI * 2
      inner.update(0.0001)
      for (const d of inner.dots.values()) expect(d.sy - d.sr, `${d.name} at ${k * 5}°`).toBeGreaterThanOrEqual(free.top)
      const words = recordWords(inner)
      expect(words.map((w) => w.text)).toContain('RESEARCH')
      for (const w of words) {
        const where = `${w.text} at ${k * 5}°: ${JSON.stringify(w)}`
        expect(w.top, where).toBeGreaterThanOrEqual(free.top)
        expect(w.left, where).toBeGreaterThanOrEqual(free.left)
        expect(w.right, where).toBeLessThanOrEqual(free.right)
        expect(w.bottom, where).toBeLessThanOrEqual(free.bottom)
      }
    }
  })

  it('however the camera is moved, no word is drawn in the room the HUD, the rail and the Ask keep', async () => {
    const { e, inner } = await freshHive()
    e.setData({ swarms: [...FOUNDATION.swarms, ...RESEARCH.swarms], agents: [...FOUNDATION.agents, ...RESEARCH.agents], thinking: {}, beliefs: {}, universe })
    settle(inner)
    const fitted = { ...inner.camT }
    let crossing = 0
    // moved up, down and left by a step at a time, as a person drags the map under the bar, the Ask and the rail
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0]]) {
      for (let px = 0; px <= 600; px += 20) {
        inner.cam = inner.camT = { ...fitted, x: fitted.x + (dx * px) / fitted.z, y: fitted.y + (dy * px) / fitted.z }
        settle(inner)
        for (const w of recordWords(inner)) {
          const where = `${w.text} moved ${dx * px},${dy * px}: ${JSON.stringify(w)}`
          // never wholly in the room, and only fading while it crosses into it
          expect(w.bottom > free.top && w.right > free.left && w.top < free.bottom, where).toBe(true)
          if (w.top < free.top || w.left < free.left || w.bottom > free.bottom) {
            crossing++
            expect(w.alpha, where).toBeLessThan(1)
          }
        }
      }
    }
    // the moves did carry words across the edges, so the fading was exercised
    expect(crossing).toBeGreaterThan(0)
  })
})
