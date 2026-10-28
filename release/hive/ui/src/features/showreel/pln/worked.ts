/**
 * The worked examples (cases.json): each case's rule and inputs, an argument `{from}` being an earlier case's
 * conclusion as the page computed it. The page shows exactly what these return; pln.test.ts holds every one to PeTTa.
 */
import data from './cases.json'
import { C2W, conclude, evaluate, RULES, W2C, type Rule, type RuleId, type Stv } from './rules'

export interface WorkedCase {
  id: string
  fn: RuleId
  args: (number | Stv | { from: string })[]
  /** a check of another branch of the rule (not shown on the page; the transcription is held to PeTTa on it) */
  branch?: 'inconsistent' | 'q-near-1'
}

export const ALL_CASES: WorkedCase[] = data.cases as unknown as WorkedCase[]
/** the worked examples the page shows */
export const CASES: WorkedCase[] = ALL_CASES.filter((c) => !c.branch)
export const caseById = (id: string): WorkedCase | undefined => ALL_CASES.find((c) => c.id === id)

/** The rule a case shows (the evidence conversions have no premises of their own and are not inference steps). */
export function ruleOf(c: WorkedCase): Rule | null {
  return c.fn in RULES ? RULES[c.fn as keyof typeof RULES] : null
}

/** A case's premises as numbers, `{from}` resolved to that case's computed conclusion. */
export function argsOf(c: WorkedCase, seen: string[] = []): Stv[] {
  return c.args.map((a) => {
    if (Array.isArray(a)) return a
    if (typeof a === 'number') throw new Error(`${c.id}: a number where a truth value is expected`)
    if (seen.includes(a.from)) throw new Error(`${c.id}: a loop through ${a.from}`)
    const prior = caseById(a.from)
    if (!prior) throw new Error(`${c.id}: no case ${a.from}`)
    return computed(prior, [...seen, c.id]) as Stv
  })
}

/** What the page shows for a case: the rule's tree evaluated, or the evidence conversion. */
export function computed(c: WorkedCase, seen: string[] = []): Stv | number {
  if (c.fn === 'Truth__c2w' || c.fn === 'Truth__w2c') {
    const x = c.args[0] as number
    return c.fn === 'Truth__c2w' ? evaluate(C2W.ex, { c: x }) : evaluate(W2C.ex, { w: x })
  }
  const rule = ruleOf(c)
  if (!rule) throw new Error(`${c.id}: no rule ${c.fn}`)
  return conclude(rule, argsOf(c, seen))
}

export { C2W, W2C }
