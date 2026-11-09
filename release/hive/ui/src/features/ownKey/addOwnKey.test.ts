import { describe, expect, it, vi } from 'vitest'

/**
 * The one add-your-key step's calls (addOwnKey.ts), against invented clients: the two calls, the one-call host, a total
 * set meanwhile (kept for fresh consent, never overwritten), a key saved with its answer lost (reconciled, never added
 * twice), the limit refused or unconfirmed, and the chain stopped by a sign-in change while a call is held.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
const kv = new Map<string, string>()
const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: storage })
vi.stubGlobal('localStorage', storage)

const { ApiError } = await import('../../api/client')
const { bindOperation } = await import('../../lib/boundOperation')
const { useHive } = await import('../../store/store')
const { initialState, keepGoverning, keySetupFrom, limitOnlySetup, submitOwnKey, suggestedFrom, KEY_UNCONFIRMED_WORDS, LIMIT_REFUSED_WORDS } = await import('./addOwnKey')
type KeySetup = import('./addOwnKey').KeySetup

const SETUP: KeySetup = { provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 }
const KEY = { id: 'k_0000beef', provider: 'openrouter', provider_label: 'OpenRouter', label: 'mine', owner: 'user:u_ann', hint: '…0001', default: false, created_at: 1, spent_usd: 0, minds: [] }
const SECRET = 'sk-or-ann-invented-0001'

/** an invented hive: her keys (exact secrets, as the host holds them) and her total; the PUT honours expected_month_usd
 *  (ownhive.set_total_if) and a duplicate of her own exact key is marked own (providers.own_key), as the host does */
function hive(o: { add?: () => Promise<unknown>; put?: (b: { month_usd: number }) => Promise<unknown>; total?: number | null; keys?: { provider: string; secret: string; owner?: string }[] } = {}) {
  const calls: string[] = []
  const state = { total: o.total ?? null as number | null, keys: o.keys ?? [] as { provider: string; secret: string; owner?: string }[] }
  const io = {
    addKey: vi.fn(async (b: Record<string, unknown>) => {
      calls.push('add ' + JSON.stringify(b))
      if (o.add) return (await o.add()) as never
      const same = state.keys.find((k) => k.provider === b.provider && k.secret === b.key)
      if (same) throw new ApiError(409, 'duplicate_key', 'that key is already saved', { envelope: { code: 'duplicate_key', ...(same.owner ? {} : { own: true, key_id: 'k_x' }) } })
      state.keys.push({ provider: String(b.provider), secret: String(b.key) })
      return KEY as never
    }),
    read: vi.fn(async () => {
      calls.push('read')
      return { keys: state.keys.map((k, i) => ({ id: `k_${i}`, label: 'x', provider: k.provider, hint: '…' + k.secret.slice(-4) })), own: state.total === null ? [] : [{ key_id: '*', month_usd: state.total, active: true, spent_usd: 0 }], suggested_month_usd: 50 }
    }),
    writeLimit: vi.fn(async (b: { key_id: '*'; month_usd: number; expected_month_usd: number | null }) => {
      calls.push('put ' + JSON.stringify(b))
      if (o.put) await o.put(b)
      if (b.expected_month_usd !== state.total) throw new ApiError(409, 'limit_changed', 'changed', { envelope: { code: 'limit_changed', monthly_total_usd: state.total } })
      state.total = b.month_usd
      return {}
    }),
  }
  return { io, calls, state }
}
const op = () => bindOperation(() => true)
const writes = (calls: string[]) => calls.filter((c) => !c.startsWith('read'))

