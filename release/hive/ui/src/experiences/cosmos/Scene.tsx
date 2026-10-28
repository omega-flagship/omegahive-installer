import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bloom, ChromaticAberration, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode, type ChromaticAberrationEffect } from 'postprocessing'
import * as THREE from 'three'
import { useHive, type Agent } from '../sdk'
import { clumpColour } from './clumpColour'
import { cosmicClock, isLit, planetPos, seeded, hashStr, type CosmosLayout, type PlanetLayout, type SystemLayout } from './layout'
import { labels, pulseQueue, useCosmos, type LabelEntry, type View } from './state'
import * as S from './shaders'

const hueColor = (h: number, s = 0.85, l = 0.6) => new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l)
const tmp = { x: 0, y: 0, z: 0 }
const FACET_FRAG = S.planetFrag.replace('vec3 N = normalize(vN);', 'vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));')
const CORE_COLOR = new THREE.Color(1, 0.8, 0.58)

/* ============================================================ camera rig */

/** Mutable camera state shared by the rig, the controls and the label driver. */
const rig = {
  target: new THREE.Vector3(),
  goal: new THREE.Vector3(),
  radius: 120,
  radiusGoal: 120,
  theta: 0.6,
  thetaGoal: 0.6,
  phi: 1.05,
  phiGoal: 1.05,
  offX: 0,
  offY: 0,
  lastInput: 0,
  speed: 0,
  snap: true,
}

function viewGoal(view: View, layout: CosmosLayout, desktop: boolean) {
  if (view.kind === 'system') {
    const s = layout.systemById[view.id]
    if (s) return { radius: s.frame * (desktop ? 1 : 1.45), phi: 0.92 }
  }
  if (view.kind === 'mind') {
    const p = layout.planetById[view.id]
    if (p) return { radius: (p.size * 5.5 + 2.6) * (desktop ? 1 : 1.3), phi: 1.1 }
  }
  return { radius: layout.extent * (desktop ? 2.2 : 3.6) + 20, phi: desktop ? 0.98 : 0.66 }
}

function CameraRig({ layout, reduced, desktop }: { layout: CosmosLayout; reduced: boolean; desktop: boolean }) {
  const view = useCosmos((s) => s.view)
  const recenter = useCosmos((s) => s.recenter)
  const { gl, invalidate } = useThree()
  const prev = useRef(new THREE.Vector3())

  // a new destination: fly there (or jump, under reduced motion)
  useEffect(() => {
    const g = viewGoal(view, layout, desktop)
    rig.radiusGoal = g.radius
    rig.phiGoal = g.phi
    if (view.kind === 'galaxy') rig.goal.set(0, 0, 0)
    if (view.kind === 'system') {
      const s = layout.systemById[view.id]
      if (s) rig.goal.set(...s.center)
    }
    if (rig.snap || reduced) {
      rig.snap = false
      if (view.kind === 'mind') {
        const p = layout.planetById[view.id]
        if (p) {
          planetPos(p, cosmicClock.t, tmp)
          rig.goal.set(tmp.x, tmp.y, tmp.z)
        }
      }
      rig.target.copy(rig.goal)
      rig.radius = rig.radiusGoal
      rig.phi = rig.phiGoal
    }
    invalidate()
  }, [view, recenter, layout, reduced, desktop, invalidate])

  // drag to orbit, wheel / pinch to zoom
  useEffect(() => {
    const el = gl.domElement
    const pts = new Map<number, { x: number; y: number }>()
    let pinch = 0
    const down = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      const dx = e.clientX - p.x
      const dy = e.clientY - p.y
      p.x = e.clientX
      p.y = e.clientY
      rig.lastInput = performance.now()
      if (pts.size === 1) {
        rig.thetaGoal -= dx * 0.0055
        rig.phiGoal = THREE.MathUtils.clamp(rig.phiGoal - dy * 0.004, 0.18, 1.52)
        if (reduced) {
          rig.theta = rig.thetaGoal
          rig.phi = rig.phiGoal
        }
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch > 0) zoom(pinch / d)
        pinch = d
      }
      invalidate()
    }
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      pinch = 0
    }
    const zoom = (f: number) => {
      const base = rig.radiusGoal
      rig.radiusGoal = THREE.MathUtils.clamp(base * f, 2.2, layout.extent * 5 + 60)
      if (reduced) rig.radius = rig.radiusGoal
      rig.lastInput = performance.now()
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoom(Math.exp(e.deltaY * 0.0012))
      invalidate()
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [gl, layout, reduced, invalidate])

  useFrame((st, rawDt) => {
    const { camera, size } = st
    const dt = Math.min(rawDt, 0.05)
    if (view.kind === 'mind') {
      const p = layout.planetById[view.id]
      if (p) {
          planetPos(p, cosmicClock.t, tmp)
          rig.goal.set(tmp.x, tmp.y, tmp.z)
        }
    }
    // the galaxy turns slowly under you when you leave it alone
    if (!reduced && view.kind === 'galaxy' && performance.now() - rig.lastInput > 5000) rig.thetaGoal += dt * 0.025
    const k = reduced ? 1 : 1 - Math.exp(-dt * 2.4)
    const kr = reduced ? 1 : 1 - Math.exp(-dt * 1.8)
    const ka = reduced ? 1 : 1 - Math.exp(-dt * 4)
    // when the target is changing fast (a mind tracked in orbit) follow tighter
    rig.target.lerp(rig.goal, view.kind === 'mind' && rig.target.distanceTo(rig.goal) < 1 ? Math.max(k, 0.35) : k)
    rig.radius += (rig.radiusGoal - rig.radius) * kr
    rig.theta += (rig.thetaGoal - rig.theta) * ka
    rig.phi += (rig.phiGoal - rig.phi) * ka
    const sp = Math.sin(rig.phi)
    camera.position.set(
      rig.target.x + rig.radius * sp * Math.cos(rig.theta),
      rig.target.y + rig.radius * Math.cos(rig.phi),
      rig.target.z + rig.radius * sp * Math.sin(rig.theta),
    )
    camera.lookAt(rig.target)
    // travel speed relative to the scale you are at: drives the warp
    const v = camera.position.distanceTo(prev.current) / Math.max(dt, 1e-3) / Math.max(rig.radius, 4)
    prev.current.copy(camera.position)
    rig.speed += (Math.min(v, 3) - rig.speed) * 0.15
    const cam = camera as THREE.PerspectiveCamera
    const fov = 50 + (reduced ? 0 : Math.min(rig.speed * 6, 14))
    // keep the focused world clear of the transmission panel
    const panel = view.kind === 'mind' || view.kind === 'system'
    const ox = panel && desktop ? (view.kind === 'mind' ? 230 : 170) : 0
    const oy = panel && !desktop ? Math.round(size.height * (view.kind === 'mind' ? 0.27 : 0.16)) : 0
    rig.offX += (ox - rig.offX) * (reduced ? 1 : ka)
    rig.offY += (oy - rig.offY) * (reduced ? 1 : ka)
    if (Math.abs(cam.fov - fov) > 0.01 || Math.abs(rig.offX) > 0.5 || Math.abs(rig.offY) > 0.5 || cam.view) {
      cam.fov = fov
      if (Math.abs(rig.offX) > 0.5 || Math.abs(rig.offY) > 0.5) cam.setViewOffset(size.width, size.height, rig.offX, rig.offY, size.width, size.height)
      else cam.clearViewOffset()
      cam.updateProjectionMatrix()
    }
    if (reduced && (rig.target.distanceTo(rig.goal) > 0.001)) invalidate()
  })
  return null
}

