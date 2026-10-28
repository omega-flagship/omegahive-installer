import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../api/client'
import { accepts, ARM_MS, bindTo } from '../../../lib/decisionGate'
import { canonical, ContractError, hunkIdentityBody, isWorkbenchRoute, normalizedBody, parseDecisionResult, parseHistoryPage, parseSuggestionRead, sha256Text, verifyIntegrity, WORKBENCH_RELAYED_ROUTES, type SuggestionBinding, type SuggestionContent, type SuggestionRead } from './contract'
import { addRange, authoredMismatch, authoredProblem, authorLabel, createRequest, decisionRequest, describeFailure, diffRows, dirtyConflict, groupsOf, hunkStates, leftBehind, lineSpan, mergeHistory, personHunks, proposalSummary, rangeKey, receiptCheck, retryRequest, scopeRanges, stage, stagedProblem, type PickedRange } from './model'

const H = (c: string) => c.repeat(64)
const binding: SuggestionBinding = { workspace_id: 'ws_a', task_id: 'g_a', generation: 3, tree_digest: H('a') }

/** Build a read exactly as the service retains it (ids and digests derived with the service's canonical JSON). */
async function fixture(opts: { groups?: number[][]; currency?: 'current' | 'stale'; decisions?: SuggestionRead['decisions'] } = {}): Promise<SuggestionRead> {
  const raw = [
    { path: 'src/a.py', start_byte: 0, end_byte: 5, replacement: 'ALPHA', before_digest: H('1'), expected_file_digest: H('f') },
    { path: 'src/a.py', start_byte: 10, end_byte: 12, replacement: 'β', before_digest: H('2'), expected_file_digest: H('f') },
    { path: 'src/a.py', start_byte: 20, end_byte: 20, replacement: '# 😀', before_digest: H('3'), expected_file_digest: H('f') },
  ]
  const hunks = await Promise.all(raw.map(async (h) => ({ ...h, id: await sha256Text(canonical(hunkIdentityBody(binding, h))) })))
  const content = { schema: 'omegacode-scoped-suggestion-v1', binding, scope: { 'src/a.py': [[0, 40]] }, hunks, digest: '', scope_id: 'scope_1', author: 'agent:a_x' } as unknown as SuggestionContent
  if (opts.groups) content.hunk_groups = opts.groups.map((g) => g.map((i) => hunks[i].id))
  content.digest = await sha256Text(canonical(normalizedBody(content)))
  const digest = await sha256Text(canonical(content))
  return { record: { id: 'suggestion_1', workspace_id: 'ws_a', scope_id: 'scope_1', digest, author: 'agent:a_x', created_at: 1 }, content, decisions: opts.decisions ?? [], currency: opts.currency ?? 'current' }
}

