/**
 * The joint first-slice flow, end to end against the simulator's invented code service (sim/codeService.ts):
 * saved selection -> human scope -> instruction -> retained proposal -> one accepted hunk -> ChangeSet -> stale remainder
 * refused; plus identical retry after a lost answer, changed-payload refusal, issuer revocation and another actor's edit.
 * INVENTED DATA: this qualifies the panel's model against a faithful stand-in, not the live service or hive.
 */
import { describe, expect, it } from 'vitest'
import { SimClient } from '../../../api/sim/SimClient'
import { SimCodeService } from '../../../api/sim/codeService'
import { canonical, hunkIdentityBody, parseCreateRecord, parseDecisionResult, parseScopeRecord, parseHistoryPage, parseSuggestionRead, sha256Text, verifyIntegrity, type SuggestionDecisionRequest } from './contract'
import { addRange, authoredMismatch, createRequest, decisionRequest, describeFailure, dirtyConflict, groupsOf, hunkStates, personHunks, rangeKey, receiptCheck, receiptOf, scopeRanges, stage, type PickedRange } from './model'
import { savedHunkRanges, savedSelection } from './savedSelection'

const WS = 'ws_simsuggest01'
type Ws = { id: string; generation: number; tree_digest: string }
type File = { content: string; digest: string; generation: number }

