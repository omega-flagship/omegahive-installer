/**
 * The personal mind as a softly lit glass figure (Classic; the owner picked direction B, mock-up personal-mind/classic.html):
 * memory as a cloud in the head, energy as a core in the chest, light running to the hands while it acts, and a halo
 * for its version. Pure SVG, drawn from the presence and a few counts; decorative motion only, and none at all under
 * reduced motion (the page's own setting or the system's): the states then differ by light alone.
 */
import { useId } from 'react'
import type { MindPresence } from '../../api/personalMind'
import { useReducedMotion } from '../../lib/hooks'
import { lookState } from '../../shell/uiVariant'
import { ARM_LEFT, ARM_RIGHT, BODY } from './figurePaths'

export interface GlassFigureProps {
  name: string
  presence: MindPresence
  /** how many things it remembers (the memory cloud's stars, up to 9) */
  remembers: number
  /** it is acting on the screen now: light runs to the hands */
  acting: boolean
  /** a version is known: the halo is drawn */
  versioned: boolean
  width?: number
  className?: string
}

const STARS: [number, number, number, string][] = [
  [186, 70, 1.6, '#6ee7ff'],
  [214, 62, 1.2, '#ffffff'],
  [204, 92, 1.8, '#a493ff'],
  [222, 84, 1.1, '#6ee7ff'],
  [178, 96, 1.2, '#ffffff'],
  [196, 52, 1.0, '#6ee7ff'],
  [230, 104, 1.0, '#a493ff'],
  [170, 78, 1.0, '#a493ff'],
  [208, 110, 1.1, '#ffffff'],
]

/** How brightly each part glows in each presence (0..1). */
const LIGHT: Record<MindPresence, { body: number; core: number; memory: number; halo: number }> = {
  asleep: { body: 0.55, core: 0.28, memory: 0.35, halo: 0.35 },
  waking: { body: 0.75, core: 0.6, memory: 0.6, halo: 0.6 },
  listening: { body: 0.9, core: 0.85, memory: 0.85, halo: 0.85 },
  working: { body: 1, core: 1, memory: 1, halo: 1 },
}

const WORDS: Record<MindPresence, string> = {
  asleep: 'asleep',
  waking: 'waking',
  listening: 'awake and listening',
  working: 'working on your screen',
}

