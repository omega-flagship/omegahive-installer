import { useEffect, useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate } from '../../lib/router'
import { useSim } from '../../lib/sim'
import { useMe } from '../../lib/useAdmin'
import { has } from '../../lib/useResource'
import { Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { ArchivedSwarms } from './ArchivedSwarms'
import { swarmsScreen } from './data'
import { warmSwarmView } from './SwarmSheetSkeleton'

const swarmOf = (item: ScreenItem): string => (Array.isArray(item.scope) ? String(item.scope[0] ?? '') : '')

/**
 * #/swarms: every swarm in the hive, archived swarms (admins), and minds in no swarm. The page and each swarm's card
 * are atoms (swarms.metta) that MeTTa composes for the look being worn; this page reads the store, states the facts,
 * places the archived list (an island), and carries out a press. One swarm's own page is SwarmView.tsx.
 */
export default function SwarmsIndex() {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const beliefs = useHive((s) => s.beliefs)
  const client = useHive((s) => s.client)
  const { admin } = useMe()
  const sim = useSim()
  const look = experienceById(useLook().current?.experience).id
  const canRestore = has(client, 'restoreSwarm')
  // a swarm is one click away: have its sheet ready (also on a card's hover or focus, below)
  useEffect(() => warmSwarmView(), [])

  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = swarmsScreen({ swarms, agents, beliefs }, { admin, canRestore, sim }, compose)
    return { plan: compose('swarms', facts), data }
  }, [swarms, agents, beliefs, admin, canRestore, sim, compose])

  const host: ScreenHost = {
    data,
    framed: true,
    islands: { 'archived-swarms': <ArchivedSwarms /> },
    onOpen: (target, item) => {
      if (target === 'swarm') navigate({ name: 'swarm', id: swarmOf(item) })
      if (target === 'mind') navigate({ name: 'dot', id: String(item.id) })
    },
    onAction: (action, item) => {
      if (action === 'connect') navigate({ name: 'connect' })
      if (action === 'launch') navigate({ name: 'launch' })
      if (action === 'new-mind') navigate({ name: 'new', swarm: swarmOf(item) })
      if (action === 'connect-here') navigate({ name: 'connect', swarm: swarmOf(item) })
    },
  }

  return (
    <Page label="Swarms" eyebrow="The hive" title="Swarms" onClose={() => navigate({ name: 'hive' })}>
      <div className="px-3 pb-28 md:px-6 md:pb-8" onPointerOver={warmSwarmView} onFocus={warmSwarmView}>
        <Screen plan={plan} host={host} />
      </div>
    </Page>
  )
}
