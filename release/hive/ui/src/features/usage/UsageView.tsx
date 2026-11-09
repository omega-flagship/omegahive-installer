import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Usage } from '../../api/types'
import { compact, modelLabel, money } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { EmptyState, ErrorState, Orb, Segmented, Skeleton } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { Page } from '../../ui/Page'
import { Limits } from './Limits'
import { MySpend } from './MySpend'
import { SettleCalls } from './SettleCalls'
import { SimChip } from '../../ui/SimChip'
import { SIM_COST_NOTE, useSim } from '../../lib/sim'

/**
 * Categorical slots: the dataviz reference palette's dark steps, validated with
 * validate_palette.js against this view's surface (#12132a): all checks pass.
 * Slots are assigned by all-time spend so colour follows the entity, never the filter.
 */
const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9']
const OTHER = '#5f5e7c'
const BAR = '#3987e5'
const SURFACE = '#0d0d26'

type Range = '24h' | '7d' | '30d'
type Group = 'agent' | 'model'

const RANGE: Record<Range, { ms: number; bucket: number; label: string }> = {
  '24h': { ms: 86_400_000, bucket: 3_600_000, label: 'last 24 hours' },
  '7d': { ms: 7 * 86_400_000, bucket: 86_400_000, label: 'last 7 days' },
  '30d': { ms: 30 * 86_400_000, bucket: 86_400_000, label: 'last 30 days' },
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceMax(v: number): { max: number; ticks: number[] } {
  if (v <= 0) return { max: 1, ticks: [0, 0.5, 1] }
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const steps = [1, 2, 2.5, 5, 10]
  let step = exp
  for (const s of steps) {
    step = (s * exp) / 2
    if (v / step <= 4) break
  }
  const max = Math.ceil(v / step) * step
  const ticks: number[] = []
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t)
  return { max, ticks }
}

