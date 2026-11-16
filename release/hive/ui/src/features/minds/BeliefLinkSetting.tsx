// Purpose: who sees a mind's own beliefs, on its Memory tab: reads the mind's link, composes beliefLink.metta for this
// moment, and makes each choice or tick the one write PUT …/belief-link takes, then shows the link the hive answers.
import { useMemo, useState } from 'react'
import type { Agent } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { useMe } from '../../lib/useAdmin'
import { errorMessage, has, isForbidden, isNotFound, need, useResource } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { withResource } from '../../screens/resourceFacts'
import { screensSpace } from '../../screens/screenSpace'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { beliefLinkScreen, LINK_PAGE, linkPress, type LinkPage } from './beliefLink'

/**
 * A mind's beliefs reach its swarm through a link, never a copy (Jon on #334), and what the link shows is its owner's
 * choice, its default following who may see the mind (Jon on #354). Only its owner may let the swarm see more; an admin
 * may only narrow it (Jon on #360), as the rights the hive answers with the link say. The hive answers 404 for a mind
 * this person may not see and on a hive without links, and 403 owner_only to anyone else who sees the mind; either way
 * there is nothing to show.
 */
export function BeliefLinkSetting({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const { me } = useMe()
  const look = experienceById(useLook().current?.experience).id
  // read again when its owner's setting changes anywhere (the view's belief_link, on every agent event) and when who may
  // see the mind changes, which moves its default (hive.py relink_beliefs)
  const res = useResource(() => need(client, 'beliefLink', 'Who sees its beliefs')(agent.id),
    { context: agent.id, key: `${agent.visibility ?? ''}\u0000${agent.personal_of ?? ''}\u0000${JSON.stringify(agent.belief_link ?? null)}`, isEmpty: () => false })
  const [page, setPage] = useState<LinkPage>(LINK_PAGE)
  const { plan, data } = useMemo(() => {
    const { data, facts } = withResource(res, beliefLinkScreen(res.data, agent, me?.principal, page))
    return { plan: screensSpace().compose('belief-link', look, facts), data }
  }, [res, agent, me?.principal, page, look])
  if (!has(client, 'beliefLink') || res.status === 'unsupported' || (res.status === 'error' && (isNotFound(res.error) || isForbidden(res.error)))) return null

  const onAction = (action: string, item: ScreenItem, checked?: boolean) => {
    if (action === 'retry-link') return res.reload()
    const link = res.data
    if (!link || page.busy) return
    const wants = linkPress(link, action, action === 'set-link' ? item.value : item.id, checked)
    // choosing what is already linked only closes the ticks; Some subjects opens them and writes nothing yet
    if (wants === null) return action === 'set-link' && item.value !== 'some' ? setPage((p) => ({ ...p, picking: false })) : undefined
    if (wants === 'pick') return setPage((p) => ({ ...p, picking: true, error: null }))
    setPage((p) => ({ ...p, busy: true, error: null }))
    need(client, 'setBeliefLink', 'Who sees its beliefs')(agent.id, wants.domains).then(
      (next) => {
        res.mutate(() => next)
        setPage(LINK_PAGE)
      },
      (e: unknown) => setPage((p) => ({ ...p, busy: false, error: errorMessage(e) })),
    )
  }

  return (
    <section aria-label="Who sees its beliefs" className="rounded-xl border border-line bg-tint/[0.02] p-3" data-belief-link={agent.id}>
      <Screen plan={plan} host={{ data, busy: res.refreshing, onAction }} />
    </section>
  )
}
