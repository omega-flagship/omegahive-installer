/** P8 release-bound display tokens only. No memory, network, confidence or inference operations. */
export const MEMORY_COLOR_SLOTS = ['surface', 'panel', 'text', 'muted', 'accent', 'border', 'positive', 'danger'] as const
export const MEMORY_FONT_IDS = ['system', 'humanist', 'serif', 'mono'] as const
export type MemoryFontId = (typeof MEMORY_FONT_IDS)[number]
export type MemoryMotion = 'none' | 'gentle' | 'lively'
type ColorSlot = (typeof MEMORY_COLOR_SLOTS)[number]
export type MemoryThemeTokens = Partial<Record<ColorSlot, string>> & { radius?: number; font?: MemoryFontId; motion?: MemoryMotion }
export type MemoryThemeVariant = MemoryThemeTokens & { dark?: MemoryThemeTokens }
export type MemoryThemeDeclaration = MemoryThemeTokens & Record<string, unknown>
export interface MemoryThemes { memory_theme?: MemoryThemeDeclaration; memory_theme_dark?: MemoryThemeTokens }
export type ResolvedMemoryTheme = Record<ColorSlot, string> & {
  radius: number; font: MemoryFontId; fontFamily: string; motion: MemoryMotion; accentText: '#ffffff' | '#0b0820'
}

const SCALAR_KEYS = new Set<string>([...MEMORY_COLOR_SLOTS, 'radius', 'font', 'motion'])
const RESERVED = new Set([...SCALAR_KEYS, 'dark', 'constructor', 'prototype'])
const COLOR_KEYS = new Set<string>(MEMORY_COLOR_SLOTS)
const NAME = /^[a-z0-9-]{1,24}$/
const HEX = /^#[0-9a-fA-F]{6}$/
const MOTIONS: readonly string[] = ['none', 'gentle', 'lively']
const DEFAULT_COLORS: Record<ColorSlot, string> = {
  surface: '#ffffff', panel: '#f3f4f7', text: '#0b0820', muted: '#484256',
  accent: '#5741d9', border: '#bcb7cc', positive: '#17653c', danger: '#9e2038',
}
/** System/generic families only: an app cannot supply a font stack, URL or font file. */
const FONTS: Record<MemoryFontId, string> = {
  system: 'system-ui, sans-serif', humanist: 'ui-rounded, system-ui, sans-serif',
  serif: 'ui-serif, serif', mono: 'ui-monospace, monospace',
}
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined)
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function tokens(value: unknown): MemoryThemeTokens | null {
  if (!plain(value) || Object.keys(value).some((key) => !SCALAR_KEYS.has(key))) return null
  const out: Record<string, unknown> = {}
  for (const [key, token] of Object.entries(value)) {
    if (COLOR_KEYS.has(key)) {
      if (typeof token !== 'string' || !HEX.test(token)) return null
      out[key] = token.toLowerCase()
    } else if (key === 'radius') {
      if (typeof token !== 'number' || !Number.isFinite(token) || token < 0 || token > 32) return null
      out[key] = token
    } else if (key === 'font') {
      if (typeof token !== 'string' || !(MEMORY_FONT_IDS as readonly string[]).includes(token)) return null
      out[key] = token
    } else if (key === 'motion') {
      if (typeof token !== 'string' || !MOTIONS.includes(token)) return null
      out[key] = token
    }
  }
  return out as MemoryThemeTokens
}

/** Same closed manifest schema as core/memory_theme.py, rechecked at the host render boundary. */
export function readMemoryThemes(value: unknown): MemoryThemes | null {
  if (!plain(value)) return null
  const out: MemoryThemes = {}
  if (own(value, 'memory_theme')) {
    const theme = value.memory_theme
    if (!plain(theme)) return null
    const base = tokens(Object.fromEntries(Object.entries(theme).filter(([key]) => SCALAR_KEYS.has(key))))
    if (!base) return null
    const names = Object.keys(theme).filter((key) => !SCALAR_KEYS.has(key))
    if (names.length > 4 || names.some((name) => !NAME.test(name) || RESERVED.has(name))) return null
    const result: MemoryThemeDeclaration = { ...base }
    for (const name of names) {
      const input = theme[name]
      if (!plain(input)) return null
      const light = tokens(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'dark')))
      if (!light) return null
      const variant: MemoryThemeVariant = { ...light }
      if (own(input, 'dark')) {
        const dark = tokens(input.dark)
        if (!dark) return null
        variant.dark = dark
      }
      result[name] = variant
    }
    out.memory_theme = result
  }
  if (own(value, 'memory_theme_dark')) {
    const dark = tokens(value.memory_theme_dark)
    if (!dark) return null
    out.memory_theme_dark = dark
  }
  return out
}

