import { plural } from '../../lib/plural'
import { plainText } from '../sdk'
import { useShownSwarms } from '../../scene/viewer'
import { AnimatePresence } from 'framer-motion'
import { useDraft } from '../drafts'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ApprovalDecision } from '../ApprovalDecision'
import {
  FEATURES, GROUP_LABEL, GoalDecision, ScopedFeaturePicker, featureOffered, navigate, openFeature, openGallery, openPalette, presenceRef,
  shown, targetFor, useAskView, useHomeRequested, useAuthContext, useAdminView, useHive, useResting, useRoute, viewIsLive, type Approval, type Feature, type Goal,
} from '../sdk'
import { Conversation, MindControls } from './Conversation'
import { contextOf, current } from './binding'
import { TOKENS } from './theme'
import { Motivations } from '../Motivations'
import { DIRECTORY } from '../directory'
import { publicActivityKind, publicBlurb, publicLabel, publicWords } from '../publicWords'
import { guardComposing } from '../../features/ask/keys'
import './styles.css'

type View = 'overview' | 'minds' | 'swarms' | 'goals' | 'decisions' | 'apps' | 'activity' | 'tools' | 'future'
type Inspected = { kind: 'approval'; seen: Approval; session: string } | { kind: 'goal'; seen: Goal; to: Goal['status']; session: string }
const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'minds', label: 'Minds' },
  { id: 'swarms', label: 'Swarms' }, { id: 'goals', label: 'Tasks' },
  { id: 'decisions', label: 'Decisions' }, { id: 'apps', label: 'Apps' },
  { id: 'activity', label: 'Activity' }, { id: 'tools', label: 'All tools' },
]
const IN_PLACE: Partial<Record<string, View>> = {
  'minds.see': 'minds', 'swarms.see': 'swarms', 'work.goals': 'goals',
  'decide.approvals': 'decisions', 'apps.list': 'apps', 'watch.activity': 'activity',
}
const date = (value: string) => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** Host-owned experience candidate. All local drafts/selection remount on client, session, init or auth change. */
export default function Professional() {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  useAuthContext(client)
  const ctx = contextOf({ ...useHive.getState(), client, session, inits })
  return <Workspace key={ctx} ctx={ctx} />
}

