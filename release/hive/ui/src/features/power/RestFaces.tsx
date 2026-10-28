import type { MouseEvent } from 'react'
import type { RestChip, RestChipId } from './rest'
import { blockDigits, handAngles, sketchCircle, timeInWords } from './restClocks'
import { hasScene, RestScene, type SceneData } from './RestScene'

/**
 * Each experience's rest, in its own grammar (the owner: "each UI will need a different stylised version"):
 *   Classic   the hive's orbs drifting slowly in the dark, a large thin clock
 *   Still     paper: the time written out as a sentence
 *   Canvas    a pencil-sketched clock face on the board, alerts as sticky notes
 *   Cosmos    deep space drifting, the time drawn as constellations
 *   Flux      slow liquid, the clock suspended in it
 *   Construct low rain, a terminal clock in block glyphs
 * Alerts are buttons (counts; each one wakes and goes there). The live line starts empty, so entering says nothing.
 */
export interface FaceProps {
  kind: string
  reduced: boolean
  now: Date
  clock: { digits: string; suffix: string | null }
  date: string
  line: string | null
  working: string
  busy: boolean
  chips: RestChip[]
  scene: SceneData
  onChip: (id: RestChipId) => void
}

function Live({ line, className = 'pw-alert' }: { line: string | null; className?: string }) {
  return (
    <div className={className} role="status" aria-live="polite">
      {line ?? ''}
    </div>
  )
}

