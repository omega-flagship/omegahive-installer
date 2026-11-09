import { buildFigureMask, FIG_H, FIG_W } from './anatomy'

/**
 * The atmosphere beneath the classic map, carried forward from the legacy atmosphere.js: a two-level domain-warped
 * nebula; translucent membranes with luminous, noise-warped rims (territories, the structure in focus); a figure lit
 * from within, shaded from the anatomy mask (r body, g organs, b nerves, a halo) and lit by the territories behind
 * it; dust that twinkles. Rendered at reduced resolution: it is soft light, and the sharp SVG layer carries detail.
 */

const VS = `#version 300 es
in vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0., 1.); }`

const FS = `#version 300 es
precision highp float; in vec2 v; out vec4 o;
uniform vec2 R; uniform float S; uniform float T; uniform vec2 C; uniform float DIM;
uniform int N; uniform vec4 M[24]; uniform vec4 MC[24];
uniform sampler2D F; uniform vec4 FR; uniform float FA; uniform float PULSE; uniform float WARM;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1)); return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
float fbm(vec2 p) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= .5; } return s; }
float fbm3(vec2 p) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = m * p; a *= .5; } return s; }
void main() {
  vec2 px = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y) / S;
  vec2 uv = px / (R.y / S);
  vec2 q = uv * 1.5 + C * 0.00009;
  vec2 w = vec2(fbm(q + vec2(0., T * .010)), fbm(q + vec2(5.2, 1.3) - T * .007));
  float n = fbm(q + 1.15 * w);
  float n2 = fbm(q * 2.2 + 2.6 * w + vec2(T * .015, 0.));
  vec3 base = vec3(.014, .022, .040);
  vec3 cA = vec3(.28, .36, .92), cB = vec3(.64, .40, .96), cC = vec3(.24, .78, .94), cD = vec3(1.0, .54, .48);
  vec3 neb = mix(cA, cB, smoothstep(.30, .72, n2));
  neb = mix(neb, cC, smoothstep(.56, .86, fbm3(q * .8 + w.yx + 2.1)));
  neb = mix(neb, cD, smoothstep(.70, .92, fbm3(q * 1.3 - w + 7.3)) * (.45 + .25 * WARM));
  float cloud = smoothstep(.34, .80, n) * .70 + smoothstep(.55, .92, n2) * .32;
  vec3 col = base + neb * cloud * 1.15 * (1. - DIM * .55);
  col += cC * smoothstep(.78, .96, n2) * .35 * (1. - DIM * .6) + cB * smoothstep(.80, .97, n) * .3 * (1. - DIM * .6);
  vec3 territoryLight = vec3(0.);
  for (int i = 0; i < 24; i++) {
    if (i >= N) break; vec4 m = M[i]; vec4 mc = MC[i]; if (mc.a < .004) continue;
    vec2 d2 = (px - m.xy) / m.z; float d = length(d2);
    d += .40 * (fbm3(px * .0032 + float(i) * 7.1 + vec2(T * .018, -T * .012)) - .5);
    float body = smoothstep(1.08, .10, d);
    float rim = exp(-pow((d - .84) * 6.5, 2.)) * m.w;
    float inner = exp(-pow(d * 2.2, 2.)) * .5;
    col += mc.rgb * (body * .15 + rim * .48 + inner * .35) * mc.a;
    territoryLight += mc.rgb * exp(-dot(d2, d2) * 1.4) * mc.a;
  }
  vec2 fuv = (px - FR.xy) / FR.zw;
  if (FA > .002 && all(greaterThan(fuv, vec2(0.))) && all(lessThan(fuv, vec2(1.)))) {
    vec4 f = texture(F, fuv); float inside = f.r, organs = f.g, fil = f.b, halo = f.a;
    float contour = smoothstep(.03, .42, inside) * (1. - smoothstep(.45, .96, inside));
    float volume = smoothstep(.12, .82, inside);
    float sideLight = clamp(1. - abs(fuv.x - .38) * 1.65, .0, 1.);
    float grain = fbm3(fuv * vec2(8., 15.) + vec2(0., -T * .012));
    float flow = .5 + .5 * sin(fuv.y * 52. - T * .6 + grain * 5.);
    vec3 tissue = mix(vec3(.11, .19, .43), vec3(.39, .52, .83), sideLight);
    col += halo * vec3(.16, .25, .58) * .24 * FA;
    col += inside * tissue * (.29 + .18 * grain) * FA;
    col += volume * min(territoryLight, vec3(1.8)) * (.30 + .20 * PULSE) * FA;
    col += contour * vec3(.40, .65, .90) * .20 * FA;
    col += fil * vec3(.50, .83, 1.0) * (.26 + .45 * flow + .20 * PULSE) * FA;
    col += organs * mix(vec3(1.0, .54, .48), vec3(.84, .62, 1.0), fuv.y) * (.52 + .33 * PULSE) * FA;
  }
  vec2 g = px * .045; vec2 ci = floor(g), cf = fract(g); float h = hash(ci); vec2 sp = vec2(hash(ci + 1.7), hash(ci + 3.1));
  float ds = length(cf - sp); float tw = .55 + .45 * sin(T * (.8 + h * 1.6) + h * 30.);
  float star = smoothstep(.05, .0, ds) * step(.935, h) * tw;
  col += star * mix(vec3(.85, .92, 1.), vec3(.6, .85, 1.), h) * .9;
  float vg = 1. - .38 * pow(length(v * vec2(1., .85)), 2.4);
  o = vec4(col * vg, 1.);
}`

