import { beforeEach, describe, expect, it } from 'vitest'

// Review A1 (OmegaReview probe omegareview-surface-owner-unknown-probe.test.ts, kept verbatim in spirit): a rejected or
// absent me() must never replay an identity-bound pending cache/marker to the server.
const storage = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
  location: { search: '' },
}
const { loadLook, keepLook, escapeToClassic, lookState } = await import('./uiVariant')
type Prefs = Parameters<typeof keepLook>[1]
const still: Prefs = { variant: null, layout: null, apps: null, experience: 'still' }

/** A person's server: their own stored prefs, every write recorded. */
function server(principal: string | null | 'refuse', initial: Prefs | null = null) {
  let stored = initial
  const writes: (Prefs | 'reset')[] = []
  return {
    writes,
    get stored() {
      return stored
    },
    ...(principal === null ? {} : { me: async () => (principal === 'refuse' ? Promise.reject(new Error('identity lookup unavailable')) : { principal }) }),
    uiPrefs: async () => ({ prefs: stored, updated_at: null }),
    setUiPrefs: async (p: Prefs) => (writes.push(p), (stored = p), { prefs: p, updated_at: null }),
    resetUiPrefs: async () => (writes.push('reset'), (stored = null), { prefs: null, updated_at: null }),
  }
}

/** Ana saves Still, then escapes while offline: a pending marker on Ana's keys. */
async function anaEscapesOffline() {
  const a = server('user:ana')
  await loadLook(a)
  await keepLook(a, still)
  await escapeToClassic({ ...a, setUiPrefs: async () => Promise.reject(new Error('offline')) })
  expect(storage.get('omegahive.ui.look.pending:user:ana')).toBe('1')
  return a
}

describe('Review A1: unknown identity never replays another person’s pending look', () => {
  beforeEach(() => storage.clear())

  // the exact Review probe: expected zero preference writes
  for (const missing of [false, true])
    it(`does not replay another person's pending prefs when me is ${missing ? 'absent' : 'refused'}`, async () => {
      await anaEscapesOffline()
      const anaKeys = [...storage.entries()].filter(([k]) => k.endsWith(':user:ana'))
      const b = server(missing ? null : 'refuse', { ...still, experience: 'canvas' })
      await loadLook(b)
      expect(b.writes).toHaveLength(0)
      // the server's own prefs for this session are shown, and Ana's device copy and marker are untouched
      expect(lookState().saved?.experience).toBe('canvas')
      expect([...storage.entries()].filter(([k]) => k.endsWith(':user:ana'))).toEqual(anaKeys)
    })

  it('a later escape while unbound writes only the unbound device copy, never Ana’s keys', async () => {
    await anaEscapesOffline()
    const anaKeys = [...storage.entries()].filter(([k]) => k.endsWith(':user:ana'))
    const b = server('refuse', still)
    await loadLook(b)
    await escapeToClassic({ ...b, setUiPrefs: async () => Promise.reject(new Error('offline')) })
    expect(storage.get('omegahive.ui.look.pending')).toBe('1')
    expect([...storage.entries()].filter(([k]) => k.endsWith(':user:ana'))).toEqual(anaKeys)
    await loadLook(b)
    expect(b.writes).toHaveLength(0)
    expect(lookState().saved?.experience).toBeNull()
  })

  it('a hanging identity lookup is treated as unknown (no replay)', async () => {
    await anaEscapesOffline()
    const b = { ...server('user:x'), me: () => new Promise<never>(() => undefined) }
    // withTimeout uses the save timeout; do not wait for it here, only check nothing was pushed meanwhile
    void loadLook(b)
    await Promise.resolve()
    expect(b.writes).toHaveLength(0)
  })

  it('the verified owner of the pending change still gets it replayed; a switch to Ben does not', async () => {
    await anaEscapesOffline()
    const ben = server('user:ben', { ...still, experience: 'canvas' })
    await loadLook(ben)
    expect(ben.writes).toHaveLength(0)
    expect(lookState().saved?.experience).toBe('canvas')
    const anaAgain = server('user:ana', still)
    await loadLook(anaAgain)
    expect(anaAgain.writes).toHaveLength(1)
    expect(anaAgain.stored?.experience).toBeNull()
    expect(storage.has('omegahive.ui.look.pending:user:ana')).toBe(false)
  })
})
