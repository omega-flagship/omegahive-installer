// Purpose: tests what a report gathers as the person uses the hive: the page's recent errors (lib/recentErrors.ts), named
// by route with every id left out and kept to a bound, and the screens visited (trail.ts), by name only.
import { afterEach, describe, expect, it } from 'vitest'
import { clearPageErrors, KEEP_PAGE_ERRORS, noteError, pageErrors, raisedAt, routeOf, watchPageErrors } from '../../lib/recentErrors'
import { KEEP_SCREENS, noteScreen, pageOf, screenName, screensVisited, stepsOf } from './trail'

afterEach(() => clearPageErrors())

describe("the page's recent errors", () => {
  it.each([
    ['/api/agents/a_7f3k2/messages?after=4', '/api/agents/:id/messages'],
    ['/api/swarms/s1/beliefs', '/api/swarms/:id/beliefs'],
    ['/api/dot/c_a_vega01~user:u_ab/turns', '/api/dot/:id/turns'],
    ['/api/apps/omegadesign/drafts/deck%201', '/api/apps/omegadesign/drafts/:id'],
    ['/api/hive', '/api/hive'],
    ['/dot/a_vega01/chat', '/dot/:id/chat'],
  ])('%s is %s', (path, route) => {
    expect(routeOf(path)).toBe(route)
  })
  it('keeps the newest, up to its bound, each stamped to the second', () => {
    for (let i = 0; i < KEEP_PAGE_ERRORS + 5; i++) noteError({ kind: 'request', where: `GET /api/x${i}`, message: 'm' })
    expect(pageErrors()).toHaveLength(KEEP_PAGE_ERRORS)
    expect(pageErrors()[0].where).toBe('GET /api/x5')
    expect(pageErrors()[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  })
  it('names where the page raised an error by its file and line, never the address it was served from', () => {
    expect(raisedAt('TypeError: x\n    at draw (https://hive.example.org/assets/Screen-ab12.js:812:7)')).toBe('Screen-ab12.js:812')
    expect(raisedAt(undefined)).toBe('')
  })
  it('notes errors nothing caught, and stops when told', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const target = { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), removeEventListener: (t: string) => delete listeners[t] } as unknown as Window
    const stop = watchPageErrors(target)
    listeners.error({ error: new Error('boom'), message: 'boom', filename: '', lineno: 0 })
    listeners.unhandledrejection({ reason: 'nobody caught this' })
    expect(pageErrors().map((e) => [e.kind, e.message])).toEqual([['page', 'boom'], ['page', 'nobody caught this']])
    stop()
    expect(Object.keys(listeners)).toEqual([])
  })
})

describe('the screens visited', () => {
  it('names a screen and its tab, and a page with every id left out', () => {
    expect(screenName('#/dot/a_vega01/chat')).toBe('dot · chat')
    expect(pageOf('#/dot/a_vega01/chat')).toBe('dot · chat (#/dot/:id/chat)')
    expect(pageOf('')).toBe('hive (#/)')
  })
  it('counts the same screen twice in a row once, keeps the newest, and turns them into steps to edit', () => {
    for (const h of ['#/', '#/', '#/settings', '#/dot/a_1/chat', '#/dot/a_2/chat']) noteScreen(h)
    expect(screensVisited().slice(-3)).toEqual(['hive', 'settings', 'dot · chat'])
    for (let i = 0; i < KEEP_SCREENS + 3; i++) noteScreen(i % 2 ? '#/settings' : '#/people')
    expect(screensVisited()).toHaveLength(KEEP_SCREENS)
    expect(stepsOf(['hive', 'settings'])).toBe('1. Opened hive\n2. Opened settings')
    expect(stepsOf([])).toBe('')
  })
})
