/**
 * The AtomSpace layer: the atoms a step read and wrote, as two small graphs (before and after). A link atom is drawn
 * as a node joined to the atoms it holds; what is new or changed after the step is marked, in words as well as colour.
 */
import { fmt } from './pln/formulaText'
import { changes, type Change } from './atomChanges'
import type { TraceAtom } from './types'

const short = (t: string) => (t.length > 34 ? `${t.slice(0, 32)}…` : t)

function Graph({ atoms, marks, title }: { atoms: TraceAtom[]; marks?: Record<string, Change>; title: string }) {
  const W = 300
  const H = 190
  const n = atoms.length
  const pos = new Map(atoms.map((a, i) => [a.id, { x: W / 2 + Math.cos((i / Math.max(1, n)) * 2 * Math.PI - Math.PI / 2) * (W / 2 - 60), y: H / 2 + Math.sin((i / Math.max(1, n)) * 2 * Math.PI - Math.PI / 2) * (H / 2 - 26) }]))
  return (
    <figure className="sr-graph">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${atoms.map((a) => a.text).join('; ')}`}>
        {atoms.flatMap((a) =>
          (a.targets ?? []).map((t) => {
            const p = pos.get(a.id)
            const q = pos.get(t)
            return p && q ? <line key={`${a.id}-${t}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="sr-edge" /> : null
          }),
        )}
        {atoms.map((a) => {
          const p = pos.get(a.id)!
          const m = marks?.[a.id] ?? 'same'
          return (
            <g key={a.id} className="sr-atom" data-kind={a.kind} data-change={m}>
              <circle cx={p.x} cy={p.y} r={a.kind === 'link' ? 5 : 7} />
              <text x={p.x} y={p.y - 10} textAnchor="middle">
                {short(a.text)}
              </text>
              {a.stv && (
                <text x={p.x} y={p.y + 16} textAnchor="middle" className="sr-tv">
                  (stv {fmt(a.stv[0])} {fmt(a.stv[1])})
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

export function AtomGraph({ space, before, after }: { space: string; before: TraceAtom[]; after: TraceAtom[] }) {
  const marks = changes(before, after)
  const moved = after.filter((a) => marks[a.id] !== 'same')
  return (
    <div className="sr-atoms">
      <p className="sr-muted">
        Space <code>{space}</code>
      </p>
      <div className="sr-graphs">
        <Graph atoms={before} title="Before" />
        <Graph atoms={after} marks={marks} title="After" />
      </div>
      {moved.length ? (
        <ul className="sr-list" aria-label="Written by this step">
          {moved.map((a) => (
            <li key={a.id}>
              <span className="sr-tag">{marks[a.id] === 'new' ? 'added' : 'changed'}</span> <code>{a.text}</code>
              {a.stv && <code> (stv {fmt(a.stv[0])} {fmt(a.stv[1])})</code>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="sr-muted">This step only read these atoms; nothing was written.</p>
      )}
    </div>
  )
}
