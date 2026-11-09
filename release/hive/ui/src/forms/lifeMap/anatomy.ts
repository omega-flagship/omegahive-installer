/**
 * The figure. Carried forward from the legacy Atlas atmosphere: a 400 x 900 figure space (head centre y~95,
 * throat ~165, heart ~270, abdomen ~420), the body silhouette built from mirrored half-paths, and the organs
 * and nerves drawn into a mask. Here the same paths serve three renderers: a WebGL mask (classic, cosmos core),
 * ink line-work (still) and the anchor sites observations attach to.
 */

export const FIG_W = 400
export const FIG_H = 900

type Pt = readonly [number, number]

/** The left half of the silhouette, from the throat down the arm, round the hand, down the leg to the crotch. */
const LEFT: Pt[] = [
  [200, 150], [178, 152], [176, 176], [150, 192], [96, 202], [76, 224], [66, 300], [58, 400], [56, 470], [50, 512],
  [66, 522], [80, 486], [98, 420], [116, 330], [124, 270], [128, 330], [134, 400], [118, 470], [112, 540], [124, 620],
  [126, 700], [134, 780], [138, 860], [148, 890], [176, 890], [178, 800], [172, 700], [180, 620], [200, 560],
]

function half(pts: Pt[]): string {
  let d = ` L${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]
    const [nx, ny] = pts[i + 1]
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`
  }
  const last = pts[pts.length - 1]
  return d + ` L${last[0]} ${last[1]}`
}

/** The body silhouette as one SVG path in figure space. */
export const BODY_PATH: string = (() => {
  // head: upper half ellipse (200,95) rx46 ry58, from the left side over the crown to the right
  let d = 'M154 95 A46 58 0 0 1 246 95'
  d += ' Q244 138 222 152'
  const right = LEFT.slice().reverse().map(([x, y]) => [400 - x, y] as Pt)
  d += half(right)
  d += half(LEFT)
  d += ' Q156 138 154 95 Z'
  return d
})()

/** Organ shapes (ink drawing + mask). Each is [kind, svg path]. */
export const ORGANS: { id: string; d: string; fill: number }[] = [
  { id: 'brain', d: 'M166 90 A34 29 0 1 0 234 90 A34 29 0 1 0 166 90 Z', fill: 0.55 },
  { id: 'lung-l', d: 'M164 222 C140 226 136 300 152 312 C176 320 190 290 188 250 C186 228 176 220 164 222 Z', fill: 0.5 },
  { id: 'lung-r', d: 'M236 222 C260 226 264 300 248 312 C224 320 210 290 212 250 C214 228 224 220 236 222 Z', fill: 0.5 },
  { id: 'heart', d: 'M188 256 C170 240 158 270 188 296 C218 270 206 240 188 256 Z', fill: 1 },
  { id: 'liver', d: 'M176 352 C200 336 246 340 250 360 C252 378 222 384 196 380 C180 378 170 364 176 352 Z', fill: 0.45 },
  { id: 'kidney-l', d: 'M163 372 A9 14 0 1 0 181 372 A9 14 0 1 0 163 372 Z', fill: 0.5 },
  { id: 'kidney-r', d: 'M219 372 A9 14 0 1 0 237 372 A9 14 0 1 0 219 372 Z', fill: 0.5 },
  { id: 'gut', d: 'M200 384 C236 384 238 452 200 452 C162 452 164 384 200 384 Z M200 400 C220 400 222 436 200 436 C180 436 178 400 200 400 Z', fill: 0.45 },
]

/** Brain folds, spine, pelvis: strokes. */
export const ORGAN_STROKES: string[] = [
  'M175 89 A12 12 0 0 1 196 78',
  'M203 76 A11 11 0 0 1 222 86',
  'M188 108 A14 14 0 0 0 214 106',
  'M174 100 A8 8 0 0 1 180 92',
  'M222 104 A8 8 0 0 0 228 96',
  'M200 158 L200 500',
  'M140 470 Q200 560 260 470',
]
export const VERTEBRAE: Pt[] = Array.from({ length: 16 }, (_, i) => [200, 170 + i * 22] as Pt).filter(([, y]) => y < 500)

