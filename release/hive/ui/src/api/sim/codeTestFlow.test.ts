// SIM ONLY, invented data. Create · Code's whole person flow in the simulator: ask → admitted → helper works → proposal
// → sandbox test of the proposal on a fork (running, then passed or failed) → ready to apply; plus the Ask capability,
// the team's host-bound request limits, and code/select + code/attach for Create's embedded workbench.
import { describe, expect, it } from 'vitest'
import { SimCodeService } from './codeService'
import { SimIntents, SIM_CODE_TEAM } from './intents'
import { SimProjectTests, simTestStdout, type SimTestSource } from './projectTests'
import { SimClient } from './SimClient'
import { codeTestBody, parseCodeTestQueueReceipt, resumeCodeTest } from '../../features/code/testIntent'
import { parseProjectTestEvidence, projectTestEvidenceRequest, type EvidenceSubject } from '../../features/code/suggestions/projectTestEvidence'

const TASK = 'g_simflow01'
const WS = 'ws_simflow01'

async function flow(opts: { outcome?: 'pass' | 'fail'; workMs?: number; testRunMs?: number } = {}) {
  const svc = new SimCodeService({ workspace_id: WS, task_id: TASK })
  const turns = new Map<string, { turnId: string; createdAt: string }>()
  const host = new SimIntents({
    principal: () => 'user:you', admin: () => true, turn: (op) => turns.get(op) ?? null,
    code: (t) => (t === TASK ? svc : undefined), later: (ms, fn) => setTimeout(fn, ms),
    workMs: () => opts.workMs ?? 0, testRunMs: () => opts.testRunMs ?? 0, testOutcome: () => opts.outcome ?? 'pass',
  })
  const turn = (op: string) => turns.set(op, { turnId: `t_${op}`, createdAt: new Date().toISOString() })
  const head = (await svc.proxy('POST', '/v1/workspaces', {}, {})) as { id: string; generation: number; tree_digest: string }
  const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 'sc1', expected_generation: head.generation, expected_tree_digest: head.tree_digest, ranges: { 'calculator.py': [[0, 31]] } })) as { id: string; digest: string }
  turn('op_ask')
  const rec = host.record('op_ask', { kind: 'code.request', request: {
    to_swarm: SIM_CODE_TEAM.to_swarm, kind: 'code', title: 'Fix add()', instruction: 'Fix add() in the calculator',
    origin: { task_id: TASK, repository_id: 'sim-suggestions', workspace_id: WS, scope_id: scope.id, scope_digest: `sha256:${scope.digest}`, generation: head.generation },
    budget: { limit_usd: 0.25 }, lifetime: { until: new Date(Date.now() + 590_000).toISOString() }, lease: { template_ids: ['tpl_sim_coder'], max_children: 1 },
  } }).view as { intent_id: string }
  const admission = host.submit(rec.intent_id) as { request_id: string; state: string }
  return { svc, host, turn, head, admission }
}
async function until<T>(read: () => Promise<T | null | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
async function retained(svc: SimCodeService) {
  const page = (await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions`, {}, undefined)) as Record<string, unknown>
  const list = (Object.values(page).find(Array.isArray) ?? []) as { id?: string; record?: { id: string } }[]
  const id = list.map((x) => x.record?.id ?? x.id).find((x) => typeof x === 'string')
  if (!id) return null
  return (await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${id}`, {}, undefined)) as { record: { id: string; digest: string }; content: { digest: string; binding: { generation: number; tree_digest: string }; hunks: { replacement: string }[] } }
}
function subjectOf(p: NonNullable<Awaited<ReturnType<typeof retained>>>, head: { generation: number; tree_digest: string }): EvidenceSubject {
  return { workspace_id: WS, generation: head.generation, tree_digest: head.tree_digest, proposal_id: p.record.id, proposal_digest: p.record.digest, normalized_hunks_digest: p.content.digest }
}

