import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { LiveClient } from '../../api/live'
import { SimClient } from '../../api/sim/SimClient'
import type { EpochBinding } from '../../lib/identityEpoch'
import { isCurrent, releasePersons, signInAs, switchPerson, testPerson } from '../../lib/identityEpoch.testkit'
import { UnsupportedError } from '../../lib/useResource'
import { clearGoogleQuestion, clearGoogleSignIn, signInWords } from './clearGoogle'
import type { Person } from '../../api/client'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { peopleScreen, type Can, type StackItem } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** Surface: google_bound in plain words, and the admins' "Clear Google identity". Invented data only. */

const tomas = { id: 'p_tomas', name: 'Tomás Reyes', email: 'tomas@example.org' }

// metta-screens-people: the row is composed by MeTTa now (people.metta: people-person), so these draw that screen where
// they drew Row before; what they assert is unchanged
const space = ScreensSpace.open()
const ALL: Can = { invite: true, addMember: true, revokeInvite: true, updatePerson: true, clearGoogle: true, resetPassword: true, removePassword: true }
function personRow(google: boolean | undefined, { self = false, can = ALL, admin = true }: { self?: boolean; can?: Can; admin?: boolean } = {}) {
  const p: Person = { id: 'p_tomas', name: 'Tomás Reyes', email: 'tomas@example.org', role: 'member', invited_by: null, created_at: '', last_seen_at: null, disabled: false, google_bound: google }
  const { data } = peopleScreen({ status: 'ready', data: { people: [p], invites: [], google_ready: true }, error: undefined, refreshing: false },
    { admin, selfId: self ? p.id : null }, can, { invite: null, password: null }, {}, (screen, facts) => space.compose(screen, 'classic', facts))
  const item = (data['people.rows'] as StackItem[])[1]
  return renderToStaticMarkup(createElement(Screen, { plan: item.plan, host: { data: item.data, onAction: () => undefined } }))
}

describe('google_bound in the person view', () => {
  const row = (google?: boolean) => personRow(google)
  it('says "Signs in with Google" when bound', () => {
    expect(signInWords(true)).toBe('Signs in with Google')
    expect(row(true)).toContain('Signs in with Google')
  })
  it('says nothing when not bound or not reported', () => {
    expect(signInWords(false)).toBeNull()
    expect(signInWords(undefined)).toBeNull()
    expect(row(false)).not.toContain('Google')
    expect(row(undefined)).not.toContain('Google')
  })
  it('shows "Clear Google sign-in" only when the page offers it, never on your own row', () => {
    const offered = (self: boolean) => personRow(true, { self })
    expect(offered(false)).toContain('Clear Google sign-in')
    expect(offered(true)).not.toContain('Clear Google sign-in')
    expect(personRow(true, { can: { ...ALL, clearGoogle: false } })).not.toContain('Clear Google sign-in')
    expect(personRow(true, { admin: false })).not.toContain('Clear Google sign-in')
  })
})

