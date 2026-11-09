import { describe, expect, it, vi } from 'vitest'
import { captureDigest, exactEvidenceCursor, parseProjectTestEvidence, projectTestEvidenceRequest, ProjectTestEvidenceReader, type EvidenceState } from './projectTestEvidence'
import { deferred, emptyEvidencePage, evidencePage, evidencePageWithRetainedHold, evidenceSubject } from './projectTestEvidence.testkit'

describe('read-only project-test evidence', () => {
  it('uses only the exact normal read route, limit4 and original decimal cursor', () => {
    expect(projectTestEvidenceRequest(evidenceSubject, '9007199254740993')).toEqual({ path: '/v1/workspaces/ws_a/suggestions/suggestion_a/project-tests', query: { limit: '4', cursor: '9007199254740993' } })
    expect(exactEvidenceCursor('9223372036854775807')).toBe('9223372036854775807')
    for (const value of ['01', '-1', '9223372036854775808', '1e3', 1]) expect(() => exactEvidenceCursor(value)).toThrow()
  })
  it('verifies original capture bytes and retains the original receipt locator', async () => {
    const parsed = await parseProjectTestEvidence(await evidencePage(), evidenceSubject)
    expect(parsed.results[0].tested).toBe(true)
    expect(parsed.results[0].logs[0].text).toBe('original assertion output\n')
    expect(parsed.results[0].receipt_digest).toBe('sha256:' + 'a'.repeat(64))
  })
  it('refuses a foreign workspace, proposal, proposal digest or response association', async () => {
    for (const change of ['workspace', 'proposal', 'digest', 'test', 'launch']) {
      const page = await evidencePage(), row = page.results[0]
      if (change === 'workspace') row.result.receipt.binding.parent.workspace_id = 'ws_foreign'
      if (change === 'proposal') row.result.receipt.binding.proposal.proposal_id = 'suggestion_foreign'
      if (change === 'digest') row.result.receipt.binding.proposal.proposal_digest = 'sha256:' + 'f'.repeat(64)
      if (change === 'test') row.result.test_id = 'pt_foreign'
      if (change === 'launch') row.result.launch_key = 'launch_foreign'
      await expect(parseProjectTestEvidence(page, evidenceSubject)).rejects.toThrow()
    }
  })
  it('never credits unknown, stale or a moved selected parent as current tested', async () => {
    for (const flag of ['unknown', 'stale']) {
      const page = await evidencePage(), row = page.results[0]
      row.execution_currency = flag; row.currency = flag; row.tested = false
      expect((await parseProjectTestEvidence(page, evidenceSubject)).results[0].tested).toBe(false)
    }
    const moved = { ...evidenceSubject, generation: 3, tree_digest: 'f'.repeat(64) }
    const row = (await parseProjectTestEvidence(await evidencePage(), moved)).results[0]
    expect(row.currency).toBe('stale'); expect(row.tested).toBe(false)
  })
  it('rejects contradictory tested flags, changed captures, malformed base64 and private response fields', async () => {
    for (const change of ['currency', 'bytes', 'base64', 'private']) {
      const page = await evidencePage(), row = page.results[0]
      if (change === 'currency') row.currency = 'unknown'
      if (change === 'bytes') row.result.captures.stdout = btoa('changed bytes')
      if (change === 'base64') row.result.captures.stdout += '\n'
      if (change === 'private') Object.assign(row, { snapshot_b64: 'forbidden' })
      await expect(parseProjectTestEvidence(page, evidenceSubject)).rejects.toThrow()
    }
  })
  it('bounds four rows and refuses repeated/nonadvancing cursors and duplicate records', async () => {
    const page = await evidencePage()
    await expect(parseProjectTestEvidence({ ...page, results: Array(5).fill(page.results[0]) }, evidenceSubject)).rejects.toThrow()
    await expect(parseProjectTestEvidence({ ...page, results: [page.results[0], page.results[0]] }, evidenceSubject)).rejects.toThrow()
    await expect(parseProjectTestEvidence({ ...page, next_cursor: '9007199254740993' }, evidenceSubject, '9007199254740993')).rejects.toThrow()
  })
  it('keeps incomplete logs historical/unknown and bounds verified previews without altering the byte digest', async () => {
    const page = await evidencePage(), row = page.results[0], bytes = new Uint8Array(32769).fill(65)
    const stream = row.result.receipt.streams.stdout
    row.tested = false; row.execution_currency = 'unknown'; row.currency = 'unknown'
    row.result.captures.stdout = btoa('A'.repeat(bytes.length))
    Object.assign(stream, { digest: await captureDigest(bytes), retained_bytes: bytes.length, observed_bytes: bytes.length + 1, complete: false, eof: false })
    const parsed = (await parseProjectTestEvidence(page, evidenceSubject)).results[0]
    expect(parsed.tested).toBe(false); expect(parsed.logs[0].text.length).toBe(32768)
    expect(parsed.logs[0].preview_truncated).toBe(true); expect(parsed.logs[0].bytes).toBe(32769)
  })
  it('uses the existing body/query convention and no write or dispatch call', async () => {
    const call = vi.fn(async () => emptyEvidencePage()), updates: EvidenceState[] = []
    const reader = new ProjectTestEvidenceReader(call, evidenceSubject, state => updates.push(state))
    await reader.load('9007199254740993')
    expect(call).toHaveBeenCalledExactlyOnceWith('GET', '/v1/workspaces/ws_a/suggestions/suggestion_a/project-tests', undefined, { limit: '4', cursor: '9007199254740993' })
    expect(updates.at(-1)?.page?.results).toEqual([]); reader.dispose()
  })
  it('ignores a superseded response and clears current evidence before a fresh read', async () => {
    const old = deferred<unknown>(), fresh = deferred<unknown>(), updates: EvidenceState[] = []
    let index = 0
    const reader = new ProjectTestEvidenceReader(() => (++index === 1 ? old.promise : fresh.promise), evidenceSubject, state => updates.push(state))
    const one = reader.load(), two = reader.load()
    expect(updates.at(-1)).toEqual({ pending: true, page: null, error: null })
    fresh.resolve(emptyEvidencePage()); await two
    const count = updates.length; old.resolve(await evidencePage()); await one
    expect(updates.length).toBe(count); expect(updates.at(-1)?.page?.results).toEqual([])
    reader.dispose()
  })
  it('ignores completion after unmount/disposal and never heals read errors using a cached page', async () => {
    const delayed = deferred<unknown>(), updates: EvidenceState[] = []
    const reader = new ProjectTestEvidenceReader(() => delayed.promise, evidenceSubject, state => updates.push(state))
    const pending = reader.load(); reader.dispose(); const count = updates.length
    delayed.resolve(await evidencePage()); await pending; expect(updates.length).toBe(count)
    const failed = new ProjectTestEvidenceReader(async () => { throw new Error('private raw failure') }, evidenceSubject, state => updates.push(state))
    await failed.load(); expect(updates.at(-1)?.page).toBeNull(); expect(updates.at(-1)?.error).not.toContain('private raw')
    failed.dispose()
  })
})

