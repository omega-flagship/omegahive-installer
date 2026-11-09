import { AnimatePresence } from 'framer-motion'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { PresenceLazy } from '../ui/PresenceLazy'
import { useHive } from '../store/store'
import { useIntro, welcomeNeeded } from './introStore'
import { isDemoClient } from '../features/showreel/hook'
import { useFlDoor } from '../features/firstlight/door'
import { identityKey } from '../lib/identityEpoch'
import { enterFirstRun, mayResumeFirstRun } from './firstRun'

// The welcome and help sheet share one small chunk; the tour (script, player, speech) is its own lazy chunk.
const Welcome = lazy(() => import('./Intro').then((r) => ({ default: r.Welcome })))
const HelpSheet = lazy(() => import('./Intro').then((r) => ({ default: r.HelpSheet })))
const TourPlayer = lazy(() => import('./TourPlayer'))

/** Live sign-in resumes the host's First Light; the browser welcome is demo-only. Menu help/tour remain explicit. */
export function IntroLayer() {
  const ready = useHive((s) => s.ready)
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  const checked = useRef<string | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [retry, setRetry] = useState(0)
  const demo = isDemoClient(client)
  const welcome = useIntro((s) => s.welcome)
  const help = useIntro((s) => s.help)
  const tour = useIntro((s) => s.tour)
  const firstLight = useFlDoor((s) => !!s.asked)

  useEffect(() => {
    if (!ready || !client) return
    const key = identityKey()
    if (checked.current === key) return
    setUnknown(false)
    if (demo) {
      checked.current = key
      if (welcomeNeeded()) useIntro.getState().showWelcome()
      return
    }
    useIntro.setState({ welcome: false })
    let alive = true
    let navigationChanged = false
    const route = window.location.hash
    const moved = () => { navigationChanged = true }
    window.addEventListener('hashchange', moved)
    void enterFirstRun(client, () => {
      if (mayResumeFirstRun(route, window.location.hash, navigationChanged, !!useFlDoor.getState().asked, !!useIntro.getState().tour)) window.location.hash = '#/first-light/resume'
    }, () => alive).then((result) => {
      if (alive && identityKey() === key && result !== 'stopped') { checked.current = key; setUnknown(result === 'unknown') }
    })
    return () => { alive = false; window.removeEventListener('hashchange', moved) }
  }, [ready, client, session, inits, demo, retry])

  if (!ready) return null
  return (
    <>
      {unknown && !demo && <div role="status" className="fixed left-3 right-3 top-3 z-[58] rounded-xl border border-line bg-surface p-3 text-sm">
        First Light progress could not be read. Your saved setup was not changed.
        <button type="button" onClick={() => { checked.current = null; setRetry((n) => n + 1) }}>Read again</button>
        <button type="button" onClick={() => { setUnknown(false); window.location.hash = '#/first-light/resume' }}>Open First Light</button>
      </div>}
      <AnimatePresence>
        {welcome && demo && (
          // a welcome closed before its chunk revealed it must not hang this AnimatePresence (PresenceLazy, Surface M audit)
          <PresenceLazy key="welcome">
            <Welcome />
          </PresenceLazy>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {help && !tour && !firstLight && (
          <PresenceLazy key="help">
            <HelpSheet />
          </PresenceLazy>
        )}
      </AnimatePresence>
      {tour && !firstLight && (
        <Suspense fallback={null}>
          <TourPlayer key={tour.key} request={tour} />
        </Suspense>
      )}
    </>
  )
}
