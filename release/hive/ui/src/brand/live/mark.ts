// @ts-nocheck: the reel renderer (the brand-mark r1 morph), shared as-is so the film and the app run
// the same code. Typed wrappers are in ../LiveOmega.tsx.
// The Omega living mark: one exact shape (traced from the glass master) whose MATERIAL comes from the environment (the
// look or app it is in) and whose CHANGE comes from the action (what is happening). Every material is alive while it holds
// (the galaxy drifts, aurora flows, leaves rustle, signals travel the graph). A change is one material literally turning
// into the other, in the new material's own way, while the old one reacts: cake pours over the flowers (its shadow falls
// ahead, petals drop), flowers sprout through cracks in the blocks (which split and tumble), blocks pixelate the old surface
// and drop in, graph lines thread through and fill, stars punch through as night falls, ink bleeds, paper peels back.
// All behaviour comes from MeTTa (omega-mark.metta → PeTTa → rules.json); this file only draws it.
//
//   const mark = await OmegaMark.create(canvas, { look: 'cosmos' })
//   mark.morphTo('bush', 'create')   // environment changes; the action decides how the new material arrives
//   mark.act('wake')                 // an action in place: the current material does it, no material change
//
// Actions are decoration bound to real events (a mind woke, a pattern was found…); words on screen always say the state.
// Reduced motion: a 300 ms crossfade, materials hold still and actions are skipped. The canvas is transparent unless stage: true.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { MarkFX } from './fx'
import { MarkSound } from './sound'

const LOOKS = {
  cosmos:       { edge: '#6a5ad0', style: 'stars' },
  classic:      { edge: '#7a6ae0', style: 'aurora' },
  flux:         { edge: '#c050c0', style: 'flow' },
  construct:    { edge: '#1e8a3a', style: 'scan' },
  still:        { edge: '#0d0b09', style: 'ink' },
  canvas:       { edge: '#2b48e0', style: 'peel' },
  omegatown:    { edge: '#14504a', style: 'bloom' },
  professional: { edge: '#1d3c8f', style: 'sweep' },
  brand:        { edge: '#14705f', style: 'bloom' },
  hyperon:      { edge: '#8a6a20', style: 'swarm' },
  atomspace:    { edge: '#5a4ac0', style: 'swarm' },
  glitch:       { edge: '#2a6aa0', style: 'glitch' },
  bush:         { edge: '#1f3a14', style: 'grow' },
  cake:         { edge: '#3a2214', style: 'drip' },
  voxel:        { edge: '#3a2a6a', style: 'build' },
}
// action → morph style (overrides the material's own); and what the action looks like in place
const ACTION_STYLE = { create: 'grow', wake: 'stars', rest: 'fade', learn: 'swarm', think: 'aurora', find: 'swarm', error: 'glitch', build: 'build', write: 'ink', approve: 'bloom' }
const STYLE_ID = { stars: 0, aurora: 1, flow: 2, scan: 3, ink: 4, peel: 5, bloom: 6, sweep: 7, swarm: 8, glitch: 9, grow: 10, drip: 11, build: 12, fade: 13, paint: 14, crystal: 15, forge: 16, flood: 17, notes: 18, inflate: 19 }
const EDGE_GLOW = { stars: '#fff2ff', aurora: '#b8f0ff', flow: '#ffb0f0', scan: '#7dff9b', ink: '#3a2a1a', peel: '#ffffff', bloom: '#d8fff0', sweep: '#e8f0ff', swarm: '#c8d8ff', glitch: '#5ff0ff', grow: '#6fbf3a', drip: '#ffd8a8', build: '#d0c0ff', fade: '#a0a0c0', paint: '#bff5e8', crystal: '#e8ffff', forge: '#ffb050', flood: '#ffe0f8', notes: '#ffffff', inflate: '#f0e8ff' }

// the same value noise in GLSL and JS, so particles are born exactly where the shader reveals the new material
const GLSL_NOISE = `
float sqr(float x){ return x * x; }   // GLSL pow() is undefined for negative bases: square explicitly
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 4; k++){ s += a * vnoise(p); p *= 2.03; a *= .5; } return s; }
vec3 vor(vec2 p){ vec2 i = floor(p), f = fract(p); float d1 = 8., d2 = 8., id = 0.;                 // (nearest seed, edge distance, seed id)
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)), r = g + vec2(h21(i + g), h21(i + g + 17.3)) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = h21(i + g + 3.1); } else if (d < d2) d2 = d; }
  return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), id); }
vec2 hexvor(vec2 p){ vec2 i = floor(p), f = fract(p); float best = 8., id = 0.;                       // (hexagonal distance to the nearest seed, seed id): crystals grow faceted
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)), q = abs(g + vec2(h21(i + g), h21(i + g + 17.3)) - f);
    float d = max(q.x * .866 + q.y * .5, q.y); if (d < best) { best = d; id = h21(i + g + 3.1); } }
  return vec2(best, id); }`
const fract = x => x - Math.floor(x)
function h21(x, y) { x = fract(x * 123.34); y = fract(y * 456.21); const d = x * (x + 45.32) + y * (y + 45.32); x += d; y += d; return fract(x * y) }
function vnoise(x, y) { const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const a = h21(ix, iy), b = h21(ix + 1, iy), c = h21(ix, iy + 1), d = h21(ix + 1, iy + 1); return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy }
function fbm(x, y) { let s = 0, a = .5; for (let k = 0; k < 4; k++) { s += a * vnoise(x, y); x *= 2.03; y *= 2.03; a *= .5 } return s }
function vor(px, py) { const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy; let d1 = 8, d2 = 8, id = 0
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { const gx = ix + x, gy = iy + y, rx = x + h21(gx, gy) - fx, ry = y + h21(gx + 17.3, gy + 17.3) - fy, d = rx * rx + ry * ry
    if (d < d1) { d2 = d1; d1 = d; id = h21(gx + 3.1, gy + 3.1) } else if (d < d2) d2 = d }
  return [Math.sqrt(d1), Math.sqrt(d2) - Math.sqrt(d1), id] }
function hexvor(px, py) { const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy; let best = 8, id = 0
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { const gx = ix + x, gy = iy + y, qx = Math.abs(x + h21(gx, gy) - fx), qy = Math.abs(y + h21(gx + 17.3, gy + 17.3) - fy), d = Math.max(qx * .866 + qy * .5, qy)
    if (d < best) { best = d; id = h21(gx + 3.1, gy + 3.1) } }
  return [best, id] }

// reveal time r(m) in [0,1] for a point m in mark space (280 × 256, y down): the new material shows where r < progress
const GLSL_REVEAL = `
float reveal(vec2 m, int s){
  vec2 c = vec2(140., 135.); float d = length(m - c) / 190.;
  if (s == 0) { vec3 v = vor(m / 9.); return clamp(v.z * .86 + v.x * .2, 0., 1.); }                              // stars: points ignite, then spread
  if (s == 1) return clamp(.5 + .38 * sin(m.x * .045 + m.y * .02) * cos(m.y * .03) + .25 * (fbm(m * .02) - .5) + (m.x / 280. - .5) * .6, 0., 1.); // aurora ribbons
  if (s == 2) { vec2 w = m * .015 + vec2(fbm(m * .01), fbm(m * .01 + 3.)) * 2.5; return clamp(fbm(w) * 1.3 - .15 + (m.x + m.y) / 1100., 0., 1.); } // liquid flow
  if (s == 3) return clamp(m.y / 256. * .92 + .08 * h21(vec2(0., floor(m.y / 3.))), 0., 1.);                   // scan line, top to bottom
  if (s == 4) { vec3 v = vor(m / 45.); return clamp(v.z * .4 + v.x * .5 + .25 * (fbm(m * .04) - .5) + .2 * (fbm(m * .13) - .5) + .05, 0., 1.); } // ink drops bleed out
  if (s == 5) return clamp(((280. - m.x) + m.y) / 536. + .04 * (fbm(m * .05) - .5), 0., 1.);                 // paper peel, corner to corner
  if (s == 6 || s == 13 || s == 19) return clamp(d + .2 * (fbm(m * .025) - .5), 0., 1.);                                   // bloom from the centre
  if (s == 7) return clamp(m.x / 280. + .06 * sin(m.y * .05), 0., 1.);                                          // metal sweep
  if (s == 8) { vec3 v = vor(m / 30.); return clamp(.55 * min(1., v.y * 2.2) + .45 * (1. - d), 0., 1.); }        // graph lines thread in, then fill
  if (s == 9) { vec2 b = floor(m / vec2(28., 7.)); return clamp(h21(b) * .85 + .15 * h21(vec2(b.y, 3.)), 0., 1.); } // glitch blocks
  if (s == 10) { vec3 v = vor(m / 34.); return clamp(v.z * .42 + (1. - m.y / 256.) * .25 + v.x * .42 + .1 * (fbm(m * .35) - .5), 0., 1.); } // sprouts burst from seeds, base first
  if (s == 11) { float col = vnoise(vec2(m.x * .09, 1.)); return clamp(m.y / 256. * .75 - col * .25 + .2, 0., 1.); } // icing drips down
  if (s == 12) { vec2 b = floor(m / 12.); return clamp((1. - b.y * 12. / 256.) * .55 + h21(b) * .45, 0., 1.); }  // blocks build up
  if (s == 14) { float b = floor((m.y + 6. * sin(m.x * .04)) / 24.); float xp = mod(b, 2.) < .5 ? m.x / 280. : 1. - m.x / 280.;   // paint: brushed on, stroke by stroke
    return clamp((b + xp * .98) / 11. + .025 * (vnoise(vec2(m.x * .05, m.y * .9)) - .5), 0., 1.); }
  if (s == 15) { vec2 v = hexvor(m / 55.); return clamp(v.y * .35 + v.x * .62, 0., 1.); }   // crystal: frost grows from seeds
  if (s == 16) return clamp(m.x / 280. * .85 + .12 * fbm(m * .03) + .03 * sin(m.y * .08), 0., 1.);                                // forge: molten metal rolls across
  if (s == 17) return clamp((1. - m.y / 256.) * .9 + .05 + .03 * sin(m.x * .05), 0., 1.);                                         // flood: rises from the bottom
  if (s == 18) { float best = 1.; vec2 g0 = floor(m / 38.);                                                                         // notes: sticky notes slap on, one by one
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = g0 + vec2(float(x), float(y)); float h = h21(g + 9.);
      vec2 c = (g + .5) * 38. + (vec2(h21(g + 2.), h21(g + 5.)) - .5) * 8.; float a = (h - .5) * .4, sa = sin(a), ca = cos(a); vec2 q = mat2(ca, sa, -sa, ca) * (m - c);
      if (max(abs(q.x), abs(q.y)) < 24.) best = min(best, .06 + h * .82); }
    return best; }
  return d; }`
