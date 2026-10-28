/* GLSL for Cosmos. Everything is procedural: no textures are loaded. */

export const NOISE = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return v;
}
float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.07 + vec3(4.1, 1.3, 7.7);
    a *= 0.5;
  }
  return v;
}
`

/* ---------------- Nebula sky ---------------- */
export const nebulaVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`
export const nebulaFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float t = uTime * 0.004;
  vec3 q = d * 2.2 + vec3(t, 0.0, -t);
  float warp = fbm(q * 1.3);
  float n1 = fbm(q + warp * 1.6);
  float n2 = fbm(q * 1.8 - warp + vec3(5.2, 1.3, 2.8));
  float band = exp(-pow(d.y * 3.2 + (warp - 0.5) * 0.9, 2.0));
  vec3 col = vec3(0.004, 0.006, 0.02);
  col += uA * pow(smoothstep(0.38, 0.95, n1), 2.2) * (0.35 + 0.9 * band);
  col += uB * pow(smoothstep(0.42, 0.98, n2), 2.6) * (0.25 + 0.6 * band);
  // dust lanes darken the bright band
  float dust = smoothstep(0.45, 0.75, fbm(q * 3.1 + 11.0));
  col += uC * band * 0.12 * (1.0 - dust);
  col *= 1.0 - 0.55 * dust * band;
  gl_FragColor = vec4(col, 1.0);
}
`
export const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`
export const skyFrag = /* glsl */ `
uniform samplerCube uCube;
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(textureCube(uCube, normalize(vDir)).rgb, 1.0);
}
`

/* ---------------- Background stars ---------------- */
export const starsVert = /* glsl */ `
attribute float aSize;
attribute float aSeed;
attribute vec3 aColor;
uniform float uTime;
uniform float uPx;
varying vec3 vColor;
varying float vTw;
void main() {
  vColor = aColor;
  float tw = 0.65 + 0.35 * sin(uTime * (0.6 + aSeed * 2.4) + aSeed * 40.0);
  vTw = tw;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPx * (0.75 + 0.25 * tw);
}
`
export const starsFrag = /* glsl */ `
varying vec3 vColor;
varying float vTw;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  core = pow(core, 3.0);
  float spike = max(0.0, 1.0 - abs(c.x) * 18.0) * max(0.0, 1.0 - abs(c.y) * 2.2) + max(0.0, 1.0 - abs(c.y) * 18.0) * max(0.0, 1.0 - abs(c.x) * 2.2);
  float a = core + spike * 0.25 * vTw;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vTw, a);
}
`

/* ---------------- Galaxy dust (spiral arms) ---------------- */
export const dustVert = /* glsl */ `
attribute float aRad;
attribute float aAng;
attribute float aY;
attribute float aSize;
attribute vec3 aColor;
uniform float uTime;
uniform float uPx;
uniform float uScale;
uniform float uMax;
uniform float uDim;
uniform float uNear;
varying vec3 vColor;
varying float vFade;
void main() {
  vColor = aColor;
  float ang = aAng + uTime * 0.18 / (1.0 + aRad * 0.06);
  vec3 p = vec3(cos(ang) * aRad, aY, sin(ang) * aRad);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = clamp(aSize * uPx * uScale / dist, 0.0, uMax * uPx);
  // dust close to the camera thins out so systems stay readable
  vFade = smoothstep(uNear * 0.2, uNear, dist) * uDim;
}
`
export const dustFrag = /* glsl */ `
uniform float uSoft;
varying vec3 vColor;
varying float vFade;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * uSoft) * vFade * smoothstep(1.0, 0.8, r);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`

/* ---------------- Star glow billboard (also the galactic core) ---------------- */
export const glowVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // billboard: keep the quad facing the camera
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 scale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0);
  mv.xy += position.xy * scale.xy;
  gl_Position = projectionMatrix * mv;
}
`
export const glowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uRays;
uniform float uSeed;
varying vec2 vUv;
${NOISE}
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float ang = atan(c.y, c.x);
  float halo = exp(-r * 5.0) * 1.4 + exp(-r * 13.0) * 2.6;
  float n = vnoise(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uTime * 0.25 + uSeed));
  float rays = pow(max(0.0, 1.0 - r), 3.0) * (0.35 + 0.65 * n) * uRays;
  float flare = (max(0.0, 1.0 - abs(c.y) * 90.0) * max(0.0, 1.0 - abs(c.x) * 2.0)) * 0.55 * uRays;
  float a = (halo + rays + flare) * smoothstep(1.0, 0.7, r);
  vec3 col = mix(uColor, vec3(1.0), clamp(exp(-r * 18.0), 0.0, 1.0) * 0.85);
  gl_FragColor = vec4(col * a * uIntensity, 1.0);
}
`

