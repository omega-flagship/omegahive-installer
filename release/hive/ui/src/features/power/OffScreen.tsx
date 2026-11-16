import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { resultWords, whoWords, type NameOf } from './api'
import { canPress, screenOf, type PowerView } from './machine'
import './power.css'
import { OmegaGlyph } from '../../brand/OmegaGlyph'

/** The experiences with their own Off; anything else (a future experience) falls back to Classic's. */
export const OFF_EMBODIMENTS = ['classic', 'still', 'canvas', 'cosmos', 'flux', 'construct'] as const
export type Embodiment = (typeof OFF_EMBODIMENTS)[number]
export const embodimentOf = (experience: string): Embodiment => ((OFF_EMBODIMENTS as readonly string[]).includes(experience) ? (experience as Embodiment) : 'classic')

/** How long the light-up plays before the report (the reduced version is an instant fade). */
export const LIGHT_UP_MS = 1600
export const LIGHT_UP_REDUCED_MS = 150

const v = (o: Record<string, string | number>) => o as CSSProperties

// decorative only: fixed shapes, never data (nothing about the hive is shown while it is off)
const CONVERGE = Array.from({ length: 14 }, (_, i) => {
  const a = (i / 14) * Math.PI * 2 + 0.3
  const r = 180 + ((i * 53) % 220)
  return v({ '--x': `${Math.cos(a) * r}px`, '--y': `${Math.sin(a) * r}px`, '--d': `${(i % 5) * 0.05}s` })
})
const CONSTELLATION = [
  [-210, -120], [-140, -170], [-60, -110], [40, -150], [130, -90], [220, -140], [260, 10],
  [180, 120], [90, 170], [-20, 130], [-120, 160], [-230, 60], [-280, -30], [10, -20],
].map(([x, y], i) => v({ '--x': `${x}px`, '--y': `${y}px`, '--d': `${0.35 + i * 0.07}s` }))
const CARDS = [
  [8, 14], [24, 10], [40, 18], [62, 12], [78, 20], [10, 52], [30, 48], [52, 56], [72, 50], [16, 78], [44, 80], [70, 76],
].map(([x, y], i) => v({ '--x': `${x}%`, '--y': `${y}%`, '--d': `${0.6 + Math.floor(i / 4) * 0.22 + (i % 4) * 0.04}s` }))
const ORBITS = [180, 300, 440, 600, 780].map((r, i) => v({ '--r': `${r}px`, '--d': `${0.3 + i * 0.16}s` }))
const RIPPLES = [0, 0.18, 0.36].map((d) => v({ '--d': `${d}s` }))
const STARS = (() => {
  let s = 7
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  return Array.from({ length: 160 }, () => `${Math.round((rnd() - 0.5) * 2400)}px ${Math.round((rnd() - 0.5) * 1600)}px 0 ${rnd() < 0.15 ? 1 : 0}px rgb(220 235 255 / ${(0.25 + rnd() * 0.6).toFixed(2)})`).join(',')
})()

interface Props {
  experience: string
  view: PowerView
  reduced: boolean
  nameOf: NameOf
  onPress: () => void
  onLit: () => void
  onDismiss: () => void
}

/**
 * Off, in each experience's own style: the same machine (machine.ts), six embodiments. While off nothing about the
 * hive is shown; an admin sees the bright Ω and, after acting, the honest result; anyone else sees it resting.
 */
