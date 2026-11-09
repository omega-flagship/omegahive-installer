import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bloom, ChromaticAberration, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode, type ChromaticAberrationEffect } from 'postprocessing'
import * as THREE from 'three'
import { useHive, usePhase, type Agent, type ShellPhase } from '../sdk'
import { clumpColour } from './clumpColour'
import { cosmicClock, isLit, planetPos, seeded, hashStr, type CosmosLayout, type PlanetLayout, type SystemLayout } from './layout'
import { labels, pulseQueue, useCosmos, type LabelEntry, type View } from './state'
import * as S from './shaders'
import { APP_ORBIT, appClock, appPos, askSideShift, fadesFor, labelSide, flightAfterViewChange, follow, frameloopFor, omegaMarkLive, pacedFps, phaseFrame, RATE, uGalaxy, uSky } from './phaseRig'
import { transitionOf } from '../../shell/phase'
import { useHelperGroups } from '../../scene/helperGroupsStore'

const hueColor = (h: number, s = 0.85, l = 0.6) => new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l)
const tmp = { x: 0, y: 0, z: 0 }
const FACET_FRAG = S.planetFrag.replace('vec3 N = normalize(vN);', 'vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));')
const CORE_COLOR = new THREE.Color(1, 0.8, 0.58)

/**
 * Rest → awake → Pro (CANDIDATE): a fragment shader that also fades by a shared uniform (phaseRig uGalaxy / uSky).
 * The uniform is 1 in Pro and whenever the phases are off, so Pro draws exactly as before.
 */
function fading(frag: string, name: 'uGalaxy' | 'uSky'): string {
  const end = frag.lastIndexOf('}')
  return `uniform float ${name};\n${frag.slice(0, end)}  gl_FragColor.rgb *= ${name};\n}\n`
}
const G = {
  dust: fading(S.dustFrag, 'uGalaxy'),
  glow: fading(S.glowFrag, 'uGalaxy'),
  sun: fading(S.sunFrag, 'uGalaxy'),
  planet: fading(S.planetFrag, 'uGalaxy'),
  facet: fading(FACET_FRAG, 'uGalaxy'),
  atmo: fading(S.atmoFrag, 'uGalaxy'),
  ring: fading(S.ringFrag, 'uGalaxy'),
  orbit: fading(S.orbitFrag, 'uGalaxy'),
  belt: fading(S.beltFrag, 'uGalaxy'),
  pulse: fading(S.pulseFrag, 'uGalaxy'),
  reticle: fading(S.reticleFrag, 'uGalaxy'),
  stars: fading(S.starsFrag, 'uSky'),
  sky: fading(S.skyFrag, 'uSky'),
}

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
  /** rest/awake (CANDIDATE): the exponential rate of the journey under way (0: none), and the Ω's lift in px */
  flight: 0,
  phaseOffY: 0,
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

