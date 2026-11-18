import type { LlmErrorCode } from '../api/types'

export interface LlmErrorInfo {
  code: LlmErrorCode | 'other'
  status: 402 | 403 | 429 | null
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
}

/**
 * Reads a mind's `last_error`. The contract does not fix its format, so the gateway's error codes
 * are matched anywhere in the text (e.g. "llm: 402 no_budget" or a JSON error body).
 */
export function describeLlmError(text: string | null | undefined): LlmErrorInfo | null {
  if (!text) return null
  // most specific first: hive_budget_exhausted contains budget_exhausted, and a free refusal's 429 is not the per-minute limit
  for (const code of ['free_inference_busy', 'free_inference_daily_cap', 'free_inference_hive_daily_cap', 'free_inference_off', 'free_model_not_offered', 'free_inference_invited_only', 'free_inference_person_only', 'hive_budget_exhausted', 'budget_exhausted', 'no_budget', 'unpriced_model', 'rate_limited'] as const) {
    if (text.includes(code)) return { code, ...KNOWN[code] }
  }
  if (/\b429\b/.test(text)) return { code: 'rate_limited', ...KNOWN.rate_limited }
  return { code: 'other', status: null, title: 'Error', hint: text }
}
