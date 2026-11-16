/**
 * Pre-rendered glow sprites. Every luminous thing in the scene is a cached radial-gradient
 * bitmap drawn with additive blending ("lighter"), which gives a bloom look at a fraction of
 * the cost of real post-processing.
 */
type Canvas = HTMLCanvasElement | OffscreenCanvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const cache = new Map<string, Canvas>()

function makeCanvas(w: number, h: number): Canvas {
  // A DOM canvas is the most widely drawable source (older iOS Safari is picky with OffscreenCanvas).
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const q = (h: number) => ((Math.round(h / 3) * 3) % 360 + 360) % 360

/** A soft glow with a white-hot centre. */
export function glowSprite(hue: number, sat = 100, hot = true): Canvas {
  const key = `g:${q(hue)}:${sat}:${hot ? 1 : 0}`
  let c = cache.get(key)
  if (c) return c
  const S = 128
  c = makeCanvas(S, S)
  const g = c.getContext('2d') as Ctx2D
  const h = q(hue)
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  if (hot) {
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.07, `hsla(${h},${sat}%,88%,0.95)`)
    grad.addColorStop(0.18, `hsla(${h},${sat}%,68%,0.55)`)
  } else {
    grad.addColorStop(0, `hsla(${h},${sat}%,70%,0.7)`)
    grad.addColorStop(0.18, `hsla(${h},${sat}%,62%,0.4)`)
  }
  grad.addColorStop(0.42, `hsla(${h},${sat}%,58%,0.13)`)
  grad.addColorStop(0.7, `hsla(${h},${sat}%,52%,0.035)`)
  grad.addColorStop(1, `hsla(${h},${sat}%,50%,0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  cache.set(key, c)
  return c
}

/** A very wide, faint nebula cloud. */
export function nebulaSprite(hue: number): Canvas {
  const key = `n:${q(hue)}`
  let c = cache.get(key)
  if (c) return c
  const S = 256
  c = makeCanvas(S, S)
  const g = c.getContext('2d') as Ctx2D
  const h = q(hue)
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0, `hsla(${h},80%,45%,0.22)`)
  grad.addColorStop(0.35, `hsla(${h},75%,35%,0.1)`)
  grad.addColorStop(0.7, `hsla(${(h + 30) % 360},70%,30%,0.035)`)
  grad.addColorStop(1, `hsla(${h},70%,25%,0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  cache.set(key, c)
  return c
}

/** A tileable star field layer. */
export function starTile(seed: number, size: number, count: number, maxR: number): Canvas {
  const key = `s:${seed}:${size}:${count}:${maxR}`
  let c = cache.get(key)
  if (c) return c
  c = makeCanvas(size, size)
  const g = c.getContext('2d') as Ctx2D
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  for (let i = 0; i < count; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = 0.25 + rnd() ** 3 * maxR
    const a = 0.25 + rnd() * 0.6
    const tint = rnd()
    g.fillStyle =
      tint < 0.15 ? `rgba(190,200,255,${a})` : tint < 0.25 ? `rgba(255,220,200,${a})` : `rgba(235,235,255,${a})`
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  cache.set(key, c)
  return c
}

export type { Canvas as SpriteCanvas }
