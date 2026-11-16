import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'
import { buildFigureMask, FIG_H, FIG_W } from './anatomy'
import { KIND_COLOR, marksAt, STRUCTURE, TERRITORIES, TERRITORY, type Mark, type TerritoryId } from './model'
import { AskModal, CaptureModal, DISCLAIMER, EmptyState, Header, Icon, LedgerModal, MarkIndex, PlanPanel, SampleBanner, TimelinePanel, TodayPanel, ViewBar } from './panels'
import { ConsentDialog, Outcomes, Reading, ZoomRail } from './parts'
import type { Atlas } from './useAtlas'
import { ALTITUDE_NAMES, type Level } from './types'

/**
 * Cosmos: a planet of self. The lit figure is the core of a slowly turning world; territories are its atmospheric
 * bands; time runs around it as longitude (the oldest record at the dawn line, the newest at dusk); the depths are
 * altitudes: orbit (Systems), low flight (Structures), surface (Values), core sample (Provenance).
 */

/** Band latitudes, north to south: the mind above, context below, as in the body. */
const BAND_LAT: Record<TerritoryId, number> = { mind: 64, sleep: 42, endocrine: 21, body: 0, metabolic: -21, context: -44 }
const ALT = [5.6, 3.3, 2.05, 0.62]
const R = 1

/** Where a record sits on the planet: latitude from its territory (structure spreads it within the band), longitude from its date. */
function planetSpot(m: Mark, t0: number, t1: number): { lat: number; lon: number; alt: number } {
  const p = m.place
  const s = p.structure ? STRUCTURE[p.structure] : null
  const spread = s ? ((s.y % 37) / 37 - 0.5) * 12 : 0
  const at = m.item.at ? Date.parse(m.item.at) : NaN
  const f = Number.isFinite(at) && t1 > t0 ? (at - t0) / (t1 - t0) : hash01(m.item.id)
  const k = m.item.kind
  const alt = k === 'hypothesis' ? 1.32 : k === 'prediction' || k === 'experiment' ? 1.16 : k === 'event' ? 0.8 : k === 'literature' ? 1.45 : 1.012
  const lon = Number.isFinite(at) ? -150 + f * 300 : (hash01(m.item.id) * 360) - 180
  return { lat: BAND_LAT[p.territory] + spread + (k === 'hypothesis' ? 0 : (hash01(m.item.id + 'j') - 0.5) * 5), lon, alt }
}
function hash01(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}
function toXYZ(lat: number, lon: number, r: number, out = new THREE.Vector3()) {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  return out.set(Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r)
}

/* ================================================================ shaders */

const NOISE = `
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){s+=a*vnoise(p);p=m*p;a*=.5;}return s;}
`

const shellVert = `
varying vec3 vN; varying vec3 vP; varying vec3 vW;
void main(){ vN = normalize(normalMatrix*normal); vP = position; vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`

const shellFrag = `
uniform float uT; uniform vec3 uBand[6]; uniform float uLat[6]; uniform float uOn[6]; uniform float uDim; uniform vec3 uCam;
varying vec3 vN; varying vec3 vP; varying vec3 vW;
${NOISE}
void main(){
  vec3 p = normalize(vP);
  float lat = degrees(asin(p.y));
  float lon = atan(p.x, p.z);
  vec3 col = vec3(0.); float a = 0.;
  for (int i = 0; i < 6; i++) {
    float d = (lat - uLat[i]) / 9.5;
    float band = exp(-d*d);
    // seamless around the world: noise over the unit circle of longitude, stretched along the band
    float dir = mod(float(i),2.)*2.-1.;
    float ang = lon + uT*.02*dir;
    vec2 q = vec2(cos(ang)*1.6 + sin(ang)*0.4, sin(ang)*1.6);
    float n = fbm(vec2(q.x*1.4 + q.y*0.9, lat*.33) + vec2(q.y*1.2, 0.) + float(i)*3.7);
    float streak = smoothstep(.35,.85,n);
    col += uBand[i] * band * (.25 + 1.1*streak) * uOn[i];
    a += band * (.16 + .5*streak) * uOn[i];
  }
  vec3 V = normalize(uCam - vW);
  float fres = pow(1. - abs(dot(normalize(vN), normalize((viewMatrix*vec4(V,0.)).xyz))), 2.6);
  col += mix(vec3(.5,.83,1.), vec3(1.,.54,.48), smoothstep(-.3,.6,p.y)) * fres * .9;
  a += fres*.55;
  gl_FragColor = vec4(col*(1.-uDim*.6), clamp(a,0.,.92)*(1.-uDim*.5));
}`

