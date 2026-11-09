/**
 * J3 r4.3 O3: the cost readout. Monthly headroom FIRST (Jon 10-17 2250: the person's one total monthly limit governs),
 * then this session's spend against its cap, then the step backstops (contract :162, :175–:183). Defaults Jon confirmed:
 * $2 per session, $0.25 per step, 180 s per step. Unknown figures read "unknown", never a guess; held and unknown billing
 * are named separately from what is spent.
 */
import type { LedgerBudget, MonthlyRow } from './api'

export const DEFAULT_SESSION_CAP = 2
export const DEFAULT_STEP_CAP = 0.25
export const DEFAULT_STEP_SECONDS = 180

const usd = (n: number) => `$${n.toFixed(2)}`
const or = (n: number | null, alt = 'unknown') => (n === null ? alt : usd(n))

/**
 * Headroom on one monthly row. The host's own figure wins; else limit − spent − held, where held is INCLUSIVE of unknown
 * liabilities (host scope_held: reserved + dispatched + unknown), so the unknown subset is never subtracted twice
 * (Code 215311Z). An unknown limit, spent or held TOTAL makes the headroom unknown (a missing breakdown alone does not).
 */
export function headroom(m: MonthlyRow): number | null {
  if (typeof m.headroom === 'number') return Math.max(0, m.headroom)
  if (m.limit === null || m.spent === null || m.held === null) return null
  return Math.max(0, m.limit - m.spent - m.held)
}

/** The governing monthly line: the least headroom across rows; ANY row with unknown headroom makes it unknown (never dropped). */
export function monthlyLine(rows: MonthlyRow[]): { text: string; headroom: number | null; missing: boolean } {
  if (!rows.length) return { text: 'Your monthly limit: not known yet', headroom: null, missing: true }
  const all = rows.map((r) => ({ r, h: headroom(r) }))
  if (all.some((x) => x.h === null)) return { text: 'Your month: what is left is not known (a limit’s held amount is unknown)', headroom: null, missing: false }
  const least = all.reduce((a, b) => (b.h! < a.h! ? b : a))
  return { text: least.r.limit !== null ? `${usd(least.h!)} of your month left (limit ${usd(least.r.limit)})` : `${usd(least.h!)} of your month left`, headroom: least.h, missing: false }
}

/**
 * Kimi K1: spent + held + unknown is conserved across ledger reads unless calls settle: an unknown amount may only go
 * down by what spent goes up (it settled). If it vanishes otherwise, the figures are not trusted ("not settled"), never
 * shown as a clean zero. Missing figures are not drift (they read as unknown already).
 */
export function moneyDrifted(prev: LedgerBudget | null, next: LedgerBudget): boolean {
  if (!prev || prev.unknown === null || next.unknown === null || prev.spent === null || next.spent === null) return false
  return prev.unknown - next.unknown > next.spent - prev.spent + 0.005
}

export interface CostReadout { monthly: string; session: string; step: string; held: string | null; unknown: string | null; nearCap: boolean; compact: string }

/**
 * One readout for the detail panel and the compact bar. An ADMITTED ledger's missing figure is unknown (never a default);
 * the $2 / $0.25 / 180 s defaults are setup-time only (the card shows the host consent payload anyway).
 */
export function costReadout(b: LedgerBudget | null, opts: { drift?: boolean } = {}): CostReadout {
  if (!b) return { monthly: 'Your monthly limit: not known yet', session: 'This session: not known yet', step: 'Each step: not known yet', held: null, unknown: null, nearCap: true, compact: 'unknown of unknown' }
  const spent = b.spent
  const cap = b.cap
  return {
    monthly: monthlyLine(b.monthly).text,
    session: opts.drift ? `This session: not settled (the figures do not add up yet) · cap ${or(cap)}` : `This session: ${or(spent)} of ${or(cap)}`,
    step: `Each step: up to ${or(b.step_cap)} and ${b.step_seconds === null ? 'unknown' : `${Math.round(b.step_seconds)} s`}`,
    held: b.held && b.held > 0 ? `${usd(b.held)} held for calls in progress` : b.held === null ? 'Held for calls in progress: unknown' : null,
    // the unsettled part is a breakdown line only (already inside held); an unknown breakdown is said, never hidden
    unknown: b.unknown === null ? 'Not settled yet: unknown' : b.unknown > 0 ? `${usd(b.unknown)} not settled yet` : null,
    // Kimi K2 (r1.1): an absent held, spent, cap or step figure is unknown, so nearness to the cap is never claimed optimistically
    nearCap: spent === null || b.held === null || cap === null || b.step_cap === null || !!opts.drift || cap - spent - b.held < b.step_cap,
    compact: opts.drift ? 'not settled' : `${or(spent)} of ${or(cap)}`,
  }
}

/** Setup-time defaults Jon confirmed (shown only before admission, never filled into a ledger). */
export const SETUP_DEFAULTS = { cap: DEFAULT_SESSION_CAP, step_cap: DEFAULT_STEP_CAP, step_seconds: DEFAULT_STEP_SECONDS }
