import { ApiError } from './client'

/**
 * A person's private drafts for one app in one swarm (Studio slice 2; Platform's candidate routes on platform/next8):
 *
 *   PUT    /api/apps/{program_id}/drafts/{draft_key}   {swarm_id, expected_revision, body, source_ref?} → AppDraftSaved
 *   GET    /api/apps/{program_id}/drafts?swarm_id=     → {drafts: AppDraftSummary[]}
 *   GET    /api/apps/{program_id}/drafts/{key}?swarm_id= → AppDraft
 *   DELETE /api/apps/{program_id}/drafts/{key}?swarm_id=
 *
 * Scope is (signed-in person, program, swarm): the hive takes the person from the session, never from the body. The
 * app must be enabled and the swarm visible. 409 `draft_conflict` carries `current_revision` in the error object;
 * 413 `draft_too_large` above 256 KB. The last 20 revisions are kept; a draft idle for 30 days expires. A draft is
 * not a publication: saving one adopts and shares nothing.
 */
export interface AppDraftSourceRef {
  artifact_id: string
  revision: number
  digest: string
}
export interface AppDraftPut {
  swarm_id: string
  /** null: create; a draft already under this key is a conflict. A number: the revision this save replaces. */
  expected_revision: number | null
  body: Record<string, unknown>
  source_ref?: AppDraftSourceRef
}
export interface AppDraftSaved {
  draft_key: string
  revision: number
  saved_at: string
}
export type AppDraftSummary = AppDraftSaved
export interface AppDraft extends AppDraftSaved {
  body: Record<string, unknown>
  source_ref: AppDraftSourceRef | null
}

export const DRAFT_MAX_BYTES = 256 * 1024
export const DRAFT_KEEP_REVISIONS = 20
export const DRAFT_IDLE_DAYS = 30
/** A draft key: a lowercase slug of 1–80 characters. */
export const DRAFT_KEY = /^[a-z0-9][a-z0-9_-]{0,79}$/

/** A 409 draft_conflict error, with the revision the hive holds now (null: the draft no longer exists). */
export type DraftConflictError = ApiError & { current_revision: number | null }
export function draftConflict(message: string, current: number | null): DraftConflictError {
  return Object.assign(new ApiError(409, 'draft_conflict', message), { current_revision: current })
}
/** The current revision a conflict reported, or undefined when the error is not a draft conflict. */
export function conflictRevision(e: unknown): number | null | undefined {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'draft_conflict') return undefined
  const r = (e as Partial<DraftConflictError>).current_revision
  return typeof r === 'number' && Number.isSafeInteger(r) && r >= 1 ? r : null
}

/** UTF-8 length of the JSON a draft body is sent as. */
export function draftBytes(body: unknown): number {
  try {
    const s = JSON.stringify(body)
    return s === undefined ? Infinity : new TextEncoder().encode(s).length
  } catch {
    return Infinity
  }
}
