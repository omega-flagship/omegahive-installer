/**
 * The truth functions the showreel's Reasoning layer shows, taken from the hive's own MeTTa (release 388fd72), never
 * from a textbook: lib_pln.metta (Truth__Deduction :65, Truth__Induction :83, Truth__Abduction :93,
 * Truth__ModusPonens :105, Truth__Revision :117, Truth__c2w :52, Truth__w2c :56) and lib_nal.metta (Truth_Deduction :8,
 * Truth_Revision :92). Two independent readings of each, both checked against PeTTa running the real files
 * (pln.test.ts, petta-reference.json):
 *
 *  1. RULES: each function as a small formula tree (`Ex`). The page typesets the tree, plugs the numbers into the SAME
 *     tree and evaluates it, so what is shown is what is computed. Operand order follows the source exactly, so the
 *     floating-point result is the engine's.
 *  2. TRANSCRIBED: each function written out again as plain TypeScript, guards included (`/safe`, the consistency
 *     conditions, the 0.9999 branch).
 *
 * Formulas as implemented in the hive's pinned NAL/PLN libraries (byte-identical); Patrick may upgrade them in full
 * hive mode.
 */

/** A truth value: strength and confidence. */
export type Stv = [number, number]

/** A formula: a number, a variable, or an operation on formulas. `/` is lib_pln's `/safe` where the source uses it. */
export type Ex = number | string | { op: '+' | '-' | '*' | '/'; a: Ex; b: Ex; safe?: boolean } | { fn: 'min' | 'max'; a: Ex; b: Ex }

const add = (a: Ex, b: Ex): Ex => ({ op: '+', a, b })
const sub = (a: Ex, b: Ex): Ex => ({ op: '-', a, b })
const mul = (a: Ex, b: Ex): Ex => ({ op: '*', a, b })
const div = (a: Ex, b: Ex, safe = false): Ex => ({ op: '/', a, b, ...(safe ? { safe: true } : {}) })
const min = (a: Ex, b: Ex): Ex => ({ fn: 'min', a, b })
const max = (a: Ex, b: Ex): Ex => ({ fn: 'max', a, b })

/** One premise's two variables, named as in the source ($PQs, $PQc), and how they read typeset (s and c, sub PQ). */
export interface Param {
  s: string
  c: string
  /** the subscript shown: s_PQ, c_PQ */
  sub: string
  /** what the premise is, in the rule's own terms */
  role: string
}

export type RuleId = 'Truth__Deduction' | 'Truth__Induction' | 'Truth__Abduction' | 'Truth__ModusPonens' | 'Truth__Revision' | 'Truth_Deduction' | 'Truth_Revision' | 'Truth__c2w' | 'Truth__w2c'

export interface Rule {
  id: RuleId
  name: string
  file: 'lib_pln.metta' | 'lib_nal.metta'
  /** 1-based line of `(= (<id> ...` in that file */
  line: number
  params: Param[]
  /** let-bindings, in order (the source's let* or a named sub-expression) */
  lets: [string, Ex][]
  s: Ex
  c: Ex
  /** a plain note under the formula (a branch or guard the main formula does not show) */
  notes?: string[]
}

const P = (s: string, c: string, sub: string, role: string): Param => ({ s, c, sub, role })

