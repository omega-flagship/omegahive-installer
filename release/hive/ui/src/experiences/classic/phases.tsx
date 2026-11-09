import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { plural } from '../../lib/plural'
import { LiveOmega } from '../../brand/LiveOmega'
import { MarkStill } from '../../brand/LivingMark'
import { OmegaGlyph } from '../../brand/OmegaGlyph'
import { Icon } from '../../ui/Icon'
import { iconOr } from '../../ui/iconPaths'
import { omegaGesture, sendPhase, typesIntoAsk } from '../../shell/phase'
import { partsSpace } from '../parts/space'
import type { PhaseRendererProps } from '../registry'
import './phases.css'

/** One glass Omega, kept through rest, awake and Pro. The shell's bottom Ask never moves. */
export function ClassicHome({ phase, reduced, ask, apps, presence, waiting }: PhaseRendererProps) {
  const [spokenWaiting, setSpokenWaiting] = useState('')
  useEffect(() => {
    if (phase !== 'rest' || waiting < 1) { setSpokenWaiting(''); return }
    const timer = window.setTimeout(() => setSpokenWaiting(`${plural(waiting, 'notice')} waiting.`), 1000)
    return () => window.clearTimeout(timer)
  }, [phase, waiting])
  const omega = useRef<HTMLButtonElement>(null)
  const home = useRef<HTMLElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const words = useMemo(() => partsSpace(), [])
  const counts = new Map<string, number>()
  for (const app of apps.shown) counts.set(app.name, (counts.get(app.name) ?? 0) + 1)
  const say = (intent: string) => words.say('classic', intent) ?? ''
  const gesture = useMemo(() => omegaGesture({
    onTap: () => { if (ask.alive()) ask.focus() },
    onSwipe: () => { if (ask.alive()) sendPhase('omega-swipe') },
  }), [ask])
  useEffect(() => {
    let escapeAt = 0
    const key = (event: KeyboardEvent) => {
      if (!ask.alive() || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        escapeAt = performance.now()
        return
      }
      if (phase === 'awake' && escapeAt && performance.now() - escapeAt < 1500 && event.key.toLowerCase() === 'p') {
        escapeAt = 0
        event.preventDefault(); sendPhase('pro')
        return
      }
      escapeAt = 0
      if (phase === 'rest' && typesIntoAsk(event, event.target) && ask.focus()) {
        if (ask.type(event.key) !== 'none') event.preventDefault()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [phase, ask])
  useEffect(() => {
    // Transfer only focus owned by this view; an Ask draft and caret stay where the person left them.
    const active = document.activeElement
    if (phase === 'pro' && home.current?.contains(active)) back.current?.focus({ preventScroll: true })
    else if ((phase !== 'pro' && back.current === active) || (phase === 'rest' && home.current?.contains(active))) omega.current?.focus({ preventScroll: true })
  }, [phase])
  return <>
    <section ref={home} className="classic-home" data-phase={phase} data-reduced={reduced || undefined} aria-label={say('shell.omega')} hidden={phase === 'pro'} inert={phase === 'pro'}>
      <div className="classic-home-core">
        <button ref={omega} className="classic-home-omega" data-ui-part={phase === 'rest' ? 'classic rest ω' : 'classic awake ω'} data-intent="shell.omega" aria-label={say('shell.omega')} {...gesture}>
          <LiveOmega look="classic" size="hero" className="classic-home-mark" fallback={<MarkStill look="classic" />} pace={phase === 'awake' ? 'awake' : 'still'} presence={{ state: presence.presence, level: presence.level }} pulse={presence.pulse} hold={presence.hold} />
        </button>
        <p className="classic-home-question" data-ui-part="classic rest question" hidden={phase !== 'rest'}>{say('shell.question')}</p>
        {phase === 'rest' && waiting > 0 && <p className="classic-home-waiting" aria-hidden="true">{plural(waiting, 'notice')} waiting</p>}
        <p className="sr-only" role="status" aria-live="polite">{spokenWaiting}</p>
        <h1 data-ui-part="classic awake name" hidden={phase !== 'awake'}>{say('shell.omega')}</h1>
        <div className="classic-home-awake" hidden={phase !== 'awake'} inert={phase !== 'awake'}>
          <div className="classic-home-apps" data-ui-part="classic awake apps" aria-label={say('apps.open')}>
            {apps.shown.map((app) => {
              const scope = app.placement === 'swarm' && (counts.get(app.name) ?? 0) > 1
              return <button key={app.id} className="classic-home-app" data-intent="apps.open" aria-label={scope ? `${app.name} · ${app.where}` : app.name} onClick={() => { if (ask.alive()) app.open() }}>
              <span className="classic-home-tile" style={{ color: app.identityColour }} aria-hidden>{app.identityIcon ? <img src={app.identityIcon} alt="" draggable={false} /> : <Icon name={iconOr(app.icon ?? undefined, 'spark')} size={30} />}<span className="classic-home-app-badge"><OmegaGlyph /></span></span>
              <span className="classic-home-app-name">{app.name.split(/(?=[A-Z][a-z])/).map((word, i) => <Fragment key={i}>{i > 0 && <wbr />}{word}</Fragment>)}</span>{scope && <small>{app.where}</small>}
            </button>})}
          </div>
          {apps.more > 0 && <button className="classic-home-more" data-intent="apps.more" onClick={() => { if (ask.alive()) apps.openAll() }}>{say('apps.more')} · {apps.more}</button>}
          <button className="classic-home-pro" data-ui-part="classic awake pro" data-intent="shell.pro" onClick={() => { if (ask.alive()) sendPhase('pro') }}>{say('shell.pro')} ↑</button>
        </div>
      </div>
      <button className="classic-home-power" data-ui-part="classic awake power" data-intent="shell.power" hidden={phase !== 'awake'} onClick={() => { if (ask.alive()) sendPhase('power') }}>{say('shell.power')}</button>
    </section>
    <button ref={back} className="classic-home-back" data-ui-part="classic pro back" data-intent="shell.back" hidden={phase !== 'pro'} onClick={() => { if (ask.alive()) sendPhase('back') }}>{say('shell.back')}</button>
  </>
}

// One renderer deliberately owns both phases, preserving one LiveOmega instance through every transition.
export const rest = ClassicHome