const glowFrag = `
varying vec3 vN; varying vec3 vP; varying vec3 vW; uniform vec3 uCam;
void main(){
  vec3 V = normalize(uCam - vW);
  float f = pow(1. - abs(dot(normalize(vN), normalize((viewMatrix*vec4(V,0.)).xyz))), 3.);
  gl_FragColor = vec4(mix(vec3(.5,.83,1.), vec3(1.,.54,.48), .35) * f * .9, f*.8);
}`

const figVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`
const figFrag = `
uniform sampler2D uF; uniform float uT; uniform float uA; varying vec2 vUv;
${NOISE}
void main(){
  vec2 fuv = vUv;
  vec4 f = texture2D(uF, fuv); float inside=f.r, organs=f.g, fil=f.b, halo=f.a;
  float side = clamp(1. - abs(fuv.x - .38)*1.65, 0., 1.);
  float grain = fbm(fuv*vec2(8.,15.) + vec2(0., -uT*.012));
  float flow = .5 + .5*sin(fuv.y*52. - uT*.6 + grain*5.);
  vec3 tissue = mix(vec3(.11,.19,.43), vec3(.39,.52,.83), side);
  vec3 col = halo*vec3(.16,.25,.58)*.4 + inside*tissue*(.45+.25*grain) + fil*vec3(.5,.83,1.)*(.4+.7*flow) + organs*mix(vec3(1.,.54,.48), vec3(.84,.62,1.), fuv.y)*1.25;
  float a = clamp(halo*.35 + inside*.75 + fil + organs, 0., 1.);
  gl_FragColor = vec4(col*uA, a*uA);
}`

function shellMaterialParams() {
  return {
    vertexShader: shellVert,
    fragmentShader: shellFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uT: { value: 0 },
      uBand: { value: TERRITORIES.map((x) => new THREE.Color(x.color)) },
      uLat: { value: TERRITORIES.map((x) => BAND_LAT[x.id]) },
      uOn: { value: TERRITORIES.map(() => 1) },
      uDim: { value: 0 },
      uCam: { value: new THREE.Vector3() },
    },
  }
}

function figureTexture() {
  const m = buildFigureMask(0.75)
  const tex = m ? new THREE.DataTexture(m.data, m.w, m.h, THREE.RGBAFormat) : new THREE.DataTexture(new Uint8Array(4), 1, 1)
  tex.flipY = true
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/* ================================================================ scene */

const rig = { radius: ALT[0], goal: ALT[0], yaw: 0.4, pitch: 0.18, drag: false, lastInput: 0 }

function Rig({ level, reduced, territory }: { level: Level; reduced: boolean; territory: TerritoryId | null }) {
  const { camera, gl, invalidate } = useThree()
  useEffect(() => {
    rig.goal = ALT[level]
    // a focused band brings the camera level with it
    if (territory) rig.pitch = Math.max(-1.1, Math.min(1.1, (BAND_LAT[territory] * Math.PI) / 180 * 0.9))
    if (reduced) rig.radius = rig.goal
    invalidate()
  }, [level, reduced, territory, invalidate])
  useEffect(() => {
    const el = gl.domElement
    let last: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
      rig.drag = false
    }
    const move = (e: PointerEvent) => {
      if (!last) return
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      if (Math.abs(dx) + Math.abs(dy) > 3) rig.drag = true
      rig.yaw -= dx * 0.006
      rig.pitch = Math.max(-1.1, Math.min(1.1, rig.pitch + dy * 0.004))
      rig.lastInput = performance.now()
      last = { x: e.clientX, y: e.clientY }
      invalidate()
    }
    const up = () => {
      last = null
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [gl, invalidate])
  useFrame((_, dt) => {
    if (!reduced && performance.now() - rig.lastInput > 4000) rig.yaw += dt * 0.035
    rig.radius += (rig.goal - rig.radius) * (reduced ? 1 : 1 - Math.exp(-dt * 2.2))
    const r = rig.radius
    camera.position.set(Math.sin(rig.yaw) * Math.cos(rig.pitch) * r, Math.sin(rig.pitch) * r + (r < 1 ? 0 : 0.05 * r), Math.cos(rig.yaw) * Math.cos(rig.pitch) * r)
    camera.lookAt(0, r < 1 ? 0 : 0, 0)
    if (reduced && Math.abs(rig.goal - rig.radius) > 1e-3) invalidate()
  })
  return null
}

function Planet({ atlas, marks, reduced, onSelect }: { atlas: Atlas; marks: Mark[]; reduced: boolean; onSelect: (id: string) => void }) {
  const { camera } = useThree()
  const t = useRef(0)
  // materials are declared in JSX (r3f owns and disposes them); uniforms are driven through refs
  const shellParams = useMemo(() => shellMaterialParams(), [])
  const glowParams = useMemo(() => ({ vertexShader: shellVert, fragmentShader: glowFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, uniforms: { uCam: { value: new THREE.Vector3() } } }), [])
  const figTex = useMemo(() => figureTexture(), [])
  const figParams = useMemo(() => ({ vertexShader: figVert, fragmentShader: figFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uF: { value: figTex }, uT: { value: 0 }, uA: { value: 1 } } }), [figTex])
  useEffect(() => () => figTex.dispose(), [figTex])
  const shell = useRef<THREE.ShaderMaterial>(null)
  const glow = useRef<THREE.ShaderMaterial>(null)
  const fig = useRef<THREE.ShaderMaterial>(null)
  useEffect(() => {
    if (shell.current) shell.current.uniforms.uOn.value = TERRITORIES.map((x) => (!atlas.territory || atlas.territory === x.id ? 1 : 0.18))
    // the core is the subject at orbit and at the core sample; at low flight and the surface it recedes behind the records
    const depth = atlas.view === 'map' ? atlas.level : 0
    if (fig.current) fig.current.uniforms.uA.value = atlas.mode === 'empty' ? 0.45 : [1, 0.7, 0.28, 1][depth]
  }, [atlas.territory, atlas.mode, atlas.level, atlas.view])
  const figure = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (!reduced) t.current += dt
    if (shell.current) {
      shell.current.uniforms.uT.value = t.current
      shell.current.uniforms.uCam.value.copy(camera.position)
      shell.current.uniforms.uDim.value = atlas.view === 'timeline' || atlas.view === 'plan' ? 0.5 : 0
    }
    if (fig.current) fig.current.uniforms.uT.value = t.current
    glow.current?.uniforms.uCam.value.copy(camera.position)
    figure.current?.quaternion.copy(camera.quaternion)
  })

  /* ---- marks as instances */
  const [t0, t1] = useMemo(() => {
    const ts = atlas.graph.items.map((i) => (i.at ? Date.parse(i.at) : NaN)).filter(Number.isFinite)
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 1]
  }, [atlas.graph])
  const pts = useMemo(() => marks.filter((m) => m.item.kind !== 'subject' && m.item.kind !== 'question').map((m) => ({ m, spot: planetSpot(m, t0, t1) })), [marks, t0, t1])
  const inst = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => new THREE.SphereGeometry(1, 12, 8), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), [])
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat])
  useEffect(() => {
    const im = inst.current
    if (!im) return
    const o = new THREE.Object3D()
    const c = new THREE.Color()
    pts.forEach(({ m, spot }, i) => {
      toXYZ(spot.lat, spot.lon, spot.alt * R, o.position)
      const k = m.item.kind
      const s = (k === 'hypothesis' ? 0.042 : k === 'observation' ? 0.0125 : k === 'event' ? 0.01 : 0.022) * (m.presence === 'glimmer' ? 0.55 : 1) * (atlas.selected === m.item.id ? 1.9 : 1)
      o.scale.setScalar(s)
      o.updateMatrix()
      im.setMatrixAt(i, o.matrix)
      const col = k === 'observation' ? TERRITORY[m.place.territory].color : KIND_COLOR[k] ?? '#cfe9ff'
      const retired = m.item.status && m.item.status !== 'current'
      c.set(retired ? '#ff9aa6' : col).multiplyScalar(m.presence === 'glimmer' ? 0.9 : atlas.selected === m.item.id ? 3.2 : 1.7)
      im.setColorAt(i, c)
    })
    im.count = pts.length
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
  }, [pts, atlas.selected])

  /* ---- threads: the selected idea's evidence, and at the core, extraction lines */
  const lines = useMemo(() => {
    const pos = new Map(pts.map(({ m, spot }) => [m.item.id, toXYZ(spot.lat, spot.lon, spot.alt)]))
    const segs: number[] = []
    const cols: number[] = []
    const add = (a: string, b: string, col: string) => {
      const pa = pos.get(a)
      const pb = pos.get(b)
      if (!pa || !pb) return
      const c = new THREE.Color(col)
      segs.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z)
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    const sel = atlas.selected
    if (sel) for (const l of [...(atlas.ix.out.get(sel) ?? []), ...(atlas.ix.into.get(sel) ?? [])]) add(l.from, l.to, l.rel === 'supports' ? '#9fe6c4' : l.rel === 'contradicts' ? '#ff9aa6' : '#ffd68a')
    if (atlas.level >= 3) for (const l of atlas.graph.links) if (l.rel === 'extracted-from') add(l.from, l.to, '#3d5a7a')
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
    return g
  }, [pts, atlas.selected, atlas.level, atlas.ix, atlas.graph])
  useEffect(() => () => lines.dispose(), [lines])

  const click = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (rig.drag || e.instanceId == null) return
      e.stopPropagation()
      const p = pts[e.instanceId]
      if (p && p.m.presence === 'full') onSelect(p.m.item.id)
    },
    [pts, onSelect],
  )

  return (
    <group>
      <mesh ref={figure} renderOrder={1}>
        <planeGeometry args={[(FIG_W / FIG_H) * 1.5, 1.5]} />
        <shaderMaterial ref={fig} args={[figParams]} />
      </mesh>
      <mesh renderOrder={2}>
        <sphereGeometry args={[R, 96, 64]} />
        <shaderMaterial ref={shell} args={[shellParams]} />
      </mesh>
      <mesh scale={1.16}>
        <sphereGeometry args={[R, 64, 32]} />
        <shaderMaterial ref={glow} args={[glowParams]} />
      </mesh>
      {atlas.mode !== 'empty' && <instancedMesh ref={inst} args={[geo, mat, Math.max(1, pts.length)]} onClick={click} />}
      <lineSegments geometry={lines}>
        <lineBasicMaterial vertexColors transparent opacity={0.85} toneMapped={false} />
      </lineSegments>
      <Stars />
    </group>
  )
}

function Stars() {
  const geo = useMemo(() => {
    const n = 1400
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const v = toXYZ(Math.asin(hash01('s' + i) * 2 - 1) * (180 / Math.PI), hash01('l' + i) * 360, 40 + hash01('r' + i) * 40)
      p.set([v.x, v.y, v.z], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  }, [])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <points geometry={geo}>
      <pointsMaterial size={0.09} color="#cfe3ff" transparent opacity={0.7} sizeAttenuation depthWrite={false} />
    </points>
  )
}

function Effects() {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.3} radius={0.75} />
      <Vignette offset={0.3} darkness={0.7} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  )
}

/* ================================================================ the form */

export default function Cosmos({ atlas }: { atlas: Atlas }) {
  const root = useRef<HTMLDivElement>(null)
  const reduced = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const [hidden, setHidden] = useState(false)
  const [desk, setDesk] = useState(true)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setHidden(!e.isIntersecting))
    io.observe(el)
    const vis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', vis)
    const ro = new ResizeObserver(([e]) => setDesk(e.contentRect.width >= 900))
    ro.observe(el)
    return () => {
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', vis)
    }
  }, [])
  const marks = useMemo(() => (atlas.mode === 'empty' ? [] : marksAt(atlas.ix, atlas.place, atlas.level, { asOf: atlas.asOf, territory: atlas.territory })), [atlas.mode, atlas.ix, atlas.place, atlas.level, atlas.asOf, atlas.territory])
  const openMap = useCallback(
    (id?: string, t?: TerritoryId) => {
      atlas.setView('map')
      if (t) atlas.focusTerritory(t)
      if (id) {
        const it = atlas.ix.byId.get(id)
        if (it?.kind === 'observation' && atlas.level < 2) atlas.setLevel(2)
        if (it?.kind === 'event' && atlas.level < 3) atlas.setLevel(3)
        atlas.select(id)
      }
    },
    [atlas],
  )
  const { view, mode, selected } = atlas
  const sheet = !!selected && mode !== 'empty'
  return (
    <div ref={root} className="lm lm-cosmos" data-view={view} data-mode={mode} data-sheet={sheet ? 'y' : undefined}>
      <div className="lm-cosmos-stage" data-shift={desk && view !== 'map' ? 'y' : undefined}>
        <Canvas
          dpr={[1, desk ? 1.75 : 1.5]}
          frameloop={hidden ? 'never' : reduced ? 'demand' : 'always'}
          gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
          camera={{ fov: 42, near: 0.02, far: 200, position: [0, 0.6, ALT[0]] }}
          onCreated={({ gl }) => gl.setClearColor('#03050b')}
          aria-hidden="true"
        >
          <Rig level={view === 'map' ? atlas.level : 0} reduced={reduced} territory={view === 'map' ? atlas.territory : null} />
          <Planet atlas={atlas} marks={marks} reduced={reduced} onSelect={atlas.select} />
          <Effects />
        </Canvas>
      </div>

      <Header atlas={atlas} />
      <SampleBanner atlas={atlas} />
      {mode === 'empty' ? (
        <EmptyState atlas={atlas} />
      ) : (
        <>
          {view === 'today' && (
            <aside className="lm-side lm-side-today">
              <TodayPanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'timeline' && (
            <aside className="lm-side lm-side-wide">
              <TimelinePanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'plan' && (
            <aside className="lm-side lm-side-wide">
              <PlanPanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'map' && (
            <>
              <div className="lm-bands" role="group" aria-label="Atmospheric bands: territories">
                <p className="lm-eyebrow">Bands</p>
                {[...TERRITORIES].sort((a, b) => BAND_LAT[b.id] - BAND_LAT[a.id]).map((t) => (
                  <button key={t.id} type="button" className="lm-band" style={{ ['--tc' as string]: t.color }} data-on={atlas.territory === t.id ? 'y' : undefined} onClick={() => atlas.focusTerritory(atlas.territory === t.id ? null : t.id)}>
                    <i aria-hidden="true" />
                    {t.label}
                  </button>
                ))}
                <p className="lm-note lm-bands-note">Longitude is time: the oldest record at dawn, the newest at dusk. Drag to turn the world.</p>
              </div>
              <ZoomRail level={atlas.level} onLevel={atlas.setLevel} names={ALTITUDE_NAMES} />
              <MarkIndex atlas={atlas} ids={marks.filter((m) => m.presence === 'full' && m.item.kind !== 'subject' && m.item.kind !== 'question').map((m) => m.item.id)} label="Records on the planet" />
            </>
          )}
          {sheet && (
            <div className="lm-sheet lm-paper" key={selected}>
              <div className="lm-sheet-grip" aria-hidden="true" />
              <Reading atlas={atlas} id={selected!} onClose={() => atlas.select(null)} />
            </div>
          )}
          <button type="button" className="lm-fab" onClick={() => atlas.setPanel('capture')} aria-label="Add to your record" title="Add to your record">
            <Icon name="plus" size={24} />
          </button>
          <ViewBar atlas={atlas} />
          <p className="lm-disclaimer">{DISCLAIMER}</p>
        </>
      )}
      {atlas.panel === 'ask' && <AskModal atlas={atlas} openMap={openMap} />}
      {atlas.panel === 'ledger' && <LedgerModal atlas={atlas} />}
      {atlas.panel === 'capture' && <CaptureModal atlas={atlas} />}
      <ConsentDialog atlas={atlas} />
      <Outcomes atlas={atlas} />
    </div>
  )
}
