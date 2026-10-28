import { plural } from '../../lib/plural'
import { SwarmMove } from './SwarmMove'
import { AnimatePresence, m } from 'framer-motion'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { lazyRoute } from '../../lib/lazyRoute'
import type { Agent, AgentAction } from '../../api/types'
import { ModelPicker } from '../models/ModelPicker'
import { CoffeeMembershipControl } from '../messages/CoffeeParts'
import { KeyPicker } from '../keys/KeyPicker'
import { RoleSelect } from '../roles/RoleSelect'
import { buildRows } from '../models/modelUtil'
import { hsl } from '../../lib/color'
import { money } from '../../lib/format'
import { useIsDesktop } from '../../lib/hooks'
import { DOT_PHONE_PEEK } from './phoneLayout'
import { closeToHome, navigate, type DotTab } from '../../lib/router'
import { useScene } from '../../scene/sceneStore'
import { useHive, useRefusal } from '../../store/store'
import { useUnsaved } from '../ask/dirty'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, EmptyState, IconButton, Meter, Orb, Segmented, StatusPill } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { Sheet } from '../../ui/Sheet'
import { describeLlmError } from '../../lib/llmErrors'
import { Chat } from './Chat'
import { MemoryInspector } from './MemoryInspector'
import { MindTimeline } from './MindTimeline'
import { MindTools } from '../minds/MindTools'
import { MoveMind } from '../minds/MoveMind'
import { Schedule } from './Schedule'
import { IsolationChip } from './IsolationChip'
import { VisibilityControl } from '../../ui/Visibility'
import { OWN_BUDGET_CODES } from './mindStatus'
import { PausedPill, SpendingPause } from './SpendingPause'
import { LabGuards } from '../../shell/LabBadge'
import { OpenIn } from '../programs/OpenIn'
import { sessionKey } from '../../store/programSession'
import { ViewInfo } from '../../tour/ViewInfo'
import { SimChip } from '../../ui/SimChip'
import { shown } from '../../lib/displayName'
import { Tools } from './Tools'
import { escapeFrom, tabStep } from './tabNav'

const ProgramHost = lazyRoute(() => import('../programs/ProgramHost'))

type Tab = DotTab

const TAB_ORDER: Tab[] = ['chat', 'mind', 'memory', 'schedule', 'model', 'tools']

