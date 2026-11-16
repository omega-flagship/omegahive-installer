import { beforeEach, describe, expect, it, vi } from 'vitest'

// Small things (SMALL_THINGS_AUDIT_20261008): an experience's companion look is an implementation detail. INVENTED
// data only; a minimal browser (localStorage, location, matchMedia) so the look store and the shell render on a server.
const store = new Map<string, string>()
vi.stubGlobal('window', {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  location: { search: '', hash: '#/' },
  matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  innerWidth: 1440,
  innerHeight: 900,
})

const look = await import('./uiVariant')
const { escapeToClassic, keepLook, loadLook, lookState, previewLook, resetLook, SEED_VARIANTS } = look
const { applyLookPatch } = await import('../lib/intent')
const { proposedLook } = await import('../store/ask')
const { EXPERIENCES } = await import('../experiences/registry')
const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')
const ChangeUi = (await import('./ChangeUi')).default
const { LookPreviewBar } = await import('./LookPreviewBar')
const { LookSection } = await import('./LookSection')
type Prefs = import('./uiVariant').UiPrefs

const server = () => {
  let held: Prefs | null = null
  return {
    uiPrefs: async () => ({ prefs: held, updated_at: null }),
    setUiPrefs: async (p: Prefs) => ((held = p), { prefs: p, updated_at: 'now' }),
    resetUiPrefs: async () => ((held = null), { prefs: null, updated_at: null }),
  }
}
const seed = (id: string) => SEED_VARIANTS.find((v) => v.id === id)!
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const render = (c: () => unknown) => text(renderToStaticMarkup(createElement(c as never)))
/** each look card's name and its status ("Yours", "Previewing" or nothing), as the gallery draws them */
const cards = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/<span class="flex-1 truncate text-\[14px\][^"]*">([^<]+)<\/span>(?:<span[^>]*>([^<]*)<\/span>)?/g)].map((m) => [m[1], m[2] ?? '']))

// the three experiences that carry a companion look, and the seed each one wears
const COMPANIONS = [
  { id: 'cosmos', name: 'Cosmos', seed: 'deep-sea' },
  { id: 'construct', name: 'Construct', seed: 'phosphor' },
  { id: 'flux', name: 'Flux', seed: 'sakura-night' },
]

beforeEach(async () => {
  store.clear()
  previewLook(null)
  await resetLook(server())
  await loadLook(server()) // a hive that stores looks, so You & your keys shows its Look and layout section
  await keepLook(server(), { variant: null, layout: null, apps: null, experience: null })
})

