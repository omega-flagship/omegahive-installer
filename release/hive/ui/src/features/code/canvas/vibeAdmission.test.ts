import { afterEach, describe, expect, it, vi } from 'vitest'

// vibe-intents r2 [P1]: a vibe request's intent rides ONLY on the exact Ask operation the hive admitted the person's
// words under (store/ask `admit`, via askBridge `admittedTurn`). Failed, unsupported, capped and held steers, refusals
// and a change of person admit nothing, and an unrelated open turn is never used. A hand-made Ask client (invented
// data, no network), as store/ask.test.ts plays it.
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1440, innerHeight: 900 })

const { AskRefusal } = await import('../../../api/ask')
const { useHive } = await import('../../../store/store')
const { STEERS_PER_TURN, useAskStore } = await import('../../../store/ask')
const { admittedTurn } = await import('./askBridge')
const { SimCodeService } = await import('../../../api/sim/codeService')
const { intentsKit } = await import('./vibeIntents.testkit')
const { VibeSession } = await import('./vibeSession')
type HiveClient = import('../../../api/client').HiveClient
type WorkspaceHead = import('../suggestions/contract').WorkspaceHead

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
const CTX = { route: 'code', experience: 'classic' } as const
function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', thread, state: 'thinking', events: [], more: false })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string }) => ({ steer_id: b.steer_id, operation_id: op })),
    ...over,
  } as unknown as HiveClient
}
let n = 0
function start(client: HiveClient, principal = 'user:p_ada') {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session!, principal)
}
afterEach(() => useAskStore.getState().reset())
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

describe('admittedTurn: only the exact admitted operation', () => {
  it('a new turn the hive admitted: exactly its operation id', async () => {
    const c = fakeClient()
    start(c)
    const op = await admittedTurn('fix the sum', CTX)
    expect(op).toBe((c.ask as ReturnType<typeof vi.fn>).mock.calls[0][0].operation_id)
  })
  it('a steer the hive took on the open turn: that turn', async () => {
    const c = fakeClient()
    start(c)
    const open = await admittedTurn('first words', CTX)
    expect(useAskStore.getState().open).toBe(open)
    expect(await admittedTurn('fix the sum', CTX)).toBe(open)
    expect(c.askSteer).toHaveBeenCalledTimes(1)
  })
  it('a failed steer: refused, nothing admitted', async () => {
    start(fakeClient({ askSteer: vi.fn(async () => Promise.reject(new Error('network'))) }))
    await admittedTurn('first words', CTX)
    const e = await refusal(admittedTurn('fix the sum', CTX))
    expect(e).toBeInstanceOf(AskRefusal)
    expect(e).toMatchObject({ code: 'failed' })
  })
  it('a hive that takes no steers (unsupported): refused', async () => {
    start(fakeClient({ askSteer: undefined }))
    await admittedTurn('first words', CTX)
    expect(await refusal(admittedTurn('fix the sum', CTX))).toMatchObject({ code: 'unsupported' })
  })
  it('a capped turn (too many steers): refused', async () => {
    start(fakeClient())
    const op = await admittedTurn('first words', CTX)
    useAskStore.setState((s) => ({ turns: { ...s.turns, [op]: { ...s.turns[op], steers: Array.from({ length: STEERS_PER_TURN }, (_, i) => ({ steer_id: `s${i}`, text: 'x', at_seq: 0, state: 'sent' as const })) } } }))
    expect(await refusal(admittedTurn('fix the sum', CTX))).toMatchObject({ code: 'capped' })
  })
  it('a held steer (the last request’s admission is still being checked): refused, the words only held', async () => {
    start(fakeClient())
    const op = await admittedTurn('first words', CTX)
    useAskStore.setState((s) => ({ turns: { ...s.turns, [op]: { ...s.turns[op], state: 'checking' as const } } }))
    expect(await refusal(admittedTurn('fix the sum', CTX))).toMatchObject({ code: 'held' })
    expect(useAskStore.getState().turns[op].held).toHaveLength(1)
  })
  it('a refused Ask while another of the person’s turns is in flight (ask_busy): that unrelated turn is never used', async () => {
    start(fakeClient({ ask: vi.fn(async () => Promise.reject(new AskRefusal(409, 'ask_busy', 'busy', { operation_id: 'ask:other-tab' }))) }))
    const e = await refusal(admittedTurn('fix the sum', CTX))
    expect(e).toMatchObject({ code: 'refused' })
    await vi.waitFor(() => expect(useAskStore.getState().open).toBe('ask:other-tab'))
  })
  it('the person changes while the steer is in flight: nothing admitted for anyone', async () => {
    const c = fakeClient()
    start(c)
    await admittedTurn('first words', CTX)
    c.askSteer = vi.fn(async (op: string, b: { steer_id: string }) => {
      start(fakeClient(), 'user:p_bo')
      return { steer_id: b.steer_id, operation_id: op }
    }) as unknown as HiveClient['askSteer']
    expect(await refusal(admittedTurn('fix the sum', CTX))).toBeInstanceOf(AskRefusal)
  })
})

describe('the vibe request: no admission, no intent', () => {
  it('a failed steer under the canvas: the request stops, nothing is recorded or submitted', async () => {
    start(fakeClient({ askSteer: vi.fn(async () => Promise.reject(new Error('network'))) }))
    await admittedTurn('first words', CTX)
    const svc = new SimCodeService({ workspace_id: 'ws_adm', task_id: 'g_adm' })
    const ws = (await svc.proxy('GET', '/v1/workspaces/ws_adm', {}, null)) as WorkspaceHead
    const kit = intentsKit(svc, { ctx: { task_id: 'g_adm', grant_id: 'gr', repository_id: 'sim-suggestions' } })
    const f = (await svc.proxy('GET', '/v1/workspaces/ws_adm/files', { path: 'calculator.py' }, null)) as { content: string; digest: string }
    const session = new VibeSession(undefined, { pollMs: [5] })
    session.setDeps({ client: kit.client, ctx: { task_id: 'g_adm', grant_id: 'gr', repository_id: 'sim-suggestions' }, ws, onWorkspace: async () => undefined, turn: (w) => admittedTurn(w, CTX) })
    await session.ask('fix the sum', null, { path: 'calculator.py', content: f.content, digest: f.digest }, false, () => 'Anvil', true)
    expect(session.getState().phase.kind).toBe('error')
    expect(kit.log.some((l) => /\/intents$/.test(l) && l.startsWith('POST'))).toBe(false)
    expect(kit.log.some((l) => l.endsWith('/submit'))).toBe(false)
  })
})
