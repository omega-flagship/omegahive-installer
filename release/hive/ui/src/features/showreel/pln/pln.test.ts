// The showreel's PLN maths against the hive's own MeTTa (Surface demo D4). Every number the Reasoning layer shows is
// computed twice in TypeScript (the typeset formula tree, and a plain transcription of the source) and both must equal
// what PeTTa returns when it runs the REAL lib_pln.metta / lib_nal.metta on the same inputs (petta-reference.json,
// written by scripts/showreel-pln-reference.py, the approach of scripts/mind-metta-parity.py). The reference is bound to
// the exact files (sha256) and to the exact inputs (each case's MeTTa expression), and every formula is bound to its
// source line. Formulas as implemented in the hive's pinned NAL/PLN libraries (byte-identical); Patrick may upgrade
// them in full hive mode.
import { describe, expect, it } from 'vitest'
import ref from './petta-reference.json'
import { branchOf, RULES, TRANSCRIBED, type Stv } from './rules'
import { ALL_CASES, argsOf, CASES, computed, ruleOf, type WorkedCase } from './worked'
import { texText } from './formulaText'
import { SCENES } from '../scenes'

const fsName = 'node:fs'
const cryptoName = 'node:crypto'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e?: 'utf8') => string & Uint8Array }
const { createHash } = (await import(/* @vite-ignore */ cryptoName)) as { createHash: (a: string) => { update: (d: Uint8Array) => { digest: (e: 'hex') => string } } }
// src/features/showreel/pln → the repository root (lib_pln.metta and lib_nal.metta live there)
const REPO = new URL('../../../../../../', import.meta.url).pathname

const STV = /^\(stv (\S+) (\S+)\)$/
const parse = (s: string): Stv | number => {
  const m = STV.exec(s)
  return m ? [Number(m[1]), Number(m[2])] : Number(s)
}
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))
const same = (a: Stv | number, b: Stv | number) => (typeof a === 'number' || typeof b === 'number' ? typeof a === typeof b && close(a as number, b as number) : close(a[0], b[0]) && close(a[1], b[1]))
const reference = ref.cases as Record<string, { expr: string; result: string }>

/** The MeTTa expression a case stands for, built the way the reference script builds it. */
function exprOf(c: WorkedCase): string {
  const parts = c.args.map((a) => {
    if (Array.isArray(a)) return `(stv ${a[0]} ${a[1]})`
    if (typeof a === 'number') return String(a)
    return reference[a.from].result
  })
  return `(${c.fn} ${parts.join(' ')})`
}