/* ---------------- Star body ---------------- */
export const sunVert = /* glsl */ `
varying vec3 vN;
varying vec3 vObj;
varying vec3 vView;
void main() {
  vObj = position;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`
export const sunFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vView;
${NOISE}
void main() {
  vec3 p = normalize(vObj) * 4.0;
  float g = fbm3(p + vec3(0.0, uTime * 0.12, 0.0));
  float g2 = fbm3(p * 2.6 - vec3(uTime * 0.2));
  float mu = max(dot(normalize(vN), normalize(vView)), 0.0);
  float limb = pow(mu, 0.45);
  vec3 hot = mix(uColor, vec3(1.0, 0.98, 0.92), 0.55);
  vec3 col = mix(uColor * 0.9, hot, smoothstep(0.35, 0.75, g)) * (0.7 + 0.6 * g2);
  col *= 0.75 + 1.05 * limb;
  gl_FragColor = vec4(col, 1.0);
}
`

/* ---------------- Planet surface ---------------- */
export const planetVert = /* glsl */ `
varying vec3 vN;
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vObj = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`
export const planetFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform vec3 uStar;
uniform float uTime;
uniform float uSeed;
uniform float uLit;
uniform float uThink;
uniform float uError;
uniform float uHover;
uniform float uKind;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vWorld;
${NOISE}
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(uStar - vWorld);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 p = vObj * 2.2 + uSeed;
  float warp = fbm3(p * 1.4 + vec3(0.0, uTime * 0.03, 0.0));
  float bands = sin(vObj.y * (6.0 + uKind * 5.0) + warp * 5.0 + uSeed);
  float n = fbm3(p * 2.5 + warp);
  vec3 surf = mix(uColor2, uColor, smoothstep(-0.6, 0.8, bands * 0.6 + (n - 0.5) * 1.6));
  surf = mix(surf, vec3(1.0), smoothstep(0.72, 0.9, n) * 0.25);
  // dormant worlds freeze: desaturated, cold, frosted
  float l = dot(surf, vec3(0.299, 0.587, 0.114));
  vec3 ice = mix(vec3(l) * vec3(0.55, 0.68, 0.95), vec3(0.75, 0.85, 1.0), smoothstep(0.55, 0.8, n) * 0.4);
  surf = mix(ice * 0.65, surf, uLit);
  float ndl = dot(N, L);
  float day = smoothstep(-0.15, 0.35, ndl);
  vec3 col = surf * (0.045 + 1.15 * day);
  // night-side thought lights: awake minds glow where it is dark; thinking makes them flare
  float cities = smoothstep(0.62, 0.78, vnoise(vObj * 26.0 + uSeed)) * smoothstep(0.45, 0.6, n);
  float flick = 0.6 + 0.4 * sin(uTime * 3.0 + vObj.x * 40.0 + vObj.z * 30.0);
  col += uColor * 1.8 * cities * (1.0 - day) * uLit * (0.35 + 1.4 * uThink * flick);
  // atmosphere rim
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  float rimLight = 0.25 + 0.75 * smoothstep(-0.4, 0.6, ndl);
  col += mix(vec3(0.35, 0.5, 0.9) * 0.25, uColor * 1.3, uLit) * fres * rimLight * (0.45 + 0.9 * uLit + 1.0 * uThink + 0.6 * uHover);
  col = mix(col, vec3(1.0, 0.2, 0.15) * (0.6 + 0.4 * sin(uTime * 6.0)), uError * fres * 0.9);
  gl_FragColor = vec4(col, 1.0);
}
`

