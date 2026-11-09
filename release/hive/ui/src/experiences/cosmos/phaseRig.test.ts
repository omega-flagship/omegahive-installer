/** Cosmos rest/awake framing and the awake orbit's apps (CANDIDATE, cosmos-rest-r1): pure parts. */
import { describe, expect, it } from 'vitest'
import { announcement, APP_ORBIT, appPos, askSideShift, labelSide, awakeStatus, FADES, fadesFor, firstLive, flightAfterViewChange, frameloopFor, ignitionLit, pacedFps, orbitCount, PHI, phaseFrame, PRO_FOCUS_CHAIN, RATE, restPaced, rootPresentation, type RootState } from './phaseRig'
import { orbitApps } from './phaseApps'
import type { Program } from '../../api/types'

const TAN = Math.tan((25 * Math.PI) / 180)
const VIEWPORTS: [number, number][] = [
  [390, 844],
  [820, 1180],
  [1440, 900],
]

describe('phaseFrame', () => {
  it('fits the awake orbit inside the screen at every target size, with room below for the field', () => {
    for (const [w, h] of VIEWPORTS) {
      const f = phaseFrame('awake', w, h)
      const halfW = f.radius * TAN * (w / h)
      const halfH = f.radius * TAN
      const tall = w / h < 0.8
      expect(f.phi).toBe(tall ? PHI.awakeTall : PHI.awake)
      expect(APP_ORBIT / halfW, `${w}x${h} width`).toBeLessThanOrEqual(tall ? 0.721 : 0.621)
      expect((APP_ORBIT * Math.cos(f.phi)) / halfH, `${w}x${h} height`).toBeLessThanOrEqual(tall ? 0.461 : 0.401)
      // the Ω is lifted above the centre (the field lives below)
      expect(f.offY).toBeGreaterThan(0)
    }
  })
  it('rest is the same view from much farther, lower over the plane', () => {
    for (const [w, h] of VIEWPORTS) {
      const a = phaseFrame('awake', w, h)
      const r = phaseFrame('rest', w, h)
      expect(r.radius / a.radius).toBeCloseTo(2.6)
      expect(r.phi).toBeGreaterThan(a.phi)
    }
  })
  it('the fades: nothing of the galaxy at rest, alive but dimmed awake, all of it in Pro', () => {
    expect(FADES.rest.galaxy).toBe(0)
    // quality pass r1: awake keeps the galaxy alive behind the Ω (never a near-black void); a phone looking down into the
    // core keeps it lower, so the name and status keep their contrast
    expect(fadesFor('awake', 1440, 900).galaxy).toBeGreaterThanOrEqual(0.5)
    expect(fadesFor('awake', 390, 844).galaxy).toBeLessThan(fadesFor('awake', 1440, 900).galaxy)
    expect(fadesFor('rest', 390, 844)).toEqual(FADES.rest)
    expect(FADES.awake.galaxy).toBeGreaterThan(0)
    expect(FADES.awake.galaxy).toBeLessThan(FADES.pro.galaxy)
    expect(FADES.pro).toEqual({ galaxy: 1, sky: 1 })
  })
})