describe('F1: an experience is called by its own name, never its companion look', () => {
  for (const x of COMPANIONS) {
    describe(x.name, () => {
      const companion = seed(x.seed).name
      it('the gallery, the Ask and a proposal make the same choice, and keep the person’s own look', () => {
        const mine: Prefs = { variant: seed('ember-forge'), layout: null, apps: null, experience: null }
        const gallery = look.withExperience(mine, x.id)
        expect(gallery).toEqual({ variant: seed('ember-forge'), layout: null, apps: null, experience: x.id })
        expect(applyLookPatch(mine, { kind: 'experience', id: x.id }, look.DEFAULT_VARIANT, SEED_VARIANTS)).toEqual(gallery)
        expect(proposedLook({ experience: x.id }, mine, EXPERIENCES).next).toEqual(gallery)
      })

      it('previewing it names it in the preview bar and the gallery, and marks no look card as previewing', () => {
        previewLook(look.withExperience(null, x.id))
        expect(look.wornVariant(lookState().preview)?.id).toBe(x.seed) // classic pages still wear the companion
        const bar = render(LookPreviewBar)
        expect(bar).toContain(`Previewing ${x.name}`)
        expect(bar).not.toContain(companion)
        const html = renderToStaticMarkup(createElement(ChangeUi))
        expect(cards(html)[companion]).toBe('')
        expect(cards(html)['OmegaHive']).toBe('Yours') // the person's own Classic look, remembered
        expect(text(html)).toContain(`Keep ${x.name}`)
        expect(text(html)).toContain(`${x.name} brings its own look`)
      })

      it('kept, You & your keys says the experience, not the seed', async () => {
        await keepLook(server(), look.withExperience(null, x.id))
        const section = render(LookSection)
        expect(section).toContain(`${x.name} ·`)
        expect(section).not.toContain(companion)
      })

      it('leaving it restores the person’s own look (Ω → Back to the Classic hive)', async () => {
        await keepLook(server(), { variant: seed('ember-forge'), layout: null, apps: null, experience: null })
        await keepLook(server(), look.withExperience(lookState().saved, x.id))
        await escapeToClassic(server())
        expect(lookState().saved?.experience).toBeNull()
        expect(lookState().saved?.variant?.id).toBe('ember-forge')
        expect(render(LookSection)).toContain('Ember Forge · Top bar')
      })

      it('a look saved by the old gallery (the companion stored as the variant) does not stick after leaving', async () => {
        await keepLook(server(), { variant: seed(x.seed), layout: null, apps: null, experience: x.id })
        expect(render(LookSection)).not.toContain(companion)
        await escapeToClassic(server())
        expect(lookState().saved?.variant ?? null).toBeNull()
        expect(look.effectiveLayout(lookState().saved)).toBe('rail') // the companion's dock goes with it
        expect(render(LookSection)).toContain('OmegaHive · Side rail')
      })

      it('the same seed chosen in Classic is the person\u2019s own: it survives entering and leaving (stand-in r2 P2)', async () => {
        const srv = server()
        await keepLook(srv, { variant: seed(x.seed), layout: null, apps: null, experience: null }) // chosen in Classic
        await keepLook(srv, look.withExperience(lookState().saved, x.id)) // the gallery's enter
        expect(look.ownVariant(lookState().saved)?.id).toBe(x.seed)
        await loadLook(srv) // a reload inside the experience still knows it is theirs
        await escapeToClassic(srv)
        expect(lookState().saved?.variant?.id).toBe(x.seed)
        expect(render(LookSection)).toContain(`${companion} ·`)
        // the Ask's way in and out, and a gallery pick of the seed made inside the experience, keep it the same way
        const viaAsk = applyLookPatch({ variant: seed(x.seed), layout: null, apps: null, experience: null }, { kind: 'experience', id: x.id }, look.DEFAULT_VARIANT, SEED_VARIANTS)
        expect(look.withExperience(viaAsk, null).variant?.id).toBe(x.seed)
        const picked = applyLookPatch({ variant: null, layout: null, apps: null, experience: x.id }, { kind: 'variant', id: x.seed }, look.DEFAULT_VARIANT, SEED_VARIANTS)
        expect(look.withExperience(picked, null).variant?.id).toBe(x.seed)
        const inGallery: Prefs = { ...look.withExperience(null, x.id), variant: look.asOwnChoice(seed(x.seed), x.id) }
        expect(look.withExperience(inGallery, 'classic').variant?.id).toBe(x.seed)
      })

      it('an adjusted companion is the person\u2019s own: roomy applies while worn, survives save, reload and leaving (stand-in r3 P2)', async () => {
        const srv = server()
        await keepLook(srv, look.withExperience(null, x.id))
        const roomy = applyLookPatch(lookState().saved, { kind: 'density', density: 'roomy' }, look.DEFAULT_VARIANT, SEED_VARIANTS)
        expect(look.wornVariant(roomy)?.density).toBe('roomy') // applies while worn
        await keepLook(srv, roomy)
        await loadLook(srv) // reload
        expect(look.wornVariant(lookState().saved)?.density).toBe('roomy')
        await escapeToClassic(srv)
        expect(lookState().saved?.variant?.id).toBe(x.seed) // leaving keeps it
        expect(lookState().saved?.variant?.density).toBe('roomy')
      })

      it('a mind\u2019s proposal of the seed as a whole object, with its experience, is the person\u2019s choice (stand-in r3 P2)', () => {
        const { next } = proposedLook({ variant: seed(x.seed), experience: x.id }, null, EXPERIENCES)
        expect(next.experience).toBe(x.id)
        expect(look.ownVariant(next)?.id).toBe(x.seed)
        expect(look.withExperience(next, null).variant?.id).toBe(x.seed) // leaving keeps it
      })

      it('the same seed stored with ANOTHER experience is the person\u2019s own too', () => {
        const other = COMPANIONS.find((o) => o.id !== x.id)!.id
        expect(look.withExperience({ variant: seed(x.seed), layout: null, apps: null, experience: other }, null).variant?.id).toBe(x.seed)
      })

      it('picking Classic in the gallery restores the own look too', () => {
        const inside: Prefs = { variant: seed(x.seed), layout: null, apps: null, experience: x.id }
        expect(look.withExperience(inside, 'classic')).toEqual({ variant: null, layout: null, apps: null, experience: null })
        const mine: Prefs = { variant: seed('paper'), layout: 'topbar', apps: 'designed', experience: x.id }
        expect(look.withExperience(mine, 'classic')).toEqual({ variant: seed('paper'), layout: 'topbar', apps: 'designed', experience: null })
      })
    })
  }

  it('an experience without a companion (Still) is named too, not "OmegaHive"', () => {
    previewLook(look.withExperience(null, 'still'))
    expect(render(LookPreviewBar)).toContain('Previewing Still')
  })
})