/* Additive halo shell around a planet. */
export const atmoFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uStar;
uniform float uStrength;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uStar - vWorld);
  float f = pow(1.0 - abs(dot(N, V)), 3.5);
  float lit = 0.35 + 0.65 * smoothstep(-0.5, 0.5, dot(N, L));
  float a = f * lit * uStrength;
  gl_FragColor = vec4(uColor * a, a);
}
`

/* ---------------- Planet ring (omega minds) ---------------- */
export const ringVert = /* glsl */ `
varying vec2 vP;
varying vec3 vWorld;
void main() {
  vP = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`
export const ringFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uInner;
uniform float uOuter;
uniform float uTime;
uniform float uLit;
uniform float uThink;
uniform float uSeed;
varying vec2 vP;
varying vec3 vWorld;
void main() {
  float r = length(vP);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  float bands = 0.55 + 0.45 * sin(t * 48.0 + uSeed) * sin(t * 13.0 + uSeed * 2.0);
  float edge = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.85, t);
  float gap = 1.0 - 0.8 * smoothstep(0.02, 0.0, abs(t - 0.62));
  // a signal sweeps around the ring while the mind thinks
  float sweep = pow(0.5 + 0.5 * cos(ang - uTime * 2.4), 18.0) * uThink;
  vec3 cold = vec3(0.45, 0.55, 0.75);
  vec3 col = mix(cold * 0.5, uColor, uLit) * bands;
  float a = edge * gap * (0.18 + 0.32 * uLit) * bands + sweep * edge * 0.9;
  gl_FragColor = vec4(col * (0.6 + 0.6 * uLit) + uColor * sweep * 2.5, a);
}
`

/* ---------------- Orbit trails ---------------- */
export const orbitVert = /* glsl */ `
attribute float aAng;
varying float vAng;
void main() {
  vAng = aAng;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
export const orbitFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAng;
uniform float uBase;
uniform float uTrail;
varying float vAng;
void main() {
  float d = mod(uAng - vAng, 6.2831853) / 6.2831853;
  float trail = pow(1.0 - d, 7.0);
  float a = uBase + uTrail * trail;
  gl_FragColor = vec4(uColor * a, a);
}
`

/* ---------------- Belief belt ---------------- */
export const beltVert = /* glsl */ `
attribute float aAng;
attribute float aRad;
attribute float aY;
attribute float aSize;
attribute float aFlash;
attribute vec3 aColor;
uniform float uTime;
uniform float uPx;
uniform float uFocus;
varying vec3 vColor;
varying float vA;
void main() {
  float ang = aAng + uTime * 0.6 / pow(aRad, 1.5);
  vec3 p = vec3(cos(ang) * aRad, aY, sin(ang) * aRad);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float flash = exp(-max(uTime - aFlash, 0.0) * 1.2) * step(0.0, uTime - aFlash);
  gl_PointSize = clamp(aSize * uPx * (90.0 / -mv.z) * (1.0 + flash * 2.0), 0.0, 18.0);
  vColor = aColor * (1.0 + flash * 3.0);
  vA = (0.35 + 0.65 * uFocus);
}
`
export const beltFrag = /* glsl */ `
varying vec3 vColor;
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * 5.0) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`

/* ---------------- Light pulses ---------------- */
export const pulseVert = /* glsl */ `
attribute float aAlpha;
attribute vec3 aColor;
uniform float uPx;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha <= 0.001 ? 0.0 : clamp(uPx * 160.0 * (0.25 + aAlpha) / -mv.z, 1.5, 34.0);
}
`
export const pulseFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = (exp(-r * r * 6.0) + exp(-r * 22.0)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * 2.2, a);
}
`

/* ---------------- Focus reticle ---------------- */
export const reticleFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uShow;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float ang = atan(c.y, c.x);
  float ring = smoothstep(0.012, 0.0, abs(r - 0.86));
  float ticks = step(0.75, fract((ang + uTime * 0.25) * 36.0 / 6.2831853)) * smoothstep(0.03, 0.0, abs(r - 0.94)) ;
  float arcs = smoothstep(0.008, 0.0, abs(r - 0.78)) * step(0.0, sin(ang * 3.0 - uTime * 0.6));
  float a = (ring * 0.55 + ticks * 0.7 + arcs * 0.9) * uShow;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a * 1.6, a);
}
`