function reveal(mx, my, s) {
  const cx = 140, cy = 135, d = Math.hypot(mx - cx, my - cy) / 190, cl = v => Math.min(1, Math.max(0, v))
  switch (s) {
    case 0: { const v = vor(mx / 9, my / 9); return cl(v[2] * .86 + v[0] * .2) }
    case 1: return cl(.5 + .38 * Math.sin(mx * .045 + my * .02) * Math.cos(my * .03) + .25 * (fbm(mx * .02, my * .02) - .5) + (mx / 280 - .5) * .6)
    case 2: { const wx = mx * .015 + fbm(mx * .01, my * .01) * 2.5, wy = my * .015 + fbm(mx * .01 + 3, my * .01 + 3) * 2.5; return cl(fbm(wx, wy) * 1.3 - .15 + (mx + my) / 1100) }
    case 3: return cl(my / 256 * .92 + .08 * h21(0, Math.floor(my / 3)))
    case 4: { const v = vor(mx / 45, my / 45); return cl(v[2] * .4 + v[0] * .5 + .25 * (fbm(mx * .04, my * .04) - .5) + .2 * (fbm(mx * .13, my * .13) - .5) + .05) }
    case 5: return cl(((280 - mx) + my) / 536 + .04 * (fbm(mx * .05, my * .05) - .5))
    case 6: case 13: case 19: return cl(d + .2 * (fbm(mx * .025, my * .025) - .5))
    case 7: return cl(mx / 280 + .06 * Math.sin(my * .05))
    case 8: { const v = vor(mx / 30, my / 30); return cl(.55 * Math.min(1, v[1] * 2.2) + .45 * (1 - d)) }
    case 9: { const bx = Math.floor(mx / 28), by = Math.floor(my / 7); return cl(h21(bx, by) * .85 + .15 * h21(by, 3)) }
    case 10: { const v = vor(mx / 34, my / 34); return cl(v[2] * .42 + (1 - my / 256) * .25 + v[0] * .42 + .1 * (fbm(mx * .35, my * .35) - .5)) }
    case 11: return cl(my / 256 * .75 - vnoise(mx * .09, 1) * .25 + .2)
    case 12: { const bx = Math.floor(mx / 12), by = Math.floor(my / 12); return cl((1 - by * 12 / 256) * .55 + h21(bx, by) * .45) }
    case 14: { const b = Math.floor((my + 6 * Math.sin(mx * .04)) / 24), xp = ((b % 2) + 2) % 2 < .5 ? mx / 280 : 1 - mx / 280; return cl((b + xp * .98) / 11 + .025 * (vnoise(mx * .05, my * .9) - .5)) }
    case 15: { const v = hexvor(mx / 55, my / 55); return cl(v[1] * .35 + v[0] * .62) }
    case 16: return cl(mx / 280 * .85 + .12 * fbm(mx * .03, my * .03) + .03 * Math.sin(my * .08))
    case 17: return cl((1 - my / 256) * .9 + .05 + .03 * Math.sin(mx * .05))
    case 18: { let best = 1; const gx0 = Math.floor(mx / 38), gy0 = Math.floor(my / 38)
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { const gx = gx0 + x, gy = gy0 + y, h = h21(gx + 9, gy + 9), a = (h - .5) * .4, sa = Math.sin(a), ca = Math.cos(a)
        const dx = mx - ((gx + .5) * 38 + (h21(gx + 2, gy + 2) - .5) * 8), dy = my - ((gy + .5) * 38 + (h21(gx + 5, gy + 5) - .5) * 8), qx = ca * dx - sa * dy, qy = sa * dx + ca * dy
        if (Math.max(Math.abs(qx), Math.abs(qy)) < 24) best = Math.min(best, .06 + h * .82) }
      return best }
    default: return d
  }
}

// drawing data only: how each MeTTa living motion is drawn (shader id) and what drifts off it while it holds
const LIFE_ID = { 'galaxy-turns': 0, 'aurora-flows': 1, 'liquid-swirls': 2, 'scan-sweeps': 3, 'sheen-glides': 4, 'ink-traces': 5, 'sun-sheen': 6, 'metal-sweep': 7,
  'caustic-shimmer': 8, 'thoughts-travel': 9, 'graph-pulses': 10, 'glitch-flickers': 11, 'leaves-rustle': 12, 'icing-glistens': 13, 'blocks-pop': 14, 'fur-ruffles': 12, 'foil-shimmer': 7, still: -1 }
const AMBIENT = { 0: [['stars', 46]], 1: [['aurora', 10]], 2: [['flow', 9]], 3: [['scan', 14]], 4: [], 5: [], 6: [['bloom', 3]], 7: [], 8: [['sparkle', 8]],
  9: [['swarm', 9]], 10: [['swarm', 12]], 11: [['glitch', 26]], 12: [['leaf', 7], ['firefly', 5]], 13: [['sparkle', 10], ['drip', 3]], 14: [['build', 8]] }
// what breaks off the OLD material as the new one takes it over (coloured from the old material itself)
const DEBRIS = { stars: 'stars', build: 'chunk', glitch: 'glitch', swarm: 'swarm', aurora: 'aurora', scan: 'chunk', crystal: 'shard', flood: 'bubble', forge: 'spark' }
const OPAQUE = new Set(['chunk', 'leaf', 'sprinkle', 'ink', 'paint', 'scrap', 'shard'])   // drawn solid (normal blending), the rest are light

