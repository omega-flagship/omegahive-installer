import { describe, expect, it } from 'vitest'
import { appTheme, appVars, contrast, DESIGNED_APPS } from './appLook'
import { blockedReason, DEFAULT_VARIANT, SEED_VARIANTS } from './uiVariant'

const looks = [DEFAULT_VARIANT, ...SEED_VARIANTS.filter((v) => !blockedReason(v))]

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
