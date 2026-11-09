import { plural } from '../../lib/plural'
import { ApiError, type SwarmCounts, type SwarmDeletePreview, type SwarmDeleteResult } from '../../api/client'
import { STALE, type EpochBinding } from '../../lib/identityEpoch'

/**
 * Delete a swarm together with its minds (Jon 2026-10-07, "Do it" 2026-10-08), the pure part: the host's read-only
 * preview (GET /api/swarms/{id}/delete-preview) read and put in plain words, the typed-name gate, and every result and
 * refusal in plain words. Nothing here ever sends the plain DELETE to find out what a swarm holds. The host counts
 * `goals`; people read them as tasks, so every sentence here says tasks. The dialog (SwarmDeleteDialog.tsx) and the
 * Ask share all of it.
 */

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

/** Host words, never shown raw: "goal" reads "task" (the host's reason already says tasks; older text may not). */
export const taskWords = (s: string) => s.replace(/\bgoals\b/gi, 'tasks').replace(/\bgoal\b/gi, 'task')

/** The preview as the host sent it, checked field by field (untrusted); null when it is not a preview at all. */
export function readPreview(raw: unknown): SwarmDeletePreview | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.counts || typeof r.counts !== 'object') return null
  const c = r.counts as Record<string, unknown>
  const counts: SwarmCounts = { minds: n(c.minds), members: n(c.members), goals: n(c.goals), artifacts: n(c.artifacts), child_swarms: n(c.child_swarms) }
  const awake = Array.isArray(r.awake_minds)
    ? r.awake_minds.flatMap((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? [{ id: (m as { id: string }).id, name: typeof (m as { name?: unknown }).name === 'string' ? (m as { name: string }).name : (m as { id: string }).id }] : []))
    : []
  return {
    name: r.name,
    counts,
    awake_minds: awake,
    would: r.would === 'delete' ? 'delete' : 'archive',
    reason: typeof r.reason === 'string' ? r.reason : '',
    released_tasks_estimate: n(r.released_tasks_estimate),
    busy: typeof r.busy === 'string' && r.busy ? r.busy : r.busy === false || r.busy == null ? false : 'the hive says it is busy',
  }
}

/** The preview in plain words, one line per thing that happens. */
export interface PreviewWords {
  minds: string
  awake: string | null
  tasks: string
  fate: string
  kept: string[]
  busy: string | null
}

export function previewWords(name: string, p: SwarmDeletePreview): PreviewWords {
  const k = p.counts.minds
  const awake = p.awake_minds.map((m) => m.name)
  const t = p.released_tasks_estimate
  const kept: string[] = []
  // the host counts swarms under any of its agents (members and earlier-deleted minds too), but only those under the
  // minds THIS delete removes are detached (Kimi K3): never promise more; the result names the ones that were
  if (p.counts.child_swarms) kept.push(`Up to ${plural(p.counts.child_swarms, 'swarm sits', 'swarms sit')} inside its minds or members. None is deleted; any inside the minds deleted here will stand on ${p.counts.child_swarms === 1 ? 'its' : 'their'} own, and the result lists which.`)
  if (p.counts.members) kept.push(`${plural(p.counts.members, 'external member is', 'external members are')} never deleted with it.`)
  const why = taskWords(p.reason).replace(/^it has /, '')
  return {
    minds: k ? `${plural(k, 'mind', 'minds')} will be deleted.` : 'No minds remain in it. If an earlier delete left cleanup unfinished, this finishes it.',
    awake: awake.length ? `Awake now, stopped first: ${awake.join(', ')}.` : null,
    tasks: t ? `${plural(t, 'unfinished task', 'unfinished tasks')} held by or given to these minds will be released: back to open, with no one on ${t === 1 ? 'it' : 'them'}.` : 'No unfinished tasks are held by these minds, so none are released.',
    fate:
      p.would === 'delete'
        ? `${name} itself will be deleted: nothing of it would remain. This cannot be undone.`
        : `${name} itself will be archived, not deleted, because ${why ? `it has ${why}` : 'it has history'}. You can restore it from Archived swarms; its minds are still deleted.`,
    kept,
    busy: p.busy ? `Busy right now: ${taskWords(p.busy)}. Deleting would be refused until that finishes. Check again in a moment.` : null,
  }
}

