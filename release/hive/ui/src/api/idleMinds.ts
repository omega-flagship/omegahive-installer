/**
 * Health's idle minds (Platform idle-minds r2, PLATFORM_IDLE_MINDS_R2_SHAPES): Health notices an awake mind with no
 * input, asks it (sleep, or say what it is waiting for / finish what it owes), and the mind answers. Nothing here
 * sleeps a mind by itself; a person sees all of it and may Remind or Sleep.
 *
 * Routes:
 * - GET  /api/health/idle[?include=personal]           {minds: IdleMind[], generated_at, window}
 * - GET  /api/agents/{id}/health/idle[?include=personal] IdleMind & {history: IdleRecord[]} (newest first, at most 20)
 * - POST /api/agents/{id}/health/remind                 same as the GET; 409 not_awake, 403 personal_mind, 404 not_found
 *
 * Readers: an admin or the mind's owner. Another person's personal mind is hidden unless an admin audits
 * (`?include=personal`, opt-in, read-only). A personal mind is reminded by its person only.
 *
 * Who may act is the HOST's answer (Platform r2.4): `may_remind`, `may_sleep` and `is_mine` on every idle row and on
 * `/api/agents`. The UI never infers ownership; a missing flag is false (fail closed).
 *
 * Every reader here takes the host's answer as unknown and keeps only what is well formed.
 */

export type IdleKind = 'owed' | 'idle' | 'silent'
export type IdleStatus = 'quiet' | 'noticed' | 'asked' | 'replied' | 'resolved' | 'slept' | 'superseded' | 'unsent'

export type Owed =
  | { type: 'goal'; goal_id: string; title: string; goal_status: string; since: string | null }
  | { type: 'assigned_goal'; goal_id: string; title: string; goal_status: string; since: string | null }
  | { type: 'message'; message_id: string; conversation_id: string; from: string; from_name: string; since: string | null }

export interface IdleMind {
  id: string
  name: string
  swarm_id: string | null
  mind_status: string
  personal: boolean
  idle_calls_24h: number
  idle_spend_24h: number
  last_input_at: string | null
  noticed: boolean
  kind: IdleKind | null
  owed: Owed[]
  question_id: string | null
  question: string | null
  question_at: string | null
  question_by: string | null
  reply: string | null
  reply_at: string | null
  status: IdleStatus
  actions: { remind: boolean; sleep: boolean }
  /** Platform r2.4: the host says this viewer may Remind / Sleep this mind; absent is false */
  may_remind: boolean
  may_sleep: boolean
  /** Platform r2.4: this is the viewer's own personal mind */
  is_mine: boolean
}

export interface IdleRecord {
  question_id: string | null
  kind: IdleKind | null
  owed: Owed[]
  observed_at: string | null
  last_noticed_at: string | null
  last_input_at: string | null
  idle_calls_24h: number
  idle_spend_24h: number
  question: string | null
  question_at: string | null
  question_by: string | null
  reply: string | null
  reply_at: string | null
  status: IdleStatus
  closed_at: string | null
}

export interface IdleWindow {
  notice_after_s: number
  ask_quiet_s: number
  counts_over_s: number
}

export interface IdleOverview {
  minds: IdleMind[]
  generated_at: string | null
  window: IdleWindow
  /** r1.4: when this browser read it (ms), to order its flags against a fresher GET /api/agents/{id} */
  read_at: number
}

export interface IdleDetail extends IdleMind {
  history: IdleRecord[]
}

/** The host's defaults, used only when a read leaves a window value out. */
export const DEFAULT_WINDOW: IdleWindow = { notice_after_s: 3600, ask_quiet_s: 21600, counts_over_s: 86400 }
export const HISTORY_MAX = 20
/** Two Reminds within this long are one question on the host; the button stays off for as long. */
export const REMIND_ONCE_MS = 60_000

