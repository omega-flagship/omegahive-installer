/**
 * Who takes what: one lane per assignee (any number: a team, one specialist mind, a capability any able mind may take, a
 * whole hive, or one still being found), each headed by its own orb, its pieces as cards in the order they can be built,
 * and the dependency threads between cards drawn over the board. Lanes flow as columns that wrap. Presentation only: the
 * lanes and their words come from the plan model (assigneeLanes, pieceRows). Reduced motion: orbs are still.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../../lib/cx'
import type { Assignee, PlanView } from './contract'
import { assigneeLanes, type AssigneeLane, type Edge, type PieceRow } from './planModel'

/** a stable hue for an assignee without a mind of its own (a team, a capability, a hive) */
export function hueOf(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

const KIND_WORDS: Record<string, string> = { team: 'team', mind: 'specialist', capability: 'any able mind', hive: 'a whole hive', open: 'open' }
/** what kind of assignee it is, in plain words ("team", "specialist", "finding who takes it…") */
export function assigneeKind(a: Assignee): string {
  if (!a.resolved || a.kind === 'open') return 'finding who takes it…'
  return KIND_WORDS[a.kind] ?? String(a.kind).replace(/[-_]+/g, ' ')
}
const ACTIVE = new Set(['building', 'testing', 'fixing', 'review'])

/** An assignee's orb: a team's glow, a mind in its own hue, a hive's constellation, or a soft open ring while it is found. */
export function AssigneeOrb({ assignee, hue, active, reduced, size = 30 }: { assignee: Assignee; hue?: number; active: boolean; reduced: boolean; size?: number }) {
  const open = !assignee.resolved || assignee.kind === 'open'
  const form = open ? 'open' : assignee.kind === 'hive' ? 'hive' : assignee.kind === 'mind' ? 'mind' : 'team'
  return (
    <span className={cx('pb-orb', active && !reduced && 'pb-orb-live')} data-form={form} data-active={active || undefined} aria-hidden="true"
      style={{ ['--mind-hue' as string]: String(hue ?? hueOf(assignee.display)), width: size, height: size }}>
      {form === 'hive' && <><i /><i /><i /><i /><i /></>}
    </span>
  )
}

function Card({ row, after, reduced }: { row: PieceRow; after: string[]; reduced: boolean }) {
  const live = ACTIVE.has(row.phase)
  return (
    <li className="pb-card" data-piece={row.id} data-phase={row.phase} aria-current={live ? 'step' : undefined}
      style={row.builder ? { ['--mind-hue' as string]: String(row.builder.hue) } : undefined}>
      <p className="pb-card-title">{row.title}</p>
      {row.files.length > 0 && <p className="pb-files">{row.files.map((f) => <span key={f} className="pb-file">{f}</span>)}</p>}
      <p className="pb-words">
        {live && row.builder && <span className={cx('pb-dot', !reduced && 'pb-dot-live')} aria-hidden="true" />}
        {row.words}
      </p>
      {(row.repairs > 0 || after.length > 0) && (
        <p className="pb-meta">
          {after.length > 0 && <span className="pb-after">after {after.join(' and ')}</span>}
          {row.repairs > 0 && <span className="pb-fixed">{row.repairs === 1 ? 'fixed once' : `fixed ${row.repairs} times`}</span>}
        </p>
      )}
    </li>
  )
}

function Lane({ lane, titles, reduced }: { lane: AssigneeLane; titles: Map<string, string>; reduced: boolean }) {
  const working = lane.pieces.filter((p) => ACTIVE.has(p.phase))
  const builder = working.find((p) => p.builder)?.builder ?? null
  const mindHue = lane.assignee.kind === 'mind' ? lane.pieces.find((p) => p.builder)?.builder?.hue : undefined
  const now = builder ? `${builder.name} · ${working.length === 1 ? working[0].title.toLowerCase() : `${working.length} pieces`}` : lane.pieces.every((p) => p.phase === 'integrated') ? 'all in' : null
  return (
    <section className="pb-lane" aria-label={`${lane.assignee.display}: ${lane.pieces.length === 1 ? 'one piece' : `${lane.pieces.length} pieces`}`} data-open={!lane.assignee.resolved || undefined}>
      <header className="pb-lane-head">
        <AssigneeOrb assignee={lane.assignee} hue={mindHue} active={working.length > 0} reduced={reduced} />
        <span className="pb-lane-names">
          <span className="pb-lane-name">{lane.assignee.display}</span>
          <span className="pb-lane-kind">{now ?? assigneeKind(lane.assignee)}</span>
        </span>
      </header>
      <ol className="pb-cards">
        {lane.pieces.map((r) => <Card key={r.id} row={r} reduced={reduced} after={r.deps.map((d) => titles.get(d)).filter((t): t is string => !!t).map((t) => t.toLowerCase())} />)}
      </ol>
    </section>
  )
}

/** the threads between cards, measured from where the cards are drawn (none until there is a layout to measure) */
function useThreads(board: React.RefObject<HTMLDivElement | null>, edges: Edge[], key: string): { d: string; id: string }[] {
  const [paths, setPaths] = useState<{ d: string; id: string }[]>([])
  // the edges by value (a new array each render must not re-measure, or the measure's own update loops)
  const edgeSig = edges.map((e) => `${e.from}>${e.to}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by value: the same edges keep the same array
  const stable = useMemo(() => edges, [edgeSig])
  useLayoutEffect(() => {
    const keep = (next: { d: string; id: string }[]) => setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.d === next[i].d) ? prev : next))
    const el = board.current
    if (!el || typeof el.querySelector !== 'function') return
    const measure = () => {
      const box = el.getBoundingClientRect()
      if (!box.width) return keep([])
      const at = (id: string) => el.querySelector(`[data-piece="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null
      const out: { d: string; id: string }[] = []
      for (const e of stable) {
        const a = at(e.from)
        const b = at(e.to)
        if (!a || !b || !a.width || !b.width) continue
        const sameColumn = Math.abs(a.left - b.left) < 8
        const [x1, y1, x2, y2] = sameColumn
          ? [a.left + 18 - box.left, a.bottom - box.top, b.left + 18 - box.left, b.top - box.top]
          : a.left < b.left
            ? [a.right - box.left, a.top + a.height / 2 - box.top, b.left - box.left, b.top + b.height / 2 - box.top]
            : [a.left - box.left, a.top + a.height / 2 - box.top, b.right - box.left, b.top + b.height / 2 - box.top]
        const bend = sameColumn ? Math.max(12, (y2 - y1) / 2) : Math.max(16, Math.abs(x2 - x1) / 2)
        out.push({ id: `${e.from}>${e.to}`, d: sameColumn
          ? `M${x1},${y1} C${x1 - 14},${y1 + bend} ${x2 - 14},${y2 - bend} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + Math.sign(x2 - x1) * bend},${y1} ${x2 - Math.sign(x2 - x1) * bend},${y2} ${x2},${y2}` })
      }
      keep(out)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [board, stable, key])
  return paths
}

export function PlanBoard({ view, reduced }: { view: PlanView; reduced: boolean }) {
  const { lanes, edges } = assigneeLanes(view)
  const titles = new Map(view.pieces.map((p) => [p.id, p.title]))
  const board = useRef<HTMLDivElement>(null)
  const layoutKey = lanes.map((l) => `${l.key}:${l.pieces.map((p) => `${p.id}.${p.phase}.${p.words.length}`).join(',')}`).join('|')
  const threads = useThreads(board, edges, layoutKey)
  return (
    <div className="pb" ref={board} data-lanes={lanes.length} data-reduced={reduced || undefined} role="group" aria-label="Who is making what">
      <svg className="pb-threads" aria-hidden="true">
        {threads.map((t) => <path key={t.id} d={t.d} />)}
      </svg>
      {lanes.map((l) => <Lane key={l.key} lane={l} titles={titles} reduced={reduced} />)}
    </div>
  )
}
