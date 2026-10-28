/**
 * J3 r4.3 O3: the Studio receipt cards (Surface design r1 §2, J3 rows; Code's receipt-card binding 20261017).
 *
 * Cards come from HOST RECORDS only: the G1 admission (submit result) and the session ledger. A `studio.session` event or
 * an artifact notice only triggers a ledger read; it is never itself a receipt. Narration stays separate (model words are
 * never parsed into a card). Each card carries its binding (person, hive, session, app, maker, step, exact refs) so a
 * card from another person, session or piece can never confirm today's words.
 *
 *   session-started  the linked submit result (session + goal + host-made proposal artifact ids, maker, payer)
 *   proposal-ready   the host's proposal revision n + digest bound to step n (publication, NOT drawing)
 *   drawn            the host-recorded frame-reported `applied` outcome for that exact proposal/step, with piece after-ref,
 *                    the admitted receiver generation and the acknowledged upload binding
 *   refused          the same outcome record with `refused` (and its reason)
 *   step-other       accepted-no-source-change, invalid, or a step that ended with nothing published
 *   stopped          local close, then the host fence; "stopped" only at state=stopped with zero in-flight liabilities;
 *                    the maker's cancel-ack on its own line
 *   billing          unknown/held liabilities under the session, until the host settles them (across a month change too)
 */
import type { Admission, Ledger, LedgerStep, ProposalRef } from './api'
import type { ReportEntry } from './outcomes'
import { monthlyLine } from './cost'
import { remoteStopConfirmed } from './words'

export type CardKind = 'session-started' | 'proposal-ready' | 'drawn' | 'refused' | 'step-other' | 'stopped' | 'billing'
export interface CardBinding { principal: string; session_id: string; program_id: string; maker_id: string; step: number | null; proposal: ProposalRef | null }
export interface ReceiptCard {
  id: string
  kind: CardKind
  text: string
  /** a second line (e.g. remote stop state, cancel-ack, "reported late") */
  detail?: string
  tone: 'ok' | 'warn' | 'info'
  binding: CardBinding
}

/** Local facts the cards may name beside the ledger (never as proof of a host effect). */
export interface LocalFacts {
  principal: string
  admission: Admission | null
  /** local receiving closed by the person's Stop (synchronous, before the host stop) */
  localStopped: boolean
  /** what this page's reporter holds for each proposal (to catch a host record that disagrees with the canvas) */
  reports: ReportEntry[]
}

const usd = (n: number) => `$${n.toFixed(2)}`
const REFUSAL_WORDS: Record<string, string> = {
  conflict: 'it would overwrite your edit',
  precondition: 'it would overwrite your edit',
  'stale-prior': 'it would overwrite your edit',
  bounds: 'it went past the edge of the piece',
  limit: 'it was more than one step may change',
  invalid: 'it did not fit the piece',
  // Kimi r2.1: person-made parts are never the maker's to change (and a renamed copy of a maker part is yours)
  'unknown-element': 'that part is yours, not one Studio made, so it can’t change it; edit it by hand',
}
export const refusalWords = (reason: string | null) => (reason && REFUSAL_WORDS[reason]) || 'the canvas refused it'

function stepCards(l: Ledger, s: LedgerStep, base: Omit<CardBinding, 'step' | 'proposal'>, facts: LocalFacts): ReceiptCard[] {
  const out: ReceiptCard[] = []
  const proposal = s.proposal_n !== null && s.proposal_digest ? { artifact_id: l.proposal_artifact_id, revision: s.proposal_n, digest: s.proposal_digest } : null
  const binding: CardBinding = { ...base, step: s.n, proposal }
  if (proposal) out.push({ id: `${l.session_id}:p${s.n}`, kind: 'proposal-ready', text: `Step ${s.n} proposal ready`, detail: 'Published by the maker; not drawn until the canvas applies it.', tone: 'info', binding })
  const late = s.late ? 'Reported after the step’s time ran out; recorded against this step.' : undefined
  if (s.outcome === 'applied') {
    // drawn needs the whole correlation; anything missing leaves it unconfirmed, never green
    const local = proposal ? facts.reports.find((r) => r.report.proposal.revision === proposal.revision && r.report.proposal.artifact_id === proposal.artifact_id) : undefined
    const disagrees = !!local && (!s.piece_after || local.report.piece_after.digest !== s.piece_after.digest || local.report.outcome !== 'applied')
    const complete = !!proposal && !!s.piece_after && s.receiver_generation !== null && !!s.upload && (!l.scene_id || s.piece_after.scene_id === l.scene_id)
    if (complete && !disagrees) out.push({ id: `${l.session_id}:d${s.n}`, kind: 'drawn', text: `Step ${s.n} drawn${s.summary ? ` · ${s.summary}` : ''}`, detail: late, tone: 'ok', binding })
    else out.push({ id: `${l.session_id}:d${s.n}`, kind: 'step-other', text: `Step ${s.n}: not confirmed`, detail: disagrees ? 'The hive’s record and this canvas disagree; nothing is claimed.' : 'The hive’s record is incomplete; nothing is claimed.', tone: 'warn', binding })
  } else if (s.outcome === 'refused') {
    out.push({ id: `${l.session_id}:r${s.n}`, kind: 'refused', text: `Step ${s.n} not applied: ${refusalWords(s.reason)}`, detail: late ?? 'Your piece is unchanged; the next step starts from it.', tone: 'warn', binding })
  } else if (s.outcome === 'accepted-no-source-change') {
    out.push({ id: `${l.session_id}:a${s.n}`, kind: 'step-other', text: `Step ${s.n}: pointed, nothing changed in the piece`, detail: late, tone: 'info', binding })
  } else if (s.outcome === 'invalid') {
    out.push({ id: `${l.session_id}:i${s.n}`, kind: 'step-other', text: `Step ${s.n} could not be used`, detail: 'The canvas could not read that step; nothing changed.', tone: 'warn', binding })
  } else if (s.outcome === 'unknown') {
    out.push({ id: `${l.session_id}:u${s.n}`, kind: 'step-other', text: `Step ${s.n}: drawing not confirmed`, detail: 'The canvas may have changed but has no receipt for it. It will not be replayed automatically.', tone: 'warn', binding })
  } else if (!proposal && (s.state === 'finished' || s.state === 'timed_out' || s.state === 'timed_out_unread' || s.state === 'interrupted')) {
    const spent = s.spent_usd !== null ? ` · ${usd(s.spent_usd)} spent` : ''
    out.push({ id: `${l.session_id}:e${s.n}`, kind: 'step-other', text: `Step ${s.n}: drawing not confirmed${spent}`, detail: 'The hive has no confirmed drawing result for this step. It will not be replayed automatically.', tone: 'warn', binding })
  }
  return out
}

