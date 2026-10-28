/**
 * The simulator's commons, on the real engine. Every outcome, truth value and stamp the sim's commons holds is decided
 * by the hive's own MeTTa: lib_hive's hive-publish! (the access-list check, the vocabulary check, the duplicate check,
 * then hive-integrate!: revision only of disjoint stamps, else choice; the 0.99 confidence cap), run by MeTTaScript
 * 3.4.0 over the same pinned lib_nal, lib_pln and lib_hive the personal mind loads (lib/mindSpace/sources.ts, checked
 * byte-for-byte by pins.test.ts). Each revision is also checked against lib_nal's Truth_Revision. There is no
 * TypeScript truth arithmetic and no TypeScript outcome here, and no fallback: if the engine cannot start or answers
 * unexpectedly, this throws CommonsEngineError and the commons is unavailable, said plainly.
 *
 * As hive/spaces/service.py does it:
 *  - one commons and one vocabulary space per swarm, one access list;
 *  - statements are parsed by the same restricted grammar as hive/spaces/sexpr.py (symbols, numbers, strings, nested
 *    expressions; no variables, no `!`, no `&` handles, no comments) and passed as real expressions, built atom by atom
 *    (never as MeTTa source text), so lib_hive sees their symbols;
 *  - membership is the access list: grant/revoke add and remove (Grant agent commons $stmt publish), as
 *    _apply_grant/_apply_revoke do; a principal with no grant is denied by hive-publish! itself;
 *  - vocabulary terms are added with hive-vocab-add!; stamps "ev:agent:n" become sorted (ev agent n); truth values are
 *    read back to 6 places.
 * One difference, chosen by the caller and said there: service.publish(open_vocab=True) first adds a member's symbols
 * to the vocabulary; the sim publishes as open_vocab=False, so a term outside the swarm's vocabulary is quarantined.
 *
 * Synchronous, on the page's thread: the sim itself runs there, and the engine is quick (about 15 ms to load the
 * libraries and about 1 ms an assertion, measured in r1). The DATA is invented; the reasoning and the rules are real.
 */
import { MeTTa, E, S, V, ValueAtom, type Atom } from '@mettascript/hyperon'
import { PETTA_STDLIB_SRC } from '@mettascript/core'
import { MIND_SOURCES } from '../../lib/mindSpace/sources'
import { isSym, show, toAtom, toVal, type Val } from '../../lib/mindSpace/atoms'
import type { TruthValue } from '../types'

/** the libraries this engine loads, in order (lib_mind is the personal mind's own and is not needed here) */
export const COMMONS_LIBS = ['lib_nal', 'lib_pln', 'lib_hive'] as const

export type EngineOutcome = 'adopted' | 'revised' | 'chosen' | 'kept' | 'duplicate' | 'quarantined' | 'denied'
export interface Held {
  /** the commons' current belief, read back to 6 places (as service.py's _tv) */
  tv: TruthValue
  /** the same, exactly as the engine holds it (the parity check compares this with PeTTa) */
  exact: TruthValue
  stamp: string[]
  /** hive-sources: agents whose assertions share evidence with the current stamp */
  sources: string[]
  /** every (Chosen stmt kept rejected) the engine has noted for this statement, oldest first */
  choices: { kept: string[]; rejected: string[] }[]
}
export interface Integration {
  outcome: EngineOutcome
  /** the statement's canonical text (sexpr.render) */
  statement: string
  /** for 'quarantined': the symbols outside the swarm's vocabulary, as hive-publish! names them */
  unmapped?: string[]
  /** what the commons holds for the statement after this assertion (null: nothing, e.g. denied before any belief) */
  held: Held | null
}

/** 'invalid': the assertion was refused (as service.py refuses it); 'engine': the engine did not start or misbehaved. */
export class CommonsEngineError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'engine' = 'engine',
  ) {
    super(message)
  }
}
const invalid = (message: string) => new CommonsEngineError(message, 'invalid')

// ---- hive/spaces/sexpr.py, the statement grammar ------------------------------------------------------------------

