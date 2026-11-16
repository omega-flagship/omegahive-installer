import { HOST_DISPLAY_MODES, type DisplayMode, type HostContext } from './viewBridge'

/**
 * What a view is told about where it is drawn (MCP Apps HostContext): the look being worn as the standard style
 * variables, light or dark by that look's own background, the space it may take, and the person's locale, time zone
 * and device. Everything is read from the live document, so each look, and any look added later, gets its own values
 * without a list of looks here.
 */

/** The standard variables the hive fills, each from a CSS expression over the look's tokens (hive/ui/src/index.css).
 *  Colours are resolved to concrete values before they are sent, so a view never sees the hive's own token names. */
export const STYLE_VARIABLES: readonly (readonly [string, string])[] = [
  ['--color-background-primary', 'var(--color-float)'],
  ['--color-background-secondary', 'var(--color-glass)'],
  ['--color-background-tertiary', 'var(--color-glass-2)'],
  ['--color-background-inverse', 'var(--color-ink)'],
  ['--color-background-ghost', 'transparent'],
  ['--color-background-info', 'color-mix(in srgb, var(--color-accent-2) 16%, transparent)'],
  ['--color-background-danger', 'color-mix(in srgb, var(--color-bad) 16%, transparent)'],
  ['--color-background-success', 'color-mix(in srgb, var(--color-good) 16%, transparent)'],
  ['--color-background-warning', 'color-mix(in srgb, var(--color-warn) 16%, transparent)'],
  ['--color-background-disabled', 'var(--color-line)'],
  ['--color-text-primary', 'var(--color-ink)'],
  ['--color-text-secondary', 'var(--color-ink-2)'],
  ['--color-text-tertiary', 'var(--color-ink-3)'],
  ['--color-text-inverse', 'var(--color-float)'],
  ['--color-text-info', 'var(--color-accent-2)'],
  ['--color-text-danger', 'var(--color-bad)'],
  ['--color-text-success', 'var(--color-good)'],
  ['--color-text-warning', 'var(--color-warn)'],
  ['--color-text-disabled', 'var(--color-ink-5)'],
  ['--color-text-ghost', 'var(--color-ink-4)'],
  ['--color-border-primary', 'var(--color-line-2)'],
  ['--color-border-secondary', 'var(--color-line)'],
  ['--color-border-tertiary', 'var(--color-line)'],
  ['--color-border-inverse', 'var(--color-ink)'],
  ['--color-border-ghost', 'transparent'],
  ['--color-border-info', 'var(--color-accent-2)'],
  ['--color-border-danger', 'var(--color-bad)'],
  ['--color-border-success', 'var(--color-good)'],
  ['--color-border-warning', 'var(--color-warn)'],
  ['--color-border-disabled', 'var(--color-line)'],
  ['--color-ring-primary', 'var(--color-accent)'],
  ['--color-ring-secondary', 'var(--color-line-2)'],
  ['--color-ring-inverse', 'var(--color-ink)'],
  ['--color-ring-info', 'var(--color-accent-2)'],
  ['--color-ring-danger', 'var(--color-bad)'],
  ['--color-ring-success', 'var(--color-good)'],
  ['--color-ring-warning', 'var(--color-warn)'],
]

/** Values that are not colours: the look's fonts, and the hive's weights, radii and line, as the hive's own CSS uses
 *  them (Tailwind's rounded-md/xl/2xl/3xl are 6, 12, 16 and 24 px; the hive draws 1 px lines). */
export const FIXED_VARIABLES: Readonly<Record<string, string>> = {
  '--font-weight-normal': '400', '--font-weight-medium': '500', '--font-weight-semibold': '600', '--font-weight-bold': '700',
  '--border-radius-xs': '4px', '--border-radius-sm': '6px', '--border-radius-md': '12px', '--border-radius-lg': '16px',
  '--border-radius-xl': '24px', '--border-radius-full': '9999px', '--border-width-regular': '1px',
}
const FONT_VARIABLES = ['--font-sans', '--font-mono'] as const

/** Relative luminance (WCAG 2) of a computed colour such as "rgb(8, 8, 34)", "rgba(…)" or "color(srgb 0.1 0.2 0.3)";
 *  null when it cannot be read. Transparent colours count by their own channels. */
export function luminance(color: string): number | null {
  const nums = color.match(/-?\d*\.?\d+(?:e-?\d+)?%?/gi)?.map((n) => (n.endsWith('%') ? parseFloat(n) / 100 : parseFloat(n)))
  if (!nums || nums.length < 3) return null
  const srgb = color.trim().startsWith('color(') ? nums.slice(0, 3) : nums.slice(0, 3).map((n) => n / 255)
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** Light or dark by the background a view would paint first: a look's surface lighter than mid-grey is light. */
export const themeOf = (background: string): 'light' | 'dark' => ((luminance(background) ?? 0) > 0.18 ? 'light' : 'dark')

/** Resolves each expression to the computed colour it stands for, through one hidden probe element. */
export function resolveColors(doc: Document, expressions: readonly string[]): string[] {
  const probe = doc.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'
  doc.body.appendChild(probe)
  try {
    return expressions.map((expr) => {
      probe.style.color = ''
      probe.style.color = expr
      return getComputedStyle(probe).color
    })
  } finally {
    probe.remove()
  }
}

export function styleVariables(doc: Document): Record<string, string> {
  const colors = resolveColors(doc, STYLE_VARIABLES.map(([, expr]) => expr))
  const vars: Record<string, string> = {}
  STYLE_VARIABLES.forEach(([name], i) => { if (colors[i]) vars[name] = colors[i] })
  const root = getComputedStyle(doc.documentElement)
  for (const name of FONT_VARIABLES) {
    const value = root.getPropertyValue(name).trim()
    if (value) vars[name] = value
  }
  return { ...vars, ...FIXED_VARIABLES }
}

export interface Placement {
  mode: DisplayMode
  /** The frame's width, and the most height it may take (inline) or the height it has (fullscreen). */
  width: number
  height: number
}

/** The whole context for one view at one moment. */
export function hostContext(doc: Document, place: Placement): HostContext {
  const vars = styleVariables(doc)
  const coarse = matchMedia('(pointer: coarse)').matches
  return {
    theme: themeOf(vars['--color-background-primary'] ?? ''),
    styles: { variables: vars },
    displayMode: place.mode,
    availableDisplayModes: [...HOST_DISPLAY_MODES],
    containerDimensions: place.mode === 'fullscreen'
      ? { width: Math.round(place.width), height: Math.round(place.height) }
      : { width: Math.round(place.width), maxHeight: Math.round(place.height) },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'OmegaHive',
    platform: coarse && window.innerWidth < 768 ? 'mobile' : 'web',
    deviceCapabilities: { touch: coarse || navigator.maxTouchPoints > 0, hover: matchMedia('(hover: hover)').matches },
  }
}
