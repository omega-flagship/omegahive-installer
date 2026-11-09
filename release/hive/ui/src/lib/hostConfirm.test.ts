import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import { SimConfirmTokens } from '../api/sim/confirmTokens'
import type { ActionResult, ProgramActBody, ProgramDescription } from '../api/types'
import { base64Chunked, fileActBody } from './frameOps'
import {
  CONFIRM_AGAIN, CONFIRM_MISMATCH, confirmRefusal, PAYLOAD_TOO_LARGE, frameConfirmReply, frameReason, needsConfirm, payloadOf, personActivity, prepareConfirm, priorWords, recoveryOf,
  RECHECK, runConfirmed, runningWords, UNSUPPORTED_VALUE, type ConfirmIntent, type ConfirmOutcome,
} from './hostConfirm'

// §9d host confirm (Platform 1e23aa0 + Surface): the sim host follows the hive's rules (api/sim/confirmTokens.ts).
// INVENTED sim data only; nothing leaves the page.

function sim(session: 'person' | 'operator' = 'person') {
  const s = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  s.simSession = session
  s.programsHost.installInvented('ledger-fixture')
  return s
}
const describeOf = async (s: SimClient, id: string) => (await s.program(id)).describe as ProgramDescription
const note = (over: Partial<ProgramActBody> = {}): ProgramActBody => ({ swarm_id: 's_lyra', action: 'note', items: [], ...over })
const intentOf = (programId: string, body: ProgramActBody, d: ProgramDescription | null) => {
  const p = prepareConfirm(programId, body, d)
  if (!p.ok) throw new Error(p.message)
  return p.intent
}
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('which acts need the host confirm (describe passthrough)', () => {
  const d = { contract: '0.1', kinds: [], relations: [], actions: [
    { id: 'save', person_activity: true, confirm: true }, { id: 'send', confirm: true }, { id: 'plain', confirm: false }, { id: 'bare' },
  ] } as ProgramDescription
  it('person_activity or confirm: true; unknown (no describe, or not listed) confirms to be safe', () => {
    expect(needsConfirm(d, 'save')).toBe(true)
    expect(needsConfirm(d, 'send')).toBe(true)
    expect(needsConfirm(d, 'plain')).toBe(false)
    expect(needsConfirm(d, 'bare')).toBe(false)
    expect(needsConfirm(d, 'unknown')).toBe(true)
    expect(needsConfirm(null, 'anything')).toBe(true)
    expect(needsConfirm({ ...d, actions: [{ id: 'x', person_activity: true, confirm: false }] }, 'x')).toBe(true)   // no opt-out
    expect(personActivity(d, 'save')).toBe(true)
    expect(personActivity(null, 'save')).toBeNull()
  })
  it('the sim describe carries the effective confirm on every action, as GET /api/programs/{id}', async () => {
    const s = sim()
    const acts = Object.fromEntries((await describeOf(s, 'ledger-fixture')).actions.map((a) => [a.id, a.confirm]))
    expect(acts).toEqual({ attach: true, note: true })
    const fixture = Object.fromEntries((await describeOf(s, 'contract-fixture')).actions.map((a) => [a.id, a.confirm]))
    expect(fixture).toMatchObject({ challenge: true, compare: false, 'inspect-source': false })
  })
})