async function setup() {
  const svc = new SimCodeService()
  const ws = (await svc.proxy('POST', '/v1/workspaces', {}, {})) as Ws
  const file = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/greeting.py' }, undefined)) as File
  // the person selects the whole greet() function in the editor (UTF-16 offsets on exactly the saved text)
  const from = file.content.indexOf('def greet')
  const to = file.content.indexOf('\n\n\ndef farewell')
  const sel = await savedSelection(new TextEncoder().encode(file.content), file.digest, file.content, from, to)
  const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 'scope-1', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'src/greeting.py': [[sel.start_byte, sel.end_byte]] } })) as { id: string }
  const rec = (await svc.ask(WS, scope.id, 'Add type hints and use an f-string')) as { id: string }
  const read = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${rec.id}`, {}, undefined), { workspace_id: WS, suggestion_id: rec.id })
  return { svc, ws, file, sel, scope, read }
}

describe('selection -> proposal -> accepted hunk -> ChangeSet -> stale remainder (sim, invented)', () => {
  it('runs the whole first slice', async () => {
    const { svc, ws, file, read } = await setup()
    expect(read.currency).toBe('current')
    expect(read.content.binding.generation).toBe(ws.generation)
    expect(await verifyIntegrity(read)).toEqual({ ok: true, problems: [] })
    // the invented mind proposes 4 hunks: a signature, and a 3-line dependent rename group
    expect(read.content.hunks).toHaveLength(4)
    const [sig, ...rename] = read.content.hunks
    expect(groupsOf(read).get(rename[0].id)).toEqual(rename.map((h) => h.id))
    // retained bytes convert back to editor positions on the saved source
    const views = await savedHunkRanges(new TextEncoder().encode(file.content), file.digest, file.content, read.content.hunks)
    expect(views[0]).toMatchObject({ before: 'def greet(name):', after: 'def greet(name: str) -> str:' })
    expect(file.content.slice(views[0].from, views[0].to)).toBe('def greet(name):')

    // a dependent group cannot be split
    expect(stage(read, {}, rename[0].id, 'accept').staged).toEqual(Object.fromEntries(rename.map((h) => [h.id, 'accept'])))
    const split = { ...decisionRequest(read, { [sig.id]: 'accept' }, 'split'), accepted_hunk_ids: [sig.id, rename[0].id] }
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, split)).rejects.toMatchObject({ code: 'suggestion_group_split' })

    // accept ONE hunk -> one atomic ChangeSet
    const request = decisionRequest(read, { [sig.id]: 'accept' }, 'decide-1')
    const result = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request), request)
    expect(result.change).toMatchObject({ generation: ws.generation + 1, paths: ['src/greeting.py'], before_digest: ws.tree_digest })
    expect(result.decision.change_id).toBe(result.change!.id)
    const after = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/greeting.py' }, undefined)) as File
    expect(after.content).toContain('def greet(name: str) -> str:\n    message = "Hello, " + name + "!"')

    // the remaining original hunks are now stale: shown as stale, refused on accept AND on reject
    const now = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${read.record.id}`, {}, undefined))
    expect(now.currency).toBe('stale')
    expect(hunkStates(now).get(sig.id)?.kind).toBe('accepted')
    expect(rename.map((h) => hunkStates(now).get(h.id)?.kind)).toEqual(['stale', 'stale', 'stale'])
    const remainder: SuggestionDecisionRequest = { ...request, operation_id: 'decide-2', accepted_hunk_ids: rename.map((h) => h.id), rejected_hunk_ids: [] }
    const refused = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, remainder).catch((e) => e)
    expect(describeFailure(refused).kind).toBe('stale')
    const rejectStale = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, { ...remainder, operation_id: 'decide-3', accepted_hunk_ids: [], rejected_hunk_ids: rename.map((h) => h.id) }).catch((e) => e)
    expect(describeFailure(rejectStale).kind).toBe('stale')
    // binding the new generation instead of the retained one refuses too (no silent rebase)
    const rebased = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, { ...remainder, operation_id: 'decide-4', expected_generation: result.change!.generation, expected_tree_digest: result.change!.tree_digest }).catch((e) => e)
    expect(rebased).toMatchObject({ code: 'suggestion_stale' })

    // history lists it with counts and currency
    const page = parseHistoryPage(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions`, { limit: '20' }, undefined), WS)
    expect(page.items[0]).toMatchObject({ id: read.record.id, currency: 'stale', hunk_count: 4, accepted_count: 1, rejected_count: 0 })
  })

  it('retry after a lost answer returns the original receipt; a changed payload under the same ID refuses', async () => {
    const { svc, read } = await setup()
    const request = decisionRequest(read, { [read.content.hunks[0].id]: 'accept' }, 'decide-lost')
    await svc.fixture('lose-next-answer')
    const lost = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request).catch((e) => e)
    expect(describeFailure(lost).kind).toBe('unknown')
    const retried = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request), request)
    const again = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request), request)
    expect(again.change!.id).toBe(retried.change!.id)
    const ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, undefined)) as Ws
    expect(ws.generation).toBe(read.content.binding.generation + 1) // applied once, not twice
    const changed = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, { ...request, accepted_hunk_ids: [], rejected_hunk_ids: [read.content.hunks[0].id] }).catch((e) => e)
    expect(changed).toMatchObject({ code: 'operation_conflict' })
  })

  it('rejection records a decision and leaves source unchanged', async () => {
    const { svc, read, ws } = await setup()
    const request = decisionRequest(read, { [read.content.hunks[0].id]: 'reject' }, 'reject-1')
    const r = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request), request)
    expect(r.change).toBeUndefined()
    expect(r.workspace.generation).toBe(ws.generation)
    const now = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${read.record.id}`, {}, undefined))
    expect(now.currency).toBe('current')
    expect(hunkStates(now).get(read.content.hunks[0].id)?.kind).toBe('rejected')
    const twice = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, { ...request, operation_id: 'reject-2' }).catch((e) => e)
    expect(describeFailure(twice).kind).toBe('decided')
  })

  it('revocation of the scope issuer refuses decisions and new proposals; a fresh scope works', async () => {
    const { svc, read, sel } = await setup()
    await svc.fixture('revoke-issuer')
    const request = decisionRequest(read, { [read.content.hunks[0].id]: 'accept' }, 'after-revoke')
    const refused = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, request).catch((e) => e)
    expect(describeFailure(refused).kind).toBe('revoked')
    await expect(svc.ask(WS, read.content.scope_id, 'again')).rejects.toMatchObject({ code: 'invalid_capability' })
    const ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, undefined)) as Ws
    const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 'scope-2', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'src/greeting.py': [[sel.start_byte, sel.end_byte]] } })) as { id: string }
    expect(await svc.ask(WS, scope.id, 'again')).toMatchObject({ scope_id: scope.id })
  })

  it('another actor\'s edit makes the proposal stale before any decision (reload shows it)', async () => {
    const { svc, read } = await setup()
    await svc.fixture('external-edit')
    const now = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${read.record.id}`, {}, undefined))
    expect(now.currency).toBe('stale')
    const refused = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, decisionRequest(read, { [read.content.hunks[0].id]: 'accept' }, 'x')).catch((e) => e)
    expect(describeFailure(refused).kind).toBe('stale')
  })

  it('dirty editor: no scope from unsaved text, and accepting into the dirty file is refused before sending', async () => {
    const { file, read } = await setup()
    const bytes = new TextEncoder().encode(file.content)
    await expect(savedSelection(bytes, file.digest, file.content + '# typing', 0, 3)).rejects.toThrow(/dirty/)
    expect(dirtyConflict(read, { [read.content.hunks[0].id]: 'accept' }, { path: 'src/greeting.py', dirty: true })).toMatch(/unsaved edits/)
  })

  it('scope minting refuses split characters and stale generations; proposals outside scope refuse', async () => {
    const svc = new SimCodeService()
    const ws = (await svc.proxy('POST', '/v1/workspaces', {}, {})) as Ws
    const units = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/units.py' }, undefined)) as File
    const omega = new TextEncoder().encode(units.content.slice(0, units.content.indexOf('Ω'))).length
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 's', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'src/units.py': [[omega + 1, omega + 2]] } })).rejects.toMatchObject({ code: 'suggestion_scope' })
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 's2', expected_generation: ws.generation + 1, expected_tree_digest: ws.tree_digest, ranges: { 'src/units.py': [[0, 2]] } })).rejects.toMatchObject({ code: 'stale_workspace' })
    const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 's3', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'src/units.py': [[0, 10]] } })) as { id: string }
    const outside = { operation_id: 'p', scope_id: scope.id, hunks: [{ path: 'src/units.py', start_byte: 20, end_byte: 21, replacement: 'x', before_digest: 'a'.repeat(64) }] }
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, outside)).rejects.toMatchObject({ code: 'suggestion_refused' })
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, { ...outside, operation_id: 'p2', model: 'gpt' })).rejects.toMatchObject({ status: 422 })
  })
})

describe('person-authored explicit hunks: the live first slice, rehearsed on the sim (invented)', () => {
  const CALC = 'calculator.py'
  async function personScope(svc = new SimCodeService()) {
    const ws = (await svc.proxy('POST', '/v1/workspaces', {}, {})) as Ws
    const file = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: CALC }, undefined)) as File
    const bytes = new TextEncoder().encode(file.content)
    // the person double-clicks `add`, then `-`, in the editor (UTF-16 offsets on exactly the saved text)
    const pick = async (needle: string, at: number): Promise<PickedRange> => {
      const from = file.content.indexOf(needle, at)
      const s = await savedSelection(bytes, file.digest, file.content, from, from + needle.length)
      return { path: CALC, start_byte: s.start_byte, end_byte: s.end_byte, lines: 'line', text: needle }
    }
    let ranges: PickedRange[] = []
    ranges = addRange(ranges, await pick('add', 0)).ranges
    ranges = addRange(ranges, await pick('-', 0)).ranges
    const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 'scope-p', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: scopeRanges(ranges) })) as { id: string }
    return { svc, ws, file, ranges, scope }
  }

  it('fixture parity: the sim calculator.py is byte-identical to the live synthetic one, and the ranges are bytes 4–7 and 28–29', async () => {
    const { file, ranges } = await personScope()
    expect(await sha256Text(file.content)).toBe('e1a894022d1a082987b87adecb623438c9e386d86b2b621cff4a5fe7fdf7edc8')
    expect(scopeRanges(ranges)).toEqual({ [CALC]: [[4, 7], [28, 29]] })
  })

  it('scope two ranges -> person writes both -> filed with explicit hunks -> retained exactly, author = the person -> accept one -> ChangeSet -> identical retry -> stale remainder', async () => {
    const { svc, ws, file, ranges, scope } = await personScope()
    const hunks = await personHunks(ranges, { [rangeKey(ranges[0])]: 'plus', [rangeKey(ranges[1])]: '+' })
    const request = createRequest(scope.id, hunks, 'suggest-p1')
    const rec = parseCreateRecord(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, request), { workspace_id: WS, scope_id: scope.id })
    expect(rec.author).toBe('user:you') // derived from the caller, never supplied
    // identical create retry returns the original record; a changed payload under the same ID refuses
    expect(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, request)).toEqual(rec)
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, { ...request, hunks: request.hunks.slice(1) })).rejects.toMatchObject({ code: 'operation_conflict' })

    const read = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${rec.id}`, {}, undefined), { workspace_id: WS, suggestion_id: rec.id })
    expect(await verifyIntegrity(read)).toEqual({ ok: true, problems: [] })
    expect(authoredMismatch(read, request)).toEqual([])
    expect(read.content.author).toBe('user:you')
    // hunk IDs are exactly what the browser derives from {binding, hunk}
    const binding = { workspace_id: WS, task_id: 'g_simcode01', generation: ws.generation, tree_digest: ws.tree_digest }
    for (const h of read.content.hunks) expect(h.id).toBe(await sha256Text(canonical(hunkIdentityBody(binding, { ...h, expected_file_digest: file.digest }))))

    // accept the `-` -> `+` hunk only
    const minus = read.content.hunks.find((h) => h.start_byte === 28)!
    const rename = read.content.hunks.find((h) => h.start_byte === 4)!
    const decide = decisionRequest(read, { [minus.id]: 'accept' }, 'decide-p1')
    const result = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, decide), decide)
    expect(result.change).toMatchObject({ generation: ws.generation + 1, paths: [CALC] })
    const after = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: CALC }, undefined)) as File
    expect(after.content).toBe('def add(a, b):\n    return a + b\n')
    const again = parseDecisionResult(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, decide), decide)
    expect(again.change!.id).toBe(result.change!.id)
    expect(((await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, undefined)) as Ws).generation).toBe(ws.generation + 1) // applied once
    const now = parseSuggestionRead(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${rec.id}`, {}, undefined))
    expect(hunkStates(now).get(rename.id)?.kind).toBe('stale')
    const stale = await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}, { ...decide, operation_id: 'decide-p2', accepted_hunk_ids: [rename.id] }).catch((e) => e)
    expect(describeFailure(stale).kind).toBe('stale')
  })

  it('create refuses exactly what the real route refuses', async () => {
    const { svc, ranges, scope } = await personScope()
    const [good] = await personHunks(ranges, { [rangeKey(ranges[0])]: 'plus' })
    const post = (body: unknown) => svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, body).catch((e) => e)
    expect(await post({ operation_id: 'r1', scope_id: scope.id, hunks: [{ ...good, before_digest: 'a'.repeat(64) }] })).toMatchObject({ code: 'suggestion_refused', message: 'before digest' })
    expect(await post({ operation_id: 'r2', scope_id: scope.id, hunks: [{ ...good, start_byte: 0, end_byte: 3, before_digest: await sha256Text('def') }] })).toMatchObject({ code: 'suggestion_refused', message: 'range scope' })
    expect(await post({ operation_id: 'r3', scope_id: scope.id, hunks: [good, { ...good, replacement: 'minus' }] })).toMatchObject({ code: 'suggestion_refused', message: 'overlapping or ambiguous hunks' })
    expect(await post({ operation_id: 'r4', scope_id: scope.id, hunks: [{ ...good, author: 'user:someone' }] })).toMatchObject({ code: 'suggestion_refused', message: 'hunk fields' })
    expect(await post({ operation_id: 'r5', scope_id: scope.id, hunks: [good], author: 'user:someone' })).toMatchObject({ status: 422 })
    expect(await post({ operation_id: 'r6', scope_id: scope.id, hunks: [] })).toMatchObject({ code: 'suggestion_refused', message: 'hunk count' })
    expect(await post({ operation_id: 'r7', scope_id: scope.id, hunks: [{ ...good, path: '../calculator.py' }] })).toMatchObject({ code: 'suggestion_refused', message: 'path scope' })
  })

  it('a withdrawn issuer refuses filing on the old scope (revoked); another actor\'s edit makes it stale', async () => {
    const { svc, ranges, scope } = await personScope()
    const req = createRequest(scope.id, await personHunks(ranges, { [rangeKey(ranges[1])]: '+' }), 'p-rev')
    await svc.fixture('revoke-issuer')
    expect(describeFailure(await svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, req).catch((e) => e)).kind).toBe('revoked')
    const fresh = await personScope()
    await fresh.svc.fixture('external-edit')
    const req2 = createRequest(fresh.scope.id, await personHunks(fresh.ranges, { [rangeKey(fresh.ranges[1])]: '+' }), 'p-stale')
    expect(describeFailure(await fresh.svc.proxy('POST', `/v1/workspaces/${WS}/suggestions`, {}, req2).catch((e) => e)).kind).toBe('stale')
  })
})

describe('relayed vs not relayed (sim configurations)', () => {
  it('a hive that does not relay the Workbench routes answers 404 not_relayed on each real call; other routes still work', async () => {
    const svc = new SimCodeService({ relay: false })
    await svc.proxy('POST', '/v1/workspaces', {}, {})
    const file = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'calculator.py' }, undefined)) as File
    expect(file.content).toContain('def add')
    const calls: [('GET' | 'POST'), string, unknown][] = [
      ['GET', `/v1/workspaces/${WS}/suggestions`, undefined],
      ['POST', `/v1/workspaces/${WS}/suggestion-scopes`, { operation_id: 'x', expected_generation: 1, expected_tree_digest: 'a'.repeat(64), ranges: { 'calculator.py': [[4, 7]] } }],
      ['POST', `/v1/workspaces/${WS}/suggestions`, { operation_id: 'y', scope_id: 'scope_x', hunks: [] }],
      ['GET', `/v1/workspaces/${WS}/suggestions/suggestion_x`, undefined],
      ['POST', `/v1/workspaces/${WS}/suggestion-decisions`, {}],
    ]
    for (const [m, p, b] of calls) {
      const e = await svc.proxy(m, p, {}, b).catch((x) => x)
      expect(e, `${m} ${p}`).toMatchObject({ status: 404, code: 'not_relayed', message: `${m} ${p} is not available through the hive` })
      expect(describeFailure(e).kind).toBe('unavailable')
    }
  })

  it('a relaying hive answers the same calls (history is the panel\'s availability probe)', async () => {
    const svc = new SimCodeService()
    await svc.proxy('POST', '/v1/workspaces', {}, {})
    expect(parseHistoryPage(await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions`, { limit: '20' }, undefined), WS).items).toEqual([])
  })

  it('the sim client plays live (no route to a mind) in person and unrelayed modes; the invented mind exists only in mind mode', () => {
    const make = (codeMode?: 'mind' | 'person' | 'unrelayed') => new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1, codeMode })
    expect(make().codeSuggestionAsk).toBeTypeOf('function')
    expect(make('person').codeSuggestionAsk).toBeUndefined()
    expect(make('unrelayed').codeSuggestionAsk).toBeUndefined()
    expect(make('person').codeSuggestionCreate).toBeTypeOf('function')
  })
})

