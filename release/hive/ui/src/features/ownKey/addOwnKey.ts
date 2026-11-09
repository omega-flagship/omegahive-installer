/**
 * The one add-your-key step (Jon 11-05: members' minds run on their own key, and adding it is one friendly step).
 *
 * The host's own_key_needed (and the missing monthly total behind it) carries what the step needs
 * (ownhive.OwnHive.key_setup): the provider, its name, whether the person already has their ONE monthly total, and
 * the figure to suggest when they don't. One submit then, every call through ONE BoundOperation (lib/boundOperation:
 * the sign-in it began under and the sheet that started it; a change stops the chain before its next write):
 *   1. POST /api/keys {provider, key, month_usd}. Its answer says whether this host handles the total in the same call:
 *      `monthly_total_applied` present means it does (true: written; false: a total it kept, `monthly_total_usd`, that
 *      someone set meanwhile, shown for fresh consent and never overwritten); absent means it ignored month_usd.
 *      409 duplicate_key with `own: true` is the host saying, by exact match (providers.own_key), that this very key is
 *      already the person's own: it is saved (a retry after a lost answer). Without it, it is someone else's copy. A lost
 *      answer or a 5xx is "unconfirmed": the person sends again and the host's answer settles it, never a guess.
 *   2. Only when the total is still needed: read the current total first. One set meanwhile is shown and kept unless
 *      the person chooses to replace it (fresh consent). The PUT /api/me/key-limits/self carries the total they were
 *      shown (`expected_month_usd`, null for none): the host writes it only if that is still the total (ownhive
 *      set_total_if), else 409 limit_changed with the total now, which goes back to the person. Then read back
 *      (keys/ownLimit.saveOwnLimit): "done" only on a readback that shows it.
 *   3. done: the caller retries what was refused, with the person's words kept.
 * A key saved but a limit not set is its own state: the retry is not fired and a resubmit never adds the key again.
 */
import { ApiError } from '../../api/client'
import type { KeyInfo } from '../../api/types'
import { stopped, type BoundOperation } from '../../lib/boundOperation'
import { addKeyRefusalWords, parseLimit, readOwnLimit, saveOwnLimit } from '../keys/ownLimit'

export interface KeySetup {
  provider: string | null
  providerLabel: string
  /** the person already had their one monthly total when refused: the step asks only for the key */
  hasTotal: boolean
  suggestedMonthUsd: number | null
}

export type SheetPhase = 'ask' | 'saving' | 'needs-limit' | 'confirm-limit' | 'done' | 'stopped'

export interface SheetState {
  phase: SheetPhase
  /** the key is stored on the hive (from this sheet, or before it opened for the limit alone) */
  keySaved: boolean
  /** plain words for what went wrong, shown on the sheet; null when nothing did */
  error: string | null
  /** confirm-limit: the monthly total that governs now, set elsewhere meanwhile (kept unless the person replaces it) */
  governingUsd?: number | null
}

export interface OwnKeyIo {
  addKey(body: { provider: string; key: string; month_usd?: number }): Promise<KeyInfo & { monthly_total_applied?: boolean; monthly_total_usd?: number | null }>
  /** GET /api/me/key-limits: the person's own keys and their own total */
  read(): Promise<unknown>
  /** PUT /api/me/key-limits/self, written only if the total is still `expected_month_usd` (null: none set) */
  writeLimit(body: { key_id: '*'; month_usd: number; expected_month_usd: number | null }): Promise<unknown>
}

