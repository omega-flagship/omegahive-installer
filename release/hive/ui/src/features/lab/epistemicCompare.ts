import { plural } from '../../lib/plural'
import type { LabCase } from '../../api/types'
import { alignCaseMetric, close } from './stallCompare'

/**
 * The Epistemic board's comparison of our commons with the paper's reference mock (lab-compare r1.1), kept pure and
 * tested. Every metric goes through the same guards as the Lab compare (alignCaseMetric: one record per name, same
 * dimension, definition, direction and a declared unit). Only evaluated metrics are counted; unknown and
 * not-comparable ones are named, never folded into "level".
 */

/**
 * The four suite metrics, their direction and their unit. The harness (Crawford & Hammer, AGI-26) records the three
 * rates without a unit; this board declares them as `ratio` and correction latency as `steps`. The declaration fills
 * only a blank recorded unit; a recorded unit always wins and must then line up on its own.
 */
export const EPISTEMIC_METRICS: { name: string; short: string; better: 'lower' | 'higher'; unit: string }[] = [
  { name: 'correction latency', short: 'Correction latency', better: 'lower', unit: 'steps' },
  { name: 'corruption susceptibility', short: 'Corruption', better: 'lower', unit: 'ratio' },
  { name: 'retention', short: 'Retention', better: 'higher', unit: 'ratio' },
  { name: 'recovery', short: 'Recovery', better: 'higher', unit: 'ratio' },
]

export interface EpistemicCounts {
  better: number
  worse: number
  same: number
  notComparable: number
  unknown: number
}

/** A case with this board's unit declarations filled into blank recorded units (nothing else changes). */
function declared(c: LabCase): LabCase {
  return {
    ...c,
    metrics: c.metrics.map((m) => {
      const d = EPISTEMIC_METRICS.find((x) => x.name === m.name)
      return d && (typeof m.unit !== 'string' || m.unit.trim() === '') ? { ...m, unit: d.unit } : m
    }),
  }
}

/** Ours against the reference, metric by metric. "Same" is the Lab compare's own relative closeness (close). */
export function epistemicCounts(ours: LabCase, ref: LabCase): EpistemicCounts {
  const n: EpistemicCounts = { better: 0, worse: 0, same: 0, notComparable: 0, unknown: 0 }
  const o = declared(ours)
  const r = declared(ref)
  for (const m of EPISTEMIC_METRICS) {
    const al = alignCaseMetric(r, o, m.name)
    if (al.verdict === 'unknown') n.unknown++
    else if (al.verdict !== 'comparable' || al.better !== m.better || al.bInA == null) n.notComparable++
    else {
      const a = al.bInA // ours, in the reference's unit
      const b = al.a!.value // the reference
      if (close(a, b)) n.same++
      else if (m.better === 'lower' ? a < b : a > b) n.better++
      else n.worse++
    }
  }
  return n
}


/** The board's one-line verdict: only evaluated metrics are judged, and the rest are named. */
export function epistemicVerdict(ours: LabCase | undefined, ref: LabCase | undefined): string {
  if (!ours) return 'Our commons has not reported a suite score in this run.'
  if (!ref) return 'The reference mock is missing from this run.'
  const n = epistemicCounts(ours, ref)
  const total = EPISTEMIC_METRICS.length
  const evaluated = n.better + n.worse + n.same
  const rest = [n.unknown ? `${n.unknown} not recorded or unreadable` : '', n.notComparable ? `${n.notComparable} not comparable (different units, definition or direction)` : ''].filter(Boolean).join('; ')
  if (evaluated === 0) return `None of the ${plural(total, 'metric')} could be compared with mock-provenance: ${rest}.`
  const of = evaluated === total ? `of ${plural(total, 'metric')}` : `of the ${plural(evaluated, 'metric')} compared`
  const head = n.worse
    ? `Behind mock-provenance on ${n.worse} ${of}.`
    : n.better
      ? `Ahead of mock-provenance on ${n.better} and level on ${n.same} ${of}.`
      : evaluated === total
        ? 'Level with mock-provenance, the paper’s reference, on all four metrics.'
        : `Level with mock-provenance on the ${plural(evaluated, 'metric')} compared.`
  return evaluated === total ? head : `${head} Not compared: ${rest}.`
}
