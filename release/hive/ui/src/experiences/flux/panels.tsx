import { useVisibleAuthority } from '../../lib/useVisibleAuthority'
import { healthCheck } from '../../lib/healthQuestion'
import { HealthCheckLabel } from '../../ui/HealthCheckLabel'
import { plural } from '../../lib/plural'
import { AnimatePresence, m, useIsPresent } from 'framer-motion'
import { useDraft } from '../drafts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { BeliefSentence, closeToHome, hsl, openClassic, PlainText, plainText, shown, Sureness, useHive, useReducedMotion, type Agent, type Approval, type Belief, type Goal, type Message } from '../sdk'
import { ApprovalDecision } from '../ApprovalDecision'
import { useMotivationData } from '../../lib/motivations'
import type { MotivationRef, Trace } from '../../api/types'
import { INK, INK2, INK3, statusLine, useFlux, type Origin } from './ctx'
import { Chip, GlassButton, Glyph, LiquidPanel, LiquidSwitch, MotivationChip, Slot, ThinkingDrops } from './kit'
import { guardComposing } from '../../features/ask/keys'
import { SurenessMeter } from './SurenessMeter'

export function useFluxApprovalAuthority(id: string) {
  const { decisionOwner } = useFlux()
  const cardOwner = useMemo(() => ({ ...decisionOwner, matches: (value: unknown) => (value as { id: string } | null)?.id === id }), [decisionOwner, id])
  return useVisibleAuthority('hive-pro', useIsPresent(), id, cardOwner)
}

const EMPTY_M: Message[] = []
const EMPTY_P: never[] = []
const EMPTY_B: Record<string, Belief> = {}
const EMPTY_L: MotivationRef[] = []

function usePanelGeometry() {
  const { desktop } = useFlux()
  return desktop ? 'fixed right-5 top-5 bottom-[max(20px,var(--os-clock-lift,0px),var(--ask-room,0px))] z-30 w-[452px]' : 'fixed inset-x-2 bottom-[calc(max(76px,var(--ask-room,0px))+var(--sab,0px))] top-[26%] z-30'
}

const toggle = (a: Agent) => {
  const act = useHive.getState().agentAction
  if (a.status === 'awake' || a.status === 'starting') void act(a.id, 'sleep')
  else if (a.status === 'stopped' || a.status === 'created') void act(a.id, 'start')
  else void act(a.id, 'wake')
}

const OPEN_GOAL = new Set(['open', 'claimed', 'waiting', 'stalled', 'submitted'])

// ---------------------------------------------------------------- swarm