describe('contract parsing and validation', () => {
  it('accepts the exact implemented shape and verifies digests and hunk identities in the browser', async () => {
    const r = await fixture()
    expect(parseSuggestionRead(JSON.parse(JSON.stringify(r)), { workspace_id: 'ws_a', suggestion_id: 'suggestion_1' })).toEqual(r)
    expect(await verifyIntegrity(r)).toEqual({ ok: true, problems: [] })
  })

  it('refuses illustrative / caller-asserted fields, a foreign workspace and the wrong schema', async () => {
    const r = await fixture()
    const withStatus = { ...r, content: { ...r.content, status: 'applied', rationale: 'x' } }
    expect(() => parseSuggestionRead(withStatus)).toThrow(ContractError)
    try {
      parseSuggestionRead(withStatus)
    } catch (e) {
      expect((e as ContractError).problems).toEqual(expect.arrayContaining(['content.status is not a contract field', 'content.rationale is not a contract field']))
    }
    expect(() => parseSuggestionRead(r, { workspace_id: 'ws_other' })).toThrow(/another workspace/)
    expect(() => parseSuggestionRead({ ...r, content: { ...r.content, schema: 'omegacode-suggestion-v1' } })).toThrow(/schema/)
    expect(() => parseSuggestionRead({ ...r, currency: 'applied' })).toThrow(/currency/)
    const outside = { ...r, content: { ...r.content, hunks: [{ ...r.content.hunks[0], end_byte: 99 }] } }
    expect(() => parseSuggestionRead(outside)).toThrow(/outside the retained scope/)
  })

  it('refuses decisions that bind another digest, unknown hunks, double decisions or accepts without a ChangeSet', async () => {
    const r = await fixture()
    const d = { id: 'decision_1', suggestion_id: 'suggestion_1', suggestion_digest: r.record.digest, workspace_id: 'ws_a', actor: 'user:you', accepted_hunk_ids: [r.content.hunks[0].id], rejected_hunk_ids: [], change_id: 'cs_1', created_at: 2 }
    expect(parseSuggestionRead({ ...r, decisions: [d] }).decisions).toHaveLength(1)
    expect(() => parseSuggestionRead({ ...r, decisions: [{ ...d, suggestion_digest: r.content.digest }] })).toThrow(/binds another proposal or digest/)
    expect(() => parseSuggestionRead({ ...r, decisions: [{ ...d, accepted_hunk_ids: [H('9')] }] })).toThrow(/unknown hunk/)
    expect(() => parseSuggestionRead({ ...r, decisions: [d, { ...d, id: 'decision_2' }] })).toThrow(/decided twice/)
    expect(() => parseSuggestionRead({ ...r, decisions: [{ ...d, change_id: null }] })).toThrow(/without a ChangeSet/)
  })

  it('detects tampering: a changed replacement breaks the hunk id, digests and record digest', async () => {
    const r = await fixture()
    const tampered = structuredClone(r)
    tampered.content.hunks[1].replacement = 'evil'
    const check = await verifyIntegrity(tampered)
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toMatch(/identity does not match/)
    expect(check.problems.join(' ')).toMatch(/record digest/)
  })

  it('canonical JSON matches Python json.dumps(sort_keys, compact, ensure_ascii=False)', () => {
    expect(canonical({ b: 1, a: ['Ω', '😀', 'x\ny'], 'é': null })).toBe('{"a":["Ω","😀","x\\ny"],"b":1,"é":null}')
    // code point order, not UTF-16 order: U+FF5E sorts before U+1F600
    expect(canonical({ '😀': 1, '～': 2 })).toBe('{"～":2,"😀":1}')
  })

  it('parses a history page bound to this workspace only', () => {
    const page = { workspace_id: 'ws_a', generation: 3, tree_digest: H('a'), next_cursor: null, items: [{ id: 'suggestion_1', workspace_id: 'ws_a', scope_id: 'scope_1', digest: H('d'), author: 'agent:x', created_at: 1, generation: 3, tree_digest: H('a'), currency: 'current', hunk_count: 2, accepted_count: 0, rejected_count: 0 }] }
    expect(parseHistoryPage(page, 'ws_a').items).toHaveLength(1)
    expect(() => parseHistoryPage(page, 'ws_b')).toThrow(/another workspace/)
    expect(() => parseHistoryPage({ ...page, items: [{ ...page.items[0], status: 'applied' }] }, 'ws_a')).toThrow(/not a contract field/)
  })
})

