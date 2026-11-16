import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import appSource from '../App.tsx?raw'
import noticeSource from './HeldExperienceNotice.tsx?raw'

/**
 * UI review 2026-10-12 TF-03: a surface-preview build holds Still and Canvas back (registry HELD_IN_PREVIEW), and a
 * saved choice of one quietly showed Classic. It now says so once: "Still isn't in this preview build; showing
 * Classic." A release build never holds, so it never says it. INVENTED data only.
 */
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))

async function buildAs(mode: string) {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('DEV', false)
  vi.stubEnv('MODE', mode)
  vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  const registry = await import('../experiences/registry')
  const notice = await import('./heldExperience')
  const { useHive } = await import('../store/store')
  useHive.setState({ toasts: [] })
  notice.resetHeldNotices()
  const toasts = () => useHive.getState().toasts.map((t) => t.title)
  return { registry, notice, toasts }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('TF-03: a held experience is said, not silently shown as Classic', () => {
  it('surface-preview: choosing Still or Canvas shows Classic and says so, once each', async () => {
    const { registry, notice, toasts } = await buildAs('surface-preview')
    // the fallback the notice explains: the held experience resolves to Classic
    expect(registry.experienceById('still').id).toBe('classic')
    expect(registry.heldInPreview('still')?.name).toBe('Still')
    expect(registry.heldInPreview('canvas')?.name).toBe('Canvas')
    expect(notice.announceHeld('still')).toBe(true)
    expect(toasts()).toEqual(["Still isn't in this preview build; showing Classic."])
    expect(notice.announceHeld('still')).toBe(false) // once: a re-render says nothing new
    expect(notice.announceHeld('canvas')).toBe(true)
    // one notice on screen: the later held choice replaces the earlier one's (one group)
    expect(toasts()).toEqual(["Canvas isn't in this preview build; showing Classic."])
  })

  it('surface-preview: an offered experience, Classic, or no choice says nothing', async () => {
    const { registry, notice, toasts } = await buildAs('surface-preview')
    for (const id of ['cosmos', 'construct', 'flux', 'omegatown', 'professional', 'classic', null, undefined, 'nonsense']) {
      expect(registry.heldInPreview(id)).toBeNull()
      expect(notice.announceHeld(id)).toBe(false)
    }
    expect(toasts()).toEqual([])
  })

  it('a release build holds nothing back and never says it (Still mounts as Still)', async () => {
    const { registry, notice, toasts } = await buildAs('production')
    expect(registry.experienceById('still').id).toBe('still')
    expect(registry.heldInPreview('still')).toBeNull()
    expect(notice.announceHeld('still')).toBe(false)
    expect(notice.announceHeld('canvas')).toBe(false)
    expect(toasts()).toEqual([])
  })

  it('is wired: App mounts the notice next to the preview marker; it speaks only once the hive is ready', () => {
    expect(appSource).toMatch(/<PreviewBuildBanner \/>[\s\S]{0,200}<HeldExperienceNotice \/>/)
    // binding a client empties the notices (store init), and announceHeld speaks once: before ready it would never be seen
    expect(noticeSource).toContain('const ready = useHive((s) => s.ready)')
    expect(noticeSource).toContain('if (ready) announceHeld(wanted, preview)')
  })
})