describe('prepare (before the dialog): nothing is called, unsupported values are refused, the token is never the frame’s', () => {
  it('no client call; a key per intent for person_activity or unknown; a frame-supplied token is dropped', () => {
    const d = { contract: '0.1', kinds: [], relations: [], actions: [{ id: 'save', person_activity: true }, { id: 'send', confirm: true }] } as ProgramDescription
    const p = prepareConfirm('app', { swarm_id: 's', action: 'save', items: ['i1'], confirm_token: 'hct_from_frame' } as ProgramActBody, d)
    expect(p.ok && p.intent.body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.ok && 'confirm_token' in p.intent.body).toBe(false)
    const q = prepareConfirm('app', { swarm_id: 's', action: 'send', items: [] }, d)
    expect(q.ok && q.intent.body.idempotency_key).toBeUndefined()   // strictly single use: no intent record
    expect(prepareConfirm('app', { swarm_id: 's', action: 'send', items: [], idempotency_key: 'frame-k' }, d)).toMatchObject({ ok: true, intent: { body: { idempotency_key: 'frame-k' } } })
  })
  it('decimals and numbers past 2^53−1 are refused with a plain sentence, before any mint', () => {
    for (const params of [{ amount: 1.5 }, { big: 2 ** 53 }, { nested: [{ x: 0.25 }] }])
      expect(prepareConfirm('app', { swarm_id: 's', action: 'send', items: [], params }, null)).toEqual({ ok: false, reason: 'invalid', message: UNSUPPORTED_VALUE })
  })
  it('a payload over 2 MiB (canonical, file bytes excluded) is refused before any mint; a large FILE is not counted', () => {
    expect(prepareConfirm('app', { swarm_id: 's', action: 'send', items: [], params: { s: 'x'.repeat(2 * 1024 * 1024) } }, null)).toEqual({ ok: false, reason: 'too-large', message: PAYLOAD_TOO_LARGE })
    const big = 'QUFB'.repeat(1024 * 1024)   // 4 MiB of base64: file bytes, not payload
    expect(prepareConfirm('app', { swarm_id: 's', action: 'attach', items: [], file: { name: 'a.txt', mime: 'text/plain', size: 3 * 1024 * 1024, content_base64: big } }, null).ok).toBe(true)
  })
})