describe('binding: digest, original hunk IDs, exact generation/tree', () => {
  it('the decision binds record.digest (not the inner digest), the retained generation/tree and original IDs in order', async () => {
    const r = await fixture()
    const req = decisionRequest(r, { [r.content.hunks[2].id]: 'reject', [r.content.hunks[0].id]: 'accept' }, 'op-1')
    expect(req).toEqual({
      operation_id: 'op-1',
      suggestion_id: 'suggestion_1',
      suggestion_digest: r.record.digest,
      expected_generation: 3,
      expected_tree_digest: binding.tree_digest,
      accepted_hunk_ids: [r.content.hunks[0].id],
      rejected_hunk_ids: [r.content.hunks[2].id],
    })
    expect(req.suggestion_digest).not.toBe(r.content.digest)
  })

  it('a decision answer must answer exactly what was sent, with a ChangeSet from the bound generation/tree', async () => {
    const r = await fixture()
    const sent = decisionRequest(r, { [r.content.hunks[0].id]: 'accept' }, 'op-1')
    const decision = { id: 'decision_1', suggestion_id: sent.suggestion_id, suggestion_digest: sent.suggestion_digest, workspace_id: 'ws_a', actor: 'user:you', accepted_hunk_ids: sent.accepted_hunk_ids, rejected_hunk_ids: [], change_id: 'cs_1', created_at: 2 }
    const change = { id: 'cs_1', workspace_id: 'ws_a', task_id: 'g_a', author: 'user:you', base_commit: 'c', before_digest: binding.tree_digest, tree_digest: H('b'), generation: 4, paths: ['src/a.py'], created_at: 2, diff_digest: H('c') }
    const ok = { workspace: { id: 'ws_a', generation: 4, tree_digest: H('b'), base_commit: 'c' }, change, decision }
    expect(parseDecisionResult(ok, sent).change?.id).toBe('cs_1')
    expect(() => parseDecisionResult({ ...ok, change: { ...change, generation: 9 } }, sent)).toThrow(/bound generation/)
    expect(() => parseDecisionResult({ ...ok, change: undefined }, sent)).toThrow(/no ChangeSet/)
    expect(() => parseDecisionResult({ ...ok, decision: { ...decision, accepted_hunk_ids: [r.content.hunks[1].id] } }, sent)).toThrow(/other hunks/)
  })

  it('retry resends the identical payload under the same operation ID', async () => {
    const r = await fixture()
    const request = decisionRequest(r, { [r.content.hunks[0].id]: 'accept' }, 'op-7')
    const again = retryRequest({ request, unknown: 'lost' })
    expect(again).toEqual(request)
    expect(again).not.toBe(request)
  })
})

describe('hunk state, dependent groups and the stale remainder', () => {
  it('derives per-hunk state from decisions and currency; never a whole-proposal "applied"', async () => {
    const r0 = await fixture()
    const d = { id: 'decision_1', suggestion_id: 'suggestion_1', suggestion_digest: r0.record.digest, workspace_id: 'ws_a', actor: 'user:you', accepted_hunk_ids: [r0.content.hunks[0].id], rejected_hunk_ids: [], change_id: 'cs_1', created_at: 2 }
    const r = { ...r0, decisions: [d], currency: 'stale' as const }
    const s = hunkStates(r)
    expect(s.get(r.content.hunks[0].id)?.kind).toBe('accepted')
    expect(s.get(r.content.hunks[1].id)?.kind).toBe('stale')
    expect(proposalSummary(r)).toBe('1 accepted · 2 stale (source changed; cannot be decided)')
    expect(stage(r, {}, r.content.hunks[1].id, 'accept').refused).toMatch(/stale/)
    expect(stagedProblem(r, { [r.content.hunks[1].id]: 'reject' })).toMatch(/source changed/)
  })

  it('dependent groups stage together and can never be split', async () => {
    const r = await fixture({ groups: [[1, 2]] })
    const [a, b, c] = r.content.hunks.map((h) => h.id)
    expect(groupsOf(r).get(b)).toEqual([b, c])
    const s1 = stage(r, {}, b, 'accept').staged
    expect(s1).toEqual({ [b]: 'accept', [c]: 'accept' })
    expect(stage(r, s1, c, null).staged).toEqual({})
    expect(stagedProblem(r, { [b]: 'accept', [c]: 'reject' })).toMatch(/together/)
    expect(() => decisionRequest(r, { [b]: 'accept' }, 'op')).toThrow(/together/)
    expect(stagedProblem(r, { [a]: 'accept' })).toBeNull()
    // a group with a decided member refuses staging the rest
    const decided = { ...r, decisions: [{ id: 'd', suggestion_id: 'suggestion_1', suggestion_digest: r.record.digest, workspace_id: 'ws_a', actor: 'user:you', accepted_hunk_ids: [], rejected_hunk_ids: [a], change_id: null, created_at: 2 }] }
    expect(stage(decided, {}, a, 'accept').refused).toMatch(/already decided/)
  })

  it('names what an acceptance leaves behind (it becomes stale)', async () => {
    const r = await fixture()
    expect(leftBehind(r, { [r.content.hunks[0].id]: 'accept' }).map((h) => h.id)).toEqual([r.content.hunks[1].id, r.content.hunks[2].id])
  })
})

