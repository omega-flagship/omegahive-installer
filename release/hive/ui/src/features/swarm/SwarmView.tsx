import { plural } from '../../lib/plural'
import { VisibilityControl } from '../../ui/Visibility'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Belief } from '../../api/types'
import { hsl, surenessColor } from '../../lib/color'
import { useIsDesktop } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useScene } from '../../scene/sceneStore'
import { isActive } from '../../lib/goals'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { AsWritten, BeliefSentence, Sureness } from '../../ui/Belief'
import { asWritten, beliefText, compareSureness } from '../../lib/beliefSentence'
import { Button, EmptyState, ErrorState, IconButton, Segmented, Skeleton } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { Page } from '../../ui/Page'
import { GoalsBoard } from '../goals/GoalsBoard'
import { Constellation, ConstellationLegend } from './Constellation'
import { Provenance } from './Provenance'
import { OpenIn } from '../programs/OpenIn'
import { SwarmConnections } from './SwarmConnections'
import { SwarmServices } from './SwarmServices'
import { CapabilityCatalogue } from './Catalogue'
import { SwarmSettingsButton } from './SwarmSettings'
import { SwarmBreadcrumbs, SwarmTeam } from './SwarmTeam'
import { SwarmRequestInbox } from './CodingSwarmInboxPanel'
import { shown } from '../../lib/displayName'
import { clearSkeletonShown, skeletonShownFor } from './SwarmSheetSkeleton'

import { followTabLink, initialTab, initialView, type Tab, type View } from './commonsView'

const EMPTY: Record<string, Belief> = {}


