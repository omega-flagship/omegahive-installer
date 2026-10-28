import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Stand-in OMEGATOWN_PROFESSIONAL R1 finding 4: the registry is the one gate for unreviewed experiences. A production
 * build excludes them whatever the build environment says (VITE_UNREVIEWED_EXPERIENCES=1 included); only the
 * surface-preview mode offers them, and it says so on screen. These re-import the real modules under a production env.
 */
vi.mock('../shell/uiVariant', async (orig) => ({ ...(await orig<typeof import('../shell/uiVariant')>()), openGallery: () => undefined }))
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))

/** No candidate is pending (professional-release-r1 released the last one). A new candidate is listed here. */
const CANDIDATES: string[] = []
/**
 * Released after their whole-experience SHIPs: offered, chromed, covered and skinned in every build. OmegaTown: the owner
 * 2026-10-08. Professional: professional-release-r1 (SURFACE_PROFESSIONAL_RELEASE_R1_STANDIN_VERDICT.md and
 * SURFACE_PROFESSIONAL_RELEASE_R1_KIMI_VERDICT.md).
 */
const RELEASED = ['omegatown', 'professional']
const SKIN_OF: Record<string, string> = { omegatown: 'town-capsule', professional: 'professional' }
const ids = (l: { id: string }[]) => l.map((e) => e.id)