export default function DotPanel({ id, tab: routeTab, program }: { id: string; tab?: DotTab; program?: string }) {
  const agent = useHive((s) => s.agents[id])
  const ready = useHive((s) => s.ready)
  // Esc, a phone drag or Back to the hive: just this panel; the visible X: home (closeToHome)
  const dismiss = () => navigate({ name: 'hive' })
  const tab: Tab = routeTab ?? 'chat'
  // mind-chat r1: leaving the chat is one Back away, and returning to it steps back to that entry (tabNav.tabStep)
  const leftChat = useRef(false)
  useEffect(() => {
    if (tab === 'chat') leftChat.current = false
  }, [tab])
  const setTab = (t: Tab) => {
    const step = tabStep(tab, t, leftChat.current)
    if (step === 'none') return
    if (step === 'back') {
      leftChat.current = false
      history.back()
      return
    }
    if (step === 'push') leftChat.current = true
    navigate({ name: 'dot', id, tab: t }, { replace: step === 'replace' })
  }
  // the Budget meter opens the budget cap (Model tab); the chat stays one Esc, Back or "Back to chat" away
  const openBudget = () => {
    setTab('model')
    window.setTimeout(() => {
      const h = document.getElementById('budget-h')
      h?.scrollIntoView?.({ block: 'center' })
      document.querySelector<HTMLInputElement>('input[aria-labelledby="budget-h"]')?.focus({ preventScroll: true })
    }, 260)
  }
  // slide direction follows the tab order
  const [prevTab, setPrevTab] = useState(tab)
  const [dir, setDir] = useState(1)
  if (prevTab !== tab) {
    setDir(TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(prevTab) ? 1 : -1)
    setPrevTab(tab)
  }
  const bodyRef = useRef<HTMLDivElement>(null)
  const desktop = useIsDesktop()
  const setAnchor = useScene((s) => s.setChatAnchor)
  const loadWakeups = useHive((s) => s.loadWakeups)
  // while a mind's chat is open, what the Ask opens under its field stays short, so the chat keeps room to read
  // (features/ask/ask.css html[data-mind-panel]; mind-chat r1)
  const chatShown = !!agent && !program
  useEffect(() => {
    if (!chatShown) return
    const root = document.documentElement
    root.dataset.mindPanel = ''
    return () => {
      delete root.dataset.mindPanel
    }
  }, [chatShown])
  useEffect(() => {
    loadWakeups(id).catch(() => undefined)
  }, [id, loadWakeups])

  // tell the scene where "the chat" is so message light can fly to it
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      setAnchor(desktop ? { x: r.left - 6, y: r.top + r.height * 0.7 } : { x: window.innerWidth / 2, y: r.top - 4 })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    const t = setInterval(report, 600)
    return () => {
      ro.disconnect()
      clearInterval(t)
      setAnchor(null)
    }
  }, [desktop, setAnchor])

  if (!agent) {
    return (
      <Sheet label="Mind" onClose={dismiss}>
        <div ref={bodyRef} className="flex flex-1 items-center justify-center">
          {ready ? (
            <EmptyState icon="alert" title="This mind is gone" body="It may have been deleted. Its memory is kept on disk." action={<Button onClick={dismiss}>Back to the hive</Button>} />
          ) : (
            <div className="eyebrow animate-pulse">Finding mind…</div>
          )}
        </div>
      </Sheet>
    )
  }

  if (program) return <DotProgram agent={agent} programId={program} onCloseX={closeToHome} onDismiss={dismiss} />

  return (
    <Sheet label={`${shown(agent.name)} panel`} className="dot-sheet" onClose={dismiss} onEscape={escapeFrom(tab) === 'chat' ? () => setTab('chat') : undefined} header={<PanelHeader agent={agent} onCloseX={closeToHome} tab={tab} setTab={setTab} onBudget={openBudget} />} initialSnap={desktop ? 'full' : 'peek'} peekHeight={DOT_PHONE_PEEK}>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col" data-mind-panel-body="">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <m.div
            key={tab}
            custom={dir}
            data-tour={`dot-body-${tab}`}
            className={cx('flex min-h-0 flex-1 flex-col', tab !== 'chat' && tab !== 'mind' && 'thin-scroll overflow-y-auto')}
            variants={{ in: (d: number) => ({ opacity: 0, x: 14 * d }), on: { opacity: 1, x: 0 }, out: (d: number) => ({ opacity: 0, x: -14 * d }) }}
            initial="in"
            animate="on"
            exit="out"
            transition={{ duration: 0.16 }}
          >
            {tab !== 'chat' && (
              <button type="button" onClick={() => setTab('chat')} data-back-to-chat="" className="mx-4 mt-1 mb-1 inline-flex min-h-9 shrink-0 items-center gap-1.5 self-start rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-white/[0.06] hover:text-ink">
                <Icon name="back" size={15} />
                Back to chat
              </button>
            )}
            {tab === 'chat' ? (
              <Chat key={agent.id} agent={agent} />
            ) : tab === 'mind' ? (
              <MindTimeline key={agent.id} agent={agent} />
            ) : tab === 'memory' ? (
              <MemoryInspector key={agent.id} agent={agent} />
            ) : tab === 'schedule' ? (
              <Schedule key={agent.id} agent={agent} />
            ) : tab === 'tools' ? (
              <Tools key={agent.id} agent={agent} />
            ) : (
              <ModelSettings key={agent.id} agent={agent} />
            )}
          </m.div>
        </AnimatePresence>
        <LogTail agent={agent} />
      </div>
    </Sheet>
  )
}

