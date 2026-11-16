import { describe, expect, it } from 'vitest'
import { SimCodeService } from '../../../api/sim/codeService'
import { parseSuggestionRead, verifyIntegrity } from '../suggestions/contract'
import { featuresOf, groupsProblem } from './features'
import { summarize } from './vibe'

// Codex owner rulings, CODE_CANVAS_P1_OWNER_DECISIONS_20261006.md §1 and §4
describe('the loaded service capabilities gate plain summaries and dependent groups', () => {
  it('reads the features list from GET /v1/capabilities, and nothing from anything else', () => {
    expect(featuresOf({ service: 'omegacode', features: ['search', 'dependent-suggestion-groups'] })).toEqual(new Set(['search', 'dependent-suggestion-groups']))
    expect(featuresOf({ features: 'search' })).toEqual(new Set())
    expect(featuresOf(null)).toEqual(new Set())
    expect(featuresOf({ features: ['ok', 7, ''] })).toEqual(new Set(['ok']))
  })
  it('refuses to decide a grouped proposal when the loaded service does not declare dependent-suggestion-groups (never synthesised, never ignored)', () => {
    expect(groupsProblem([['a', 'b']], { status: 'ready', features: new Set() })).toMatch(/does not say it supports/)
    expect(groupsProblem([['a', 'b']], { status: 'ready', features: new Set(['dependent-suggestion-groups']) })).toBeNull()
    expect(groupsProblem(undefined, { status: 'ready', features: new Set() })).toBeNull()
  })
  it('shows the author’s plain what/why only when proposal-plain-summary is loaded, as the author’s words; otherwise the honest absent wording', () => {
    const base = { instruction: 'make it add', mind: 'Anvil', path: 'calc.py', changes: [{ line: 2, lastLine: 2, words: 'now adds' }], together: [] }
    const plain = { what: 'Makes add return the sum.', why: 'It subtracted.' }
    const on = summarize({ ...base, plain, canCarry: true })
    expect(on.why).toBe('Anvil says: Makes add return the sum. It subtracted. (The author’s explanation, not a check.)')
    expect(summarize({ ...base, plain, canCarry: false }).why).toContain('gave no reason of its own (this service’s proposals cannot carry one yet)')
    expect(summarize({ ...base, plain: null, canCarry: true }).why).toBe('You asked: “make it add”. Anvil gave no reason with this proposal.')
  })
})

describe('plain_summary in the retained proposal', () => {
  it('is parsed strictly when present and is covered by the record digest', async () => {
    const ws = 'ws_or01'
    const s = new SimCodeService({ workspace_id: ws })
    const head = (await s.proxy('GET', `/v1/workspaces/${ws}`, {}, null)) as { generation: number; tree_digest: string }
    const cap = (await s.proxy('GET', '/v1/capabilities', {}, null)) as { features: string[] }
    expect(cap.features).toEqual(expect.arrayContaining(['dependent-suggestion-groups', 'proposal-plain-summary']))
    const scope = (await s.proxy('POST', `/v1/workspaces/${ws}/suggestion-scopes`, {}, { operation_id: 'sc', expected_generation: head.generation, expected_tree_digest: head.tree_digest, ranges: { 'calculator.py': [[0, 31]] } })) as { id: string }
    const rec = (await s.ask(ws, scope.id, 'make add actually add')) as { id: string }
    const raw = (await s.proxy('GET', `/v1/workspaces/${ws}/suggestions/${rec.id}`, {}, null)) as { content: Record<string, unknown> }
    const read = parseSuggestionRead(raw)
    expect(read.content.plain_summary?.what).toMatch(/\w/)
    expect((await verifyIntegrity(read)).ok).toBe(true)
    const tampered = structuredClone(raw) as { content: { plain_summary: { why: string } } }
    tampered.content.plain_summary.why = 'something else'
    expect((await verifyIntegrity(parseSuggestionRead(tampered))).ok).toBe(false)
    expect(() => parseSuggestionRead({ ...raw, content: { ...raw.content, plain_summary: { what: 'x' } } })).toThrow()
    expect(() => parseSuggestionRead({ ...raw, content: { ...raw.content, plain_summary: { what: 'x', why: 'y', score: 1 } } })).toThrow()
  })
})
