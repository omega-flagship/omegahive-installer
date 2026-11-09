import { useVisibleAuthority } from '../../lib/useVisibleAuthority'
import { AnimatePresence, m, useIsPresent } from 'framer-motion'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Feature } from '../../features/registry'
import { SurenessMeter } from './SurenessMeter'
import { BeliefSentence, beliefText, closeToHome, compareSureness, countPending, GoalDecision, hsl, PlainText, plainText, Sureness, openClassic, openPalette, readContext, shown, taggedFor, useHive, useReducedMotion, type Agent, type Goal, type Tagged } from '../sdk'
import { makeMind } from '../../lib/makeMind'
import { atLeast, creatorLine, LINK_MEANS, ownerLine, PARTIAL_WORDS, progressOf, sortMotivations, STATUS_WORDS, tasksOf, useCountsPartial, useMotivationData, WORDS, type Progress } from '../../lib/motivations'
import { useMe } from '../../lib/useAdmin'
import type { Motivation, MotivationRef } from '../../api/types'
import { INK, INK2, INK3, statusLine, useFlux, type SheetState } from './ctx'
import { Chip, GlassButton, Glyph, LiquidPanel, MotivationChip, Orb } from './kit'
import { clip, countByMotivation, serves } from './motivations'
import { plural, pluralAtLeast } from '../../lib/plural'
import { FLUX_NATIVE, runFeature, sheetGroups, type SheetPage } from './nav'

type Hive = ReturnType<typeof useHive.getState>
type ActivityItem = Hive['activity'][number]

const money = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`
const when = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function useFluxGoalAuthority() {
  const { sheetOwner } = useFlux()
  const goalOwner = useMemo(() => ({ ...sheetOwner, matches: (value: unknown) => (value as SheetState | null)?.page === 'goals' }), [sheetOwner])
  return useVisibleAuthority('hive-pro', useIsPresent(), 'flux-task-sheet', goalOwner)
}

const TITLES: Record<SheetPage, string> = {
  index: 'Everything',
  minds: 'Minds',
  beliefs: 'Beliefs',
  goals: WORDS.tasks,
  motivations: WORDS.motivations,
  decisions: 'Decisions',
  activity: 'Happening now',
  create: 'Bring a mind to life',
  usage: 'Spend',
  help: 'How Flux works',
}

export function Sheet({ sheet }: { sheet: SheetState }) {
  const { desktop, openSheet } = useFlux()
  const page = sheet.page
  return (
    <LiquidPanel
      glassKey="sheet"
      origin={sheet.origin}
      label={TITLES[page]}
      className={`${desktop ? 'fixed top-5 bottom-[max(84px,var(--ask-room,0px))] left-5 z-[35] w-[440px]' : 'fixed inset-x-2 top-[calc(60px+var(--sat,0px))] bottom-[calc(max(76px,var(--ask-room,0px))+var(--sab,0px))] z-[35]'} flex flex-col overflow-hidden`}
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-3">
        {page !== 'index' && <GlassButton label="Back to everything" icon="back" size={38} onClick={() => openSheet({ page: 'index' })} />}
        <h2 className="min-w-0 flex-1 truncate text-[26px] leading-tight font-semibold tracking-[-0.01em]">{TITLES[page]}</h2>
        <GlassButton label="Close" icon="close" size={38} onClick={closeToHome} autoFocus={page !== 'index'} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={page + (sheet.tab ?? '') + (sheet.motivation ?? '')} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }} transition={{ duration: 0.22 }}>
          {page === 'index' && <Index />}
          {page === 'minds' && <Minds pickFor={sheet.pickFor ?? null} />}
          {page === 'beliefs' && <Beliefs start={sheet.swarm ?? ''} />}
          {page === 'goals' && <Goals start={sheet.swarm ?? ''} motivation={sheet.motivation ?? ''} />}
          {page === 'motivations' && <Motivations />}
          {page === 'decisions' && <Decisions tab={sheet.tab ?? 'history'} />}
          {page === 'activity' && <Activity />}
          {page === 'create' && <Create start={sheet.swarm ?? null} />}
          {page === 'usage' && <Usage />}
          {page === 'help' && <Help />}
        </m.div>
      </AnimatePresence>
    </LiquidPanel>
  )
}

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div data-flux-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6" style={{ scrollbarWidth: 'thin' }}>
      {children}
    </div>
  )
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-5 mb-2 text-[13px] font-semibold tracking-[0.12em] uppercase" style={{ color: INK3 }}>
      {children}
    </h3>
  )
}

function Search({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="mx-5 mb-2 flex items-center gap-2.5 rounded-full px-4 py-2.5 focus-within:shadow-[inset_0_0_0_2px_#ffd6fb]" style={{ background: 'rgb(255 255 255 / 0.08)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)', color: INK2 }}>
      <Glyph name="search" size={17} />
      <span className="sr-only">{placeholder}</span>
      <input data-autofocus={autoFocus ? '' : undefined} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#c8bddb]" style={{ color: INK }} />
    </label>
  )
}

function Pills<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: [T, string, number?][]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={`flux-hscroll flex gap-1.5 overflow-x-auto ${className}`}>
      {options.map(([k, l, hue]) => {
        const on = value === k
        return (
          <button key={k} role="tab" aria-selected={on} type="button" onClick={() => onChange(k)} className="flux-focus relative shrink-0 rounded-full px-3.5 py-1.5 text-[14px] font-semibold whitespace-nowrap" style={{ color: on ? '#170a22' : INK, boxShadow: on ? undefined : 'inset 0 0 0 1px rgb(255 255 255 / 0.16)' }}>
            {on && <m.span layoutId={`pills-${label}`} className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle at 35% 20%, #fff, ${hue != null ? hsl(hue, 90, 80) : '#f0c8ff'} 70%)` }} transition={{ type: 'spring', stiffness: 420, damping: 30 }} />}
            <span className="relative">{l}</span>
          </button>
        )
      })}
    </div>
  )
}

function OpenLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flux-focus mt-5 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold hover:bg-white/10" style={{ color: INK, boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
      {label}
      <Glyph name="open" size={14} />
    </button>
  )
}

/* ---------------------------------------------------------------- everything */

