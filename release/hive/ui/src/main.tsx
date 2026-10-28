import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createClient } from './api/client'
import { useHive } from './store/store'
import { useIntro, welcomeNeeded } from './tour/introStore'
import { installPower, type PowerHooks } from './features/power/store'
import { shown } from './lib/displayName'
import { askMemory } from './lib/askMemory'
import { bindEpoch, onIdentityChange } from './lib/identityEpoch'
import { installChunkRecovery } from './lib/chunkReload'
import { installEditTracking, unsavedWork } from './shell/unsavedWork'

// a tab left open across a deploy asks for chunks the new release no longer has: reload toward the new build once
// (only with nothing unsaved), else say so; a failed load that is not a deploy offers Retry (no reload, no loop)
installEditTracking()
installChunkRecovery({ unsaved: unsavedWork })

// the Ask's own memory follows the identity epoch: nothing of one person's outlives a change of person
askMemory.connectIdentity({ bind: bindEpoch, onIdentityChange })

// The static demo opens on the Lab: it exists to review the recorded tests and benchmarks. On a first
// visit the welcome comes first, over the living hive; the Lab follows once it is answered.
if (import.meta.env.MODE === 'demo' && !window.location.hash) {
  if (welcomeNeeded()) useIntro.setState({ afterWelcome: '#/lab' })
  else history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/lab`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/** Toasts raised while the hive was off are its own refusals of gated reads: they go when it comes back. */
let offMark: number | null = null
const powerHooks: PowerHooks = {
  wentOff: () => {
    offMark = Math.max(0, ...useHive.getState().toasts.map((t) => t.id))
  },
  woken: () => {
    const mark = offMark
    offMark = null
    if (mark !== null) useHive.setState((s) => ({ toasts: s.toasts.filter((t) => t.id <= mark) }))
    void useHive.getState().hydrate()
  },
  notify: (n) => useHive.getState().toast({ ...n, ttl: n.tone === 'error' ? 20_000 : 8000 }),
  nameOf: (id) => {
    const a = useHive.getState().agents[id]
    return a ? shown(a.name) : undefined
  },
}

createClient()
  .then((raw) => {
    // the simulator is reachable from the console (and the screenshot script) to play "someone else"
    if (raw.mode === 'sim') window.__hiveSim = raw
    // hive power: while off, only power, sign-in and the events socket reach the hive (features/power/gate.ts)
    return useHive.getState().init(installPower(raw, powerHooks))
  })
  .catch((err: unknown) => useHive.setState({ bootError: err instanceof Error ? err.message : String(err) }))
