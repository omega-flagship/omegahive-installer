// Purpose: the shapes of the money, work and apps routes: held calls and how each settles itself, estimates and their correction, overruns, artifacts, assets, services and app activity.
/**
 * Shapes for the money, work and apps surfaces (classic audit rows 20, 23, 24, 25, 36), read from hive/core:
 * cost_reservations.py (outstanding, overruns, estimated, correct, correct_all), assets.py (view, store_info), collab.py (swarm services),
 * services.py (view), program_attachments.py (view, offer), program_actions.py (activity).
 */
import type { CreationReference } from '../lib/router'

// ---- cost reservations (GET /api/budgets/reservations, /overruns): nobody settles a held call by hand ----

/** A held worst-case cost for a model call (cost_reservations.outstanding). */
export interface CostReservation {
  id: string
  /** unknown: the call's outcome is not known, and it settles by itself (`settles`); dispatched/reserved: still in flight. */
  state: 'unknown' | 'dispatched' | 'reserved'
  held_usd: number
  /** Every budget the hold counts against, e.g. agent:a_x:total, swarm:s_y:month, hive:hard-total. */
  scopes: string[]
  /** Only these host fields are ever shown (SHOWN_METADATA): never the call's content. */
  metadata: { agent?: string; model?: string; payer?: string; key?: string; kind?: string; payload_hash?: string }
  /** Provider identifiers the host saw, if any (no authority or reconciliation claim), and `cause`: why the call's cost
   *  is unknown, in the hive's own words (gateway.held_cause), e.g. "OpenAI refused the request (rate_limited, 429)." */
  observation: { response_id?: string; resolved_model?: string; usage_origin?: string; cause?: string } | null
  /** How the hive settles it by itself: from OpenRouter's record of the call ('record', the expiry its backstop), at its
   *  worst case at the expiry, a free model's at $0 ('estimate'), or when the call answers ('answer'). */
  settles: 'record' | 'estimate' | 'answer'
  /**
   * Candidate (Platform, closing audit row 20): absent on live 0aa6330, whose rows carry only the fields above.
   * When the call went out (epoch seconds; null while only reserved).
   */
  dispatched_at?: number | null
  /** Candidate: when its outcome became unknown (epoch seconds). */
  unknown_at?: number | null
  /** Candidate: when the expiry settles it as an estimate if nothing settles it first (epoch seconds; null unless unknown). */
  auto_settles_at?: number | null
}

/** An actual cost above what was held (cost_overruns); amounts in micro-dollars, `at` in epoch seconds. */
export interface CostOverrun {
  reservation: string
  agent: string | null
  maximum: number
  actual: number
  /** settle: the call's answer; provider-record: OpenRouter's record; correct: a person's correction; resolve: a person
   *  settled it by hand, before the hive settled held calls by itself. */
  source: 'settle' | 'provider-record' | 'correct' | 'late-after-release' | 'resolve' | string
  at: number
}

/** Correct all (POST /api/budgets/reservations/correct): every listed estimate kept as billed (settle) or corrected to
 *  nothing billed (release), with one reason. All or none: 409 not_correctable when one can no longer be corrected. */
export interface CorrectAllBody {
  action: 'settle' | 'release'
  ids: string[]
  reason: string
}

/** What Correct all did: how many estimates, their total, and each call after it. */
export interface CorrectedAll {
  action: 'settle' | 'release'
  count: number
  estimate_usd: number
  corrected: CorrectedReservation[]
}

// ---- estimates (GET /api/budgets/reservations/estimated; POST /reservations/{id}/correct) ----

/** A call the hive settled at its worst case an hour after its cost went unknown, which a person may still correct
 *  (cost_reservations.estimated). Times in epoch seconds. */
export interface EstimatedCall {
  id: string
  /** What was recorded: the call's worst case, an upper bound that's usually more than the provider billed. */
  estimate_usd: number
  settled_at: number
  /** Until when a person may correct it: 30 days after the hive settled it. */
  correctable_until: number
  metadata: CostReservation['metadata']
  observation: CostReservation['observation']
  scopes: string[]
}

/** A correction: the cost the provider billed ('settle'), or nothing billed ('release'), with a reason. */
export type CorrectBody = { action: 'settle'; actual_usd: number; reason: string } | { action: 'release'; reason: string }

/** The call after a correction, in micro-dollars: its hold, its estimate and its actual (the billed cost). */
export interface CorrectedReservation {
  id: string
  state: 'settled' | string
  maximum: number
  actual: number
  estimate: number
  action: 'settle' | 'release'
}

// ---- artifacts, exhibits and findings (composed: there is no single hive-level list route) ----

export type ArtifactKind = 'creation' | 'flow' | 'review' | 'exhibit' | 'app-result'

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
  /** A creation's own kind as its mind named it (plan, studio-source, view), when the row is a creation. */
  creation_kind?: string
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

/** Filters applied before the limit in GET /api/artifacts. */
export interface CreationListOptions {
  kind?: string
  saved?: boolean
  limit?: number
}

