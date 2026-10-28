import { outcomeUnknown } from '../lib/decisionGate'
import type { FormActResult } from './contract'

/**
 * Review B1 (commons f0818d8): what an act that threw resolves to, for the host (features/programs/ProgramForm) and
 * for a form that guards its own act. An error after which the act may have been delivered (lib/decisionGate
 * outcomeUnknown: no answer, a 5xx, still in progress) is `unknown`; any other is a plain error. Never a refusal: a
 * thrown error alone does not establish that nothing happened.
 */
export function actErrorResult(e: unknown): FormActResult {
  const message = e instanceof Error ? e.message : String(e)
  return outcomeUnknown(e) ? { status: 'error', message, unknown: true } : { status: 'error', message }
}
