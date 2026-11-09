import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { PolicyMode, PolicyRule, PolicyScope } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { useIsDesktop, useNow } from '../../lib/hooks'
import { DEFAULT_POLICY, globMatch, resolvePolicy, scopeId, scopeKind } from '../../lib/policy'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { MODE_STYLE } from '../../ui/modes'
import { Button, EmptyState, ErrorState, IconButton, ModeChip, Orb, Segmented, Skeleton } from '../../ui/primitives'
import { shown } from '../../lib/displayName'

/** Skills the UI knows about, for glob previews and the tester. */
const KNOWN = [
  'send', 'wait', 'pin', 'hive-status', 'query', 'remember', 'episodes', 'search', 'web-search', 'read-file',
  'shell', 'shell-confirm', 'metta', 'write-file', 'append-file', 'send-file', 'codex-run', 'space-transform', 'remove-atom', 'space-commit',
  'fetch-telemetry', 'compute-period', 'change-password', 'transfer-funds', 'pay', 'purchase',
]

const MODES: PolicyMode[] = ['allow', 'ask', 'deny']

export default function PolicyEditor() {
  const policy = useHive((s) => s.policy)
  const load = useHive((s) => s.loadPolicy)
  const desktop = useIsDesktop()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    load().then(() => setErr(null), (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the policy'))
  }, [load])

  if (err && !policy) return <ErrorState title="Could not load the rules" body={err} onRetry={() => load().then(() => setErr(null), () => undefined)} />
  if (!policy)
    return (
      <div className="space-y-3">
        <Skeleton className="h-40 w-full rounded-[22px]" />
        <Skeleton className="h-64 w-full rounded-[22px]" />
      </div>
    )

  const side = (
    <div className="space-y-3">
      <AddRule />
      <Tester rules={policy} />
      <Help />
    </div>
  )
  if (!desktop)
    return (
      <div className="space-y-4">
        <AddRule />
        <RuleList rules={policy} />
        <Tester rules={policy} />
        <Help />
      </div>
    )
  return (
    <div className="grid grid-cols-[1fr_380px] gap-6">
      <RuleList rules={policy} />
      <aside className="sticky top-16 self-start">{side}</aside>
    </div>
  )
}

