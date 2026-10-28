/** How the formulas read as text: numbers, variable names, precedence, and the whole tree as plain text. */
import type { Ex, Rule } from './rules'

/** A number as the page shows it: up to 4 decimals; the exact value is in its title. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Number.isInteger(n)) return String(n)
  const r = Number(n.toFixed(4))
  return String(r)
}
/** Whether fmt() rounded it (the page then marks it ≈ and keeps the exact value in the title). */
export const rounded = (n: number): boolean => Number.isFinite(n) && fmt(n) !== String(n)

/** How a variable reads typeset: its letter and subscript. */
export type Names = Record<string, { sym: string; sub?: string }>

export function namesOf(rule: Pick<Rule, 'params' | 'lets'>): Names {
  const out: Names = {}
  for (const p of rule.params) {
    out[p.s] = { sym: /^f/.test(p.s) ? 'f' : 's', sub: p.sub }
    out[p.c] = { sym: 'c', sub: p.sub }
  }
  for (const [name] of rule.lets) {
    const m = /^([a-z])(\d*)$/.exec(name)
    out[name] = m ? { sym: m[1], ...(m[2] ? { sub: m[2] } : {}) } : { sym: name }
  }
  return out
}

export const prec = (e: Ex): number => (typeof e === 'number' || typeof e === 'string' ? 9 : 'fn' in e ? 9 : e.op === '+' || e.op === '-' ? 1 : e.op === '/' ? 9 : 2)

/** The same tree as plain text (screen readers, tests): "s = PQs·QRs + …". */
export function texText(e: Ex, values?: Record<string, number>): string {
  if (typeof e === 'number') return fmt(e)
  if (typeof e === 'string') return values && e in values ? fmt(values[e]) : e
  const a = texText(e.a, values)
  const b = texText(e.b, values)
  if ('fn' in e) return `${e.fn}(${a}, ${b})`
  if (e.op === '/') return `(${a}) / (${b})`
  const p = prec(e)
  const wa = prec(e.a) < p ? `(${a})` : a
  const wb = prec(e.b) < p || (e.op === '-' && prec(e.b) === p) ? `(${b})` : b
  return `${wa} ${e.op === '*' ? '·' : e.op === '-' ? '−' : '+'} ${wb}`
}
