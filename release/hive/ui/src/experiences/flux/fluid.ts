/**
 * Flux fluid engine: a stable-fluids (Navier-Stokes) solver on ping-pong half-float targets, plus one display pass
 * that draws the ink, liquid-metal metaballs (back and front layers) and liquid-glass regions cut from the same
 * liquid. Pure three.js, one WebGL context, one fullscreen triangle.
 */
import * as THREE from 'three'

export const MAXB = 48
const MAXS = 16
// pill, an open panel, a sheet, a decision card, and the universal Ask's liquid capsule
const MAXG = 5

const BASE_VERT = /* glsl */ `
uniform vec2 texel;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vL = vUv - vec2(texel.x, 0.0);
  vR = vUv + vec2(texel.x, 0.0);
  vT = vUv + vec2(0.0, texel.y);
  vB = vUv - vec2(0.0, texel.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const HEAD = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
`

const CURL = HEAD + /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`

const VORTICITY = HEAD + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
  gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`

const DIVERGENCE = HEAD + /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

const CLEAR = HEAD + /* glsl */ `
uniform sampler2D uTexture;
uniform float value;
void main() { gl_FragColor = value * texture2D(uTexture, vUv); }`

const PRESSURE = HEAD + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float d = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}`

const GRADIENT = HEAD + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`

