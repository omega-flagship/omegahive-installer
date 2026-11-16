/**
 * A formula from rules.ts, typeset with plain HTML and CSS (no maths library): fractions stacked, subscripts, the
 * source's own operand order. `values` plugs numbers into the very same tree (what is shown is what is computed).
 */
import type { ReactNode } from 'react'
import type { Ex } from './rules'
import { fmt, prec, rounded, type Names } from './formulaText'

function Var({ name, names }: { name: string; names: Names }) {
  const n = names[name] ?? { sym: name }
  return (
    <span className="pln-var">
      <i>{n.sym}</i>
      {n.sub && <sub>{n.sub}</sub>}
    </span>
  )
}

function Num({ n }: { n: number }) {
  return (
    <span className="pln-num" title={rounded(n) ? String(n) : undefined}>
      {fmt(n)}
    </span>
  )
}

/** Render a tree; with `values`, each variable shows its number instead. */
export function Tex({ e, names, values }: { e: Ex; names: Names; values?: Record<string, number> }): ReactNode {
  if (typeof e === 'number') return <Num n={e} />
  if (typeof e === 'string') return values && e in values ? <Num n={values[e]} /> : <Var name={e} names={names} />
  const a = <Tex e={e.a} names={names} values={values} />
  const b = <Tex e={e.b} names={names} values={values} />
  if ('fn' in e)
    return (
      <span className="pln-fn">
        {e.fn}(<span>{a}</span>,{'\u00a0'}<span>{b}</span>)
      </span>
    )
  if (e.op === '/')
    return (
      <span className="pln-frac" role="group" aria-label="fraction">
        <span className="pln-frac-n">{a}</span>
        <span className="pln-frac-d">{b}</span>
      </span>
    )
  const p = prec(e)
  // left-associative: a right operand of equal precedence keeps its brackets for − (and for · it never matters)
  const wrapA = prec(e.a) < p
  const wrapB = prec(e.b) < p || (e.op === '-' && prec(e.b) === p)
  const sign = e.op === '*' ? '·' : e.op === '-' ? '−' : '+'
  return (
    <span className="pln-op">
      {wrapA ? <>({a})</> : a}
      <span className="pln-sign"> {sign} </span>
      {wrapB ? <>({b})</> : b}
    </span>
  )
}

