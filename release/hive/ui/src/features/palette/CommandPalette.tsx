import { m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { hsl } from '../../lib/color'
import { useEscape, useIsDesktop } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { fuzzy } from '../../lib/fuzzy'
import { countPending } from '../../store/reducer'
import { useScene } from '../../scene/sceneStore'
import { useHive } from '../../store/store'
import { useIntro } from '../../tour/introStore'
import { Icon, type IconName } from '../../ui/Icon'
import { Kbd, Orb } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { openGallery, useLook } from '../../shell/uiVariant'
import { useModalContainment } from '../../ui/useModalContainment'
import { navCommandsFor, placeCommandsFor } from './navCommands'
import { goTo } from '../../shell/navGo'
import { useAdminView } from '../../lib/useAdmin'
import { useAskFillable } from '../ask/fields'
import { plural } from '../../lib/plural'
import { guardComposing } from '../../features/ask/keys'

interface Cmd {
  id: string
  group: 'Navigate' | 'Minds' | 'Swarms' | 'Actions'
  label: string
  hint?: string
  keywords?: string
  icon?: IconName
  lead?: ReactNode
  keys?: string[]
  run: () => void
  /** Only surfaced when the query matches (keeps the idle list short). */
  searchOnly?: boolean
}


export default function CommandPalette() {
  const setPalette = useHive((s) => s.setPalette)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const act = useHive((s) => s.agentAction)
  const pending = useHive((s) => countPending(s.approvals))
  const setStopAll = useHive((s) => s.setStopAll)
  const labSuites = useHive((s) => s.labSuites)
  const startLab = useHive((s) => s.startLab)
  const runAllLab = useHive((s) => s.runAllLab)
  const programs = useHive((s) => s.programs)
  const desktop = useIsDesktop()
  const lookAvailable = useLook().available
  // the palette navigates to exactly what this person's navigation reaches (members: no admin-only pages)
  // (members' view until the hive says an admin is signed in: lib/useAdmin adminViewOf)
  const { adminView } = useAdminView()
  // openPalette(query) opens with words already typed
  const [q, setQ] = useState(() => useHive.getState().paletteQuery)
  const [sel, setSel] = useState(0)
  // the Ask conductor may type a search here (results only show; nothing runs until the person picks one)
  useAskFillable('palette.search', 'Search the hive', 'search', (t) => {
    setQ(t)
    setSel(0)
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const close = () => setPalette(false)
  useEscape(close)
  useModalContainment(box)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [])

  const cmds = useMemo<Cmd[]>(() => {
    const go = (fn: () => void) => () => {
      close()
      fn()
    }
    const list: Cmd[] = [
      // every nav destination this person's navigation has, apps by name included, from the nav model itself
      // (shell/navItems.ts via navCommands.ts): the palette cannot miss one or name it differently
      ...navCommandsFor({ admin: adminView, apps: programs }).map((c): Cmd => ({ id: c.id, group: 'Navigate', label: c.label, icon: c.icon, keys: c.keys, keywords: c.keywords, hint: c.badge === 'pending' && pending ? `${pending} waiting` : c.route.name === 'program' ? 'app' : undefined, run: go(() => navigate(c.route)) })),
      // places inside those pages that have no entry of their own (Decision history, Archived swarms, Calls to settle…)
      ...placeCommandsFor({ admin: adminView, apps: programs }).map((c): Cmd => ({ id: c.id, group: 'Navigate', label: c.label, icon: c.icon, keywords: c.keywords, searchOnly: true, run: go(() => goTo(c.route, c.reveal)) })),
      // Add an outside agent is admin-only (navItems `connect`): a member's palette does not offer it either
      ...(adminView ? [{ id: 'connect', group: 'Actions' as const, label: 'Add an outside agent (Claude Code, Codex or any MCP client)', icon: 'plug' as const, keys: ['G', 'A'], keywords: 'outside agent harness invite join code mcp claude codex hermes connect remote external', run: go(() => navigate({ name: 'connect' })) }] : []),
      { id: 'launch', group: 'Actions', label: 'Start a swarm', icon: 'sparkles', keywords: 'team swarm group create launch new start research build debate', run: go(() => navigate({ name: 'launch' })) },
      { id: 'new', group: 'Actions', label: 'Create a new mind', icon: 'plus', keys: ['N'], keywords: 'add spawn birth', run: go(() => navigate({ name: 'new' })) },
      { id: 'stop-all', group: 'Actions', label: 'Stop all minds…', icon: 'power', keywords: 'kill switch emergency halt stop-all panic', run: go(() => setStopAll(true)) },
      ...(lookAvailable ? [{ id: 'change-ui', group: 'Actions' as const, label: 'Change experience: try a different experience, look or layout', icon: 'sparkles' as const, keywords: 'theme skin colour color layout dock top bar sidebar style appearance look design surface omegasurface reset default', run: go(() => openGallery(true)) }] : []),
      { id: 'tour', group: 'Actions', label: 'Replay the tour', icon: 'compass', hint: 'about 2 min', keywords: 'guide walkthrough intro help tutorial video onboarding learn', run: () => (close(), useIntro.getState().startTour({})) },
      { id: 'help', group: 'Actions', label: 'Help & shortcuts', icon: 'question', keys: ['?'], keywords: 'keys shortcuts help hotkeys', run: () => (close(), useIntro.getState().setHelp(true)) },
      { id: 'recenter', group: 'Actions', label: 'Recenter the camera', icon: 'locate', keywords: 'overview fit zoom', run: go(() => (navigate({ name: 'hive' }), useScene.getState().engine?.overview())) },
    ]
    for (const x of labSuites ?? []) {
      const running = x.last_run?.status === 'running'
      list.push({
        id: `lab-run-${x.id}`,
        group: 'Actions',
        label: `Run ${/^(Epistemic|Omega)/.test(x.title) ? x.title : x.title.charAt(0).toLowerCase() + x.title.slice(1)}`,
        icon: 'flask',
        searchOnly: true,
        hint: running ? 'running now' : !x.runnable ? 'unavailable' : x.kind === 'bench' ? 'benchmark' : 'tests',
        keywords: `lab ${x.id} ${x.kind === 'bench' ? 'benchmark bench' : 'tests test'} ${x.description}`,
        run: go(() => {
          if (x.runnable && !running) void startLab(x.id)
          navigate({ name: 'lab', suite: x.id })
        }),
      })
      list.push({ id: `lab-history-${x.id}`, group: 'Navigate', label: `${x.title} history`, icon: 'history', searchOnly: true, keywords: `lab trend ${x.id} ${x.kind}`, run: go(() => navigate({ name: 'lab', suite: x.id, tab: 'history' })) })
    }
    for (const p of programs ?? []) {
      if (!p.enabled) continue
      for (const s of Object.values(swarms))
        list.push({ id: `program-${p.id}-${s.id}`, group: 'Navigate', label: `Open ${shown(p.name)} in ${shown(s.name)}`, icon: 'apps', searchOnly: true, keywords: `program ${p.id} ${shown(s.name)}`, run: go(() => navigate({ name: 'program', id: p.id, swarm: s.id })) })
    }
    if (labSuites?.length) list.push({ id: 'lab-run-all', group: 'Actions', label: 'Run every test and benchmark', icon: 'flask', searchOnly: true, keywords: 'lab run all everything suites ci', run: go(() => (void runAllLab(), navigate({ name: 'lab' }))) })
    const sorted = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))
    for (const a of sorted) {
      list.push({
        id: `dot-${a.id}`,
        group: 'Minds',
        label: shown(a.name),
        hint: `${a.status} · ${a.swarm_id ? (swarms[a.swarm_id]?.name ?? '') : 'wanderer'}`,
        keywords: `${a.kind} ${a.model}`,
        lead: <Orb hue={a.hue} status={a.status} size={20} />,
        run: go(() => navigate({ name: 'dot', id: a.id })),
      })
      list.push({ id: `mind-${a.id}`, group: 'Minds', label: `Watch ${shown(a.name)} think`, icon: 'mind', searchOnly: true, keywords: `${shown(a.name)} mind trace timeline`, run: go(() => navigate({ name: 'dot', id: a.id, tab: 'mind' })) })
      if (a.status === 'awake' || a.status === 'starting')
        list.push({ id: `sleep-${a.id}`, group: 'Actions', label: `Sleep ${shown(a.name)}`, icon: 'moon', searchOnly: true, run: go(() => void act(a.id, 'sleep')) })
      if (a.status === 'asleep')
        list.push({ id: `wake-${a.id}`, group: 'Actions', label: `Wake ${shown(a.name)}`, icon: 'sun', searchOnly: true, run: go(() => void act(a.id, 'wake')) })
      if (a.status === 'stopped' || a.status === 'error' || a.status === 'created')
        list.push({ id: `start-${a.id}`, group: 'Actions', label: `Start ${shown(a.name)}`, icon: 'play', searchOnly: true, run: go(() => void act(a.id, 'start')) })
    }
    for (const s of Object.values(swarms)) {
      list.push({
        id: `swarm-${s.id}`,
        group: 'Swarms',
        label: shown(s.name),
        hint: plural(s.member_ids.length, 'mind'),
        lead: <span className="size-3 rounded-full" style={{ background: hsl(s.hue, 95, 68), boxShadow: `0 0 10px ${hsl(s.hue, 100, 60)}` }} />,
        run: go(() => navigate({ name: 'swarm', id: s.id })),
      })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, swarms, pending, labSuites, programs, lookAvailable, adminView])

  const results = useMemo(() => {
    const query = q.trim()
    const scored = cmds
      .filter((c) => query || !c.searchOnly)
      .map((c) => ({ c, s: query ? Math.max(fuzzy(query, c.label), fuzzy(query, `${c.keywords ?? ''} ${c.hint ?? ''}`) * 0.6) : 1 }))
      .filter((x) => x.s > 0)
    if (query) scored.sort((a, b) => b.s - a.s)
    const order = ['Navigate', 'Actions', 'Minds', 'Swarms']
    if (!query) scored.sort((a, b) => order.indexOf(a.c.group) - order.indexOf(b.c.group))
    return scored.map((x) => x.c).slice(0, 40)
  }, [cmds, q])

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKey = (e: KeyboardEvent) => {
    // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
    if (guardComposing(e)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(results.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      results[sel]?.run()
    }
  }

  let lastGroup = ''
  return (
    <m.div className="xc-dress xc-backdrop fixed inset-0 z-[55] flex items-start justify-center bg-[#03030c]/60 backdrop-blur-[2px] md:pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
      <m.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        initial={{ opacity: 0, y: desktop ? -12 : -30, scale: desktop ? 0.97 : 1 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 500, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
        className="xc-frame xc-flush-t glass-strong flex max-h-[80dvh] w-full flex-col overflow-hidden rounded-b-[24px] md:max-w-[600px] md:rounded-[22px]"
        style={desktop ? undefined : { paddingTop: 'var(--sat)' }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4" data-presence-region="search">
          <Icon name="search" size={19} className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={onKey}
            placeholder="Jump to a mind or swarm, or type a command…"
            // a search, not work: typing here never holds back an update's reload (shell/unsavedWork.ts)
            data-unsaved-ignore=""
            className="min-h-14 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-4"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[sel] ? `cmd-${results[sel].id}` : undefined}
            aria-autocomplete="list"
          />
          {desktop ? <Kbd>esc</Kbd> : <button onClick={close} className="min-h-11 px-1 text-sm text-ink-3">Cancel</button>}
        </div>
        <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" data-unsaved-ignore="" className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {results.length === 0 && <div className="px-3 py-10 text-center text-sm text-ink-3">Nothing matches “{q}”.</div>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {header && <div className="eyebrow px-3 pt-3 pb-1.5">{header}</div>}
                <div
                  id={`cmd-${c.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === sel}
                  onClick={c.run}
                  onPointerMove={() => setSel(i)}
                  className={cx('relative flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3', i === sel ? 'text-ink' : 'text-ink-2')}
                >
                  {i === sel && <m.span layoutId="palette-sel" className="absolute inset-0 rounded-xl border border-line-2 bg-tint/[0.08]" transition={{ type: 'spring', stiffness: 700, damping: 45 }} />}
                  <span className="relative flex w-6 justify-center text-ink-3">{c.lead ?? (c.icon && <Icon name={c.icon} size={18} />)}</span>
                  <span className="relative min-w-0 flex-1 truncate text-[14px]">{c.label}</span>
                  {c.hint && <span className="relative truncate text-[12px] text-ink-4">{c.hint}</span>}
                  {c.keys && desktop && (
                    <span className="relative flex gap-1">
                      {c.keys.map((k, ki) => (
                        <Kbd key={`${k}-${ki}`}>{k}</Kbd>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {desktop && (
          <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[11px] text-ink-4">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> run
            </span>
            <span className="ml-auto">Try “wake”, “sleep”, a mind or a swarm</span>
          </div>
        )}
      </m.div>
    </m.div>
  )
}