const ADVECT = HEAD + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 velTexel;
uniform float dt;
uniform float dissipation;
void main() {
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * velTexel;
  gl_FragColor = texture2D(uSource, coord) / (1.0 + dissipation * dt);
}`

const SPLAT = HEAD + /* glsl */ `
uniform sampler2D uTarget;
uniform float aspect;
uniform int count;
uniform vec4 sp[${MAXS}];
uniform vec4 sv[${MAXS}];
void main() {
  vec3 base = texture2D(uTarget, vUv).xyz;
  for (int i = 0; i < ${MAXS}; i++) {
    if (i >= count) break;
    vec2 p = vUv - sp[i].xy;
    p.x *= aspect;
    float g = exp(-dot(p, p) / sp[i].z);
    if (sp[i].w > 0.5) {
      vec2 dir = p / (length(p) + 0.0001);
      dir.x /= aspect;
      base.xy += dir * sv[i].x * g * smoothstep(0.0, 0.02, length(p));
    } else {
      base += sv[i].xyz * g;
    }
  }
  gl_FragColor = vec4(base, 1.0);
}`

const DISPLAY = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDye;
uniform vec2 uRes;
uniform float uTime;
uniform int uCount;
uniform int uSplit;
uniform vec4 uB[${MAXB}];
uniform vec4 uC[${MAXB}];
uniform int uGlassN;
uniform vec4 uG[${MAXG}];
uniform vec4 uGc[${MAXG}];
uniform float uCeil;
uniform vec3 uCeilCol;
uniform float uDim;

const float T = 0.24;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

float sdRound(vec2 p, vec2 c, vec2 h, float r) {
  vec2 q = abs(p - c) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float glassSd(vec2 p) {
  float d = 1e5;
  for (int i = 0; i < ${MAXG}; i++) {
    if (i >= uGlassN) break;
    vec4 g = uG[i];
    vec4 k = uGc[i];
    float s = sdRound(p, g.xy + g.zw * 0.5, g.zw * 0.5, k.x);
    if (k.w >= 0.0) s = max(s, length(p - k.yz) - k.w);
    d = min(d, s);
  }
  return d;
}

vec2 toUv(vec2 p) { return vec2(p.x / uRes.x, 1.0 - p.y / uRes.y); }

vec3 dyeAt(vec2 p) {
  vec3 d = texture2D(uDye, toUv(p)).rgb;
  return 1.0 - exp(-max(d, 0.0) * 0.95);
}

vec3 baseBg(vec2 p) {
  vec2 q = p / uRes;
  vec3 c = mix(vec3(0.055, 0.022, 0.105), vec3(0.03, 0.012, 0.06), q.y);
  vec2 a = q - vec2(0.82, 0.08); vec2 b = q - vec2(0.12, 0.92); vec2 m = q - vec2(0.5, 0.55);
  c += vec3(0.32, 0.06, 0.38) * 0.22 * exp(-7.0 * dot(a, a));
  c += vec3(0.05, 0.16, 0.36) * 0.22 * exp(-6.0 * dot(b, b));
  c += vec3(0.16, 0.05, 0.22) * 0.12 * exp(-3.0 * dot(m, m));
  return c;
}

// Wyvill metaball field for one layer, with its gradient and a colour blend.
void field(vec2 p, float layer, out float f, out vec2 g, out vec3 col, out float e) {
  f = 0.0; g = vec2(0.0); col = vec3(0.0); e = 0.0;
  float w = 0.0;
  int start = layer < 0.5 ? 0 : uSplit;
  int end = layer < 0.5 ? uSplit : uCount;
  for (int k = 0; k < ${MAXB}; k++) {
    int i = start + k;
    if (i >= end) break;
    vec4 b = uB[i];
    if (b.z < 0.5) continue;
    vec2 d = p - b.xy;
    float R = b.z * 1.645;
    float q = dot(d, d) / (R * R);
    if (q >= 1.0) continue;
    float o = 1.0 - q;
    float fi = o * o * o;
    f += fi;
    g += -6.0 * o * o * d / (R * R);
    float wi = fi * fi + 1e-6;
    col += uC[i].rgb * wi;
    e += uC[i].a * wi;
    w += wi;
  }
  if (layer < 0.5 && uCeil > 0.001) {
    float H = 30.0 + 8.0 * sin(p.x * 0.013 + uTime * 0.9) + 4.0 * sin(p.x * 0.031 - uTime * 1.3);
    float q = clamp(p.y / H, 0.0, 1.0);
    float o = 1.0 - q;
    float fi = uCeil * o * o * o * 0.9;
    f += fi;
    g += vec2(0.0, -uCeil * 2.7 * o * o / H);
    float wi = fi * fi + 1e-6;
    col += uCeilCol * wi; e += 0.8 * wi; w += wi;
  }
  if (w > 0.0) { col /= w; e /= w; }
}

vec3 liquid(vec3 under, vec2 p, float f, vec2 g, vec3 tint, float e, float soft) {
  float aa = max(fwidth(f), 0.0005) * (1.0 + soft * 14.0);
  float a = smoothstep(T - aa, T + aa, f);
  vec3 n = normalize(vec3(-g * 34.0, 1.0));
  vec3 L = normalize(vec3(-0.55, -0.8, 0.5));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float ndh = max(dot(n, H), 0.0);
  float fres = pow(1.0 - n.z, 1.6);
  vec3 refr = dyeAt(p - n.xy * 46.0);
  float tl = dot(tint, vec3(0.299, 0.587, 0.114));
  vec3 iri = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fres * 1.4 + tl * 1.7 + uTime * 0.025));
  float depth = smoothstep(T, T + 0.9, f);
  vec3 core = tint * (0.32 + 0.6 * e) * (0.55 + 0.45 * depth);
  vec3 c = core + refr * 0.42 * (0.4 + 0.6 * e);
  c += iri * fres * (0.38 + 0.4 * e);
  float caust = pow(max(dot(normalize(n.xy + 1e-5), -L.xy), 0.0), 3.0) * (1.0 - n.z);
  c += tint * caust * 1.1 * e;
  c += vec3(1.0, 0.97, 1.0) * (pow(ndh, 70.0) * 1.3 + pow(ndh, 9.0) * 0.14) * (1.0 - soft * 0.7);
  c = mix(c, c * 0.55 + vec3(0.02, 0.01, 0.04), soft * 0.5);
  float halo = smoothstep(0.0, T, f) * (1.0 - a);
  return mix(under, c, a) + tint * halo * halo * (0.12 + 0.35 * e) * (1.0 - soft * 0.6);
}

void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);

  // liquid glass: signed distance, edge band refraction, frost
  float gd = glassSd(p);
  float inG = smoothstep(1.0, -1.0, gd);
  vec2 offs = vec2(0.0);
  vec2 gn = vec2(0.0);
  if (gd < 20.0 && uGlassN > 0) {
    vec2 h = vec2(1.0, 0.0);
    gn = normalize(vec2(glassSd(p + h.xy) - glassSd(p - h.xy), glassSd(p + h.yx) - glassSd(p - h.yx)) + 1e-5);
    float band = clamp(1.0 + gd / 22.0, 0.0, 1.0) * inG;
    offs = -gn * band * band * 26.0;
  }
  vec2 pb = p + offs;

  vec3 col = baseBg(pb);
  vec3 ink;
  if (inG > 0.01) {
    float r = 9.0 * inG;
    ink = (dyeAt(pb) * 2.0 + dyeAt(pb + vec2(r, r)) + dyeAt(pb + vec2(-r, r)) + dyeAt(pb + vec2(r, -r)) + dyeAt(pb + vec2(-r, -r))) / 6.0;
  } else {
    ink = dyeAt(pb);
  }
  col = col * (1.0 - ink * 0.3) + ink * ink * 0.35 + ink * 0.3;
  col *= 1.0 - uDim * 0.35;

  float f; vec2 g; vec3 tint; float e;
  field(pb, 0.0, f, g, tint, e);
  col = liquid(col, pb, f, g, tint, e * (1.0 - uDim * 0.4), inG);

  if (inG > 0.001) {
    vec3 glassBase = vec3(0.045, 0.025, 0.085);
    vec3 frosted = glassBase + min(col * 0.32, vec3(0.2));
    // soft sheen from the top-left
    float sheen = 0.035 * smoothstep(1.0, 0.0, (p.y) / uRes.y);
    col = mix(col, frosted + sheen, inG);
    float edge = smoothstep(1.6, 0.0, abs(gd));
    float lit = 0.25 + 0.75 * max(dot(gn, normalize(vec2(-0.6, -1.0))), 0.0);
    col += vec3(1.0, 0.95, 1.0) * edge * lit * 0.55;
    float inner = smoothstep(7.0, 1.5, -gd) * inG;
    col += vec3(0.85, 0.75, 1.0) * inner * 0.05;
  }

  if (uCount > uSplit) {
    field(p, 1.0, f, g, tint, e);
    col = liquid(col, p, f, g, tint, e, 0.0);
  }

  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.35 * dot(q, q);
  col += (hash(p + fract(uTime)) - 0.5) * 0.018;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`

