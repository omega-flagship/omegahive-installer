import { describe, expect, it } from 'vitest'
import { frameStats } from './fpsMeterState'

describe('frame statistics', () => {
  it('60 even frames read as 60 fps with no slow frames', () => {
    const s = frameStats(Array(60).fill(1000 / 60))
    expect(s.fps).toBe(60)
    expect(s.slow).toBe(0)
  })
  it('a few long frames show in p95, worst and the slow count, not only in the average', () => {
    const s = frameStats([...Array(57).fill(16.7), 50, 80, 120])
    expect(s.worst).toBe(120)
    expect(s.slow).toBe(3)
    expect(s.p95).toBeGreaterThanOrEqual(50)
  })
  it('no frames yet reads as zero, not NaN', () => {
    expect(frameStats([])).toEqual({ fps: 0, p95: 0, worst: 0, slow: 0 })
  })
})