const VERT = `varying vec2 vM; varying float vS; varying vec3 vN; void main(){ vM = vec2(position.x, -position.y) - vec2(normal.x, -normal.y) * 1.; vS = .5 + .5 * normal.y; vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`
const ALIVE = `
float luma(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
vec2 uvOf(vec2 m){ return vec2((m.x * M.z + M.x) / 1024., 1. - (m.y * M.z + M.y) / 1024.); }
vec3 S(sampler2D tex, vec2 m){ return texture2D(tex, uvOf(m)).rgb; }
vec3 alive(sampler2D tex, vec2 m, int L, float seed){
  float t = lt + seed;   // the material's own clock: a behaviour can speed it up or slow it down
  if (L < 0) return S(tex, m);
  if (L == 0) {                                                            // galaxy-turns
    vec2 c = m.x < 150. ? vec2(78., 128.) : vec2(212., 118.); vec2 q = m - c; float r = length(q), a = atan(q.y, q.x);
    vec2 w = vec2(fbm(vec2(a * 2. - t * .35, r * .03)), fbm(vec2(a * 2. - t * .35 + 4., r * .03 + 2.))) - .5;
    vec3 col = S(tex, m + wind * (w * 5. + vec2(-q.y, q.x) / max(r, 1.) * sin(t * .6 + r * .05) * 2.2));
    col += smoothstep(.55, .95, luma(col)) * pow(vnoise(m * .7 + t * 2.5), 3.) * 1.2;
    col += (1. - smoothstep(0., 18., abs(m.x + m.y * .5 - mod(t * 90., 700.) + 120.))) * .18; return col; }
  if (L == 1) {                                                            // aurora-flows
    vec2 w = vec2(fbm(m * .02 + vec2(0., t * .4)) - .5, fbm(m * .02 + vec2(3., -t * .5)) - .5);
    vec3 col = S(tex, m + w * vec2(6., 10.) * wind);
    return col * (.8 + .45 * sqr(.5 + .5 * sin(m.x * .05 + m.y * .015 - t * 1.4 + fbm(m * .03 + t * .2) * 5.))); }
  if (L == 2) {                                                            // liquid-swirls
    vec2 q = m * .012; vec2 w1 = vec2(fbm(q + t * .15), fbm(q + 5.2 - t * .12)); vec2 w2 = vec2(fbm(q + w1 * 2. + t * .1), fbm(q + w1 * 2. + 1.7));
    vec3 col = S(tex, m + (w2 - .5) * 12. * wind); float sh = .5 + .5 * sin((w2.x + w2.y) * 9. + t * 1.2);
    return mix(col, col.gbr, .18 * sh) + pow(sh, 12.) * .25; }
  if (L == 3) {                                                            // scan-sweeps
    vec3 col = S(tex, m); float y = mod(t * 110., 380.) - 60.;
    float b = exp(-sqr((m.y - y) / 6.)) * 1.2 + exp(-max(0., y - m.y) / 40.) * step(m.y, y) * .25;
    col *= (.95 + .05 * sin(t * 7.)) * (.88 + .12 * step(.5, fract(m.y / 2.5))); return col + vec3(.3, 1., .45) * b * (.3 + luma(col)); }
  if (L == 4) {                                                            // sheen-glides
    vec3 col = S(tex, m + (vec2(fbm(m * .02 + t * .12), fbm(m * .02 - t * .1 + 3.)) - .5) * 4. * wind); float x = mod(t * 60., 520.) - 120.;   // reflections drift in the lacquer
    return col + exp(-sqr((m.x * .8 - m.y * .45 - x) / 22.)) * .42 * vec3(1., .95, .86) * (.5 + smoothstep(.0, .3, luma(col))); }
  if (L == 5) {                                                            // ink-traces
    vec3 col = S(tex, m); float blue = smoothstep(.1, .35, col.b - col.r); float a = atan(m.y - 135., m.x - 140.);
    col += blue * pow(.5 + .5 * sin(a * 3. - t * 2.4), 16.) * vec3(.45, .6, 1.) * 1.3; return col * (.97 + .05 * sin(t * .8 + m.x * .01)); }
  if (L == 6 || L == 7) {                                                  // sun-sheen, metal-sweep
    vec3 col = S(tex, m); float x = fract(t / (L == 6 ? 7. : 4.5)) * 620. - 150.;
    float s = exp(-sqr((m.x - m.y * .35 - x) / (L == 6 ? 40. : 14.))); return col + s * (L == 6 ? vec3(.35, .32, .2) : vec3(.6, .65, .75)) * (.4 + luma(col)); }
  if (L == 8) {                                                            // caustic-shimmer
    vec3 col = S(tex, m + (vec2(fbm(m * .03 + t * .3), fbm(m * .03 - t * .25 + 4.)) - .5) * 3. * wind);
    return col + pow(abs(sin(fbm(m * .04 + vec2(t * .25, -t * .2)) * 14.)), 10.) * vec3(.4, 1., .85) * .45; }
  if (L == 9 || L == 10) {                                                 // thoughts-travel, graph-pulses
    vec3 col = S(tex, m); float hi = smoothstep(.35, .8, luma(col));
    float wave = L == 9 ? pow(.5 + .5 * sin(length(m - vec2(140., 150.)) * .09 - t * 3. + fbm(m * .02) * 6.), 8.)
                        : pow(.5 + .5 * sin(t * 2.2 + h21(floor(m / 14.)) * 6.283), 10.);
    float wave2 = pow(.5 + .5 * sin(m.x * .06 - m.y * .03 - t * 2.), 14.);
    vec3 tint = L == 9 ? (m.x < 150. ? vec3(1., .78, .35) : vec3(.4, 1., .95)) : vec3(.75, .8, 1.);
    return col + hi * (wave * 1.3 + wave2 * .6) * tint; }
  if (L == 11) {                                                           // glitch-flickers
    float burst = step(.62, vnoise(vec2(t * 1.7, 2.))), row = floor(m.y / 6.);
    vec2 mm = m + vec2(burst * (h21(vec2(row, floor(t * 15.))) - .5) * 26., 0.); float o = burst * 3. + 1.;
    vec3 col = vec3(S(tex, mm + vec2(o, 0.)).r, S(tex, mm).g, S(tex, mm - vec2(o, 0.)).b) * (.85 + .15 * step(.5, fract(m.y / 3. + t * 2.)));
    col += burst * step(.93, h21(vec2(floor(m.x / 24.), row + floor(t * 10.)))) * vec3(.2, .9, 1.) * .8; return col * (.95 + .05 * sin(t * 9.)); }
  if (L == 12) {                                                           // leaves-rustle
    float up = 1. - m.y / 256.; vec2 wv = wind * vec2(sin(t * 1.3 + m.y * .03) * 3.4 * up + sin(t * 2.1 + m.x * .05) * .8, 0.);
    vec2 jit = (vec2(vnoise(m * .35 + t * 1.6), vnoise(m * .35 - t * 1.4 + 7.)) - .5) * 1.8;
    vec3 col = S(tex, m + wv + jit * wind) * (1.02 + .45 * fbm(m * .025 + vec2(t * .18, t * .05)));
    return col + smoothstep(.75, 1., vnoise(m * .5 + t * .8)) * vec3(.25, .3, .05) * .5; }
  if (L == 13) {                                                           // icing-glistens
    vec3 base = S(tex, m); float f1 = fract(t * .3), f2 = fract(t * .3 + .5);                       // chocolate flows down the drips (flow map)
    vec3 fl = mix(S(tex, m - vec2(0., f1 * 10.)), S(tex, m - vec2(0., f2 * 10.)), abs(.5 - f1) * 2.);
    float choc = smoothstep(.38, .12, luma(base)) * smoothstep(.02, .06, luma(base)) * smoothstep(0., .05, base.r - base.b);
    vec3 col = mix(base, fl, choc); col += smoothstep(.5, .9, luma(col)) * pow(vnoise(m * .9 + t * 2.), 3.) * 1.6;
    float x = mod(t * 55., 560.) - 140.; return col + exp(-sqr((m.x + m.y * .3 - x) / 22.)) * .2 * vec3(1., .9, .8); }
  if (L == 14) {                                                           // blocks-pop
    vec2 cell = floor(m / 11.); float ph = t * 1.5 + h21(cell); float lift = step(.94, h21(cell + floor(ph))) * sin(fract(ph) * 3.1416);
    vec3 col = S(tex, m - vec2(0., lift * 2.5)) * (1. + lift * .45); vec2 f = fract(m / 11.); return col + lift * (step(f.x, .1) + step(f.y, .1)) * .25; }
  return S(tex, m); }`
// drawing data: how much real relief each living material has (height from its own image), how glossy it is, whether it
// is built of blocks; and how far the change front swells as it passes (a thick pour, a molten bulge, a rising flood)
const RELIEF = { 0: [0, .9, 0], 1: [0, .9, 0], 2: [1.5, .9, 0], 3: [0, .2, 0], 4: [0, .9, 0], 5: [.6, .05, 0], 6: [0, .6, 0], 7: [0, .9, 0], 8: [0, .9, 0],
  9: [1, .6, 0], 10: [1, .6, 0], 11: [0, .4, 0], 12: [6, .12, 0], 13: [4, .75, 0], 14: [0, .2, 1], '-1': [0, .5, 0] }
const BED_ROOT = { voxel: 130.81, bush: 174.61, cake: 220, professional: 146.83, cosmos: 110, hyperon: 196, glitch: 123.47, still: 164.81, flux: 207.65, canvas: 196, construct: 110, brand: 146.83, classic: 185, omegatown: 174.61, atomspace: 116.54 }   // each material's chord root
const BULGE = { inflate: 10, drip: 7, forge: 4, flood: 3.5, paint: 2, grow: 3, crystal: 1.5, notes: 2.5, build: 0, ink: 1 }
// the front face is a fine lit surface that really moves: relief from each material, the front swelling as it passes
const FACE_VERT = `uniform sampler2D tA, tB; uniform float p, time, rA, rB, bulge; uniform int sty, blkA, blkB; uniform vec4 M;
varying vec2 vM; varying float vS; varying vec3 vN; ${GLSL_NOISE} ${GLSL_REVEAL}
vec2 uvOf(vec2 m){ return vec2((m.x * M.z + M.x) / 1024., 1. - (m.y * M.z + M.y) / 1024.); }
float relief1(sampler2D t, vec2 m, float amt, int blk){ if (blk == 1) return 2. + 4. * h21(floor(m / 11.)); return dot(texture2D(t, uvOf(m)).rgb, vec3(.299, .587, .114)) * amt; }
float height(vec2 m){ float on = step(.001, p) * step(p, .999), e = p * 1.15 - .07, r = reveal(m, sty), ahead = r - e;
  return mix(relief1(tA, m, rA, blkA), relief1(tB, m, rB, blkB), smoothstep(e + .02, e - .02, r)) + bulge * exp(-sqr(ahead / .045)) * on; }
void main(){ vec2 m = vec2(position.x, -position.y); float h = height(m), d = 1.25;
  vN = normalize(vec3(-(height(m + vec2(d, 0.)) - h) / d, (height(m + vec2(0., d)) - h) / d, 1.)); vM = m; vS = 1.;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, position.z + h, 1.); }`