describe('Clear Google identity', () => {
  it('admins only: a member never sees the question nor sends anything', async () => {
    const ask = vi.fn(async () => true)
    const clear = vi.fn(async () => ({}))
    expect(await clearGoogleSignIn(tomas, { admin: false, clear, ask, show: vi.fn() })).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('asks first with the agreed words, as a danger question', async () => {
    const ask = vi.fn(async () => false)
    await clearGoogleSignIn(tomas, { admin: true, clear: vi.fn(), ask, show: vi.fn() })
    expect(ask).toHaveBeenCalledWith("Clear Tomás Reyes's Google sign-in? They'll be signed out and must sign in with Google again to link an account.", 'Clear Google sign-in', expect.objectContaining({ danger: true, binding: expect.anything() }))
    expect(clearGoogleQuestion({ name: '', email: 'x@example.org' })).toContain("Clear x@example.org's Google sign-in?")
  })

  it('cancel: no PATCH', async () => {
    const clear = vi.fn(async () => ({}))
    expect(await clearGoogleSignIn(tomas, { admin: true, clear, ask: async () => false, show: vi.fn() })).toBeNull()
    expect(clear).not.toHaveBeenCalled()
  })

  it('confirm: one call, success in plain words', async () => {
    const clear = vi.fn(async () => ({}))
    const show = vi.fn()
    const reload = vi.fn()
    const shown = await clearGoogleSignIn(tomas, { admin: true, clear, ask: async () => true, show, reload })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith('p_tomas')
    expect(show).toHaveBeenCalledWith(shown)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(shown).toEqual({ tone: 'success', title: "Tomás Reyes's Google sign-in is cleared", body: "They've been signed out and will link an account the next time they sign in with Google." })
  })

  it('failures in plain words, never the host text', async () => {
    const cases: [unknown, string][] = [
      [new ApiError(403, 'forbidden', 'RAW-HOST-403'), 'Only admins can do this.'],
      [new ApiError(404, 'not_found', 'RAW-HOST-404'), 'That person is no longer in this hive.'],
      [new ApiError(0, 'network', 'RAW-NET'), 'Could not reach the hive. Check the connection and try again.'],
      [new ApiError(401, 'unauthorized', 'RAW-401'), 'Your sign-in ended. Sign in again, then try once more.'],
      [new ApiError(500, 'internal', 'RAW-HOST-500'), 'Nothing changed. Please try again.'],
      [new Error('RAW-ERR'), 'Nothing changed. Please try again.'],
    ]
    for (const [err, body] of cases) {
      const reload = vi.fn()
      const shown = await clearGoogleSignIn(tomas, { admin: true, clear: async () => { throw err }, ask: async () => true, show: vi.fn(), reload })
      expect(reload).not.toHaveBeenCalled()
      expect(shown).toEqual({ tone: 'error', title: "Could not clear Tomás Reyes's Google sign-in", body })
      expect(JSON.stringify(shown)).not.toContain('RAW')
    }
    const unsupported = await clearGoogleSignIn(tomas, { admin: true, clear: async () => { throw new UnsupportedError() }, ask: async () => true, show: vi.fn() })
    expect(unsupported?.title).toBe('Not available here')
  })
})

/**
 * Stand-in r1 P1: the identity is re-checked right before the PATCH and after it. A and B share one client (a
 * same-tab re-login), so a PATCH sent after the switch would go out under B's credential. Invented data only.
 */
describe('Clear Google identity is bound to the identity that asked', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
  afterEach(() => {
    releasePersons()
    vi.unstubAllGlobals()
  })

  it('"yes" arriving after a same-client switch to B: no PATCH, no toast, no reload', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const clear = vi.fn(async () => ({}))
    const show = vi.fn()
    const reload = vi.fn()
    // the question is answered "yes" for A, and B signs in on the same client before the continuation runs
    const ask = vi.fn(async () => {
      void switchPerson(a, b)
      return true
    })
    expect(await clearGoogleSignIn(tomas, { admin: true, clear, ask, show, reload })).toBeNull()
    expect(isCurrent(b)).toBe(true)
    expect(clear).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('a switch while the PATCH is in flight: no toast and no reload for B', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    let finish!: () => void
    const clear = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const show = vi.fn()
    const reload = vi.fn()
    const run = clearGoogleSignIn(tomas, { admin: true, clear, ask: async () => true, show, reload })
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
    void switchPerson(a, b)
    finish()
    expect(await run).toBeNull()
    expect(show).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('the real askConfirmBound gets the binding made before asking', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const ask = vi.fn(async (_m: string, _l?: string, opts?: { binding?: EpochBinding }) => !!opts?.binding?.current())
    const clear = vi.fn(async () => ({}))
    await clearGoogleSignIn(tomas, { admin: true, clear, ask, show: vi.fn() })
    expect(clear).toHaveBeenCalledTimes(1)
  })
})

describe('the request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('live: PATCH /api/people/{id} with exactly {"clear_google_identity": true}', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token', setItem: () => undefined, removeItem: () => undefined })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'p/1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const c = new LiveClient('http://hive.invalid')
    await c.clearGoogleIdentity('p/1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/api\/people\/p%2F1$/)
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ clear_google_identity: true })
  })

  it('sim (invented data): clearing unlinks the person; unknown people are a 404', async () => {
    const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    const before = (await sim.listPeople()).people.find((p) => p.id === 'p_tomas')
    expect(before?.google_bound).toBe(true)
    await sim.clearGoogleIdentity('p_tomas')
    expect((await sim.listPeople()).people.find((p) => p.id === 'p_tomas')?.google_bound).toBe(false)
    await expect(sim.clearGoogleIdentity('p_nobody')).rejects.toMatchObject({ status: 404 })
  })
})
