import rules from './theme.rules.json'

/**
 * Holds any look (built-in, seed, or one a person makes) to the theme's rules. The rules are MeTTa's (theme.metta, run in
 * PeTTa into theme.rules.json): which token is read against which surface, how strongly it must stand out, and how a
 * shortfall is repaired. This module only measures (WCAG contrast) and applies the repair (OKLCH lightness). Pure.
 */
export interface ThemeCheck {
  /** the look's colours, with any repaired token replaced */
  colors: Record<string, string>
  repaired: { token: string; from: string; to: string }[]
  /** what still falls short after the allowed repair: the look is refused with the first of these. `ratio` is null when a
   *  colour the rules read is missing or not solid #rrggbb (fails closed), and is rounded down, for the message only */
  failures: { token: string; against: string; ratio: number | null; floor: number }[]
}

const HEX = /^#[0-9a-f]{6}$/i
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const unlin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
const toHex = (c: number[]) => '#' + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')

/** WCAG 2.2 contrast ratio between two #rrggbb colours */
export function contrast(a: string, b: string): number {
  const L = (h: string) => { const [r, g, bb] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * bb }
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** #rrggbb → OKLCH [L, C, h] and back (Björn Ottosson's OKLab), clamped into sRGB on the way back */
export function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), Math.atan2(B, A)]
}
export function fromOklch([L, C, h]: [number, number, number]): string {
  const A = C * Math.cos(h), B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return toHex([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(unlin))
}

interface Check { token: string; against: string; floor: number; repair: string }
const CHECKS = (rules as { checks: Check[] }).checks
const GIVE_UP = (rules as { giveUpAfter: number }).giveUpAfter

/** Check a look's colours against the rules; repair what the rules allow; report what still fails. */
export function checkLook(input: Record<string, string>): ThemeCheck {
  const colors = { ...input }, repaired: ThemeCheck['repaired'] = []
  const solid = (k: string) => typeof colors[k] === 'string' && HEX.test(colors[k])
  // decided on the exact ratio, as the host does (core/theme_rules.py); an unmeasurable pair is a failure, never skipped
  const failing = () => CHECKS.filter((c) => !(solid(c.token) && solid(c.against)) || contrast(colors[c.token], colors[c.against]) < c.floor)
  for (const token of [...new Set(failing().map((c) => c.token))]) {
    const mine = CHECKS.filter((c) => c.token === token && c.repair === 'lightness-nearest')
    if (!mine.length || !mine.every((c) => solid(c.token) && solid(c.against))) continue
    const from = colors[token], [L0, C, h] = toOklch(from)
    // the smallest lightness change that reads, searching both ways: away from the surfaces first (lighter on dark
    // grounds, darker on light ones), then toward them, since a mid-grey ground can be passed on the far side
    const surfaceL = mine.map((c) => toOklch(colors[c.against])[0]).reduce((a, b) => a + b, 0) / mine.length
    const away = surfaceL < 0.5 ? 1 : -1
    search: for (let d = 0.01; d <= GIVE_UP + 1e-9; d += 0.01) {
      for (const dir of [away, -away]) {
        const L = L0 + dir * d
        if (L < 0 || L > 1) continue
        const next = fromOklch([L, C, h])
        if (mine.every((c) => contrast(next, colors[c.against]) >= c.floor)) { colors[token] = next; repaired.push({ token, from, to: next }); break search }
      }
    }
  }
  // rounded down, so a ratio below the floor never reads as the floor itself
  const failures = failing().map((c) => ({ token: c.token, against: c.against, ratio: solid(c.token) && solid(c.against) ? Math.floor(contrast(colors[c.token], colors[c.against]) * 100) / 100 : null, floor: c.floor }))
  return { colors, repaired, failures }
}
