import { useId, useMemo, useState, type ReactNode } from 'react'
import { useWidth } from './useWidth'
import type { LabSeries } from '../../api/types'
import { cx } from '../../lib/cx'
import { BAD, categoricalX, fmtValue, GOOD, GRID, hair, INK3, INK4, isReference, labText, niceDomain, seriesTitle, SLOTS, SURFACE, valueAt } from './labUtil'

export interface ChartSeries extends LabSeries {
  color?: string
  dashed?: boolean
}

/** Legend: always for two or more series, so identity never rests on colour alone. */
export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean; bar?: boolean }[] }) {
  if (items.length < 2) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2" aria-label="Legend">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1.5">
          {it.bar ? (
            <span className="size-2.5 rounded-[3px]" style={{ background: it.color }} aria-hidden="true" />
          ) : (
            <svg width="16" height="6" aria-hidden="true">
              <line x1="1" x2="15" y1="3" y2="3" stroke={it.color} strokeWidth="2" strokeDasharray={it.dashed ? '4 3' : undefined} strokeLinecap="round" />
            </svg>
          )}
          {labText(it.name)}
        </li>
      ))}
    </ul>
  )
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const w = 172
  const left = Math.min(Math.max(0, x - w / 2), Math.max(0, width - w))
  return (
    <div className="glass-strong pointer-events-none absolute top-0 z-10 rounded-xl px-3 py-2 text-[12px]" style={{ left, width: w }}>
      {children}
    </div>
  )
}

/**
 * Lab series drawn to scale: line, step and bar (and histogram) on one shared x/y.
 * Axes carry units; hovering shows a crosshair with every series' value at that x.
 * `cursor` replays "as of this x": marks after it fade and a rule marks the step.
 */
