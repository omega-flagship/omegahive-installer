import { describe, expect, it, vi } from 'vitest'
import { isPageRoute, PAGE_ROUTES } from '../lib/router'
import { geometry } from './layout'
import { asOwnChoice, blockedReason, CHOSEN_BY_YOU, COLOR_KEYS, DEFAULT_VARIANT, effectiveLayout, keepLook, loadLook, lookState, lookVars, LEGACY_SEED_AUTHOR_SHA256, ownVariant, resetLook, SEED_VARIANTS, type UiPrefs, type UiPrefsResponse, withExperience } from './uiVariant'

// vi.mock is hoisted: the factory names its own literals
const LEGACY_STAND_IN = 'Surface seed (legacy stand-in)'
vi.mock('../lib/askMemory/hash', async (actual) => {
  const real = await actual<typeof import('../lib/askMemory/hash')>()
  return { ...real, sha256: (t: string) => (t === 'Surface seed (legacy stand-in)' ? 'c4abd51eca8539ce55d40cc06a27e159473d7e811fbf444f777e51478477d9ed' : real.sha256(t)) }
})

function fakeClient(opts: { refuse?: boolean } = {}) {
  let stored: UiPrefs | null = null
  return {
    get stored() {
      return stored
    },
    uiPrefs: async (): Promise<UiPrefsResponse> => ({ prefs: stored, updated_at: null }),
    setUiPrefs: async (p: UiPrefs): Promise<UiPrefsResponse> => {
      if (opts.refuse) throw new Error('invalid_ui_variant')
      stored = p
      return { prefs: p, updated_at: 'now' }
    },
    resetUiPrefs: async (): Promise<UiPrefsResponse> => {
      stored = null
      return { prefs: null, updated_at: null }
    },
  }
}

describe('UI variants', () => {
  it('only the exact earlier seed author still reads as the seed; an edited author keeps the look theirs (demo D1 r2)', () => {
    const deep = SEED_VARIANTS.find((v) => v.id === 'deep-sea')!
    expect(deep.author).toBe('Surface seed look')
    // the earlier wording lives only as its digest, pinned here independently (sha256 of the pre-D1 seed author)
    expect(LEGACY_SEED_AUTHOR_SHA256).toBe('c4abd51eca8539ce55d40cc06a27e159473d7e811fbf444f777e51478477d9ed')
    // a stand-in whose hash plays the earlier wording's (the mocked sha256 above), so no test carries that wording
    const legacy = { ...deep, author: LEGACY_STAND_IN }
    expect(asOwnChoice(deep, 'cosmos').author).toBe(CHOSEN_BY_YOU)
    expect(asOwnChoice(legacy, 'cosmos').author).toBe(CHOSEN_BY_YOU)
    expect(ownVariant({ variant: legacy, layout: null, apps: null, experience: 'cosmos' })).toBeNull()
    for (const author of ['Surface seed edited by me', 'Surface seed (an earlier wording)', 'someone else', CHOSEN_BY_YOU]) {
      const edited = { ...deep, author }
      expect(asOwnChoice(edited, 'cosmos').author).toBe(author)
      const saved = { variant: edited, layout: null, apps: null, experience: 'cosmos' }
      expect(ownVariant(saved)).toEqual(edited) // the person's own, not the companion
      expect(withExperience(saved, 'classic').variant).toEqual(edited) // leaving the experience keeps it
    }
    expect(asOwnChoice({ ...legacy, density: deep.density === 'roomy' ? 'compact' : 'roomy' }, 'cosmos').author).toBe(legacy.author)
  })

  it('the digest helper is real SHA-256 (FIPS 180-2 vectors), so the pinned digest means the exact earlier wording', async () => {
    const { sha256 } = await vi.importActual<typeof import('../lib/askMemory/hash')>('../lib/askMemory/hash')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('ships five seeds, each with every colour token', () => {
    expect(SEED_VARIANTS).toHaveLength(5)
    for (const v of [DEFAULT_VARIANT, ...SEED_VARIANTS]) {
      expect(Object.keys(v.colors).sort()).toEqual([...COLOR_KEYS].sort())
      const vars = lookVars(v)
      for (const k of COLOR_KEYS) expect(vars[`--color-${k}`]).toBe(v.colors[k])
    }
  })

  it('only offers looks that render correctly today', () => {
    const blocked = SEED_VARIANTS.filter((v) => blockedReason(v)).map((v) => v.id)
    expect(blocked).toEqual(['paper'])
    expect(blockedReason(DEFAULT_VARIANT)).toBeNull()
  })

  it('a layout override beats the variant, which beats the side rail', () => {
    const deep = SEED_VARIANTS.find((v) => v.id === 'deep-sea')!
    expect(effectiveLayout(null)).toBe('rail')
    expect(effectiveLayout({ variant: deep, layout: null })).toBe('dock')
    expect(effectiveLayout({ variant: deep, layout: 'topbar' })).toBe('topbar')
    expect(effectiveLayout({ variant: null, layout: 'dock' })).toBe('dock')
  })

  it('keeps a look only once the server accepted it, and resets', async () => {
    const c = fakeClient()
    await loadLook(c)
    expect(lookState().available).toBe(true)
    const p = { variant: SEED_VARIANTS[0], layout: null }
    await keepLook(c, p)
    expect(lookState().saved?.variant?.id).toBe(SEED_VARIANTS[0].id)
    expect(c.stored).toEqual(p)
    await resetLook(c)
    expect(lookState().saved).toBeNull()
    expect(c.stored).toBeNull()

    const refusing = fakeClient({ refuse: true })
    await expect(keepLook(refusing, p)).rejects.toThrow('invalid_ui_variant')
    expect(lookState().saved).toBeNull()
  })

  it('hides Change UI when the client cannot store a look', async () => {
    await loadLook({})
    expect(lookState().available).toBe(false)
  })
})

describe('layout geometry', () => {
  it('leaves room for each navigation', () => {
    const rail = geometry('rail', true)
    expect(rail.railX).toBe(236)
    expect(geometry('rail', false).inset.left).toBe(72)
    const top = geometry('topbar', false)
    expect(top.pageTop).toBeGreaterThan(rail.pageTop)
    expect(top.railX).toBe(12)
    const dock = geometry('dock', false)
    expect(dock.pageBottom).toBeGreaterThan(rail.pageBottom)
    expect(dock.hudBottom).toBe(dock.pageBottom)
    expect(dock.inset.bottom).toBeGreaterThan(dock.hudBottom)
  })
})

describe('page routes', () => {
  it('is one list, including Lifecycle (which the rail used to miss)', () => {
    expect(isPageRoute('lifecycle')).toBe(true)
    expect(isPageRoute('hive')).toBe(false)
    expect(isPageRoute('dot')).toBe(false)
    expect(new Set(PAGE_ROUTES).size).toBe(PAGE_ROUTES.length)
  })
})
