import type { Asset, SwarmArtifact } from '../api/moneyWork'
import { CLASSIC_CHROME, type ExperienceChrome } from '../experiences/chrome'
import { GRAMMARS, type Grammar } from '../forms/contract'
import { cleanInsets, cleanReserved, type Insets, type Reserved } from './frameFit'
import { creationReference, type CreationReference } from './router'

/**
 * App frame bridge, candidate additions (Studio slice 1; PROGRAMS.md §9). Two host capabilities for an app's own
 * interface, both data only:
 *
 * - `context`: the experience the person is in, its window chrome tokens, the app's identity in the current look,
 *   reduced motion and which host capabilities exist. Sent after `app-ready`, on `{type:'context?'}`, and on change.
 * - `pick`: the frame asks; the HOST shows its own picker of what this person may read for this app in this swarm;
 *   the person chooses; the frame receives exactly one authorised reference (or a cancellation). The frame never
 *   lists, searches or names anything itself, and a reference grants nothing beyond what the host's existing routes
 *   already authorise for this app's later requests.
 *
 * Every function here is pure and validated, so the shapes are tested without a browser.
 */

export const APP_CONTEXT_SCHEMA = 'omegahive.app-context/0.1'
/** Largest bridge-extension message accepted from a frame (serialised). */
export const MAX_BRIDGE_MESSAGE = 2048
export type PickAccept = 'artifact' | 'asset'
const ACCEPTS: PickAccept[] = ['artifact', 'asset']
const ID = /^[\w.:-]{1,80}$/
const KIND = /^[a-z][\w.+-]{0,47}(\/([a-z0-9][\w.+-]{0,47}|\*))?$/i

// ---- context ----------------------------------------------------------------------------------------------------

export type ChromeTokens = ExperienceChrome
export interface AppIdentityTokens {
  accent: string
  accent_2: string
  surface: string
  ink: string
  type: 'editorial' | 'technical' | 'humanist' | 'mono'
  motif: 'none' | 'constellation' | 'strata' | 'lattice' | 'grain' | 'rings' | 'ruled' | 'blueprint'
}
export interface AppCapabilities {
  picker: boolean
  /** Studio slice 2: the frame may save private drafts (a signed-in person, on a hive with the draft routes). */
  draftSave: boolean
  /** Frame ops (§9c): declared reads of this app (the host has the read route and the app declares at least one read). */
  read: boolean
  /** Frame ops (§9c): the host opens an https link on the person's own click, after showing where it goes. */
  openUrl: boolean
  /** Frame ops (§9c): the host shows a PDF or plain text in its own viewer. */
  showFile: boolean
  /** Frame ops (§9c): an act may carry one file from the person (a signed-in person only). */
  actFile: boolean
  /** Frame ops (§9c): the frame may ask to fill the stage below the host's minimal chrome. */
  fullBleed: boolean
  ask: boolean
  presence: boolean
  handoff: boolean
}
export interface AppContext {
  schema: typeof APP_CONTEXT_SCHEMA
  experience: string
  grammar: Grammar
  chrome: ChromeTokens
  appIdentity: AppIdentityTokens | null
  reducedMotion: boolean
  capabilities: AppCapabilities
  /** Studio slice 2: who is using the app, as data only (no id, name or email); null when the host does not say. */
  person: AppPerson | null
  /** Fit (§9c): how far the device's safe areas reach into the frame's box, CSS px (0 when the host keeps it clear). */
  insets: Insets
  /** Fit (§9c): the frame's bottom-left rectangle under the host's Ω (plus margin), CSS px (0 when it does not meet). */
  reserved: Reserved
}
export interface AppPerson {
  kind: 'person' | 'operator'
  localOperator: boolean
}

/** The person fields from /api/auth/me (`person_kind`, `local_operator`), or null when the host does not report them. */
export function appPerson(me: { person_kind?: unknown; local_operator?: unknown } | null | undefined): AppPerson | null {
  if (!me || (me.person_kind !== 'person' && me.person_kind !== 'operator')) return null
  return { kind: me.person_kind, localOperator: me.local_operator === true }
}

/**
 * A chrome value is a CSS colour, length, font stack or shadow written by host code. Before it crosses into a frame
 * it must still look like one: short, and nothing that could load or run anything (no url(), escapes, at-rules,
 * blocks, markup or schemes). Anything else is replaced by the classic value, never passed through.
 */
export function safeToken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 160 && !/url\(|image-set|expression|javascript:|data:|[\\<>{};@]|\/\*/i.test(v)
}

const CHROME_KEYS = Object.keys(CLASSIC_CHROME) as (keyof ExperienceChrome)[]
const MATERIALS: ExperienceChrome['material'][] = ['glass', 'paper', 'terminal', 'none']
const TYPES: AppIdentityTokens['type'][] = ['editorial', 'technical', 'humanist', 'mono']
const MOTIFS: AppIdentityTokens['motif'][] = ['none', 'constellation', 'strata', 'lattice', 'grain', 'rings', 'ruled', 'blueprint']
const HEX = /^#[0-9a-fA-F]{6}$/