/** Every J3 card, in order, from the admission and the ledger (and local facts that only ever WITHHOLD confirmation). */
export function buildCards(ledger: Ledger | null, facts: LocalFacts): ReceiptCard[] {
  const out: ReceiptCard[] = []
  const a = facts.admission
  if (!ledger) return out
  const base = { principal: facts.principal, session_id: ledger.session_id, program_id: ledger.program_id, maker_id: ledger.maker_id }
  // admission: the linked submit result's ids must be exactly this ledger's (a goal alone is never an admission)
  if (a && a.session_id === ledger.session_id && a.goal_id === ledger.goal_id && a.proposal_artifact_id === ledger.proposal_artifact_id && a.maker_id === ledger.maker_id) {
    const month = ledger.budget.monthly.length ? monthlyLeft(ledger) : null
    out.push({ id: `${ledger.session_id}:start`, kind: 'session-started', text: `Studio session started · cap ${usd(a.cap_usd)}${month !== null ? ` · ${usd(month)} of your month left` : ''}`, tone: 'ok', binding: { ...base, step: null, proposal: null } })
  }
  for (const s of ledger.steps) out.push(...stepCards(ledger, s, base, facts))
  const stop = ledger.stop
  if (facts.localStopped || stop.state !== 'none') {
    const remote = remoteStopConfirmed(ledger.state, stop) ? 'stopped' : stop.state === 'none' && ledger.state !== 'stopping' && ledger.state !== 'ended' && ledger.state !== 'stopped' ? 'not sent yet' : ledger.state === 'stopping' ? 'stopping…' : 'stop not confirmed'
    const ack = stop.cancel_ack === 'acknowledged' ? 'The maker acknowledged.' : stop.cancel_ack === 'pending' ? 'The maker hasn’t acknowledged yet.' : undefined
    out.push({ id: `${ledger.session_id}:stop`, kind: 'stopped', text: `Stopped here · remote: ${remote}`, detail: ack, tone: remote === 'stopped' ? 'ok' : 'info', binding: { ...base, step: null, proposal: null } })
  }
  const unknown = Math.max(stop.unknown_usd ?? 0, ledger.budget.unknown ?? 0)
  if (unknown > 0) {
    const period = ledger.budget.monthly.find((m) => m.period)?.period
    out.push({ id: `${ledger.session_id}:bill`, kind: 'billing', text: `${usd(unknown)} not settled yet`, detail: `A call was already sent; its cost isn’t known yet. It stays on this session${period ? ` (now ${period})` : ''} until the hive settles it; nothing was refunded.`, tone: 'warn', binding: { ...base, step: null, proposal: null } })
  }
  return out
}

function monthlyLeft(l: Ledger): number | null {
  return monthlyLine(l.budget.monthly).headroom   // inclusive held, never double-counted; any unknown row: unknown
}

// ---------------------------------------------------------------- narration vs receipts

/**
 * Whether model words that claim a Studio effect have a matching card for THIS person and session. Conservative: only
 * these claims are classified; anything else is 'unclassified' (left as plain narration, never marked confirmed).
 */
const CLAIMS: { re: RegExp; kind: CardKind }[] = [
  { re: /\b(i(?:'|’)ve|i have|i)\s+(drawn|drew|added|painted|placed)\b|\bstep \d+ (is )?drawn\b/i, kind: 'drawn' },
  { re: /\b(studio|the session)\s+(is\s+)?(started|running|set up)\b|\bi(?:'|’)ve (started|set up) (a |the )?(studio )?session\b/i, kind: 'session-started' },
  { re: /\b(i(?:'|’)ve|i have)\s+stopped\b|\bstudio (is |has )?stopped\b/i, kind: 'stopped' },
]
export function claimStatus(text: string, cards: ReceiptCard[], who: { principal: string; session_id: string }): 'confirmed' | 'not-confirmed' | 'unclassified' {
  const claim = CLAIMS.find((c) => c.re.test(text))
  if (!claim) return 'unclassified'
  const ok = cards.some((c) => c.kind === claim.kind && c.binding.principal === who.principal && c.binding.session_id === who.session_id && (c.kind !== 'stopped' || /remote: stopped$/.test(c.text)))
  return ok ? 'confirmed' : 'not-confirmed'
}
