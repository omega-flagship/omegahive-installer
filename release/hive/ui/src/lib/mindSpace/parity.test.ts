// Parity: the same .metta files and the same inputs on MeTTaScript (here) and on the hive's PeTTa (parity/petta.json,
// made by scripts/mind-metta-parity.py the way hive/spaces/service.py runs PeTTa). Numbers agree to 1e-12 (relative);
// everything else exactly, apart from the known engine differences listed in KNOWN, each of which is asserted as it is.
// MIND_PARITY_OUT=<file> writes every case's two answers for PARITY.md.
import { describe, expect, it } from 'vitest'
import { MeTTa } from '@mettascript/hyperon'
import { PETTA_STDLIB_SRC } from '@mettascript/core'
import { MIND_SOURCES } from './sources'
import cases from './parity/cases.json'
import scenario from './parity/scenario.json'
import petta from './parity/petta.json'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

/** Engine differences, asserted exactly as they are (PARITY.md explains each). */
const KNOWN: Record<string, { metta: string[]; why: string }> = {
  'edge-nal Truth_Revision (1.0, 1.0) (0.0, 0.5)': { metta: ['(stv NaN 0.99)'], why: 'c = 1: c2w divides by zero. PeTTa raises; MeTTaScript gives w = Infinity, f = Infinity/Infinity = NaN, c capped 0.99.' },
  'edge-hive hive-truth-revision (1.0, 1.0) (0.0, 0.5)': { metta: ['(stv NaN 0.99)'], why: 'as above' },
  'edge-nal Truth_Revision (0.5, 0.0) (0.5, 0.0)': { metta: ['(stv NaN 0)'], why: 'c = 0 both: f = 0/0. PeTTa raises; MeTTaScript gives NaN.' },
  'edge-hive hive-truth-revision (0.5, 0.0) (0.5, 0.0)': { metta: ['(stv NaN 0)'], why: 'as above' },
  'lib_pln |~ (both orders, unique-atom collapse)': {
    metta: ['(((Inheritance A C) (stv 0.7222222222222223 0.5832)) (|~pln ((Inheritance B C) (stv 0.8 0.9)) ((Inheritance A B) (stv 0.9 0.9))))'],
    why: 'MeTTaScript (Hyperon semantics) returns a call no rule matches unreduced; PeTTa drops it. lib_mind\'s mind-infer filters these.',
  },
  'lib_nal |- deduction': {
    metta: ['(((--> a c) (stv 0.7200000000000001 0.5832)) (|-nal ((--> b c) (stv 0.8 0.9)) ((--> a b) (stv 0.9 0.9))) ((--> c a) (stv 1.0 0.3683678625568469)))'],
    why: 'as above, for lib_nal\'s |-',
  },
  'raw |~pln with no matching rule': {
    metta: ['((|~pln ((Inheritance A B) (stv 0.9 0.9)) ((Inheritance X Y) (stv 0.8 0.9))))'],
    why: 'as above, the raw rule call',
  },
}

const TOKEN = /"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/g
const norm = (t: string) => (t === 'true' ? 'True' : t === 'false' ? 'False' : t)
/** Equal as MeTTa text, numbers to 1e-12 relative. */
function same(a: string, b: string): boolean {
  const x = a.match(TOKEN) ?? []
  const y = b.match(TOKEN) ?? []
  if (x.length !== y.length) return false
  return x.every((t, i) => {
    const u = norm(t)
    const v = norm(y[i])
    if (u === v) return true
    const p = Number(u)
    const q = Number(v)
    return u !== '' && v !== '' && Number.isFinite(p) && Number.isFinite(q) && Math.abs(p - q) <= 1e-12 * Math.max(1, Math.abs(p), Math.abs(q))
  })
}
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => same(x, b[i]))

const m = new MeTTa()
m.run(PETTA_STDLIB_SRC)
for (const [, src] of MIND_SOURCES) m.run(src)
const run = (expr: string): string[] => {
  try {
    return m.run(`!${expr}`)[0].map(String)
  } catch (e) {
    return [`(MeTTaScript-exception ${(e as Error).message.slice(0, 60)})`]
  }
}

type Row = { group: string; name: string; expr: string; metta: string[]; petta: string[]; verdict: 'match' | 'known' | 'MISMATCH'; why?: string }
const rows: Row[] = []
const pc = petta.cases as Record<string, string[]>

describe('parity with PeTTa', () => {
  it('every case', () => {
    for (const c of cases.cases) {
      const metta = run(c.expr)
      const p = pc[c.name]
      expect(p, c.name).toBeDefined()
      const known = KNOWN[c.name]
      const verdict = sameList(metta, p) ? 'match' : known && sameList(metta, known.metta) ? 'known' : 'MISMATCH'
      rows.push({ ...c, metta, petta: p, verdict, ...(known ? { why: known.why } : {}) })
    }
    const bad = rows.filter((r) => r.verdict === 'MISMATCH')
    expect(bad.map((r) => `${r.name}: MeTTaScript ${r.metta.join(' | ')} vs PeTTa ${r.petta.join(' | ')}`)).toEqual([])
    // every known difference is still a difference (else it should leave KNOWN)
    for (const name of Object.keys(KNOWN)) expect(rows.find((r) => r.name === name)?.verdict, name).toBe('known')
  })

  it('the scenario, step by step, and the final spaces', () => {
    const steps = scenario.steps.map((s, i) => ({ i, expr: s, metta: run(s), petta: petta.scenario[i] }))
    // add-atom answers () on MeTTaScript and True on PeTTa: the one bootstrap step compares by count
    const diffs = steps.filter((s) => !sameList(s.metta, s.petta) && !(s.i === 0 && s.metta[0] === '2' && s.petta[0] === '2'))
    expect(diffs.map((d) => `step ${d.i} ${d.expr}: ${d.metta.join(' | ')} vs ${d.petta.join(' | ')}`)).toEqual([])
    const mind = run('(match &mind $x $x)').sort()
    const history = run('(match &history $x $x)').sort()
    expect(sameList(mind, petta.mind), `&mind\n${mind.join('\n')}\nvs\n${petta.mind.join('\n')}`).toBe(true)
    expect(sameList(history, petta.history)).toBe(true)
    if (env.MIND_PARITY_OUT) {
      fs.writeFileSync(env.MIND_PARITY_OUT, JSON.stringify({ engine: { metta: 'MeTTaScript 3.4.0', petta: petta.engine, swipl: petta.swipl }, rows, steps, mind, history }, null, 1))
    }
  })
})
