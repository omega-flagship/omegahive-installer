/** WCAG 2.x contrast for the board palette: parse, composite translucent colours, measure. */

export type RGBA = [number, number, number, number]

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s = clamp01(s)
  l = clamp01(l)
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** Parses #rgb, #rrggbb, rgb()/rgba() and hsl() (comma or space syntax). */
export function parse(c: string): RGBA {
  const s = c.trim().toLowerCase()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1]
  }
  const m = s.match(/^(rgba?|hsla?)\((.*)\)$/)
  if (!m) throw new Error(`unparsed colour ${c}`)
  const parts = m[2].split(/[\s,/]+/).filter(Boolean)
  const num = (x: string) => parseFloat(x)
  const alpha = parts[3] !== undefined ? (parts[3].endsWith('%') ? num(parts[3]) / 100 : num(parts[3])) : 1
  if (m[1].startsWith('rgb')) return [num(parts[0]), num(parts[1]), num(parts[2]), alpha]
  const [r, g, b] = hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100)
  return [r, g, b, alpha]
}

/** Source-over composite of `top` on an opaque `bottom`. */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3]
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
}

/** Resolve a stack of colours (topmost first) to one opaque colour. The last entry must be opaque. */
export function flatten(...stack: string[]): RGBA {
  let c = parse(stack[stack.length - 1])
  for (let i = stack.length - 2; i >= 0; i--) c = over(parse(stack[i]), c)
  return c
}

/** Multiply channels (approximates CSS brightness() on the sRGB values). */
export const dim = (c: RGBA, k: number): RGBA => [c[0] * k, c[1] * k, c[2] * k, c[3]]

const lin = (v: number) => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
export const luminance = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])

export function ratio(a: RGBA, b: RGBA): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const contrast = (fg: string, bg: string) => ratio(flatten(fg, bg), parse(bg))

/** Darkest-needed lightness (in steps of 1%) at which white text on hsl(h s L) reaches `min`. */
export function lightnessForWhite(h: number, s: number, start: number, min = 4.6): number {
  for (let l = start; l > 5; l--) {
    const [r, g, b] = hslToRgb(h, s / 100, l / 100)
    if (ratio([255, 255, 255, 1], [r, g, b, 1]) >= min) return l
  }
  return 5
}
