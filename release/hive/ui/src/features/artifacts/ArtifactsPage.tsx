import { useMemo, useState } from 'react'
import type { ArtifactKind, HiveArtifact } from '../../api/moneyWork'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { navigate, openInDesign, type Route } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon, type IconName } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { filterArtifacts, KIND_LABEL, NO_FILTER, type ArtifactFilter } from './artifacts'

const KIND_ICON: Record<ArtifactKind, IconName> = { review: 'doc', flow: 'graph', exhibit: 'layers', 'app-result': 'apps' }
const KINDS: (ArtifactKind | 'all')[] = ['all', 'review', 'flow', 'exhibit', 'app-result']

/** #/artifacts: everything minds and apps produced across the hive, newest first, filterable by swarm, mind and app. */
export default function ArtifactsPage() {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'hiveArtifacts', 'Artifacts')(), { poll: 30_000, isEmpty: (d) => d.items.length === 0 && d.missing.length === 0 })
  return (
    <Page title="Artifacts and findings" eyebrow="What minds and apps produced" label="Artifacts and findings" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-4xl space-y-4 px-3 pt-2 pb-12 md:px-6">
        <ResourceView
          res={res}
          errorTitle="Could not list artifacts"
          empty={{ icon: 'layers', title: 'Nothing produced yet', body: 'Flows, revisions sent for review, exhibits minds show each other, and finished app actions appear here.' }}
          unsupported={{ body: 'This hive or the demo does not list artifacts yet.' }}
        >
          {(data) => <List items={data.items} missing={data.missing} refreshing={res.refreshing} onReload={res.reload} />}
        </ResourceView>
      </div>
    </Page>
  )
}

