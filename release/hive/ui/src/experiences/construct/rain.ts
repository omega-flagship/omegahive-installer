/**
 * Digital rain: two canvas-2D layers (far and near) stepped at a fixed 30 Hz, faded with destination-out so the
 * canvases stay transparent over the construct's backdrop. Only the drop heads are drawn each step (plus a few
 * mutating trail glyphs and any words resolving), so a 1440p frame costs a couple of hundred fillText calls.
 * The canvases are mirrored with CSS (as in the film); words are drawn un-mirrored so names read correctly.
 * Hive events drive the shared `bus`: energy speeds and brightens the rain, alert tints it amber, and names
 * queued with speak() resolve out of the rain.
 */

export const bus = {
  energy: 0,
  alert: 0,
  /** 0..1 user setting */
  level: 1,
  queue: [] as string[],
  pool: [] as string[],
}
export const pulse = (e = 0.3) => {
  bus.energy = Math.min(1, bus.energy + e)
}
export const alarm = () => {
  bus.alert = 1
  pulse(0.6)
}
export const speak = (name: string) => {
  if (name && bus.queue.length < 4 && !bus.queue.includes(name)) bus.queue.push(name)
}

const KATA = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'
const GLYPHS = KATA + KATA + '0123456789' + '012345789Z:・."=*+-<>¦|_'
const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0]

interface Word {
  text: string
  col: number
  row: number
  born: number
  lock: number[]
  life: number
}

