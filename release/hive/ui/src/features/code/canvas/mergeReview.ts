/**
 * The merge review packet (Surface, Code canvas phase 2; gap inventory row 29), over OmegaCode's
 *   GET /v1/workspaces/{ws}/merge-review/{change_id}   read, full-workspace scope (Codex ruling: read relay)
 * (service.merge_review_packet). It is evidence about an APPLIED merge at the current source: what changed, what was
 * verified, and its limits. It dispatches no review and awards no quality. Wired behind capability detection
 * (`merge-review-packet` in the service's merge features) AND the hive's real answer: until Platform's relay lands the
 * hive answers 404 not_relayed, and nothing is shown.
 */
import { ApiError } from '../../../api/client'

export const MERGE_REVIEW = 'merge-review-packet'

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>
export interface MergePacket {
  change: string
  generation: number
  files: number
  verification: string
  quality: string
  dispatch: string
  limitations: string[]
}
export type MergeReviewState = { kind: 'hidden' } | { kind: 'packet'; packet: MergePacket } | { kind: 'error'; text: string }

/** The applied merge at the current source, if there is one (only that can have a packet). */
export function mergeReviewTarget(raw: unknown, ws: { generation: number; tree_digest: string }): string | null {
  const changes = raw && typeof raw === 'object' ? (raw as { changes?: unknown }).changes : undefined
  if (!Array.isArray(changes)) return null
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i] as Record<string, unknown>
    if (c && typeof c.id === 'string' && c.merge_preview_id && c.generation === ws.generation && c.tree_digest === ws.tree_digest) return c.id
  }
  return null
}

export function parseMergeReview(raw: unknown): MergePacket {
  const r = (raw ?? {}) as Record<string, unknown>
  const a = r.artifact as Record<string, unknown> | undefined
  if (r.schema !== 'omegacode-merge-review-v1' || !a || typeof a.changeset_id !== 'string' || typeof a.generation !== 'number' || !r.changed_files || typeof r.changed_files !== 'object') throw new Error('The merge review packet was not understood.')
  return {
    change: a.changeset_id,
    generation: a.generation,
    files: Object.keys(r.changed_files as object).length,
    verification: String(r.verification_state ?? 'unknown'),
    quality: String(r.quality_approval ?? 'not_assessed'),
    dispatch: String(r.review_dispatch ?? 'host_bridge_required'),
    limitations: Array.isArray(r.limitations) ? r.limitations.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
  }
}

const unrelayed = (e: unknown) => e instanceof ApiError && (e.code === 'not_relayed' || e.code === 'service_unavailable' || (e.code === 'http_404' && e.source === 'omegacode'))

/** Hidden unless declared, relayed and there is an applied merge to review; the packet otherwise. */
export async function loadMergeReview(call: Call, ws: { id: string; generation: number; tree_digest: string }, caps: { status: string; features: ReadonlySet<string> }): Promise<MergeReviewState> {
  if (caps.status !== 'ready' || !caps.features.has(MERGE_REVIEW)) return { kind: 'hidden' }
  try {
    const target = mergeReviewTarget(await call<unknown>('GET', `/v1/workspaces/${ws.id}/changes`), ws)
    if (!target) return { kind: 'hidden' }
    return { kind: 'packet', packet: parseMergeReview(await call<unknown>('GET', `/v1/workspaces/${ws.id}/merge-review/${target}`)) }
  } catch (e) {
    if (unrelayed(e)) return { kind: 'hidden' }
    return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
  }
}

const VERIFIED: Record<string, string> = { passed: 'every recorded check passed', failed: 'a recorded check failed', missing: 'no checks recorded on the merged source yet', unknown: 'checks recorded, outcome unclear' }
export const verificationWords = (v: string) => VERIFIED[v] ?? v
