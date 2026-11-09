/**
 * What First Light reads and writes on the host (live 81c8b9d, hive/API.md "First Light" and "Own hive, round H1").
 * Every answer is read strictly from unknown: what is not well formed is left out (never guessed into a claim).
 *
 * Routes used by R2 (all act only on the signed-in person):
 *  - GET / PATCH /api/me/onboarding        progress, versioned (409 stale_onboarding carries `current`)
 *  - GET /api/me/setup                     the setup list; its monthly_limit item says whether a limit is `enforced`
 *  - GET /api/hive/own                     whose hive, and how this person is in it (owner, guest, legacy, public)
 *  - GET /api/me                           the person's name
 *  - GET /api/me/mind                      their personal mind
 *  - GET /api/me/key-limits                their own keys
 *  - PUT /api/me/key-limits/self           their own monthly limit on all their keys (`key_id: "*"`)
 *  - POST /api/me/limit-requests           a guest asks the host for more (the host decides)
 *  - GET / POST /api/me/personal-mind/hello  the hello: GET never wakes; POST is the person's Wake press
 *
 * Added by R3 (existing routes only; nothing new on the host):
 *  - GET /api/programs, GET /api/programs/{id}/install   beat 5: the person apps installed for this person (P14)
 *  - GET /api/agents/{id}                  beat 6: their own mind's current persona (to start from)
 *  - POST /api/me/mind {name}              beat 6: their own mind's name
 *  - PATCH /api/agents/{id} {persona}      beat 6: how it should be (owner only, the ordinary mind update)
 *  - PUT /api/me/ask {}                    beat 6: their Ask prefs as they stand (marks "Set up your Ask" on setup)
 */
import { stopped } from '../../lib/boundOperation'
import type { Beat } from './script'

export type RolePath = 'admin' | 'coder' | 'researcher' | 'explorer'
export type ProgressStatus = 'not_started' | 'in_progress' | 'finished' | 'skipped'

export interface Progress {
  status: ProgressStatus
  current_beat: Beat | null
  beats_done: Beat[]
  beats_skipped: Beat[]
  role_path: RolePath | null
  monthly_spend_usd: number | null
  key_choice: 'own-key' | 'hive-keys' | null
  version: number
}
export type ProgressWrite = Partial<Pick<Progress, 'status' | 'current_beat' | 'beats_done' | 'beats_skipped' | 'role_path' | 'monthly_spend_usd' | 'key_choice'>>

/** Who enforces a monthly limit, exactly as the host says (null: nothing does). */
export type EnforcedBy = 'own' | 'invite' | 'rule' | 'member-default' | 'grant' | null

/** The setup list's monthly_limit item: the limit in force, read live. */
export interface MonthlyLimit {
  done: boolean
  /** a month limit really caps this person's spend at call time (only then is a limit named as enforced) */
  enforced: boolean
  enforced_by: EnforcedBy
  limit_usd: number | null
  spent_usd: number | null
  chosen_usd: number | null
  /** a guest's host */
  host_name: string | null
  pending_request: { id: string; amount_usd: number; created_at: string | null } | null
}

export interface Setup {
  own_keys: number
  guest: boolean
  limit: MonthlyLimit | null
  mind_awake: boolean
  complete: boolean
}

export type Access = 'owner' | 'legacy' | 'guest' | 'public' | null
export interface HiveOwn {
  owner_name: string | null
  you_are_owner: boolean
  your_access: Access
  visibility: 'private' | 'public' | null
  pays: 'own-key' | 'hive-key' | null
}

export interface MindRef {
  id: string
  name: string
  status: string
}

export interface Hello {
  mind: MindRef
  state: 'waiting' | 'greeted'
  /** the mind's own first message, or null while it has not answered */
  greeting: { id: string; text: string; created_at: string | null } | null
  created: boolean
  retryable: boolean
  requested_at: string | null
}

/** R3 beat 5: an app installed for this person, which opens in their own space (P14). */
export interface AppRef {
  id: string
  name: string
  tagline: string | null
}
/** R3 beat 6: what the person says their Ask should be. `how` null: leave it as it is. */
export interface AskShape {
  name: string
  how: string | null
}
export interface MindProfile { id: string; name: string; persona: string; model: string | null }
/** One bound hive write (lib/boundOperation `op.write`): sent only while the same person is signed in, its answer taken
 * only if they still are. A chain of writes passes each one through it, so nothing goes out under another person. */