export const RULES: Record<Exclude<RuleId, 'Truth__c2w' | 'Truth__w2c'>, Rule> = {
  Truth__Deduction: {
    id: 'Truth__Deduction',
    name: 'Deduction (PLN)',
    file: 'lib_pln.metta',
    line: 65,
    params: [P('Ps', 'Pc', 'P', 'term P'), P('Qs', 'Qc', 'Q', 'term Q'), P('Rs', 'Rc', 'R', 'term R'), P('PQs', 'PQc', 'PQ', 'P → Q'), P('QRs', 'QRc', 'QR', 'Q → R')],
    lets: [],
    s: add(mul('PQs', 'QRs'), div(mul(sub(1, 'PQs'), sub('Rs', mul('Qs', 'QRs'))), sub(1, 'Qs'), true)),
    c: mul(mul('PQs', 'QRs'), mul('PQc', 'QRc')),
    notes: [
      'Only when both links are consistent with their terms (conditional-probability-consistency, lib_pln.metta:32); otherwise the result is (stv 1 0).',
      'When Q’s strength is above 0.9999 the strength is R’s strength instead (no division by 1 − Q).',
    ],
  },
  Truth__Induction: {
    id: 'Truth__Induction',
    name: 'Induction (PLN)',
    file: 'lib_pln.metta',
    line: 83,
    params: [P('sA', 'cA', 'A', 'term A'), P('sB', 'cB', 'B', 'term B'), P('sC', 'cC', 'C', 'term C'), P('sBA', 'cBA', 'BA', 'link B → A'), P('sBC', 'cBC', 'BC', 'link B → C')],
    lets: [['w', mul(mul('sBC', 'cBC'), 'cBA')]],
    s: add(div(mul(mul('sBA', 'sBC'), 'sB'), 'sA', true), mul(sub(1, div(mul('sBA', 'sB'), 'sA', true)), div(sub('sC', mul('sB', 'sBC')), sub(1, 'sB'), true))),
    c: div('w', add('w', 1), true),
    notes: ['The confidence is Truth__w2c of w (lib_pln.metta:56): c = w / (w + 1).'],
  },
  Truth__Abduction: {
    id: 'Truth__Abduction',
    name: 'Abduction (PLN)',
    file: 'lib_pln.metta',
    line: 93,
    params: [P('sA', 'cA', 'A', 'term A'), P('sB', 'cB', 'B', 'term B'), P('sC', 'cC', 'C', 'term C'), P('sAB', 'cAB', 'AB', 'link A → B'), P('sCB', 'cCB', 'CB', 'link C → B')],
    lets: [['w', mul(mul('sAB', 'cAB'), 'cCB')]],
    s: add(div(mul(mul('sAB', 'sCB'), 'sC'), 'sB', true), div(mul('sC', mul(sub(1, 'sAB'), sub(1, 'sCB'))), sub(1, 'sB'), true)),
    c: div('w', add('w', 1), true),
    notes: ['The confidence is Truth__w2c of w (lib_pln.metta:56): c = w / (w + 1).'],
  },
  Truth__ModusPonens: {
    id: 'Truth__ModusPonens',
    name: 'Modus Ponens (PLN)',
    file: 'lib_pln.metta',
    line: 105,
    params: [P('Ps', 'Pc', 'P', 'P'), P('PQs', 'PQc', 'PQ', 'P → Q')],
    lets: [],
    s: add(mul('Ps', 'PQs'), mul(0.02, sub(1, 'Ps'))),
    c: mul(mul('Ps', 'PQs'), mul('Pc', 'PQc')),
  },
  Truth__Revision: {
    id: 'Truth__Revision',
    name: 'Revision (PLN)',
    file: 'lib_pln.metta',
    line: 117,
    params: [P('f1', 'c1', '1', 'first evidence'), P('f2', 'c2', '2', 'second evidence')],
    lets: [
      ['w1', div('c1', sub(1, 'c1'), true)],
      ['w2', div('c2', sub(1, 'c2'), true)],
      ['w', add('w1', 'w2')],
      ['f', div(add(mul('w1', 'f1'), mul('w2', 'f2')), 'w', true)],
      ['c', div('w', add('w', 1), true)],
    ],
    s: min(1, 'f'),
    c: min(1, max(max('c', 'c1'), 'c2')),
    notes: ['lib_pln caps the confidence at 1.0; lib_nal’s Truth_Revision caps it at 0.99.'],
  },
  Truth_Deduction: {
    id: 'Truth_Deduction',
    name: 'Deduction (NAL)',
    file: 'lib_nal.metta',
    line: 8,
    params: [P('f1', 'c1', '1', 'a → b'), P('f2', 'c2', '2', 'b → c')],
    lets: [],
    s: mul('f1', 'f2'),
    c: mul(mul('f1', 'f2'), mul('c1', 'c2')),
  },
  Truth_Revision: {
    id: 'Truth_Revision',
    name: 'Revision (NAL)',
    file: 'lib_nal.metta',
    line: 92,
    params: [P('f1', 'c1', '1', 'first evidence'), P('f2', 'c2', '2', 'second evidence')],
    lets: [
      ['w1', div('c1', sub(1, 'c1'))],
      ['w2', div('c2', sub(1, 'c2'))],
      ['w', add('w1', 'w2')],
      ['f', div(add(mul('w1', 'f1'), mul('w2', 'f2')), 'w')],
      ['c', div('w', add('w', 1))],
    ],
    s: min(1, 'f'),
    c: min(0.99, max(max('c', 'c1'), 'c2')),
    notes: ['lib_nal caps the confidence at 0.99; lib_pln’s Truth__Revision caps it at 1.0.'],
  },
}

/** Evidence ↔ confidence, lib_pln.metta:52 and :56 (both through /safe). */
export const C2W = { id: 'Truth__c2w' as const, file: 'lib_pln.metta' as const, line: 52, ex: div('c', sub(1, 'c'), true) }
export const W2C = { id: 'Truth__w2c' as const, file: 'lib_pln.metta' as const, line: 56, ex: div('w', add('w', 1), true) }

// ---------------------------------------------------------------- evaluating a tree

/** A /safe whose divisor is not above 0 gives (empty) in MeTTa: no conclusion at all. */
export class Empty extends Error {}

export function evaluate(e: Ex, env: Record<string, number>): number {
  if (typeof e === 'number') return e
  if (typeof e === 'string') {
    if (!(e in env)) throw new Error(`unbound ${e}`)
    return env[e]
  }
  const a = evaluate(e.a, env)
  const b = evaluate(e.b, env)
  if ('fn' in e) return e.fn === 'min' ? Math.min(a, b) : Math.max(a, b)
  switch (e.op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (e.safe && !(b > 0)) throw new Empty()
      return a / b
  }
}