describe('runConfirmed: mint only from the confirm, token at the top level, once', () => {
  it('mints once for exactly the payload sent, then acts with confirm_token at the top level (never in params)', async () => {
    const calls: string[] = []
    const client = {
      confirmAct: vi.fn<NonNullable<HiveClient['confirmAct']>>(async () => (calls.push('mint'), { confirm_token: 'hct_x', expires_at: '', expires_in: 120 })),
      programAct: vi.fn<HiveClient['programAct']>(async () => (calls.push('act'), { status: 'done' } as ActionResult)),
    }
    const intent = intentOf('app', { swarm_id: 's', action: 'send', items: ['i1'], params: { to: 'Zoë', n: 3 }, base_revision: 'r1' }, null)
    expect(client.confirmAct).not.toHaveBeenCalled()   // preparing (showing the dialog) mints nothing
    const o = await runConfirmed(client, intent)
    expect(o).toEqual({ kind: 'done', result: { status: 'done' } })
    expect(calls).toEqual(['mint', 'act'])
    const [, swarm, action, payload, digest] = client.confirmAct.mock.calls[0]
    expect([swarm, action]).toEqual(['s', 'send'])
    expect(payload).toEqual({ items: ['i1'], params: { to: 'Zoë', n: 3 }, base_revision: 'r1' })
    expect(digest).toBe((await payloadOf(intent.body)).digest)
    const sent = client.programAct.mock.calls[0][1]
    expect(sent.confirm_token).toBe('hct_x')
    expect(JSON.stringify(sent.params)).not.toContain('hct_')
  })

  it('end to end on the sim host: no token refused, a token works once, a spent token is refused for a non-person_activity act', async () => {
    const s = sim()
    const d = await describeOf(s, 'ledger-fixture')
    await expect(s.programAct('ledger-fixture', note())).rejects.toMatchObject({ status: 403, code: 'confirm_required' })
    const intent = intentOf('ledger-fixture', note(), d)
    const done = await runConfirmed(s, intent)
    expect(done).toMatchObject({ kind: 'done', result: { status: 'started' } })
    // the only way to present the token again is to have it: re-mint is what the host does; a spent one is refused
    const spy = vi.spyOn(s, 'programAct')
    const mint = vi.spyOn(s, 'confirmAct')
    await runConfirmed(s, intent)
    expect(mint).toHaveBeenCalledTimes(1)
    const token = (await mint.mock.results[0].value).confirm_token
    await expect(s.programAct('ledger-fixture', { ...intent.body, confirm_token: token })).rejects.toMatchObject({ code: 'confirm_invalid' })
    expect(spy).toHaveBeenCalled()
  })

  it('the token binds action, payload, session and time; refusals map to one plain sentence, never hive text', async () => {
    let t = 1_000_000
    const tokens = new SimConfirmTokens(() => t)
    const d = { contract: '0.1', kinds: [], relations: [], actions: [{ id: 'note', confirm: true }, { id: 'other', confirm: true }] } as ProgramDescription
    const person = { principal: 'user:p_ada', person: true, session: 'one' }
    const body = note({ params: { k: 1 } })
    const { payload, digest } = await payloadOf(body)
    const mint = async () => (await tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload, payload_digest: digest })).confirm_token
    const take = (b: ProgramActBody, who = person) => tokens.take('ledger-fixture', d.actions.find((a) => a.id === b.action), who, b)
    for (const wrong of [
      { ...body, params: { k: 2 } }, { ...body, items: ['x'] }, { ...body, base_revision: 'r9' }, { ...body, swarm_id: 's_forge' },
    ]) await expect(take({ ...wrong, confirm_token: await mint() })).rejects.toMatchObject({ code: 'confirm_invalid' })
    await expect(take({ ...body, confirm_token: await mint() }, { ...person, session: 'two' })).rejects.toMatchObject({ code: 'confirm_invalid' })
    await expect(take({ ...body, action: 'other', confirm_token: await mint() })).rejects.toMatchObject({ code: 'confirm_invalid' })
    const late = await mint()
    t += 121_000
    await expect(take({ ...body, confirm_token: late })).rejects.toMatchObject({ code: 'confirm_invalid' })
    const ok = await mint()
    await expect(take({ ...body, confirm_token: ok })).resolves.toBeNull()
    await expect(take({ ...body, confirm_token: ok })).rejects.toMatchObject({ code: 'confirm_invalid' })   // single use
    // the mint itself: exact body, digest recomputed from payload, number domain
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload_digest: digest })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload: { ...payload, params: { k: 9 } }, payload_digest: digest })).rejects.toMatchObject({ code: 'confirm_digest_mismatch' })
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload: { ...payload, params: { k: 1.5 } }, payload_digest: digest })).rejects.toMatchObject({ code: 'confirm_unsupported_value' })
    // the mapping
    expect(confirmRefusal(new ApiError(403, 'confirm_required', 'raw hive text'))).toEqual({ kind: 'again', message: CONFIRM_AGAIN })
    expect(confirmRefusal(new ApiError(403, 'confirm_invalid', 'raw hive text'))).toEqual({ kind: 'again', message: CONFIRM_AGAIN })
    expect(confirmRefusal(new ApiError(400, 'confirm_unsupported_value', 'raw'))).toEqual({ kind: 'unsupported', message: UNSUPPORTED_VALUE })
    expect(confirmRefusal(new ApiError(400, 'confirm_digest_mismatch', 'raw'))).toEqual({ kind: 'again', message: CONFIRM_MISMATCH })
    expect(confirmRefusal(new ApiError(413, 'confirm_payload_too_large', 'raw'))).toEqual({ kind: 'too-large', message: PAYLOAD_TOO_LARGE })
    expect(frameReason({ kind: 'too-large', message: PAYLOAD_TOO_LARGE })).toBe('too-large')
    // ced0564: the mint's payload fields are optional and normalized as the act normalizes them
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload: { items: [] }, payload_digest: (await payloadOf(note())).digest })).resolves.toMatchObject({ expires_in: 120 })
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload: { items: null, params: null }, payload_digest: (await payloadOf(note())).digest })).resolves.toMatchObject({ expires_in: 120 })
    await expect(tokens.mint('ledger-fixture', d.actions, person, { swarm_id: 's_lyra', action: 'note', payload: { params: { s: 'x'.repeat(2 * 1024 * 1024) } }, payload_digest: digest })).rejects.toMatchObject({ status: 413, code: 'confirm_payload_too_large' })
    expect(confirmRefusal(new ApiError(403, 'person_required', 'x'))).toBeNull()
  })

  it('person only: the operator session cannot mint for person_activity; it may for a plain confirm action', async () => {
    const s = sim('operator')
    const d = await describeOf(s, 'ledger-fixture')
    const bytes = enc('invented')
    const file = fileActBody({ action: 'attach', items: [] }, 's_lyra', { name: 'a.txt', mime: 'text/plain', size: bytes.byteLength, content_base64: base64Chunked(bytes) }, 'k-op')
    const o = await runConfirmed(s, intentOf('ledger-fixture', file, d))
    expect(o.kind).toBe('failed')
    expect((o as { error: ApiError }).error).toMatchObject({ status: 403, code: 'person_required' })
    expect(await runConfirmed(s, intentOf('ledger-fixture', note(), d))).toMatchObject({ kind: 'done' })
  })
})