export function SeriesChart({
  series,
  height = 180,
  cursor,
  xLabels: xLabelsIn,
  yLabels,
  yDomain,
  label,
  extra,
}: {
  series: ChartSeries[]
  height?: number
  cursor?: number | null
  /** Category names for integer x positions (e.g. events, decisions). */
  xLabels?: Record<number, string>
  /** Names for coded y values (e.g. goal states). */
  yLabels?: Record<number, string>
  yDomain?: [number, number]
  label: string
  /** Extra marks drawn in data space (e.g. a target line). */
  extra?: (sx: (x: number) => number, sy: (y: number) => number) => ReactNode
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const clip = useId().replace(/:/g, '')
  const colored = useMemo(() => {
    let slot = 0
    return series.map((s) => ({ ...s, color: s.color ?? SLOTS[slot++ % SLOTS.length], dashed: s.dashed ?? (series.length > 1 && isReference(s.name)) }))
  }, [series])
  const bars = colored.every((s) => s.kind === 'bar')
  const unit = colored[0]?.unit ?? ''
  const catX = !xLabelsIn && colored.length === 1 ? categoricalX(colored[0]) : null
  const xLabels = xLabelsIn ?? catX ?? undefined
  const xTitle = catX ? '' : labText(colored[0]?.x)

  const geo = useMemo(() => {
    const xs: number[] = []
    const ys: number[] = []
    for (const s of colored) for (const [x, y] of s.points) {
      xs.push(x)
      ys.push(y)
    }
    if (!xs.length) return null
    let xlo = Math.min(...xs)
    let xhi = Math.max(...xs)
    const uniq = [...new Set(xs)].sort((a, b) => a - b)
    let gap = Infinity
    for (let i = 1; i < uniq.length; i++) gap = Math.min(gap, uniq[i] - uniq[i - 1])
    if (!Number.isFinite(gap)) gap = 1
    if (bars) {
      xlo -= gap / 2
      xhi += gap / 2
    }
    if (xlo === xhi) {
      xlo -= 1
      xhi += 1
    }
    let ylo = Math.min(...ys)
    let yhi = Math.max(...ys)
    if (yDomain) [ylo, yhi] = yDomain
    else if (bars || ylo >= 0) {
      // magnitudes start at zero; unitless 0..1 values (confidence, frequency) get the full unit range
      ylo = 0
      if (!unit && yhi <= 1) yhi = 1
    }
    const yd = yLabels ? { lo: Math.min(ylo, ...Object.keys(yLabels).map(Number)), hi: Math.max(yhi, ...Object.keys(yLabels).map(Number)), ticks: Object.keys(yLabels).map(Number) } : niceDomain(ylo, yhi, height < 140 ? 3 : 4)
    return { xlo, xhi, gap, yd, uniq }
  }, [colored, bars, yDomain, yLabels, unit, height])

  if (!geo) {
    return <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-line text-[12px] text-ink-4">No points recorded</div>
  }
  const tickText = (t: number) => (yLabels ? (yLabels[t] ?? '') : fmtValue(t, unit === 'ms' || unit === '$' ? unit : '', { short: true }))
  const padL = Math.max(30, Math.min(84, Math.max(...geo.yd.ticks.map((t) => tickText(t).length)) * 6.4 + 12))
  const padR = 10
  const padT = 8
  const padB = 34
  const plotW = Math.max(20, width - padL - padR)
  const plotH = height - padT - padB
  const sx = (x: number) => padL + ((x - geo.xlo) / (geo.xhi - geo.xlo)) * plotW
  const yspan = geo.yd.hi - geo.yd.lo || 1
  const sy = (y: number) => padT + plotH - ((y - geo.yd.lo) / yspan) * plotH
  const xd = niceDomain(geo.xlo, geo.xhi, Math.max(2, Math.floor(plotW / 70)))
  const xTicks = xLabels
    ? Object.keys(xLabels).map(Number).filter((_, i, arr) => arr.length <= Math.floor(plotW / 54) || i % Math.ceil(arr.length / Math.floor(plotW / 54)) === 0)
    : bars && geo.uniq.length <= 14 && geo.uniq.every(Number.isInteger)
      ? geo.uniq.filter((_, i) => i % Math.ceil(geo.uniq.length / Math.max(2, Math.floor(plotW / 40))) === 0)
      : xd.ticks.filter((t) => t >= geo.xlo - 1e-9 && t <= geo.xhi + 1e-9)
  const xText = (x: number) => xLabels?.[x] ?? fmtValue(x, xTitle === 'ms' ? 'ms' : '', { short: true })

  // bars: grouped side by side when several series share an x
  const bandW = (geo.gap / (geo.xhi - geo.xlo)) * plotW
  const barW = Math.max(1.5, Math.min(28, bandW - Math.max(2, bandW * 0.22)) / Math.max(1, colored.filter((s) => s.kind === 'bar').length))

  const path = (s: ChartSeries) => {
    const pts = s.points
    if (!pts.length) return ''
    let d = `M${sx(pts[0][0])},${sy(pts[0][1])}`
    for (let i = 1; i < pts.length; i++) {
      if (s.kind === 'step') d += `H${sx(pts[i][0])}V${sy(pts[i][1])}`
      else d += `L${sx(pts[i][0])},${sy(pts[i][1])}`
    }
    return d
  }
  const hx = hover
  const cursorX = cursor != null ? sx(cursor) : null

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect()
    const px = e.clientX - r.left
    const x = geo.xlo + (px / r.width) * (geo.xhi - geo.xlo)
    let best = geo.uniq[0]
    for (const u of geo.uniq) if (Math.abs(u - x) < Math.abs(best - x)) best = u
    setHover(best)
  }

  const marks = (
    <>
      {[...colored].sort((a, b) => Number(!!b.dashed) - Number(!!a.dashed)).map((s, si) =>
        s.kind === 'bar' ? (
          <g key={s.name}>
            {s.points.map(([x, y]) => {
              const bi = colored.filter((c) => c.kind === 'bar').indexOf(s)
              const nb = colored.filter((c) => c.kind === 'bar').length
              const x0 = sx(x) - (barW * nb) / 2 + bi * barW + (nb > 1 ? 1 : 0)
              const w = Math.max(1, barW - (nb > 1 ? 2 : 0))
              const y0 = sy(Math.max(geo.yd.lo, 0))
              const y1 = sy(y)
              const h = Math.max(0, y0 - y1)
              const r = Math.min(4, w / 2, h)
              const d = h <= 0.3 ? '' : `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + w - r}Q${x0 + w},${y1} ${x0 + w},${y1 + r}V${y0}Z`
              return d ? <path key={x} d={d} fill={s.color} opacity={hx === null || hx === x ? 1 : 0.5} /> : null
            })}
          </g>
        ) : (
          <path
            key={s.name}
            d={path(s)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={si === 0 || !s.dashed ? 1 : 0.9}
          />
        ),
      )}
      {/* short measured series get markers, so each point reads as a measurement */}
      {colored.map((s) =>
        s.kind !== 'bar' && !s.dashed && s.points.length <= 16
          ? s.points.map(([x, y], i) => <circle key={`${s.name}-${i}`} cx={sx(x)} cy={sy(y)} r={3.5} fill={s.color} strokeWidth={1.5} style={{ stroke: SURFACE }} />)
          : null,
      )}
    </>
  )

  return (
    <div ref={ref} className="relative select-none" onPointerLeave={() => setHover(null)}>
      <Legend items={colored.map((s) => ({ name: seriesTitle(s.name), color: s.color!, dashed: s.dashed, bar: s.kind === 'bar' }))} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
          <defs>
            <clipPath id={`c${clip}`}>
              <rect x={0} y={0} width={cursorX ?? width} height={height} />
            </clipPath>
          </defs>
          {geo.yd.ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={sy(t)} y2={sy(t)} style={{ stroke: GRID }} />
              <text x={padL - 7} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={10.5} style={{ fill: INK3, fontVariantNumeric: 'tabular-nums' }}>
                {tickText(t)}
              </text>
            </g>
          ))}
          <line x1={padL} x2={width - padR} y1={sy(Math.max(geo.yd.lo, 0))} y2={sy(Math.max(geo.yd.lo, 0))} style={{ stroke: hair(18) }} />
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={padT + plotH + 15} textAnchor="middle" fontSize={10.5} style={{ fill: INK3, fontVariantNumeric: 'tabular-nums' }}>
              {xText(t).length > 12 ? `${xText(t).slice(0, 11)}…` : xText(t)}
            </text>
          ))}
          <text x={width - padR} y={height - 3} textAnchor="end" fontSize={10} style={{ fill: INK4 }}>
            {xTitle}
            {xTitle && ' →'}
          </text>
          {unit && !yLabels && (
            <text x={4} y={height - 3} fontSize={10} style={{ fill: INK4 }}>
              {unit}
            </text>
          )}
          {extra?.(sx, sy)}
          {cursorX != null ? (
            <>
              <g opacity={0.16}>{marks}</g>
              <g clipPath={`url(#c${clip})`}>{marks}</g>
              <line x1={cursorX} x2={cursorX} y1={padT} y2={padT + plotH} strokeOpacity={0.55} strokeDasharray="2 3" style={{ stroke: 'var(--color-ink)' }} />
            </>
          ) : (
            marks
          )}
          {hx !== null && (
            <g pointerEvents="none">
              <line x1={sx(hx)} x2={sx(hx)} y1={padT} y2={padT + plotH} style={{ stroke: hair(25) }} />
              {colored.map((s) => {
                if (s.kind === 'bar') return null
                const v = valueAt(s, hx)
                return v == null ? null : <circle key={s.name} cx={sx(hx)} cy={sy(v)} r={4} fill={s.color} strokeWidth={2} style={{ stroke: SURFACE }} />
              })}
            </g>
          )}
          <rect
            x={padL}
            y={0}
            width={plotW}
            height={padT + plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            tabIndex={0}
            aria-label={`${label}. Use the arrow keys to read values.`}
            onKeyDown={(e) => {
              const i = hx === null ? -1 : geo.uniq.indexOf(hx)
              if (e.key === 'ArrowRight') setHover(geo.uniq[Math.min(geo.uniq.length - 1, i + 1)])
              else if (e.key === 'ArrowLeft') setHover(geo.uniq[Math.max(0, i - 1)])
              else return
              e.preventDefault()
            }}
            onBlur={() => setHover(null)}
            className="outline-none"
          />
        </svg>
      )}
      {hx !== null && width > 0 && (
        <Tooltip x={sx(hx)} width={width}>
          <div className="mb-1 truncate text-ink-3">
            {xTitle && !xLabels ? `${xTitle} ` : ''}
            {xText(hx)}
          </div>
          {colored.map((s) => {
            const v = s.kind === 'bar' ? (s.points.find((p) => p[0] === hx)?.[1] ?? null) : valueAt(s, hx)
            return (
              <div key={s.name} className="flex items-center gap-2 py-0.5">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="font-medium text-ink tabular-nums">{v == null ? '–' : yLabels?.[v] ?? fmtValue(v, s.unit)}</span>
                <span className="min-w-0 truncate text-ink-3">{seriesTitle(s.name)}</span>
              </div>
            )
          })}
        </Tooltip>
      )}
    </div>
  )
}

