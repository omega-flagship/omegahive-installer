import { useEffect, useState, useSyncExternalStore } from 'react'
import { href, navigate } from '../../lib/router'
import { useLook } from '../../shell/uiVariant'
import { askAutoWake } from './autoWake'
import { restoreAskDraft } from './useAskField'
import { AnswererPicker } from './AnswererPicker'
import './autoWake.css'

/** A request's wake has its own slot, directly below the words that caused it. */
export function AutoWakeStatus({ op, words }: { op: string; words: string }) {
  const view = useSyncExternalStore(askAutoWake.subscribe, () => askAutoWake.view(op), () => null)
  const look = useLook()
  const experience = look.current?.experience ?? 'classic'
  const [picker, setPicker] = useState(false)
  const [clock, setClock] = useState({ since: 0, age: 0 })
  const age = clock.since === view?.since ? clock.age : 0
  useEffect(() => {
    if (view?.phase !== 'waking') return
    const update = () => setClock({ since: view.since, age: Date.now() - view.since })
    update()
    const short = setTimeout(update, 400)
    const long = setTimeout(update, 8000)
    return () => { clearTimeout(short); clearTimeout(long) }
  }, [view?.phase, view?.since])
  useEffect(() => {
    if (view?.phase === 'failed' || view?.phase === 'gated') askAutoWake.restoreDraft(op, () => restoreAskDraft(words, experience, async () => {
      if (view.gate === 'spending') { navigate(view.mindId ? { name: 'dot', id: view.mindId, tab: 'model' } : { name: 'usage' }); return }
      if (view.phase === 'gated' && view.gate === 'authority' && view.privateRequest) { setPicker(true); return }
      if (view.gate === 'authority' && view.own) return askAutoWake.useOwn(op)
      await askAutoWake.retry(op)
    }))
  }, [op, view?.phase, words, experience])
  if (!view || view.phase === 'inspecting' || view.phase === 'sending' || view.phase === 'stopped') return null
  const name = view.name
  if (view.phase === 'waking') {
    if (age < 400) return null
    const text = age >= 8000 ? `Still waking ${name}… your request will run when it’s awake.`
      : experience === 'cosmos' ? `Uplink · waking ${name}…`
      : experience === 'construct' ? `${name.toLowerCase()}@hive waking…` : `Waking ${name}…`
    if (experience === 'professional') return <div className="ask-wake-professional" role="status" aria-label={`Waking ${name}`}>
      <span className="ask-wake-avatar" aria-hidden="true">{name[0]?.toUpperCase()}</span>
      <span aria-hidden="true"><strong>{name}</strong><small>{age >= 8000 ? 'Still starting · your request is held' : 'Starting to answer you'}</small></span>
      <span className="ask-wake-badge" aria-hidden="true">Waking</span>
    </div>
    return <div className="ask-wake-step" data-wake-look={experience} role="status" aria-label={`Waking ${name}`}>
      <span className="ask-wake-signal" aria-hidden="true"><i /><i /><i /></span>
      <span aria-hidden="true">{text}</span>
    </div>
  }
  const spending = view.phase === 'gated' && view.gate === 'spending'
  const privateChoice = view.phase === 'gated' && view.gate === 'authority' && view.privateRequest
  const own = view.gate === 'authority' ? view.own : undefined
  const failed = view.phase === 'failed'
  const text = failed
    ? view.changed ? 'The answerer changed, so your request wasn’t sent. Your words are kept.'
      : `Couldn’t wake ${name}, so your request wasn’t sent. Your words are kept.`
    : spending ? `${name} has reached its spending limit, so it can’t wake for this. Your request wasn’t sent. Your words are kept.`
    : `You can’t wake ${name} with your current access. Your request wasn’t sent. Your words are kept.`
  return <div className="ask-wake-card" data-wake-look={experience} data-wake-state={view.phase} role="note">
    <span className="ask-wake-notation" aria-hidden="true">{experience === 'cosmos' ? failed ? 'UPLINK LOST' : 'TRANSMISSION HELD'
      : experience === 'construct' ? failed ? '[wake failed]' : '[request held]'
      : experience === 'omegatown' ? 'A note on the door' : experience === 'canvas' ? 'Not sent' : failed ? '!' : 'i'}</span>
    <span>{text}</span>
    {spending ? <a className="ask-wake-choice" href={href(view.mindId ? { name: 'dot', id: view.mindId, tab: 'model' } : { name: 'usage' })}>Open budget settings</a> : <button type="button" className="ask-wake-choice" disabled={!askAutoWake.canRetry(op)} aria-expanded={privateChoice ? picker : undefined} onClick={() => { if (privateChoice) setPicker((open) => !open); else void (own ? askAutoWake.useOwn(op) : askAutoWake.retry(op)) }}>
      {privateChoice ? 'Choose who answers' : own ? experience === 'cosmos' ? `Route to ${own.name.slice(0, 60)}` : experience === 'canvas' ? `Pin it to ${own.name.slice(0, 60)} instead` : experience === 'construct' ? `ask ${own.name.slice(0, 60).toLowerCase()} ⏎` : `Ask ${own.name.slice(0, 60)} instead` : experience === 'construct' ? 'retry ⏎' : experience === 'cosmos' ? 'Reconnect' : 'Try again'}
    </button>}
    {privateChoice && picker && <div className="ask-wake-picker"><AnswererPicker onDone={() => { setPicker(false); void askAutoWake.retry(op) }} /></div>}
    {view.failures >= 2 && <a className="ask-wake-health" href={href({ name: 'health' })}>See what’s wrong in Health</a>}
  </div>
}
