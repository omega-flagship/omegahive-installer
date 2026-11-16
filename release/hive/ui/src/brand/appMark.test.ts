import { describe, expect, it } from 'vitest'
import { appMarkSvg, appMarkUrl, monogram, themeFromColour } from './appMark'
import { DESIGNED_APPS } from '../shell/appLook'

/** Each app's mark from its identity (Dot 3 Nov): deterministic, its own colours, motif and type, a readable monogram. */
describe('app marks', () => {
  it('monograms read as the app is named', () => {
    expect(monogram('Commons Explorer')).toBe('CE')
    expect(monogram('OmegaDesign')).toBe('OD')
    expect(monogram('Omega Tools catalogue (sim)')).toBe('OT')
    expect(monogram('Atlas')).toBe('A')
    expect(monogram('   ')).toBe('Ω')
    expect(monogram('The evidence room')).toBe('ER')
    expect(monogram('A living map')).toBe('LM')
  })
  it('the same app is the same mark; another app is another mark', () => {
    const t = themeFromColour('notes', '#ff7a00')
    expect(appMarkSvg({ id: 'notes', name: 'Notes' }, t)).toBe(appMarkSvg({ id: 'notes', name: 'Notes' }, t))
    expect(appMarkSvg({ id: 'board', name: 'Board' }, themeFromColour('board', '#22aaff'))).not.toBe(appMarkSvg({ id: 'notes', name: 'Notes' }, t))
  })
  it('a designed identity draws in its own colours and type; names are escaped; the URL is an SVG data URL', () => {
    const [id, ident] = Object.entries(DESIGNED_APPS)[0]
    const svg = appMarkSvg({ id, name: ident.title }, ident.theme)
    expect(svg).toContain(ident.theme.accent)
    expect(svg).toContain(ident.theme.surface)
    expect(appMarkSvg({ id: 'x', name: '<b>&' }, themeFromColour('x', '#123456'))).not.toContain('<b>')
    // each app's gradient has its own id, so inline marks never share one
    expect(appMarkSvg({ id: 'a1', name: 'A' }, themeFromColour('a1', '#123456')).match(/id="(am[0-9a-z]+)"/)?.[1]).not.toBe(appMarkSvg({ id: 'b2', name: 'B' }, themeFromColour('b2', '#123456')).match(/id="(am[0-9a-z]+)"/)?.[1])
    expect(appMarkUrl({ id: 'x', name: 'X' }, themeFromColour('x', '#123456'))).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
  })
  it('a theme from a colour keeps the colour and picks a motif by id', () => {
    const t = themeFromColour('notes', '#ff7a00')
    expect(t.accent).toBe('#ff7a00')
    expect(t.motif).toBe(themeFromColour('notes', '#000000').motif)
  })
})
