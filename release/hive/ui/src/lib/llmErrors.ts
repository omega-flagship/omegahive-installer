import type { LlmErrorCode } from '../api/types'

export interface LlmErrorInfo {
  code: LlmErrorCode | 'other'
  status: 402 | 429 | null
  title: string
  hint: string
}

const KNOWN: Record<LlmErrorCode, Omit<LlmErrorInfo, 'code'>> = {
  no_budget: { status: 402, title: 'No budget for a paid model', hint: 'This mind runs a paid model with a $0 budget. Set a budget cap, or switch it to a local model.' },
  unpriced_model: { status: 402, title: 'Model has no price', hint: 'The gateway refuses remote models it cannot meter. Pick a priced model, or set HIVE_ALLOW_UNPRICED=1 on the hive.' },
  budget_exhausted: { status: 402, title: 'Budget spent', hint: 'The next call could pass this mind’s budget cap. Raise the cap to let it think again.' },
  hive_budget_exhausted: { status: 402, title: 'Hive budget spent', hint: 'The call would pass HIVE_BUDGET_USD for the whole hive. Every mind is paused until it is raised.' },
  rate_limited: { status: 429, title: 'Rate limited', hint: 'More than HIVE_MAX_LLM_CALLS_PER_MINUTE model calls this minute. It retries on its own.' },
}

/**
 * Reads a mind's `last_error`. The contract does not fix its format, so the gateway's error codes
 * are matched anywhere in the text (e.g. "llm: 402 no_budget" or a JSON error body).
 */
export function describeLlmError(text: string | null | undefined): LlmErrorInfo | null {
  if (!text) return null
  // most specific first: hive_budget_exhausted contains budget_exhausted
  for (const code of ['hive_budget_exhausted', 'budget_exhausted', 'no_budget', 'unpriced_model', 'rate_limited'] as const) {
    if (text.includes(code)) return { code, ...KNOWN[code] }
  }
  if (/\b429\b/.test(text)) return { code: 'rate_limited', ...KNOWN.rate_limited }
  return { code: 'other', status: null, title: 'Error', hint: text }
}