function Chips({ chips, onChip, prefix }: { chips: RestChip[]; onChip: (id: RestChipId) => void; prefix?: string }) {
  if (!chips.length) return null
  const tap = (id: RestChipId) => (e: MouseEvent) => {
    e.stopPropagation()
    onChip(id)
  }
  return (
    <ul className="pw-chips" aria-label="While resting">
      {chips.map((c) => (
        <li key={c.id}>
          <button type="button" className="pw-chip" data-rest-chip={c.id} onClick={tap(c.id)}>
            {prefix && <span aria-hidden="true">{prefix}</span>}
            <b>{c.n}</b> {c.label.replace(/^\d+ /, '')}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Working({ text, busy }: { text: string; busy: boolean }) {
  return (
    <div className={`pw-working${busy ? ' pw-busy' : ''}`}>
      <span className="pw-pulse" aria-hidden="true" />
      {text}
    </div>
  )
}

const Time = ({ clock }: { clock: FaceProps['clock'] }) => (
  <>
    {clock.digits}
    {clock.suffix && <span className="pw-ampm">{clock.suffix}</span>}
  </>
)

export function RestFace(p: FaceProps) {
  const scene = hasScene(p.kind) ? <RestScene kind={p.kind} reduced={p.reduced} data={p.scene} /> : null
  switch (p.kind) {
    case 'still':
      return (
        <>
          <div className="pw-face">
            <p className="pw-words">{timeInWords(p.now)}</p>
            <div className="pw-small">
              <Time clock={p.clock} /> · {p.date}
            </div>
            <div className="pw-rule" aria-hidden="true" />
            <Working text={p.working} busy={p.busy} />
          </div>
          <div className="pw-foot">
            <Live line={p.line} />
            <Chips chips={p.chips} onChip={p.onChip} />
          </div>
        </>
      )
    case 'canvas':
      return (
        <>
          <div className="pw-face">
            <SketchClock now={p.now} />
            <div className="pw-hand">
              <Time clock={p.clock} /> · {p.date}
            </div>
            <Working text={p.working} busy={p.busy} />
          </div>
          <div className="pw-foot">
            <Live line={p.line} />
            <Chips chips={p.chips} onChip={p.onChip} />
          </div>
        </>
      )
    case 'cosmos':
      return (
        <>
          {scene}
          <div className="pw-face">
            {/* the constellations are the clock; this is the same time, for reading and for screen readers */}
            <div className="pw-readout">
              <span className="pw-clock">
                <Time clock={p.clock} />
              </span>
              <span aria-hidden="true"> · </span>
              {p.date}
            </div>
            <Working text={p.working} busy={p.busy} />
          </div>
          <div className="pw-foot">
            <Live line={p.line} />
            <Chips chips={p.chips} onChip={p.onChip} prefix="◇ " />
          </div>
        </>
      )
    case 'flux':
      return (
        <>
          {scene}
          <div className="pw-face">
            <div className="pw-clock">
              <Time clock={p.clock} />
            </div>
            <div className="pw-date">{p.date}</div>
            <Working text={p.working} busy={p.busy} />
          </div>
          <div className="pw-foot">
            <Live line={p.line} />
            <Chips chips={p.chips} onChip={p.onChip} />
          </div>
        </>
      )
    case 'construct':
      return (
        <>
          {scene}
          <div className="pw-term">
            <div className="pw-term-bar" aria-hidden="true">
              omega@hive: ~ (resting)
            </div>
            <div className="pw-term-body">
              <div aria-hidden="true">
                <span className="pw-prompt">$</span> clock
              </div>
              <pre className="pw-blocks" aria-hidden="true">
                {blockDigits(p.clock.digits).join('\n')}
              </pre>
              <div className="pw-clock sr-only">
                <Time clock={p.clock} />
              </div>
              <div className="pw-term-dim">
                {p.date}
                {p.clock.suffix ? ` · ${p.clock.suffix}` : ''}
              </div>
              <div aria-hidden="true">
                <span className="pw-prompt">$</span> hive status
              </div>
              <Working text={p.working} busy={p.busy} />
              <Chips chips={p.chips} onChip={p.onChip} prefix="[!] " />
              <Live line={p.line} />
              <div aria-hidden="true">
                <span className="pw-prompt">$</span> <span className="pw-cursor">█</span>
              </div>
            </div>
          </div>
        </>
      )
    default:
      return (
        <>
          {scene}
          <div className="pw-face">
            <div className="pw-clock">
              <Time clock={p.clock} />
            </div>
            <div className="pw-date">{p.date}</div>
            <Working text={p.working} busy={p.busy} />
          </div>
          <div className="pw-foot">
            <Live line={p.line} />
            <Chips chips={p.chips} onChip={p.onChip} />
          </div>
        </>
      )
  }
}

/** Canvas: a clock face sketched in pencil on the board (drawn in on arrival; hands move on the minute). */
function SketchClock({ now }: { now: Date }) {
  const { hour, minute } = handAngles(now)
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const r1 = i % 3 === 0 ? 76 : 82
    const j = ((i * 37) % 7) / 10 - 0.3
    return { x1: 100 + Math.sin(a) * r1, y1: 100 - Math.cos(a) * r1, x2: 100 + Math.sin(a + 0.01 * j) * 88, y2: 100 - Math.cos(a + 0.01 * j) * 88 }
  })
  const num = (n: number) => {
    const a = (n / 12) * Math.PI * 2
    return { x: 100 + Math.sin(a) * 62, y: 100 - Math.cos(a) * 62 + 6 }
  }
  return (
    <svg className="pw-sketch" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <filter id="pw-pencil" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" />
        </filter>
      </defs>
      <g filter="url(#pw-pencil)" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path className="pw-draw" d={sketchCircle(100, 100, 92, 1)} strokeWidth="1.6" pathLength={1} />
        <path className="pw-draw pw-draw-2" d={sketchCircle(100, 100, 93.5, 2.3, 0.3)} strokeWidth="0.8" opacity="0.55" pathLength={1} />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth={i % 3 === 0 ? 2 : 1} opacity={0.8} />
        ))}
        <g className="pw-hands">
          <line x1="100" y1="104" x2="100" y2="54" strokeWidth="3" transform={`rotate(${hour} 100 100)`} />
          <line x1="100" y1="106" x2="100" y2="26" strokeWidth="1.8" transform={`rotate(${minute} 100 100)`} />
          <circle cx="100" cy="100" r="3" fill="currentColor" />
        </g>
      </g>
      {[12, 3, 6, 9].map((n) => (
        <text key={n} x={num(n % 12).x} y={num(n % 12).y} textAnchor="middle" className="pw-num">
          {n}
        </text>
      ))}
    </svg>
  )
}
