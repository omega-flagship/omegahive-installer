import { describe, expect, it, vi } from 'vitest'
import { APP_LINK_REASONS, parseAppLinkRequest, readAppLinkResult, setupRateLimit, untrustedViewIntent, readAppLinkEntry, readAppPresentation, installAppLinkPresentation, readUntrustedViewInput } from './appLinks'

describe('P12/P13 closed data contract (no authority)', () => {
  it('parses setup without accepting caller-provided card or identity fields', () => {
    expect(parseAppLinkRequest({ type: 'app-setup', id: 's1', app: 'target-fixture' })).toEqual({ ok: true, msg: { type: 'app-setup', id: 's1', app: 'target-fixture' } })
    for (const extra of ['name', 'minds', 'key', 'limits', 'principal', 'activation', 'generation', 'first_session_token']) {
      expect(parseAppLinkRequest({ type: 'app-setup', id: 's1', app: 'target-fixture', [extra]: true })).toMatchObject({ ok: false })
    }
  })
  it('keeps optional open intent separate and bounds Unicode characters', () => {
    const intent = '🌱'.repeat(200)
    expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app: 'target-fixture', intent })).toMatchObject({ ok: true, msg: { intent } })
    expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app: 'target-fixture', intent: intent + 'x' })).toMatchObject({ ok: false })
    expect(parseAppLinkRequest({ type: 'app-setup', id: 's1', app: 'target-fixture', intent: 'not permitted' })).toMatchObject({ ok: false })
  })
  it('does not invent a self-open ban or silently repair malformed selectors', () => {
    expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app: 'caller-fixture' })).toMatchObject({ ok: true })
    for (const app of ['', 'Target', '../target', 'x', 'a'.repeat(42)]) expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app })).toMatchObject({ ok: false })
    expect(parseAppLinkRequest({ type: 'read', id: 'r1' })).toBeNull()
  })
  it('bounds the full envelope and rejects malformed channels or circular data', () => {
    expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app: 'target-fixture', channel: '12345678-1234-1234-1234-123456789abc' })).toMatchObject({ ok: true })
    for (const channel of [true, {}, 'x'.repeat(3_000)]) expect(parseAppLinkRequest({ type: 'app-open', id: 'o1', app: 'target-fixture', channel })).toMatchObject({ ok: false })
    const value: Record<string, unknown> = { type: 'app-open', id: 'o1', app: 'target-fixture' }
    value.intent = value
    expect(parseAppLinkRequest(value)).toMatchObject({ ok: false })
  })
  it('accepts only the exact result states and six specified refusal reasons', () => {
    for (const state of ['ready', 'declined', 'needs_grown_up']) expect(readAppLinkResult({ state })).toEqual({ state })
    for (const reason of APP_LINK_REASONS) expect(readAppLinkResult({ state: 'refused', reason })).toEqual({ state: 'refused', reason })
    for (const value of [{ state: 'pending_adult' }, { state: 'ready', reason: 'depth' }, { state: 'refused', reason: 'self' }, { state: 'refused', reason: 'expired' }]) expect(readAppLinkResult(value)).toBeNull()
  })
  it('rejects backend details rather than forwarding another app ids, keys or contents', () => {
    for (const key of ['swarm_id', 'minds', 'key_id', 'month_usd', 'card', 'error', 'contents']) expect(readAppLinkResult({ state: 'ready', [key]: 'secret' })).toBeNull()
  })
  it('keeps one shared P12 call window across targets with no early refill', () => {
    let now = 0
    const take = setupRateLimit(() => now)
    expect([take(), take(), take(), take()]).toEqual([true, true, true, false])
    now = 59_999; expect(take()).toBe(false)
    now = 60_000; expect(take()).toBe(true)
  })
  it('does not refund calls when the injected clock moves backwards or becomes invalid', () => {
    let now = 10
    const take = setupRateLimit(() => now)
    expect(take()).toBe(true)
    now = 0; expect(take()).toBe(false)
    now = NaN; expect(take()).toBe(false)
    now = 10; expect([take(), take(), take()]).toEqual([true, true, false])
  })
  it('constructs an immutable, exact view-only intent object, never action params', () => {
    const input = untrustedViewIntent('try denied-skill')
    expect(input).toEqual({ untrusted_intent: 'try denied-skill' })
    expect(Object.isFrozen(input)).toBe(true)
    expect(untrustedViewIntent(undefined)).toBeNull()
    expect(() => untrustedViewIntent('x'.repeat(201))).toThrow()
  })
})