function CameraRig({ layout, reduced, desktop, phase, phased }: { layout: CosmosLayout; reduced: boolean; desktop: boolean; phase: ShellPhase; phased: boolean }) {
  const view = useCosmos((s) => s.view)
  const recenter = useCosmos((s) => s.recenter)
  const { gl, invalidate } = useThree()
  const width = useThree((st) => st.size.width)
  const height = useThree((st) => st.size.height)
  const prev = useRef(new THREE.Vector3())
  // rest and awake are the Ω's own close views: the camera is the shell's journey's, not the person's to drag
  const local = phased && phase !== 'pro'
  const localRef = useRef(local)
  const wasLocal = useRef(false)
  const sideSeen = useRef(0)
  useLayoutEffect(() => {
    localRef.current = local
  }, [local])

  // a phased Cosmos opens on its rest at once (never a flight in from wherever the camera last was)
  useLayoutEffect(() => {
    if (phased) rig.snap = true
  }, [phased])

  // rest and awake: the Ω's views, framed for this viewport; the journey's rate follows the motion score
  useEffect(() => {
    if (!local) return
    // framed for the space an Ask thread pinned beside the view leaves (the frame re-reads it if that changes)
    const side = askSideShift(document.documentElement.dataset.askSide, width)
    sideSeen.current = side
    const f = phaseFrame(phase as 'rest' | 'awake', width - 2 * side, height)
    rig.goal.set(0, 0, 0)
    rig.radiusGoal = f.radius
    rig.phiGoal = f.phi
    rig.phaseOffY = f.offY
    const tr = transitionOf(usePhase.getState().from ?? phase, phase)
    rig.flight = tr ? RATE[tr] : 2.4
    if (rig.snap || reduced) {
      rig.snap = false
      rig.flight = 0
      rig.target.copy(rig.goal)
      rig.radius = rig.radiusGoal
      rig.phi = rig.phiGoal
      rig.offY = rig.phaseOffY
      // the fades arrive with the camera (opening straight on the rest: never a full galaxy fading out first)
      uGalaxy.value = fadesFor(phase as 'rest' | 'awake', width, height).galaxy
      uSky.value = fadesFor(phase as 'rest' | 'awake', width, height).sky
    }
    invalidate()
  }, [local, phase, width, height, reduced, invalidate])

  // a new destination: fly there (or jump, under reduced motion)
  useEffect(() => {
    const leaving = wasLocal.current
    wasLocal.current = local
    if (local) return
    // Pro again after awake: fly out to the person's own view, kept as they left it (never cleared to home). Only the
    // journey itself; later moves inside Pro ease exactly as they always have.
    rig.flight = flightAfterViewChange(leaving, rig.snap, reduced)
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
  }, [view, recenter, layout, reduced, desktop, invalidate, local, phased])

  // drag to orbit, wheel / pinch to zoom
  useEffect(() => {
    const el = gl.domElement
    const pts = new Map<number, { x: number; y: number }>()
    let pinch = 0
    const down = (e: PointerEvent) => {
      if (localRef.current) return
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
      // the person's own navigation takes the camera at once: no journey easing lingers under their hand
      rig.flight = 0
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
      rig.flight = 0
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (localRef.current) return
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
    // an Ask thread pinned or unpinned beside rest/awake: re-frame for the space left, with the same gentle settle
    if (local) {
      const side = askSideShift(document.documentElement.dataset.askSide, size.width)
      if (side !== sideSeen.current) {
        sideSeen.current = side
        const f = phaseFrame(phase as 'rest' | 'awake', size.width - 2 * side, size.height)
        rig.radiusGoal = f.radius
        rig.phiGoal = f.phi
        rig.phaseOffY = f.offY
        rig.flight = reduced ? 0 : RATE.settle
        if (reduced) rig.radius = rig.radiusGoal
      }
    }
    const dt = Math.min(rawDt, 0.05)
    if (view.kind === 'mind' && !local) {
      const p = layout.planetById[view.id]
      if (p) {
          planetPos(p, cosmicClock.t, tmp)
          rig.goal.set(tmp.x, tmp.y, tmp.z)
        }
    }
    // the galaxy turns slowly under you when you leave it alone
    if (!reduced && !local && view.kind === 'galaxy' && performance.now() - rig.lastInput > 5000) rig.thetaGoal += dt * 0.025
    // rest and awake drift very slowly round the Ω (no drift under reduced motion)
    if (!reduced && local) rig.thetaGoal += dt * (phase === 'rest' ? 0.012 : 0.018)
    if (rig.flight > 0 && !reduced) {
      // a journey between the shell's states: one continuous ease from the current pose (a reversal blends from
      // wherever the camera is), zooming in log space so near and far move at one even pace
      const kf = 1 - Math.exp(-dt * rig.flight)
      rig.target.lerp(rig.goal, view.kind === 'mind' && !local ? Math.max(kf, 0.2) : kf)
      rig.radius = Math.exp(Math.log(rig.radius) + (Math.log(rig.radiusGoal) - Math.log(rig.radius)) * kf)
      rig.theta += (rig.thetaGoal - rig.theta) * kf
      rig.phi += (rig.phiGoal - rig.phi) * kf
      if (Math.abs(Math.log(rig.radius / rig.radiusGoal)) < 0.004 && rig.target.distanceTo(rig.goal) < 0.05 && Math.abs(rig.phi - rig.phiGoal) < 0.003) rig.flight = 0
    } else {
      rig.flight = 0
      const k = reduced ? 1 : 1 - Math.exp(-dt * 2.4)
      const kr = reduced ? 1 : 1 - Math.exp(-dt * 1.8)
      const ka = reduced ? 1 : 1 - Math.exp(-dt * 4)
      // when the target is changing fast (a mind tracked in orbit) follow tighter
      rig.target.lerp(rig.goal, view.kind === 'mind' && rig.target.distanceTo(rig.goal) < 1 ? Math.max(k, 0.35) : k)
      rig.radius += (rig.radiusGoal - rig.radius) * kr
      rig.theta += (rig.thetaGoal - rig.theta) * ka
      rig.phi += (rig.phiGoal - rig.phi) * ka
    }
    const ka = reduced ? 1 : 1 - Math.exp(-dt * (rig.flight > 0 ? Math.max(rig.flight, 2) : 4))
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
    // the shell's journeys keep the lens still (no warp surge on the way to or from the Ω)
    const fov = 50 + (reduced || local || rig.flight > 0 ? 0 : Math.min(rig.speed * 6, 14))
    // keep the focused world clear of the transmission panel
    const panel = !local && (view.kind === 'mind' || view.kind === 'system')
    // rest and awake: centred in the space an Ask thread pinned beside them leaves (r2)
    const ox = local ? askSideShift(document.documentElement.dataset.askSide, size.width) : panel && desktop ? (view.kind === 'mind' ? 230 : 170) : 0
    const oy = local ? rig.phaseOffY : panel && !desktop ? Math.round(size.height * (view.kind === 'mind' ? 0.27 : 0.16)) : 0
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
  const uniforms = useMemo(() => ({ uCube: { value: null as THREE.Texture | null }, uSky }), [])
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
      <shaderMaterial ref={mat} vertexShader={S.skyVert} fragmentShader={G.sky} uniforms={uniforms} side={THREE.BackSide} depthWrite={false} depthTest={false} />
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
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: px }, uSky }), [px])
  useFrame((st) => {
    if (!mat.current) return
    mat.current.uniforms.uTime.value = cosmicClock.real
    mat.current.uniforms.uPx.value = st.viewport.dpr * px
  })
  return (
    <points geometry={geo} renderOrder={-9} frustumCulled={false}>
      <shaderMaterial ref={mat} vertexShader={S.starsVert} fragmentShader={G.stars} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
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
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: px }, uScale: { value: 220 }, uMax: { value: cloud ? 220 : 14 }, uSoft: { value: cloud ? 2.2 : 4 }, uCrisp: { value: cloud ? 0 : 1 }, uDim: { value: 1 }, uNear: { value: cloud ? 45 : 30 }, uGalaxy }), [px, cloud])
  useFrame((st) => {
    if (!mat.current) return
    const u = mat.current.uniforms
    u.uTime.value = cosmicClock.t * 0.15
    u.uPx.value = st.viewport.dpr * px
    u.uDim.value += (dim - u.uDim.value) * ease(0.05)
  })
  return (
    <points geometry={geo} frustumCulled={false} renderOrder={cloud ? -6 : -5}>
      <shaderMaterial ref={mat} vertexShader={S.dustVert} fragmentShader={G.dust} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

/* ============================================================ glow billboard */

function Glow({ color, scale, intensity, rays = 1, seed = 0, position, fade = 1, focusScale, galaxy = false }: { color: THREE.Color; scale: number; intensity: number; rays?: number; seed?: number; position?: [number, number, number]; fade?: number; focusScale?: number; galaxy?: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const uniforms = useMemo(() => ({ uColor: { value: color }, uTime: { value: 0 }, uIntensity: { value: intensity }, uRays: { value: rays }, uSeed: { value: seed }, uGalaxy }), [color, intensity, rays, seed])
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
      <shaderMaterial ref={mat} vertexShader={S.glowVert} fragmentShader={galaxy ? G.glow : S.glowFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
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
  const sunUniforms = useMemo(() => ({ uColor: { value: color }, uTime: { value: 0 }, uGalaxy }), [color])
  const dragged = useClickGuard()
  useFrame(() => {
    if (sun.current) sun.current.uniforms.uTime.value = cosmicClock.real
  })
  return (
    <group position={sys.center}>
      <mesh>
        <sphereGeometry args={[1.05, lite ? 32 : 48, lite ? 16 : 24]} />
        <shaderMaterial ref={sun} vertexShader={S.sunVert} fragmentShader={G.sun} uniforms={sunUniforms} />
      </mesh>
      <Glow color={color} scale={16} focusScale={current ? 7 : 16} intensity={1.0} seed={hashStr(sys.id) % 100} galaxy />
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
  const uniforms = useMemo(() => ({ uColor: { value: color }, uAng: { value: 0 }, uBase: { value: 0.05 }, uTrail: { value: 0.5 }, uGalaxy }), [color])
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
      <shaderMaterial ref={mat} vertexShader={S.orbitVert} fragmentShader={G.orbit} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
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
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPx: { value: 1 }, uFocus: { value: 0 }, uGalaxy }), [])
  useFrame((st) => {
    const m = mat.current
    if (!m) return
    m.uniforms.uTime.value = cosmicClock.real
    m.uniforms.uPx.value = st.viewport.dpr
    m.uniforms.uFocus.value += ((focus ? 1 : 0) - m.uniforms.uFocus.value) * ease(0.06)
  })
  return (
    <points geometry={geo} frustumCulled={false}>
      <shaderMaterial ref={mat} vertexShader={S.beltVert} fragmentShader={G.belt} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
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
      uGalaxy,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.hue, agent.kind, star, seed],
  )
  const atmoUniforms = useMemo(() => ({ uColor: { value: hueColor(agent.hue, 0.95, 0.62) }, uStar: { value: star }, uStrength: { value: 1 }, uGalaxy }), [agent.hue, star])
  const ringUniforms = useMemo(
    () => ({ uColor: { value: hueColor(agent.hue, 0.7, 0.66) }, uInner: { value: 1.55 }, uOuter: { value: 2.35 }, uTime: { value: 0 }, uLit: { value: 1 }, uThink: { value: 0 }, uSeed: { value: seed }, uGalaxy }),
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
        <shaderMaterial ref={surf} vertexShader={S.planetVert} fragmentShader={agent.kind === 'module' ? G.facet : G.planet} uniforms={uniforms} />
      </mesh>
      <mesh geometry={geos.sphere} scale={1.16}>
        <shaderMaterial ref={atmo} vertexShader={S.planetVert} fragmentShader={G.atmo} uniforms={atmoUniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
      </mesh>
      {agent.kind === 'omega' && (
        <mesh geometry={geos.ring} rotation={[Math.PI / 2 - 0.42 + (seed % 0.3), 0.2, 0]}>
          <shaderMaterial ref={ringMat} vertexShader={S.ringVert} fragmentShader={G.ring} uniforms={ringUniforms} transparent depthWrite={false} side={THREE.DoubleSide} />
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

/**
 * A team's folded request helpers (scene/helperGroups): one small, dim, unlit world that never pulses. A click opens the
 * group (its helpers become worlds of their own) or closes it; its label (Labels GroupLabel) is the keyboard way.
 */
function GroupWorld({ p, sys, geos }: { p: PlanetLayout; sys: SystemLayout | null; geos: Geos }) {
  const hover = useCosmos((s) => s.hover)
  const hovered = useCosmos((s) => s.hovered === p.id)
  const toggle = useHelperGroups((s) => s.toggle)
  const group = useRef<THREE.Group>(null)
  const dragged = useClickGuard()
  const hue = sys?.hue ?? 210
  const star = useMemo(() => new THREE.Vector3(...(sys ? sys.center : [0, 0, 0])), [sys])
  const uniforms = useMemo(
    () => ({
      uColor: { value: hueColor(hue, 0.25, 0.42) }, uColor2: { value: hueColor(hue + 28, 0.2, 0.2) }, uStar: { value: star }, uTime: { value: 0 },
      uSeed: { value: (hashStr(p.id) % 1000) / 37 }, uLit: { value: 0 }, uThink: { value: 0 }, uError: { value: 0 }, uHover: { value: 0 }, uKind: { value: 2 }, uGalaxy,
    }),
    [hue, star, p.id],
  )
  useFrame(() => {
    const g = group.current
    if (!g) return
    planetPos(p, cosmicClock.t, tmp)
    g.position.set(tmp.x, tmp.y, tmp.z)
    g.scale.setScalar(p.size * (hovered ? 1.15 : 1))
  })
  return (
    <group ref={group}>
      <mesh geometry={geos.facet}>
        <shaderMaterial vertexShader={S.planetVert} fragmentShader={G.facet} uniforms={uniforms} />
      </mesh>
      <mesh
        geometry={geos.hit}
        scale={Math.max(2.1, 1.1 / p.size)}
        onClick={(e) => {
          if (dragged(e)) return
          e.stopPropagation()
          toggle(p.id)
        }}
        onPointerOver={(e) => (e.stopPropagation(), hover(p.id), (document.body.style.cursor = 'pointer'))}
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
  const uniforms = useMemo(() => ({ uColor: { value: hueColor(hue, 0.9, 0.7) }, uTime: { value: 0 }, uShow: { value: 0 }, uGalaxy }), [hue])
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
      <shaderMaterial ref={mat} vertexShader={S.glowVert} fragmentShader={G.reticle} uniforms={uniforms} transparent depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
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
  const uniforms = useMemo(() => ({ uPx: { value: 1 }, uGalaxy }), [])

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
      <shaderMaterial ref={pmat} vertexShader={S.pulseVert} fragmentShader={G.pulse} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

/* ============================================================ effects */

/**
 * `crisp` (rest and awake): the space reads sharp (Jon, 3 Nov: "blurry and not too good"). Only bright cores bloom, the
 * nebula and the star field don't; there's no chromatic fringe and no grain. Pro keeps its approved look.
 */
function Effects({ lite, reduced, crisp }: { lite: boolean; reduced: boolean; crisp: boolean }) {
  const ca = useRef<ChromaticAberrationEffect>(null)
  const offset = useMemo(() => new THREE.Vector2(0.0004, 0.0004), [])
  useFrame(() => {
    const e = ca.current
    if (!e) return
    const amt = 0.00015 + (reduced || rig.flight > 0 ? 0 : Math.min(rig.speed, 2) * 0.0024)
    e.offset.set(amt, amt * 0.6)
  })
  if (crisp)
    return (
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur intensity={lite ? 0.7 : 0.8} luminanceThreshold={0.62} luminanceSmoothing={0.2} radius={0.45} />
        <Vignette offset={0.3} darkness={0.66} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    )
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

/**
 * Paced (rest, awake): the screen's own resolution by default, restored at once on entry (crisp). On the weakest device
 * it still holds its pace: when the frames it is drawn at fall below `floor` a second over a 3 s window, the resolution
 * steps down by a quarter (to 0.85 at least), and steps back up when the pace is met again (Dot's review, looks r1).
 */
function PacedDpr({ max, fps }: { max: number; fps: number }) {
  const setDpr = useThree((s) => s.setDpr)
  const acc = useRef({ start: 0, n: 0, dpr: max, good: 0, need: 2, rose: false })
  // a new pace (rest ↔ awake) starts a fresh window: frames counted against the old rate would judge the new one wrongly
  useEffect(() => {
    acc.current = { start: performance.now(), n: 0, dpr: max, good: 0, need: 2, rose: false }
    setDpr(max)
  }, [setDpr, max, fps])
  useFrame(() => {
    const a = acc.current
    const now = performance.now()
    a.n++
    if (now - a.start < 3000) return
    // frames delivered against Pace's own schedule, by the wall clock: Pace asks for `fps` a second whenever the scene is
    // paced (pacedFps), so nothing paced draws sparsely by design; a hidden page draws nothing and is never judged
    const got = (a.n * 1000) / (now - a.start)
    a.start = now
    a.n = 0
    if (document.hidden) return
    const floor = Math.min(16, fps * 0.8)
    let next = a.dpr
    if (got < floor) {
      next = Math.max(0.85, a.dpr - 0.25)
      // a step down right after a recovery step backs recovery off (2, 4, 8 good windows), so it never oscillates
      if (a.rose) a.need = Math.min(8, a.need * 2)
      a.rose = false
      a.good = 0
    } else if (got >= fps - 2 && a.dpr < max) {
      if (++a.good >= a.need) { next = Math.min(max, a.dpr + 0.25); a.good = 0; a.rose = true }
    } else a.good = 0                                       // a neutral window: neither slow nor at pace
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

/* ============================================================ rest → awake → Pro (CANDIDATE, cosmos-rest-r1) */

/**
 * The Ω: the galaxy's own core. In Pro it is exactly the core glow Cosmos always had; at rest it gathers into one
 * warm star, and awake it brightens and gains a body (its corona warms before anything else appears). Sized against
 * the camera's distance, so the star holds its place on screen while the camera travels.
 */
function OmegaCore({ phase, view, reduced }: { phase: ShellPhase; view: View; reduced: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const glow = useRef<THREE.Mesh>(null)
  const body = useRef<THREE.Mesh>(null)
  const bodyMat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(() => ({ uColor: { value: CORE_COLOR.clone() }, uTime: { value: 0 }, uIntensity: { value: 0.55 }, uRays: { value: 0.6 }, uSeed: { value: 0 } }), [])
  const bodyUniforms = useMemo(() => ({ uColor: { value: new THREE.Color(1, 0.72, 0.42) }, uTime: { value: 0 } }), [])
  const cur = useRef({ scale: 34, intensity: 0.55, rays: 0.6, body: 0 })
  const lampWas = useRef(true)
  // a lost mark brings the star back in the very next scene frame, even when the scene draws only on demand
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => omegaMarkLive.subscribe(() => invalidate()), [invalidate])
  useFrame((st, rawDt) => {
    const u = mat.current?.uniforms
    if (!u || !glow.current) return
    const d = st.camera.position.length()
    // rest and awake: while the living Ω shows, no star, corona or glow behind it (Jon, 3 Nov: no light behind the
    // Ω); only where the mark can't run is the star itself the Ω
    const lamp = !omegaMarkLive.value
    const t =
      phase === 'pro'
        ? { scale: 34, intensity: 0.55 * (view.kind === 'galaxy' ? 1 : 0.3), rays: 0.6, body: 0 }
        : phase === 'awake'
          ? { scale: d * 0.2, intensity: lamp ? 0.85 : 0, rays: 0.42, body: lamp ? d * 0.0135 : 0 }
          : { scale: d * 0.14, intensity: lamp ? 0.9 : 0, rays: 0.8, body: lamp ? d * 0.008 : 0 }
    // the Ω answers first: quicker than the camera
    const k = reduced ? 1 : 1 - Math.exp(-Math.min(rawDt, 0.05) * (phase === 'pro' ? 2.4 : 5))
    const c = cur.current
    // a showing mark puts the lamp out at once (never easing out under it); a lost mark brings it back at once too, so
    // the centre is never empty (Kimi, looks r1.1)
    if (!lamp && phase !== 'pro') { c.intensity = 0; c.body = 0 }
    if (lamp && !lampWas.current && phase !== 'pro') { c.intensity = t.intensity; c.body = t.body }
    lampWas.current = lamp
    c.scale += (t.scale - c.scale) * k
    c.intensity += (t.intensity - c.intensity) * k
    c.rays += (t.rays - c.rays) * k
    c.body += (t.body - c.body) * k
    glow.current.scale.setScalar(c.scale)
    glow.current.visible = c.intensity > 0.002
    u.uTime.value = cosmicClock.real
    u.uIntensity.value = c.intensity
    u.uRays.value = c.rays
    if (body.current) {
      body.current.visible = c.body > 0.002
      body.current.scale.setScalar(Math.max(c.body, 0.0001))
    }
    if (bodyMat.current) bodyMat.current.uniforms.uTime.value = cosmicClock.real
  })
  return (
    <>
      <mesh ref={body} frustumCulled={false} renderOrder={1}>
        <sphereGeometry args={[1, 40, 20]} />
        <shaderMaterial ref={bodyMat} vertexShader={S.sunVert} fragmentShader={S.sunFrag} uniforms={bodyUniforms} />
      </mesh>
      <mesh ref={glow} position={[0, 0, 0]} scale={34} frustumCulled={false} renderOrder={2}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial ref={mat} vertexShader={S.glowVert} fragmentShader={S.glowFrag} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </>
  )
}

export interface OrbitApp {
  id: string
  color: string
}

/**
 * The apps awake: cut crystals in their own colours on one faint orbit round the Ω (labels are DOM, phases.tsx). They
 * emerge after the field, one after another, and go before the camera leaves for Pro. Real apps only: what the hive
 * lists, enabled and working. The orbit holds still while a person points at or focuses one.
 */
function AppOrbit({ apps, phase, reduced }: { apps: OrbitApp[]; phase: ShellPhase; reduced: boolean }) {
  const ring = useRef<THREE.ShaderMaterial>(null)
  const bodies = useRef<(THREE.Group | null)[]>([])
  const mats = useRef<(THREE.ShaderMaterial | null)[]>([])
  const show = useRef<number[]>([])
  const since = useRef(0)
  const was = useRef(phase)
  const geo = useMemo(() => {
    const n = 192
    const pos = new Float32Array(n * 3)
    const ang = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pos.set([Math.cos(a) * APP_ORBIT, 0, Math.sin(a) * APP_ORBIT], i * 3)
      ang[i] = a
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    return g
  }, [])
  useEffect(() => () => geo.dispose(), [geo])
  const crystal = useMemo(() => new THREE.OctahedronGeometry(1, 0), [])
  useEffect(() => () => crystal.dispose(), [crystal])
  const ringUniforms = useMemo(() => ({ uColor: { value: new THREE.Color('#7cc4ff') }, uAng: { value: 0 }, uBase: { value: 0 }, uTrail: { value: 0 } }), [])
  const appUniforms = useMemo(
    () => apps.map((a, i) => ({ uColor: { value: new THREE.Color(a.color) }, uTime: { value: 0 }, uShow: { value: 0 }, uSeed: { value: (hashStr(a.id) % 1000) / 1000 + i } })),
    [apps],
  )
  // each app is a lit body: a soft halo in its own colour round the crystal (the suns' glow, quality pass r1)
  const haloUniforms = useMemo(
    () => apps.map((a, i) => ({ uColor: { value: new THREE.Color(a.color) }, uTime: { value: 0 }, uIntensity: { value: 0 }, uRays: { value: 0 }, uSeed: { value: (hashStr(a.id) % 1000) / 1000 + i } })),
    [apps],
  )
  const halos = useRef<(THREE.ShaderMaterial | null)[]>([])
  useFrame((st, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    if (was.current !== phase) {
      was.current = phase
      since.current = 0
    }
    since.current += dt
    const awake = phase === 'awake'
    const tmpP = tmp
    apps.forEach((_, i) => {
      // after the field (≈0.55 s), one after another; leaving, all at once and quickly
      const want = awake && (reduced || since.current > 0.55 + i * 0.09) ? 1 : 0
      const rate = awake ? 4.5 : 7
      const k = reduced ? 1 : 1 - Math.exp(-dt * rate)
      const v = (show.current[i] ?? 0) + (want - (show.current[i] ?? 0)) * k
      show.current[i] = v
      const g = bodies.current[i]
      if (!g) return
      appPos(i, apps.length, appClock.t, tmpP)
      g.position.set(tmpP.x, tmpP.y, tmpP.z)
      g.visible = v > 0.01
      const d = st.camera.position.distanceTo(g.position)
      // a body keeps one size on screen whatever the camera does, and grows into place
      g.scale.setScalar(Math.max(0.0001, d * 0.034 * (0.4 + 0.6 * v)))
      g.rotation.y = cosmicClock.real * 0.4 + i
      g.rotation.x = 0.5 + Math.sin(cosmicClock.real * 0.3 + i) * 0.15
      const m = mats.current[i]
      if (m) {
        m.uniforms.uShow.value = v
        m.uniforms.uTime.value = cosmicClock.real
      }
      const h = halos.current[i]
      if (h) {
        h.uniforms.uIntensity.value = 0.7 * v
        h.uniforms.uTime.value = cosmicClock.real
      }
    })
    const r = ring.current
    if (r) {
      const want = awake ? 1 : 0
      const k = reduced ? 1 : 1 - Math.exp(-dt * (awake ? 3 : 6))
      r.uniforms.uBase.value += (want * 0.06 - r.uniforms.uBase.value) * k
      r.uniforms.uTrail.value += (want * 0.35 - r.uniforms.uTrail.value) * k
      const a = 0.55 + appClock.t * 0.035
      r.uniforms.uAng.value = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    }
  })
  return (
    <group>
      <lineLoop geometry={geo} frustumCulled={false}>
        <shaderMaterial ref={ring} vertexShader={S.orbitVert} fragmentShader={S.orbitFrag} uniforms={ringUniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </lineLoop>
      {apps.map((a, i) => (
        <group key={a.id} ref={(g) => void (bodies.current[i] = g)} visible={false}>
          <mesh geometry={crystal} scale={[0.62, 1, 0.62]}>
            <shaderMaterial ref={(m) => void (mats.current[i] = m)} vertexShader={S.planetVert} fragmentShader={S.appFrag} uniforms={appUniforms[i]} />
          </mesh>
          <mesh scale={5.5} frustumCulled={false} renderOrder={3}>
            <planeGeometry args={[1, 1]} />
            <shaderMaterial ref={(m) => void (halos.current[i] = m)} vertexShader={S.glowVert} fragmentShader={S.glowFrag} uniforms={haloUniforms[i]} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/**
 * Each frame, in step with the camera: eases the shared fades toward the state's (straight to Pro's when the phases
 * are off, so a non-phased Cosmos is never faded), turns the galaxy's layer off once it is fully faded (no cost at
 * rest), advances the apps' orbit, and moves the DOM that follows the scene (the Ω's point, the app labels).
 */
function PhaseDriver({ phase, phased, reduced, apps }: { phase: ShellPhase; phased: boolean; reduced: boolean; apps: number }) {
  const { camera, size, scene } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  // SIM ONLY: the browser checks read what the scene draws with (never on a real hive)
  const sim = useHive((s) => s.client?.mode === 'sim')
  useEffect(() => {
    if (!sim) return
    const w = window as unknown as { __cosmosScene?: unknown }
    w.__cosmosScene = () => {
      const out: { type: string; visible: boolean; fades: string[]; galaxy?: number }[] = []
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined
        if (!m || !('fragmentShader' in m)) return
        let vis = o.visible
        for (let q = o.parent; q; q = q.parent) vis &&= q.visible
        out.push({ type: o.type, visible: vis, fades: ['uGalaxy', 'uSky'].filter((u) => m.fragmentShader.includes(`uniform float ${u}`)), galaxy: m.uniforms?.uGalaxy?.value as number | undefined })
      })
      return { camera: camera.position.toArray().map((x) => +x.toFixed(2)), flight: rig.flight, out }
    }
    return () => {
      delete w.__cosmosScene
    }
  }, [sim, scene, camera])
  const rate = useRef(2.4)
  const sent = useRef({ g: -1, s: -1, n: -1 })
  const last = useRef(phase)
  const frame = useRef(0)
  const labelW = useRef(new WeakMap<HTMLElement, { w: number; at: number }>())
  // the galaxy's own layer (named in Scene), found once in the scene this driver draws
  const galaxy = useRef<THREE.Object3D | null>(null)
  useFrame((st, rawDt) => {
    frame.current++
    const dt = Math.min(rawDt, 0.05)
    if (last.current !== phase) {
      const tr = transitionOf(last.current, phase)
      rate.current = tr ? RATE[tr] : 2.4
      last.current = phase
    }
    const f = fadesFor(phased ? phase : 'pro', st.size.width, st.size.height)
    const k = !phased || reduced ? 1 : 1 - Math.exp(-dt * rate.current)
    uGalaxy.value += (f.galaxy - uGalaxy.value) * k
    uSky.value += (f.sky - uSky.value) * k
    if (Math.abs(uGalaxy.value - f.galaxy) < 0.001) uGalaxy.value = f.galaxy
    if (Math.abs(uSky.value - f.sky) < 0.001) uSky.value = f.sky
    // each material holds its own copy of a uniform (three clones them): hand the fades on whenever they move, and to
    // any material that arrived since (a few dozen materials, walked only while something changed)
    const n = scene.children.length
    if (uGalaxy.value !== sent.current.g || uSky.value !== sent.current.s || n !== sent.current.n) {
      sent.current = { g: uGalaxy.value, s: uSky.value, n }
      scene.traverse((o) => {
        const u = ((o as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms
        if (!u) return
        if (u.uGalaxy) u.uGalaxy.value = uGalaxy.value
        if (u.uSky) u.uSky.value = uSky.value
      })
    }
    if (!galaxy.current?.parent) galaxy.current = scene.getObjectByName(GALAXY_LAYER) ?? null
    if (galaxy.current) galaxy.current.visible = uGalaxy.value > 0.004
    if (!reduced && !appClock.hold) appClock.t += dt
    if (!phased) return
    const w = size.width
    const h = size.height
    v.set(0, 0, 0).project(camera)
    const ox0 = (v.x * 0.5 + 0.5) * w
    const oy0 = (-v.y * 0.5 + 0.5) * h
    if (follow.roots.size) {
      const ox = `${((v.x * 0.5 + 0.5) * w).toFixed(1)}px`
      const oy = `${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px`
      for (const root of follow.roots) {
        root.style.setProperty('--cx-ox', ox)
        root.style.setProperty('--cx-oy', oy)
      }
    }
    // the space the labels may use: the screen, less an Ask thread pinned beside the view (r2)
    const room = w - 2 * askSideShift(document.documentElement.dataset.askSide, w)
    for (const [i, el] of follow.apps) {
      appPos(i, apps, appClock.t, tmp)
      v.set(tmp.x, tmp.y, tmp.z)
      const depth = v.distanceTo(camera.position)
      v.project(camera)
      const sx = (v.x * 0.5 + 0.5) * w
      const sy = (-v.y * 0.5 + 0.5) * h
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`
      // each name sits on the outer side of its body, away from the Ω and its name (never across them), and always
      // wholly on screen: a side with no room falls back to above or below, nudged inside the edges
      let lw = labelW.current.get(el)
      if (!lw || frame.current - lw.at > 30) {
        lw = { w: (el.firstElementChild as HTMLElement | null)?.offsetWidth || 120, at: frame.current }
        labelW.current.set(el, lw)
      }
      const dx = sx - ox0
      const dy = sy - oy0
      const side = labelSide(dx, dy, sx, lw.w, room)
      const nudge = side === 't' || side === 'b' ? Math.min(room - 8 - (sx + lw.w / 2), Math.max(8 - (sx - lw.w / 2), 0)) : 0
      if (el.dataset.side !== side) el.dataset.side = side
      el.style.setProperty('--cxp-nudge', `${nudge.toFixed(0)}px`)
      // nearer bodies' labels sit over farther ones
      el.style.zIndex = String(1000 - Math.round(depth * 10))
    }
  })
  return null
}

/** At rest the sky is drawn a little over twenty times a second while it can be seen: slow light costs less. */
function Pace({ fps }: { fps: number | null }) {
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => {
    if (!fps) return
    const t = window.setInterval(() => invalidate(), 1000 / fps)
    return () => window.clearInterval(t)
  }, [fps, invalidate])
  return null
}

/** Under reduced motion every change of state is a cut: draw it on the next frame (eases snap, so 2 frames settle). */
function PhaseInvalidate({ phase }: { phase: ShellPhase }) {
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => {
    invalidate(3)
  }, [phase, invalidate])
  return null
}

const NO_APPS: OrbitApp[] = []
/** The galaxy's layer (dust, systems, worlds): faded and switched off as one at rest and awake. */
const GALAXY_LAYER = 'cosmos-galaxy'

/* ============================================================ root */

export default function Scene({
  layout,
  reduced,
  desktop,
  hidden,
  onReady,
  onContext,
  phase = 'pro',
  phased = false,
  apps = NO_APPS,
}: {
  layout: CosmosLayout
  reduced: boolean
  desktop: boolean
  hidden: boolean
  onReady: () => void
  onContext?: (state: 'lost' | 'restored') => void
  /** CANDIDATE (cosmos-rest-r1): the shell's state, whether Cosmos takes part, and the apps the awake orbit carries */
  phase?: ShellPhase
  phased?: boolean
  apps?: OrbitApp[]
}) {
  const agents = useHive((s) => s.agents)
  const view = useCosmos((s) => s.view)
  // at rest the scene is drawn on demand from the first moment, at a slow pace while it can be seen, and awake at most 30 frames a second (Pace)
  const pacing = { hidden, reduced, phased, phase }
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
  // paced (rest and awake) the scene draws at most 22 frames a second, so it can afford the screen's own resolution, up
  // to 2 (crisp at DPR 1 and 2); unpaced (Pro), adaptive resolution keeps the frame rate on a weak device
  const paced = pacedFps(pacing) !== null
  const maxDpr = paced ? Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1) : desktop ? 1.75 : 1.5
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
      frameloop={frameloopFor(pacing)}
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
      <group name={GALAXY_LAYER}>
        <GalaxyDust count={lite ? 260 : 600} layout={layout} px={1} cloud dim={view.kind === 'galaxy' ? 1 : 0.35} />
        <GalaxyDust count={lite ? 9000 : 24000} layout={layout} px={1} dim={view.kind === 'galaxy' ? 1 : 0.55} />
        {layout.systems.map((s) => (
          <StarSystem key={s.id} sys={s} layout={layout} lite={lite} current={currentSystem === s.id} focusSystem={currentSystem === s.id} />
        ))}
        {layout.planets.map((p) =>
          p.group ? <GroupWorld key={p.id} p={p} sys={p.systemId ? layout.systemById[p.systemId] : null} geos={geos} /> : agents[p.id] ? <Planet key={p.id} p={p} agent={agents[p.id]} sys={p.systemId ? layout.systemById[p.systemId] : null} geos={geos} selected={view.kind === 'mind' && view.id === p.id} /> : null,
        )}
        <Reticle layout={layout} />
        <Pulses layout={layout} />
      </group>
      {phased ? <OmegaCore phase={phase} view={view} reduced={reduced} /> : <Glow color={CORE_COLOR} scale={34} intensity={0.55} rays={0.6} position={[0, 0, 0]} fade={view.kind === 'galaxy' ? 1 : 0.3} />}
      {phased && <AppOrbit apps={apps} phase={phase} reduced={reduced} />}
      <CameraRig layout={layout} reduced={reduced} desktop={desktop} phase={phase} phased={phased} />
      <PhaseDriver phase={phase} phased={phased} reduced={reduced} apps={apps.length} />
      <LabelDriver />
      {/* only when unpaced: a paced scene's low frame rate is by design, not a sign of a slow device */}
      {!reduced && !paced && <Adaptive max={maxDpr} />}
      {paced && <PacedDpr max={maxDpr} fps={pacedFps(pacing) ?? 22} />}
      {reduced && <DemandInvalidate />}
      {reduced && phased && <PhaseInvalidate phase={phase} />}
      <Pace fps={pacedFps(pacing)} />
      <Effects lite={lite} reduced={reduced} crisp={phased && phase !== 'pro'} />
    </Canvas>
  )
}
