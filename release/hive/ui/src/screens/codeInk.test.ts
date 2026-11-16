import { describe, expect, it } from 'vitest'
import { ScreensSpace, SCREEN_SOURCES } from './screenSpace'

describe('the code editor’s ink is chosen by MeTTa (looks.metta scr-code-ink)', () => {
  it('a light surface writes code in paper ink, a dark one in night ink, whatever the look', () => {
    const s = ScreensSpace.open()
    expect(s.codeInk('still', 'light')).toBe('paper')
    expect(s.codeInk('professional', 'light')).toBe('paper')
    expect(s.codeInk('classic', 'dark')).toBe('night')
    expect(s.codeInk('cosmos', 'dark')).toBe('night')
  })
  it('a look may name its own ink in the AtomSpace, and that wins over the surface', () => {
    const s = ScreensSpace.open([...SCREEN_SOURCES, ['own-ink', '(LookCodeInk canvas night)']])
    expect(s.codeInk('canvas', 'light')).toBe('night')
    expect(s.codeInk('still', 'light')).toBe('paper')
  })
})
