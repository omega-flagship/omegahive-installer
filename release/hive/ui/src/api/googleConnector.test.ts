import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from './types'
import { GOOGLE_CALENDAR_SCOPE, bindGoogleView, googleMindConsent, googleRevocationWords, googleTopLevelWindow, isGoogleConnectorReturn, ownGoogleMinds, readGoogleAuthorization, readGoogleConnectorStatus, readGoogleRevocation, startGoogleAuthorization } from './googleConnector'
import { LiveClient } from './live'

const status = { ready: true, connected: true, backend: 'B', allowed_minds: ['a_own'], calendar_scope: GOOGLE_CALENDAR_SCOPE }
const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&state=synthetic&code_challenge=synthetic&code_challenge_method=S256'

describe('safe current-person Google metadata', () => {
  it('keeps only safe fields and never returns OAuth credentials', () => {
    const answer = readGoogleConnectorStatus({ ...status, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', client_secret: 'synthetic-secret' })
    expect(answer).toEqual(status)
    expect(Object.keys(answer!)).toEqual(['ready', 'connected', 'backend', 'allowed_minds', 'calendar_scope'])
    expect(JSON.stringify(answer)).not.toContain('synthetic-')
  })
  it('fails closed for malformed or ambiguous grants and a wider scope', () => {
    for (const bad of [{ ...status, connected: 'yes' }, { ...status, allowed_minds: ['a_own', 'a_own'] }, { ...status, allowed_minds: [null] }, { ...status, calendar_scope: 'https://www.googleapis.com/auth/calendar' }, { ...status, backend: 'A' }]) {
      expect(readGoogleConnectorStatus(bad)).toBeNull()
    }
  })
  it('lists exact own minds only, without treating visibility or admin flags as ownership', () => {
    const agents = [
      { id: 'a_own', name: 'Own', kind: 'omega', owner: 'user:one' },
      { id: 'a_iter', name: 'Iter', kind: 'iter', owner: 'user:one' },
      { id: 'a_other', kind: 'omega', owner: 'user:two', is_mine: true, personal_of: 'user:one' },
      { id: 'a_public', kind: 'omega', visibility: 'public' },
      { id: 'a_module', kind: 'module', owner: 'user:one' },
    ] as Agent[]
    expect(ownGoogleMinds(agents, 'user:one').map((a) => a.id)).toEqual(['a_own', 'a_iter'])
    expect(ownGoogleMinds(agents, 'user:admin')).toEqual([])
    expect(googleMindConsent('a_own', false)).toEqual({ allowed: false })
    expect(() => googleMindConsent('a_own', 'yes' as unknown as boolean)).toThrow()
    expect(() => googleMindConsent('../a_other', true)).toThrow()
  })
  it('keeps local disconnect separate from unconfirmed Google revocation', () => {
    expect(readGoogleRevocation({ revocation: 'unconfirmed', refresh_token: 'synthetic' })).toBe('unconfirmed')
    expect(readGoogleRevocation({ revocation: { toString: () => 'confirmed' } })).toBeNull()
    expect(googleRevocationWords('unconfirmed')).toContain('could not be confirmed')
    expect(googleRevocationWords('confirmed')).toContain('Google confirmed')
    expect(googleRevocationWords('not_needed')).toContain('no saved grant')
  })
})

describe('authenticated top-level authorization navigation', () => {
  it('accepts only the fixed Google authorization endpoint, without tokens in its URL', () => {
    expect(readGoogleAuthorization({ authorization_url: url })).toBe(url)
    expect(readGoogleAuthorization({ authorization_url: url, access_token: 'synthetic' })).toBeNull()
    for (const invalid of ['javascript:alert(1)', 'https://other.invalid/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'https://user@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth#fragment', 'https://accounts.google.com/other', url + '&access_token=synthetic', url + '&client_secret=synthetic']) {
      expect(readGoogleAuthorization({ authorization_url: invalid })).toBeNull()
    }
  })
  it('never starts OAuth in a frame, and never navigates an earlier identity after an await', async () => {
    const self = {}
    expect(googleTopLevelWindow({ top: self, self })).toBe(true)
    expect(googleTopLevelWindow({ top: {}, self })).toBe(false)
    expect(googleTopLevelWindow({ top: self, self, fence: {} })).toBe(false)
    let current = true
    const binding = { current: () => current, commit<T>(write: () => T) { if (current) return write() } }
    const start = vi.fn(async () => ({ authorization_url: url })), go = vi.fn()
    await expect(startGoogleAuthorization(start, binding, () => false, go)).rejects.toThrow('full hive window')
    expect(start).not.toHaveBeenCalled()
    let resolve!: (v: unknown) => void
    const held = new Promise<unknown>((r) => { resolve = r })
    const pending = startGoogleAuthorization(() => held, binding, () => true, go)
    current = false; resolve({ authorization_url: url }); await pending
    expect(go).not.toHaveBeenCalled()
    await startGoogleAuthorization(start, binding, () => true, go)
    expect(start).not.toHaveBeenCalled()
  })
  it('rechecks the top-level boundary at navigation and does not manufacture callback success', async () => {
    const binding = { current: () => true, commit<T>(write: () => T) { return write() } }
    let top = true
    const go = vi.fn()
    await expect(startGoogleAuthorization(async () => { top = false; return { authorization_url: url } }, binding, () => top, go)).rejects.toThrow('full hive window')
    expect(go).not.toHaveBeenCalled()
    await startGoogleAuthorization(async () => ({ authorization_url: url }), binding, () => true, go)
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(url)
    expect(isGoogleConnectorReturn('?google_connector=connected')).toBe(true)
    expect(isGoogleConnectorReturn('?google_connector_error=cancelled')).toBe(true)
    expect(isGoogleConnectorReturn('?google_connector_error=provider-secret')).toBe(false)
    expect(isGoogleConnectorReturn('?code=synthetic&state=synthetic')).toBe(false)
  })
  it('retires pending navigation and completion writes when the profile unmounts under the same identity', async () => {
    let mounted = true
    const identity = { current: () => true, commit<T>(write: () => T) { return write() } }
    const view = bindGoogleView(identity, () => mounted), go = vi.fn(), paint = vi.fn()
    let resolve!: (v: unknown) => void
    const response = new Promise<unknown>((r) => { resolve = r })
    const pending = startGoogleAuthorization(() => response, view, () => true, go)
    mounted = false; resolve({ authorization_url: url }); await pending
    view.commit(paint)
    expect(view.current()).toBe(false)
    expect(go).not.toHaveBeenCalled()
    expect(paint).not.toHaveBeenCalled()
  })
})

let calls: { url: string; method: string; body: unknown }[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('window', { location: { href: 'https://hive.invalid/', search: '' }, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('host client connector routes', () => {
  it('sends only the closed bodies, never a caller principal, and keeps the client secret on the admin route', async () => {
    const c = new LiveClient('https://hive.invalid')
    await c.googleConnector()
    await c.startGoogleConnector()
    await c.setGoogleConnectorMind('a_own', true)
    await c.disconnectGoogleConnector()
    await c.configureGoogleConnector('synthetic-client-id', 'synthetic-client-secret')
    expect(calls).toEqual([
      { url: 'https://hive.invalid/api/connectors/google', method: 'GET', body: undefined },
      { url: 'https://hive.invalid/api/connectors/google/start', method: 'POST', body: {} },
      { url: 'https://hive.invalid/api/connectors/google/minds/a_own', method: 'PUT', body: { allowed: true } },
      { url: 'https://hive.invalid/api/connectors/google/disconnect', method: 'POST', body: {} },
      { url: 'https://hive.invalid/api/connectors/google/config', method: 'POST', body: { client_id: 'synthetic-client-id', client_secret: 'synthetic-client-secret' } },
    ])
  })
  it('refuses malformed consent locally before a request is sent', () => {
    const c = new LiveClient('https://hive.invalid')
    expect(() => c.setGoogleConnectorMind('../other', true)).toThrow()
    expect(() => c.setGoogleConnectorMind('a_own', undefined as unknown as boolean)).toThrow()
    expect(calls).toEqual([])
  })
})
