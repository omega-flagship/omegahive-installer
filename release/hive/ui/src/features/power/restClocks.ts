/**
 * The resting clocks, one per experience, as pure shapes (RestFaces.tsx and RestScene.tsx draw them; tests check them).
 * Nothing here reads the hive: a clock is only the time.
 */

/** The time as the clock shows it: digits ("4:20" or "16:20"), and "PM"/"AM" when this locale reads a 12-hour clock. */
export function clockParts(d: Date, hour12: boolean): { digits: string; suffix: string | null } {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  if (!hour12) return { digits: `${String(h).padStart(2, '0')}:${m}`, suffix: null }
  return { digits: `${h % 12 || 12}:${m}`, suffix: h < 12 ? 'AM' : 'PM' }
}

/** Whether this browser's locale reads a 12-hour clock. */
export function localeHour12(): boolean {
  try {
    const hc = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hourCycle
    return hc === 'h12' || hc === 'h11'
  } catch {
    return false
  }
}

const NUM = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven']
const PAST: Record<number, string> = { 5: 'five past', 10: 'ten past', 15: 'quarter past', 20: 'twenty past', 25: 'twenty-five past', 30: 'half past' }
const TO: Record<number, string> = { 35: 'twenty-five to', 40: 'twenty to', 45: 'quarter to', 50: 'ten to', 55: 'five to' }

/**
 * Still's clock, as a sentence: "It is just after twenty past four, in the afternoon." Rounded to the nearest five
 * minutes, and honest about the rounding ("just after", "nearly").
 */
export function timeInWords(d: Date): string {
  const raw = d.getHours() * 60 + d.getMinutes()
  const off = raw % 5
  const near = off === 0 ? raw : off <= 2 ? raw - off : raw + (5 - off)
  const hedge = off === 0 ? '' : off <= 2 ? 'just after ' : 'nearly '
  const total = near % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  const hourWord = (x: number) => NUM[x % 12]
  let phrase: string
  if (m === 0) phrase = h === 0 ? 'midnight' : h === 12 ? 'noon' : `${hourWord(h)} o’clock`
  else if (m <= 30) phrase = `${PAST[m]} ${h === 0 ? 'midnight' : hourWord(h)}`
  else phrase = `${TO[m]} ${h + 1 === 24 ? 'midnight' : h + 1 === 12 ? 'noon' : hourWord(h + 1)}`
  const named = phrase.endsWith('midnight') || phrase.endsWith('noon')
  // the part of the day the rounded time falls in
  const ref = h
  const part = ref < 5 ? 'at night' : ref < 12 ? 'in the morning' : ref < 17 ? 'in the afternoon' : ref < 21 ? 'in the evening' : 'at night'
  return `It is ${hedge}${phrase}${named ? '' : `, ${part}`}.`
}

// ---- Cosmos: the time as constellations (seven-segment digits whose corners are stars) ----

/** Seven segments: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g middle. */
const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' }
const NODE: Record<string, [string, string]> = { a: ['tl', 'tr'], b: ['tr', 'mr'], c: ['mr', 'br'], d: ['bl', 'br'], e: ['ml', 'bl'], f: ['tl', 'ml'], g: ['ml', 'mr'] }
const AT: Record<string, [number, number]> = { tl: [0, 0], tr: [1, 0], ml: [0, 1], mr: [1, 1], bl: [0, 2], br: [1, 2] }

/** A small fixed wobble per star, so the digits read as constellations rather than an LCD (same input, same sky). */
const wobble = (i: number, k: string) => {
  let h = 2166136261
  for (const ch of `${i}${k}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.16
}

export interface Constellation {
  /** Stars in clock units: each digit is 1 wide and 2 tall, digits 1.6 apart; `w` and `h` are the whole span. */
  stars: { x: number; y: number; bright: boolean }[]
  lines: [number, number, number, number][]
  w: number
  h: number
}

export function constellation(digits: string): Constellation {
  const stars: Constellation['stars'] = []
  const lines: Constellation['lines'] = []
  let x = 0
  digits.split('').forEach((ch, i) => {
    if (ch === ':') {
      stars.push({ x: x + 0.1, y: 0.6, bright: true }, { x: x + 0.1, y: 1.4, bright: true })
      x += 0.8
      return
    }
    const segs = SEG[ch]
    if (!segs) return
    // a one is a single stroke: it sits in the middle of a narrower cell
    const nx = ch === '1' ? x - 0.5 : x
    const pt = (n: string): [number, number] => [nx + AT[n][0] + wobble(i, n), AT[n][1] + wobble(i, `${n}y`)]
    const used = new Set<string>()
    for (const s of segs) {
      const [p, q] = NODE[s]
      const a = pt(p)
      const b = pt(q)
      lines.push([a[0], a[1], b[0], b[1]])
      used.add(p)
      used.add(q)
    }
    for (const n of used) {
      const [sx, sy] = pt(n)
      stars.push({ x: sx, y: sy, bright: n === 'tl' || n === 'br' })
    }
    x += ch === '1' ? 1.1 : 1.6
  })
  return { stars, lines, w: Math.max(0, x - 0.6), h: 2 }
}

// ---- Construct: a terminal clock in block glyphs ----

const BLOCK: Record<string, string[]> = {
  '0': ['███', '█ █', '█ █', '█ █', '███'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['███', '  █', '███', '█  ', '███'],
  '3': ['███', '  █', ' ██', '  █', '███'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '███', '  █', '███'],
  '6': ['███', '█  ', '███', '█ █', '███'],
  '7': ['███', '  █', ' █ ', ' █ ', ' █ '],
  '8': ['███', '█ █', '███', '█ █', '███'],
  '9': ['███', '█ █', '███', '  █', '███'],
  ':': [' ', '█', ' ', '█', ' '],
}

/** Five rows of block glyphs for the digits, one space between characters. */
export function blockDigits(digits: string): string[] {
  const chars = digits.split('').filter((c) => BLOCK[c])
  return [0, 1, 2, 3, 4].map((r) => chars.map((c) => BLOCK[c][r]).join(' '))
}

// ---- Canvas: a pencil-sketched clock face ----

/** A hand-drawn loop: a circle with a little wobble that overshoots where it began, as a pencil does. SVG path data. */
export function sketchCircle(cx: number, cy: number, r: number, seed: number, overshoot = 0.12): string {
  const n = 40
  const pts: string[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (Math.PI * 2 + overshoot) - Math.PI / 2 + seed * 0.7
    const rr = r * (1 + Math.sin(t * 3 + seed * 5) * 0.012 + Math.sin(t * 7 + seed) * 0.006) + (i / n) * r * 0.02
    pts.push(`${(cx + Math.cos(t) * rr).toFixed(1)},${(cy + Math.sin(t) * rr).toFixed(1)}`)
  }
  return `M${pts[0]} L${pts.slice(1).join(' ')}`
}

/** Hand angles in degrees (0 = twelve, clockwise) for an analogue face. */
export function handAngles(d: Date): { hour: number; minute: number } {
  const m = d.getMinutes()
  return { hour: ((d.getHours() % 12) + m / 60) * 30, minute: m * 6 }
}
