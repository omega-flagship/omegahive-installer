import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LiveOmega } from '../../brand/LiveOmega'
import { MarkStill } from '../../brand/LivingMark'
import { plural } from '../../lib/plural'
import { omegaGesture, sendPhase, typesIntoAsk, wakeIntoApps } from '../../shell/phase'
import { nativeWords } from '../../inventory/nativeWords'
import type { PhaseRendererProps } from '../registry'
import './phases.css'

/** Written beneath the retained paper question; the native input never leaves its box. */
function StillHome({ anchor, phase, ask, apps, presence, waiting, reduced }: PhaseRendererProps) {
  const words = useMemo(() => nativeWords(), [])
  const say = (intent: string) => words.say('still', intent) ?? ''
  const [spoken, setSpoken] = useState('')
  const prior = useRef(phase)
  useEffect(() => {
    if (phase !== 'rest' || waiting < 1) { setSpoken(''); return }
    const timer = window.setTimeout(() => setSpoken(`${plural(waiting, 'notice')} waiting.`), 1000)
    return () => window.clearTimeout(timer)
  }, [phase, waiting])
  useEffect(() => {
    // Only the native paper slot is scrolled; Ask focus/fill belongs to its port.
    if (anchor && phase === 'awake' && prior.current === 'pro') anchor.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
    prior.current = phase
  }, [anchor, phase, reduced])
  const gesture = useMemo(() => omegaGesture({ onTap: () => { if (ask.alive()) ask.focus() }, onSwipe: () => { if (ask.alive()) sendPhase('omega-swipe') } }), [ask])
  useEffect(() => {
    let escapeAt = 0
    const key = (event: KeyboardEvent) => {
      if (!ask.alive() || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') { escapeAt = performance.now(); return }
      if (phase === 'awake' && escapeAt && performance.now() - escapeAt < 1500 && event.key.toLowerCase() === 'p') {
        escapeAt = 0; event.preventDefault(); sendPhase('pro'); return
      }
      escapeAt = 0
      if (phase === 'rest' && typesIntoAsk(event, event.target) && ask.focus() && ask.type(event.key) !== 'none') event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [ask, phase])
  const counts = new Map<string, number>()
  for (const app of apps.shown) counts.set(app.name, (counts.get(app.name) ?? 0) + 1)
  return <>
    {anchor && createPortal(<section className="st-home" data-phase={phase} hidden={phase === 'pro'} aria-label="Omega and your apps">
      <button className="st-home-omega" data-ui-part={phase === 'rest' ? 'still rest ω' : 'still awake ω'} data-intent="shell.omega" aria-label={say('shell.omega')} {...gesture}>
        <LiveOmega look="still" size="hero" className="st-home-mark" fallback={<MarkStill look="still" />} pace={phase === 'awake' ? 'awake' : 'still'} presence={{ state: presence.presence, level: presence.level }} pulse={presence.pulse} hold={presence.hold} />
      </button>
      <button className="st-link st-serif st-home-rest-apps" data-ui-part="still rest apps" data-intent="shell.apps" hidden={phase !== 'rest'} onClick={() => { if (ask.alive()) wakeIntoApps() }}>{say('shell.apps')}</button>
      {phase === 'rest' && waiting > 0 && <p className="st-home-waiting" aria-hidden="true">{plural(waiting, 'notice')} waiting</p>}
      <p className="sr-only" role="status" aria-live="polite">{spoken}</p>
      <div hidden={phase !== 'awake'} inert={phase !== 'awake'}>
        <p className="st-kicker st-home-app-heading">{say('apps.open')}</p>
        <ul className="st-home-apps" data-ui-part="still awake apps">{apps.shown.map(app => <li key={app.id}><button className="st-link st-serif" data-intent="apps.open" onClick={() => { if (ask.alive()) app.open() }}>{app.name}{app.placement === 'swarm' && (counts.get(app.name) ?? 0) > 1 && <small> · {app.where}</small>}</button></li>)}</ul>
        {apps.more > 0 && <button className="st-link st-home-more" data-intent="apps.more" onClick={() => { if (ask.alive()) apps.openAll() }}>{say('apps.more')} · {apps.more}</button>}
        <div className="st-home-controls"><button className="st-link" data-ui-part="still awake pro" data-intent="shell.pro" onClick={() => { if (ask.alive()) sendPhase('pro') }}>{say('shell.pro')} ↑</button><button className="st-link" data-ui-part="still awake power" data-intent="shell.power" onClick={() => { if (ask.alive()) sendPhase('power') }}>{say('shell.power')}</button></div>
      </div>
    </section>, anchor)}
    <button className="st-home-back" data-ui-part="still pro back" data-intent="shell.back" hidden={phase !== 'pro'} onClick={() => { if (ask.alive()) sendPhase('back') }}>{say('shell.back')}</button>
  </>
}
export const rest = StillHome
