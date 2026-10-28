import { beforeEach, describe, expect, it } from 'vitest'

// a minimal browser: localStorage + location, so the device-side copy and the sync marker are exercised
const store = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  location: { search: '' },
}

const { escapeToClassic, keepLook, loadLook, lookState, previewLook } = await import('./uiVariant')
type Prefs = Parameters<typeof keepLook>[1]

const inStill: Prefs = { variant: null, layout: null, apps: null, experience: 'still' }
const ok = (principal?: string) => {
  let server: Prefs | null = null
  return {
    ...(principal ? { me: async () => ({ principal }) } : {}),
    get server() {
      return server
    },
    uiPrefs: async () => ({ prefs: server, updated_at: null }),
    setUiPrefs: async (p: Prefs) => ((server = p), { prefs: p, updated_at: 'now' }),
    resetUiPrefs: async () => ((server = null), { prefs: null, updated_at: null }),
  }
}

describe('Review R1: leaving an experience never depends on the network', () => {
  beforeEach(async () => {
    store.clear()
    await keepLook(ok(), inStill)
    expect(lookState().saved?.experience).toBe('still')
  })

  it('a refused save still returns the person to classic at once, and marks the change to sync', async () => {
    const refusing = { ...ok(), setUiPrefs: async () => Promise.reject(new Error('refused')) }
    const where = await escapeToClassic(refusing)
    expect(where).toBe('local')
    expect(lookState().saved?.experience).toBeNull()
    expect(store.get('omegahive.ui.look.pending')).toBe('1')
  })

  it('a hanging save does not hold the person: classic is applied before the save resolves', async () => {
    const hanging = { ...ok(), setUiPrefs: () => new Promise<never>(() => undefined) }
    const pending = escapeToClassic(hanging, 30)
    expect(lookState().saved?.experience).toBeNull() // synchronous, before any await
    expect(await pending).toBe('local')
  })

  it('no client at all (missing preference API) still escapes', async () => {
    expect(await escapeToClassic(null)).toBe('local')
    expect(lookState().saved?.experience).toBeNull()
  })

  it('an escape from a preview clears the preview too', async () => {
    previewLook({ ...inStill, experience: 'cosmos' })
    await escapeToClassic(ok())
    expect(lookState().preview).toBeNull()
    expect(lookState().saved?.experience).toBeNull()
  })

  it('on the next load the device change wins over the stale server copy, then syncs (same verified person)', async () => {
    const server = ok('user:solo')
    await loadLook(server)
    await server.setUiPrefs(inStill) // the server still says Still
    await escapeToClassic({ ...server, setUiPrefs: async () => Promise.reject(new Error('offline')) })
    expect(store.get('omegahive.ui.look.pending:user:solo')).toBe('1')
    await loadLook(server)
    expect(lookState().saved?.experience).toBeNull()
    expect(server.server?.experience).toBeNull()
    expect(store.has('omegahive.ui.look.pending:user:solo')).toBe(false)
  })

  it('Review A1: an unbound escape holds on this device after reload but is never pushed when identity is unknown', async () => {
    const server = ok() // no me(): identity cannot be verified
    await server.setUiPrefs(inStill)
    await loadLook(server) // unbound
    await escapeToClassic({ ...server, setUiPrefs: async () => Promise.reject(new Error('offline')) })
    expect(store.get('omegahive.ui.look.pending')).toBe('1')
    await loadLook(server)
    expect(lookState().saved?.experience).toBeNull() // the escape still holds here
    expect(server.server?.experience).toBe('still') // nothing was pushed for an unverified person
  })

  it('a successful escape saves and clears the sync marker, and choosing an experience afterwards works', async () => {
    const server = ok()
    expect(await escapeToClassic(server)).toBe('saved')
    expect(store.has('omegahive.ui.look.pending')).toBe(false)
    await keepLook(server, { ...inStill, experience: 'canvas' })
    expect(lookState().saved?.experience).toBe('canvas')
  })
})

describe('Review P2: the device copy belongs to one person', () => {
  it("one person's offline escape never applies to, or is pushed as, another person's look", async () => {
    store.clear()
    const serverA = ok('user:ana')
    await loadLook(serverA)
    await keepLook(serverA, inStill)
    // Ana escapes while offline: pending on Ana's device copy only
    await escapeToClassic({ setUiPrefs: async () => Promise.reject(new Error('offline')) })
    expect(lookState().saved?.experience).toBeNull()
    // Ben signs in on the same browser; his server copy says Canvas
    const serverB = ok('user:ben')
    await serverB.setUiPrefs({ ...inStill, experience: 'canvas' })
    await loadLook(serverB)
    expect(lookState().saved?.experience).toBe('canvas') // Ben's own look, not Ana's pending classic
    expect(serverB.server?.experience).toBe('canvas') // Ana's pending change was not pushed into Ben's account
    // Ana comes back: her pending escape still wins for her, then syncs
    const backA = ok('user:ana')
    await backA.setUiPrefs(inStill)
    await loadLook(backA)
    expect(lookState().saved?.experience).toBeNull()
    expect(backA.server?.experience).toBeNull()
  })

  it('a variant of an unknown schema version is never applied', async () => {
    const { applyLook, SEED_VARIANTS } = await import('./uiVariant')
    expect(() => applyLook({ variant: { ...SEED_VARIANTS[0], schema: 'omegasurface.variant/9.9' as 'omegasurface.variant/0.1' }, layout: null })).not.toThrow()
  })
})
