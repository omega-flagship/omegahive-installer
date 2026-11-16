// Purpose: what the Usage screen's held calls (usage.metta) are told: the held calls with how and when each settles, the calls still in flight, the estimates a person may correct and the calls that cost more than was held, as rows bound by path, with their counts and the in-flight row's state as facts, and the held list's state as the resource named held. Pure: names, the clock and whether the in-flight row is open come in as arguments.
import type { CostOverrun, CostReservation, EstimatedCall } from '../../api/moneyWork'
import { ago } from '../../lib/format'
import { plural } from '../../lib/plural'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'
import type { ScreenFacts } from '../../screens/screenSpace'
import { canCorrect, ESTIMATE_WORDS, estimateSummary, estimateTiming, exactUsd, heldFor, heldReason, isFreeFloor, overrunUsd, settlesWords, splitHeld } from './settle'

/** How many estimates the list shows before "and N more" (Correct all still takes every one). */
export const ESTIMATES_SHOWN = 8
/** How many overruns the list shows, newest first. */
const OVERRUNS_SHOWN = 8

export type Namer = (kind: 'agent' | 'swarm' | 'key', id: string) => string

/** Where an overrun's cost came from, in a person's words. */
const OVERRUN_SOURCE: Record<string, string> = {
  'provider-record': 'found in OpenRouter’s record',
  resolve: 'settled by a person',
  correct: 'corrected by a person',
  'late-after-release': 'reported after its hold was released',
}

const who = (md: { agent?: string | null }, name: Namer) => (md.agent ? name('agent', md.agent) : 'a call')
const onModel = (md: { model?: string | null }) => (md.model ? ` on ${md.model}` : '')

/** The estimates the panel offers to correct now: the ones still inside their 30 days. */
export const correctable = (estimates: EstimatedCall[] | undefined, now: number) => (estimates ?? []).filter((e) => canCorrect(e, now))

/**
 * The held calls' data and facts. `held` is the held list's resource (its status, stated as the resource named held,
 * drives the shared loading, failed and stale parts); `estimates` is the estimates list once it is read, else undefined;
 * `overruns` whatever has been read.
 */
export function heldCallsScreen(
  held: ResourceLike & { data?: CostReservation[] },
  estimates: EstimatedCall[] | undefined,
  overruns: CostOverrun[] | undefined,
  name: Namer,
  now: number,
  inFlightOpen: boolean,
): { data: Record<string, unknown>; facts: ScreenFacts } {
  const split = held.data ? splitHeld(held.data) : { unknown: [], inFlight: [] }
  const unknown = split.unknown.map((r: CostReservation) => ({
    id: r.id,
    icon: 'coin',
    title: `${isFreeFloor(r.held_usd) ? 'A free model’s call' : `${exactUsd(r.held_usd)} held`} for ${who(r.metadata, name)}${onModel(r.metadata)}`,
    settles: [settlesWords(r, now), heldFor(r, now)].filter(Boolean).join(' · '),
    reason: heldReason(r),
  }))
  const inflight = split.inFlight.map((r: CostReservation) => ({
    id: r.id,
    title: `${exactUsd(r.held_usd)} for ${who(r.metadata, name)}`,
    kind: r.metadata.model ?? r.metadata.kind ?? '',
    state: r.state,
    held_for: heldFor(r, now) ?? '',
  }))
  const open = correctable(estimates, now)
  const shown = open.slice(0, ESTIMATES_SHOWN).map((e) => ({
    id: e.id,
    icon: 'coin',
    badge: 'estimated',
    title: `${exactUsd(e.estimate_usd)} for ${who(e.metadata, name)}${onModel(e.metadata)}`,
    timing: estimateTiming(e, now),
    reason: heldReason(e),
    action: 'Correct…',
  }))
  const more = open.length - shown.length
  const overs = (overruns ?? []).slice(-OVERRUNS_SHOWN).reverse().map((o) => {
    const u = overrunUsd(o)
    return {
      id: `${o.reservation}:${o.at}`,
      title: `+${exactUsd(u.over)}`,
      summary: `${o.agent ? name('agent', o.agent) : 'a call'}: held ${exactUsd(u.held)}, cost ${exactUsd(u.actual)}`,
      source_words: OVERRUN_SOURCE[o.source ?? ''] ?? 'reported by the provider',
      when: ago(new Date(o.at * 1000).toISOString()),
    }
  })
  return withResource(held, {
    data: {
      'held.unknown': unknown,
      'held.unknown.n': split.unknown.length,
      'held.inflight': inflight,
      'held.inflight.n': split.inFlight.length,
      'held.inflight.open': inFlightOpen,
      'estimates.shown': shown,
      'estimates.open.n': open.length,
      'estimates.total': exactUsd(estimateSummary(open).usd),
      'estimates.words': ESTIMATE_WORDS,
      'estimates.more.words': plural(Math.max(0, more), 'more estimate'),
      overruns: overs,
    },
    facts: {
      counts: { 'held.unknown': split.unknown.length, 'held.inflight': split.inFlight.length, 'estimates.open': open.length, 'estimates.more': Math.max(0, more), overruns: overs.length },
      flags: { 'held.inflight.open': inFlightOpen, 'estimates.several': open.length > 1 },
    },
  }, 'held')
}