export function SwarmPanel({ id, origin }: { id: string; origin?: Origin }) {
  const geo = usePanelGeometry()
  const { openMind, openSheet } = useFlux()
  const swarm = useHive((s) => s.swarms[id])
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const goalsAll = useHive((s) => s.goals)
  const beliefs = useHive((s) => s.beliefs[id] ?? EMPTY_B)
  const minds = useMemo(() => Object.values(agents).filter((a) => a.swarm_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name)), [agents, id])
  const goals = useMemo(() => Object.values(goalsAll).filter((g) => g.swarm_id === id && OPEN_GOAL.has(g.status)).sort((a, b) => b.priority - a.priority).slice(0, 5), [goalsAll, id])
  const nBeliefs = Object.keys(beliefs).length
  const awake = minds.filter((a) => a.status === 'awake').length
  const busy = minds.filter((a) => a.status === 'awake' && (thinking[a.id] === 'llm' || thinking[a.id] === 'skills')).length
  const [goal, setGoal] = useDraft(`flux:task:${id}`)
  // the motivations each task serves (association only), read once for this session
  useMotivationData()
  const links = useHive((s) => s.taskLinks)

  useEffect(() => {
    void useHive.getState().loadGoals(id).catch(() => undefined)
    void useHive.getState().loadBeliefs(id).catch(() => undefined)
  }, [id])

  if (!swarm) return null
  const addGoal = () => {
    const t = goal.trim()
    if (!t) return
    setGoal('')
    void useHive.getState().createGoal(id, { title: t })
  }
  return (
    <LiquidPanel glassKey={`panel-swarm-${id}`} origin={origin} label={`${shown(swarm.name)} swarm`} className={`${geo} flex flex-col overflow-hidden`}>
      <div className="flex items-start gap-4 px-6 pt-6 pb-4">
        <Slot slotKey={`swarm:${id}`} size={64} hue={swarm.hue} />
        <div className="min-w-0 flex-1 pt-1">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: INK3 }}>Swarm</div>
          <h2 className="truncate text-[30px] leading-[1.1] font-semibold tracking-[-0.01em]">{shown(swarm.name)}</h2>
        </div>
        <GlassButton label="Close" icon="close" onClick={closeToHome} autoFocus />
      </div>
      <div data-flux-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6" style={{ scrollbarWidth: 'thin' }}>
        {swarm.description && <p className="mb-4 text-[15px] leading-relaxed" style={{ color: INK2 }}>{swarm.description}</p>}
        <div className="mb-6 flex flex-wrap gap-2">
          <Chip>{minds.length} {minds.length === 1 ? 'mind' : 'minds'}</Chip>
          <Chip>{awake} awake</Chip>
          {busy > 0 && <Chip hue={swarm.hue}>{busy} thinking</Chip>}
          <Chip>{nBeliefs} shared {nBeliefs === 1 ? 'belief' : 'beliefs'}</Chip>
        </div>
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em]" style={{ color: INK3 }}>Minds</h3>
        {minds.length === 0 ? (
          <div className="rounded-3xl p-5 text-[15px]" style={{ background: 'rgb(255 255 255 / 0.05)', color: INK2 }}>
            No minds in this swarm yet.
            <button type="button" className="flux-focus mt-3 block rounded-full px-4 py-2 text-[14px] font-semibold" style={{ color: '#1a0b24', background: hsl(swarm.hue, 90, 78) }} onClick={() => openClassic({ name: 'new', swarm: id })}>
              Bring a mind to life
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {minds.map((a, i) => (
              <m.li key={a.id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 + i * 0.05, type: 'spring', stiffness: 260, damping: 22 }}>
                <MindRow agent={a} thinking={thinking[a.id]} onOpen={(o) => openMind(a.id, o)} />
              </m.li>
            ))}
          </ul>
        )}
        <h3 className="mt-7 mb-2 text-[13px] font-semibold uppercase tracking-[0.12em]" style={{ color: INK3 }}>Tasks</h3>
        <div className="flex flex-col gap-1.5">
          {goals.length === 0 && <p className="text-[14px]" style={{ color: INK2 }}>No open tasks. Give the swarm one below.</p>}
          {goals.map((g) => <GoalRow key={g.id} goal={g} links={links[g.id] ?? EMPTY_L} onMotivation={(mo) => openSheet({ page: 'goals', swarm: id, motivation: mo })} />)}
        </div>
        <form
          className="mt-3 flex items-center gap-2 rounded-full p-1.5 pl-4"
          style={{ background: 'rgb(255 255 255 / 0.07)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)' }}
          onSubmit={(e) => { e.preventDefault(); addGoal() }}
        >
          <label className="sr-only" htmlFor={`flux-goal-${id}`}>New task for {shown(swarm.name)}</label>
          <input id={`flux-goal-${id}`} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Give the swarm a task…" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#c8bddb]" style={{ color: INK }} />
          <button type="submit" disabled={!goal.trim()} aria-label="Add task" className="flux-focus grid size-9 place-items-center rounded-full disabled:opacity-40" style={{ color: '#1a0b24', background: hsl(swarm.hue, 90, 78) }}>
            <Glyph name="plus" size={18} stroke={2.4} />
          </button>
        </form>
        <div className="mt-7 flex flex-wrap gap-2">
          <ClassicLink label="Swarm page" onClick={() => openClassic({ name: 'swarm', id })} />
          <ClassicLink label="Tasks" onClick={() => openClassic({ name: 'tasks', swarm: id })} />
          <ClassicLink label="Add a mind" onClick={() => openClassic({ name: 'new', swarm: id })} />
        </div>
      </div>
    </LiquidPanel>
  )
}

