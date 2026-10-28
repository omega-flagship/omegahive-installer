import { describe, expect, it } from 'vitest'
import type { CollabRequest } from '../../api/types'
import { composeArtifacts, filterArtifacts, NO_FILTER } from './artifacts'

const digest = `sha256:${'a'.repeat(64)}`

describe('the hive-level artifact list', () => {
  const request = { id: 'rq1', kind: 'review', title: 'Review the patch', from_swarm: 's1', from_principal: 'agent:a_v', to_swarm: 's2', state: 'working', created_at: '2026-10-05T10:00:00Z', subject: { artifact_id: 'ar1', revision: 3, digest } } as unknown as CollabRequest
  const items = composeArtifacts({
    requests: [request, { ...request, id: 'rq2', subject: { bad: true } } as unknown as CollabRequest],
    flows: { s2: [{ artifact_id: 'ar9', title: 'Nightly', revision: 2 }] },
    shares: [
      { id: 'sh1', owner_id: 'a_d', grantee_id: 'a_v', status: 'active', created_at: '2026-10-05T11:00:00Z', exhibit_id: 'ex1', exhibit: { title: 'Spectra', bytes: 10, atoms: 2 } },
      { id: 'sh2', owner_id: 'a_d', grantee_id: 'a_x', status: 'active', created_at: '2026-10-05T11:00:00Z', exhibit_id: 'ex1', exhibit: { title: 'Spectra', bytes: 10, atoms: 2 } },
    ],
    activity: [
      { id: 'pa1', program: 'explorer', swarm_id: 's1', principal: 'agent:a_v', action: 'annotate', items: ['b1'], status: 'done', approval_id: null, created_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:01Z' },
      { id: 'pa2', program: 'explorer', swarm_id: 's1', principal: 'agent:a_v', action: 'annotate', items: [], status: 'failed', approval_id: null, created_at: '2026-10-05T12:00:00Z', finished_at: null },
    ],
  })

  it('composes one row per thing, newest first, skipping malformed references and unfinished actions', () => {
    expect(items.map((a) => a.key)).toEqual(['app:pa1', 'exhibit:ex1', 'review:rq1', 'flow:ar9'])
    expect(items.find((a) => a.kind === 'review')).toMatchObject({ mind_id: 'a_v', revision: 3, ref: { artifact_id: 'ar1', revision: 3, digest } })
  })

  it('filters by kind, swarm (through a mind), mind, app and text', () => {
    expect(filterArtifacts(items, { ...NO_FILTER, kind: 'flow' }).map((a) => a.key)).toEqual(['flow:ar9'])
    expect(filterArtifacts(items, { ...NO_FILTER, swarm: 's9' }, (id) => (id === 'a_d' ? 's9' : null)).map((a) => a.key)).toEqual(['exhibit:ex1'])
    expect(filterArtifacts(items, { ...NO_FILTER, app: 'explorer' }).map((a) => a.key)).toEqual(['app:pa1'])
    expect(filterArtifacts(items, { ...NO_FILTER, q: 'PATCH' }).map((a) => a.key)).toEqual(['review:rq1'])
  })
})