const SYMBOL = /^[A-Za-z_\-+*/<>=|.:?#'^~%][A-Za-z0-9_\-+*/<>=|.:?#'^~%]*$/
const VARIABLE = /^\$[A-Za-z_][A-Za-z0-9_-]*$/
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
const MAX_DEPTH = 16
const MAX_NODES = 256
const EV = /^ev:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}):(\d{1,12})$/

class Str {
  constructor(readonly s: string) {}
}
type Node = string | number | Str | Node[]

function tokenize(text: string): (string | Str)[] {
  const out: (string | Str)[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) i++
    else if (ch === '(' || ch === ')') {
      out.push(ch)
      i++
    }
    else if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          buf += text[j + 1]
          j += 2
        } else {
          buf += text[j]
          j++
        }
      }
      if (j >= text.length) throw invalid('unterminated string')
      out.push(new Str(buf))
      i = j + 1
    } else if (ch === ';') throw invalid('comments are not allowed')
    else {
      let j = i
      while (j < text.length && !/\s/.test(text[j]) && !'()"'.includes(text[j])) j++
      out.push(text.slice(i, j))
      i = j
    }
  }
  return out
}

/** sexpr.parse(text, allow_vars=False) */
function parse(text: string): Node {
  const tokens = tokenize(String(text))
  if (!tokens.length) throw invalid('empty expression')
  let pos = 0
  let nodes = 0
  const atom = (tok: string | Str): Node => {
    if (tok instanceof Str) return tok
    if (NUMBER.test(tok)) return Number(tok)
    if (VARIABLE.test(tok)) throw invalid(`variables are not allowed here: ${tok}`)
    if (SYMBOL.test(tok)) return tok
    throw invalid(`symbol not allowed: ${JSON.stringify(tok)}`)
  }
  const read = (depth: number): Node => {
    if (++nodes > MAX_NODES) throw invalid('expression too large')
    if (depth > MAX_DEPTH) throw invalid('expression too deep')
    if (pos >= tokens.length) throw invalid('unexpected end')
    const tok = tokens[pos++]
    if (tok === '(') {
      const items: Node[] = []
      for (;;) {
        if (pos >= tokens.length) throw invalid('missing )')
        if (tokens[pos] === ')') {
          pos++
          return items
        }
        items.push(read(depth + 1))
      }
    }
    if (tok === ')') throw invalid('unexpected )')
    return atom(tok)
  }
  const value = read(0)
  if (pos !== tokens.length) throw invalid('trailing input after expression')
  return value
}

