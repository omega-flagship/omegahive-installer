import { MAX_BRIDGE_MESSAGE } from './appBridge'

/** P12/P13 data only. Receiving or parsing a request proves no person gesture. */
export const APP_LINK_STATES = ['ready', 'declined', 'refused', 'needs_grown_up'] as const
export const APP_LINK_REASONS = ['not_available', 'not_ready', 'rate_limited', 'depth', 'not_related', 'busy'] as const
export type AppLinkState = typeof APP_LINK_STATES[number]
export type AppLinkReason = typeof APP_LINK_REASONS[number]
export type AppLinkResult = { state: 'ready' | 'declined' | 'needs_grown_up' } | { state: 'refused'; reason?: AppLinkReason }
export type AppLinkRequest =
  | { type: 'app-setup'; id: string; app: string }
  | { type: 'app-open'; id: string; app: string; intent?: string }
export type AppLinkParse = { ok: true; msg: AppLinkRequest } | { ok: false; type: AppLinkRequest['type']; id: string | null }

const ID = /^[\w.:-]{1,80}$/
const PROGRAM = /^[a-z0-9][a-z0-9-]{1,40}$/
const CHANNEL = /^[a-f0-9-]{36}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k))
const textLength = (value: string) => Array.from(value).length
const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/** Source/window/origin/channel binding belongs to AppFrame before this parser. */
export function parseAppLinkRequest(value: unknown): AppLinkParse | null {
  if (!object(value) || (value.type !== 'app-setup' && value.type !== 'app-open')) return null
  const type = value.type
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : null
  const bad = (): AppLinkParse => ({ ok: false, type, id })
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BRIDGE_MESSAGE) return bad()
  } catch { return bad() }
  if (!id || typeof value.app !== 'string' || !PROGRAM.test(value.app)) return bad()
  if (has(value, 'channel') && (typeof value.channel !== 'string' || !CHANNEL.test(value.channel))) return bad()
  if (!keys(value, type === 'app-setup' ? ['type', 'id', 'app', 'channel'] : ['type', 'id', 'app', 'channel', 'intent'])) return bad()
  // A claimed activation, principal, frame generation or first-session token is
  // an extra key and is rejected. None can arrive through this public contract.
  if (type === 'app-setup') return { ok: true, msg: { type, id, app: value.app } }
  if (value.intent !== undefined && (typeof value.intent !== 'string' || textLength(value.intent) > 200)) return bad()
  return { ok: true, msg: { type, id, app: value.app, ...(typeof value.intent === 'string' ? { intent: value.intent } : {}) } }
}

/** Closed projection of a host result; never spread server error/result objects. */
export function readAppLinkResult(value: unknown): AppLinkResult | null {
  if (!object(value) || !keys(value, ['state', 'reason']) || !APP_LINK_STATES.includes(value.state as AppLinkState)) return null
  if (value.state !== 'refused') return has(value, 'reason') ? null : { state: value.state as 'ready' | 'declined' | 'needs_grown_up' }
  if (has(value, 'reason') && !APP_LINK_REASONS.includes(value.reason as AppLinkReason)) return null
  return { state: 'refused', ...(typeof value.reason === 'string' ? { reason: value.reason as AppLinkReason } : {}) }
}

/** P12 only: a sliding 60-second window, not an added P13 quota. New document,
 * new limiter. The host must not create one per request or per target. */
export function setupRateLimit(clock: () => number = () => performance.now()): () => boolean {
  let calls: number[] = []
  let last = -Infinity
  return () => {
    const now = clock()
    // A clock reversal cannot refund this frame's prior calls.
    if (!Number.isFinite(now) || now < last) return false
    last = now
    calls = calls.filter(at => at > now - 60_000)
    if (calls.length >= 3) return false
    calls.push(now)
    return true
  }
}

/** View-only copy. It is deliberately not a params/focus/action constructor.
 * Integration must put it on the target's separate view input and must omit it
 * from both target template-rule evaluation and the act stream. */
export function untrustedViewIntent(intent: string | undefined): Readonly<{ untrusted_intent: string }> | null {
  if (intent === undefined) return null
  if (typeof intent !== 'string' || textLength(intent) > 200) throw new Error('Invalid app-open intent')
  return Object.freeze({ untrusted_intent: intent })
}