export type BoundWrite = <T>(send: () => Promise<T>) => Promise<T>

export const ASK_NAME_MAX = 40
export const ASK_HOW_MAX = 400
export const DEFAULT_ASK_PURPOSE = 'Help me and my family improve our lives.'

export interface LimitRequest {
  id: string
  amount_usd: number
  status: 'pending' | 'approved' | 'adjusted' | 'declined'
}

/** A refusal from the host (or none reached): its code, and its own message as a fallback. */
export class FlRefusal extends Error {
  readonly status: number
  readonly code: string
  /** 409 stale_onboarding: the record as it stands now */
  readonly current?: unknown
  readonly details: Record<string, unknown>
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    if ('current' in details) this.current = details.current
  }
}

/** Everything First Light asks of a hive. The live one calls the routes; the demo one is invented and deterministic. */
export interface FlHost {
  readonly kind: 'live' | 'demo'
  /** Optional local reconciliation identity; not Host authority or an RPC. */
  retainedMutationScope?(): { host: string; principal: string } | null
  progress(): Promise<Progress>
  writeProgress(patch: ProgressWrite, version: number): Promise<Progress>
  setup(): Promise<Setup>
  own(): Promise<HiveOwn>
  personName(): Promise<string | null>
  mind(): Promise<MindRef | null>
  /** how many minds this person sees on the hive besides their own (null: not known) */
  otherMinds(mindId: string | null): number | null
  setOwnLimit(monthUsd: number): Promise<void>
  askForMore(amountUsd: number): Promise<LimitRequest>
  helloGet(): Promise<Hello | null>
  helloWake(): Promise<Hello>
  /** R3: the apps ready for this person (installed for them, person placement, with an interface) */
  apps(): Promise<AppRef[]>
  /** R3: their own mind's current persona ('' when none) */
  askHow(mindId: string): Promise<string>
  /** U1 context, whole and for the exact personal mind. Optional on older adapters. */
  profile?(mindId: string): Promise<MindProfile>
  /** R3: save the name (and how, unless null) on their own mind, each write through `write`; answers the mind as it now
   * stands. A changed sign-in stops the chain at the next write (OperationStopped), and nothing after it is sent. */
  saveAsk(mindId: string, shape: AskShape, write: BoundWrite): Promise<MindRef>
  /** The owner's tap on "Think with your … plan": set their own mind's model to a connected subscription model, through
   * `write`. Optional: a host without it never offers the plan. Answers the model as the host now holds it. */
  useModel?(mindId: string, model: string, write: BoundWrite): Promise<string>
}

// ---------------------------------------------------------------- strict readers

const BEAT_IDS: readonly Beat[] = ['arrive', 'look', 'models', 'tools', 'apps', 'ask', 'tour', 'hello']
const ROLES: readonly RolePath[] = ['admin', 'coder', 'researcher', 'explorer']
const STATUSES: readonly ProgressStatus[] = ['not_started', 'in_progress', 'finished', 'skipped']
const ID = /^[A-Za-z0-9_.:~-]{1,160}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() && v.length <= max && !/\p{Cc}/u.test(v) ? v : null)
const beats = (v: unknown): Beat[] => (Array.isArray(v) ? BEAT_IDS.filter((b) => v.includes(b)) : [])
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : null)

export const BLANK_PROGRESS: Progress = { status: 'not_started', current_beat: null, beats_done: [], beats_skipped: [], role_path: null, monthly_spend_usd: null, key_choice: null, version: 0 }

export function readProgress(v: unknown): Progress | null {
  if (!isObj(v) || num(v.version) === null) return null
  return {
    status: oneOf(v.status, STATUSES) ?? 'not_started',
    current_beat: oneOf(v.current_beat, BEAT_IDS),
    beats_done: beats(v.beats_done),
    beats_skipped: beats(v.beats_skipped),
    role_path: oneOf(v.role_path, ROLES),
    monthly_spend_usd: num(v.monthly_spend_usd),
    key_choice: oneOf(v.key_choice, ['own-key', 'hive-keys'] as const),
    version: Math.max(0, Math.floor(num(v.version) ?? 0)),
  }
}

