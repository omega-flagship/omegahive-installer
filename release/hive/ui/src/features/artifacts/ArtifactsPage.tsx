import { useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate, type Route } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { screensSpace } from '../../screens/screenSpace'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import type { ArtifactFilter } from './artifacts'
import { artifactsScreen, NO_FILTER, withInput, type Names } from './data'

/**
 * #/artifacts: everything minds and apps produced across the hive, newest first, filterable by kind, words, swarm, mind
 * and app. The screen is atoms (artifacts.metta) that MeTTa composes for the look being worn; this page only loads the
 * list, states the facts, and carries out a press.
 */
export default function ArtifactsPage() {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  const look = experienceById(useLook().current?.experience).id
  const res = useResource(() => need(client, 'hiveArtifacts', 'Artifacts')(), { poll: 30_000, isEmpty: (d) => d.items.length === 0 && d.missing.length === 0 })
  const [filter, setFilter] = useState<ArtifactFilter>(NO_FILTER)

  const names = useMemo<Names>(() => ({ minds: agents, swarms, apps: Object.fromEntries((programs ?? []).map((p) => [p.id, p.name])) }), [agents, swarms, programs])
  const { plan, data } = useMemo(() => {
    const { data, facts } = artifactsScreen({ status: res.status, list: res.data, error: res.error }, filter, names)
    return { plan: screensSpace().compose('artifacts', look, facts), data }
  }, [res.status, res.data, res.error, filter, names, look])

  return (
    <Page title="Artifacts and findings" eyebrow="What minds and apps produced" label="Artifacts and findings" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-4xl px-3 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data,
          busy: res.refreshing,
          framed: true,
          onInput: (bind, value) => setFilter((f) => withInput(f, bind, value)),
          onOpen: (target, item) => { if (target === 'artifact' && item.route) navigate(item.route as Route) },
          onAction: (action) => {
            if (action === 'reload') void res.reload()
            else if (action === 'clear-filters') setFilter(NO_FILTER)
          },
        }} />
      </div>
    </Page>
  )
}