/** Data-only target bridge input, after its normal source/origin/channel check. */
export function readUntrustedViewInput(value: unknown): Readonly<{ untrusted_intent: string; authoritative: false }> | null {
  if (!object(value) || !keys(value, ['type', 'channel', 'input', 'authoritative']) || value.type !== 'app-view-input' || value.authoritative !== false || !object(value.input) || !keys(value.input, ['untrusted_intent']) || typeof value.input.untrusted_intent !== 'string' || textLength(value.input.untrusted_intent) > 200) return null
  return Object.freeze({ untrusted_intent: value.input.untrusted_intent, authoritative: false })
}

/** Parent-only API envelopes. Never include these in a frame result/context. */
export interface AppLinkEntry { id: string; app: string; swarm_id: string; name: string; back_name: string }
export interface AppLinkTemplate {
  program_id: string; program_name: string; template_id: string; template_digest: string
  key_id: string | null; month_usd: number | null; providers: string[]; spend_note: string
  consent_revision: { granted_at: string; withdrawn_at: string | null } | null
  authority_revision: string | null
  consent_current?: boolean
  minds: { slot: string; name: string; persona: string; model: string; budget_usd: number }[]
  rules: { skill: string; mode: 'deny' | 'ask' }[]
}
export interface AppLinkReview {
  id: string; kind: 'app-setup' | 'app-open'; caller_name: string; target_name: string; target: string
  release_digest: string; version: string; template: AppLinkTemplate | null; approved_revision: string | null
  price_guide: string[]; session_permission: 'may send to and show your Ask while open'; related_apps: string[]
}
export interface AppLinkAnswer { review?: AppLinkReview; result?: AppLinkResult; entry?: AppLinkEntry; notice?: string }
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
const digest = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const optionalText = (v: unknown, max: number) => v === null || text(v, max)
const money = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0
export function readAppLinkEntry(value: unknown): AppLinkEntry | null {
  return object(value) && keys(value, ['id', 'app', 'swarm_id', 'name', 'back_name']) && text(value.id, 80) && ID.test(value.id as string) && typeof value.app === 'string' && PROGRAM.test(value.app) && text(value.swarm_id, 80) && ID.test(value.swarm_id as string) && text(value.name, 120) && text(value.back_name, 120) ? value as unknown as AppLinkEntry : null
}
export function readAppLinkReview(value: unknown): AppLinkReview | null {
  if (!object(value) || !keys(value, ['id', 'kind', 'caller_name', 'target_name', 'target', 'release_digest', 'version', 'template', 'approved_revision', 'price_guide', 'session_permission', 'related_apps'])) return null
  if (!text(value.id, 80) || !ID.test(value.id as string) || !['app-setup', 'app-open'].includes(String(value.kind)) || !text(value.caller_name, 120) || !text(value.target_name, 120) || (typeof value.target !== 'string' || !PROGRAM.test(value.target)) || !digest(value.release_digest) || !text(value.version, 120) || !optionalText(value.approved_revision, 100)) return null
  if (!Array.isArray(value.price_guide) || value.price_guide.length > 8 || !value.price_guide.every(v => text(v, 300)) || value.session_permission !== 'may send to and show your Ask while open' || !Array.isArray(value.related_apps) || value.related_apps.length > 8 || !value.related_apps.every(v => typeof v === 'string' && PROGRAM.test(v))) return null
  if (value.template !== null) {
    const t = value.template
    if (!object(t) || !keys(t, ['program_id', 'program_name', 'template_id', 'template_digest', 'key_id', 'month_usd', 'providers', 'spend_note', 'consent_revision', 'authority_revision', 'consent_current', 'minds', 'rules']) || t.program_id !== value.target || !text(t.program_name, 120) || !text(t.template_id, 80) || (typeof t.template_digest !== 'string' || !/^[a-f0-9]{64}$/.test(t.template_digest)) || !optionalText(t.key_id, 160) || !money(t.month_usd) || !optionalText(t.authority_revision, 100) || !text(t.spend_note, 1000) || has(t, 'consent_current') && typeof t.consent_current !== 'boolean') return null
    if (!Array.isArray(t.providers) || t.providers.length > 8 || !t.providers.every(v => text(v, 120)) || !Array.isArray(t.minds) || t.minds.length < 1 || t.minds.length > 8 || !t.minds.every(m => object(m) && keys(m, ['slot', 'name', 'persona', 'model', 'budget_usd']) && text(m.slot, 262144) && text(m.name, 200) && typeof m.persona === 'string' && m.persona.length <= 8000 && text(m.model, 262144) && typeof m.budget_usd === 'number' && money(m.budget_usd))) return null
    if (!Array.isArray(t.rules) || t.rules.length > 64 || !t.rules.every(r => object(r) && keys(r, ['skill', 'mode']) && text(r.skill, 262144) && (r.mode === 'deny' || r.mode === 'ask'))) return null
    if (t.consent_revision !== null && (!object(t.consent_revision) || !keys(t.consent_revision, ['granted_at', 'withdrawn_at']) || !text(t.consent_revision.granted_at, 100) || !optionalText(t.consent_revision.withdrawn_at, 100))) return null
  } else return null
  return value as unknown as AppLinkReview
}
export function readAppLinkAnswer(value: unknown): AppLinkAnswer | null {
  if (!object(value) || !keys(value, ['review', 'result', 'entry', 'notice'])) return null
  const result = has(value, 'result') ? readAppLinkResult(value.result) : undefined
  const review = has(value, 'review') ? readAppLinkReview(value.review) : undefined
  const entry = has(value, 'entry') ? readAppLinkEntry(value.entry) : undefined
  if (result === null || review === null || entry === null || !!result === !!review || entry && result?.state !== 'ready' || has(value, 'notice') && !text(value.notice, 200)) return null
  return { ...(result ? { result } : {}), ...(review ? { review } : {}), ...(entry ? { entry } : {}), ...(typeof value.notice === 'string' ? { notice: value.notice } : {}) }
}