const ENFORCERS = ['own', 'invite', 'rule', 'member-default', 'grant'] as const
export function readMonthlyLimit(item: unknown): MonthlyLimit | null {
  if (!isObj(item) || item.id !== 'monthly_limit') return null
  const d = isObj(item.detail) ? item.detail : {}
  const p = isObj(d.pending_request) ? d.pending_request : null
  const limit = num(d.limit_usd) ?? num(d.allowance_usd)
  // `enforced` is the host's word: anything but a literal true is not enforced, and a limit is never named without an
  // amount or without what enforces it (`enforced_by`, one of the known enforcers)
  const by = oneOf(d.enforced_by, ENFORCERS)
  const enforced = item.enforced === true && limit !== null && by !== null
  return {
    done: item.done === true,
    enforced,
    enforced_by: enforced ? by : null,
    limit_usd: limit,
    spent_usd: num(d.spent_usd),
    chosen_usd: num(d.chosen_usd),
    host_name: str(d.host_name, 120),
    pending_request: p && str(p.id, 80) && num(p.amount_usd) !== null ? { id: p.id as string, amount_usd: p.amount_usd as number, created_at: str(p.created_at, 40) } : null,
  }
}

export function readSetup(v: unknown): Setup | null {
  if (!isObj(v) || !Array.isArray(v.items)) return null
  const items: unknown[] = v.items
  const item = (id: string) => items.find((i) => isObj(i) && i.id === id) as Record<string, unknown> | undefined
  const key = item('provider_key')
  const kd = key && isObj(key.detail) ? key.detail : {}
  return {
    own_keys: Math.max(0, Math.floor(num(kd.own_keys) ?? 0)),
    guest: kd.guest === true,
    limit: readMonthlyLimit(item('monthly_limit')),
    mind_awake: item('mind_awake')?.done === true,
    complete: v.complete === true,
  }
}

export function readOwn(v: unknown): HiveOwn | null {
  if (!isObj(v)) return null
  return {
    owner_name: str(v.owner_name, 120),
    you_are_owner: v.you_are_owner === true,
    your_access: oneOf(v.your_access, ['owner', 'legacy', 'guest', 'public'] as const),
    visibility: oneOf(v.visibility, ['private', 'public'] as const),
    pays: oneOf(v.pays, ['own-key', 'hive-key'] as const),
  }
}

export function readMindRef(v: unknown): MindRef | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || !str(v.name, 120)) return null
  return { id: v.id, name: v.name as string, status: typeof v.status === 'string' ? v.status.slice(0, 20) : 'asleep' }
}

/** The hello, as the host gave it. A greeting is kept only when the host says the mind greeted and gave its words. */
export function readHello(v: unknown): Hello | null {
  if (!isObj(v)) return null
  const mind = readMindRef(v.mind)
  if (!mind) return null
  const g = isObj(v.greeting) ? v.greeting : null
  const text = g && typeof g.text === 'string' && g.text.trim() ? g.text.slice(0, 4000) : null
  const greeted = v.state === 'greeted' && !!text
  return {
    mind,
    state: greeted ? 'greeted' : 'waiting',
    greeting: greeted && g ? { id: typeof g.id === 'string' ? g.id.slice(0, 80) : '', text: text!, created_at: str(g.created_at, 40) } : null,
    created: v.created === true,
    retryable: v.retryable === true,
    requested_at: str(v.requested_at, 40),
  }
}

export function readLimitRequest(v: unknown): LimitRequest | null {
  if (!isObj(v) || !str(v.id, 80) || num(v.amount_usd) === null) return null
  return { id: v.id as string, amount_usd: v.amount_usd as number, status: oneOf(v.status, ['pending', 'approved', 'adjusted', 'declined'] as const) ?? 'pending' }
}

