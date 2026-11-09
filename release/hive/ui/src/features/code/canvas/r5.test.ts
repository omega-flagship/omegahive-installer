/**
 * r5: Codex's summary-contract correction (surface-summary-contract-r1.patch): the
 * plain_summary parser limit is 2000 Unicode code points (not UTF-16 units), nonblank, without forbidden controls,
 * at most 8192 canonical UTF-8 bytes; and plain_summary is covered by the inner normalised digest too.
 */
import { describe, expect, it } from 'vitest'
import { SimCodeService } from '../../../api/sim/codeService'
import { canonical, parseSuggestionRead, sha256Text, verifyIntegrity } from '../suggestions/contract'

const WS = 'ws_r5'
async function proposal() {
  const svc = new SimCodeService({ workspace_id: WS })
  const h = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as { generation: number; tree_digest: string }
  const scope = (await svc.proxy('POST', `/v1/workspaces/${WS}/suggestion-scopes`, {}, { operation_id: 'sc', expected_generation: h.generation, expected_tree_digest: h.tree_digest, ranges: { 'calculator.py': [[0, 31]] } })) as { id: string }
  const rec = (await svc.ask(WS, scope.id, 'make add actually add')) as { id: string }
  return (await svc.proxy('GET', `/v1/workspaces/${WS}/suggestions/${rec.id}`, {}, null)) as { record: { digest: string }; content: Record<string, unknown> & { plain_summary: { what: string; why: string } } }
}
const withSummary = (raw: Awaited<ReturnType<typeof proposal>>, ps: unknown) => ({ ...raw, content: { ...raw.content, plain_summary: ps } })

describe('plain_summary: the corrected parser limit', () => {
  it('counts Unicode code points, not UTF-16 units: 1500 emoji (3000 units) is within 2000', async () => {
    const raw = await proposal()
    expect(() => parseSuggestionRead(withSummary(raw, { what: '👋'.repeat(1500), why: 'ok' }))).not.toThrow()
    expect(() => parseSuggestionRead(withSummary(raw, { what: 'a'.repeat(2001), why: 'ok' }))).toThrow(/2000 Unicode code points/)
  })
  it('refuses blank text, forbidden controls, and more than 8192 canonical UTF-8 bytes', async () => {
    const raw = await proposal()
    expect(() => parseSuggestionRead(withSummary(raw, { what: '   ', why: 'ok' }))).toThrow()
    expect(() => parseSuggestionRead(withSummary(raw, { what: 'a\u0007b', why: 'ok' }))).toThrow()
    expect(() => parseSuggestionRead(withSummary(raw, { what: 'line one\nline two\tok', why: 'ok' }))).not.toThrow()
    expect(() => parseSuggestionRead(withSummary(raw, { what: '👋'.repeat(1990), why: '👋'.repeat(1990) }))).toThrow(/8192/)
  })
})

describe('plain_summary: covered by the inner normalised digest', () => {
  it('the simulator’s proposal verifies with the summary in both digests', async () => {
    const raw = await proposal()
    expect(raw.content.plain_summary.what).toMatch(/\w/)
    expect((await verifyIntegrity(parseSuggestionRead(raw))).ok).toBe(true)
  })
  it('a summary changed after the fact fails integrity even when the record digest is recomputed to match', async () => {
    const raw = await proposal()
    const content = { ...raw.content, plain_summary: { what: raw.content.plain_summary.what, why: 'a different reason' } }
    const forged = { ...raw, record: { ...raw.record, digest: await sha256Text(canonical(content)) }, content }
    const check = await verifyIntegrity(parseSuggestionRead(forged))
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toMatch(/normalized proposal digest/)
  })
})