// one shape, two living materials: B takes A over along the style's front (p 0 → 1); A reacts just ahead of the front
const FRAG = `precision highp float; varying vec2 vM; varying float vS; varying vec3 vN;
uniform sampler2D tA, tB, mask, sdf; uniform float p, time, side, voice, attend, face, gA, gB, lt, wind, gain; uniform vec3 tint; uniform int sty, LA, LB; uniform vec3 glow, edgeA, edgeB; uniform vec4 M; ${GLSL_NOISE} ${GLSL_REVEAL} ${ALIVE}
void main(){
  vec2 m = vM, ma = m, mb = m; float on = step(.001, p) * step(p, .999);
  if (face > .5 && texture2D(mask, vec2(m.x / 280., 1. - m.y / 256.)).r < .5) discard;                       // the flat front ends at the outline, where the round bevel begins
  if (side > .5) { vec2 su = vec2(m.x / 280., 1. - m.y / 256.); float dd = texture2D(sdf, su).r * 32.;                   // the walls show the material's body,
    if (dd < 13.) { vec2 g = normalize(vec2(texture2D(sdf, su + vec2(.004, 0.)).r - texture2D(sdf, su - vec2(.004, 0.)).r, -(texture2D(sdf, su + vec2(0., .004)).r - texture2D(sdf, su - vec2(0., .004)).r)) + 1e-6);
      float step1 = (13. - dd) * .9;                                                                                      // not the still's painted rim
      for (int i = 0; i < 3; i++) { vec2 q = m + g * step1; if (texture2D(sdf, vec2(q.x / 280., 1. - q.y / 256.)).r * 32. > dd) break; step1 *= .5; }   // never past the middle of a thin tip
      m += g * step1; ma = m; mb = m; } }
  float e = p * 1.15 - .07, w = .05, r = reveal(m, sty), ahead = r - e;
  float near = (1. - smoothstep(0., .16, ahead)) * step(0., ahead) * on;      // old material the front is about to reach
  float fresh = (1. - smoothstep(0., .07, -ahead)) * step(ahead, 0.) * on;    // new material that has only just arrived
  if (sty == 12) { if (near > .05) ma = (floor(m / 7.) + .5) * 7.; mb.y -= fresh * 12. * h21(floor(m / 12.)); }   // old pixelates; new blocks drop in
  if (sty == 2) ma += (vec2(fbm(m * .03 + time), fbm(m * .03 - time + 4.)) - .5) * 16. * near;                    // old melts ahead of the flood
  if (sty == 10) { vec3 v = vor(m / 34.); ma += (vec2(vnoise(m * .2), vnoise(m * .2 + 5.)) - .5) * 5. * near; }   // old is pushed and split by the sprouts
  if (sty == 8 && on > 0.) { vec2 c = vec2(140., 135.), q = m - c; float a = p * 1.4 * near, s = sin(a), co = cos(a); ma = c + mat2(co, -s, s, co) * q; } // old swirls out
  if (sty == 9 && on > 0.) { float j = step(.5, h21(vec2(floor(m.y / 7.), floor(time * 15.)))) * (1. - abs(p * 2. - 1.)) * 14.; ma.x += j; mb.x -= j; }
  if (sty == 1 && on > 0.) { vec2 c = vec2(140., 135.), q = m - c; float a = 2.4 * near, sa = sin(a), ca = cos(a); ma = c + mat2(ca, -sa, sa, ca) * q * (1. - .25 * near); } // aurora: the old is drawn into a vortex
  if (sty == 17) { r += .035 * sin(m.x * .07 - time * 6.) * on; ahead = r - e; ma += vec2(sin(m.y * .2 + time * 7.), cos(m.x * .15 + time * 5.)) * 2.5 * near; } // the water sloshes; the old wobbles beneath
  if (sty == 16) ma.y += sin(m.x * .3 + time * 14.) * 1.2 * near;                                                // heat shimmer ahead of the molten front
  vec3 A = alive(tA, ma, LA, 0.), B = alive(tB, mb, LB, 0.);
  if (sty == 11) A *= 1. - .6 * near;                                                                          // the pour's shadow runs ahead of it
  if (sty == 10) { vec3 v = vor(m / 34.); A *= 1. - .8 * near * smoothstep(.12, 0., v.y); }                     // cracks open where sprouts push through
  if (sty == 0) { vec3 v = vor(m / 9.); A *= 1. - .3 * near; A += vec3(1., .95, 1.) * near * smoothstep(.2, 0., v.x) * 2.5; }   // night falls, stars are born ahead of the front
  if (sty == 4) A *= 1. - .65 * near * smoothstep(.35, .65, fbm(m * .05));                                     // ink stains spread
  if (sty == 3) A = mix(A, vec3(.2, 1., .4) * (.3 + luma(A)) * 1.3, near * .8 * step(.4, fract(m.y / 3.)));      // derezzes to phosphor
  if (sty == 12) { vec2 f = fract(m / 7.); A *= 1. - near * .35 * (step(f.x, .12) + step(f.y, .12)); }
  if (sty == 5) { float flap = step(0., ahead) * (1. - smoothstep(0., .07, ahead)) * on; A = mix(A, vec3(.96, .94, .87) * (.72 + .28 * smoothstep(0., .07, ahead)), flap); } // the lifted flap shows the paper's back
  if (sty == 11) B = B * (1. - .3 * fresh) + pow(fresh, 3.) * .7;                                               // a glossy lip leads the pour
  if (sty == 12) { vec2 f = fract(m / 12.); B += fresh * (step(f.x, .08) + step(f.y, .08)) * .5; }
  if (sty == 10) B *= 1. + .35 * fresh;
  if (sty == 16) { float heat = smoothstep(.28, 0., -ahead) * step(ahead, 0.) * on;                             // molten metal: white-hot at the front, cooling to blue
    B = mix(B, mix(vec3(1., .42, .08), vec3(1., .95, .8), smoothstep(.1, 0., -ahead)) * 1.5, pow(heat, 1.3)); A += vec3(.7, .18, .02) * near * near; }
  if (sty == 15) { A = mix(A, vec3(.82, .96, 1.) * (.25 + luma(A)), near * .75 * smoothstep(.3, .7, fbm(m * .09))); B += fresh * .7 + fresh * .9 * step(.88, h21(floor(m / 4.) + floor(time * 10.))); } // frost creeps ahead; new facets glint
  if (sty == 14) { B *= .86 + .14 * vnoise(vec2(m.x * .04, m.y * 1.4)); B += sqr(fresh) * .35; A *= 1. - .25 * near; }   // bristle streaks, wet paint
  if (sty == 18) { A *= 1. - .5 * near; B *= 1. + .3 * fresh; }                                                    // each note lands with a shadow and a flash
  if (sty == 17) B *= 1. + .25 * fresh;
  if (sty == 4) B += pow(fresh, 4.) * .45;                                                                         // wet ink sheen
  if (sty == 3) { vec2 gg = abs(fract(m / 9.) - .5); A = mix(A, vec3(.25, 1., .45), near * smoothstep(.42, .5, max(gg.x, gg.y)) * .9); } // the old turns to wireframe first
  float k = smoothstep(e + w * .35, e - w * .35, r);
  vec3 nW = normalize(vN), Lw = normalize(vec3(-.45, .6, .66)); vec3 col = side > .5 ? mix(A, B, k) * (.42 + .38 * max(dot(nW, Lw), 0.)) : mix(A, B, k);   // quiet walls: the material in shade, no rim highlight
  if (face > .5) { vec3 Lt = normalize(vec3(-.45, .6, .66)), H = normalize(Lt + vec3(0., 0., 1.)); float tilt = 1. - vN.z;          // real light on the real relief
    col *= 1. + (dot(vN, Lt) - Lt.z) * 1.5; col += pow(max(dot(vN, H), 0.), 90.) * mix(gA, gB, k) * smoothstep(.03, .08, tilt) * .35; }
  col = col * gain + tint;                                                                                   // a behaviour's light
  if (sty == 13) col *= mix(1., .55, smoothstep(.2, .8, p));
  float dc = length(m - vec2(140., 150.));                                                                         // speaking: light ripples out through the material
  col *= 1. + voice * (.45 + 1.6 * pow(.5 + .5 * sin(dc * .11 - time * 8.), 3.));
  if (side > .5) col *= 1. + attend * (.35 + .35 * sin(time * 3.));                                                 // listening: the rim breathes
  col += glow * (1. - smoothstep(0., w, abs(ahead))) * on * (sty == 4 ? -.6 : sty == 11 || sty == 5 || sty == 14 ? .25 : sty == 10 ? .35 : sty == 0 ? .3 : sty == 18 ? 0. : sty == 16 ? .6 : 1.1);
  gl_FragColor = vec4(col, 1.); }`

