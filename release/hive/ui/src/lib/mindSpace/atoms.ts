/**
 * Between MeTTaScript atoms and plain values. Calls into the space are built as atoms (E/S/ValueAtom), never as
 * source text, so a person's words cannot be parsed as MeTTa: a statement is always one grounded string.
 */
import { E, ExpressionAtom, GroundedAtom, S, SymbolAtom, ValueAtom, VariableAtom, atomToJs, type Atom } from '@mettascript/hyperon'

/** A symbol read back from the space (kept apart from strings: `"b1"` is a string, `b1` a symbol). */
export interface Sym {
  readonly sym: string
}
export type Val = string | number | boolean | Sym | Val[]

export const sym = (name: string): Sym => ({ sym: name })
export const isSym = (v: unknown, name?: string): v is Sym =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Sym).sym === 'string' && (name === undefined || (v as Sym).sym === name)

export function toVal(a: Atom): Val {
  if (a instanceof ExpressionAtom) return a.children().map(toVal)
  if (a instanceof SymbolAtom) {
    const n = a.name()
    return n === 'True' ? true : n === 'False' ? false : sym(n)
  }
  if (a instanceof VariableAtom) return sym(`$${a.name()}`)
  if (a instanceof GroundedAtom) {
    const v = atomToJs(a) as unknown
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  }
  return sym(String(a))
}

/** Plain value to atom: strings are grounded strings, Sym are symbols, arrays are expressions. */
export function toAtom(v: Val): Atom {
  if (Array.isArray(v)) return E(...v.map(toAtom))
  if (typeof v === 'string') return ValueAtom(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('not a finite number')
    return ValueAtom(v)
  }
  if (typeof v === 'boolean') return S(v ? 'True' : 'False')
  return S(v.sym)
}

export const call = (head: string, ...args: Val[]): Atom => E(S(head), ...args.map(toAtom))

/** (stv f c) */
export interface Stv {
  f: number
  c: number
}
export const stvVal = (t: Stv): Val => [sym('stv'), t.f, t.c]
export function readStv(v: Val): Stv {
  if (Array.isArray(v) && v.length === 3 && isSym(v[0], 'stv') && typeof v[1] === 'number' && typeof v[2] === 'number') return { f: v[1], c: v[2] }
  throw new Error(`not a truth value: ${show(v)}`)
}

/** One piece of evidence, lib_hive's (ev agent n). */
export interface Evidence {
  agent: string
  n: number
}
export const evVal = (e: Evidence): Val => [sym('ev'), e.agent, e.n]
export function readStamp(v: Val): Evidence[] {
  if (!Array.isArray(v)) throw new Error(`not a stamp: ${show(v)}`)
  return v.map((e) => {
    if (Array.isArray(e) && e.length === 3 && isSym(e[0], 'ev') && (typeof e[1] === 'string' || isSym(e[1])) && typeof e[2] === 'number')
      return { agent: typeof e[1] === 'string' ? e[1] : e[1].sym, n: e[2] }
    throw new Error(`not evidence: ${show(e)}`)
  })
}

/** MeTTa text of a value (for errors and traces only). */
export function show(v: Val): string {
  if (Array.isArray(v)) return `(${v.map(show).join(' ')})`
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') return v.sym
  return String(v)
}
