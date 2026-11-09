import { describe, expect, it } from 'vitest'
import { PINNED_AXIS_SHIFT, placeAsk } from './placement'

describe('the hive home: the Ask on the page centre axis (Jon, 3 Nov)', () => {
  const base = { width: 1440, height: 900, layout: 'rail' as const, page: false, tabBar: false, omegaRight: null, clockLeft: null }
  it('Classic (rail 236) and Professional (sidebar 216) home: centred at 720, not right of the rail', () => {
    for (const railX of [236, 216]) {
      const home = placeAsk({ ...base, railX, pageAxis: true })
      expect(home.left + home.width / 2).toBe(720)
      const page = placeAsk({ ...base, railX, page: true })
      expect(page.left + page.width / 2).toBe((railX + 1440) / 2)   // a page still centres in its content area
    }
  })
  it('never over the rail: a narrow window keeps the Ask clear of it', () => {
    const p = placeAsk({ ...base, width: 900, railX: 236, pageAxis: true })
    expect(p.left).toBeGreaterThanOrEqual(236)
  })
})

describe('a thread pinned beside the home: one centre axis for the Ask and the Ω', () => {
  it('the Ask centres on the shifted axis the Ω uses', () => {
    const p = placeAsk({ width: 1440, height: 900, layout: 'rail', page: false, tabBar: false, omegaRight: null, clockLeft: null, railX: null, pageAxis: true, axisShift: PINNED_AXIS_SHIFT })
    expect(p.left + p.width / 2).toBe(720 - PINNED_AXIS_SHIFT)
  })
})

describe('one source for the side the thread sits on', () => {
  it('a pinned desktop column, or a landscape sheet, only while a floating Ask has its thread open', async () => {
    const { askSideOf } = await import('./placement')
    expect(askSideOf({ floating: true, threadOpen: true, pinned: true, mode: 'desktop' })).toBe('desktop')
    expect(askSideOf({ floating: true, threadOpen: true, pinned: false, mode: 'desktop' })).toBeNull()
    expect(askSideOf({ floating: true, threadOpen: true, pinned: false, mode: 'landscape' })).toBe('landscape')
    expect(askSideOf({ floating: false, threadOpen: true, pinned: true, mode: 'desktop' })).toBeNull()
    expect(askSideOf({ floating: true, threadOpen: false, pinned: true, mode: 'desktop' })).toBeNull()
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    const host = fs.readFileSync(new URL('./AskHost.tsx', import.meta.url), 'utf8')
    expect(host).toMatch(/if \(side\) root\.dataset\.askSide = side/)
    expect(host).toMatch(/axisShift: experience === 'cosmos' && side === 'desktop'/)
  })
})
