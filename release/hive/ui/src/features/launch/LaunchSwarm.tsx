import { VisibilityPicker, type VisibilityValue } from '../../ui/Visibility'
import { AnimatePresence, m } from 'framer-motion'
import { useMemo, useState } from 'react'
import type { AgentKind, AgentOptions, CreatedAgent, Swarm } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { money } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon, type IconName } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, Orb, Segmented } from '../../ui/primitives'
import { KeyPicker } from '../keys/KeyPicker'
import { ModelPicker } from '../models/ModelPicker'
import { buildRows, priceLabel, readDefaultModel } from '../models/modelUtil'
import { RoleSelect } from '../roles/RoleSelect'
import { shown } from '../../lib/displayName'
import { useUnsaved } from '../ask/dirty'
import { markSaved } from '../../shell/unsavedWork'
import { bindOperation, OPERATION_STOPPED_WORDS, stopped, useAlive } from '../../lib/boundOperation'

/** One member of the swarm being planned. */
interface Slot {
  key: number
  name: string
  role: string
  /** A library role; resolved from the template's role name when the library loads. */
  roleId: string | null
  persona: string
  kind: AgentKind
  model: string
  options: AgentOptions
  budget: string
  hue: number
}

interface Template {
  id: string
  title: string
  blurb: string
  icon: IconName
  hue: number
  goal: string
  roles: { name: string; role: string; persona: string }[]
}

const TEMPLATES: Template[] = [
  {
    id: 'research',
    title: 'Research swarm',
    blurb: 'Find sources, weigh the evidence, challenge weak claims.',
    icon: 'search',
    hue: 196,
    goal: 'Research a question and report what the evidence supports, with sources and honest confidence',
    roles: [
      { name: 'Scout', role: 'Source finder', persona: 'You find and summarise primary sources. Cite where each claim comes from. Publish only what a source actually says.' },
      { name: 'Analyst', role: 'Evidence analyst', persona: 'You weigh the sources the swarm finds and publish beliefs with confidence that matches the evidence. Say what would change your mind.' },
      { name: 'Sceptic', role: 'Sceptic', persona: 'You challenge weak or single-source claims, ask for evidence and flag anything that looks too convenient.' },
    ],
  },
  {
    id: 'build',
    title: 'Build swarm',
    blurb: 'Plan the work, build it, review it before it lands.',
    icon: 'terminal',
    hue: 152,
    goal: 'Plan and build something concrete, reviewed before it is called done',
    roles: [
      { name: 'Planner', role: 'Planner', persona: 'You turn the task into small, testable subtasks for the swarm and keep track of what is done and what is blocked.' },
      { name: 'Builder', role: 'Builder', persona: 'You take one subtask at a time, do it carefully and report exactly what you changed and how you checked it.' },
      { name: 'Reviewer', role: 'Reviewer', persona: 'You review what the Builder produces against the task, point out concrete problems and approve only what you have checked.' },
    ],
  },
  {
    id: 'debate',
    title: 'Debate',
    blurb: 'Two sides argue it out, a judge decides what holds.',
    icon: 'scale',
    hue: 32,
    goal: 'Argue both sides of a question and decide which arguments hold up',
    roles: [
      { name: 'Proponent', role: 'Advocate', persona: 'You make the strongest honest case for the proposition, with evidence.' },
      { name: 'Opponent', role: 'Opponent', persona: 'You make the strongest honest case against the proposition, with evidence.' },
      { name: 'Judge', role: 'Judge', persona: 'You weigh both sides fairly, publish what holds up and with what confidence, and explain why.' },
    ],
  },
  {
    id: 'blank',
    title: 'Start empty',
    blurb: 'One mind; add more as you go.',
    icon: 'sparkles',
    hue: 262,
    goal: '',
    roles: [{ name: 'Lyra', role: 'Generalist', persona: 'You are a thoughtful generalist. Ask for what you need and say what you are unsure of.' }],
  },
]

const STEPS = ['Purpose', 'Minds', 'Limits', 'Launch'] as const
let slotSeq = 0

function defaultModel(models: { id: string; provider: string; local: boolean }[]) {
  const saved = readDefaultModel()
  if (saved) return { model: saved.model, options: saved.options ?? {} }
  const pick = models.find((m) => m.id.includes('sonnet')) ?? models.find((m) => !m.local) ?? models[0]
  return { model: pick?.id ?? 'mock/echo', options: {} }
}

