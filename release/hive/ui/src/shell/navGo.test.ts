import { afterEach, describe, expect, it, vi } from 'vitest'

/** Kimi K3 follow-up (9593fd1) P3-10: goTo's look for a place stops when the person leaves the page. */
function stubDom() {
  const loc = { hash: '', pathname: '/', search: '' }
  const found: string[] = []
  vi.stubGlobal('window', { location: loc, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true })
  vi.stubGlobal('history', { state: null, replaceState: () => undefined })
  vi.stubGlobal('document', { querySelector: (s: string) => (found.push(s), null) })
  return { loc, found }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('P3-10: a Go to place is looked for only on its own page', () => {
  it('stops looking once the route changes', async () => {
    vi.useFakeTimers()
    const { loc, found } = stubDom()
    const { goTo } = await import('./navGo')
    goTo({ name: 'programs' }, '#app-activity-h')
    expect(loc.hash).toBe('#/programs')
    vi.advanceTimersByTime(160)
    expect(found.length).toBe(1)
    loc.hash = '#/usage' // the person went elsewhere
    vi.advanceTimersByTime(150 * 25)
    expect(found.length).toBe(1)
  })
  it('a newer goTo stops the older one', async () => {
    vi.useFakeTimers()
    const { found } = stubDom()
    const { goTo } = await import('./navGo')
    goTo({ name: 'usage' }, '#settle-h')
    goTo({ name: 'usage' }, '#limits-h')
    vi.advanceTimersByTime(150 * 3)
    expect(found.every((s) => s === '#limits-h')).toBe(true)
  })
})