/** One app from GET /api/programs, kept only when it is a usable person app (enabled, person placement, own interface). */
export function readPersonApp(v: unknown): AppRef | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || !str(v.name, 120)) return null
  if (v.enabled !== true || v.placement !== 'person' || v.ui !== true || v.error) return null
  const app = isObj(v.app) ? v.app : {}
  return { id: v.id, name: v.name as string, tagline: str(app.tagline, 140) }
}
/** The person's words, as plain text: control characters out, spaces folded, cut to `max` (null when nothing is left). */
export function cleanWords(v: string, max: number): string | null {
  const t = v.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return t ? t : null
}
/**
 * Whether beat 6 may offer the persona for editing: only one that fits the field whole, on one line, so what the person
 * sees is exactly what is there (stand-in R3.2 P1). Anything longer or multi-line is changed on the mind's own page.
 */
export const personaEditable = (current: string | null): boolean => current !== null && current.length <= ASK_HOW_MAX && !/[\r\n]/.test(current)

/**
 * The visible proposal is offered only after a known-empty read. Unknown is never treated as empty.
 */
export const askPurposeValue = (current: string | null): string => current === '' ? DEFAULT_ASK_PURPOSE : current ?? ''

/** Explicit Save adopts the visible default for a known-empty persona. An edit (including clear) takes precedence.
 * Existing words are changed only by the dirty flag, never by comparing with a shortened display. */
export const askToSave = (name: string, edited: string | null, current: string | null): AskShape => ({
  name,
  how: !personaEditable(current) ? null : edited !== null ? edited : current === '' ? DEFAULT_ASK_PURPOSE : null,
})

/**
 * The app the person will talk in: the first ready app, in the order the host lists them. Hive code names no app; no
 * manifest field marks a "talk here" app yet (`app.home` is the item an app opens on, not this).
 */
export const startApp = (apps: readonly AppRef[] | null): AppRef | null => apps?.[0] ?? null

/** The person's first name, from their account name (the first word). */
export const firstName = (name: string | null | undefined): string | null => (name ? (name.trim().split(/\s+/)[0] ?? null) : null)

// ---------------------------------------------------------------- the live host

/** The client methods First Light needs (all optional: a hive without them refuses with not_on_this_hive). */
export interface FlClient {
  retainedMutationScope?(): { host: string; principal: string } | null
  onboarding?(): Promise<unknown>
  patchOnboarding?(body: Record<string, unknown>): Promise<unknown>
  mySetup?(): Promise<unknown>
  hiveOwn?(): Promise<unknown>
  me?(): Promise<{ person?: { name?: string } | null }>
  myMind?(): Promise<unknown>
  setOwnKeyLimit?(body: Record<string, unknown>): Promise<unknown>
  askForLimit?(body: Record<string, unknown>): Promise<unknown>
  personalMindHello?(wake: boolean): Promise<unknown>
  programs?(): Promise<unknown>
  programInstall?(program: string): Promise<unknown>
  getAgent?(id: string): Promise<unknown>
  renameMyMind?(name: string): Promise<unknown>
  patchAgent?(id: string, body: { persona?: string; model?: string }): Promise<unknown>
  setAskSettings?(body: Record<string, never>): Promise<unknown>
}

const missing = () => new FlRefusal(404, 'not_on_this_hive', 'This hive does not offer that yet.')
const malformed = () => new FlRefusal(0, 'unreadable', 'The hive answered in a shape this page does not understand.')

/** An ordinary client error as a refusal; typed session stops rethrow unchanged. Keeps code/status/envelope details. */
export function asRefusal(e: unknown): FlRefusal {
  // Keep the client's typed identity change (and OperationStopped) intact through call() and every later catch.
  if (stopped(e)) throw e
  if (e instanceof FlRefusal) return e
  const x = e as { status?: unknown; code?: unknown; message?: unknown; envelope?: unknown } | null
  const status = typeof x?.status === 'number' ? x.status : 0
  const code = typeof x?.code === 'string' && x.code ? x.code : status === 0 ? 'network' : 'error'
  const message = typeof x?.message === 'string' ? x.message : ''
  return new FlRefusal(status, code, message, isObj(x?.envelope) ? x.envelope : {})
}

async function call<T>(fn: (() => Promise<unknown>) | undefined, read: (v: unknown) => T | null): Promise<T> {
  if (!fn) throw missing()
  let v: unknown
  try {
    v = await fn()
  } catch (e) {
    throw asRefusal(e)
  }
  const out = read(v)
  if (out === null) throw malformed()
  return out
}

