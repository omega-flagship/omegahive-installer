import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '../../lib/hooks'
import { isPageRoute, useRoute } from '../../lib/router'
import { shown } from '../../lib/displayName'
import { useScene } from '../../scene/sceneStore'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { screenOf } from './machine'
import { OffScreen } from './OffScreen'
import { PowerDialogs } from './PowerDialogs'
import { RestHost } from './RestScreen'
import { restAllowed } from './rest'
import { usePower } from './store'
import { restHolds, usePhase } from '../../shell/phase'

const nameOf = (id: string): string | undefined => {
  const a = useHive.getState().agents[id]
  return a ? shown(a.name) : undefined
}

/**
 * Hive power on the page: ONE mount (App), over every route, app and experience. Off sits above everything except a
 * dialog an admin opened; the page behind it is inert and shows nothing. Quiet rests when the person is idle.
 */
/**
 * The shell's phases (CANDIDATE): idle rests the experience's own rest, and the same urgent events (rest.ts isUrgent: a
 * pending decision or a budget refusal) wake that rest as they wake this page's own: only a rest the idle time really began (the shell's `restBy`, set on the move itself and
 * cleared by every other move, opt-out and identity change), never the opening rest or one the person chose.
 */
const NATIVE_REST = {
  rest: () => void usePhase.getState().send('idle'),
  wake: () => void usePhase.getState().wakeUrgent(),
  resting: () => {
    const s = usePhase.getState()
    return s.phased && s.phase === 'rest' && s.restBy === 'idle'
  },
}

export function PowerHost({ experience, signedIn, ready }: { experience: string; signedIn: boolean; ready: boolean }) {
  const view = usePower()
  const screen = screenOf(view)
  const look = useLook()
  const reduced = useReducedMotion() || look.motion === 'none'
  const route = useRoute()
  const [resting, setResting] = useState(false)
  // CANDIDATE (one-experience r1): an opted-in experience draws its own rest; the idle owner hands its rest to it
  const phased = usePhase((s) => s.phased)
  const phaseRest = usePhase((s) => restHolds(s))
  const shownOff = signedIn && screen !== 'none'
  const dark = shownOff && (screen === 'off' || screen === 'lighting')

  useEffect(() => {
    const b = document.body
    const root = document.getElementById('root')
    if (dark) {
      b.dataset.hivePower = 'off'
      if (view.admin) b.dataset.hiveAdmin = ''
      else delete b.dataset.hiveAdmin
    } else {
      delete b.dataset.hivePower
      delete b.dataset.hiveAdmin
    }
    if (root) root.inert = dark
    // a dialog that closes after the hive went off restores the page's inert state as IT found it: keep it inert
    const keep = dark && root ? new MutationObserver(() => !root.inert && (root.inert = true)) : null
    if (keep && root) keep.observe(root, { attributes: true, attributeFilter: ['inert'] })
    return () => {
      keep?.disconnect()
      delete b.dataset.hivePower
      delete b.dataset.hiveAdmin
      if (root) root.inert = false
    }
  }, [dark, view.admin])

  // the classic scene stops drawing behind the dark, and dims and settles while resting (App dims it for pages)
  useEffect(() => {
    const want = dark || (resting && experience === 'classic') || isPageRoute(route.name)
    const t = setTimeout(() => useScene.getState().setDimmed(want), 0)
    return () => clearTimeout(t)
  }, [dark, resting, experience, route.name])

  const onPress = useCallback(() => void usePower.getState().press(), [])
  const onLit = useCallback(() => usePower.getState().dispatch({ type: 'lit' }), [])
  const onDismiss = useCallback(() => usePower.getState().dispatch({ type: 'dismiss' }), [])

  return (
    <>
      {shownOff && createPortal(<OffScreen experience={experience} view={view} reduced={reduced} nameOf={nameOf} onPress={onPress} onLit={onLit} onDismiss={onDismiss} />, document.body)}
      {signedIn && <PowerDialogs />}
      {signedIn && <RestHost experience={experience} allowed={restAllowed(ready, screen)} reduced={reduced} onResting={setResting} admin={view.admin === true} native={phased ? NATIVE_REST : undefined} phaseRest={phaseRest} />}
    </>
  )
}