type StudioRecentBase = { id: string; title: string; at: string }
export type StudioRecentCreation =
  | (StudioRecentBase & { kind: 'design' | 'image'; swarm_id: string; revision: number; digest: string })
  | (StudioRecentBase & { kind: 'app'; swarm_id: string | null })

/** One saved revision of an artifact with its text (GET /api/artifacts/{id}/revisions/{n}), the Artifacts page's reader,
 *  for a person who is shown that artifact. */
export interface CreationText {
  artifact_id: string
  kind: string
  title: string
  swarm_id: string
  revision: number
  digest: string
  body: string
  created_at: string
}

/** One saved revision as an interactive view (GET /api/artifacts/{id}/view), for a person shown that artifact. `carrier`
 *  says what made it a view: `metta` (kind view, written in MeTTa: its text comes, and this browser composes it), `view`
 *  (kind view, HTML), `resource` (kind view, the MCP resource as JSON) or `document` (another kind whose text is an HTML
 *  document, viewed only when the person asks). An HTML view comes as its MCP UI resource with what the hive grants it,
 *  what it declared and the hive refused, and the short-lived address of its document, which the hive serves sandboxed
 *  with an opaque origin (hive/core/views.py). Nothing runs until the person asks (`grant.ran`, given by their own click
 *  through consentView): until then the text or the document is null, and an HTML view reaches the domains it declares
 *  only once they allow them for that revision (`grant.reach`; `asks` lists what waits). */
export type ArtifactView = MettaArtifactView | HtmlArtifactView
/** A person's consent to one revision of a view: they ran it, and (an HTML view) let it reach its declared domains. */
export interface ViewGrant {
  ran: boolean
  reach: boolean
}
interface ViewCommon {
  artifact_id: string
  kind: string
  title: string
  swarm_id: string
  mind_id: string | null
  revision: number
  digest: string
  created_at: string
  grant: ViewGrant
}
/** A view a mind wrote in MeTTa (hive/ui/src/features/views/lib_view.metta): its text, which this browser composes, once
 *  the person has run it (a run covers its later revisions, which arrive live; it reaches no domain). */
export interface MettaArtifactView extends ViewCommon {
  carrier: 'metta'
  source: string | null
}
/** An HTML view (MCP Apps): its resource and the short-lived address of its document. */
export interface HtmlArtifactView extends ViewCommon {
  carrier: 'view' | 'resource' | 'document'
  resource: {
    uri: string
    mimeType: string
    _meta: { ui: { csp: Partial<Record<'connectDomains' | 'resourceDomains' | 'frameDomains' | 'baseUriDomains', string[]>>; permissions: Record<string, object>; prefersBorder?: boolean } }
  }
  /** The iframe allow value for the permissions granted ('' for none). */
  allow: string
  /** Declared domains and permissions the hive refused, as declared. */
  refused: string[]
  /** The domains it declares that wait on the person allowing them for this revision (empty once allowed). */
  asks: Partial<Record<'connectDomains' | 'resourceDomains' | 'frameDomains' | 'baseUriDomains', string[]>>
  /** The document's absolute address (the client resolves the hive's path against its base), once the person ran it. */
  document: string | null
}

// ---- assets and stores (R12: /api/assets*, /api/asset-stores) ----

export interface AssetStore {
  name: string
  kind: 'local' | 's3' | string
  /** The most one file may hold in this store (assets.py limit_for): null = no cap (the local store by default). */
  max_bytes?: number | null
}

/** The size limit of the named store, or null for none (an older hive that does not say keeps the earlier 100 MB). Pure. */
export function storeLimit(stores: AssetStore[], name: string): number | null {
  const s = stores.find((x) => x.name === name)
  if (!s) return null
  if (s.max_bytes === undefined) return 100 * 1024 * 1024
  return s.max_bytes
}

// ---- linked local folders (folders.py: /api/folders*, local hives only) ----

export interface LinkedFolder {
  id: string
  label: string
  root: string
  owner_swarm: string
  writable: boolean
  /** Who may write while writing is on: admins (the default) or anyone who sees the owner swarm. Minds never write. */
  writers: FolderWriters
  created_by: string
  created_at: string
  /** Always this_machine_only: a linked folder is never copied anywhere. */
  scope: 'this_machine_only'
  available: boolean
  history: { at: string; by: string; event: 'linked' | 'write_on' | 'write_off' | string }[]
}

export type FolderWriters = 'admins' | 'swarm_members'

export interface LinkedFolderList {
  /** False on a hive that is not on this machine: nothing can be linked or shown. */
  local: boolean
  scope: 'this_machine_only'
  folders: LinkedFolder[]
}

export interface FolderItem {
  name: string
  path: string
  kind: 'file' | 'folder'
  bytes: number | null
  modified_at: number
  link: boolean
}

export interface FolderListing {
  folder: LinkedFolder
  path: string
  items: FolderItem[]
  /** Hidden files, keys, secrets and links pointing out, counted, never named. */
  hidden: number
  truncated: boolean
}

export interface FolderWriteReceipt {
  id: string
  folder_id: string
  path: string
  by: string
  sha256_before: string | null
  sha256_after: string
  bytes: number
  at: string
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
