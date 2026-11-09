import { plural } from '../../lib/plural'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { FEATURES, GROUP_LABEL, adminViewOf, askOrigin, countPending, featureOffered, navigate, openFeature, presenceRef, registerActHandler, shown, targetFor, useAskStore, useAskView, useAuthContext, useCovered, useHive, useHomeRequested, useMe, useReducedMotion, useResting, useRoomyLayout, useRoute, viewIsLive, type Feature, type PageView } from '../sdk'
import { contextOf, current, rememberPose, restorePose, type LocalPose } from './binding'
import { publicBlurb, publicLabel } from './nav'
import { TownScene, Robot } from './TownScene'
import { Motivations } from '../Motivations'
import { DIRECTORY } from '../directory'
import { publicActivityKind } from '../publicWords'
import { useWalking } from './movement'
import { PLACES, bounded, nearest, type PlaceId, type Point } from './world'
import { FURNITURE } from './chrome'
import './styles.css'

type View = 'residents' | 'teams' | 'work' | 'activity' | 'tools'
/**
 * The conductor's point and highlight targets on Town's always-visible directory tabs (lib/presence), as the other
 * experiences declare theirs. While the tools directory is open its own rows carry these ids, so the tabs step back.
 */
const TAB_FEATURE: Record<View, string | undefined> = { residents: 'minds.see', teams: 'swarms.see', work: 'work.goals', activity: 'watch.activity', tools: undefined }

/** One native store, plus reversible presentation. A scene node never becomes a Hive authority. */
export default function OmegaTown() {
  const state = useHive()
  useAuthContext(state.client)
  const ctx = contextOf(state)
  return <Town key={ctx} ctx={ctx} />
}