/** The press is allowed only for the exact name: capitals and spaces count, as the hive checks. */
export const nameMatches = (typed: string, name: string) => typed === name

export interface DoneWords {
  title: string
  body: string
  /** the swarms that were inside its minds and now stand on their own (ids) */
  detached: string[]
  /** a partial answer: the same request again finishes it */
  partial: boolean
  /** a partial answer: the minds still in the swarm, by name (Kimi K1); Finish the delete deletes them */
  remaining?: string[]
  /** a partial answer: minds deleted whose cleanup is still pending */
  pending?: number
  /** a partial answer: why it stopped, in words for its error code (Kimi K4) */
  stopped?: string
}

/**
 * What every attempt so far did, together (stand-in r1 P2-4): a retry's answer reports only that attempt's work (it may
 * finish the cleanup of minds an earlier attempt deleted), so the totals are kept across attempts: mind ids deduplicated,
 * released tasks added up, detached swarms joined.
 */
export interface Progress {
  attempts: number
  minds: string[]
  released: number
  detached: string[]
}
export const NO_PROGRESS: Progress = { attempts: 0, minds: [], released: 0, detached: [] }
export function addAttempt(p: Progress, r: SwarmDeleteResult): Progress {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    attempts: p.attempts + 1,
    minds: [...new Set([...p.minds, ...ids(r.deleted_minds)])],
    released: p.released + n(r.released_tasks),
    detached: [...new Set([...p.detached, ...ids(r.detached_swarms)])],
  }
}

/** The result in plain words: done, or partly done with cleanup pending. `total` is every attempt so far, this one included. */
export function resultWords(name: string, r: SwarmDeleteResult, total: Progress = addAttempt(NO_PROGRESS, r), nameOf: (id: string) => string = (id) => id): DoneWords {
  const k = total.minds.length
  const detached = total.detached
  const released = total.released
  const several = total.attempts > 1
  const tasks = released ? ` ${plural(released, 'task was', 'tasks were')} released back to open${several ? ' in all' : ''}.` : ''
  const skipped = Array.isArray(r.skipped_minds) && r.skipped_minds.length ? ` ${r.skipped_minds.map((m) => m.name).join(', ')} moved to another swarm meanwhile and ${r.skipped_minds.length === 1 ? 'was' : 'were'} left alone.` : ''
  const thisTime = several ? ` This attempt ${Array.isArray(r.deleted_minds) && r.deleted_minds.length ? `finished ${plural(r.deleted_minds.length, 'mind', 'minds')}` : 'deleted no further minds'}.` : ''
  const deletedSoFar = k ? `${plural(k, 'mind was', 'minds were')} deleted${several ? ` over ${total.attempts} attempts` : ''}.` : 'No mind was deleted yet.'
  if (r.error) {
    const pending = Array.isArray(r.cleanup_pending) ? r.cleanup_pending.length : 0
    const remaining = (Array.isArray(r.remaining_minds) ? r.remaining_minds : []).filter((x): x is string => typeof x === 'string').map(nameOf)
    const stopped = stoppedWords(r.error, nameOf)
    const parts = [
      `${name} is archived and none of its minds is running.`,
      stopped,
      deletedSoFar,
      pending ? `Cleanup is still pending for ${plural(pending, 'deleted mind', 'deleted minds')}.` : '',
      remaining.length ? `Still in the swarm: ${remaining.join(', ')}.` : '',
      `Finish the delete to complete it${remaining.length ? ` (it deletes ${remaining.length === 1 ? 'that mind' : 'those minds'} too)` : ''}, or restore the swarm from Archived swarms to keep what remains.`,
    ]
    return { title: `${name} was only partly deleted`, body: parts.filter(Boolean).join(' ') + tasks + skipped + thisTime, detached, partial: true, remaining, pending, stopped }
  }
  if (r.swarm === 'deleted') return { title: `${name} was deleted`, body: (k ? `The swarm was deleted, with its ${plural(k, 'mind', 'minds')}${several ? ` (over ${total.attempts} attempts)` : ''}.` : 'The swarm was deleted; it had no minds left.') + tasks + skipped + thisTime, detached, partial: false }
  const why = r.reason ? taskWords(r.reason).replace(/^it has /, '') : 'history'
  const minds = k ? deletedSoFar : 'It had no minds left.'
  return { title: `${name} was archived, not deleted`, body: `${minds} The swarm was kept, archived, because it has ${why}. You can restore it from Archived swarms.${tasks}${skipped}${thisTime}`, detached, partial: false }
}

