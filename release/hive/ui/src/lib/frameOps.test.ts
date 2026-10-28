import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import type { ActionResult, ProgramActBody } from '../api/types'
import { appContext } from './appBridge'
import { appDocument, frameCsp } from './appFrame'
import { payloadOf } from './hostConfirm'
import {
  acceptsFile, actFileError, base64Chunked, checkUrl, declaredReads, FRAME_BUCKET, FrameGoals, frameBack, goalNotice, MAX_ACT_FILE, MAX_READ_INFLIGHT,
  MAX_READ_PARAMS, MAX_READ_RESULT, MAX_SHOW_BYTES, parseActFile, parseFrameOp, precheckActFile, readError, readReply, releaseBytes, sendActFile, startedGoal,
  tokenBucket, urlParts, viewable, viewerBlob, type FrameOp, type ReadEnv,
} from './frameOps'

const ch = '12345678-1234-1234-1234-123456789abc'
const ok = (data: unknown): FrameOp => {
  const p = parseFrameOp(data)
  if (!p || !p.ok) throw new Error(`expected a valid op: ${JSON.stringify(p)}`)
  return p.msg
}
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const PDF = enc('%PDF-1.4\n%invented\n')
const readMsg = (query = 'entries', params: Record<string, unknown> | null = null) => ({ type: 'read' as const, id: 'r1', query, params })
const env = (read: ReadEnv['read'], declared: Set<string> | null = new Set(['entries'])): ReadEnv => ({ read, programId: 'ledger-fixture', swarmId: 's_lyra', declared, inflight: { n: 0 } })
function sim(session: 'person' | 'operator' = 'person') {
  const s = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  s.simSession = session
  s.programsHost.installInvented('ledger-fixture')
  return s
}

describe('frame ops: messages (exact keys; the frame never names a program, swarm or person)', () => {
  it('accepts every well-formed shape', () => {
    expect(ok({ type: 'read', channel: ch, id: 'r1', query: 'entries' })).toEqual({ type: 'read', id: 'r1', query: 'entries', params: null })
    expect(ok({ type: 'read', id: 'r1', query: 'a.b-c_d', params: { limit: 5 } })).toMatchObject({ params: { limit: 5 } })
    expect(ok({ type: 'open-url', id: 'u1', url: 'https://example.org/x' })).toEqual({ type: 'open-url', id: 'u1', url: 'https://example.org/x' })
    expect(ok({ type: 'show-file', id: 'f1', name: 'a.pdf', mime: 'application/pdf', bytes: PDF })).toMatchObject({ type: 'show-file', mime: 'application/pdf' })
    expect(ok({ type: 'back-request', channel: ch })).toEqual({ type: 'back-request' })
    expect(ok({ type: 'escape' })).toEqual({ type: 'escape' })
    expect(ok({ type: 'layout', mode: 'full' })).toEqual({ type: 'layout', mode: 'full' })
    expect(ok({ type: 'subscribe', goal_id: 'g_1' })).toEqual({ type: 'subscribe', goal_id: 'g_1' })
  })

  it('leaves other types alone (null)', () => {
    for (const m of [{ type: 'pick', id: 'p' }, { type: 'app-request', id: 'x', op: 'subscribe' }, { type: 'draft-save' }, { type: 'READ' }, null, 'read', []]) expect(parseFrameOp(m)).toBeNull()
  })

  it('refuses spoofed fields', () => {
    const spoofs = [
      { type: 'read', id: 'x', query: 'entries', program_id: 'other' },
      { type: 'read', id: 'x', query: 'entries', swarm_id: 's_other' },
      { type: 'read', id: 'x', query: 'entries', principal: 'user:p_other' },
      { type: 'open-url', id: 'x', url: 'https://example.org', swarm_id: 's_other' },
      { type: 'show-file', id: 'x', name: 'a', mime: 'text/plain', bytes: enc('a'), program: 'omegacode' },
      { type: 'back-request', id: 'x' },
      { type: 'layout', mode: 'full', swarm_id: 's' },
    ]
    for (const m of spoofs) expect(parseFrameOp(m)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseFrameOp({ type: 'subscribe', goal_id: 'g', swarm_id: 's' })).toMatchObject({ ok: false })
  })

  it('validates the query id and params on the host (before any request)', () => {
    expect(parseFrameOp({ type: 'read', id: 'x', query: '../etc' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'q'.repeat(65) })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: [1] })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: 'a' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: { d: new Date(0) } })).toMatchObject({ ok: false, reason: 'bad-request' })
    // params are capped at 1 MB serialised (Platform), checked before any request
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: { s: 'y'.repeat(20_000) } })).toMatchObject({ ok: true })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: { s: 'y'.repeat(MAX_READ_PARAMS - 20) } })).toMatchObject({ ok: true })
    expect(parseFrameOp({ type: 'read', id: 'x', query: 'entries', params: { s: 'y'.repeat(MAX_READ_PARAMS) } })).toMatchObject({ ok: false, id: 'x', reason: 'too-large' })
  })
})