describe('the awake orbit', () => {
  it('spaces the apps evenly on the orbit', () => {
    const o = { x: 0, y: 0, z: 0 }
    const angles = [0, 1, 2, 3].map((i) => (appPos(i, 4, 0, o), Math.atan2(o.z, o.x)))
    for (let i = 1; i < 4; i++) expect((((angles[i] - angles[i - 1]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(Math.PI / 2)
    appPos(0, 4, 0, o)
    expect(Math.hypot(o.x, o.z)).toBeCloseTo(APP_ORBIT)
  })
  it('carries fewer bodies on a phone', () => {
    expect(orbitCount(390)).toBe(4)
    expect(orbitCount(820)).toBe(5)
    expect(orbitCount(1440)).toBe(6)
  })
  it('carries only real, openable apps, in the hive’s order, nothing invented', () => {
    const p = (id: string, enabled = true, error: string | null = null) => ({ id, name: id.toUpperCase(), version: '1', description: '', icon: '', capabilities: [], source: 'built-in', enabled, error }) as Program
    expect(orbitApps(null, () => null)).toEqual([])
    const out = orbitApps([p('a'), p('b', false), p('c', true, 'broken'), p('d')], (x) => (x.id === 'a' ? '#ff0000' : null))
    expect(out.map((x) => x.id)).toEqual(['a', 'd'])
    expect(out[0].color).toBe('#ff0000')
    expect(out[1].color).toMatch(/^hsl|^#/)
  })
})

describe('the live line', () => {
  it('says each real move into a state exactly once, and nothing on the opening paint', () => {
    // a journey: opening rest, wake, Pro, back, rest, wake; the awake layer's text after each step
    const steps: [string, string | null][] = [['rest', null], ['awake', 'rest'], ['pro', 'awake'], ['awake', 'pro'], ['rest', 'awake'], ['awake', 'rest']]
    const texts = steps.map(([p, f]) => announcement(p as never, f as never, 'awake', 'W'))
    expect(texts).toEqual(['', 'W', '', 'W', '', 'W'])
    // a live region speaks on a change to non-empty text: one per real arrival in awake (three here)
    const spoken = texts.filter((t, i) => t && t !== (texts[i - 1] ?? '')).length
    expect(spoken).toBe(3)
    expect(announcement('rest', null, 'rest', 'R')).toBe('')
    expect(announcement('rest', 'awake', 'rest', 'R')).toBe('R')
  })
})

describe('r2: pacing, flights, ignition, focus, the pinned thread (Kimi r1 and stand-in r1)', () => {
  const p = (o: Partial<Parameters<typeof frameloopFor>[0]>) => ({ hidden: false, reduced: false, phased: true, phase: 'rest' as const, ...o })
  it('draws on demand at rest from the first moment, never while hidden, always awake and in Pro (Kimi #10)', () => {
    expect(frameloopFor(p({}))).toBe('demand')
    expect(frameloopFor(p({ phase: 'awake' }))).toBe('demand')
    expect(frameloopFor(p({ phase: 'pro' }))).toBe('always')
    expect(frameloopFor(p({ phased: false, phase: 'pro' }))).toBe('always')
    expect(frameloopFor(p({ hidden: true }))).toBe('never')
    expect(frameloopFor(p({ reduced: true, phase: 'awake' }))).toBe('demand')
  })
  it('paces awake at 18 and rest at 22 frames a second; never hidden, reduced, unphased or in Pro (contract R1.1 #3)', () => {
    expect(pacedFps(p({}))).toBe(22)
    expect(pacedFps(p({ phase: 'awake' }))).toBe(18)
    expect(pacedFps(p({ phase: 'pro' }))).toBeNull()
    expect(pacedFps(p({ phase: 'awake', hidden: true }))).toBeNull()
    expect(pacedFps(p({ phase: 'awake', reduced: true }))).toBeNull()
    expect(pacedFps(p({ phase: 'awake', phased: false }))).toBeNull()
  })
  it('paces the rest only while it can be seen, and never under reduced motion (stand-in P2)', () => {
    expect(restPaced(p({}))).toBe(true)
    expect(restPaced(p({ hidden: true }))).toBe(false)
    expect(restPaced(p({ reduced: true }))).toBe(false)
    expect(restPaced(p({ phase: 'awake' }))).toBe(false)
    expect(restPaced(p({ phased: false }))).toBe(false)
  })
  it('the fly-out rate only for the move from awake into Pro; any other view change clears it (stand-in P2)', () => {
    expect(flightAfterViewChange(true, false, false)).toBe(RATE['fly-out'])
    expect(flightAfterViewChange(false, false, false)).toBe(0)
    expect(flightAfterViewChange(true, true, false)).toBe(0)
    expect(flightAfterViewChange(true, false, true)).toBe(0)
  })
  it('the ignition veil lifts only for the current scene (a restored context is a new epoch), or on failure (Kimi #1)', () => {
    expect(ignitionLit(-1, 0, false)).toBe(false)
    expect(ignitionLit(0, 0, false)).toBe(true)
    expect(ignitionLit(0, 1, false)).toBe(false)
    expect(ignitionLit(1, 1, false)).toBe(true)
    expect(ignitionLit(-1, 3, true)).toBe(true)
  })
  it('Pro focus lands on the first live place of the chain, skipping missing and inert ones (Kimi #4)', () => {
    const el = (inert = false, isConnected = true) => ({ isConnected, closest: (s: string) => (inert && s === '[inert]' ? {} : null) })
    expect(PRO_FOCUS_CHAIN[PRO_FOCUS_CHAIN.length - 1]).toBe('[data-cx-pro-root]')
    expect(firstLive(PRO_FOCUS_CHAIN, (s) => (s === '[data-cx-back-to-omega]' ? el() : el()))).toBe('[data-cx-back-to-omega]')
    expect(firstLive(PRO_FOCUS_CHAIN, (s) => (s === '[data-cx-back-to-omega]' ? null : el()))).toBe('.ask-root .ask-input')
    expect(firstLive(PRO_FOCUS_CHAIN, (s) => (s === '[data-cx-pro-root]' ? el() : el(true)))).toBe('[data-cx-pro-root]')
    expect(firstLive(PRO_FOCUS_CHAIN, () => el(false, false))).toBeNull()
  })
  it('rest and awake step aside for an Ask thread pinned beside them (smoke r1)', () => {
    expect(askSideShift(undefined, 1440)).toBe(0)
    expect(askSideShift('desktop', 1440)).toBe(202)
    expect(askSideShift('landscape', 844)).toBe(211)
  })
  it('says the status plainly, including for an empty hive', () => {
    expect(awakeStatus(0, 0)).toBe('No minds yet')
    expect(awakeStatus(1, 1)).toBe('1 of 1 mind lit')
    expect(awakeStatus(15, 7)).toBe('7 of 15 minds lit')
  })
})

describe('r2 styles', () => {
  const fsName = 'node:fs'
  // touch: pinch-zoom on the layer, the sky and the Ω is checked by behaviour (onePointerPress / wheelIsNavigation in
  // shell/phase.test.ts, and the smoke's real two-finger pinch at phone width), not by reading the stylesheet
  it('Pro clears a pinned thread; a lost context shows the dark sky, only while phased', async () => {
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const css = fs.readFileSync(new URL('./phases.css', import.meta.url).pathname, 'utf8')
    expect(css).toMatch(/html\[data-ask-side\] \.cxp-pro \{\s*top: auto;\s*right: auto;\s*left: calc\(116px/)
    // beside a pinned thread the names wrap, so they keep inside the narrow free area
    expect(css).toMatch(/html\[data-ask-side\] \.cxp-app \{\s*white-space: normal;\s*max-width: 150px;/)
    // a lost context: the dark sky, not a blank canvas, and the note above the field in rest and awake
    // the hide rule is the candidate's (phases.css); the released stylesheet keeps no such rule (stand-in r2 blocking)
    const cosmos = fs.readFileSync(new URL('./cosmos.css', import.meta.url).pathname, 'utf8')
    expect(css).toMatch(/\.cx\[data-gl='lost'\] canvas \{ visibility: hidden; \}/)
    expect(cosmos).not.toMatch(/data-gl='lost'\] canvas/)
    expect(css).toMatch(/\.cx\[data-phase\]:not\(\[data-phase='pro'\]\) \.cx-gl-note \{\s*top: calc\(64px[^}]*bottom: auto;/)
  })
})

describe('r2: label sides', () => {
  it('outer side when there is room; above when the body is on the Ω line and there is none (the name sits below)', () => {
    expect(labelSide(-300, 5, 400, 200, 1440)).toBe('l')
    expect(labelSide(300, 5, 1000, 200, 1440)).toBe('r')
    expect(labelSide(-300, 5, 150, 250, 820)).toBe('t')
    expect(labelSide(-300, 80, 150, 250, 820)).toBe('b')
    expect(labelSide(-100, 120, 150, 250, 820)).toBe('b')
    // a pinned thread narrows the room: a right label that would run under it goes above
    expect(labelSide(150, 0, 358, 220, 416)).toBe('t')
    expect(labelSide(0, -200, 400, 200, 820)).toBe('t')
  })
})

describe('r2.1: unphased Cosmos presents its scene exactly as released (stand-in r2 FIX-FIRST)', () => {
  // the root's lifecycle, step by step, through the same transitions index.tsx makes: first light, a lost context,
  // the restore (a new scene epoch), the new scene's first light
  const walk = (phased: boolean) => {
    const st: RootState = { phased, gl: 'ok', litEpoch: -1, epoch: 0, everLit: false }
    const at = () => rootPresentation(st)
    const boot = at()
    Object.assign(st, { litEpoch: 0, everLit: true })
    const first = at()
    st.gl = 'lost'
    const lost = at()
    Object.assign(st, { gl: 'ok', epoch: 1 })
    const restored = at()
    st.litEpoch = 1
    const relit = at()
    return { boot, first, lost, restored, relit }
  }
  it('phases off: a lost context sets no data-gl (the canvas is not hidden), and a restore never re-arms the veil', () => {
    const w = walk(false)
    expect(w.boot).toEqual({ lit: false, dataGl: undefined, retireVeil: false })
    expect(w.first.lit).toBe(true)
    expect(w.lost).toEqual({ lit: true, dataGl: undefined, retireVeil: false })
    expect(w.restored).toEqual({ lit: true, dataGl: undefined, retireVeil: false })
    expect(w.relit).toEqual({ lit: true, dataGl: undefined, retireVeil: false })
    // a failure lifts the veil for good, as released; still no data-gl
    expect(rootPresentation({ phased: false, gl: 'failed', litEpoch: -1, epoch: 0, everLit: true })).toEqual({ lit: true, dataGl: undefined, retireVeil: false })
  })
  it('phases on: the r2 recovery (lost hides the canvas, the restored scene is veiled until its own first light)', () => {
    const w = walk(true)
    expect(w.first).toEqual({ lit: true, dataGl: undefined, retireVeil: true })
    expect(w.lost.dataGl).toBe('lost')
    expect(w.restored.lit).toBe(false)
    expect(w.relit.lit).toBe(true)
    expect(rootPresentation({ phased: true, gl: 'failed', litEpoch: -1, epoch: 0, everLit: true }).dataGl).toBe('failed')
  })
})

describe('r2.1: the root reads its presentation from rootPresentation, keyed on activation', () => {
  const fsName = 'node:fs'
  it('data-gl and the veil retirement come from it, and it is given the phase store\'s activation', async () => {
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const src = fs.readFileSync(new URL('./index.tsx', import.meta.url).pathname, 'utf8')
    expect(src).toContain('const activated = usePhase((s) => s.phased)')
    expect(src).toContain('rootPresentation({ phased: activated, gl, litEpoch, epoch, everLit })')
    expect(src).toContain('data-gl={shown.dataGl}')
    expect(src).toContain('retire={shown.retireVeil}')
    expect(src).not.toMatch(/data-gl=\{gl/)
  })
})