const STATUSES: readonly IdleStatus[] = ['quiet', 'noticed', 'asked', 'replied', 'resolved', 'slept', 'superseded', 'unsent']
const KINDS: readonly IdleKind[] = ['owed', 'idle', 'silent']
const ID = /^[A-Za-z0-9_.:~-]{1,160}$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null)
const when = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const status = (v: unknown): IdleStatus => (STATUSES.includes(v as IdleStatus) ? (v as IdleStatus) : 'quiet')
const kind = (v: unknown): IdleKind | null => (KINDS.includes(v as IdleKind) ? (v as IdleKind) : null)

export function readOwed(v: unknown): Owed | null {
  if (!isObj(v)) return null
  if (v.type === 'goal' || v.type === 'assigned_goal') {
    const g = id(v.goal_id)
    return g ? { type: v.type, goal_id: g, title: str(v.title) ?? '', goal_status: str(v.goal_status) ?? '', since: when(v.since) } : null
  }
  if (v.type === 'message') {
    const m = id(v.message_id)
    return m ? { type: 'message', message_id: m, conversation_id: str(v.conversation_id) ?? '', from: str(v.from) ?? '', from_name: str(v.from_name) ?? '', since: when(v.since) } : null
  }
  return null
}

const owedList = (v: unknown): Owed[] => (Array.isArray(v) ? v.map(readOwed).filter((x): x is Owed => !!x).slice(0, 20) : [])

export function readIdleMind(v: unknown): IdleMind | null {
  if (!isObj(v)) return null
  const mid = id(v.id) ?? id(v.agent_id)
  if (!mid) return null
  const acts = isObj(v.actions) ? v.actions : {}
  return {
    id: mid,
    name: str(v.name) ?? mid,
    swarm_id: id(v.swarm_id),
    mind_status: str(v.mind_status) ?? '',
    personal: v.personal === true,
    idle_calls_24h: count(v.idle_calls_24h),
    idle_spend_24h: count(v.idle_spend_24h),
    last_input_at: when(v.last_input_at),
    noticed: v.noticed === true,
    kind: kind(v.kind),
    owed: owedList(v.owed),
    question_id: id(v.question_id),
    question: str(v.question),
    question_at: when(v.question_at),
    question_by: str(v.question_by),
    reply: str(v.reply),
    reply_at: when(v.reply_at),
    status: status(v.status),
    actions: { remind: acts.remind === true, sleep: acts.sleep === true },
    may_remind: v.may_remind === true,
    may_sleep: v.may_sleep === true,
    is_mine: v.is_mine === true,
  }
}

export function readIdleRecord(v: unknown): IdleRecord | null {
  if (!isObj(v)) return null
  return {
    question_id: id(v.question_id),
    kind: kind(v.kind),
    owed: owedList(v.owed),
    observed_at: when(v.observed_at),
    last_noticed_at: when(v.last_noticed_at),
    last_input_at: when(v.last_input_at),
    idle_calls_24h: count(v.idle_calls_24h),
    idle_spend_24h: count(v.idle_spend_24h),
    question: str(v.question),
    question_at: when(v.question_at),
    question_by: str(v.question_by),
    reply: str(v.reply),
    reply_at: when(v.reply_at),
    status: status(v.status),
    closed_at: when(v.closed_at),
  }
}

const positive = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)

/** The list, in the host's order (worst first); a malformed entry is left out. */
export function readIdleOverview(v: unknown, now: number = Date.now()): IdleOverview {
  const o = isObj(v) ? v : {}
  const w = isObj(o.window) ? o.window : {}
  return {
    minds: Array.isArray(o.minds) ? o.minds.map(readIdleMind).filter((x): x is IdleMind => !!x) : [],
    generated_at: when(o.generated_at),
    window: { notice_after_s: positive(w.notice_after_s, DEFAULT_WINDOW.notice_after_s), ask_quiet_s: positive(w.ask_quiet_s, DEFAULT_WINDOW.ask_quiet_s), counts_over_s: positive(w.counts_over_s, DEFAULT_WINDOW.counts_over_s) },
    read_at: now,
  }
}