function Town({ ctx }: { ctx: string }) {
  const state = useHive()
  const route = useRoute()
  const self = useMe()
  const adminView = adminViewOf(self)
  const reduced = useReducedMotion()
  const roomy = useRoomyLayout()
  const resting = useResting((s) => s.resting)
  const root = useRef<HTMLDivElement>(null)
  const worldRoot = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const localViewVisit = useRef(0)
  const [displayedVisit, setDisplayedVisit] = useState(0)
  // Invalidate a retained export now, then guarantee a committed renewal even for unchanged navigation.
  const renewView = useCallback(() => { localViewVisit.current++; setDisplayedVisit(localViewVisit.current) }, [])
  const coveredByHost = useCovered(root)
  const [view, setView] = useState<View>('residents')
  const [q, setQuery] = useState('')
  const [readError, setReadError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [room, setRoom] = useState<PlaceId | null>(null)
  const [scope, setScope] = useState('')
  const [pick, setPick] = useState<Feature | null>(null)
  const [pose, setPose] = useState<LocalPose>(() => restorePose(ctx))

  const authorized = current(ctx)
  const hidden = route.name !== 'hive' || resting || !authorized
  const foregroundBlocked = hidden || coveredByHost || state.paletteOpen || state.stopAllOpen || !!state.reveal
  const blocked = foregroundBlocked || !!room || !!pick
  useEffect(() => { if (root.current) root.current.inert = hidden }, [hidden])
  const onPoint = useCallback((p: Point) => { if (current(ctx)) setPose((old) => ({ ...old, ...p })) }, [ctx])
  const walking = useWalking({ ctx, enabled: !blocked, reduced, root: worldRoot, point: pose, onPoint })
  useEffect(() => { rememberPose(ctx, pose) }, [ctx, pose])
  useEffect(() => { if (blocked) walking.stop() }, [blocked, walking])
  // a surface's X lands on the town itself (home:requested): no place entered, no pick, the residents view
  useHomeRequested(() => { if (!current(ctx)) return; renewView(); walking.stop(); setView('residents'); setQuery(''); setPick(null); setRoom(null); setSelected(null) })

  const residents = useMemo(() => Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id)), [state.agents])
  const teams = useMemo(() => Object.values(state.swarms).sort((a, b) => a.id.localeCompare(b.id)), [state.swarms])
  const teamIds = teams.map((s) => s.id).join('\u0001')
  // Reuse native store readers; no direct client/fetch, duplicate cache or owner data writes.
  useEffect(() => {
    if (!state.ready || !current(ctx)) return
    let showing = true
    const live = useHive.getState()
    void Promise.allSettled([live.loadApprovals(), live.loadPrograms(), ...Object.keys(live.swarms).map((id) => live.loadGoals(id))]).then((answers) => {
      if (showing && current(ctx)) setReadError(answers.some((answer) => answer.status === 'rejected'))
    })
    return () => { showing = false }
  }, [ctx, state.ready, teamIds])
  const work = useMemo(() => Object.values(state.goals).filter((g) => !!state.swarms[g.swarm_id]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [state.goals, state.swarms])
  const liveResident = selected ? state.agents[selected] : undefined
  const place = PLACES.find((p) => p.id === room)
  const near = nearest(pose)
  // Me.person is the existing native exact association, not a People/name/role match.
  // The key above remounts this canonical reader on session/init as well as auth changes.
  const person = authorized ? self.me?.person : null
  const visitor = person?.id ? { id: person.id, label: shown(person.name) || person.id } : null
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const featureGroups = useMemo(() => {
    const groups = new Map<string, Feature[]>()
    for (const [, rows] of DIRECTORY) for (const f of rows) if (featureOffered(f, { admin: adminView, apps: state.programs }) && hit(`${publicLabel(f)} ${publicBlurb(f)} ${f.keywords ?? ''}`)) groups.set(f.group, [...(groups.get(f.group) ?? []), f])
    return [...groups]
    // Query is the only local input; FEATURES is the canonical static registry.
  }, [q, adminView, state.programs])
  const rawHash = typeof window === 'undefined' ? '' : window.location.hash
  const displayedLocalVisit = displayedVisit
  const residentRefs = [...new Set([...(selected && state.agents[selected] ? [selected] : []), ...residents.slice(0, 8).map((a) => a.id)])]
  const teamRefs = teams.slice(0, 6).map((s) => s.id)
  const refSignature = JSON.stringify([residentRefs, teamRefs])
  const exported: PageView | null = hidden ? null : {
    title: 'OmegaTown',
    refs: [
      ...residentRefs.map((id) => ({ kind: 'mind' as const, ref: id })),
      ...teams.slice(0, 6).map((s) => ({ kind: 'swarm' as const, ref: s.id })),
      { kind: 'feature' as const, ref: 'build.code' }, { kind: 'feature' as const, ref: 'apps.open' },
      { kind: 'feature' as const, ref: 'decide.approvals' }, { kind: 'feature' as const, ref: 'work.goals' },
    ],
    acts: [],
    regions: ['town-world', 'town-directory', ...PLACES.map((p) => `town-place-${p.id}`)],
    summary: `${plural(residents.length, 'authorized resident')}, ${plural(teams.length, 'swarm')}. Walking is a local view. Native tools remain directly available.`,
  }
  // One exporter for this experience, and an event-time origin guard before the effect cleanup can run.
  const viewCurrent = useCallback(() => {
    const live = useHive.getState()
    return current(ctx) && viewIsLive(root.current) && window.location.hash === rawHash && route.name === 'hive' && localViewVisit.current === displayedLocalVisit && residentRefs.every((id) => !!live.agents[id]) && teamRefs.every((id) => !!live.swarms[id])
  }, [ctx, rawHash, route.name, displayedLocalVisit, refSignature])
  useAskView('omegatown', exported, viewCurrent)

  const changeView = (next: View) => { if (!current(ctx)) return; renewView(); walking.stop(); setView(next); setQuery(''); setPick(null); setRoom(null) }
  const showResident = (id: string) => { if (!current(ctx) || !useHive.getState().agents[id]) return; renewView(); walking.stop(); setSelected(id); setView('residents'); setRoom(null); setPick(null); heading.current?.focus({ preventScroll: true }) }
  const enter = useCallback((id: PlaceId) => { if (!current(ctx)) return; renewView(); walking.stop(); setRoom(id); setPick(null); setScope('') }, [ctx, renewView, walking])
  const go = (f: Feature, mind?: string, swarm?: string) => {
    if (!current(ctx)) return
    const fresh = FEATURES.find((row) => row.id === f.id)
    if (!fresh || !featureOffered(fresh, { admin: adminView, apps: useHive.getState().programs })) return
    const t = targetFor(fresh)
    const live = useHive.getState()
    if (t?.kind === 'mind' && (!mind || !live.agents[mind])) { walking.stop(); setPick(fresh); return }
    if (t?.kind === 'swarm' && (!swarm || !live.swarms[swarm])) { walking.stop(); setPick(fresh); return }
    walking.stop(); setPick(null)
    openFeature(fresh, mind, swarm)
    if (t?.kind === 'home') changeView(fresh.id === 'watch.activity' ? 'activity' : 'residents')
  }
  const feature = (id: string) => { const f = FEATURES.find((item) => item.id === id); if (f) go(f) }
  // Resolve a tool only inside the native click. Rendering the directory never invokes a ref-capturing action.
  const chooseTool = (event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.featureId
    if (id) feature(id)
  }
  // Jon, 2026-10-08: "Residents use their own voice, ask is essentially me." Talking to a resident opens that mind's
  // own chat (its own voice); the Universal Ask stays the person's and never speaks for, or as, a resident.
  const talk = (id: string) => {
    const agent = useHive.getState().agents[id]
    if (!current(ctx) || !agent) return
    walking.stop()
    if (agent.kind === 'module') { navigate({ name: 'dot', id, tab: 'model' }); return }
    if (agent.kind === 'omega' || agent.kind === 'iter') navigate({ name: 'dot', id, tab: 'chat' })
  }
  // Existing typed fast-path handler: Code can be entered as local scenery before opening its native picker.
  useEffect(() => {
    let active: ReturnType<typeof askOrigin> | null = null
    const unsubscribe = useAskStore.subscribe(() => {
      if (active && !active.ok()) { walking.stop(); active = null }
    })
    const unregister = registerActHandler('omegatown', async (act) => {
      if (act.do !== 'feature' || act.id !== 'build.code') return false
      const origin = askOrigin()
      const live = useHive.getState()
      if (foregroundBlocked || live.paletteOpen || live.stopAllOpen || live.reveal || !viewCurrent() || !origin.ok()) return 'keep'
      // Rooms/pickers stop walking, but an explicit Ask may use the ordinary native Code destination.
      if (room || pick) return false
      // A new task waits for the submitting key's window listener; a microtask can run between listeners.
      // Keep typing/focus cancellation intact, and recheck the captured origin after the event has propagated.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (blocked || !viewCurrent() || !origin.ok()) return 'keep'
      active = origin
      const started = walking.walkTo(PLACES.find((p) => p.id === 'code')!.point, { conductor: true, onArrival: () => {
        if (active !== origin) return
        active = null
        if (origin.ok() && viewCurrent()) enter('code')
      } })
      if (!started && active === origin) active = null
      return started
    })
    return () => { unregister(); unsubscribe(); if (active) walking.stop(); active = null }
  }, [blocked, foregroundBlocked, room, pick, viewCurrent, walking, enter])

  // A declared on-screen native conductor point may move only this local visitor and room.
  // No act vocabulary, host acknowledgement or native app operation is invented here.
  useEffect(() => {
    let seen = useAskStore.getState().presence.at(-1)?.id
    let active: string | null = null
    const holds = (op: string) => {
      const s = useAskStore.getState(), turn = s.turns[op]
      return !blocked && viewCurrent() && s.open === op && turn?.state === 'open' && !turn.tookOver
    }
    const unsubscribe = useAskStore.subscribe((s) => {
      if (active && !holds(active)) { walking.stop(); active = null }
      const item = s.presence.at(-1)
      if (!item || item.id === seen) return
      seen = item.id
      if (item.verb !== 'point' || !holds(item.op)) return
      const destination = PLACES.find((p) => item.target.region === `town-place-${p.id}` || (item.target.entity?.kind === 'room' && item.target.entity.ref === `town-place-${p.id}`) || (p.id === 'code' && item.target.feature === 'build.code'))
      if (!destination) return
      active = item.op
      walking.walkTo(destination.point, { conductor: true, onArrival: () => {
        if (active === item.op && holds(item.op)) enter(destination.id)
        active = null
      } })
    })
    return () => { unsubscribe(); if (active) walking.stop(); active = null }
  }, [blocked, viewCurrent, walking, enter])
  const openSpecialist = () => {
    if (!place || !current(ctx)) return
    walking.stop()
    if (place.id === 'code') { navigate({ name: 'code' }); return } // Real Code target/workspace picker; never Agent.id.
    if (place.id !== 'design') return
    const live = useHive.getState()
    const program = live.programs?.find((p) => p.id === 'omegadesign')
    // No program name heuristic, automatic first team or implied workspace/source revision.
    if (!program?.enabled || program.error || !scope || !live.swarms[scope]) return
    navigate({ name: 'program', id: program.id, swarm: scope })
  }
  const programId = room === 'design' ? 'omegadesign' : null
  const program = programId ? state.programs?.find((p) => p.id === programId) : null

  if (!authorized) return <div className="omegatown ot-connecting" role="status">{state.connection === 'unauthorized' ? 'Sign in to see your town.' : state.bootError ? 'The Hive could not be read. Open the native connection screen to check it.' : 'Connecting your town to the Hive…'}</div>
  return <div ref={root} className={`omegatown${roomy ? ' ot-roomy' : ''}`} style={FURNITURE as CSSProperties} data-town-covered={blocked ? 'true' : undefined} aria-hidden={hidden || undefined}>
    <header className="ot-hud">
      <div><span className="ot-eyebrow">Inhabited intelligence</span><h1>{shown(state.hive?.name ?? 'OmegaTown')}</h1><p>People, minds and useful work, in one living workspace.</p></div>
      <nav aria-label="Town controls"><button type="button" onClick={() => changeView('tools')}>All tools</button><button type="button" data-presence-feature="talk.recent" onClick={() => feature('talk.recent')}>Recent conversations</button><button type="button" data-presence-feature="decide.approvals" onClick={() => feature('decide.approvals')}>Decisions <span>{countPending(state.approvals)}</span></button><button type="button" data-presence-feature="hive.changeui" onClick={() => feature('hive.changeui')}>Change experience</button></nav>
      <p role="status" className="ot-connection">{state.connection === 'open' ? 'Connected to Hive' : 'Reconnecting · showing the last authorized view'}</p>
    </header>
    <div className="ot-layout">
      <main className="ot-world-panel" data-presence-region="town-world">
        <div className="ot-world-toolbar"><strong>{visitor ? `${visitor.label}’s character` : 'Local visitor'}</strong><span>{visitor ? 'Linked to your native profile' : !self.loaded ? 'Reading your profile…' : self.me ? 'This session has no linked person character' : 'Your profile is unavailable here'}</span>
          <label>Coat <select aria-label="Character coat" value={pose.coat} onChange={(e) => { if (current(ctx)) setPose((old) => ({ ...old, coat: e.target.value as LocalPose['coat'] })) }}><option value="amber">Amber</option><option value="fern">Fern</option><option value="violet">Violet</option></select></label>
          <label>Building look <select value={pose.kit} onChange={(e) => { if (current(ctx)) setPose((old) => ({ ...old, kit: e.target.value as LocalPose['kit'] })) }}><option value="woodland">Woodland</option><option value="modern">Modern</option><option value="future">Year 4000</option></select></label>
        </div>
        <div ref={worldRoot} data-native-person-id={visitor?.id}>
          <TownScene agents={residents} swarms={teams} pose={pose} selected={selected} onResident={showResident} onPlace={enter} onWalk={walking.walkTo} walkingEnabled={!blocked} visitorLabel={visitor?.label ?? 'Local visitor'} />
        </div>
        <div className="ot-walking-tools" data-xc-keep-clear=""><span aria-live="polite">Position {Math.round(pose.x)}, {Math.round(pose.y)}{near ? ` · Near ${near.label}` : ''}</span><button type="button" onClick={() => { walking.stop(); worldRoot.current?.querySelector<HTMLElement>('[data-town-walk]')?.focus() }}>Walk with keyboard</button><button type="button" onClick={walking.stop}>Stop walking</button><button type="button" disabled={!near} onClick={() => near && enter(near.id)}>Enter nearby place</button></div>
        <div className="ot-touch-pad" role="group" aria-label="Move your character" data-xc-keep-clear="">{([{ label: 'Move up', x: 0, y: -22, glyph: '↑' }, { label: 'Move left', x: -22, y: 0, glyph: '←' }, { label: 'Move down', x: 0, y: 22, glyph: '↓' }, { label: 'Move right', x: 22, y: 0, glyph: '→' }]).map((step) => <button type="button" key={step.label} aria-label={step.label} disabled={blocked} onClick={() => { if (current(ctx) && !blocked) { walking.stop(); onPoint(bounded({ x: pose.x + step.x, y: pose.y + step.y })) } }}>{step.glyph}</button>)}</div>
        <p className="ot-caption">Tap a movement arrow, click the ground to walk, or focus the town and use WASD / arrows. Typing, dialogs and covered pages stop movement. Reduced motion uses direct steps. All tools work without walking.</p>
      </main>
      <aside className="ot-sidebar" aria-label="Direct town directory" data-presence-region="town-directory">
        {readError && <p role="status">Some information couldn’t be read. Its native page can help you check it.</p>}
        <nav className="ot-tabs" aria-label="Directory views">{(['residents','teams','work','activity','tools'] as View[]).map((id) => <button type="button" key={id} data-presence-feature={view === 'tools' && !room && !pick ? undefined : TAB_FEATURE[id]} aria-current={view === id && !room ? 'page' : undefined} onClick={() => changeView(id)}>{id === 'work' ? 'Work' : id === 'tools' ? 'All tools' : id === 'teams' ? 'Swarms' : id[0].toUpperCase()+id.slice(1)}</button>)}</nav>
        {room && place ? <section className="ot-room" aria-label={place.label}>
          <span className="ot-eyebrow">Inside the same world</span><h2 tabIndex={-1}>{place.label}</h2><p>{place.copy}</p><div className={`ot-interior ot-interior-${room}`} data-art-content="local-room"><span aria-hidden="true">{room === 'code' ? '⌘' : room === 'design' ? '✦' : '◇'}</span><i /><i /><i /></div>
          {room === 'design' && <><p>{state.programs === null ? 'Reading available apps…' : !program ? 'This app isn’t available here yet.' : !program.enabled || program.error ? 'This app isn’t ready to open.' : 'Choose the exact swarm for this visit.'}</p><label>Swarm<select value={scope} onChange={(e) => { if (current(ctx)) setScope(e.target.value) }}><option value="">Choose a swarm…</option>{teams.map((s) => <option key={s.id} value={s.id}>{shown(s.name)}</option>)}</select></label><button type="button" disabled={!program?.enabled || !!program.error || !scope || !state.swarms[scope]} onClick={openSpecialist}>Open native Design</button><button type="button" onClick={() => feature('apps.list')}>All apps</button></>}
          {room === 'code' && <button type="button" onClick={openSpecialist}>Choose a Code workspace</button>}
          {room === 'hall' && <><Motivations originCurrent={() => current(ctx)} className="ot-record" /><button type="button" onClick={() => changeView('work')}>Motivations and Tasks</button>{adminView && <button type="button" onClick={() => feature('work.boards')}>Task views</button>}<button type="button" onClick={() => feature('decide.approvals')}>Decisions</button></>}
          {(room === 'house' || room === 'personal-lab') && <><p>Your personal place and Omega aren’t connected yet. This room previews where they will belong.</p><button type="button" onClick={() => feature('people.me')}>Your native profile</button><p>Full building tools, physics, multiplayer, Bring to life and SAIL are planned.</p></>}
          <button type="button" onClick={() => { if (!current(ctx)) return; renewView(); setRoom(null); walking.stop(); worldRoot.current?.querySelector<HTMLButtonElement>(`[aria-label="Enter ${place.label}"]`)?.focus({ preventScroll: true }) }}>Back to town</button>
        </section> : <>
          <h2 ref={heading} tabIndex={-1}>{view === 'tools' ? 'Every Hive tool' : view === 'work' ? 'Motivations and Tasks' : view === 'activity' ? 'Native activity' : view === 'teams' ? 'Swarm districts' : 'Residents'}</h2>
          <label className="ot-search">Find {view === 'tools' ? 'a tool' : 'an exact resident or swarm'}<input value={q} onChange={(e) => { if (current(ctx)) setQuery(e.target.value) }} placeholder="Search this directory" /></label>
          {pick ? <section className="ot-scope"><h3>{publicLabel(pick)}: choose {targetFor(pick)?.kind === 'swarm' ? 'a swarm' : 'a mind'}</h3>{targetFor(pick)?.kind === 'swarm' ? teams.map((s) => <button type="button" key={s.id} onClick={() => go(pick, undefined, s.id)}>{shown(s.name)} <small>{s.id}</small></button>) : residents.map((a) => <button type="button" key={a.id} onClick={() => go(pick, a.id)}>{shown(a.name)} <small>{a.id}</small></button>)}<button type="button" onClick={() => { if (current(ctx)) setPick(null) }}>Cancel selection</button></section> : view === 'tools' ? featureGroups.map(([group, rows]) => <section key={group}><h3>{GROUP_LABEL[group as Feature['group']]}</h3>{rows.map((f) => <button type="button" key={f.id} data-feature-id={f.id} data-presence-feature={f.id} className="ot-tool" disabled={!targetFor(f)} onClick={chooseTool}><strong>{publicLabel(f)}</strong><span>{publicBlurb(f)}</span><small>{targetFor(f)?.kind === 'mind' ? 'Choose mind' : targetFor(f)?.kind === 'swarm' ? 'Choose swarm' : targetFor(f) ? 'Native destination' : 'Not built yet'}{f.money ? ' · Budget rules apply' : ''}</small></button>)}</section>) : view === 'residents' ? <>
            {liveResident && <section className="ot-selected-card"><Robot module={liveResident.kind === 'module'} /><h3>{shown(liveResident.name)}</h3><p>{liveResident.kind} · {liveResident.status} · {liveResident.connected ? 'connected' : 'not connected'}</p><small>{liveResident.id}</small><button type="button" onClick={() => talk(liveResident.id)}>{liveResident.kind === 'module' ? 'Open this module' : `Talk to ${shown(liveResident.name)}`}</button><button type="button" onClick={() => { const f = FEATURES.find((item) => item.id === (liveResident.kind === 'module' ? 'minds.inventory' : 'minds.wake')); if (f) go(f, liveResident.id) }}>{liveResident.kind === 'module' ? 'Native module controls' : 'Native mind controls'}</button><p>{liveResident.kind === 'module' ? 'Modules are not chatting minds. Open their native controls and tools here.' : 'Talk opens this mind’s own chat, in its own voice. The Ask below is yours.'}</p></section>}
            {!residents.length && <p>No residents are visible in this authorized view yet.</p>}{residents.filter((a) => hit(`${a.id} ${shown(a.name)} ${a.kind} ${a.status}`)).map((a) => <button type="button" key={a.id} data-presence-ref={presenceRef('mind', a.id)} className="ot-directory-row" onClick={() => showResident(a.id)}><strong>{shown(a.name)}</strong><span>{a.kind} · {a.status}{a.kind !== 'omega' ? ` · ${a.connected ? 'connected' : 'not connected'}` : ''}</span><small>{a.id}</small></button>)}
          </> : view === 'teams' ? <>{!teams.length && <p>No swarms are visible yet.</p>}{teams.filter((s) => hit(`${s.id} ${shown(s.name)}`)).map((s) => <section key={s.id} data-presence-ref={presenceRef('swarm', s.id)} className="ot-record"><h3>{shown(s.name)}</h3><p>{s.archived_at ? 'Archived · history retained' : 'Current swarm'} · {s.member_ids.filter((id) => !!state.agents[id]).length} visible members</p><small>{s.id}</small><button type="button" onClick={() => { if (current(ctx) && useHive.getState().swarms[s.id]) navigate({ name:'swarm', id:s.id }) }}>Open exact swarm</button></section>)}</> : view === 'work' ? <><Motivations originCurrent={() => current(ctx)} className="ot-record" /><button type="button" onClick={() => feature('work.goals')}>Open Tasks</button>{adminView && <button type="button" onClick={() => feature('work.boards')}>Task views</button>}<h3>Swarm purposes</h3>{teams.map((s) => <section key={s.id} data-presence-ref={presenceRef('swarm', s.id)} className="ot-record"><h4>{shown(s.name)}</h4><p>{shown(s.description) || 'No purpose is recorded yet.'}</p><button type="button" onClick={() => { if (current(ctx) && useHive.getState().swarms[s.id]) navigate({ name:'swarm', id:s.id }) }}>Open this swarm</button></section>)}<h3>Tasks</h3><p>Native task IDs and state are shown here. Task text and app records stay in their workspace.</p>{teams.some((s) => !state.goalsLoaded[s.id]) && <p>Some swarm work has not been read yet.</p>}{work.map((g) => <section key={g.id} data-presence-ref={presenceRef('goal', g.id)} className="ot-record"><h3>Task · {g.status}</h3><small>{g.id}</small><button type="button" onClick={() => { const fresh = useHive.getState().goals[g.id]; if (current(ctx) && fresh?.swarm_id === g.swarm_id) navigate({ name:'goals', swarm:g.swarm_id, goal:g.id }) }}>Open exact work</button></section>)}</> : <><p>Native event kind and time only. Scenery is separate from this activity.</p>{state.activity.slice(0, 25).map((a) => <p className="ot-record" key={a.id}>{publicActivityKind(a.kind)} <time dateTime={a.at}>{a.at}</time></p>)}<button type="button" onClick={() => feature('watch.health')}>Health</button></>}
        </>}
        <footer><button type="button" onClick={() => feature('minds.create')}>New mind</button><button type="button" onClick={() => feature('swarms.launch')}>Start a swarm</button><button type="button" disabled title="Full game installation and world continuity are planned">Bring to life · planned</button><small>House, Sophia AI Lab and personal Omega are separate future links. Benchmark Lab stays in All tools.</small></footer>
      </aside>
    </div>
  </div>
}