describe('through the client, as live (person mode): resend receipt check, then the hive revokes the grant (sim, invented)', () => {
  it('identical resend returns the original receipt; after grant revocation read, list and decide are refused before the service', async () => {
    const client = new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1, codeMode: 'person' })
    const opened = await client.codeOpen('repo:sim-suggestions')
    const ctx = { task_id: opened.task_id, grant_id: opened.grant_id, repository_id: opened.repository_id }
    expect(ctx).toEqual({ task_id: 'g_simcode01', grant_id: 'grant_simcode01', repository_id: 'sim-suggestions' })
    const ws = (await client.codeProxy<Ws>('POST', '/v1/workspaces', ctx, {}))
    const scope = parseScopeRecord(await client.codeSuggestionScope(ctx, WS, { operation_id: 's', expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: { 'calculator.py': [[4, 7], [28, 29]] } }), WS)
    const hunks = await personHunks([{ path: 'calculator.py', start_byte: 4, end_byte: 7, lines: 'line 1', text: 'add' }, { path: 'calculator.py', start_byte: 28, end_byte: 29, lines: 'line 2', text: '-' }], { 'calculator.py:4-7': 'plus', 'calculator.py:28-29': '+' })
    const create = createRequest(scope.id, hunks, 'c1')
    const rec = parseCreateRecord(await client.codeSuggestionCreate(ctx, WS, create), { workspace_id: WS, scope_id: scope.id })
    const read = parseSuggestionRead(await client.codeSuggestionRead(ctx, WS, rec.id))
    const minus = read.content.hunks.find((h) => h.start_byte === 28)!
    const decide = decisionRequest(read, { [minus.id]: 'accept' }, 'd1')
    const first = parseDecisionResult(await client.codeSuggestionDecide(ctx, WS, decide), decide)
    const again = parseDecisionResult(await client.codeSuggestionDecide(ctx, WS, decide), decide)
    expect(receiptCheck(receiptOf(first), again)).toBeNull()
    expect(again.workspace.generation).toBe(first.workspace.generation)

    // a second, open proposal on the new generation, staged but not yet recorded
    const ws2 = await client.codeProxy<Ws>('GET', `/v1/workspaces/${WS}`, ctx)
    const scope2 = parseScopeRecord(await client.codeSuggestionScope(ctx, WS, { operation_id: 's2', expected_generation: ws2.generation, expected_tree_digest: ws2.tree_digest, ranges: { 'calculator.py': [[4, 7]] } }), WS)
    const rec2 = parseCreateRecord(await client.codeSuggestionCreate(ctx, WS, createRequest(scope2.id, await personHunks([{ path: 'calculator.py', start_byte: 4, end_byte: 7, lines: 'line 1', text: 'add' }], { 'calculator.py:4-7': 'plus' }), 'c2')), { workspace_id: WS, scope_id: scope2.id })
    const read2 = parseSuggestionRead(await client.codeSuggestionRead(ctx, WS, rec2.id))
    const decide2 = decisionRequest(read2, { [read2.content.hunks[0].id]: 'accept' }, 'd2')

    await client.codeSimFixture('revoke-grant')
    for (const call of [() => client.codeSuggestionRead(ctx, WS, rec2.id), () => client.codeSuggestionHistory(ctx, WS), () => client.codeSuggestionDecide(ctx, WS, decide2)]) {
      const e = await call().catch((x) => x)
      expect(e).toMatchObject({ status: 403, code: 'grant_invalid' })
      expect(describeFailure(e).kind).toBe('revoked')
    }
  })
})