describe('the PLN maths shown is the hive’s own', () => {
  it('the reference was made from these exact lib_pln.metta and lib_nal.metta files', () => {
    for (const [lib, sha] of Object.entries(ref.libs)) {
      const got = createHash('sha256').update(readFileSync(`${REPO}${lib}`)).digest('hex')
      expect([lib, got]).toEqual([lib, sha])
    }
    expect(ref.engine).toMatch(/^PeTTa /)
  })

  it('every formula is bound to its definition line in the source', () => {
    const files: Record<string, string[]> = {}
    const lines = (f: string) => (files[f] ??= readFileSync(`${REPO}${f}`, 'utf8').split('\n'))
    for (const r of Object.values(RULES)) expect([r.id, lines(r.file)[r.line - 1].startsWith(`(= (${r.id} `)]).toEqual([r.id, true])
    expect(lines('lib_pln.metta')[52 - 1]).toBe('(= (Truth__c2w $c)')
    expect(lines('lib_pln.metta')[56 - 1]).toBe('(= (Truth__w2c $w)')
    expect(lines('lib_pln.metta')[32 - 1]).toBe('(= (conditional-probability-consistency $As $Bs $ABs)')
  })

  it('the reference holds exactly these cases, with exactly these inputs', () => {
    expect(Object.keys(reference).sort()).toEqual(ALL_CASES.map((c) => c.id).sort())
    for (const c of ALL_CASES) expect([c.id, reference[c.id].expr]).toEqual([c.id, exprOf(c)])
  })

  it('each worked example: the typeset formula, evaluated, equals PeTTa running the real function', () => {
    for (const c of CASES) {
      const want = parse(reference[c.id].result)
      const got = computed(c)
      expect([c.id, same(got, want)], `${c.id}: page ${JSON.stringify(got)} vs PeTTa ${reference[c.id].result}`).toEqual([c.id, true])
    }
  })

  it('each worked example, and each other-branch check: a plain transcription of the source equals PeTTa too', () => {
    for (const c of ALL_CASES) {
      const want = parse(reference[c.id].result)
      const fn = TRANSCRIBED[c.fn] as (...a: unknown[]) => Stv | number
      const got = c.fn === 'Truth__c2w' || c.fn === 'Truth__w2c' ? fn(c.args[0]) : fn(...argsOf(c))
      expect([c.id, same(got, want)], `${c.id}: transcription ${JSON.stringify(got)} vs PeTTa ${reference[c.id].result}`).toEqual([c.id, true])
    }
  })

  it('every displayed example takes the branch whose formula is shown (Deduction: consistent, Q below 0.9999)', () => {
    for (const c of CASES) {
      const r = ruleOf(c)
      if (r) expect([c.id, branchOf(r, argsOf(c))]).toEqual([c.id, 'main'])
    }
  })

  it('the other Deduction branches are the ones the checks name (PeTTa agrees above)', () => {
    for (const c of ALL_CASES.filter((x) => x.branch)) expect([c.id, branchOf(ruleOf(c)!, argsOf(c))]).toEqual([c.id, c.branch])
    expect(parse(reference['pln-ded-inconsistent'].result)).toEqual([1, 0])
    expect(parse(reference['pln-ded-q-near-1'].result)).toEqual([0.5, 0.405])
  })

  it('lib_nal caps a revision’s confidence at 0.99 and lib_pln at 1.0 (the difference the page names)', () => {
    const pln = parse(reference['pln-rev-cap'].result) as Stv
    const nal = parse(reference['nal-rev-cap'].result) as Stv
    expect(pln[1]).toBeGreaterThan(0.99)
    expect(nal[1]).toBe(0.99)
    expect(close(pln[0], nal[0])).toBe(true)
  })

  it('the typeset Modus Ponens reads as the source does', () => {
    expect(texText(RULES.Truth__ModusPonens.s)).toBe('Ps · PQs + 0.02 · (1 − Ps)')
    expect(texText(RULES.Truth__ModusPonens.c)).toBe('Ps · PQs · Pc · PQc')
    expect(texText(RULES.Truth__ModusPonens.s, { Ps: 0.9, PQs: 0.8 })).toBe('0.9 · 0.8 + 0.02 · (1 − 0.9)')
  })
})

describe('the showreel’s reasoning steps use these examples, and agree with their atoms', () => {
  const steps = SCENES.flatMap((s) => s.steps.map((x, i) => ({ id: `${s.id}#${i}`, trace: x.trace })))

  it('every inference step names a worked example', () => {
    for (const s of steps) for (const r of s.trace.reasoning ?? []) expect([s.id, r.case, CASES.some((c) => c.id === r.case)]).toEqual([s.id, r.case, true])
  })

  it('an atom a step writes with a truth value holds exactly the conclusion PeTTa computed', () => {
    for (const s of steps) {
      for (const r of s.trace.reasoning ?? []) {
        const atom = s.trace.atomspace?.after.find((a) => a.text === r.conclusion)
        expect([s.id, r.conclusion, !!atom]).toEqual([s.id, r.conclusion, true])
        const want = parse(reference[r.case].result) as Stv
        expect([s.id, r.case, same(atom!.stv!, want)]).toEqual([s.id, r.case, true])
      }
    }
  })

  it('a step’s premises are named one per rule input', () => {
    for (const s of steps) {
      for (const r of s.trace.reasoning ?? []) {
        const c = CASES.find((x) => x.id === r.case)!
        expect([s.id, r.premises.length]).toEqual([s.id, ruleOf(c)!.params.length])
      }
    }
  })
})