describe('G1 read', () => {
  it('refuses an undeclared query on the host, without calling', async () => {
    const read = vi.fn()
    expect(await readReply(readMsg('timeline'), env(read))).toEqual({ type: 'read-refused', id: 'r1', query: 'timeline', reason: 'not-declared' })
    expect(read).not.toHaveBeenCalled()
  })

  it('fills in the program and swarm itself and forwards only result', async () => {
    const read = vi.fn(async () => ({ program: 'ledger-fixture', query: 'entries', result: { n: 1 }, extra: 'never forwarded' }))
    expect(await readReply(readMsg('entries', { limit: 2 }), env(read))).toEqual({ type: 'read-result', id: 'r1', query: 'entries', result: { n: 1 } })
    expect(read).toHaveBeenCalledWith('ledger-fixture', 's_lyra', 'entries', { limit: 2 })
  })

  it('refuses a 200 result that is not a plain JSON object (next9)', async () => {
    for (const result of [[1, 2], 'text', 3, null, undefined, { d: new Date(0) }])
      expect(await readReply(readMsg(), env(async () => ({ result })))).toMatchObject({ type: 'read-refused', reason: 'unavailable' })
  })

  it('refuses a result over 4 MB (too-large)', async () => {
    const big = { s: 'x'.repeat(MAX_READ_RESULT) }
    expect(await readReply(readMsg(), env(async () => ({ result: big })))).toMatchObject({ reason: 'too-large' })
  })

  it('maps hive errors, never forwarding their text', async () => {
    const cases: [ApiError | Error, string][] = [
      [new ApiError(404, 'unknown_read', 'secret'), 'not-declared'],
      [new ApiError(403, 'program_refused', 'secret'), 'refused'],
      [new ApiError(413, 'read_too_large', 'secret'), 'too-large'],
      [new ApiError(400, 'bad_request', 'secret'), 'bad-request'],
      [new ApiError(403, 'app_integrity', 'secret'), 'unavailable'],
      [new ApiError(409, 'program_disabled', 'secret'), 'unavailable'],
      [new ApiError(404, 'app_not_here', 'secret'), 'not-set-up'],
      [new ApiError(403, 'app_not_opened', 'secret'), 'not-opened'],
      [new ApiError(500, 'bad_result', 'secret'), 'unavailable'],
      [new ApiError(0, 'network', 'secret'), 'unavailable'],
      [new Error('secret'), 'unavailable'],
    ]
    for (const [e, reason] of cases) {
      expect(readError(e)).toBe(reason)
      const r = await readReply(readMsg(), env(async () => { throw e }))
      expect(r).toEqual({ type: 'read-refused', id: 'r1', query: 'entries', reason })
      expect(JSON.stringify(r)).not.toContain('secret')
    }
  })

  it('limits reads in flight and answers unavailable without the route', async () => {
    const e = env(async () => ({ result: {} }))
    e.inflight.n = MAX_READ_INFLIGHT
    expect(await readReply(readMsg(), e)).toMatchObject({ reason: 'busy' })
    expect(await readReply(readMsg(), env(undefined))).toMatchObject({ reason: 'unavailable' })
  })

  it('reads the declared reads from describe; capability read only with the route and a declared read', async () => {
    expect(declaredReads({ contract: '0.1', kinds: [], relations: [], actions: [], reads: [{ id: 'entries' }, { id: '../x' }] })).toEqual(new Set(['entries']))
    expect(declaredReads({ contract: '0.1', kinds: [], relations: [], actions: [] })).toBeNull()
    const base = { experience: 'classic', chrome: null, identity: null, reducedMotion: false, picker: false }
    expect(appContext({ ...base, reads: true, frameOps: true }).capabilities).toMatchObject({ read: true, openUrl: true, showFile: true, fullBleed: true, actFile: false })
    expect(appContext({ ...base, reads: true, frameOps: true, person: { kind: 'person', localOperator: false } }).capabilities.actFile).toBe(true)
    expect(appContext(base).capabilities).toMatchObject({ read: false, openUrl: false, showFile: false, actFile: false, fullBleed: false })
  })

  it('the sim follows the rules: declared, object, 4 MB, never persisted', async () => {
    const s = sim()
    const d = await s.program('ledger-fixture')
    expect(d.describe?.reads).toEqual([{ id: 'entries', label: 'Entries' }])
    const r = await s.programRead('ledger-fixture', 's_lyra', 'entries', { limit: 3 })
    expect(r.program).toBe('ledger-fixture')
    expect((r.result as { entries: unknown[] }).entries).toHaveLength(3)
    await expect(s.programRead('ledger-fixture', 's_lyra', 'timeline', null)).rejects.toMatchObject({ status: 404, code: 'unknown_read' })
    await expect(s.programRead('contract-fixture', 's_lyra', 'entries', null)).rejects.toMatchObject({ code: 'unknown_read' })
    await expect(s.programRead('ledger-fixture', 's_lyra', 'bad id', null)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(s.programRead('ledger-fixture', 's_lyra', 'entries', [1] as never)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(s.programRead('ledger-fixture', 's_lyra', 'entries', { pad: MAX_READ_RESULT })).rejects.toMatchObject({ status: 413, code: 'read_too_large' })
    // end to end through the host's reply
    const via = (m: ReturnType<typeof readMsg>) => readReply(m, { ...env(s.programRead.bind(s)), declared: declaredReads(d.describe) })
    expect(await via(readMsg('entries', { pad: MAX_READ_RESULT }))).toMatchObject({ reason: 'too-large' })
    expect(await via(readMsg('entries', { limit: 1 }))).toMatchObject({ type: 'read-result', result: { total: 24 } })
  })

  it('the sim refuses a non-object read result (500 bad_result)', async () => {
    const s = sim()
    const entry = (s.programsHost as unknown as { entries: Map<string, { program: { read: unknown } }> }).entries.get('ledger-fixture')!
    entry.program.read = () => [1, 2]
    await expect(s.programRead('ledger-fixture', 's_lyra', 'entries', null)).rejects.toMatchObject({ status: 500, code: 'bad_result' })
  })
})

describe('G4 open-url', () => {
  it('accepts https only; refuses anything else', () => {
    expect(checkUrl('https://example.org/a?b#c')).toMatchObject({ ok: true })
    for (const u of ['http://example.org', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://x/1', 'file:///etc/passwd', 'ftp://x'])
      expect(checkUrl(u)).toEqual({ ok: false, reason: 'not-https' })
    expect(checkUrl('not a url')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkUrl('https://bank.example@evil.example/')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkUrl(`https://example.org/${'a'.repeat(2048)}`)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('the prompt shows the full origin (punycode) and the path ellipsized', () => {
    const r = checkUrl(`https://exämple.org/research/${'p'.repeat(120)}/paper.pdf?x=1`)
    if (!r.ok) throw new Error('expected ok')
    const parts = urlParts(r.url)
    expect(parts.origin).toBe('https://xn--exmple-cua.org')
    expect(parts.rest.length).toBeLessThanOrEqual(64)
    expect(parts.rest).toContain('…')
    expect(parts.rest.startsWith('/research/')).toBe(true)
    expect(parts.rest.endsWith('paper.pdf?x=1')).toBe(true)
    expect(urlParts(new URL('https://example.org/a'))).toEqual({ origin: 'https://example.org', rest: '/a' })
  })
})

describe('G3 show-file', () => {
  it('refuses other types and over 20 MB before showing', () => {
    expect(parseFrameOp({ type: 'show-file', id: 'f', name: 'a.html', mime: 'text/html', bytes: enc('<b>') })).toMatchObject({ ok: false, reason: 'unsupported-type' })
    expect(parseFrameOp({ type: 'show-file', id: 'f', name: 'a.svg', mime: 'image/svg+xml', bytes: enc('<svg/>') })).toMatchObject({ ok: false, reason: 'unsupported-type' })
    expect(parseFrameOp({ type: 'show-file', id: 'f', name: 'a', mime: 'text/plain', bytes: new ArrayBuffer(MAX_SHOW_BYTES + 1) })).toMatchObject({ ok: false, reason: 'too-large' })
    expect(parseFrameOp({ type: 'show-file', id: 'f', name: 'a', mime: 'text/plain', bytes: new Uint8Array(2) })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseFrameOp({ type: 'show-file', id: 'f', name: 'a', mime: 'text/plain', bytes: 'aGk=' })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('checks a PDF signature and decodes text (shown escaped by React)', () => {
    expect(viewable('application/pdf', PDF)).toEqual({ ok: true, kind: 'pdf' })
    expect(viewable('application/pdf', enc('<html><script>x</script>'))).toEqual({ ok: false, reason: 'mismatch' })
    expect(viewable('text/plain', enc('<b>hi</b>'))).toEqual({ ok: true, kind: 'text', text: '<b>hi</b>', cut: false })
  })

  it('cleans the untrusted name', () => {
    expect(ok({ type: 'show-file', id: 'f', name: 'a‮gpj.exe\u0000', mime: 'text/plain', bytes: enc('x') })).toMatchObject({ name: 'agpj.exe' })
  })

  it('revokes the blob URL on close, once', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const blob = viewerBlob(PDF, 'application/pdf')
    expect(blob.url.startsWith('blob:')).toBe(true)
    expect(revoke).not.toHaveBeenCalled()
    blob.close()
    expect(revoke).toHaveBeenCalledWith(blob.url)
    blob.close()
    expect(revoke).toHaveBeenCalledTimes(1)
    revoke.mockRestore()
  })
})

describe('G7 back / escape', () => {
  it('is the host Back unless a host dialog is open', () => {
    const back = vi.fn()
    expect(frameBack(false, back)).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    expect(frameBack(true, back)).toBe(false)
    expect(frameBack(false, undefined)).toBe(false)
    expect(back).toHaveBeenCalledTimes(1)
  })
})

describe('G2 act with a file', () => {
  const file = (n = 4, mime = 'text/plain', name = 'notes.txt') => ({ name, mime, bytes: new Uint8Array(n).fill(65).buffer })
  const actions = [
    { id: 'attach', accepts_file: { mimes: ['application/pdf', 'text/plain', 'image/*'], max_bytes: 10 } },
    { id: 'note' },
  ]

  it('parses {name, mime, bytes} only; the host computes size', () => {
    const p = parseActFile(file(4))
    expect(p).toMatchObject({ ok: true, file: { name: 'notes.txt', mime: 'text/plain', size: 4 } })
    expect(parseActFile({ ...file(), size: 1 })).toEqual({ ok: false, reason: 'bad-file' })
    expect(parseActFile({ ...file(), content_base64: 'QQ==' })).toEqual({ ok: false, reason: 'bad-file' })
    expect(parseActFile({ name: 'a', mime: 'text/plain', bytes: 'QQ==' })).toEqual({ ok: false, reason: 'bad-file' })
    expect(parseActFile({ name: '\u0000', mime: 'text/plain', bytes: new ArrayBuffer(1) })).toEqual({ ok: false, reason: 'bad-file' })
    expect(parseActFile({ name: 'a', mime: 'not a mime', bytes: new ArrayBuffer(1) })).toEqual({ ok: false, reason: 'bad-file' })
    expect(parseActFile({ name: 'n'.repeat(400), mime: 'text/plain', bytes: new ArrayBuffer(1) })).toMatchObject({ ok: true, file: { name: 'n'.repeat(255) } })
  })

  it('refuses over 20 MB before any call', () => {
    expect(parseActFile({ name: 'a', mime: 'text/plain', bytes: new ArrayBuffer(MAX_ACT_FILE + 1) })).toEqual({ ok: false, reason: 'too-large' })
  })

  it('pre-checks accepts_file from describe (the hive stays the authority)', () => {
    const f = (size: number, mime = 'text/plain') => ({ name: 'a', mime, size, bytes: new ArrayBuffer(size) })
    expect(acceptsFile(actions[0])).toEqual({ mimes: ['application/pdf', 'text/plain', 'image/*'], max_bytes: 10 })
    expect(precheckActFile(f(4), 'attach', actions)).toBeNull()
    expect(precheckActFile(f(4, 'image/png'), 'attach', actions)).toBeNull()
    expect(precheckActFile(f(4), 'note', actions)).toBe('file-not-accepted')
    expect(precheckActFile(f(4, 'application/zip'), 'attach', actions)).toBe('file-type-refused')
    expect(precheckActFile(f(11), 'attach', actions)).toBe('too-large')
    expect(precheckActFile(f(4), 'attach', null)).toBeNull()
  })

  it('maps every hive refusal', () => {
    const cases: [ApiError | Error, string][] = [
      [new ApiError(400, 'file_not_accepted', 'x'), 'file-not-accepted'],
      [new ApiError(415, 'file_type_refused', 'x'), 'file-type-refused'],
      [new ApiError(413, 'file_too_large', 'x'), 'too-large'],
      [new ApiError(413, 'request_too_large', 'x'), 'too-large'],
      [new ApiError(400, 'bad_file', 'x'), 'bad-file'],
      [new ApiError(403, 'app_not_opened', 'x'), 'not-opened'],
      [new ApiError(403, 'person_required', 'x'), 'person-required'],
      [new ApiError(500, 'program_error', 'x'), 'unavailable'],
      [new Error('x'), 'unavailable'],
    ]
    for (const [e, reason] of cases) expect(actFileError(e)).toBe(reason)
  })

  it('base64 round-trips in chunks (no one huge spread)', () => {
    const bytes = new Uint8Array(3 * 0x4000 * 2 + 7)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255
    const b64 = base64Chunked(bytes.buffer, 3 * 0x4000)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    expect(b64).toBe(btoa(bin))
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(bytes)
    expect(base64Chunked(new ArrayBuffer(0))).toBe('')
  })

  it('releases the buffer (detached) once encoded', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer
    releaseBytes(buf)
    expect(buf.byteLength).toBe(0)
    expect((buf as ArrayBuffer & { detached?: boolean }).detached).toBe(true)
    releaseBytes(buf)   // twice is harmless
  })

  it('one host key per confirmed intent: a retry after a lost answer reuses it and the bytes; the frame cannot choose it', async () => {
    const seen: ProgramActBody[] = []
    let n = 0
    const act = async (b: ProgramActBody): Promise<ActionResult> => {
      seen.push(structuredClone(b))
      if (++n === 1) throw new ApiError(0, 'network', 'lost')
      return { status: 'done' }
    }
    const wire = { name: 'a.txt', mime: 'text/plain', size: 1, content_base64: 'QQ==' }
    await sendActFile(act, { action: 'attach', items: [], idempotency_key: 'frame-chosen', swarm_id: 's_other' }, 's_lyra', wire, 'k-host-1')
    expect(seen).toHaveLength(2)
    expect(seen.map((b) => b.idempotency_key)).toEqual(['k-host-1', 'k-host-1'])
    expect(seen[0]).toEqual(seen[1])
    expect(seen[0].swarm_id).toBe('s_lyra')
    // a refusal is not retried
    const refuse = vi.fn(async () => { throw new ApiError(413, 'request_too_large', 'x') })
    await expect(sendActFile(refuse, { action: 'attach', items: [] }, 's_lyra', wire)).rejects.toMatchObject({ code: 'request_too_large' })
    expect(refuse).toHaveBeenCalledTimes(1)
    // two confirmed intents get two keys
    const keys: string[] = []
    const rec = async (b: ProgramActBody): Promise<ActionResult> => (keys.push(b.idempotency_key!), { status: 'done' })
    await sendActFile(rec, { action: 'attach', items: [] }, 's_lyra', wire)
    await sendActFile(rec, { action: 'attach', items: [] }, 's_lyra', wire)
    expect(new Set(keys).size).toBe(2)
  })

  it('the sim follows the rules: person only, declared, typed, sized, never stored; a retry is answered once', async () => {
    const s = sim('person')
    const bytes = enc('invented note')
    const f = { name: 'note.txt', mime: 'text/plain', size: bytes.byteLength, content_base64: base64Chunked(bytes) }
    const body = (over: Partial<ProgramActBody> = {}): ProgramActBody => ({ swarm_id: 's_lyra', action: 'attach', items: [], idempotency_key: crypto.randomUUID(), file: f, ...over })
    // §9d: every file act is person_activity, so it carries the host's confirm token for exactly this payload
    const confirmed = async (b: ProgramActBody) => { const { payload, digest } = await payloadOf(b); return { ...b, confirm_token: (await s.confirmAct('ledger-fixture', b.swarm_id, b.action, payload, digest)).confirm_token } }
    const first = await confirmed(body({ idempotency_key: 'k1' }))
    const r = await s.programAct('ledger-fixture', first)
    expect(r.detail?.received).toMatchObject({ name: 'note.txt', mime: 'text/plain', size: bytes.byteLength })
    expect((r.detail?.received as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await s.programAct('ledger-fixture', first)).toEqual(r)   // the recovery of the completed intent
    await expect(s.programAct('ledger-fixture', await confirmed(body({ action: 'note' })))).rejects.toMatchObject({ status: 400, code: 'file_not_accepted' })
    await expect(s.programAct('ledger-fixture', await confirmed(body({ file: { ...f, mime: 'application/zip' } })))).rejects.toMatchObject({ status: 415, code: 'file_type_refused' })
    await expect(s.programAct('ledger-fixture', await confirmed(body({ file: { ...f, size: 6 * 1024 * 1024 } })))).rejects.toMatchObject({ status: 413, code: 'file_too_large' })
    await expect(s.programAct('ledger-fixture', await confirmed(body({ file: { ...f, size: 3 } })))).rejects.toMatchObject({ status: 400, code: 'bad_file' })
    // bytes that are not base64 cannot be digested by the host either; the sim refuses them as the hive does
    await expect(s.programAct('ledger-fixture', body({ file: { ...f, content_base64: '***' } }))).rejects.toMatchObject({ status: 400, code: 'bad_file' })
    // the hive refuses a person_activity act without its stable intent key (403 person_required)
    await expect(s.programAct('ledger-fixture', body({ idempotency_key: undefined }))).rejects.toMatchObject({ status: 403, code: 'person_required' })
    await expect(sim('operator').programAct('ledger-fixture', body())).rejects.toMatchObject({ status: 403, code: 'person_required' })
  })
})

describe('G9 goal notices', () => {
  it('only goals this frame’s own act started; status only; dropped on clear', () => {
    const goals = new FrameGoals()
    expect(goals.subscribe('g_1')).toBe(false)   // not started here
    goals.record(startedGoal({ status: 'started', task: { id: 'g_1', kind: 'goal', status: 'open' } }))
    goals.record(startedGoal({ status: 'done' }))
    expect(goals.subscribe('g_1')).toBe(true)
    const ev = { type: 'goal.updated', at: 't', goal: { id: 'g_1', swarm_id: 's_lyra', status: 'done', title: 'never forwarded', detail: 'never' } }
    expect(goalNotice(ev, 's_lyra', goals)).toEqual({ type: 'goal.status', goal_id: 'g_1', status: 'done' })
    expect(goalNotice({ ...ev, goal: { ...ev.goal, swarm_id: 's_other' } }, 's_lyra', goals)).toBeNull()
    expect(goalNotice({ ...ev, goal: { ...ev.goal, id: 'g_2' } }, 's_lyra', goals)).toBeNull()
    expect(goalNotice({ type: 'goal.created', goal: ev.goal }, 's_lyra', goals)).toBeNull()
    goals.unsubscribe('g_1')
    expect(goalNotice(ev, 's_lyra', goals)).toBeNull()
    goals.subscribe('g_1')
    goals.clear()
    expect(goalNotice(ev, 's_lyra', goals)).toBeNull()
    expect(goals.subscribe('g_1')).toBe(false)
  })
})

describe('per-frame token bucket over every op', () => {
  it('spends one token per message and refills', () => {
    let t = 0
    const b = tokenBucket(3, 2, () => t)
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false])
    t = 500
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(false)
    expect(FRAME_BUCKET).toEqual([60, 20])
  })
})

describe('G5 frame CSP (client-side; Platform ruling)', () => {
  it('is exactly this policy: attribute styles allowed; style elements and scripts nonce-only', () => {
    expect(frameCsp('N')).toBe(
      "default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; style-src-attr 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'",
    )
    const files = { 'index.html': '<html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>', 'app.js': '', 'style.css': '' }
    const d = appDocument(files, 'https://hive.example.test', ch, ch)
    expect(d.html).toContain('style-src-attr &#39;unsafe-inline&#39;')
    expect(d.html).not.toContain('script-src &#39;unsafe-inline')
    expect(d.html).not.toMatch(/style-src &#39;unsafe-inline/)
  })
})