export function liveHost(c: FlClient, otherMinds: (mindId: string | null) => number | null): FlHost {
  return {
    kind: 'live',
    retainedMutationScope: () => c.retainedMutationScope?.() ?? null,
    progress: () => call(c.onboarding && (() => c.onboarding!()), readProgress),
    writeProgress: (patch, version) => call(c.patchOnboarding && (() => c.patchOnboarding!({ ...patch, version })), readProgress),
    setup: () => call(c.mySetup && (() => c.mySetup!()), readSetup),
    own: () => call(c.hiveOwn && (() => c.hiveOwn!()), readOwn),
    personName: () => call(c.me && (() => c.me!()), (v) => (isObj(v) ? { name: isObj(v.person) ? str(v.person.name, 120) : null } : null)).then((r) => r.name),
    mind: () => call(c.myMind && (() => c.myMind!()), (v) => (isObj(v) ? { m: readMindRef(v.mind) } : null)).then((r) => r.m),
    otherMinds,
    setOwnLimit: (month) => call(c.setOwnKeyLimit && (() => c.setOwnKeyLimit!({ key_id: '*', month_usd: month })), (v) => (isObj(v) ? true : null)).then(() => undefined),
    askForMore: (amount) => call(c.askForLimit && (() => c.askForLimit!({ amount_usd: amount })), readLimitRequest),
    helloGet: () => call(c.personalMindHello && (() => c.personalMindHello!(false)), (v) => (isObj(v) ? { h: readHello(v.hello) } : null)).then((r) => r.h),
    helloWake: () => call(c.personalMindHello && (() => c.personalMindHello!(true)), readHello),
    async apps() {
      const list = await call(c.programs && (() => c.programs!()), (v) => (Array.isArray(v) ? v.map(readPersonApp).filter((a): a is AppRef => !!a) : null))
      // installed for this person: the host's own answer per app (an app it will not answer for is left out)
      const checked = await Promise.all(list.slice(0, 12).map(async (a) => {
        const st = await call(c.programInstall && (() => c.programInstall!(a.id)), (v) => (isObj(v) ? v : null)).catch(() => null)
        return st && st.installed === true && st.placement === 'person' ? a : null
      }))
      // in the host's own order (it lists programs by name)
      return checked.filter((a): a is AppRef => !!a)
    },
    // read whole (never cut): First Light only edits a persona it can hold whole (personaEditable), and never writes a read
    askHow: (mindId) => call(c.getAgent && (() => c.getAgent!(mindId)), (v) => (isObj(v) && v.id === mindId && typeof v.persona === 'string' ? { p: v.persona } : null)).then((r) => r.p),
    profile: (mindId) => call(c.getAgent && (() => c.getAgent!(mindId)), (v) => (isObj(v) && v.id === mindId && !!str(v.name, 120) && typeof v.persona === 'string' ? { id: mindId, name: v.name as string, persona: v.persona, model: str(v.model, 300) } : null)),
    async saveAsk(mindId, shape, write) {
      // stand-in R3.1 P1: every write in the chain is bound on its own, so a sign-in change between them sends nothing more
      const named = await write(() => call(c.renameMyMind && (() => c.renameMyMind!(shape.name)), (v) => (isObj(v) ? readMindRef(v.mind) : null)))
      if (named.id !== mindId) throw new FlRefusal(409, 'mind_changed', 'Your mind changed in another window. Here it is as it stands now.')
      if (shape.how !== null) await write(() => call(c.patchAgent && (() => c.patchAgent!(mindId, { persona: shape.how! })), (v) => (isObj(v) ? true : null)))
      // the Ask prefs as they stand (who answers, what a conversation may spend): unchanged, now recorded as set up.
      // Its own refusal is not the person's problem; a stop (another person signed in) still ends the chain.
      await write(() => call(c.setAskSettings && (() => c.setAskSettings!({})), (v) => (isObj(v) ? true : null))).catch((e: unknown) => {
        if (stopped(e)) throw e
      })
      return named
    },
    async useModel(mindId, model, write) {
      return write(() => call(c.patchAgent && (() => c.patchAgent!(mindId, { model })), (v) => (isObj(v) && typeof v.model === 'string' && v.model === model ? v.model : null)))
    },
  }
}