export default function SwarmView({ id, statement, tab: startTab }: { id: string; statement?: string; tab?: import('../../lib/router').SwarmTab }) {
  const swarm = useHive((s) => s.swarms[id])
  const beliefMap = useHive((s) => s.beliefs[id] ?? EMPTY)
  const loaded = useHive((s) => !!s.beliefsLoaded[id])
  const pulses = useHive((s) => s.beliefPulse)
  const loadBeliefs = useHive((s) => s.loadBeliefs)
  const desktop = useIsDesktop()
  // the request inbox sits beside the team: on phones in the Team section, on desktop as a commons view
  const [tab, setTab] = useState<Tab>(() => initialTab(startTab))
  const [view, setView] = useState<View>(() => initialView(startTab, desktop))
  // a link to another tab of this same swarm (?tab=, a guided demo's next step) moves the page there (audit P3 #27)
  const [linkedTab, setLinkedTab] = useState(startTab)
  if (startTab !== linkedTab) {
    setLinkedTab(startTab)
    const next = followTabLink(linkedTab, startTab, desktop)
    if (next.tab) setTab(next.tab)
    if (next.view) setView(next.view)
  }
  const shownView: View = view === 'requests' && !desktop ? 'list' : view
  const [err, setErr] = useState<string | null>(null)
  const engine = useScene((s) => s.engine)
  // the loading frame was already on screen: take its place without a second entrance
  const [enter] = useState(() => !skeletonShownFor(id))
  useEffect(() => clearSkeletonShown(), [])

  useEffect(() => {
    loadBeliefs(id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load beliefs'))
  }, [id, loadBeliefs])
  useEffect(() => engine?.flyToSwarm(id), [engine, id])

  const beliefs = useMemo(() => Object.values(beliefMap), [beliefMap])
  const openGoals = useHive((s) => {
    let n = 0
    for (const g of Object.values(s.goals)) if (g.swarm_id === id && isActive(g)) n++
    return n
  })

  if (!swarm) return null

  const select = (st: string | undefined) => navigate({ name: 'swarm', id, statement: st }, { replace: true })

  const commons = (
    // on phones the goals board grows with the page instead of scrolling inside a fixed box
    <div className={cx('flex min-h-0 flex-col', (desktop || view !== 'goals') && 'h-full')}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
        <div className="flex items-baseline gap-2">
          <h2 className="eyebrow">{shownView === 'connections' ? 'Connections' : shownView === 'requests' ? 'Requests' : shownView === 'goals' ? 'Tasks' : 'Commons'}</h2>
          <span className="text-[12px] text-ink-3">{shownView === 'connections' || shownView === 'requests' ? '' : shownView === 'goals' ? `${openGoals} in flight` : plural(beliefs.length, 'belief')}</span>
        </div>
        <Segmented<View>
          label="Commons view"
          tour="commons-view"
          value={shownView}
          onChange={setView}
          options={[
            { value: 'sky', label: 'Constellation' },
            { value: 'list', label: 'Table' },
            { value: 'goals', label: 'Tasks' },
            { value: 'connections', label: 'Connections' },
            ...(desktop ? [{ value: 'requests' as const, label: 'Requests' }] : []),
          ]}
        />
      </div>
      {shownView === 'requests' ? <div className="thin-scroll min-h-0 flex-1 overflow-y-auto pb-6"><SwarmRequestInbox swarm={swarm} /></div> : view === 'connections' ? <div className="thin-scroll min-h-0 flex-1 overflow-y-auto"><SwarmServices swarm={swarm} /><CapabilityCatalogue swarm={swarm} /><SwarmConnections swarm={swarm} /></div> : view === 'goals' ? (
        <GoalsBoard swarmId={id} className={desktop ? 'min-h-0 flex-1' : undefined} />
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[20px] border border-line" data-tour="swarm-sky" style={{ background: `radial-gradient(70% 70% at 50% 50%, color-mix(in srgb, ${hsl(swarm.hue, 80, 30)} var(--swarm-sky-tint), transparent), var(--swarm-sky-edge))` }}>
          {err && !beliefs.length ? (
            <ErrorState title="Could not load the commons" body={err} onRetry={() => loadBeliefs(id, true).then(() => setErr(null), () => undefined)} />
          ) : !loaded && !beliefs.length ? (
            <div className="flex h-full items-center justify-center">
              <div className="eyebrow animate-pulse">Charting the commons…</div>
            </div>
          ) : !beliefs.length ? (
            <EmptyState icon="sparkles" title="An empty sky" body="No beliefs yet. When members publish, stars appear here." />
          ) : view === 'sky' ? (
            <Constellation beliefs={beliefs} hue={swarm.hue} selected={statement} onSelect={(s) => select(s)} pulses={pulses} swarmId={id} tour="swarm-constellation" />
          ) : (
            <BeliefTable beliefs={beliefs} onSelect={(s) => select(s)} selected={statement} />
          )}
        </div>
      )}
      {view === 'sky' && beliefs.length > 0 && <ConstellationLegend className="px-1 pt-2.5" tour="sky-legend" />}
    </div>
  )

  return (
    <>
      <Page
        label={`${shown(swarm.name)} swarm`}
        eyebrow={
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: hsl(swarm.hue, 95, 68), boxShadow: `0 0 8px ${hsl(swarm.hue, 95, 60)}` }} />
            Swarm{swarm.archived_at ? ' · archived' : ''}
          </span>
        }
        title={shown(swarm.name)}
        enter={enter}
        onClose={() => navigate({ name: 'hive' })}
        onBack={() => navigate({ name: 'swarms' })}
        info="swarm"
        actions={
          <div className="flex items-center gap-2">
            <OpenIn onPick={(pid) => navigate({ name: 'program', id: pid, swarm: id })} iconOnly={!desktop} />
            {swarm && <VisibilityControl kind="swarm" id={id} value={{ visibility: swarm.visibility ?? 'public', shared_with: swarm.shared_with ?? [] }} />}
            <SwarmSettingsButton swarm={swarm} iconOnly={!desktop} startOpen={startTab === 'settings'} />
            <Button
              variant="subtle"
              icon="chat"
              aria-label="Chat with this swarm"
              data-tour="swarm-chat"
              onClick={async () => {
                const { client, toast } = useHive.getState()
                if (!client?.swarmRoom) return navigate({ name: 'messages' })
                try {
                  const room = await client.swarmRoom(id)
                  navigate({ name: 'messages', room: room.id })
                } catch (e) {
                  toast({ tone: 'error', title: 'Could not open the swarm chat', body: e instanceof Error ? e.message : String(e) })
                }
              }}
            >
              Chat
            </Button>
            <Button variant="subtle" icon="power" onClick={() => navigate({ name: 'lifecycle', swarm: id })} aria-label="Lifecycle: who may run whom">
              Lifecycle
            </Button>
            <div className={statement ? 'hidden' : 'hidden sm:block'}>
              <Button variant="subtle" icon="plus" onClick={() => navigate({ name: 'new', swarm: id })}>
                New mind here
              </Button>
            </div>
          </div>
        }
      >
        {desktop ? (
          <div className="grid h-full min-h-[560px] grid-cols-[300px_1fr] gap-5 px-6 pb-6 transition-[padding] duration-300" style={{ paddingRight: statement ? 484 : undefined }}>
            <aside className="thin-scroll min-h-0 space-y-6 overflow-y-auto pr-1">
              <SwarmBreadcrumbs swarm={swarm} />
              <p className="text-small leading-relaxed text-ink-3">{shown(swarm.description)}</p>
              <SwarmTeam swarm={swarm} />
              <Vocab swarmId={id} />
            </aside>
            {commons}
          </div>
        ) : (
          <div className="flex h-full flex-col px-3 pb-[calc(var(--sab)+84px)]">
            <SwarmBreadcrumbs swarm={swarm} />
            <p className="px-1 pb-3 text-small leading-relaxed text-ink-3">{shown(swarm.description)}</p>
            <Segmented<Tab>
              label="Swarm section"
              tour="swarm-tab"
              value={tab}
              onChange={setTab}
              className="mb-3 w-full"
              options={[
                { value: 'commons', label: 'Commons' },
                { value: 'members', label: 'Minds' },
                { value: 'vocab', label: 'Vocabulary' },
                { value: 'connections', label: 'Connections' },
              ]}
            />
            <div className="min-h-[440px] flex-1">
              {tab === 'commons' ? commons : tab === 'members' ? <div className="space-y-6 pb-6"><SwarmTeam swarm={swarm} /><SwarmRequestInbox swarm={swarm} /></div> : tab === 'connections' ? <><SwarmServices swarm={swarm} /><CapabilityCatalogue swarm={swarm} /><SwarmConnections swarm={swarm} /></> : <Vocab swarmId={id} />}
            </div>
          </div>
        )}
      </Page>
      <AnimatePresence>{statement && <Provenance key={statement} swarmId={id} statement={statement} onClose={() => select(undefined)} />}</AnimatePresence>
    </>
  )
}

