// Purpose: read and acknowledge the person's task stops through the shared conversation screen.
import { useEffect, useState } from 'react'
import { Emitter } from '../../api/client'
import { experienceById } from '../../experiences/registry'
import { errorMessage, need, useAuthContext, useResource } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { hiveBus, useHive } from '../../store/store'
import { stoppedScreen } from './stopped'

// a stop is read again each minute, as main's held-calls list polls (heldCalls.ts), a module this build doesn't carry
const HELD_POLL_MS = 60_000

const changed = new Emitter<void>()

export function StoppedTasks({ mind }: { mind?: string }) {
  const client = useHive((s) => s.client)
  const identity = useAuthContext(client)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const read = useResource(() => need(client, 'listTaskStops')().then((r) => r.stops), { poll: HELD_POLL_MS })
  const { reload } = read
  const [action, setAction] = useState<{ client: typeof client; identity: typeof identity; busy: string | null; error: string } | null>(null)
  useEffect(() => changed.on(reload), [reload])
  useEffect(() => hiveBus.on((event) => { if (event.type === 'goal.updated') reload() }), [reload])
  const current = action?.client === client && action?.identity === identity ? action : null
  const stops = (read.data ?? []).filter((stop) => !mind || stop.mind_id === mind)
  const { data, facts } = stoppedScreen(stops, compose, current?.busy, current?.error || (read.error && read.status !== 'unsupported' ? errorMessage(read.error) : ''))
  const acknowledge = async (item: ScreenItem) => {
    if (client?.authContext && client.authContext() !== identity) return
    const id = String(Array.isArray(item.scope) ? item.scope[0] : '')
    if (!id || current?.busy) return
    setAction({ client, identity, busy: id, error: '' })
    try {
      await need(client, 'acknowledgeTaskStop')(id)
      setAction({ client, identity, busy: null, error: '' })
      changed.emit()
    } catch (error) {
      setAction({ client, identity, busy: null, error: errorMessage(error) })
    }
  }
  return <Screen plan={compose('stopped-tasks', facts)} host={{ data,
    onAction: (name, item) => {
      if (name === 'retry') { setAction({ client, identity, busy: null, error: '' }); read.reload() }
      if (name === 'acknowledge') void acknowledge(item)
    },
  }} />
}
