import { describe, expect, it } from 'vitest'
import { placeHint, type Box } from './place'

const hit = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

describe('hint placement', () => {
  const vp = { width: 1440, height: 900 }
  // the mind panel on desktop: "?" in its header, Wake/Stop and the budget just below it
  const panel = { left: 988, top: 12, width: 440, height: 876 }
  const anchor = { left: 1272, top: 36, width: 36, height: 36 }
  const wakeStop = { left: 1004, top: 88, width: 290, height: 44 }
  const budget = { left: 1300, top: 88, width: 112, height: 44 }

  it('never covers the Wake, Stop and Budget controls in the mind panel', () => {
    const p = placeHint(anchor, { width: 300, height: 60 }, vp, [wakeStop, budget], panel)
    expect(p.covers).toBe(0)
    expect(hit(p, wakeStop)).toBe(false)
    expect(hit(p, budget)).toBe(false)
    expect(p.side).toBe('outside')
  })
  it('stays below its button when nothing is there', () => {
    const p = placeHint(anchor, { width: 300, height: 60 }, vp, [], panel)
    expect(p.side).toBe('below')
  })
  it('goes above on a phone sheet where below is busy', () => {
    const phone = { width: 390, height: 844 }
    const a = { left: 236, top: 340, width: 36, height: 36 }
    const below = { left: 16, top: 392, width: 358, height: 44 }
    const p = placeHint(a, { width: 300, height: 60 }, phone, [below], { left: 0, top: 290, width: 390, height: 554 })
    expect(p.side).toBe('above')
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + p.width).toBeLessThanOrEqual(382)
  })
})

describe('hint placement beside a panel', () => {
  it('drops below the hive stats when they sit beside the panel header', () => {
    const vp = { width: 1440, height: 900 }
    const panel = { left: 988, top: 12, width: 440, height: 876 }
    const anchor = { left: 1272, top: 36, width: 36, height: 36 }
    const stats = { left: 500, top: 16, width: 440, height: 58 }
    const controls = [{ left: 1004, top: 88, width: 408, height: 44 }, stats]
    const p = placeHint(anchor, { width: 300, height: 60 }, vp, controls, panel)
    expect(p.covers).toBe(0)
    expect(p.top).toBeGreaterThanOrEqual(74)
    expect(p.left + p.width).toBeLessThanOrEqual(panel.left)
  })
})

describe('r3 (audit P1 #8, phone hint over Settings): a phone page header', () => {
  // a classic page at 390: "?" top right of the header, the title beside it, the action row (Swarm settings) below
  const phone = { width: 390, height: 844 }
  const anchor = { left: 282, top: 22, width: 44, height: 44 }
  const title = { left: 68, top: 27, width: 202, height: 33 }
  const close = { left: 334, top: 22, width: 44, height: 44 }
  const actions = [{ left: 16, top: 68, width: 44, height: 44 }, { left: 68, top: 68, width: 92, height: 44 }, { left: 169, top: 68, width: 52, height: 44 }, { left: 229, top: 68, width: 90, height: 44 }]
  const tabs = { left: 16, top: 232, width: 358, height: 44 }
  it('never covers the title or the Swarm settings control: it takes the first clear band further down', () => {
    const p = placeHint(anchor, { width: 300, height: 62 }, phone, [title, close, ...actions, tabs], null, 120)
    expect(p.covers).toBe(0)
    for (const b of [title, close, ...actions, tabs]) expect(hit(p, b)).toBe(false)
    expect(p.top).toBeGreaterThanOrEqual(112)
  })
  it('nowhere clear above the Ask: covers -1 (the hint is not shown), never a spot over a control', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({ left: 8, top: 70 + i * 48, width: 374, height: 44 }))
    const p = placeHint(anchor, { width: 300, height: 62 }, phone, [title, ...rows], null, 120)
    expect(p.covers).toBe(-1)
  })
})
