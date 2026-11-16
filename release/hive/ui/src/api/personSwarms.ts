/** Host-only P2 card data. The frame never supplies these values or receives this card. */
export interface PinnedPersonSwarm {
  release_digest: string
  template_ids: string[]
  template_digests: Record<string, string>
}

export interface PersonSwarmShown {
  template_digest: string
  key_id: string | null
  month_usd: number | null
  consent_revision: { granted_at: string | null; withdrawn_at: string | null } | null
  authority_revision: string | null
}

export interface PersonSwarmCard extends PersonSwarmShown {
  program_id: string
  program_name: string
  template_id: string
  providers: string[]
  spend_note: string
  consent_current: boolean
  minds: { slot: string; name: string; persona: string; model: string; budget_usd: number }[]
  rules: { skill: string; mode: 'deny' | 'ask' }[]
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const nullableText = (v: unknown): v is string | null => v === null || typeof v === 'string'
const amount = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
function freezeJSON<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeJSON)
    Object.freeze(value)
  }
  return value
}

export const personSwarmCardRoute = (program: string, template: string): string =>
  `/api/me/app-swarms/${encodeURIComponent(program)}/${encodeURIComponent(template)}`

/** A successful response with the wrong identity or missing spend/binding data is not a usable card. */
export function readPersonSwarmCard(raw: unknown, program: string, template: string): PersonSwarmCard | null {
  if (!record(raw) || raw.program_id !== program || raw.template_id !== template || !text(raw.program_name) ||
      !text(raw.template_digest) || !nullableText(raw.key_id) || !amount(raw.month_usd) ||
      !nullableText(raw.authority_revision) || typeof raw.spend_note !== 'string' || !raw.spend_note.trim() ||
      typeof raw.consent_current !== 'boolean') return null
  const rev = raw.consent_revision
  if (rev !== null && (!record(rev) || !nullableText(rev.granted_at) || !nullableText(rev.withdrawn_at))) return null
  if (!Array.isArray(raw.providers) || !raw.providers.every(text) || !Array.isArray(raw.minds) || raw.minds.length < 1 || raw.minds.length > 8 ||
      !raw.minds.every((m) => record(m) && text(m.slot) && text(m.name) && typeof m.persona === 'string' && text(m.model) && typeof m.budget_usd === 'number' && amount(m.budget_usd)) ||
      !Array.isArray(raw.rules) || raw.rules.length > 64 ||
      !raw.rules.every((r) => record(r) && typeof r.skill === 'string' && (r.mode === 'deny' || r.mode === 'ask'))) return null
  // Copy all data: a consumer cannot mutate the request's snapshot by retaining an API object.
  return freezeJSON(JSON.parse(JSON.stringify(raw)) as PersonSwarmCard)
}

/** These five fields are the existing server's shown-card contract, without new policy or coercion. */
export function shownPersonSwarm(card: PersonSwarmCard): PersonSwarmShown {
  return {
    template_digest: card.template_digest,
    key_id: card.key_id,
    month_usd: card.month_usd,
    consent_revision: card.consent_revision === null ? null : { ...card.consent_revision },
    authority_revision: card.authority_revision,
  }
}

/** Metadata is derived by Programs.detail from the verified pinned manifest, not Context._program. */
export function singlePersonSwarm(raw: unknown): { releaseDigest: string; templateId: string; templateDigest: string } | null {
  if (!record(raw) || !text(raw.release_digest) || !Array.isArray(raw.template_ids) || raw.template_ids.length !== 1 ||
      !text(raw.template_ids[0]) || !record(raw.template_digests) || !text(raw.template_digests[raw.template_ids[0]])) return null
  return { releaseDigest: raw.release_digest, templateId: raw.template_ids[0], templateDigest: raw.template_digests[raw.template_ids[0]] as string }
}

export const P2_SAVED = 'Saved. Your helpers will be set up the next time the app needs them.'
export const P2_CHANGED = 'This changed since it was shown to you. Nothing has been set up. Please look again.'
/** The wire amount is USD. Preserve its full numeric precision, including tiny positive limits; perform no FX. */
export const formatPersonSwarmUSD = (value: number): string => `${String(value)} USD`