/** sexpr.render (numbers as JS prints them; the sim's statements hold none) */
function render(n: Node): string {
  if (Array.isArray(n)) return `(${n.map(render).join(' ')})`
  if (n instanceof Str) return `"${n.s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return String(n)
}

const nodeAtom = (n: Node): Atom => (Array.isArray(n) ? E(...n.map(nodeAtom)) : n instanceof Str ? ValueAtom(n.s) : typeof n === 'number' ? ValueAtom(n) : S(n))

/** sexpr.safe_statement: a non-empty expression, as its canonical text and as an atom. */
export function statementOf(text: string): { text: string; atom: Atom; symbols: string[] } {
  const v = parse(text)
  if (!Array.isArray(v) || !v.length) throw invalid('a statement must be a non-empty expression')
  const symbols: string[] = []
  const walk = (n: Node) => (Array.isArray(n) ? n.forEach(walk) : typeof n === 'string' && symbols.push(n))
  walk(v)
  return { text: render(v), atom: nodeAtom(v), symbols: [...new Set(symbols)] }
}

/** sexpr.safe_symbol */
function symbolOf(name: string): string {
  if (typeof name !== 'string' || !SYMBOL.test(name)) throw invalid(`symbol not allowed: ${JSON.stringify(name)}`)
  return name
}

/** lib_hive's structural symbols (hive-structural?): never vocabulary terms */
export const STRUCTURAL: ReadonlySet<string> = new Set(['-->', '<->', '==>', '<=>', '&&', '||', '--', 'stv'])

// ---- values ---------------------------------------------------------------------------------------------------------

/** As service.py's _tv: read back to 6 places. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

function checkTv(tv: TruthValue): void {
  // service.py: need 0 <= f <= 1 and 0 < c < 1
  if (!tv || !Number.isFinite(tv.f) || !Number.isFinite(tv.c) || tv.f < 0 || tv.f > 1 || tv.c <= 0 || tv.c >= 1) throw invalid('need 0 <= f <= 1 and 0 < c < 1')
}

/** "ev:agent:n" → (ev agent n), as service.py's _stamp_atoms (sorted by its text). */
function stampAtom(stamp: string[]): Atom {
  if (!Array.isArray(stamp) || stamp.length === 0) throw invalid('a stamp needs at least one evidence id')
  const parts = stamp.map((s) => {
    const m = EV.exec(String(s))
    if (!m) throw invalid(`bad evidence id ${JSON.stringify(s)} (want ev:agent:n)`)
    return { text: `(ev ${m[1]} ${Number(m[2])})`, atom: E(S('ev'), S(m[1]), ValueAtom(Number(m[2]))) }
  })
  parts.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
  return E(...parts.map((p) => p.atom))
}

/** (ev agent n) list → "ev:agent:n", as service.py's _stamp_json. */
function readStampText(v: Val): string[] {
  if (!Array.isArray(v)) throw new CommonsEngineError(`not a stamp: ${show(v)}`)
  return v.map((e) => {
    if (Array.isArray(e) && e.length === 3 && isSym(e[0], 'ev') && isSym(e[1]) && typeof e[2] === 'number') return `ev:${e[1].sym}:${e[2]}`
    throw new CommonsEngineError(`not evidence: ${show(e)}`)
  })
}

function readTv(v: Val): TruthValue {
  if (Array.isArray(v) && v.length === 3 && isSym(v[0], 'stv') && typeof v[1] === 'number' && typeof v[2] === 'number') return { f: v[1], c: v[2] }
  throw new CommonsEngineError(`not a truth value: ${show(v)}`)
}

const names = (v: Val): string[] => (Array.isArray(v) ? v.map((x) => (isSym(x) ? x.sym : String(x))) : [])
const stvAtom = (tv: TruthValue) => E(S('stv'), ValueAtom(tv.f), ValueAtom(tv.c))
const OUTCOMES: readonly EngineOutcome[] = ['adopted', 'revised', 'chosen', 'kept', 'duplicate', 'quarantined', 'denied']

interface SwarmSpaces {
  commons: Atom
  vocab: Atom
}

/**
 * Everything the engine holds, as plain values: per swarm, the commons' atoms (Current, Asserted, Chosen) and the
 * vocabulary's (Term) in the order the spaces hold them, and its members (grants). Made by exportState from the engine
 * itself; restore() loads it into a NEW engine. Used by the sim's seed cache (SimClient): a seed the engine has already
 * run in this process is loaded, not recomputed; the state is always the engine's own answer.
 */
export interface CommonsState {
  swarms: { id: string; commons: Val[]; vocab: Val[]; members: string[] }[]
}

const noVariables = (v: Val): void => {
  if (Array.isArray(v)) v.forEach(noVariables)
  else if (isSym(v) && v.sym.startsWith('$')) throw new CommonsEngineError(`a stored atom holds a variable: ${v.sym}`)
}

export class SimCommons {
  private readonly m: MeTTa
  private readonly acl: Atom
  private readonly swarms = new Map<string, SwarmSpaces>()

  private constructor() {
    try {
      this.m = new MeTTa()
      this.m.run(PETTA_STDLIB_SRC)
      for (const name of COMMONS_LIBS) {
        const src = MIND_SOURCES.find(([n]) => n === name)?.[1]
        if (!src) throw new Error(`${name} is missing`)
        this.m.run(src)
      }
      this.acl = this.newSpace()
    } catch (e) {
      throw new CommonsEngineError(`the MeTTa engine did not start: ${String((e as Error)?.message ?? e)}`)
    }
  }

  /** Load the engine and the libraries. Throws CommonsEngineError when it cannot. */
  static start(): SimCommons {
    return new SimCommons()
  }

  /** A new engine holding exactly `state` (see CommonsState). */
  static restore(state: CommonsState): SimCommons {
    const e = new SimCommons()
    for (const sw of state.swarms) {
      const sp = e.spaces(sw.id)
      for (const a of sw.commons) e.one(E(S('add-atom'), sp.commons, toAtom(a)))
      for (const a of sw.vocab) e.one(E(S('add-atom'), sp.vocab, toAtom(a)))
      for (const m of sw.members) e.grant(m, sw.id)
    }
    return e
  }

  private atomsOf(space: Atom): Val[] {
    const v = this.one(E(S('collapse'), E(S('match'), space, V('x'), V('x'))))
    const out = Array.isArray(v) ? v : []
    out.forEach(noVariables)
    return out
  }

  /** The engine's whole state, as plain values (a deep copy: nothing in it is shared with the engine). */
  exportState(): CommonsState {
    return { swarms: [...this.swarms.entries()].map(([id, sp]) => ({ id, commons: this.atomsOf(sp.commons), vocab: this.atomsOf(sp.vocab), members: this.members(id) })) }
  }

  private newSpace(): Atom {
    const out = this.m.run('!(new-space)')
    const a = out?.[0]?.[0]
    if (!a || out[0].length !== 1) throw new CommonsEngineError('new-space answered nothing')
    return a
  }

  private one(atom: Atom): Val {
    let out: Atom[]
    try {
      out = this.m.evaluateAtom(atom)
    } catch (e) {
      throw new CommonsEngineError(`the engine failed on ${String(atom).slice(0, 80)}: ${String((e as Error)?.message ?? e)}`)
    }
    if (out.length !== 1) throw new CommonsEngineError(`${String(atom).slice(0, 80)} answered ${out.length} times`)
    const v = toVal(out[0])
    if (Array.isArray(v) && isSym(v[0], 'Error')) throw new CommonsEngineError(show(v).slice(0, 200))
    return v
  }

  private spaces(swarmId: string): SwarmSpaces {
    let s = this.swarms.get(swarmId)
    if (!s) {
      s = { commons: this.newSpace(), vocab: this.newSpace() }
      this.swarms.set(swarmId, s)
    }
    return s
  }

  private grantAtom(agentId: string, sp: SwarmSpaces): Atom {
    return E(S('Grant'), S(symbolOf(agentId)), sp.commons, V('stmt'), S('publish'))
  }

  // ---- membership: the access list (service.py grant / revoke / is_member) ---------------------------------------

  /** The principals granted publish on this swarm's commons, sorted. */
  members(swarmId: string): string[] {
    const sp = this.spaces(swarmId)
    return [...new Set(names(this.one(E(S('collapse'), E(S('match'), this.acl, E(S('Grant'), V('a'), sp.commons, V('s'), S('publish')), V('a'))))))].sort()
  }

  isMember(agentId: string, swarmId: string): boolean {
    const sp = this.spaces(swarmId)
    const v = this.one(E(S('collapse'), E(S('match'), this.acl, E(S('Grant'), S(symbolOf(agentId)), sp.commons, V('s'), S('publish')), S('True'))))
    return Array.isArray(v) && v.length > 0
  }

  /** service.py grant: (Grant agent &commons_s $stmt publish), once. */
  grant(agentId: string, swarmId: string): void {
    if (this.isMember(agentId, swarmId)) return
    this.one(E(S('add-atom'), this.acl, this.grantAtom(agentId, this.spaces(swarmId))))
  }

  /** service.py revoke: (remove-atom &hive_acl (Grant agent &commons_s $stmt publish)). */
  revoke(agentId: string, swarmId: string): void {
    this.one(E(S('remove-atom'), this.acl, this.grantAtom(agentId, this.spaces(swarmId))))
    if (this.isMember(agentId, swarmId)) throw new CommonsEngineError(`revoke left ${agentId} granted`)
  }

  /** Make the access list hold exactly these members (grants the new, revokes the gone). */
  setMembers(swarmId: string, agentIds: readonly string[]): void {
    const want = new Set(agentIds)
    const have = this.members(swarmId)
    for (const a of have) if (!want.has(a)) this.revoke(a, swarmId)
    for (const a of want) if (!have.includes(a)) this.grant(a, swarmId)
  }

  // ---- vocabulary (service.py add_vocab / vocab) ----------------------------------------------------------------

  /** The swarm's vocabulary, sorted (service.py vocab). */
  vocab(swarmId: string): string[] {
    const sp = this.spaces(swarmId)
    return names(this.one(E(S('collapse'), E(S('match'), sp.vocab, E(S('Term'), V('t')), V('t'))))).sort()
  }

  /** hive-vocab-add! for each term (symbols only); answers the vocabulary. */
  addVocab(swarmId: string, terms: readonly string[], agentId = 'hive'): string[] {
    const sp = this.spaces(swarmId)
    for (const t of terms) this.one(E(S('hive-vocab-add!'), sp.vocab, S(symbolOf(t)), S(symbolOf(agentId))))
    return this.vocab(swarmId)
  }

  // ---- truth --------------------------------------------------------------------------------------------------------

  /** lib_nal's Truth_Revision, exactly as the engine computes it. */
  revise(a: TruthValue, b: TruthValue): TruthValue {
    return readTv(this.one(E(S('Truth_Revision'), stvAtom(a), stvAtom(b))))
  }

  private current(sp: SwarmSpaces, stmt: Atom): { tv: TruthValue; stamp: string[] } | null {
    const v = this.one(E(S('collapse'), E(S('match'), sp.commons, E(S('Current'), stmt, V('t'), V('s')), E(V('t'), V('s')))))
    if (!Array.isArray(v) || v.length === 0) return null
    if (v.length !== 1) throw new CommonsEngineError(`more than one Current for ${String(stmt)}`)
    const [t, s] = v[0] as Val[]
    return { tv: readTv(t), stamp: readStampText(s) }
  }

  /**
   * One principal's assertion into a swarm's commons: lib_hive's hive-publish! (access list, vocabulary, duplicate,
   * then hive-integrate!). Every outcome is the engine's, and so is the belief it then holds.
   */
  publish(swarmId: string, agentId: string, statement: string, tv: TruthValue, stamp: string[]): Integration {
    symbolOf(agentId)
    const st = statementOf(statement)
    checkTv(tv)
    const evidence = stampAtom(stamp)
    const sp = this.spaces(swarmId)
    const before = this.current(sp, st.atom)
    const r = this.one(E(S('hive-publish!'), sp.commons, sp.vocab, this.acl, S(agentId), st.atom, stvAtom(tv), evidence))
    const outcome = (isSym(r) ? r.sym : Array.isArray(r) && isSym(r[0]) ? r[0].sym : '') as EngineOutcome
    if (!OUTCOMES.includes(outcome)) throw new CommonsEngineError(`unexpected publish result ${show(r)}`)
    const now = this.current(sp, st.atom)
    if (outcome === 'revised') {
      // lib_hive's hive-truth-revision is a copy of lib_nal's Truth_Revision: hold the engine to that, every time
      const nal = this.revise(before!.tv, tv)
      if (!now || nal.f !== now.tv.f || nal.c !== now.tv.c) throw new CommonsEngineError(`hive-integrate! revised to ${JSON.stringify(now?.tv)} but Truth_Revision gives ${JSON.stringify(nal)}`)
    }
    if (outcome !== 'denied' && outcome !== 'quarantined' && !now) throw new CommonsEngineError(`no Current for the statement after ${outcome}`)
    let held: Held | null = null
    if (now) {
      const chosen = this.one(E(S('collapse'), E(S('match'), sp.commons, E(S('Chosen'), st.atom, V('k'), V('r')), E(V('k'), V('r')))))
      held = {
        tv: { f: round6(now.tv.f), c: round6(now.tv.c) },
        exact: now.tv,
        stamp: now.stamp,
        sources: names(this.one(E(S('hive-sources'), sp.commons, st.atom))),
        choices: Array.isArray(chosen) ? chosen.map((p) => ({ kept: readStampText((p as Val[])[0]), rejected: readStampText((p as Val[])[1]) })) : [],
      }
    }
    return { outcome, statement: st.text, ...(outcome === 'quarantined' && Array.isArray(r) ? { unmapped: names(r[1]) } : {}), held }
  }
}