function Vocab({ swarmId }: { swarmId: string }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [terms, setTerms] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [fresh, setFresh] = useState<string[]>([])

  useEffect(() => {
    if (!client) return
    client.getVocab(swarmId).then(setTerms, (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load vocabulary'))
  }, [client, swarmId])

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const list = draft.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
    if (!client || !list.length) return
    try {
      const next = await client.addVocab(swarmId, list)
      setFresh(list)
      setTerms(next)
      setDraft('')
    } catch (x) {
      toast({ tone: 'error', title: 'Could not add terms', body: x instanceof Error ? x.message : undefined })
    }
  }

  return (
    <section aria-labelledby="voc-h">
      <h2 id="voc-h" className="eyebrow mb-2 px-1">
        Vocabulary {terms ? `· ${terms.length}` : ''}
      </h2>
      {err ? (
        <p className="px-1 text-sm text-bad">{err}</p>
      ) : !terms ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-16" />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {terms.length === 0 && <p className="px-1 text-sm text-ink-3">No terms yet. Anything goes until you add some.</p>}
          {terms.map((t) => (
            <m.span
              key={t}
              layout
              initial={fresh.includes(t) ? { opacity: 0, scale: 0.6 } : false}
              animate={{ opacity: 1, scale: 1 }}
              className="inline-flex min-h-7 items-center rounded-lg border border-line bg-white/[0.04] px-2 font-mono text-[12px] text-ink-2"
            >
              {t}
            </m.span>
          ))}
        </div>
      )}
      <form onSubmit={add} className="mt-2.5 flex gap-1.5">
        <label className="sr-only" htmlFor={`voc-${swarmId}`}>
          Add vocabulary terms
        </label>
        <input
          id={`voc-${swarmId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add terms, comma separated"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-black/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4 focus:border-line-2"
        />
        <IconButton icon="plus" label="Add terms" type="submit" className="border border-line" disabled={!draft.trim()} />
      </form>
    </section>
  )
}

type SortKey = 'statement' | 'sure' | 'sources' | 'updated'

/** uifix-r3 (S3): beliefs as sentences, sureness in words (numbers on hover, for screen readers and "Show as written"). */
/** The commons as a table (exported for the sureness agreement test, uifix-r3.5). */
export function BeliefTable({ beliefs, onSelect, selected }: { beliefs: Belief[]; onSelect: (s: string) => void; selected?: string }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'sure', dir: -1 })
  const rows = useMemo(() => {
    // how sure: the one sureness order (compareSureness): direction first, then NAL expectation, so the order agrees
    // with the dot and the word (a neutral row never outranks a blue one; a confident "no" sorts below a weak "yes")
    const v = (b: Belief) => (sort.k === 'statement' ? beliefText(b.statement) : sort.k === 'sources' ? b.sources.length : b.updated_at)
    const cmp = (a: Belief, b: Belief) => (sort.k === 'sure' ? compareSureness(a.tv, b.tv) : v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0)
    return [...beliefs].sort((a, b) => cmp(a, b) * sort.dir)
  }, [beliefs, sort])
  const th = (k: SortKey, label: string, cls = '') => (
    <th scope="col" className={cx('px-3 py-2 font-medium', cls)} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex min-h-8 items-center gap-1 hover:text-ink" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {label}
        {sort.k === k && <Icon name="chevronDown" size={12} className={sort.dir === 1 ? 'rotate-180' : ''} />}
      </button>
    </th>
  )
  return (
    <div className="thin-scroll h-full overflow-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="sticky top-0 z-[1] bg-[#0b0b26]/95 text-[11px] text-ink-3 backdrop-blur">
          <tr>
            {th('statement', 'Belief')}
            {th('sure', 'How sure', 'text-right')}
            {th('sources', 'Sources', 'text-right hidden sm:table-cell')}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((b) => (
            <tr key={b.statement} onClick={() => onSelect(b.statement)} className={cx('cursor-pointer border-t border-line transition-colors hover:bg-white/[0.04]', selected === b.statement && 'bg-white/[0.07]')}>
              <td className="px-3 py-2.5">
                <button className="text-left" onClick={(e) => (e.stopPropagation(), onSelect(b.statement))}>
                  <BeliefSentence statement={b.statement} sure={false} written={false} />
                </button>
                <AsWritten text={asWritten(b.statement, b.tv)} />
              </td>
              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: surenessColor(b.tv) }} aria-hidden="true" />
                <Sureness tv={b.tv} />
              </td>
              <td className="hidden px-3 py-2.5 text-right font-mono text-ink-3 sm:table-cell">{b.sources.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