/** The chrome as plain data: exactly the ExperienceChrome keys, each a safe string or a valid enum. */
export function chromeTokens(c: ExperienceChrome | null | undefined): ChromeTokens {
  const src = (c ?? CLASSIC_CHROME) as unknown as Record<string, unknown>
  const out = {} as Record<string, string>
  for (const k of CHROME_KEYS) {
    const v = src[k]
    if (k === 'material') out[k] = MATERIALS.includes(v as never) ? (v as string) : CLASSIC_CHROME.material
    else if (k === 'scheme') out[k] = v === 'light' || v === 'dark' ? v : CLASSIC_CHROME.scheme
    else out[k] = safeToken(v) ? v : CLASSIC_CHROME[k]
  }
  return out as unknown as ChromeTokens
}

/** The app's identity as data, or null unless every field is a #rrggbb colour or a known enum. */
export function identityTokens(t: Partial<Record<keyof AppIdentityTokens, unknown>> | null | undefined): AppIdentityTokens | null {
  if (!t) return null
  const { accent, accent_2, surface, ink, type, motif } = t
  if (![accent, accent_2, surface, ink].every((x) => typeof x === 'string' && HEX.test(x))) return null
  if (!TYPES.includes(type as never) || !MOTIFS.includes(motif as never)) return null
  return { accent, accent_2, surface, ink, type, motif } as AppIdentityTokens
}

/** The whole `context` payload. Data only: strings, booleans and enums; no functions, URLs or host objects. */
export function appContext(input: {
  experience: string | null | undefined
  chrome: ExperienceChrome | null | undefined
  identity: Partial<Record<keyof AppIdentityTokens, unknown>> | null | undefined
  reducedMotion: boolean
  picker: boolean
  /** The client has the draft routes (the person must also be a signed-in person: `person.kind === 'person'`). */
  drafts?: boolean
  person?: AppPerson | null
  /** The client has the read route AND the app declares at least one read. */
  reads?: boolean
  /** The host renders the frame-ops prompt, viewer and layout (true in this host). */
  frameOps?: boolean
  /** P1: true only while this visible frame holds current consent and a fresh host lease. */
  ask?: boolean
  /** Fit (§9c), measured by the host in the frame's own box. */
  insets?: Partial<Insets> | null
  reserved?: { bottomLeft?: { width?: unknown; height?: unknown } | null } | null
}): AppContext {
  const experience = typeof input.experience === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(input.experience) ? input.experience : 'classic'
  const grammar: Grammar = (GRAMMARS as string[]).includes(experience) ? (experience as Grammar) : 'classic'
  const person = appPerson(input.person ? { person_kind: input.person.kind, local_operator: input.person.localOperator } : null)
  return {
    schema: APP_CONTEXT_SCHEMA,
    experience,
    grammar,
    chrome: chromeTokens(input.chrome),
    appIdentity: identityTokens(input.identity),
    reducedMotion: input.reducedMotion === true,
    capabilities: {
      picker: input.picker === true,
      draftSave: input.drafts === true && person?.kind === 'person',
      read: input.reads === true,
      openUrl: input.frameOps === true,
      showFile: input.frameOps === true,
      actFile: input.frameOps === true && person?.kind === 'person',
      fullBleed: input.frameOps === true,
      ask: input.ask === true && person?.kind === 'person',
      presence: input.ask === true && person?.kind === 'person',
      handoff: input.ask === true && person?.kind === 'person',
    },
    person,
    insets: cleanInsets(input.insets),
    reserved: cleanReserved(input.reserved),
  }
}

// ---- frame → host messages --------------------------------------------------------------------------------------

export type BridgeRequest = { type: 'context?' } | { type: 'pick'; id: string; accept: PickAccept[]; kinds: string[] | null }
/** null: not a bridge-extension message (the caller ignores it or handles it elsewhere). */
export type BridgeParse = { ok: true; msg: BridgeRequest } | { ok: false; id: string | null; reason: string } | null

const size = (data: unknown) => {
  try {
    return JSON.stringify(data)?.length ?? Infinity
  } catch {
    return Infinity
  }
}
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))

/** Validate a `context?` or `pick` message from a frame (already checked to be the frame, on its channel). */
export function parseBridgeMessage(data: unknown): BridgeParse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.type !== 'context?' && m.type !== 'pick') return null
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null
  if (size(data) > MAX_BRIDGE_MESSAGE) return { ok: false, id, reason: 'too-large' }
  if (m.type === 'context?') return onlyKeys(m, ['type', 'channel']) ? { ok: true, msg: { type: 'context?' } } : { ok: false, id: null, reason: 'invalid' }
  if (!id || !onlyKeys(m, ['type', 'channel', 'id', 'accept', 'kinds'])) return { ok: false, id, reason: 'invalid' }
  const accept = m.accept
  if (!Array.isArray(accept) || !accept.length || accept.length > ACCEPTS.length || !accept.every((a) => ACCEPTS.includes(a)) || new Set(accept).size !== accept.length)
    return { ok: false, id, reason: 'invalid' }
  let kinds: string[] | null = null
  if (m.kinds !== undefined) {
    if (!Array.isArray(m.kinds) || !m.kinds.length || m.kinds.length > 16 || !m.kinds.every((k) => typeof k === 'string' && KIND.test(k))) return { ok: false, id, reason: 'invalid' }
    kinds = [...new Set(m.kinds as string[])]
  }
  return { ok: true, msg: { type: 'pick', id, accept: accept as PickAccept[], kinds } }
}