export function readIdleDetail(v: unknown): IdleDetail | null {
  const m = readIdleMind(v)
  if (!m) return null
  const h = isObj(v) && Array.isArray(v.history) ? v.history : []
  return { ...m, history: h.map(readIdleRecord).filter((x): x is IdleRecord => !!x).slice(0, HISTORY_MAX) }
}

// ---------------------------------------------------------------- plain words

/** A span of seconds in plain words: "1 hour", "6 hours", "30 minutes", "24 hours". */
export function span(s: number): string {
  if (s >= 3600 && s % 3600 === 0) return s === 3600 ? '1 hour' : `${s / 3600} hours`
  const m = Math.max(1, Math.round(s / 60))
  return m === 1 ? '1 minute' : `${m} minutes`
}

/** The window, as a person reads it. */
export function windowSentence(w: IdleWindow): string {
  return `Health notices after ${span(w.notice_after_s)} with no input; asks at most every ${span(w.ask_quiet_s)}.`
}

export const STATUS_LABEL: Record<IdleStatus, string> = {
  quiet: 'Quiet',
  noticed: 'Noticed',
  asked: 'Asked',
  // the mind spoke after the question: its next message, whatever it says. Never "agreed" or "done".
  replied: 'Answered',
  resolved: 'Had input since',
  slept: 'Went to sleep',
  superseded: 'Asked again',
  unsent: 'Not delivered',
}

/** What Health noticed, in plain words. */
export function noticedSentence(m: Pick<IdleMind, 'noticed' | 'kind' | 'owed' | 'idle_calls_24h' | 'idle_spend_24h'>, money: (n: number) => string): string {
  if (!m.noticed || !m.kind) return 'Nothing noticed.'
  if (m.kind === 'silent') return 'Awake with no input and no output.'
  if (m.kind === 'idle') return `Making model calls with no input: ${m.idle_calls_24h} call${m.idle_calls_24h === 1 ? '' : 's'}, ${money(m.idle_spend_24h)}.`
  const first = m.owed[0]
  const more = m.owed.length > 1 ? ` (${m.owed.length - 1} more owed)` : ''
  if (!first) return `Owes work${more}.`
  if (first.type === 'goal') return `Holds the task “${first.title || first.goal_id}” with no progress${more}.`
  if (first.type === 'assigned_goal') return `The task “${first.title || first.goal_id}” is assigned to it and still open${more}.`
  return `${first.from_name || 'Someone'} wrote to it and has no reply yet${more}.`
}

/** Who asked: Health's own pass, you, or another person (by principal). */
export function askedBy(by: string | null, me: string | null | undefined): string {
  if (!by || by === 'hive:health') return 'Health'
  if (me && by === me) return 'you'
  return 'a person'
}

/**
 * Whether the mind replied, worded neutrally: `replied` means only that the mind spoke after the question (its next
 * message there, whatever it says), never that it agreed or did what was asked.
 */
export function replyWords(m: Pick<IdleMind, 'status' | 'reply' | 'reply_at' | 'question'>): { label: string; text: string | null } {
  if (!m.question) return { label: 'Not asked', text: null }
  if (m.reply || m.status === 'replied') return { label: 'Answered', text: m.reply }
  if (m.status === 'asked') return { label: 'No answer yet', text: null }
  return { label: 'No answer', text: null }
}

