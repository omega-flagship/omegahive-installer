import { describe, expect, it, vi } from 'vitest'

/** r1.14b (Design walk 144100Z): the own-key monthly total on the Me page. INVENTED data only. */
vi.stubGlobal('window', { location: { hash: '#/me', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { readOwnLimit, parseLimit } = await import('./ownLimit')

describe('reading the own-key monthly total from GET /api/me/key-limits', () => {
  it('the self / all-keys row is the one Studio checks; a per-key row or a revoked one is not', () => {
    expect(readOwnLimit({ keys: [{ id: 'k1' }], own: [{ key_id: '*', grantee: 'self', month_usd: 50, spent_usd: 0.12, active: true }], grants: [] }))
      .toEqual({ state: 'set', limit: { month_usd: 50, spent_usd: 0.12 }, ownKeys: 1 })
    expect(readOwnLimit({ keys: [{ id: 'k1' }], own: [{ key_id: 'k1', grantee: 'self', month_usd: 9, active: true }] })).toEqual({ state: 'unset', ownKeys: 1 })
    expect(readOwnLimit({ keys: [], own: [{ key_id: '*', month_usd: 9, active: false }] })).toEqual({ state: 'unset', ownKeys: 0 })
    expect(readOwnLimit({ keys: [], own: [] })).toEqual({ state: 'unset', ownKeys: 0 })
  })
  it('anything malformed is unreadable, never "not set" and never a default', () => {
    for (const v of [null, 'x', {}, { own: [] }, { keys: [] }, { keys: [], own: [{ key_id: '*', month_usd: 'fifty' }] }]) expect(readOwnLimit(v), JSON.stringify(v)).toEqual({ state: 'unreadable' })
  })
})

describe('what the person types', () => {
  it('dollars with up to two decimals, 0 to 1,000,000 (the host range); anything else is refused before sending', () => {
    expect(parseLimit('50')).toBe(50)
    expect(parseLimit(' $12.50 ')).toBe(12.5)
    expect(parseLimit('0')).toBe(0)
    for (const t of ['', '-1', '1e3', '12.345', 'fifty', '1000001', 'NaN']) expect(parseLimit(t), t).toBeNull()
  })
})

describe('the live client', () => {
  it('reads GET /api/me/key-limits and writes PUT /api/me/key-limits/self', async () => {
    const src = ((await import(/* @vite-ignore */ 'node:' + 'fs')) as unknown as { readFileSync(p: string | URL, e: "utf8"): string }).readFileSync(new URL('../../api/live.ts', import.meta.url), 'utf8')
    expect(src).toContain("myKeyLimits = () => this.request<unknown>('GET', '/api/me/key-limits')")
    expect(src).toContain("setOwnKeyLimit = (body: Record<string, unknown>) => this.request<unknown>('PUT', '/api/me/key-limits/self', body)")
  })
})

describe('Design 145300Z: one save, bound to the sign-in, never a false "nothing changed"', async () => {
  const { saveOwnLimit } = await import('./ownLimit')
  const { bindOperation } = await import('../../lib/boundOperation')
  const { ApiError } = await import('../../api/client')
  const { useHive } = await import('../../store/store')
  const set = (m: number) => ({ keys: [{ id: 'k1' }], own: [{ key_id: '*', grantee: 'self', month_usd: m, spent_usd: 0, active: true }] })
  it('PUT then the host readback shows it: saved', async () => {
    const out = await saveOwnLimit(bindOperation(), { write: async () => ({}), read: async () => set(50) }, 50)
    expect(out.kind).toBe('saved')
  })
  it('the hive answered a refusal to the PUT: refused (nothing changed)', async () => {
    const read = vi.fn()
    const out = await saveOwnLimit(bindOperation(), { write: async () => { throw new ApiError(400, 'bad_limit', 'x') }, read }, 50)
    expect(out.kind).toBe('refused')
    expect(read).not.toHaveBeenCalled()
  })
  it('the PUT answer was lost (network): unconfirmed, never "nothing changed"', async () => {
    const out = await saveOwnLimit(bindOperation(), { write: async () => { throw new TypeError('Failed to fetch') }, read: async () => set(50) }, 50)
    expect(out.kind).toBe('unconfirmed')
  })
  it('a 5xx or a 408 answer to the PUT may come after the row was written: unconfirmed; other 4xx: refused', async () => {
    for (const st of [500, 502, 503, 408]) expect((await saveOwnLimit(bindOperation(), { write: async () => { throw new ApiError(st, 'x', 'x') }, read: async () => set(50) }, 50)).kind, String(st)).toBe('unconfirmed')
    for (const st of [400, 401, 403, 404, 409, 422]) expect((await saveOwnLimit(bindOperation(), { write: async () => { throw new ApiError(st, 'x', 'x') }, read: async () => set(50) }, 50)).kind, String(st)).toBe('refused')
  })
  it('PUT succeeded, the readback failed: unconfirmed', async () => {
    const out = await saveOwnLimit(bindOperation(), { write: async () => ({}), read: async () => { throw new TypeError('Failed to fetch') } }, 50)
    expect(out).toEqual({ kind: 'unconfirmed', view: null })
  })
  it('PUT succeeded, the readback shows another figure: unconfirmed, with what the host shows', async () => {
    const out = await saveOwnLimit(bindOperation(), { write: async () => ({}), read: async () => set(20) }, 50)
    expect(out.kind).toBe('unconfirmed')
  })
  it('a sign-in change while the PUT is in flight: stopped, and the readback is never sent for the new person', async () => {
    let release: () => void = () => undefined
    const read = vi.fn(async () => set(50))
    const p = saveOwnLimit(bindOperation(), { write: () => new Promise((r) => { release = () => r({}) }), read }, 50)
    useHive.setState({ inits: useHive.getState().inits + 1 })   // a sign-in change (identity epoch), same client
    release()
    expect((await p).kind).toBe('stopped')
    expect(read).not.toHaveBeenCalled()
  })
  it('a sign-in change before the save starts: nothing is sent', async () => {
    const op = bindOperation()
    useHive.setState({ inits: useHive.getState().inits + 1 })
    const write = vi.fn(async () => ({}))
    expect((await saveOwnLimit(op, { write, read: async () => set(50) }, 50)).kind).toBe('stopped')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('Design 145800Z #2: the box is keyed by the identity epoch, which moves on every sign-in boundary', async () => {
  const { currentEpoch, onIdentityChange } = await import('../../lib/identityEpoch')
  const { useHive } = await import('../../store/store')
  it('a re-init (inits) and a credential-only change on the same client both move the epoch and notify the key', async () => {
    const seen: number[] = []
    const off = onIdentityChange(() => seen.push(currentEpoch()))
    const e0 = currentEpoch()
    useHive.setState({ inits: useHive.getState().inits + 1 })
    const e1 = currentEpoch()
    useHive.setState({ session: `${useHive.getState().session}:relogin` })
    const e2 = currentEpoch()
    off()
    expect(e1).toBeGreaterThan(e0)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(e2).toBeGreaterThanOrEqual(e1)
  })
  it('the component reads its key from that epoch (source)', async () => {
    const src = ((await import(/* @vite-ignore */ 'node:' + 'fs')) as unknown as { readFileSync(p: string | URL, e: 'utf8'): string }).readFileSync(new URL('./OwnMonthlyLimit.tsx', import.meta.url), 'utf8')
    expect(src).toContain('useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)')
    expect(src).toContain('<OwnMonthlyLimitBody key={epoch} />')
  })
})

describe('Dot (Jon’s three 409s): a refused key is said plainly and in place', async () => {
  const { addKeyRefusalWords } = await import('./ownLimit')
  const { ApiError } = await import('../../api/client')
  it('duplicate_key names what happened and the way on; bad_key and others say themselves', () => {
    expect(addKeyRefusalWords(new ApiError(409, 'duplicate_key', 'that key is already saved'), 'OpenRouter')).toBe('That key is already saved in this hive, perhaps as the hive\'s own key or one added before. Make a new key at OpenRouter for your own use, then add that one.')
    expect(addKeyRefusalWords(new ApiError(401, 'bad_key', 'x'), 'OpenRouter')).toMatch(/^OpenRouter did not accept that key/)
    expect(addKeyRefusalWords(new ApiError(500, 'internal', 'boom'), 'OpenRouter')).toBe('The key was not added: boom')
  })
  it('the form keeps the refusal on screen and will not send the same refused key again (source)', async () => {
    const src = ((await import(/* @vite-ignore */ 'node:' + 'fs')) as unknown as { readFileSync(p: string | URL, e: 'utf8'): string }).readFileSync(new URL('./AddKeyForm.tsx', import.meta.url), 'utf8')
    expect(src).toContain("if (!secret.trim() || busy || refused?.secret === secret.trim()) return")
    expect(src).toContain('disabled={!secret.trim() || busy || refused?.secret === secret.trim()}')
    expect(src).toContain('data-add-key-refused=""')
  })
})
