import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The gallery's (and the preview bar's) Keep is bound to the person it was pressed for (Request an experience r1b):
 * a save that lands after a sign-in change writes nothing on this page. The REAL store identity change (identityEpoch
 * testkit), synthetic SimClients and invented looks only.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

import type { UiPrefs } from './uiVariant'
const { DEFAULT_VARIANT, lookState, previewLook, resetLook, SEED_VARIANTS } = await import('./uiVariant')
const { keepLookBound } = await import('./keepBound')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')

function heldClient(opts: { refuse?: boolean } = {}) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  return {
    release: () => release(),
    async setUiPrefs(p: UiPrefs) {
      await gate
      if (opts.refuse) throw new Error('invalid_ui_variant')
      return { prefs: p, updated_at: 'now' }
    },
  }
}
const ember = SEED_VARIANTS.find((v) => v.id === 'ember-forge')!
const look = { variant: ember, layout: null, apps: null, experience: null }

beforeEach(async () => {
  await resetLook(null)
  mem.clear()
  previewLook(null)
})
afterEach(() => releasePersons())

describe('the gallery’s Keep is bound to the person it was pressed for', () => {
  it('kept for the same person: saved and applied, as before', async () => {
    const a = testPerson('kb-a')
    await signInAs(a)
    previewLook(look)
    const c = heldClient()
    const kept = keepLookBound(c, look)
    c.release()
    expect(await kept).toBe('kept')
    expect(lookState().saved?.variant?.id).toBe('ember-forge')
    expect(lookState().preview).toBeNull()
  })

  it.each([['another tab', false], ['the same tab (credential only)', true]] as const)('a save that lands after a switch (%s) writes nothing on this page', async (_n, sameTab) => {
    const a = testPerson(`kb-late-a-${sameTab}`)
    const b = sameTab ? testPerson(`kb-late-b-${sameTab}`, { sameTab: a }) : testPerson(`kb-late-b-${sameTab}`)
    await signInAs(a)
    const before = lookState().saved
    expect(before).toBeNull()
    previewLook(look)
    const c = heldClient()
    const kept = keepLookBound(c, look)
    const done = switchPerson(a, b)
    c.release()
    expect(await kept).toBe('stale')
    await done
    expect(lookState().saved?.variant?.id ?? 'default').not.toBe('ember-forge')
    expect(lookState().saved).toBe(before)
    expect([...mem.values()].some((v) => v.includes('ember-forge'))).toBe(false)
  })

  it('a refusal for the person still signed in rejects as before; after a switch it is stale, not an error', async () => {
    const a = testPerson('kb-ref-a')
    const b = testPerson('kb-ref-b')
    await signInAs(a)
    const c1 = heldClient({ refuse: true })
    const k1 = keepLookBound(c1, look)
    c1.release()
    await expect(k1).rejects.toThrow('invalid_ui_variant')
    const c2 = heldClient({ refuse: true })
    const k2 = keepLookBound(c2, { ...look, variant: DEFAULT_VARIANT })
    const done = switchPerson(a, b)
    c2.release()
    expect(await k2).toBe('stale')
    await done
  })
})
