import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { LiveOmega } from '../../brand/LiveOmega'
import { MarkStill } from '../../brand/LivingMark'
import { omegaGesture, sendPhase, typesIntoAsk, wakeIntoApps } from '../../shell/phase'
import { nativeWords } from '../../inventory/nativeWords'
import type { PhaseRendererProps } from '../registry'
import { useAskStore } from '../../store/ask'
import { shown } from '../../lib/displayName'
import './phases.css'

function ConstructHome({ anchor, phase, ask, apps, presence, waiting }: PhaseRendererProps) {
  const space = useMemo(nativeWords, [])
  const say = (intent: string) => space.say('construct', intent) ?? ''
  const personal = useAskStore(s => s.personal)
  const personalName = shown(personal?.name ?? '').trim()
  const name = personalName && !/^omega$/i.test(personalName) ? personalName : 'Omega'
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    if (phase !== 'rest' || waiting < 1) { setSpoken(''); return }
    const timer = setTimeout(() => setSpoken(`${waiting} notices waiting`), 1000)
    return () => clearTimeout(timer)
  }, [phase, waiting])
  useEffect(() => {
    let escapeAt = 0
    const key = (e: KeyboardEvent) => {
      if (!ask.alive() || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') { escapeAt = performance.now(); return }
      if (phase === 'awake' && escapeAt && performance.now() - escapeAt < 1500 && e.key.toLowerCase() === 'p') { escapeAt = 0; e.preventDefault(); sendPhase('pro'); return }
      escapeAt = 0
      if (phase === 'rest' && typesIntoAsk(e, e.target) && ask.focus() && ask.type(e.key) !== 'none') e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [phase, ask])
  const gesture = useMemo(() => omegaGesture({ onTap: () => { if (ask.alive()) ask.focus() }, onSwipe: () => { if (ask.alive()) sendPhase('omega-swipe') } }), [ask])
  const counts = new Map<string, number>()
  for (const app of apps.shown) counts.set(app.name, (counts.get(app.name) ?? 0) + 1)
  return <>
    {anchor && createPortal(<section className="cx-home" data-phase={phase} hidden={phase === 'pro'} aria-label="Omega and your apps">
      <div className="cx-home-core">
        <button className="cx-home-omega" data-ui-part={`construct ${phase === 'rest' ? 'rest' : 'awake'} ω`} aria-label={phase === 'awake' ? name : say('shell.omega')} {...gesture}>
          <LiveOmega look="construct" size="hero" className="cx-home-mark" fallback={<MarkStill look="construct" />} pace={phase === 'awake' ? 'awake' : 'still'} presence={{ state: presence.presence, level: presence.level }} pulse={presence.pulse} hold={presence.hold} />
        </button>
        <p data-ui-part="construct rest question" className="cx-home-question" hidden={phase !== 'rest'}>{say('shell.question')}</p>
        <button className="cx-home-rest-apps" data-ui-part="construct rest apps" data-intent="shell.apps" hidden={phase !== 'rest'} onClick={() => { if (ask.alive()) wakeIntoApps() }}><span aria-hidden="true">$ </span>{say('shell.apps')}</button>
        {phase === 'rest' && waiting > 0 && <p className="cx-home-waiting" aria-hidden="true">{waiting} waiting</p>}
        <p className="sr-only" role="status" aria-live="polite">{spoken}</p>
        <div className="cx-home-awake" hidden={phase !== 'awake'} inert={phase !== 'awake'}>
          <h1 data-ui-part="construct awake name">{name}</h1>
          <p className="cx-c-dim">{say('apps.open')}</p>
          <ul data-ui-part="construct awake apps" className="cx-home-apps">{apps.shown.map(app => <li key={app.id}><button data-intent="apps.open" onClick={() => { if (ask.alive()) app.open() }}><span aria-hidden="true">Ω · </span>{app.name}{app.placement === 'swarm' && (counts.get(app.name) ?? 0) > 1 && <small> · {app.where}</small>}</button></li>)}</ul>
          {apps.more > 0 && <button className="cx-home-more" onClick={() => { if (ask.alive()) apps.openAll() }}>{say('apps.more')} · {apps.more}</button>}
          <div className="cx-home-controls"><button data-ui-part="construct awake pro" onClick={() => { if (ask.alive()) sendPhase('pro') }}>{say('shell.pro')} ↑</button><button data-ui-part="construct awake power" onClick={() => { if (ask.alive()) sendPhase('power') }}>{say('shell.power')}</button></div>
        </div>
      </div>
    </section>, anchor)}
    <button data-ui-part="construct pro back" className="cx-home-back" hidden={phase !== 'pro'} onClick={() => { if (ask.alive()) sendPhase('back') }}>{say('shell.back')}</button>
  </>
}
export const rest = ConstructHome