/** The total line over what the list shows. */
export function totalLine(minds: Pick<IdleMind, 'idle_spend_24h'>[], money: (n: number) => string): string {
  const spenders = minds.filter((m) => m.idle_spend_24h > 0)
  const total = spenders.reduce((t, m) => t + m.idle_spend_24h, 0)
  return `Idle spend in the last 24 h: ${money(total)} across ${spenders.length} mind${spenders.length === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------- who may act

export interface Viewer {
  /** the signed-in principal ("user:u_ab12", "user:operator"), for "you asked" */
  principal: string | null
  admin: boolean
  /** this list was read with ?include=personal (admin audit: read-only for other people's personal minds) */
  auditing: boolean
}

/** The host's permission flags (Platform r2.4), on an idle row or an agent from /api/agents. */
export interface HostFlags {
  may_remind?: boolean
  may_sleep?: boolean
  is_mine?: boolean
}

/**
 * Whether the host lets this viewer do it. Only the host's flag counts, for every mind, personal or not; a missing or
 * non-true flag is no (fail closed). The UI never works out ownership itself.
 */
export function hostAllows(m: HostFlags | null | undefined, what: 'remind' | 'sleep'): boolean {
  if (!m) return false
  return (what === 'remind' ? m.may_remind : m.may_sleep) === true
}

/** Health's Remind button: the same rule over an idle row (r1.4: withheld unless the mind is awake). */
export const showRemind = (m: HostFlags & { mind_status: string }) => canRemindNow({ ...m, status: m.mind_status })
/**
 * The ONE awake rule for Remind and Sleep, everywhere (Health, the Ask, its run, Still): exactly `awake`, as the host's
 * Remind 409 rule (starting, asleep, stopped, created and error are not awake).
 */
export const isAwakeForAction = (status: string | null | undefined): boolean => status === 'awake'

/**
 * Remind now: the host's may_remind AND the mind is awake by the one rule. The host makes may_remind false for a mind
 * that is not awake, but a flag kept across a flagless event can be older than the status (r1.4): the status wins.
 */
export const canRemindNow = (a: (HostFlags & { status?: string | null }) | null | undefined): boolean => hostAllows(a, 'remind') && isAwakeForAction(a?.status)
/** Why Remind is not sent now, in plain words. */
export function remindRefusalNow(name: string, a: (HostFlags & { status?: string | null; personal?: boolean }) | null | undefined): string {
  if (!hostAllows(a, 'remind')) return notAllowedWords(name, 'remind', a ? { personal: a.personal, is_mine: a.is_mine } : null)
  return `${name} is not awake${a?.status ? ` (${a.status})` : ''}, so Health did not ask. Health only asks awake minds and never wakes one.`
}
/**
 * Sleep now: the host's may_sleep (permission only, Platform r2.4: it stays true for a mind already asleep, where Sleep
 * is a no-op) AND the mind is awake by the one rule.
 */
export const canSleepNow = (a: (HostFlags & { status?: string | null }) | null | undefined): boolean => hostAllows(a, 'sleep') && isAwakeForAction(a?.status)

/** Health's Sleep button: the same rule over an idle row (its lifecycle status is `mind_status`). */
export const showSleep = (m: HostFlags & { mind_status: string }) => canSleepNow({ ...m, status: m.mind_status })

/** Why Sleep is not sent now, in plain words: the host said no, or the mind is not awake. */
export function sleepRefusal(name: string, a: (HostFlags & { status?: string | null; personal?: boolean }) | null | undefined): string {
  if (!hostAllows(a, 'sleep')) return notAllowedWords(name, 'sleep', a ? { personal: a.personal, is_mine: a.is_mine } : null)
  if (a?.status === 'asleep') return `${name} is already asleep.`
  return `${name} is not awake${a?.status ? ` (${a.status})` : ''}, so there is nothing to put to sleep now.`
}

/**
 * An agent.updated event carries no per-viewer flags (the host publishes the raw view): keep the ones the last read
 * gave until a fresh GET /api/agents/{id} replaces them. A flag the event does carry wins.
 */
export function keepHostFlags<T extends HostFlags>(prev: HostFlags | null | undefined, next: T): T {
  if (!prev) return next
  const out = { ...next }
  for (const k of ['may_remind', 'may_sleep', 'is_mine'] as const) if (typeof out[k] !== 'boolean' && typeof prev[k] === 'boolean') out[k] = prev[k]
  return out
}
/** Whether an agent view carries the host's flags at all (an event does not; a GET does). */
export const hasHostFlags = (a: HostFlags | null | undefined): boolean => !!a && typeof a.may_remind === 'boolean' && typeof a.may_sleep === 'boolean'

/** Why there is no Remind or Sleep for this mind, in plain words (the host said no). */
export function notAllowedWords(name: string, what: 'remind' | 'sleep', m: { personal?: boolean; is_mine?: boolean } | null | undefined): string {
  const doing = what === 'remind' ? `remind ${name}` : `put ${name} to sleep`
  if (m?.personal && m.is_mine !== true) return `${name} is someone else’s personal mind; only they can ${what === 'remind' ? 'remind it' : 'put it to sleep'}.`
  return `The hive does not let you ${doing}. Only its owner or an admin can.`
}

/** A mind's reply as shown: at most REPLY_MAX characters, the rest in its conversation. */
export const REPLY_MAX = 200
export function clipReply(text: string | null): { text: string | null; clipped: boolean } {
  if (text === null) return { text: null, clipped: false }
  const chars = [...text]
  if (chars.length <= REPLY_MAX) return { text, clipped: false }
  return { text: `${chars.slice(0, REPLY_MAX - 1).join('').trimEnd()}…`, clipped: true }
}

/** A Remind the hive refused, in plain words; null when the error is not one of the shapes' refusals. */
export function remindRefusal(e: unknown, name: string): string | null {
  const status = isObj(e) && typeof e.status === 'number' ? e.status : 0
  const code = isObj(e) && typeof e.code === 'string' ? e.code : ''
  if (status === 409 || code === 'not_awake') return `${name} is not awake, so Health did not ask. Health only asks awake minds and never wakes one.`
  if (status === 403 || code === 'personal_mind') return `${name} is a person’s personal mind. Only that person can remind it.`
  if (status === 404 || code === 'not_found') return `${name} is not one you can remind here.`
  return null
}

export const REMIND_LOST = 'Not confirmed: the hive’s answer was lost. Look at the mind before trying again.'

/** The question as the mind received it, without the `[HEALTH-QUESTION hq_…] ` tag. */
export const questionText = (q: string) => q.replace(/^\[HEALTH-QUESTION [^\]]*\]\s*/, '')

/**
 * Remind's minute, kept in the store by mind id (so a remount, a reload of the list or the Ask all see it): ms until a
 * Remind for this mind works again (0: now). The host counts two Reminds within 60 s as one question.
 */
export function remindWait(at: number | undefined, now: number): number {
  if (at === undefined) return 0
  return Math.max(0, REMIND_ONCE_MS - (now - at))
}

/** The host's flags as the Ask's world carries them (lib/intent Named); absent or not-true is false. */
type AskAgent = (HostFlags & { status?: string | null }) | null | undefined
type AskBits = { mayRemind: boolean; maySleep: boolean; isMine: boolean; awakeNow: boolean; personal: boolean }
/**
 * `inPersonalSwarm`: the mind sits in a person's personal-mind swarm (the swarm view's own marker); with is_mine that
 * is how the Ask knows a mind is personal, for the "someone else's personal mind" words. Wording only.
 */
export const namedFlags = (a: AskAgent, inPersonalSwarm = false): AskBits => ({
  mayRemind: a?.may_remind === true,
  maySleep: a?.may_sleep === true,
  isMine: a?.is_mine === true,
  awakeNow: isAwakeForAction(a?.status),
  personal: a?.is_mine === true || inPersonalSwarm,
})
/** The same bits packed into a world signature (five characters, '1' or '0'), and read back. */
export const askFlags = (a: AskAgent, inPersonalSwarm = false): string => {
  const f = namedFlags(a, inPersonalSwarm)
  return [f.mayRemind, f.maySleep, f.isMine, f.awakeNow, f.personal].map((b) => (b ? 1 : 0)).join('')
}
export const readAskFlags = (s: string | undefined): AskBits => ({
  mayRemind: s?.[0] === '1',
  maySleep: s?.[1] === '1',
  isMine: s?.[2] === '1',
  awakeNow: s?.[3] === '1',
  personal: s?.[4] === '1',
})

/** The Remind button for this mind, from the store's remindedAt: on, or off ("Reminded") until its minute is up. */
export function remindButton(at: number | undefined, now: number): { on: boolean; label: 'Remind' | 'Reminded'; wait: number } {
  const wait = remindWait(at, now)
  return { on: wait === 0, label: wait === 0 ? 'Remind' : 'Reminded', wait }
}