function luminance(color: string): number {
  const channel = (start: number) => {
    const value = parseInt(color.slice(start, start + 2), 16) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }
  return .2126 * channel(1) + .7152 * channel(3) + .0722 * channel(5)
}
/** WCAG display-color contrast, never a truth/confidence calculation. */
export function memoryThemeContrast(left: string, right: string): number {
  const a = luminance(left), b = luminance(right)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

export interface MemoryThemeOptions {
  /** A declared variant name only. Undeclared or malformed names use the default. */
  theme?: unknown
  mode?: 'light' | 'dark'
  /** The current host list; withdrawal cannot prevent rendering. System is always the native fallback. */
  fonts?: readonly MemoryFontId[]
  reducedMotion?: boolean
}

/** Unknown/withdrawn render-time values fall back; no app value becomes arbitrary CSS. */
export function resolveMemoryTheme(input: unknown, options: MemoryThemeOptions = {}): ResolvedMemoryTheme {
  const themes = readMemoryThemes(input) ?? {}
  const declaration = themes.memory_theme ?? {}
  const base = Object.fromEntries(Object.entries(declaration).filter(([key]) => SCALAR_KEYS.has(key))) as MemoryThemeTokens
  const name = typeof options.theme === 'string' && NAME.test(options.theme) && !RESERVED.has(options.theme) && own(declaration, options.theme) ? options.theme : null
  const variant = name ? declaration[name] as MemoryThemeVariant : null
  const variantTokens = variant ? tokens(Object.fromEntries(Object.entries(variant).filter(([key]) => key !== 'dark'))) ?? {} : {}
  const light: MemoryThemeTokens = { ...base, ...variantTokens }
  const chosen = options.mode === 'dark' ? { ...light, ...(variant ? variant.dark : themes.memory_theme_dark) } : light
  const colors: Record<ColorSlot, string> = { ...DEFAULT_COLORS }
  for (const key of MEMORY_COLOR_SLOTS) if (chosen[key]) colors[key] = chosen[key]!
  const candidates = ['#0b0820', '#ffffff', '#000000']
  const floor = (ink: string) => Math.min(memoryThemeContrast(ink, colors.surface), memoryThemeContrast(ink, colors.panel))
  if (Math.max(...candidates.map(floor)) < 4.5) colors.panel = colors.surface
  const fallback = candidates.reduce((best, ink) => floor(ink) > floor(best) ? ink : best)
  for (const key of ['text', 'muted', 'positive', 'danger'] as const) if (floor(colors[key]) < 4.5) colors[key] = fallback
  const accentInk = (): '#ffffff' | '#0b0820' => memoryThemeContrast('#ffffff', colors.accent) >= memoryThemeContrast('#0b0820', colors.accent) ? '#ffffff' : '#0b0820'
  if (memoryThemeContrast(accentInk(), colors.accent) < 4.5) colors.accent = DEFAULT_COLORS.accent
  const fonts = options.fonts ?? MEMORY_FONT_IDS
  const font = chosen.font && fonts.includes(chosen.font) ? chosen.font : 'system'
  return { ...colors, accentText: accentInk(), font, fontFamily: FONTS[font], radius: chosen.radius ?? 16,
    motion: options.reducedMotion ? 'none' : chosen.motion ?? 'gentle' }
}

export type MemoryThemeStyle = Record<`--memory-${string}`, string> & {
  color: string; backgroundColor: string; fontFamily: string; borderRadius: string
}
/** Apply only to the memory body. Host identity and confirm cards must be siblings/portals outside it. */
export function memoryThemeStyle(theme: ResolvedMemoryTheme): MemoryThemeStyle {
  const variables = Object.fromEntries(MEMORY_COLOR_SLOTS.map((key) => [`--memory-${key}`, theme[key]]))
  return { ...variables, '--memory-accent-text': theme.accentText, '--memory-radius': `${theme.radius}px`,
    '--memory-motion-ms': theme.motion === 'none' ? '0ms' : theme.motion === 'gentle' ? '140ms' : '220ms',
    color: theme.text, backgroundColor: theme.surface, fontFamily: theme.fontFamily, borderRadius: `${theme.radius}px` }
}