/** Why a partial answer stopped, one sentence per error code (Kimi K4); the host's message only as a last resort. */
export function stoppedWords(e: { code?: unknown; message?: unknown; mind?: unknown } | undefined, nameOf: (id: string) => string = (id) => id): string {
  if (!e || typeof e !== 'object') return ''
  const who = typeof e.mind === 'string' ? nameOf(e.mind) : 'one mind'
  if (e.code === 'cleanup_failed') return `${who} was deleted, but its cleanup did not finish.`
  if (e.code === 'minds_unstoppable') return `1 mind wouldn't stop: ${who}. Nothing more was deleted.`
  const said = typeof e.message === 'string' && e.message ? `: ${taskWords(e.message)}` : ''
  return `It stopped at ${who}${said}. Nothing more was deleted.`
}

/**
 * The delete was sent but its answer never arrived or could not be read (status 0: the network dropped, or a successful
 * answer was unreadable), so it may have gone through (stand-in r1 P2-3). Never "try again": read what is there first.
 */
export const outcomeUnknown = (e: unknown) => e instanceof ApiError && e.status === 0

export const UNKNOWN_WORDS = 'The delete was sent, but its answer was lost, so whether it went through is not known. Reading what is there now…'

/**
 * After a lost answer: what a re-read of the preview says happened. `gone`: the swarm is not there (404), so the delete
 * went through. Otherwise the fresh preview, to decide again from what is really there.
 */
export function reconciledWords(name: string, r: { gone: true } | { gone: false; preview: SwarmDeletePreview } | { failed: string }): { title: string; body: string } {
  if ('failed' in r) return { title: 'Not known yet', body: `The delete was sent, but its answer was lost, and reading the swarm again failed too (${r.failed}) Whether it went through is still not known. Check again before doing anything else.` }
  if (r.gone) return { title: `${name} was deleted`, body: 'The answer was lost, but reading again shows the swarm is gone: the delete went through.' }
  const k = r.preview.counts.minds
  return {
    title: `What is there now`,
    body: `The answer was lost; reading again shows ${name} ${k ? `still has ${plural(k, 'mind', 'minds')}` : 'has no minds left'}. Nothing more is sent unless you confirm again below.`,
  }
}

/** Failures every call shares. */
function commonFailure(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'The hive did not answer, or its answer could not be read. Check the connection; nothing here is confirmed.'
    if (e.status === 401) return 'Your sign-in ended. Sign in again, then try once more.'
    if (e.code === 'admin_only' || e.status === 403) return 'Only admins can delete a swarm.'
    if (e.status === 404) return "That swarm isn't here any more, or this hive can't delete a swarm with its minds yet."
  }
  return 'Something went wrong. Nothing is confirmed; look at the swarm before trying again.'
}