const tickMoney = (n: number) => (n === 0 ? '$0' : n < 1 ? `$${n.toFixed(2)}` : n < 10 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`)

export default function UsageView() {
  const client = useHive((s) => s.client)
  const usage = useHive((s) => s.usage)
  const agents = useHive((s) => s.agents)
  const models = useHive((s) => s.models)
  const sim = useSim()
  const [range, setRange] = useState<Range>('7d')
  const [group, setGroup] = useState<Group>('agent')
  const [table, setTable] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(usage.length ? 'ready' : 'loading')
  const [err, setErr] = useState('')
  const now = useNow(30_000)

  useEffect(() => {
    if (!client) return
    const since = new Date(Date.now() - RANGE['30d'].ms).toISOString()
    client.listUsage({ since }).then(
      (list) => {
        useHive.setState((s) => {
          const seen = new Set(list.map((u) => `${u.agent_id}|${u.created_at}|${u.cost_usd}`))
          const live = s.usage.filter((u) => !seen.has(`${u.agent_id}|${u.created_at}|${u.cost_usd}`))
          return { usage: [...list, ...live].sort((a, b) => a.created_at.localeCompare(b.created_at)) }
        })
        setState('ready')
      },
      (e: unknown) => {
        setErr(e instanceof Error ? e.message : 'Could not load usage')
        setState('error')
      },
    )
  }, [client])

  const keyOf = (u: Usage) => (group === 'agent' ? u.agent_id : u.model)
  const nameOf = (k: string) => (group === 'agent' ? (agents[k]?.name ?? k) : (models.find((m) => m.id === k)?.label ?? modelLabel(k)))

  // stable colour slots: by all-time spend for the grouping
  const slotOf = useMemo(() => {
    const tot = new Map<string, number>()
    for (const u of usage) {
      const k = group === 'agent' ? u.agent_id : u.model
      tot.set(k, (tot.get(k) ?? 0) + u.cost_usd)
    }
    const order = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const m = new Map<string, number>()
    order.slice(0, SLOTS.length).forEach((k, i) => m.set(k, i))
    return m
  }, [usage, group])

  const data = useMemo(() => {
    const { ms, bucket } = RANGE[range]
    const end = Math.ceil(now / bucket) * bucket
    const start = end - ms
    const prevStart = start - ms
    const n = Math.round(ms / bucket)
    const series = [...slotOf.keys()]
    const cols = Array.from({ length: n }, (_, i) => ({ t: start + i * bucket, v: new Map<string, number>(), total: 0 }))
    const byEntity = new Map<string, { cost: number; req: number; pt: number; ct: number }>()
    let cost = 0
    let req = 0
    let tokens = 0
    let prevCost = 0
    let prevReq = 0
    let prevTokens = 0
    for (const u of usage) {
      const t = Date.parse(u.created_at)
      if (t >= prevStart && t < start) {
        prevCost += u.cost_usd
        prevReq++
        prevTokens += u.prompt_tokens + u.completion_tokens
      }
      if (t < start || t >= end) continue
      const k = keyOf(u)
      const sk = slotOf.has(k) ? k : '__other'
      const col = cols[Math.min(n - 1, Math.floor((t - start) / bucket))]
      col.v.set(sk, (col.v.get(sk) ?? 0) + u.cost_usd)
      col.total += u.cost_usd
      const e = byEntity.get(k) ?? { cost: 0, req: 0, pt: 0, ct: 0 }
      e.cost += u.cost_usd
      e.req++
      e.pt += u.prompt_tokens
      e.ct += u.completion_tokens
      byEntity.set(k, e)
      cost += u.cost_usd
      req++
      tokens += u.prompt_tokens + u.completion_tokens
    }
    const hasOther = cols.some((c) => c.v.has('__other'))
    const entities = [...byEntity.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.cost - a.cost)
    return { cols, series: hasOther ? [...series, '__other'] : series, entities, cost, req, tokens, prevCost, prevReq, prevTokens, bucket }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage, range, group, slotOf, now])

  const colorOf = (k: string) => (k === '__other' ? OTHER : SLOTS[slotOf.get(k) ?? 0])
  const labelOf = (k: string) => (k === '__other' ? 'Other' : nameOf(k))

  return (
    <Page label="Usage" eyebrow="Spend & tokens" title="Usage" onClose={() => navigate({ name: 'hive' })}>
      <div className="px-3 pb-28 md:px-6 md:pb-8">
        <MySpend />
        <SettleCalls />
        <Limits />
        {/* one filter row above everything it scopes */}
        <div className="sticky top-0 z-[2] -mx-3 mb-4 flex flex-wrap items-center gap-2 bg-gradient-to-b from-[#0a0a20] via-[#0a0a20]/95 to-transparent px-3 pt-1 pb-3 md:-mx-6 md:px-6">
          <Segmented<Range>
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
            ]}
          />
          <Segmented<Group>
            label="Group by"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'agent', label: 'Minds' },
              { value: 'model', label: 'Models' },
            ]}
          />
          <button
            onClick={() => setTable(!table)}
            aria-pressed={table}
            aria-label="Show as table"
            className={cx('ml-auto flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-[13px] transition-colors', table ? 'border-line-2 bg-tint/[0.09] text-ink' : 'border-line text-ink-3 hover:text-ink')}
          >
            <Icon name="table" size={16} />
            <span className="hidden sm:inline">Table</span>
          </button>
        </div>

        {state === 'error' ? (
          <ErrorState title="Could not load usage" body={err} />
        ) : state === 'loading' ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
            <Skeleton className="h-72" />
          </div>
        ) : data.req === 0 && data.prevReq === 0 ? (
          <EmptyState icon="chart" title="No usage yet" body={`Nothing was spent in the ${RANGE[range].label}. When minds think, the gateway meters every call here.`} />
        ) : (
          <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            {sim && (
              <p className="flex items-start gap-3 rounded-2xl border border-warn/25 bg-warn/[0.06] px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-3" role="note">
                <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
                  <Icon name="coin" size={14} />
                </span>
                <span>
                  <b className="font-semibold text-warn">Simulated</b> · {SIM_COST_NOTE}
                </span>
              </p>
            )}
            <section className="grid grid-cols-3 gap-2.5 md:grid-cols-4 md:gap-3" aria-label="Key figures">
              <Tile hero money label={`Spend · ${RANGE[range].label}`} value={money(data.cost)} delta={pctDelta(data.cost, data.prevCost)} upIsGood={false} />
              <Tile label="Requests" value={compact(data.req)} delta={pctDelta(data.req, data.prevReq)} />
              <Tile label="Tokens" value={compact(data.tokens)} delta={pctDelta(data.tokens, data.prevTokens)} />
              <Tile money label="Avg / request" value={data.req ? money(data.cost / data.req) : '$0'} />
            </section>

            {table ? (
              <EntityTable rows={data.entities} total={data.cost} name={nameOf} group={group} />
            ) : (
              <>
                <Card money title={`Spend over time, ${group === 'agent' ? 'by mind' : 'by model'}`} subtitle={`Per ${data.bucket >= 86_400_000 ? 'day' : data.bucket >= 6 * 3_600_000 ? '6 hours' : 'hour'}, US dollars`}>
                  <Legend items={data.series.map((k) => ({ k, label: labelOf(k), color: colorOf(k) }))} />
                  <StackedColumns cols={data.cols} series={data.series} colorOf={colorOf} labelOf={labelOf} range={range} />
                </Card>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card money title={group === 'agent' ? 'Spend by mind' : 'Spend by model'} subtitle={`${RANGE[range].label}, US dollars`}>
                    <Bars rows={data.entities.slice(0, 12)} name={nameOf} group={group} />
                  </Card>
                  <Card title="Tokens by kind" subtitle={`Prompt vs completion, ${RANGE[range].label}`}>
                    <TokenSplit rows={data.entities.slice(0, 8)} name={nameOf} />
                  </Card>
                </div>
              </>
            )}
          </m.div>
        )}
      </div>
    </Page>
  )
}

function pctDelta(cur: number, prev: number): number | null {
  if (!prev) return null
  return (cur - prev) / prev
}

function Tile({ label, value, delta, hero, upIsGood = true, money: isMoney }: { label: string; value: string; delta?: number | null; hero?: boolean; upIsGood?: boolean; money?: boolean }) {
  const up = (delta ?? 0) >= 0
  const good = up === upIsGood
  return (
    <div className={cx('rounded-2xl border border-line', hero ? 'col-span-3 p-4 md:col-span-1' : 'p-3 md:p-4')} style={{ background: SURFACE }}>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
        <span className="truncate">{label}</span>
        {isMoney && <SimChip />}
      </div>
      <div className={cx('mt-1 font-sans font-semibold tracking-tight text-ink', hero ? 'text-[44px] leading-none md:text-[48px]' : 'text-xl md:text-2xl')}>{value}</div>
      {delta !== undefined && delta !== null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1 text-[11px] md:text-[12px]">
          <span className={good ? 'text-good' : 'text-[#fda4af]'}>
            <Icon name="chevron" size={12} className={cx('inline', up ? '-rotate-90' : 'rotate-90')} /> {Math.abs(delta * 100).toFixed(0)}%
          </span>
          <span className="text-ink-4">vs previous</span>
        </div>
      )}
    </div>
  )
}

function Card({ title, subtitle, children, money: isMoney }: { title: string; subtitle?: string; children: ReactNode; money?: boolean }) {
  return (
    <figure className="rounded-[20px] border border-line p-4 md:p-5" style={{ background: SURFACE }}>
      <figcaption className="mb-3">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          {title}
          {isMoney && <SimChip label="simulated" />}
        </div>
        {subtitle && <div className="text-[12px] text-ink-3">{subtitle}</div>}
      </figcaption>
      {children}
    </figure>
  )
}

function Legend({ items }: { items: { k: string; label: string; color: string }[] }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2" aria-label="Legend">
      {items.map((it) => (
        <li key={it.k} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  )
}

function StackedColumns({
  cols,
  series,
  colorOf,
  labelOf,
  range,
}: {
  cols: { t: number; v: Map<string, number>; total: number }[]
  series: string[]
  colorOf: (k: string) => string
  labelOf: (k: string) => string
  range: Range
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 220
  const padL = 44
  const padB = 26
  const plotW = Math.max(10, width - padL - 4)
  const plotH = H - padB - 8
  const { max, ticks } = niceMax(Math.max(...cols.map((c) => c.total)))
  const band = plotW / cols.length
  const bw = Math.min(24, Math.max(3, band - Math.max(2, band * 0.3)))
  const y = (v: number) => 8 + plotH - (v / max) * plotH
  const labelEvery = Math.ceil(cols.length / Math.max(2, Math.floor(plotW / 64)))
  const fmtX = (t: number) => {
    const d = new Date(t)
    if (range === '24h') return d.toLocaleTimeString([], { hour: '2-digit' })
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  const h = hover !== null ? cols[hover] : null

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Stacked column chart of spend over time. Use the table toggle for exact values.">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width} y1={y(t)} y2={y(t)} stroke="color-mix(in oklab, var(--color-ink) 7%, transparent)" />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="#8a89b3" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {tickMoney(t)}
              </text>
            </g>
          ))}
          <line x1={padL} x2={width} y1={y(0)} y2={y(0)} stroke="color-mix(in oklab, var(--color-ink) 18%, transparent)" />
          {cols.map((c, i) => {
            const x = padL + i * band + (band - bw) / 2
            let acc = 0
            const present = series.filter((k) => (c.v.get(k) ?? 0) > 0)
            return (
              <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.45} style={{ transition: 'opacity 120ms' }}>
                {present.map((k, si) => {
                  const v = c.v.get(k) ?? 0
                  const y0 = y(acc)
                  acc += v
                  const y1 = y(acc)
                  const top = si === present.length - 1
                  const gap = si > 0 ? 2 : 0
                  const hgt = Math.max(0, y0 - y1 - gap)
                  if (hgt <= 0.2) return null
                  const r = top ? Math.min(4, bw / 2, hgt) : 0
                  const yy = y1
                  const d = `M${x},${yy + hgt} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + hgt} Z`
                  return <path key={k} d={d} fill={colorOf(k)} />
                })}
              </g>
            )
          })}
          {cols.map((c, i) =>
            i % labelEvery === 0 ? (
              <text key={c.t} x={padL + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="#8a89b3">
                {fmtX(c.t)}
              </text>
            ) : null,
          )}
          {/* hit targets: the whole band, larger than the mark */}
          {cols.map((c, i) => (
            <rect
              key={c.t}
              x={padL + i * band}
              y={0}
              width={band}
              height={H - padB}
              fill="transparent"
              tabIndex={0}
              aria-label={`${fmtX(c.t)}: ${money(c.total)}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="outline-none"
            />
          ))}
        </svg>
      )}
      <AnimatePresence>
        {h && hover !== null && (
          <m.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            className="glass-strong pointer-events-none absolute top-0 z-10 min-w-44 rounded-xl px-3 py-2 text-[12px]"
            style={{ left: Math.min(Math.max(0, padL + hover * band + band / 2 - 88), Math.max(0, width - 180)) }}
          >
            <div className="mb-1 text-ink-3">{new Date(h.t).toLocaleString([], { month: 'short', day: 'numeric', hour: range === '30d' ? undefined : '2-digit' })}</div>
            <div className="mb-1.5 text-[15px] font-semibold text-ink">{money(h.total)}</div>
            {series
              .filter((k) => (h.v.get(k) ?? 0) > 0)
              .sort((a, b) => (h.v.get(b) ?? 0) - (h.v.get(a) ?? 0))
              .map((k) => (
                <div key={k} className="flex items-center gap-2 py-0.5">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: colorOf(k) }} />
                  <span className="font-medium text-ink tabular-nums">{money(h.v.get(k) ?? 0)}</span>
                  <span className="truncate text-ink-3">{labelOf(k)}</span>
                </div>
              ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type Row = { k: string; cost: number; req: number; pt: number; ct: number }

function Bars({ rows, name, group }: { rows: Row[]; name: (k: string) => string; group: Group }) {
  const agents = useHive((s) => s.agents)
  const max = Math.max(...rows.map((r) => r.cost), 0.0001)
  const [hover, setHover] = useState<string | null>(null)
  if (!rows.length) return <p className="text-sm text-ink-3">No spend in this range.</p>
  return (
    <ul className="space-y-2.5" onPointerLeave={() => setHover(null)}>
      {rows.map((r) => {
        const a = group === 'agent' ? agents[r.k] : undefined
        return (
          <li key={r.k} className="relative" onPointerEnter={() => setHover(r.k)} tabIndex={0} onFocus={() => setHover(r.k)} onBlur={() => setHover(null)} aria-label={`${name(r.k)}: ${money(r.cost)}, ${r.req} requests`}>
            <div className="mb-1 flex items-center gap-2 text-[12px]">
              {a && <Orb hue={a.hue} status={a.status} size={14} />}
              <span className="truncate text-ink-2">{name(r.k)}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative h-3 flex-1">
                <m.div
                  className="absolute inset-y-0 left-0 rounded-r-[4px]"
                  initial={{ width: 0 }}
                  animate={{ width: `${(r.cost / max) * 100}%` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                  style={{ background: BAR, opacity: hover && hover !== r.k ? 0.5 : 1, minWidth: 2 }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-[12px] font-medium text-ink tabular-nums">{money(r.cost)}</span>
            </div>
            {hover === r.k && (
              <div className="glass-strong pointer-events-none absolute right-0 -top-1 z-10 -translate-y-full rounded-lg px-2.5 py-1.5 text-[11px] text-ink-2">
                <span className="font-semibold text-ink">{r.req}</span> requests · <span className="font-semibold text-ink">{compact(r.pt + r.ct)}</span> tokens
                {a && a.budget_usd > 0 && (
                  <>
                    {' '}
                    · cap <span className="font-semibold text-ink">{money(a.budget_usd)}</span>
                  </>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Prompt vs completion per entity: a two-part stacked bar with the reference 2px gap. */
function TokenSplit({ rows, name }: { rows: Row[]; name: (k: string) => string }) {
  const max = Math.max(...rows.map((r) => r.pt + r.ct), 1)
  return (
    <div>
      <Legend
        items={[
          { k: 'pt', label: 'Prompt', color: SLOTS[0] },
          { k: 'ct', label: 'Completion', color: SLOTS[1] },
        ]}
      />
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li key={r.k} aria-label={`${name(r.k)}: ${r.pt} prompt, ${r.ct} completion tokens`}>
            <div className="mb-1 flex justify-between text-[12px]">
              <span className="truncate text-ink-2">{name(r.k)}</span>
              <span className="text-ink-3 tabular-nums">{compact(r.pt + r.ct)}</span>
            </div>
            <div className="flex h-3 gap-[2px]">
              <div className="h-full rounded-l-[2px]" style={{ width: `${(r.pt / max) * 100}%`, background: SLOTS[0] }} />
              <div className="h-full rounded-r-[4px]" style={{ width: `${(r.ct / max) * 100}%`, background: SLOTS[1], minWidth: 2 }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EntityTable({ rows, total, name, group }: { rows: Row[]; total: number; name: (k: string) => string; group: Group }) {
  return (
    <div className="overflow-x-auto rounded-[20px] border border-line" style={{ background: SURFACE }}>
      <table className="w-full text-left text-[13px]">
        <caption className="sr-only">Usage {group === 'agent' ? 'by mind' : 'by model'}</caption>
        <thead className="text-[11px] text-ink-3">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {group === 'agent' ? 'Mind' : 'Model'}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Requests
            </th>
            <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">
              Prompt
            </th>
            <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">
              Completion
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Spend
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.k} className="border-t border-line">
              <td className="px-4 py-2.5 text-ink">{name(r.k)}</td>
              <td className="px-4 py-2.5 text-right text-ink-2">{r.req.toLocaleString()}</td>
              <td className="hidden px-4 py-2.5 text-right text-ink-2 sm:table-cell">{r.pt.toLocaleString()}</td>
              <td className="hidden px-4 py-2.5 text-right text-ink-2 sm:table-cell">{r.ct.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right text-ink">{money(r.cost)}</td>
              <td className="px-4 py-2.5 text-right text-ink-3">{total ? `${((r.cost / total) * 100).toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
