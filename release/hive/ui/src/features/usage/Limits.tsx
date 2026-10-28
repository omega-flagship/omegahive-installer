import { useState, type FormEvent } from 'react'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { money } from '../../lib/format'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Meter, Skeleton } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { shown } from '../../lib/displayName'

export interface BudgetRow {
  id: string
  scope: string
  period: 'day' | 'month' | 'total'
  limit_usd: number
  spent_usd: number
  note: string
  origin: 'rule' | 'default'
}

const PERIOD: Record<BudgetRow['period'], string> = { day: 'per day', month: 'per month', total: 'in total' }

/** Spending limits at every level, with what has been spent against each. Checked before every paid call. */
export function Limits() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const keys = useHive((s) => s.keys)
  const toast = useHive((s) => s.toast)
  const [adding, setAdding] = useState(false)
  // a failed load is an error with a retry, never "no limits"
  const res = useResource(() => need(client, 'listBudgets', 'Spending limits')(), {})
  const canSet = has(client, 'setBudget')
  const canRemove = has(client, 'removeBudget')

  const name = (scope: string) => {
    const [kind, id] = scope.split(/:(.*)/s)
    if (kind === 'hive') return { kind: 'Whole hive', label: 'Every mind', hue: 252 }
    if (kind === 'swarm') return { kind: 'Swarm', label: swarms[id]?.name ?? id, hue: swarms[id]?.hue ?? 200 }
    if (kind === 'agent') return { kind: 'Mind', label: agents[id]?.name ?? id, hue: agents[id]?.hue ?? 280 }
    const k = keys?.find((x) => x.id === id)
    return { kind: 'Key', label: k ? `${k.label} ${k.hint}` : id, hue: 262 }
  }

  const save = async (scope: string, period: string, limit: number) => {
    try {
      await need(client, 'setBudget', 'Setting limits')({ scope, period, limit_usd: limit })
      res.reload()
      toast({ tone: 'success', icon: 'coin', title: 'Limit saved', body: `${name(scope).label}: ${money(limit)} ${PERIOD[period as BudgetRow['period']]}` })
    } catch (e) {
      toast(actionFailure(e, 'Could not save the limit'))
    }
  }
  const remove = async (row: BudgetRow) => {
    const who = name(row.scope)
    const ok = await askConfirm(
      `Remove the ${money(row.limit_usd)} ${PERIOD[row.period]} limit on ${who.label}?${row.scope.startsWith('swarm:') ? ' The swarm falls back to the default monthly limit.' : ' Nothing will cap this spending except other limits that apply.'}`,
      'Remove limit',
      { danger: true },
    )
    if (!ok) return
    try {
      await need(client, 'removeBudget', 'Removing limits')(row.id)
      res.reload()
      toast({ tone: 'success', icon: 'coin', title: 'Limit removed', body: `${who.label}: ${money(row.limit_usd)} ${PERIOD[row.period]}` })
    } catch (e) {
      toast(actionFailure(e, 'Could not remove the limit'))
    }
  }

  return (
    <section aria-labelledby="limits-h" className="mb-6 rounded-[20px] border border-line bg-white/[0.025] p-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="limits-h" className="eyebrow">Spending limits</h2>
          <p className="mt-1 text-[12px] text-ink-3">Checked before every paid call, at every level that applies. Each swarm gets $500 a month unless you set its own.</p>
        </div>
        {!adding && canSet && res.status !== 'error' && res.status !== 'unsupported' && (
          <Button variant="subtle" icon="plus" onClick={() => setAdding(true)} className="shrink-0">
            Add a limit
          </Button>
        )}
      </div>
      {adding && <AddLimit onSave={async (s, p, l) => (await save(s, p, l), setAdding(false))} onCancel={() => setAdding(false)} />}
      <ResourceView
        res={res}
        loading={<Skeleton className="h-24" />}
        errorTitle="Could not load spending limits"
        forbidden={{ icon: 'shield', title: 'Admins only', body: 'Only admins can see and set spending limits.' }}
        unsupported={{ body: 'This hive or the demo does not offer spending limits.' }}
        empty={{ icon: 'coin', title: 'No limits yet', body: 'Only the default of $500 a month per swarm applies.' }}
      >
        {(rows) => (
          <div className="divide-y divide-line">
            {rows.map((row) => (
              <LimitRow key={row.id} row={row} who={name(row.scope)} onSave={canSet ? (l) => save(row.scope, row.period, l) : undefined} onRemove={row.origin === 'rule' && canRemove ? () => remove(row) : undefined} />
            ))}
          </div>
        )}
      </ResourceView>
      <ConfirmHost />
    </section>
  )
}