/** Nerve filaments, mirrored. */
const NERVE_LINES: Pt[][] = [
  [[200, 200], [150, 205], [98, 226], [72, 320], [62, 470]],
  [[200, 250], [150, 260], [110, 330], [100, 420]],
  [[200, 480], [150, 520], [128, 640], [136, 860]],
  [[200, 480], [180, 560], [176, 700], [172, 860]],
  [[200, 160], [200, 110]],
  [[200, 300], [166, 320], [140, 340]],
  [[200, 360], [176, 372]],
  [[176, 120], [150, 150], [138, 180]],
]
export const NERVES: string[] = (() => {
  const out: string[] = []
  for (const line of NERVE_LINES)
    for (const mirror of [false, true]) {
      const P = line.map(([x, y]) => [mirror ? 400 - x : x, y])
      out.push('M' + P.map(([x, y]) => `${x} ${y}`).join(' L'))
    }
  for (let y = 210; y < 470; y += 34)
    for (const s of [-1, 1]) out.push(`M200 ${y} Q${200 + s * 30} ${y + 10} ${200 + s * 62 * (1 - (y - 210) / 600)} ${y + 26}`)
  return out
})()

/**
 * Builds the RGBA figure mask the legacy shader reads: r = body, g = organs, b = nerves, a = halo.
 * Browser only (canvas 2D); returns null where there is no canvas.
 */
export function buildFigureMask(scale = 1): { data: Uint8Array; w: number; h: number } | null {
  if (typeof document === 'undefined') return null
  const w = Math.round(FIG_W * scale)
  const h = Math.round(FIG_H * scale)
  const layer = (draw: (g: CanvasRenderingContext2D) => void, blur: number): Uint8ClampedArray | null => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return null
    g.scale(scale, scale)
    if (blur) g.filter = `blur(${blur}px)`
    draw(g)
    return g.getImageData(0, 0, w, h).data
  }
  const body = new Path2D(BODY_PATH)
  const bodyL = layer((g) => {
    g.fillStyle = '#fff'
    g.fill(body)
  }, 5)
  const halo = layer((g) => {
    g.fillStyle = '#fff'
    g.fill(body)
  }, 34)
  const org = layer((g) => {
    g.fillStyle = '#fff'
    g.strokeStyle = '#fff'
    g.lineCap = 'round'
    for (const o of ORGANS) {
      g.globalAlpha = o.fill
      g.fill(new Path2D(o.d), 'evenodd')
    }
    g.globalAlpha = 1
    g.lineWidth = 2.4
    ORGAN_STROKES.forEach((s, i) => {
      g.lineWidth = i === 5 ? 3 : i === 6 ? 5 : 2.2
      g.globalAlpha = i === 6 ? 0.45 : 1
      g.stroke(new Path2D(s))
    })
    g.globalAlpha = 1
    for (const [x, y] of VERTEBRAE) {
      g.beginPath()
      g.arc(x, y, 3.6, 0, Math.PI * 2)
      g.fill()
    }
  }, 7)
  const nrv = layer((g) => {
    g.strokeStyle = '#fff'
    g.lineCap = 'round'
    g.lineWidth = 1.5
    NERVES.forEach((s, i) => {
      g.globalAlpha = i >= 16 ? 0.7 : 1
      g.lineWidth = i >= 16 ? 1 : 1.5
      g.stroke(new Path2D(s))
    })
  }, 1.4)
  if (!bodyL || !halo || !org || !nrv) return null
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = bodyL[i * 4 + 3]
    out[i * 4 + 1] = org[i * 4 + 3]
    out[i * 4 + 2] = nrv[i * 4 + 3]
    out[i * 4 + 3] = halo[i * 4 + 3]
  }
  return { data: out, w, h }
}
