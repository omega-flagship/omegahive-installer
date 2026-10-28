import type { PageView } from '../../ask/view'
import { heldCount, MODULES, type ModuleId } from './contract'
import type { ViewState } from './load'

/** The presence region the six viewers sit in (the conductor may point at it; a tour may scroll to it). */
export const REASONING_REGION = 'reasoning-modules'

/**
 * What the reasoning viewers export to the Ask (PageView → the conductor model): METADATA ONLY. Per module: its
 * state, a count and the observed time. Never a label, term, id, reason code, explanation or evidence ref: those
 * stay on screen for the person (Root 143526Z: labels, terms and evidence stay off the model export).
 */
export function reasoningPageView(mindId: string, states: Record<ModuleId, ViewState>): PageView {
  const parts = MODULES.map((m) => {
    const s = states[m]
    if (s.kind === 'unavailable') return `${m}: unavailable (${s.why.replace('_', ' ')})`
    if (s.kind === 'current' || s.kind === 'empty') return `${m}: current, ${heldCount(s.envelope)} held, observed ${s.envelope.observed_at ?? 'unknown'}`
    // synthetic and banked are never exported as a module's state from the current-state area
    if (s.kind === 'loading') return `${m}: reading`
    return `${m}: unavailable (unreadable)`
  })
  return {
    title: 'Reasoning modules',
    summary: parts.join('; '),
    refs: [{ kind: 'mind', ref: mindId }],
    regions: [REASONING_REGION],
  }
}