function Workspace({ ctx }: { ctx: string }) {
  const { adminView } = useAdminView()
  const hive = useHive((s) => s.hive)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const approvals = useHive((s) => s.approvals)
  const goals = useHive((s) => s.goals)
  const programs = useHive((s) => s.programs)
  const programsError = useHive((s) => s.programsError)
  const approvalsLoaded = useHive((s) => s.approvalsLoaded)
  const goalsLoaded = useHive((s) => s.goalsLoaded)
  const activity = useHive((s) => s.activity)
  const thinking = useHive((s) => s.thinking)
  const connection = useHive((s) => s.connection)
  const ready = useHive((s) => s.ready)
  const bootError = useHive((s) => s.bootError)
  const route = useRoute()
  const resting = useResting((s) => s.resting)
  const [view, setView] = useState<View>('overview')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pick, setPick] = useState<Feature | null>(null)
  const [inspected, setInspected] = useState<Inspected | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const localViewVisit = useRef(0)
  const [displayedVisit, setDisplayedVisit] = useState(0)
  // Invalidate a retained export now, then guarantee a committed renewal even for unchanged navigation.
  const renewView = () => { localViewVisit.current++; setDisplayedVisit(localViewVisit.current) }
  const toolsButton = useRef<HTMLButtonElement>(null)
  // a surface's X lands on the overview (home:requested): no mind selected, no picker open
  useHomeRequested(() => {
    if (!current(ctx)) return
    renewView()
    setView('overview')
    setQuery('')
    setSelected(null)
    setPick(null)
  })

  const minds = useMemo(() => Object.values(agents).sort((a, b) => shown(a.name).localeCompare(shown(b.name))), [agents])
  // the one visibility helper (scene/visibleSet), grouped by hive: yours, the cloud hive's, then other people's
  const teams = useShownSwarms()
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)), [approvals])
  const goalList = useMemo(() => Object.values(goals).filter((g) => !!swarms[g.swarm_id]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [goals, swarms])
  const teamIds = teams.map((s) => s.id).sort().join('\u0001')
  const goalsComplete = teams.every((s) => !!goalsLoaded[s.id])
  const awake = minds.filter((a) => a.status === 'awake').length
  const covered = route.name !== 'hive' || resting
  const activeMind = selected ? agents[selected] : null
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w))

  const refresh = () => {
    if (!current(ctx)) return
    const s = useHive.getState()
    const work = [s.loadApprovals(), s.loadPrograms(), ...Object.keys(s.swarms).map((id) => s.loadGoals(id, true))]
    void Promise.allSettled(work).then((results) => {
      if (!current(ctx)) return
      setReadError(results.some((r) => r.status === 'rejected') ? 'Some information could not be refreshed. Open its page to check again.' : null)
    })
  }
  useEffect(() => {
    if (!ready || !current(ctx)) return
    const s = useHive.getState()
    let showing = true
    void Promise.allSettled([s.loadApprovals(), s.loadPrograms(), ...Object.keys(s.swarms).map((id) => s.loadGoals(id))]).then((results) => {
      if (showing && current(ctx) && results.some((r) => r.status === 'rejected')) setReadError('Some information could not be loaded. You can check it on its page.')
    })
    return () => { showing = false }
  }, [ctx, ready, teamIds])

  useEffect(() => {
    if (stage.current) stage.current.inert = covered
  }, [covered])

  const rawHash = window.location.hash
  const displayedOriginCurrent = useCallback(() => localViewVisit.current === displayedVisit && current(ctx) && window.location.hash === rawHash && route.name === 'hive' && (!selected || !!useHive.getState().agents[selected]), [ctx, rawHash, route.name, selected, displayedVisit])
  const displayedViewCurrent = useCallback(() => displayedOriginCurrent() && viewIsLive(stage.current), [displayedOriginCurrent])
  // View labels and exact public entity refs only; private app contents/chat drafts/results are never exported.
  useAskView('professional', covered ? null : {
    title: `Professional · ${VIEWS.find((v) => v.id === view)?.label ?? 'Future spaces'}`,
    refs: selected && agents[selected] ? [{ kind: 'mind', ref: selected }] : [],
    summary: `${plural(minds.length, 'mind')} in view; ${awake} awake; ${plural(pending.length, 'loaded decision')} pending`,
  }, displayedViewCurrent)

  const changeView = (next: View) => {
    if (!current(ctx)) return
    renewView()
    setView(next)
    setQuery('')
    setSelected(null)
    // The heading persists across view changes; no deferred control can steal focus from a host modal.
    heading.current?.focus({ preventScroll: true })
  }
  const selectMind = (id: string) => {
    if (!current(ctx) || !useHive.getState().agents[id]) return
    renewView()
    setSelected(id)
    setView('minds')
  }
  const clearSelected = () => {
    if (!current(ctx)) return
    renewView()
    setSelected(null)
    heading.current?.focus()
  }
  const feature = (f: Feature) => {
    if (!current(ctx) || !featureOffered(f, { admin: adminView, apps: useHive.getState().programs })) return
    if (IN_PLACE[f.id]) { changeView(IN_PLACE[f.id]!); return }
    const target = targetFor(f)
    if (target?.kind === 'mind' || target?.kind === 'swarm') { setPick(f); return }
    if (!openFeature(f)) setReadError('This feature does not have a UI yet.')
  }
  const byId = (id: string) => { const f = FEATURES.find((x) => x.id === id); if (f) feature(f) }
  const decide = (a: Approval) => {
    if (!current(ctx)) return
    const live = useHive.getState().approvals[a.id]
    if (!live || live.status !== 'pending') return
    setInspected({ kind: 'approval', seen: { ...live }, session: useHive.getState().session })
  }
  const goalDecision = (g: Goal, to: Goal['status']) => {
    if (!current(ctx)) return
    const live = useHive.getState().goals[g.id]
    if (!live) return
    setInspected({ kind: 'goal', seen: { ...live }, to, session: useHive.getState().session })
  }
  const restore = (opener: HTMLElement | null) => opener?.isConnected && !opener.closest('[inert]') ? opener : heading.current
  const openGoal = (g: Goal) => {
    if (current(ctx) && useHive.getState().swarms[g.swarm_id] && useHive.getState().goals[g.id]) navigate({ name: 'goals', swarm: g.swarm_id, goal: g.id })
  }

  const mindRows = (limit?: number) => {
    const found = minds.filter((a) => hit(`${shown(a.name)} ${a.id} ${a.kind} ${a.status} ${a.swarm_id ? shown(swarms[a.swarm_id]?.name ?? a.swarm_id) : ''}`))
    return <ul className="pr-rows" aria-label="Minds">{(limit ? found.slice(0, limit) : found).map((a) => <li key={a.id} data-presence-ref={presenceRef('mind', a.id)}>
      <button type="button" className="pr-row-main" aria-label={a.kind === 'module' ? `Open this module: ${shown(a.name)}` : `Talk to ${shown(a.name)}`} onClick={() => selectMind(a.id)}>
        <span className="pr-avatar" aria-hidden="true" style={{ background: `hsl(${a.hue} 55% 93%)`, color: `hsl(${a.hue} 60% 30%)` }}>{shown(a.name).slice(0, 1).toUpperCase()}</span>
        <span className="pr-row-text"><strong>{shown(a.name)}</strong><small>{a.swarm_id ? shown(swarms[a.swarm_id]?.name ?? a.swarm_id) : 'No swarm'} · {a.kind}</small></span>
        <span className="pr-status" data-status={a.status}>{thinking[a.id] === 'llm' ? 'Thinking' : thinking[a.id] === 'skills' ? 'Using skills' : a.status}</span>
      </button>
      <MindControls key={`${a.id}:${a.status}`} agent={a} ctx={ctx} />
    </li>)}{!found.length && <li className="pr-empty">{query ? 'No minds match your search.' : ready ? 'No minds in view yet.' : 'Connecting to the hive…'}</li>}</ul>
  }
  const decisionRows = (limit?: number) => <ul className="pr-rows" aria-label="Pending decisions">
    {(limit ? pending.slice(0, limit) : pending).filter((a) => hit(`${shown(agents[a.agent_id]?.name ?? a.agent_id)} ${a.skill} ${a.reason}`)).map((a) => <li key={a.id}>
      <span className="pr-row-text"><strong>{shown(agents[a.agent_id]?.name ?? a.agent_id)} asks to use {a.skill}</strong><small>{a.risk} risk · {date(a.created_at)}</small></span>
      <button type="button" className="pr-button" onClick={() => decide(a)}>Review request</button>
    </li>)}
    {!pending.length && <li className="pr-empty">{approvalsLoaded ? 'No decisions waiting on you.' : 'Loading decisions…'}</li>}
  </ul>
  const goalRows = (limit?: number) => <ul className="pr-rows" aria-label="Tasks">
    {(limit ? goalList.slice(0, limit) : goalList).filter((g) => hit(`${g.title} ${g.status} ${shown(swarms[g.swarm_id]?.name ?? g.swarm_id)}`)).map((g) => <li key={g.id} data-presence-ref={presenceRef('goal', g.id)} className="pr-goal-row">
      <button type="button" className="pr-row-main" onClick={() => openGoal(g)}><span className="pr-row-text"><strong>{g.title}</strong><small>{shown(swarms[g.swarm_id]?.name ?? g.swarm_id)} · Updated {date(g.updated_at)}</small></span><span className="pr-status">{g.status === 'submitted' ? 'Awaiting review' : g.status}</span></button>
      <div className="pr-row-actions">
        {g.status === 'submitted' ? <button type="button" className="pr-button" onClick={() => openGoal(g)}>Review work</button> : g.status === 'done' || g.status === 'cancelled' ? <button type="button" className="pr-button" onClick={() => openGoal(g)}>View result</button> : <>
          <button type="button" className="pr-button" onClick={() => goalDecision(g, g.status === 'failed' || g.status === 'stalled' ? 'open' : 'done')}>{g.status === 'failed' || g.status === 'stalled' ? 'Re-open' : 'Mark done'}</button>
          <button type="button" className="pr-link" onClick={() => goalDecision(g, 'cancelled')}>Cancel</button>
        </>}
      </div>
    </li>)}
    {!goalList.length && <li className="pr-empty">{goalsComplete ? 'No tasks in view yet.' : 'Loading tasks…'}</li>}
    {!goalsComplete && goalList.length > 0 && <li className="pr-muted">Some swarms’ tasks are still loading.</li>}
  </ul>
  const activityRows = (limit?: number) => {
    // UI review C4 (stand-in r1 P2): each row says who did it, as Classic's feed does ("Vega revised …")
    const who = (a: (typeof activity)[number]) => (a.agent_id && agents[a.agent_id] ? shown(agents[a.agent_id].name) : '')
    const found = [...activity].reverse().filter((a) => hit(`${who(a)} ${a.text} ${a.kind}`))
    return <ol className="pr-activity">{(limit ? found.slice(0, limit) : found).map((a) => <li key={a.id}><span className="pr-activity-dot" aria-hidden="true" /><div><p>{who(a) && <strong>{who(a)} </strong>}{plainText(publicWords(a.text))}</p><small>{publicActivityKind(a.kind)} · {date(a.at)}</small></div></li>)}{!found.length && <li className="pr-empty">No recent activity in this session.</li>}</ol>
  }
  const appCards = () => <ul className="pr-apps">{(programs ?? []).filter((p) => hit(`${shown(p.name)} ${p.id} ${shown(p.description)}`)).map((p) => <li key={p.id} className="pr-card">
    <div className="pr-card-head"><h2>{shown(p.name)}</h2><span className="pr-status">{p.error ? 'Error' : p.enabled ? 'Enabled' : 'Disabled'}</span></div>
    <p>{shown(p.description) || 'No description provided.'}</p><small className="pr-muted">{p.id} · v{p.version}</small>
    <div className="pr-app-actions"><button type="button" className="pr-button" disabled={!p.enabled || !!p.error || !current(ctx)} onClick={() => {
      const live = useHive.getState().programs?.find((x) => x.id === p.id)
      if (current(ctx) && live?.enabled && !live.error) navigate({ name: 'program', id: p.id })
    }}>Open app</button></div>
  </li>)}{programs?.length === 0 && <li className="pr-empty">No apps found in this hive.</li>}</ul>

  let content: ReactNode
  if (selected) content = activeMind ? <section className="pr-card pr-chat-card" data-presence-ref={presenceRef('mind', activeMind.id)}>
    <div className="pr-card-head pr-chat-head"><div><h2>{shown(activeMind.name)}</h2><p className="pr-muted">{activeMind.swarm_id ? shown(swarms[activeMind.swarm_id]?.name ?? activeMind.swarm_id) : 'No swarm'} · {activeMind.kind} · {activeMind.status}</p></div>
      <div className="pr-row-actions"><MindControls key={`${activeMind.id}:${activeMind.status}`} agent={activeMind} ctx={ctx} /><button type="button" className="pr-button" onClick={() => { const live = useHive.getState().agents[selected]; if (current(ctx) && live) navigate({ name: 'dot', id: selected, tab: live.kind === 'module' ? 'model' : 'chat' }) }}>{activeMind.kind === 'module' ? 'Open model & tools' : 'Mind panel'}</button><button type="button" className="pr-button" onClick={clearSelected}>Back to minds</button></div>
    </div>{activeMind.kind === 'module' ? <p className="pr-muted">Modules are not chatting minds. Open this module’s native model and tools panel to inspect its controls.</p> : <Conversation key={`${ctx}:${activeMind.id}`} agent={activeMind} ctx={ctx} />}
  </section> : <section className="pr-card pr-empty"><h2>This mind is no longer in view.</h2><p>Choose another mind from the list.</p><button type="button" className="pr-button" onClick={clearSelected}>Back to minds</button></section>
  else if (view === 'overview') content = <>
    <div className="pr-welcome"><div><p className="pr-eyebrow">Your workspace</p><h2>What needs your attention?</h2><p>Work with your minds, review decisions and move your tasks forward.</p></div><button type="button" className="pr-button pr-primary" onClick={() => byId('swarms.launch')}>Start a swarm</button></div>
    <div className="pr-metrics"><Metric label="Minds in view" value={ready ? minds.length : '—'} /><Metric label="Awake" value={ready ? awake : '—'} /><Metric label="Pending decisions" value={approvalsLoaded ? pending.length : '—'} /><Metric label="Active swarms" value={ready ? teams.filter((s) => !s.archived_at).length : '—'} /></div>
    <div className="pr-overview-grid"><section className="pr-card"><CardHead title="Needs your decision" action="View all" run={() => changeView('decisions')} />{decisionRows(4)}</section><section className="pr-card"><CardHead title="Minds" action="View all" run={() => changeView('minds')} />{mindRows(5)}</section><section className="pr-card"><CardHead title="Recent tasks" action="View all" run={() => changeView('goals')} />{goalRows(5)}</section><section className="pr-card"><CardHead title="Recent activity" action="View all" run={() => changeView('activity')} />{activityRows(5)}</section></div>
  </>
  else if (view === 'minds') content = <section className="pr-card"><CardHead title="Your minds" action="Create a mind" run={() => byId('minds.create')} />{mindRows()}</section>
  else if (view === 'swarms') content = <section className="pr-card"><CardHead title="Swarms" action="Start a swarm" run={() => byId('swarms.launch')} /><ul className="pr-rows">{teams.filter((s) => hit(`${shown(s.name)} ${s.id} ${shown(s.description)}`)).map((s) => <li key={s.id} data-presence-ref={presenceRef('swarm', s.id)}><button type="button" className="pr-row-main" onClick={() => { if (current(ctx) && useHive.getState().swarms[s.id]) navigate({ name: 'swarm', id: s.id, tab: 'members' }) }}><span className="pr-row-text"><strong>{shown(s.name)}</strong><small>{shown(s.description) || 'No purpose set'}</small></span><span className="pr-status">{s.archived_at ? 'Archived' : `${minds.filter((a) => a.swarm_id === s.id).length} minds`}</span></button></li>)}{!teams.length && <li className="pr-empty">No swarms in view yet.</li>}</ul></section>
  else if (view === 'goals') content = <><Motivations originCurrent={() => current(ctx)} className="pr-card pr-motivations" /><section className="pr-card" data-professional-region="swarm-purposes"><CardHead title="Swarm purposes" action="Swarms" run={() => changeView('swarms')} /><ul className="pr-rows">{teams.filter((s) => !s.archived_at).map((s) => <li key={s.id} data-presence-ref={presenceRef('swarm', s.id)}><span className="pr-row-text"><strong>{shown(s.name)}</strong><small>{shown(s.description) || 'This swarm has not set a purpose yet.'}</small></span></li>)}{!teams.some((s) => !s.archived_at) && <li className="pr-empty">Start a swarm and give it a purpose.</li>}</ul></section><CreateGoal key={ctx} ctx={ctx} /><section className="pr-card" data-professional-region="tasks"><CardHead title="Tasks" action="Open task view" run={() => navigate({ name: 'goals' })} />{goalRows()}</section></>
  else if (view === 'decisions') content = <section className="pr-card"><CardHead title="Waiting on you" action="History & rules" run={() => navigate({ name: 'approvals', tab: 'history' })} />{decisionRows()}</section>
  else if (view === 'apps') content = <><p className="pr-muted">Apps installed in this hive. Choose one to open its own workspace.</p>{programsError && <p className="pr-notice" role="alert">{programsError}</p>}{!programs && <p role="status" className="pr-muted">Loading apps…</p>}{appCards()}<button type="button" className="pr-button" onClick={() => navigate({ name: 'programs' })}>App settings, access & activity</button></>
  else if (view === 'activity') content = <section className="pr-card"><CardHead title="This session’s activity" action="Health" run={() => navigate({ name: 'health' })} />{activityRows()}</section>
  else if (view === 'future') content = <section className="pr-card pr-future"><p className="pr-eyebrow">Planned spaces</p><h2>Your Lab, your Home and OmegaTown</h2><p>Your personal research Lab and Omega companion will share the same work and conversations. A separate Home will support building, from treehouses to future cities.</p><p>OmegaTown’s “Bring to life” will upgrade that same world to a playable game shard inside the Hive.</p><p className="pr-muted">These spaces are on the roadmap. Professional does not create them yet.</p><button type="button" className="pr-button" onClick={() => byId('watch.lab')}>Open Lab</button><p className="pr-muted">The existing Lab runs tests and benchmarks.</p></section>
  else content = <div className="pr-tool-groups">{DIRECTORY.map(([group, rows]) => {
    const label = GROUP_LABEL[group]
    const items = rows.filter((f) => featureOffered(f, { admin: adminView, apps: programs }) && hit(`${publicLabel(f)} ${publicBlurb(f)} ${f.keywords ?? ''}`))
    if (!items.length) return null
    return <section key={group} className="pr-card"><div className="pr-card-head"><h2>{label}</h2></div><ul className="pr-tool-list">{items.map((f) => <li key={f.id}><button type="button" data-feature-id={f.id} data-presence-feature={f.id} disabled={!current(ctx) || !targetFor(f)} onClick={() => feature(f)}><span><strong>{publicLabel(f)}</strong><small>{publicBlurb(f)}</small></span><span aria-hidden="true">›</span></button>{!targetFor(f) && <p className="pr-muted">No UI yet</p>}</li>)}</ul></section>
  })}</div>

  return <>
    <div ref={stage} className="professional" style={TOKENS as CSSProperties} data-experience="professional" aria-hidden={covered || undefined}>
      <a className="pr-skip" href="#pr-main">Skip to workspace</a>
      <aside className="pr-sidebar" aria-label="Workspace navigation"><div className="pr-brand"><span aria-hidden="true">Ω</span><div><strong>{shown(hive?.name ?? 'OmegaHive')}</strong><small>Professional</small></div></div>
        <nav>{VIEWS.map((v) => <button key={v.id} type="button" ref={v.id === 'tools' ? toolsButton : undefined} aria-current={view === v.id ? 'page' : undefined} onClick={() => changeView(v.id)}><span>{v.label}</span>{v.id === 'decisions' && pending.length > 0 && <span className="pr-count">{pending.length}</span>}</button>)}
          {/* mind-chat r1: one step back to any mind's chat, in the nav row a phone keeps too */}
          <button type="button" data-presence-feature="talk.recent" onClick={() => byId('talk.recent')}>Recent conversations</button></nav>
        <div className="pr-sidebar-bottom"><button type="button" onClick={() => byId('people.me')}>Your profile</button>{adminView && <button type="button" onClick={() => byId('hive.settings')}>Settings</button>}<button type="button" onClick={() => openGallery(true)}>Change UI</button><button type="button" onClick={() => changeView('future')}>Future spaces</button></div>
      </aside>
      <div className="pr-workspace"><header className="pr-topbar"><div><p className="pr-eyebrow">{shown(hive?.name ?? 'Hive')}</p><h1 ref={heading} tabIndex={-1}>{selected && activeMind ? shown(activeMind.name) : VIEWS.find((v) => v.id === view)?.label ?? 'Future spaces'}</h1></div><div className="pr-topbar-actions"><span className="pr-connection" role="status">{connection === 'open' ? 'Connected' : connection === 'unauthorized' ? 'Sign in required' : connection === 'reconnecting' ? 'Reconnecting' : 'Connecting'}</span><button type="button" className="pr-button" onClick={() => openPalette()}>Search the hive</button><button type="button" className="pr-button" onClick={() => byId('minds.create')}>Create a mind</button></div></header>
        <main id="pr-main" tabIndex={-1} className="pr-main" data-professional-region="workspace">
          {bootError && <p className="pr-notice" role="alert">{bootError}</p>}{readError && <p className="pr-notice" role="alert">{readError} <button type="button" className="pr-link" onClick={refresh}>Refresh</button></p>}
          {view !== 'overview' && view !== 'future' && !selected && <div className="pr-view-tools"><label><span className="pr-sr">Filter {VIEWS.find((v) => v.id === view)?.label ?? 'Future spaces'}</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={view === 'tools' ? 'Find a tool, setting or feature…' : `Filter ${VIEWS.find((v) => v.id === view)?.label.toLowerCase() ?? view}…`} /></label><button type="button" className="pr-button" onClick={refresh}>Refresh</button></div>}
          {content}
          <footer className="pr-footer"><button type="button" className="pr-link" onClick={() => changeView('tools')}>Everything in this hive</button><button type="button" className="pr-link" onClick={() => byId('hive.help')}>Help</button><button type="button" className="pr-link" onClick={() => byId('money.usage')}>Usage & limits</button><span>Professional</span></footer>
        </main>
      </div>
    </div>
    {pick && <ScopedFeaturePicker key={`${ctx}:${pick.id}`} feature={pick} displayedOriginCurrent={displayedOriginCurrent} onClose={() => setPick(null)} restoreTo={() => toolsButton.current ?? heading.current} />}
    <AnimatePresence>{inspected?.kind === 'approval' && <ApprovalDecision key={`approval:${inspected.seen.id}`} seen={inspected.seen} session={inspected.session} onClose={() => setInspected(null)} restoreFocus={restore} />}{inspected?.kind === 'goal' && <GoalDecision key={`goal:${inspected.seen.id}`} seen={inspected.seen} to={inspected.to} session={inspected.session} onClose={() => setInspected(null)} restoreFocus={restore} />}</AnimatePresence>
  </>
}