/** A sliding-window limit per key: true when the call is allowed (and counted). */
export function rateLimit(max: number, windowMs: number, now: () => number = () => performance.now()) {
  const seen = new Map<string, number[]>()
  return (key: string): boolean => {
    const t = now()
    const recent = (seen.get(key) ?? []).filter((x) => t - x < windowMs)
    const ok = recent.length < max
    if (ok) recent.push(t)
    seen.set(key, recent)
    return ok
  }
}
/** The bridge's own limits: a frame may ask for context 10 times and open the picker 5 times in 10 seconds. */
export const BRIDGE_LIMITS: Record<BridgeRequest['type'], [number, number]> = { 'context?': [10, 10_000], pick: [5, 10_000] }

// ---- picker candidates and replies ------------------------------------------------------------------------------

export interface AssetReference {
  handle: string
  name: string
  mime: string
  size: number
}
export type PickCandidate =
  | { key: string; source: 'artifact'; title: string; kind: string; at: string; reference: CreationReference }
  | { key: string; source: 'asset'; title: string; kind: string; at: string; reference: AssetReference }

/** A kind filter entry matches an artifact kind exactly, or an asset's mime type exactly or as `type/*`. */
export function kindMatches(kinds: string[] | null, kind: string, mime = false): boolean {
  if (!kinds) return true
  return kinds.some((k) => k === kind || (mime && k.endsWith('/*') && kind.startsWith(k.slice(0, -1))))
}

/** Artifacts the host listed for this swarm, each re-validated as an exact reference. */
export function artifactCandidates(rows: SwarmArtifact[], kinds: string[] | null): PickCandidate[] {
  const out: PickCandidate[] = []
  for (const r of rows) {
    const reference = creationReference({ artifact_id: r.artifact_id, revision: r.revision, digest: r.digest })
    if (!reference || typeof r.kind !== 'string' || !kindMatches(kinds, r.kind)) continue
    out.push({ key: `artifact:${reference.artifact_id}`, source: 'artifact', title: String(r.title ?? '').slice(0, 200) || reference.artifact_id, kind: r.kind, at: String(r.revised_at ?? ''), reference })
  }
  return out
}

/** Files of THIS swarm (the same rule an app's read uses: the swarm is one of the file's owners). */
export function assetCandidates(rows: Asset[], swarmId: string, kinds: string[] | null): PickCandidate[] {
  const out: PickCandidate[] = []
  for (const a of rows) {
    if (!/^[a-f0-9]{64}$/.test(a.sha256) || !Array.isArray(a.owners) || !a.owners.includes(swarmId)) continue
    if (typeof a.mime !== 'string' || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || !kindMatches(kinds, a.mime, true)) continue
    const name = String(a.name ?? '').slice(0, 200)
    out.push({ key: `asset:${a.sha256}`, source: 'asset', title: name || a.sha256.slice(0, 12), kind: a.mime, at: String(a.created_at ?? ''), reference: { handle: a.sha256, name, mime: a.mime, size: a.bytes } })
  }
  return out
}

export type PickedReply =
  | { type: 'picked'; id: string; source: CreationReference }
  | { type: 'picked'; id: string; asset: AssetReference }
  | { type: 'picked'; id: string; cancelled: true; reason?: 'busy' | 'unavailable' | 'rate-limited' | 'invalid' | 'too-large' }

/** What the frame receives for the person's choice: one exact reference, re-validated, nothing else. */
export function pickedReply(id: string, c: PickCandidate): PickedReply {
  if (c.source === 'artifact') {
    const r = creationReference(c.reference)
    if (!r) throw new Error('Not an exact reference')
    return { type: 'picked', id, source: r }
  }
  const { handle, name, mime, size: bytes } = c.reference
  if (!/^[a-f0-9]{64}$/.test(handle)) throw new Error('Not an asset handle')
  return { type: 'picked', id, asset: { handle, name, mime, size: bytes } }
}

/** A cancellation. No reason: the person cancelled; otherwise why the host did not open the picker. */
export function cancelledReply(id: string, reason?: 'busy' | 'unavailable' | 'rate-limited' | 'invalid' | 'too-large'): PickedReply {
  return reason ? { type: 'picked', id, cancelled: true, reason } : { type: 'picked', id, cancelled: true }
}