function Card({ title, icon, children, className, tour }: { title: string; icon?: Parameters<typeof Icon>[0]['name']; children: ReactNode; className?: string; tour?: string }) {
  return (
    <section className={cx('rounded-[20px] border border-line bg-tint/[0.025] p-4', className)} aria-label={title} data-tour={tour}>
      <h2 className="eyebrow mb-3 flex items-center gap-1.5">
        {icon && <Icon name={icon} size={13} />}
        {title}
      </h2>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------- list

function RuleList({ rules }: { rules: PolicyRule[] }) {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const groups = useMemo(() => {
    const hive = rules.filter((r) => r.scope === 'hive')
    const bySwarm = new Map<string, PolicyRule[]>()
    const byAgent = new Map<string, PolicyRule[]>()
    for (const r of rules) {
      const id = scopeId(r.scope)
      if (!id) continue
      const map = scopeKind(r.scope) === 'swarm' ? bySwarm : byAgent
      if (!map.has(id)) map.set(id, [])
      map.get(id)!.push(r)
    }
    return { hive, bySwarm: [...bySwarm.entries()], byAgent: [...byAgent.entries()] }
  }, [rules])

  if (!rules.length) return <EmptyState icon="rules" title="No rules yet" body="Only the defaults apply. Add a rule to allow, ask or deny a skill for the hive, a swarm or one mind." />

  return (
    <div className="space-y-5" data-tour="policy-rules">
      <Group title="Hive" sub="Every mind" lead={<span className="flex size-6 items-center justify-center rounded-lg bg-tint/[0.06] text-ink-2"><Icon name="hive" size={14} /></span>} rules={groups.hive} />
      {groups.bySwarm.length > 0 && <div className="eyebrow px-1 pt-1">Swarms</div>}
      {groups.bySwarm.map(([id, list]) => {
        const sw = swarms[id]
        return (
          <Group
            key={id}
            title={sw?.name ?? id}
            sub={plural(sw?.member_ids.length ?? 0, 'mind')}
            lead={<span className="size-3 rounded-full" style={{ background: hsl(sw?.hue ?? 252, 95, 68), boxShadow: `0 0 10px ${hsl(sw?.hue ?? 252, 100, 60)}` }} />}
            rules={list}
          />
        )
      })}
      {groups.byAgent.length > 0 && <div className="eyebrow px-1 pt-1">Minds</div>}
      {groups.byAgent.map(([id, list]) => {
        const a = agents[id]
        return <Group key={id} title={a?.name ?? id} sub={a ? (a.swarm_id ? (swarms[a.swarm_id]?.name ?? '') : 'wanderer') : 'gone'} lead={<Orb hue={a?.hue ?? 252} status={a?.status} size={22} />} rules={list} />
      })}
    </div>
  )
}

function Group({ title, sub, lead, rules }: { title: string; sub: string; lead: ReactNode; rules: PolicyRule[] }) {
  return (
    <section aria-label={`${title} rules`}>
      <div className="mb-2 flex items-center gap-2 px-1">
        {lead}
        <h3 className="font-display text-[15px] font-semibold">{title}</h3>
        <span className="text-[12px] text-ink-4">{sub}</span>
        <span className="ml-auto text-[12px] text-ink-4 tabular-nums">{rules.length}</span>
      </div>
      <ul className="overflow-hidden rounded-[18px] border border-line bg-tint/[0.02]">
        <AnimatePresence initial={false}>
          {rules.length === 0 && <li className="px-4 py-3 text-[13px] text-ink-4">No rules at this scope.</li>}
          {rules.map((r, i) => (
            <RuleRow key={r.id} rule={r} first={i === 0} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  )
}

function RuleRow({ rule, first }: { rule: PolicyRule; first: boolean }) {
  const del = useHive((s) => s.deleteRule)
  const now = useNow(60_000)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3500)
    return () => clearTimeout(t)
  }, [confirm])
  const matches = KNOWN.filter((k) => globMatch(rule.skill, k))
  return (
    <m.li
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.22 } }}
      className={cx('overflow-hidden', !first && 'border-t border-line')}
    >
      <div className="relative flex min-h-14 items-center gap-3 py-2 pr-1.5 pl-4 md:pl-5">
        <span className="absolute top-1/2 left-1.5 h-7 w-[3px] -translate-y-1/2 rounded-full" style={{ background: MODE_STYLE[rule.mode].color, opacity: 0.75, boxShadow: `0 0 8px ${MODE_STYLE[rule.mode].color}` }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-line-2 bg-shade/30 px-1.5 py-px font-mono text-[13px] text-ink">{rule.skill}</code>
            <ModeChip mode={rule.mode} />
            {rule.skill.includes('*') && matches.length > 0 && <span className="hidden text-meta text-ink-4 sm:inline">matches {matches.slice(0, 3).join(', ')}{matches.length > 3 ? ` +${matches.length - 3}` : ''}</span>}
          </div>
          <div className="mt-1 truncate text-[12px] text-ink-3">
            {rule.note || <span className="text-ink-4">No note</span>}
            <span className="text-ink-4"> · {ago(rule.created_at, now)}</span>
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {confirm ? (
            <m.div key="c" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
              <Button variant="danger" className="px-3" onClick={() => void del(rule.id)}>
                Delete
              </Button>
            </m.div>
          ) : (
            <m.div key="t" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <IconButton icon="trash" label={`Delete rule ${rule.skill}`} size={18} className="text-ink-4 hover:text-bad" onClick={() => setConfirm(true)} />
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </m.li>
  )
}

// ---------------------------------------------------------------- add

const selectCls =
  'min-h-11 w-full appearance-none rounded-xl border border-line bg-shade/30 bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9 pl-3 text-[14px] text-ink outline-none focus:border-line-2'
const chevronBg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a89b3' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`

function AddRule() {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const add = useHive((s) => s.addRule)
  const [kind, setKind] = useState<'hive' | 'swarm' | 'agent'>('hive')
  const swarmList = useMemo(() => Object.values(swarms).sort((a, b) => a.name.localeCompare(b.name)), [swarms])
  const agentList = useMemo(() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)), [agents])
  const [target, setTarget] = useState('')
  const [skill, setSkill] = useState('')
  const [mode, setMode] = useState<PolicyMode>('ask')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(0)

  const effectiveTarget = target || (kind === 'swarm' ? swarmList[0]?.id : kind === 'agent' ? agentList[0]?.id : '') || ''
  const scope: PolicyScope = kind === 'hive' ? 'hive' : kind === 'swarm' ? `swarm:${effectiveTarget}` : `agent:${effectiveTarget}`
  const matches = skill.trim() ? KNOWN.filter((k) => globMatch(skill.trim(), k)) : []
  const valid = !!skill.trim() && /^[\w*?.-]+$/.test(skill.trim()) && (kind === 'hive' || !!effectiveTarget)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const ok = await add({ scope, skill: skill.trim(), mode, note: note.trim() || undefined })
    setBusy(false)
    if (ok) {
      setSkill('')
      setNote('')
      setFlash((n) => n + 1)
    }
  }

  return (
    <Card title="Add a rule" icon="plus" tour="policy-add">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <span className="mb-1.5 block text-[12px] text-ink-3">Scope</span>
          <Segmented
            label="Rule scope"
            value={kind}
            onChange={(k) => {
              setKind(k)
              setTarget('')
            }}
            className="w-full"
            options={[
              { value: 'hive', label: 'Hive' },
              { value: 'swarm', label: 'Swarm' },
              { value: 'agent', label: 'Mind' },
            ]}
          />
          <AnimatePresence initial={false}>
            {kind !== 'hive' && (
              <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <label className="sr-only" htmlFor="rule-target">
                  {kind === 'swarm' ? 'Swarm' : 'Mind'}
                </label>
                <select id="rule-target" value={effectiveTarget} onChange={(e) => setTarget(e.target.value)} className={cx(selectCls, 'mt-2')} style={{ backgroundImage: chevronBg }}>
                  {(kind === 'swarm' ? swarmList : agentList).map((x) => (
                    <option key={x.id} value={x.id}>
                      {shown(x.name)}
                    </option>
                  ))}
                </select>
              </m.div>
            )}
          </AnimatePresence>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-ink-3">Skill glob</span>
          <input
            value={skill}
            onChange={(e) => setSkill(e.target.value.replace(/\s/g, ''))}
            placeholder="shell*  ·  write-file  ·  *"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
          />
          <span className="mt-1 block min-h-4 truncate text-meta text-ink-4">
            {skill.trim() ? (matches.length ? `Matches ${matches.slice(0, 5).join(', ')}${matches.length > 5 ? ` and ${matches.length - 5} more` : ''}` : 'Matches no skill the UI knows (it may still match others)') : 'Use * for any run of characters.'}
          </span>
        </label>
        <div role="radiogroup" aria-label="Mode" className="grid grid-cols-3 gap-1.5">
          {MODES.map((md) => {
            const st = MODE_STYLE[md]
            const on = md === mode
            return (
              <button
                key={md}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMode(md)}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border text-[13px] font-semibold transition-all"
                style={{
                  color: on ? st.color : 'var(--color-ink-3)',
                  borderColor: on ? `${st.color}77` : 'var(--color-line)',
                  background: on ? st.bg : 'transparent',
                  boxShadow: on ? `0 0 18px -6px ${st.color}` : undefined,
                }}
              >
                <Icon name={st.icon} size={14} strokeWidth={2.4} />
                {st.label}
              </button>
            )
          })}
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-ink-3">Note (shown as the reason)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this rule exists"
            className="min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
          />
        </label>
        <Button type="submit" variant="primary" icon={flash ? 'check' : 'plus'} key={flash} disabled={!valid || busy} className="w-full">
          {busy ? 'Adding…' : 'Add rule'}
        </Button>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------- tester