class Layer {
  ctx: CanvasRenderingContext2D
  cell = 16
  cols = 0
  rows = 0
  dpr = 1
  y = new Float32Array(0)
  speed = new Float32Array(0)
  last = new Int16Array(0)
  wait = new Float32Array(0)
  chars: string[] = []
  font = ''
  constructor(
    public canvas: HTMLCanvasElement,
    public baseCell: number,
    public trail: [number, number, number],
    public head: string,
    public fade: number,
    public density: number,
    public speedRange: [number, number],
    public maxDpr: number,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: true })!
  }
  resize(w: number, h: number) {
    const narrow = w < 600
    this.cell = narrow ? Math.round(this.baseCell * 0.85) : this.baseCell
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr)
    this.canvas.width = Math.ceil(w * this.dpr)
    this.canvas.height = Math.ceil(h * this.dpr)
    this.cols = Math.ceil(w / this.cell)
    this.rows = Math.ceil(h / this.cell) + 1
    this.y = new Float32Array(this.cols)
    this.speed = new Float32Array(this.cols)
    this.last = new Int16Array(this.cols)
    this.wait = new Float32Array(this.cols)
    this.chars = new Array(this.cols).fill(' ')
    for (let c = 0; c < this.cols; c++) this.seed(c, true)
    this.font = `500 ${Math.round(this.cell * 0.82)}px "IBM Plex Mono","Hiragino Sans","Hiragino Kaku Gothic ProN","SF Mono",Menlo,monospace`
  }
  seed(c: number, initial = false) {
    this.y[c] = initial ? Math.random() * this.rows * 1.2 - this.rows * 0.4 : -Math.random() * 8
    this.speed[c] = this.speedRange[0] + Math.random() * (this.speedRange[1] - this.speedRange[0])
    this.last[c] = Math.floor(this.y[c]) - 1
    this.wait[c] = initial ? (Math.random() < this.density ? 0 : Math.random() * 90) : Math.random() * (40 / this.density)
  }
  // scratch buffers: positions are collected first, then drawn in three passes so fillStyle changes 3x per step
  tx: number[] = []
  ty: number[] = []
  tc: string[] = []
  hx: number[] = []
  hy: number[] = []
  hc: string[] = []
  fx: number[] = []
  fy: number[] = []
  step(energy: number, tint: string, headTint: string) {
    const { ctx, cell, dpr } = this
    const { tx, ty, tc, hx, hy, hc, fx, fy } = this
    tx.length = ty.length = tc.length = hx.length = hy.length = hc.length = fx.length = fy.length = 0
    const boost = 1 + energy * 1.6
    for (let c = 0; c < this.cols; c++) {
      if (this.wait[c] > 0) {
        this.wait[c] -= boost
        continue
      }
      this.y[c] += this.speed[c] * boost
      const r = Math.floor(this.y[c])
      if (r <= this.last[c]) continue
      const x = c * cell + cell / 2
      // the old head settles into the trail colour
      if (this.last[c] >= 0) {
        tx.push(x)
        ty.push(this.last[c] * cell)
        tc.push(this.chars[c])
      }
      for (let k = this.last[c] + 1; k < r; k++) {
        tx.push(x)
        ty.push(k * cell)
        tc.push(glyph())
      }
      const ch = glyph()
      hx.push(x)
      hy.push(r * cell)
      hc.push(ch)
      this.chars[c] = ch
      this.last[c] = r
      // a glyph somewhere up the trail flickers to a new one
      if (Math.random() < 0.35) {
        const k = r - 2 - ((Math.random() * 14) | 0)
        if (k >= 0) {
          fx.push(c * cell)
          fy.push(k * cell)
        }
      }
      if (r > this.rows + 4 + Math.random() * 10) this.seed(c)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = `rgba(0,0,0,${this.fade})`
    ctx.fillRect(0, 0, this.cols * cell, this.rows * cell)
    ctx.globalCompositeOperation = 'source-over'
    ctx.font = this.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = tint
    for (let i = 0; i < tx.length; i++) ctx.fillText(tc[i], tx[i], ty[i])
    if (fx.length) {
      ctx.globalAlpha = 0.55
      for (let i = 0; i < fx.length; i++) {
        ctx.clearRect(fx[i], fy[i], cell, cell)
        ctx.fillText(glyph(), fx[i] + cell / 2, fy[i])
      }
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = headTint
    for (let i = 0; i < hx.length; i++) ctx.fillText(hc[i], hx[i], hy[i])
  }
}

export class Rain {
  far: Layer
  near: Layer
  words: Word[] = []
  raf = 0
  acc = 0
  prev = 0
  t = 0
  nextIdle = 140
  running = false
  boost = -1
  w = 0
  h = 0
  constructor(
    far: HTMLCanvasElement,
    near: HTMLCanvasElement,
    public host: HTMLElement,
    public reduced: boolean,
  ) {
    this.far = new Layer(far, 12, [40, 190, 90], 'rgba(150,255,170,0.75)', 0.085, 0.5, [0.28, 0.6], 1)
    this.near = new Layer(near, 19, [70, 255, 120], 'rgba(225,255,232,0.98)', 0.07, 0.42, [0.32, 0.85], 1.5)
  }
  resize(w: number, h: number) {
    this.w = w
    this.h = h
    this.far.resize(w, h)
    this.near.resize(w, h)
    this.words = []
    if (this.reduced) this.still()
  }
  /** Reduced motion: one settled frame, then nothing moves. */
  still() {
    for (let i = 0; i < 70; i++) this.tick(true)
  }
  start() {
    if (this.reduced || this.running) return
    this.running = true
    this.prev = performance.now()
    const loop = (now: number) => {
      if (!this.running) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(100, now - this.prev)
      this.prev = now
      this.acc += dt
      if (this.acc < 33.3) return
      this.acc = this.acc % 33.3
      this.tick(false)
    }
    this.raf = requestAnimationFrame(loop)
  }
  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }
  tick(silent: boolean) {
    this.t++
    const e = bus.energy * bus.level
    const a = bus.alert
    bus.energy *= 0.965
    bus.alert *= 0.955
    if (bus.alert < 0.01) bus.alert = 0
    const mix = (g: [number, number, number], alpha: number) => {
      const r = Math.round(g[0] + (255 - g[0]) * a)
      const gg = Math.round(g[1] + (176 - g[1]) * a)
      const b = Math.round(g[2] + (40 - g[2]) * a)
      return `rgba(${r},${gg},${b},${alpha})`
    }
    this.far.step(e * 0.6, mix(this.far.trail, 0.5), this.far.head)
    this.near.step(e, mix(this.near.trail, 0.82), this.near.head)
    if (!silent) {
      this.speakWords()
      const boost = Math.round((e * 0.55 + a * 0.35) * 50) / 50
      if (boost !== this.boost) {
        this.boost = boost
        // only the rain box carries the variable, so this restyles two canvases, not the whole construct
        this.host.style.setProperty('--cx-rain-boost', String(boost))
      }
    }
  }
  speakWords() {
    if (--this.nextIdle <= 0) {
      this.nextIdle = 210 + Math.random() * 240
      const pool = bus.pool
      if (pool.length && bus.queue.length === 0) bus.queue.push(pool[(Math.random() * pool.length) | 0])
    }
    if (bus.queue.length && this.words.length < 3 && this.t % 12 === 0) {
      const text = bus.queue.shift()!.toUpperCase().slice(0, 22)
      const L = this.near
      const len = text.length
      if (L.cols > len + 4) {
        const col = 2 + ((Math.random() * (L.cols - len - 4)) | 0)
        const row = 3 + ((Math.random() * Math.max(1, L.rows - 8)) | 0)
        this.words.push({ text, col, row, born: this.t, lock: [...text].map((_, i) => 6 + i * 2 + ((Math.random() * 10) | 0)), life: 95 })
      }
    }
    if (!this.words.length) return
    const L = this.near
    const { ctx, cell, dpr } = L
    ctx.font = L.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const amber = bus.alert > 0.2
    this.words = this.words.filter((w) => {
      const age = this.t - w.born
      if (age > w.life) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        return false
      }
      for (let i = 0; i < w.text.length; i++) {
        const ch = w.text[i]
        if (ch === ' ') continue
        // screen column -> mirrored canvas column
        const sc = w.col + i
        const cc = L.cols - 1 - sc
        const x = cc * cell
        const y = w.row * cell
        const locked = age >= w.lock[i]
        ctx.setTransform(-dpr, 0, 0, dpr, (x + cell) * dpr, 0)
        ctx.clearRect(0, y, cell, cell)
        ctx.fillStyle = locked ? (amber ? 'rgba(255,214,140,1)' : 'rgba(236,255,240,1)') : 'rgba(120,255,160,0.85)'
        if (locked) {
          ctx.shadowColor = amber ? 'rgba(255,176,0,0.9)' : 'rgba(57,255,20,0.9)'
          ctx.shadowBlur = 10
        }
        ctx.fillText(locked ? ch : glyph(), cell / 2, y)
        ctx.shadowBlur = 0
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return true
    })
  }
}
