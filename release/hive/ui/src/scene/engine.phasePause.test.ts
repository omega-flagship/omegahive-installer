import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSceneGlobals, mockCanvas, SPRITES_MOCK, universe } from './engineHarness.testkit'
vi.mock('./sprites', () => SPRITES_MOCK)
import { HiveEngine } from './engine'
import type { Agent, Swarm } from '../api/types'

installSceneGlobals()
afterEach(() => { (document as unknown as { hidden: boolean }).hidden = false; vi.restoreAllMocks() })
const engine = () => new HiveEngine(mockCanvas(900, 700) as unknown as HTMLCanvasElement, { onHover: () => {}, onTap: () => {} })

describe('an owned phase hold keeps the covered Classic map idle', () => {
  it('retires removed mind interaction and claim references while retaining live ones', () => {
    const e = engine()
    const refs = e as unknown as { selected: string | null; hoverTarget: { kind: string; id: string } | null; claimSeen: Map<string, string | null> }
    try {
      const data = universe(), gone = data.agents[0].id, kept = data.agents[1].id
      e.setData({ ...data, thinking: {}, beliefs: {}, claims: { goneGoal: gone, keptGoal: kept } })
      e.setSelected(gone, false)
      refs.hoverTarget = { kind: 'dot', id: gone }
      const release = e.holdDrawing()
      e.setData({ ...data, agents: data.agents.filter(a => a.id !== gone), thinking: {}, beliefs: {}, claims: { keptGoal: kept } })
      expect(refs.selected).toBeNull()
      expect(refs.hoverTarget).toBeNull()
      expect(refs.claimSeen.has('goneGoal')).toBe(false)
      expect(refs.claimSeen.get('keptGoal')).toBe(kept)
      release()
    } finally { e.destroy() }
  })
  it('paints a still under a full-page pause without restarting frames', () => {
    const e = engine(), paint = vi.spyOn(e as unknown as { render(): void }, 'render')
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      e.pause()
      paint.mockClear(); frames.mockClear()
      const release = e.holdDrawing()
      expect(paint).toHaveBeenCalledTimes(1)
      expect(frames).not.toHaveBeenCalled()
      release()
      expect(e.isPaused).toBe(true)
      expect(frames).not.toHaveBeenCalled()
    } finally { e.destroy() }
  })
  it('keeps the map lights but removes every canvas label while held, restoring labels for Pro', () => {
    const canvas = mockCanvas(900, 700)
    const context = canvas.getContext()
    const text = vi.fn()
    Object.assign(context, { fillText: text })
    canvas.getContext = () => context
    const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => {}, onTap: () => {} })
    try {
      const data = universe()
      e.setData({ ...data, thinking: {}, beliefs: {} })
      e.land(null, true)
      const release = e.holdDrawing()
      expect(e.screenPos(data.agents[0].id)).not.toBeNull()
      expect(text).not.toHaveBeenCalled()
      expect(e.labelBoxes()).toEqual([])
      expect(e.galaxyLabelBoxes()).toEqual([])
      release()
      e.pause(); e.resize()
      expect(text).toHaveBeenCalled()
    } finally { e.destroy() }
  })
  it('paints the actual map before any animation frame, and refits a held first landing', () => {
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    const e = engine()
    try {
      e.setData({
        agents: [{ id: 'a', name: 'Invented mind', swarm_id: 's', status: 'awake', hue: 200, created_at: '2026-01-01' } as Agent],
        swarms: [{ id: 's', name: 'Invented swarm', hue: 200, member_ids: ['a'], created_at: '2026-01-01' } as Swarm],
        thinking: {}, beliefs: {},
      })
      const release = e.holdDrawing()
      e.land(null, true)
      const point = e.screenPos('a')
      expect(point).not.toBeNull()
      expect(point!.x).toBeGreaterThan(0)
      expect(point!.y).toBeGreaterThan(0)
      e.setData({ agents: [], swarms: [], thinking: {}, beliefs: {} })
      expect(e.screenPos('a')).toBeNull()
      expect(frames).not.toHaveBeenCalled()
      release()
    } finally { e.destroy() }
  })
  it('does not let a normal resume or another owner release restart a held map', () => {
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    const e = engine()
    try {
      e.start()
      expect(frames).toHaveBeenCalledTimes(1)
      const first = e.holdDrawing(), second = e.holdDrawing()
      e.resume()
      first(); first()
      expect(e.isPaused).toBe(true)
      expect(frames).toHaveBeenCalledTimes(1)
      second()
      expect(e.isPaused).toBe(false)
      expect(frames).toHaveBeenCalledTimes(2)
    } finally { e.destroy() }
  })
  it('keeps a legacy full-page pause after the phase hold leaves', () => {
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    const e = engine()
    try {
      const release = e.holdDrawing()
      e.pause()
      release()
      expect(e.isPaused).toBe(true)
      expect(frames).not.toHaveBeenCalled()
      e.resume()
      expect(frames).toHaveBeenCalledTimes(1)
    } finally { e.destroy() }
  })
  it('never schedules a frame in a hidden tab or from a late destroyed-owner cleanup', () => {
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    const e = engine()
    const release = e.holdDrawing()
    ;(document as unknown as { hidden: boolean }).hidden = true
    release()
    e.resume()
    expect(frames).not.toHaveBeenCalled()
    ;(document as unknown as { hidden: boolean }).hidden = false
    const late = e.holdDrawing()
    e.destroy()
    late(); e.start()
    expect(frames).not.toHaveBeenCalled()
  })
})

describe('a queued frame cannot precede its resume clock', () => {
  it('never draws a negative-radius newborn when a delayed RAF timestamp is older than resume()', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((frame) => (frames.push(frame), frames.length))
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    const canvas = mockCanvas(900, 700), context = canvas.getContext()
    const radii: number[] = []
    Object.assign(context, { arc: (_x: number, _y: number, radius: number) => {
      radii.push(radius)
      if (radius < 0) throw new RangeError(`negative canvas radius: ${radius}`)
    } })
    canvas.getContext = () => context
    const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => {}, onTap: () => {} })
    try {
      const data = universe(), first = data.agents[0], swarm = data.swarms[0]
      e.setData({ agents: [first], swarms: [swarm], thinking: {}, beliefs: {} })
      e.start()
      e.setData({ agents: [first, { ...first, id: 'newborn-stopped', status: 'stopped' }], swarms: [swarm], thinking: {}, beliefs: {} })
      e.land(null, true)
      expect(frames.length).toBeGreaterThan(0)
      // CPU pressure can delay dispatch of a compositor timestamp queued before resume's performance.now().
      expect(() => frames.shift()!(100)).not.toThrow()
      expect(() => frames.shift()!(1100)).not.toThrow()
      expect(radii.length).toBeGreaterThan(0)
      expect(radii.every((r) => Number.isFinite(r) && r >= 0)).toBe(true)
    } finally { e.destroy() }
  })
})