it('accepts the genuine-shaped pending202 hold_id without inferring a test or terminal result', async () => {
  const page = await evidencePage(), row = page.results[0]
  const start = { schema: 'omegacode-sandbox-dispatch/1', state: 'dispatch_unresolved', test_id: row.test_id, launch_key: row.launch_key,
    hold_id: row.result.hold_id, run_id: row.result.receipt.run_id, binding: row.result.receipt.binding, revision: 1 }
  const pending = { ...page, results: [{ ...row, execution_currency: 'unknown', currency: 'unknown', tested: false, result: start }] }
  const parsed = (await parseProjectTestEvidence(pending, evidenceSubject)).results[0]
  expect(parsed.tested).toBe(false); expect(parsed.outcome).toBe('unknown'); expect(parsed.receipt_digest).toBeNull(); expect(parsed.logs).toEqual([])
  await expect(parseProjectTestEvidence({ ...pending, results: [{ ...pending.results[0], result: { ...start, hold_id: 'not_a_hold' } }] }, evidenceSubject)).rejects.toThrow()
})
it('retains verified historical captures with original finish hold metadata when fresh Host evidence is unavailable', async () => {
  const page = await evidencePageWithRetainedHold(), parsed = (await parseProjectTestEvidence(page, evidenceSubject)).results[0]
  expect(parsed.currency).toBe('unknown'); expect(parsed.tested).toBe(false)
  expect(parsed.logs[0].text).toBe('original assertion output\n'); expect(parsed.receipt_digest).toBe(page.results[0].result.receipt.digest)
  const foreign = structuredClone(page); foreign.results[0].result.hold.hold.hold_id = 'ph_' + 'f'.repeat(24)
  await expect(parseProjectTestEvidence(foreign, evidenceSubject)).rejects.toThrow()
  const extra = structuredClone(page); Object.assign(extra.results[0].result.hold, { execution_authority: true })
  await expect(parseProjectTestEvidence(extra, evidenceSubject)).rejects.toThrow()
  const nested = structuredClone(page); Object.assign(nested.results[0].result.hold.observation.body, { token: 'forbidden' })
  await expect(parseProjectTestEvidence(nested, evidenceSubject)).rejects.toThrow()
})
