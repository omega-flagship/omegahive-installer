import { describe, expect, it } from 'vitest'
import { effectivePace, nextFrame, reallyShown } from './markPace'

/** The counted gate's scheduler (contract R1.1 §9.4, Dot 3 Nov): marks are still unless really shown and the shell is awake. */
describe('mark pacing', () => {
  it('at shell rest every mark is still; not shown is still; otherwise the asked pace', () => {
    expect(effectivePace('full', true, 'rest')).toBe('still')
    expect(effectivePace('awake', true, 'rest')).toBe('still')
    expect(effectivePace('full', false, 'awake')).toBe('still')
    expect(effectivePace('awake', true, 'awake')).toBe('awake')
    expect(effectivePace('full', true, 'pro')).toBe('full')
    expect(effectivePace('awake', true, undefined)).toBe('awake')
    // at shell awake only the look's own hero lives; corner marks hold still (and keep their pace in Pro)
    expect(effectivePace('awake', true, 'awake', 'corner')).toBe('still')
    expect(effectivePace('awake', true, 'awake', 'hero')).toBe('awake')
    expect(effectivePace('awake', true, 'pro', 'corner')).toBe('awake')
  })
  it('still schedules nothing; an awake hero waits ~55 ms, a corner ~33 ms; only a full hero takes each display frame', () => {
    expect(nextFrame('still', 'hero')).toBe('none')
    expect(nextFrame('still', 'corner')).toBe('none')
    expect(nextFrame('awake', 'hero')).toBe(55)
    expect(nextFrame('full', 'corner')).toBe(33)
    expect(nextFrame('full', 'hero')).toBe('raf')
  })
  it('CSS hiding counts (checkVisibility with opacity and visibility); off screen or a hidden tab is not shown', () => {
    const el = (v: boolean) => ({ checkVisibility: (o: { checkOpacity: boolean; checkVisibilityCSS: boolean }) => (o.checkOpacity && o.checkVisibilityCSS ? v : !v) }) as unknown as Element
    expect(reallyShown(el(true), true, false)).toBe(true)
    expect(reallyShown(el(false), true, false)).toBe(false)
    expect(reallyShown(el(true), false, false)).toBe(false)
    expect(reallyShown(el(true), true, true)).toBe(false)
    expect(reallyShown({} as Element, true, false)).toBe(true)
    expect(reallyShown(null, true, false)).toBe(false)
  })
})
