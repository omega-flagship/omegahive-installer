import { AnimatePresence } from 'framer-motion'
import { lazy, Suspense, useEffect } from 'react'
import { PresenceLazy } from '../ui/PresenceLazy'
import { useHive } from '../store/store'
import { useIntro, welcomeNeeded } from './introStore'

// The welcome and help sheet share one small chunk; the tour (script, player, speech) is its own lazy chunk.
const Welcome = lazy(() => import('./Intro').then((r) => ({ default: r.Welcome })))
const HelpSheet = lazy(() => import('./Intro').then((r) => ({ default: r.HelpSheet })))
const TourPlayer = lazy(() => import('./TourPlayer'))

let checked = false

/** Eager and tiny: shows the welcome on a first visit, and mounts the help sheet or tour when asked. */
export function IntroLayer() {
  const ready = useHive((s) => s.ready)
  const welcome = useIntro((s) => s.welcome)
  const help = useIntro((s) => s.help)
  const tour = useIntro((s) => s.tour)

  useEffect(() => {
    if (!ready || checked) return
    checked = true
    if (welcomeNeeded()) useIntro.getState().showWelcome()
  }, [ready])

  if (!ready) return null
  return (
    <>
      <AnimatePresence>
        {welcome && (
          // a welcome closed before its chunk revealed it must not hang this AnimatePresence (PresenceLazy, Surface M audit)
          <PresenceLazy key="welcome">
            <Welcome />
          </PresenceLazy>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {help && !tour && (
          <PresenceLazy key="help">
            <HelpSheet />
          </PresenceLazy>
        )}
      </AnimatePresence>
      {tour && (
        <Suspense fallback={null}>
          <TourPlayer key={tour.key} request={tour} />
        </Suspense>
      )}
    </>
  )
}