function Tester({ rules }: { rules: PolicyRule[] }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)), [agents])
  const [agentId, setAgentId] = useState('')
  const [skill, setSkill] = useState('shell-confirm')
  const a = agents[agentId] ?? list[0]
  const d = a && skill.trim() ? resolvePolicy(rules, { agentId: a.id, swarmId: a.swarm_id }, skill.trim()) : null
  const from =
    !d || !a
      ? ''
      : d.source === 'human-only'
        ? 'Human-only: no rule can open it'
        : d.source === 'default'
          ? 'Default policy'
          : d.source === 'unlisted'
            ? 'Not in the defaults; the UI assumes ask'
            : d.source === 'hive'
              ? `Hive rule ${d.rule!.skill}`
              : d.source === 'swarm'
                ? `${swarms[a.swarm_id!]?.name ?? 'Swarm'} rule ${d.rule!.skill}`
                : `${shown(a.name)}'s rule ${d.rule!.skill}`
  return (
    <Card title="Try it" icon="sparkles" tour="policy-try">
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <select aria-label="Mind" value={a?.id ?? ''} onChange={(e) => setAgentId(e.target.value)} className={selectCls} style={{ backgroundImage: chevronBg }}>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {shown(x.name)}
            </option>
          ))}
        </select>
        <input
          aria-label="Skill"
          value={skill}
          onChange={(e) => setSkill(e.target.value.replace(/\s/g, ''))}
          list="known-skills"
          autoCapitalize="off"
          spellCheck={false}
          className="min-h-11 w-full min-w-0 rounded-xl border border-line bg-shade/30 px-3 font-mono text-[14px] text-ink outline-none focus:border-line-2"
        />
        <datalist id="known-skills">
          {KNOWN.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {d && (
          <m.div key={`${d.mode}${from}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex items-center gap-2.5 rounded-xl border border-line bg-shade/20 px-3 py-2.5">
            <ModeChip mode={d.mode} />
            <span className="min-w-0 text-[12px] leading-snug text-ink-3">
              {from}
              {d.rule?.note && <span className="block truncate text-ink-4">“{d.rule.note}”</span>}
            </span>
          </m.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

// ---------------------------------------------------------------- help

function Help() {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-[20px] border border-line bg-tint/[0.025]" aria-label="How the gate decides">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-12 w-full items-center gap-2 px-4 text-left">
        <Icon name="info" size={15} className="text-ink-3" />
        <span className="eyebrow flex-1">How the gate decides</span>
        <Icon name="chevronDown" size={16} className={cx('text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      <div className="px-4 pb-4">
        <ol className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2" aria-label="Precedence">
          {['Human-only', 'Mind', 'Swarm', 'Hive', 'Defaults'].map((x, i) => (
            <li key={x} className="flex items-center gap-1.5">
              {i > 0 && <Icon name="chevron" size={12} className="text-ink-4" />}
              <span className={cx('rounded-md border px-1.5 py-0.5', i === 0 ? 'border-bad/30 bg-bad/10 text-bad' : 'border-line bg-tint/[0.04]')}>{x}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">The most specific scope with a matching rule wins. With no match, the defaults apply.</p>
        <AnimatePresence initial={false}>
          {open && (
            <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <ul className="mt-3 space-y-3">
                {DEFAULT_POLICY.map((d) => (
                  <li key={d.mode} className="rounded-xl border border-line bg-shade/20 p-3">
                    <div className="flex items-center gap-2">
                      <ModeChip mode={d.mode} />
                      <span className="text-[12px] text-ink-3">{d.why}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.skills.map((s) => (
                        <code key={s} className="rounded border border-line bg-tint/[0.04] px-1 py-px font-mono text-meta text-ink-2">
                          {s}
                        </code>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
                “Ask” pauses the mind on that command and raises an approval here. An approval lets the same command run once.
              </p>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}
