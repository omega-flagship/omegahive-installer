import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PREFS } from './navItems'
import { dropPinned, movePinned, readNavPrefs, setCollapsed, toggleHidden, togglePin, writeNavPrefs } from './navPrefs'

describe('each person’s nav arrangement: pins, order, hidden, folded', () => {
  it('pins and unpins; pinning a hidden entry shows it again', () => {
    const p = togglePin(toggleHidden(EMPTY_PREFS, 'lab'), 'lab')
    expect(p).toMatchObject({ pinned: ['lab'], hidden: [] })
    expect(togglePin(p, 'lab').pinned).toEqual([])
  })
  it('Move up / Move down reorder pins without dragging, and stop at the ends', () => {
    const p = { ...EMPTY_PREFS, pinned: ['a', 'b', 'c'] }
    expect(movePinned(p, 'c', -1).pinned).toEqual(['a', 'c', 'b'])
    expect(movePinned(p, 'a', 1).pinned).toEqual(['b', 'a', 'c'])
    expect(movePinned(p, 'a', -1)).toBe(p)
    expect(movePinned(p, 'c', 1)).toBe(p)
  })
  it('a drop lands before its target, or last, pinning what was not pinned', () => {
    const p = { ...EMPTY_PREFS, pinned: ['a', 'b', 'c'] }
    expect(dropPinned(p, 'c', 'a').pinned).toEqual(['c', 'a', 'b'])
    expect(dropPinned(p, 'a', null).pinned).toEqual(['b', 'c', 'a'])
    expect(dropPinned(p, 'z', 'b').pinned).toEqual(['a', 'z', 'b', 'c'])
  })
  it('hiding unpins; folding is remembered per section', () => {
    expect(toggleHidden({ ...EMPTY_PREFS, pinned: ['x'] }, 'x')).toMatchObject({ pinned: [], hidden: ['x'] })
    expect(setCollapsed(EMPTY_PREFS, 'admin', false).collapsed).toEqual({ admin: false })
  })
  describe('storage', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('is kept per person in this browser, and anything malformed reads as the defaults', () => {
      const store = new Map<string, string>()
      vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } })
      writeNavPrefs('user:p_ada', { pinned: ['lab'], hidden: [], collapsed: { admin: false } })
      expect([...store.keys()]).toEqual(['omegadots.nav.prefs.v1:user:p_ada'])
      expect(readNavPrefs('user:p_ada').pinned).toEqual(['lab'])
      store.set('omegadots.nav.prefs.v1:user:p_bad', JSON.stringify({ pinned: [1, 'ok', 'ok'], hidden: 'x', collapsed: { home: true, admin: 'no', work: true } }))
      expect(readNavPrefs('user:p_bad')).toEqual({ pinned: ['ok'], hidden: [], collapsed: { work: true } })
      expect(readNavPrefs('user:p_none')).toEqual(EMPTY_PREFS)
    })
  })
})