/** #/swarms/new: from an idea to a working swarm: purpose, minds, limits, first task, launch. */
export default function LaunchSwarm() {
  const client = useHive((s) => s.client)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const agents = useHive((s) => s.agents)
  const library = useHive((s) => s.roles)
  const roleIdOf = (s: Slot) => s.roleId ?? library?.find((r) => r.name.toLowerCase() === s.role.trim().toLowerCase())?.id ?? null
  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])

  const [step, setStep] = useState(0)
  const [template, setTemplate] = useState<Template>(TEMPLATES[0])
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [hue, setHue] = useState(TEMPLATES[0].hue)
  const [goal, setGoal] = useState(TEMPLATES[0].goal)
  const [slots, setSlots] = useState<Slot[]>(() => slotsFor(TEMPLATES[0], models))
  const [limit, setLimit] = useState('500')
  const [vis, setVis] = useState<VisibilityValue>({ visibility: 'private', shared_with: [] })
  const [startAwake, setStartAwake] = useState(true)
  const [open, setOpen] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ label: string; state: 'doing' | 'done' | 'failed'; note?: string }[]>([])
  const [made, setMade] = useState<{ swarm: Swarm; minds: CreatedAgent[] } | null>(null)
  const [busy, setBusy] = useState(false)
  // professional-release r1.1/r1.2 (stand-in P1): a launch belongs to the sign-in it began under and to this open
  // wizard; every write goes through the bound operation (lib/boundOperation), checked right before it is sent
  const alive = useAlive()
  // a swarm being planned lives only here, across every step, until it is launched: a reload or a proposed move must not
  // drop it (stand-in r3 P1: Continue unmounts the earlier step's fields, their words stay here)
  useUnsaved(!made && (!!name.trim() || !!purpose.trim() || step > 0))

  function slotsFor(t: Template, list = models): Slot[] {
    const d = defaultModel(list)
    return t.roles.map((r, i) => ({ key: ++slotSeq, name: r.name, role: r.role, roleId: null, persona: '', kind: 'omega', model: d.model, options: d.options, budget: '5', hue: (t.hue + i * 47) % 360 }))
  }

  const pickTemplate = (t: Template) => {
    setTemplate(t)
    setHue(t.hue)
    setGoal(t.goal)
    setSlots(slotsFor(t))
    if (!name.trim()) setName('')
  }

  const taken = useMemo(() => new Set(Object.values(agents).map((a) => a.name.toLowerCase())), [agents])
  const nameClash = slots.find((s, i) => taken.has(s.name.trim().toLowerCase()) || slots.findIndex((x) => x.name.trim().toLowerCase() === s.name.trim().toLowerCase()) !== i)
  const valid = [!!name.trim(), slots.length > 0 && slots.every((s) => s.name.trim() && s.model) && !nameClash, Number(limit) >= 0, true]
  const totalBudget = slots.reduce((t, s) => t + (Number(s.budget) || 0), 0)

  const update = (key: number, patch: Partial<Slot>) => setSlots((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)))

  const launch = async () => {
    if (!client || busy) return
    setBusy(true)
    const log: typeof progress = []
    const push = (label: string) => {
      log.push({ label, state: 'doing' })
      setProgress([...log])
      return log.length - 1
    }
    const finish = (i: number, state: 'done' | 'failed' = 'done', note?: string) => {
      log[i] = { ...log[i], state, note }
      setProgress([...log])
    }
    let swarm: Swarm
    const minds: CreatedAgent[] = []
    const op = bindOperation(alive)
    const halted = (e: unknown) => stopped(e) || !op.current()
    try {
      let i = push(`Creating the swarm “${name.trim()}”`)
      swarm = await op.write(() => client.createSwarm({ name: name.trim(), description: purpose.trim(), hue, visibility: vis.visibility, shared_with: vis.visibility === 'shared' ? vis.shared_with : undefined }))
      finish(i)
      if (Number(limit) !== 500 && client.setBudget) {
        i = push(`Setting its spending limit to ${money(Number(limit))} a month`)
        const setBudget = client.setBudget
        await op.write(() => setBudget({ scope: `swarm:${swarm.id}`, period: 'month', limit_usd: Number(limit) }))
        finish(i)
      }
      for (const s of slots) {
        i = push(`Bringing ${s.name.trim()} to life`)
        try {
          const roleId = roleIdOf(s)
          const purposeLine = purpose.trim() ? ` The swarm's purpose: ${purpose.trim()}` : ''
          // with a role, the role writes the prompt (and knows the swarm); without one, say who the mind is
          const persona = roleId ? s.persona.trim() : `You are ${s.name.trim()}, the ${(s.role.trim() || 'member').toLowerCase()} in ${name.trim()}.${purposeLine} ${s.persona}`.trim()
          const created = await op.write(() => client.createAgent({ name: s.name.trim(), kind: s.kind, swarm_id: swarm.id, model: s.model, persona, hue: s.hue, budget_usd: Number(s.budget) || 0, options: Object.keys(s.options).length ? s.options : undefined, role_id: roleId, visibility: vis.visibility, shared_with: vis.visibility === 'shared' ? vis.shared_with : undefined }))
          minds.push(created)
          if (startAwake && s.kind !== 'module') await op.write(() => client.agentAction(created.id, 'start'))
          finish(i, 'done', startAwake && s.kind !== 'module' ? 'waking' : undefined)
        } catch (e) {
          if (halted(e)) throw e // a stop ends the whole launch, never only this mind
          finish(i, 'failed', e instanceof Error ? e.message : String(e))
        }
      }
      if (goal.trim()) {
        i = push('Posting the first task')
        await op.write(() => client.createGoal(swarm.id, { title: goal.trim(), priority: 0.7 }))
        finish(i)
      }
      setMade({ swarm, minds })
      markSaved('launch-swarm') // launched: what was typed in the wizard is in the hive now
    } catch (e) {
      const last = log.findIndex((x) => x.state === 'doing')
      // stopped: said honestly on the step it stopped at; nothing after it was sent
      if (last >= 0) finish(last, 'failed', halted(e) ? OPERATION_STOPPED_WORDS : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page title="Start a swarm" eyebrow="From an idea to a working swarm" label="Start a swarm" onClose={() => navigate({ name: 'swarms' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-16 md:px-6" data-unsaved-scope="launch-swarm">
        <ol className="mb-6 flex gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className="flex-1">
              <button onClick={() => i < step && !made && setStep(i)} disabled={i > step || !!made} aria-current={i === step ? 'step' : undefined} className="flex w-full flex-col gap-1.5 text-left">
                <span className="relative h-1 w-full overflow-hidden rounded-full bg-tint/10">
                  <m.span className="absolute inset-y-0 left-0 rounded-full" initial={false} animate={{ width: i <= step ? '100%' : '0%' }} style={{ background: hsl(hue, 100, 72), boxShadow: `0 0 10px ${hsl(hue, 100, 65)}` }} />
                </span>
                <span className={cx('text-[11px] font-medium', i === step ? 'text-ink' : 'text-ink-4')}>{s}</span>
              </button>
            </li>
          ))}
        </ol>

        <AnimatePresence mode="wait">
          <m.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}>
            {step === 0 && (
              <div className="space-y-6">
                <section>
                  <h2 className="eyebrow mb-2">What kind of swarm?</h2>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {TEMPLATES.map((t) => {
                      const on = t.id === template.id
                      return (
                        <button key={t.id} onClick={() => pickTemplate(t)} aria-pressed={on} className={cx('flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-all', on ? 'bg-tint/[0.07]' : 'border-line bg-tint/[0.02] hover:border-line-2')} style={on ? { borderColor: hsl(t.hue, 90, 70, 0.55), boxShadow: `0 12px 40px -18px ${hsl(t.hue, 100, 60, 0.7)}` } : undefined}>
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-shade/25" style={{ color: hsl(t.hue, 100, 78) }}>
                            <Icon name={t.icon} size={17} />
                          </span>
                          <span className="min-w-0">
                            <span className="block font-display text-[15px] font-semibold">{t.title}</span>
                            <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{t.blurb}</span>
                            <span className="mt-1.5 block text-[11px] text-ink-4">{t.roles.map((r) => r.name).join(' · ')}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
                <section className="grid gap-3">
                  <label className="block">
                    <span className="eyebrow">Name</span>
                    <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="e.g. Market Watch, Bridge Build, Reading Group" className="mt-2 min-h-12 w-full rounded-xl border border-line bg-shade/25 px-4 font-display text-lg text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
                  </label>
                  <label className="block">
                    <span className="eyebrow">What it is for</span>
                    <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} placeholder="One or two sentences every mind in it will read." className="thin-scroll mt-2 w-full resize-y rounded-xl border border-line bg-shade/25 p-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
                  </label>
                  <label className="block">
                    <span className="eyebrow">First task</span>
                    <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} placeholder="What should they start on? (you can add more later)" className="mt-2 min-h-11 w-full rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
                  </label>
                </section>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-3">
                <p className="text-[13px] text-ink-3">Each mind gets a name, a role, a model and a budget. Tap one to change its model or who pays for it.</p>
                {slots.map((s) => {
                  const row = rows.find((r) => r.id === s.model)
                  const clash = taken.has(s.name.trim().toLowerCase())
                  return (
                    <div key={s.key} className="rounded-2xl border border-line bg-tint/[0.03]" style={{ boxShadow: `0 16px 40px -30px ${hsl(s.hue, 100, 60, 0.7)}` }}>
                      <div className="flex flex-wrap items-center gap-3 p-3">
                        <Orb hue={s.hue} size={34} />
                        <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-[1fr_1fr]">
                          <input value={s.name} onChange={(e) => update(s.key, { name: e.target.value })} aria-label="Mind name" maxLength={32} className={cx('min-h-10 rounded-lg border bg-shade/25 px-2.5 font-display text-[15px] text-ink outline-none focus:border-line-2', clash ? 'border-bad/60' : 'border-line')} />
                          <RoleSelect compact value={roleIdOf(s)} onChange={(roleId) => update(s.key, { roleId, role: library?.find((r) => r.id === roleId)?.name ?? '' })} />
                        </div>
                        <div className="flex items-center rounded-lg border border-line bg-shade/25 px-2" title="Budget cap for this mind">
                          <span className="text-ink-3">$</span>
                          <input inputMode="decimal" value={s.budget} onChange={(e) => update(s.key, { budget: e.target.value.replace(/[^\d.]/g, '') })} aria-label={`Budget for ${shown(s.name)}`} className="min-h-10 w-12 bg-transparent px-1 font-mono text-[13px] text-ink outline-none" />
                        </div>
                        <button onClick={() => setSlots((l) => l.filter((x) => x.key !== s.key))} disabled={slots.length === 1} aria-label={`Remove ${shown(s.name)}`} className="flex size-9 items-center justify-center rounded-lg text-ink-4 hover:bg-tint/[0.06] hover:text-ink disabled:opacity-30">
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      <button onClick={() => setOpen(open === s.key ? null : s.key)} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[12.5px] text-ink-3 hover:bg-tint/[0.03]">
                        <Icon name="cpu" size={13} />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-ink-2">{row?.name ?? s.model}</span>
                          {row && !row.local && <span className="text-ink-4"> · {priceLabel(row.inPerM, row.outPerM)}</span>}
                        </span>
                        <span className="text-ink-4">{open === s.key ? 'Done' : 'Change'}</span>
                      </button>
                      <AnimatePresence initial={false}>
                        {open === s.key && (
                          <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                            <div className="space-y-4 border-t border-line p-3">
                              <ModelPicker value={s.model} options={s.options} hue={s.hue} onChange={(model, options) => update(s.key, { model, options })} />
                              <KeyPicker provider={s.model.split('/')[0]} value={s.options.key} hue={s.hue} onChange={(key) => update(s.key, { options: { ...s.options, key } })} />
                              <label className="block">
                                <span className="eyebrow">{roleIdOf(s) ? `Extra instructions for ${s.name || 'this mind'}` : `How ${s.name || 'it'} works`}</span>
                                <textarea value={s.persona} onChange={(e) => update(s.key, { persona: e.target.value })} rows={3} className="thin-scroll mt-2 w-full resize-y rounded-xl border border-line bg-shade/25 p-3 text-[13.5px] text-ink outline-none focus:border-line-2" />
                              </label>
                            </div>
                          </m.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
                {nameClash && <p className="text-[12px] text-bad">Each mind needs a name not used anywhere else in the hive ({nameClash.name || 'empty'}).</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="subtle"
                    icon="plus"
                    onClick={() => {
                      const d = defaultModel(models)
                      setSlots((l) => [...l, { key: ++slotSeq, name: '', role: 'Generalist', roleId: null, persona: '', kind: 'omega', model: d.model, options: d.options, budget: '5', hue: (hue + l.length * 47) % 360 }])
                    }}
                  >
                    Add a mind
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <section className="rounded-2xl border border-line bg-tint/[0.03] p-4">
                  <VisibilityPicker value={vis} onChange={setVis} label="Who can see this swarm and its minds" />
                </section>
                <section className="rounded-2xl border border-line bg-tint/[0.03] p-4">
                  <h2 className="eyebrow">Spending</h2>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <span className="text-[13.5px] text-ink-2">The whole swarm may spend at most</span>
                    <div className="flex items-center rounded-xl border border-line bg-shade/25 px-3">
                      <span className="text-ink-3">$</span>
                      <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Monthly limit in dollars" className="min-h-10 w-20 bg-transparent px-1 font-mono text-ink outline-none" />
                    </div>
                    <span className="text-[13.5px] text-ink-2">a month.</span>
                  </div>
                  <p className="mt-2 text-[12px] text-ink-4">
                    Each mind also stops at its own cap ({money(totalBudget)} across the {slots.length} of them). Every paid call is checked against both before it is made; change them any time on the Usage page.
                  </p>
                </section>
                <section className="rounded-2xl border border-line bg-tint/[0.03] p-4">
                  <h2 className="eyebrow">Safety</h2>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                    Minds talk, research, publish beliefs and work on tasks freely. Anything risky (running commands, writing files, changing code, touching their own memory) waits in your Inbox for a yes. Money and passwords are never theirs to touch.
                  </p>
                </section>
                <section className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-tint/[0.03] p-4">
                  <div>
                    <h2 className="eyebrow">Start right away</h2>
                    <p className="mt-1 text-[12.5px] text-ink-3">{startAwake ? 'The minds wake as soon as they are created and pick up the first task.' : 'The minds are created asleep; wake them when you are ready.'}</p>
                  </div>
                  <Segmented value={startAwake ? 'yes' : 'no'} onChange={(v) => setStartAwake(v === 'yes')} label="Start right away" options={[{ value: 'yes', label: 'Awake' }, { value: 'no', label: 'Asleep' }]} dense />
                </section>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <div className="relative flex flex-col items-center overflow-hidden rounded-[22px] border border-line py-8" style={{ background: `radial-gradient(60% 80% at 50% 40%, ${hsl(hue, 90, 55, 0.28)}, transparent 70%)` }}>
                  <div className="flex -space-x-2">
                    {slots.map((s) => (
                      <Orb key={s.key} hue={s.hue} size={44} />
                    ))}
                  </div>
                  <div className="mt-3 font-display text-2xl font-semibold tracking-tight">{name || 'Your swarm'}</div>
                  <div className="mt-1 text-sm text-ink-3">{slots.map((s) => s.name).join(', ')}</div>
                  {goal.trim() && <div className="mt-3 max-w-md px-4 text-center text-[13px] text-ink-2">First task: {goal}</div>}
                </div>
                {progress.length > 0 && (
                  <ul className="space-y-1.5" aria-live="polite">
                    {progress.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-[13px]">
                        <span className="mt-0.5">{p.state === 'doing' ? <span className="inline-block size-3 animate-pulse rounded-full bg-accent-2" /> : <Icon name={p.state === 'done' ? 'check' : 'alert'} size={14} className={p.state === 'done' ? 'text-good' : 'text-bad'} />}</span>
                        <span className={cx(p.state === 'failed' ? 'text-bad' : 'text-ink-2')}>
                          {p.label}
                          {p.note && <span className="text-ink-4"> · {p.note}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {made && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" icon="swarms" onClick={() => navigate({ name: 'swarm', id: made.swarm.id })}>
                      Open {shown(made.swarm.name)}
                    </Button>
                    <Button variant="subtle" icon="target" onClick={() => navigate({ name: 'tasks', swarm: made.swarm.id })}>
                      See its tasks
                    </Button>
                  </div>
                )}
              </div>
            )}
          </m.div>
        </AnimatePresence>

        {!made && (
          <div className="mt-8 flex items-center gap-2 border-t border-line pt-4">
            {step > 0 && (
              <Button variant="ghost" icon="back" onClick={() => setStep(step - 1)} disabled={busy}>
                Back
              </Button>
            )}
            <div className="flex-1" />
            {step < 3 ? (
              <Button variant="primary" size="lg" disabled={!valid[step]} onClick={() => setStep(step + 1)} className="min-w-32">
                Continue
              </Button>
            ) : (
              <Button variant="primary" size="lg" icon="sparkles" disabled={busy || !valid[0] || !valid[1]} onClick={() => void launch()}>
                {busy ? 'Launching…' : `Launch ${name.trim() || 'the swarm'}`}
              </Button>
            )}
          </div>
        )}
      </div>
    </Page>
  )
}
