/**
 * Shapes for the money, work and apps surfaces (classic audit rows 20, 23, 24, 25, 36), read from hive/core:
 * cost_reservations.py (outstanding, overruns, resolve), assets.py (view, store_info), collab.py (swarm services),
 * services.py (view), program_attachments.py (view, offer), program_actions.py (activity).
 */
import type { CreationReference } from '../lib/router'

// ---- cost reservations (GET /api/budgets/reservations, /overruns; POST /reservations/{id}/resolve) ----

/** A held worst-case cost for a model call (cost_reservations.outstanding). */
export interface CostReservation {
  id: string
  /** unknown: the call's outcome is not known and a person must settle it; dispatched/reserved: still in flight. */
  state: 'unknown' | 'dispatched' | 'reserved'
  held_usd: number
  /** Every budget the hold counts against, e.g. agent:a_x:total, swarm:s_y:month, hive:hard-total. */
  scopes: string[]
  /** Only these host fields are ever shown (SHOWN_METADATA): never the call's content. */
  metadata: { agent?: string; model?: string; payer?: string; key?: string; kind?: string; payload_hash?: string }
  /** Provider identifiers the host saw, if any (no authority or reconciliation claim). */
  observation: { response_id?: string; resolved_model?: string; usage_origin?: string } | null
  /**
   * Candidate (Platform, closing audit row 20): absent on live 0aa6330, whose rows carry only the fields above.
   * When the call went out (epoch seconds; null while only reserved).
   */
  dispatched_at?: number | null
  /** Candidate: when its outcome became unknown (epoch seconds). */
  unknown_at?: number | null
  /** Candidate: whether a person may resolve it now (the hive's own test: unknown, or in flight for too long). */
  resolvable?: boolean
  /** Candidate: when the hive settles it at its held worst case if nobody does (epoch seconds; null unless unknown). */
  auto_settles_at?: number | null
}

/** An actual cost above what was held (cost_overruns); amounts in micro-dollars, `at` in epoch seconds. */
export interface CostOverrun {
  reservation: string
  agent: string | null
  maximum: number
  actual: number
  source: 'settle' | 'resolve' | 'late-after-release' | string
  at: number
}

export type ResolveBody = { action: 'settle'; actual_usd: number; reason: string } | { action: 'release'; reason: string }

/** The reservation after a person resolved it (cost_reservations row). */
export interface ResolvedReservation {
  id: string
  state: 'settled' | 'released' | string
  maximum: number
  actual: number | null
}

// ---- artifacts, exhibits and findings (composed: there is no single hive-level list route) ----

export type ArtifactKind = 'flow' | 'review' | 'exhibit' | 'app-result'

/** One thing a mind or an app produced, as the hive-level list shows it. */
export interface HiveArtifact {
  /** Unique row key (kind + source id). */
  key: string
  kind: ArtifactKind
  title: string
  swarm_id: string | null
  mind_id: string | null
  /** The app that produced it, when an app did. */
  app: string | null
  /** Where a revision was sent for review. */
  to_swarm?: string
  at: string
  /** The exact revision, when the source names one (opens in Design). */
  ref?: CreationReference
  /** The underlying artifact id, when known. */
  artifact_id?: string
  revision?: number
  state?: string
  detail?: string
}

export interface ArtifactList {
  items: HiveArtifact[]
  /** Sources that could not be read this time (shown, never hidden). */
  missing: string[]
}

/** Candidate (Studio picker): one artifact of a swarm at its latest revision, as an exact reference. Metadata only
 *  (GET /api/swarms/{id}/artifacts); never a body or an author. */
export interface SwarmArtifact {
  artifact_id: string
  kind: string
  title: string
  revision: number
  digest: string
  created_at: string
  revised_at: string
}

// ---- assets and stores (R12: /api/assets*, /api/asset-stores) ----

export interface AssetStore {
  name: string
  kind: 'local' | 's3' | string
}

export interface AssetHistoryEntry {
  at: string
  by: string
  event: 'stored' | 'copied' | 'moved' | 'owner_added' | 'local_only' | string
  store?: string
  to?: string
  removed?: string[]
  owner_swarm?: string
}

export interface Asset {
  sha256: string
  mime: string
  bytes: number
  name: string
  owner_swarm: string | null
  owners: string[]
  created_by: string
  created_at: string
  local_only: boolean
  placements: string[]
  history: AssetHistoryEntry[]
  /** Stores a this-machine-only file still has to be removed from (assets.py view); cleanup retries those. */
  pending_removal?: string[]
}

export interface UploadAssetOptions {
  swarm_id?: string
  name?: string
  local_only?: boolean
  store?: string
}

// ---- services between swarms (collab.py) and registered services (services.py) ----

export interface SwarmServices {
  swarm_id: string
  /** Offered to every swarm that can see this one. */
  kinds: string[]
  /** Offered only through an active connection that allows the kind. */
  connection_only_kinds: string[]
}

export interface RegisteredService {
  id: string
  name: string
  version: string
  address: string
  contract: string
  surfaces: string[]
  capabilities: string[]
  enabled: boolean
  registered_at: string
  last_seen_at: string | null
}

// ---- app activations, attachments, offers and activity (program_attachments.py, program_actions.py) ----

export interface AppActivation {
  program: string
  swarm_id: string
  active: boolean
}

export interface AppAttachment {
  id: string
  program: string
  swarm_id: string
  mind_id: string
  actor: string | null
  actions: string[]
  channels: string[] | null
  policy: Record<string, 'allow' | 'ask'>
  expires_at: string | null
  binding?: { kind: string; id: string; version: string; artifact_id: string; revision: number; digest: string }
  status: 'binding' | 'active' | 'unbind_pending' | 'revoked' | string
  granted_by: string
  revoked_by: string | null
}

/** What an app offers one mind (its offer hook); a person reviews a subset before attaching. */
export interface AppOffer {
  actions_offered: string[]
  channels_offered: string[]
  [extra: string]: unknown
}

export interface AttachBody {
  mind_id: string
  actions: string[]
  channels?: string[] | null
  policy: Record<string, 'allow' | 'ask'>
  expires_at?: string | null
  idempotency_key: string
}

export interface AppActivityRow {
  id: string
  program: string
  swarm_id: string
  principal: string
  action: string
  items: string[]
  status: string | null
  approval_id: string | null
  created_at: string
  finished_at: string | null
}