function CardHead({ title, action, run }: { title: string; action: string; run: () => void }) {
  return <div className="pr-card-head"><h2>{title}</h2><button type="button" className="pr-link" onClick={run}>{action}</button></div>
}
function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="pr-metric"><span>{label}</span><strong>{value}</strong></div>
}
function CreateGoal({ ctx }: { ctx: string }) {
  const swarms = useHive((s) => s.swarms)
  const [swarm, setSwarm] = useState('')
  const [title, setTitle] = useDraft('professional:task:title')
  const [detail, setDetail] = useDraft('professional:task:detail')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const choices = Object.values(swarms).filter((s) => !s.archived_at).sort((a, b) => shown(a.name).localeCompare(shown(b.name)))
  const create = async () => {
    if (!current(ctx) || inFlight.current || uncertain || !title.trim() || !swarm) return
    const state = useHive.getState()
    if (!state.swarms[swarm] || state.swarms[swarm].archived_at) { setNotice('Choose a swarm that is still active.'); return }
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    try {
      const made = await state.createGoal(swarm, { title: title.trim(), detail: detail.trim(), priority: 0.5 })
      if (!current(ctx)) return
      if (made) { setTitle(''); setDetail(''); setNotice('The task was created.'); }
      else { setUncertain(true); setNotice('Creation was not confirmed. Check this swarm’s tasks before submitting another copy.'); }
    } finally { inFlight.current = false; if (current(ctx)) setBusy(false) }
  }
  // Kimi r1: the form never submits on its own (inert); Enter in the Task field is its own guarded key, first line
  // guardComposing (an input method's Enter never creates), and the Create button acts on its own click
  const onTaskKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (guardComposing(e)) return
    if (e.key !== 'Enter' || e.repeat) return
    e.preventDefault()
    void create()
  }
  return <section className="pr-card pr-goal-form"><div className="pr-card-head"><h2>Create a task</h2></div><form onSubmit={(e) => e.preventDefault()}>
    <div className="pr-form-fields"><label>Swarm<select value={swarm} onChange={(e) => setSwarm(e.target.value)} disabled={busy || uncertain}><option value="">Choose a swarm</option>{choices.map((s) => <option key={s.id} value={s.id}>{shown(s.name)}</option>)}</select></label><label>Task<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onKeyDown={onTaskKey} disabled={busy || uncertain} placeholder="What should this swarm do?" /></label></div>
    <label>Details<textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} disabled={busy || uncertain} placeholder="Context and what a good result looks like" /></label>
    <div className="pr-form-actions">{notice && <p role="status" className="pr-muted">{notice}</p>}{uncertain ? <button type="button" className="pr-button" onClick={() => { if (current(ctx) && useHive.getState().swarms[swarm]) navigate({ name: 'goals', swarm }) }}>Check swarm’s tasks</button> : <button type="button" className="pr-button pr-primary" onClick={() => void create()} disabled={busy || !current(ctx) || !title.trim() || !swarm || !swarms[swarm]}>{busy ? 'Creating…' : 'Create task'}</button>}</div>
  </form></section>
}