function insidePoly(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi) c = !c } return c }
function smoothLoop(P, n = 8) { const out = []   // closed Catmull-Rom through the traced points (make_sdf.py does the same)
  for (let i = 0; i < P.length; i++) { const p0 = P[(i - 1 + P.length) % P.length], p1 = P[i], p2 = P[(i + 1) % P.length], p3 = P[(i + 2) % P.length]
    for (let k = 0; k < n; k++) { const t = k / n, t2 = t * t, t3 = t2 * t; out.push([0, 1].map(c => .5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3))) } }
  return out }
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u) }

/** How far a behaviour is on (0–1) at scene time `clock`: eased in, held or run for its duration, eased out. The scene
 *  clock runs backwards in a rewind, so the result is clamped: crossing the start or the end never inverts or overshoots. */
export function behaviourLevel(B, clock) {
  const age = clock - B.t0, d = B.b.dur || 0
  const k = B.out !== undefined ? 1 - (clock - B.out) / .5 : d > 0 ? (age < .25 ? age / .25 : age < d ? 1 : 1 - (age - d) / .5) : age / .3
  return Math.min(1, Math.max(0, k))
}
export class OmegaMark {
  static async create(canvas, opts = {}) { const m = new OmegaMark(canvas, opts); try { await m.init(opts.look || 'cosmos') } catch (e) { m.dispose(); throw e } return m }
  /** Free everything on the GPU: geometries, materials and their textures, look textures, the composer, the context. Safe to call twice, or mid-init. */
  dispose() {
    if (this.disposed) return; this.disposed = true
    try {
      this.scene?.traverse((o) => { o.geometry?.dispose(); for (const m of (o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [])) { m.map?.dispose(); for (const u of Object.values(m.uniforms || {})) u?.value?.dispose?.(); m.dispose() } })
      for (const t of [...Object.values(this.tex || {}), ...Object.values(this.bg || {}), ...Object.values(this.sharp || {})]) t?.dispose?.()
      this.composer?.dispose?.(); this.renderer?.dispose(); this.renderer?.forceContextLoss?.()
    } catch { /* already gone */ }
  }
  constructor(canvas, opts) { this.canvas = canvas; this.base = opts.base || './'; this.stage = !!opts.stage; this.reduce = opts.reduce ?? matchMedia('(prefers-reduced-motion: reduce)').matches; this.showcase = !!opts.showcase; this.pr = opts.pixelRatio || 1; this.bloom = opts.bloom; this.texExt = opts.texExt || 'png'; this.camZ = opts.cameraZ; this.keepFrames = opts.preserveDrawingBuffer ?? true; this.withSound = opts.sound ?? true; this.filmPieces = opts.filmPieces ?? true }   // the app passes false: no puppy or balloon built at all   // the film reads frames back; the app passes false
  async init(look) {
    const W = this.canvas.width, H = this.canvas.height
    const R = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: this.keepFrames })
    R.setClearColor(0, 0); R.outputColorSpace = THREE.SRGBColorSpace; R.setPixelRatio(this.pr); R.setSize(W, H, false)   // pixel ratio 2 when filming: every edge supersampled
    this.data = await (await fetch(this.base + 'outline.json')).json()
    this.data.union = smoothLoop(this.data.union)                                 // the traced points become a smooth curve: no facets on the silhouette
    // the behaviour comes from MeTTa (omega-mark.metta, evaluated by PeTTa into rules.json); this file only draws it
    const rules = await (await fetch(this.base + 'rules.json')).json()
    for (const [k, v] of Object.entries(rules.environments)) LOOKS[k] = { edge: v.edge, style: v.style, material: v.material, living: v.living }
    for (const [a, st] of Object.entries(rules.actions)) ACTION_STYLE[a] = st
    this.behaviours = rules.ask?.behaviours || {}; this.lt = 0; this.beh = null
    this.loader = new THREE.TextureLoader(); this.tex = {}; this.bg = {}; this.pix = {}
    const scene = this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(28, W / H, 1, 5000); this.camera.position.set(0, 0, this.camZ || (this.stage ? 820 : 900))
    if (this.stage) {
      this.bgMat = new THREE.ShaderMaterial({ uniforms: { a: { value: null }, b: { value: null }, sa: { value: null }, sb: { value: null }, p: { value: 0 }, focus: { value: 0 } }, depthWrite: false, depthTest: false,
        vertexShader: 'varying vec2 u; void main(){ u = uv; gl_Position = vec4(position.xy, 0., 1.); }',      // focus 1: the real screen, sharp (the camera has pulled back to it)
        fragmentShader: 'uniform sampler2D a, b, sa, sb; uniform float p, focus; varying vec2 u; void main(){ vec4 c = mix(texture2D(a, u), texture2D(b, u), p); if (focus > 0.) c = mix(c, mix(texture2D(sa, u), texture2D(sb, u), p), focus); gl_FragColor = c; }' })
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat); q.renderOrder = -1; q.frustumCulled = false; scene.add(q)
    }
    const sh = new THREE.Shape(this.data.union.map(([x, y]) => new THREE.Vector2(x, -y)))
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 20, bevelEnabled: false, curveSegments: 1 })   // straight walls: the face carries the master's own bevel, which is what makes it look right
    const M = this.data.master
    const u = () => ({ lt: { value: 0 }, wind: { value: 1 }, gain: { value: 1 }, tint: { value: new THREE.Color(0, 0, 0) }, sdf: { value: null }, mask: { value: null }, face: { value: 0 }, gA: { value: .5 }, gB: { value: .5 }, rA: { value: 0 }, rB: { value: 0 }, blkA: { value: 0 }, blkB: { value: 0 }, bulge: { value: 0 }, voice: { value: 0 }, attend: { value: 0 }, tA: { value: null }, tB: { value: null }, p: { value: 0 }, time: { value: 0 }, side: { value: 0 }, sty: { value: 6 }, LA: { value: -1 }, LB: { value: -1 },
      glow: { value: new THREE.Color('#ffffff') }, edgeA: { value: new THREE.Color() }, edgeB: { value: new THREE.Color() }, M: { value: new THREE.Vector4(M.x0, M.y0, M.px_per_unit, 0) } })
    this.mats = [new THREE.ShaderMaterial({ uniforms: u(), vertexShader: VERT, fragmentShader: FRAG }), new THREE.ShaderMaterial({ uniforms: u(), vertexShader: VERT, fragmentShader: FRAG })]
    this.mats[0].uniforms.side.value = 1; this.mats[1].uniforms.side.value = 1   // the cap only peeks out as a rim under the real face: paint it as the wall
    this.mesh = new THREE.Mesh(geo, this.mats); this.mesh.position.set(-140, 128, -8)
    this.pivot = new THREE.Group(); this.pivot.add(this.mesh); scene.add(this.pivot)
    const mc = document.createElement('canvas'); mc.width = 1120; mc.height = 1024; const mg = mc.getContext('2d'); mg.fillStyle = '#fff'; mg.beginPath()
    this.data.union.forEach(([x, y], i) => i ? mg.lineTo(x * 4, y * 4) : mg.moveTo(x * 4, y * 4)); mg.fill(); const maskTex = new THREE.CanvasTexture(mc)
    this.faceMat = new THREE.ShaderMaterial({ uniforms: u(), vertexShader: FACE_VERT, fragmentShader: FRAG }); this.faceMat.uniforms.face.value = 1; this.faceMat.uniforms.mask.value = maskTex
    this.faceMat.uniforms.sdf.value = await new Promise(r => new THREE.TextureLoader().load(this.base + 'sdf.png', t => { t.colorSpace = THREE.NoColorSpace; r(t) }, undefined, () => r(null)))   // every load settles: a missing file never hangs init
    this.faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(280, 256, 224, 205).translate(140, -128, 0), this.faceMat); this.faceMesh.position.set(-140, 128, -8 + 20.15); this.faceMesh.frustumCulled = false
    this.pivot.add(this.faceMesh); this.allMats = [...this.mats, this.faceMat]
    // real light for the real 3D pieces, a glow pass on stage, the pieces themselves, and their sound
    scene.add(new THREE.AmbientLight(0xffffff, .25)); const key = new THREE.DirectionalLight(0xfff4e8, 1.3); key.position.set(-220, 320, 420); scene.add(key)
    scene.environment = new THREE.PMREMGenerator(R).fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .45
    if (this.stage) { this.composer = new EffectComposer(R, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 })); this.composer.setPixelRatio(this.pr); this.composer.setSize(W, H); this.composer.addPass(new RenderPass(scene, this.camera))
      this.composer.addPass(new ShaderPass({ uniforms: { tDiffuse: { value: null } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
        fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); bool bad = !(c.r == c.r && c.g == c.g && c.b == c.b) || max(c.r, max(c.g, c.b)) > 6e4; gl_FragColor = bad ? vec4(0., 0., 0., c.a == c.a ? c.a : 1.) : vec4(min(c.rgb, vec3(8.)), c.a); }' }))   // no invalid or extreme pixel reaches the glow
      if (this.bloom !== false) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), .42, .45, 1.02)); this.composer.addPass(new OutputPass()) }
    // without a stage (a mark inside the app, on transparency): the same colour pipeline, minus the glow, so the shaders'
    // colours reach the screen correctly converted, exactly as in the film
    else { this.composer = new EffectComposer(R, new THREE.WebGLRenderTarget(W * this.pr, H * this.pr, { type: THREE.HalfFloatType, samples: 4 })); this.composer.setPixelRatio(this.pr); this.composer.setSize(W, H)
      const rp = new RenderPass(scene, this.camera); rp.clearAlpha = 0; this.composer.addPass(rp); this.composer.addPass(new OutputPass()) }
    // the film records its events for the soundtrack; the app has no sound, so it keeps nothing (no growing event list)
    this.sound = this.withSound ? new MarkSound() : { at() {}, events: [] }
    this.sound.at(0, 'bed', { root: BED_ROOT[look] || 130.81, dur: 7 })
    this.fx = new MarkFX({ filmPieces: this.filmPieces, pivot: this.pivot, data: this.data, inside: (x, y) => insidePoly(x, y, this.data.union), reveal, STYLE_ID, sound: this.sound, geo, mask: maskTex, h21, vnoise,
      colorAt: (k, x, y) => this.pix[k] ? this.colorAt(k, x, y) : null, particle: (x, y, st, c) => this.spawn(x, y, st, 0, 1, c) })
    // particles live on the face plane, in mark space
    this.pts = []; let tries = 0
    while (this.pts.length < 2600 && tries++ < 60000) { const x = Math.random() * 280, y = Math.random() * 256; if (insidePoly(x, y, this.data.union)) this.pts.push([x, y]) }
    const mkSet = (solid) => { const N = solid ? 700 : 1100, pg = new THREE.BufferGeometry(), P = { pos: new Float32Array(N * 3), col: new Float32Array(N * 3), size: new Float32Array(N), shape: new Float32Array(N),
        life: new Float32Array(N), max: new Float32Array(N).fill(1), born: new Float32Array(N).fill(-1e9), vel: new Float32Array(N * 3), kind: new Array(N).fill(''), size0: new Float32Array(N), next: 0 }
      pg.setAttribute('position', new THREE.BufferAttribute(P.pos, 3)); pg.setAttribute('color', new THREE.BufferAttribute(P.col, 3)); pg.setAttribute('size', new THREE.BufferAttribute(P.size, 1)); pg.setAttribute('shape', new THREE.BufferAttribute(P.shape, 1))
      const vs = 'attribute float size, shape; uniform float pscale; varying vec3 vC; varying float vSh; void main(){ vC = color * min(1., pscale * 1.2); vSh = shape; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = pscale * size * (' + (900 * H / 720).toFixed(1) + ' / -mv.z); gl_Position = projectionMatrix * mv; }'
      const mat = solid ? new THREE.ShaderMaterial({ uniforms: { pscale: { value: 1 } }, transparent: true, depthWrite: false, vertexColors: true, vertexShader: vs,
          fragmentShader: 'varying vec3 vC; varying float vSh; void main(){ vec2 d = gl_PointCoord - .5; float a = vSh > .5 ? step(max(abs(d.x), abs(d.y)), .42) : smoothstep(.5, .4, length(d)); if (a < .01) discard; gl_FragColor = vec4(vC * (.8 + .4 * (.5 - d.y)), a); }' })
        : new THREE.ShaderMaterial({ uniforms: { pscale: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, vertexShader: vs,
          fragmentShader: 'varying vec3 vC; varying float vSh; void main(){ vec2 d = gl_PointCoord - .5; float r = length(d); float a = smoothstep(.5, .0, r); a *= a; gl_FragColor = vec4(vC * a * 1.6, a); }' })
      P.points = new THREE.Points(pg, mat); P.points.position.set(-140, 128, 16.5); P.points.frustumCulled = false; this.pivot.add(P.points); return P }
    this.light = mkSet(false); this.solid = mkSet(true)
    this.look = look; this.target = null; this.clock = 0
    await this.loadLook(look); this.setMats(look, look, 0, 'bloom')
    if (this.stage) { this.bgMat.uniforms.a.value = this.bg[look]; this.bgMat.uniforms.b.value = this.bg[look] }
  }
  async loadLook(k) {
    const ld = (u, optional) => new Promise(r => this.loader.load(u, t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; r(t) }, undefined, () => r(optional ? null : undefined)))
    if (!this.tex[k]) {
      this.tex[k] = await ld(`${this.base}tex-${k}.${this.texExt}`)
      const img = this.tex[k].image, c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 256, 256)
      this.pix[k] = g.getImageData(0, 0, 256, 256).data                       // a small copy, so debris carries the old material's colours
    }
    if (this.stage && !this.bg[k]) { this.bg[k] = await ld(`${this.base}bg-${k}.jpg`); this.sharp = this.sharp || {}; this.sharp[k] = (await ld(`${this.base}sharp-${k}.jpg`, true)) || this.bg[k] }   // the in-focus screen, where one exists
  }
  colorAt(k, mx, my) { const M = this.data.master, px = Math.min(255, Math.max(0, ((mx * M.px_per_unit + M.x0) / 4) | 0)), py = Math.min(255, Math.max(0, ((my * M.px_per_unit + M.y0) / 4) | 0)), d = this.pix[k], i = (py * 256 + px) * 4
    return new THREE.Color(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255).convertSRGBToLinear() }
  setMats(a, b, p, style) {
    const la = LIFE_ID[LOOKS[a].living] ?? -1, lb = LIFE_ID[LOOKS[b].living] ?? -1, Ra = RELIEF[la], Rb = RELIEF[lb]
    for (const m of this.allMats) { const u = m.uniforms; u.rA.value = Ra[0]; u.rB.value = Rb[0]; u.gA.value = Ra[1]; u.gB.value = Rb[1]; u.blkA.value = Ra[2]; u.blkB.value = Rb[2]; u.bulge.value = this.reduce ? 0 : BULGE[style] ?? 1.5; u.tA.value = this.tex[a]; u.tB.value = this.tex[b]; u.p.value = p; u.sty.value = STYLE_ID[style] ?? 6; u.glow.value.set(EDGE_GLOW[style] || '#ffffff')
      u.LA.value = this.reduce ? -1 : LIFE_ID[LOOKS[a].living] ?? -1; u.LB.value = this.reduce ? -1 : LIFE_ID[LOOKS[b].living] ?? -1; u.edgeA.value.set(LOOKS[a].edge); u.edgeB.value.set(LOOKS[b].edge) }
  }
  /** The environment changes: the new material takes the old one over, in its own way; the action plays as a burst on arrival. */
  async morphTo(look, action) {
    await this.loadLook(look)
    this.style = this.reduce ? 'bloom' : LOOKS[look].style; this.burst = action && !this.reduce ? ACTION_STYLE[action] : null
    this.target = look; this.morphT0 = this.clock; this.morphDur = this.reduce ? .3 : 2.6; this.mp = 0; this.mdir = 1; this.setMats(this.look, look, 0, this.style)
    if (this.stage) { const u = this.bgMat.uniforms; u.a.value = this.bg[this.look]; u.b.value = this.bg[look]; u.sa.value = this.sharp[this.look]; u.sb.value = this.sharp[look] }
    this.sound.at(this.clock, { grow: 'rustle', drip: 'pour', forge: 'forge' }[this.style] || 'whoosh', { dur: this.morphDur }); this.impacted = false
    this.sound.at(this.clock + this.morphDur * .5, 'bed', { root: BED_ROOT[look] || 130.81, dur: 7 })
    const sid = STYLE_ID[this.style]; this.revealOf = this.pts.map(([x, y]) => reveal(x, y, sid)); this.inDone = new Uint8Array(this.pts.length); this.outDone = new Uint8Array(this.pts.length)
  }
  /** The one Omega you talk to: 'listening' (it leans in) or 'speaking' with a voice level 0–1 (light ripples with it), or 'idle'. */
  /** Change costume at once, no takeover (used off screen, e.g. before the puppy runs in). */
  async wear(look) { if (!LOOKS[look]) return; await this.loadLook(look); this.look = look; this.target = null; this.setMats(look, look, 0, LOOKS[look].style)
    if (this.stage) { const u = this.bgMat.uniforms; u.a.value = u.b.value = this.bg[look]; u.sa.value = u.sb.value = this.sharp[look]; u.p.value = 0 } }
  /** After a true rewind has reached the start: the change never happened (pieces reset); it can then play forward fresh. */
  resetChange() { if (this.beh) this.beh = this.beh.b.dur || this.beh.out !== undefined ? null : { b: this.beh.b, t0: this.clock - .3 }   // a one-off ends; a held one stays, fully on, from here
    this.mp = 0; this.mdir = 0; this.fx.reset(); this.inDone = new Uint8Array(this.pts.length); this.outDone = new Uint8Array(this.pts.length); this.impacted = false }
  /** Abandon a change once a rewind has reached its start: back in the material it came from, as if it never began. */
  cancelChange() { this.resetChange(); this.punchT = undefined; if (this.target) { this.target = null; this.setMats(this.look, this.look, 0, this.style); if (this.stage) { const u = this.bgMat.uniforms; u.b.value = this.bg[this.look]; u.sb.value = this.sharp[this.look]; u.p.value = 0 } } }
  /** Someone said "wait": the change stops (hold) or runs back (reverse); "carry on" resumes it. */
  holdMorph() { this.mdir = 0 }
  reverseMorph(speed = 1.3) { this.mdir = -speed }
  resumeMorph() { this.mdir = 1 }
  /** focus 0: the screen behind is blurred (the camera is close on the mark); 1: the real screen, sharp. */
  setFocus(f) { if (this.bgMat) this.bgMat.uniforms.focus.value = f }
  /** Where the mark sits: zoom 1 is the hero mark; 0 is its real place in the UI (x, y in world units, s its scale there). */
  setPlace(zoom, at) { this.zoom = zoom; if (at) this.placeAt = at }
  presence(state, level = 1) { this.state = this.reduce ? 'idle' : state; this.level = level }
  /** Behave (omega-mark.metta `behaviour`): steer the material's own life for a while (a gust, a spin-up, a whirlpool, a
   *  bloom, a wilt…). A behaviour with dur 0 is held until the next one or calm(). */
  behave(name) { const b = this.behaviours[name]; if (!b || this.reduce) return; this.beh = { b, t0: this.clock }; if (b.fx && b.fx !== 'none') this.fx.event(b.fx, this.clock) }
  calm() { if (this.beh && !this.beh.b.dur) this.beh = { b: this.beh.b, t0: this.clock - 9, out: this.clock } }
  /** A pulse of a style's own particles (the Ask's activities: a scan, stars, a swarm, blocks…); no material change. */
  pulse(style) { if (this.reduce) return; for (let i = 0; i < 90; i++) { const [x, y] = this.pts[(Math.random() * this.pts.length) | 0]; this.spawn(x, y, style, Math.random() * .3) } }
  /** An action in place: the current living material plays it (a burst of the action's particles); no material change. */
  act(action) { if (this.reduce) return; const style = ACTION_STYLE[action] || 'stars'; for (let i = 0; i < 140; i++) { const [x, y] = this.pts[(Math.random() * this.pts.length) | 0]; this.spawn(x, y, style, Math.random() * .4) } }
  spawn(x, y, style, delay = 0, scale = 1, color = null) {
    const P = OPAQUE.has(style) ? this.solid : this.light, i = P.next; P.next = (i + 1) % P.size.length; let shape = 0; const c = new THREE.Color(EDGE_GLOW[style] || '#ffffff'), R = Math.random
    let vx = 0, vy = 0, sz = 6 + R() * 8, life = 1 + R() * .8, px = x, py = y
    if (style === 'grow') { c.set(R() < .2 ? '#ffb8e8' : R() < .5 ? '#7ad84a' : '#b8ff8a'); vy = 12 + R() * 18; vx = (R() - .5) * 10; sz = 7 + R() * 10 }
    if (style === 'stars') { c.set(R() < .3 ? '#d8b8ff' : '#ffffff'); sz = 4 + R() * 16; life = .6 + R() * 1.2 }
    if (style === 'swarm') { const a = R() * 6.28, D = 160 + R() * 120; px = 140 + Math.cos(a) * D; py = 135 + Math.sin(a) * D; vx = x - px; vy = -(y - py); c.set(R() < .5 ? '#a8c8ff' : '#ffd890'); life = .9 }
    if (style === 'glitch') { c.set(R() < .5 ? '#5ff0ff' : '#ff5fd8'); vx = (R() - .5) * 120; sz = 5 + R() * 6; life = .35 }
    if (style === 'build') { c.set(R() < .5 ? '#c0a0ff' : '#a0d8ff'); vy = -30; sz = 9; life = .5 }
    if (style === 'drip') { c.set(['#ff6a9a', '#ffd84a', '#6ad8ff', '#ffffff', '#9aff6a'][(R() * 5) | 0]); vy = -40 - R() * 40; sz = 4 + R() * 3 }
    if (style === 'flow') { c.set(R() < .5 ? '#ff7ad8' : '#a07aff'); vy = 18 + R() * 20; vx = (R() - .5) * 14; sz = 6 + R() * 9 }
    if (style === 'aurora') { c.set(R() < .5 ? '#a493ff' : '#6ee7ff'); vx = 40 * Math.sin(y * .05); vy = 10; sz = 10 + R() * 10 }
    if (style === 'scan') { c.set('#7dff9b'); vx = (R() - .5) * 6; vy = -8; sz = 3 + R() * 4; life = .7 }
    if (style === 'bloom') { c.set('#d8fff0'); vy = 8 + R() * 8; sz = 8 + R() * 8; life = 1.6 }
    if (style === 'sparkle') { c.set(R() < .5 ? '#ffffff' : '#fff0c8'); sz = 3 + R() * 9; life = .4 + R() * .6 }
    if (style === 'sprinkle') { c.set(['#ff6a9a', '#ffd84a', '#6ad8ff', '#ffffff'][(R() * 4) | 0]); vx = (R() - .5) * 50; vy = 30 + R() * 30; sz = 4 + R() * 3; life = 1.2 }
    if (style === 'leaf') { c.set(R() < .35 ? '#ffb8e8' : R() < .6 ? '#9ad84a' : '#5fae3a'); vx = 10 + R() * 18; vy = -14 - R() * 14; sz = 6 + R() * 6; life = 2 + R() }
    if (style === 'chunk') { vx = (R() - .5) * 70; vy = 40 + R() * 50; sz = 8 + R() * 6; life = 1.3; shape = 1 }
    if (style === 'firefly') { c.set('#e8ff8a'); vx = (R() - .5) * 16; vy = (R() - .5) * 16; sz = 4 + R() * 4; life = 1.6 + R() }
    if (style === 'voice') { const dx = x - 140, dy = y - 150, n = Math.hypot(dx, dy) || 1; vx = dx / n * 110; vy = -dy / n * 110; sz = 8 + R() * 10; life = 1; c.set(R() < .5 ? '#e8d8ff' : '#9ad8ff') }
    if (style === 'ink') { c.set('#0a0806'); const a = R() * 6.28, v = 40 + R() * 70; vx = Math.cos(a) * v; vy = Math.sin(a) * v + 30; sz = 3 + R() * 6; life = .9 }   // ink splashes
    if (style === 'paint') { c.set(R() < .5 ? '#1f8f80' : '#3fbfa8'); vx = (R() - .5) * 40; vy = 20 + R() * 30; sz = 4 + R() * 5; life = 1 }
    if (style === 'scrap') { vx = (R() - .5) * 80; vy = 30 + R() * 50; sz = 10 + R() * 8; life = 1.4; shape = 1 }
    if (style === 'shard') { c.set(R() < .5 ? '#e8ffff' : '#9ff0e0'); const a = R() * 6.28, v = 60 + R() * 80; vx = Math.cos(a) * v; vy = Math.sin(a) * v; sz = 4 + R() * 6; life = .9; shape = 1 }
    if (style === 'crystal') { c.set('#e8ffff'); sz = 3 + R() * 8; life = .5 + R() * .5 }
    if (style === 'forge' || style === 'spark') { c.set(R() < .5 ? '#ffb040' : '#ffe8a0'); vx = (R() - .5) * 90; vy = 60 + R() * 90; sz = 3 + R() * 4; life = .8 }
    if (style === 'flood' || style === 'bubble') { c.set('#ffe8ff'); vx = (R() - .5) * 8; vy = 30 + R() * 40; sz = 4 + R() * 6; life = 1.1 }
    if (style === 'notes') { c.set('#fff8d0'); const a = R() * 6.28; vx = Math.cos(a) * 50; vy = Math.sin(a) * 50; sz = 5 + R() * 5; life = .5 }
    if (style === 'fade') { c.set('#8080a0'); vy = 6; life = 1.4 }
    if (color) c.copy(color).multiplyScalar(P === this.solid ? 1 : 1.4)
    P.pos[i * 3] = px; P.pos[i * 3 + 1] = -py; P.pos[i * 3 + 2] = P === this.solid ? 2 : 0; P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.shape[i] = shape
    P.col[i * 3] = c.r; P.col[i * 3 + 1] = c.g; P.col[i * 3 + 2] = c.b; P.size0[i] = sz * scale; P.life[i] = P.max[i] = life + delay; P.kind[i] = style; P.born[i] = this.clock
  }
  /** Advance to time t (seconds) and draw. Deterministic in its motion, so it can be filmed frame by frame. */
  render(t) {
    const dt = Math.min(.1, Math.max(-.1, t - this.clock)); this.clock = t   // negative while the scene's clock runs backwards (a true rewind)
    for (const m of this.allMats) m.uniforms.time.value = t
    let lift = 0, turn = 0
    const st = this.state || 'idle', a0 = this.attendV || 0, v0 = this.voiceV || 0
    this.attendV = a0 + ((st === 'listening' ? 1 : st === 'speaking' ? .4 : 0) - a0) * Math.min(1, dt * 4); this.voiceV = v0 + ((st === 'speaking' ? this.level : 0) - v0) * Math.min(1, dt * 18)
    for (const m of this.allMats) { m.uniforms.attend.value = this.attendV; m.uniforms.voice.value = this.voiceV }
    if (this.target) {
      this.mp = Math.min(1, Math.max(0, this.mp + dt / this.morphDur * (dt < 0 && this.mdir <= 0 ? 1 : this.mdir)))   // (a rewind always runs it back, even if it was held)
      const p = this.mp, e = smooth(0, 1, this.style === 'drip' ? Math.pow(p, 1.35) : p)   // a pour starts slow and gathers
      for (const m of this.allMats) m.uniforms.p.value = e
      if (!this.impacted && p > .93) { this.impacted = true; const hit = { build: 'thump', drip: 'splat', forge: 'clang', notes: 'thump' }[this.style]; if (hit && !this.reduce) { this.sound.at(t, hit); this.punchT = t } }
      this.front = e * 1.15 - .07
      if (this.stage) this.bgMat.uniforms.p.value = e
      if (!this.reduce && this.mdir > 0 && dt > 0) {
        lift = Math.sin(Math.PI * e) * 10; turn = Math.sin(Math.PI * e) * 9                                      // the mark rises a little and turns toward you as it changes
        const front = e * 1.15 - .07, debris = DEBRIS[this.style]
        for (let k = 0; k < this.pts.length; k++) {
          const r = this.revealOf[k], [x, y] = this.pts[k]
          if (!this.inDone[k] && r < front && Math.random() < .45) { this.inDone[k] = 1; this.spawn(x, y, this.style) }
          if (debris && !this.outDone[k] && r < front + .08 && Math.random() < (debris === 'scrap' ? .06 : .25)) { this.outDone[k] = 1; this.spawn(x, y, debris, 0, .9, this.colorAt(this.look, x, y)) }
        }
        if (this.burst && p > .75) { this.act(Object.keys(ACTION_STYLE).find(a => ACTION_STYLE[a] === this.burst)); this.burst = null }
      }
      if (p >= 1) { this.look = this.target; this.target = null; this.setMats(this.look, this.look, 0, this.style); if (this.stage) { const u = this.bgMat.uniforms; u.a.value = this.bg[this.look]; u.sa.value = this.sharp[this.look]; u.p.value = 0 } }
    }
    if (!this.reduce && dt > 0 && this.attendV > .5 && st === 'listening') for (let n = 0; n < 40 * dt; n++) { const [x, y] = this.pts[(Math.random() * this.pts.length) | 0]; this.spawn(x, y, 'swarm', 0, .6) }   // takes in what you say
    if (!this.reduce && dt > 0 && this.voiceV > .15 && (this.zoom ?? 1) > .95) for (let n = 0; n < 90 * this.voiceV * dt; n++) { const [x, y] = this.pts[(Math.random() * this.pts.length) | 0]; this.spawn(x, y, 'voice', 0, .8) }  // its voice goes out as light
    if (!this.target) this.front = 0
    { const B = this.beh; let sp = 1, wi = 1, ga = 1, fl = 0                                                       // the behaviour's levers, eased in and out
      if (B) { const age = this.clock - B.t0, d = B.b.dur || 0, k = behaviourLevel(B, this.clock)
        if (k <= 0 && (B.out !== undefined || d > 0)) this.beh = null
        sp = 1 + ((B.b.speed ?? 1) - 1) * k; wi = 1 + ((B.b.wind ?? 1) - 1) * k; ga = 1 + ((B.b.gain ?? 1) - 1) * k; fl = B.b.fx === 'nova' ? Math.exp(-Math.max(0, age) * 4) * .45 : 0 }
      this.lt += dt * sp
      for (const m of this.allMats) { const u = m.uniforms; u.lt.value = this.lt; u.wind.value = wi; u.gain.value = ga; u.tint.value.setRGB(fl, fl * .95, fl) } }
    this.fx.voice = this.voiceV || 0
    this.fx.tick({ t, dt, look: this.look, target: this.target, style: this.style, front: this.front })
    if (this.target || dt <= 0) {} else if (!this.reduce) {
      // a puppy sheds no leaves
      for (const [style, rate] of (LOOKS[this.look].living === 'fur-ruffles' ? [] : AMBIENT[LIFE_ID[LOOKS[this.look].living]] || [])) { let n = rate * dt; while (n > 0) { if (Math.random() < n) { const [x, y] = this.pts[(Math.random() * this.pts.length) | 0]; this.spawn(x, y, style, 0, .7) } n -= 1 } }
    }
    for (const P of [this.light, this.solid]) {
      for (let i = 0; i < P.size.length; i++) {
        if (P.life[i] <= 0 && dt >= 0) { P.size[i] = 0; continue }
        if (dt < 0 && P.life[i] <= 0 && !(P.born[i] >= (this.morphT0 ?? Infinity))) { P.size[i] = 0; continue }   // died before this change began: stays dead
        P.life[i] -= dt; if (P.life[i] <= 0 || P.life[i] > P.max[i]) { P.size[i] = 0; continue } const k = P.kind[i], age = 1 - P.life[i] / P.max[i], f = k === 'swarm' ? 1.1 : 1
        if (k === 'leaf') P.vel[i * 3] = 14 * Math.sin(t * 2 + i)                                                   // leaves flutter as they fall
        if (k === 'scrap') P.vel[i * 3] += Math.sin(t * 5 + i) * 60 * dt                                             // paper scraps flutter
        if (k === 'chunk' || k === 'sprinkle' || k === 'ink' || k === 'paint' || k === 'shard' || k === 'spark' || k === 'forge') P.vel[i * 3 + 1] -= 260 * dt   // they fall
        if (k === 'scrap') P.vel[i * 3 + 1] -= 90 * dt
        if (k === 'firefly') { P.vel[i * 3] += (Math.random() - .5) * 40 * dt; P.vel[i * 3 + 1] += (Math.random() - .5) * 40 * dt }
        P.pos[i * 3] += P.vel[i * 3] * dt * f; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt * f; if (k === 'chunk' || k === 'scrap' || k === 'shard') P.pos[i * 3 + 2] += 30 * dt
        const s0 = P.size0[i]
        P.size[i] = k === 'stars' || k === 'sparkle' || k === 'firefly' || k === 'crystal' ? s0 * Math.sin(Math.PI * Math.min(1, age)) * (1 + .3 * Math.sin(t * 12 + i))
          : k === 'grow' || k === 'leaf' ? s0 * Math.min(1, age * 3) * (1 - age * .6) : OPAQUE.has(k) ? s0 * (1 - age * .45) : s0 * (1 - age)
      }
      const g = P.points.geometry; for (const n of ['position', 'size', 'color', 'shape']) g.attributes[n].needsUpdate = true
    }
    const sway = this.reduce ? 0 : this.showcase ? Math.sin(t / 7 * 6.2832) * 14 : Math.sin(t * .15) * 4, bob = this.reduce ? 0 : Math.sin(t * 1.1) * 3
    const A = this.attendV, V = this.voiceV
    const shake = this.target && this.style === 'glitch' ? (h21(Math.floor(t * 15), 3) - .5) * 14 * lift / 10 : 0   // a glitch shakes the whole mark
    const Z = this.zoom ?? 1, P = this.placeAt || { x: 0, y: 0, s: 1 }, zs = Math.pow(P.s, 1 - Z), zw = (zs - P.s) / (1 - P.s || 1)   // zw: 1 at hero, 0 in place
    this.pivot.position.set(P.x * (1 - zw) + (shake + 0) * zw, P.y * (1 - zw) + (bob + lift + A * 8) * zw, A * 90 * zw); for (const P of [this.light, this.solid]) P.points.material.uniforms.pscale.value = zs   // particles shrink with the mark, so a small mark keeps its proportions
    this.pivot.scale.setScalar(zs * (1 + V * .025) * (this.punchT !== undefined && t >= this.punchT && t - this.punchT < 1 ? 1 + .035 * Math.exp(-(t - this.punchT) * 6) * Math.cos((t - this.punchT) * 24) : 1))   // a landing punches                 // leans in to listen; pulses as it speaks
    this.pivot.rotation.set((2 - A * 11 + (this.reduce ? 0 : Math.sin(t * .8) * 1.2)) * Math.PI / 180, (-3 + sway + turn) * Math.PI / 180, 0)
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera)
  }
}
export { LOOKS, ACTION_STYLE }
