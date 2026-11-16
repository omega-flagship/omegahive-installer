/**
 * Workbench Map, the drawn parts. Each takes exactly what an answer contained and renders it; none reads the store or
 * the network (MapView does), so each renders the same in the page and in a test. Colours follow Design's brief r2:
 * violet (accent) marks selection, cyan (accent-2) links sources, amber (warn) unknown or incomplete, rose (bad)
 * failed; words and shapes carry the same meaning.
 */
import { plural } from '../../../lib/plural'
import type { ReactNode } from 'react'
import { cx } from '../../../lib/cx'
import { Icon, type IconName } from '../../../ui/Icon'
import { Button } from '../../../ui/primitives'
import { failureWords, type RepoSpace, type DriftItem, type MapEdge, type MapFailure, type MapHeader, type MapNode, type Preset, type Provenance, type Ref } from '../../../api/repoMap'
import {
  COPY,
  TESTS_NOTE,
  TONE_COLOR,
  spaceWords,
  UNRESOLVED_SHOWN,
  ambiguousAt,
  countRows,
  driftLabel,
  tallyWords,
  totalRows,
  coverageLines,
  edgeLook,
  edgesByKind,
  emptyWords,
  evidenceWords,
  MAX_MARKS,
  childGroups,
  moduleGroups,
  packGroups,
  pathOf,
  scopedCount,
  short,
  truncatedWords,
  type Anchor,
  type DriftView,
  type StateView,
} from './model'
import { DIRECT_ONLY, presetTitle, type Plan } from './ask'

const SURFACE = 'color-mix(in srgb, var(--color-glass) 92%, transparent)'