describe('the one add-your-key step', () => {
  it('two calls on a hive without the one-call total: the key, the limit (read first, read back), then done', async () => {
    const { io, calls } = hive()
    expect(await submitOwnKey(op(), io, SETUP, { key: `  ${SECRET}  `, month: '50' }, initialState(SETUP))).toEqual({ phase: 'done', keySaved: true, error: null })
    expect(calls).toEqual([`add {"provider":"openrouter","key":"${SECRET}","month_usd":50}`, 'read', 'put {"key_id":"*","month_usd":50,"expected_month_usd":null}', 'read'])
  })

  it('a host that wrote the total in the same call (monthly_total_applied: true) gets no second write', async () => {
    const { io, calls } = hive({ add: async () => ({ ...KEY, monthly_total_applied: true, monthly_total_usd: 50 }) })
    expect((await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))).phase).toBe('done')
    expect(writes(calls)).toHaveLength(1)
  })

  it('sol P2: an explicit false is a newer total the host kept: shown for fresh consent, never overwritten', async () => {
    const { io, calls } = hive({ add: async () => ({ ...KEY, monthly_total_applied: false, monthly_total_usd: 8 }), total: 8 })
    const out = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(out).toEqual({ phase: 'confirm-limit', keySaved: true, error: null, governingUsd: 8 })
    expect(calls).toEqual([`add {"provider":"openrouter","key":"${SECRET}","month_usd":50}`])   // the answer says it all: not even a read
    expect((await keepGoverning(op(), io, out)).phase).toBe('done')                     // "keep it": still no write
    expect(writes(calls).filter((c) => c.startsWith('put'))).toEqual([])
    expect((await submitOwnKey(op(), io, SETUP, { key: '', month: '50', replace: true }, out)).phase).toBe('done')   // "set mine"
    expect(writes(calls).at(-1)).toBe('put {"key_id":"*","month_usd":50,"expected_month_usd":8}')   // only over the $8 she saw
    expect(writes(calls).filter((c) => c.startsWith('add'))).toHaveLength(1)
  })

  it('sol P2: on a two-call host, a total set meanwhile is read before the PUT and kept for fresh consent', async () => {
    const { io, calls } = hive({ total: 8 })
    const out = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(out).toMatchObject({ phase: 'confirm-limit', governingUsd: 8 })
    expect(writes(calls).filter((c) => c.startsWith('put'))).toEqual([])
  })

  it('the limit refused: "set limit" state, never done; a resubmit only retries the limit', async () => {
    let fail = true
    const { io, calls } = hive({ put: async () => { if (fail) throw new ApiError(400, 'bad_limit', 'no') } })
    const first = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(first).toEqual({ phase: 'needs-limit', keySaved: true, error: LIMIT_REFUSED_WORDS })
    fail = false
    expect((await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '40' }, first)).phase).toBe('done')
    expect(writes(calls).filter((c) => c.startsWith('add'))).toHaveLength(1)           // the key is never added twice
    expect(writes(calls).at(-1)).toBe('put {"key_id":"*","month_usd":40,"expected_month_usd":null}')
  })

  it('sol R2 P2: the key committed but its answer lost: "unconfirmed"; sending again meets her own exact key, then the limit', async () => {
    let lose = true
    const { io, calls, state } = hive({ add: async () => { if (lose) { lose = false; state.keys.push({ provider: 'openrouter', secret: SECRET }); throw new TypeError('Failed to fetch') } throw new ApiError(409, 'duplicate_key', 'x', { envelope: { code: 'duplicate_key', own: true, key_id: 'k_x' } }) } })
    const first = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(first).toEqual({ phase: 'ask', keySaved: false, error: KEY_UNCONFIRMED_WORDS })
    expect((await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, first)).phase).toBe('done')
    expect(state.keys).toHaveLength(1)                                                   // stored once
    expect(writes(calls).filter((c) => c.startsWith('put'))).toHaveLength(1)
  })

  it('sol R2 P2: duplicate_key for SOMEONE ELSE\'s copy with the same last four is refused, never "saved"', async () => {
    const { io, calls } = hive({ keys: [{ provider: 'openrouter', secret: SECRET, owner: 'user:u_bob' }] })
    const out = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(out).toMatchObject({ phase: 'ask', keySaved: false })
    expect(out.error).toMatch(/already saved in this hive/)
    expect(writes(calls).filter((c) => c.startsWith('put'))).toEqual([])
  })

  it('sol R2 P2: a total set between the read and the PUT is not overwritten: 409, back to her with the new figure', async () => {
    const { io, calls, state } = hive({ put: async () => { if (state.total === null) state.total = 8 } })   // lands in between
    const out = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(out).toEqual({ phase: 'confirm-limit', keySaved: true, error: null, governingUsd: 8 })
    expect(state.total).toBe(8)
    expect(writes(calls).filter((c) => c.startsWith('add'))).toHaveLength(1)
  })

  it('sol R2 P2: "set mine instead" is conditional too: a change after she chose goes back to her again', async () => {
    const { io, state } = hive({ total: 8 })
    const shown = await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    expect(shown).toMatchObject({ phase: 'confirm-limit', governingUsd: 8 })
    state.total = 12                                                                      // someone else, meanwhile
    expect(await submitOwnKey(op(), io, SETUP, { key: '', month: '50', replace: true }, shown)).toEqual({ phase: 'confirm-limit', keySaved: true, error: null, governingUsd: 12 })
    expect(state.total).toBe(12)
  })

  it('a key the provider rejects: the sheet stays on the key, with the reason, and nothing else is called', async () => {
    const { io, calls } = hive({ add: async () => { throw new ApiError(401, 'bad_key', 'OpenRouter rejected that key') } })
    expect(await submitOwnKey(op(), io, SETUP, { key: 'nope-nope', month: '50' }, initialState(SETUP))).toMatchObject({ phase: 'ask', keySaved: false })
    expect(calls).toHaveLength(1)
  })

  it('someone with a monthly total already is asked for the key alone (no limit call)', async () => {
    const { io, calls } = hive()
    expect((await submitOwnKey(op(), io, { ...SETUP, hasTotal: true, suggestedMonthUsd: null }, { key: SECRET, month: '' }, initialState(SETUP))).phase).toBe('done')
    expect(calls).toEqual([`add {"provider":"openrouter","key":"${SECRET}"}`])
  })

  it('sol P1: a sign-in change while the key\'s answer is held stops the chain: no read, no limit, "stopped"', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const { io, calls } = hive({ add: async () => { await held; return KEY } })
    const pending = submitOwnKey(bindOperation(() => true), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))
    useHive.setState({ inits: useHive.getState().inits + 1 })                          // another person signs in
    release()
    expect((await pending).phase).toBe('stopped')
    expect(calls).toEqual([`add {"provider":"openrouter","key":"${SECRET}","month_usd":50}`])
  })

  it('sol P1: the sheet going away while the answer is held stops the chain the same way', async () => {
    let alive = true
    const { io, calls } = hive({ add: async () => { alive = false; return KEY } })
    expect((await submitOwnKey(bindOperation(() => alive), io, SETUP, { key: SECRET, month: '50' }, initialState(SETUP))).phase).toBe('stopped')
    expect(writes(calls)).toHaveLength(1)
  })

  it('nothing is sent for an empty key or a limit that is not an amount', async () => {
    const { io, calls } = hive()
    expect((await submitOwnKey(op(), io, SETUP, { key: '  ', month: '50' }, initialState(SETUP))).error).toBe('Paste your OpenRouter key.')
    expect((await submitOwnKey(op(), io, SETUP, { key: 'sk', month: 'lots' }, initialState(SETUP))).error).toMatch(/monthly limit/)
    expect(calls).toEqual([])
    expect((await submitOwnKey(op(), io, SETUP, { key: SECRET, month: '12.345' }, initialState(SETUP))).error).toMatch(/monthly limit/)   // keys/ownLimit.parseLimit's rule
    expect(calls).toEqual([])
    expect([suggestedFrom({ suggested_month_usd: 50 }), suggestedFrom({}), suggestedFrom({ suggested_month_usd: -1 })]).toEqual([50, null, null])
  })

  it('the missing monthly total alone: the sheet opens on the limit, and writes only the limit', async () => {
    const { io, calls } = hive()
    const setup = limitOnlySetup()
    expect(setup.suggestedMonthUsd).toBeNull()                                           // the host's figure, not a fixed $50
    expect(initialState(setup)).toEqual({ phase: 'needs-limit', keySaved: true, error: null })
    expect((await submitOwnKey(op(), io, setup, { key: '', month: '50' }, initialState(setup))).phase).toBe('done')
    expect(writes(calls)).toEqual(['put {"key_id":"*","month_usd":50,"expected_month_usd":null}'])
  })

  it('reads the step from own_key_needed only, and only with a well-formed provider', () => {
    const body = (extra: object) => ({ error: { code: 'own_key_needed', ...extra } })
    const e = (b: { error: Record<string, unknown> }) => new ApiError(402, 'own_key_needed', 'x', { envelope: b.error, body: b })
    expect(keySetupFrom(e(body({ provider: 'openrouter', provider_label: 'OpenRouter', has_total: false, suggested_month_usd: 50 })))).toEqual(SETUP)
    expect(keySetupFrom(e(body({ provider: 'openrouter', has_total: true, suggested_month_usd: null })))).toMatchObject({ hasTotal: true, suggestedMonthUsd: null, providerLabel: 'openrouter' })
    expect(keySetupFrom(e(body({ provider: '<x>' })))).toBeNull()
    expect(keySetupFrom(e(body({})))).toBeNull()
    expect(keySetupFrom(new ApiError(402, 'spend_limit', 'x', { envelope: { provider: 'openrouter' } }))).toBeNull()
  })
})
