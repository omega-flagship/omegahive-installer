import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The saved look follows the signed-in person (Request an experience r1d): on a sign-in change A's saved look leaves
 * the screen at once and B's loads; a late load of A's look after the change applies nothing. The REAL store identity
 * change (identityEpoch testkit), synthetic SimClients, invented principals and looks only.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
vi.stubGlobal('localStorage', storage)
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

import type { UiPrefs, UiPrefsResponse } from './uiVariant'
const { escapeToClassic, keepLook, lookState, resetLook, SEED_VARIANTS, subscribeLook } = await import('./uiVariant')
const { loadLookBound } = await import('./lookIdentity')
const { isCurrent, releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
type Person = ReturnType<typeof testPerson>

const lookOf = (id: string): UiPrefs => ({ variant: SEED_VARIANTS.find((v) => v.id === id)!, layout: null, apps: null, experience: null })
const LOOK_A = lookOf('ember-forge')
const LOOK_B = lookOf('deep-sea')
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Each person's own identity and saved look on the client(s) they use; A's look can be held to arrive late. */
function hostFor(a: Person, b: Person) {
  const held: { release: () => void } = { release: () => undefined }
  let holdA = false
  const answer = (p: Person) => async (): Promise<UiPrefsResponse> => {
    const forA = p === a ? isCurrent(a) : !isCurrent(b)
    if (forA && holdA) await new Promise<void>((r) => (held.release = r))
    return { prefs: forA ? LOOK_A : LOOK_B, updated_at: null }
  }
  for (const p of [a, b]) {
    Object.assign(p.client, {
      me: async () => ({ principal: (p === a ? isCurrent(a) : !isCurrent(b)) ? 'user:p_inv_look_a' : 'user:p_inv_look_b' }),
      uiPrefs: answer(p),
    })
  }
  return { held, hold: (on: boolean) => void (holdA = on) }
}

beforeEach(() => {
  mem.clear()
  loc.search = ''
})
afterEach(() => releasePersons())

describe('the saved look follows the signed-in person', () => {
  it.each([['the same tab (credential only)', true], ['another tab', false]] as const)('switch on %s: A’s saved look is gone at once, and B’s loads', async (_n, sameTab) => {
    const a = testPerson(`look-a-${sameTab}`)
    const b = sameTab ? testPerson(`look-b-${sameTab}`, { sameTab: a }) : testPerson(`look-b-${sameTab}`)
    hostFor(a, b)
    await signInAs(a)
    await loadLookBound(a.client)
    expect(lookState().saved?.variant?.id).toBe('ember-forge')

    const done = switchPerson(a, b)
    expect(lookState().saved).toBeNull() // A's look left the screen inside the change
    expect(lookState().preview).toBeNull()
    await done
    await settle()
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
  })

  it('a late load of A’s look, answered after the switch, is NEVER shown (Kimi K2: every state recorded, B’s load awaited)', async () => {
    const a = testPerson('late-look-a')
    const b = testPerson('late-look-b', { sameTab: a })
    const h = hostFor(a, b)
    await signInAs(a)
    await loadLookBound(a.client)
    h.hold(true)
    const lateA = loadLookBound(a.client) // asked under A; its answer is held
    await settle()
    const shown: string[] = []
    const record = () => void shown.push(`${lookState().saved?.variant?.id ?? 'none'}|${lookState().preview?.variant?.id ?? 'none'}`)
    const off = subscribeLook(record)
    try {
      const done = switchPerson(a, b)
      h.hold(false)
      // A's answer arrives first, before B's own look has loaded: it must not win even for a moment
      h.held.release()
      await lateA
      await done
      // B's load, awaited explicitly (not left to the identity hook's timing)
      await loadLookBound(b.client)
      await settle()
    } finally {
      off()
    }
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.filter((x) => x.includes('ember-forge'))).toEqual([])
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
    expect(mem.get('omegahive.ui.look:user:p_inv_look_b') ?? '').not.toContain('ember-forge')
  })

  it('the pending replay is A’s own (Kimi K1): it pushes A’s copy, and a late end never touches B', async () => {
    const a = testPerson('replay-a')
    const b = testPerson('replay-b', { sameTab: a })
    hostFor(a, b)
    const pushed: UiPrefs[] = []
    let release: () => void = () => undefined
    Object.assign(a.client, {
      setUiPrefs: (p: UiPrefs) => {
        pushed.push(p)
        return new Promise((r) => (release = () => r({ prefs: p, updated_at: 'now' })))
      },
    })
    await signInAs(a)
    // A changed their look offline on this device earlier: their own copy, marked pending
    mem.set('omegahive.ui.look:user:p_inv_look_a', JSON.stringify(lookOf('phosphor')))
    mem.set('omegahive.ui.look.pending:user:p_inv_look_a', '1')
    const replay = loadLookBound(a.client)
    await settle()
    expect(pushed.map((p) => p.variant?.id)).toEqual(['phosphor']) // A's own copy (captured as A's before the push)
    await switchPerson(a, b)
    await loadLookBound(b.client)
    mem.set('omegahive.ui.look.pending:user:p_inv_look_b', '1')
    release() // A's push ends now
    await replay
    await settle()
    expect(mem.get('omegahive.ui.look.pending:user:p_inv_look_b')).toBe('1')
    expect(mem.get('omegahive.ui.look:user:p_inv_look_b') ?? '').not.toContain('phosphor')
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
  })
})

