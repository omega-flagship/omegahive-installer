import type { CSSProperties } from 'react'
import type { Program } from '../api/types'
import pack from './appIdentities.json'
import { blockedReason, DEFAULT_VARIANT, useLook, type UiVariant } from './uiVariant'

/**
 * Each app's identity inside the person's hive look. The app brings its colours, a heading type pairing and a
 * background motif; the look keeps everything that makes it the same hive: navigation, layout, shapes, body type and
 * text colours. The app's surface is blended into the look's, so Truth on Ember Forge and Truth on Deep Sea are both
 * recognisably Truth and recognisably that look. Data only: the host renders every motif from its own CSS.
 */
export interface AppTheme {
  accent: string
  accent_2: string
  surface: string
  ink: string
  type: 'editorial' | 'technical' | 'humanist' | 'mono'
  motif: 'none' | 'constellation' | 'strata' | 'lattice' | 'grain' | 'rings' | 'ruled' | 'blueprint'
  density: 'airy' | 'regular' | 'dense'
}
export interface AppIdentity {
  title: string
  tagline: string
  theme: AppTheme
}
export type AppIdentitySource = 'owner' | 'designed'

export const DESIGNED_APPS = pack as Record<string, AppIdentity>

export const TYPE_FONTS: Record<AppTheme['type'], string> = {
  editorial: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  technical: "'IBM Plex Mono', 'SF Mono', Menlo, monospace",
  humanist: "'Avenir Next', 'Segoe UI', 'Inter Variable', system-ui, sans-serif",
  mono: "'IBM Plex Mono', 'SF Mono', Menlo, monospace",
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const toHex = (c: number[]) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')
/** `a` weighted by `t` against `b`. */
export const mix = (a: string, b: string, t: number) => toHex(rgb(a).map((x, i) => x * t + rgb(b)[i] * (1 - t)))
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const HEX = /^#[0-9a-fA-F]{6}$/

/** The theme an app is shown with: the designed identity when the person chose it (and one exists), else the app's own. */
export function appTheme(program: Pick<Program, 'id' | 'app'> | undefined, source: AppIdentitySource): AppTheme | null {
  if (!program) return null
  if (source === 'designed' && DESIGNED_APPS[program.id]) return DESIGNED_APPS[program.id].theme
  return (program.app?.theme as AppTheme | undefined) ?? null
}

/**
 * CSS variables for an app inside a look. The look's text colours stay (they already pass its floors); the app's
 * surface is blended 60/40 into the look's so the two read as one family; app accents that would fall below 3:1 on
 * that surface give way to the look's own.
 */
export function appVars(theme: AppTheme, look: UiVariant): Record<string, string> {
  const base = look.colors
  const surfaceHex = HEX.test(theme.surface) ? theme.surface : base.abyss
  const surface = mix(surfaceHex, base.abyss, 0.6)
  const deep = mix(surfaceHex, base.void, 0.5)
  const accent = HEX.test(theme.accent) && contrast(theme.accent, surface) >= 3 ? theme.accent : base.accent
  const accent2 = HEX.test(theme.accent_2) && contrast(theme.accent_2, surface) >= 3 ? theme.accent_2 : base['accent-2']
  const primaryInk = contrast(deep, accent) >= 4.5 ? deep : '#000000'
  const [r, g, b] = rgb(surface)
  const [vr, vg, vb] = rgb(deep)
  return {
    '--color-accent': accent,
    '--color-accent-2': accent2,
    '--color-primary-top': mix(accent, '#ffffff', 0.75),
    '--color-primary-ink': primaryInk,
    '--font-display': TYPE_FONTS[theme.type] ?? TYPE_FONTS.humanist,
    '--look-page-a': `rgb(${r} ${g} ${b} / 0.92)`,
    '--look-page-b': `rgb(${vr} ${vg} ${vb} / 0.95)`,
    '--look-selection': `${accent}66`,
    '--look-card': mix(surface, '#ffffff', 0.96),
    '--look-panel': `rgb(${r} ${g} ${b} / 0.72)`,
    '--app-accent': accent,
    '--app-accent-2': accent2,
  }
}

/**
 * The app's identity as it is actually shown in this look, as data an app frame may read (bridge `context`): the
 * same blended surface and contrast-guarded accents as appVars, and the ink the app gets (its own when it reaches
 * 7:1 on that surface, else the look's). Strings and enums only.
 */
export function appIdentityTokens(theme: AppTheme, look: UiVariant) {
  const vars = appVars(theme, look)
  const surface = mix(HEX.test(theme.surface) ? theme.surface : look.colors.abyss, look.colors.abyss, 0.6)
  const lookInk = HEX.test(look.colors.ink) ? look.colors.ink : '#eceaff'
  return {
    accent: vars['--app-accent'],
    accent_2: vars['--app-accent-2'],
    surface,
    ink: HEX.test(theme.ink) && contrast(theme.ink, surface) >= 7 ? theme.ink : lookInk,
    type: theme.type,
    motif: theme.motif,
  }
}

export interface AppLook {
  style: CSSProperties
  motif: AppTheme['motif']
  type: AppTheme['type']
  identity: AppIdentity | null
}

/** Everything a page needs to wear an app's identity in the current look. */
export function useAppLook(program: Pick<Program, 'id' | 'app'> | undefined): AppLook | null {
  const look = useLook()
  const source: AppIdentitySource = look.current?.apps ?? 'owner'
  const theme = appTheme(program, source)
  if (!theme || !program) return null
  const chosen = look.worn
  const variant = chosen && !blockedReason(chosen) ? chosen : DEFAULT_VARIANT
  return {
    style: appVars(theme, variant) as CSSProperties,
    motif: theme.motif,
    type: theme.type,
    identity: source === 'designed' ? DESIGNED_APPS[program.id] ?? null : null,
  }
}
