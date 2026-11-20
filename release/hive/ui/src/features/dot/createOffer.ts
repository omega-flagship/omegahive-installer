// Purpose: read a mind's offers to build something in Create from the hive's untrusted answers, and state the facts and
// data the mind-create-offers screen (createOffer.metta) composes from.
import type { CreateOffer } from '../../api/types'
import type { Compose, ScreenFacts } from '../../screens/screenSpace'
import { shown } from '../../lib/displayName'

const STATES = new Set<CreateOffer['state']>(['offered', 'started', 'dismissed'])
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
/** How a card names a mind the hive no longer names (its row is gone) when no mind's chat it sits in names one. */
const UNNAMED_MIND = 'A mind'

/** One offer as the host's view gives it (create_offers.py CreateOffers.view), or null for any other shape. */
export function parseOffer(raw: unknown): CreateOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = text(o.id), sentence = text(o.sentence), created = text(o.created_at)
  if (!id || !sentence || !created || !STATES.has(o.state as CreateOffer['state'])) return null
  const m = o.mind as Record<string, unknown> | null | undefined
  const mind = m && typeof m === 'object' && text(m.id) && typeof m.name === 'string' ? { id: m.id as string, name: m.name } : null
  return { id, mind, sentence, state: o.state as CreateOffer['state'], plan_id: text(o.plan_id), created_at: created }
}

/** GET /api/me/create-offers?mind=: the open offers in it, newest first as the host sent them; anything else none. */
export function parseOffers(raw: unknown): CreateOffer[] {
  return Array.isArray(raw) ? raw.map(parseOffer).filter((o): o is CreateOffer => o !== null && o.state === 'offered') : []
}

/** POST …/start: the plan the press started (or had started), as its id, or null when the answer names none. */
export function startedPlan(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const plan = (raw as { plan?: unknown }).plan
  return plan && typeof plan === 'object' ? text((plan as { plan_id?: unknown }).plan_id) : null
}

/**
 * The mind-create-offers screen's facts and data: each open offer composed as its own card (its id, so a press comes
 * back scoped to it, and the words it draws: the mind's name and the sentence in quotes), and the line saying why a
 * press didn't go through. Pure. Example: one offer from Dot to build "a tip calculator" gives one card that reads
 * "Dot can build this in Create: “a tip calculator”". Each card names its own offer's mind (the Ask's thread holds
 * every mind's); `mindName`, the chat's own mind, only stands in for a mind the hive no longer names.
 */
export function offersScreen(offers: CreateOffer[], mindName: string | null, alert: string | null, compose: Compose):
  { data: Record<string, unknown>; facts: ScreenFacts } {
  const rows = offers.map((o) => ({
    id: o.id,
    plan: compose('mind-create-offer', {}),
    data: { 'offer.mind': shown(o.mind?.name || mindName || UNNAMED_MIND), 'offer.sentence': `“${o.sentence}”` },
  }))
  return {
    data: { 'offers.rows': rows, 'offers.alert': alert ?? '' },
    facts: { counts: { 'offers.open': rows.length }, flags: { 'offers.failed': !!alert } },
  }
}