function MindRow({ agent: a, thinking, onOpen }: { agent: Agent; thinking?: string; onOpen: (o: Origin) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const busy = a.status === 'awake' && (thinking === 'llm' || thinking === 'skills')
  const dim = a.status !== 'awake' && a.status !== 'starting'
  const open = () => {
    const s = ref.current?.querySelector('[aria-hidden]')?.getBoundingClientRect()
    onOpen(s ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 })
  }
  return (
    <div className="group flex items-center gap-2 rounded-[22px] pr-2 transition-colors hover:bg-white/[0.06]">
      <button ref={ref} type="button" onClick={open} className="flux-focus flex min-w-0 flex-1 items-center gap-3.5 rounded-[22px] p-2 text-left" aria-label={`Talk to ${shown(a.name)}, ${statusLine(a, thinking)}`}>
        <Slot slotKey={`mind:${a.id}`} size={46} hue={a.hue} dim={dim} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-semibold">{shown(a.name)}</span>
          <span className="flex items-center gap-1.5 truncate text-[13px]" style={{ color: INK2 }}>
            <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: a.status === 'error' ? '#ff7a8f' : dim ? '#9d93ad' : hsl(a.hue, 90, 70), boxShadow: busy ? `0 0 8px ${hsl(a.hue, 90, 70)}` : undefined }} />
            {statusLine(a, thinking)}
            <span aria-hidden>·</span>
            <span className="truncate">{a.model.split('/').pop()}</span>
          </span>
        </span>
      </button>
      <GlassButton label={a.status === 'awake' || a.status === 'starting' ? `Put ${shown(a.name)} to sleep` : `Wake ${shown(a.name)}`} icon={a.status === 'awake' || a.status === 'starting' ? 'moon' : 'sun'} size={36} onClick={() => toggle(a)} />
    </div>
  )
}

