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

describe('the Ask’s other two sizes start where its row starts (askSize.ts)', () => {
  const desk = { width: 1440, height: 900, layout: 'rail' as const, page: false, tabBar: false, omegaRight: 48, clockLeft: 1300, railX: null }
  it('collapsed: one 44 px mark right of Ω on the row’s own height, on a desktop, a phone above its tab bar and a landscape phone', async () => {
    const { MARK_SIZE, OMEGA_CLEAR, placeMark } = await import('./placement')
    expect(placeMark(desk, [])).toEqual({ mode: 'desktop', bottom: 18, left: 48 + OMEGA_CLEAR, width: MARK_SIZE })
    expect(placeMark({ ...desk, width: 390, height: 844, omegaRight: null, tabBar: true }, [])).toEqual({ mode: 'phone', bottom: 74, left: 10, width: MARK_SIZE })
    expect(placeMark({ ...desk, width: 844, height: 390, omegaRight: 48 }, [])).toEqual({ mode: 'landscape', bottom: 8, left: 60, width: MARK_SIZE })
    // past the classic rail, never over it
    expect(placeMark({ ...desk, omegaRight: null, railX: 236 }, []).left).toBe(236)
  })
  it('collapsed: lifted clear of chrome an experience keeps clear where the mark would sit, as the field is', async () => {
    const { placeMark } = await import('./placement')
    // a 44 px button bottom-left beside Ω (Cosmos's power), 12 px above the foot
    const power = { left: 62, top: 900 - 12 - 44, right: 106, bottom: 900 - 12 }
    const p = placeMark(desk, [power])
    expect(p.bottom).toBeGreaterThanOrEqual(12 + 44)
    expect(placeMark(desk, [{ ...power, left: 700, right: 744 }]).bottom).toBe(18)
  })
  it('half: the left half right of where the row starts, on a desktop and a landscape phone; the rest is the stage’s', async () => {
    const { placeHalf } = await import('./placement')
    const p = placeHalf(desk, [])
    expect(p).toEqual({ mode: 'desktop', bottom: 18, left: 60, width: Math.round((1440 - 60) / 2) - 24 })
    expect(p.left + p.width).toBeLessThan(1440 / 2 + 60)
    const l = placeHalf({ ...desk, width: 844, height: 390 }, [])
    expect(l).toEqual({ mode: 'landscape', bottom: 8, left: 60, width: Math.round((844 - 60) / 2) - 10 })
  })
  it('the row rules are the ones placeAsk keeps: its bubble is unchanged by them', async () => {
    const { placeAsk, rowBottom, rowStart } = await import('./placement')
    expect(rowStart(desk)).toBe(60)
    expect(rowBottom(desk)).toBe(18)
    expect(rowBottom({ ...desk, layout: 'dock' })).toBe(12 + 60 + 8 + 6)
    expect(rowBottom({ ...desk, layout: 'dock', page: true })).toBe(18)
    expect(placeAsk(desk)).toEqual({ mode: 'desktop', bottom: 18, left: 400, width: 640 })
    expect(placeAsk({ ...desk, width: 844, height: 390 })).toEqual({ mode: 'landscape', bottom: 8, left: 60, width: Math.max(220, Math.min(420, 844 / 2 - 60 - 10)) })
  })
})

describe('one source for the side the thread sits on', () => {
  it('the half size is the left half, whatever the thread and the pin say', async () => {
    const { askSideOf } = await import('./placement')
    expect(askSideOf({ floating: true, threadOpen: false, pinned: true, mode: 'desktop', half: true })).toBe('half')
    expect(askSideOf({ floating: false, threadOpen: false, pinned: false, mode: 'landscape', half: true })).toBe('half')
  })
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
