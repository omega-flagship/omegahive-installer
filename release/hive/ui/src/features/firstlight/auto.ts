import { useEffect } from 'react'
import { dwellMs } from '../guided/machine'
import { DEMO_PEOPLE } from './demo'
import { fillLine } from './honest'
import { startApp } from './host'
import { nextIndex, waitsForPerson } from './journey'
import { autoHeld, factsOf, stepOf, useFirstLight, type Run } from './store'

/**
 * Auto-advance a step that does not wait for the person, after the time to read it. In demo mode only, the invented
 * newcomer's own presses are played for them (a role, a look, a key, a limit, Next past the apps, their Ask, Wake), on
 * the demo host. A live journey
 * never presses anything by itself.
 *
 * followups-r8: held (no timer at all) while a guest is asking their host for more (store autoHeld); once that ends
 * the step gets its full time to read again before it moves on.
 */
export function useAuto(run: Run | null) {
  const step = stepOf(run)
  const token = run?.token
  const playing = run?.status === 'playing'
  const greeted = !!run?.facts.greeted
  const mode = run?.mode
  const held = autoHeld(run)
  useEffect(() => {
    if (!run || !step || !playing || run.loadError || held) return
    const g = useFirstLight.getState()
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms))
    const text = fillLine(step.say, { name: run.facts.name, host: run.facts.host, limit: run.facts.limit, look: run.facts.lookName, monthly: run.facts.limit?.chosen_usd ?? null, mind: run.facts.mind?.name ?? null, app: startApp(run.facts.apps)?.name ?? null })
    if (!waitsForPerson(step) || (step.wait?.for === 'first-answer' && greeted)) {
      const ms = Math.max(step.wait?.for === 'time' ? step.wait.ms : 0, dwellMs(text))
      // the last line of the journey (the last step that applies now) stays until the person closes it
      later(ms, () => {
        const r = useFirstLight.getState().run
        if (r && r.token === token && nextIndex(r.steps, r.i, factsOf(r)) >= 0 && !autoHeld(r)) g.next()
      })
    } else if (mode === 'demo' && run.persona) {
      const who = DEMO_PEOPLE[run.persona]
      const w = step.wait
      if (w?.for === 'choice') later(1800, () => void g.choose(w.field === 'role' ? who.role : who.monthly ?? 5))
      else if (w?.for === 'look') later(2600, () => g.demoKeepLook())
      else if (w?.for === 'key') later(2000, () => void g.demoAddKey())
      else if (w?.for === 'wake') later(2200, () => void g.wake())
      else if (w?.for === 'apps') later(2600, () => g.appsNext())
      else if (w?.for === 'ask') later(3000, () => void g.demoSaveAsk())
    }
    return () => timers.forEach(clearTimeout)
    // the step's token is its identity: a new step (or a pause) clears what the last one scheduled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, playing, greeted, mode, held])
}

