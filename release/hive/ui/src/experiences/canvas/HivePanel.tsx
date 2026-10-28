import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { asWritten, AsWritten, beliefText, compareSureness, GROUP_LABEL, Sureness, openClassic, openFeature, readContext, readPeople, shown, taggedFor, useHive, type Approval, type Feature, type Tagged } from '../sdk'
import { ago, useClock } from './data'
import { Avatar } from './parts'
import { BOARD, HIVE_ENTRIES, wayFor, type CardId } from './nav'
import { creatorLine, ownerLine, PARTIAL_WORDS, useCountsPartial, useMotivationData } from '../../lib/motivations'
import { useMe } from '../../lib/useAdmin'
import { motivationRows, progressWords } from './motives'

/**
 * "Hive": everything in the hive from Canvas's own top bar. Board features act on the board; beliefs, motivations,
 * decision history, usage and people are Canvas cards here; mind features ask which mind (the selected one first); the
 * rest open their page, which wears Canvas's chrome. Nothing needs the Ω menu.
 */
export function HivePanel({ onClose, onBoard, selectedMind }: { onClose: () => void; onBoard: (featureId: string) => void; selectedMind: string | null }) {
  const head = useId()
  const [q, setQ] = useState('')
  const [card, setCard] = useState<CardId | null>(null)
  const [forMind, setForMind] = useState<Feature | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus({ preventScroll: true }), [card, forMind])
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const by = new Map<string, Feature[]>()
    for (const f of HIVE_ENTRIES) if (words.every((w) => `${f.label} ${f.blurb} ${f.keywords ?? ''}`.toLowerCase().includes(w))) by.set(f.group, [...(by.get(f.group) ?? []), f])
    return [...by.entries()]
  }, [q])
  const pick = (f: Feature) => {
    const way = wayFor(f)
    if (way === 'board') return (onClose(), onBoard(f.id))
    if (way === 'card') return setCard(f.id as CardId)
    if (way === 'mind') {
      if (selectedMind) return (onClose(), openFeature(f, selectedMind))
      setQ('')
      return setForMind(f)
    }
    onClose()
    openFeature(f)
  }
  const back = card || forMind ? () => (setCard(null), setForMind(null)) : null
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (back) back()
    else onClose()
  }
  const title = card ? HIVE_ENTRIES.find((f) => f.id === card)?.label : forMind ? `${forMind.label}: which mind?` : 'Hive'
  return (
    <section
      data-chrome
      data-ownkeys
      data-cv-hive
      aria-labelledby={head}
      onKeyDown={onKeyDown}
      className="absolute top-[64px] right-3 bottom-[72px] flex w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-[16px] border border-[var(--chrome-line)] bg-[var(--card)] shadow-[var(--shadow-lg)] select-text"
      style={{ zIndex: 46 }}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--line)] px-3 py-2">
        {back && (
          <button onClick={back} aria-label="Back to everything" className="grid size-8 place-items-center rounded-[8px] text-[16px] text-[var(--ink-2)] hover:bg-[var(--accent-soft)]">
            ‹
          </button>
        )}
        <h2 id={head} className="m-0 min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-[var(--ink)]">
          {title}
        </h2>
        <button onClick={onClose} className="h-8 shrink-0 rounded-[8px] px-2.5 text-[13px] font-medium text-[var(--ink-2)] hover:bg-[var(--accent-soft)]">
          Close
        </button>
      </div>
      {!card && (
        <label className="border-b border-[var(--line)] px-3 py-2">
          <span className="sr-only">{forMind ? 'Find a mind' : 'Find anything in the hive'}</span>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={forMind ? 'Find a mind…' : 'Find anything: memory, budget, people…'}
            className="h-9 w-full rounded-[8px] border border-[var(--line-2)] bg-[var(--card-2)] px-3 text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)] focus:border-[var(--accent)]"
          />
        </label>
      )}
      <div data-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-3" style={{ touchAction: 'pan-y' }}>
        {card ? (
          <Card id={card} />
        ) : forMind ? (
          <MindPick q={q} onPick={(id) => (onClose(), openFeature(forMind, id))} />
        ) : (
          <>
            {groups.length === 0 && <p className="m-0 px-2 py-6 text-center text-[13px] text-[var(--ink-2)]">Nothing matches “{q}”.</p>}
            {groups.map(([g, items]) => (
              <section key={g} aria-label={GROUP_LABEL[g as keyof typeof GROUP_LABEL]} className="mt-1.5">
                <h3 className="m-0 px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">{GROUP_LABEL[g as keyof typeof GROUP_LABEL]}</h3>
                {items.map((f) => (
                  <button key={f.id} onClick={() => pick(f)} className="flex w-full items-center gap-3 rounded-[10px] px-2 py-1.5 text-left hover:bg-[var(--accent-soft)]">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium text-[var(--ink)]">{f.label}</span>
                      <span className="block truncate text-[12px] text-[var(--ink-2)]">{f.blurb}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--ink-3)]">{WAY_NOTE[wayFor(f) ?? 'page'](f)}</span>
                  </button>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </section>
  )
}

const WAY_NOTE: Record<string, (f: Feature) => string> = {
  board: (f) => (BOARD[f.id] ? 'on the canvas' : ''),
  card: () => 'card',
  mind: () => 'pick a mind',
  page: () => 'page',
}

function MindPick({ q, onPick }: { q: string; onPick: (id: string) => void }) {
  const agents = useHive((s) => s.agents)
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return Object.values(agents)
      .filter((a) => words.every((w) => shown(a.name).toLowerCase().includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, q])
  if (!list.length) return <p className="m-0 px-2 py-6 text-center text-[13px] text-[var(--ink-2)]">No mind matches.</p>
  return (
    <ul className="m-0 list-none p-0 pt-1">
      {list.map((a) => (
        <li key={a.id}>
          <button onClick={() => onPick(a.id)} className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-[var(--accent-soft)]">
            <Avatar name={a.name} hue={a.hue} size={24} radius={7} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--ink)]">{shown(a.name)}</span>
            <span className="shrink-0 text-[11.5px] text-[var(--ink-3)]">{a.status}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------ cards

function Card({ id }: { id: CardId }) {
  if (id === 'swarms.beliefs') return <Beliefs />
  if (id === 'work.motivations') return <Motivations />
  if (id === 'decide.history') return <History />
  if (id === 'money.usage') return <Usage />
  return <People />
}

const Muted = ({ children }: { children: ReactNode }) => <p className="m-0 px-2 py-3 text-[13px] leading-[1.45] text-[var(--ink-2)]">{children}</p>
const Full = ({ label, run }: { label: string; run: () => void }) => (
  <button onClick={run} className="mx-2 mt-3 h-8 rounded-[8px] border border-[var(--line-2)] px-3 text-[12.5px] font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]">
    {label}
  </button>
)
const Bar = ({ value, tone = 'var(--accent)' }: { value: number; tone?: string }) => (
  <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--line)]" aria-hidden>
    <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: tone }} />
  </span>
)

function Beliefs() {
  const swarms = useHive((s) => s.swarms)
  const list = useMemo(() => Object.values(swarms).sort((a, b) => a.name.localeCompare(b.name)), [swarms])
  const [sid, setSid] = useState<string | null>(list[0]?.id ?? null)
  const beliefs = useHive((s) => (sid ? s.beliefs[sid] : undefined))
  const loaded = useHive((s) => (sid ? !!s.beliefsLoaded[sid] : false))
  const now = useClock(60_000)
  useEffect(() => {
    if (sid) void useHive.getState().loadBeliefs(sid).catch(() => undefined)
  }, [sid])
  const rows = useMemo(() => Object.values(beliefs ?? {}).sort((a, b) => compareSureness(b.tv, a.tv) || b.updated_at.localeCompare(a.updated_at)), [beliefs])
  if (!list.length) return <Muted>No swarms yet. Start one from the toolbar.</Muted>
  return (
    <div className="pt-2">
      <div className="flex flex-wrap gap-1.5 px-2" role="group" aria-label="Swarm">
        {list.map((s) => (
          <button key={s.id} aria-pressed={s.id === sid} onClick={() => setSid(s.id)} className="h-7 max-w-full truncate rounded-full px-2.5 text-[12.5px] font-medium" style={s.id === sid ? { background: 'var(--accent)', color: 'var(--on-accent)' } : { border: '1px solid var(--line-2)', color: 'var(--ink)' }}>
            {shown(s.name)}
          </button>
        ))}
      </div>
      {!loaded && <Muted>Reading beliefs…</Muted>}
      {loaded && rows.length === 0 && <Muted>This swarm holds no shared beliefs yet.</Muted>}
      <ul className="m-0 mt-2 list-none p-0">
        {rows.map((b) => (
          <li key={b.statement} className="mx-1 mb-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--card-2)] px-2.5 py-2">
            <div className="text-[13px] leading-[1.45] text-[var(--ink)] [overflow-wrap:anywhere]">{beliefText(b.statement)}</div>
            <div className="mt-1.5 grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2 text-[11.5px] text-[var(--ink-2)]" aria-hidden="true">
              {/* uifix-r3.4 (Kimi 3): each number named for what it is; how sure is the word below */}
              <span>likelihood</span>
              <Bar value={b.tv.f} />
              <span>confidence</span>
              <Bar value={b.tv.c} tone="var(--good)" />
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-3)]">
              <Sureness tv={b.tv} /> · {b.sources.length} source{b.sources.length === 1 ? '' : 's'} · updated {ago(b.updated_at, now)}
              <AsWritten text={asWritten(b.statement, b.tv)} />
            </div>
          </li>
        ))}
      </ul>
      {sid && <Full label="Evidence and history" run={() => openClassic({ name: 'swarm', id: sid })} />}
    </div>
  )
}

/**
 * Motivations, read-only in Canvas's grammar: the why above the tasks. Each says what it is for, its status, who it
 * belongs to and who made it (a person or a mind), and its progress with every task counted once. Opening one, or the
 * full list, goes to the classic Motivations page, where they are made, edited and linked.
 */
export function Motivations() {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const taskLinks = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const rows = useMemo(() => motivationRows(motivations, taskLinks, goals), [motivations, taskLinks, goals])
  // a read that did not finish: every count here may be short (stand-in P2-4 on 57e64ca)
  const partial = useCountsPartial()
  const counted = (p: Parameters<typeof progressWords>[0]) => `${progressWords(p)}${partial ? ` · ${PARTIAL_WORDS}` : ''}`
  const ctx = { me, agents, swarms }
  const full = <Full label="All motivations and their tasks" run={() => openClassic({ name: 'motivations' })} />
  if (!supported) return <Muted>This hive does not have motivations yet.</Muted>
  if (!loaded && rows.length === 0) return <Muted>Reading motivations…</Muted>
  return (
    <div className="pt-1">
      <Muted>Why the work matters. Each motivation gathers the tasks that serve it; a task can serve several and is counted once.</Muted>
      {rows.length === 0 && <Muted>No motivations yet. Name one on the Motivations page, then file tasks under it.</Muted>}
      <ul className="m-0 list-none p-0">
        {rows.map(({ m, status, progress }) => {
          const quiet = m.status !== 'active'
          return (
            <li key={m.id} data-cv-motivation={m.id} className="mx-1 mb-1.5">
              <button
                onClick={() => openClassic({ name: 'motivations', id: m.id })}
                aria-label={`Open the motivation ${m.title}: ${status}, ${counted(progress)}`}
                className="block w-full rounded-[10px] border border-[var(--line)] bg-[var(--card-2)] px-2.5 py-2 text-left hover:border-[var(--line-2)]"
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-[var(--ink)] [overflow-wrap:anywhere]">{m.title}</span>
                  <span className="shrink-0 text-[11.5px] font-semibold" style={{ color: quiet ? 'var(--ink-3)' : 'var(--good)' }}>
                    {status}
                  </span>
                </span>
                {m.why && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-[1.4] text-[var(--ink-2)]">{m.why}</span>}
                <span className="mt-1 block truncate text-[11.5px] text-[var(--ink-3)]">
                  {ownerLine(m, ctx)} · {creatorLine(m, ctx)}
                </span>
                <span className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-x-2 text-[11.5px] text-[var(--ink-2)]">
                  <Bar value={progress.ratio ?? 0} tone={progress.failed ? 'var(--warn)' : 'var(--good)'} />
                  <span className="tabular-nums">{counted(progress)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {full}
      <Full label="Tasks under no motivation" run={() => openClassic({ name: 'tasks', motivation: 'none' })} />
    </div>
  )
}

const DECIDED: Record<string, string> = { approved: 'Allowed', denied: 'Refused', expired: 'Expired', used: 'Allowed once, used' }

function History() {
  const approvals = useHive((s) => s.approvals)
  const agents = useHive((s) => s.agents)
  const now = useClock(30_000)
  const rows = useMemo(
    () =>
      (Object.values(approvals) as Approval[])
        .filter((a) => a.status !== 'pending')
        .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))
        .slice(0, 60),
    [approvals],
  )
  return (
    <div className="pt-1">
      {rows.length === 0 && <Muted>Nothing has been decided yet.</Muted>}
      <ul className="m-0 list-none p-0">
        {rows.map((a) => (
          <li key={a.id} className="mx-1 border-b border-[var(--line)] px-1.5 py-2 last:border-b-0">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 text-[13.5px] text-[var(--ink)] [overflow-wrap:anywhere]">
                <span className="font-semibold">{shown(agents[a.agent_id]?.name ?? 'A mind')}</span> · {a.skill}
              </span>
              <span className="shrink-0 text-[12px] font-semibold" style={{ color: a.status === 'denied' ? 'var(--bad)' : a.status === 'expired' ? 'var(--ink-3)' : 'var(--good)' }}>
                {DECIDED[a.status] ?? a.status}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--ink-2)]" title={a.command}>
              {a.command}
            </div>
            <div className="mt-0.5 text-[11.5px] text-[var(--ink-3)]">
              {a.decided_by ? `by ${a.decided_by} · ` : ''}
              {ago(a.decided_at ?? a.created_at, now)}
            </div>
          </li>
        ))}
      </ul>
      <Full label="Full history and rules" run={() => openClassic({ name: 'approvals', tab: 'history' })} />
    </div>
  )
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`

function Usage() {
  const agents = useHive((s) => s.agents)
  const rows = useMemo(() => Object.values(agents).sort((a, b) => b.spent_usd - a.spent_usd || a.name.localeCompare(b.name)), [agents])
  const total = rows.reduce((n, a) => n + a.spent_usd, 0)
  const budget = rows.reduce((n, a) => n + a.budget_usd, 0)
  return (
    <div className="pt-2">
      <div className="mx-1 rounded-[10px] border border-[var(--line)] bg-[var(--card-2)] px-3 py-2.5">
        <div className="text-[12px] text-[var(--ink-2)]">Spent by every mind, against their budgets</div>
        <div className="mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink)] tabular-nums">
          {usd(total)} <span className="text-[14px] font-normal text-[var(--ink-3)]">of {usd(budget)}</span>
        </div>
      </div>
      <ul className="m-0 mt-2 list-none p-0">
        {rows.map((a) => {
          const frac = a.budget_usd > 0 ? a.spent_usd / a.budget_usd : 0
          return (
            <li key={a.id} className="mx-1 px-1.5 py-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Avatar name={a.name} hue={a.hue} size={20} radius={6} />
                <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{shown(a.name)}</span>
                <span className="shrink-0 text-[var(--ink-2)] tabular-nums">
                  {usd(a.spent_usd)} / {usd(a.budget_usd)}
                </span>
              </div>
              <div className="mt-1 pl-7">
                <Bar value={frac} tone={frac > 0.9 ? 'var(--bad)' : frac > 0.7 ? 'var(--warn)' : 'var(--accent)'} />
              </div>
            </li>
          )
        })}
      </ul>
      <Full label="Spend, limits and calls to settle" run={() => openClassic({ name: 'usage' })} />
    </div>
  )
}

type PeopleState = { status: 'loading' } | { status: 'none' } | { status: 'error'; message: string } | { status: 'ok'; data: NonNullable<Awaited<ReturnType<typeof readPeople>>> }

function People() {
  // Surface K1 audit: read again for each client; an answer read through another client is not shown
  const client = useHive((s) => s.client)
  const [read, setSt] = useState<Tagged<PeopleState> | null>(null)
  const st: PeopleState = taggedFor(read, readContext(client)) ?? { status: 'loading' }
  const now = useClock(60_000)
  useEffect(() => {
    let live = true
    const ctx = readContext(client)
    readPeople().then(
      (d) => live && setSt({ ctx, value: d ? { status: 'ok', data: d } : { status: 'none' } }),
      (e: unknown) => live && setSt({ ctx, value: { status: 'error', message: e instanceof Error ? e.message : String(e) } }),
    )
    return () => {
      live = false
    }
  }, [client])
  const full = <Full label="Invite and manage people" run={() => openClassic({ name: 'people' })} />
  if (st.status === 'loading') return <Muted>Reading who can use this hive…</Muted>
  if (st.status === 'none') return <>{<Muted>This hive does not list its people to you.</Muted>}{full}</>
  if (st.status === 'error') return <>{<Muted>Could not read people: {st.message}</Muted>}{full}</>
  const pending = st.data.invites.filter((i) => i.status === 'pending')
  return (
    <div className="pt-1">
      <ul className="m-0 list-none p-0">
        {st.data.people.map((p) => (
          <li key={p.id} className="mx-1 flex items-center gap-2.5 border-b border-[var(--line)] px-1.5 py-2 last:border-b-0">
            <Avatar name={p.name || p.email} hue={hashHue(p.id)} size={26} radius={13} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-[var(--ink)]">
                {p.name || p.email}
                {p.disabled && <span className="font-normal text-[var(--ink-3)]"> · disabled</span>}
              </span>
              <span className="block truncate text-[12px] text-[var(--ink-2)]">{p.email}</span>
            </span>
            <span className="shrink-0 text-right text-[11.5px] text-[var(--ink-3)]">
              <span className="block font-semibold text-[var(--ink-2)]">{p.role}</span>
              {p.last_seen_at ? `seen ${ago(p.last_seen_at, now)}` : 'not yet seen'}
            </span>
          </li>
        ))}
      </ul>
      {pending.length > 0 && <Muted>{pending.length === 1 ? 'One invitation is' : `${pending.length} invitations are`} waiting to be accepted.</Muted>}
      {full}
    </div>
  )
}

const hashHue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