/** The environment of a rule on its premises: every parameter, then every let in order. */
export function bind(rule: Rule, args: Stv[]): Record<string, number> {
  if (args.length !== rule.params.length) throw new Error(`${rule.id} takes ${rule.params.length} premises`)
  const env: Record<string, number> = {}
  rule.params.forEach((p, i) => {
    env[p.s] = args[i][0]
    env[p.c] = args[i][1]
  })
  for (const [name, ex] of rule.lets) env[name] = evaluate(ex, env)
  return env
}

/** Which branch of a rule the inputs take. Only 'main' is the formula shown; the others are named in its notes. */
export type Branch = 'main' | 'inconsistent' | 'q-near-1'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(v, lo))
/** lib_pln.metta:24, :28, :32 */
export const smallestIntersection = (As: number, Bs: number) => clamp((As + Bs - 1) / As, 0, 1)
export const largestIntersection = (As: number, Bs: number) => clamp(Bs / As, 0, 1)
export const consistent = (As: number, Bs: number, ABs: number) => 0 < As && smallestIntersection(As, Bs) <= ABs && ABs <= largestIntersection(As, Bs)

export function branchOf(rule: Rule, args: Stv[]): Branch {
  if (rule.id !== 'Truth__Deduction') return 'main'
  const [[Ps], [Qs], [Rs], [PQs], [QRs]] = args
  if (!(consistent(Ps, Qs, PQs) && consistent(Qs, Rs, QRs))) return 'inconsistent'
  return 0.9999 < Qs ? 'q-near-1' : 'main'
}

/** The conclusion as the page shows it: the tree evaluated on the inputs (main branch only). */
export function conclude(rule: Rule, args: Stv[]): Stv {
  const env = bind(rule, args)
  return [evaluate(rule.s, env), evaluate(rule.c, env)]
}

// ---------------------------------------------------------------- the second reading: straight transcriptions

const safe = (a: number, b: number): number => {
  if (!(b > 0)) throw new Empty()
  return a / b
}
const c2w = (c: number) => safe(c, 1 - c)
const w2c = (w: number) => safe(w, w + 1)

/** Each function written out from the source again, guards and all (independent of the trees above). */
export const TRANSCRIBED: Record<RuleId, (...args: never[]) => Stv | number> = {
  Truth__c2w: (c: number) => c2w(c),
  Truth__w2c: (w: number) => w2c(w),
  Truth__Deduction: (P: Stv, Q: Stv, R: Stv, PQ: Stv, QR: Stv): Stv => {
    const [Ps] = P
    const [Qs] = Q
    const [Rs] = R
    const [PQs, PQc] = PQ
    const [QRs, QRc] = QR
    if (!(consistent(Ps, Qs, PQs) && consistent(Qs, Rs, QRs))) return [1, 0]
    const s = 0.9999 < Qs ? Rs : PQs * QRs + safe((1 - PQs) * (Rs - Qs * QRs), 1 - Qs)
    return [s, PQs * QRs * (PQc * QRc)]
  },
  Truth__Induction: (A: Stv, B: Stv, C: Stv, BA: Stv, BC: Stv): Stv => {
    const [sA] = A
    const [sB] = B
    const [sC] = C
    const [sBA, cBA] = BA
    const [sBC, cBC] = BC
    return [safe(sBA * sBC * sB, sA) + (1 - safe(sBA * sB, sA)) * safe(sC - sB * sBC, 1 - sB), w2c(sBC * cBC * cBA)]
  },
  Truth__Abduction: (A: Stv, B: Stv, C: Stv, AB: Stv, CB: Stv): Stv => {
    const [sB] = B
    const [sC] = C
    const [sAB, cAB] = AB
    const [sCB, cCB] = CB
    void A
    return [safe(sAB * sCB * sC, sB) + safe(sC * ((1 - sAB) * (1 - sCB)), 1 - sB), w2c(sAB * cAB * cCB)]
  },
  Truth__ModusPonens: ([Ps, Pc]: Stv, [PQs, PQc]: Stv): Stv => [Ps * PQs + 0.02 * (1 - Ps), Ps * PQs * (Pc * PQc)],
  Truth__Revision: ([f1, c1]: Stv, [f2, c2]: Stv): Stv => {
    const w1 = c2w(c1)
    const w2 = c2w(c2)
    const w = w1 + w2
    const f = safe(w1 * f1 + w2 * f2, w)
    const c = w2c(w)
    return [Math.min(1.0, f), Math.min(1.0, Math.max(Math.max(c, c1), c2))]
  },
  Truth_Deduction: ([f1, c1]: Stv, [f2, c2]: Stv): Stv => [f1 * f2, f1 * f2 * (c1 * c2)],
  Truth_Revision: ([f1, c1]: Stv, [f2, c2]: Stv): Stv => {
    const w1 = c1 / (1 - c1)
    const w2 = c2 / (1 - c2)
    const w = w1 + w2
    const f = (w1 * f1 + w2 * f2) / w
    const c = w / (w + 1)
    return [Math.min(1.0, f), Math.min(0.99, Math.max(Math.max(c, c1), c2))]
  },
}

/** The evidence count behind a confidence (lib_pln Truth__c2w), or null where c2w has no value (c = 1). */
export function evidenceOf(c: number): number | null {
  try {
    return c2w(c)
  } catch {
    return null
  }
}
