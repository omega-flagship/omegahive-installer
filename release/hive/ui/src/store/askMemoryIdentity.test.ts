import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Ask's own memory across identity changes (stand-in r1 P2, "forget everything" bound to its owner), driven by
 * the identity-epoch test kit: the REAL store identity change, synthetic SimClients, invented memories only.
 *
 * The confirm dialog is played by hand here: its "yes" can arrive after the identity changed (a click racing the
 * change), which the real dialog cannot be made to do from a test.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

const asked: { message: string; signal?: AbortSignal; resolve: (ok: boolean) => void }[] = []
vi.mock('../ui/confirm', () => ({
  askConfirm: (message: string, _label?: string, opts: { signal?: AbortSignal } = {}) => new Promise<boolean>((resolve) => asked.push({ message, signal: opts.signal, resolve })),
  confirmShowing: () => null,
  onConfirmChange: () => () => undefined,
  ConfirmHost: () => null,
}))

const { useHive } = await import('./store')
const { useAskStore } = await import('./ask')
const { askMemory, AskMemoryStore, dbName, hiveKey } = await import('../lib/askMemory')
const { bindEpoch, onIdentityChange } = await import('../lib/identityEpoch')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
const { confirmForgetAll, onMemoryFocus, openAskMemory, takeMemoryFocus } = await import('../features/ask/memoryNav')

askMemory.connectIdentity({ bind: bindEpoch, onIdentityChange })

const frame = (turn: string, statement: string) => ({ turn_id: turn, seq: 2, op: 'remember' as const, digest: 'd', target_id: null, item: { statement, kind: 'preference' as const, truth: { frequency: 1, confidence: 0.8 } } })
async function bindAs(principal: string) {
  useAskStore.getState().bind(useHive.getState().session, principal)
  await askMemory.whenReady()
}
const statements = () => askMemory.getView().beliefs.map((b) => b.statement)

beforeEach(() => {
  asked.length = 0
})
afterEach(async () => {
  await askMemory.flushed()
  useAskStore.getState().reset()
  releasePersons()
})

describe('stand-in r1 P2: forget everything is bound to the person it was asked for', () => {
  it('start forget-all for A, switch to B, then "yes": B’s memory is untouched, and so is A’s', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    await bindAs('user:p_inv_a')
    askMemory.receive(frame('turn_a', 'Invented A prefers tea'), { privatePage: false, since: askMemory.turnMark() })
    await askMemory.flushed()
    const answer = confirmForgetAll(1)
    expect(asked).toHaveLength(1)

    const done = switchPerson(a, b)
    // the identity change empties A's memory at once and answers the open question "no" through its signal
    expect(askMemory.getView().beliefs).toEqual([])
    expect(asked[0].signal?.aborted).toBe(true)
    await done
    await bindAs('user:p_inv_b')
    askMemory.receive(frame('turn_b', 'Invented B prefers coffee'), { privatePage: false, since: askMemory.turnMark() })
    await askMemory.flushed()

    asked[0].resolve(true) // a "yes" arriving after the change
    expect(await answer).toBe(false)
    await askMemory.flushed()
    expect(statements()).toEqual(['Invented B prefers coffee'])
    // B's database still holds B's belief; A's still holds A's (nobody asked for B's, and A's answer came too late)
    const hive = hiveKey(useHive.getState().client?.mode ?? 'live')
    const fresh = new AskMemoryStore({ persist: () => undefined, channel: null })
    fresh.use({ principal: 'user:p_inv_b', hive })
    await fresh.whenReady()
    expect(fresh.getView().beliefs.map((x) => x.statement)).toEqual(['Invented B prefers coffee'])
    fresh.use({ principal: 'user:p_inv_a', hive })
    await fresh.whenReady()
    expect(fresh.getView().beliefs.map((x) => x.statement)).toEqual(['Invented A prefers tea'])
    expect(dbName({ principal: 'user:p_inv_a', hive })).not.toBe(dbName({ principal: 'user:p_inv_b', hive }))
    fresh.use(null)
  })

  it('switching away and back before "yes" forgets nothing either (the owner it was asked for has gone and returned)', async () => {
    const a = testPerson('a2')
    const b = testPerson('b2')
    await signInAs(a)
    await bindAs('user:p_inv_a2')
    askMemory.receive(frame('turn_a2', 'Invented A2 likes maps'), { privatePage: false, since: askMemory.turnMark() })
    await askMemory.flushed()
    const answer = confirmForgetAll(1)
    await switchPerson(a, b)
    await switchPerson(b, a)
    await bindAs('user:p_inv_a2')
    asked[0].resolve(true)
    expect(await answer).toBe(false)
    expect(statements()).toEqual(['Invented A2 likes maps'])
  })

  it('"yes" with no change forgets everything', async () => {
    const a = testPerson('a3')
    await signInAs(a)
    await bindAs('user:p_inv_a3')
    askMemory.receive(frame('turn_a3', 'Invented A3 likes rain'), { privatePage: false, since: askMemory.turnMark() })
    const answer = confirmForgetAll(1)
    asked[0].resolve(true)
    expect(await answer).toBe(true)
    expect(statements()).toEqual([])
  })
})

describe('stand-in r1 accessibility: Memory pressed while already on #/me', () => {
  it('the mounted section is told, and takes the focus', async () => {
    let took = 0
    const off = onMemoryFocus(() => (takeMemoryFocus() ? took++ : undefined))
    loc.hash = '#/me'
    openAskMemory()
    await Promise.resolve()
    off()
    expect(took).toBe(1)
  })
})
