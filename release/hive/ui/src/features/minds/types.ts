/**
 * Shapes of the minds-side routes (hive/core): memory shares (shares.py), the S4 tool inventory (inventory.py),
 * per-mind health (health.py), the health mind (R8) and portable minds (placement.py). Field names are the server's.
 */
import type { MindHealth } from '../../api/types'

export type ShareStatus = 'requested' | 'active' | 'denied' | 'revoked' | 'expired'

/** One row of GET /api/shares (Shares.view): a space share or one reader's copy of an exhibit. */
export interface Share {
  id: string
  kind: 'space' | 'exhibit'
  swarm_id: string
  owner_id: string
  owner_name: string
  grantee_id: string
  grantee_name: string | null
  space: string | null
  /** Only atoms containing this text are visible. */
  pattern: string | null
  exhibit_id: string | null
  exhibit?: { title: string; bytes: number; atoms: number }
  minutes: number
  /** The reader's reason for a request, or the owner's note on an offer. */
  reason: string
  status: ShareStatus
  /** 'grantee': the reader asked; 'owner': the owner offered or exhibited. */
  initiated_by: 'grantee' | 'owner'
  created_at: string
  decided_at: string | null
  /** When an open request lapses, or when access ends. */
  expires_at: string | null
  reads: number
  last_read_at: string | null
  /**
   * Candidate (Platform, closing audit row 37): who ended it, e.g. `user:u_…`, `user:operator`, `agent:<id>`; null
   * when it lapsed or was never revoked. Absent on live 0aa6330, which does not record it.
   */
  revoked_by?: string | null
}

/** One read of a share (GET /api/shares/{id}/reads), newest first. */
export interface ShareRead {
  id: number
  share_id: string
  reader_id: string
  q: string | null
  returned: number
  created_at: string
}

export type SkillStatus = 'callable' | 'imported' | 'configured' | 'unknown'
export type InventoryAvailability = 'boot-receipt' | 'receipt-stale' | 'no-boot-receipt'

export interface InventorySkill {
  id: string
  module: string | null
  signature: { parser: unknown; declared: unknown }
  help: string | null
  topic: unknown
  effects: unknown
  risk: unknown
  metadata: 'verified-source' | 'unverified'
  status: SkillStatus
  policy: { decision: 'allow' | 'ask' | 'deny'; reason: string | null; snapshot_at: string }
  route: { kind: string; note?: string }
}

/** GET /api/agents/{id}/inventory: what the mind's last boot receipt says it can call. */
export interface MindInventory {
  mind_id: string
  kind: string
  availability: InventoryAvailability
  stale_reason: string | null
  inventory_revision: string | null
  loaded_at: string | null
  process: { boot_id: string; pid?: number | null } | null
  modules: { id: string; version: string | null; source_digest: string | null; configured: boolean; loaded: boolean; source_verified: boolean }[]
  core: { source_digest: string; source_verified: boolean } | null
  skills: InventorySkill[]
  dynamic: { kind: string; id: string; registry_revision: string; swarm_id: string | null; status: string }[]
  dynamic_status: string
  provider: { model: string; resolved_model: string | null; payer_kind: string; budget_route: string[]; budget_route_note?: string; snapshot_at: string }
  snapshot_at: string
  vendor_pin?: unknown
}

type Count = { attempted: number; ran: number }
/** GET /api/agents/{id}/inventory/activity: how often it reasoned and wrote beliefs over its last cycles. */
export interface MindActivity {
  mind_id: string
  cycles_requested: number
  cycles_observed: number
  since: string | null
  until: string | null
  reasoning: Record<'nal' | 'pln' | 'nars' | 'metta', Count>
  belief_writes: Record<'mind' | 'commons', Count>
  belief_writes_ran: number
  reasoning_ran: number
  dormant: boolean
  basis: string
}

/** GET /api/agents/{id}/health has the same shape as one mind of the overview. */
export type MindHealthDetail = MindHealth

/** GET/PUT /api/health/mind. */
export interface HealthMindSetting {
  agent_id: string | null
}

/** GET /api/hive/identity: this hive, as other hives name it. */
export interface HiveIdentity {
  id: string
  name: string
  home: boolean
  owner: string | null
}

/** One row of GET /api/agents/{id}/moves. */
export interface MindMove {
  id: string
  agent_id: string
  direction: 'out' | 'in'
  other_hive: string | null
  other_name: string | null
  manifest_sha256: string | null
  status: 'exported' | 'settled' | 'arrived' | string
  detail: { bytes?: number; files?: number }
  created_at: string
}

/** POST /api/agents/{id}/export, as the browser receives it. */
export interface MindExport {
  blob: Blob
  filename: string
  manifest_sha256: string
  bytes: number
}

/** POST /api/agents/import. */
export interface MindImportResult {
  agent: import('../../api/types').Agent
  from: Partial<HiveIdentity>
  manifest_sha256: string
}
