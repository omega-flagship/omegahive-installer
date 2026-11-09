/**
 * Colour moves for the look pack (warmer, cooler, more or less contrast, an accent), as pure data transforms of a
 * variant's colour tokens. Every result is made legible against the host's own floors before it is used
 * (hive/core/ui_prefs.py TEXT_FLOORS and primary-ink on accent), so a look made from words is never refused by the
 * host and never unreadable. Status colours (good, warn, bad) and the link colour (accent-2) are never moved.
 */
import type { ColorKey, UiVariant } from '../../shell/uiVariant'

type Colors = UiVariant['colors']
type RGB = [number, number, number]

/** The host's floors: (token, minimum contrast against void). Mirrors hive/core/ui_prefs.py TEXT_FLOORS. */
export const TEXT_FLOORS: [ColorKey, number][] = [
  ['ink', 7], ['ink-2', 4.5], ['ink-3', 4.5], ['ink-4', 4.5], ['accent', 3], ['accent-2', 3], ['control', 3], ['good', 3], ['warn', 3], ['bad', 3],
]
const ALPHA_KEYS: ColorKey[] = ['line', 'line-2', 'glass', 'glass-2']
const HEX = /^#([0-9a-f]{6})$/i
const RGBA = /^rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*\/\s*(0|1|0?\.\d{1,3})\s*\)$/