describe('dirty buffers are never overwritten', () => {
  it('refuses accepting into a file with unsaved edits; rejection and other files are allowed', async () => {
    const r = await fixture()
    const id = r.content.hunks[0].id
    expect(dirtyConflict(r, { [id]: 'accept' }, { path: 'src/a.py', dirty: true })).toMatch(/unsaved edits/)
    expect(dirtyConflict(r, { [id]: 'reject' }, { path: 'src/a.py', dirty: true })).toBeNull()
    expect(dirtyConflict(r, { [id]: 'accept' }, { path: 'README.md', dirty: true })).toBeNull()
    expect(dirtyConflict(r, { [id]: 'accept' }, { path: 'src/a.py', dirty: false })).toBeNull()
  })
})

describe('failures in plain words', () => {
  it('classifies relayed service errors; only an unanswered decision is retryable', () => {
    expect(describeFailure(new ApiError(404, 'not_relayed', 'x')).kind).toBe('unavailable')
    expect(describeFailure(new ApiError(409, 'stale_workspace', 'x')).kind).toBe('stale')
    expect(describeFailure(new ApiError(409, 'suggestion_stale', 'x')).kind).toBe('stale')
    expect(describeFailure(new ApiError(409, 'suggestion_decided', 'x')).kind).toBe('decided')
    expect(describeFailure(new ApiError(409, 'operation_conflict', 'x')).kind).toBe('conflict')
    expect(describeFailure(new ApiError(401, 'invalid_capability', 'x')).kind).toBe('revoked')
    expect(describeFailure(new ApiError(403, 'grant_invalid', 'x')).kind).toBe('revoked')
    expect(describeFailure(new ApiError(429, 'suggestion_budget', 'x')).kind).toBe('limit')
    expect(describeFailure(new ApiError(502, 'service_unreachable', 'x')).kind).toBe('unknown')
    expect(describeFailure(new ApiError(0, 'network', 'x')).kind).toBe('unknown')
    expect(describeFailure(new ContractError('The proposal', ['x'])).kind).toBe('contract')
    expect(describeFailure(new ApiError(400, 'suggestion_decision', 'x')).kind).toBe('refused')
  })
})

describe('decision gate (reused from lib/decisionGate)', () => {
  it('a held key or an activation inside the arming window is not a decision; a changed proposal unbinds', () => {
    expect(accepts({ repeat: true, at: 10_000 }, 0)).toBe(false)
    expect(accepts({ at: ARM_MS - 1 }, 0)).toBe(false)
    expect(accepts({ at: ARM_MS }, 0)).toBe(true)
    const seen = { digest: 'd1', generation: 3, tree: 't', currency: 'current' }
    const fields = ['digest', 'generation', 'tree', 'currency'] as const
    expect(bindTo(seen, { ...seen }, fields).kind).toBe('ready')
    expect(bindTo(seen, { ...seen, currency: 'stale' }, fields)).toEqual({ kind: 'changed', fields: ['currency'] })
    expect(bindTo(seen, seen, fields, () => 'src/a.py has unsaved edits.').kind).toBe('closed')
  })
})

describe('display helpers', () => {
  it('line spans and side-by-side rows', () => {
    const text = 'a\nbb\nccc\n'
    expect(lineSpan(text, 2, 4)).toEqual({ first: 2, last: 2 })
    expect(lineSpan(text, 2, 9)).toEqual({ first: 2, last: 3 })
    expect(diffRows('bb\nccc', 'B', 2)).toEqual([{ left: { n: 2, text: 'bb' }, right: { n: 2, text: 'B' } }, { left: { n: 3, text: 'ccc' }, right: null }])
    expect(diffRows('', 'x', 5, '  ', '()')).toEqual([{ left: { n: 5, text: '  ()' }, right: { n: 5, text: '  x()' } }])
  })

  it('merges refreshed pages by ID, newest first', () => {
    const it0 = { id: 'a', workspace_id: 'w', scope_id: 's', digest: H('d'), author: 'x', created_at: 1, generation: 1, tree_digest: H('a'), currency: 'current' as const, hunk_count: 1, accepted_count: 0, rejected_count: 0 }
    const merged = mergeHistory([it0], [{ ...it0, currency: 'stale' }, { ...it0, id: 'b', created_at: 2 }])
    expect(merged.map((i) => [i.id, i.currency])).toEqual([['b', 'current'], ['a', 'stale']])
  })
})

