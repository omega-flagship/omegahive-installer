import type { LlmErrorCode } from '../api/types'

export interface LlmErrorInfo {
  code: LlmErrorCode | 'other'
  status: 401 | 402 | 403 | 429 | null
  title: string
  hint: string
}

const KNOWN: Record<LlmErrorCode, Omit<LlmErrorInfo, 'code'>> = {
  no_budget: { status: 402, title: 'No budget for a paid model', hint: 'This mind runs a paid model with a $0 budget. Set a budget cap, or switch it to a local model.' },
  unpriced_model: { status: 402, title: 'Model has no price', hint: 'The gateway refuses remote models it cannot meter. Pick a priced model, or set HIVE_ALLOW_UNPRICED=1 on the hive.' },
  budget_exhausted: { status: 402, title: 'Budget spent', hint: 'The next call could pass this mind’s budget cap. Raise the cap to let it think again.' },
  hive_budget_exhausted: { status: 402, title: 'Hive budget spent', hint: 'The call would pass HIVE_BUDGET_USD for the whole hive. Every mind is paused until it is raised.' },
  rate_limited: { status: 429, title: 'Rate limited', hint: 'More than HIVE_MAX_LLM_CALLS_PER_MINUTE model calls this minute. It retries on its own.' },
  // the refusals a person hears (hive/core/refusals.py KINDS): each says its own reason, never the per-minute limit's
  free_inference_busy: { status: 429, title: 'Free inference busy', hint: 'More calls came in at once than the free key takes. It retries on its own.' },
  free_inference_daily_cap: { status: 429, title: 'Free calls used up', hint: 'Today’s free model calls for this mind’s person are used. They come back at midnight UTC, or add a key of your own.' },
  free_inference_hive_daily_cap: { status: 429, title: 'Hive’s free calls used up', hint: 'This hive has used today’s free model calls. They come back at midnight UTC, or add a key of your own.' },
  free_inference_off: { status: 403, title: 'Free inference off', hint: 'This hive doesn’t offer free inference now. Choose another way for this mind to think.' },
  free_model_not_offered: { status: 403, title: 'Model not offered free', hint: 'Free inference here doesn’t offer this mind’s model. Choose a model it offers, or another way to think.' },
  free_inference_invited_only: { status: 403, title: 'Free inference is for invited people', hint: 'Free inference on this hive is for the people it invited. Add a key of your own for this mind to think.' },
  free_inference_person_only: { status: 403, title: 'Free inference is for a person', hint: 'Free inference is for a person’s own use, and this call is for no one in particular.' },
  free_inference_key_refused: { status: 401, title: 'Free inference’s key refused', hint: 'Free inference’s provider refused the hive’s key. Add a key of your own, or choose another way for this mind to think.' },
  free_model_unreconciled: { status: 402, title: 'Model paused', hint: 'An earlier call to this model ended without a clear answer, so it isn’t called again until that is settled. Choose another model to go on now.' },
  provider_no_credit: { status: 402, title: 'No credit at the provider', hint: 'The account behind this mind’s key has no credit left. Add credit there, or choose a free model or another key.' },
  provider_key_refused: { status: 401, title: 'Key refused by the provider', hint: 'The provider refused the key that pays for this mind. Check the key, or use another one.' },
  provider_busy: { status: 429, title: 'Provider busy', hint: 'The provider is taking no more calls to this model for now. It retries on its own; another model goes on sooner.' },
  provider_unavailable: { status: null, title: 'Provider unavailable', hint: 'The provider couldn’t answer just now. It retries on its own.' },
  provider_request_refused: { status: null, title: 'Request refused by the provider', hint: 'The provider wouldn’t take this request for this mind’s model. Choose another model.' },
}

// matched longest first, so a code that holds another (hive_budget_exhausted holds budget_exhausted) is found first, and
// a refusal's own 429 is never read as the per-minute limit
const ORDER = (Object.keys(KNOWN) as LlmErrorCode[]).sort((a, b) => b.length - a.length)

/**
 * Reads a mind's `last_error`. The contract does not fix its format, so the gateway's error codes
 * are matched anywhere in the text (e.g. "llm: 402 no_budget" or a JSON error body).
 */
export function describeLlmError(text: string | null | undefined): LlmErrorInfo | null {
  if (!text) return null
  for (const code of ORDER) {
    if (text.includes(code)) return { code, ...KNOWN[code] }
  }
  if (/\b429\b/.test(text)) return { code: 'rate_limited', ...KNOWN.rate_limited }
  return { code: 'other', status: null, title: 'Error', hint: text }
}
