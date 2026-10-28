import { describe, expect, it } from 'vitest'
import { SimCodeService } from './codeService'

// r2, Kimi FIX-FIRST 2: the simulator binds runs to their workspace, exactly as OmegaCode's service does
// (service.run / run_output / cancel authorise against the run's own workspace; output cursor 0..4 MiB, limit 1..65536)
describe('sim runs are bound to their workspace', () => {
  const ws = 'ws_cc02'
  const head = async (s: SimCodeService) => (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
  it('refuses a run asked for another workspace', async () => {
    const s = new SimCodeService({ workspace_id: ws })
    const h = await head(s)
    await expect(s.proxy('POST', '/v1/runs', {}, { workspace_id: 'ws_other', expected_generation: h.generation, expected_tree_digest: h.tree_digest, argv: ['pytest'] })).rejects.toMatchObject({ status: 404 })
  })
  it('refuses reading, polling or cancelling a run that belongs to another workspace', async () => {
    const s = new SimCodeService({ workspace_id: ws })
    await head(s)
    ;(s as unknown as { runs: Map<string, unknown> }).runs.set('run_elsewhere', { id: 'run_elsewhere', workspace_id: 'ws_other', status: 'succeeded', argv: ['x'], exit_code: 0, generation: 1, tree_digest: 't', output: 'secret\n' })
    await expect(s.proxy('GET', '/v1/runs/run_elsewhere/output', { after: '0' }, null)).rejects.toMatchObject({ status: 404 })
    await expect(s.proxy('GET', '/v1/runs/run_elsewhere', {}, null)).rejects.toMatchObject({ status: 404 })
    await expect(s.proxy('POST', '/v1/runs/run_elsewhere/cancel', {}, { operation_id: 'c' })).rejects.toMatchObject({ status: 404 })
  })
  it('refuses an output cursor outside the service bounds (400 invalid_output_cursor)', async () => {
    const s = new SimCodeService({ workspace_id: ws })
    const h = await head(s)
    const run = (await s.proxy('POST', '/v1/runs', {}, { workspace_id: ws, expected_generation: h.generation, expected_tree_digest: h.tree_digest, argv: ['pytest'] })) as { id: string }
    await expect(s.proxy('GET', `/v1/runs/${run.id}/output`, { after: '-1' }, null)).rejects.toMatchObject({ code: 'invalid_output_cursor' })
    await expect(s.proxy('GET', `/v1/runs/${run.id}/output`, { after: '0', limit: '70000' }, null)).rejects.toMatchObject({ code: 'invalid_output_cursor' })
  })
})