function PanelHeader({ agent, onCloseX, tab, setTab, onBudget }: { agent: Agent; onCloseX: () => void; tab: Tab; setTab: (t: Tab) => void; onBudget: () => void }) {
  const thinking = useHive((s) => s.thinking[agent.id])
  const wakeups = useHive((s) => {
    let n = 0
    for (const w of Object.values(s.wakeups)) if (w.agent_id === agent.id && w.enabled) n++
    return n
  })
  const swarm = useHive((s) => (agent.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const refusal = useRefusal(agent.id)
  const lastError = describeLlmError(agent.last_error)
  // the spending banner already says why; do not repeat a budget error under it
  const showLastError = !!agent.last_error && !(refusal && lastError && (OWN_BUDGET_CODES.has(lastError.code) || lastError.code === 'hive_budget_exhausted'))
  const desktop = useIsDesktop()
  const visibilityValue = { visibility: agent.visibility ?? 'public', shared_with: agent.shared_with ?? [] }
  return (
    <div className="relative shrink-0 px-4 pt-1 md:pt-4" data-tour="dot-header">
      <div className="pointer-events-none absolute inset-x-0 -top-10 h-40 opacity-70" style={{ background: `radial-gradient(60% 100% at 20% 0%, ${hsl(agent.hue, 90, 55, 0.28)}, transparent)` }} />
      <div className="relative flex items-center gap-3">
        <Orb hue={agent.hue} status={agent.status} thinking={thinking} size={42} />
        <div className="min-w-0 flex-1">
          {/* Wraps instead of squeezing: the name always shows, and chips never slide under the header icons. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="max-w-full min-w-0 truncate font-display text-[20px] leading-tight font-semibold tracking-tight">{shown(agent.name)}</h2>
            <StatusPill status={agent.status} thinking={thinking} />
            {refusal && <PausedPill />}
            <IsolationChip agentId={agent.id} status={agent.status} />
            {desktop && <VisibilityControl kind="agent" id={agent.id} value={visibilityValue} />}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden text-[12px] whitespace-nowrap text-ink-3">
            <span className="capitalize">{agent.kind}</span>
            <span aria-hidden="true">·</span>
            {swarm ? (
              <button onClick={() => navigate({ name: 'swarm', id: swarm.id })} className="inline-flex min-h-6 items-center gap-1 text-ink-2 hover:text-ink">
                <span className="size-1.5 rounded-full" style={{ background: hsl(swarm.hue, 90, 65) }} />
                {shown(swarm.name)}
              </button>
            ) : (
              <span>wanderer</span>
            )}
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono text-meta">{agent.model}</span>
          </div>
        </div>
        <ViewInfo view={`dot-${tab}`} size="sm" />
        <OpenIn iconOnly onPick={(pid) => navigate({ name: 'dot', id: agent.id, program: pid })} />
        <IconButton icon="x" label="Close panel" onClick={onCloseX} className="-mr-2" />
      </div>
      {/* on a phone, who can see it joins the controls' row: the header stays short and the chat keeps its room */}
      <div className="mt-3 flex items-stretch gap-2">
        <Controls agent={agent} />
        <Budget agent={agent} onOpen={onBudget} />
        {/* last in the row, so its picker opens leftwards from the screen's right edge */}
        {!desktop && <div className="flex shrink-0 items-center"><VisibilityControl kind="agent" id={agent.id} value={visibilityValue} iconOnly /></div>}
      </div>
      <AnimatePresence initial={false}>
        {refusal && <SpendingPause key="refused" agent={agent} refusal={refusal} onFixBudget={() => setTab('model')} />}
        {showLastError && <LastError key="err" agent={agent} onFix={() => setTab('model')} />}
      </AnimatePresence>
      <Segmented<Tab>
        dense
        label="Panel section"
        tour="dot-tab"
        value={tab}
        onChange={setTab}
        className="mt-2.5 mb-1.5 w-full"
        options={[
          { value: 'chat', label: 'Chat' },
          {
            value: 'mind',
            label: 'Thinking',
            badge: thinking && thinking !== 'idle' ? <span className="size-1.5 animate-pulse rounded-full" style={{ background: hsl(thinking === 'skills' ? agent.hue + 55 : agent.hue, 100, 72), boxShadow: `0 0 6px ${hsl(agent.hue, 100, 65)}` }} aria-label="thinking" /> : undefined,
          },
          { value: 'memory', label: 'Memory' },
          { value: 'schedule', label: 'Schedule', badge: wakeups ? <span className="font-mono text-caption text-ink-4">{wakeups}</span> : undefined },
          { value: 'model', label: 'Model' },
          { value: 'tools', label: 'Tools' },
        ]}
      />
    </div>
  )
}

/** A mind hosting a program in its own panel space, over its swarm. */
function DotProgram({ agent, programId, onCloseX, onDismiss }: { agent: Agent; programId: string; onCloseX: () => void; onDismiss: () => void }) {
  const program = useHive((s) => s.programs?.find((p) => p.id === programId))
  // named only when the host lists the app for this person (town follow-up, as ProgramPage): otherwise nothing of it shows
  const programsLoaded = useHive((s) => !!s.programs)
  const loadPrograms = useHive((s) => s.loadPrograms)
  useEffect(() => {
    if (!programsLoaded) void loadPrograms().catch(() => undefined)
  }, [programsLoaded, loadPrograms])
  const name = program ? shown(program.name) : 'App'
  const desktop = useIsDesktop()
  const back = () => navigate({ name: 'dot', id: agent.id })
  const swarmId = agent.swarm_id
  const escape = () => {
    if (!swarmId || !useHive.getState().programBack(sessionKey(programId, swarmId))) back()
  }
  const header = (
    <div className="relative shrink-0 px-4 pt-1 pb-1 md:pt-4">
      <div className="pointer-events-none absolute inset-x-0 -top-10 h-32 opacity-60" style={{ background: `radial-gradient(60% 100% at 20% 0%, ${hsl(agent.hue, 90, 55, 0.24)}, transparent)` }} />
      <div className="relative flex items-center gap-2.5">
        <IconButton icon="back" label={`Back to ${shown(agent.name)}`} onClick={back} className="-ml-2" />
        <Orb hue={agent.hue} status={agent.status} size={30} />
        <div className="min-w-0 flex-1">
          <div className="eyebrow truncate">{shown(agent.name)} · program</div>
          <h2 className="truncate font-display text-[18px] leading-tight font-semibold tracking-tight">{name}</h2>
        </div>
        <ViewInfo view="program" size="sm" />
        <IconButton icon="x" label="Close panel" onClick={onCloseX} className="-mr-2" />
      </div>
    </div>
  )
  return (
    <Sheet label={`${name} in ${shown(agent.name)}'s panel`} onClose={onDismiss} onEscape={escape} header={header} width={480} initialSnap="full" peekHeight="80dvh">
      <div className="flex min-h-0 flex-1 flex-col" style={{ height: desktop ? undefined : '78dvh' }}>
        {!program ? (
          programsLoaded
            ? <EmptyState icon="shield" title="This app isn't available to you here" body="This hive doesn't offer that app to you." action={<Button onClick={back}>Back</Button>} />
            : <div className="eyebrow flex flex-1 animate-pulse items-center justify-center">Opening…</div>
        ) : swarmId ? (
          <Suspense fallback={<div className="eyebrow flex flex-1 animate-pulse items-center justify-center">Opening…</div>}>
            <ProgramHost programId={programId} swarmId={swarmId} variant="panel" onExit={back} />
          </Suspense>
        ) : (
          <EmptyState icon="swarms" title={`${shown(agent.name)} is a wanderer`} body="Apps work inside one swarm. Move this mind into a swarm to host an app here." action={<Button onClick={back}>Back</Button>} />
        )}
      </div>
    </Sheet>
  )
}

const ACTIONS: Record<AgentAction, { label: string; icon: IconName }> = {
  start: { label: 'Start', icon: 'play' },
  wake: { label: 'Wake', icon: 'sun' },
  sleep: { label: 'Sleep', icon: 'moon' },
  stop: { label: 'Stop', icon: 'stop' },
}

function Controls({ agent }: { agent: Agent }) {
  const act = useHive((s) => s.agentAction)
  const desktop = useIsDesktop()
  const [busy, setBusy] = useState<AgentAction | null>(null)
  const available: AgentAction[] =
    agent.status === 'awake'
      ? ['sleep', 'stop']
      : agent.status === 'asleep'
        ? ['wake', 'stop']
        : agent.status === 'starting'
          ? ['stop']
          : ['start']
  const run = async (a: AgentAction) => {
    setBusy(a)
    await act(agent.id, a)
    setBusy(null)
  }
  return (
    <div className="flex shrink-0 gap-1.5" role="group" aria-label="Status controls" data-tour="dot-controls">
      {available.map((a, i) => (
        // on a phone the second action shows its icon alone (its name stays in the label), so the row keeps the budget
        <Button key={a} variant={i === 0 ? 'primary' : 'subtle'} hue={agent.hue} icon={ACTIONS[a].icon} onClick={() => run(a)} disabled={!!busy} className={i > 0 && !desktop ? 'min-w-11 !px-0' : 'px-3.5'} aria-label={`${ACTIONS[a].label} ${shown(agent.name)}`} title={i > 0 && !desktop ? ACTIONS[a].label : undefined}>
          {busy === a ? '…' : i > 0 && !desktop ? null : ACTIONS[a].label}
        </Button>
      ))}
    </div>
  )
}

/** Why the mind is unwell: gateway refusals (402 / 429) get a plain-language title and a fix. */
function LastError({ agent, onFix }: { agent: Agent; onFix: () => void }) {
  const info = describeLlmError(agent.last_error)
  if (!info) return null
  const budgetish = info.code === 'no_budget' || info.code === 'budget_exhausted' || info.code === 'unpriced_model'
  const tone = info.code === 'rate_limited' ? '#fbbf24' : '#fb7185'
  return (
    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
      <div role="status" className="mt-2 flex items-start gap-2.5 rounded-xl border px-3 py-2" style={{ borderColor: `${tone}40`, background: `${tone}0f` }}>
        <Icon name={info.code === 'rate_limited' ? 'clock' : 'alert'} size={16} className="mt-0.5 shrink-0" style={{ color: tone }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-semibold" style={{ color: tone }}>
              {info.title}
            </span>
            {info.status && (
              <code className="font-mono text-meta text-ink-4">
                {info.status} {info.code}
              </code>
            )}
            {budgetish && <SimChip className="self-center" />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-3" title={agent.last_error ?? undefined}>
            {info.hint}
          </p>
        </div>
        {budgetish && (
          <button onClick={onFix} className="shrink-0 self-center rounded-lg px-2 py-1.5 text-[12px] font-semibold text-ink hover:bg-white/[0.07]">
            {info.code === 'unpriced_model' ? 'Change model' : 'Fix budget'}
          </button>
        )}
      </div>
    </m.div>
  )
}

function Budget({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const unlimited = agent.budget_usd <= 0
  const pct = unlimited ? 0 : agent.spent_usd / agent.budget_usd
  return (
    <button type="button" onClick={onOpen} aria-label={`${shown(agent.name)} budget: change the cap`} className="flex min-w-0 flex-1 flex-col justify-center rounded-xl border border-line bg-white/[0.025] px-3 py-1.5 text-left hover:border-line-2" data-tour="dot-budget">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-meta whitespace-nowrap">
        <span className="flex items-center gap-1 text-ink-3">
          Budget
          <SimChip />
          {!unlimited && pct > 0.85 && (
            <span className="inline-flex items-center gap-0.5 text-warn">
              <Icon name="alert" size={11} /> {Math.round(pct * 100)}%
            </span>
          )}
        </span>
        <span className="truncate font-mono text-ink-3">
          <span className="text-ink">{money(agent.spent_usd)}</span>
          {unlimited ? ' · ∞' : ` / ${money(agent.budget_usd)}`}
        </span>
      </div>
      <Meter value={agent.spent_usd} max={agent.budget_usd} hue={agent.hue} label={`${shown(agent.name)} budget used`} />
    </button>
  )
}

function ModelSettings({ agent }: { agent: Agent }) {
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const patch = useHive((s) => s.patchAgent)
  const toast = useHive((s) => s.toast)
  const client = useHive((s) => s.client)
  const [persona, setPersona] = useState(agent.persona)
  const [budget, setBudget] = useState(String(agent.budget_usd))
  const [hue, setHue] = useState(agent.hue)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const current = rows.find((r) => r.id === agent.model)

  const dirty = persona !== agent.persona
  // an unsaved persona holds the orchestrator's page moves as Go cards (features/ask/dirty)
  useUnsaved(dirty)
  const savePersona = async () => {
    setSaving(true)
    const ok = await patch(agent.id, { persona })
    setSaving(false)
    if (ok) toast({ tone: 'success', title: 'Persona saved', body: `${shown(agent.name)} will use it from the next turn.` })
  }

  return (
    <div className="space-y-6 px-4 pt-2 pb-6">
      <section aria-labelledby="model-h" data-tour="model-list">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 id="model-h" className="eyebrow">Model</h3>
          {current && <span className="truncate text-meta text-ink-4">{shown(current.name)}</span>}
        </div>
        <ModelPicker
          value={agent.model}
          options={agent.options}
          hue={agent.hue}
          onChange={async (model, options) => {
            const same = model === agent.model && JSON.stringify(options) === JSON.stringify(agent.options ?? {})
            if (same) return
            const ok = await patch(agent.id, { model, options })
            if (ok && model !== agent.model) toast({ tone: 'success', title: `${shown(agent.name)} now runs on ${rows.find((r) => r.id === model)?.name ?? model}`, body: agent.status === 'awake' ? 'From its next turn.' : undefined })
          }}
        />
        <div className="mt-4">
          <KeyPicker
            provider={agent.model.split('/')[0]}
            value={agent.options?.key}
            hue={agent.hue}
            onChange={async (key) => {
              const next = { ...(agent.options ?? {}) }
              if (key) next.key = key
              else delete next.key
              const ok = await patch(agent.id, { options: next })
              if (ok) toast({ tone: 'success', icon: 'token', title: key ? `${shown(agent.name)} now pays with its own key` : `${shown(agent.name)} uses the hive default key` })
            }}
          />
        </div>
      </section>

      <button onClick={() => navigate({ name: 'code', target: `mind:${agent.id}` })} className="flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2.5 text-left text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:bg-white/[0.04]">
        <Icon name="terminal" size={16} className="text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block">Edit {shown(agent.name)}'s code</span>
          <span className="block text-meta text-ink-4">The runtime it thinks with, in an isolated copy with tests</span>
        </span>
        <Icon name="chevron" size={14} className="text-ink-4" />
      </button>

      <SwarmMove agentId={agent.id} />

      <section aria-labelledby="role-h">
        <h3 id="role-h" className="eyebrow mb-2">Role</h3>
        <RoleSelect
          value={agent.role_id}
          onChange={async (roleId) => {
            const ok = await patch(agent.id, { role_id: roleId })
            if (ok) toast({ tone: 'success', icon: 'user', title: roleId ? `${shown(agent.name)} has a new role` : `${shown(agent.name)} has no role now`, body: 'From its next turn.' })
          }}
        />
        {agent.role_prompt && <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-2 text-[12.5px] leading-relaxed text-ink-3">{agent.role_prompt}</p>}
      </section>

      <CoffeeMembershipControl agent={agent} />

      <section aria-labelledby="persona-h">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 id="persona-h" className="eyebrow">{agent.role_id ? `Extra instructions for ${shown(agent.name)}` : 'Instructions'}</h3>
          <span className="text-meta text-ink-4 tabular-nums">{plural(persona.length, 'char')}</span>
        </div>
        <textarea
          aria-labelledby="persona-h"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={6}
          className="thin-scroll w-full resize-y rounded-xl border border-line bg-black/25 p-3 text-[14px] leading-relaxed text-ink outline-none focus:border-line-2"
        />
        <AnimatePresence>
          {dirty && (
            <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex justify-end gap-2 overflow-hidden pt-2">
              <Button variant="ghost" onClick={() => setPersona(agent.persona)}>
                Revert
              </Button>
              <Button variant="primary" hue={agent.hue} onClick={savePersona} disabled={saving}>
                {saving ? 'Saving…' : 'Save persona'}
              </Button>
            </m.div>
          )}
        </AnimatePresence>
      </section>

      <section aria-labelledby="hue-h">
        <h3 id="hue-h" className="eyebrow mb-2">Colour</h3>
        <div className="flex items-center gap-3">
          <Orb hue={hue} size={36} />
          <input
            type="range"
            min={0}
            max={359}
            value={hue}
            aria-labelledby="hue-h"
            onChange={(e) => setHue(Number(e.target.value))}
            onPointerUp={() => hue !== agent.hue && patch(agent.id, { hue })}
            onKeyUp={() => hue !== agent.hue && patch(agent.id, { hue })}
            className="hue-range flex-1"
          />
        </div>
      </section>

      <section aria-labelledby="guards-h">
        <h3 id="guards-h" className="eyebrow mb-2">Hive guards</h3>
        <LabGuards />
      </section>

      <MindTools agent={agent} />

      <section aria-labelledby="budget-h" data-tour="model-budget">
        <h3 id="budget-h" className="eyebrow mb-2">Budget cap</h3>
        <div className="flex items-center gap-2">
          <div className="flex min-h-11 flex-1 items-center rounded-xl border border-line bg-black/25 px-3 focus-within:border-line-2">
            <span className="text-ink-3">$</span>
            <input
              inputMode="decimal"
              aria-labelledby="budget-h"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))}
              className="w-full bg-transparent px-1.5 font-mono text-ink outline-none"
            />
          </div>
          <Button
            disabled={Number(budget) === agent.budget_usd || Number.isNaN(Number(budget))}
            onClick={async () => {
              const ok = await patch(agent.id, { budget_usd: Number(budget) })
              if (ok) toast({ tone: 'success', title: 'Budget updated' })
            }}
          >
            Save
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] text-ink-4">
          0 means unlimited for local models; a paid model with a $0 cap is refused (402 no_budget). The gateway checks each call’s worst-case cost against the cap before it runs.
        </p>
      </section>

      <MoveMind agent={agent} />

      <section className="rounded-xl border border-bad/20 bg-bad/[0.04] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Delete {shown(agent.name)}</div>
            <div className="text-[12px] text-ink-3">Stops the mind. Memory stays on disk.</div>
          </div>
          {confirmDelete ? (
            <div className="flex gap-1.5">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await client?.deleteAgent(agent.id)
                    toast({ tone: 'info', title: `${shown(agent.name)} was released` })
                    navigate({ name: 'hive' })
                  } catch (e) {
                    toast({ tone: 'error', title: 'Could not delete', body: e instanceof Error ? e.message : undefined })
                  }
                }}
              >
                Delete
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete…
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

const EMPTY: string[] = []

function LogTail({ agent }: { agent: Agent }) {
  const lines = useHive((s) => s.logs[agent.id] ?? EMPTY)
  const loaded = useHive((s) => !!s.logsLoaded[agent.id])
  const loadLogs = useHive((s) => s.loadLogs)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (!loaded) loadLogs(agent.id).catch(() => undefined)
  }, [agent.id, loaded, loadLogs])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines.length, open])

  const last = lines[lines.length - 1]
  return (
    // steps aside while a guided demo's reading step needs the room to show a viewer whole (guided/reading reflow)
    <div className="shrink-0 border-t border-line bg-black/20" data-reading-yields="">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={`log-${agent.id}`} className="flex min-h-11 w-full items-center gap-2 px-4 text-left">
        <Icon name="terminal" size={15} className="shrink-0 text-ink-3" />
        <span className="eyebrow shrink-0">Live log</span>
        {!open && last && (
          <m.span key={last} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="min-w-0 flex-1 truncate font-mono text-meta text-ink-3">
            {last}
          </m.span>
        )}
        <Icon name="chevronDown" size={16} className={cx('ml-auto shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div id={`log-${agent.id}`} initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 40 }} className="overflow-hidden">
            <div
              ref={ref}
              onScroll={() => {
                const el = ref.current
                if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
              className="thin-scroll max-h-[34dvh] overflow-y-auto px-4 pb-3 font-mono text-meta leading-[1.7]"
              role="log"
              aria-label={`${shown(agent.name)} log`}
            >
              {lines.length === 0 ? (
                <div className="text-ink-4">{loaded ? 'No log lines yet.' : 'Loading…'}</div>
              ) : (
                lines.map((l, i) => <LogLine key={i} line={l} />)
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LogLine({ line }: { line: string }) {
  const m = /^(\S+)\s+(INFO|WARN|ERROR|DEBUG)\s+(\S+:)?(.*)$/.exec(line)
  if (!m) return <div className="break-all whitespace-pre-wrap text-ink-3">{line}</div>
  const [, ts, level, src, rest] = m
  return (
    <div className="break-all whitespace-pre-wrap">
      <span className="text-ink-4">{ts} </span>
      <span className={level === 'ERROR' ? 'text-bad' : level === 'WARN' ? 'text-warn' : 'text-[#7dd3fc]/70'}>{level.padEnd(5)} </span>
      {src && <span className="text-[#c4b5fd]">{src}</span>}
      <span className={level === 'ERROR' ? 'text-bad/90' : 'text-ink-2'}>{rest}</span>
    </div>
  )
}
