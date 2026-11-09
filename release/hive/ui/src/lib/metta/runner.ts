import { E, MeTTa, S, type Atom } from '@mettascript/hyperon'
import { PETTA_STDLIB_SRC } from '@mettascript/core'
import { isSym, show, toVal, type Val } from '../mindSpace/atoms'
import { plural } from '../plural'

/**
 * One MeTTaScript runner over a fixed list of the repo's own `.metta` sources: the page's parts space
 * (experiences/parts/space.ts) and its screens space (screens/space.ts) open the same way and ask the same way.
 * Sources are only ever repo files; every call is built as atoms (E/S/ValueAtom), never as source text.
 */
export class AtomRunner {
  readonly m: MeTTa
  readonly loadMs: number

  constructor(sources: readonly (readonly [string, string])[], private readonly fail: new (message: string) => Error) {
    const t0 = typeof performance === 'undefined' ? Date.now() : performance.now()
    this.m = new MeTTa()
    this.m.run(PETTA_STDLIB_SRC)
    for (const [, src] of sources) this.m.run(src)
    this.loadMs = (typeof performance === 'undefined' ? Date.now() : performance.now()) - t0
  }

  /** Evaluate one read-only call and read its single answer; an (Error …) answer or any other count is refused. */
  query(head: string, ...args: Atom[]): Val {
    const out = this.m.evaluateAtom(E(S(head), ...args))
    if (out.length !== 1) throw new this.fail(`${head} answered ${plural(out.length, 'time')}`)
    const v = toVal(out[0])
    if (Array.isArray(v) && isSym(v[0], 'Error')) throw new this.fail(show(v).slice(0, 200))
    return v
  }
}

/** A symbol's name, a string as itself, anything else as MeTTa text. */
export const symName = (v: Val): string => (isSym(v) ? v.sym : typeof v === 'string' ? v : show(v))
