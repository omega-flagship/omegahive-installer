// Purpose: draw and acknowledge the person's task stops through the shared conversation screen.
import { useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { errorMessage, need, useAuthContext } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { stoppedScreen } from './stopped'
import { useTaskStops } from './useTaskStops'

export function StoppedTasks({ mind }: { mind?: string }) {
  const client = useHive((s) => s.client)
  const identity = useAuthContext(client)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  // one read for the Ask's cards, every mind's chat and the folded Ask's mark: a Got it here reaches them all
  const read = useTaskStops()
  const [action, setAction] = useState<{ client: typeof client; identity: typeof identity; busy: string | null; error: string } | null>(null)
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
      read.reload()
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