describe('sim Create · Code: the whole person flow', () => {
  it('admits the request, the helper proposes return a + b, the queued test reads running, then passed', async () => {
    const { svc, host, turn, head, admission } = await flow({ testRunMs: 300 })
    expect(admission.state).toBe('accepted')
    const p = await until(() => retained(svc))
    expect(p.content.hunks.map((h) => h.replacement).join('')).toContain('+')
    // the person's Test: codeTestBody → record → submit, exactly as testIntent.resumeCodeTest drives the live client
    turn('op_test')
    const body = codeTestBody({ request_id: admission.request_id, proposal_id: p.record.id })
    const client = { askRecordCodeTestIntent: async (op: string, b: typeof body) => host.recordTest(op, b).view, askSubmitIntent: async (id: string) => host.submit(id) }
    const out = await resumeCodeTest(client, { operation: 'op_test', body }, () => true)
    expect(out.kind).toBe('queued')
    if (out.kind !== 'queued') return
    expect(out.receipt).toMatchObject({ schema: 'hive.code-test-intent-receipt/1', kind: 'code.test', state: 'queued', tested: false, accepted_source: false, controller_id: 'a_vega01' })
    expect(parseCodeTestQueueReceipt(host.submit(out.attempt.intent!), body.request)).toEqual(out.receipt) // a resubmit answers the same receipt
    const subject = subjectOf(p, head)
    const req = projectTestEvidenceRequest(subject)
    const running = await parseProjectTestEvidence(await svc.proxy('GET', req.path, req.query, undefined), subject)
    expect(running.results).toHaveLength(1)
    expect(running.results[0]).toMatchObject({ tested: false, outcome: 'unknown', currency: 'unknown', logs: [] })
    await new Promise((r) => setTimeout(r, 350))
    const done = await parseProjectTestEvidence(await svc.proxy('GET', req.path, req.query, undefined), subject)
    expect(done.results[0]).toMatchObject({ tested: true, outcome: 'succeeded', currency: 'current' })
    expect(done.results[0].logs.find((l) => l.name === 'stdout')!.text).toContain('1 passed in 0.02s')
    expect(done.next_cursor).toBeNull()
  })

  it('simtest=fail: the settled result failed with the assertion, and is not tested', async () => {
    const { svc, host, turn, head, admission } = await flow({ outcome: 'fail' })
    const p = await until(() => retained(svc))
    turn('op_test')
    const view = host.recordTest('op_test', codeTestBody({ request_id: admission.request_id, proposal_id: p.record.id })).view as { intent_id: string; kind: string; request_operation_id: string; state: string; title: string; acceptance: string }
    expect(view).toMatchObject({ kind: 'code.test', state: 'pending', request_operation_id: `ask.${view.intent_id}`, title: 'Test retained proposal', acceptance: 'queued_only' })
    expect(view.intent_id).toMatch(/^ai_[a-f0-9]{24}$/)
    host.submit(view.intent_id)
    const subject = subjectOf(p, head)
    const req = projectTestEvidenceRequest(subject)
    const page = await parseProjectTestEvidence(await svc.proxy('GET', req.path, req.query, undefined), subject)
    expect(page.results[0]).toMatchObject({ tested: false, outcome: 'not_succeeded' })
    const text = page.results[0].logs.find((l) => l.name === 'stdout')!.text
    expect(text).toContain('assert add(2, 3) == 5')
    expect(text).toContain('AssertionError')
  })

  it('refuses a test of another request, or of a proposal that is not this request’s', async () => {
    const { svc, host, turn, admission } = await flow()
    const p = await until(() => retained(svc))
    turn('op_x')
    expect(() => host.recordTest('op_x', codeTestBody({ request_id: 'rq_nothere', proposal_id: p.record.id }))).toThrow(expect.objectContaining({ code: 'not_available' }))
    expect(() => host.recordTest('op_x', codeTestBody({ request_id: admission.request_id, proposal_id: `suggestion_${'0'.repeat(32)}` }))).toThrow(expect.objectContaining({ code: 'code_test_source' }))
    expect(() => host.recordTest('op_x', { kind: 'code.test', request: { request_id: admission.request_id } })).toThrow(expect.objectContaining({ code: 'bad_request' }))
  })

  it('paces the helper: it is seen working for workMs before its proposal lands', async () => {
    const { svc, host, admission } = await flow({ workMs: 900 })
    const kid = await until(async () => host.children(SIM_CODE_TEAM.to_swarm).children.find((k) => k.request_id === admission.request_id))
    expect(kid.state).toBe('running')
    expect(await retained(svc)).toBeNull() // still thinking
    const p = await until(() => retained(svc))
    expect(p.record.id).toMatch(/^suggestion_[a-f0-9]{32}$/)
  })
})

describe('sim project-test evidence pages', () => {
  it('a running row parses as unknown; paging is by four, newest first', async () => {
    const t = new SimProjectTests()
    const source: SimTestSource = { request_id: 'rq_simx', repository_id: 'sim-suggestions', proposal: { proposal_id: `suggestion_${'a'.repeat(32)}`, proposal_digest: `sha256:${'b'.repeat(64)}`, normalized_hunks_digest: `sha256:${'c'.repeat(64)}` }, parent: { workspace_id: WS, generation: 1, tree_digest: `sha256:${'d'.repeat(64)}` } }
    for (let i = 0; i < 5; i++) t.start(source, { lease_id: 'ls_sim', controller_id: 'a_vega01', issuer: 'user:you', outcome: 'pass', runMs: 60_000 })
    const subject: EvidenceSubject = { workspace_id: WS, generation: 1, tree_digest: 'd'.repeat(64), proposal_id: source.proposal.proposal_id, proposal_digest: 'b'.repeat(64), normalized_hunks_digest: 'c'.repeat(64) }
    const first = await parseProjectTestEvidence(await t.page(source.proposal.proposal_id, { generation: 1, tree_digest: 'd'.repeat(64) }, { limit: '4', cursor: '0' }), subject, '0')
    expect(first.results).toHaveLength(4)
    expect(first.next_cursor).toBe('4')
    expect(first.results.every((r) => !r.tested && r.outcome === 'unknown')).toBe(true)
    // a later workspace head: the evidence is historical
    const stale = await parseProjectTestEvidence(await t.page(source.proposal.proposal_id, { generation: 2, tree_digest: 'e'.repeat(64) }, { limit: '4', cursor: '4' }), subject, '4')
    expect(stale.results[0].currency).toBe('stale')
  })
  it('the invented outputs read as pytest', () => {
    expect(simTestStdout('pass')).toMatch(/=+ 1 passed in 0\.02s =+/)
    expect(simTestStdout('fail')).toMatch(/FAILED tests\/test_calculator\.py::test_add - AssertionError: assert -1 == 5/)
  })
})

