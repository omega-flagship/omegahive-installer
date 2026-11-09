import { useVisibleAuthority, visibleOwner } from '../../lib/useVisibleAuthority'
import { plural } from '../../lib/plural'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, m, useIsPresent } from 'framer-motion'
import { BeliefSentence, beliefText, closeToHome, compareSureness, PlainText, plainText, countPending, GoalDecision, hsl, openClassic, openPalette, shown, useHive, useReducedMotion, type Agent, type Goal } from '../sdk'
import { statusWord, type CosmosLayout } from './layout'
import { deckGroups, runFeature, COSMOS_NATIVE, type DeckPage } from './nav'
import { Bar, BeliefRow, Holo, Orb } from './Panels'
import { useCosmos } from './state'
import { makeMind } from '../../lib/makeMind'
import { creatorLine, isUnsorted, ownerLine, PARTIAL_WORDS, progressOf, sortMotivations, STATUS_WORDS, tasksOf, useCountsPartial, useMotivationData, WORDS } from '../../lib/motivations'
import { useMe } from '../../lib/useAdmin'
import type { Motivation, MotivationRef } from '../../api/types'

type Hive = ReturnType<typeof useHive.getState>
type ActivityItem = Hive['activity'][number]

const pad = (n: number, w = 2) => String(Math.max(0, Math.round(n))).padStart(w, '0')
const clock = (iso: string | null | undefined) => {
  if (!iso) return '--:--'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5)
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(5, 10).replace('-', '.') : '')
const money = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`

const goalDeckOwner = visibleOwner(useCosmos, s => JSON.stringify([s.deck, s.deckSwarm, s.deckMotivation, s.deckTab, s.pickFor]), key => JSON.parse(key)[0] === 'goals')
export const useCosmosGoalAuthority = () => useVisibleAuthority('hive-pro', useIsPresent(), 'cosmos-task-deck', goalDeckOwner)

const TITLES: Record<DeckPage, string> = {
  index: 'Flight deck',
  minds: 'Worlds',
  beliefs: 'Beliefs',
  motivations: WORDS.motivations,
  goals: WORDS.tasks,
  decisions: 'Decision log',
  activity: 'Live signal',
  create: 'Seed a mind',
  usage: 'Fuel and spend',
  help: 'Field manual',
}
const HUES: Record<DeckPage, number> = { index: 205, minds: 205, beliefs: 212, motivations: 130, goals: 168, decisions: 38, activity: 190, create: 205, usage: 45, help: 220 }

export function Deck({ layout, desktop }: { layout: CosmosLayout; desktop: boolean }) {
  const page = useCosmos((s) => s.deck)
  const setDeck = useCosmos((s) => s.setDeck)
  if (!page) return null
  const hue = HUES[page]
  return (
    <Holo
      hue={hue}
      label={TITLES[page]}
      side={desktop ? 'right' : 'bottom'}
      className="fixed z-30"
      style={desktop ? { top: 132, left: 20, bottom: 'max(76px, var(--ask-room, 0px))', width: 'min(460px, calc(100vw - 40px))' } : { top: 64, left: 0, right: 0, bottom: 'var(--os-clock-lift, 0px)', borderLeft: 0, borderRight: 0, borderBottom: 0 }}
    >
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-3">
        {page !== 'index' && (
          <button className="cx-icon-btn cx-icon-sm shrink-0" aria-label="Back to the flight deck" onClick={() => setDeck('index')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="cx-mono text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.2em' }}>
            {page === 'index' ? 'EVERYTHING IN THE HIVE' : 'FLIGHT DECK'}
          </div>
          <h2 className="cx-wide truncate text-[15px]" style={{ color: '#fff', letterSpacing: '0.34em' }}>
            {TITLES[page]}
          </h2>
        </div>
        <button className="cx-icon-btn cx-icon-sm shrink-0" aria-label="Close the flight deck" onClick={closeToHome}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </header>
      <div className="cx-rule" />
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={page} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
          {page === 'index' && <Index layout={layout} desktop={desktop} />}
          {page === 'minds' && <Minds layout={layout} desktop={desktop} />}
          {page === 'beliefs' && <Beliefs />}
          {page === 'motivations' && <Motivations />}
          {page === 'goals' && <Goals />}
          {page === 'decisions' && <Decisions />}
          {page === 'activity' && <Activity desktop={desktop} />}
          {page === 'create' && <Create desktop={desktop} />}
          {page === 'usage' && <Usage />}
          {page === 'help' && <Help />}
        </m.div>
      </AnimatePresence>
    </Holo>
  )
}

/** A scrolling body that keeps its last line clear of Ω on phones. */
function Body({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cx-scroll min-h-0 flex-1 px-4 pt-3 pb-[calc(max(64px,var(--ask-room,0px))+var(--sab,0px))] [@media(min-width:768px)_and_(min-height:560px)]:pb-4 ${className}`}>{children}</div>
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="cx-mono mb-1.5 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.2em' }}>
      {children}
    </div>
  )
}