function Index() {
  const api = useFlux()
  const [q, setQ] = useState('')
  const groups = useMemo(() => sheetGroups(q), [q])
  const pending = useHive((s) => countPending(s.approvals))
  return (
    <>
      <div className="mx-5 mb-3 grid grid-cols-2 gap-2">
        <button data-sweep="new-swarm" type="button" onClick={() => openClassic({ name: 'launch' })} className="flux-focus flex items-center gap-2.5 rounded-[22px] px-3.5 py-3 text-left text-[15px] font-semibold" style={{ color: '#170a22', background: 'radial-gradient(circle at 25% 15%, #fff, #ffc8ea 55%, #f59ad6)', boxShadow: '0 0 22px rgb(255 150 220 / 0.35)' }}>
          <Glyph name="drop" size={18} stroke={2.2} />
          Start a swarm
        </button>
        <button data-sweep="new-mind" type="button" onClick={() => api.openSheet({ page: 'create' })} className="flux-focus flex items-center gap-2.5 rounded-[22px] px-3.5 py-3 text-left text-[15px] font-semibold" style={{ color: INK, background: 'rgb(255 255 255 / 0.1)', boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.2), inset 0 0 0 1px rgb(255 255 255 / 0.14)' }}>
          <Glyph name="plus" size={18} stroke={2.2} />
          New mind
        </button>
      </div>
      <Search value={q} onChange={setQ} placeholder="Find anything: memory, budget, people…" autoFocus={api.desktop} />
      <Scroll>
        {groups.length === 0 && <p className="py-8 text-center text-[15px]" style={{ color: INK2 }}>Nothing matches “{q}”.</p>}
        {groups.map(([g, label, list]) => (
          <section key={g} aria-label={label}>
            <H3>{label}</H3>
            <ul className="flex flex-col gap-1">
              {list.map((f) => {
                const here = FLUX_NATIVE.includes(f.id)
                return (
                  <li key={f.id}>
                    <button data-feature={f.id} type="button" onClick={() => runFeature(f, api)} className="flux-focus flex w-full items-center gap-3 rounded-[20px] px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.08]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-semibold">{f.label}</span>
                        <span className="block truncate text-[13px]" style={{ color: INK2 }}>{f.blurb}</span>
                      </span>
                      {f.id === 'decide.approvals' && pending > 0 && <Chip hue={320}>{pending}</Chip>}
                      <span aria-label={here ? 'opens here' : 'opens a page'} className="grid size-8 shrink-0 place-items-center rounded-full" style={{ color: here ? '#ffd6fb' : INK3, background: here ? 'rgb(255 140 220 / 0.14)' : 'transparent' }}>
                        <Glyph name={here ? 'drop' : 'open'} size={15} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </Scroll>
    </>
  )
}

/* ---------------------------------------------------------------- minds */

const TAB_NAME: Record<string, string> = { memory: 'memory', schedule: 'wakeups', model: 'model and key', mind: 'record', chat: 'conversation' }

const toggle = (a: Agent) => {
  const act = useHive.getState().agentAction
  if (a.status === 'awake' || a.status === 'starting') void act(a.id, 'sleep')
  else if (a.status === 'stopped' || a.status === 'created') void act(a.id, 'start')
  else void act(a.id, 'wake')
}

function Minds({ pickFor }: { pickFor: string | null }) {
  const api = useFlux()
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const thinking = useHive((s) => s.thinking)
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (a: Agent) => words.every((w) => `${a.name} ${a.model} ${a.status}`.toLowerCase().includes(w))
    const all = Object.values(agents).filter(hit).sort((a, b) => a.name.localeCompare(b.name))
    const out = Object.values(swarms)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((s) => ({ id: s.id, name: shown(s.name), hue: s.hue, minds: all.filter((a) => a.swarm_id === s.id) }))
    out.push({ id: '', name: 'Roaming free', hue: 300, minds: all.filter((a) => !a.swarm_id || !swarms[a.swarm_id]) })
    return out.filter((g) => g.minds.length)
  }, [agents, swarms, q])
  const open = (a: Agent) => {
    if (pickFor) return openClassic({ name: 'dot', id: a.id, tab: pickFor as 'memory' })
    if (!api.desktop) api.openSheet(null)
    api.openMind(a.id)
  }
  return (
    <>
      {pickFor && <p className="mx-5 mb-2 rounded-2xl px-4 py-2.5 text-[14px]" style={{ background: 'rgb(255 140 220 / 0.14)' }}>Choose a mind to open its {TAB_NAME[pickFor] ?? pickFor}.</p>}
      <Search value={q} onChange={setQ} placeholder={`Find among ${plural(Object.keys(agents).length, 'mind')}…`} autoFocus={api.desktop} />
      <Scroll>
        {groups.length === 0 && <p className="py-8 text-center text-[15px]" style={{ color: INK2 }}>No mind matches.</p>}
        {groups.map((g) => (
          <section key={g.id || 'free'} aria-label={g.name}>
            <H3>
              <span style={{ color: g.id ? hsl(g.hue, 90, 84) : INK3 }}>{g.name}</span> · {g.minds.length}
            </H3>
            <ul className="flex flex-col gap-1">
              {g.minds.map((a) => {
                const dim = a.status !== 'awake' && a.status !== 'starting'
                return (
                  <li key={a.id} className="flex items-center gap-2 rounded-[22px] pr-2 hover:bg-white/[0.06]">
                    <button type="button" onClick={() => open(a)} className="flux-focus flex min-w-0 flex-1 items-center gap-3 rounded-[22px] p-2 text-left" aria-label={pickFor ? `Open the ${TAB_NAME[pickFor]} of ${shown(a.name)}` : `Talk to ${shown(a.name)}, ${statusLine(a, thinking[a.id])}`}>
                      <span className="relative size-9 shrink-0">
                        <Orb hue={a.hue} size={36} dim={dim} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-semibold">{shown(a.name)}</span>
                        <span className="block truncate text-[13px]" style={{ color: INK2 }}>
                          {statusLine(a, thinking[a.id])} · {a.model.split('/').pop()}
                        </span>
                      </span>
                    </button>
                    {!pickFor && <GlassButton label={a.status === 'awake' || a.status === 'starting' ? `Put ${shown(a.name)} to sleep` : `Wake ${shown(a.name)}`} icon={a.status === 'awake' || a.status === 'starting' ? 'moon' : 'sun'} size={36} onClick={() => toggle(a)} />}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </Scroll>
    </>
  )
}

/* ---------------------------------------------------------------- swarm picker */

function useSwarmList() {
  const swarms = useHive((s) => s.swarms)
  return useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
}

function SwarmPills({ value, onChange, all, none }: { value: string; onChange: (id: string) => void; all?: boolean; none?: string }) {
  const list = useSwarmList()
  const opts: [string, string, number?][] = [...(all ? [['', 'All swarms'] as [string, string]] : []), ...(none ? [['', none] as [string, string]] : []), ...list.map((s) => [s.id, shown(s.name), s.hue] as [string, string, number])]
  return <Pills value={value} onChange={onChange} options={opts} label="Swarm" className="-mx-5 px-5 pb-1" />
}

/* ---------------------------------------------------------------- beliefs */

function Beliefs({ start }: { start: string }) {
  const [sid, setSid] = useState(start)
  const [q, setQ] = useState('')
  const beliefs = useHive((s) => s.beliefs)
  const swarms = useHive((s) => s.swarms)
  useEffect(() => {
    for (const id of sid ? [sid] : Object.keys(swarms)) void useHive.getState().loadBeliefs(id).catch(() => undefined)
  }, [sid, swarms])
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const out: { sid: string; b: Hive['beliefs'][string][string] }[] = []
    for (const id in beliefs) if ((!sid || id === sid) && swarms[id]) for (const b of Object.values(beliefs[id])) if (words.every((w) => `${b.statement} ${beliefText(b.statement)}`.toLowerCase().includes(w))) out.push({ sid: id, b })
    // uifix-r3.6: listed beside its sureness word, so ordered by the one sureness order (most sure first), never by c alone
    return out.sort((a, b) => compareSureness(b.b.tv, a.b.tv)).slice(0, 200)
  }, [beliefs, swarms, sid, q])
  return (
    <>
      <div className="px-5">
        <SwarmPills value={sid} onChange={setSid} all />
      </div>
      <div className="pt-2">
        <Search value={q} onChange={setQ} placeholder="Find a belief…" />
      </div>
      <Scroll>
        {list.length === 0 && <p className="py-6 text-[15px]" style={{ color: INK2 }}>No shared beliefs here yet. They appear as swarms form them.</p>}
        <ul className="mt-2 flex flex-col gap-2">
          {list.map(({ sid: id, b }) => (
            <li key={`${id}:${b.statement}`} className="rounded-2xl px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
              {!sid && <div className="mb-1 text-[12px] font-semibold" style={{ color: hsl(swarms[id].hue, 90, 84) }}>{shown(swarms[id].name)}</div>}
              <div className="text-[14px] leading-snug break-words">
                <BeliefSentence statement={b.statement} sure={false} />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <SurenessMeter tv={b.tv} />
                <Sureness tv={b.tv} className="shrink-0 text-[12px]" />
              </div>
            </li>
          ))}
        </ul>
        {sid && <OpenLink label="Evidence on the swarm page" onClick={() => openClassic({ name: 'swarm', id: sid })} />}
      </Scroll>
    </>
  )
}

/* ---------------------------------------------------------------- tasks (goals underneath): see, create, patch */

const LIVE = new Set(['open', 'claimed', 'waiting', 'stalled', 'submitted'])
const STATUS_HUE: Record<string, number> = { open: 290, claimed: 170, waiting: 40, stalled: 350, submitted: 260, done: 150, failed: 350, cancelled: 280 }
const PRIORITY: [string, string, number][] = [
  ['low', 'Low', 0.25],
  ['normal', 'Normal', 0.5],
  ['high', 'High', 0.8],
]

const NO_LINKS: MotivationRef[] = []

function Goals({ start, motivation }: { start: string; motivation: string }) {
  const swarms = useHive((s) => s.swarms)
  const list0 = useSwarmList()
  const [sid, setSid] = useState(start)
  const [show, setShow] = useState<'live' | 'closed'>('live')
  // the motivation filter: '' any task, 'none' Unsorted, or one motivation's id (association only: it changes nothing)
  const [mo, setMo] = useState(motivation)
  const goals = useHive((s) => s.goals)
  const { supported, loaded } = useMotivationData()
  const links = useHive((s) => s.taskLinks)
  const motivations = useHive((s) => s.motivations)
  // Review D1: done, cancel and re-open are decisions on the goal as it was when asked, confirmed in the shared dialog.
  // Held here, not in the row, so a goal that moves lists while the dialog is open still shows why it was refused.
  const [deciding, setDeciding] = useState<{ seen: Goal; to: Goal['status']; session: string } | null>(null)
  const decisionCurrent = useFluxGoalAuthority()
  useEffect(() => {
    for (const id of sid ? [sid] : Object.keys(swarms)) void useHive.getState().loadGoals(id).catch(() => undefined)
  }, [sid, swarms])
  const base = useMemo(() => Object.values(goals).filter((g) => (!sid || g.swarm_id === sid) && swarms[g.swarm_id] && (show === 'live' ? LIVE.has(g.status) : !LIVE.has(g.status))), [goals, sid, swarms, show])
  // each task counts once in every total, however many motivations it serves
  const counts = useMemo(() => countByMotivation(base.map((g) => g.id), links), [base, links])
  // a read that did not finish makes these counts floors (stand-in P2-4 on 57e64ca)
  const partial = useCountsPartial() && supported
  const list = useMemo(() => base.filter((g) => serves(links, g.id, mo)).sort((a, b) => b.priority - a.priority || b.updated_at.localeCompare(a.updated_at)), [base, links, mo])
  const readable = useMemo(() => sortMotivations(Object.values(motivations)), [motivations])
  const chosen = mo && mo !== 'none' ? motivations[mo] : undefined
  const missing = !!mo && mo !== 'none' && loaded && !chosen
  const pick = (id: string) => setMo((cur) => (cur === id ? '' : id))
  const target = sid || list0[0]?.id || ''
  const under = mo === 'none' ? ' under no motivation you can see' : chosen ? ` under “${chosen.title}”` : ''
  return (
    <>
      <div data-goals-home tabIndex={-1} className="flex flex-col gap-2 px-5 outline-none">
        <SwarmPills value={sid} onChange={setSid} all />
        <Pills value={show} onChange={setShow} label="Which tasks" options={[['live', 'In motion'], ['closed', 'Settled']]} />
        {supported && (readable.length > 0 || counts.none < counts.any || mo) && (
          <Pills
            value={mo}
            onChange={setMo}
            label="Motivation"
            options={[['', `Any · ${counts.any}`], ...readable.map((x): [string, string] => [x.id, `${clip(x.title)} · ${atLeast(counts.per[x.id] ?? 0, partial)}`]), ['none', `${WORDS.unsorted} · ${atLeast(counts.none, partial)}`]]}
          />
        )}
        {partial && <p className="text-[13px]" style={{ color: INK2 }} data-partial>Counts by motivation {PARTIAL_WORDS}.</p>}
      </div>
      <Scroll>
        <NewGoal swarmId={target} />
        {missing && (
          <p className="mt-3 rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 255 255 / 0.06)', color: INK2 }}>
            That motivation is not there for you: it may have been made private, or it no longer exists.{' '}
            <button type="button" onClick={() => setMo('')} className="flux-focus rounded font-semibold underline" style={{ color: INK }}>
              Show every task
            </button>
          </p>
        )}
        {list.length > 0 && (
          <p className="mt-3 text-[13px]" style={{ color: INK2 }} aria-live="polite">
            {plural(list.length, 'task')}
            {under}
          </p>
        )}
        {list.length === 0 && <p className="py-5 text-[15px]" style={{ color: INK2 }}>{show === 'live' ? `No tasks in motion${under}.` : `Nothing settled yet${under}.`}</p>}
        {mo === 'none' && list.length > 0 && <p className="mt-1 text-[13px]" style={{ color: INK2 }}>File a task under a motivation from the Tasks page. Nothing is filed for you.</p>}
        <ul className="mt-3 flex flex-col gap-2">
          {list.map((g) => (
            <GoalRow key={g.id} g={g} showSwarm={!sid} onDecide={setDeciding} links={links[g.id] ?? NO_LINKS} filter={mo} onMotivation={pick} />
          ))}
        </ul>
        <OpenLink label="Tasks" onClick={() => openClassic({ name: 'tasks', ...(sid ? { swarm: sid } : {}), ...(mo ? { motivation: mo } : {}) })} />
      </Scroll>
      <AnimatePresence>{deciding && <GoalDecision current={decisionCurrent} seen={deciding.seen} to={deciding.to} session={deciding.session} onClose={() => setDeciding(null)} restoreFocus={goalsHome} />}</AnimatePresence>
    </>
  )
}

function NewGoal({ swarmId }: { swarmId: string }) {
  const swarm = useHive((s) => s.swarms[swarmId])
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [pri, setPri] = useState('normal')
  const [busy, setBusy] = useState(false)
  if (!swarm) return <p className="mt-2 text-[15px]" style={{ color: INK2 }}>Tasks belong to a swarm. Start one to give it tasks.</p>
  const submit = async () => {
    const t = title.trim()
    if (!t) return
    setBusy(true)
    const made = await useHive.getState().createGoal(swarmId, { title: t, detail: detail.trim() || undefined, priority: PRIORITY.find((p) => p[0] === pri)?.[2] ?? 0.5 })
    setBusy(false)
    if (made) {
      setTitle('')
      setDetail('')
    }
  }
  return (
    <form
      className="mt-2 rounded-[26px] p-3"
      style={{ background: 'rgb(255 255 255 / 0.06)', boxShadow: `inset 0 0 0 1px ${hsl(swarm.hue, 80, 70, 0.3)}` }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="px-2 pb-2 text-[13px] font-semibold" style={{ color: INK2 }}>
        A new task for <span style={{ color: hsl(swarm.hue, 90, 84) }}>{shown(swarm.name)}</span>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" placeholder="What should the swarm do?" className="flux-field w-full rounded-full px-4 py-2.5 text-[15px]" />
      <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} aria-label="Task detail" placeholder="Detail (optional)" className="flux-field mt-2 w-full resize-none rounded-[20px] px-4 py-2.5 text-[14px]" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Pills value={pri} onChange={setPri} label="Priority" options={PRIORITY.map(([k, l]) => [k, l] as [string, string])} />
        <button type="submit" disabled={!title.trim() || busy} className="flux-focus rounded-full px-4 py-2 text-[14px] font-semibold disabled:opacity-40" style={{ color: '#1a0b24', background: hsl(swarm.hue, 90, 80) }}>
          {busy ? 'Pouring…' : 'Add task'}
        </button>
      </div>
    </form>
  )
}

function GoalRow({ g, showSwarm, onDecide, links, filter, onMotivation }: { g: Goal; showSwarm: boolean; onDecide: (d: { seen: Goal; to: Goal['status']; session: string }) => void; links: MotivationRef[]; filter: string; onMotivation: (id: string) => void }) {
  const agents = useHive((s) => s.agents)
  const swarm = useHive((s) => s.swarms[g.swarm_id])
  // Surface R: the session this row's goal was read under; its decisions and priority changes go only in that session
  const session = useHive((s) => s.session)
  const [open, setOpen] = useState(false)
  const decide = (to: Goal['status']) => onDecide({ seen: g, to, session })
  const patch = (b: Parameters<Hive['patchGoal']>[1]) => void useHive.getState().patchGoal(g.id, b, session)
  const who = g.claimed_by ? agents[g.claimed_by.replace(/^agent:/, '')] : null
  const hue = STATUS_HUE[g.status] ?? 290
  const live = LIVE.has(g.status)
  const act = (label: string, run: () => void, danger?: boolean, disabled?: boolean) => (
    <button type="button" onClick={run} disabled={disabled} className="flux-focus rounded-full px-3.5 py-1.5 text-[13px] font-semibold hover:bg-white/10 disabled:opacity-40" style={{ color: danger ? '#ffc2cf' : INK, boxShadow: `inset 0 0 0 1px ${danger ? 'rgb(255 140 165 / 0.5)' : 'rgb(255 255 255 / 0.18)'}` }}>
      {label}
    </button>
  )
  return (
    <li className="rounded-[22px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flux-focus flex w-full items-start gap-3 rounded-xl text-left">
        <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: hsl(hue, 90, 72), boxShadow: `0 0 10px ${hsl(hue, 90, 65)}` }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-snug font-semibold break-words">{plainText(g.title)}</span>
          <span className="mt-0.5 block truncate text-[13px]" style={{ color: INK2 }}>
            {g.status}
            {who ? ` · ${shown(who.name)}` : ''}
            {showSwarm && swarm ? ` · ${shown(swarm.name)}` : ''} · {Math.round(g.priority * 100)}% priority
          </span>
        </span>
      </button>
      {links.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-5" data-task-chips>
          {links.map((l) => (
            <MotivationChip key={l.id} m={l} on={filter === l.id} onClick={() => onMotivation(l.id)} />
          ))}
        </div>
      )}
      {open && (
        <div className="mt-2 pl-5">
          {g.detail && <p className="text-[14px] leading-snug whitespace-pre-wrap" style={{ color: INK2 }}><PlainText text={g.detail} /></p>}
          {g.result && <p className="mt-2 rounded-2xl px-3 py-2 text-[14px] whitespace-pre-wrap" style={{ background: 'rgb(140 240 200 / 0.1)' }}><PlainText text={g.result} /></p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {live ? (
              <>
                {act('Done', () => decide('done'))}
                {g.status === 'stalled' && act('Reopen', () => decide('open'))}
                {act('Raise', () => patch({ priority: Math.min(1, Math.round((g.priority + 0.2) * 10) / 10) }), false, g.priority >= 1)}
                {act('Lower', () => patch({ priority: Math.max(0, Math.round((g.priority - 0.2) * 10) / 10) }), false, g.priority <= 0)}
                {act('Cancel', () => decide('cancelled'), true)}
              </>
            ) : (
              act('Reopen', () => decide('open'))
            )}
          </div>
        </div>
      )}
    </li>
  )
}

/* ---------------------------------------------------------------- motivations: the why above the tasks (read-only) */

const MOTIVATION_HUE: Record<Motivation['status'], number> = { active: 320, paused: 40, achieved: 150, retired: 270 }

function Motivations() {
  const api = useFlux()
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const ctx = { me, agents, swarms }
  const [show, setShow] = useState<'open' | 'closed'>('open')
  const all = useMemo(() => sortMotivations(Object.values(motivations)), [motivations])
  const list = useMemo(() => all.filter((x) => (show === 'open' ? x.status === 'active' || x.status === 'paused' : x.status === 'achieved' || x.status === 'retired')), [all, show])
  // the tasks under any listed motivation, each counted once however many of them it serves
  const total = useMemo(() => progressOf(list.flatMap((x) => tasksOf(x.id, links)), goals), [list, links, goals])
  const partial = useCountsPartial()
  const tasks = (id: string) => api.openSheet({ page: 'goals', swarm: null, motivation: id })
  return (
    <>
      <div className="flex flex-col gap-2 px-5">
        <Pills value={show} onChange={setShow} label="Which motivations" options={[['open', 'Active and paused'], ['closed', 'Achieved and retired']]} />
      </div>
      <Scroll>
        {!supported ? (
          <p className="py-5 text-[15px]" style={{ color: INK2 }}>This hive does not have motivations yet.</p>
        ) : !loaded ? (
          <p className="py-5 text-[15px]" style={{ color: INK2 }} aria-live="polite">Reading motivations…</p>
        ) : list.length === 0 ? (
          <p className="py-5 text-[15px]" style={{ color: INK2 }}>{show === 'open' ? 'No active or paused motivations you can see.' : 'None achieved or retired yet.'}</p>
        ) : (
          <>
            <p className="mt-1 text-[13px]" style={{ color: INK2 }}>
              {plural(list.length, 'motivation')} · {pluralAtLeast(total.total, partial, 'task')} under them, each counted once{partial ? ` (${PARTIAL_WORDS})` : ''}
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {list.map((x) => (
                <MotivationRow key={x.id} mo={x} owner={ownerLine(x, ctx)} creator={creatorLine(x, ctx)} progress={progressOf(tasksOf(x.id, links), goals)} partial={partial} onTasks={() => tasks(x.id)} />
              ))}
            </ul>
          </>
        )}
        {supported && <p className="mt-4 text-[13px] leading-snug" style={{ color: INK2 }}>{LINK_MEANS}</p>}
        <div className="flex flex-wrap gap-2">
          {supported && <OpenLink label="Unsorted tasks" onClick={() => tasks('none')} />}
          <OpenLink label="All motivations" onClick={() => openClassic({ name: 'motivations' })} />
        </div>
      </Scroll>
    </>
  )
}

function progressWords(p: Progress): string {
  if (p.total === 0) return 'No tasks you can see yet'
  const parts = [`${p.done} of ${p.total - p.cancelled} done`]
  if (p.working) parts.push(`${p.working} working`)
  if (p.review) parts.push(`${p.review} to review`)
  if (p.open) parts.push(`${p.open} open`)
  if (p.failed) parts.push(`${p.failed} failed`)
  if (p.cancelled) parts.push(`${p.cancelled} cancelled`)
  return parts.join(' · ')
}

function MotivationRow({ mo, owner, creator, progress: p, partial, onTasks }: { mo: Motivation; owner: string; creator: string; progress: Progress; partial: boolean; onTasks: () => void }) {
  const hue = MOTIVATION_HUE[mo.status]
  const pct = p.ratio == null ? 0 : Math.round(p.ratio * 100)
  return (
    <li className="rounded-[22px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }} data-motivation={mo.id}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[16px] leading-snug font-semibold break-words">{mo.title}</span>
        <Chip hue={hue}>{STATUS_WORDS[mo.status]}</Chip>
      </div>
      {mo.why && <p className="mt-1 line-clamp-3 text-[14px] leading-snug break-words" style={{ color: INK2 }}>{mo.why}</p>}
      <p className="mt-1.5 text-[13px] break-words" style={{ color: INK3 }}>
        {owner} · {creator}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgb(255 255 255 / 0.1)' }} role="img" aria-label={`${pct}% done`}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${hsl(hue, 90, 70)}, ${hsl(hue, 90, 82)})` }} />
      </div>
      <p className="mt-1 text-[13px]" style={{ color: INK2 }}>{progressWords(p)}{partial ? ` · ${PARTIAL_WORDS}` : ''}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={onTasks} className="flux-focus rounded-full px-3.5 py-1.5 text-[13px] font-semibold hover:bg-white/10" style={{ color: INK, boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
          Its tasks
        </button>
        <button type="button" onClick={() => openClassic({ name: 'motivations', id: mo.id })} className="flux-focus inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold hover:bg-white/10" style={{ color: INK, boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
          In full
          <Glyph name="open" size={13} />
        </button>
      </div>
    </li>
  )
}

/* ---------------------------------------------------------------- decisions: history and rules */

function Decisions({ tab }: { tab: 'history' | 'rules' }) {
  const api = useFlux()
  const pending = useHive((s) => countPending(s.approvals))
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-5 pb-2">
        <Pills value={tab} onChange={(t) => api.openSheet({ page: 'decisions', tab: t })} label="Decisions" options={[['history', 'History'], ['rules', 'Rules']]} />
        {pending > 0 && (
          <button type="button" className="flux-focus rounded-full px-3.5 py-1.5 text-[13px] font-semibold" style={{ color: '#170a22', background: 'radial-gradient(circle at 35% 20%, #fff, #ff9fdc 70%)' }} onClick={() => runFeature({ id: 'decide.approvals' } as Feature, api)}>
            {pending} waiting
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
  const { openMind, openSheet, desktop } = useFlux()
  const list = useMemo(() => Object.values(approvals).filter((a) => a.status !== 'pending').sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at)).slice(0, 120), [approvals])
  const tone: Record<string, string> = { approved: '#8ff0c9', used: '#8ff0c9', denied: '#ffb3c0', expired: INK3 }
  return (
    <Scroll>
      {list.length === 0 && <p className="py-6 text-[15px]" style={{ color: INK2 }}>No decisions yet.</p>}
      <ul className="flex flex-col gap-2">
        {list.map((a) => {
          const ag = agents[a.agent_id]
          return (
            <li key={a.id} className="rounded-[22px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-semibold capitalize" style={{ color: tone[a.status] ?? INK2 }}>{a.status}</span>
                <span style={{ color: INK2 }}>· {when(a.decided_at ?? a.created_at)}</span>
              </div>
              <div className="mt-0.5 text-[15px] leading-snug">
                {ag ? (
                  <button
                    type="button"
                    className="flux-focus rounded font-semibold underline-offset-4 hover:underline"
                    onClick={() => {
                      if (!desktop) openSheet(null)
                      openMind(ag.id)
                    }}
                  >
                    {shown(ag.name)}
                  </button>
                ) : (
                  'A mind'
                )}{' '}
                used <span className="font-semibold">{a.skill}</span>
                {a.decided_by ? <span style={{ color: INK2 }}> · {a.decided_by}</span> : null}
              </div>
              <code className="mt-1.5 block truncate rounded-xl px-3 py-1.5 text-[12px]" style={{ background: 'rgb(0 0 0 / 0.28)', color: INK2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} title={a.command}>
                {a.command}
              </code>
            </li>
          )
        })}
      </ul>
      <OpenLink label="Full history" onClick={() => openClassic({ name: 'approvals', tab: 'history' })} />
    </Scroll>
  )
}

function Rules() {
  const policy = useHive((s) => s.policy)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  // read again for each session (client); a failure belongs to the session it was read under (Surface K1)
  const client = useHive((s) => s.client)
  const ctx = readContext(client)
  const [failed, setFailed] = useState<Tagged<string> | null>(null)
  const err = taggedFor(failed, ctx)
  useEffect(() => {
    useHive.getState().loadPolicy().catch((e: unknown) => setFailed({ ctx, value: e instanceof Error ? e.message : 'Could not read the rules' }))
  }, [ctx])
  const scope = (s: string) => {
    if (s === 'hive') return 'Whole hive'
    const [k, id] = s.split(':')
    if (k === 'swarm') return `Swarm ${swarms[id] ? shown(swarms[id].name) : id}`
    return `Mind ${agents[id] ? shown(agents[id].name) : id}`
  }
  const tone: Record<string, [string, string]> = { allow: ['#0e1a14', '#8ff0c9'], ask: ['#201400', '#ffc46b'], deny: ['#2a0610', '#ff9fb2'] }
  return (
    <Scroll>
      <p className="pb-3 text-[15px] leading-snug" style={{ color: INK2 }}>What minds may do without asking you. The most specific rule wins: a mind, then its swarm, then the hive.</p>
      {err && <p className="rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 90 120 / 0.14)' }}>{err}</p>}
      {!err && policy === null && <p className="py-4 text-[15px]" style={{ color: INK2 }}>Reading the rules…</p>}
      {policy && policy.length === 0 && <p className="py-4 text-[15px]" style={{ color: INK2 }}>No rules yet: every gated skill asks you.</p>}
      <ul className="flex flex-col gap-2">
        {(policy ?? []).map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded-[22px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
            <span className="mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-bold capitalize" style={{ color: tone[r.mode]?.[0] ?? '#170a22', background: tone[r.mode]?.[1] ?? INK2 }}>{r.mode}</span>
            <span className="min-w-0 flex-1">
              <code className="block truncate text-[14px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{r.skill}</code>
              <span className="block truncate text-[13px]" style={{ color: INK2 }}>{scope(r.scope)}</span>
              {r.note && <span className="mt-0.5 block text-[13px]" style={{ color: INK2 }}>{r.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      <OpenLink label="Change rules" onClick={() => openClassic({ name: 'approvals', tab: 'rules' })} />
    </Scroll>
  )
}

/* ---------------------------------------------------------------- activity */

const KIND: Record<string, [string, number]> = { belief: ['belief', 270], message: ['message', 200], status: ['status', 170], error: ['trouble', 350], birth: ['new mind', 40], approval: ['decision', 320], goal: ['task', 150], wakeup: ['woke', 250] }

function Activity() {
  const activity = useHive((s) => s.activity)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { openMind, openSheet, desktop } = useFlux()
  const reduced = useReducedMotion()
  const [kind, setKind] = useState('all')
  const list = useMemo(() => [...activity].reverse().filter((a: ActivityItem) => kind === 'all' || a.kind === kind), [activity, kind])
  return (
    <>
      <div className="px-5 pb-2">
        <Pills value={kind} onChange={setKind} label="Kind" options={[['all', 'All'], ['message', 'Messages'], ['belief', 'Beliefs'], ['goal', 'Tasks'], ['error', 'Trouble']]} className="-mx-5 px-5" />
      </div>
      <Scroll>
        {list.length === 0 && <p className="py-6 text-[15px]" style={{ color: INK2 }}>Quiet for now. Ripples appear here as the hive moves.</p>}
        <ol className="flex flex-col gap-1.5" aria-live="polite">
          <AnimatePresence initial={false}>
            {list.map((a) => {
              const [word, hue] = KIND[a.kind] ?? ['event', 290]
              const ag = a.agent_id ? agents[a.agent_id] : undefined
              const sw = a.swarm_id ? swarms[a.swarm_id] : undefined
              return (
                <m.li key={a.id} layout={!reduced} initial={reduced ? false : { opacity: 0, y: -10, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="flex gap-3 rounded-[20px] px-3.5 py-2.5" style={{ background: 'rgb(255 255 255 / 0.045)' }}>
                  <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: hsl(ag?.hue ?? hue, 90, 72) }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 text-[13px]">
                      {ag ? (
                        <button
                          type="button"
                          className="flux-focus rounded font-semibold hover:underline"
                          onClick={() => {
                            if (!desktop) openSheet(null)
                            openMind(ag.id)
                          }}
                        >
                          {shown(ag.name)}
                        </button>
                      ) : sw ? (
                        <span className="font-semibold">{shown(sw.name)}</span>
                      ) : null}
                      <span style={{ color: hsl(hue, 90, 84) }}>{word}</span>
                      <span style={{ color: INK2 }}>{time(a.at)}</span>
                    </span>
                    <span className="mt-0.5 block text-[14px] leading-snug break-words">{a.statement ? <BeliefSentence statement={a.statement} sure={false} /> : plainText(a.text)}</span>
                  </span>
                </m.li>
              )
            })}
          </AnimatePresence>
        </ol>
      </Scroll>
    </>
  )
}

/* ---------------------------------------------------------------- bring a mind to life */

const NAMES = ['Ripple', 'Tide', 'Eddy', 'Brook', 'Mist', 'Dew', 'Coral', 'Pearl', 'Lagoon', 'Marina', 'Delta', 'Rill', 'Nimbus', 'Spray', 'Fern']

function Create({ start }: { start: string | null }) {
  const api = useFlux()
  const list = useSwarmList()
  const models = useHive((s) => s.models)
  const agents = useHive((s) => s.agents)
  const reduced = useReducedMotion()
  const taken = useMemo(() => new Set(Object.values(agents).map((a) => a.name.toLowerCase())), [agents])
  const [name, setName] = useState('')
  const [sid, setSid] = useState<string>(start ?? list[0]?.id ?? '')
  const [model, setModel] = useState(() => models.find((x) => x.id.includes('sonnet'))?.id ?? models.find((x) => !x.local)?.id ?? models[0]?.id ?? '')
  const [budget, setBudget] = useState('10')
  const [persona, setPersona] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hue] = useState(() => Math.floor(Math.random() * 360))
  const chosen = models.find((x) => x.id === model)
  const clash = !!name.trim() && taken.has(name.trim().toLowerCase())
  const cap = Number(budget)
  // a budget is said, never assumed (an empty one is not $0): the same rule as the reviewed Still form
  const badBudget = budget.trim() === '' || !Number.isFinite(cap) || cap < 0
  const ok = !!name.trim() && !clash && !!model && !badBudget && !busy
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      // Review O-B2: bound to the session it was dispatched in; the token is shown once, after the liquid settles, and
      // only while that session is still the current one (lib/makeMind)
      await makeMind({ name: name.trim(), kind: 'omega', swarm_id: sid || null, model, persona: persona.trim() || undefined, hue, budget_usd: Number.isFinite(cap) ? cap : 0 }, (agent) => {
        api.openSheet(null)
        api.openMind(agent.id)
      }, reduced ? 300 : 1400)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The mind could not be made')
      setBusy(false)
    }
  }
  const label = (t: string) => <div className="mb-1.5 px-1 text-[13px] font-semibold" style={{ color: INK2 }}>{t}</div>
  return (
    <Scroll>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-center gap-3">
          <span className="relative size-12 shrink-0">
            <Orb hue={hue} size={48} />
          </span>
          <p className="text-[14px] leading-snug" style={{ color: INK2 }}>A new drop with sensible defaults. Roles, keys and sharing are on the full form.</p>
        </div>
        <div>
          {label('Name')}
          <div className="flex items-center gap-2">
            <input data-autofocus={api.desktop ? '' : undefined} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" aria-invalid={clash} placeholder="Name the mind" className="flux-field min-w-0 flex-1 rounded-full px-4 py-2.5 text-[15px]" />
            <button type="button" className="flux-focus shrink-0 rounded-full px-3.5 py-2.5 text-[13px] font-semibold hover:bg-white/10" style={{ boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }} onClick={() => setName(NAMES.filter((n) => !taken.has(n.toLowerCase()))[Math.floor(Math.random() * 6)] ?? `Drop-${Math.floor(Math.random() * 999)}`)}>
              Suggest
            </button>
          </div>
          {clash && <p className="mt-1 px-1 text-[13px]" style={{ color: '#ffb3c0' }}>That name is taken.</p>}
        </div>
        <div>
          {label('Swarm')}
          <SwarmPills value={sid} onChange={setSid} none="Roam free" />
        </div>
        <div>
          {label('Model')}
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" className="flux-field flux-select w-full rounded-full px-4 py-2.5 text-[15px]">
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
          {label('Budget')}
          <label className="flux-field flex items-center gap-1 rounded-full px-4 py-2.5 text-[15px]">
            <span style={{ color: INK2 }}>$</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget in US dollars" aria-invalid={badBudget} className="min-w-0 flex-1 bg-transparent tabular-nums outline-none" style={{ color: INK }} />
          </label>
          {!chosen?.local && cap === 0 && <p className="mt-1 px-1 text-[13px]" style={{ color: '#ffd9a0' }}>A paid model with a $0 budget is refused every call.</p>}
        </div>
        <div>
          {label('Persona (optional)')}
          <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={3} aria-label="Persona" placeholder="Who is it, and what is it for?" className="flux-field w-full resize-none rounded-[22px] px-4 py-2.5 text-[14px]" />
        </div>
        {err && <p role="alert" className="rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 90 120 / 0.14)' }}>{err}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <m.button type="submit" whileTap={{ scale: 0.94 }} disabled={!ok} className="flux-focus rounded-full px-5 py-3 text-[16px] font-semibold disabled:opacity-40" style={{ color: '#170a22', background: `radial-gradient(circle at 30% 20%, #fff, ${hsl(hue, 90, 80)} 70%)`, boxShadow: `0 0 24px ${hsl(hue, 90, 65, 0.4)}` }}>
            {busy ? 'Forming…' : 'Bring it to life'}
          </m.button>
          <button type="button" onClick={() => openClassic(sid ? { name: 'new', swarm: sid } : { name: 'new' })} className="flux-focus inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold hover:bg-white/10" style={{ color: INK, boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
            Full form <Glyph name="open" size={14} />
          </button>
        </div>
      </form>
    </Scroll>
  )
}

/* ---------------------------------------------------------------- spend (read only) */

function Usage() {
  const agents = useHive((s) => s.agents)
  const usage = useHive((s) => s.usage)
  const budgets = useHive((s) => s.budgets)
  const { openMind, openSheet, desktop } = useFlux()
  const [since] = useState(() => Date.now() - 24 * 3600 * 1000)
  const all = Object.values(agents)
  const spent = all.reduce((n, a) => n + (a.spent_usd || 0), 0)
  const cap = all.reduce((n, a) => n + (a.budget_usd || 0), 0)
  const day = usage.filter((u) => Date.parse(u.created_at) >= since)
  const cost24 = day.reduce((n, u) => n + u.cost_usd, 0)
  const tok24 = day.reduce((n, u) => n + u.prompt_tokens + u.completion_tokens, 0)
  const top = [...all].sort((a, b) => b.spent_usd - a.spent_usd).slice(0, 8)
  const max = top[0]?.spent_usd || 1
  const meter = (v: number, hue: number, label: string) => (
    <div className="relative h-2 overflow-hidden rounded-full" style={{ background: 'rgb(255 255 255 / 0.1)' }} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, v)} aria-label={label}>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(1, Math.max(0, v)) * 100}%`, background: v > 0.85 ? 'linear-gradient(90deg, #ff9fb2, #ff6f8f)' : `linear-gradient(90deg, ${hsl(hue, 90, 70)}, ${hsl(hue + 40, 90, 78)})` }} />
    </div>
  )
  return (
    <Scroll>
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Spent', money(spent)],
          ['Spent this visit', money(cost24)],
          ['Tokens this visit', tok24 >= 1000 ? `${(tok24 / 1000).toFixed(tok24 >= 100000 ? 0 : 1)}k` : String(tok24)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-[20px] px-3 py-3" style={{ background: 'rgb(255 255 255 / 0.06)' }}>
            <div className="text-[19px] font-semibold tabular-nums">{v}</div>
            <div className="text-[12px]" style={{ color: INK2 }}>{k}</div>
          </div>
        ))}
      </div>
      {cap > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-[13px]" style={{ color: INK2 }}>
            <span>Of all budgets</span>
            <span className="tabular-nums">{money(spent)} / {money(cap)}</span>
          </div>
          {meter(spent / cap, 300, 'Share of all budgets spent')}
        </div>
      )}
      {budgets && budgets.length > 0 && (
        <>
          <H3>Limits</H3>
          <ul className="flex flex-col gap-3">
            {budgets.map((b) => (
              <li key={b.id}>
                <div className="mb-1 flex justify-between gap-2 text-[13px]" style={{ color: INK2 }}>
                  <span className="truncate">{b.scope} · {b.period}</span>
                  <span className="shrink-0 tabular-nums">{money(b.spent_usd)} / {money(b.limit_usd)}</span>
                </div>
                {meter(b.limit_usd ? b.spent_usd / b.limit_usd : 0, 170, `${b.scope} ${b.period} limit used`)}
              </li>
            ))}
          </ul>
        </>
      )}
      <H3>Who spends most</H3>
      <ul className="flex flex-col gap-1">
        {top.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flux-focus flex w-full items-center gap-3 rounded-[18px] px-2 py-2 text-left hover:bg-white/[0.06]"
              onClick={() => {
                if (!desktop) openSheet(null)
                openMind(a.id)
              }}
            >
              <span className="relative size-6 shrink-0">
                <Orb hue={a.hue} size={24} dim={a.status !== 'awake'} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex justify-between gap-2 text-[14px]">
                  <span className="truncate font-semibold">{shown(a.name)}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: INK2 }}>
                    {money(a.spent_usd)}
                    {a.budget_usd ? ` / ${money(a.budget_usd)}` : ''}
                  </span>
                </span>
                <span className="mt-1 block">{meter(a.budget_usd ? a.spent_usd / a.budget_usd : a.spent_usd / max, a.hue, `${shown(a.name)} spend`)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <OpenLink label="Limits and reservations" onClick={() => openClassic({ name: 'usage' })} />
    </Scroll>
  )
}

/* ---------------------------------------------------------------- help */

function Help() {
  const rows: [string, string][] = [
    ['Bodies of liquid', 'Swarms; their colour is the mix of their minds'],
    ['Droplets', 'Minds; bright when awake, stirring when they think'],
    ['Drips at the top', 'Decisions waiting on you'],
    ['Whispers', 'New beliefs, tasks and trouble, as they happen'],
    ['The pill', 'Home, decisions, new mind, start a swarm, everything'],
    ['The Omega mark, bottom left', 'Change experience, and the way back to the Classic hive'],
  ]
  return (
    <Scroll>
      <ul className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <li key={k} className="rounded-[20px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
            <div className="text-[15px] font-semibold">{k}</div>
            <div className="text-[14px]" style={{ color: INK2 }}>{v}</div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[14px] leading-snug" style={{ color: INK2 }}>Touch a body to pour it into glass; touch a droplet to talk. Escape drains the top glass. The guided tour is in Search and commands (⌘K).</p>
      <button type="button" onClick={openPalette} className="flux-focus mt-3 rounded-full px-4 py-2.5 text-[14px] font-semibold" style={{ color: '#170a22', background: 'radial-gradient(circle at 35% 20%, #fff, #f0c8ff 70%)' }}>
        Search and commands
      </button>
    </Scroll>
  )
}

/** After a task decision: back to what opened it, or (the task moved lists and its row is gone) to the tasks controls. */
const goalsHome = (opener: HTMLElement | null) => (opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-goals-home]'))
