/**
 * Purpose: #/artifacts, everything minds and apps produced across the hive, newest first, filterable by kind, words, swarm, mind
 * and app. The screen is atoms (artifacts.metta) that MeTTa composes for the look being worn; this page only loads the
 * list, states the facts, and carries out a press, opening a saved creation in place when that is where its row opens
 * (CreationReader: its text, or its view). #/artifacts/<id> opens that one the same way: a mind's words name what it
 * made by id, shown as a chip that links here (features/views/Words); a link naming one this person can't open says so
 * above the list, a part of the same screen. What the page lists is told
 * to the Ask by id, the creation open in place first.
 */
import { useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate, useRoute, type Route } from '../../lib/router'
import { isForbidden, isNotFound, need, useResource } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { screensSpace } from '../../screens/screenSpace'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { useAskView, type PageView } from '../ask/view'
import { attachAbout, type ChatAbout } from '../dot/chatAbout'
import type { ArtifactFilter } from './artifacts'
import { CreationReader } from './CreationReader'
import { artifactsScreen, NO_FILTER, withInput, type ArtifactRow, type Names } from './data'

export default function ArtifactsPage() {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  const look = experienceById(useLook().current?.experience).id
  const res = useResource(() => need(client, 'hiveArtifacts', 'Artifacts')(), { poll: 30_000, isEmpty: (d) => d.items.length === 0 && d.missing.length === 0 })
  const [filter, setFilter] = useState<ArtifactFilter>(NO_FILTER)
  const route = useRoute()
  const open = route.name === 'artifacts' ? route.open : undefined
  // a row opened from the list belongs to the link it was opened under: a new link shows what it names
  const [picked, setPicked] = useState<{ under: string | undefined; reading: Reading } | null>(null)
  const linked = useResource(() => (open ? need(client, 'artifact', 'Artifacts')(open) : Promise.resolve(null)), { context: open ?? null })
  const fromLink: Reading | null = open && linked.status === 'ready' && linked.data && linked.data.revision !== null
    ? { artifactId: linked.data.artifact_id, revision: linked.data.revision, title: linked.data.title, view: linked.data.kind === 'view' }
    : null
  const reading = (picked && picked.under === open ? picked.reading : null) ?? fromLink
  const linkMissing = !!open && linked.status === 'error' && (isNotFound(linked.error) || isForbidden(linked.error))

  const names = useMemo<Names>(() => ({ minds: agents, swarms, apps: Object.fromEntries((programs ?? []).map((p) => [p.id, p.name])) }), [agents, swarms, programs])
  const { plan, data, listed } = useMemo(() => {
    const { data, facts, listed } = artifactsScreen({ status: res.status, list: res.data, error: res.error }, filter, names)
    // a link naming an artifact this person can't open says so above the list (artifacts.metta)
    return { plan: screensSpace().compose('artifacts', look, { ...facts, flags: { ...facts.flags, 'artifacts.link-missing': linkMissing } }), data, listed }
  }, [res.status, res.data, res.error, filter, names, look, linkMissing])
  // What the Ask is told this page shows: the creation open in place first, then every row listed, by id (the newest
  // first, as the list is, so trimming the view to its 2 KB keeps the newest). The hive names each from its own data,
  // only what this person may see, so "show me the picture called Harbour at dusk" finds its id here.
  const askView = useMemo<PageView>(() => {
    const ids = [...new Set([reading?.artifactId, ...listed].filter((id): id is string => !!id))]
    return { title: 'Artifacts and findings', refs: ids.map((ref) => ({ kind: 'artifact', ref })), summary: `${listed.length} listed` }
  }, [reading?.artifactId, listed])
  useAskView('artifacts', askView)

  return (
    <Page title="Artifacts and findings" eyebrow="What minds and apps produced" label="Artifacts and findings" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-4xl px-3 pt-2 pb-44 md:px-6 md:pb-12">
        {reading ? (
          <CreationReader key={`${reading.artifactId}@${reading.revision}`} {...reading} onBack={() => { setPicked(null); if (open) navigate({ name: 'artifacts' }) }} />
        ) : (
          <Screen plan={plan} host={{
            data,
            busy: res.refreshing,
            framed: true,
            onInput: (bind, value) => setFilter((f) => withInput(f, bind, value)),
            onOpen: (target, item) => {
              if (target !== 'artifact') return
              const read = item.read as ArtifactRow['read']
              if (read) setPicked({ under: open, reading: { artifactId: read.artifact_id, revision: read.revision, title: String(item.title), view: !!read.view } })
              else if (item.route) {
                const route = item.route as Route
                // Ask <mind> opens that mind's chat with the artifact on its box, so the question goes about it
                if (route.name === 'dot' && item.about) attachAbout(route.id, item.about as ChatAbout)
                navigate(route)
              }
            },
            onAction: (action) => {
              if (action === 'reload') void res.reload()
              else if (action === 'clear-filters') setFilter(NO_FILTER)
            },
          }} />
        )}
      </div>
    </Page>
  )
}

/** A saved creation open in place: which revision, its title, and whether it opens as its view (CreationReader). */
type Reading = { artifactId: string; revision: number; title: string; view: boolean }