export function Panel({ title, children, className, tone, actions, label }: { title?: ReactNode; children: ReactNode; className?: string; tone?: string; actions?: ReactNode; label?: string }) {
  return (
    <section aria-label={label} className={cx('rounded-[18px] border p-3.5 text-[12.5px] text-ink-2 shadow-[0_8px_30px_rgb(0_0_0/0.18)] backdrop-blur-md', className)} style={{ background: SURFACE, borderColor: tone ? `color-mix(in srgb, ${tone} 38%, transparent)` : 'var(--color-line-2)' }}>
      {(title || actions) && (
        <header className="mb-2 flex items-start gap-2">
          {title && <h2 className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap" style={{ color, background: `color-mix(in srgb, ${color} 10%, transparent)`, borderColor: `color-mix(in srgb, ${color} 34%, transparent)` }}>
      {children}
    </span>
  )
}
export const AmbiguousTag = () => <Chip color="var(--color-warn)" title="The extractor could not qualify this node uniquely; it is kept separate, never merged.">ambiguous</Chip>
export const HeuristicTag = () => <Chip color="var(--color-warn)" title="A heuristic link: a syntactic expression, not a resolved call or dependency.">heuristic</Chip>

// ---------------------------------------------------------------------------------------------------- state

const TONE_ICON: Record<StateView['tone'], IconName> = { ok: 'check', amber: 'alert', rose: 'alert' }
/** The map's state and reason, verbatim, with the plain note. Always shown, also for ready. */
export function StateBand({ v, space, recheck }: { v: StateView; space?: RepoSpace; recheck?: { stopped: boolean; onRecheck: () => void } }) {
  const color = TONE_COLOR[v.tone]
  const sp = space ? spaceWords(space) : null
  return (
    <div role="status" data-map-state={v.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border px-3 py-2 text-[12.5px]" style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}>
      <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color }}>
        <Icon name={TONE_ICON[v.tone]} size={14} strokeWidth={2.4} />
        state: <span data-map-state-word>{v.state}</span>
      </span>
      {v.reason && (
        <span className="text-ink-2">
          reason: <span data-map-reason>{v.reason}</span>
        </span>
      )}
      {v.note && <span className="text-ink-3">{v.note}</span>}
      {sp && (
        <span className="basis-full text-[12px]" style={{ color: sp.settled ? 'var(--color-ink-3)' : 'var(--color-warn)' }} data-map-space={sp.status}>
          Native space: <span data-map-space-status>{sp.status}</span>
          {sp.status === 'mounting' ? ' ' : ' · '}
          <span data-map-space-contents>{sp.contents}</span>
          {sp.reason ? ` · ${sp.reason}` : ''}
          {sp.waiting && recheck && !recheck.stopped && <span className="text-ink-3" data-map-space-polling> · checking again shortly</span>}
          {sp.waiting && recheck?.stopped && (
            <>
              {' · '}
              <span className="text-ink-3" data-map-space-stopped>stopped checking</span>{' '}
              <button type="button" className="min-h-8 rounded-md px-1.5 underline underline-offset-2" onClick={recheck.onRecheck} data-map-space-recheck>
                Check again
              </button>
            </>
          )}
        </span>
      )}
    </div>
  )
}

export function FailureCard({ f }: { f: MapFailure }) {
  const w = failureWords(f)
  return (
    <div role="alert" data-map-failure={f.kind} className="mx-auto mt-10 max-w-md rounded-[18px] border border-line-2 px-5 py-6 text-center">
      <Icon name="alert" size={22} className="mx-auto mb-2 text-warn" />
      <h2 className="text-[15px] font-semibold text-ink">{w.title}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{w.body}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- overview

export function Overview({ header, v, nodes, truncated, scope, onScope, onMore, moreBusy, note }: { header: MapHeader; v: StateView; nodes: MapNode[] | null; truncated: boolean; scope: string | null; onScope: (m: string | null) => void; onMore?: () => void; moreBusy?: boolean; note?: string | null }) {
  const counts = countRows(header.counts)
  const totals = totalRows(header.counts)
  const edgeKinds = tallyWords(header.counts?.edges_by_kind ?? null)
  const edgeBases = tallyWords(header.counts?.edges_by_basis ?? null)
  const cov = coverageLines(header)
  const groups = nodes ? moduleGroups(nodes) : []
  const more = nodes ? truncatedWords(nodes.length, truncated) : null
  return (
    <Panel title="Overview" label="Repository map overview">
      <div className="space-y-2.5">
        <div>
          <div className="eyebrow mb-1">Counts this map reports{v.complete ? '' : ` (map is ${v.state})`}</div>
          {counts.length ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5" data-map-counts>
              {counts.map((c) => (
                <li key={c.kind} className="text-ink">
                  {c.words}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">No node counts by kind in this answer.</p>
          )}
          {totals.length > 0 && <p className="mt-0.5 text-[11.5px] text-ink-3" data-map-totals>totals: {totals.join(' · ')}</p>}
          {edgeKinds.length > 0 && <p className="text-[11.5px] text-ink-3" data-map-edge-kinds>relationships by kind: {edgeKinds.join(' · ')}</p>}
          {edgeBases.length > 0 && <p className="text-[11.5px] text-ink-3" data-map-edge-bases>by basis: {edgeBases.join(' · ')}</p>}
        </div>
        <div>
          <div className="eyebrow mb-1">Coverage</div>
          <p>{cov.supported}</p>
          {cov.unresolved.length > 0 && (
            <div className="mt-1" data-map-unresolved={cov.unresolved.length}>
              <p style={{ color: 'var(--color-warn)' }}>
                {cov.unresolved.length} unresolved {cov.unresolved.length === 1 ? 'entry' : 'entries'}:
              </p>
              <ul className="space-y-0.5" data-map-unresolved-issues>
                {cov.byIssue.map((b) => (
                  <li key={b.issue} className="flex gap-1.5" style={{ color: 'var(--color-warn)' }}>
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span className="[overflow-wrap:anywhere]">
                      {b.issue} <span className="text-ink-3">· {b.n}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <details className="mt-1">
                <summary className="cursor-pointer text-ink-3">Where{cov.unresolved.length > UNRESOLVED_SHOWN ? ` (first ${UNRESOLVED_SHOWN} of ${cov.unresolved.length})` : ''}</summary>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                  {cov.unresolved.slice(0, UNRESOLVED_SHOWN).map((u, i) => (
                    <li key={i} className="[overflow-wrap:anywhere]">
                      Not read: <span className="font-mono">{u.path}</span> — {u.issue}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          {cov.other.length > 0 && (
            <dl className="mt-1 space-y-0.5 text-[11.5px]" data-map-coverage-other>
              {cov.other.map(([k, val]) => (
                <div key={k} className="flex gap-1.5">
                  <dt className="shrink-0 text-ink-3">{k}</dt>
                  <dd className="min-w-0 font-mono text-ink-2 [overflow-wrap:anywhere]">{val.length > 160 ? `${val.slice(0, 159)}…` : val}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {v.drawable && nodes && (
          <div>
            <div className="eyebrow mb-1">Top-level modules (from the file-level items read)</div>
            <p className="mb-1 text-ink-3" data-map-scoped>
              {scopedCount(nodes.length)}
              {more ? ` · ${more}` : ''}
            </p>
            {note && <p className="mb-1 text-ink-3" data-map-note>{note}</p>}
            {groups.length === 0 ? (
              <p className="text-ink-3" data-map-empty>{emptyWords(v)}</p>
            ) : (
              <ul className="space-y-0.5">
                {groups.map((g) => (
                  <li key={g.module}>
                    <button type="button" className={cx('flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-tint/5', scope === g.module && 'text-ink')} style={scope === g.module ? { boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined} onClick={() => onScope(scope === g.module ? null : g.module)} aria-pressed={scope === g.module}>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{g.module}</span>
                      <span className="text-ink-3">{scopedCount(g.items.length).replace(' in this view', '')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {more && onMore && (
              <Button variant="ghost" className="mt-1 min-h-8 px-2 text-[12px]" disabled={moreBusy} onClick={onMore}>
                Read more
              </Button>
            )}
            {scope && <p className="mt-1 text-ink-3">{COPY.narrowed}</p>}
          </div>
        )}
      </div>
    </Panel>
  )
}

export function ProvenanceFooter({ p, schema }: { p: Provenance; schema: string }) {
  const rows: [string, string][] = [
    ['repo', p.repo],
    ['sha', p.sha],
    ['snapshot', p.snapshot_digest ?? 'not given'],
    ['extractor', `${p.extractor.id} ${p.extractor.version}${p.extractor.parser ? ` (${p.extractor.parser})` : ''}`],
    ['generated', p.generated_at ?? 'not given'],
    ['receipt', p.receipt ? [p.receipt.digest, p.receipt.artifact_ref].filter(Boolean).join(' · ') || 'not given' : 'not given'],
    ['schema', schema],
  ]
  return (
    <footer aria-label="Where this map came from" data-map-provenance className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-4">
      {rows.map(([k, val]) => (
        <span key={k} className="min-w-0 [overflow-wrap:anywhere]">
          {k} <span className="font-mono text-ink-3">{val}</span>
        </span>
      ))}
    </footer>
  )
}

// ---------------------------------------------------------------------------------------------------- graph

const FOCUS_MAX = 24
const KIND_ICON: Record<string, string> = { file: '▢', module: '◇', def: 'ƒ', import: '↘', test: '✓', doc: '¶' }
const kindGlyph = (k: string) => KIND_ICON[k] ?? '•'

export interface Focus {
  node: MapNode
  edges: MapEdge[]
  neighbours: MapNode[]
}

/**
 * The map as a picture, at one of three levels (the hive view's approach: pack groups as circles, zoom by scope):
 * repository (top-level modules), module (its files, with what each holds), focus (one node and the edges the answer
 * gave for it). Syntax edges solid; heuristic dashed, tagged "heuristic". Every mark is a button with a text name.
 */
export function MapGraph({ nodes, scope, focus, selectedId, onScope, onSelect, height }: { nodes: MapNode[]; scope: string | null; focus: Focus | null; selectedId: string | null; onScope: (m: string) => void; onSelect: (id: string) => void; height: number }) {
  const amb = ambiguousAt(nodes)
  const key = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }
  if (focus) return <FocusGraph focus={focus} ambiguous={amb.size > 0 && nodes.some((n, i) => amb.has(i) && n.id === focus.node.id)} ambiguousIds={new Set(nodes.filter((_, i) => amb.has(i)).map((n) => n.id))} onSelect={onSelect} height={height} />
  const all = childGroups(nodes, scope)
  const groups = all.slice(0, MAX_MARKS)
  const hidden = all.length - groups.length
  const { places, radius } = packGroups(groups, (g) => g.key)
  const R = Math.max(radius, 60) + 30
  const level = scope === null ? 'repository' : 'module'
  return (
    <svg role="img" aria-label={scope === null ? `Repository: ${plural(all.length, 'top-level module')}` : `${scope}: ${plural(all.length, 'directory or file', 'directories and files')}`} viewBox={`${-R} ${-R} ${2 * R} ${2 * R + (hidden ? 24 : 0)}`} width="100%" height={height} data-map-level={level}>
      {groups.map((g, i) => {
        const p = places[i]
        const fileIdx = g.kind === 'file' ? (g.items.find((j) => nodes[j].kind === 'file') ?? g.items[0]) : undefined
        const open = () => (g.kind === 'dir' ? onScope(g.key) : fileIdx !== undefined && onSelect(nodes[fileIdx].id))
        const inner = g.kind === 'file' ? g.items.filter((j) => j !== fileIdx) : []
        const sel = fileIdx !== undefined && nodes[fileIdx].id === selectedId
        const n = g.items.length
        return (
          <g key={g.key} data-map-mark={g.kind}>
            <g role="button" tabIndex={0} aria-label={`${g.kind === 'dir' ? 'directory' : nodes[fileIdx!].kind} ${g.label}: ${n} ${n === 1 ? 'item' : 'items'}${fileIdx !== undefined && amb.has(fileIdx) ? ', ambiguous' : ''}. Open`} className="cursor-pointer outline-none" onClick={open} onKeyDown={(e) => key(e, open)}>
              <circle cx={p.x} cy={p.y} r={p.r} fill={g.kind === 'dir' ? 'color-mix(in srgb, var(--color-accent) 9%, transparent)' : 'color-mix(in srgb, var(--color-ink) 4%, transparent)'} stroke={sel ? 'var(--color-accent)' : 'var(--color-line-2)'} strokeWidth={sel ? 2 : 1.2} strokeDasharray={g.kind === 'file' ? undefined : '5 3'} />
              <text x={p.x} y={inner.length ? p.y - p.r + 16 : p.y - 3} textAnchor="middle" className="fill-[var(--color-ink)] font-mono" fontSize={Math.max(10, Math.min(14, p.r / 3.2))}>
                {g.label.length > 22 ? `${g.label.slice(0, 21)}…` : g.label}
                {g.kind === 'dir' ? '/' : ''}
              </text>
              {!inner.length && (
                <text x={p.x} y={p.y + 13} textAnchor="middle" className="fill-[var(--color-ink-3)]" fontSize={10.5}>
                  {n} {n === 1 ? 'item' : 'items'}
                </text>
              )}
            </g>
            {inner.slice(0, 12).map((j, k) => {
              const nd = nodes[j]
              const a = (2 * Math.PI * k) / Math.max(1, Math.min(12, inner.length)) - Math.PI / 2
              const rr = inner.length === 1 ? 0 : p.r * 0.42
              const x = p.x + Math.cos(a) * rr
              const y = p.y + 6 + Math.sin(a) * rr
              const on = nd.id === selectedId
              return (
                <g key={`${nd.id}#${j}`} role="button" tabIndex={0} aria-label={`${nd.kind} ${nd.label}${amb.has(j) ? ', ambiguous' : ''}. Open`} className="cursor-pointer outline-none" onClick={() => onSelect(nd.id)} onKeyDown={(e) => key(e, () => onSelect(nd.id))}>
                  <circle cx={x} cy={y} r={11} fill={on ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-accent) 22%, transparent)'} stroke={amb.has(j) ? 'var(--color-warn)' : 'none'} strokeDasharray={amb.has(j) ? '3 2' : undefined} strokeWidth={1.4} />
                  <text x={x} y={y + 4} textAnchor="middle" fontSize={11} className={on ? 'fill-[var(--color-primary-ink)]' : 'fill-[var(--color-ink)]'}>
                    {kindGlyph(nd.kind)}
                  </text>
                  <text x={x} y={y + 24} textAnchor="middle" fontSize={10} className="fill-[var(--color-ink-2)]">
                    {nd.label.length > 16 ? `${nd.label.slice(0, 15)}…` : nd.label}
                    {amb.has(j) ? ' · ambiguous' : ''}
                  </text>
                </g>
              )
            })}
            {inner.length > 12 && (
              <text x={p.x} y={p.y + p.r - 8} textAnchor="middle" fontSize={10} className="fill-[var(--color-ink-3)]">
                +{inner.length - 12} more
              </text>
            )}
          </g>
        )
      })}
      {hidden > 0 && (
        <text x={0} y={R + 14} textAnchor="middle" fontSize={12} className="fill-[var(--color-ink-3)]" data-map-marks-hidden={hidden}>
          {hidden} smaller {hidden === 1 ? 'entry is' : 'entries are'} not drawn here: Show as list
        </text>
      )}
    </svg>
  )
}

function FocusGraph({ focus, ambiguous, ambiguousIds, onSelect, height }: { focus: Focus; ambiguous: boolean; ambiguousIds: Set<string>; onSelect: (id: string) => void; height: number }) {
  const groups = edgesByKind(focus.node.id, focus.edges, focus.neighbours)
  const all = groups.flatMap((g) => g.rows)
  const allOthers = [...new Set(all.map((r) => r.other))]
  // the picture keeps to FOCUS_MAX neighbours (the card lists every edge read); the rest are counted on it
  const others = allOthers.slice(0, FOCUS_MAX)
  const keep = new Set(others)
  const rows = all.filter((r) => keep.has(r.other))
  const R = 245
  const pos = new Map(others.map((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, others.length) - Math.PI / 2
    return [id, { x: Math.cos(a) * 170, y: Math.sin(a) * 170 }]
  }))
  const label = (id: string) => focus.neighbours.find((n) => n.id === id)?.label ?? id
  const isAmb = (id: string) => ambiguousIds.has(id) || !!focus.neighbours.find((n) => n.id === id)?.ambiguous
  return (
    <svg role="img" aria-label={`${focus.node.label} and ${plural(others.length, 'related item')}`} viewBox={`${-R - 40} ${-R} ${2 * R + 80} ${2 * R}`} width="100%" height={height} data-map-level="focus">
      <defs>
        <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-ink-3)" />
        </marker>
      </defs>
      {rows.map((r) => {
        const o = pos.get(r.other)!
        const [x1, y1, x2, y2] = r.outward ? [0, 0, o.x, o.y] : [o.x, o.y, 0, 0]
        const d = Math.hypot(x2 - x1, y2 - y1) || 1
        const k = 30 / d
        return (
          <g key={r.edge.id} data-edge-kind={r.edge.kind} data-edge-dashed={r.look.dashed ? '1' : '0'}>
            <line x1={x1 + (x2 - x1) * k} y1={y1 + (y2 - y1) * k} x2={x2 - (x2 - x1) * k} y2={y2 - (y2 - y1) * k} stroke={r.look.heuristic ? 'var(--color-warn)' : 'var(--color-ink-3)'} strokeWidth={1.5} strokeDasharray={r.look.dashed ? '6 5' : undefined} markerEnd="url(#map-arrow)" />
            <text x={o.x * 0.55} y={o.y * 0.55 + (Math.abs(o.y) < 20 ? -7 : 0)} textAnchor="middle" fontSize={10} className="fill-[var(--color-ink-2)]" paintOrder="stroke" stroke="var(--color-void)" strokeWidth={3}>
              {r.look.name}
              {r.look.heuristic ? ' · heuristic' : ''}
            </text>
          </g>
        )
      })}
      {allOthers.length > others.length && (
        <text x={0} y={R - 6} textAnchor="middle" fontSize={11} className="fill-[var(--color-ink-3)]" data-map-focus-more>
          {allOthers.length - others.length} more related items are listed in the card
        </text>
      )}
      <g data-map-focus>
        <circle r={28} fill="var(--color-accent)" />
        <text y={5} textAnchor="middle" fontSize={15} className="fill-[var(--color-primary-ink)]">
          {kindGlyph(focus.node.kind)}
        </text>
        <text y={46} textAnchor="middle" fontSize={12} className="fill-[var(--color-ink)] font-semibold">
          {focus.node.label}
          {ambiguous || focus.node.ambiguous ? ' · ambiguous' : ''}
        </text>
      </g>
      {others.map((id) => {
        const o = pos.get(id)!
        return (
          <g key={id} role="button" tabIndex={0} aria-label={`${label(id)}. Open`} className="cursor-pointer outline-none" onClick={() => onSelect(id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(id))}>
            <circle cx={o.x} cy={o.y} r={22} fill="color-mix(in srgb, var(--color-accent) 18%, transparent)" stroke={isAmb(id) ? 'var(--color-warn)' : 'var(--color-line-2)'} strokeDasharray={isAmb(id) ? '3 2' : undefined} />
            <text x={o.x} y={o.y + 38} textAnchor="middle" fontSize={11} className="fill-[var(--color-ink-2)]">
              {label(id).length > 22 ? `${label(id).slice(0, 21)}…` : label(id)}
              {isAmb(id) ? ' · ambiguous' : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** The list equivalent of the picture (also the phone's first view): the same level, as rows; every entry listed. */
export function ItemList({ nodes, scope, selectedId, onScope, onSelect }: { nodes: MapNode[]; scope: string | null; selectedId: string | null; onScope: (m: string | null) => void; onSelect: (id: string) => void }) {
  const amb = ambiguousAt(nodes)
  const groups = childGroups(nodes, scope)
  return (
    <ul className="space-y-1" aria-label={scope === null ? 'Repository map as a list' : `${scope} as a list`} data-map-list>
      {groups.map((g) => {
        const fileIdx = g.kind === 'file' ? (g.items.find((j) => nodes[j].kind === 'file') ?? g.items[0]) : undefined
        const nd = fileIdx !== undefined ? nodes[fileIdx] : null
        return (
          <li key={g.key}>
            <button type="button" data-map-row={g.kind} className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-line px-3 text-left" style={nd && nd.id === selectedId ? { boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined} onClick={() => (g.kind === 'dir' ? onScope(g.key) : nd && onSelect(nd.id))}>
              <Icon name={g.kind === 'dir' ? 'chevron' : 'doc'} size={14} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                {g.label}
                {g.kind === 'dir' ? '/' : ''}
              </span>
              {fileIdx !== undefined && amb.has(fileIdx) && <AmbiguousTag />}
              <span className="text-[11.5px] text-ink-3">{g.kind === 'dir' ? g.items.length : nd?.kind}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------------------------------- node detail

export function RefRow({ r, onOpen }: { r: Ref; onOpen?: () => void }) {
  return (
    <div className="rounded-lg border border-line px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: 'var(--color-accent-2)' }}>
          {r.path}:{r.line}
        </span>
        {onOpen && (
          <button type="button" className="min-h-8 shrink-0 rounded-md px-2 text-[11.5px] text-ink-2 underline-offset-2 hover:underline" onClick={onOpen}>
            Open source
          </button>
        )}
      </div>
      {r.excerpt && <pre className="mt-1 overflow-x-auto font-mono text-[11.5px] whitespace-pre text-ink-2">{r.excerpt}</pre>}
    </div>
  )
}

export function NodeCard({ node, ambiguous, edges, neighbours, truncated, note, unavailable, kindNotes, onSelect, onOpenRef, onMore, moreBusy, onClose }: { node: MapNode; ambiguous: boolean; edges: MapEdge[]; neighbours: MapNode[]; truncated: boolean; note: string | null; unavailable?: string | null; kindNotes?: Record<string, string> | null; onSelect: (id: string) => void; onOpenRef: (r: Ref) => void; onMore?: () => void; moreBusy?: boolean; onClose: () => void }) {
  const groups = edgesByKind(node.id, edges, neighbours)
  const more = truncatedWords(edges.length, truncated)
  return (
    <Panel
      label={`Detail: ${node.label}`}
      tone="var(--color-accent)"
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-normal text-ink-3">{node.kind}</span> {node.label} {(ambiguous || node.ambiguous) && <AmbiguousTag />}
        </span>
      }
      actions={
        <button type="button" aria-label="Close detail" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-ink" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      }
    >
      <div className="space-y-2.5" data-map-detail={node.id}>
        <p className="font-mono text-[11px] text-ink-3 [overflow-wrap:anywhere]">{node.id}</p>
        {node.declaration && (
          <p className="text-[11.5px] text-ink-3" data-map-declaration>
            {Object.entries(node.declaration)
              .map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
              .join(' · ')}
          </p>
        )}
        {unavailable ? <p className="text-ink-3">{unavailable}</p> : null}
        {node.refs.length > 0 && (
          <div className="space-y-1">
            <div className="eyebrow">Source</div>
            {node.refs.map((r, i) => (
              <RefRow key={i} r={r} onOpen={() => onOpenRef(r)} />
            ))}
          </div>
        )}
        {groups.length > 0 && (
          <div className="space-y-2">
            {groups.map((g) => {
              const tests = g.kind === 'test-doc-link' || g.kind === 'test_doc_link'
              return (
                <div key={g.kind} data-edge-group={g.kind}>
                  <div className="eyebrow">{tests ? COPY.relatedTests : g.name}</div>
                  {tests && <p className="text-[11.5px] text-ink-3">{TESTS_NOTE}</p>}
                  {kindNotes?.[g.kind] && <p className="text-[11.5px] text-ink-3" data-map-kind-note={g.kind}>{kindNotes[g.kind]}</p>}
                  <ul className="mt-0.5 space-y-0.5">
                    {g.rows.map((r) => (
                      <li key={r.edge.id} className="flex flex-wrap items-center gap-1.5">
                        <span aria-hidden className="inline-block w-6 border-t-2" style={{ borderStyle: r.look.dashed ? 'dashed' : 'solid', borderColor: r.look.heuristic ? 'var(--color-warn)' : 'var(--color-ink-3)' }} />
                        <span className="text-ink-3">{r.outward ? '→' : '←'}</span>
                        <button type="button" className="min-h-8 min-w-0 truncate text-left text-ink underline-offset-2 hover:underline" onClick={() => onSelect(r.other)}>
                          {r.otherNode?.label ?? r.other}
                        </button>
                        {r.otherNode && r.otherNode.kind !== 'file' && pathOf(r.otherNode) && <span className="truncate font-mono text-[11px] text-ink-4">{pathOf(r.otherNode)}</span>}
                        {r.otherNode?.ambiguous && <AmbiguousTag />}
                        {r.look.heuristic ? <HeuristicTag /> : null}
                        <span className="text-[11px] text-ink-4" title={r.edge.basis_note}>
                          basis: {r.edge.basis}
                          {r.edge.basis_note ? ` — ${r.edge.basis_note}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
        {!unavailable && groups.length === 0 && <p className="text-ink-3">{truncated ? 'No relationships on this page.' : 'No relationships in this answer.'}</p>}
        {note && <p className="text-ink-3" data-map-note>{note}</p>}
        {more && (
          <div className="flex items-center gap-2">
            <span className="text-ink-3" data-map-truncated>{more}</span>
            {onMore && (
              <Button variant="ghost" className="min-h-8 px-2 text-[12px]" disabled={moreBusy} onClick={onMore}>
                More
              </Button>
            )}
          </div>
        )}
      </div>
    </Panel>
  )
}

/** A ref opened at its excerpt, on the canvas: the excerpt the answer carried and nothing else. */
export function SourceCard({ anchor, sha, onClose }: { anchor: Anchor; sha: string; onClose: () => void }) {
  return (
    <Panel
      label="Source"
      tone="var(--color-accent-2)"
      title={anchor.state === 'unavailable' ? <span className="font-mono">{anchor.was.path}</span> : <span className="font-mono">{anchor.ref.path}:{anchor.ref.line}</span>}
      actions={
        <button type="button" aria-label="Close source" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-ink" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      }
    >
      <div data-map-source={anchor.state}>
        {anchor.state === 'moved' && (
          <p className="mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--color-warn)' }} data-map-moved-line>
            <Icon name="alert" size={12} /> {anchor.warning} (was line {anchor.was.line}).
          </p>
        )}
        {anchor.state === 'unavailable' ? (
          <p className="text-ink-3">{anchor.words}</p>
        ) : (
          <pre className="overflow-x-auto rounded-lg border border-line px-2 py-1.5 font-mono text-[12px] whitespace-pre text-ink">
            <span className="mr-3 text-ink-4 select-none">{anchor.ref.line}</span>
            {anchor.ref.excerpt}
          </pre>
        )}
        <p className="mt-1.5 text-[11px] text-ink-4">at revision {short(sha)} · excerpt from the map’s approved bytes only</p>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------- drift

function DriftList({ title, items, mark, color, onOpen }: { title: string; items: DriftItem[]; mark: string; color: string; onOpen: (i: DriftItem) => void }) {
  if (!items.length) return null
  return (
    <div data-drift-list={title}>
      <div className="eyebrow">{title}</div>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((it, i) => (
          <li key={`${it.id}#${i}`} className="flex flex-wrap items-center gap-1.5" title={evidenceWords(it)} data-drift-item={it.id}>
            <span aria-hidden className="w-4 text-center font-semibold" style={{ color }}>
              {mark}
            </span>
            <button type="button" className={cx('min-h-8 min-w-0 truncate text-left text-ink underline-offset-2 hover:underline', title === 'Removed' && 'line-through opacity-70')} onClick={() => onOpen(it)}>
              {driftLabel(it)}
            </button>
            {title === 'Moved' && it.from && <span className="truncate font-mono text-[11px] text-ink-4">from {it.from.label ?? it.from.id}</span>}
            <span className="ml-auto shrink-0 text-[11px] text-ink-4">{evidenceWords(it)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DriftCard({ view, from, to, onOpen, onMore, moreBusy, onClose, note, basisNote, opLine }: { view: DriftView; from: string; to: string; onOpen: (i: DriftItem, side: 'from' | 'to') => void; onMore?: () => void; moreBusy?: boolean; onClose: () => void; note?: string | null; basisNote?: string | null; opLine?: string | null }) {
  return (
    <Panel
      label="Changes"
      title={`Changes since ${short(from)}`}
      actions={
        <button type="button" aria-label="Close changes" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-ink" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      }
    >
      <div className="space-y-2" data-map-drift>
        <p className="text-[13px] text-ink" data-drift-verdict>{view.verdict}</p>
        {opLine && <p style={{ color: 'var(--color-warn)' }} data-map-op-line>{opLine}</p>}
        {basisNote && <p className="text-ink-3" data-map-basis-note>basis: {basisNote}</p>}
        {view.demoted > 0 && <p className="text-ink-3">{view.demoted === 1 ? 'One moved record' : `${view.demoted} moved records`} without a stated basis or both ends {view.demoted === 1 ? 'is' : 'are'} shown as removed and added.</p>}
        {note && <p className="text-ink-3">{note}</p>}
        <DriftList title="Added" items={view.added} mark="+" color="var(--color-good)" onOpen={(i) => onOpen(i, 'to')} />
        <DriftList title="Removed" items={view.removed} mark="−" color="var(--color-bad)" onOpen={(i) => onOpen(i, 'from')} />
        <DriftList title="Changed" items={view.changed} mark="~" color="var(--color-warn)" onOpen={(i) => onOpen(i, 'to')} />
        <DriftList title="Moved" items={view.moved} mark="→" color="var(--color-accent)" onOpen={(i) => onOpen(i, 'to')} />
        <p className="text-[11px] text-ink-4">
          {short(from)} → {short(to)}
        </p>
        {onMore && (
          <Button variant="ghost" className="min-h-8 px-2 text-[12px]" disabled={moreBusy} onClick={onMore}>
            More
          </Button>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------- the Ask's preset

/** Which oneOf group the plan uses now (the first whose parameters are filled), or the first group. */
const groupOf = (p: Preset, plan: Plan): string[] => p.oneOf.find((g) => g.some((k) => (plan.params[k] ?? '') !== '')) ?? p.oneOf[0] ?? []

/** The preset the words became, with its parameters, all visible and editable; nothing runs until Run. */
export function PresetComposer({ words, onWords, plan, why, presets, onPlan, onRun, busy, runWhy }: { words: string; onWords: (w: string) => void; plan: Plan | null; why: string | null; presets: Preset[]; onPlan: (p: Plan) => void; onRun: () => void; busy: boolean; runWhy: string | null }) {
  const preset = plan ? presets.find((p) => p.name === plan.preset) : undefined
  const group = preset && plan ? groupOf(preset, plan) : []
  const inGroups = new Set(preset?.oneOf.flat() ?? [])
  const set = (k: string, v: string) => plan && onPlan({ ...plan, params: { ...plan.params, [k]: v } })
  const input = (d: Preset['params'][number]) => (
    <label key={d.name} className="block min-w-[10rem] flex-1">
      <span className="eyebrow mb-1 block">
        {d.name}
        {d.required || inGroups.has(d.name) ? '' : ' (optional)'}
      </span>
      <input data-map-param={d.name} inputMode={d.type === 'integer' ? 'numeric' : undefined} value={plan?.params[d.name] ?? ''} placeholder={d.description ?? d.type} onChange={(e) => set(d.name, e.target.value)} className="min-h-11 w-full rounded-lg border border-line bg-transparent px-3 font-mono text-[12.5px] text-ink outline-none focus:border-[var(--color-accent)]" />
    </label>
  )
  const depth = preset?.params.find((d) => d.name === 'max_depth')
  return (
    <div className="space-y-2" data-map-composer>
      <label className="block">
        <span className="eyebrow mb-1 block">{COPY.askContext}</span>
        <input data-map-words value={words} onChange={(e) => onWords(e.target.value)} placeholder="e.g. which tests cover pkg/core.py" className="min-h-11 w-full rounded-lg border border-line bg-transparent px-3 text-[13px] text-ink outline-none focus:border-[var(--color-accent)]" />
      </label>
      {why && <p className="text-[12px] text-ink-3" data-map-plan-why>{why}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="eyebrow mb-1 block">Preset</span>
          <select data-map-preset value={plan?.preset ?? ''} onChange={(e) => onPlan({ preset: e.target.value, params: {}, note: null })} className="min-h-11 rounded-lg border border-line bg-[var(--color-glass-2)] px-2 text-[13px] text-ink">
            <option value="" disabled>
              Choose…
            </option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {presetTitle(p.name)}
              </option>
            ))}
          </select>
        </label>
        {preset && preset.oneOf.length > 1 && (
          <fieldset className="block" data-map-oneof={preset.oneOf.map((g) => g.join('+')).join('|')}>
            <legend className="eyebrow mb-1 block">Exactly one of</legend>
            <div className="flex min-h-11 items-center gap-1 rounded-lg border border-line px-1">
              {preset.oneOf.map((g) => {
                const on = g.join() === group.join()
                return (
                  <button key={g.join()} type="button" aria-pressed={on} data-map-oneof-pick={g.join('+')} onClick={() => plan && !on && onPlan({ ...plan, params: Object.fromEntries(Object.entries(plan.params).filter(([k]) => !inGroups.has(k))) , note: plan.note })} className={cx('min-h-9 rounded-md px-2.5 font-mono text-[12px]', on ? 'text-ink' : 'text-ink-3')} style={on ? { boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined}>
                    {g.join(' + ')}
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}
        {preset?.params.filter((d) => (inGroups.has(d.name) ? group.includes(d.name) : d.name !== 'max_depth')).map(input)}
        <Button variant="primary" disabled={!plan || busy} onClick={onRun} data-map-run>
          Run
        </Button>
      </div>
      {preset && depth && (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2" data-map-depth>
          <label className="inline-flex min-h-11 items-center gap-2">
            <input type="checkbox" data-map-direct checked={(plan?.params.max_depth ?? '') === '1'} onChange={(e) => set('max_depth', e.target.checked ? '1' : '')} />
            {DIRECT_ONLY} (max_depth 1)
          </label>
          <label className="inline-flex items-center gap-1.5">
            max_depth
            <input data-map-param="max_depth" inputMode="numeric" value={plan?.params.max_depth ?? ''} placeholder={`all${depth.maximum !== undefined ? ` (≤ ${depth.maximum})` : ''}`} onChange={(e) => set('max_depth', e.target.value)} className="min-h-9 w-24 rounded-lg border border-line bg-transparent px-2 font-mono text-[12.5px] text-ink outline-none" />
          </label>
        </div>
      )}
      {preset?.description && <p className="text-[11.5px] text-ink-3" data-map-preset-description>{preset.description}</p>}
      {preset?.basis_note && <p className="text-[11.5px] text-ink-3" data-map-preset-basis>basis: {preset.basis_note}</p>}
      {(plan?.note || plan?.preset === 'test-doc-links') && <p className="text-[12px]" style={{ color: 'var(--color-warn)' }} data-map-plan-note>{plan?.note ?? TESTS_NOTE}</p>}
      {runWhy && <p className="text-[12px] text-ink-3" data-map-run-why>{runWhy}</p>}
      <p className="text-[11px] text-ink-4">Presets only; raw MeTTa queries are not offered here.</p>
    </div>
  )
}

export function QueryCard({ preset, params, basisNote, state, reason, opLine, nodes, edges, truncated, note, onSelect, onMore, moreBusy, onClose }: { preset: string; params: Record<string, unknown>; basisNote: string | null; state?: string; reason?: string; opLine?: string | null; nodes: MapNode[]; edges: MapEdge[]; truncated: boolean; note: string | null; onSelect: (id: string) => void; onMore?: () => void; moreBusy?: boolean; onClose: () => void }) {
  const more = truncatedWords(nodes.length, truncated)
  const tests = preset === 'test-doc-links'
  return (
    <Panel
      label="Query result"
      title={
        <span>
          {presetTitle(preset)} <span className="font-mono text-[11.5px] font-normal text-ink-3">{Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(' ')}</span>
        </span>
      }
      actions={
        <button type="button" aria-label="Close result" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-ink" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      }
    >
      <div className="space-y-1.5" data-map-query={preset}>
        {tests && <p style={{ color: 'var(--color-warn)' }}>{TESTS_NOTE}</p>}
        {basisNote && <p className="text-ink-3" data-map-basis-note>basis: {basisNote}</p>}
        {opLine ? (
          <p style={{ color: 'var(--color-warn)' }} data-map-op-line>
            {opLine}
          </p>
        ) : state && state !== 'ready' ? (
          <p style={{ color: 'var(--color-warn)' }} data-map-query-state>
            state: {state}
            {reason ? ` · reason: ${reason}` : ''}
          </p>
        ) : null}
        {nodes.length === 0 ? (
          <p className="text-ink-3">{state && state !== 'ready' ? 'Nothing found before the query stopped; that is not the same as nothing there.' : 'Nothing matched.'}</p>
        ) : (
          <ul className="space-y-0.5">
            {nodes.map((n, i) => (
              <li key={`${n.id}#${i}`}>
                <button type="button" className="flex min-h-8 w-full items-center gap-2 text-left" onClick={() => onSelect(n.id)}>
                  <span className="w-12 shrink-0 text-[11px] text-ink-3">{n.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">{n.label}</span>
                  {n.distance !== undefined && (
                    <span className="shrink-0 text-[11px] text-ink-3" data-map-distance={n.distance}>
                      distance {n.distance}
                      {n.distance === 1 ? ' (direct)' : ''}
                    </span>
                  )}
                  <span className="truncate font-mono text-[11px] text-ink-4">{pathOf(n) ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {edges.length > 0 && (
          <ul className="space-y-0.5 border-t border-line pt-1.5">
            {edges.map((e) => {
              const look = edgeLook(e)
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-1.5 text-[11.5px]" data-edge-dashed={look.dashed ? '1' : '0'}>
                  <span aria-hidden className="inline-block w-6 border-t-2" style={{ borderStyle: look.dashed ? 'dashed' : 'solid', borderColor: look.heuristic ? 'var(--color-warn)' : 'var(--color-ink-3)' }} />
                  <span className="font-mono text-ink-3">{e.from}</span>→<span className="font-mono text-ink-3">{e.to}</span>
                  <span>{look.name}</span>
                  {look.heuristic && <HeuristicTag />}
                  <span className="text-ink-4" title={e.basis_note}>
                    basis: {e.basis}
                    {e.basis_note ? ` — ${e.basis_note}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {note && <p className="text-ink-3" data-map-note>{note}</p>}
        {more && (
          <div className="flex items-center gap-2">
            <span className="text-ink-3" data-map-truncated>{more}</span>
            {onMore && (
              <Button variant="ghost" className="min-h-8 px-2 text-[12px]" disabled={moreBusy} onClick={onMore}>
                More
              </Button>
            )}
          </div>
        )}
      </div>
    </Panel>
  )
}
