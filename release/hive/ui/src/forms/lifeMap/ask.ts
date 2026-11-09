import type { WorkItem } from '../../api/types'
import { evidenceOf, gapsOf, KIND_WORD, restingName, silentSpans, today, TERRITORY, uncertaintyText, type Indexed, type Placement } from './model'

/**
 * Ask Atlas: quick questions answered from the map itself, on this device. No model is called and no value is
 * ever written into an answer; answers name records, and the records carry their own sealed values.
 */
export type Prompt = 'changed' | 'unsure' | 'test' | 'gaps'
export const PROMPTS: { id: Prompt; text: string }[] = [
  { id: 'changed', text: 'What changed recently?' },
  { id: 'unsure', text: 'What is Atlas least sure about?' },
  { id: 'test', text: 'What would test the leading idea?' },
  { id: 'gaps', text: 'Where is my record thin?' },
]

export interface Answer {
  lead: string
  lines: { text: string; item?: string }[]
  caveat: string
}

const CAVEAT = 'Answered from the records on this map. Not medical advice.'

export function ask(ix: Indexed, place: Map<string, Placement>, p: Prompt): Answer {
  const t = today(ix, place)
  const terr = (it: WorkItem) => TERRITORY[place.get(it.id)?.territory ?? 'context'].label
  if (p === 'changed') {
    if (!t.recent.length) return { lead: 'Nothing new in the last three weeks of the record.', lines: [], caveat: CAVEAT }
    return {
      lead: `${t.recent.length} record${t.recent.length === 1 ? '' : 's'} arrived in the three weeks up to the latest entry.`,
      lines: t.recent.map((o) => ({ text: `${restingName(o)} · ${terr(o)}`, item: o.id })),
      caveat: CAVEAT,
    }
  }
  if (p === 'unsure') {
    const open = t.openHypotheses.map((h) => {
      const ev = evidenceOf(ix, h.id)
      return { h, n: ev.support.length + ev.oppose.length + ev.qualify.length, mixed: ev.support.length > 0 && ev.oppose.length > 0 }
    })
    const unassessed = open.filter((o) => !o.h.uncertainty)
    const mixed = open.filter((o) => o.mixed)
    const thin = open.filter((o) => o.n <= 1)
    const lines = [
      ...mixed.map((o) => ({ text: `Evidence pulls both ways: ${restingName(o.h)}`, item: o.h.id })),
      ...thin.map((o) => ({ text: `Barely tested (${o.n} linked record${o.n === 1 ? '' : 's'}): ${restingName(o.h)}`, item: o.h.id })),
      ...unassessed.map((o) => ({ text: `${uncertaintyText(null).short}: ${restingName(o.h)}`, item: o.h.id })),
    ]
    return { lead: lines.length ? 'Where the map is least settled:' : 'Every open idea has linked evidence and an assessment.', lines: dedupe(lines), caveat: 'Uncertainty is shown by its own method and never combined. ' + CAVEAT }
  }
  if (p === 'test') {
    const lead = t.openHypotheses
      .map((h) => ({ h, n: evidenceOf(ix, h.id).support.length }))
      .sort((a, b) => b.n - a.n || a.h.id.localeCompare(b.h.id))[0]?.h
    if (!lead) return { lead: 'There is no open idea to test yet.', lines: [], caveat: CAVEAT }
    const linked = [...(ix.out.get(lead.id) ?? []), ...(ix.into.get(lead.id) ?? [])]
      .map((l) => ix.byId.get(l.from === lead.id ? l.to : l.from))
      .filter((i): i is WorkItem => !!i && (i.kind === 'prediction' || i.kind === 'experiment'))
    return {
      lead: `The idea with the most recorded support is “${restingName(lead)}”.`,
      lines: linked.length
        ? linked.map((i) => ({ text: `${KIND_WORD[i.kind]}: ${restingName(i)}${i.meta?.domain_status ? ` (${String(i.meta.domain_status)})` : ''}`, item: i.id }))
        : [{ text: 'No prediction or experiment is linked to it yet. A Scientist review could propose one.', item: lead.id }],
      caveat: 'Support is counted by recorded links, a heuristic, not a probability. ' + CAVEAT,
    }
  }
  const g = gapsOf(ix, place)
  const spans = silentSpans(g.silentMonths)
  const lines = [
    ...spans.map((s) => ({ text: `Nothing recorded: ${s.label} (${s.n} month${s.n === 1 ? '' : 's'})` })),
    ...(g.noRange.length ? [{ text: `${g.noRange.length} measured value${g.noRange.length === 1 ? ' has' : 's have'} no reference range to read against` }] : []),
    ...(g.unassessed.length ? [{ text: `${g.unassessed.length} open idea${g.unassessed.length === 1 ? ' is' : 's are'} unassessed (not the same as unlikely)` }] : []),
    ...(g.unplaced.length ? [{ text: `${g.unplaced.length} record${g.unplaced.length === 1 ? '' : 's'} could not be placed on the body and sit in Context` }] : []),
  ]
  return { lead: lines.length ? 'Where the record is thin:' : 'No silent months, missing ranges or unassessed ideas.', lines, caveat: CAVEAT }
}

function dedupe<T extends { item?: string }>(xs: T[]): T[] {
  const seen = new Set<string>()
  return xs.filter((x) => !x.item || (seen.has(x.item) ? false : (seen.add(x.item), true)))
}