/** Sim only (sol on 4e3cd2b6): the demonstration never takes a credential; this invented one stands in for it. */
export const SIM_DEMO_KEY = 'sk-invented-demo-key-0000'

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** The step's details from a refusal (own_key_needed, or the missing monthly total), else null. Untrusted input. */
export function keySetupFrom(e: unknown): KeySetup | null {
  if (!(e instanceof ApiError) || e.status !== 402) return null
  const env = rec(e.envelope)
  const err = rec(rec(e.body)?.error)
  const pick = (k: string): unknown => env?.[k] ?? rec(env?.detail)?.[k] ?? err?.[k] ?? rec(err?.detail)?.[k] ?? rec(err?.details)?.[k]
  const provider = typeof pick('provider') === 'string' && /^[a-z0-9_-]{1,40}$/.test(pick('provider') as string) ? (pick('provider') as string) : null
  const label = typeof pick('provider_label') === 'string' && (pick('provider_label') as string).length <= 60 ? (pick('provider_label') as string) : null
  const suggested = typeof pick('suggested_month_usd') === 'number' && Number.isFinite(pick('suggested_month_usd')) ? (pick('suggested_month_usd') as number) : null
  if (e.code === 'own_key_needed') {
    if (!provider) return null   // a host that names no provider: the old way on (Keys) still works
    return { provider, providerLabel: label ?? provider, hasTotal: pick('has_total') === true, suggestedMonthUsd: suggested }
  }
  return null
}

/** The sheet for the missing monthly total alone (the key is already theirs): only the limit is asked for. The figure to
 *  suggest comes from the host (GET /api/me/key-limits suggested_month_usd) when the refusal carries none. */
export function limitOnlySetup(suggestedMonthUsd: number | null = null): KeySetup {
  return { provider: null, providerLabel: '', hasTotal: false, suggestedMonthUsd }
}

export function initialState(setup: KeySetup): SheetState {
  return { phase: setup.provider ? 'ask' : 'needs-limit', keySaved: !setup.provider, error: null }
}

export const LIMIT_SAVED_KEY_WORDS = 'Your key is saved. Set your monthly limit to continue.'
export const KEY_UNCONFIRMED_WORDS = 'The hive didn’t confirm your key was saved. Try again; nothing is added twice.'
export const LIMIT_UNCONFIRMED_WORDS = 'Your limit couldn’t be confirmed. Try again.'
export const LIMIT_REFUSED_WORDS = 'The hive didn’t save that limit. Nothing changed.'

/** The person's own total, as GET /api/me/key-limits answers (untrusted): the figure, null for none, or 'unreadable'. */
function ownTotal(v: unknown): number | null | 'unreadable' {
  const view = readOwnLimit(v)
  return view.state === 'unreadable' ? 'unreadable' : view.state === 'set' ? view.limit.month_usd : null
}

/** The host's suggestion for a first monthly total (GET /api/me/key-limits suggested_month_usd), or null. */
export function suggestedFrom(v: unknown): number | null {
  const m = rec(v)?.suggested_month_usd
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null
}

/** 409 duplicate_key that the host marks as exactly the person's own stored key (providers.own_key), never a guess */
const ownDuplicate = (e: unknown) => e instanceof ApiError && e.code === 'duplicate_key' && (rec(e.envelope)?.own === true || rec(rec(rec(e.body)?.error))?.own === true)
/** a 4xx the host answered before acting (not a 408 timeout): nothing was saved */
const refusedOutright = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408

/**
 * One submit of the sheet. Never throws: every outcome is a state. `prior.keySaved` means step 1 is already done (this
 * sheet saved it, or the sheet opened for the limit alone), so it is never repeated. `replace`: the person chose to
 * replace a total set meanwhile (confirm-limit), their fresh consent.
 */
