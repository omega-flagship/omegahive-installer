// Purpose: every app's identity stays legible in every look a person can wear and, inside every experience, on the
// chrome the dress puts on classic pages; the chrome applyChrome writes is the one app identities read.
import { describe, expect, it, vi } from 'vitest'
import { appliedChrome, applyChrome, watchAppliedChrome, type ChromeModule, type ExperienceChrome } from '../experiences/chrome'
import { chromeForMode } from '../experiences/canvas/chrome'
import { parseColor } from '../forms/readabilityKit'
import { appIdentityTokens, appTheme, appVars, blendBase, contrast, DESIGNED_APPS, type AppTheme } from './appLook'
import { blockedReason, DEFAULT_VARIANT, SEED_VARIANTS } from './uiVariant'

const looks = [DEFAULT_VARIANT, ...SEED_VARIANTS.filter((v) => !blockedReason(v))]
// what a page's background reads as (--look-page-a's rgb, its alpha aside) and a chrome colour, both as #rrggbb
const hexOf = (rgb: number[]) => '#' + rgb.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
const pageOf = (v: Record<string, string>) => hexOf(v['--look-page-a'].match(/\d+/g)!.slice(0, 3).map(Number))
const colour = (c: string) => hexOf(parseColor(c).slice(0, 3))
// what an app frame is told (bridge `context`) is the page it sits on: the same surface, and an ink readable there
const frameMatchesPage = (theme: AppTheme, look: Parameters<typeof appVars>[1]) => {
  const t = appIdentityTokens(theme, look)
  expect(t.surface).toBe(pageOf(appVars(theme, look)))
  expect(contrast(t.ink, t.surface)).toBeGreaterThanOrEqual(7)
}
// every experience's own chrome, and Canvas's dark board too (its light one is its `chrome`)
const chromes: [string, ExperienceChrome][] = [
  ...Object.entries(import.meta.glob<ChromeModule>('../experiences/*/chrome.ts', { eager: true }))
    .map(([path, m]): [string, ExperienceChrome] => [path.split('/')[2], m.chrome]),
  ['canvas (dark board)', chromeForMode('dark')],
]

describe('app identities inside every experience, on the chrome the dress applies', () => {
  it('covers every experience that ships a chrome', () => {
    expect(chromes.map(([n]) => n)).toEqual(expect.arrayContaining(['canvas', 'still', 'professional', 'cosmos', 'flux', 'construct']))
  })
  for (const [name, chrome] of chromes) {
    for (const [id, ident] of Object.entries(DESIGNED_APPS)) {
      it(`${id} in ${name} keeps the chrome's ink readable on its page`, () => {
        const v = appVars(ident.theme, blendBase({ worn: null }, chrome))
        const page = pageOf(v)
        expect(contrast(colour(chrome.ink), page)).toBeGreaterThanOrEqual(7)
        expect(contrast(colour(chrome.ink3), page)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(v['--color-accent'], page)).toBeGreaterThanOrEqual(3)
        expect(contrast(v['--color-primary-ink'], v['--color-accent'])).toBeGreaterThanOrEqual(4.5)
        frameMatchesPage(ident.theme, blendBase({ worn: null }, chrome))
      })
    }
  }
  it('blended against the worn look instead, Create read far below 4.5:1 under Canvas’s ink, as the v0.40 kit drew it', () => {
    const create = DESIGNED_APPS.omegadesign.theme
    expect(contrast(colour(chromeForMode('light').ink), pageOf(appVars(create, DEFAULT_VARIANT)))).toBeLessThan(4.5)
  })
  it('in the Classic hive the blend is the worn look itself', () => {
    expect(blendBase({ worn: null }, null)).toBe(DEFAULT_VARIANT)
    const seed = looks[looks.length - 1]
    expect(blendBase({ worn: seed }, null)).toBe(seed)
  })
})

describe('the chrome applyChrome writes is the one app identities read', () => {
  it('publishes each chrome it writes, and the Classic hive as none, telling its watchers each time', () => {
    const g = globalThis as { document?: unknown }
    const saved = g.document
    g.document = { documentElement: { style: { setProperty: () => undefined }, dataset: {} as Record<string, string> } }
    const seen = vi.fn()
    const stop = watchAppliedChrome(seen)
    try {
      const light = chromeForMode('light'), dark = chromeForMode('dark')
      applyChrome(light)
      expect(appliedChrome()).toBe(light)
      applyChrome(dark) // Canvas swapping its board's mode in place
      expect(appliedChrome()).toBe(dark)
      applyChrome(null)
      expect(appliedChrome()).toBeNull()
      expect(seen).toHaveBeenCalledTimes(3)
      stop()
      applyChrome(light)
      expect(seen).toHaveBeenCalledTimes(3)
    } finally {
      applyChrome(null)
      g.document = saved
    }
  })
})

describe('app identities inside every look', () => {
  for (const look of looks) {
    for (const [id, ident] of Object.entries(DESIGNED_APPS)) {
      it(`${id} in ${look.id} stays legible`, () => {
        const v = appVars(ident.theme, look)
        const surface = v['--look-page-a'].match(/\d+/g)!.slice(0, 3).map(Number)
        const hex = '#' + surface.map((x) => x.toString(16).padStart(2, '0')).join('')
        expect(contrast(look.colors.ink, hex)).toBeGreaterThanOrEqual(7)
        expect(contrast(look.colors['ink-3'], hex)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(v['--color-accent'], hex)).toBeGreaterThanOrEqual(3)
        expect(contrast(v['--color-primary-ink'], v['--color-accent'])).toBeGreaterThanOrEqual(4.5)
        frameMatchesPage(ident.theme, look)
      })
    }
  }

  it('uses the designed identity only when chosen, else the app’s own theme', () => {
    const own = { accent: '#65e4ce', accent_2: '#ffbf79', surface: '#101418', ink: '#f4efe6', type: 'editorial' as const, motif: 'constellation' as const, density: 'airy' as const }
    const truth = { id: 'omegatruth', app: { theme: own } }
    expect(appTheme(truth, 'owner')).toEqual(own)
    expect(appTheme(truth, 'designed')?.motif).toBe('ruled')
    expect(appTheme({ id: 'unknown-app', app: { theme: own } }, 'designed')).toEqual(own)
    expect(appTheme({ id: 'bare' }, 'owner')).toBeNull()
  })

  it('gives every app a distinct accent and motif-or-type pairing', () => {
    const keys = Object.values(DESIGNED_APPS).map((a) => `${a.theme.accent}|${a.theme.motif}|${a.theme.type}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
