import { VisibilityPicker, type VisibilityValue } from '../../ui/Visibility'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { AgentKind, AgentOptions, CreateAgentBody } from '../../api/types'
import { ModelPicker } from '../models/ModelPicker'
import { RoleSelect } from '../roles/RoleSelect'
import { KeyPicker } from '../keys/KeyPicker'
import { buildRows, priceLabel, readDefaultModel, routeSummary, writeDefaultModel } from '../models/modelUtil'
import { hsl } from '../../lib/color'
import { useReducedMotion } from '../../lib/hooks'
import { closeToHome, navigate } from '../../lib/router'
import { useScene } from '../../scene/sceneStore'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, IconButton, Orb } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { Sheet } from '../../ui/Sheet'
import { shown } from '../../lib/displayName'
import { plural } from '../../lib/plural'
import { useUnsaved } from '../ask/dirty'
import { guardComposing } from '../../features/ask/keys'

const NAME_IDEAS = ['Lumen', 'Orrery', 'Tessel', 'Halcyon', 'Ember', 'Sable', 'Quill', 'Nimbus', 'Fable', 'Cinder', 'Moth', 'Rook', 'Juno', 'Wren', 'Kestrel', 'Lark', 'Onyx', 'Pollen', 'Spindle']

const KINDS: { value: AgentKind; title: string; body: string }[] = [
  { value: 'omega', title: 'Omega', body: 'Full neural-symbolic agent: MeTTa, AtomSpace memory, skills.' },
  { value: 'iter', title: 'Iter', body: 'A lighter loop that iterates on one task and reports.' },
  { value: 'module', title: 'Module', body: 'A tool-like mind that ingests or transforms data.' },
]


const STEPS = ['Spark', 'Home', 'Mind', 'Birth'] as const

