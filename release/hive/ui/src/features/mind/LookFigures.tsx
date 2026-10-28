/**
 * The personal mind in the other looks (the owner, 2026-10-08: "use whatever is tasteful for each UI"), on the same props
 * and data as the Classic glass figure:
 * - Cosmos: a constellation, a standing figure in points of light (mock-up personal-mind/cosmos.html). Its outline is
 *   sampled from the same body path as the glass figure; the dust around it is seeded, so it never moves between renders.
 * - Still: one continuous ink line, seated (mock-up personal-mind/still.html), with three red callout marks.
 * Both are pure SVG, reduced-motion safe (Cosmos twinkles only when motion is allowed; Still never moves).
 */
import { useId, useMemo } from 'react'
import { useReducedMotion } from '../../lib/hooks'
import { lookState } from '../../shell/uiVariant'
import type { GlassFigureProps } from './GlassFigure'
import { BODY, samplePath, STILL_HALO, STILL_LINE } from './figurePaths'

const WORDS = { asleep: 'asleep', waking: 'waking', listening: 'awake and listening', working: 'working on your screen' } as const

/** mulberry32: a tiny seeded PRNG (the same dust every render). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const motionOff = () => lookState().saved?.variant?.motion === 'none'

/** Skeleton joints and limbs (from the Cosmos mock-up); the right arm carries the light while it acts. */
const JOINTS: Record<string, [number, number]> = {
  neck: [200, 160], rs: [276, 194], ls: [124, 194], re: [308, 362], le: [92, 362], rw: [330, 492], lw: [70, 492], rh: [342, 552], lh: [58, 552],
  core: [200, 262], hip: [200, 446], rhip: [246, 456], lhip: [154, 456], rk: [232, 656], lk: [168, 656], ra: [228, 832], la: [172, 832], rf: [250, 864], lf: [150, 864],
}
const BONES: [string, string, boolean?][] = [
  ['neck', 'rs'], ['neck', 'ls'], ['rs', 're', true], ['re', 'rw', true], ['rw', 'rh', true], ['ls', 'le'], ['le', 'lw'], ['lw', 'lh'],
  ['neck', 'core'], ['core', 'hip'], ['rs', 'core'], ['ls', 'core'], ['hip', 'rhip'], ['hip', 'lhip'], ['rhip', 'rk'], ['rk', 'ra'], ['ra', 'rf'], ['lhip', 'lk'], ['lk', 'la'], ['la', 'lf'],
]
const HEAD = '200,32 225.7,43.7 239.4,73.3 234.6,107 213.7,129 186.3,129 165.4,107 160.6,73.3 174.3,43.7 200,32'
const HEAD_STARS: [number, number][] = [[200, 32], [225.7, 43.7], [239.4, 73.3], [234.6, 107], [213.7, 129], [186.3, 129], [165.4, 107], [160.6, 73.3], [174.3, 43.7]]
const MEMORY_STARS: [number, number][] = [[192, 66], [212, 58], [204, 90], [222, 80], [184, 96], [198, 48], [228, 100], [176, 78], [210, 112]]

const LIGHT = { asleep: 0.4, waking: 0.65, listening: 0.85, working: 1 } as const