export function GlassFigure({ name, presence, remembers, acting, versioned, width = 280, className }: GlassFigureProps) {
  const raw = useId()
  const u = `pm${raw.replace(/[^A-Za-z0-9]/g, '')}`
  // the system's setting, or the person's own look with motion off
  const reduced = useReducedMotion() || lookState().saved?.variant?.motion === 'none'
  const light = LIGHT[presence]
  const stars = STARS.slice(0, Math.max(2, Math.min(STARS.length, remembers)))
  const hands = acting ? 1 : presence === 'asleep' ? 0.18 : 0.4
  const animate = !reduced
  const r = (id: string) => `url(#${u}${id})`
  return (
    <svg
      className={className}
      viewBox="0 -10 400 910"
      width={width}
      height={Math.round((width * 910) / 400)}
      role="img"
      aria-label={`${name}, drawn as a softly lit glass figure, ${WORDS[presence]}: memory in the head, energy in the chest, light to the hands`}
      data-presence={presence}
      data-acting={acting ? '' : undefined}
      data-motion={animate ? 'on' : 'off'}
      style={{ overflow: 'visible', maxWidth: '100%', height: 'auto' }}
    >
      <defs>
        <linearGradient id={`${u}body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(185,174,255,.26)" />
          <stop offset=".55" stopColor="rgba(185,174,255,.26)" stopOpacity=".6" />
          <stop offset="1" stopColor="rgba(110,231,255,.07)" />
        </linearGradient>
        <linearGradient id={`${u}sheen`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity=".16" />
          <stop offset=".35" stopColor="#fff" stopOpacity=".03" />
          <stop offset=".8" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".07" />
        </linearGradient>
        <linearGradient id={`${u}rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(200,190,255,.55)" />
          <stop offset="1" stopColor="rgba(200,190,255,.55)" stopOpacity=".25" />
        </linearGradient>
        <linearGradient id={`${u}halo`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6ee7ff" />
          <stop offset=".5" stopColor="#a493ff" />
          <stop offset="1" stopColor="#ff8fd8" />
        </linearGradient>
        <linearGradient id={`${u}arm`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a493ff" stopOpacity=".2" />
          <stop offset="1" stopColor="#6ee7ff" />
        </linearGradient>
        <radialGradient id={`${u}mem`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#6ee7ff" stopOpacity=".75" />
          <stop offset=".45" stopColor="#a493ff" stopOpacity=".35" />
          <stop offset="1" stopColor="#a493ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${u}core`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity=".95" />
          <stop offset=".18" stopColor="#a493ff" stopOpacity=".85" />
          <stop offset=".6" stopColor="#a493ff" stopOpacity=".18" />
          <stop offset="1" stopColor="#a493ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${u}hand`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".2" stopColor="#6ee7ff" stopOpacity=".8" />
          <stop offset="1" stopColor="#6ee7ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${u}floor`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#a493ff" stopOpacity=".35" />
          <stop offset="1" stopColor="#a493ff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${u}soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id={`${u}blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <clipPath id={`${u}clip`}>
          <path d={BODY} />
        </clipPath>
      </defs>

      <ellipse cx="200" cy="874" rx="120" ry="14" fill={r('floor')} opacity={light.body} />
      {versioned && (
        <g opacity={light.halo} data-part="halo">
          <g className={animate ? 'pm-halo' : undefined}>
            <ellipse cx="200" cy="20" rx="70" ry="11" fill="none" stroke={r('halo')} strokeWidth="1.6" opacity=".9" />
            <ellipse cx="200" cy="20" rx="70" ry="11" fill="none" stroke="#a493ff" strokeWidth="5" opacity=".14" filter={r('soft')} />
          </g>
        </g>
      )}
      <path d={BODY} fill="rgba(4,4,15,.35)" />
      <path d={BODY} fill={r('body')} opacity={light.body} />
      <g clipPath={r('clip')}>
        <rect x="0" y="-10" width="400" height="910" fill={r('sheen')} />
        <path d="M200 150 L200 450" stroke="#a493ff" strokeWidth="10" opacity={0.1 * light.core} filter={r('soft')} />
        <path d="M200 150 C198 220 202 330 200 450" stroke="#6ee7ff" strokeWidth=".8" opacity={0.45 * light.core} fill="none" />
        <g opacity={light.memory} data-part="memory">
          <g className={animate && presence !== 'asleep' ? 'pm-memory' : undefined}>
          <ellipse cx="204" cy="80" rx="50" ry="52" fill={r('mem')} filter={r('blur')} />
          <ellipse cx="186" cy="74" rx="22" ry="18" fill="#6ee7ff" opacity=".22" filter={r('soft')} />
          <ellipse cx="216" cy="94" rx="20" ry="16" fill="#a493ff" opacity=".30" filter={r('soft')} />
          {stars.map(([x, y, rr, c], i) => (
            <circle key={i} cx={x} cy={y} r={rr} fill={c} opacity=".85" />
          ))}
          </g>
        </g>
        <g opacity={light.core} data-part="core">
          <g className={animate && presence !== 'asleep' ? (presence === 'waking' ? 'pm-core pm-core-slow' : 'pm-core') : undefined}>
          <circle cx="200" cy="262" r="58" fill={r('core')} />
          <circle cx="200" cy="262" r="52" fill="none" stroke="#a493ff" strokeWidth="1" opacity="0.28" />
          <circle cx="200" cy="262" r="70" fill="none" stroke="#a493ff" strokeWidth="1" opacity="0.16" />
          <circle cx="200" cy="262" r="90" fill="none" stroke="#a493ff" strokeWidth="1" opacity="0.08" />
          </g>
        </g>
        <g data-part="arms" opacity={acting ? 1 : 0.45 * light.body}>
          <path d={ARM_RIGHT} fill="none" stroke={r('arm')} strokeWidth="7" strokeLinecap="round" opacity="0.55" filter={r('soft')} />
          <path d={ARM_RIGHT} fill="none" stroke={r('arm')} strokeWidth="1.6" strokeLinecap="round" className={animate && acting ? 'pm-flow' : undefined} />
          <path d={ARM_LEFT} fill="none" stroke={r('arm')} strokeWidth="5" strokeLinecap="round" opacity="0.3" filter={r('soft')} />
          <path d={ARM_LEFT} fill="none" stroke={r('arm')} strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
        </g>
      </g>
      <g data-part="hands" opacity={hands}>
        <circle cx="340" cy="548" r={acting ? 46 : 32} fill={r('hand')} className={animate && acting ? 'pm-hand' : undefined} />
        <circle cx="60" cy="548" r="30" fill={r('hand')} opacity="0.55" />
      </g>
      <path d={BODY} fill="none" stroke={r('rim')} strokeWidth="1.3" />
      <path d={BODY} fill="none" stroke="#fff" strokeWidth=".5" opacity="0.35" transform="translate(-1.2 -1)" />
    </svg>
  )
}