export default function CreateFlow({ swarmId }: { swarmId?: string }) {
  const swarms = useHive((s) => s.swarms)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const agents = useHive((s) => s.agents)
  const createAgent = useHive((s) => s.createAgent)
  const toast = useHive((s) => s.toast)
  const reduced = useReducedMotion()
  const swarmList = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])

  const [step, setStep] = useState(0)
  const [dir, setDir] = useState(1)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentKind>('omega')
  const [hue, setHue] = useState(() => Math.floor(Math.random() * 360))
  const [swarm, setSwarm] = useState<string | null>(swarmId && swarms[swarmId] ? swarmId : (swarmList[0]?.id ?? null))
  // The remembered default (Models view), else a sensible first choice from what is connected.
  const [model, setModel] = useState(() => {
    const def = readDefaultModel()
    if (def && models.some((m) => m.id === def.model)) return def.model
    if (def?.model.startsWith('openrouter/') && models.some((m) => m.provider === 'openrouter')) return def.model
    return models.find((m) => m.id.includes('sonnet'))?.id ?? models.find((m) => !m.local)?.id ?? models[0]?.id ?? ''
  })
  const [options, setOptions] = useState<AgentOptions>(() => readDefaultModel()?.options ?? {})
  const [persona, setPersona] = useState('')
  const [roleId, setRoleId] = useState<string | null>(null)
  const [budget, setBudget] = useState('10')
  const [vis, setVis] = useState<VisibilityValue>({ visibility: 'private', shared_with: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // a mind being made lives only here until it is created: a reload or a proposed move must not drop it
  useUnsaved(!!name.trim() || !!persona.trim() || step > 0)

  const engine = useScene((s) => s.engine)
  useEffect(() => {
    if (!engine) return
    const t = setTimeout(() => (swarm ? engine.flyToSwarm(swarm) : engine.overview()), 120)
    return () => clearTimeout(t)
  }, [engine, swarm])

  const taken = useMemo(() => new Set(Object.values(agents).map((a) => a.name.toLowerCase())), [agents])
  const nameErr = name.trim() && taken.has(name.trim().toLowerCase()) ? 'That name is taken' : null
  const valid = [!!name.trim() && !nameErr, !!model, true, true]
  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const chosen = rows.find((r) => r.id === model)
  const keys = useHive((s) => s.keys)
  const providerKeys = (keys ?? []).filter((k) => k.provider === model.split('/')[0])
  const paidKey = options.key ? providerKeys.find((k) => k.id === options.key) : providerKeys.find((k) => k.default)
  const paidBy = paidKey ? `${paidKey.label} ${paidKey.hint}${options.key ? '' : ' (hive default)'}` : 'No key yet'
  const free = chosen ? chosen.local || (chosen.inPerM === 0 && chosen.outPerM === 0) : models.find((m) => m.id === model)?.local

  // Esc or a phone drag: just this sheet; the visible X: home (closeToHome)
  const close = () => navigate({ name: 'hive' })
  const go = (n: number) => {
    setDir(n > step ? 1 : -1)
    setStep(n)
  }

  const suggest = () => {
    const free = NAME_IDEAS.filter((n) => !taken.has(n.toLowerCase()))
    setName(free[Math.floor(Math.random() * free.length)] ?? `Mind-${Math.floor(Math.random() * 999)}`)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const body: CreateAgentBody = {
      name: name.trim(),
      kind,
      swarm_id: swarm,
      model,
      persona: persona.trim() || undefined,
      hue,
      budget_usd: Number(budget) || 0,
      options: Object.keys(options).length ? options : undefined,
      role_id: roleId,
      visibility: vis.visibility,
      shared_with: vis.visibility === 'shared' ? vis.shared_with : undefined,
    }
    try {
      const created = await createAgent(body)
      const { token, ...agent } = created
      if (!readDefaultModel()) writeDefaultModel({ model, options })
      navigate({ name: 'hive' }, { replace: true })
      setTimeout(() => {
        const engine = useScene.getState().engine
        if (agent.swarm_id) engine?.flyToSwarm(agent.swarm_id)
        else engine?.overview()
      }, 60)
      setTimeout(() => useHive.setState({ reveal: { agent, token } }), reduced ? 600 : 2100)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not create the mind'
      setError(msg)
      toast({ tone: 'error', title: 'Creation failed', body: msg })
      setBusy(false)
    }
  }

  const header = (
    <div className="px-4 pt-1 md:px-5 md:pt-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="eyebrow">New mind</div>
          <h2 className="font-display text-xl font-semibold tracking-tight">{['Give it a spark', 'Choose a home', 'Shape its mind', 'Bring it to life'][step]}</h2>
        </div>
        <IconButton icon="x" label="Cancel" onClick={closeToHome} className="-mr-2" />
      </div>
      <ol className="mt-3 flex gap-1.5" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <button
              onClick={() => i < step && go(i)}
              disabled={i > step}
              aria-current={i === step ? 'step' : undefined}
              className="group flex w-full flex-col gap-1.5 text-left"
            >
              <span className="relative h-1 w-full overflow-hidden rounded-full bg-tint/10">
                <m.span
                  className="absolute inset-y-0 left-0 rounded-full"
                  initial={false}
                  animate={{ width: i <= step ? '100%' : '0%' }}
                  transition={{ type: 'spring', stiffness: 200, damping: 30 }}
                  style={{ background: hsl(hue, 100, 72), boxShadow: `0 0 10px ${hsl(hue, 100, 65)}` }}
                />
              </span>
              <span className={cx('text-[11px] font-medium', i === step ? 'text-ink' : 'text-ink-4')}>{s}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )

  return (
    <Sheet label="Create a mind" onClose={close} header={header} width={480} initialSnap="full">
      <div className="thin-scroll relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <m.div
            key={step}
            custom={dir}
            initial={{ opacity: 0, x: reduced ? 0 : dir * 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduced ? 0 : dir * -40 }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            className="px-4 pt-4 pb-6 md:px-5"
          >
            {step === 0 && (
              <div className="space-y-6">
                <div className="flex justify-center">
                  <HueRing hue={hue} onChange={setHue} name={name} kind={kind} />
                </div>
                <div>
                  <label htmlFor="dot-name" className="eyebrow">
                    Name
                  </label>
                  <div className="mt-2 flex gap-2">
                    <input
                      id="dot-name"
                      data-autofocus
                      value={name}
                      maxLength={32}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => !guardComposing(e) && e.key === 'Enter' && valid[0] && go(1)}
                      placeholder="Vega, Coral, Anvil…"
                      autoComplete="off"
                      aria-invalid={!!nameErr}
                      className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-shade/25 px-4 font-display text-lg text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
                    />
                    <IconButton icon="dice" label="Suggest a name" onClick={suggest} className="size-12 border border-line" />
                  </div>
                  {nameErr && <p className="mt-1.5 text-[12px] text-bad">{nameErr}</p>}
                </div>
                <fieldset>
                  <legend className="eyebrow mb-2">Kind</legend>
                  <div className="grid gap-2" role="radiogroup">
                    {KINDS.map((k) => (
                      <Choice key={k.value} on={kind === k.value} hue={hue} onClick={() => setKind(k.value)} title={k.title} body={k.body} />
                    ))}
                  </div>
                </fieldset>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-6">
                <fieldset>
                  <legend className="eyebrow mb-2">Swarm</legend>
                  <div className="grid gap-2" role="radiogroup">
                    {swarmList.map((s) => (
                      <Choice
                        key={s.id}
                        on={swarm === s.id}
                        hue={s.hue}
                        onClick={() => setSwarm(s.id)}
                        title={shown(s.name)}
                        body={`${plural(s.member_ids.length, 'mind')} · ${shown(s.description)}`}
                        lead={<span className="size-3 rounded-full" style={{ background: hsl(s.hue, 95, 68), boxShadow: `0 0 12px ${hsl(s.hue, 100, 60)}` }} />}
                      />
                    ))}
                    <Choice on={swarm === null} hue={hue} onClick={() => setSwarm(null)} title="Wanderer" body="No swarm. Drifts between commons and carries rumours." lead={<Icon name="sparkles" size={14} className="text-ink-3" />} />
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="eyebrow mb-2">Model</legend>
                  <ModelPicker
                    value={model}
                    options={options}
                    hue={hue}
                    onChange={(m, o) => {
                      setModel(m)
                      setOptions(o)
                    }}
                  />
                </fieldset>
                <KeyPicker provider={model.split('/')[0]} value={options.key} hue={hue} onChange={(key) => setOptions((o) => ({ ...o, key }))} />
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div>
                  <div className="eyebrow mb-2">Role</div>
                  <RoleSelect value={roleId} onChange={setRoleId} />
                  <label htmlFor="dot-persona" className="eyebrow mt-4 block">
                    {roleId ? 'Extra instructions' : 'Instructions'}
                  </label>
                  <textarea
                    id="dot-persona"
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    rows={5}
                    placeholder={`Who is ${name.trim() || 'this mind'}? What does it care about? How sure must it be before it publishes?`}
                    className="thin-scroll mt-2 w-full resize-y rounded-xl border border-line bg-shade/25 p-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
                  />
                </div>
                <VisibilityPicker value={vis} onChange={setVis} label="Who can see this mind" />
                <div>
                  <div className="eyebrow">Budget cap</div>
                  <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Budget presets">
                    {['0', '5', '10', '25', '50'].map((b) => (
                      <button
                        key={b}
                        role="radio"
                        aria-checked={budget === b}
                        onClick={() => setBudget(b)}
                        className={cx('min-h-10 rounded-xl border px-3.5 font-mono text-[13px] transition-colors', budget === b ? 'border-transparent text-primary-ink' : 'border-line bg-tint/[0.04] text-ink-2 hover:border-line-2')}
                        style={budget === b ? { background: hsl(hue, 100, 80) } : undefined}
                      >
                        {b === '0' ? '∞' : `$${b}`}
                      </button>
                    ))}
                    <div className="flex min-h-10 items-center rounded-xl border border-line bg-shade/25 px-3 focus-within:border-line-2">
                      <span className="text-ink-3">$</span>
                      <input
                        aria-label="Custom budget in dollars"
                        inputMode="decimal"
                        value={budget}
                        onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))}
                        className="w-16 bg-transparent px-1 font-mono text-ink outline-none"
                      />
                    </div>
                  </div>
                  {Number(budget) || free ? (
                    <p className="mt-1.5 text-[12px] text-ink-4">
                      {Number(budget) ? `The gateway stops spending at $${budget}.` : 'Unlimited. Watch the usage view.'}
                      {chosen && chosen.inPerM != null && !free ? ` ${chosen.name} costs ${priceLabel(chosen.inPerM, chosen.outPerM)} tokens.` : ''}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[12px] text-warn">A paid model needs a budget: with $0 the gateway refuses every call (402 no_budget). Pick a cap, or a local model.</p>
                  )}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="relative flex flex-col items-center overflow-hidden rounded-[22px] border border-line py-8" style={{ background: `radial-gradient(60% 80% at 50% 40%, ${hsl(hue, 90, 55, 0.28)}, transparent 70%)` }}>
                  <Orb hue={hue} size={92} />
                  <div className="mt-3 font-display text-2xl font-semibold tracking-tight">{name}</div>
                  <div className="mt-1 text-sm text-ink-3 capitalize">
                    {kind} · {swarm ? swarms[swarm]?.name : 'wanderer'}
                  </div>
                </div>
                <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
                  {[
                    [
                      'Model',
                      <span>
                        <span className="block">{chosen?.name ?? model}</span>
                        <span className="block font-mono text-[11px] text-ink-4">{model}</span>
                      </span>,
                    ],
                    ...(chosen?.provider === 'openrouter' ? [['Served by', routeSummary(options)]] : []),
                    ...(chosen && !chosen.local ? [['Paid by', paidBy]] : []),
                    ['Budget', Number(budget) ? `$${budget}` : 'Unlimited'],
                    ['Persona', persona.trim() ? <span className="line-clamp-2 text-ink-2">{persona}</span> : <span className="text-ink-4">Default</span>],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex gap-4 px-3 py-2.5">
                      <dt className="w-16 shrink-0 text-ink-3">{k}</dt>
                      <dd className="min-w-0 flex-1">{v}</dd>
                    </div>
                  ))}
                </dl>
                {error && (
                  <p className="text-sm text-bad" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </m.div>
        </AnimatePresence>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-4 py-3 md:px-5">
        {step > 0 && (
          <Button variant="ghost" icon="back" onClick={() => go(step - 1)} disabled={busy}>
            Back
          </Button>
        )}
        <div className="flex-1" />
        {step < 3 ? (
          <Button variant="primary" onClick={() => go(step + 1)} disabled={!valid[step]} size="lg" className="min-w-32">
            Continue
          </Button>
        ) : (
          <Button variant="primary" icon="sparkles" onClick={submit} disabled={busy || !valid[0]} size="lg">
            {busy ? 'Igniting…' : `Bring ${name.trim()} to life`}
          </Button>
        )}
      </div>
    </Sheet>
  )
}

function Radio({ on, hue }: { on: boolean; hue: number }) {
  return (
    <span className={cx('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-transparent' : 'border-line-2')} style={on ? { background: hsl(hue, 100, 75), boxShadow: `0 0 10px ${hsl(hue, 100, 65, 0.7)}` } : undefined}>
      {on && <span className="size-1.5 rounded-full bg-primary-ink" />}
    </span>
  )
}

function Choice({ on, hue, onClick, title, body, lead }: { on: boolean; hue: number; onClick: () => void; title: string; body: string; lead?: React.ReactNode }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cx('flex min-h-14 w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all', on ? 'bg-tint/[0.07]' : 'border-line bg-tint/[0.02] hover:border-line-2')}
      style={on ? { borderColor: hsl(hue, 90, 70, 0.55), boxShadow: `0 0 0 1px ${hsl(hue, 90, 70, 0.25)} inset, 0 8px 30px -12px ${hsl(hue, 100, 60, 0.5)}` } : undefined}
    >
      <span className="mt-1 flex w-4 justify-center">{lead ?? <Radio on={on} hue={hue} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-3">{body}</span>
      </span>
      {lead && on && <Icon name="check" size={16} className="mt-0.5 text-ink" />}
    </button>
  )
}