/** A refusal of the delete itself, in plain words. */
export function refusalWords(e: unknown, name: string): { words: string; minds?: string[]; expected?: string } {
  if (e instanceof ApiError) {
    if (e.code === 'confirm_mismatch') {
      const expected = typeof e.envelope?.expected === 'string' ? e.envelope.expected : undefined
      return expected && expected !== name
        ? { words: `The hive says this swarm is now called exactly “${expected}”. Type that to confirm. Nothing changed.`, expected }
        : { words: `The name you typed isn't exactly “${name}” (capitals and spaces count). Nothing changed.`, expected }
    }
    if (e.code === 'swarm_busy') return { words: `${name} is busy right now: ${taskWords(e.message || 'something is changing here')}. Nothing was deleted. Try again in a moment.` }
    if (e.code === 'minds_unstoppable') {
      const failed = Array.isArray(e.envelope?.failed) ? (e.envelope!.failed as unknown[]) : []
      const minds = failed.map((f) => (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' ? (f as { name: string }).name : '')).filter(Boolean)
      return { words: `Nothing was deleted: ${minds.length ? `${minds.length === 1 ? 'this mind' : 'these minds'} could not be stopped` : 'some minds could not be stopped'}. Minds that did stop stay asleep. Try again, or stop them from their own pages first.`, minds }
    }
  }
  return { words: commonFailure(e) }
}

/** The preview read under the binding: its answer is handed back only while the identity that asked still holds. */
export async function fetchPreview(
  swarm: { id: string },
  deps: { binding: EpochBinding; preview: (id: string) => Promise<unknown> },
): Promise<{ ok: true; preview: SwarmDeletePreview } | { ok: false; words: string } | null> {
  const sent = deps.binding.commit(() => deps.preview(swarm.id))
  if (sent === STALE) return null
  let out: { ok: true; preview: SwarmDeletePreview } | { ok: false; words: string }
  try {
    const p = readPreview(await sent)
    out = p ? { ok: true, preview: p } : { ok: false, words: "The hive's answer could not be read. Nothing was changed." }
  } catch (error) {
    out = { ok: false, words: commonFailure(error) }
  }
  return deps.binding.current() ? out : null
}

/**
 * The one press: nothing unless the typed name matches exactly; dispatched only through `binding.commit` (the identity
 * that opened the warning, checked in the same tick); the answer is handed back only while that identity holds.
 */
export async function pressDelete(
  swarm: { id: string; name: string },
  typed: string,
  deps: { binding: EpochBinding; del: (id: string, confirm: string) => Promise<SwarmDeleteResult> },
): Promise<{ ok: true; result: SwarmDeleteResult } | { ok: false; error: unknown } | null> {
  if (!nameMatches(typed, swarm.name)) return null
  const sent = deps.binding.commit(() => deps.del(swarm.id, typed))
  if (sent === STALE) return null
  let out: { ok: true; result: SwarmDeleteResult } | { ok: false; error: unknown }
  try {
    out = { ok: true, result: await sent }
  } catch (error) {
    out = { ok: false, error }
  }
  return deps.binding.current() ? out : null
}

/**
 * Which of the tasks this page has loaded the delete would release (goals.release_rows' selection), for naming them
 * beside the host's count; the host's count is the authority.
 */
export function knownReleased<G extends { id: string; title: string; status: string; assignee?: string | null; claimed_by?: string | null }>(goals: G[], mindIds: Set<string>): G[] {
  const mine = (v: string | null | undefined) => !!v && mindIds.has(v)
  return goals.filter((g) => (['open', 'claimed', 'waiting', 'stalled'].includes(g.status) && (mine(g.assignee) || mine(g.claimed_by))) || (g.status === 'submitted' && mine(g.assignee)))
}

/**
 * After a lost answer, read (never write) what is there: the preview again. A 404 means the swarm is gone (the same
 * route answered a moment ago, so it is not a hive without it). Bound like every other call.
 */
export async function reconcile(
  swarm: { id: string },
  deps: { binding: EpochBinding; preview: (id: string) => Promise<unknown> },
): Promise<{ gone: true } | { gone: false; preview: SwarmDeletePreview } | { failed: string } | null> {
  const sent = deps.binding.commit(() => deps.preview(swarm.id))
  if (sent === STALE) return null
  let out: { gone: true } | { gone: false; preview: SwarmDeletePreview } | { failed: string }
  try {
    const p = readPreview(await sent)
    out = p ? { gone: false, preview: p } : { failed: "its answer could not be read." }
  } catch (error) {
    out = error instanceof ApiError && error.status === 404 ? { gone: true } : { failed: commonFailure(error) }
  }
  return deps.binding.current() ? out : null
}

/**
 * Where a refused "Finish the delete" goes (stand-in r1 P2-2): when the hive says the swarm is now called something
 * else, back to a typed confirmation of that exact name (the earlier progress kept); otherwise stay on the result with
 * the refusal in words.
 */
export function afterFinishRefusal(error: unknown, confirm: string): { kind: 'reconfirm'; name: string; refusal: string } | { kind: 'done'; refusal: string } {
  const ref = refusalWords(error, confirm)
  return ref.expected && ref.expected !== confirm ? { kind: 'reconfirm', name: ref.expected, refusal: ref.words } : { kind: 'done', refusal: ref.words }
}

/**
 * Which swarm-delete action a swarm's settings offer (stand-in r1 P2-1): with minds, delete them with it; archived with
 * none left (an earlier delete may have left cleanup pending), finish deleting it; otherwise none (the plain Delete and
 * Archive cover an empty live swarm).
 */
export function deleteActionFor(s: { minds: number; archived: boolean }): 'delete' | 'finish' | null {
  if (s.minds > 0) return 'delete'
  return s.archived ? 'finish' : null
}