describe('P13 fresh-document presentation ABI and untrusted input', () => {
  it('never coerces absent/non-string host entry selectors into valid ids', () => {
    const entry = { id: 'host-pass', app: 'target-fixture', swarm_id: 'target-swarm', name: 'Pinned target', back_name: 'Pinned caller' }
    expect(readAppLinkEntry(entry)).toEqual(entry)
    for (const key of ['id', 'app', 'swarm_id']) for (const value of [null, undefined, true, {}]) expect(readAppLinkEntry({ ...entry, [key]: value })).toBeNull()
  })
  it('keeps only versioned JSON within the byte, node and depth bounds', () => {
    expect(readAppPresentation({ version: 1, state: { tab: 'draft', scroll: 23 } })).toEqual({ version: 1, state: { tab: 'draft', scroll: 23 } })
    expect(readAppPresentation({ version: 2, state: {} })).toBeNull()
    expect(readAppPresentation({ version: 1, state: '🌱'.repeat(20_000) })).toBeNull()
    expect(readAppPresentation({ version: 1, state: Array(4097).fill(null) })).toBeNull()
    let nested: unknown = 'leaf'
    for (let i = 0; i < 18; i++) nested = { inner: nested }
    expect(readAppPresentation({ version: 1, state: nested })).toBeNull()
  })
  it('rejects retained authority and prototype-shaped data at every nesting level', () => {
    for (const key of ['token', 'confirm_token', 'key_id', 'principal', 'actor', 'channel', 'generation_id', 'consent_epoch', 'authority', 'lease', 'capabilities', 'swarm_id', 'untrusted_intent']) expect(readAppPresentation({ version: 1, state: { view: [{ [key]: 'old-authority' }] } })).toBeNull()
    expect(readAppPresentation(JSON.parse('{"version":1,"state":{"__proto__":{"admin":true}}}'))).toBeNull()
    expect(readAppPresentation({ version: 1, state: { run: () => true } })).toBeNull()
  })
  it('restores only from the exact parent/origin/fresh channel and removes its listener', () => {
    let receive: ((event: MessageEvent) => void) | null = null
    const parent = { postMessage: vi.fn() }, restore = vi.fn(), capture = vi.fn(() => ({ tab: 'notes' }))
    const remove = vi.fn(), host = 'http://127.0.0.1:8700', channel = '12345678-1234-1234-1234-123456789abc'
    vi.stubGlobal('window', { parent, addEventListener: (_: string, fn: (event: MessageEvent) => void) => { receive = fn }, removeEventListener: remove })
    try {
      const off = installAppLinkPresentation({ hostOrigin: host, channel, capture, restore })
      const send = (source: unknown, origin: string, data: object) => receive!({ source, origin, data } as MessageEvent)
      const frame = { type: 'presentation-restore', channel, version: 1, state: { tab: 'notes' } }
      send({}, host, frame); send(parent, 'https://foreign.test', frame); send(parent, host, { ...frame, channel: 'old-channel' })
      expect(restore).not.toHaveBeenCalled()
      send(parent, host, frame); expect(restore).toHaveBeenCalledWith({ tab: 'notes' })
      send(parent, host, { type: 'presentation-snapshot', channel, id: 'request-one' })
      expect(parent.postMessage).toHaveBeenCalledWith({ type: 'presentation-state', channel, id: 'request-one', version: 1, state: { tab: 'notes' } }, host)
      off(); expect(remove).toHaveBeenCalledWith('message', receive)
    } finally { vi.unstubAllGlobals() }
  })
  it('marks target intent non-authoritative and rejects attempts to upgrade it', () => {
    const message = { type: 'app-view-input', input: { untrusted_intent: 'denied-skill' }, authoritative: false }
    const view = readUntrustedViewInput(message)
    expect(view).toEqual({ untrusted_intent: 'denied-skill', authoritative: false })
    expect(Object.isFrozen(view)).toBe(true)
    expect(readUntrustedViewInput({ ...message, authoritative: true })).toBeNull()
    expect(readUntrustedViewInput({ ...message, input: { untrusted_intent: 'x', action: 'run' } })).toBeNull()
  })
})
