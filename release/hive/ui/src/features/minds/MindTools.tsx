import { useState } from 'react'
import type { Agent } from '../../api/types'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { ModeChip, Segmented, Skeleton } from '../../ui/primitives'
import { availabilityWords, countSkills, filterSkills, SKILL_STATUS_WORDS, type SkillView } from './logic'
import type { InventorySkill, MindActivity, MindInventory } from './types'

const TONE = { good: 'border-good/30 bg-good/[0.06] text-good', warn: 'border-warn/35 bg-warn/[0.07] text-warn', muted: 'border-line bg-white/[0.03] text-ink-3' }
const HEALTH_TONE: Record<string, string> = { high: 'text-bad', medium: 'text-warn', low: 'text-ink-2', ok: 'text-good' }
const HEALTH_WORD: Record<string, string> = { high: 'needs attention', medium: 'has errors', low: 'has minor issues', ok: 'is healthy' }

/**
 * What this mind can call, as its last boot receipt says (S4), how often it actually reasoned and wrote beliefs,
 * and its health. Read-only: changing what a mind may do is a policy rule (Decisions → Rules).
 */
export function MindTools({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const inv = useResource(() => need(client, 'agentInventory', 'Tool inventory')(agent.id), { context: agent.id, key: agent.status, isEmpty: () => false })
  if (!has(client, 'agentInventory') || inv.status === 'unsupported') return null
  const name = shown(agent.name)
  return (
    <section aria-labelledby="tools-h" data-tour="mind-tools">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 id="tools-h" className="eyebrow">
          Tools
        </h3>
        <MindHealthLine agent={agent} />
      </div>
      {inv.status === 'loading' ? (
        <div className="space-y-1.5">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : inv.status === 'error' ? (
        <p className="text-[13px] text-bad">
          {inv.error && (inv.error as { status?: number }).status === 403 ? `Only ${name}'s owner or an admin can see its tools.` : `Could not read ${name}'s tools: ${errorMessage(inv.error)}`}{' '}
          <button className="underline" onClick={inv.reload}>
            Try again
          </button>
        </p>
      ) : inv.data ? (
        <Inventory inv={inv.data} name={name} />
      ) : null}
      <Activity agent={agent} />
    </section>
  )
}

function MindHealthLine({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'agentHealth', 'Health')(agent.id), { context: agent.id, key: agent.status, isEmpty: () => false, poll: 30_000 })
  if (res.status !== 'ready' || !res.data) return null
  const h = res.data
  const open = h.issues.filter((i) => i.recent).length
  return (
    <button onClick={() => navigate({ name: 'health' })} className={cx('text-meta hover:underline', HEALTH_TONE[h.health] ?? 'text-ink-3')}>
      {shown(agent.name)} {HEALTH_WORD[h.health] ?? h.health}
      {open > 0 && ` · ${open} recent`}
    </button>
  )
}

function Inventory({ inv, name }: { inv: MindInventory; name: string }) {
  const counts = countSkills(inv.skills)
  const [view, setView] = useState<SkillView>(counts.callable ? 'callable' : 'all')
  const [q, setQ] = useState('')
  const trust = availabilityWords(inv)
  const list = filterSkills(inv.skills, view, q)
  return (
    <div className="space-y-2.5">
      <div className={cx('rounded-xl border px-3 py-2 text-[12.5px] leading-snug', TONE[trust.tone])}>
        <span className="font-semibold">{trust.title}.</span> <span className="text-ink-2">{trust.body}</span>
        {inv.loaded_at && <span className="text-ink-4"> Sent {ago(inv.loaded_at)}{inv.inventory_revision ? ` · ${inv.inventory_revision}` : ''}.</span>}
      </div>

      {inv.skills.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<SkillView>
              label={`Which of ${name}'s tools to show`}
              dense
              value={view}
              onChange={setView}
              options={[
                { value: 'callable', label: `Callable ${counts.callable}` },
                { value: 'not-callable', label: `Not callable ${inv.skills.length - counts.callable}` },
                { value: 'all', label: `All ${inv.skills.length}` },
              ]}
            />
            <label className="flex min-h-9 min-w-[140px] flex-1 items-center gap-1.5 rounded-lg border border-line bg-black/25 px-2.5 focus-within:border-line-2">
              <Icon name="search" size={14} className="text-ink-4" />
              <span className="sr-only">Find a tool</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a tool" className="w-full bg-transparent text-[12.5px] text-ink outline-none" />
            </label>
          </div>
          <ul className="overflow-hidden rounded-xl border border-line bg-black/20">
            {list.length === 0 && <li className="px-3 py-3 text-center text-[12.5px] text-ink-4">No tools match.</li>}
            {list.map((s, i) => (
              <SkillRow key={`${s.module}:${s.id}`} skill={s} first={i === 0} />
            ))}
          </ul>
        </>
      )}

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-ink-4">Model</dt>
        <dd className="text-ink-2 [overflow-wrap:anywhere]">
          {inv.provider.model}
          {inv.provider.resolved_model && inv.provider.resolved_model !== inv.provider.model && <span className="text-ink-4"> (answers as {inv.provider.resolved_model})</span>}
        </dd>
        <dt className="text-ink-4">Who pays</dt>
        <dd className="text-ink-2">{inv.provider.payer_kind === 'hive' ? 'the hive' : inv.provider.payer_kind.replace(/-/g, ' ')}</dd>
        <dt className="text-ink-4">Counts against</dt>
        <dd className="text-ink-2 [overflow-wrap:anywhere]">
          {inv.provider.budget_route.join(' → ')}
          {inv.provider.budget_route_note && <span className="text-ink-4"> ({inv.provider.budget_route_note})</span>}
        </dd>
        {inv.modules.length > 0 && (
          <>
            <dt className="text-ink-4">Modules</dt>
            <dd className="text-ink-2">
              {inv.modules.map((mod, i) => (
                <span key={mod.id}>
                  {i > 0 && ', '}
                  {mod.id}
                  {mod.version ? ` ${mod.version}` : ''}
                  <span className="text-ink-4"> ({mod.loaded ? 'loaded' : mod.configured ? 'set up, not loaded' : 'not set up'}{mod.loaded && !mod.source_verified ? ', source not verified' : ''})</span>
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

const STATUS_CHIP: Record<InventorySkill['status'], string> = {
  callable: 'border-good/30 text-good',
  imported: 'border-line-2 text-ink-2',
  configured: 'border-line text-ink-3',
  unknown: 'border-line text-ink-4',
}

function SkillRow({ skill: s, first }: { skill: InventorySkill; first: boolean }) {
  const decision = s.policy.decision
  return (
    <li className={cx('flex items-start gap-2 px-3 py-1.5 text-[12.5px]', !first && 'border-t border-line')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-mono text-ink">{s.id}</span>
          {s.module && s.module !== 'core' && <span className="text-meta text-ink-4">{s.module}</span>}
        </div>
        {s.help && <div className="text-meta text-ink-3">{s.help}</div>}
        {s.route.note && <div className="text-meta text-ink-4">{s.route.note}</div>}
      </div>
      <span title={SKILL_STATUS_WORDS[s.status]} className={cx('shrink-0 rounded-full border px-1.5 py-px text-[10.5px]', STATUS_CHIP[s.status])}>
        {s.status}
      </span>
      <span title={s.policy.reason ?? undefined} className="shrink-0">
        <ModeChip mode={decision} />
      </span>
    </li>
  )
}

const REASONING: [keyof MindActivity['reasoning'], string][] = [
  ['nal', 'NAL'],
  ['pln', 'PLN'],
  ['nars', 'NARS'],
  ['metta', 'MeTTa'],
]

function Activity({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'agentInventoryActivity', 'Activity')(agent.id, 30), { context: agent.id, isEmpty: () => false })
  if (res.status !== 'ready' || !res.data) return null
  const a = res.data
  if (!a.cycles_observed) return <p className="mt-2 text-meta text-ink-4">No thinking cycles recorded yet, so there is nothing to count.</p>
  return (
    <div className="mt-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-medium text-ink-2">Last {a.cycles_observed} thinking cycles</span>
        {a.dormant && <span className="text-warn">reasoned nothing</span>}
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-6">
        {REASONING.map(([k, label]) => (
          <Count key={k} label={label} c={a.reasoning[k]} />
        ))}
        <Count label="Own beliefs" c={a.belief_writes.mind} />
        <Count label="Commons" c={a.belief_writes.commons} />
      </div>
      <p className="mt-1.5 text-meta text-ink-4">Counted from {a.basis}. “ran / tried”.</p>
    </div>
  )
}

function Count({ label, c }: { label: string; c: { attempted: number; ran: number } }) {
  return (
    <div>
      <div className="text-meta text-ink-4">{label}</div>
      <div className={cx('font-mono', c.ran ? 'text-ink' : 'text-ink-4')}>
        {c.ran}
        <span className="text-ink-4">/{c.attempted}</span>
      </div>
    </div>
  )
}