describe('person-authored suggestions (model)', () => {
  const r = (path: string, a: number, z: number, text: string): PickedRange => ({ path, start_byte: a, end_byte: z, lines: 'line 1', text })

  it('assembles a scope from picked ranges in byte order and refuses empty, duplicate and overlapping ranges', () => {
    let ranges: PickedRange[] = []
    ranges = addRange(ranges, r('calculator.py', 28, 29, '-')).ranges
    ranges = addRange(ranges, r('calculator.py', 4, 7, 'add')).ranges
    expect(ranges.map((x) => [x.start_byte, x.end_byte])).toEqual([[4, 7], [28, 29]])
    expect(scopeRanges(ranges)).toEqual({ 'calculator.py': [[4, 7], [28, 29]] })
    expect(addRange(ranges, r('calculator.py', 4, 7, 'add')).refused).toMatch(/already/)
    expect(addRange(ranges, r('calculator.py', 6, 9, 'd(a')).refused).toMatch(/overlaps/)
    expect(addRange(ranges, r('calculator.py', 9, 9, '')).refused).toMatch(/at least one character/)
    // touching ranges are separate ranges, and another file is fine
    expect(addRange(ranges, r('calculator.py', 7, 8, '(')).refused).toBeUndefined()
    expect(scopeRanges(addRange(ranges, r('README.md', 0, 1, '#')).ranges)).toEqual({ 'README.md': [[0, 1]], 'calculator.py': [[4, 7], [28, 29]] })
  })

  it('writes one closed hunk per changed range, before_digest = sha256 of the replaced UTF-8 bytes', async () => {
    const ranges = [r('calculator.py', 4, 7, 'add'), r('calculator.py', 28, 29, '-'), r('src/units.py', 10, 14, 'Ωx')]
    const drafts = { [rangeKey(ranges[0])]: 'plus', [rangeKey(ranges[1])]: '+', [rangeKey(ranges[2])]: 'Ωx' }
    const hunks = await personHunks(ranges, drafts)
    expect(hunks).toEqual([
      { path: 'calculator.py', start_byte: 4, end_byte: 7, replacement: 'plus', before_digest: await sha256Text('add') },
      { path: 'calculator.py', start_byte: 28, end_byte: 29, replacement: '+', before_digest: await sha256Text('-') },
    ]) // the unchanged multi-byte range is not filed
    expect(await sha256Text('-')).toBe('3973e022e93220f9212c18d0d0c543ae7c309e46640da93a4a0314de999f5112')
    const req = createRequest('scope_1', hunks, 'suggest-1')
    expect(Object.keys(req).sort()).toEqual(['hunks', 'operation_id', 'scope_id']) // no author/model/harness: derived by the service
    expect(req.hunks.every((h) => Object.keys(h).sort().join() === 'before_digest,end_byte,path,replacement,start_byte')).toBe(true)
    expect(() => createRequest('scope_1', [], 'x')).toThrow(/at least one/)
  })

  it('says why drafts cannot be filed', () => {
    const ranges = [r('calculator.py', 4, 7, 'add')]
    expect(authoredProblem([], {})).toMatch(/scope first/)
    expect(authoredProblem(ranges, { [rangeKey(ranges[0])]: 'add' })).toMatch(/at least one range/)
    expect(authoredProblem(ranges, { [rangeKey(ranges[0])]: 'plus' })).toBeNull()
  })

  it('checks the retained proposal is exactly what the person wrote', async () => {
    const read = await fixture()
    const sent = { operation_id: 'o', scope_id: 'scope_1', hunks: read.content.hunks.map(({ path, start_byte, end_byte, replacement, before_digest }) => ({ path, start_byte, end_byte, replacement, before_digest })) }
    expect(authoredMismatch(read, sent)).toEqual([])
    expect(authoredMismatch(read, { ...sent, hunks: [{ ...sent.hunks[0], replacement: 'other' }, ...sent.hunks.slice(1)] })).toEqual([expect.stringMatching(/not retained as written/)])
    expect(authoredMismatch(read, { ...sent, hunks: sent.hunks.slice(1) })).toEqual([expect.stringMatching(/3 hunks were retained for 2 written/)])
    expect(authoredMismatch(read, { ...sent, scope_id: 'scope_2' })).toEqual(['the proposal binds another scope'])
  })

  it('names the author as the capability actor only', () => {
    expect(authorLabel('user:operator')).toBe('person operator')
    expect(authorLabel('agent:a_x')).toBe('mind a_x')
    expect(authorLabel('svc:other')).toBe('svc:other')
  })

  it('decides availability from the real answer, with accurate wording', () => {
    const notRelayed = describeFailure(new ApiError(404, 'not_relayed', 'POST /v1/workspaces/ws_a/suggestions is not available through the hive'))
    expect(notRelayed).toEqual({ kind: 'unavailable', text: expect.stringContaining('does not relay this suggestion route') })
    expect(notRelayed.text).toContain('404 not_relayed: POST /v1/workspaces/ws_a/suggestions')
    expect(notRelayed.text).not.toMatch(/\b0 of\b|\b13\b/)
    expect(describeFailure(new ApiError(503, 'service_unavailable', 'x')).kind).toBe('unavailable')
    // relayed, but the loaded release has no such route: FastAPI's bare 404
    expect(describeFailure(new ApiError(404, 'http_404', 'Not Found', { source: 'omegacode', upstreamStatus: 404 })).text).toMatch(/release it reaches does not answer/)
    // a contract 404 (unknown proposal) is a refusal, not "unavailable"
    expect(describeFailure(new ApiError(404, 'not_found', 'proposal not found', { source: 'omegacode', upstreamStatus: 404 })).kind).toBe('refused')
  })

  it('every call the panel makes is a route the live host relays (60fa650), and nothing it calls is a held run-result route', () => {
    const ws = 'ws_simsuggest01'
    const calls: [string, string][] = [
      ['POST', `/v1/workspaces/${ws}/suggestion-scopes`],
      ['POST', `/v1/workspaces/${ws}/suggestions`],
      ['GET', `/v1/workspaces/${ws}/suggestions`],
      ['GET', `/v1/workspaces/${ws}/suggestions/suggestion_0123abcd`],
      ['POST', `/v1/workspaces/${ws}/suggestion-decisions`],
    ]
    for (const [m, p] of calls) expect(isWorkbenchRoute(m, p), `${m} ${p}`).toBe(true)
    expect(WORKBENCH_RELAYED_ROUTES).toHaveLength(9)
    for (const [m, p] of [['POST', '/v1/runs/run_1/results'], ['GET', `/v1/workspaces/${ws}/run-results/rr_1`], ['POST', `/v1/workspaces/${ws}/run-results/rr_1/import`]]) expect(isWorkbenchRoute(m, p)).toBe(false)
    expect(isWorkbenchRoute('GET', `/v1/workspaces/${ws}/suggestion-scopes`)).toBe(false) // method matters
  })
})

describe('receipt check for an identical resend', () => {
  it('passes only when the original decision and ChangeSet come back', () => {
    const original = { decision_id: 'decision_1', change_id: 'cs_1', generation: 4 }
    const answer = (decision: string, change: string | null) => ({ workspace: { id: 'ws_a', generation: 4, tree_digest: H('b'), base_commit: 'c' }, decision: { id: decision } as never, ...(change ? { change: { id: change } as never } : {}) })
    expect(receiptCheck(original, answer('decision_1', 'cs_1'))).toBeNull()
    expect(receiptCheck(original, answer('decision_2', 'cs_2'))).toMatch(/decision decision_2 instead of decision_1; ChangeSet cs_2 instead of cs_1/)
    expect(receiptCheck({ ...original, change_id: null }, answer('decision_1', null))).toBeNull()
  })
})