function List({ items, missing, refreshing, onReload }: { items: HiveArtifact[]; missing: string[]; refreshing: boolean; onReload: () => void }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  const [f, setF] = useState<ArtifactFilter>(NO_FILTER)
  const swarmOfMind = (id: string) => agents[id]?.swarm_id ?? null
  const shownItems = useMemo(() => filterArtifacts(items, f, swarmOfMind), [items, f, agents]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length }
    for (const a of items) c[a.kind] = (c[a.kind] ?? 0) + 1
    return c
  }, [items])
  const minds = useMemo(() => [...new Set(items.map((a) => a.mind_id).filter((x): x is string => !!x))], [items])
  const apps = useMemo(() => [...new Set(items.map((a) => a.app).filter((x): x is string => !!x))], [items])
  const swarmIds = useMemo(() => [...new Set(items.map((a) => a.swarm_id ?? (a.mind_id ? swarmOfMind(a.mind_id) : null)).filter((x): x is string => !!x))], [items, agents]) // eslint-disable-line react-hooks/exhaustive-deps
  const appName = (id: string) => shown(programs?.find((p) => p.id === id)?.name ?? id)
  const sel = 'min-h-10 rounded-xl border border-line bg-black/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2'

  return (
    <>
      {missing.length > 0 && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-warn">
          <span className="min-w-0 flex-1">Could not read {missing.join(', ')} this time, so those are missing from the list.</span>
          <Button variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={onReload} disabled={refreshing}>
            Retry
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
        {KINDS.map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={f.kind === k}
            onClick={() => setF({ ...f, kind: k })}
            className={cx('min-h-9 rounded-full border px-3 text-[12.5px]', f.kind === k ? 'border-control bg-white/[0.09] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}
          >
            {k === 'all' ? 'Everything' : KIND_LABEL[k]} <span className="text-ink-4">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex min-h-10 min-w-[180px] flex-1 items-center gap-2 rounded-xl border border-line bg-black/30 px-3 focus-within:border-line-2">
          <Icon name="search" size={15} className="text-ink-4" />
          <span className="sr-only">Search artifacts</span>
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search titles" className="w-full bg-transparent text-[13px] text-ink outline-none" />
        </label>
        <select aria-label="Swarm" value={f.swarm} onChange={(e) => setF({ ...f, swarm: e.target.value })} className={sel}>
          <option value="">Every swarm</option>
          {swarmIds.map((id) => (
            <option key={id} value={id}>
              {shown(swarms[id]?.name ?? id)}
            </option>
          ))}
        </select>
        <select aria-label="Mind" value={f.mind} onChange={(e) => setF({ ...f, mind: e.target.value })} className={sel}>
          <option value="">Every mind</option>
          {minds.map((id) => (
            <option key={id} value={id}>
              {shown(agents[id]?.name ?? id)}
            </option>
          ))}
        </select>
        {apps.length > 0 && (
          <select aria-label="App" value={f.app} onChange={(e) => setF({ ...f, app: e.target.value })} className={sel}>
            <option value="">Every app</option>
            {apps.map((id) => (
              <option key={id} value={id}>
                {appName(id)}
              </option>
            ))}
          </select>
        )}
      </div>
      {shownItems.length === 0 ? (
        <EmptyState icon="filter" title="Nothing matches" body="Try another kind, swarm or mind." action={<Button variant="subtle" onClick={() => setF(NO_FILTER)}>Clear filters</Button>} />
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-line bg-white/[0.02]">
          {shownItems.map((a, i) => (
            <Row key={a.key} a={a} first={i === 0} appName={appName} />
          ))}
        </ul>
      )}
      <p className="text-meta text-ink-4">Composed from what you can already see: revisions sent for review, each swarm’s flows, exhibits minds showed each other, and app actions that finished.</p>
    </>
  )
}

function Row({ a, first, appName }: { a: HiveArtifact; first: boolean; appName: (id: string) => string }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const swarm = a.swarm_id ?? (a.mind_id ? agents[a.mind_id]?.swarm_id ?? null : null)
  const design = a.ref && swarm ? openInDesign(a.ref, swarm) : undefined
  const open: { label: string; route: Route } | null = design
    ? { label: 'Open in Design', route: design }
    : a.kind === 'flow'
      ? { label: 'Open flows', route: { name: 'flow' } }
      : a.kind === 'exhibit' && a.mind_id && agents[a.mind_id]
        ? { label: 'Who sees it', route: { name: 'dot', id: a.mind_id, tab: 'memory' } }
        : a.app
          ? { label: `Open ${appName(a.app)}`, route: { name: 'program', id: a.app, swarm: a.swarm_id ?? undefined } }
          : null
  return (
    <li className={cx('flex items-start gap-3 px-4 py-3', !first && 'border-t border-line')}>
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-line bg-white/[0.04] text-ink-3">
        <Icon name={KIND_ICON[a.kind]} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{a.title}</span>
          <span className="text-meta text-ink-4">{KIND_LABEL[a.kind]}</span>
          {a.state && <span className="rounded-full border border-line px-1.5 py-px text-[10.5px] text-ink-3">{a.state}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-ink-3">
          {[a.mind_id && `by ${shown(agents[a.mind_id]?.name ?? a.mind_id)}`, a.app && `via ${appName(a.app)}`, swarm && `in ${shown(swarms[swarm]?.name ?? swarm)}`, a.at && ago(a.at)].filter(Boolean).join(' · ')}
        </div>
        {(a.detail || a.artifact_id) && (
          <div className="mt-0.5 text-meta text-ink-4">
            {a.to_swarm && `Sent to ${shown(swarms[a.to_swarm]?.name ?? a.to_swarm)} · `}
            {a.detail}
            {a.artifact_id && <span className="font-mono"> · {a.artifact_id}{a.revision ? ` r${a.revision}` : ''}</span>}
          </div>
        )}
      </div>
      {open && (
        <Button variant="ghost" className="min-h-9 shrink-0 px-2.5 text-[12px]" onClick={() => navigate(open.route)}>
          {open.label}
        </Button>
      )}
    </li>
  )
}