/**
 * j0-fixes r1 (J0 live): the editor showed the raw float ("3.914502…"). It shows dollars and cents; saving the shown
 * figure unchanged changes nothing (the rounding alone never moves a limit). Returns the amount to save, or null.
 */
export const limitDraft = (usd: number): string => (Number.isFinite(usd) ? usd.toFixed(2) : '')
export function limitToSave(draft: string, current: number): number | null {
  if (draft.trim() === limitDraft(current)) return null
  const n = Number(draft)
  return draft.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

function LimitRow({ row, who, onSave, onRemove }: { row: BudgetRow; who: { kind: string; label: string; hue: number }; onSave?: (limit: number) => void; onRemove?: () => void }) {
  const [edit, setEdit] = useState(false)
  const [value, setValue] = useState(() => limitDraft(row.limit_usd))
  const pct = row.limit_usd > 0 ? row.spent_usd / row.limit_usd : 1
  return (
    <div className="py-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="size-2 rounded-full" style={{ background: hsl(who.hue, 90, 68) }} />
        <span className="text-[11px] text-ink-4">{who.kind}</span>
        <span className="text-[13.5px] text-ink">{who.label}</span>
        {row.origin === 'default' && <span className="rounded-full border border-line px-1.5 text-[10px] text-ink-3">default</span>}
        <span className="flex-1" />
        {edit ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              const n = limitToSave(value, row.limit_usd)
              if (n !== null) onSave?.(n)
              setEdit(false)
            }}
          >
            <span className="text-ink-3">$</span>
            <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Limit in dollars" className="w-20 rounded-lg border border-line-2 bg-black/30 px-2 py-1 font-mono text-[13px] text-ink outline-none" />
            <Button type="submit" variant="subtle" className="min-h-8 px-2.5 text-[12px]">
              Save
            </Button>
          </form>
        ) : (
          <button onClick={() => (setValue(limitDraft(row.limit_usd)), setEdit(true))} disabled={!onSave} className="font-mono text-[12.5px] text-ink-2 enabled:hover:text-ink" title={onSave ? 'Change the limit' : undefined}>
            <span className={cx(pct > 0.9 && 'text-bad', pct > 0.7 && pct <= 0.9 && 'text-warn')}>{money(row.spent_usd)}</span> / {money(row.limit_usd)} {PERIOD[row.period]}
          </button>
        )}
        {onRemove && !edit && (
          <button onClick={onRemove} aria-label="Remove this limit" className="flex size-7 items-center justify-center rounded-lg text-ink-4 hover:bg-white/[0.06] hover:text-ink">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <Meter value={row.spent_usd} max={row.limit_usd || 0.000001} hue={who.hue} label={`${who.label} spend against its limit`} />
    </div>
  )
}

function AddLimit({ onSave, onCancel }: { onSave: (scope: string, period: string, limit: number) => void; onCancel: () => void }) {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const keys = useHive((s) => s.keys)
  const [scope, setScope] = useState('hive')
  const [period, setPeriod] = useState('month')
  const [limit, setLimit] = useState('50')
  const selectCls = 'min-h-10 rounded-xl border border-line bg-black/25 px-2.5 text-[13px] text-ink outline-none'
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const n = Number(limit)
        if (Number.isFinite(n) && n >= 0) onSave(scope, period, n)
      }}
      className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-black/20 p-3"
    >
      <select aria-label="Applies to" value={scope} onChange={(e) => setScope(e.target.value)} className={selectCls}>
        <option value="hive">Whole hive</option>
        {Object.values(swarms).map((s) => (
          <option key={s.id} value={`swarm:${s.id}`}>Swarm · {shown(s.name)}</option>
        ))}
        {Object.values(agents).map((a) => (
          <option key={a.id} value={`agent:${a.id}`}>Mind · {shown(a.name)}</option>
        ))}
        {(keys ?? []).map((k) => (
          <option key={k.id} value={`key:${k.id}`}>Key · {k.label} {k.hint}</option>
        ))}
      </select>
      <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} className={selectCls}>
        <option value="day">per day</option>
        <option value="month">per month</option>
        <option value="total">in total</option>
      </select>
      <div className="flex min-h-10 items-center rounded-xl border border-line bg-black/25 px-2.5">
        <span className="text-ink-3">$</span>
        <input inputMode="decimal" aria-label="Limit in dollars" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ''))} className="w-20 bg-transparent px-1 font-mono text-[13px] text-ink outline-none" />
      </div>
      <div className="flex-1" />
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" hue={38}>
        Save limit
      </Button>
    </form>
  )
}