type DoubleRT = { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap(): void }

export interface Splat {
  x: number
  y: number
  r: number
  /** velocity (px/s-ish) or dye rgb */
  a: number
  b: number
  c: number
  radial?: boolean
}

export interface GlassRegion {
  x: number
  y: number
  w: number
  h: number
  radius: number
  clip: { x: number; y: number; r: number } | null
}

export class FluidEngine {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mesh: THREE.Mesh
  private mats: Record<string, THREE.ShaderMaterial> = {}
  private vel!: DoubleRT
  private dye!: DoubleRT
  private pressure!: DoubleRT
  private div!: THREE.WebGLRenderTarget
  private curl!: THREE.WebGLRenderTarget
  private simW = 0
  private simH = 0
  private dyeW = 0
  private dyeH = 0
  private cssW = 1
  private cssH = 1
  readonly B: THREE.Vector4[] = Array.from({ length: MAXB }, () => new THREE.Vector4())
  readonly C: THREE.Vector4[] = Array.from({ length: MAXB }, () => new THREE.Vector4())
  private G: THREE.Vector4[] = Array.from({ length: MAXG }, () => new THREE.Vector4())
  private Gc: THREE.Vector4[] = Array.from({ length: MAXG }, () => new THREE.Vector4())
  private sp: THREE.Vector4[] = Array.from({ length: MAXS }, () => new THREE.Vector4())
  private sv: THREE.Vector4[] = Array.from({ length: MAXS }, () => new THREE.Vector4())

