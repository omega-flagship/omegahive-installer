import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client'
import { SimCodeService } from '../../../api/sim/codeService'
import { loadMergeReview, mergeReviewTarget, parseMergeReview } from './mergeReview'

type Call = Parameters<typeof loadMergeReview>[0]
const asCall = (f: unknown) => f as Call

// Phase 2.4, row 29: the merge review packet (OmegaCode service.merge_review_packet; relay coming from Platform)
const WS = { id: 'ws_mr', generation: 5, tree_digest: 't'.repeat(64) }
const merge = { id: 'cs_m', workspace_id: 'ws_mr', generation: 5, tree_digest: 't'.repeat(64), merge_preview_id: 'mp_1' }
const PACKET = { schema: 'omegacode-merge-review-v1', artifact: { changeset_id: 'cs_m', generation: 5 }, changed_files: { 'a.py': {}, 'b.py': {} }, verifications: [], verification_state: 'missing', quality_approval: 'not_assessed', review_dispatch: 'host_bridge_required', limitations: ['Passing commands do not prove quality or independent review'] }
const READY = { status: 'ready' as const, features: new Set(['merge-review-packet']) }

describe('the merge review packet, behind capability detection and the relay', () => {
  it('targets only the applied merge at the current source', () => {
    expect(mergeReviewTarget({ changes: [{ id: 'cs_1', generation: 4, tree_digest: 'x' }, merge] }, WS)).toBe('cs_m')
    expect(mergeReviewTarget({ changes: [{ ...merge, generation: 4 }] }, WS)).toBeNull()
    expect(mergeReviewTarget({ changes: [{ id: 'cs_1', generation: 5, tree_digest: 't'.repeat(64) }] }, WS)).toBeNull()
  })
  it('parses the packet strictly and keeps its limits', () => {
    expect(parseMergeReview(PACKET)).toMatchObject({ change: 'cs_m', files: 2, verification: 'missing', limitations: ['Passing commands do not prove quality or independent review'] })
    expect(() => parseMergeReview({ ...PACKET, schema: 'x' })).toThrow()
  })
  it('stays hidden (and asks nothing) unless the service declares merge-review-packet', async () => {
    const call = vi.fn()
    expect(await loadMergeReview(asCall(call), WS, { status: 'ready', features: new Set() })).toEqual({ kind: 'hidden' })
    expect(await loadMergeReview(asCall(call), WS, { status: 'checking', features: new Set(['merge-review-packet']) })).toEqual({ kind: 'hidden' })
    expect(call).not.toHaveBeenCalled()
  })
  it('stays hidden while the hive does not relay the route (today), and when there is no merge to review', async () => {
    const notRelayed = vi.fn(async (_m: string, p: string) => {
      if (p.endsWith('/changes')) return { changes: [merge] }
      throw new ApiError(404, 'not_relayed', 'GET … is not available through the hive')
    })
    expect(await loadMergeReview(asCall(notRelayed), WS, READY)).toEqual({ kind: 'hidden' })
    const noMerge = vi.fn(async () => ({ changes: [] }))
    expect(await loadMergeReview(asCall(noMerge), WS, READY)).toEqual({ kind: 'hidden' })
    expect(noMerge).toHaveBeenCalledTimes(1)
  })
  it('shows the packet once the relay answers', async () => {
    const relayed = vi.fn(async (_m: string, p: string) => (p.endsWith('/changes') ? { changes: [merge] } : PACKET))
    expect(await loadMergeReview(asCall(relayed), WS, READY)).toMatchObject({ kind: 'packet', packet: { change: 'cs_m', files: 2 } })
    expect(relayed).toHaveBeenLastCalledWith('GET', '/v1/workspaces/ws_mr/merge-review/cs_m')
  })
  it('the simulator plays today’s hive: the route is not relayed', async () => {
    const svc = new SimCodeService({ workspace_id: 'ws_mr' })
    await svc.proxy('GET', '/v1/workspaces/ws_mr', {}, null)
    await expect(svc.proxy('GET', '/v1/workspaces/ws_mr/merge-review/cs_x', {}, null)).rejects.toMatchObject({ code: 'not_relayed' })
  })
})