describe('retries (§9d, review B2): one delivery per confirm, never a promise of exactly-once effects', () => {
  const lossyOf = (s: SimClient, drops: number) => {
    const real = s.programAct.bind(s)
    let left = drops
    return { confirmAct: s.confirmAct.bind(s), programAct: async (id: string, b: ProgramActBody) => {
      const r = await real(id, b)   // the hive did it ...
      if (left > 0) { left--; throw new ApiError(0, 'network', 'Network error') }   // ... and the answer was lost
      return r
    } }
  }
  const attach = (key: string, text = 'Invented note for the ledger fixture.\n') => {
    const bytes = enc(text)
    return fileActBody({ action: 'attach', items: [] }, 's_lyra', { name: 'note.txt', mime: 'text/plain', size: bytes.byteLength, content_base64: base64Chunked(bytes) }, key)
  }

  it('(a) done recovery: a lost answer to a completed person_activity intent is checked with the SAME token and shown as done; never asked again, never delivered twice', async () => {
    const s = sim()
    const d = await describeOf(s, 'ledger-fixture')
    const act = vi.spyOn(s.programsHost, 'act')
    const lossy = lossyOf(s, 1)
    const mint = vi.spyOn(lossy, 'confirmAct')
    const sends = vi.spyOn(lossy, 'programAct')
    const o = await runConfirmed(lossy, intentOf('ledger-fixture', attach('k-intent-1'), d))
    expect(o).toMatchObject({ kind: 'done', recovered: true, result: { status: 'done', message: 'received note.txt' } })
    expect(mint).toHaveBeenCalledTimes(1)   // no second token: nothing was asked again
    expect(sends).toHaveBeenCalledTimes(2)
    expect(sends.mock.calls[1][1].confirm_token).toBe(sends.mock.calls[0][1].confirm_token)   // the recovery check
    expect(sends.mock.calls[1][1].idempotency_key).toBe('k-intent-1')
    expect(act).toHaveBeenCalledTimes(1)   // the program ran once; the check got the recorded result
  })

  it('(b) failed: the check is refused (confirm_invalid), the person is asked afresh with the repeat-risk words; only that confirm mints a NEW token, same key', async () => {
    const s = sim()
    const d = await describeOf(s, 'ledger-fixture')
    const act = vi.spyOn(s.programsHost, 'act').mockRejectedValueOnce(new ApiError(500, 'program_error', 'boom'))
    const mint = vi.spyOn(s, 'confirmAct')
    const sends = vi.spyOn(s, 'programAct')
    const first = await runConfirmed(s, intentOf('ledger-fixture', attach('k-fail'), d))
    expect(first).toMatchObject({ kind: 'uncertain', intent: { prior: 'failed', personActivity: true, body: { idempotency_key: 'k-fail' } } })
    expect(mint).toHaveBeenCalledTimes(1)
    expect(sends).toHaveBeenCalledTimes(2)   // the act (500) and the check (refused: never re-run under a spent token)
    await expect(sends.mock.results[1].value).rejects.toMatchObject({ code: 'confirm_invalid' })
    expect(act).toHaveBeenCalledTimes(1)
    const again = (first as { intent: ConfirmIntent }).intent
    const words = priorWords(again.prior!, recoveryOf(again), 'Ledger')
    expect(words).toMatch(/cannot tell whether Ledger acted/)
    expect(words).toMatch(/may repeat it unless it recovers/)
    expect(words).not.toMatch(/at most once|exactly once/)
    // the person's new confirm: a new token, the same key; the hive delivers again (the app sees prior_failed on a real hive)
    const second = await runConfirmed(s, again)
    expect(second).toMatchObject({ kind: 'done' })
    expect(mint).toHaveBeenCalledTimes(2)
    expect((await mint.mock.results[1].value).confirm_token).not.toBe((await mint.mock.results[0].value).confirm_token)
    expect(sends.mock.calls[2][1].idempotency_key).toBe('k-fail')
    expect(act).toHaveBeenCalledTimes(2)   // a second delivery: exactly what the words warn of
  })

  it('(b) lost twice: the check gets no answer either, so the outcome stays unknown and the person is asked afresh', async () => {
    const s = sim()
    const d = await describeOf(s, 'ledger-fixture')
    const lossy = lossyOf(s, 2)
    const o = await runConfirmed(lossy, intentOf('ledger-fixture', attach('k-lost2'), d))
    expect(o).toMatchObject({ kind: 'uncertain', intent: { prior: 'lost' } })
    expect(priorWords('lost', true, 'Ledger')).toMatch(/^The hive did not answer last time, so the earlier attempt may already have had its effect\. Confirming again sends it again: if the hive finished it, you see that result and nothing is sent again; otherwise Ledger may repeat it unless it recovers the earlier attempt\.$/)
  })

  it('(b) still running at the first send: 409 in_progress is re-checked (bounded, the same token), never re-confirmed', async () => {
    const saved = RECHECK.delaysMs
    RECHECK.delaysMs = [0, 0, 0]
    try {
      const client = {
        confirmAct: vi.fn<NonNullable<HiveClient['confirmAct']>>(async () => ({ confirm_token: 'hct_r', expires_at: '', expires_in: 120 })),
        programAct: vi.fn<HiveClient['programAct']>(async () => { throw new ApiError(409, 'in_progress', 'this person request is still running') }),
      }
      const d = { contract: '0.1', kinds: [], relations: [], actions: [{ id: 'save', person_activity: true }] } as ProgramDescription
      const o = await runConfirmed(client, intentOf('app', { swarm_id: 's', action: 'save', items: [] }, d))
      expect(o).toMatchObject({ kind: 'uncertain', intent: { prior: 'running' } })
      expect(typeof (o as { recheck?: unknown }).recheck).toBe('function')
      expect(client.confirmAct).toHaveBeenCalledTimes(1)
      expect(client.programAct).toHaveBeenCalledTimes(4)   // the send and three re-checks
      expect(new Set(client.programAct.mock.calls.map((c) => c[1].confirm_token))).toEqual(new Set(['hct_r']))
    } finally {
      RECHECK.delaysMs = saved
    }
  })

  it('(c) not person_activity (confirm: true only): no intent record, so no recovery check; the words say it may be done a second time', async () => {
    const s = sim()
    const d = await describeOf(s, 'ledger-fixture')
    const act = vi.spyOn(s.programsHost, 'act')
    const lossy = lossyOf(s, 1)
    const sends = vi.spyOn(lossy, 'programAct')
    const o = await runConfirmed(lossy, intentOf('ledger-fixture', note(), d))
    expect(o).toMatchObject({ kind: 'uncertain', intent: { prior: 'lost', personActivity: false } })
    expect(sends).toHaveBeenCalledTimes(1)   // never re-presented: its token is strictly single use
    const again = (o as { intent: ConfirmIntent }).intent
    const words = priorWords(again.prior!, recoveryOf(again), 'Ledger')
    expect(words).toMatch(/may already have had its effect/)
    expect(words).toMatch(/no recovery in the hive: confirming again sends it again, and Ledger may do it a second time unless it recovers/)
    // a new confirm delivers again: the words were right
    expect(await runConfirmed(s, again)).toMatchObject({ kind: 'done' })
    expect(act).toHaveBeenCalledTimes(2)
    // and an action with neither confirm nor person_activity takes no host confirm at all
    expect(needsConfirm({ contract: '0.1', kinds: [], relations: [], actions: [{ id: 'plain', confirm: false }] } as ProgramDescription, 'plain')).toBe(false)
  })

  it('describe unknown: the check is still tried (it can only recover), but the words never promise recovery', () => {
    const p = prepareConfirm('app', { swarm_id: 's', action: 'x', items: [] }, null)
    expect(p.ok && p.intent.personActivity).toBeNull()
    expect(p.ok && recoveryOf(p.intent)).toBe(false)
    expect(priorWords('failed', false, 'App')).toMatch(/no recovery in the hive/)
  })

  it('no copy promises at-most-once or exactly-once anywhere in the host confirm', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
    for (const f of ['./hostConfirm.ts', '../features/programs/HostConfirm.tsx'])
      expect(fs.readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/['`][^'`\n]*(at most once|exactly once|exactly-once)[^'`\n]*['`]/)
  })
})

describe('identity (review B1): runConfirmed never mints or acts once `alive` is false', () => {
  it('false before the mint: nothing called; false after the mint: the token is discarded, no act; false after the act: stale, sent', async () => {
    let calls: string[] = []
    let flip = ''
    let alive = true
    const client = {
      confirmAct: vi.fn<NonNullable<HiveClient['confirmAct']>>(async () => { calls.push('mint'); if (flip === 'mint') alive = false; return { confirm_token: 'hct_x', expires_at: '', expires_in: 120 } }),
      programAct: vi.fn<HiveClient['programAct']>(async () => { calls.push('act'); if (flip === 'act') alive = false; return { status: 'done' } as ActionResult }),
    }
    const intent = intentOf('app', { swarm_id: 's', action: 'send', items: [] }, null)
    alive = false
    expect(await runConfirmed(client, intent, () => alive)).toMatchObject({ kind: 'stale', sent: false })
    expect(calls).toEqual([])
    alive = true; flip = 'mint'
    expect(await runConfirmed(client, intent, () => alive)).toMatchObject({ kind: 'stale', sent: false })
    expect(calls).toEqual(['mint'])
    calls = []; alive = true; flip = 'act'
    expect(await runConfirmed(client, intent, () => alive)).toMatchObject({ kind: 'stale', sent: true })
    expect(calls).toEqual(['mint', 'act'])
  })
  it('false during a lost answer: no recovery check is sent', async () => {
    let alive = true
    const client = {
      confirmAct: vi.fn<NonNullable<HiveClient['confirmAct']>>(async () => ({ confirm_token: 'hct_x', expires_at: '', expires_in: 120 })),
      programAct: vi.fn<HiveClient['programAct']>(async () => { alive = false; throw new ApiError(0, 'network', 'lost') }),
    }
    const d = { contract: '0.1', kinds: [], relations: [], actions: [{ id: 'save', person_activity: true }] } as ProgramDescription
    expect(await runConfirmed(client, intentOf('app', { swarm_id: 's', action: 'save', items: [] }, d), () => alive)).toMatchObject({ kind: 'stale', sent: true })
    expect(client.programAct).toHaveBeenCalledTimes(1)
  })
})

describe('what a frame is told', () => {
  it('the result only, never the token; confirm refusals are `confirm-required`, unsupported values `invalid`', () => {
    const reply = frameConfirmReply('a1', { kind: 'done', result: { status: 'done', message: 'ok' } })
    expect(reply).toEqual({ type: 'app-reply', id: 'a1', ok: true, result: { status: 'done', message: 'ok' } })
    expect(JSON.stringify(reply)).not.toContain('hct_')
    expect(frameReason({ kind: 'again', message: CONFIRM_AGAIN })).toBe('confirm-required')
    expect(frameReason({ kind: 'unsupported', message: UNSUPPORTED_VALUE })).toBe('invalid')
    expect(frameConfirmReply('a2', { kind: 'refused', reason: 'confirm-required' })).toEqual({ type: 'app-reply', id: 'a2', ok: false, error: 'confirm-required', reason: 'confirm-required' })
  })
})

describe('every act path mints only from a confirm (source check)', () => {
  async function source(rel: string): Promise<string> {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
    return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
  }
  it('confirmAct is called only by lib/hostConfirm; runConfirmed only from the host dialog’s confirm (or Fusion after its confirm)', async () => {
    const files = ['../features/programs/AppFrame.tsx', '../features/programs/frameAct.ts', '../features/programs/ProgramForm.tsx', '../features/programs/ProgramHost.tsx', '../features/programs/HostConfirm.tsx', '../features/programs/fusionForecast.ts', '../store/store.ts']
    for (const f of files) expect(await source(f), f).not.toMatch(/\.confirmAct\(/)
    expect(await source('./hostConfirm.ts')).toMatch(/client\.confirmAct\(/)
    const host = await source('../features/programs/HostConfirm.tsx')
    // run() is reached from the dialog's confirm (the person's press), or from a caller's own confirm (preconfirmed)
    expect(host.match(/runConfirmed\(/g)).toHaveLength(1)
    expect(host).toMatch(/runConfirmed\(o\.origin\.client, o\.intent, \(\) => this\.alive\(o\),/)   // the ORIGIN client, fenced
    expect(host.match(/this\.run\(o\)/g)).toHaveLength(2)
    expect(host).toMatch(/o\.phase = 'running'\n {4}await this\.run\(o\)/)
    expect(host).toMatch(/if \(opts\.preconfirmed\) \{[\s\S]*?void this\.run\(o\)/)
    expect(host).toMatch(/onConfirm=\{\(\) => c\.confirm\(view\.seq\)\}/)
    expect(host).not.toMatch(/getState\(\)\.client/)   // never the store's current client for a confirm
    const fusion = await source('../features/programs/fusionForecast.ts')
    expect(fusion.indexOf('await confirm(message)')).toBeLessThan(fusion.indexOf('this.send(request)'))
    // the frame bridge never puts the token in a reply: replies are built from the result only
    const frame = await source('../features/programs/AppFrame.tsx')
    expect(frame).not.toMatch(/confirm_token[^:]/)
    // the token is taken out first; later rounds strip more (untrusted_intent) before the rest becomes the body
    expect(frame).toMatch(/const \{ confirm_token: _frameToken, (?:[A-Za-z_]+: _[A-Za-z]+, )*\.\.\.frameBody \}/)
  })
})

describe('still running (Kimi next22b/23b r2 #3): a recovery check answered 409 in_progress is not a failure', () => {
  // the hive answers in_progress before it looks at the token (program_actions.person_act); once done it returns the
  // recorded result for the token spent on that intent (§9d). INVENTED sim data and scripted answers only.
  let saved: number[]
  beforeEach(() => { saved = RECHECK.delaysMs; RECHECK.delaysMs = [0, 0, 0] })
  afterEach(() => { RECHECK.delaysMs = saved })
  const d = { contract: '0.1', kinds: [], relations: [], actions: [{ id: 'save', label: 'Save', person_activity: true }] } as ProgramDescription
  const RUNNING = () => new ApiError(409, 'in_progress', 'this person request is still running')
  /** First send: the answer is lost; then each check answers from `script` in turn (an Error is thrown). */
  function scripted(script: (ActionResult | Error)[]) {
    let n = 0
    const client = {
      confirmAct: vi.fn<NonNullable<HiveClient['confirmAct']>>(async () => ({ confirm_token: `hct_${++n}`, expires_at: '', expires_in: 120 })),
      programAct: vi.fn<HiveClient['programAct']>(async () => {
        const next = script.shift()
        if (next === undefined) throw new Error('script ran out')
        if (next instanceof Error) throw next
        return next
      }),
    }
    return client
  }
  const tokens = (c: ReturnType<typeof scripted>) => c.programAct.mock.calls.map((x) => x[1].confirm_token)
  const save = () => intentOf('app', { swarm_id: 's', action: 'save', items: [], idempotency_key: 'k-run' }, d)

  it('in_progress, then done: the recorded result, recovered; one mint, never a re-confirm, every check with the same token', async () => {
    const c = scripted([new ApiError(0, 'network', 'Network error'), RUNNING(), RUNNING(), { status: 'done', message: 'saved' }])
    const o = await runConfirmed(c, save())
    expect(o).toEqual({ kind: 'done', result: { status: 'done', message: 'saved' }, recovered: true })
    expect(c.confirmAct).toHaveBeenCalledTimes(1)
    expect(c.programAct).toHaveBeenCalledTimes(4)   // the send, the recovery check, two re-checks
    expect(new Set(tokens(c))).toEqual(new Set(['hct_1']))
  })

  it('in_progress, then failed: a fresh confirm with the repeat-risk words; only that confirm mints a new token, same key', async () => {
    const c = scripted([new ApiError(0, 'network', 'Network error'), RUNNING(), new ApiError(403, 'confirm_invalid', 'used')])
    const o = await runConfirmed(c, save())
    expect(o).toMatchObject({ kind: 'uncertain', intent: { prior: 'failed', body: { idempotency_key: 'k-run' } } })
    expect((o as { recheck?: unknown }).recheck).toBeUndefined()   // not running any more: the person is asked afresh
    expect(c.confirmAct).toHaveBeenCalledTimes(1)
    const again = (o as { intent: ConfirmIntent }).intent
    const words = priorWords(again.prior!, recoveryOf(again), 'App')
    expect(words).toMatch(/did not finish, and the hive cannot tell whether App acted/)
    expect(words).toMatch(/may repeat it unless it recovers/)
    // the person's new confirm mints a new token for the same key
    const c2 = scripted([{ status: 'done', message: 'saved again' }])
    expect(await runConfirmed(c2, again)).toMatchObject({ kind: 'done' })
    expect(c2.programAct.mock.calls[0][1]).toMatchObject({ idempotency_key: 'k-run', confirm_token: 'hct_1' })
  })

  it('in_progress until the re-checks run out: still unknown; the outcome offers only a further check, which never mints', async () => {
    const c = scripted([new ApiError(0, 'network', 'Network error'), RUNNING(), RUNNING(), RUNNING(), RUNNING()])
    const o = await runConfirmed(c, save())
    expect(o).toMatchObject({ kind: 'uncertain', intent: { prior: 'running' } })
    const recheck = (o as Extract<ConfirmOutcome, { kind: 'uncertain' }>).recheck!
    expect(typeof recheck).toBe('function')
    expect(c.programAct).toHaveBeenCalledTimes(5)   // the send, the recovery check, three re-checks: bounded
    expect(runningWords('App')).toMatch(/still being carried out/)
    expect(runningWords('App')).toMatch(/not known yet/)
    expect(runningWords('App')).toMatch(/Nothing more is sent while it is running/)
    // a further check (the person's "Check again"): the same token; done now
    c.programAct.mockImplementationOnce(async () => ({ status: 'done', message: 'saved' }))
    expect(await recheck()).toEqual({ kind: 'done', result: { status: 'done', message: 'saved' }, recovered: true })
    expect(c.confirmAct).toHaveBeenCalledTimes(1)
    expect(new Set(tokens(c))).toEqual(new Set(['hct_1']))
  })

  it('an identity change between re-checks stops them: nothing more is sent', async () => {
    let alive = true
    const c = scripted([new ApiError(0, 'network', 'Network error'), RUNNING(), RUNNING(), RUNNING(), RUNNING()])
    c.programAct.mockImplementation(async () => { alive = c.programAct.mock.calls.length < 3; throw RUNNING() })
    c.programAct.mockImplementationOnce(async () => { throw new ApiError(0, 'network', 'Network error') })
    const o = await runConfirmed(c, save(), () => alive)
    expect(o).toMatchObject({ kind: 'stale', sent: true })
    expect(c.programAct).toHaveBeenCalledTimes(3)
  })
})