/* ============================================================ clock + labels */

/**
 * Under reduced motion nothing eases: every value snaps to where it is going, so a change settles in one frame and the
 * on-demand renderer can stop (otherwise the eases below need ~90 frames and freeze half-way, or keep it drawing).
 */
const motion = { reduced: false }
const ease = (rate: number) => (motion.reduced ? 1 : rate)

function Clock({ reduced }: { reduced: boolean }) {
  useLayoutEffect(() => {
    motion.reduced = reduced
  }, [reduced])
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05)
    cosmicClock.real += d
    if (!reduced) cosmicClock.t += d
  })
  return null
}

interface LabelCand {
  key: string
  entry: LabelEntry
  x: number
  y: number
  dist: number
  rank: number
}
const labelSize = new WeakMap<HTMLElement, { w: number; h: number; at: number }>()

/**
 * Labels follow their 3D points and never collide: each frame the visible ones are placed in priority order (the one
 * you hover, then systems, then the nearest worlds, with a little hysteresis so they do not flicker), a label whose box
 * would overlap one already placed waits, and every label is kept fully on screen.
 */
function LabelDriver() {
  const { camera, size } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  const frame = useRef(0)
  const blocked = useRef<[number, number, number, number][]>([])
  useFrame(() => {
    frame.current++
    // the HUD, open panels and Ω's corner are taken: labels never sit under them
    if (frame.current % 12 === 1) {
      const b: [number, number, number, number][] = [[0, size.height - 64, 64, size.height]]
      for (const el of document.querySelectorAll<HTMLElement>('[data-cx-occlude]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) b.push([r.left, r.top, r.right, r.bottom])
      }
      blocked.current = b
    }
    const cands: LabelCand[] = []
    const hide = (el: HTMLElement) => {
      if (el.dataset.on !== '0') {
        el.dataset.on = '0'
        el.style.opacity = '0'
        el.style.visibility = 'hidden'
      }
    }
    for (const [key, entry] of labels) {
      const ok = entry.at(tmp)
      v.set(tmp.x, tmp.y, tmp.z)
      const dist = v.distanceTo(camera.position)
      v.project(camera)
      const show = ok && v.z < 1 && dist < entry.maxDist && dist > (entry.minDist ?? 0) && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15
      if (!show) {
        hide(entry.el)
        continue
      }
      const hot = (entry.el.firstElementChild as HTMLElement | null)?.dataset.hot === '1'
      const rank = hot ? -1e6 : (key.startsWith('sys:') ? 0 : 1e4) + dist * (entry.el.dataset.on === '1' ? 0.8 : 1)
      cands.push({ key, entry, x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height, dist, rank })
    }
    cands.sort((a, b) => a.rank - b.rank)
    const placed: [number, number, number, number][] = [...blocked.current]
    for (const c of cands) {
      const el = c.entry.el
      let sz = labelSize.get(el)
      if (!sz || frame.current - sz.at > 45) {
        const child = el.firstElementChild as HTMLElement | null
        sz = { w: child?.offsetWidth || 120, h: child?.offsetHeight || 32, at: frame.current }
        labelSize.set(el, sz)
      }
      const half = sz.w / 2
      const x = Math.min(size.width - half - 8, Math.max(half + 8, c.x))
      const box: [number, number, number, number] = [x - half - 4, c.y + 12, x + half + 4, c.y + 16 + sz.h]
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
        hide(el)
        continue
      }
      placed.push(box)
      const fade = Math.min(1, (c.entry.maxDist - c.dist) / (c.entry.maxDist * 0.25))
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`
      el.style.opacity = fade.toFixed(2)
      if (el.dataset.on !== '1') {
        el.dataset.on = '1'
        el.style.visibility = 'visible'
      }
    }
  })
  return null
}

/* ============================================================ sky, stars, dust */

/** The nebula is expensive noise, so it is painted once into a cube map and then only sampled. */
function Sky({ lite }: { lite: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const gl = useThree((st) => st.gl)
  const invalidate = useThree((st) => st.invalidate)
  const uniforms = useMemo(() => ({ uCube: { value: null as THREE.Texture | null } }), [])
  useEffect(() => {
    const rt = new THREE.WebGLCubeRenderTarget(lite ? 512 : 1024, { type: THREE.HalfFloatType, generateMipmaps: false })
    const cam = new THREE.CubeCamera(1, 2000, rt)
    const scene = new THREE.Scene()
    const geo = new THREE.SphereGeometry(900, 64, 32)
    const paint = new THREE.ShaderMaterial({
      vertexShader: S.nebulaVert,
      fragmentShader: S.nebulaFrag,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color(0.17, 0.06, 0.32) }, uB: { value: new THREE.Color(0.02, 0.17, 0.26) }, uC: { value: new THREE.Color(0.55, 0.45, 0.7) } },
    })
    scene.add(new THREE.Mesh(geo, paint))
    cam.update(gl, scene)
    if (mat.current) mat.current.uniforms.uCube.value = rt.texture
    invalidate()
    geo.dispose()
    paint.dispose()
    return () => rt.dispose()
  }, [gl, lite, invalidate])
  return (
    <mesh renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[900, 32, 16]} />
      <shaderMaterial ref={mat} vertexShader={S.skyVert} fragmentShader={S.skyFrag} uniforms={uniforms} side={THREE.BackSide} depthWrite={false} depthTest={false} />
    </mesh>
  )
}

function Starfield({ count, px }: { count: number; px: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const geo = useMemo(() => {
    const rnd = seeded(7)
    const pos = new Float32Array(count * 3)
    const size = new Float32Array(count)
    const seed = new Float32Array(count)
    const col = new Float32Array(count * 3)
    const c = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      // concentrate a share of stars along the galactic band
      const y = rnd() < 0.45 ? u * 0.25 : u
      const s = Math.sqrt(1 - y * y)
      const r = 700 + rnd() * 120
      pos.set([Math.cos(th) * s * r, y * r, Math.sin(th) * s * r], i * 3)
      const big = rnd()
      size[i] = big > 0.995 ? 5.5 : big > 0.96 ? 3.2 : 1.1 + rnd() * 1.6
      seed[i] = rnd()
      const temp = rnd()
      c.setHSL(temp < 0.3 ? 0.08 : temp < 0.75 ? 0.6 : 0.62, temp < 0.3 ? 0.7 : 0.45, 0.78 + rnd() * 0.15)
      col.set([c.r, c.g, c.b], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    return g
  }, [count])
  useEffect(() => () => geo.dispose(), [geo])
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: px } }), [px])
  useFrame((st) => {
    if (!mat.current) return
    mat.current.uniforms.uTime.value = cosmicClock.real
    mat.current.uniforms.uPx.value = st.viewport.dpr * px
  })
  return (
    <points geometry={geo} renderOrder={-9} frustumCulled={false}>
      <shaderMaterial ref={mat} vertexShader={S.starsVert} fragmentShader={S.starsFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

function GalaxyDust({ count, layout, px, cloud, dim }: { count: number; layout: CosmosLayout; px: number; cloud?: boolean; dim: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const geo = useMemo(() => {
    const rnd = seeded(cloud ? 1337 : 42)
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2
    const R = layout.extent * 1.35 + 12
    const rad = new Float32Array(count)
    const ang = new Float32Array(count)
    const ys = new Float32Array(count)
    const sz = new Float32Array(count)
    const col = new Float32Array(count * 3)
    const pos = new Float32Array(count * 3)
    const core = new THREE.Color(1.0, 0.74, 0.48)
    const arm = new THREE.Color(0.42, 0.55, 1.0)
    const outer = new THREE.Color(0.55, 0.36, 0.95)
    const hii = new THREE.Color(1.0, 0.34, 0.6)
    const c = new THREE.Color()
    const tints = layout.systems.map((s) => ({ s, c: hueColor(s.hue, 0.9, 0.6) }))
    for (let i = 0; i < count; i++) {
      const bulge = rnd() < (cloud ? 0.12 : 0.16)
      const halo = !bulge && rnd() < 0.12
      const r = bulge ? Math.abs(gauss()) * 10 : halo ? 4 + rnd() * R * 1.05 : 4 + Math.pow(rnd(), 0.9) * R
      // two grand arms and two fainter spurs, logarithmic winding
      const armIdx = Math.floor(rnd() * 4)
      const a0 = armIdx * (Math.PI / 2) + (armIdx % 2 ? 0.35 : 0)
      const wind = 2.1 * Math.log(1 + r / 7)
      const width = (cloud ? 0.42 : 0.3) * (armIdx % 2 ? 0.7 : 1) * (0.7 + 0.6 * (r / R))
      const a = bulge || halo ? rnd() * Math.PI * 2 : a0 + wind + gauss() * width
      const rr = bulge || halo ? r : r + gauss() * 2.2
      rad[i] = Math.max(0.5, rr)
      ang[i] = a
      ys[i] = gauss() * (bulge ? 3.6 : cloud ? 1.2 : 0.5 + 1.8 * Math.exp(-r / 12))
      const t = Math.min(1, r / (R * 0.6))
      c.copy(core).lerp(arm, t)
      if (r > R * 0.75) c.lerp(outer, Math.min(1, (r - R * 0.75) / (R * 0.4)))
      if (!bulge && rnd() < (cloud ? 0.12 : 0.04)) c.copy(hii)
      const x = Math.cos(a) * rr
      const z = Math.sin(a) * rr
      for (const { s, c: tc } of tints) {
        const d = Math.hypot(x - s.center[0], z - s.center[2])
        if (d < 16) c.lerp(tc, (1 - d / 16) * 0.75)
      }
      if (cloud) {
        sz[i] = bulge ? 30 + rnd() * 30 : 22 + rnd() * 40
        const dim = (bulge ? 0.09 : 0.05) + rnd() * 0.04
        col.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
      } else {
        const big = rnd()
        sz[i] = bulge ? 1.4 + rnd() * 2.4 : big > 0.988 ? 6.5 : halo ? 0.8 + rnd() : 1 + rnd() * 2.2
        const dim = bulge ? 0.95 : halo ? 0.18 + rnd() * 0.2 : 0.3 + rnd() * 0.55
        col.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1))
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    g.setAttribute('aY', new THREE.BufferAttribute(ys, 1))
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    return g
  }, [count, layout, cloud])
  useEffect(() => () => geo.dispose(), [geo])
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: px }, uScale: { value: 220 }, uMax: { value: cloud ? 220 : 26 }, uSoft: { value: cloud ? 2.2 : 4 }, uDim: { value: 1 }, uNear: { value: cloud ? 45 : 30 } }), [px, cloud])
  useFrame((st) => {
    if (!mat.current) return
    const u = mat.current.uniforms
    u.uTime.value = cosmicClock.t * 0.15
    u.uPx.value = st.viewport.dpr * px
    u.uDim.value += (dim - u.uDim.value) * ease(0.05)
  })
  return (
    <points geometry={geo} frustumCulled={false} renderOrder={cloud ? -6 : -5}>
      <shaderMaterial ref={mat} vertexShader={S.dustVert} fragmentShader={S.dustFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

/* ============================================================ glow billboard */

function Glow({ color, scale, intensity, rays = 1, seed = 0, position, fade = 1, focusScale }: { color: THREE.Color; scale: number; intensity: number; rays?: number; seed?: number; position?: [number, number, number]; fade?: number; focusScale?: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const uniforms = useMemo(() => ({ uColor: { value: color }, uTime: { value: 0 }, uIntensity: { value: intensity }, uRays: { value: rays }, uSeed: { value: seed } }), [color, intensity, rays, seed])
  useFrame(() => {
    const u = mat.current?.uniforms
    if (!u) return
    u.uTime.value = cosmicClock.real
    u.uIntensity.value += (intensity * fade - u.uIntensity.value) * ease(0.05)
    const m = mesh.current
    if (m && focusScale != null) m.scale.setScalar(m.scale.x + (focusScale - m.scale.x) * 0.05)
  })
  return (
    <mesh ref={mesh} position={position} scale={scale} frustumCulled={false} renderOrder={2}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial ref={mat} vertexShader={S.glowVert} fragmentShader={S.glowFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </mesh>
  )
}

/* ============================================================ star systems */

function useClickGuard() {
  return (e: ThreeEvent<MouseEvent>) => e.delta > 8
}

function StarSystem({ sys, layout, lite, current, focusSystem }: { sys: SystemLayout; layout: CosmosLayout; lite: boolean; current: boolean; focusSystem: boolean }) {
  const go = useCosmos((s) => s.go)
  const hover = useCosmos((s) => s.hover)
  const sun = useRef<THREE.ShaderMaterial>(null)
  const color = useMemo(() => hueColor(sys.hue, 0.9, 0.62), [sys.hue])
  const sunUniforms = useMemo(() => ({ uColor: { value: color }, uTime: { value: 0 } }), [color])
  const dragged = useClickGuard()
  useFrame(() => {
    if (sun.current) sun.current.uniforms.uTime.value = cosmicClock.real
  })
  return (
    <group position={sys.center}>
      <mesh>
        <sphereGeometry args={[1.05, lite ? 32 : 48, lite ? 16 : 24]} />
        <shaderMaterial ref={sun} vertexShader={S.sunVert} fragmentShader={S.sunFrag} uniforms={sunUniforms} />
      </mesh>
      <Glow color={color} scale={16} focusScale={current ? 7 : 16} intensity={1.0} seed={hashStr(sys.id) % 100} />
      {/* generous hit sphere to fly to the system from afar */}
      {!current && (
        <mesh
          onClick={(e) => {
            if (dragged(e)) return
            e.stopPropagation()
            go({ kind: 'system', id: sys.id })
          }}
          onPointerOver={(e) => (e.stopPropagation(), hover(sys.id), (document.body.style.cursor = 'pointer'))}
          onPointerOut={() => (hover(null), (document.body.style.cursor = ''))}
        >
          <sphereGeometry args={[sys.belt + 1, 12, 8]} />
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      )}
      <Belt sys={sys} lite={lite} focus={focusSystem} />
      {sys.members.map((id) => {
        const p = layout.planetById[id]
        return p ? <Orbit key={id} p={p} color={color} bright={focusSystem} /> : null
      })}
    </group>
  )
}

function Orbit({ p, color, bright }: { p: PlanetLayout; color: THREE.Color; bright: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const geo = useMemo(() => {
    const n = 160
    const pos = new Float32Array(n * 3)
    const ang = new Float32Array(n)
    const cn = Math.cos(p.node)
    const sn = Math.sin(p.node)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.cos(a) * p.orbit
      const z = Math.sin(a) * p.orbit
      pos.set([x, (-x * sn + z * cn) * Math.sin(p.incline), z], i * 3)
      ang[i] = a
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    return g
  }, [p])
  useEffect(() => () => geo.dispose(), [geo])
  const uniforms = useMemo(() => ({ uColor: { value: color }, uAng: { value: 0 }, uBase: { value: 0.05 }, uTrail: { value: 0.5 } }), [color])
  useFrame(() => {
    const m = mat.current
    if (!m) return
    const a = p.phase + p.speed * cosmicClock.t
    m.uniforms.uAng.value = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    m.uniforms.uBase.value += ((bright ? 0.09 : 0.035) - m.uniforms.uBase.value) * ease(0.08)
    m.uniforms.uTrail.value += ((bright ? 0.75 : 0.35) - m.uniforms.uTrail.value) * ease(0.08)
  })
  return (
    <lineLoop geometry={geo}>
      <shaderMaterial ref={mat} vertexShader={S.orbitVert} fragmentShader={S.orbitFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineLoop>
  )
}

function Belt({ sys, lite, focus }: { sys: SystemLayout; lite: boolean; focus: boolean }) {
  const beliefs = useHive((s) => s.beliefs[sys.id])
  const pulse = useHive((s) => s.beliefPulse)
  const mat = useRef<THREE.ShaderMaterial>(null)
  const geo = useMemo(() => {
    const list = Object.values(beliefs ?? {}).sort((a, b) => a.statement.localeCompare(b.statement))
    const per = lite ? 14 : 26
    const dust = lite ? 120 : 260
    const n = list.length * per + dust
    const ang = new Float32Array(n)
    const rad = new Float32Array(n)
    const ys = new Float32Array(n)
    const sz = new Float32Array(n)
    const fl = new Float32Array(n)
    const col = new Float32Array(n * 3)
    const pos = new Float32Array(n * 3)
    const rnd = seeded(hashStr(sys.id) ^ 0x9e37)
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5
    const now = Date.now()
    let k = 0
    list.forEach((b, bi) => {
      // each belief is a clump; colour = how sure (the one sureness decision, as the word), brightness = confidence (clumpColour)
      const center = (bi / Math.max(1, list.length)) * Math.PI * 2 + rnd() * 0.3
      const c = b.tv.c
      const rgb = clumpColour(b.tv)
      const p = pulse[`${sys.id}\u0000${b.statement}`]
      const flash = p && now - p < 4000 ? cosmicClock.real : -100
      for (let j = 0; j < per; j++, k++) {
        ang[k] = center + gauss() * 0.16
        rad[k] = sys.belt + gauss() * 0.35
        ys[k] = gauss() * 0.12
        sz[k] = (j === 0 ? 2.6 : 0.8 + rnd() * 1.2) * (0.6 + c * 0.6)
        fl[k] = flash
        col.set(rgb, k * 3)
      }
    })
    for (let j = 0; j < dust; j++, k++) {
      ang[k] = rnd() * Math.PI * 2
      rad[k] = sys.belt + gauss() * 0.7
      ys[k] = gauss() * 0.2
      sz[k] = 0.5 + rnd() * 0.6
      fl[k] = -100
      col.set([0.16, 0.18, 0.26], k * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1))
    g.setAttribute('aY', new THREE.BufferAttribute(ys, 1))
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1))
    g.setAttribute('aFlash', new THREE.BufferAttribute(fl, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beliefs, sys.id, sys.belt, lite])
  useEffect(() => () => geo.dispose(), [geo])
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: 1 }, uFocus: { value: 0 } }), [])
  useFrame((st) => {
    const m = mat.current
    if (!m) return
    m.uniforms.uTime.value = cosmicClock.real
    m.uniforms.uPx.value = st.viewport.dpr
    m.uniforms.uFocus.value += ((focus ? 1 : 0) - m.uniforms.uFocus.value) * ease(0.06)
  })
  return (
    <points geometry={geo} frustumCulled={false}>
      <shaderMaterial ref={mat} vertexShader={S.beltVert} fragmentShader={S.beltFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

/* ============================================================ planets */

interface Geos {
  sphere: THREE.SphereGeometry
  facet: THREE.IcosahedronGeometry
  ring: THREE.RingGeometry
  hit: THREE.SphereGeometry
}

function Planet({ p, agent, sys, geos, selected }: { p: PlanetLayout; agent: Agent; sys: SystemLayout | null; geos: Geos; selected: boolean }) {
  const go = useCosmos((s) => s.go)
  const hover = useCosmos((s) => s.hover)
  const hovered = useCosmos((s) => s.hovered === agent.id)
  const thinking = useHive((s) => s.thinking[agent.id])
  const group = useRef<THREE.Group>(null)
  const body = useRef<THREE.Mesh>(null)
  const surf = useRef<THREE.ShaderMaterial>(null)
  const atmo = useRef<THREE.ShaderMaterial>(null)
  const ringMat = useRef<THREE.ShaderMaterial>(null)
  const dragged = useClickGuard()
  const seed = (hashStr(agent.id) % 1000) / 37
  const scale = p.size * (1 + 0.28 * Math.min(1, Math.log10(1 + agent.spent_usd) / 2))
  const star = useMemo(() => new THREE.Vector3(...(sys ? sys.center : [0, 0, 0])), [sys])
  const uniforms = useMemo(
    () => ({
      uColor: { value: hueColor(agent.hue, 0.8, 0.58) },
      uColor2: { value: hueColor(agent.hue + 28, 0.55, 0.26) },
      uStar: { value: star },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uLit: { value: isLit(agent) ? 1 : 0 },
      uThink: { value: 0 },
      uError: { value: 0 },
      uHover: { value: 0 },
      uKind: { value: agent.kind === 'omega' ? 0 : agent.kind === 'iter' ? 1 : 2 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.hue, agent.kind, star, seed],
  )
  const atmoUniforms = useMemo(() => ({ uColor: { value: hueColor(agent.hue, 0.95, 0.62) }, uStar: { value: star }, uStrength: { value: 1 } }), [agent.hue, star])
  const ringUniforms = useMemo(
    () => ({ uColor: { value: hueColor(agent.hue, 0.7, 0.66) }, uInner: { value: 1.55 }, uOuter: { value: 2.35 }, uTime: { value: 0 }, uLit: { value: 1 }, uThink: { value: 0 }, uSeed: { value: seed } }),
    [agent.hue, seed],
  )
  const lit = isLit(agent)
  const think = thinking === 'llm' ? 1 : thinking === 'skills' ? 0.7 : 0
  const error = agent.status === 'error' ? 1 : 0
  useFrame((_, dt) => {
    const g = group.current
    if (!g) return
    planetPos(p, cosmicClock.t, tmp)
    g.position.set(tmp.x, tmp.y, tmp.z)
    const k = ease(1 - Math.exp(-Math.min(dt, 0.05) * 3))
    const s = surf.current
    if (s) {
      const u = s.uniforms
      u.uTime.value = cosmicClock.real
      u.uLit.value += ((lit ? 1 : 0) - u.uLit.value) * k
      u.uThink.value += (think - u.uThink.value) * k
      u.uError.value += (error - u.uError.value) * k
      u.uHover.value += ((hovered || selected ? 1 : 0) - u.uHover.value) * k
      const pulse = 1 + u.uThink.value * 0.035 * Math.sin(cosmicClock.real * 5)
      g.scale.setScalar(scale * pulse)
      if (atmo.current) atmo.current.uniforms.uStrength.value = 0.25 + 0.9 * u.uLit.value + 1.1 * u.uThink.value + 0.5 * u.uHover.value
      if (ringMat.current) {
        ringMat.current.uniforms.uTime.value = cosmicClock.real
        ringMat.current.uniforms.uLit.value = u.uLit.value
        ringMat.current.uniforms.uThink.value = u.uThink.value
      }
    }
    if (body.current) body.current.rotation.y = cosmicClock.t * 0.15 + seed
  })
  return (
    <group ref={group}>
      <mesh ref={body} geometry={agent.kind === 'module' ? geos.facet : geos.sphere}>
        <shaderMaterial ref={surf} vertexShader={S.planetVert} fragmentShader={agent.kind === 'module' ? FACET_FRAG : S.planetFrag} uniforms={uniforms} />
      </mesh>
      <mesh geometry={geos.sphere} scale={1.16}>
        <shaderMaterial ref={atmo} vertexShader={S.planetVert} fragmentShader={S.atmoFrag} uniforms={atmoUniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
      </mesh>
      {agent.kind === 'omega' && (
        <mesh geometry={geos.ring} rotation={[Math.PI / 2 - 0.42 + (seed % 0.3), 0.2, 0]}>
          <shaderMaterial ref={ringMat} vertexShader={S.ringVert} fragmentShader={S.ringFrag} uniforms={ringUniforms} transparent depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <mesh
        geometry={geos.hit}
        scale={Math.max(2.1, 1.1 / p.size)}
        onClick={(e) => {
          if (dragged(e)) return
          e.stopPropagation()
          go({ kind: 'mind', id: agent.id })
        }}
        onPointerOver={(e) => (e.stopPropagation(), hover(agent.id), (document.body.style.cursor = 'pointer'))}
        onPointerOut={() => (hover(null), (document.body.style.cursor = ''))}
      >
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

/* ============================================================ focus reticle */

function Reticle({ layout }: { layout: CosmosLayout }) {
  const view = useCosmos((s) => s.view)
  const mesh = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.ShaderMaterial>(null)
  const agents = useHive((s) => s.agents)
  const hue = view.kind === 'mind' ? (agents[view.id]?.hue ?? 210) : 210
  const uniforms = useMemo(() => ({ uColor: { value: hueColor(hue, 0.9, 0.7) }, uTime: { value: 0 }, uShow: { value: 0 } }), [hue])
  useFrame(() => {
    const m = mesh.current
    const u = mat.current?.uniforms
    if (!m || !u) return
    const p = view.kind === 'mind' ? layout.planetById[view.id] : undefined
    u.uTime.value = cosmicClock.real
    u.uShow.value += ((p ? 1 : 0) - u.uShow.value) * ease(0.08)
    if (p) {
      planetPos(p, cosmicClock.t, tmp)
      m.position.set(tmp.x, tmp.y, tmp.z)
      m.scale.setScalar(p.size * 4.6)
    }
    m.visible = u.uShow.value > 0.01
  })
  return (
    <mesh ref={mesh} renderOrder={5} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial ref={mat} vertexShader={S.glowVert} fragmentShader={S.reticleFrag} uniforms={uniforms} transparent depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
    </mesh>
  )
}

/* ============================================================ light pulses */

const PULSES = 48
const TRAIL = 10

interface Pulse {
  on: boolean
  t0: number
  dur: number
  from: THREE.Vector3
  to: () => THREE.Vector3
  color: THREE.Color
}

function Pulses({ layout }: { layout: CosmosLayout }) {
  const pts = useRef<THREE.Points>(null)
  const pmat = useRef<THREE.ShaderMaterial>(null)
  const { camera } = useThree()
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PULSES * TRAIL * 3), 3))
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(PULSES * TRAIL), 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(PULSES * TRAIL * 3), 3))
    return g
  }, [])
  useEffect(() => () => geo.dispose(), [geo])
  const pool = useRef<Pulse[]>([])
  const uniforms = useMemo(() => ({ uPx: { value: 1 } }), [])

  useEffect(() => {
    pool.current = Array.from({ length: PULSES }, () => ({ on: false, t0: 0, dur: 1, from: new THREE.Vector3(), to: () => new THREE.Vector3(), color: new THREE.Color() }))
    const planetAt = (id: string) => () => {
      const p = layout.planetById[id]
      if (!p) return new THREE.Vector3()
      planetPos(p, cosmicClock.t, tmp)
      return new THREE.Vector3(tmp.x, tmp.y, tmp.z)
    }
    const starOf = (id: string) => {
      const p = layout.planetById[id]
      const s = p?.systemId ? layout.systemById[p.systemId] : null
      return s ? new THREE.Vector3(...s.center) : new THREE.Vector3(0, 0, 0)
    }
    const spawn = (from: THREE.Vector3, to: () => THREE.Vector3, hue: number, dur = 1.6) => {
      // a pulse is motion: under reduced motion the event is not drawn as a light travelling
      if (motion.reduced) return
      const slot = pool.current.find((x) => !x.on)
      if (!slot) return
      slot.on = true
      slot.t0 = cosmicClock.real
      slot.dur = dur
      slot.from.copy(from)
      slot.to = to
      slot.color.copy(hueColor(hue, 0.95, 0.66))
    }
    let seen = useHive.getState().activitySeq
    const drain = () => {
      while (pulseQueue.length) {
        const q = pulseQueue.shift()!
        if (q.to === 'you' || q.to === 'core') continue
        const target = planetAt(q.to)
        if (q.from === 'you') {
          const dir = new THREE.Vector3()
          camera.getWorldDirection(dir)
          spawn(camera.position.clone().addScaledVector(dir, 2).add(new THREE.Vector3(0, -1, 0)), target, q.hue, 1.3)
        }
      }
    }
    const unsub = useHive.subscribe((s) => {
      drain()
      if (s.activitySeq === seen) return
      const fresh = s.activity.filter((a) => a.id > seen)
      seen = s.activitySeq
      for (const a of fresh.slice(0, 6)) {
        if (!a.agent_id || !layout.planetById[a.agent_id]) continue
        const ag = s.agents[a.agent_id]
        const hue = a.kind === 'error' ? 4 : a.kind === 'approval' ? 40 : (ag?.hue ?? 210)
        planetPos(layout.planetById[a.agent_id], cosmicClock.t, tmp)
        const from = new THREE.Vector3(tmp.x, tmp.y, tmp.z)
        if (a.kind === 'wakeup') spawn(new THREE.Vector3(0, 0, 0), planetAt(a.agent_id), hue, 2.4)
        else if (a.kind === 'approval') spawn(from, () => new THREE.Vector3(0, 0, 0), hue, 2.4)
        else if (a.kind === 'belief') {
          const p = layout.planetById[a.agent_id]
          const sys = p.systemId ? layout.systemById[p.systemId] : null
          const ang = Math.atan2(tmp.z - (sys?.center[2] ?? 0), tmp.x - (sys?.center[0] ?? 0)) + 0.8
          const end = sys ? new THREE.Vector3(sys.center[0] + Math.cos(ang) * sys.belt, sys.center[1], sys.center[2] + Math.sin(ang) * sys.belt) : new THREE.Vector3()
          spawn(from, () => end, hue, 1.4)
        } else {
          const star = starOf(a.agent_id)
          spawn(from, () => star, hue, 1.2)
        }
      }
    })
    return unsub
  }, [layout, camera])

  useFrame((st) => {
    const g = pts.current?.geometry
    if (!g) return
    if (pmat.current) pmat.current.uniforms.uPx.value = st.viewport.dpr
    const pos = g.attributes.position.array as Float32Array
    const al = g.attributes.aAlpha.array as Float32Array
    const co = g.attributes.aColor.array as Float32Array
    const now = cosmicClock.real
    const mid = new THREE.Vector3()
    const end = new THREE.Vector3()
    pool.current.forEach((pl, i) => {
      const base = i * TRAIL
      if (!pl.on) {
        for (let j = 0; j < TRAIL; j++) al[base + j] = 0
        return
      }
      const u = (now - pl.t0) / pl.dur
      if (u > 1.15) {
        pl.on = false
        return
      }
      end.copy(pl.to())
      const dist = pl.from.distanceTo(end)
      mid.copy(pl.from).add(end).multiplyScalar(0.5)
      mid.y += dist * 0.28
      for (let j = 0; j < TRAIL; j++) {
        const t = THREE.MathUtils.clamp(u - j * 0.022, 0, 1)
        const e = t * t * (3 - 2 * t)
        const a = 1 - e
        const b = e
        const x = a * a * pl.from.x + 2 * a * b * mid.x + b * b * end.x
        const y = a * a * pl.from.y + 2 * a * b * mid.y + b * b * end.y
        const z = a * a * pl.from.z + 2 * a * b * mid.z + b * b * end.z
        pos[(base + j) * 3] = x
        pos[(base + j) * 3 + 1] = y
        pos[(base + j) * 3 + 2] = z
        const fadeIn = Math.min(1, u * 8)
        const fadeOut = u > 1 ? Math.max(0, 1 - (u - 1) / 0.15) : 1
        al[base + j] = (1 - j / TRAIL) ** 1.6 * fadeIn * fadeOut * (u - j * 0.022 < 0 ? 0 : 1)
        co[(base + j) * 3] = pl.color.r
        co[(base + j) * 3 + 1] = pl.color.g
        co[(base + j) * 3 + 2] = pl.color.b
      }
    })
    g.attributes.position.needsUpdate = true
    g.attributes.aAlpha.needsUpdate = true
    g.attributes.aColor.needsUpdate = true
  })
  return (
    <points ref={pts} geometry={geo} frustumCulled={false} renderOrder={6}>
      <shaderMaterial ref={pmat} vertexShader={S.pulseVert} fragmentShader={S.pulseFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

/* ============================================================ effects */

function Effects({ lite, reduced }: { lite: boolean; reduced: boolean }) {
  const ca = useRef<ChromaticAberrationEffect>(null)
  const offset = useMemo(() => new THREE.Vector2(0.0004, 0.0004), [])
  useFrame(() => {
    const e = ca.current
    if (!e) return
    const amt = 0.00015 + (reduced ? 0 : Math.min(rig.speed, 2) * 0.0024)
    e.offset.set(amt, amt * 0.6)
  })
  if (lite)
    return (
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.22} luminanceSmoothing={0.35} radius={0.7} />
        <Vignette offset={0.3} darkness={0.7} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    )
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.2} luminanceSmoothing={0.35} radius={0.78} />
      <ChromaticAberration ref={ca} offset={offset} radialModulation modulationOffset={0.25} />
      <Vignette offset={0.28} darkness={0.72} />
      <Noise opacity={0.028} blendFunction={BlendFunction.SOFT_LIGHT} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  )
}

/* ============================================================ adaptive resolution */

function Adaptive({ max }: { max: number }) {
  const setDpr = useThree((s) => s.setDpr)
  const acc = useRef({ t: 0, n: 0, dpr: max })
  useFrame((_, dt) => {
    const a = acc.current
    a.t += dt
    a.n++
    if (a.t < 2) return
    const fps = a.n / a.t
    a.t = 0
    a.n = 0
    const next = fps < 42 ? Math.max(0.85, a.dpr - 0.25) : fps > 57 && a.dpr < max ? Math.min(max, a.dpr + 0.25) : a.dpr
    if (next !== a.dpr) {
      a.dpr = next
      setDpr(next)
    }
  })
  return null
}

/* ============================================================ on-demand rendering (reduced motion) */

/** Under reduced motion the scene renders only when something changes; give each change a short settle. */
function DemandInvalidate() {
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => {
    // only what the scene draws: worlds, systems, thinking, belts, and where you are (eases snap, so 2 frames settle)
    const a = useHive.subscribe((s, p) => {
      if (s.agents !== p.agents || s.swarms !== p.swarms || s.thinking !== p.thinking || s.beliefs !== p.beliefs) invalidate(2)
    })
    const b = useCosmos.subscribe((s, p) => {
      if (s.view !== p.view || s.hovered !== p.hovered || s.recenter !== p.recenter) invalidate(2)
    })
    const onResize = () => invalidate(5)
    window.addEventListener('resize', onResize)
    return () => {
      a()
      b()
      window.removeEventListener('resize', onResize)
    }
  }, [invalidate])
  return null
}

/** Tells the page once real frames are on screen (shader compilation can take a while on a busy GPU). */
function FirstLight({ onReady }: { onReady: () => void }) {
  const n = useRef(0)
  useFrame(() => {
    n.current++
    if (n.current === 3) onReady()
  })
  return null
}

/* ============================================================ root */

export default function Scene({ layout, reduced, desktop, hidden, onReady, onContext }: { layout: CosmosLayout; reduced: boolean; desktop: boolean; hidden: boolean; onReady: () => void; onContext?: (state: 'lost' | 'restored') => void }) {
  const agents = useHive((s) => s.agents)
  const view = useCosmos((s) => s.view)
  const lite = !desktop
  const geos = useMemo<Geos>(
    () => ({
      sphere: new THREE.SphereGeometry(1, lite ? 40 : 64, lite ? 20 : 32),
      facet: new THREE.IcosahedronGeometry(1, 1),
      ring: new THREE.RingGeometry(1.55, 2.35, lite ? 64 : 128, 1),
      hit: new THREE.SphereGeometry(1, 10, 8),
    }),
    [lite],
  )
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos])
  const maxDpr = desktop ? 1.75 : 1.5
  // a scene being taken down (rebuilt after a restore, or leaving) gives its context back on purpose: not news
  const alive = useRef(true)
  // a layout effect: on removal it runs before the canvas below is torn down (which loses its context on purpose)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const currentSystem = view.kind === 'system' ? view.id : view.kind === 'mind' ? (layout.planetById[view.id]?.systemId ?? null) : null
  return (
    <Canvas
      className="!absolute inset-0"
      dpr={[1, maxDpr]}
      frameloop={hidden ? 'never' : reduced ? 'demand' : 'always'}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'default' }}
      camera={{ fov: 50, near: 0.1, far: 2400, position: [0, 80, 140] }}
      flat
      onCreated={({ gl }) => {
        gl.setClearColor('#010208')
        // the GPU can take the context away (driver reset, too many contexts, a backgrounded phone): say so, and when it
        // comes back the page rebuilds the scene (the sky is painted once, at mount)
        const el = gl.domElement
        el.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          if (alive.current) onContext?.('lost')
        })
        el.addEventListener('webglcontextrestored', () => alive.current && onContext?.('restored'))
      }}
      onPointerMissed={() => undefined}
      aria-hidden
    >
      <Clock reduced={reduced} />
      <FirstLight onReady={onReady} />
      <Sky lite={lite} />
      <Starfield count={lite ? 2200 : 5200} px={1} />
      <GalaxyDust count={lite ? 260 : 600} layout={layout} px={1} cloud dim={view.kind === 'galaxy' ? 1 : 0.35} />
      <GalaxyDust count={lite ? 9000 : 24000} layout={layout} px={1} dim={view.kind === 'galaxy' ? 1 : 0.55} />
      <Glow color={CORE_COLOR} scale={34} intensity={0.55} rays={0.6} position={[0, 0, 0]} fade={view.kind === 'galaxy' ? 1 : 0.3} />
      {layout.systems.map((s) => (
        <StarSystem key={s.id} sys={s} layout={layout} lite={lite} current={currentSystem === s.id} focusSystem={currentSystem === s.id} />
      ))}
      {layout.planets.map((p) =>
        agents[p.id] ? <Planet key={p.id} p={p} agent={agents[p.id]} sys={p.systemId ? layout.systemById[p.systemId] : null} geos={geos} selected={view.kind === 'mind' && view.id === p.id} /> : null,
      )}
      <Reticle layout={layout} />
      <Pulses layout={layout} />
      <CameraRig layout={layout} reduced={reduced} desktop={desktop} />
      <LabelDriver />
      {!reduced && <Adaptive max={maxDpr} />}
      {reduced && <DemandInvalidate />}
      <Effects lite={lite} reduced={reduced} />
    </Canvas>
  )
}