function Field({ value, onChange, placeholder, label, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; autoFocus?: boolean }) {
  return (
    <label className="cx-composer flex items-center gap-2 border px-3 py-2" style={{ borderColor: 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)' }}>
      <span className="sr-only">{label}</span>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden style={{ color: 'var(--cx-ink-3)' }}>
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <input className="cx-input cx-selectable !text-[14px]" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
    </label>
  )
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
      {options.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)} className="cx-caps border px-2.5 py-1.5 text-[10px]" style={{ letterSpacing: '0.18em', borderColor: value === k ? 'var(--cx-accent)' : 'var(--cx-line)', color: value === k ? '#fff' : 'var(--cx-ink-2)', background: value === k ? 'rgba(124,196,255,0.14)' : 'transparent' }}>
          {l}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ index: everything */

function Index({ layout, desktop }: { layout: CosmosLayout; desktop: boolean }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => deckGroups(q), [q])
  const pending = useHive((s) => countPending(s.approvals))
  return (
    <>
      <div className="px-4 pt-3">
        <div className="mb-2.5 grid grid-cols-2 gap-2">
          <button data-sweep="new-swarm" className="cx-btn cx-btn-hue !justify-start !px-3" style={{ ['--cx-hue' as string]: '#ffc36b' }} onClick={() => openClassic({ name: 'launch' })}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: 'radial-gradient(circle, #fff, #ffc36b 60%)', boxShadow: '0 0 8px #ffc36b' }} />
            Start a swarm
          </button>
          <button data-sweep="new-mind" className="cx-btn cx-btn-hue !justify-start !px-3" style={{ ['--cx-hue' as string]: '#7cc4ff' }} onClick={() => useCosmos.getState().setDeck('create')}>
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: '#7cc4ff' }} />
            Seed a mind
          </button>
        </div>
        <Field value={q} onChange={setQ} placeholder="Find anything: memory, budget, people, flows…" label="Find a feature" autoFocus={desktop} />
      </div>
      <Body>
        {groups.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>
            No signal for “{q}”.
          </p>
        )}
        {groups.map(([g, label, list]) => (
          <section key={g} aria-label={label} className="mb-3">
            <h3 className="cx-mono flex items-center gap-2 pt-1 pb-1.5 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.24em' }}>
              {label.toUpperCase()}
              <span className="h-px flex-1" style={{ background: 'var(--cx-line)' }} />
            </h3>
            <ul>
              {list.map((f) => {
                const here = COSMOS_NATIVE.includes(f.id)
                const badge = f.id === 'decide.approvals' && pending ? pad(pending) : null
                return (
                  <li key={f.id}>
                    <button data-feature={f.id} data-presence-feature={f.id} onClick={() => runFeature(f, layout, desktop)} className="group flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-white/[0.05]">
                      <span aria-hidden className="grid size-5 shrink-0 place-items-center">
                        {here ? <span className="size-1.5 rounded-full" style={{ background: 'var(--cx-accent)', boxShadow: '0 0 8px var(--cx-accent)' }} /> : <span className="size-1.5 rotate-45 border" style={{ borderColor: 'var(--cx-ink-3)' }} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px]" style={{ color: 'var(--cx-ink)' }}>
                          {f.label}
                        </span>
                        <span className="block truncate text-[12px]" style={{ color: 'var(--cx-ink-3)' }}>
                          {f.blurb}
                        </span>
                      </span>
                      {badge && (
                        <span className="cx-mono px-1.5 text-[11px]" style={{ background: 'var(--cx-amber)', color: '#1a1000', fontWeight: 600 }}>
                          {badge}
                        </span>
                      )}
                      <span className="cx-mono shrink-0 text-[9.5px]" style={{ color: here ? 'var(--cx-accent)' : 'var(--cx-ink-3)', letterSpacing: '0.18em' }}>
                        {here ? 'HERE' : 'PAGE ↗'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </Body>
    </>
  )
}

/* ------------------------------------------------------------ worlds: every mind */

const TAB_NAME: Record<string, string> = { memory: 'memory', schedule: 'wakeups', model: 'model and key', mind: 'record', chat: 'conversation' }

function Minds({ layout, desktop }: { layout: CosmosLayout; desktop: boolean }) {
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const act = useHive((s) => s.agentAction)
  const pickFor = useCosmos((s) => s.pickFor)
  const go = useCosmos((s) => s.go)
  const setDeck = useCosmos((s) => s.setDeck)
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (a: Agent) => words.every((w) => `${a.name} ${a.model} ${a.status}`.toLowerCase().includes(w))
    const out: { id: string; name: string; hue: number; minds: Agent[] }[] = layout.systems.map((s) => ({ id: s.id, name: shown(s.name), hue: s.hue, minds: s.members.map((id) => agents[id]).filter((a): a is Agent => !!a && hit(a)) }))
    const drift = layout.planets.filter((p) => !p.systemId).map((p) => agents[p.id]).filter((a): a is Agent => !!a && hit(a))
    out.push({ id: '', name: 'Deep space', hue: 220, minds: drift })
    return out.filter((g) => g.minds.length)
  }, [agents, layout, q])
  const total = Object.keys(agents).length
  const open = (a: Agent) => {
    if (pickFor) {
      openClassic({ name: 'dot', id: a.id, tab: pickFor })
      return
    }
    if (!desktop) setDeck(null)
    go({ kind: 'mind', id: a.id })
  }
  return (
    <>
      <div className="px-4 pt-3">
        {pickFor && (
          <p className="mb-2 border px-3 py-2 text-[13px]" style={{ borderColor: 'var(--cx-accent)', color: 'var(--cx-ink)', background: 'rgba(124,196,255,0.08)' }}>
            Choose a world to open its {TAB_NAME[pickFor]}.
          </p>
        )}
        <Field value={q} onChange={setQ} placeholder={`Find among ${plural(total, 'world')}…`} label="Find a mind" autoFocus={desktop} />
      </div>
      <Body>
        {groups.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>
            {total ? 'No world matches.' : 'No worlds yet.'}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.id || 'deep'} aria-label={g.name} className="mb-3">
            <h3 className="cx-mono flex items-center gap-2 pb-1 text-[10px]" style={{ letterSpacing: '0.22em', color: g.id ? hsl(g.hue, 90, 80) : 'var(--cx-ink-3)' }}>
              {g.name.toUpperCase()}
              <span style={{ color: 'var(--cx-ink-3)' }}>· {pad(g.minds.length)}</span>
              <span className="h-px flex-1" style={{ background: 'var(--cx-line)' }} />
            </h3>
            <ul>
              {g.minds.map((a) => {
                const t = thinking[a.id]
                const busy = t === 'llm' || t === 'skills'
                const action = a.status === 'awake' ? 'sleep' : a.status === 'asleep' ? 'wake' : a.status === 'starting' ? null : 'start'
                return (
                  <li key={a.id} className="flex items-center gap-2 hover:bg-white/[0.04]">
                    <button className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left" onClick={() => open(a)} aria-label={pickFor ? `Open the ${TAB_NAME[pickFor]} of ${shown(a.name)}` : `Open transmission with ${shown(a.name)}`}>
                      <Orb hue={a.hue} lit={a.status === 'awake'} size={18} busy={busy} />
                      <span className="min-w-0 flex-1">
                        <span className="cx-caps block truncate text-[11.5px]" style={{ color: 'var(--cx-ink)', letterSpacing: '0.18em' }}>
                          {shown(a.name)}
                        </span>
                        <span className="cx-mono block truncate text-[10px]" style={{ color: busy ? hsl(a.hue, 95, 80) : 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
                          {statusWord(a, t)} · {a.model.split('/').pop()?.toUpperCase()}
                        </span>
                      </span>
                    </button>
                    {!pickFor && action && (
                      <button className="cx-btn cx-btn-sm !px-2.5 !text-[10px] shrink-0" aria-label={`${action === 'sleep' ? 'Put to sleep' : action === 'wake' ? 'Wake' : 'Start'} ${shown(a.name)}`} onClick={() => void act(a.id, action)}>
                        {action === 'sleep' ? 'Sleep' : action === 'wake' ? 'Wake' : 'Ignite'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {!pickFor && (
          <button className="cx-btn cx-btn-hue mt-1" style={{ ['--cx-hue' as string]: '#7cc4ff' }} onClick={() => setDeck('create')}>
            + Seed a mind
          </button>
        )}
      </Body>
    </>
  )
}

/* ------------------------------------------------------------ systems picker */

function SystemPick({ value, onChange, all }: { value: string; onChange: (id: string) => void; all?: boolean }) {
  const swarms = useHive((s) => s.swarms)
  const list = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  return (
    <div className="cx-hscroll -mx-4 flex gap-1.5 px-4 pb-1" role="tablist" aria-label="Star system">
      {all && (
        <button role="tab" aria-selected={value === ''} onClick={() => onChange('')} className="cx-caps shrink-0 border px-2.5 py-1.5 text-[10px]" style={{ letterSpacing: '0.18em', borderColor: value === '' ? 'var(--cx-accent)' : 'var(--cx-line)', color: value === '' ? '#fff' : 'var(--cx-ink-2)' }}>
          All systems
        </button>
      )}
      {list.map((s) => (
        <button key={s.id} role="tab" aria-selected={value === s.id} onClick={() => onChange(s.id)} className="cx-caps flex shrink-0 items-center gap-1.5 border px-2.5 py-1.5 text-[10px]" style={{ letterSpacing: '0.18em', borderColor: value === s.id ? hsl(s.hue, 90, 66) : 'var(--cx-line)', color: value === s.id ? '#fff' : 'var(--cx-ink-2)', background: value === s.id ? hsl(s.hue, 90, 50, 0.16) : 'transparent' }}>
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: hsl(s.hue, 95, 70) }} />
          {shown(s.name)}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ beliefs across systems */

function Beliefs() {
  const start = useCosmos((s) => s.deckSwarm)
  const [sys, setSys] = useState(start ?? '')
  const [q, setQ] = useState('')
  const beliefs = useHive((s) => s.beliefs)
  const swarms = useHive((s) => s.swarms)
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const out: { sid: string; b: (typeof beliefs)[string][string] }[] = []
    for (const sid in beliefs) if ((!sys || sid === sys) && swarms[sid]) for (const b of Object.values(beliefs[sid])) if (words.every((w) => `${b.statement} ${beliefText(b.statement)}`.toLowerCase().includes(w))) out.push({ sid, b })
    // uifix-r3.6: listed beside its sureness word, so ordered by the one sureness order (most sure first), never by c alone
    return out.sort((a, b) => compareSureness(b.b.tv, a.b.tv)).slice(0, 200)
  }, [beliefs, swarms, sys, q])
  return (
    <>
      <div className="flex flex-col gap-2 px-4 pt-3">
        <SystemPick value={sys} onChange={setSys} all />
        <Field value={q} onChange={setQ} placeholder="Find a belief…" label="Find a belief" />
      </div>
      <Body>
        <p className="cx-mono pb-1 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.14em' }}>
          {pad(list.length)} BELIEFS · STRONGEST FIRST
        </p>
        {list.length === 0 ? (
          <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
            No beliefs charted here yet. Systems form them as their minds agree.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--cx-line)' }}>
            {list.map(({ sid, b }) => (
              <li key={`${sid}:${b.statement}`} className="relative list-none">
                {!sys && (
                  <span className="cx-mono absolute top-2.5 right-0 text-[9.5px]" style={{ color: hsl(swarms[sid].hue, 90, 78), letterSpacing: '0.14em' }}>
                    {shown(swarms[sid].name).toUpperCase()}
                  </span>
                )}
                <BeliefRow b={b} as="div" />
              </li>
            ))}
          </ul>
        )}
        {sys && (
          <button className="cx-btn mt-2" onClick={() => openClassic({ name: 'swarm', id: sys })}>
            Evidence on the swarm page ↗
          </button>
        )}
      </Body>
    </>
  )
}

/* ------------------------------------------------------------ tasks (the hive's goals): see, create, patch */

const LIVE = new Set(['open', 'claimed', 'waiting', 'stalled', 'submitted'])
const STATUS_HUE: Record<string, number> = { open: 205, claimed: 168, waiting: 38, stalled: 2, submitted: 260, done: 150, failed: 2, cancelled: 220 }
const PRIORITY: [string, string, number][] = [
  ['low', 'Low', 0.25],
  ['normal', 'Normal', 0.5],
  ['high', 'High', 0.8],
]
const NO_LINKS: MotivationRef[] = []

function Goals() {
  const swarms = useHive((s) => s.swarms)
  const start = useCosmos((s) => s.deckSwarm)
  const first = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.id ?? '', [swarms])
  const [sys, setSys] = useState(start ?? '')
  const [show, setShow] = useState<'live' | 'closed'>('live')
  const goals = useHive((s) => s.goals)
  const loadGoals = useHive((s) => s.loadGoals)
  // Motivations above Tasks: the motivation filter lives in the deck state, so a motivation (or a chip) can open it.
  // A link only files a task for the people who can read it: it tells no mind anything.
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const mo = useCosmos((s) => s.deckMotivation)
  const setMo = (v: string | null) => useCosmos.setState({ deckMotivation: v })
  // Review D1: done, cancel and re-open are decisions on the task as it was when asked, confirmed in the shared dialog.
  // Held here, not in the row, so a task that moves lists while the dialog is open still shows why it was refused.
  const [deciding, setDeciding] = useState<{ seen: Goal; to: Goal['status']; session: string } | null>(null)
  const decisionCurrent = useCosmosGoalAuthority()
  useEffect(() => {
    for (const id of sys ? [sys] : Object.keys(swarms)) void loadGoals(id).catch(() => undefined)
  }, [sys, swarms, loadGoals])
  // the system and in-flight/closed choice; the motivation filter narrows this, and its counts come from it
  const base = useMemo(
    () => Object.values(goals).filter((g) => (!sys || g.swarm_id === sys) && swarms[g.swarm_id] && (show === 'live' ? LIVE.has(g.status) : !LIVE.has(g.status))),
    [goals, sys, swarms, show],
  )
  const list = useMemo(
    () =>
      base
        .filter((g) => !mo || (mo === 'none' ? isUnsorted(links, g.id) : (links[g.id] ?? NO_LINKS).some((l) => l.id === mo)))
        .sort((a, b) => b.priority - a.priority || b.updated_at.localeCompare(a.updated_at)),
    [base, links, mo],
  )
  // each task counted once per motivation it serves, and once in Unsorted when it serves none you can read
  const counts = useMemo(() => {
    const per: Record<string, number> = {}
    let unsorted = 0
    for (const g of base) {
      const refs = links[g.id] ?? NO_LINKS
      if (isUnsorted(links, g.id)) unsorted++
      for (const id of new Set(refs.map((r) => r.id))) per[id] = (per[id] ?? 0) + 1
    }
    return { per, unsorted }
  }, [base, links])
  const offered = useMemo(() => sortMotivations(Object.values(motivations).filter((x) => x.status === 'active' || x.status === 'paused' || x.id === mo)), [motivations, mo])
  const chosen = mo && mo !== 'none' ? motivations[mo] : undefined
  const missing = !!mo && mo !== 'none' && supported && loaded && !chosen
  const filtering = supported && (offered.length > 0 || !!mo)
  return (
    <>
      <div data-goals-home tabIndex={-1} className="flex flex-col gap-2 px-4 pt-3 outline-none">
        <SystemPick value={sys} onChange={setSys} all />
        <Seg value={show} onChange={setShow} label="Which tasks" options={[['live', 'In flight'], ['closed', 'Closed']]} />
        {filtering && (
          <div className="cx-hscroll -mx-4 flex gap-1.5 px-4 pb-1" role="group" aria-label="Filter by motivation" data-motivation-filter>
            <MoPick on={!mo} onClick={() => setMo(null)}>
              Any motivation
            </MoPick>
            {offered.map((x) => (
              <MoPick key={x.id} on={mo === x.id} onClick={() => setMo(mo === x.id ? null : x.id)} quiet={x.status !== 'active'} count={counts.per[x.id] ?? 0}>
                {x.title}
              </MoPick>
            ))}
            <MoPick on={mo === 'none'} onClick={() => setMo(mo === 'none' ? null : 'none')} quiet count={counts.unsorted} dashed>
              {WORDS.unsorted}
            </MoPick>
          </div>
        )}
      </div>
      <Body>
        <NewGoal swarmId={sys || first} />
        {missing && (
          <p role="status" className="mt-3 text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>
            That motivation is not there for you: it may have been made private, or it no longer exists.
          </p>
        )}
        {mo && (
          <p className="cx-mono mt-3 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.14em' }}>
            {pad(list.length)} {list.length === 1 ? 'TASK' : 'TASKS'} {mo === 'none' ? 'UNDER NO MOTIVATION YOU CAN SEE' : chosen ? `UNDER “${chosen.title.toUpperCase()}”` : ''}
          </p>
        )}
        {list.length === 0 ? (
          <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
            {mo ? (show === 'live' ? 'No tasks in flight here.' : 'Nothing closed here yet.') : show === 'live' ? 'No tasks in flight. Give a system one above.' : 'Nothing closed yet.'}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {list.map((g) => (
              <GoalRow key={g.id} g={g} showSystem={!sys} onDecide={setDeciding} onMotivation={(id) => setMo(id)} />
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="cx-btn" onClick={() => openClassic({ name: 'tasks', ...(sys ? { swarm: sys } : {}), ...(mo ? { motivation: mo } : {}) })}>
            All tasks ↗
          </button>
          {supported && (
            <button className="cx-btn" onClick={() => useCosmos.getState().setDeck('motivations')}>
              {WORDS.motivations}
            </button>
          )}
        </div>
      </Body>
      <AnimatePresence>{deciding && <GoalDecision current={decisionCurrent} seen={deciding.seen} to={deciding.to} session={deciding.session} onClose={() => setDeciding(null)} restoreFocus={goalsHome} />}</AnimatePresence>
    </>
  )
}

/** One choice in the motivation filter: a motivation (quieter when not active), Any, or Unsorted; with its task count. */
function MoPick({ on, onClick, children, count, quiet, dashed }: { on: boolean; onClick: () => void; children: ReactNode; count?: number; quiet?: boolean; dashed?: boolean }) {
  // a read that did not finish makes the count a floor (stand-in P2-4 on 57e64ca)
  const partial = useCountsPartial()
  return (
    <button
      aria-pressed={on}
      onClick={onClick}
      className="cx-caps flex max-w-[16rem] shrink-0 items-center gap-1.5 border px-2.5 py-1.5 text-[10px]"
      style={{ letterSpacing: '0.16em', borderStyle: dashed ? 'dashed' : 'solid', borderColor: on ? hsl(130, 80, 64) : 'var(--cx-line)', color: on ? '#fff' : quiet ? 'var(--cx-ink-3)' : 'var(--cx-ink-2)', background: on ? hsl(130, 80, 50, 0.14) : 'transparent' }}
    >
      <span className="truncate">{children}</span>
      {count !== undefined && (
        <span className="cx-mono shrink-0" style={{ color: 'var(--cx-ink-3)' }} title={partial ? PARTIAL_WORDS : undefined} data-count-partial={partial || undefined}>
          {pad(count)}
          {partial ? '+' : ''}
        </span>
      )}
    </button>
  )
}

/** The motivations a task serves (only links this person can read: a hidden link and no link look the same). */
function TaskMotivations({ id, onPick }: { id: string; onPick: (motivationId: string) => void }) {
  const refs = useHive((s) => s.taskLinks[id] ?? NO_LINKS)
  if (!refs.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1" data-task-chips>
      {refs.map((r) => (
        <button
          key={r.id}
          data-motivation-chip={r.id}
          onClick={() => onPick(r.id)}
          title={`Tasks under “${r.title}”${r.status !== 'active' ? ` (${STATUS_WORDS[r.status].toLowerCase()})` : ''}`}
          className="cx-mono flex max-w-full items-center gap-1 border px-1.5 py-0.5 text-[10px]"
          style={{ letterSpacing: '0.08em', borderColor: r.status === 'active' ? hsl(130, 70, 50, 0.5) : 'var(--cx-line)', color: r.status === 'active' ? hsl(130, 80, 78) : 'var(--cx-ink-3)' }}
        >
          <span aria-hidden>◇</span>
          <span className="truncate">{r.title}</span>
          {r.status !== 'active' && <span className="shrink-0">· {STATUS_WORDS[r.status].toUpperCase()}</span>}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ motivations: the why above the tasks (read-only) */

const MO_HUE: Record<Motivation['status'], number> = { active: 130, paused: 38, achieved: 150, retired: 220 }

function Motivations() {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const ctx = useMemo(() => ({ me, agents, swarms }), [me, agents, swarms])
  const [show, setShow] = useState<'open' | 'closed'>('open')
  const list = useMemo(() => sortMotivations(Object.values(motivations).filter((m) => (show === 'open') === (m.status === 'active' || m.status === 'paused'))), [motivations, show])
  const unsorted = useMemo(() => Object.values(goals).filter((g) => LIVE.has(g.status) && isUnsorted(links, g.id)).length, [goals, links])
  const partial = useCountsPartial()
  const filterTo = (id: string) => useCosmos.getState().setDeck('goals', { motivation: id })
  return (
    <>
      <div className="px-4 pt-3">
        <Seg value={show} onChange={setShow} label="Which motivations" options={[['open', 'Active and paused'], ['closed', 'Achieved and retired']]} />
      </div>
      <Body>
        {!supported ? (
          <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
            This hive does not have motivations yet.
          </p>
        ) : !loaded && list.length === 0 ? (
          <p className="flex items-center gap-2 py-6 cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
            <span className="cx-blink">▮</span> READING…
          </p>
        ) : list.length === 0 ? (
          <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
            {show === 'open' ? 'No motivations you can see yet. A motivation is the why: an aim held by a person, a swarm or a mind.' : 'None achieved or retired yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((m) => (
              <MotivationRow key={m.id} m={m} p={progressOf(tasksOf(m.id, links), goals)} partial={partial} ctx={ctx} onOpen={() => filterTo(m.id)} />
            ))}
          </ul>
        )}
        {supported && loaded && partial && (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--cx-ink-3)' }} data-partial>
            These counts {PARTIAL_WORDS}.
          </p>
        )}
        {supported && show === 'open' && unsorted > 0 && (
          <button className="mt-3 flex w-full items-center gap-2 border border-dashed px-3 py-2 text-left text-[13px]" style={{ borderColor: 'var(--cx-line-2)', color: 'var(--cx-ink-2)' }} onClick={() => filterTo('none')}>
            <span className="min-w-0 flex-1">{WORDS.unsorted}: tasks in flight under no motivation you can see</span>
            <span className="cx-mono shrink-0 text-[11px]">
              {pad(unsorted)}
              {partial ? '+' : ''}
            </span>
          </button>
        )}
        <p className="mt-3 text-[12.5px] leading-snug" style={{ color: 'var(--cx-ink-3)' }}>
          Filing a task under a motivation is for the people who can read it. Minds working on the task are not told about it.
        </p>
        <button className="cx-btn mt-3" onClick={() => openClassic({ name: 'motivations' })}>
          Full motivations page ↗
        </button>
      </Body>
    </>
  )
}

function MotivationRow({ m, p, partial, ctx, onOpen }: { m: Motivation; p: ReturnType<typeof progressOf>; partial: boolean; ctx: Parameters<typeof ownerLine>[1]; onOpen: () => void }) {
  const hue = MO_HUE[m.status]
  const counts = [p.working && `${pad(p.working)} WORKING`, p.review && `${pad(p.review)} IN REVIEW`, p.failed && `${pad(p.failed)} FAILED`].filter(Boolean).join(' · ')
  return (
    <li className="border" style={{ borderColor: 'var(--cx-line)', background: 'rgba(8,14,30,0.45)', boxShadow: `inset 3px 0 0 ${hsl(hue, 80, 60)}` }} data-motivation={m.id}>
      <button className="block w-full p-3 text-left hover:bg-white/[0.04]" onClick={onOpen} aria-label={`Show the tasks under “${m.title}”`}>
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[14px] leading-snug break-words" style={{ color: 'var(--cx-ink)' }}>
            {m.title}
          </span>
          <span className="cx-mono shrink-0 pt-0.5 text-[9.5px]" style={{ color: hsl(hue, 90, 76), letterSpacing: '0.16em' }}>
            {STATUS_WORDS[m.status].toUpperCase()}
          </span>
        </span>
        {m.why && (
          <span className="mt-1 line-clamp-2 block text-[12.5px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
            {m.why}
          </span>
        )}
        <span className="mt-1.5 block truncate text-[11.5px]" style={{ color: 'var(--cx-ink-3)' }}>
          {ownerLine(m, ctx)} · {creatorLine(m, ctx)}
        </span>
        <span className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1">
            <Bar value={p.ratio ?? 0} hue={hue} label={`${m.title}: share of its tasks done`} />
          </span>
          <span className="cx-mono shrink-0 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
            {p.total ? `${pad(p.done)}/${pad(p.total - p.cancelled)}${partial ? '+' : ''} DONE` : partial ? 'NONE FOUND YET' : 'NO TASKS YET'}
          </span>
        </span>
        {counts && (
          <span className="cx-mono mt-1 block truncate text-[9.5px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
            {counts}
          </span>
        )}
      </button>
    </li>
  )
}

function NewGoal({ swarmId }: { swarmId: string }) {
  const swarm = useHive((s) => s.swarms[swarmId])
  const createGoal = useHive((s) => s.createGoal)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [pri, setPri] = useState('normal')
  const [busy, setBusy] = useState(false)
  if (!swarm) return <p className="text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>Tasks belong to a system. Start a swarm to give it tasks.</p>
  const submit = async () => {
    const t = title.trim()
    if (!t) return
    setBusy(true)
    const made = await createGoal(swarmId, { title: t, detail: detail.trim() || undefined, priority: PRIORITY.find((p) => p[0] === pri)?.[2] ?? 0.5 })
    setBusy(false)
    if (made) {
      setTitle('')
      setDetail('')
    }
  }
  return (
    <form
      className="border p-3"
      style={{ borderColor: 'var(--cx-line)', background: 'rgba(8,14,30,0.5)' }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Label>NEW TASK FOR {shown(swarm.name).toUpperCase()}</Label>
      <div className="cx-composer border px-3 py-2" style={{ borderColor: 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)', ['--cx-hue' as string]: hsl(swarm.hue, 90, 66) }}>
        <input className="cx-input cx-selectable !text-[14px]" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should the system do?" aria-label="Task title" />
      </div>
      <div className="cx-composer mt-2 border px-3 py-2" style={{ borderColor: 'var(--cx-line)', background: 'rgba(0,0,0,0.2)', ['--cx-hue' as string]: hsl(swarm.hue, 90, 66) }}>
        <textarea className="cx-input cx-selectable !text-[13px]" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Detail (optional)" aria-label="Task detail" />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Seg value={pri} onChange={setPri} label="Priority" options={PRIORITY.map(([k, l]) => [k, l] as [string, string])} />
        <button type="submit" className="cx-btn cx-btn-hue cx-btn-sm" style={{ ['--cx-hue' as string]: hsl(swarm.hue, 90, 66) }} disabled={!title.trim() || busy}>
          {busy ? 'Launching…' : 'Launch task'}
        </button>
      </div>
    </form>
  )
}

function GoalRow({ g, showSystem, onDecide, onMotivation }: { g: Goal; showSystem: boolean; onDecide: (d: { seen: Goal; to: Goal['status']; session: string }) => void; onMotivation: (id: string) => void }) {
  const agents = useHive((s) => s.agents)
  const swarm = useHive((s) => s.swarms[g.swarm_id])
  const patch = useHive((s) => s.patchGoal)
  // Surface R: the session this row's goal was read under; its decisions and priority changes go only in that session
  const session = useHive((s) => s.session)
  const [open, setOpen] = useState(false)
  const decide = (to: Goal['status']) => onDecide({ seen: g, to, session })
  const who = g.claimed_by ? agents[g.claimed_by.replace(/^agent:/, '')] : null
  const hue = STATUS_HUE[g.status] ?? 205
  const live = LIVE.has(g.status)
  return (
    <li className="border p-3" style={{ borderColor: 'var(--cx-line)', background: 'rgba(8,14,30,0.45)', boxShadow: `inset 3px 0 0 ${hsl(hue, 90, 62)}` }}>
      <button className="flex w-full items-start gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-snug break-words" style={{ color: 'var(--cx-ink)' }}>
            {plainText(g.title)}
          </span>
          <span className="cx-mono mt-1 block truncate text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
            <span style={{ color: hsl(hue, 90, 76) }}>{g.status.toUpperCase()}</span>
            {who ? ` · ${shown(who.name).toUpperCase()}` : ''}
            {showSystem && swarm ? ` · ${shown(swarm.name).toUpperCase()}` : ''} · {day(g.updated_at)}
          </span>
        </span>
        <span className="w-14 shrink-0 pt-1.5">
          <Bar value={g.priority} hue={hue} label="priority" />
        </span>
      </button>
      <TaskMotivations id={g.id} onPick={onMotivation} />
      {open && (
        <div className="mt-2">
          {g.detail && (
            <p className="cx-selectable text-[13px] leading-snug whitespace-pre-wrap" style={{ color: 'var(--cx-ink-2)' }}>
              <PlainText text={g.detail} />
            </p>
          )}
          {g.result && (
            <p className="cx-selectable mt-2 border-l-2 pl-2 text-[13px] leading-snug whitespace-pre-wrap" style={{ color: 'var(--cx-ink)', borderColor: hsl(150, 70, 60) }}>
              <PlainText text={g.result} />
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {live ? (
              <>
                <button className="cx-btn cx-btn-sm !px-2.5" onClick={() => decide('done')}>
                  Mark done
                </button>
                {g.status === 'stalled' && (
                  <button className="cx-btn cx-btn-sm !px-2.5" onClick={() => decide('open')}>
                    Reopen
                  </button>
                )}
                <button className="cx-btn cx-btn-sm !px-2.5" onClick={() => void patch(g.id, { priority: Math.min(1, Math.round((g.priority + 0.2) * 10) / 10) }, session)} disabled={g.priority >= 1}>
                  Raise
                </button>
                <button className="cx-btn cx-btn-sm !px-2.5" onClick={() => void patch(g.id, { priority: Math.max(0, Math.round((g.priority - 0.2) * 10) / 10) }, session)} disabled={g.priority <= 0}>
                  Lower
                </button>
                <button className="cx-btn cx-btn-hue cx-btn-sm !px-2.5" style={{ ['--cx-hue' as string]: hsl(2, 90, 62) }} onClick={() => decide('cancelled')}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="cx-btn cx-btn-sm !px-2.5" onClick={() => decide('open')}>
                Reopen
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------ decisions: history and rules */

function Decisions() {
  const tab = useCosmos((s) => s.deckTab)
  const setDeck = useCosmos((s) => s.setDeck)
  const setApprovals = useCosmos((s) => s.setApprovals)
  const pending = useHive((s) => countPending(s.approvals))
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <Seg value={tab} onChange={(t) => setDeck('decisions', { tab: t })} label="Decision log" options={[['history', 'History'], ['rules', 'Rules']]} />
        {pending > 0 && (
          <button className="cx-btn cx-btn-hue cx-btn-sm !px-2.5" style={{ ['--cx-hue' as string]: '#ffc36b' }} onClick={() => setApprovals(true)}>
            {pad(pending)} waiting
          </button>
        )}
      </div>
      {tab === 'history' ? <History /> : <Rules />}
    </>
  )
}

function History() {
  const approvals = useHive((s) => s.approvals)
  const agents = useHive((s) => s.agents)
  const go = useCosmos((s) => s.go)
  const list = useMemo(() => Object.values(approvals).filter((a) => a.status !== 'pending').sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at)).slice(0, 120), [approvals])
  const tone: Record<string, number> = { approved: 150, used: 150, denied: 2, expired: 220 }
  return (
    <Body>
      {list.length === 0 ? (
        <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          No decisions logged yet.
        </p>
      ) : (
        <ol className="flex flex-col">
          {list.map((a) => {
            const ag = agents[a.agent_id]
            return (
              <li key={a.id} className="grid grid-cols-[52px_1fr] gap-x-3 border-b py-2.5" style={{ borderColor: 'var(--cx-line)' }}>
                <span className="cx-mono pt-0.5 text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
                  {day(a.decided_at ?? a.created_at)}
                  <br />
                  {clock(a.decided_at ?? a.created_at)}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="cx-mono text-[10px]" style={{ color: hsl(tone[a.status] ?? 220, 85, 74), letterSpacing: '0.14em' }}>
                      {a.status.toUpperCase()}
                    </span>
                    <span className="cx-caps text-[10.5px]" style={{ color: 'var(--cx-ink-2)' }}>
                      {a.skill}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[13px]" style={{ color: 'var(--cx-ink)' }}>
                    {ag ? (
                      <button className="underline-offset-4 hover:underline" onClick={() => go({ kind: 'mind', id: ag.id })}>
                        {shown(ag.name)}
                      </button>
                    ) : (
                      'A mind'
                    )}
                    <span style={{ color: 'var(--cx-ink-3)' }}>{a.decided_by ? ` · by ${a.decided_by}` : ''}</span>
                  </span>
                  <code className="cx-mono cx-selectable mt-1 block truncate text-[11px]" style={{ color: 'var(--cx-ink-3)' }} title={a.command}>
                    {a.command}
                  </code>
                </span>
              </li>
            )
          })}
        </ol>
      )}
      <button className="cx-btn mt-3" onClick={() => openClassic({ name: 'approvals', tab: 'history' })}>
        Full history ↗
      </button>
    </Body>
  )
}

function Rules() {
  const policy = useHive((s) => s.policy)
  const load = useHive((s) => s.loadPolicy)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    load().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not read the rules'))
  }, [load])
  const scope = (s: string) => {
    if (s === 'hive') return 'WHOLE HIVE'
    const [k, id] = s.split(':')
    if (k === 'swarm') return `SYSTEM ${swarms[id] ? shown(swarms[id].name).toUpperCase() : id}`
    return `WORLD ${agents[id] ? shown(agents[id].name).toUpperCase() : id}`
  }
  const modeHue: Record<string, number> = { allow: 150, ask: 38, deny: 2 }
  return (
    <Body>
      <p className="pb-2 text-[13px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
        What minds may do without asking you. The most specific rule wins: world, then system, then hive.
      </p>
      {err ? (
        <p className="py-4 text-[13px]" style={{ color: hsl(2, 90, 78) }}>
          {err}
        </p>
      ) : policy === null ? (
        <p className="cx-mono py-4 text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
          READING RULES…
        </p>
      ) : policy.length === 0 ? (
        <p className="py-4 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          No rules yet: every gated skill asks you.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {policy.map((r) => (
            <li key={r.id} className="grid grid-cols-[56px_1fr] items-start gap-x-3 border px-3 py-2" style={{ borderColor: 'var(--cx-line)' }}>
              <span className="cx-mono px-1.5 py-0.5 text-center text-[10px]" style={{ background: hsl(modeHue[r.mode] ?? 220, 85, 62), color: '#05070d', fontWeight: 600, letterSpacing: '0.12em' }}>
                {r.mode.toUpperCase()}
              </span>
              <span className="min-w-0">
                <code className="cx-mono block truncate text-[12.5px]" style={{ color: 'var(--cx-ink)' }}>
                  {r.skill}
                </code>
                <span className="cx-mono block truncate text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
                  {scope(r.scope)}
                </span>
                {r.note && (
                  <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--cx-ink-2)' }}>
                    {r.note}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button className="cx-btn mt-3" onClick={() => openClassic({ name: 'approvals', tab: 'rules' })}>
        Change rules ↗
      </button>
    </Body>
  )
}

/* ------------------------------------------------------------ live activity */

const KIND: Record<string, [string, number]> = {
  belief: ['BELIEF', 212],
  message: ['COMMS', 190],
  status: ['STATUS', 168],
  error: ['FAULT', 2],
  birth: ['IGNITION', 45],
  approval: ['CLEARANCE', 38],
  goal: ['TASK', 150],
  wakeup: ['WAKE', 260],
}

function Activity({ desktop }: { desktop: boolean }) {
  const activity = useHive((s) => s.activity)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const go = useCosmos((s) => s.go)
  const setDeck = useCosmos((s) => s.setDeck)
  const [kind, setKind] = useState('all')
  const list = useMemo(() => [...activity].reverse().filter((a: ActivityItem) => kind === 'all' || a.kind === kind), [activity, kind])
  return (
    <>
      <div className="px-4 pt-3">
        <Seg value={kind} onChange={setKind} label="Signal type" options={[['all', 'All'], ['message', 'Comms'], ['belief', 'Beliefs'], ['goal', 'Tasks'], ['error', 'Faults']]} />
      </div>
      <Body>
        {list.length === 0 ? (
          <p className="flex items-center gap-2 py-6 cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
            <span className="cx-blink">▮</span> LISTENING…
          </p>
        ) : (
          <ol className="flex flex-col" aria-live="polite">
            <AnimatePresence initial={false}>
              {list.map((a) => {
                const [word, hue] = KIND[a.kind] ?? ['SIGNAL', 210]
                const ag = a.agent_id ? agents[a.agent_id] : undefined
                const sw = a.swarm_id ? swarms[a.swarm_id] : undefined
                return (
                  <m.li key={a.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="grid grid-cols-[44px_1fr] gap-x-3 border-b py-2" style={{ borderColor: 'var(--cx-line)' }}>
                    <span className="cx-mono pt-0.5 text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
                      {clock(a.at)}
                    </span>
                    <span className="min-w-0">
                      <span className="cx-mono flex items-center gap-2 text-[10px]" style={{ letterSpacing: '0.14em' }}>
                        <span style={{ color: hsl(hue, 90, 76) }}>{word}</span>
                        {ag ? (
                          <button
                            className="truncate uppercase hover:underline"
                            style={{ color: hsl(ag.hue, 90, 80) }}
                            onClick={() => {
                              if (!desktop) setDeck(null)
                              go({ kind: 'mind', id: ag.id })
                            }}
                          >
                            {shown(ag.name)}
                          </button>
                        ) : sw ? (
                          <span className="truncate uppercase" style={{ color: hsl(sw.hue, 90, 80) }}>
                            {shown(sw.name)}
                          </span>
                        ) : null}
                      </span>
                      <span className="cx-selectable mt-0.5 block text-[13px] leading-snug break-words" style={{ color: 'var(--cx-ink)' }}>
                        {a.statement ? <BeliefSentence statement={a.statement} sure={false} /> : plainText(a.text)}
                      </span>
                    </span>
                  </m.li>
                )
              })}
            </AnimatePresence>
          </ol>
        )}
      </Body>
    </>
  )
}

/* ------------------------------------------------------------ seed a mind */

const NAMES = ['Vega', 'Altair', 'Deneb', 'Rigel', 'Lyra', 'Orion', 'Carina', 'Sirius', 'Electra', 'Mira', 'Castor', 'Nova', 'Halley', 'Kepler', 'Juno']

function Create({ desktop }: { desktop: boolean }) {
  const swarms = useHive((s) => s.swarms)
  const models = useHive((s) => s.models)
  const agents = useHive((s) => s.agents)
  const reduced = useReducedMotion()
  const start = useCosmos((s) => s.deckSwarm)
  const go = useCosmos((s) => s.go)
  const setDeck = useCosmos((s) => s.setDeck)
  const list = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  const taken = useMemo(() => new Set(Object.values(agents).map((a) => a.name.toLowerCase())), [agents])
  const [name, setName] = useState('')
  const [sys, setSys] = useState<string>(start ?? list[0]?.id ?? '')
  const [model, setModel] = useState(() => models.find((x) => x.id.includes('sonnet'))?.id ?? models.find((x) => !x.local)?.id ?? models[0]?.id ?? '')
  const [budget, setBudget] = useState('10')
  const [persona, setPersona] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hue] = useState(() => Math.floor(Math.random() * 360))
  const chosen = models.find((x) => x.id === model)
  const clash = name.trim() && taken.has(name.trim().toLowerCase())
  const cap = Number(budget)
  // a budget is said, never assumed (an empty one is not $0): the same rule as the reviewed Still form
  const badBudget = budget.trim() === '' || !Number.isFinite(cap) || cap < 0
  const ok = !!name.trim() && !clash && !!model && !badBudget && !busy
  const suggest = () => setName(NAMES.filter((n) => !taken.has(n.toLowerCase()))[Math.floor(Math.random() * 6)] ?? `World-${Math.floor(Math.random() * 999)}`)
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      // Review O-B2: bound to the session it was dispatched in; the token is shown once, after the flight, and only
      // while that session is still the current one (lib/makeMind)
      await makeMind({ name: name.trim(), kind: 'omega', swarm_id: sys || null, model, persona: persona.trim() || undefined, hue, budget_usd: Number.isFinite(cap) ? cap : 0 }, (agent) => {
        if (!desktop) setDeck(null)
        go({ kind: 'mind', id: agent.id })
      }, reduced ? 300 : 1400)
      setName('')
      setPersona('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The mind could not be seeded')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Body>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-center gap-3">
          <Orb hue={hue} lit size={34} />
          <p className="text-[13px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
            A new world with sensible defaults. Roles, keys and sharing are on the full form.
          </p>
        </div>
        <div>
          <Label>NAME</Label>
          <div className="cx-composer flex items-center gap-2 border px-3 py-2" style={{ borderColor: clash ? hsl(2, 90, 62) : 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)' }}>
            <input className="cx-input cx-selectable !text-[14px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the world" aria-label="Name" aria-invalid={!!clash} autoFocus={desktop} />
            <button type="button" className="cx-mono shrink-0 text-[10px] hover:text-white" style={{ color: 'var(--cx-accent)', letterSpacing: '0.16em' }} onClick={suggest}>
              SUGGEST
            </button>
          </div>
          {clash && (
            <p className="mt-1 text-[12px]" style={{ color: hsl(2, 90, 78) }}>
              That name is taken.
            </p>
          )}
        </div>
        <div>
          <Label>STAR SYSTEM</Label>
          <div className="cx-hscroll -mx-4 flex gap-1.5 px-4 pb-1" role="radiogroup" aria-label="Star system" data-unsaved-ignore="">
            {[{ id: '', name: 'Deep space', hue: 220 }, ...list].map((s) => (
              <button key={s.id || 'none'} type="button" role="radio" aria-checked={sys === s.id} onClick={() => setSys(s.id)} className="cx-caps flex shrink-0 items-center gap-1.5 border px-2.5 py-1.5 text-[10px]" style={{ letterSpacing: '0.18em', borderColor: sys === s.id ? hsl(s.hue, 90, 66) : 'var(--cx-line)', color: sys === s.id ? '#fff' : 'var(--cx-ink-2)', background: sys === s.id ? hsl(s.hue, 90, 50, 0.16) : 'transparent' }}>
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: s.id ? hsl(s.hue, 95, 70) : 'var(--cx-ink-3)' }} />
                {s.id ? shown(s.name) : s.name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label>MODEL</Label>
          <select className="cx-select w-full border px-3 py-2 text-[14px]" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            {models.length === 0 && <option value="">No models connected</option>}
            {models.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label || x.id}
                {x.local ? ' · local' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>BUDGET (USD)</Label>
          <div className="cx-composer flex items-center gap-2 border px-3 py-2" style={{ borderColor: badBudget ? hsl(2, 90, 62) : 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)' }}>
            <span className="cx-mono text-[13px]" style={{ color: 'var(--cx-ink-3)' }}>
              $
            </span>
            <input className="cx-input cx-mono !text-[14px]" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget in US dollars" aria-invalid={badBudget} />
          </div>
          {!chosen?.local && cap === 0 && (
            <p className="mt-1 text-[12px]" style={{ color: '#ffd9a0' }}>
              A paid model with a $0 budget is refused every call. Set a cap or pick a local model.
            </p>
          )}
        </div>
        <div>
          <Label>PERSONA (OPTIONAL)</Label>
          <div className="cx-composer border px-3 py-2" style={{ borderColor: 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)' }}>
            <textarea className="cx-input cx-selectable !text-[13.5px]" rows={3} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Who is it, and what is it for?" aria-label="Persona" />
          </div>
        </div>
        {err && (
          <p className="text-[13px]" style={{ color: hsl(2, 90, 78) }} role="alert">
            {err}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="cx-btn cx-btn-hue" style={{ ['--cx-hue' as string]: hsl(hue, 90, 66) }} disabled={!ok}>
            {busy ? 'Igniting…' : 'Seed the world'}
          </button>
          <button type="button" className="cx-btn" onClick={() => openClassic(sys ? { name: 'new', swarm: sys } : { name: 'new' })}>
            Full form ↗
          </button>
        </div>
      </form>
    </Body>
  )
}

/* ------------------------------------------------------------ fuel: usage and spend (read only) */

function Usage() {
  const agents = useHive((s) => s.agents)
  const usage = useHive((s) => s.usage)
  const budgets = useHive((s) => s.budgets)
  const go = useCosmos((s) => s.go)
  const all = Object.values(agents)
  const spent = all.reduce((n, a) => n + (a.spent_usd || 0), 0)
  const cap = all.reduce((n, a) => n + (a.budget_usd || 0), 0)
  const [since] = useState(() => Date.now() - 24 * 3600 * 1000)
  const day24 = usage.filter((u) => Date.parse(u.created_at) >= since)
  const cost24 = day24.reduce((n, u) => n + u.cost_usd, 0)
  const tok24 = day24.reduce((n, u) => n + u.prompt_tokens + u.completion_tokens, 0)
  const byModel = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of usage) m.set(u.model, (m.get(u.model) ?? 0) + u.cost_usd)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [usage])
  const top = [...all].sort((a, b) => b.spent_usd - a.spent_usd).slice(0, 8)
  const maxModel = byModel[0]?.[1] || 1
  return (
    <Body>
      <div className="grid grid-cols-3 gap-2">
        {[
          ['SPENT', money(spent)],
          ['SPENT THIS VISIT', money(cost24)],
          ['TOKENS THIS VISIT', tok24 >= 1000 ? `${(tok24 / 1000).toFixed(tok24 >= 100000 ? 0 : 1)}K` : String(tok24)],
        ].map(([k, v]) => (
          <div key={k} className="border px-2.5 py-2" style={{ borderColor: 'var(--cx-line)' }}>
            <div className="cx-mono text-[16px]" style={{ color: '#ffd9a0' }}>
              {v}
            </div>
            <div className="cx-mono text-[9.5px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.16em' }}>
              {k}
            </div>
          </div>
        ))}
      </div>
      {cap > 0 && (
        <div className="mt-3">
          <div className="cx-mono mb-1 flex justify-between text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.14em' }}>
            <span>FUEL USED OF ALL BUDGETS</span>
            <span>
              {money(spent)} / {money(cap)}
            </span>
          </div>
          <Bar value={spent / cap} hue={spent / cap > 0.85 ? 2 : 45} label="share of all budgets spent" />
        </div>
      )}
      {budgets && budgets.length > 0 && (
        <section className="mt-4" aria-label="Limits">
          <Label>LIMITS</Label>
          <ul className="flex flex-col gap-2">
            {budgets.map((b) => (
              <li key={b.id}>
                <div className="cx-mono mb-1 flex justify-between gap-2 text-[10.5px]" style={{ color: 'var(--cx-ink-2)' }}>
                  <span className="truncate">
                    {b.scope.toUpperCase()} · {b.period.toUpperCase()}
                  </span>
                  <span className="shrink-0">
                    {money(b.spent_usd)} / {money(b.limit_usd)}
                  </span>
                </div>
                <Bar value={b.limit_usd ? b.spent_usd / b.limit_usd : 0} hue={b.limit_usd && b.spent_usd / b.limit_usd > 0.85 ? 2 : 168} label={`${b.scope} ${b.period} limit used`} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-4" aria-label="Top spenders">
        <Label>HEAVIEST BURN</Label>
        <ul className="flex flex-col">
          {top.map((a) => (
            <li key={a.id}>
              <button className="grid w-full grid-cols-[18px_1fr_auto] items-center gap-x-2.5 py-1.5 text-left hover:bg-white/[0.04]" onClick={() => go({ kind: 'mind', id: a.id })}>
                <Orb hue={a.hue} lit={a.status === 'awake'} size={14} />
                <span className="min-w-0">
                  <span className="cx-caps block truncate text-[10.5px]" style={{ color: 'var(--cx-ink)', letterSpacing: '0.16em' }}>
                    {shown(a.name)}
                  </span>
                  {a.budget_usd > 0 && (
                    <span className="mt-1 block">
                      <Bar value={a.spent_usd / a.budget_usd} hue={a.spent_usd / a.budget_usd > 0.85 ? 2 : a.hue} label={`${shown(a.name)} budget used`} />
                    </span>
                  )}
                </span>
                <span className="cx-mono text-[11.5px]" style={{ color: 'var(--cx-ink-2)' }}>
                  {money(a.spent_usd)}
                  {a.budget_usd ? <span style={{ color: 'var(--cx-ink-3)' }}> / {money(a.budget_usd)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {byModel.length > 0 && (
        <section className="mt-4" aria-label="By model">
          <Label>BY MODEL (THIS SESSION)</Label>
          <ul className="flex flex-col gap-2">
            {byModel.map(([mdl, c]) => (
              <li key={mdl}>
                <div className="cx-mono mb-1 flex justify-between gap-2 text-[10.5px]" style={{ color: 'var(--cx-ink-2)' }}>
                  <span className="truncate">{mdl}</span>
                  <span className="shrink-0">{money(c)}</span>
                </div>
                <Bar value={c / maxModel} hue={205} label={`${mdl} share`} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <button className="cx-btn mt-4" onClick={() => openClassic({ name: 'usage' })}>
        Limits and reservations ↗
      </button>
    </Body>
  )
}

/* ------------------------------------------------------------ field manual */

function Help() {
  const rows: [string, string][] = [
    ['Star system', 'A swarm: a group of minds with one purpose'],
    ['World', 'A mind; it glows when awake, pulses when thinking'],
    ['Belt', 'Shared beliefs around a star: colour is truth, brightness confidence'],
    ['Transmission', 'A conversation with one mind'],
    ['Incoming', 'A mind waiting on your clearance'],
    ['Flight deck', 'Everything else in the hive'],
  ]
  const keys: [string, string][] = [
    ['Drag', 'Orbit'],
    ['Scroll / pinch', 'Zoom'],
    ['[ ]', 'Step through systems or worlds'],
    ['H', 'Galaxy overview'],
    ['A', 'Incoming transmissions'],
    ['/', 'Search and commands'],
    ['Esc', 'Back out'],
  ]
  return (
    <Body>
      <Label>THE MAP</Label>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="cx-caps text-[10.5px]" style={{ color: 'var(--cx-accent)' }}>
              {k}
            </dt>
            <dd className="text-[13px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4">
        <Label>CONTROLS</Label>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
          {keys.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="cx-mono text-[11.5px]" style={{ color: 'var(--cx-ink)' }}>
                {k}
              </dt>
              <dd className="text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-4 text-[13px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
        Ω, bottom left, is the same everywhere: change experience, everything in the hive, and the way back to the Classic hive. The guided tour is in Search and commands.
      </p>
      <button className="cx-btn mt-3" onClick={openPalette}>
        Search and commands
      </button>
    </Body>
  )
}

/** After a task decision: back to what opened it, or (the task moved lists and its row is gone) to the tasks controls. */
const goalsHome = (opener: HTMLElement | null) => (opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-goals-home]'))