export function ConstellationFigure({ name, presence, remembers, acting, versioned, width = 280, className }: GlassFigureProps) {
  const u = `pc${useId().replace(/[^A-Za-z0-9]/g, '')}`
  const animate = !useReducedMotion() && !motionOff()
  const light = LIGHT[presence]
  const { dust, outline } = useMemo(() => {
    const r = seeded(0x5eed)
    const dust = Array.from({ length: 220 }, () => [r() * 400, r() * 900 - 10, 0.4 + r() * 0.4, 0.12 + r() * 0.32] as const)
    const outline = samplePath(BODY, 3).map(([x, y], i) => [x, y, i % 7 === 0 ? 1.1 : 0.7, 0.35 + ((i * 37) % 50) / 100] as const)
    return { dust, outline }
  }, [])
  const gold = '#ffc36b'
  const blue = '#7cc4ff'
  const pale = '#cfe3ff'
  const stars = MEMORY_STARS.slice(0, Math.max(2, Math.min(MEMORY_STARS.length, remembers)))
  return (
    <svg className={className} viewBox="0 -10 400 910" width={width} height={Math.round((width * 910) / 400)} role="img" aria-label={`${name}, drawn as a constellation figure in points of light, ${WORDS[presence]}`} data-presence={presence} data-figure="constellation" data-motion={animate ? 'on' : 'off'} style={{ overflow: 'visible', maxWidth: '100%', height: 'auto' }}>
      <defs>
        <radialGradient id={`${u}b`}><stop offset="0" stopColor={blue} stopOpacity=".55" /><stop offset="1" stopColor={blue} stopOpacity="0" /></radialGradient>
        <radialGradient id={`${u}g`}><stop offset="0" stopColor={gold} stopOpacity=".6" /><stop offset="1" stopColor={gold} stopOpacity="0" /></radialGradient>
        <radialGradient id={`${u}n`}><stop offset="0" stopColor={blue} stopOpacity=".22" /><stop offset=".6" stopColor="#6b7cff" stopOpacity=".08" /><stop offset="1" stopColor="#6b7cff" stopOpacity="0" /></radialGradient>
      </defs>
      {versioned && <ellipse cx="200" cy="18" rx="66" ry="9" fill="none" stroke={blue} strokeWidth=".7" strokeDasharray="1 4" opacity={0.7 * light} data-part="halo" />}
      <ellipse cx="202" cy="80" rx="46" ry="50" fill={`url(#${u}n)`} opacity={0.9 * light} />
      <g>{dust.map(([x, y, r, o], i) => <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={r.toFixed(2)} fill={pale} opacity={o.toFixed(2)} />)}</g>
      <g opacity={light} data-part="outline">{outline.map(([x, y, r, o], i) => <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={r} fill={pale} opacity={o.toFixed(2)} />)}</g>
      <polyline points={HEAD} fill="none" stroke={pale} strokeWidth=".6" opacity={0.35 * light + 0.1} />
      {BONES.map(([a, b, arm], i) => (
        <line key={i} x1={JOINTS[a][0]} y1={JOINTS[a][1]} x2={JOINTS[b][0]} y2={JOINTS[b][1]} stroke={arm && acting ? gold : blue} strokeWidth=".8" opacity={arm && acting ? 0.75 : 0.38 * light + 0.05} className={arm && acting && animate ? 'pm-flow' : undefined} />
      ))}
      {HEAD_STARS.map(([x, y], i) => <circle key={`h${i}`} cx={x} cy={y} r="1.6" fill={pale} opacity={0.5 + 0.4 * light} />)}
      <g data-part="memory" opacity={light}>
        <g className={animate && presence !== 'asleep' ? 'pm-memory' : undefined}>{stars.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.8 : 1.2} fill={i % 2 ? blue : '#ffffff'} />)}</g>
      </g>
      {Object.entries(JOINTS).map(([k, [x, y]]) => <circle key={k} cx={x} cy={y} r="1.5" fill={pale} opacity={0.6 * light + 0.2} />)}
      <g data-part="core" opacity={light}>
        <g className={animate && presence !== 'asleep' ? 'pm-core' : undefined}>
          <circle cx="200" cy="262" r="34" fill={`url(#${u}b)`} />
          <path d="M188 262 L212 262 M200 250 L200 274" stroke={blue} strokeWidth=".6" opacity=".7" />
          <circle cx="200" cy="262" r="2.4" fill="#ffffff" />
        </g>
      </g>
      <g data-part="hands">
        <circle cx="342" cy="552" r={acting ? 26 : 14} fill={`url(#${acting ? `${u}g` : `${u}b`})`} opacity={acting ? 1 : 0.4 * light} className={acting && animate ? 'pm-hand' : undefined} />
        <circle cx="58" cy="552" r="14" fill={`url(#${u}b)`} opacity={0.35 * light} />
        {acting && <path d="M330.8 552 L353.2 552 M342 540.8 L342 563.2" stroke={gold} strokeWidth=".6" opacity=".7" />}
      </g>
    </svg>
  )
}

export function LinePortrait({ name, presence, remembers, acting, versioned, width = 280, className }: GlassFigureProps) {
  const ink = 'var(--color-ink, #1b1712)'
  const red = 'var(--color-accent, #a3221b)'
  const faded = presence === 'asleep' ? 0.55 : 1
  const mark = (x: number, y: number, on: boolean, part: string) => (
    <g data-part={part} opacity={on ? 1 : 0.45}>
      <circle cx={x} cy={y} r="9" fill="none" stroke={red} strokeWidth="1" />
      <circle cx={x} cy={y} r="3.2" fill={red} />
    </g>
  )
  return (
    <svg className={className} viewBox="0 0 400 680" width={width} height={Math.round((width * 680) / 400)} role="img" aria-label={`${name}, drawn as one continuous ink line, a figure seated on a stool, ${WORDS[presence]}`} data-presence={presence} data-figure="line" style={{ overflow: 'visible', maxWidth: '100%', height: 'auto' }}>
      {versioned && <path d={STILL_HALO} fill="none" stroke={ink} strokeWidth="1.1" strokeLinecap="round" opacity={0.8 * faded} data-part="halo" />}
      <path d={STILL_LINE} fill="none" stroke={ink} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" opacity={faded} />
      {mark(201, 96, remembers > 0, 'memory')}
      {mark(236, 292, presence !== 'asleep', 'core')}
      {mark(300, 382, acting, 'hands')}
    </svg>
  )
}