describe('F14: one plural helper', async () => {
  const { plural } = await import('../lib/plural')
  it('says 1 mind, 2 minds, 0 minds and irregular nouns', () => {
    expect(plural(1, 'mind')).toBe('1 mind')
    expect(plural(2, 'mind')).toBe('2 minds')
    expect(plural(0, 'mind')).toBe('0 minds')
    expect(plural(1, 'person asking', 'people asking')).toBe('1 person asking')
    expect(plural(3, 'person asking', 'people asking')).toBe('3 people asking')
  })
})

describe('F30: each gallery card wears the experience’s real chrome accent', async () => {
  const chromes: Record<string, { accent: string }> = {
    cosmos: (await import('../experiences/cosmos/chrome')).chrome,
    construct: (await import('../experiences/construct/chrome')).chrome,
    flux: (await import('../experiences/flux/chrome')).chrome,
    still: (await import('../experiences/still/chrome')).chrome,
    canvas: (await import('../experiences/canvas/chrome')).chromeForMode('light'),
  }
  it('swatch accent = chrome accent', () => {
    for (const [id, c] of Object.entries(chromes)) expect(EXPERIENCES.find((e) => e.id === id)?.swatch.accent, id).toBe(c.accent)
  })
})

describe('F23: the experiences demo counts and names what this build offers', async () => {
  const { scriptById } = await import('../features/guided/scripts')
  it('derives its count and list from the registry', () => {
    const s = scriptById('experiences')!
    for (const e of EXPERIENCES) expect(s.blurb).toContain(e.id === 'classic' ? 'Classic' : e.name)
    expect(s.blurb.toLowerCase()).not.toContain('six')
    const previews = s.steps.flatMap((st) => (st.do && 'experience' in st.do && st.do.experience ? [st.do.experience] : []))
    for (const id of previews) expect(EXPERIENCES.some((e) => e.id === id), id).toBe(true)
  })
})

describe('F25: the Ask’s accessible name follows each skin’s own words', async () => {
  const { SKIN_WORDS } = await import('../features/ask/skins')
  it('every floating skin names its field in the words it shows', () => {
    for (const [id, w] of Object.entries(SKIN_WORDS)) {
      const first = w.placeholder.replace(/…$/, '').split(/[ ,]/)[0].toLowerCase()
      expect(w.label.toLowerCase(), id).toContain(first)
    }
  })
})