export const PRESENTATION_BYTES = 65_536
export interface AppPresentation { version: 1; state: unknown }
const AUTHORITY = /^(?:token|.*_token|key_id|api_key|credentials?|principal|actor|channel|generation(?:_id)?|consent(?:_id|_epoch)?|authority|lease|capabilities|swarm_id|untrusted_intent)$/i
/** Untrusted presentation only, kept by the same parent/identity and returned to
 * the same app. Reject authority-shaped fields; no evaluator/act sees this JSON. */
export function readAppPresentation(value: unknown): AppPresentation | null {
  if (!object(value) || !keys(value, ['version', 'state']) || value.version !== 1 || !has(value, 'state')) return null
  let nodes = 0
  const data = (v: unknown, depth = 0): boolean => {
    if (++nodes > 4096 || depth > 16) return false
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (Array.isArray(v)) return v.every(x => data(x, depth + 1))
    return object(v) && Object.entries(v).every(([k, x]) => !AUTHORITY.test(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && data(x, depth + 1))
  }
  try {
    const raw = JSON.stringify(value)
    return new TextEncoder().encode(raw).byteLength <= PRESENTATION_BYTES && data(value.state) ? JSON.parse(raw) as AppPresentation : null
  } catch { return null }
}

/** Optional app-side presentation ABI. Binding is the existing exact host
 * origin/channel. Restoring UI data never restores host authority. */
export function installAppLinkPresentation(input: {
  hostOrigin: string; channel: string; capture(): unknown; restore(state: unknown): void
}): () => void {
  const origin = new URL(input.hostOrigin)
  if (origin.origin !== input.hostOrigin || !['http:', 'https:'].includes(origin.protocol) || !CHANNEL.test(input.channel) || window.parent === window) throw new Error('Invalid presentation binding')
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== input.hostOrigin || !object(event.data) || event.data.channel !== input.channel) return
    const m = event.data
    if (m.type === 'presentation-snapshot' && keys(m, ['type', 'id', 'channel']) && text(m.id, 80) && ID.test(m.id as string)) {
      const snapshot = readAppPresentation({ version: 1, state: input.capture() })
      if (snapshot) window.parent.postMessage({ type: 'presentation-state', id: m.id, ...snapshot, channel: input.channel }, input.hostOrigin)
    } else if (m.type === 'presentation-restore' && keys(m, ['type', 'version', 'state', 'channel'])) {
      const snapshot = readAppPresentation({ version: m.version, state: m.state })
      if (snapshot) input.restore(snapshot.state)
    }
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
