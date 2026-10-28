/**
 * Wire shapes for host routes that had no screen (UI_BACKEND_PARITY_AUDIT_20261007, Surface missing-UI batch 1).
 * Every shape is the release host's own (omegahive-private, hive/core at the audited head); file:line is given where
 * a field's meaning is not obvious. Nothing here is a model or provider identifier.
 */

import type { AskEvent, AskVia, RefusalReason } from './ask'

// ---- Ask: my kept turns and the admin audit (hive/core/ask.py view/list/audit/audit_turn) -------------------------

/** One Ask turn as the hive keeps it (ask.py view). A turn from a deleted thread keeps its row with `text: ""`. */
export interface AskTurnRecord {
  operation_id: string
  turn_id: string
  state: 'accepted' | 'thinking' | 'done' | 'refused'
  reason: RefusalReason | string | null
  thread: { id: string; mind: { id: string; name: string }; budget_usd: number; spent_usd: number; addressed?: { id: string; name: string } | null } | null
  text: string
  via: AskVia | string
  context: Record<string, unknown>
  addressed: { id: string; name: string } | null
  answer_message_id: string | null
  created_at: string
  closed_at: string | null
  turn_spent_usd: number | null
}

/** GET /api/ask/audit rows (admins): every person's turns, newest first; page with `before` = the last created_at. */
export interface AskAuditRow extends AskTurnRecord {
  principal: string
  mind_id: string | null
  swarm_id: string | null
}

/** GET /api/ask/audit/{turn}: the turn and its frames after `after` (≤ 100 a page; `more` while there are more). */
export interface AskAuditTurn extends AskAuditRow {
  events: (AskEvent & { principal?: string })[]
  next_after: number
  more: boolean
}

/** The most turns GET /api/ask returns (ask.py list clamps limit to 1..200; there is no cursor). */
export const ASK_HISTORY_MAX = 200

// ---- Goals: every result attempt (goals.py attempts) -------------------------------------------------------------

export interface GoalAttempt {
  id: string
  goal_id: string
  agent_id: string
  at: string
  ok: boolean
  errors: string[]
  /** the verbatim submitted result (JSON with sorted keys when it was not text), truncated by the hive */
  raw: string
  digest: string
}

// ---- Apps: pause or restore an app's host-managed access (programs.py revoke_grants/restore_grants) -------------

export interface ProgramGrantsRevoked { program: string; grants_revoked: true }
export interface ProgramGrantsRestored { program: string; grants_revoked: false; takes_effect: string }

// ---- Updates: ask for one (updates.py request) --------------------------------------------------------------------

export interface UpdateRequestBody {
  /** "platform" or "program:<app id>" of an app this hive has */
  target: string
  /** ≤ 2000 characters */
  note: string
  /** ≤ 20, each ≤ 300 characters */
  receipts?: string[]
}
export interface UpdateRequestRecord {
  id: string
  target: string
  note: string
  receipts: string[]
  requested_by: string
  created_at: string
  status: 'pending' | 'applied' | string
  closed_at: string | null
  closed_by: string | null
}
export const UPDATE_NOTE_MAX = 2000
export const UPDATE_RECEIPTS_MAX = 20
export const UPDATE_RECEIPT_LEN = 300

// ---- Outside agents: the invitation list (mcp.py view) -----------------------------------------------------------

export interface HarnessInviteRow {
  id: string
  harness: 'claude-code' | 'codex' | 'hermes' | 'mcp'
  harness_label: string
  name: string
  swarm_id: string
  role_id: string | null
  created_by: string
  created_at: string
  /** epoch seconds */
  expires_at: number
  redeemed_at: string | null
  agent_id: string | null
  revoked_at: string | null
  status: 'waiting' | 'connected' | 'expired' | 'revoked'
}

// ---- Capability catalogue (collab.py capability_catalogue) ------------------------------------------------------

export interface CatalogueOffer {
  id: string
  provider: { kind: 'swarm' | 'agent' | 'program'; id: string }
  capability: { name: string; source: 'service' | 'role.media' | 'role.mandate' | 'program.action' | string }
  scope: { visibility: string; connection_only: boolean; swarm_id?: string }
  tier: 'advertised' | string
  evidence: { kind: string; ref: string; digest: string; at: string | null }[]
  unknowns: string[]
}
export interface CapabilityCatalogue {
  requester_swarm: string
  offers: CatalogueOffer[]
  sources: Record<string, string | null>
  truncated: boolean
  unknowns: string[]
  catalogue_digest: string
  generated_at: string
}

// ---- Code: give a person a grant on a goal (services.py grant) -------------------------------------------------

export interface AddGoalGrantBody {
  /** user:<person id> */
  principal: string
  scope: 'edit' | 'read'
  /** 5..1440 (the hive clamps) */
  ttl_minutes: number
  workspace_id?: string
}

// ---- Flows: what is adopted, and taking an adoption back (flows.py list/read/revoke) ----------------------------

export interface FlowListRow { artifact_id: string; title: string; revision: number }
/** flow_adoptions row (flows.py:22): digest is the stored "sha256:…" form. */
export interface FlowAdoption { artifact_id: string; revision: number; digest: string; adopted_by: string; adopted_at: string }
export interface FlowRevisionRead {
  artifact_id: string
  swarm_id: string
  revision: number
  digest: string
  host_digest: string
  /** the adoption row, or null when this exact revision is not adopted */
  adoption: FlowAdoption | null
  [k: string]: unknown
}

// ---- Explore groups (explore.py save_group / delete_group) -------------------------------------------------------

export interface ExploreGroupDeleted { id: string; deleted: true }

// ---- Live events the UI did not read before (events.py frames; visibility.py rules) ---------------------------

export type AppGrantsEventType = 'app.grants_revoked' | 'app.grants_restored' | 'app.grants_restore_applied' | 'app.grants_renewed' | 'app.grants_refused'
export const APP_GRANTS_EVENTS: readonly AppGrantsEventType[] = ['app.grants_revoked', 'app.grants_restored', 'app.grants_restore_applied', 'app.grants_renewed', 'app.grants_refused']
