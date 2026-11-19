// Purpose: the facts and data the mind-refused screen (refused.metta) composes from: the refusal a mind's own model calls
// last met, as the hive keeps it on the mind (Agent.refused, from hive/core/refusals.py's table).
import type { Agent } from '../../api/types'
import { plural } from '../../lib/plural'
import type { ScreenFacts } from '../../screens/screenSpace'
import { spokenRefusal } from '../ask/words'

/** When the mind tries again, in words: "in about 4 minutes", "in 20 seconds", or "now" once the time has come. */
function until(retryAt: string, now: number): string {
  const seconds = Math.round((Date.parse(retryAt) - now) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now'
  if (seconds < 60) return `in ${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'in about an hour' : `in about ${hours} hours`
}

/**
 * The mind-refused screen's facts and data. Facts are a flag and the remedy only; the words stay in the data: the
 * hive's sentence, and a line saying how many calls in a row met it and when the mind tries again by itself. The
 * hive's own refusals hold no call (retry_at null), so their line names no time; with one call refused and no time
 * there is no line, and refused.noted is off. A refusal in any other shape (an older hive, a remedy the page doesn't
 * know) states nothing, so nothing shows. Pure.
 * Example: a third 402 in a row with retry_at 4 minutes away gives the line "3 calls in a row were refused. It tries
 * again in about 4 minutes, or as soon as someone writes to it."
 */
export function refusedScreen(agent: Pick<Agent, 'refused'>, now = Date.now()): { data: Record<string, unknown>; facts: ScreenFacts } {
  const r = agent.refused
  if (!r || typeof r.say !== 'string' || !r.say || !spokenRefusal(r.remedy)) return { data: {}, facts: { flags: { 'refused.here': false } } }
  const count = Number.isInteger(r.count) && r.count > 1 ? `${plural(r.count, 'call')} in a row were refused.` : ''
  const timed = typeof r.retry_at === 'string' && r.retry_at !== '' ? `It tries again ${until(r.retry_at, now)}, or as soon as someone writes to it.` : ''
  const when = [count, timed].filter(Boolean).join(' ')
  return {
    data: { 'refused.say': r.say, 'refused.when': when },
    facts: { flags: { 'refused.here': true, 'refused.noted': when !== '' }, values: { 'refused.remedy': r.remedy } },
  }
}