describe('SimClient: capability, team limits, code.test route, code/select and code/attach', () => {
  const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  it('the Ask settings say code_test_intents, so the bench offers the sandbox test', async () => {
    expect((await sim().askSettings()).capabilities).toMatchObject({ code_test_intents: true })
    expect((await new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1, codeMode: 'person' }).askSettings()).capabilities?.code_test_intents).toBeUndefined()
  })
  it('the Code team offer carries the host-bound request limits, as live.ts codeTeamOffer reads them', async () => {
    const offer = await sim().codeTeamOffer!({} as never)
    expect(offer).toEqual({ to_swarm: 's_lyra', team_name: 'Lyra', template_ids: ['tpl_sim_coder'], limits: { limit_usd: 0.25, max_children: 1, lifetime_seconds: 600, template_ids: ['tpl_sim_coder'] } })
  })
  it('askRecordCodeTestIntent exists, is a named person’s route, and pacing is off under vitest', async () => {
    const a = sim()
    expect(typeof a.askRecordCodeTestIntent).toBe('function')
    a.simSession = 'operator'
    await expect(a.askRecordCodeTestIntent('op', codeTestBody({ request_id: 'rq_x', proposal_id: `suggestion_${'0'.repeat(32)}` }))).rejects.toMatchObject({ code: 'person_required' })
    expect((a as unknown as { opts: { codePacing: boolean } }).opts.codePacing).toBe(false)
  })
  it('code/select keeps the task and its repo; code/attach joins its workspace; the workbench reads the tree and calculator.py', async () => {
    const a = sim()
    a.simSession = 'person'
    const opened = await a.codeOpen('repo:sim-suggestions')
    const selected = await a.codeSelect(opened.task_id, opened.repository_id)
    expect(selected).toMatchObject({ task_id: opened.task_id, repository_id: 'sim-suggestions', swarm_id: opened.swarm_id, base_commit: opened.base_commit, target: { id: 'repo:sim-suggestions' } })
    expect(selected.grant_id).not.toBe(opened.grant_id)
    const ctx = { task_id: selected.task_id, grant_id: selected.grant_id, repository_id: selected.repository_id }
    const w = await a.codeProxy<{ id: string; base_commit: string }>('POST', '/v1/workspaces', ctx, { operation_id: `open-${selected.task_id}`, repository_id: selected.repository_id, task_id: selected.task_id, base_commit: selected.base_commit })
    const tree = await a.codeProxy<{ files: { path: string }[] }>('GET', `/v1/workspaces/${w.id}/tree`, ctx)
    expect(tree.files.map((f) => f.path)).toContain('calculator.py')
    const calc = await a.codeProxy<{ content: string }>('GET', `/v1/workspaces/${w.id}/files`, { ...ctx, path: 'calculator.py' })
    expect(calc.content).toContain('return a - b')
    const attached = await a.codeAttach(selected.task_id, w.id, selected.repository_id)
    expect(attached).toMatchObject({ task_id: selected.task_id, workspace_id: w.id, repository_id: 'sim-suggestions', base_commit: w.base_commit })
    const via = await a.codeProxy<{ files: { path: string }[] }>('GET', `/v1/workspaces/${w.id}/tree`, { task_id: attached.task_id, grant_id: attached.grant_id, repository_id: attached.repository_id })
    expect(via.files.length).toBe(tree.files.length)
    await expect(a.codeAttach(selected.task_id, 'ws_notthis', 'sim-suggestions')).rejects.toMatchObject({ status: 403 })
    await expect(a.codeSelect(selected.task_id, 'old-notebooks')).rejects.toMatchObject({ code: 'repository_unregistered' })
    await expect(a.codeSelect('g_nosuch', 'sim-suggestions')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('code/select on a Create task with no Code workspace yet gives it the invented repository', async () => {
    const a = sim()
    a.simSession = 'person'
    const opened = await a.codeOpen('repo:sim-suggestions')
    // a different, open task of the hive (not a code/open task): the invented service is made for it
    const goal = [...(a as unknown as { goals: Map<string, { id: string; status: string }> }).goals.values()].find((g) => g.status === 'open' && g.id !== opened.task_id)!
    const s = await a.codeSelect(goal.id, 'sim-suggestions')
    const w = await a.codeProxy<{ id: string; task_id: string }>('POST', '/v1/workspaces', { task_id: s.task_id, grant_id: s.grant_id, repository_id: s.repository_id }, {})
    expect(w.task_id).toBe(goal.id)
  })
})