async function buildAs(mode: string, extra: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('DEV', false)
  vi.stubEnv('MODE', mode)
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v)
  const registry = await import('./registry')
  const { NATIVE } = await import('./coverage')
  const { ASK_SKINS } = await import('../features/ask/AskHost')
  const { PreviewBuildMarker, PREVIEW_BUILD_WORDS } = await import('../shell/PreviewBuildMarker')
  return { registry, NATIVE, ASK_SKINS, marker: PreviewBuildMarker({}), PREVIEW_BUILD_WORDS }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/**
 * Stand-in R2 P2: in a release build no candidate output may exist at all, so the bundler must drop the import edge.
 * It does only when the build-mode literal sits at the import site itself (a shared factory, or a constant imported
 * from another module, leaves the edge and emits an unreachable candidate chunk + CSS). A future candidate's skin
 * import must carry the literal in its own statement. Today there is none: both experience skins are released.
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const SRC = new URL('..', import.meta.url).pathname
const LITERAL = "import.meta.env.DEV || (import.meta.env.PROD && import.meta.env.MODE === 'surface-preview')"
describe('candidate imports are compiled out of release builds', () => {
  it('no candidate skin is left: the released skins are lazy (never static) imports, and the rule for a future one is kept at the site', () => {
    const host = fs.readFileSync(`${SRC}features/ask/AskHost.tsx`, 'utf8')
    expect(host).not.toMatch(/candidateSkins/) // the candidate module is gone (renamed professionalSkin)
    expect(host).not.toMatch(/UNREVIEWED_ALLOWED &&/) // no skin is folded away in a release build any more
    expect(host).toMatch(/^const ProfessionalAskSkin = lazy\(\(\) => import\('\.\/professionalSkin'\)/m)
    expect(host).toMatch(/^const ProfessionalPresence = lazy\(\(\) => import\('\.\/professionalSkin'\)/m)
    expect(host).not.toMatch(/^import [^\n]*(professionalSkin|townSkin)/m) // never a static import: fetched with its experience
    expect(host).toContain(LITERAL) // the rule a future candidate's import site follows, stated where it will be written
    expect(host).not.toMatch(/const candidate = /) // the r2 shared factory that kept the edge
  })
  it('the released Town and Professional skins live apart: neither module reaches the other\'s code or CSS', () => {
    const pro = fs.readFileSync(`${SRC}features/ask/professionalSkin.tsx`, 'utf8')
    const town = fs.readFileSync(`${SRC}features/ask/townSkin.tsx`, 'utf8')
    const townCss = fs.readFileSync(`${SRC}features/ask/townAsk.css`, 'utf8')
    const host = fs.readFileSync(`${SRC}features/ask/AskHost.tsx`, 'utf8')
    expect(pro).not.toMatch(/^import [^\n]*omegatown/m)
    expect(pro).not.toMatch(/Town(AskSkin|Presence)/)
    expect(town).not.toMatch(/professional|candidateSkins|experienceAsk/i)
    expect(townCss).not.toMatch(/professional|pr-/)
    expect(host).toMatch(/^const TownAskSkin = lazy\(\(\) => import\('\.\/townSkin'\)/m)
    expect(host).toMatch(/^const TownPresence = lazy\(\(\) => import\('\.\/townSkin'\)/m)
  })
  it('the literal is the registry rule (PROD: surface-preview only; dev and tests: on)', async () => {
    const { unreviewedAllowed } = await import('./registry')
    for (const [PROD, MODE] of [[true, 'production'], [true, 'surface-preview'], [true, 'demo'], [false, 'development'], [false, 'test']] as const) {
      const DEV = !PROD
      expect(DEV || (PROD && MODE === 'surface-preview'), `${PROD} ${MODE}`).toBe(unreviewedAllowed({ PROD, MODE }))
    }
  })
})

describe('the registry gate in production builds', () => {
  it('the rule: a production build allows unreviewed experiences only in surface-preview; dev and tests allow them', async () => {
    const { unreviewedAllowed } = await import('./registry')
    expect(unreviewedAllowed({ PROD: true, MODE: 'production' })).toBe(false)
    expect(unreviewedAllowed({ PROD: true, MODE: 'demo' })).toBe(false)
    expect(unreviewedAllowed({ PROD: true, MODE: 'surface-preview' })).toBe(true)
    expect(unreviewedAllowed({ PROD: false, MODE: 'development' })).toBe(true)
  })

  // followups-r7 item 4b: the first build here is a cold import of the real registry, coverage and Ask modules.
  // Measured worst: 4.6 s in this round (8 passes: 3 alone, 5 beside sim files on 2 workers, load up to 6.7;
  // logs/measure/reviewGate-measure.log) and 11.3 s in followups-r6 (after a tree change). Its timeout is about 3x the
  // worst: 35 s (the default 5 s was under 1.1x the usual 4.0-4.6 s).
  it('a PROD build with VITE_UNREVIEWED_EXPERIENCES=1 still excludes unreviewed entries (registry, coverage rows, Ask skins) and shows no marker', async () => {
    const b = await buildAs('production', { VITE_UNREVIEWED_EXPERIENCES: '1' })
    expect(b.registry.UNREVIEWED_ALLOWED).toBe(false)
    expect(b.registry.SURFACE_PREVIEW).toBe(false)
    for (const id of CANDIDATES) {
      expect(ids(b.registry.ALL_EXPERIENCES)).not.toContain(id)
      expect(ids(b.registry.EXPERIENCES)).not.toContain(id)
      expect(b.registry.experienceById(id).id).toBe('classic') // a saved or linked choice resolves to classic
      expect(b.registry.hasOwnChrome(id)).toBe(false)
      expect(b.NATIVE[id]).toBeUndefined()
      expect(b.ASK_SKINS[id]).toBeUndefined()
    }
    expect(ids(b.registry.EXPERIENCES).every((id) => b.registry.ALL_EXPERIENCES.find((e) => e.id === id)?.reviewed === true)).toBe(true)
    expect(b.registry.ALL_EXPERIENCES.every((e) => e.reviewed === true)).toBe(true) // a release build carries no unreviewed entry
    expect(b.marker).toBeNull()
  }, 35_000)

  it('a default production build offers OmegaTown and Professional, each with its own chrome, coverage row and Ask skin', async () => {
    for (const mode of ['production', 'demo']) {
      const b = await buildAs(mode)
      expect(b.registry.UNREVIEWED_ALLOWED).toBe(false)
      for (const id of RELEASED) {
        expect(ids(b.registry.EXPERIENCES)).toContain(id)
        expect(b.registry.experienceById(id).id).toBe(id) // a saved choice restores it, never Classic
        expect(b.registry.experienceById(id).reviewed).toBe(true)
        expect(b.registry.hasOwnChrome(id)).toBe(true)
        expect(b.NATIVE[id]).toBeDefined()
        expect(b.ASK_SKINS[id]).toBe(SKIN_OF[id])
      }
      expect(b.NATIVE.professional).toEqual(['minds.see', 'minds.talk', 'minds.wake', 'swarms.see', 'work.motivations', 'work.goals', 'decide.approvals', 'apps.list', 'watch.activity', 'hive.search', 'hive.changeui', 'hive.help'])
    }
  }, 35_000)

  it('no candidate is pending: the dev build carries only reviewed experiences, so the candidate lists are empty', async () => {
    const { ALL_EXPERIENCES } = await import('./registry')
    expect(CANDIDATES).toEqual([])
    expect(ALL_EXPERIENCES.filter((e) => e.reviewed !== true).map((e) => e.id)).toEqual(CANDIDATES)
  })

  it('a surface-preview build includes them and shows the visible preview marker', async () => {
    const b = await buildAs('surface-preview')
    expect(b.registry.UNREVIEWED_ALLOWED).toBe(true)
    expect(b.registry.SURFACE_PREVIEW).toBe(true)
    for (const id of [...CANDIDATES, ...RELEASED]) {
      expect(ids(b.registry.EXPERIENCES)).toContain(id)
      expect(b.registry.hasOwnChrome(id)).toBe(true)
      expect(b.NATIVE[id]).toBeDefined()
      expect(b.ASK_SKINS[id]).toBeDefined()
    }
    expect(b.marker).not.toBeNull()
    const el = b.marker as unknown as { props: { role: string; className: string; children: [string, { props: { className: string; children: string } }]; 'aria-label': string; 'data-preview-build': string } }
    expect(el.props.role).toBe('note')
    expect(el.props['data-preview-build']).toBe('')
    expect(el.props['aria-label']).toBe(b.PREVIEW_BUILD_WORDS)
    expect(b.PREVIEW_BUILD_WORDS).toMatch(/^PREVIEW BUILD · not a release/)
    // one compact line at 390px: the short words always, the detail only from md up, never wrapping
    expect(el.props.children[0]).toBe('PREVIEW BUILD · not a release')
    expect(el.props.className).toMatch(/whitespace-nowrap/)
    expect(el.props.children[1].props.className).toBe('hidden md:inline')
  })

  it('surface-preview: whole-state reads through the SDK see one stable snapshot per store state (no update loop)', async () => {
    await buildAs('surface-preview')
    const { useHive } = await import('./sdk')
    const { useHive: store } = await import('../store/store')
    const a = useHive.getState()
    expect(useHive.getState()).toBe(a) // the same object for the same store state: React's snapshot is stable
    expect(a.decide).not.toBe(store.getState().decide) // approvals still go to the classic page in preview
    store.setState({ paletteOpen: !store.getState().paletteOpen })
    const b = useHive.getState()
    expect(b).not.toBe(a) // a new store state gives a new guarded object
    expect(useHive.getState()).toBe(b)
  })
})
