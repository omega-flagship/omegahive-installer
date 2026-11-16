/**
 * The policy (UNIVERSAL_ASK_DESIGN §2.4): what Enter does with what the fast path understood. Pure and tested.
 *
 *  - Top ≥ 0.85, ahead by ≥ 0.15, a view or look: it runs at once (the receipt carries Back or Undo).
 *  - A hive action the person typed: Still's exact preview; Enter runs it behind the arming gate.
 *  - A decision or money feature: its existing dialog or page opens; the Ask never decides.
 *  - 0.55–0.85, or the top two within 0.15: up to three "Did you mean…" choices.
 *  - A name that matches several things: "Which one?".
 *  - A missing slot ("wake", "memory" with no mind): one clarifying question with chips.
 *  - A time or condition: said plainly, with the safe part offered.
 *  - Below 0.55: the swarm's orchestrator answers (POST /api/ask), or, with none, "not here yet" and the nearest.
 */
import type { Candidate } from './types'

export const RUN_AT = 0.85
export const LEAD_BY = 0.15
export const CHOOSE_AT = 0.55

export type Decision =
  | { kind: 'run'; c: Candidate }
  | { kind: 'own'; c: Candidate }
  | { kind: 'open-decision'; c: Candidate }
  | { kind: 'choose'; options: Candidate[] }
  | { kind: 'which'; options: Candidate[] }
  | { kind: 'clarify'; c: Candidate }
  | { kind: 'limit'; c: Candidate; safe?: Candidate }
  | { kind: 'mind' }
  | { kind: 'none'; near: Candidate[] }

const acting = (c: Candidate) => !!c.act && c.effect !== 'mind'

export function decide(cands: Candidate[], opts: { orchestrator: boolean }): Decision {
  if (cands.some((c) => c.choice)) return { kind: 'which', options: cands.filter((c) => c.choice) }
  const first = cands[0]
  if (first?.limit && first.confidence >= CHOOSE_AT) return { kind: 'limit', c: first, safe: cands.find((c) => acting(c) && c.confidence >= CHOOSE_AT) }
  const ranked = cands.filter((c) => acting(c) || c.clarify).sort((a, b) => b.confidence - a.confidence)
  const top = ranked[0]
  const second = ranked[1]
  if (top && top.confidence >= CHOOSE_AT) {
    if (top.clarify && top.confidence >= RUN_AT) return { kind: 'clarify', c: top }
    if (top.effect === 'own-action' && top.confidence >= RUN_AT) return { kind: 'own', c: top }
    if (top.effect === 'open-decision' && top.confidence >= RUN_AT && (!second || top.confidence - second.confidence >= LEAD_BY)) return { kind: 'open-decision', c: top }
    const clear = top.confidence >= RUN_AT && (!second || top.confidence - second.confidence >= LEAD_BY)
    if (clear && (top.effect === 'view' || top.effect === 'look')) return { kind: 'run', c: top }
    return { kind: 'choose', options: ranked.filter((c) => c.confidence >= CHOOSE_AT && !c.clarify).slice(0, 3) }
  }
  if (opts.orchestrator) return { kind: 'mind' }
  return { kind: 'none', near: ranked.filter((c) => c.act?.do === 'feature').slice(0, 3) }
}

/** In "Did you mean…", Enter takes the first only when it just moves the view. */
export const enterTakesFirst = (d: Decision): boolean => d.kind === 'choose' && d.options[0]?.effect === 'view'
