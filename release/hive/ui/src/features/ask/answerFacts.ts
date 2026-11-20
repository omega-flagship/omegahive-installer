// Purpose: the facts and data the ask-answer screen (answer.metta) composes from: an answer's source, and the research its
// turn held back because the Research swarm is asleep, with how a press of Wake has gone.
import type { ScreenFacts } from '../../screens/screenSpace'
import type { AskRow } from '../../store/ask'
import type { ResearchWakeView } from '../../store/askResearchWake'
import { answerSourceWords, researchWakeWords, shownMind } from './words'

/** How a held-back research request stands, for answer.metta (its comment lists them). */
export type WaitPhase = 'ready' | 'working' | 'sent' | 'blocked' | 'failed' | 'closed'

/** The held-back request's phase: the intent's own state wins over this page's press (a send from another tab). */
export function waitPhase(state: NonNullable<AskRow['wait']>['state'], v: ResearchWakeView | null): WaitPhase {
  if (state === 'linked' || v?.phase === 'sent') return 'sent'
  if (state === 'abandoned' || v?.unsent === 'gone') return 'closed'
  if (state === 'dispatching' || v?.phase === 'working') return 'working'
  return v?.phase ?? 'ready'
}

/**
 * The ask-answer screen's facts and data for one answer row. A row with neither a source nor a held-back request states
 * nothing, so nothing shows under it. Pure.
 * Example: a conducted turn's answer by Vega, the asker's own mind, gives the value answer.source = model and the line
 * "From Vega’s model alone, without a web search."
 */
export function answerScreen(r: Pick<AskRow, 'source' | 'wait' | 'who' | 'whoId'>, wake: ResearchWakeView | null): { data: Record<string, unknown>; facts: ScreenFacts } {
  const data: Record<string, unknown> = {}
  const values: Record<string, string> = {}
  if (r.source) {
    values['answer.source'] = r.source.kind
    data['answer.source.text'] = answerSourceWords(r.source, r.who ? shownMind(r.who, r.whoId) : null)
  }
  if (r.wait) {
    const phase = waitPhase(r.wait.state, wake)
    values['answer.wait.phase'] = phase
    data['answer.wait.say'] = researchWakeWords(phase, wake)
  }
  return { data, facts: { flags: { 'answer.wait': !!r.wait }, values } }
}