const clamp = (n: number, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, n))
const hexOf = ([r, g, b]: RGB) => `#${[r, g, b].map((x) => Math.round(clamp(x)).toString(16).padStart(2, '0')).join('')}`
const rgbOf = (hex: string): RGB | null => {
  const m = hex.match(HEX)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/**
 * A light page (Paper Studio, the light-token round's looks) reads dark ink; a dark page light ink. Decided by which
 * of black or white stands further from the page, so every move below goes the readable way for that page.
 */
export const isLightPage = (colors: Colors): boolean => contrast(colors.void, '#000000') > contrast(colors.void, '#ffffff')
/** The colour text moves toward to read better on this page, and the one the page moves toward for more depth */
const readable = (colors: Colors): RGB => (isLightPage(colors) ? BLACK : WHITE)

/** A colour value (#rrggbb, or rgb(r g b / a) for the translucent keys) with its channels moved by `f`; alpha kept. */
function mapColour(value: string, f: (c: RGB) => RGB, alpha?: (a: number) => number): string {
  const hex = rgbOf(value)
  if (hex) return hexOf(f(hex))
  const m = value.match(RGBA)
  if (!m) return value
  const [r, g, b] = f([Number(m[1]), Number(m[2]), Number(m[3])]).map((x) => Math.round(clamp(x)))
  const a = Math.round(clamp(alpha ? alpha(Number(m[4])) : Number(m[4]), 0, 1) * 1000) / 1000
  return `rgb(${r} ${g} ${b} / ${a})`
}

function toHsl([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}
function fromHsl([h, s, l]: [number, number, number]): RGB {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** Move a colour's hue toward `target` (degrees) by `t`, the short way round; saturation and lightness kept. */
function towardHue(c: RGB, target: number, t: number): RGB {
  const [h, s, l] = toHsl(c)
  if (s === 0) return c
  const d = ((target - h + 540) % 360) - 180
  return fromHsl([(h + d * t + 360) % 360, s, l])
}

const lum = (c: RGB) => {
  const ch = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
}
/** WCAG 2 contrast of two #rrggbb colours (the host's programs.contrast). */
export function contrast(a: string, b: string): number {
  const x = rgbOf(a)
  const y = rgbOf(b)
  if (!x || !y) return 0
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/** What the host would refuse in these colours ([] when it would apply them as they are). */
export function legibilityProblems(c: Colors): string[] {
  const p: string[] = []
  for (const [k, floor] of TEXT_FLOORS) if (contrast(c[k], c.void) < floor) p.push(`${k} on void is below ${floor}:1`)
  if (contrast(c['primary-ink'], c.accent) < 4.5) p.push('primary-ink on accent is below 4.5:1')
  return p
}

/**
 * The same colours, with every text and edge token that falls under its floor moved toward the readable end for this
 * page (white on a dark page, black on a light one), and the ink on the primary button pressed toward black, a step at a
 * time until it holds (or white, when that is what reads on this accent). The accent's own colour is never changed here (Kimi K3): a named accent that
 * cannot be read is refused by accentPlan, not repaired into another hue.
 */
export function makeLegible(colors: Colors): Colors {
  const c = { ...colors }
  const to = readable(c)
  for (const [k, floor] of TEXT_FLOORS) {
    for (let i = 0; i < 40 && contrast(c[k], c.void) < floor; i++) c[k] = hexOf(mixRgb(rgbOf(c[k]) ?? to, to, 0.08))
  }
  for (let i = 0; i < 40 && contrast(c['primary-ink'], c.accent) < 4.5; i++) c['primary-ink'] = hexOf(mixRgb(rgbOf(c['primary-ink']) ?? BLACK, BLACK, 0.25))
  if (contrast(c['primary-ink'], c.accent) < 4.5 && contrast('#ffffff', c.accent) >= 4.5) c['primary-ink'] = '#ffffff'
  return c
}

/** The tokens a change of temperature moves: surfaces, ink, edges and the accent. */
const TEMPERED: ColorKey[] = ['void', 'abyss', 'ink', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'line', 'line-2', 'control', 'glass', 'glass-2', 'accent', 'primary-top', 'primary-ink']
export const WARM_HUE = 40
export const COOL_HUE = 205
const ACCENTED: ColorKey[] = ['accent', 'primary-top', 'primary-ink']

/** Warmer (toward amber) or cooler (toward sea blue): the page and ink most of the way, the accent a little less. */
export function temper(colors: Colors, way: 'warmer' | 'cooler'): Colors {
  const target = way === 'warmer' ? WARM_HUE : COOL_HUE
  const c = { ...colors }
  for (const k of TEMPERED) c[k] = mapColour(c[k], (x) => towardHue(x, target, ACCENTED.includes(k) ? 0.75 : 0.9))
  return makeLegible(c)
}

/**
 * More contrast: stronger ink, clearer edges, the page pushed the other way (on a dark page: brighter ink, a deeper
 * page; on a light page: darker ink, a brighter page). Less: ink and edges eased toward the page, floors kept.
 */
export function contrasted(colors: Colors, way: 'more' | 'less'): Colors {
  const c = { ...colors }
  const page = rgbOf(c.void) ?? BLACK
  const ink = readable(c), depth = ink === WHITE ? BLACK : WHITE
  const toward = (k: ColorKey, to: RGB, t: number) => (c[k] = mapColour(c[k], (x) => mixRgb(x, to, t)))
  if (way === 'more') {
    toward('ink', ink, 0.6)
    for (const k of ['ink-2', 'ink-3', 'ink-4'] as ColorKey[]) toward(k, ink, 0.3)
    toward('ink-5', ink, 0.2)
    toward('control', ink, 0.25)
    toward('void', depth, 0.4)
    toward('abyss', depth, 0.3)
    c.line = mapColour(c.line, (x) => x, (a) => Math.min(0.5, a * 1.8))
    c['line-2'] = mapColour(c['line-2'], (x) => x, (a) => Math.min(0.6, a * 1.6))
  } else {
    toward('ink', page, 0.1)
    for (const k of ['ink-2', 'ink-3', 'ink-4'] as ColorKey[]) toward(k, page, 0.14)
    toward('ink-5', page, 0.12)
    c.line = mapColour(c.line, (x) => x, (a) => a * 0.7)
    c['line-2'] = mapColour(c['line-2'], (x) => x, (a) => a * 0.75)
  }
  return makeLegible(c)
}

/** The accents a person can name: the bright ones read on a dark page, the deep ones on a light page. */
export const ACCENTS = {
  red: '#ff6b6b',
  orange: '#ff9f43',
  amber: '#f5c542',
  green: '#5ee39a',
  teal: '#2dd4bf',
  blue: '#60a5fa',
  purple: '#a493ff',
  pink: '#f472b6',
  // deep ones a person may ask for; on this build's dark pages they cannot be read, and say so (accentPlan)
  'deep-purple': '#3b2370',
  'deep-blue': '#1e2a6b',
  'deep-green': '#14532d',
  'deep-red': '#5c1515',
} as const
export type AccentName = keyof typeof ACCENTS
/**
 * Other words for the same accents. A Map, not an object: typed words are looked up here, and an object would answer
 * inherited names ("constructor", "__proto__", "toString") with something that is not an accent (stand-in r1b P2).
 */
export const ACCENT_WORDS: ReadonlyMap<string, AccentName> = new Map<string, AccentName>([
  ['red', 'red'], ['crimson', 'red'], ['orange', 'orange'], ['amber', 'amber'], ['gold', 'amber'], ['golden', 'amber'], ['yellow', 'amber'],
  ['green', 'green'], ['mint', 'green'], ['teal', 'teal'], ['turquoise', 'teal'], ['blue', 'blue'], ['purple', 'purple'], ['violet', 'purple'],
  ['lavender', 'purple'], ['pink', 'pink'], ['rose', 'pink'], ['magenta', 'pink'],
  ['dark purple', 'deep-purple'], ['deep purple', 'deep-purple'], ['dark violet', 'deep-purple'],
  ['dark blue', 'deep-blue'], ['deep blue', 'deep-blue'], ['navy', 'deep-blue'], ['navy blue', 'deep-blue'],
  ['dark green', 'deep-green'], ['deep green', 'deep-green'], ['forest green', 'deep-green'],
  ['dark red', 'deep-red'], ['deep red', 'deep-red'], ['maroon', 'deep-red'],
])
/** How an accent is said back: "dark purple", and the lighter and darker ones to try. */
export const accentWords = (name: AccentName): { said: string; lighter: string; darker: string } => {
  const hue = name.startsWith('deep-') ? name.slice(5) : name
  return { said: name.startsWith('deep-') ? `dark ${hue}` : hue, lighter: `a lighter ${hue}`, darker: `a darker ${hue}` }
}
const isAccent = (name: string): name is AccentName => Object.hasOwn(ACCENTS, name)

/**
 * A named accent, exactly the hue named (Kimi K3: like the host, refuse rather than repair). The accent must read on
 * the page (3:1 on void) and the button ink must read on it (4.5:1) with a dark ink of its own hue, black or white;
 * otherwise the plain reason, and nothing is applied.
 */
export function accentPlan(colors: Colors, name: AccentName): { colors: Colors } | { problem: string } {
  // a patch that did not come from ACCENT_WORDS (a stored or hand-made one) with no such accent changes nothing
  if (!isAccent(name)) return { colors }
  const accent = ACCENTS[name]
  const a = rgbOf(accent) ?? WHITE
  const w = accentWords(name)
  // too close to the page: too dark on a dark page, too light on a light one, said that way
  if (contrast(accent, colors.void) < 3) return { problem: isLightPage(colors) ? `That ${w.said} is too light to read on this page; try ${w.darker}.` : `That ${w.said} is too dark to read on this page; try ${w.lighter}.` }
  const ink = [hexOf(mixRgb(a, BLACK, 0.88)), '#000000', '#ffffff'].find((x) => contrast(x, accent) >= 4.5)
  if (!ink) return { problem: `That ${w.said} is too dark to read buttons on; try ${w.lighter}.` }
  const c = makeLegible({ ...colors, accent, 'primary-top': hexOf(mixRgb(a, WHITE, 0.3)), 'primary-ink': ink })
  // makeLegible never moves the accent; this holds the line if that ever changes
  return c.accent === accent ? { colors: c } : { problem: `That ${w.said} can’t be shown as named here; try ${w.lighter}.` }
}
/** What stops a named accent, or null. */
export function accentProblem(colors: Colors, name: AccentName): string | null {
  const p = accentPlan(colors, name)
  return 'problem' in p ? p.problem : null
}
/** The colours with a named accent, or the same colours when it cannot be read (never a drifted hue). */
export function accented(colors: Colors, name: AccentName): Colors {
  const p = accentPlan(colors, name)
  return 'colors' in p ? p.colors : colors
}

/** True for every colour value the host accepts for its key (solid #rrggbb; rgb(r g b / a) for the translucent ones). */
export function wellFormed(colors: Colors): boolean {
  return (Object.keys(colors) as ColorKey[]).every((k) => HEX.test(colors[k]) || (ALPHA_KEYS.includes(k) && RGBA.test(colors[k])))
}
