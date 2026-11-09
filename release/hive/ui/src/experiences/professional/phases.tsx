import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { plural } from '../../lib/plural'
import { LiveOmega } from '../../brand/LiveOmega'
import { MarkStill } from '../../brand/LivingMark'
import { omegaGesture, sendPhase, typesIntoAsk, wakeIntoApps } from '../../shell/phase'
import { nativeWords } from '../../inventory/nativeWords'
import type { PhaseRendererProps } from '../registry'
import { TOKENS } from './theme'
import './phases.css'

/** Professional's paper workspace around the host's existing native Ask card. */
export function ProfessionalHome({ phase, ask, apps, presence, reduced, waiting }: PhaseRendererProps) {
  const [spokenWaiting, setSpokenWaiting] = useState('')
  useEffect(() => {
    if (phase !== 'rest' || waiting < 1) { setSpokenWaiting(''); return }
    const timer = window.setTimeout(() => setSpokenWaiting(`${plural(waiting, 'notice')} waiting.`), 1000)
    return () => window.clearTimeout(timer)
  }, [phase, waiting])
  const home = useRef<HTMLElement>(null)
  const omega = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const space = useMemo(() => nativeWords(), [])
  const say = (intent: string) => space.say('professional', intent) ?? ''
  const counts = new Map<string, number>()
  for (const app of apps.shown) counts.set(app.name, (counts.get(app.name) ?? 0) + 1)
  const gesture = useMemo(() => omegaGesture({
    onTap: () => { if (ask.alive()) ask.focus() },
    onSwipe: () => { if (ask.alive()) sendPhase('omega-swipe') },
  }), [ask])
  useEffect(() => {
    let escapeAt = 0
    const key = (event: KeyboardEvent) => {
      if (!ask.alive() || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') { escapeAt = performance.now(); return }
      if (phase === 'awake' && escapeAt && performance.now() - escapeAt < 1500 && event.key.toLowerCase() === 'p') {
        escapeAt = 0
        event.preventDefault(); sendPhase('pro')
        return
      }
      escapeAt = 0
      if (phase === 'rest' && typesIntoAsk(event, event.target) && ask.focus() && ask.type(event.key) !== 'none') event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [phase, ask])
  useEffect(() => {
    const active = document.activeElement
    if (phase === 'pro' && home.current?.contains(active)) back.current?.focus({ preventScroll: true })
    else if ((phase !== 'pro' && back.current === active) || (phase === 'rest' && home.current?.contains(active))) omega.current?.focus({ preventScroll: true })
  }, [phase])
  return <>
    <section ref={home} className="prh" style={TOKENS as CSSProperties} data-phase={phase} data-reduced={reduced || undefined} hidden={phase === 'pro'} inert={phase === 'pro'} aria-label={say('shell.omega')}>
      <div className="prh-column">
        <header className="prh-heading">
          <button ref={omega} className="prh-omega" data-ui-part={phase === 'rest' ? 'professional rest ω' : 'professional awake ω'} data-intent="shell.omega" aria-label={say('shell.omega')} {...gesture}>
            <LiveOmega look="professional" size="hero" className="prh-mark" fallback={<MarkStill look="professional" />} pace={phase === 'awake' ? 'awake' : 'still'} presence={{ state: presence.presence, level: presence.level }} pulse={presence.pulse} hold={presence.hold} />
          </button>
          <p data-ui-part="professional rest question" className="prh-question" hidden={phase !== 'rest'}>{say('shell.question')}</p>
          <button className="prh-rest-apps" data-ui-part="professional rest apps" data-intent="shell.apps" hidden={phase !== 'rest'} onClick={() => { if (ask.alive()) wakeIntoApps() }}>{say('shell.apps')}</button>
          {phase === 'rest' && waiting > 0 && <p className="prh-waiting" aria-hidden="true">{plural(waiting, 'notice')} waiting</p>}
          <p className="sr-only" role="status" aria-live="polite">{spokenWaiting}</p>
          <h1 data-ui-part="professional awake name" hidden={phase !== 'awake'}>{say('shell.omega')}</h1>
        </header>
        <section className="prh-apps" data-ui-part="professional awake apps" hidden={phase !== 'awake'} inert={phase !== 'awake'} aria-label={say('apps.open')}>
          <h2>{say('apps.open')}</h2>
          <div className="prh-app-list">
            {apps.shown.map((app) => <button key={app.id} className="prh-app" style={{ borderInlineStartColor: app.identityColour }} data-intent="apps.open" onClick={() => { if (ask.alive()) app.open() }}>
              <span>{app.name}</span>{app.placement === 'swarm' && (counts.get(app.name) ?? 0) > 1 && <small>{app.where}</small>}<span aria-hidden className="prh-arrow">↗</span>
            </button>)}
          </div>
          {apps.more > 0 && <button className="prh-more" data-intent="apps.more" onClick={() => { if (ask.alive()) apps.openAll() }}>{say('apps.more')} · {apps.more}</button>}
        </section>
        <button className="prh-pro" data-ui-part="professional awake pro" data-intent="shell.pro" hidden={phase !== 'awake'} onClick={() => { if (ask.alive()) sendPhase('pro') }}>{say('shell.pro')} ↑</button>
      </div>
      <button className="prh-power" data-ui-part="professional awake power" data-intent="shell.power" hidden={phase !== 'awake'} onClick={() => { if (ask.alive()) sendPhase('power') }}>{say('shell.power')}</button>
    </section>
    <button ref={back} className="prh-back" style={TOKENS as CSSProperties} data-ui-part="professional pro back" data-intent="shell.back" hidden={phase !== 'pro'} onClick={() => { if (ask.alive()) sendPhase('back') }}>{say('shell.back')}</button>
  </>
}

export const rest = ProfessionalHome