function GoalRow({ goal: g, links, onMotivation }: { goal: Goal; links: MotivationRef[]; onMotivation: (id: string) => void }) {
  const agents = useHive((s) => s.agents)
  const who = g.claimed_by ? agents[g.claimed_by] : null
  return (
    <div className="rounded-2xl px-3.5 py-2.5" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
      <div className="flex items-center gap-3">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: who ? hsl(who.hue, 90, 68) : '#b9add0' }} />
        <span className="min-w-0 flex-1 truncate text-[14px]">{plainText(g.title)}</span>
        <span className="shrink-0 text-[12px]" style={{ color: INK2 }}>{who ? shown(who.name) : g.status}</span>
      </div>
      {links.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-5" data-task-chips>
          {links.map((l) => (
            <MotivationChip key={l.id} m={l} onClick={() => onMotivation(l.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClassicLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flux-focus inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold hover:bg-white/10" style={{ color: INK, boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
      {label}
      <Glyph name="open" size={14} />
    </button>
  )
}

// ---------------------------------------------------------------- mind

type Tab = 'talk' | 'beliefs' | 'thinking' | 'more'

export function MindPanel({ id, origin }: { id: string; origin?: Origin }) {
  const geo = usePanelGeometry()
  const { openSwarm } = useFlux()
  const agent = useHive((s) => s.agents[id])
  const swarm = useHive((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const thinking = useHive((s) => s.thinking[id])
  const [tab, setTab] = useState<Tab>('talk')
  if (!agent) return null
  const dim = agent.status !== 'awake' && agent.status !== 'starting'
  return (
    <LiquidPanel glassKey={`panel-mind-${id}`} origin={origin} label={`Conversation with ${shown(agent.name)}`} className={`${geo} flex flex-col overflow-hidden`}>
      <div className="flex items-start gap-3 px-5 pt-5">
        {swarm ? <GlassButton label={`Back to ${shown(swarm.name)}`} icon="back" size={38} onClick={() => openSwarm(swarm.id)} /> : <span className="w-1" />}
        <Slot slotKey={`mindhead:${id}`} size={62} hue={agent.hue} dim={dim} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="truncate text-[28px] leading-[1.1] font-semibold tracking-[-0.01em]">{shown(agent.name)}</h2>
          <div className="mt-0.5 truncate text-[13px]" style={{ color: INK2 }}>
            {statusLine(agent, thinking)}{swarm ? ` · ${shown(swarm.name)}` : ' · roams free'} · {agent.model.split('/').pop()}
          </div>
        </div>
        <GlassButton label="Close" icon="close" size={38} onClick={closeToHome} />
      </div>
      <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
        <div role="tablist" aria-label="Views" className="relative flex rounded-full p-1" style={{ background: 'rgb(255 255 255 / 0.06)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.12)' }}>
          {(['talk', 'beliefs', 'thinking', 'more'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className="flux-focus relative rounded-full px-3.5 py-1.5 text-[14px] font-semibold capitalize" style={{ color: tab === t ? '#170a22' : INK }}>
              {tab === t && <m.span layoutId={`flux-tab-${id}`} className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle at 35% 20%, #fff, ${hsl(agent.hue, 90, 80)} 70%)`, boxShadow: `0 0 18px ${hsl(agent.hue, 90, 70, 0.5)}` }} transition={{ type: 'spring', stiffness: 420, damping: 30 }} />}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
        <LiquidSwitch agent={agent} onToggle={() => toggle(agent)} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={tab} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }} transition={{ duration: 0.22 }}>
          {tab === 'talk' && <Talk agent={agent} />}
          {tab === 'beliefs' && <Beliefs swarmId={agent.swarm_id} />}
          {tab === 'thinking' && <Thinking agent={agent} />}
          {tab === 'more' && <More agent={agent} />}
        </m.div>
      </AnimatePresence>
    </LiquidPanel>
  )
}

const SUGGEST = ['What are you working on?', 'What do you believe most?', 'What changed recently?']

function Talk({ agent }: { agent: Agent }) {
  const id = agent.id
  const messages = useHive((s) => s.messages[id] ?? EMPTY_M)
  const pending = useHive((s) => s.pending[id] ?? EMPTY_P)
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const thinking = useHive((s) => s.thinking[id])
  const agents = useHive((s) => s.agents)
  const [text, setText] = useDraft(`flux:mind:${id}`)
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const busy = agent.status === 'awake' && (thinking === 'llm' || thinking === 'skills')
  const shownList = useMemo(() => messages.slice(-80), [messages])

  useEffect(() => {
    useHive.getState().loadMessages(id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the conversation'))
  }, [id])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shownList.length, pending.length, busy, loaded])

  const send = (v = text) => {
    const t = v.trim()
    if (!t) return
    setText('')
    stick.current = true
    void useHive.getState().sendMessage(id, t)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
      e.preventDefault()
      send()
    }
  }
  const rows = Math.min(5, Math.max(1, text.split('\n').length))
  return (
    <>
      <div
        ref={scroller}
        data-flux-scroll
        onScroll={() => {
          const el = scroller.current
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3"
        aria-live="polite"
        style={{ scrollbarWidth: 'thin' }}
      >
        {err && <p className="mb-3 rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 90 120 / 0.14)' }}>{err}</p>}
        {!loaded && !err && <p className="py-8 text-center text-[14px]" style={{ color: INK2 }}>Drawing up the conversation…</p>}
        {loaded && shownList.length === 0 && pending.length === 0 && (
          <div className="flex flex-col items-start gap-2 py-6">
            <p className="text-[16px]" style={{ color: INK2 }}>Nothing said yet. Start with:</p>
            {SUGGEST.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} className="flux-focus rounded-full px-4 py-2 text-[14px] font-semibold hover:bg-white/10" style={{ boxShadow: `inset 0 0 0 1px ${hsl(agent.hue, 80, 70, 0.4)}` }}>{s}</button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {shownList.map((msg) => <Bubble key={msg.id} msg={msg} agent={agent} agents={agents} />)}
          {pending.map((p) => (
            <m.div key={p.tempId} layout initial={{ opacity: 0, y: 18, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="max-w-[84%] self-end rounded-[22px] rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap" style={{ background: 'rgb(255 255 255 / 0.14)', boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.2)' }}>
              {p.text}
              <div className="mt-1 text-[12px]" style={{ color: p.status === 'failed' ? '#ffb3c0' : INK2 }}>
                {p.status === 'failed' ? (
                  <>
                    Not delivered.{' '}
                    <button type="button" className="flux-focus underline" onClick={() => void useHive.getState().retryMessage(id, p.tempId)}>Try again</button>
                  </>
                ) : 'Sending…'}
              </div>
            </m.div>
          ))}
          {busy && <div className="py-1"><ThinkingDrops hue={agent.hue} label={thinking === 'skills' ? `${shown(agent.name)} is acting` : `${shown(agent.name)} is thinking`} /></div>}
        </div>
      </div>
      <form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); send() }}>
        <div className="flex items-end gap-2 rounded-[26px] p-1.5 pl-4" style={{ background: 'rgb(255 255 255 / 0.08)', boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.18), inset 0 0 0 1px ${hsl(agent.hue, 70, 70, 0.28)}` }}>
          <label className="sr-only" htmlFor={`flux-say-${id}`}>Message {shown(agent.name)}</label>
          <textarea
            id={`flux-say-${id}`}
            data-autofocus
            rows={rows}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={agent.status === 'awake' ? `Message ${shown(agent.name)}…` : `Message ${shown(agent.name)} (${statusLine(agent).toLowerCase()})…`}
            className="min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed outline-none placeholder:text-[#c8bddb]"
            style={{ color: INK }}
          />
          <m.button type="submit" aria-label="Send" disabled={!text.trim()} whileTap={{ scale: 0.85 }} className="flux-focus grid size-10 shrink-0 place-items-center rounded-full disabled:opacity-40" style={{ color: '#170a22', background: `radial-gradient(circle at 35% 25%, #fff, ${hsl(agent.hue, 90, 76)} 65%)`, boxShadow: `0 0 18px ${hsl(agent.hue, 90, 65, 0.5)}` }}>
            <Glyph name="send" size={18} stroke={2.4} />
          </m.button>
        </div>
      </form>
    </>
  )
}

function Bubble({ msg, agent, agents }: { msg: Message; agent: Agent; agents: Record<string, Agent> }) {
  const mine = msg.direction === 'out'
  const peerId = !mine && msg.sender.startsWith('agent:') ? msg.sender.slice(6) : null
  const peer = peerId ? agents[peerId] : null
  const time = new Date(msg.created_at)
  return (
    <m.div
      layout="position"
      initial={{ opacity: 0, y: 16, scale: 0.92, borderRadius: 40 }}
      animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 22 }}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      className={`max-w-[86%] px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${mine || peer || healthCheck(msg) ? 'self-start rounded-bl-md' : 'self-end rounded-br-md'}`}
      style={
        mine ? { background: hsl(agent.hue, 70, 45, 0.24), boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.14), inset 0 0 0 1px ${hsl(agent.hue, 80, 70, 0.25)}` }
        : peer ? { background: hsl(peer.hue, 60, 45, 0.18), boxShadow: `inset 0 0 0 1px ${hsl(peer.hue, 80, 70, 0.25)}` }
        : { background: 'rgb(255 255 255 / 0.13)', boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.2)' }
      }
    >
      {peer && <div className="mb-0.5 text-[12px] font-semibold" style={{ color: hsl(peer.hue, 90, 82) }}>{shown(peer.name)}</div>}
      {healthCheck(msg) && <div className="mb-0.5"><HealthCheckLabel className="text-[12px] font-semibold" /></div>}
      <PlainText text={msg.text} />
      <div className="mt-1 text-[11px]" style={{ color: INK3 }}>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    </m.div>
  )
}

function Beliefs({ swarmId }: { swarmId: string | null }) {
  const beliefs = useHive((s) => (swarmId ? s.beliefs[swarmId] : undefined) ?? EMPTY_B)
  const list = useMemo(() => Object.values(beliefs).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 60), [beliefs])
  const reduced = useReducedMotion()
  useEffect(() => {
    if (swarmId) void useHive.getState().loadBeliefs(swarmId).catch(() => undefined)
  }, [swarmId])
  return (
    <div data-flux-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5" style={{ scrollbarWidth: 'thin' }}>
      {!swarmId && <p className="py-6 text-[15px]" style={{ color: INK2 }}>This mind roams free, so it shares no swarm beliefs.</p>}
      {swarmId && list.length === 0 && <p className="py-6 text-[15px]" style={{ color: INK2 }}>No shared beliefs yet. They appear here as the swarm forms them.</p>}
      <ul className="flex flex-col gap-2">
        {list.map((b, i) => <BeliefRow key={b.statement} b={b} i={i} reduced={reduced} />)}
      </ul>
    </div>
  )
}

/**
 * One shared belief with its sureness evidence (Kimi r3.6 #3): at full opacity from the first frame, so the meter and
 * its words are never shown dimmed (a fade would read as less sure). The arrival cue is a short slide only, none with
 * reduced motion.
 */
export function BeliefRow({ b, i, reduced }: { b: Belief; i: number; reduced: boolean }) {
  return (
    <m.li initial={reduced ? false : { y: 8 }} animate={{ y: 0 }} transition={{ delay: reduced ? 0 : Math.min(i, 12) * 0.03 }} data-flux-belief="" className="rounded-2xl px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)', opacity: 1 }}>
      <div className="text-[14px] leading-snug break-words">
        <BeliefSentence statement={b.statement} sure={false} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <SurenessMeter tv={b.tv} />
        <Sureness tv={b.tv} className="shrink-0 text-[12px]" />
      </div>
    </m.li>
  )
}

const EMPTY_T: Trace[] = []

/** What the mind did, turn by turn (its traces), poured as drops you can open. */
function Thinking({ agent }: { agent: Agent }) {
  const traces = useHive((s) => s.traces[agent.id] ?? EMPTY_T)
  const loaded = useHive((s) => !!s.tracesLoaded[agent.id])
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    useHive.getState().loadTraces(agent.id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not read what it did'))
  }, [agent.id])
  const list = useMemo(() => [...traces].reverse().slice(0, 60), [traces])
  return (
    <div data-flux-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5" style={{ scrollbarWidth: 'thin' }}>
      {err && <p className="mb-3 rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 90 120 / 0.14)' }}>{err}</p>}
      {!err && !loaded && !list.length && <p className="py-6 text-[15px]" style={{ color: INK2 }}>Reading what it did…</p>}
      {!err && loaded && !list.length && <p className="py-6 text-[15px]" style={{ color: INK2 }}>Nothing yet. Each time {shown(agent.name)} thinks, a turn appears here.</p>}
      <ol className="flex flex-col gap-2">
        {list.map((t) => (
          <li key={t.id} className="rounded-[20px] px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
            <button type="button" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)} className="flux-focus w-full rounded-xl text-left">
              <span className="flex flex-wrap gap-x-2 text-[12px]" style={{ color: INK2 }}>
                <span className="font-semibold" style={{ color: hsl(agent.hue, 90, 84) }}>Turn {t.iteration}</span>
                {new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {t.commands.length > 0 && <span>· {t.commands.length} {t.commands.length === 1 ? 'action' : 'actions'}</span>}
                {t.tokens != null && <span>· {plural(t.tokens, 'token')}</span>}
              </span>
              <span className={`mt-0.5 block text-[14px] leading-snug ${open === t.id ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'}`}>{t.input ? `“${t.input}”` : t.response || '(no output)'}</span>
            </button>
            {open === t.id && (
              <div className="mt-2 select-text">
                {t.input && <p className="text-[13.5px] leading-snug whitespace-pre-wrap break-words" style={{ color: INK2 }}>{t.response}</p>}
                {t.commands.map((c, i) => (
                  <pre key={i} className="mt-2 overflow-x-auto rounded-2xl px-3 py-2 text-[12px] whitespace-pre-wrap break-all" style={{ background: 'rgb(0 0 0 / 0.3)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {c.command}
                    {c.result ? `\n→ ${c.result.slice(0, 400)}` : ''}
                  </pre>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => openClassic({ name: 'dot', id: agent.id, tab: 'mind' })} className="flux-focus mt-4 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold hover:bg-white/10" style={{ boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.18)' }}>
        Full record <Glyph name="open" size={14} />
      </button>
    </div>
  )
}

function More({ agent }: { agent: Agent }) {
  const items: { label: string; hint: string; go: () => void }[] = [
    { label: 'Mind', hint: 'Persona, role and settings', go: () => openClassic({ name: 'dot', id: agent.id, tab: 'mind' }) },
    { label: 'Memory', hint: 'What it remembers', go: () => openClassic({ name: 'dot', id: agent.id, tab: 'memory' }) },
    { label: 'Schedule', hint: 'When it wakes by itself', go: () => openClassic({ name: 'dot', id: agent.id, tab: 'schedule' }) },
    { label: 'Model', hint: 'Which model and provider', go: () => openClassic({ name: 'dot', id: agent.id, tab: 'model' }) },
    { label: 'Tasks', hint: 'The tasks it works on', go: () => openClassic({ name: 'tasks', mind: agent.id }) },
  ]
  return (
    <div data-flux-scroll className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
      {agent.last_error && agent.status === 'error' && <p className="mb-3 rounded-2xl px-4 py-3 text-[14px]" style={{ background: 'rgb(255 90 120 / 0.14)' }}>{agent.last_error}</p>}
      <div className="mb-4 grid grid-cols-2 gap-2 text-[13px]">
        <Stat k="Spent" v={`$${agent.spent_usd.toFixed(2)}`} />
        <Stat k="Budget" v={agent.budget_usd ? `$${agent.budget_usd.toFixed(0)}` : 'none'} />
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((it) => (
          <li key={it.label}>
            <button type="button" onClick={it.go} className="flux-focus flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left hover:bg-white/[0.08]" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
              <span>
                <span className="block text-[16px] font-semibold">{it.label}</span>
                <span className="block text-[13px]" style={{ color: INK2 }}>{it.hint}</span>
              </span>
              <Glyph name="open" size={16} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: 'rgb(255 255 255 / 0.05)' }}>
      <div style={{ color: INK2 }}>{k}</div>
      <div className="text-[18px] font-semibold tabular-nums">{v}</div>
    </div>
  )
}

// ---------------------------------------------------------------- decision

/**
 * A request poured into glass: who, skill, risk, the reason and the request, and the queue around it. It never answers:
 * focus starts on its heading, and "Review and answer" opens the shared decision dialog (experiences/ApprovalDecision,
 * Review R2/R3) bound to the request exactly as it was when opened.
 */
export function DecisionCard({ id, origin }: { id: string; origin?: Origin }) {
  const { desktop, closeDecision, openDecision, openMind } = useFlux()
  const approvalCurrent = useFluxApprovalAuthority(id)
  const ap = useHive((s) => s.approvals[id])
  const agent = useHive((s) => (ap ? s.agents[ap.agent_id] : undefined))
  const deciding = useHive((s) => s.deciding[id])
  const approvals = useHive((s) => s.approvals)
  const queue = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)), [approvals])
  // Surface R: the request is answered only in the session it was shown under (stamped at the press, from this render)
  const session = useHive((s) => s.session)
  const [answering, setAnswering] = useState<{ ap: Approval; session: string } | null>(null)
  if (!ap) return null
  const idx = queue.findIndex((q) => q.id === id)
  const hue = agent?.hue ?? 320
  const risk = ap.risk === 'high' ? { c: '#ff8aa0', t: 'High risk' } : ap.risk === 'medium' ? { c: '#ffc46b', t: 'Medium risk' } : { c: '#7fe3c4', t: 'Low risk' }
  const done = ap.status !== 'pending'
  // answered: the glass drains and focus goes to the Decisions control, never onto another request
  const closed = () => {
    setAnswering(null)
    if (useHive.getState().approvals[id]?.status !== 'pending') closeDecision()
  }
  const afterAnswer = (opener: HTMLElement | null) =>
    useHive.getState().approvals[id]?.status === 'pending' && opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-flux-decide]')
  return (
    <LiquidPanel
      glassKey={`decision-${id}`}
      origin={origin}
      label={`Decision: ${agent ? shown(agent.name) : 'a mind'} asks to use ${ap.skill}`}
      radius={30}
      className={desktop ? 'fixed top-[84px] z-40 w-[460px]' : 'fixed inset-x-2 top-[70px] z-40 max-h-[calc(100dvh-170px)] overflow-y-auto overscroll-contain'}
      style={desktop ? { left: 'calc(50% - 230px)' } : undefined}
    >
      <div className="p-6">
        <div className="flex items-start gap-4">
          <Slot slotKey={`drip:${id}`} size={52} hue={hue} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: INK3 }}>
              Needs you {queue.length > 1 && idx >= 0 && <span className="normal-case tracking-normal">· {idx + 1} of {queue.length}</span>}
            </div>
            <h2 data-autofocus tabIndex={-1} className="text-[22px] leading-tight font-semibold [overflow-wrap:anywhere] outline-none focus-visible:underline">
              {agent ? shown(agent.name) : 'A mind'} wants to use <span style={{ color: hsl(hue, 90, 82) }}>{ap.skill}</span>
            </h2>
            {agent && (
              <button type="button" className="flux-focus mt-1 min-h-11 rounded text-[14px] font-semibold underline-offset-4 hover:underline" style={{ color: INK2 }} onClick={() => { closeDecision(); openMind(agent.id) }}>
                Open {shown(agent.name)}
              </button>
            )}
          </div>
          <GlassButton label="Close" icon="close" size={44} onClick={closeDecision} />
        </div>
        {ap.reason && <p className="mt-3 text-[15px] leading-relaxed [overflow-wrap:anywhere]" style={{ color: INK2 }}>{ap.reason}</p>}
        <pre className="mt-3 max-h-36 overflow-auto rounded-2xl px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap break-all" style={{ background: 'rgb(0 0 0 / 0.32)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: INK }}>{ap.command}</pre>
        <div className="mt-3 flex items-center gap-2 text-[13px] font-semibold" style={{ color: risk.c }}>
          <span aria-hidden className="size-2 rounded-full" style={{ background: risk.c, boxShadow: `0 0 10px ${risk.c}` }} />
          {risk.t}
        </div>
        {done ? (
          <p className="mt-5 text-[15px]" style={{ color: INK2 }}>Already {ap.status}.</p>
        ) : (
          <m.button type="button" data-flux-review={id} whileTap={{ scale: 0.97 }} disabled={!!deciding} onClick={() => setAnswering({ ap, session })} className="flux-focus mt-5 min-h-12 w-full rounded-full px-4 py-3 text-[16px] font-semibold disabled:opacity-60" style={{ color: '#170a22', background: 'radial-gradient(circle at 30% 20%, #fff, #f3a6ff 70%)', boxShadow: '0 0 24px rgb(240 140 255 / 0.35)' }}>
            {deciding ? 'Sending your answer…' : 'Review and answer'}
          </m.button>
        )}
        {queue.length > 1 && (
          <div className="mt-3 flex justify-between text-[13px]">
            <button type="button" className="flux-focus min-h-11 rounded-full px-3 py-1.5 font-semibold hover:bg-white/10" style={{ color: INK2 }} onClick={() => openDecision(queue[(idx - 1 + queue.length) % queue.length].id)}>‹ Previous</button>
            <button type="button" className="flux-focus min-h-11 rounded-full px-3 py-1.5 font-semibold hover:bg-white/10" style={{ color: INK2 }} onClick={() => openDecision(queue[(idx + 1) % queue.length].id)}>Next ›</button>
          </div>
        )}
      </div>
      <AnimatePresence>{answering && <ApprovalDecision current={approvalCurrent} key={answering.ap.id} seen={answering.ap} session={answering.session} onClose={closed} restoreFocus={afterAnswer} />}</AnimatePresence>
    </LiquidPanel>
  )
}

export function NothingCard({ onClose }: { onClose: () => void }) {
  const { desktop, openSheet } = useFlux()
  return (
    <LiquidPanel glassKey="decision-none" label="Nothing needs you" radius={30} className={desktop ? 'fixed top-[84px] z-40 w-[380px]' : 'fixed inset-x-6 top-[84px] z-40'} style={desktop ? { left: 'calc(50% - 190px)' } : undefined}>
      <div className="flex items-center gap-4 p-6">
        <div className="grid size-12 place-items-center rounded-full" style={{ background: 'rgb(140 240 200 / 0.18)', color: '#a5f5d6' }}><Glyph name="check" size={24} stroke={2.4} /></div>
        <div className="flex-1">
          <div className="text-[18px] font-semibold">Nothing needs you</div>
          <div className="text-[14px]" style={{ color: INK2 }}>When a mind asks, a drop gathers at the top.</div>
        </div>
        <GlassButton label="Close" icon="close" size={36} onClick={onClose} autoFocus />
      </div>
      <div className="px-6 pb-5">
        <button type="button" onClick={() => { onClose(); openSheet({ page: 'decisions', tab: 'history' }) }} className="flux-focus text-[13px] font-semibold underline-offset-4 hover:underline" style={{ color: INK2 }}>Past decisions and rules</button>
      </div>
    </LiquidPanel>
  )
}