describe('r1e: nothing unproven survives an identity change, and no late write lands on the next person', () => {
  it('[P1] me() failed for A, the server’s look for A is on screen: an identity change clears it at once', async () => {
    const a = testPerson('nome-a')
    const b = testPerson('nome-b', { sameTab: a })
    hostFor(a, b)
    // A's identity cannot be read: the load binds nobody, and the server's prefs (A's) show
    Object.assign(a.client, { me: async () => Promise.reject(new Error('me unavailable')) })
    await signInAs(a)
    await loadLookBound(a.client)
    expect(lookState().saved?.variant?.id).toBe('ember-forge')
    const done = switchPerson(a, b)
    expect(lookState().saved).toBeNull()
    await done
  })

  /** A client whose look calls wait to be released; every other call answers at once. */
  function slowFor(a: Person, b: Person) {
    hostFor(a, b)
    const gates: (() => void)[] = []
    const later = <T>(v: T) => new Promise<T>((r) => gates.push(() => r(v)))
    Object.assign(a.client, {
      resetUiPrefs: () => later({ prefs: null, updated_at: null }),
      setUiPrefs: (p: UiPrefs) => later({ prefs: p, updated_at: 'now' }),
    })
    return { releaseAll: () => gates.splice(0).forEach((g) => g()) }
  }
  const B_PENDING = 'omegahive.ui.look.pending:user:p_inv_look_b'

  it.each([
    ['?ui=default (the reset load)', 'url'],
    ['Reset to default', 'reset'],
    ['Back to the classic hive (escape)', 'escape'],
    ['a keep (unbound caller)', 'keep'],
  ] as const)('[P2] %s for A, answered after the switch: B’s pending marker survives, and A’s answer changes nothing on screen', async (_n, kind) => {
    const a = testPerson(`p2-a-${kind}`)
    const b = testPerson(`p2-b-${kind}`, { sameTab: a })
    const slow = slowFor(a, b)
    await signInAs(a)
    await loadLookBound(a.client)
    expect(lookState().saved?.variant?.id).toBe('ember-forge')
    if (kind === 'url') loc.search = '?ui=default'
    const late =
      kind === 'url' ? loadLookBound(a.client) : kind === 'reset' ? resetLook(a.client) : kind === 'escape' ? escapeToClassic(a.client) : keepLook(a.client, lookOf('phosphor'))
    await settle()
    loc.search = ''
    const done = switchPerson(a, b)
    await done
    await settle()
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
    // B has a change of their own waiting to reach the server
    mem.set(B_PENDING, '1')
    slow.releaseAll() // A's answer lands now
    await late
    await settle()
    expect(mem.get(B_PENDING)).toBe('1')
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
  })
})