export function OffScreen({ experience, view, reduced, nameOf, onPress, onLit, onDismiss }: Props) {
  const kind = embodimentOf(experience)
  const screen = screenOf(view)
  const press = canPress(view)
  const admin = view.admin === true
  const button = useRef<HTMLButtonElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  // keyboard: the button has focus whenever it can be pressed; otherwise the screen itself (never the page behind)
  // (again when the result card closes: its button had focus)
  const hasCard = !!(view.result || view.note)
  useEffect(() => {
    if (screen === 'off') (press ? button.current : region.current)?.focus({ preventScroll: true })
    if (screen === 'report') close.current?.focus({ preventScroll: true })
  }, [screen, press, hasCard])

  // the light-up plays once per lighting, then tells the machine (which waits for our own answer too)
  useEffect(() => {
    if (screen !== 'lighting') return
    const t = setTimeout(onLit, reduced ? LIGHT_UP_REDUCED_MS : LIGHT_UP_MS)
    return () => clearTimeout(t)
  }, [screen, reduced, onLit])

  // a clean report (no failure, no note) leaves on its own; anything that failed waits to be read
  const words = useMemo(() => (view.result ? resultWords(view.result, nameOf) : null), [view.result, nameOf])
  useEffect(() => {
    if (screen !== 'report' || view.note || (words && !words.ok)) return
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [screen, view.note, words, onDismiss])

  useEffect(() => {
    if (screen !== 'report') return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [screen, onDismiss])

  const off = screen === 'off'
  const lighting = screen === 'lighting'
  const by = admin ? whoWords(view.by) : null
  const status = lighting ? 'The hive is turning on.' : screen === 'report' ? (words?.headline ?? view.note ?? 'The hive is on.') : admin ? 'The hive is off.' : 'The hive is resting.'

  const card = (screen === 'report' || (off && admin && (view.result || view.note))) && (words || view.note) && (
    <div className="pw-card" role="status">
      {kind === 'construct' ? (
        <ConstructResult words={words} note={view.note} />
      ) : (
        <>
          {words && <h2>{words.headline}</h2>}
          {words?.detail.map((d) => <p key={d}>{d}</p>)}
          {view.note && <p>{view.note}</p>}
        </>
      )}
      <button ref={close} type="button" className="pw-close" onClick={onDismiss}>
        {kind === 'construct' ? '[ ok ]' : screen === 'report' ? 'Continue' : 'Close'}
      </button>
    </div>
  )

  const omega = (cls = '') =>
    admin ? (
      <button
        ref={button}
        type="button"
        className={`pw-button ${cls}`}
        aria-label="Turn the hive on"
        aria-disabled={!press}
        onClick={() => press && onPress()}
      >
        <span aria-hidden="true">{kind === 'construct' ? <><OmegaGlyph className="pw-glyph" /> BOOT</> : <OmegaGlyph className="pw-glyph" />}</span>
      </button>
    ) : (
      <span className={`pw-button pw-dim ${cls}`} aria-hidden="true">
        <OmegaGlyph className="pw-glyph" />
      </span>
    )

  const caption = lighting ? null : admin ? (
    <p className="pw-caption">
      The hive is off.
      {by && <><br />Turned off by {by}.</>}
    </p>
  ) : (
    <p className="pw-caption">The hive is resting.</p>
  )

  let body: ReactNode
  switch (kind) {
    case 'still':
      body = (
        <>
          <div className="pw-page">
            {omega()}
            {caption}
            {off && card}
          </div>
          {lighting && <div className="pw-typed" aria-hidden="true">The hive is waking.</div>}
        </>
      )
      break
    case 'canvas':
      body = (
        <>
          <div className="pw-board" aria-hidden="true">
            {lighting && CARDS.map((s, i) => <i key={i} style={s} />)}
          </div>
          <div className="pw-stage">
            <div className="pw-pin">
              {omega()}
              <span className="pw-needle" aria-hidden="true" />
            </div>
            {caption}
            {off && card}
          </div>
        </>
      )
      break
    case 'cosmos':
      body = (
        <>
          <span className="pw-stars" aria-hidden="true" style={{ boxShadow: STARS }} />
          {lighting && <span className="pw-burst" aria-hidden="true" />}
          {lighting && <div className="pw-orbits" aria-hidden="true">{ORBITS.map((s, i) => <i key={i} style={s} />)}</div>}
          <div className="pw-stage">
            {!lighting && omega()}
            {caption}
            {off && card}
          </div>
        </>
      )
      break
    case 'flux':
      body = (
        <>
          {lighting && <span className="pw-liquid" aria-hidden="true" />}
          {lighting && <div className="pw-ripples" aria-hidden="true">{RIPPLES.map((s, i) => <i key={i} style={s} />)}</div>}
          <div className="pw-stage">
            {!lighting && omega()}
            {caption}
            {off && card}
          </div>
        </>
      )
      break
    case 'construct':
      body = (
        <>
          <div className="pw-tty" aria-hidden="true">
            {lighting ? (
              <>
                <div>&gt; power on</div>
                <div style={v({ '--d': '0.3s' })}>&gt; reading the power snapshot…</div>
                <div style={v({ '--d': '0.7s' })}>&gt; waking minds, one at a time…</div>
                <div style={v({ '--d': '1.1s' })}>&gt; bringing the construct up<span className="pw-cursor" /></div>
              </>
            ) : (
              <div>
                OMEGAHIVE // POWER: OFF{by ? ` // BY ${by.toUpperCase()}` : ''}
                <br />
                {admin ? '> press BOOT to bring the hive up ' : '> the hive is resting. awaiting an admin '}
                <span className="pw-cursor" />
              </div>
            )}
          </div>
          <div className="pw-stage">
            {!lighting && admin && omega()}
            {off && card}
          </div>
        </>
      )
      break
    default:
      body = (
        <>
          {off && !reduced && <div className="pw-converge" aria-hidden="true">{CONVERGE.map((s, i) => <i key={i} style={s} />)}</div>}
          {lighting && <span className="pw-bloom" aria-hidden="true" />}
          {lighting && <div className="pw-constellation" aria-hidden="true">{CONSTELLATION.map((s, i) => <i key={i} style={s} />)}</div>}
          <div className="pw-stage">
            {!lighting && omega()}
            {caption}
            {off && card}
          </div>
        </>
      )
  }

  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={admin ? 'The hive is off' : 'The hive is resting'}
      data-power-screen={screen}
      data-power-embodiment={kind}
      className={`pw-off pw-${kind} pw-${screen}${reduced ? ' pw-reduced' : ''}`}
      style={{ outline: 'none' }}
    >
      <div className="pw-bg" aria-hidden="true" />
      {body}
      {screen === 'report' && card}
      <p className="pw-sr" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  )
}

/** Construct prints the result as boot lines: ok, skip, fail. */
function ConstructResult({ words, note }: { words: ReturnType<typeof resultWords> | null; note: string | null }) {
  return (
    <>
      {words && <h2>[ {words.ok ? ' ok ' : 'warn'} ] {words.headline}</h2>}
      {words?.detail.map((d) => <p key={d}>[{d.startsWith('Skipped') ? 'skip' : 'fail'}] {d}</p>)}
      {note && <p>[note] {note}</p>}
    </>
  )
}