export async function submitOwnKey(op: BoundOperation, io: OwnKeyIo, setup: KeySetup, input: { key: string; month: string; replace?: boolean }, prior: SheetState): Promise<SheetState> {
  const needsLimit = !setup.hasTotal
  const month = needsLimit ? parseLimit(input.month) : null
  if (needsLimit && month === null) return { ...prior, phase: prior.keySaved ? prior.phase === 'confirm-limit' ? 'confirm-limit' : 'needs-limit' : 'ask', error: 'Enter a monthly limit in dollars, for example 50.' }
  let keySaved = prior.keySaved
  try {
    if (!keySaved) {
      const key = input.key.trim()
      if (!key) return { ...prior, phase: 'ask', error: `Paste your ${setup.providerLabel} key.` }
      try {
        const out = await op.write(() => io.addKey({ provider: setup.provider as string, key, ...(month !== null ? { month_usd: month } : {}) }))
        keySaved = true
        if (needsLimit && out && Object.prototype.hasOwnProperty.call(out, 'monthly_total_applied')) {
          // this host handles the total in the same call: written, or a newer one kept (never overwritten here)
          if (out.monthly_total_applied === true) return { phase: 'done', keySaved, error: null }
          return { phase: 'confirm-limit', keySaved, error: null, governingUsd: typeof out.monthly_total_usd === 'number' ? out.monthly_total_usd : null }
        }
      } catch (e) {
        if (stopped(e)) return { phase: 'stopped', keySaved: false, error: null }
        // a one-call host that stored the key but not the total (503 limit_not_raised): the key is saved
        if (e instanceof ApiError && e.code === 'limit_not_raised') return { phase: 'needs-limit', keySaved: true, error: e.message || LIMIT_UNCONFIRMED_WORDS }
        if (ownDuplicate(e)) keySaved = true                        // exactly this key, already theirs (a retry)
        else if (refusedOutright(e)) return { phase: 'ask', keySaved: false, error: addKeyRefusalWords(e, setup.providerLabel) }
        else return { phase: 'ask', keySaved: false, error: KEY_UNCONFIRMED_WORDS }   // lost or 5xx: sending again settles it
      }
    }
    if (!needsLimit) return { phase: 'done', keySaved, error: null }
    // the total: never over one set meanwhile without the person's fresh consent; the host enforces it (expected)
    let expected: number | null
    if (input.replace && typeof prior.governingUsd === 'number') expected = prior.governingUsd   // the one she chose to replace
    else {
      const now = ownTotal(await op.write(() => io.read()))
      if (now === 'unreadable') return { phase: 'needs-limit', keySaved, error: LIMIT_UNCONFIRMED_WORDS }
      if (now !== null) return { phase: 'confirm-limit', keySaved, error: null, governingUsd: now }
      expected = null
    }
    let changed: ApiError | null = null
    const out = await saveOwnLimit(op, {
      write: (b) => io.writeLimit({ ...b, expected_month_usd: expected }).catch((e) => { if (e instanceof ApiError && e.code === 'limit_changed') changed = e; throw e }),
      read: () => io.read(),
    }, month as number)
    if (out.kind === 'stopped') return { phase: 'stopped', keySaved, error: null }
    if (out.kind === 'saved') return { phase: 'done', keySaved, error: null }
    if (changed) {   // the total moved between what she was shown and her answer: back to her, with what it is now
      const now = rec((changed as ApiError).envelope)?.monthly_total_usd
      return typeof now === 'number'
        ? { phase: 'confirm-limit', keySaved, error: null, governingUsd: now }
        : { phase: 'needs-limit', keySaved, error: 'Your monthly limit was removed meanwhile. Set one to continue.' }
    }
    return { phase: 'needs-limit', keySaved, error: out.kind === 'refused' ? LIMIT_REFUSED_WORDS : LIMIT_UNCONFIRMED_WORDS }
  } catch (e) {
    if (stopped(e)) return { phase: 'stopped', keySaved, error: null }
    return { phase: keySaved ? 'needs-limit' : 'ask', keySaved, error: keySaved ? LIMIT_UNCONFIRMED_WORDS : KEY_UNCONFIRMED_WORDS }
  }
}

/** confirm-limit's "keep it": the total that governs now stays; done once the hive still shows one. */
export async function keepGoverning(op: BoundOperation, io: OwnKeyIo, prior: SheetState): Promise<SheetState> {
  try {
    const now = ownTotal(await op.write(() => io.read()))
    if (typeof now === 'number') return { phase: 'done', keySaved: prior.keySaved, error: null }
    return { ...prior, phase: 'needs-limit', error: now === null ? 'No monthly limit is set now. Set one to continue.' : LIMIT_UNCONFIRMED_WORDS }
  } catch (e) {
    if (stopped(e)) return { ...prior, phase: 'stopped', error: null }
    return { ...prior, error: LIMIT_UNCONFIRMED_WORDS }
  }
}
