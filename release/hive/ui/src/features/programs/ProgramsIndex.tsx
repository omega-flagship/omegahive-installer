import { AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { shown } from '../../lib/displayName'
import { navigate } from '../../lib/router'
import { has } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { appLookIn, DESIGNED_APPS } from '../../shell/appLook'
import { useLook } from '../../shell/uiVariant'
import type { Program } from '../../api/types'
import { useHive } from '../../store/store'
import { Button } from '../../ui/primitives'
import { Page } from '../../ui/Page'
import { ActivityList, AppAccess } from './AppActivity'
import { pressed, programsScreen, type IdentityOf } from './data'

/**
 * #/programs: every app this hive found, with its state and an operator switch.
 *
 * The page and each app's card are atoms (programs.metta) that MeTTa composes for the look being worn; this page loads
 * the apps, states the facts, and carries out a press (turning an app on or off, opening it, where it runs). Islands:
 * what apps did lately (app-activity), a list that loads and refreshes itself under the heading the menu jumps to
 * (#app-activity-h); and where one app runs (app-access), a dialog with its own tabs and decisions, bound to the app
 * it was opened from. MeTTa decides whether each exists here.
 */
export default function ProgramsIndex() {
  const client = useHive((s) => s.client)
  const programs = useHive((s) => s.programs)
  const err = useHive((s) => s.programsError)
  const load = useHive((s) => s.loadPrograms)
  const reload = useHive((s) => s.reloadPrograms)
  const setEnabled = useHive((s) => s.setProgramEnabled)
  const lookState = useLook()
  const prefs = lookState.current
  const look = experienceById(prefs?.experience).id
  const designed = prefs?.apps === 'designed'
  const [access, setAccess] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  const canActivity = has(client, 'programActivity')
  const canAccess = has(client, 'programActivations') || canActivity
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const identityOf: IdentityOf = (p) => (designed ? DESIGNED_APPS[p.id]?.title ?? null : null)
    // each card wears its app's identity in the current look (colour variables, type, motif)
    const lookOf = (p: Program) => appLookIn(p, lookState)
    const { data, facts } = programsScreen(programs, err, { activity: canActivity, access: canAccess }, identityOf, compose, lookOf)
    return { plan: compose('programs', facts), data }
  }, [programs, err, canActivity, canAccess, designed, compose, lookState])

  const onAction = (action: string, item: ScreenItem, value?: boolean) => {
    const press = pressed(action, item, value)
    if (press?.kind === 'retry') return void load().catch(() => undefined)
    const p = press && programs?.find((x) => x.id === press.id)
    if (!press || !p) return
    if (press.kind === 'switch') void setEnabled(p.id, press.on)
    else if (press.kind === 'open' && p.enabled) navigate({ name: 'program', id: p.id })
    else if (press.kind === 'access') setAccess({ id: p.id, name: shown(p.name) })
  }

  const islands = {
    'app-activity': (
      <section aria-labelledby="app-activity-h" className="mt-3">
        <h2 id="app-activity-h" className="eyebrow mb-2 px-1">
          What apps did lately
        </h2>
        <ActivityList limit={20} compact />
      </section>
    ),
    'app-access': <AnimatePresence>{access && <AppAccess programId={access.id} name={access.name} onClose={() => setAccess(null)} />}</AnimatePresence>,
  }

  return (
    <Page
      label="Programs"
      eyebrow="In this hive"
      title="Apps"
      onClose={() => navigate({ name: 'hive' })}
      info="programs"
      actions={
        <Button variant="subtle" icon="reset" onClick={() => void reload()} className="mr-1" title="Re-read app code from disk">
          <span className="hidden sm:inline">Reload</span>
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-[1100px] px-3 pb-[calc(var(--sab)+24px)] md:px-6 md:pb-10">
        <Screen plan={plan} host={{ data, framed: true, islands, onAction }} />
      </div>
    </Page>
  )
}
