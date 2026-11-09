import { useMemo, useState } from 'react'
import { shown } from '../../lib/displayName'
import { navigate } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useLook } from '../../shell/uiVariant'
import { experienceById } from '../../experiences/registry'
import { Page } from '../../ui/Page'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { HivePlacement } from '../minds/MoveMind'
import { AskAudit } from './AskAudit'
import { RegisteredServices } from './RegisteredServices'
import { GoogleConnectorAdminSettings } from './GoogleConnectorSettings'
import { linkRoute, settingsScreen } from './data'

/** Parts this page still draws itself; settings.metta places each one. */
const ISLANDS = {
  'hive-placement': <HivePlacement />,
  'google-connector': <GoogleConnectorAdminSettings />,
  'registered-services': <RegisteredServices />,
  'ask-audit': <AskAudit />,
}

/**
 * #/settings: one place for how this hive is set up. The screen is atoms (settings.metta) that MeTTa composes for the
 * look being worn; this page loads the settings, states the facts, and carries out a press. The one change made here
 * is rotating the operator password, which the admin asks for, confirms, and sees once.
 *
 * Islands: where this hive runs (HivePlacement), the Google connector, registered services and the Ask audit stay as
 * their own components, which settings.metta places with island parts. Each loads its own data and holds a form or a
 * paged list with its own state (a move with a target picker, a client-secret form with an OAuth return, service runs,
 * a filtered audit trail), which the blocks don't express; each already decides for itself whether this hive offers it.
 */
export default function SettingsPage() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const res = useResource(() => need(client, 'settings', 'Settings')(), {})
  const { status, data: settings, error } = res
  const [confirming, setConfirming] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)

  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const names = {
      app: (id: string) => shown(programs?.find((p) => p.id === id)?.name ?? id),
      swarm: (id: string) => shown(swarms[id]?.name) || id,
    }
    const { data, facts } = settingsScreen({ status, data: settings, error, refreshing: false }, names, { confirming, fresh })
    return { plan: compose('settings', facts), data }
  }, [status, settings, error, programs, swarms, confirming, fresh, compose])

  const rotate = async () => {
    try {
      const r = await client!.rotatePassword!()
      setFresh(r.password)
      setConfirming(false)
    } catch (e) {
      toast({ tone: 'error', title: 'Password not changed', body: e instanceof Error ? e.message : String(e) })
    }
  }

  const host: ScreenHost = {
    data,
    framed: true,
    islands: ISLANDS,
    onOpen: (target, item) => {
      const route = target === 'link' ? linkRoute(String(item.id)) : undefined
      if (route) navigate(route)
    },
    onAction: (action) => {
      if (action === 'retry') res.reload()
      else if (action === 'ask-rotate') setConfirming(true)
      else if (action === 'cancel-rotate') setConfirming(false)
      else if (action === 'rotate') void rotate()
      else if (action === 'hide-password') setFresh(null)
      else if (action === 'copy-password' && fresh) void navigator.clipboard?.writeText(fresh).then(() => toast({ tone: 'success', title: 'Copied' }))
    },
  }

  return (
    <Page title="Settings" eyebrow="This hive" label="Settings">
      <div className="mx-auto max-w-3xl space-y-4 px-3 pb-8 md:px-6">
        <Screen plan={plan} host={host} />
      </div>
    </Page>
  )
}