export interface Membrane {
  x: number
  y: number
  r: number
  rim?: number
  rgb: [number, number, number]
  a: number
}

export interface Frame {
  t: number
  cam: { x: number; y: number }
  dim: number
  membranes: Membrane[]
  /** Figure rect in css px: x, y, w, h. */
  figure: { rect: [number, number, number, number]; alpha: number }
  pulse: number
  warm?: number
}

export const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

type U = 'R' | 'S' | 'T' | 'C' | 'DIM' | 'N' | 'M' | 'MC' | 'F' | 'FR' | 'FA' | 'PULSE' | 'WARM'

export class Atmosphere {
  private gl: WebGL2RenderingContext | null = null
  private prog: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private u = {} as Record<U, WebGLUniformLocation | null>
  private figReady = false
  private lost = false
  private q: number
  private dpr = 1
  private M = new Float32Array(24 * 4)
  private MC = new Float32Array(24 * 4)
  private readonly canvas: HTMLCanvasElement
  private readonly onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
  }
  private readonly onRestored = () => {
    this.lost = false
    this.setup()
  }

  constructor(canvas: HTMLCanvasElement, quality?: number) {
    this.canvas = canvas
    this.q = quality ?? (window.devicePixelRatio > 1.5 ? 0.45 : 0.6)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' })
    if (this.gl) this.setup()
  }

  get ok() {
    return !!this.gl && !!this.prog && !this.lost
  }

  private compile(type: number, src: string) {
    const gl = this.gl!
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }

  private setup() {
    const gl = this.gl
    if (!gl) return
    try {
      const prog = gl.createProgram()!
      gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, VS))
      gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, FS))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
      gl.useProgram(prog)
      this.prog = prog
    } catch (e) {
      console.warn('atlas atmosphere unavailable', e)
      this.prog = null
      return
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(this.prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    for (const k of ['R', 'S', 'T', 'C', 'DIM', 'N', 'M', 'MC', 'F', 'FR', 'FA', 'PULSE', 'WARM'] as U[]) this.u[k] = gl.getUniformLocation(this.prog, k)
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, p, v)
    gl.uniform1i(this.u.F, 0)
    this.figReady = false
    // the anatomy mask is built off the critical path; until then the figure is simply absent
    const build = () => {
      if (!this.gl || this.lost) return
      const m = buildFigureMask(1)
      if (!m) return
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.w, m.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data)
      this.figReady = true
      this.onFigure?.()
    }
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback
    if (ric) ric(build, { timeout: 400 })
    else setTimeout(build, 30)
  }

  /** Called once the figure mask is on the GPU (a demand-rendered scene draws again). */
  onFigure?: () => void

  resize(w: number, h: number, dpr: number) {
    if (!this.gl) return
    this.dpr = Math.min(dpr, 2)
    this.canvas.width = Math.max(1, Math.round(w * this.dpr * this.q))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr * this.q))
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  render(f: Frame) {
    const gl = this.gl
    if (!gl || !this.prog || this.lost) return
    const u = this.u
    gl.uniform2f(u.R, this.canvas.width, this.canvas.height)
    gl.uniform1f(u.S, this.dpr * this.q)
    gl.uniform1f(u.T, f.t / 1000)
    gl.uniform2f(u.C, f.cam.x, f.cam.y)
    gl.uniform1f(u.DIM, f.dim)
    gl.uniform1f(u.WARM, f.warm ?? 0)
    const n = Math.min(24, f.membranes.length)
    this.M.fill(0)
    this.MC.fill(0)
    for (let i = 0; i < n; i++) {
      const m = f.membranes[i]
      this.M.set([m.x, m.y, Math.max(1, m.r), m.rim ?? 0.6], i * 4)
      this.MC.set([m.rgb[0], m.rgb[1], m.rgb[2], m.a], i * 4)
    }
    gl.uniform1i(u.N, n)
    gl.uniform4fv(u.M, this.M)
    gl.uniform4fv(u.MC, this.MC)
    gl.uniform4f(u.FR, ...f.figure.rect)
    gl.uniform1f(u.FA, this.figReady ? f.figure.alpha : 0)
    gl.uniform1f(u.PULSE, f.pulse)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    const gl = this.gl
    if (gl) {
      if (this.tex) gl.deleteTexture(this.tex)
      if (this.prog) gl.deleteProgram(this.prog)
    }
    this.gl = null
  }
}

export { FIG_H, FIG_W }