/** A word-sized trend: line with the last value dotted, or nothing when there is a single point. */
export function Sparkline({ values, width = 72, height = 22, color = '#9085e9', marks }: { values: number[]; width?: number; height?: number; color?: string; marks?: (boolean | null)[] }) {
  if (values.length < 2) return <span className="inline-block text-[11px] text-ink-4" style={{ width }}>–</span>
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 4)
  const y = (v: number) => (hi === lo ? height / 2 : 2 + (1 - (v - lo) / span) * (height - 4))
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const last = values.length - 1
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0 overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      {marks?.map((ok, i) => (ok === false ? <circle key={i} cx={x(i)} cy={y(values[i])} r={2.5} style={{ fill: BAD }} /> : null))}
      <circle cx={x(last)} cy={y(values[last])} r={2.5} fill={color} />
    </svg>
  )
}

export interface TrendPoint {
  key: string
  at: string
  value: number
  ok: boolean | null
  example?: boolean
}

/**
 * A metric across runs (oldest → newest): the value line, the target as a dashed rule with the
 * passing side tinted, failing points as red rings, example-history points hollow.
 */
export function TrendChart({
  points,
  unit,
  target,
  better,
  height = 220,
  label,
  onPick,
  selected,
}: {
  points: TrendPoint[]
  unit: string
  target: number | null
  better: 'lower' | 'higher' | 'equal' | null
  height?: number
  label: string
  onPick?: (key: string) => void
  selected?: string | null
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  if (!points.length) return <div className="flex h-32 items-center justify-center text-[13px] text-ink-4">No finished runs yet</div>
  const vals = points.map((p) => p.value)
  let lo = Math.min(...vals, ...(target != null ? [target] : []))
  let hi = Math.max(...vals, ...(target != null ? [target] : []))
  if (lo >= 0) lo = 0
  if (!unit && hi <= 1 && lo >= 0) hi = Math.max(hi, 1)
  const yd = niceDomain(lo, hi, 4)
  const padL = Math.max(34, Math.max(...yd.ticks.map((t) => fmtValue(t, unit === 'ms' || unit === '$' ? unit : '', { short: true }).length)) * 6.4 + 12)
  const padR = 12
  const padT = 10
  const padB = 30
  const plotW = Math.max(20, width - padL - padR)
  const plotH = height - padT - padB
  const n = points.length
  const sx = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const sy = (v: number) => padT + plotH - ((v - yd.lo) / (yd.hi - yd.lo || 1)) * plotH
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(p.value)}`).join('')
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 74))))
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
  const h = hover !== null ? points[hover] : null
  const color = SLOTS[0]
  return (
    <div ref={ref} className="relative select-none" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block">
          {target != null && better && better !== 'equal' && (
            <rect
              x={padL}
              width={plotW}
              y={better === 'lower' ? sy(target) : padT}
              height={better === 'lower' ? padT + plotH - sy(target) : sy(target) - padT}
              opacity={0.045}
              style={{ fill: GOOD }}
            />
          )}
          {yd.ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={sy(t)} y2={sy(t)} style={{ stroke: GRID }} />
              <text x={padL - 7} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={10.5} style={{ fill: INK3, fontVariantNumeric: 'tabular-nums' }}>
                {fmtValue(t, unit === 'ms' || unit === '$' ? unit : '', { short: true })}
              </text>
            </g>
          ))}
          {target != null && (
            <g>
              <line x1={padL} x2={width - padR} y1={sy(target)} y2={sy(target)} strokeOpacity={0.5} strokeDasharray="5 4" style={{ stroke: 'var(--color-ink)' }} />
              <text x={width - padR} y={sy(target) - 5} textAnchor="end" fontSize={10.5} style={{ fill: 'var(--color-ink-2)' }}>
                target {better === 'lower' ? '≤' : better === 'higher' ? '≥' : '='} {fmtValue(target, unit)}
              </text>
            </g>
          )}
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => (
            <g key={p.key}>
              {p.ok === false && <circle cx={sx(i)} cy={sy(p.value)} r={8} fill="none" strokeWidth={2} style={{ stroke: BAD }} />}
              <circle
                cx={sx(i)}
                cy={sy(p.value)}
                r={selected === p.key || hover === i ? 5.5 : 4}
                strokeWidth={2}
                style={{ fill: p.example ? SURFACE : p.ok === false ? BAD : color, stroke: p.example ? (p.ok === false ? BAD : color) : SURFACE }}
              />
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={p.key} x={sx(i)} y={height - 9} textAnchor={i === n - 1 && n > 1 ? 'end' : i === 0 && n > 1 ? 'start' : 'middle'} fontSize={10.5} style={{ fill: INK3 }}>
                {day(p.at)}
              </text>
            ) : null,
          )}
          {points.map((p, i) => (
            <rect
              key={p.key}
              x={sx(i) - plotW / Math.max(1, n - 1) / 2}
              y={0}
              width={Math.max(16, plotW / Math.max(1, n - 1))}
              height={padT + plotH}
              fill="transparent"
              tabIndex={0}
              role={onPick ? 'button' : undefined}
              aria-label={`${day(p.at)}: ${fmtValue(p.value, unit)}${p.ok === false ? ', missed target' : ''}${p.example ? ', example history' : ''}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => onPick?.(p.key)}
              onKeyDown={(e) => e.key === 'Enter' && onPick?.(p.key)}
              className={cx('outline-none', onPick && 'cursor-pointer')}
            />
          ))}
        </svg>
      )}
      {h && hover !== null && (
        <Tooltip x={sx(hover)} width={width}>
          <div className="text-ink-3">{new Date(h.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-ink tabular-nums">{fmtValue(h.value, unit)}</div>
          <div className={cx('mt-0.5', h.ok === false ? 'text-bad' : h.ok ? 'text-good' : 'text-ink-3')}>{h.ok === false ? 'Missed its target' : h.ok ? 'Within target' : 'No target'}</div>
          {h.example && <div className="mt-1 text-[11px] text-warn">Example history (demo)</div>}
          {onPick && <div className="mt-1 text-[11px] text-ink-4">Click to open the run</div>}
        </Tooltip>
      )}
    </div>
  )
}