  constructor(canvas: HTMLCanvasElement, private opts: { simRes: number; dyeRes: number; dpr: number }) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })
    this.renderer.autoClear = false
    this.renderer.setPixelRatio(opts.dpr)
    // a shader that fails to compile is logged by three, not thrown: remember it, so the liquid can step aside
    this.renderer.debug.onShaderError = () => {
      this.broken = true
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    this.mesh = new THREE.Mesh(geo)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: BASE_VERT, fragmentShader: frag, uniforms: { texel: { value: new THREE.Vector2() }, ...uniforms }, depthTest: false, depthWrite: false })
    this.mats.curl = mk(CURL, { uVelocity: { value: null } })
    this.mats.vort = mk(VORTICITY, { uVelocity: { value: null }, uCurl: { value: null }, curl: { value: 22 }, dt: { value: 0 } })
    this.mats.div = mk(DIVERGENCE, { uVelocity: { value: null } })
    this.mats.clear = mk(CLEAR, { uTexture: { value: null }, value: { value: 0.8 } })
    this.mats.pressure = mk(PRESSURE, { uPressure: { value: null }, uDivergence: { value: null } })
    this.mats.grad = mk(GRADIENT, { uPressure: { value: null }, uVelocity: { value: null } })
    this.mats.advect = mk(ADVECT, { uVelocity: { value: null }, uSource: { value: null }, velTexel: { value: new THREE.Vector2() }, dt: { value: 0 }, dissipation: { value: 0 } })
    this.mats.splat = mk(SPLAT, { uTarget: { value: null }, aspect: { value: 1 }, count: { value: 0 }, sp: { value: this.sp }, sv: { value: this.sv } })
    this.mats.display = mk(DISPLAY, {
      uDye: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uCount: { value: 0 },
      uSplit: { value: 0 },
      uB: { value: this.B },
      uC: { value: this.C },
      uGlassN: { value: 0 },
      uG: { value: this.G },
      uGc: { value: this.Gc },
      uCeil: { value: 0 },
      uCeilCol: { value: new THREE.Color(1, 0.7, 0.9) },
      uDim: { value: 0 },
    })
  }

  private rt(w: number, h: number) {
    return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })
  }
  private double(w: number, h: number): DoubleRT {
    const d = { read: this.rt(w, h), write: this.rt(w, h), swap() { const t = d.read; d.read = d.write; d.write = t } }
    return d
  }
  /** Set when a shader failed to compile (three only logs it). */
  broken = false

  /**
   * Whether this GPU can actually run the liquid: the half-float targets are complete framebuffers (a GPU without
   * float colour buffers makes them incomplete, which three does not report) and every shader compiled. Call after
   * resize; a false answer means the static liquid should be used instead.
   */
  healthy(): boolean {
    if (this.broken) return false
    const gl = this.renderer.getContext()
    if (gl.isContextLost()) return false
    this.renderer.setRenderTarget(this.vel.read)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    this.renderer.setRenderTarget(null)
    if (!ok) return false
    for (const m of Object.values(this.mats)) this.renderer.compile(new THREE.Mesh(this.mesh.geometry, m), new THREE.Camera())
    return !this.broken
  }

  private disposeTargets() {
    for (const d of [this.vel, this.dye, this.pressure]) if (d) { d.read.dispose(); d.write.dispose() }
    this.div?.dispose()
    this.curl?.dispose()
  }

  resize(w: number, h: number) {
    this.cssW = Math.max(1, w)
    this.cssH = Math.max(1, h)
    this.renderer.setSize(this.cssW, this.cssH, false)
    const res = (base: number) => {
      const aspect = this.cssW / this.cssH
      return aspect >= 1 ? [Math.round(base * aspect), base] : [base, Math.round(base / aspect)]
    }
    const [sw, sh] = res(this.opts.simRes)
    const [dw, dh] = res(this.opts.dyeRes)
    if (sw === this.simW && sh === this.simH && dw === this.dyeW && dh === this.dyeH) return
    this.disposeTargets()
    this.simW = sw; this.simH = sh; this.dyeW = dw; this.dyeH = dh
    this.vel = this.double(sw, sh)
    this.pressure = this.double(sw, sh)
    this.dye = this.double(dw, dh)
    this.div = this.rt(sw, sh)
    this.curl = this.rt(sw, sh)
    for (const t of [this.vel.read, this.vel.write, this.pressure.read, this.pressure.write, this.dye.read, this.dye.write, this.div, this.curl]) {
      this.renderer.setRenderTarget(t)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear()
    }
    this.renderer.setRenderTarget(null)
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, tw: number, th: number) {
    ;(mat.uniforms.texel.value as THREE.Vector2).set(1 / tw, 1 / th)
    this.mesh.material = mat
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.cam)
  }

  private splatBatch(target: DoubleRT, list: Splat[], w: number, h: number) {
    const m = this.mats.splat
    m.uniforms.aspect.value = this.cssW / this.cssH
    for (let i = 0; i < list.length; i += MAXS) {
      const n = Math.min(MAXS, list.length - i)
      for (let k = 0; k < n; k++) {
        const s = list[i + k]
        const rn = s.r / this.cssH
        this.sp[k].set(s.x / this.cssW, 1 - s.y / this.cssH, Math.max(rn * rn, 1e-6), s.radial ? 1 : 0)
        this.sv[k].set(s.a, s.b, s.c, 0)
      }
      m.uniforms.count.value = n
      m.uniforms.uTarget.value = target.read.texture
      this.pass(m, target.write, w, h)
      target.swap()
    }
  }

  /** Advance the fluid. Velocity splats a,b are px/s in screen space (y down). */
  step(dt: number, velSplats: Splat[], dyeSplats: Splat[], dissipation: { vel: number; dye: number }) {
    const { simW: sw, simH: sh, dyeW: dw, dyeH: dh } = this
    if (!sw) return
    // screen px/s -> sim texels/s, y up
    const sx = sw / this.cssW, sy = sh / this.cssH
    for (const s of velSplats) if (!s.radial) { s.a *= sx; s.b *= -sy; s.c = 0 } else { s.a *= sx }
    if (velSplats.length) this.splatBatch(this.vel, velSplats, sw, sh)
    if (dyeSplats.length) this.splatBatch(this.dye, dyeSplats, dw, dh)
    const M = this.mats
    M.curl.uniforms.uVelocity.value = this.vel.read.texture
    this.pass(M.curl, this.curl, sw, sh)
    M.vort.uniforms.uVelocity.value = this.vel.read.texture
    M.vort.uniforms.uCurl.value = this.curl.texture
    M.vort.uniforms.dt.value = dt
    this.pass(M.vort, this.vel.write, sw, sh)
    this.vel.swap()
    M.div.uniforms.uVelocity.value = this.vel.read.texture
    this.pass(M.div, this.div, sw, sh)
    M.clear.uniforms.uTexture.value = this.pressure.read.texture
    this.pass(M.clear, this.pressure.write, sw, sh)
    this.pressure.swap()
    M.pressure.uniforms.uDivergence.value = this.div.texture
    for (let i = 0; i < 14; i++) {
      M.pressure.uniforms.uPressure.value = this.pressure.read.texture
      this.pass(M.pressure, this.pressure.write, sw, sh)
      this.pressure.swap()
    }
    M.grad.uniforms.uPressure.value = this.pressure.read.texture
    M.grad.uniforms.uVelocity.value = this.vel.read.texture
    this.pass(M.grad, this.vel.write, sw, sh)
    this.vel.swap()
    const A = M.advect
    ;(A.uniforms.velTexel.value as THREE.Vector2).set(1 / sw, 1 / sh)
    A.uniforms.dt.value = dt
    A.uniforms.uVelocity.value = this.vel.read.texture
    A.uniforms.uSource.value = this.vel.read.texture
    A.uniforms.dissipation.value = dissipation.vel
    this.pass(A, this.vel.write, sw, sh)
    this.vel.swap()
    A.uniforms.uVelocity.value = this.vel.read.texture
    A.uniforms.uSource.value = this.dye.read.texture
    A.uniforms.dissipation.value = dissipation.dye
    this.pass(A, this.dye.write, dw, dh)
    this.dye.swap()
  }

  render(time: number, count: number, split: number, glass: GlassRegion[], ceil: number, ceilCol: [number, number, number], dim: number) {
    const D = this.mats.display
    D.uniforms.uDye.value = this.dye.read.texture
    ;(D.uniforms.uRes.value as THREE.Vector2).set(this.cssW, this.cssH)
    D.uniforms.uTime.value = time
    D.uniforms.uCount.value = count
    D.uniforms.uSplit.value = split
    const n = Math.min(MAXG, glass.length)
    for (let i = 0; i < n; i++) {
      const g = glass[i]
      this.G[i].set(g.x, g.y, g.w, g.h)
      this.Gc[i].set(Math.min(g.radius, g.w / 2, g.h / 2), g.clip?.x ?? 0, g.clip?.y ?? 0, g.clip ? g.clip.r : -1)
    }
    D.uniforms.uGlassN.value = n
    D.uniforms.uCeil.value = ceil
    ;(D.uniforms.uCeilCol.value as THREE.Color).setRGB(ceilCol[0], ceilCol[1], ceilCol[2])
    D.uniforms.uDim.value = dim
    this.pass(D, null, this.cssW, this.cssH)
  }

  dispose() {
    this.disposeTargets()
    for (const m of Object.values(this.mats)) m.dispose()
    this.mesh.geometry.dispose()
    this.renderer.dispose()
    // give the context back now, so remounts (an app opened and closed, a motion toggle) never pile them up
    this.renderer.forceContextLoss()
  }
}
