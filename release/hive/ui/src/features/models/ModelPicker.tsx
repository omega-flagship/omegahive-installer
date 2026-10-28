import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { AgentOptions, ModelEndpoint, RouteSort } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Segmented, Skeleton, Switch } from '../../ui/primitives'
import { ProviderConnect } from './ProviderConnect'
import { buildRows, contextLabel, priceLabel, providerLabel, searchRows, type PickRow } from './modelUtil'
import { shown } from '../../lib/displayName'

const PAGE = 40

/**
 * Pick a model for a mind: every connected provider's models in one searchable list, with prices
 * and context from the OpenRouter catalogue, a way to connect a provider in place, and, for
 * OpenRouter models, which upstream should serve it.
 */
export function ModelPicker({
  value,
  options,
  onChange,
  hue = 252,
  autoFocus,
}: {
  value: string
  options?: AgentOptions
  onChange: (model: string, options: AgentOptions) => void
  hue?: number
  autoFocus?: boolean
}) {
  const models = useHive((s) => s.models)
  const providers = useHive((s) => s.providers)
  const catalog = useHive((s) => s.catalog)
  const catalogState = useHive((s) => s.catalogState)
  const catalogError = useHive((s) => s.catalogError)
  const loadCatalog = useHive((s) => s.loadCatalog)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [connecting, setConnecting] = useState<string | null>(null)

  const openrouter = providers?.find((p) => p.name === 'openrouter')
  useEffect(() => {
    if (openrouter?.connected && !catalog && catalogState === 'idle') void loadCatalog()
  }, [openrouter?.connected, catalog, catalogState, loadCatalog])

  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const results = useMemo(() => searchRows(rows, query, filter), [rows, query, filter])
  const selected = rows.find((r) => r.id === value)
  const selectedHidden = selected && !results.slice(0, limit).some((r) => r.id === value)

  const chips = useMemo(() => {
    const names = new Set<string>(rows.map((r) => r.provider))
    for (const p of providers ?? []) names.add(p.name)
    const order = ['openrouter', 'anthropic', 'openai', 'local', 'ollama', 'mock']
    return [...names]
      .sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
      .map((name) => {
        const p = providers?.find((x) => x.name === name)
        const count = rows.filter((r) => r.provider === name).length
        return { name, label: providerLabel(name, providers), connected: p ? p.connected : count > 0, needsKey: p?.needs_key ?? false, count }
      })
  }, [rows, providers])

  const pick = (row: PickRow) => {
    // routing only means something for OpenRouter; a key only for its own provider
    const sameProvider = value.split('/')[0] === row.provider
    const next: AgentOptions = {}
    if (row.provider === 'openrouter' && options?.route) next.route = options.route
    if (sameProvider && options?.key) next.key = options.key
    onChange(row.id, next)
  }

  return (
    <div className="space-y-3">
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="radiogroup" aria-label="Provider">
        <Chip on={filter === null} hue={hue} onClick={() => (setFilter(null), setLimit(PAGE))} label="All" />
        {chips.map((c) => (
          <Chip
            key={c.name}
            on={filter === c.name}
            hue={hue}
            dim={!c.connected}
            onClick={() => {
              if (!c.connected && c.needsKey) {
                setConnecting(connecting === c.name ? null : c.name)
                return
              }
              setFilter(filter === c.name ? null : c.name)
              setLimit(PAGE)
            }}
            label={c.label}
            count={c.connected ? c.count : undefined}
            lead={<span className={cx('size-1.5 rounded-full', c.connected ? 'bg-good' : 'bg-ink-4')} style={c.connected ? { boxShadow: '0 0 6px #4ade80' } : undefined} />}
            trail={!c.connected && c.needsKey ? <Icon name="plus" size={12} className="text-ink-4" /> : undefined}
          />
        ))}
      </div>

      <AnimatePresence initial={false}>
        {connecting && providers?.find((p) => p.name === connecting) && (
          <m.div key={connecting} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <ProviderConnect provider={providers.find((p) => p.name === connecting)!} hue={hue} autoFocus compact onDone={(p) => (setConnecting(null), setFilter(p.name))} />
          </m.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-black/25 px-3 focus-within:border-line-2">
        <Icon name="search" size={16} className="shrink-0 text-ink-4" />
        <input
          value={query}
          onChange={(e) => (setQuery(e.target.value), setLimit(PAGE))}
          placeholder={openrouter?.connected ? 'Search models… try "sonnet", "free", "vision", "cheap tools"' : 'Search models…'}
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
          data-autofocus={autoFocus ? '' : undefined}
          className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear search" className="flex size-7 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink">
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {openrouter && !openrouter.connected && !connecting && (
        <button onClick={() => setConnecting('openrouter')} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 text-left text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:bg-white/[0.03]">
          <Icon name="link" size={16} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">
            <span className="block">Connect OpenRouter</span>
            <span className="block text-[11.5px] text-ink-4">One key, every major model, with prices and provider choice.</span>
          </span>
          <Icon name="chevron" size={14} className="text-ink-4" />
        </button>
      )}

      {catalogState === 'loading' && !catalog && (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {catalogError && (
        <div className="flex items-center gap-2 rounded-xl border border-warn/25 bg-warn/[0.06] px-3 py-2 text-[12px] text-warn">
          <Icon name="alert" size={14} />
          <span className="min-w-0 flex-1">{catalogError}</span>
          <Button variant="ghost" className="min-h-8 px-2 text-[12px]" onClick={() => void loadCatalog(true)}>
            Retry
          </Button>
        </div>
      )}

      {selectedHidden && selected && (
        <div className="flex items-center gap-2 text-[12px] text-ink-3">
          <Icon name="check" size={13} />
          <span className="min-w-0 truncate">
            Selected: <span className="text-ink">{shown(selected.name)}</span>
          </span>
          <button onClick={() => (setQuery(''), setFilter(null))} className="shrink-0 text-ink-3 underline-offset-2 hover:text-ink hover:underline">
            Show
          </button>
        </div>
      )}

      <div role="radiogroup" aria-label="Model" className="overflow-hidden rounded-xl border border-line">
        {results.length === 0 && (
          <div className="px-3 py-6 text-center text-[13px] text-ink-3">{rows.length ? 'Nothing matches.' : 'No models yet. Connect a provider above.'}</div>
        )}
        {results.slice(0, limit).map((row, i) => {
          const on = row.id === value
          return (
            <div key={row.id} className={cx(i > 0 && 'border-t border-line')}>
              <button
                role="radio"
                aria-checked={on}
                onClick={() => pick(row)}
                className={cx('flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors', on ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]')}
              >
                <Radio on={on} hue={hue} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] text-ink">{shown(row.name)}</span>
                    {row.featured && row.provider === 'openrouter' && <Icon name="spark" size={12} className="shrink-0 text-ink-4" aria-label="featured" />}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-4">
                    <span className="truncate font-mono">{row.id}</span>
                    {row.context > 0 && <span className="shrink-0">· {contextLabel(row.context)}</span>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cx('font-mono text-[11px] tabular-nums', row.inPerM === 0 && row.outPerM === 0 ? 'text-good' : 'text-ink-2')}>{priceLabel(row.inPerM, row.outPerM)}</span>
                  <span className="flex gap-1">
                    {row.local && <Badge tone="good">local</Badge>}
                    {row.inputs.includes('image') && <Badge>vision</Badge>}
                    {row.reasoning && <Badge>reasoning</Badge>}
                    {!row.tools && !row.local && row.provider === 'openrouter' && <Badge tone="warn">no tools</Badge>}
                  </span>
                </span>
              </button>
              <AnimatePresence initial={false}>
                {on && row.provider === 'openrouter' && (
                  <m.div key="route" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <RouteEditor modelId={row.short} options={options ?? {}} hue={hue} onChange={(o) => onChange(row.id, options?.key ? { ...o, key: options.key } : o)} />
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
        {results.length > limit && (
          <button onClick={() => setLimit(limit + PAGE * 2)} className="flex min-h-11 w-full items-center justify-center gap-1.5 border-t border-line text-[12.5px] text-ink-3 hover:bg-white/[0.04] hover:text-ink">
            Show {Math.min(PAGE * 2, results.length - limit)} more of {results.length}
            <Icon name="chevron" size={13} className="rotate-90" />
          </button>
        )}
      </div>

      {openrouter?.connected && catalog && (
        <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-ink-4">
          <span>
            {catalog.models.length} OpenRouter models · prices {ago(new Date(catalog.fetched_at * 1000).toISOString())}
          </span>
          <button onClick={() => void loadCatalog(true)} disabled={catalogState === 'loading'} className="inline-flex items-center gap-1 text-ink-3 hover:text-ink disabled:opacity-50">
            <Icon name="reset" size={12} className={cx(catalogState === 'loading' && 'animate-spin-slow')} /> Refresh
          </button>
        </div>
      )}
    </div>
  )
}

const SORTS: { value: RouteSort | 'auto'; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'price', label: 'Cheapest' },
  { value: 'throughput', label: 'Fastest' },
  { value: 'latency', label: 'Snappiest' },
]

/** Which upstream(s) OpenRouter should use for this model: an ordered preference, with or without fallbacks. */
function RouteEditor({ modelId, options, hue, onChange }: { modelId: string; options: AgentOptions; hue: number; onChange: (o: AgentOptions) => void }) {
  const endpoints = useHive((s) => s.endpoints[modelId])
  const loading = useHive((s) => !!s.endpointsLoading[modelId])
  const loadEndpoints = useHive((s) => s.loadEndpoints)
  useEffect(() => {
    if (!endpoints) void loadEndpoints(modelId)
  }, [modelId, endpoints, loadEndpoints])

  const route = options.route ?? {}
  const order = route.order ?? []
  const fallbacks = route.allow_fallbacks !== false
  const set = (next: NonNullable<AgentOptions['route']>) => {
    const clean: NonNullable<AgentOptions['route']> = {}
    if (next.order?.length) clean.order = next.order
    if (next.allow_fallbacks === false) clean.allow_fallbacks = false
    if (next.sort) clean.sort = next.sort
    onChange(Object.keys(clean).length ? { route: clean } : {})
  }
  const toggle = (e: ModelEndpoint) => {
    const next = order.includes(e.tag) ? order.filter((t) => t !== e.tag) : [...order, e.tag]
    set({ ...route, order: next })
  }

  return (
    <div className="border-t border-line bg-black/20 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="eyebrow">Served by</span>
        {order.length > 0 && (
          <button onClick={() => set({ sort: route.sort })} className="text-[11px] text-ink-3 hover:text-ink">
            Let OpenRouter pick
          </button>
        )}
      </div>
      {loading && !endpoints && (
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>
      )}
      {endpoints && endpoints.length === 0 && <div className="text-[12px] text-ink-3">OpenRouter lists no upstream for this model right now.</div>}
      {endpoints && endpoints.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preferred providers, in order">
          {endpoints.map((e) => {
            const idx = order.indexOf(e.tag)
            const on = idx >= 0
            return (
              <button
                key={e.tag}
                onClick={() => toggle(e)}
                aria-pressed={on}
                title={`${e.name}${e.uptime != null ? ` · ${e.uptime.toFixed(1)}% up` : ''}${e.latency_ms != null ? ` · ${Math.round(e.latency_ms)} ms` : ''}`}
                className={cx('flex min-h-9 items-center gap-2 rounded-xl border px-2.5 text-left transition-all', on ? 'bg-white/[0.08]' : 'border-line bg-white/[0.02] hover:border-line-2')}
                style={on ? { borderColor: hsl(hue, 90, 70, 0.55), boxShadow: `0 0 0 1px ${hsl(hue, 90, 70, 0.25)} inset` } : undefined}
              >
                {on && (
                  <span className="flex size-4 items-center justify-center rounded-full font-mono text-[10px] font-bold text-[#0b0820]" style={{ background: hsl(hue, 100, 78) }}>
                    {idx + 1}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-ink">{e.provider || e.tag}</span>
                  <span className="block font-mono text-[10.5px] text-ink-4">
                    {priceLabel(e.in_per_m, e.out_per_m)}
                    {e.context_length ? ` · ${contextLabel(e.context_length)}` : ''}
                    {e.uptime != null ? ` · ${Math.round(e.uptime)}%` : ''}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {order.length > 0 ? (
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <Switch checked={fallbacks} onChange={(v) => set({ ...route, allow_fallbacks: v })} label="Allow other providers if these fail" hue={hue} />
            Fall back to others if {order.length === 1 ? 'it fails' : 'they fail'}
          </label>
        ) : (
          <Segmented value={route.sort ?? 'auto'} options={SORTS} onChange={(v) => set({ ...route, sort: v === 'auto' ? undefined : v })} label="Provider preference" dense className="max-w-full" />
        )}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-4">
        {order.length ? `Requests go to ${order.join(', then ')}${fallbacks ? ', then anyone else' : ' and nowhere else'}.` : 'OpenRouter balances across providers; pick one or more above to pin it.'}
      </p>
    </div>
  )
}

function Chip({ on, hue, dim, onClick, label, count, lead, trail }: { on: boolean; hue: number; dim?: boolean; onClick: () => void; label: string; count?: number; lead?: React.ReactNode; trail?: React.ReactNode }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cx('flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors', on ? 'text-ink' : dim ? 'border-line text-ink-4 hover:text-ink-2' : 'border-line bg-white/[0.03] text-ink-2 hover:border-line-2 hover:text-ink')}
      style={on ? { borderColor: hsl(hue, 90, 70, 0.6), background: hsl(hue, 90, 60, 0.14) } : undefined}
    >
      {lead}
      {label}
      {count != null && <span className="font-mono text-[10.5px] text-ink-4">{count}</span>}
      {trail}
    </button>
  )
}

function Radio({ on, hue }: { on: boolean; hue: number }) {
  return (
    <span className={cx('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-transparent' : 'border-line-2')} style={on ? { background: hsl(hue, 100, 75), boxShadow: `0 0 10px ${hsl(hue, 100, 65, 0.7)}` } : undefined}>
      {on && <span className="size-1.5 rounded-full bg-[#0b0820]" />}
    </span>
  )
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <span className={cx('rounded-md border px-1.5 py-px text-[10px] leading-4', tone === 'good' ? 'border-good/30 bg-good/10 text-good' : tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-line bg-white/[0.04] text-ink-3')}>{children}</span>
  )
}