/** A colour wheel ring with the orb itself breathing in the middle. Drag, tap or use arrow keys. */
function HueRing({ hue, onChange, name, kind }: { hue: number; onChange: (h: number) => void; name: string; kind: AgentKind }) {
  const ref = useRef<HTMLDivElement>(null)
  const S = 196
  const R = (S / 2) * 0.89
  const set = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2))
    onChange(Math.round(((a * 180) / Math.PI + 90 + 360) % 360))
  }
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30 : 5
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange((hue + step) % 360)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange((hue - step + 360) % 360)
    else return
    e.preventDefault()
  }
  const a = ((hue - 90) * Math.PI) / 180
  return (
    <div className="flex flex-col items-center">
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Mind colour"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={hue}
        aria-valuetext={`hue ${hue} degrees`}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          set(e)
        }}
        onPointerMove={(e) => e.buttons && set(e)}
        className="relative touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent-2"
        style={{ width: S, height: S }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(${Array.from({ length: 13 }, (_, i) => hsl(i * 30, 92, 64)).join(',')})`,
            mask: 'radial-gradient(circle closest-side, transparent 78%, #000 79.5%, #000 98.5%, transparent 100%)',
            WebkitMask: 'radial-gradient(circle closest-side, transparent 78%, #000 79.5%, #000 98.5%, transparent 100%)',
            opacity: 0.9,
          }}
        />
        <div className="absolute inset-[30px] rounded-full" style={{ background: `radial-gradient(circle, ${hsl(hue, 90, 50, 0.25)}, transparent 70%)` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Orb hue={hue} size={78} />
        </div>
        <m.div
          className="pointer-events-none absolute size-7 rounded-full border-[3px] border-white"
          animate={{ left: S / 2 + Math.cos(a) * R - 14, top: S / 2 + Math.sin(a) * R - 14 }}
          transition={{ type: 'spring', stiffness: 700, damping: 40 }}
          style={{ background: hsl(hue, 92, 64), boxShadow: `0 0 18px ${hsl(hue, 100, 65)}` }}
        />
      </div>
      <div className="mt-3 h-7 font-display text-xl font-semibold tracking-tight">{name.trim() || <span className="text-ink-4">Unnamed</span>}</div>
      <div className="text-[12px] text-ink-3 capitalize">{kind} mind · hue {hue}°</div>
    </div>
  )
}
