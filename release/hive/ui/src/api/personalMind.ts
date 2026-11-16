/**
 * The person's own personal mind (Platform P1, personal-mind-p1 308727d + r2 0dbd550; plan
 * PLATFORM_PERSONAL_MIND_ASK_PLAN_R1_20261008): one mind per named person, asleep in its own swarm, that the Ask
 * speaks through. The hive keeps its identity, routing, billing and version; its memory lives in the person's browser
 * (lib/askMemory). Every reader here takes the host's answer as unknown and keeps only what is well formed.
 *
 * Routes (owner only):
 * - GET  /api/me/mind                    {mind}                         403 person_required; 404 on a host without P1
 * - POST /api/me/mind {name}             {mind, created}                rename, or make it if missing
 * - GET  /api/me/mind/inbox?after=&limit {items:[{id,turn_id,created_at,words,answer,truncated}], next, dropped, expired}
 * - POST /api/me/mind/inbox/ack {ids}    {deleted}                      only after this browser durably kept them
 * - GET  /api/me/mind/versions           {current, best, candidates}    P3/P4: 404 until then
 * - POST /api/me/mind/adopt {version_id} {mind}                         409 already_current, 404 unknown_version
 * - POST /api/me/mind/rollback           {mind}                         409 nothing_to_roll_back
 */

export interface MindVersion {
  id: string
  label: string
  /** the benchmark's scores, when the read carries them */
  score?: MindScore | null
  measured_at?: string | null
  suite_run_id?: string | null
}
export interface MindScore {
  /** share of Ask tasks done right (0..1) */
  success: number
  steps: number
  cost_usd: number
}

export interface PersonalMind {
  id: string
  name: string
  swarm_id: string | null
  /** the mind's own status (asleep until the Ask speaks through it) */
  status: string
  version: MindVersion | null
  adopted_at: string | null
  previous_version_id: string | null
  /** the person's month allowance that pays for it (P1: budget 0, the person pays) */
  allowance_usd: number | null
}

export interface MindVersions {
  current: MindVersion | null
  best: MindVersion | null
  candidates: MindVersion[]
}

/** A held copy of one exchange with a swarm (personal_inbox.items). */
export interface InboxItem {
  id: string
  turn_id: string
  /** when it was held (epoch ms) */
  at: number
  words: string
  answer: string
  truncated: boolean
}
export interface InboxPage {
  items: InboxItem[]
  next: string | null
  /** how many of this person's copies the hive let go uncollected, ever (over its cap: dropped; after 7 days: expired) */
  dropped: number
  expired: number
}

/** The host's caps: a page holds at most 50 items; an ack names at most 200 ids (personal_inbox PAGE, MAX_ACK). */
export const INBOX_PAGE = 50
export const ACK_MAX = 200

const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
/** a name as a person reads it: plain words, no control characters */
export const plainName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120 && !/\p{Cc}/u.test(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const when = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)

function readScore(v: unknown): MindScore | null {
  if (!isObj(v) || !num(v.success) || !num(v.steps) || !num(v.cost_usd)) return null
  return { success: Math.min(1, Math.max(0, v.success > 1 ? v.success / 100 : v.success)), steps: v.steps, cost_usd: v.cost_usd }
}
/** A version as the person sees it: its name and scores only (never which model it runs). */
export function readVersion(v: unknown): MindVersion | null {
  if (!isObj(v) || !id(v.id)) return null
  const label = plainName(v.label) ? v.label : v.id
  return { id: v.id, label, score: readScore(v.score), measured_at: when(v.measured_at), suite_run_id: id(v.suite_run_id) ? v.suite_run_id : null }
}

/** GET /api/me/mind (and POST's answer): the mind, if well formed; null for `{mind:null}` or anything else. */
export function readPersonalMind(v: unknown): PersonalMind | null {
  const m = isObj(v) ? v.mind : null
  if (!isObj(m) || !id(m.id) || !plainName(m.name)) return null
  return {
    id: m.id,
    name: m.name,
    swarm_id: id(m.swarm_id) ? m.swarm_id : null,
    status: typeof m.status === 'string' ? m.status.slice(0, 20) : 'asleep',
    version: readVersion(m.version),
    adopted_at: when(m.adopted_at),
    previous_version_id: id(m.previous_version_id) ? m.previous_version_id : null,
    allowance_usd: num(m.allowance_usd) ? m.allowance_usd : null,
  }
}

export function readVersions(v: unknown): MindVersions | null {
  if (!isObj(v)) return null
  const candidates = Array.isArray(v.candidates) ? v.candidates.map(readVersion).filter((x): x is MindVersion => !!x).slice(0, 20) : []
  return { current: readVersion(v.current), best: readVersion(v.best), candidates }
}

const TEXT_MAX = 16 * 1024
/** One page of held copies; a malformed item is left out (and so never acknowledged: the hive keeps it). */
export function readInboxPage(v: unknown): InboxPage {
  const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)
  if (!isObj(v) || !Array.isArray(v.items)) return { items: [], next: null, dropped: 0, expired: 0 }
  const items: InboxItem[] = []
  for (const r of v.items.slice(0, INBOX_PAGE)) {
    if (!isObj(r) || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || !id(r.turn_id)) continue
    const at = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN
    if (!Number.isFinite(at) || typeof r.words !== 'string' || typeof r.answer !== 'string' || r.words.length > TEXT_MAX || r.answer.length > TEXT_MAX) continue
    items.push({ id: r.id, turn_id: r.turn_id, at, words: r.words, answer: r.answer, truncated: r.truncated === true })
  }
  return { items, next: typeof v.next === 'string' && v.next ? v.next : null, dropped: count(v.dropped), expired: count(v.expired) }
}

/** `acting_as` on a conductor turn's accepted frame or turn view (Platform P2): the person's own mind acting for them. */
export function readActingAs(v: unknown): { mind_id: string; name: string } | null {
  if (!isObj(v)) return null
  return id(v.mind_id) && plainName(v.name) ? { mind_id: v.mind_id, name: v.name } : null
}

/** The presence the figure shows: asleep, waking, listening (awake, ready) or working (acting for the person now). */
export type MindPresence = 'asleep' | 'waking' | 'listening' | 'working'
export const PRESENCE_ORDER: readonly MindPresence[] = ['asleep', 'waking', 'listening', 'working']
export const PRESENCE_WORDS: Record<MindPresence, string> = { asleep: 'Asleep', waking: 'Waking', listening: 'Listening', working: 'Working' }
export function presenceOf(status: string, working: boolean): MindPresence {
  if (working) return 'working'
  if (status === 'starting' || status === 'waking') return 'waking'
  if (status === 'awake' || status === 'running' || status === 'idle') return 'listening'
  return 'asleep'
}
