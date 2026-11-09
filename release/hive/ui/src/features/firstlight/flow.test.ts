import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewLook } from '../../shell/uiVariant'
import { DEMO_GREET_MS, DemoHost } from './demo'
import { BLANK_PROGRESS, FlRefusal, liveHost, type AppRef, type AskShape, type BoundWrite, type FlClient, type FlHost, type Hello, type HiveOwn, type MonthlyLimit, type Progress, type ProgressWrite, type Setup } from './host'
import { useHive } from '../../store/store'
import { ApiError } from '../../api/client'
import { LiveClient } from '../../api/live'
import { OperationStopped } from '../../lib/boundOperation'
import { identityKey } from '../../lib/identityEpoch'
import { autoHeld, firstLightLimitLine, setFlScreen, stepOf, useFirstLight, type FlScreen } from './store'
import { DEFAULT_ASK_PURPOSE, askToSave } from './host'
import { profileSaveCopy, spendingCopy } from './conditionalCopy'
import { enterFirstRun } from '../../tour/firstRun'

let scopeSerial = 0

/** A live-shaped host with scripted answers; it records every call (nothing reaches a hive). */
class FakeHost implements FlHost {
  readonly kind = 'live' as const
  private readonly scope = { host: `https://firstlight-${++scopeSerial}.invalid`, principal: 'user:invented' }
  retainedMutationScope() { return this.scope }
  calls: string[] = []
  p: Progress = { ...BLANK_PROGRESS }
  keys = 0
  own_: HiveOwn = { owner_name: 'Pip Lanternfield', you_are_owner: true, your_access: 'owner', visibility: 'private', pays: 'own-key' }
  limit: MonthlyLimit | null = null
  ownLimit: number | null = null
  helloNext: Hello | null = null
  wakeAnswer: (() => Hello) | null = null
  stale = false
  others = 0
  async progress() {
    this.calls.push('progress')
    return { ...this.p }
  }
  async writeProgress(w: ProgressWrite, version: number) {
    this.calls.push(`write:${JSON.stringify(w)}@${version}`)
    if (this.stale) {
      this.stale = false
      throw new FlRefusal(409, 'stale_onboarding', 'changed', { current: { ...this.p, status: 'in_progress', beats_done: ['arrive', 'look'], version: 7 } })
    }
    if (version !== this.p.version) throw new FlRefusal(409, 'stale_onboarding', 'changed', { current: { ...this.p } })
    this.p = { ...this.p, ...w, status: w.status ?? 'in_progress', version: this.p.version + 1 }
    return { ...this.p }
  }
  async setup(): Promise<Setup> {
    this.calls.push('setup')
    const l: MonthlyLimit | null =
      this.own_.your_access === 'guest'
        ? this.limit
        : this.keys > 0
          ? { done: this.ownLimit !== null, enforced: this.ownLimit !== null, enforced_by: this.ownLimit !== null ? 'own' : null, limit_usd: this.ownLimit, spent_usd: 0, chosen_usd: this.p.monthly_spend_usd, host_name: null, pending_request: null }
          : { done: this.p.monthly_spend_usd !== null, enforced: false, enforced_by: null, limit_usd: null, spent_usd: null, chosen_usd: this.p.monthly_spend_usd, host_name: null, pending_request: null }
    return { own_keys: this.keys, guest: this.own_.your_access === 'guest', limit: l, mind_awake: false, complete: false }
  }
  async own() {
    return this.own_
  }
  async personName() {
    return this.own_.your_access === 'guest' ? 'Juno Ashdown' : 'Pip Lanternfield'
  }
  async mind() {
    return { id: 'a_pipmind', name: 'Pip', status: 'asleep' }
  }
  otherMinds() {
    return this.others
  }
  async setOwnLimit(m: number) {
    this.calls.push(`setOwnLimit:${m}`)
    if (this.keys <= 0) throw new FlRefusal(403, 'key_owner_only', 'no')
    this.ownLimit = m
  }
  async askForMore(a: number) {
    this.calls.push(`ask:${a}`)
    return { id: 'lr_1', amount_usd: a, status: 'pending' as const }
  }
  async helloGet() {
    this.calls.push('helloGet')
    return this.helloNext
  }
  async helloWake() {
    this.calls.push('helloWake')
    if (!this.wakeAnswer) throw new Error('no answer scripted')
    return this.wakeAnswer()
  }
  apps_: AppRef[] = []
  how = ''
  saveRefusal: FlRefusal | null = null
  async apps() {
    this.calls.push('apps')
    return this.apps_.map((x) => ({ ...x }))
  }
  async askHow() {
    this.calls.push('askHow')
    return this.how
  }
  /** when set, saveAsk goes through the real live host over this client (identity-switch tests) */
  liveClient: FlClient | null = null
  async saveAsk(mindId: string, shape: AskShape, write: BoundWrite) {
    this.calls.push(`saveAsk:${mindId}:${JSON.stringify(shape)}`)
    if (this.liveClient) return liveHost(this.liveClient, () => 0).saveAsk(mindId, shape, write)
    if (this.saveRefusal) throw this.saveRefusal
    const mind = await write(async () => ({ id: mindId, name: shape.name, status: 'asleep' }))
    if (shape.how !== null) await write(async () => { this.how = shape.how! })
    await write(async () => undefined)
    return mind
  }
}

const moves: string[] = []
let saved = 'classic||'
const screen: FlScreen = {
  act: (a) => void moves.push(JSON.stringify(a)),
  gallery: (open) => void moves.push(`gallery:${open}`),
  galleryOpen: () => false,
  savedLook: () => saved,
  savedLookName: () => 'Cosmos',
  deviceOnly: () => false,
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise((r) => setTimeout(r, 0))
}
const g = () => useFirstLight.getState()
const at = () => stepOf(g().run)?.id

/** U1 uses the real store/coordinator. Only its host endpoints are scripted. */
class SingleHost extends FakeHost {
  model: string | null = 'provider/model-from-host'
  profileName = 'Pip'
  profileError = false
  constructor() {
    super()
    this.keys = 1
    this.wakeAnswer = () => ({ mind: { id: 'a_pipmind', name: this.profileName, status: 'awake' }, state: 'greeted', greeting: { id: 'm_u1', text: 'A recorded host reply.', created_at: null }, created: true, retryable: false, requested_at: null })
  }
  async profile(mindId: string) {
    this.calls.push(`profile:${mindId}`)
    if (this.profileError) throw new Error('synthetic unavailable profile')
    return { id: mindId, name: this.profileName, persona: this.how, model: this.model }
  }
}

/** Real liveHost adapters over distinct invented client instances; no Host/identity/store algorithm is replaced. */
type LimitWorld = { host: string; amount: number; calls: string[]; send: (amount: number) => Promise<void>; read?: () => Promise<number> }
function limitWorld(amount: number): LimitWorld {
  const world: LimitWorld = { host: `https://limit-${++scopeSerial}.invalid`, amount, calls: [], send: async (next) => { world.amount = next } }
  return world
}
function limitClient(world: LimitWorld, principal: string, proven = true): FlClient {
  return {
    retainedMutationScope: () => proven ? { host: world.host, principal } : null,
    onboarding: async () => ({ ...BLANK_PROGRESS }),
    mySetup: async () => {
      world.calls.push(`setup:${principal}`)
      const amount = world.read ? await world.read() : world.amount
      return { items: [
        { id: 'provider_key', done: true, detail: { own_keys: 1, guest: false } },
        { id: 'monthly_limit', done: true, enforced: true, detail: { enforced_by: 'own', limit_usd: amount, spent_usd: 0, chosen_usd: null } },
        { id: 'mind_awake', done: false, detail: {} },
      ], complete: false }
    },
    hiveOwn: async () => ({ owner_name: 'Invented', you_are_owner: true, your_access: 'owner', visibility: 'private', pays: 'own-key' }),
    me: async () => ({ person: { name: principal } }),
    myMind: async () => ({ mind: { id: 'mind_' + principal, name: principal, status: 'asleep' } }),
    getAgent: async (id) => ({ id, name: principal, persona: '', model: 'provider/model' }),
    programs: async () => [],
    setOwnKeyLimit: async (body) => {
      expect(body.key_id).toBe('*')
      expect(typeof body.month_usd).toBe('number')
      world.calls.push(`send:${principal}:${body.month_usd}`)
      await world.send(body.month_usd as number)
      return {}
    },
    personalMindHello: async () => { world.calls.push('unexpectedWake'); throw new Error('unexpected Wake') },
    renameMyMind: async () => { world.calls.push('unexpectedProfile'); throw new Error('unexpected profile write') },
  }
}
const pendingCopy = () => {
  const r = g().run!
  return spendingCopy(r.facts.limit, 9, r.u1!.limitPending ?? null, r.u1!.limitChecking === true && r.u1!.busy, r.u1!.limitUncertain)
}
const replaceIdentity = () => useHive.setState({ inits: useHive.getState().inits + 1 })

describe('sent limit reconciliation across pause and real adapter/client replacement', () => {
  it('records sent9 before dispatch settles, and a read begun while it is outstanding cannot resolve old5 uncertainty', async () => {
    const world = limitWorld(5)
    let releaseSend: () => void = () => undefined
    world.send = async (next) => { await new Promise<void>((resolve) => { releaseSend = resolve }); world.amount = next }
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    const old = g().wakeSingleScreen({ name: 'A', how: null }, 9)
    await flush()
    expect(world.calls).toContain('send:A:9')
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, limitChecking: true })
    g().toggle()
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, limitChecking: false, busy: false })
    expect(pendingCopy()).toBe("We couldn't confirm a spending limit here.")
    expect(pendingCopy()).not.toContain('$5')
    g().stop()
    let releaseRead: (amount: number) => void = () => undefined
    world.read = () => new Promise<number>((resolve) => { releaseRead = resolve })
    const reopen = g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    await flush()
    const newRun = g().run!.id
    releaseSend(); await old
    expect(g().run!.id).toBe(newRun)
    expect(g().run!.status).toBe('loading') // old finally did not finish the new read
    releaseRead(9); await reopen
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false })
    expect(pendingCopy()).toBe("We couldn't confirm a spending limit here.")
    world.read = undefined
    await g().reload()
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(pendingCopy()).toBe('Your minds may spend up to $9 a month.')
    expect(world.calls).not.toContain('unexpectedWake')
    expect(world.calls).not.toContain('unexpectedProfile')
  })

  it('A→B→A with new client and wrapper objects keeps A quarantined, never projects A9 into B, and isolates old finally', async () => {
    const a = limitWorld(5), b = limitWorld(3)
    b.host = a.host // same hive, distinct authenticated principals
    let finishA: () => void = () => undefined, finishB: () => void = () => undefined
    a.send = async (next) => { await new Promise<void>((resolve) => { finishA = resolve }); a.amount = next }
    b.send = async (next) => { await new Promise<void>((resolve) => { finishB = resolve }); b.amount = next }
    await g().start({ mode: 'live', host: liveHost(limitClient(a, 'A'), () => 0), singleScreen: true })
    const oldA = g().wakeSingleScreen({ name: 'A', how: null }, 9); await flush()
    replaceIdentity()
    await g().start({ mode: 'live', host: liveHost(limitClient(b, 'B'), () => 0), singleScreen: true })
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(g().run!.facts.limit!.limit_usd).toBe(3)
    const oldB = g().wakeSingleScreen({ name: 'B', how: null }, 11); await flush()
    expect(g().run!.u1!.limitPending).toBe(11)
    replaceIdentity()
    await g().start({ mode: 'live', host: liveHost(limitClient(a, 'A'), () => 0), singleScreen: true })
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false })
    expect(pendingCopy()).not.toContain('$5')
    expect(pendingCopy()).not.toContain('Checking')
    replaceIdentity()
    await g().start({ mode: 'live', host: liveHost(limitClient(b, 'B'), () => 0), singleScreen: true })
    expect(g().run!.u1!.limitPending).toBe(11)
    let readB: (amount: number) => void = () => undefined
    b.read = () => new Promise<number>((resolve) => { readB = resolve })
    const newB = g().wakeSingleScreen({ name: 'B', how: null }, 11); await flush()
    expect(g().run!.u1!.limitChecking).toBe(true)
    finishA(); await oldA
    expect(g().run!.u1).toMatchObject({ limitPending: 11, limitUncertain: true, limitChecking: true, busy: true })
    readB(3); await newB
    finishB(); await oldB
    b.read = undefined
    await g().reload()
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(a.calls).not.toContain('unexpectedWake')
    expect(b.calls).not.toContain('unexpectedWake')
    replaceIdentity()
    await g().start({ mode: 'live', host: liveHost(limitClient(a, 'A'), () => 0), singleScreen: true })
    expect(g().run!.u1!.limitUncertain).toBe(false) // ordinary matching read also reconciles A's settled write
  })

  it('a lost response retains unknown through new wrappers and mismatching readbacks until a fresh matching read', async () => {
    const world = limitWorld(5)
    world.send = async () => { throw new Error('invented lost reply; remote outcome unknown') }
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    await g().wakeSingleScreen({ name: 'A', how: null }, 9)
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, limitChecking: false, busy: false })
    expect(pendingCopy()).not.toContain('$5')
    g().stop()
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    await g().wakeSingleScreen({ name: 'A', how: null }, 9)
    expect(world.calls.filter((x) => x === 'send:A:9')).toHaveLength(1)
    expect(pendingCopy()).toBe("We couldn't confirm a spending limit here.")
    world.amount = 9 // invented delayed remote commit; not a cancellation/receipt assertion
    await g().reload()
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(pendingCopy()).toBe('Your minds may spend up to $9 a month.')
    expect(world.calls).not.toContain('unexpectedWake')
  })

  it('an unproved replacement scope gets only generic uncertainty, no A amount, and sends no mutation', async () => {
    const world = limitWorld(5)
    world.send = async () => { throw new Error('invented lost reply') }
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    await g().wakeSingleScreen({ name: 'A', how: null }, 9)
    g().stop()
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'unproved', false), () => 0), singleScreen: true })
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: true })
    await g().wakeSingleScreen({ name: 'unproved', how: null }, 7)
    expect(world.calls.filter((x) => x.startsWith('send:'))).toEqual(['send:A:9'])
    expect(pendingCopy()).toBe("We couldn't confirm a spending limit here.")
    world.amount = 9
    g().stop()
    await g().start({ mode: 'live', host: liveHost(limitClient(world, 'A'), () => 0), singleScreen: true })
    expect(g().run!.u1!.limitUncertain).toBe(false)
  })
})

describe('real LiveClient retained scope is correlated with the successful current me identity', () => {
  it('new client objects recover the same public host/principal scope only after successful me, and principal switch invalidates it', async () => {
    let principal = 'user:A'
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ principal, person: { name: principal } }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const a = new LiveClient('https://scope.invalid/hive/'), replacement = new LiveClient('https://scope.invalid/hive')
    try {
      expect(a.retainedMutationScope()).toBeNull()
      await a.me(); await replacement.me()
      expect(replacement.retainedMutationScope()).toEqual(a.retainedMutationScope())
      expect(a.retainedMutationScope()).toEqual({ host: 'https://scope.invalid/hive', principal: 'user:A' })
      principal = 'user:B'
      await expect(a.me()).rejects.toMatchObject({ code: 'auth_context_changed' })
      expect(a.retainedMutationScope()).toBeNull()
      await a.me()
      expect(a.retainedMutationScope()).toEqual({ host: 'https://scope.invalid/hive', principal: 'user:B' })
      expect(fetcher.mock.calls.every((args) => String(args[0]).endsWith('/api/auth/me'))).toBe(true)
    } finally { a.dispose(); replacement.dispose() }
  })

  it('logout invalidates cached scope and an older in-flight me cannot publish it under the new auth identity', async () => {
    let hold = false
    const releases: Array<(response: Response) => void> = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/auth/logout')) return new Response('{}')
      if (hold) return new Promise<Response>((resolve) => { releases.push(resolve) })
      return new Response(JSON.stringify({ principal: 'user:A', person: { name: 'A' } }), { headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const client = new LiveClient('https://old-me.invalid')
    try {
      await client.me(); expect(client.retainedMutationScope()).not.toBeNull()
      hold = true
      const old = client.me()
      const rejected = expect(old).rejects.toMatchObject({ code: 'auth_context_changed' })
      await flush()
      expect(client.retainedMutationScope()).toBeNull() // cached A is not usable during the pending identity read
      await client.logout()
      expect(client.retainedMutationScope()).toBeNull()
      const current = client.me()
      await flush()
      expect(releases).toHaveLength(2)
      releases[0](new Response(JSON.stringify({ principal: 'user:A', person: { name: 'A' } }), { headers: { 'Content-Type': 'application/json' } }))
      await rejected
      expect(client.retainedMutationScope()).toBeNull() // old finally cannot make the newer read look settled
      releases[1](new Response(JSON.stringify({ principal: 'user:B', person: { name: 'B' } }), { headers: { 'Content-Type': 'application/json' } }))
      await current
      expect(client.retainedMutationScope()).toEqual({ host: 'https://old-me.invalid', principal: 'user:B' })
    } finally { client.dispose() }
  })
})

/** Use the public journey state transitions/choose API, not a second test setter implementation. */
async function monthlyChoice(host: FakeHost) {
  await g().start({ mode: 'live', host, beat: 'models' })
  await nextTo('3.3')
  await g().checkKey()
  await flush()
  expect(at()).toBe('3.4')
}

describe('all reachable First Light own-limit writers share the same quarantine', () => {
  it('U1 sent9 blocks journey choose20 until settled matching readback, then the same public choose may send20', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    const actualSet = h.setOwnLimit.bind(h)
    let finish: () => void = () => undefined
    h.setOwnLimit = async (amount) => {
      h.calls.push(`dispatch:${amount}`)
      if (amount === 9) await new Promise<void>((resolve) => { finish = resolve })
      await actualSet(amount)
    }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const u1 = g().wakeSingleScreen({ name: 'Pip', how: null }, 9)
    await flush()
    expect(h.calls.filter((x) => x.startsWith('dispatch:'))).toEqual(['dispatch:9'])
    g().toggle()
    await monthlyChoice(h) // same path reached by the existing look/role journey action
    const current = g().run!.id
    await g().choose(20)
    expect(h.calls.filter((x) => x.startsWith('dispatch:'))).toEqual(['dispatch:9'])
    expect(g().run!.limit).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false })
    expect(firstLightLimitLine(g().run!)).toBe("We couldn't confirm a spending limit here.")
    expect(firstLightLimitLine(g().run!)).not.toContain('$5')
    finish(); await u1
    expect(g().run!.id).toBe(current)
    expect(g().run!.limit).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false })
    await g().checkKey() // fresh read begins after the original setter locally settles
    expect(g().run!.limit).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(g().run!.facts.limit!.limit_usd).toBe(9)
    await g().choose(20)
    expect(h.calls.filter((x) => x.startsWith('dispatch:'))).toEqual(['dispatch:9', 'dispatch:20'])
    expect(g().run!.limit).toMatchObject({ limitPending: null, limitUncertain: false, busy: false, error: null })
    expect(g().run!.facts.limit).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 20 })
    expect(firstLightLimitLine(g().run!)).toContain('$20')
    expect(at()).toBe('3.5')
    expect(h.calls).not.toContain('helloWake')
  })

  it('a journey-dispatched setter stays unknown across pause/reopen and its old finally cannot mutate the new U1 attempt', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    const set = h.setOwnLimit.bind(h)
    let finish: () => void = () => undefined
    h.setOwnLimit = async (amount) => { h.calls.push(`dispatch:${amount}`); await new Promise<void>((resolve) => { finish = resolve }); await set(amount) }
    await monthlyChoice(h)
    const choosing = g().choose(9)
    await flush()
    expect(g().run!.limit).toMatchObject({ busy: true, limitPending: 9, limitUncertain: true })
    g().toggle()
    expect(g().run!.limit).toMatchObject({ busy: false, limitPending: 9, limitUncertain: true })
    expect(firstLightLimitLine(g().run!)).not.toContain('$5')
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const newRun = g().run!.id
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false, limitChecking: false })
    const writes = h.calls.filter((x) => x.startsWith('write:')).length
    finish(); await choosing
    expect(g().run!.id).toBe(newRun)
    expect(g().run!.u1).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false, limitChecking: false })
    expect(h.calls.filter((x) => x.startsWith('write:'))).toHaveLength(writes)
    await g().reload()
    expect(g().run!.u1).toMatchObject({ limitPending: null, limitUncertain: false })
    expect(h.calls).not.toContain('helloWake')
  })

  it('a lost journey setter response cannot restore old5 or allow another setter/Wake before matching readback', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    const set = h.setOwnLimit.bind(h)
    h.setOwnLimit = async (amount) => { h.calls.push(`lost-dispatch:${amount}`); throw new Error('invented lost response') }
    await monthlyChoice(h)
    await g().choose(9)
    expect(g().run!.limit).toMatchObject({ limitPending: 9, limitUncertain: true, busy: false, error: "We couldn't confirm a spending limit here." })
    const progressWrites = h.calls.filter((x) => x.startsWith('write:')).length
    await g().checkKey()
    await g().choose(20)
    expect(h.calls.filter((x) => x.startsWith('lost-dispatch:'))).toEqual(['lost-dispatch:9'])
    expect(h.calls.filter((x) => x.startsWith('write:'))).toHaveLength(progressWrites)
    expect(firstLightLimitLine(g().run!)).not.toContain('$5')
    await g().goBeat('hello')
    await g().wake()
    expect(h.calls).not.toContain('helloWake')
    expect(g().run!.hello.refusal?.code).toBe('limit_unconfirmed')
    h.ownLimit = 9 // invented delayed remote commit, not proof of cancellation
    await monthlyChoice(h)
    h.setOwnLimit = set
    await g().choose(20)
    expect(h.calls).toContain('setOwnLimit:20')
    expect(g().run!.limit.limitUncertain).toBe(false)
  })

  it('the shared dispatch checks fresh current own-key context rather than granting a stale owner/enforcer write', async () => {
    for (const changed of ['guest', 'foreign-enforcer'] as const) {
      const h = new SingleHost()
      h.ownLimit = 5
      await monthlyChoice(h)
      if (changed === 'guest') h.own = async () => ({ ...h.own_, your_access: 'guest', you_are_owner: false })
      else {
        const setup = h.setup.bind(h)
        h.setup = async () => { const s = await setup(); return { ...s, limit: { ...s.limit!, enforced_by: 'invite' as const } } }
      }
      await g().choose(20)
      expect(h.calls.some((x) => x.startsWith('setOwnLimit:'))).toBe(false)
      expect(g().run!.limit.busy).toBe(false)
      expect(g().run!.limit.error).toBeTruthy()
      g().stop()
    }
  })
})

describe('U1: one explicit, person-bound profile and Wake chain', () => {
  it('reads the whole personal context without role/look navigation, writes or Wake', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    expect(g().run!.u1).toMatchObject({ context: 'known', model: h.model, phase: 'editing', busy: false })
    expect(g().run!.facts.askHow).toBe('')
    expect(g().run!.i).toBe(-1)
    expect(h.calls).toContain('profile:a_pipmind')
    expect(h.calls.some((x) => /^(write:|setOwnLimit:|saveAsk:|helloWake)/.test(x))).toBe(false)
    expect(moves).toEqual([])
  })

  it('explicit Wake verifies the proposed own-key limit before profile and Wake, and quotes only the returned greeting', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen(askToSave('Pip', null, ''), 5)
    await flush()
    const limitAt = h.calls.indexOf('setOwnLimit:5')
    const saveAt = h.calls.findIndex((x) => x.startsWith('saveAsk:'))
    expect(limitAt).toBeGreaterThan(-1)
    expect(h.calls.slice(limitAt + 1, saveAt)).toContain('setup')
    expect(saveAt).toBeGreaterThan(limitAt)
    expect(h.calls.indexOf('helloWake')).toBeGreaterThan(saveAt)
    expect(h.how).toBe(DEFAULT_ASK_PURPOSE)
    expect(g().run!.facts.limit).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 5 })
    expect(g().run!.u1!.phase).toBe('greeted')
    expect(g().run!.hello.hello!.greeting!.text).toBe('A recorded host reply.')
    expect(g().run!.beats.arrive.state).not.toBe('ready')
    expect(g().run!.progress!.status).toBe('finished')
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(g().run!.progress!.beats_done).toEqual(['ask', 'hello'])
    expect(g().run!.beats.look.state).toBe('pending')
    expect(moves).toEqual([])
  })

  it('Checking follows dispatched limit setter/readback promises, clears before profile work, and never survives a settled unconfirmed amount', async () => {
    const h = new SingleHost()
    const actualSet = h.setOwnLimit.bind(h), actualSetup = h.setup.bind(h), actualSave = h.saveAsk.bind(h)
    let releaseSet: () => void = () => undefined
    let releaseRead: () => void = () => undefined
    let releaseProfile: () => void = () => undefined
    let readbackReached = false, profileReached = false
    h.setOwnLimit = async (amount) => { await new Promise<void>((resolve) => { releaseSet = resolve }); await actualSet(amount) }
    h.setup = async () => {
      if (h.ownLimit !== null) { readbackReached = true; await new Promise<void>((resolve) => { releaseRead = resolve }) }
      return actualSetup()
    }
    h.saveAsk = async (id, shape, write) => {
      profileReached = true
      await new Promise<void>((resolve) => { releaseProfile = resolve })
      return actualSave(id, shape, write)
    }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const attempt = g().wakeSingleScreen({ name: 'Pip', how: null }, 5)
    await flush()
    expect(g().run!.u1!.limitChecking).toBe(true)
    expect(spendingCopy(g().run!.facts.limit, 5, null, g().run!.u1!.limitChecking)).toBe('Checking your limit…')
    releaseSet(); await flush()
    expect(readbackReached).toBe(true)
    expect(g().run!.u1).toMatchObject({ limitChecking: true, limitPending: 5 })
    releaseRead(); await flush()
    expect(profileReached).toBe(true)
    expect(g().run!.u1).toMatchObject({ limitChecking: false, limitPending: null, busy: true })
    expect(spendingCopy(g().run!.facts.limit, 5, null, g().run!.u1!.limitChecking)).toBe('Your minds may spend up to $5 a month.')
    releaseProfile(); await attempt; await flush()
    expect(g().run!.u1!.limitChecking).toBe(false)

    const failed = new SingleHost(), setup = failed.setup.bind(failed)
    failed.setup = async () => {
      const snapshot = await setup()
      return failed.ownLimit !== null ? { ...snapshot, limit: { ...snapshot.limit!, enforced: false, enforced_by: null, limit_usd: null } } : snapshot
    }
    g().stop()
    await g().start({ mode: 'live', host: failed, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, 5)
    const run = g().run!
    expect(run.u1).toMatchObject({ limitChecking: false, limitPending: 5, busy: false })
    expect(spendingCopy(run.facts.limit, 5, run.u1!.limitPending!, run.u1!.limitChecking)).toBe("We couldn't confirm a spending limit here.")
    expect(failed.calls).not.toContain('helloWake')
  })

  it('unread purpose or absent host model cannot send profile, limit or Wake', async () => {
    for (const problem of ['profile', 'model'] as const) {
      const h = new SingleHost()
      if (problem === 'profile') h.profileError = true
      else h.model = null
      await g().start({ mode: 'live', host: h, singleScreen: true })
      expect(g().run!.u1!.context).toBe('unavailable')
      expect(g().run!.facts.askHow).toBe(problem === 'profile' ? null : '')
      await g().wakeSingleScreen({ name: 'Pip', how: DEFAULT_ASK_PURPOSE }, 5)
      expect(h.calls.some((x) => /^(setOwnLimit:|saveAsk:|helloWake)/.test(x))).toBe(false)
      g().stop()
    }
  })

  it('name-only preserves the whole multiline persona; an intentional clear stays empty', async () => {
    for (const [existing, edit, expected] of [['Long\n' + 'x'.repeat(900), null, 'Long\n' + 'x'.repeat(900)], ['Kind.', '', '']] as const) {
      const h = new SingleHost()
      h.how = existing
      h.ownLimit = 7
      await g().start({ mode: 'live', host: h, singleScreen: true })
      await g().wakeSingleScreen(askToSave('Wren', edit, g().run!.facts.askHow), null)
      expect(h.calls.some((x) => x.startsWith('saveAsk:'))).toBe(true)
      expect(h.how).toBe(expected)
      expect(g().run!.facts.askHow).toBe(expected)
      expect(h.calls.some((x) => x.startsWith('setOwnLimit:'))).toBe(false)
      g().stop()
    }
  })

  it('guest scope refuses an own-key limit change, while an unchanged host allowance can reach host Wake', async () => {
    const h = new SingleHost()
    h.own_ = { ...h.own_, you_are_owner: false, your_access: 'guest', pays: 'hive-key' }
    h.limit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 3, spent_usd: 0, chosen_usd: null, host_name: 'Host', pending_request: null }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, 5)
    expect(h.calls.some((x) => /^(setOwnLimit:|saveAsk:|helloWake)/.test(x))).toBe(false)
    expect(g().run!.u1!.error).toContain('host controls')
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    expect(h.calls).toContain('helloWake')
    expect(h.calls.some((x) => x.startsWith('setOwnLimit:'))).toBe(false)
    expect(g().run!.facts.limit!.limit_usd).toBe(3)
  })

  it('a changed current model or purpose is shown for review before any write', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    h.model = 'provider/new-host-model'
    h.how = 'Changed elsewhere.'
    await g().wakeSingleScreen({ name: 'Pip', how: DEFAULT_ASK_PURPOSE }, 5)
    expect(g().run!.facts.askHow).toBe(h.how)
    expect(g().run!.u1!.model).toBe(h.model)
    expect(g().run!.u1!.error).toContain('Review the current values')
    expect(h.calls.some((x) => /^(setOwnLimit:|saveAsk:|helloWake)/.test(x))).toBe(false)
  })

  it('unconfirmed limit readback stops before profile and Wake without claiming rollback', async () => {
    const h = new SingleHost()
    h.setOwnLimit = async (n) => { h.calls.push(`setOwnLimit:${n}`) } // host answer without a confirming state change
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, 5)
    expect(h.calls).toContain('setOwnLimit:5')
    expect(h.calls.some((x) => /^(saveAsk:|helloWake)/.test(x))).toBe(false)
    expect(g().run!.facts.limit!.enforced).toBe(false)
    expect(g().run!.u1!.error).toContain('may have been saved')
  })

  it('a host Wake refusal retains saved-profile truth and never invents a greeting', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    h.helloWake = async () => { h.calls.push('helloWake'); throw new FlRefusal(403, 'no_key', 'No usable key') }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen(askToSave('Pip', null, ''), null)
    expect(h.how).toBe(DEFAULT_ASK_PURPOSE)
    expect(g().run!.u1).toMatchObject({ profileSaved: true, phase: 'editing', busy: false })
    expect(g().run!.u1!.saves!.name).toBe('saved')
    expect(g().run!.u1!.error).toContain("couldn't confirm whether this was charged")
    expect(g().run!.facts.greeted).toBe(false)
    expect(g().run!.hello.hello).toBeNull()
  })

  it('each actual live-host write and the Wake answer stays bound to its original identity', async () => {
    for (const at of ['limit', 'rename', 'persona', 'prefs', 'wake'] as const) {
      const h = new SingleHost()
      const sent: string[] = []
      const endpoint = (name: string) => { sent.push(name); if (at === name) useHive.setState((s) => ({ inits: s.inits + 1 })) }
      const setLimit = h.setOwnLimit.bind(h)
      h.setOwnLimit = async (n) => { endpoint('limit'); await setLimit(n) }
      h.liveClient = {
        renameMyMind: async (name) => { endpoint('rename'); return { mind: { id: 'a_pipmind', name, status: 'asleep' } } },
        patchAgent: async () => { endpoint('persona'); return {} },
        setAskSettings: async () => { endpoint('prefs'); return {} },
      }
      const reply = h.wakeAnswer!
      h.helloWake = async () => { endpoint('wake'); return reply() }
      await g().start({ mode: 'live', host: h, singleScreen: true })
      await g().wakeSingleScreen({ name: 'Pip', how: 'Kind.' }, 5)
      expect(sent).toEqual(['limit', 'rename', 'persona', 'prefs', 'wake'].slice(0, ['limit', 'rename', 'persona', 'prefs', 'wake'].indexOf(at) + 1))
      expect(g().run?.facts.greeted ?? false).toBe(false)
      g().stop()
    }
  })

  it('pause then resume cannot revive a deferred old read or let its finally clear a newer attempt', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const original = h.profile.bind(h)
    let release: (v: Awaited<ReturnType<SingleHost['profile']>>) => void = () => undefined
    h.profile = async (_id) => { h.calls.push('deferred-profile'); return new Promise((resolve) => { release = resolve }) }
    const old = g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(h.calls).toContain('deferred-profile')
    g().toggle()
    g().toggle()
    h.profile = original
    let answer: (v: Hello) => void = () => undefined
    h.helloWake = async () => { h.calls.push('new-wake'); return new Promise((resolve) => { answer = resolve }) }
    const next = g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(h.calls).toContain('new-wake')
    release(await original('a_pipmind'))
    await old
    expect(g().run!.u1!.busy).toBe(true)
    expect(h.calls.filter((x) => x.startsWith('saveAsk:'))).toHaveLength(1)
    answer(h.wakeAnswer!())
    await next
    expect(g().run!.u1!.phase).toBe('greeted')
  })

  it('overlapping context reloads keep only the newest whole-persona and model answer', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const original = h.profile.bind(h)
    let release: (v: Awaited<ReturnType<SingleHost['profile']>>) => void = () => undefined
    h.profile = async () => new Promise((resolve) => { release = resolve })
    const old = g().reload()
    await flush()
    h.profile = original
    h.how = 'Newest whole purpose.'
    h.model = 'new/model'
    await g().reload()
    release({ id: 'a_pipmind', name: 'Pip', persona: 'Stale.', model: 'old/model' })
    await old
    expect(g().run!.facts.askHow).toBe('Newest whole purpose.')
    expect(g().run!.u1!.model).toBe('new/model')
  })

  it('a failed completion write stays explicit and retries only progress, never paid Wake', async () => {
    const h = new SingleHost()
    h.ownLimit = 5
    const actual = h.writeProgress.bind(h)
    let fail = true
    h.writeProgress = async (w, version) => { if (w.status === 'finished' && fail) { fail = false; h.calls.push('completion-refused'); throw new FlRefusal(503, 'unavailable', 'synthetic completion refusal') } return actual(w, version) }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen(askToSave('Pip', null, ''), null)
    await flush()
    expect(h.calls).toContain('completion-refused')
    expect(g().run!.facts.greeted).toBe(true)
    expect(g().run!.u1!.completion).toBe('unknown')
    expect(h.p.status).not.toBe('finished')
    await g().finishSingleScreen()
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(h.p.status).toBe('finished')
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
    expect(h.p.beats_done).toEqual(['ask', 'hello'])
    expect(h.p.beats_skipped).toEqual([])
    const opened: string[] = []
    expect(await enterFirstRun({ onboarding: async () => ({ record: 'first-light.progress/1', ...h.p }) }, () => opened.push('open'))).toBe('complete')
    expect(opened).toEqual([])
  })

  it('a lost completion acknowledgement is unknown until readback, with no second progress write or Wake', async () => {
    const h = new SingleHost()
    const actual = h.writeProgress.bind(h)
    let writes = 0
    h.writeProgress = async (w, version) => { writes++; const saved = await actual(w, version); if (writes === 1) throw new Error('synthetic lost completion acknowledgement'); return saved }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(writes).toBe(1)
    expect(h.p.status).toBe('finished')
    expect(g().run!.u1!.completion).toBe('unknown')
    await g().finishSingleScreen()
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(writes).toBe(1)
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
  })

  it('an in-flight completion answer cannot commit after the person changes', async () => {
    const h = new SingleHost()
    const actual = h.writeProgress.bind(h)
    let release: (p: Progress) => void = () => undefined
    h.writeProgress = async (w, version) => { const value = await actual(w, version); h.calls.push('held-completion'); return new Promise<Progress>((resolve) => { release = () => resolve(value) }) }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(h.calls).toContain('held-completion')
    expect(g().run!.u1!.completion).toBe('saving')
    useHive.setState((s) => ({ inits: s.inits + 1 }))
    release(h.p)
    await flush()
    expect(g().run?.u1?.completion).not.toBe('confirmed')
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
  })

  it('after an incomplete close and re-signin, the recorded greeting is reused instead of replaying paid Wake', async () => {
    const h = new SingleHost()
    const actual = h.writeProgress.bind(h)
    let first = true
    h.writeProgress = async (w, version) => { if (first) { first = false; throw new Error('synthetic completion unavailable') } return actual(w, version) }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(g().run!.u1!.completion).toBe('unknown')
    h.helloNext = g().run!.hello.hello
    g().stop()
    useHive.setState((s) => ({ inits: s.inits + 1 }))
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(h.p.status).toBe('finished')
  })

  it('actual rename acknowledgement plus lost persona response names partial/unknown truth and reads current values back', async () => {
    const h = new SingleHost()
    const wire: string[] = []
    h.liveClient = {
      renameMyMind: async (name) => { wire.push('name'); h.profileName = name; return { mind: { id: 'a_pipmind', name, status: 'asleep' } } },
      patchAgent: async (_id, body) => { wire.push('purpose'); h.how = String(body.persona); throw new Error('synthetic lost persona answer') },
      setAskSettings: async () => { wire.push('preferences'); return {} },
    }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Wren', how: 'Kind.' }, null)
    expect(wire).toEqual(['name', 'purpose'])
    expect(g().run!.u1!.saves).toMatchObject({ name: 'saved', purpose: 'unknown', preferences: 'not_sent', readback: { name: 'Wren', purpose: 'Kind.' } })
    expect(h.calls).not.toContain('helloWake')
    expect(g().run!.facts.greeted).toBe(false)
  })

  it('ordinary prefs refusal retains the existing success policy without falsely claiming every field Saved', async () => {
    const h = new SingleHost()
    h.liveClient = {
      renameMyMind: async (name) => { h.profileName = name; return { mind: { id: 'a_pipmind', name, status: 'asleep' } } },
      patchAgent: async (_id, body) => { h.how = String(body.persona); return {} },
      setAskSettings: async () => { throw new ApiError(403, 'person_required', 'synthetic ordinary preference refusal') },
    }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: 'Kind.' }, null)
    await flush()
    expect(g().run!.u1!.saves).toMatchObject({ name: 'saved', purpose: 'saved', preferences: 'unknown' })
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(h.calls).toContain('helloWake')
  })

  it('completion reads held across pause/resume release only their own lock; an old answer cannot clear the newer progress retry', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    const actualProgress = h.progress.bind(h)
    const releases: ((p: Progress) => void)[] = []
    let reads = 0
    h.progress = async () => {
      reads++
      h.calls.push(`completion-read:${reads}`)
      return reads <= 2 ? new Promise<Progress>((resolve) => releases.push(resolve)) : actualProgress()
    }
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(reads).toBe(1)
    const oldToken = g().run!.u1!.completionToken
    expect(oldToken).toBe(g().run!.token)
    g().toggle()
    expect(g().run!.u1!.completion).toBe('unknown')
    expect(g().run!.u1!.completionToken).toBeUndefined()
    g().toggle()
    expect(g().run!.u1!.phase).toBe('greeted')
    const retry = g().finishSingleScreen()
    const newToken = g().run!.token
    expect(newToken).not.toBe(oldToken)
    expect(g().run!.u1!.completionToken).toBe(newToken)
    releases[0]({ ...h.p })
    await flush()
    expect(reads).toBe(2)
    expect(g().run!.u1!.completion).toBe('saving')
    expect(g().run!.u1!.completionToken).toBe(newToken)
    expect(h.calls.some((x) => x.startsWith('write:'))).toBe(false) // the old read never received write authority
    releases[1]({ ...h.p })
    await retry
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(g().run!.u1!.completionToken).toBeUndefined()
    expect(h.p.status).toBe('finished')
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
  })

  it('a held completion write can finish remotely during pause/reload; current greeting and progress readback recover without another write or Wake', async () => {
    const h = new SingleHost()
    const actualWrite = h.writeProgress.bind(h)
    let release: () => void = () => undefined
    let writes = 0
    h.writeProgress = async (w, version) => {
      writes++
      const saved = await actualWrite(w, version)
      if (writes === 1) return new Promise<Progress>((resolve) => { release = () => resolve(saved) })
      return saved
    }
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    await flush()
    expect(writes).toBe(1)
    expect(h.p.status).toBe('finished')
    expect(g().run!.u1!.completion).toBe('saving')
    h.helloNext = g().run!.hello.hello
    g().toggle()
    g().toggle()
    await g().reload()
    expect(g().run!.u1!.completion).toBe('unknown')
    expect(g().run!.u1!.completionToken).toBeUndefined()
    await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
    const currentToken = g().run!.token
    expect(g().run!.u1!.completionToken).toBe(currentToken)
    release()
    await flush()
    expect(g().run!.u1!.completion).toBe('confirmed')
    expect(g().run!.u1!.completionToken).toBeUndefined()
    expect(writes).toBe(1)
    expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
    expect(h.p.beats_done).toEqual(['ask', 'hello'])
  })

  it('actual typed stops release a completion lock even before the store identity key changes, without retrying Wake', async () => {
    for (const stoppedError of [new OperationStopped(), new ApiError(409, 'identity_changed', 'Synthetic current-key client stop')]) {
      const h = new SingleHost()
      await g().start({ mode: 'live', host: h, singleScreen: true })
      const key = identityKey()
      const actualProgress = h.progress.bind(h)
      let first = true
      h.progress = async () => { if (first) { first = false; h.calls.push('same-key-stop'); throw stoppedError } return actualProgress() }
      await g().wakeSingleScreen({ name: 'Pip', how: null }, null)
      await flush()
      expect(h.calls).toContain('same-key-stop')
      expect(identityKey()).toBe(key)
      expect(g().run!.u1!.completion).toBe('unknown')
      expect(g().run!.u1!.completionToken).toBeUndefined()
      expect(g().run!.u1!.error).toContain('Completion stopped')
      await g().finishSingleScreen()
      expect(g().run!.u1!.completion).toBe('confirmed')
      expect(h.calls.filter((x) => x === 'helloWake')).toHaveLength(1)
      g().stop()
    }
  })
})
/** Next until the step with this id (only steps that do not wait for the person). */
async function nextTo(id: string) {
  for (let i = 0; i < 30 && at() !== id; i++) {
    g().next()
    await flush(2)
  }
  expect(at()).toBe(id)
}

beforeEach(() => {
  moves.length = 0
  saved = 'classic||'
  setFlScreen(screen)
})
afterEach(() => {
  g().stop()
  setFlScreen(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the owner path, live', () => {
  it('arrive: the role is the person’s choice, saved on the host with its version; the beat is ready', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h })
    await flush()
    expect(g().run!.path).toBe('owner')
    expect(at()).toBe('1.1')
    expect(moves[0]).toBe(JSON.stringify({ go: { name: 'hive' } }))
    // a new hive holding only their mind: R0.1's line; Next waits at the choice
    await nextTo('1.2')
    await nextTo('1.3')
    g().next()
    expect(at()).toBe('1.3')
    await g().choose('coder')
    await flush()
    expect(g().run!.beats.arrive).toEqual({ state: 'ready', line: 'Got it.' })
    expect(h.calls.find((c) => c.startsWith('write:'))).toBe('write:{"role_path":"coder","beats_done":["arrive"],"beats_skipped":[],"current_beat":"look"}@0')
    expect(at()).toBe('1.4')
  })

  it('an owner with other minds is never told their hive holds one mind', async () => {
    const h = new FakeHost()
    h.others = 4
    await g().start({ mode: 'live', host: h })
    await flush()
    await nextTo('1.2b')
    expect(g().run!.steps.find((s) => s.id === '1.2')).toBeTruthy()
  })

  it('look: a keep in the gallery (the person’s own) makes the beat ready and moves on', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'look' })
    await flush()
    expect(at()).toBe('2.1')
    expect(moves).toContain('gallery:true')
    await nextTo('2.2')
    saved = 'cosmos||'
    previewLook(null) // any look change notifies the journey
    await flush()
    expect(g().run!.beats.look.state).toBe('ready')
    expect(at()).toBe('2.3')
  })

  it('keys and limits with a key of their own: the limit is set on the host, and named as enforced only once it is', async () => {
    const h = new FakeHost()
    h.keys = 1
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    expect(at()).toBe('3.1')
    expect(moves).toContain(JSON.stringify({ go: { name: 'me' } }))
    await nextTo('3.3')
    await g().checkKey()
    await flush()
    expect(at()).toBe('3.4')
    await g().choose(20)
    await flush()
    expect(h.calls).toContain('setOwnLimit:20')
    expect(g().run!.facts.limit).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 20 })
    expect(at()).toBe('3.5')
    await nextTo('3.7')
    g().next()
    await flush()
    expect(g().run!.beats.models).toEqual({ state: 'ready', line: 'Your key is in. Your limit: $20 a month (your own limit on your keys); the hive stops your minds there.' })
  })

  it('with no key of their own, the choice is recorded but never set or named as a limit; the beat is “later”', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3')
    g().next() // waits for the key
    expect(at()).toBe('3.3')
    g().skipBeat()
    await flush()
    expect(g().run!.beats.models.state).toBe('skipped')
    expect(g().run!.beats.models.line).toMatch(/^No key yet, so your hive can’t think/)
  })

  it('choosing an amount with no key: not sent as a limit; the next line says it is not one yet', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3')
    // the person moves on without a key (a key added later re-runs this beat)
    useFirstLight.setState({ run: { ...g().run!, i: g().run!.steps.findIndex((s) => s.id === '3.4') } })
    await g().choose(20)
    await flush()
    expect(h.calls.some((c) => c.startsWith('setOwnLimit'))).toBe(false)
    expect(h.calls.some((c) => c.includes('"monthly_spend_usd":20'))).toBe(true)
    expect(at()).toBe('3.6n')
    expect(g().run!.facts.limit?.enforced).toBe(false)
  })

  it('a stale write adopts the record as it stands now, and says so', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h })
    await flush()
    await nextTo('1.3')
    h.stale = true
    await g().choose('researcher')
    await flush(10)
    expect(g().run!.progress?.version).toBe(7)
    expect(g().run!.notice).toBe('Your setup changed in another window. Here is where it stands now.')
    expect(g().run!.beats.look.state).toBe('ready')
  })
})

describe('the hello, live', () => {
  it('a refusal blocks the beat with its plain reason, and no greeting is shown', async () => {
    const h = new FakeHost()
    h.wakeAnswer = () => {
      throw new FlRefusal(402, 'no_key', 'host words')
    }
    await g().start({ mode: 'live', host: h, beat: 'hello' })
    await flush()
    await nextTo('8.2')
    await g().wake()
    await flush()
    const r = g().run!
    expect(r.beats.hello.state).toBe('blocked')
    expect(r.hello.refusal).toEqual({ code: 'no_key', sentence: 'Your mind can’t wake yet: it has nothing to think with. Add a key of your own, then wake it here.' })
    expect(r.hello.hello).toBeNull()
    expect(r.facts.greeted).toBe(false)
    expect(at()).toBe('8.2')
  })

  it('the person’s Wake; the mind’s own words once the host has them; then the closing line and the record', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = new FakeHost()
    const waiting: Hello = { mind: { id: 'a_pipmind', name: 'Pip', status: 'awake' }, state: 'waiting', greeting: null, created: true, retryable: false, requested_at: null }
    h.wakeAnswer = () => waiting
    h.p = { ...h.p, beats_done: ['arrive', 'look', 'models', 'apps', 'ask'], version: 3, status: 'in_progress' }
    await g().start({ mode: 'live', host: h, beat: 'hello' })
    await vi.advanceTimersByTimeAsync(10)
    expect(at()).toBe('8.1')
    await nextTo('8.2')
    expect(h.calls).not.toContain('helloWake')
    await g().wake()
    await vi.advanceTimersByTimeAsync(10)
    expect(at()).toBe('8.3')
    expect(g().run!.facts.greeted).toBe(false)
    h.helloNext = { ...waiting, state: 'greeted', greeting: { id: 'm1', text: 'Hi Pip, I’m awake.', created_at: null } }
    await vi.advanceTimersByTimeAsync(1600)
    const r = g().run!
    expect(r.facts.greeted).toBe(true)
    expect(r.beats.hello.state).toBe('ready')
    expect(at()).toBe('8.4')
    await vi.advanceTimersByTimeAsync(10)
    expect(h.calls.some((c) => c.includes('"beats_done":["arrive","look","models","apps","ask","hello"]') && c.includes('"status":"finished"'))).toBe(true)
  })

  it('a live journey never presses anything by itself (no Wake, no choice) however long it waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = new FakeHost()
    h.wakeAnswer = () => ({ mind: { id: 'a', name: 'Pip', status: 'awake' }, state: 'waiting', greeting: null, created: true, retryable: false, requested_at: null })
    await g().start({ mode: 'live', host: h, beat: 'hello' })
    await vi.advanceTimersByTimeAsync(10)
    await nextTo('8.2')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).not.toContain('helloWake')
    expect(at()).toBe('8.2')
  })
})

describe('the guest path, live', () => {
  const guestHost = () => {
    const h = new FakeHost()
    h.own_ = { owner_name: 'Hazel Quillfeather', you_are_owner: false, your_access: 'guest', visibility: 'private', pays: 'own-key' }
    h.limit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 5, spent_usd: 0, chosen_usd: null, host_name: 'Hazel', pending_request: null }
    h.others = 6
    return h
  }
  it('arrives as a guest; Host friends is not offered; the limit card, and the beat ready on the host’s key', async () => {
    const h = guestHost()
    await g().start({ mode: 'live', host: h })
    await flush()
    expect(g().run!.path).toBe('guest')
    expect(g().run!.facts.host).toBe('Hazel')
    expect(at()).toBe('1.1g')
    await nextTo('1.2g')
    await g().choose('admin') // not a guest's choice: refused
    await nextTo('1.3')
    await g().choose('admin')
    expect(at()).toBe('1.3')
    g().goBeat('models')
    await flush()
    expect(at()).toBe('3.1g')
    await nextTo('3.3g')
    g().next()
    await flush()
    expect(g().run!.beats.models).toEqual({ state: 'ready', line: 'Your limit here: $5.00 a month, on Hazel’s key.' })
  })
  it('asking the host for more sends a request (the host decides)', async () => {
    const h = guestHost()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await g().askForMore(10)
    await flush()
    expect(h.calls).toContain('ask:10')
    expect(g().run!.ask.sent).toEqual({ amount: 10 })
  })
  it('no live invite limit: the beat needs the person, and no limit is named', async () => {
    const h = guestHost()
    h.limit = { ...h.limit!, enforced: false, enforced_by: null }
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    expect(at()).toBe('3.1g')
    await nextTo('3.2gn')
    await nextTo('3.3g')
    g().next()
    await flush()
    expect(g().run!.beats.models.state).toBe('blocked')
    expect(g().run!.beats.models.line).not.toMatch(/stops/)
  })
})

describe('the demo, opened at one step (the render smoke’s way in)', () => {
  it('Pip at 3.6: the earlier beats and this beat’s own choice are played first, so the line is true', async () => {
    await g().start({ mode: 'demo', persona: 'pip', host: new DemoHost('pip'), step: '3.6', paused: true })
    await flush(10)
    const r = g().run!
    expect(r.status).toBe('paused')
    expect(at()).toBe('3.6')
    expect(r.beats.arrive.state).toBe('ready')
    expect(r.beats.look.state).toBe('ready')
    expect(r.facts.limit).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 20 })
    expect(r.facts.ownKeys).toBe(1)
  })
  it('a step whose line is not true now is never shown (3.6 with no limit in force goes on to 3.6n)', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    useFirstLight.setState({ run: { ...g().run!, i: g().run!.steps.findIndex((s) => s.id === '3.5') } })
    g().next()
    await flush()
    expect(at()).toBe('3.6n')
  })
  it('Juno at 3.2g: a guest with the host’s $5.00 limit', async () => {
    await g().start({ mode: 'demo', persona: 'juno', host: new DemoHost('juno'), step: '3.2g', paused: true })
    await flush(10)
    expect(at()).toBe('3.2g')
    expect(g().run!.path).toBe('guest')
    expect(g().run!.facts.host).toBe('Hazel')
  })
})

describe('the demo host (invented, deterministic)', () => {
  it('Juno: a guest in Hazel’s hive at $5.00; greeted after the same delay every time; the hello costs $0.02', async () => {
    let now = 1_000_000
    const d = new DemoHost('juno', () => now)
    const s = await d.setup()
    expect(s.limit).toMatchObject({ enforced: true, enforced_by: 'invite', limit_usd: 5, host_name: 'Hazel' })
    expect((await d.own()).your_access).toBe('guest')
    const w = await d.helloWake()
    expect(w.state).toBe('waiting')
    expect(w.greeting).toBeNull()
    now += DEMO_GREET_MS - 1
    expect((await d.helloGet())!.state).toBe('waiting')
    now += 1
    const h = (await d.helloGet())!
    expect(h.state).toBe('greeted')
    expect(h.greeting!.text).toMatch(/^Hi Juno, I’m awake\. I’m running in Hazel’s hive, on Hazel’s key/)
    expect((await d.setup()).limit!.spent_usd).toBe(0.02)
  })
  it('Pip: no key yet means no Wake (no_key), and a limit cannot be set without a key', async () => {
    const d = new DemoHost('pip', () => 0)
    await expect(d.helloWake()).rejects.toMatchObject({ code: 'no_key' })
    await expect(d.setOwnLimit(20)).rejects.toMatchObject({ code: 'key_owner_only' })
    d.addKey()
    await d.setOwnLimit(20)
    expect((await d.setup()).limit).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 20 })
    expect(d.keyShown).toBe('sk-DEMO-••••••••••••••••7Q2F')
  })
})

describe('followups-r8: the limit and its progress are one bound operation (Kimi FL-R2 #1)', () => {
  it('a sign-in change while the limit is in flight: its answer is dropped and no progress is written for that run', async () => {
    const h = new FakeHost()
    h.keys = 1
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3')
    await g().checkKey()
    await flush()
    expect(at()).toBe('3.4')
    let answer: () => void = () => undefined
    h.setOwnLimit = (m: number) => {
      h.calls.push(`setOwnLimit:${m}`)
      return new Promise<void>((res) => { answer = res })
    }
    const writesBefore = h.calls.filter((c) => c.startsWith('write:')).length
    const choosing = g().choose(20)
    await flush()
    expect(h.calls).toContain('setOwnLimit:20')
    useHive.setState((st) => ({ inits: st.inits + 1 })) // another sign-in on this page: a new identity epoch
    answer()
    await choosing
    await flush()
    expect(h.calls.filter((c) => c.startsWith('write:')).length).toBe(writesBefore)
    expect(h.calls.some((c) => c.startsWith('write:') && c.includes('monthly_spend_usd'))).toBe(false)
  })
})

describe('followups-r8: a when-guarded caption is dropped once its condition stops holding (Kimi FL-R2 #2)', () => {
  const guest = () => {
    const h = new FakeHost()
    h.own_ = { owner_name: 'Hazel Quillfeather', you_are_owner: false, your_access: 'guest', visibility: 'private', pays: 'own-key' }
    h.limit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 5, spent_usd: 0, chosen_usd: null, host_name: 'Hazel', pending_request: null }
    return h
  }
  it('3.2g (“the hive stops them at that limit”) moves to 3.2gn when the host stops enforcing the limit', async () => {
    const h = guest()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.2g')
    h.limit = { ...h.limit!, enforced: false, enforced_by: null } // revoked in another window
    await g().checkKey() // any read of the host's setup
    await flush()
    expect(at()).toBe('3.2gn')
    expect(g().run!.facts.limit?.enforced).toBe(false)
  })
  it('the same caption stays while it still holds', async () => {
    const h = guest()
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.2g')
    await g().checkKey()
    await flush()
    expect(at()).toBe('3.2g')
  })
  it('an owner’s 3.5 (“up to {monthly}”, enforced) moves to 3.6n when the limit is no longer enforced', async () => {
    const h = new FakeHost()
    h.keys = 1
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3')
    await g().checkKey()
    await flush()
    await g().choose(20)
    await flush()
    expect(at()).toBe('3.5')
    h.ownLimit = null
    await g().checkKey()
    await flush()
    expect(at()).toBe('3.6n')
  })
})

describe('followups-r8: a guest asking for more holds the journey (stand-in FL-R2 P2)', () => {
  it('held while the amounts are open or the request is on its way; free once it is answered or closed', async () => {
    const h = new FakeHost()
    h.own_ = { owner_name: 'Hazel Quillfeather', you_are_owner: false, your_access: 'guest', visibility: 'private', pays: 'own-key' }
    h.limit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 5, spent_usd: 0, chosen_usd: null, host_name: 'Hazel', pending_request: null }
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3g')
    expect(autoHeld(g().run)).toBe(false)
    g().askChoosing(true)
    expect(autoHeld(g().run)).toBe(true)
    let answer: (v: { id: string; amount_usd: number; status: 'pending' }) => void = () => undefined
    h.askForMore = (a: number) => { h.calls.push(`ask:${a}`); return new Promise((res) => { answer = res }) }
    const asking = g().askForMore(10)
    await flush()
    expect(g().run!.ask.busy).toBe(true)
    g().askChoosing(false) // even closed, the request on its way holds
    expect(autoHeld(g().run)).toBe(true)
    g().askChoosing(true)
    answer({ id: 'lr_1', amount_usd: 10, status: 'pending' })
    await asking
    await flush()
    expect(g().run!.ask.sent).toEqual({ amount: 10 })
    expect(autoHeld(g().run)).toBe(false)
  })
  it('the amounts close when the journey leaves the guest card', async () => {
    const h = new FakeHost()
    h.own_ = { owner_name: 'Hazel Quillfeather', you_are_owner: false, your_access: 'guest', visibility: 'private', pays: 'own-key' }
    h.limit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 5, spent_usd: 0, chosen_usd: null, host_name: 'Hazel', pending_request: null }
    await g().start({ mode: 'live', host: h, beat: 'models' })
    await flush()
    await nextTo('3.3g')
    g().askChoosing(true)
    g().next() // the person's own Next: never held
    await flush()
    expect(stepOf(g().run)?.card).not.toBe('guest-limit')
    expect(g().run!.ask.choosing).toBe(false)
  })
})

describe('R3: your apps, your Ask and the hand-off, live', () => {
  const TALK: AppRef = { id: 'talk', name: 'Your assistant', tagline: null }

  it('beat 5 shows the apps ready for the person and waits for Next; the beat is ready', async () => {
    const h = new FakeHost()
    h.apps_ = [TALK]
    await g().start({ mode: 'live', host: h, beat: 'apps' })
    await flush()
    expect(at()).toBe('5.1')
    g().next() // a step that waits for the person never moves on by Next in the controls
    await flush()
    expect(at()).toBe('5.1')
    g().appsNext()
    await flush()
    expect(at()).toBe('6.1')
    expect(g().run!.beats.apps.state).toBe('ready')
    expect(h.calls.some((c) => c.startsWith('write:') && c.includes('"beats_done":["apps"]'))).toBe(true)
  })

  it('beat 5 with no app ready says so, offers nothing, and moves on as later', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'apps' })
    await flush()
    expect(at()).toBe('5.1n')
    g().next()
    await flush()
    expect(at()).toBe('6.1')
    expect(g().run!.beats.apps.state).toBe('skipped')
  })

  it('Open goes to the app, marks the beat done and pauses at Your Ask', async () => {
    const h = new FakeHost()
    h.apps_ = [TALK]
    await g().start({ mode: 'live', host: h, beat: 'apps' })
    await flush()
    g().openApp('talk')
    await flush()
    expect(moves).toContain(JSON.stringify({ go: { name: 'program', id: 'talk' } }))
    expect(g().run!.status).toBe('paused')
    expect(at()).toBe('6.1')
    expect(g().run!.beats.apps.state).toBe('ready')
  })

  it('beat 6 saves the name and how on the person’s own mind, then says its name', async () => {
    const h = new FakeHost()
    h.how = 'Old words.'
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    expect(at()).toBe('6.1')
    expect(g().run!.facts.askHow).toBe('Old words.')
    await g().saveAsk({ name: '  Wren\u0007 ', how: 'Warm   and brief.' })
    await flush()
    expect(h.calls).toContain('saveAsk:a_pipmind:{"name":"Wren","how":"Warm and brief."}')
    expect(at()).toBe('6.2')
    expect(g().run!.facts.mind?.name).toBe('Wren')
    expect(g().run!.beats.ask.state).toBe('ready')
  })


  it('beat Ask uses the real adapter: acknowledged rename, refused persona and unsent prefs remain a partial save with current readback', async () => {
    const h = new SingleHost()
    h.how = 'Original purpose.'
    const wire: string[] = []
    h.liveClient = {
      renameMyMind: async (name) => { wire.push('name'); h.profileName = name; return { mind: { id: 'a_pipmind', name, status: 'asleep' } } },
      patchAgent: async () => { wire.push('purpose'); throw new ApiError(403, 'owner_only', 'Synthetic persona refusal') },
      setAskSettings: async () => { wire.push('preferences'); return {} },
    }
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    await g().saveAsk({ name: 'Wren', how: 'New purpose.' })
    await flush()
    expect(wire).toEqual(['name', 'purpose'])
    expect(at()).toBe('6.1')
    expect(g().run!.beats.ask.state).not.toBe('ready')
    const state = g().run!.askForm.saves!
    expect(state).toMatchObject({ name: 'saved', purpose: 'unknown', preferences: 'not_sent', readback: { name: 'Wren', purpose: 'Original purpose.' } })
    expect(g().run!.askForm.error).toBe(profileSaveCopy(state))
    expect(g().run!.askForm.error).toContain('name was saved')
    expect(g().run!.askForm.error).toContain("preferences weren't sent")
    expect(g().run!.askForm.error).not.toContain('Nothing changed')
    expect(h.calls).not.toContain('helloWake')
  })
  it('beat 6 leaves unchanged words alone, refuses an empty name, and keeps the person there on a refusal', async () => {
    const h = new FakeHost()
    h.how = 'Kind.'
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    await g().saveAsk({ name: '   ', how: 'Kind.' })
    expect(g().run!.askForm.error).toBe('Give it a name first.')
    expect(h.calls.some((c) => c.startsWith('saveAsk'))).toBe(false)
    h.saveRefusal = new FlRefusal(403, 'person_required', 'no')
    await g().saveAsk(askToSave('Wren', null, 'Kind.')) // the field was not edited
    await flush()
    expect(h.calls).toContain('saveAsk:a_pipmind:{"name":"Wren","how":null}')
    expect(at()).toBe('6.1')
    expect(g().run!.askForm.error).toBeTruthy()
    expect(g().run!.beats.ask.state).not.toBe('ready')
  })

  it('Not now on beat 6 skips it and writes nothing to the mind', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    g().skipBeat()
    await flush()
    expect(g().run!.beats.ask.state).toBe('skipped')
    expect(h.calls.some((c) => c.startsWith('saveAsk'))).toBe(false)
    expect(stepOf(g().run)?.beat).toBe('hello')
  })

  it('after hello, one press opens the app to talk in and First Light ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = new FakeHost()
    h.apps_ = [TALK, { id: 'notes', name: 'Notes', tagline: null }]
    const greetedAnswer: Hello = { mind: { id: 'a_pipmind', name: 'Pip', status: 'awake' }, state: 'greeted', greeting: { id: 'm1', text: 'Hi Pip, I’m awake.', created_at: null }, created: true, retryable: false, requested_at: null }
    h.wakeAnswer = () => greetedAnswer
    h.p = { ...h.p, beats_done: ['arrive', 'look', 'models', 'apps', 'ask'], version: 3, status: 'in_progress' }
    await g().start({ mode: 'live', host: h, beat: 'hello' })
    await vi.advanceTimersByTimeAsync(10)
    await nextTo('8.2')
    await g().wake()
    await vi.advanceTimersByTimeAsync(10)
    await nextTo('8.4')
    await nextTo('8.5')
    g().startTalking()
    await vi.advanceTimersByTimeAsync(10)
    expect(moves).toContain(JSON.stringify({ go: { name: 'program', id: 'talk' } }))
    expect(g().run!.status).toBe('ended')
  })

  it('with no app ready the hello’s closing line is the last one: no hand-off step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = new FakeHost()
    h.wakeAnswer = () => ({ mind: { id: 'a_pipmind', name: 'Pip', status: 'awake' }, state: 'greeted', greeting: { id: 'm1', text: 'Hi.', created_at: null }, created: true, retryable: false, requested_at: null })
    h.p = { ...h.p, beats_done: ['arrive', 'look', 'models'], beats_skipped: ['apps', 'ask'], version: 3, status: 'in_progress' }
    await g().start({ mode: 'live', host: h, beat: 'hello' })
    await vi.advanceTimersByTimeAsync(10)
    await nextTo('8.2')
    await g().wake()
    await vi.advanceTimersByTimeAsync(10)
    await nextTo('8.4')
    expect(g().run!.steps.slice(g().run!.i + 1).some((s) => s.id === '8.5')).toBe(true)
    await vi.advanceTimersByTimeAsync(60000) // the last line that applies stays until the person closes it
    expect(at()).toBe('8.4')
  })
})

describe('R3.2: the Ask save stops at once when the person changes mid-chain (stand-in R3.1 P1)', () => {
  const bump = () => useHive.setState((st) => ({ inits: st.inits + 1 })) // another sign-in on this page: a new identity epoch
  function client(sent: string[], switchAfter: 'rename' | 'persona') {
    return {
      renameMyMind: async (name: string) => {
        sent.push('rename')
        if (switchAfter === 'rename') bump()
        return { mind: { id: 'a_pipmind', name, status: 'asleep' } }
      },
      patchAgent: async () => {
        sent.push('persona')
        if (switchAfter === 'persona') bump()
        return { id: 'a_pipmind' }
      },
      setAskSettings: async () => (sent.push('ask'), {}),
    } satisfies FlClient
  }
  for (const [switchAfter, how, expected] of [['rename', 'Warm.', ['rename']], ['rename', null, ['rename']], ['persona', 'Warm.', ['rename', 'persona']]] as const) {
    it(`a switch after the ${switchAfter} step (how ${how === null ? 'unchanged' : 'changed'}) sends nothing more`, async () => {
      const h = new FakeHost()
      h.how = 'Kind.'
      const sent: string[] = []
      h.liveClient = client(sent, switchAfter)
      await g().start({ mode: 'live', host: h, beat: 'ask' })
      await flush()
      expect(at()).toBe('6.1')
      await g().saveAsk({ name: 'Wren', how: how === null ? 'Kind.' : how })
      await flush()
      expect(sent).toEqual(expected)
      expect(sent).not.toContain('ask')
      // the journey is gone with the old person: nothing is recorded or shown as saved
      expect(g().run).toBeNull()
      expect(h.calls.some((c) => c.startsWith('write:') && c.includes('"ask"'))).toBe(false)
    })
  }
})

describe('R3.3: saving only the name never touches the persona (stand-in R3.2 P1)', () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: be careful, kind and exact about the garden club notes.`).join('\n')
  it('a multi-line persona over 400 characters, renamed only: no persona write is sent', async () => {
    expect(LONG.length).toBeGreaterThan(400)
    expect(LONG).toContain('\n')
    const h = new FakeHost()
    h.how = LONG
    const sent: string[] = []
    h.liveClient = {
      renameMyMind: async (name: string) => (sent.push('rename'), { mind: { id: 'a_pipmind', name, status: 'asleep' } }),
      patchAgent: async () => (sent.push('persona'), { id: 'a_pipmind' }),
      setAskSettings: async () => (sent.push('ask'), {}),
    }
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    expect(g().run!.facts.askHow).toBe(LONG) // read whole, never cut
    await g().saveAsk(askToSave('Wren', null, g().run!.facts.askHow))
    await flush()
    expect(sent).toEqual(['rename', 'ask'])
    expect(h.how).toBe(LONG)
    expect(g().run!.beats.ask.state).toBe('ready')
  })
})

describe('editable default purpose: explicit choices and asynchronous read identity', () => {
  it('explicit Save of the visible known-empty default persists that exact purpose', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    expect(g().run!.facts.askHow).toBe('')
    await g().saveAsk(askToSave('Wren', null, g().run!.facts.askHow))
    await flush()
    expect(h.how).toBe(DEFAULT_ASK_PURPOSE)
    expect(g().run!.facts.askHow).toBe(DEFAULT_ASK_PURPOSE)
    expect(at()).toBe('6.2')
  })

  it('explicitly clearing the proposed default stays empty after Save', async () => {
    const h = new FakeHost()
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    await g().saveAsk(askToSave('Wren', '', g().run!.facts.askHow))
    await flush()
    expect(h.calls).toContain('saveAsk:a_pipmind:{"name":"Wren","how":""}')
    expect(h.how).toBe('')
    expect(g().run!.facts.askHow).toBe('')
  })

  it('a failed persona read remains unknown and name-only Save sends no persona', async () => {
    const h = new FakeHost()
    h.askHow = async () => { throw new Error('offline') }
    const sent: string[] = []
    h.liveClient = {
      renameMyMind: async (name) => (sent.push('rename'), { mind: { id: 'a_pipmind', name, status: 'asleep' } }),
      patchAgent: async () => (sent.push('persona'), {}),
      setAskSettings: async () => (sent.push('ask'), {}),
    }
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    expect(g().run!.facts.askHow).toBeNull()
    await g().saveAsk(askToSave('Wren', null, g().run!.facts.askHow))
    await flush()
    expect(sent).toEqual(['rename', 'ask'])
    expect(g().run!.facts.askHow).toBeNull()
  })

  it('a persona answer arriving after a person switch is never committed', async () => {
    const h = new FakeHost()
    let answer!: (value: string) => void
    h.askHow = () => new Promise<string>((resolve) => { answer = resolve })
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    expect(typeof answer).toBe('function')
    useHive.setState((st) => ({ inits: st.inits + 1 }))
    answer('')
    await flush()
    expect(g().run).toBeNull()
    expect(h.calls.some((call) => call.startsWith('saveAsk'))).toBe(false)
  })

  it('a persona answer for a replaced mind is not used as the new mind’s default', async () => {
    const h = new FakeHost()
    let answer!: (value: string) => void
    h.askHow = () => new Promise<string>((resolve) => { answer = resolve })
    await g().start({ mode: 'live', host: h, beat: 'ask' })
    await flush()
    const r = g().run!
    useFirstLight.setState({ run: { ...r, facts: { ...r.facts, mind: { id: 'a_other', name: 'Other', status: 'asleep' } } } })
    answer('')
    await flush()
    expect(g().run!.facts.mind?.id).toBe('a_other')
    expect(g().run!.facts.askHow).toBeNull()
  })
})

describe('typed stops at UI action boundaries are quiet stops, not ordinary refusals', () => {
  const errors = () => [new ApiError(409, 'identity_changed', 'Earlier sign-in answer'), new OperationStopped()]
  const bump = () => useHive.setState((st) => ({ inits: st.inits + 1 }))

  it('a stopped guest limit request neither rejects its UI action nor reads setup or displays an ordinary refusal', async () => {
    for (const error of errors()) for (const switchPerson of [false, true]) {
      const h = new FakeHost()
      h.own_ = { ...h.own_, your_access: 'guest', you_are_owner: false }
      await g().start({ mode: 'live', host: h, beat: 'models' })
      await flush()
      let attempted = 0
      h.askForMore = async () => { attempted++; if (switchPerson) bump(); throw error }
      const setupReads = h.calls.filter((c) => c === 'setup').length
      await expect(g().askForMore(7)).resolves.toBeUndefined()
      await flush()
      expect(attempted).toBe(1)
      expect(h.calls.filter((c) => c === 'setup')).toHaveLength(setupReads)
      if (switchPerson) expect(g().run).toBeNull()
      else {
        expect(g().run!.ask.error).toBeNull()
        expect(g().run!.ask.sent).toBeNull()
      }
      g().stop()
    }
  })

  it('a stopped Wake neither rejects its UI action nor displays a refusal, greeting or successful beat', async () => {
    for (const error of errors()) for (const switchPerson of [false, true]) {
      const h = new FakeHost()
      await g().start({ mode: 'live', host: h, beat: 'hello' })
      await flush()
      let attempted = 0
      h.helloWake = async () => { attempted++; if (switchPerson) bump(); throw error }
      await expect(g().wake()).resolves.toBeUndefined()
      await flush()
      expect(attempted).toBe(1)
      if (switchPerson) expect(g().run).toBeNull()
      else {
        expect(g().run!.hello.refusal).toBeNull()
        expect(g().run!.hello.hello).toBeNull()
        expect(g().run!.facts.greeted).toBe(false)
        expect(g().run!.beats.hello.state).not.toBe('blocked')
        expect(g().run!.beats.hello.state).not.toBe('ready')
      }
      expect(h.calls.some((c) => c.startsWith('write:') && c.includes('"hello"'))).toBe(false)
      g().stop()
    }
  })

  it('a stopped startup read resolves without ordinary refusal logging or showing a start error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (const error of errors()) for (const switchPerson of [false, true]) {
        const h = new FakeHost()
        let attempted = 0
        h.progress = async () => { attempted++; if (switchPerson) bump(); throw error }
        await expect(g().start({ mode: 'live', host: h })).resolves.toBe(true)
        await flush()
        expect(attempted).toBe(1)
        expect(warn).not.toHaveBeenCalled()
        if (switchPerson) expect(g().run).toBeNull()
        else {
          expect(g().run!.loadError).toBeNull()
          expect(g().run!.beats.arrive.state).toBe('pending')
        }
        g().stop()
      }
    } finally { warn.mockRestore() }
  })
})

describe('"Not now" is remembered on the host (live walk 11-08)', () => {
  it('records status skipped (compare-and-set) so the next sign-in, on any device, does not reopen First Light', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await flush()
    expect(g().run).not.toBeNull()
    g().notNow()
    expect(g().run).toBeNull()
    await flush(12)
    expect(h.calls).toContain(`write:${JSON.stringify({ status: 'skipped' })}@0`)
    expect(h.p.status).toBe('skipped')
    // what IntroLayer reads on the next load: complete, so nothing opens by itself
    const opened: string[] = []
    expect(await enterFirstRun({ onboarding: async () => ({ record: 'first-light.progress/1', ...h.p }) }, () => opened.push('open'))).toBe('complete')
    expect(opened).toEqual([])
  })

  it('a stale version is re-read from the refusal and written once more; a finished record is never turned into skipped', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await flush()
    h.stale = true // the next write is refused as stale, carrying the record as another device left it (version 7)
    h.p = { ...h.p, version: 7 }
    g().notNow()
    await flush(12)
    expect(h.calls.filter((c) => c.startsWith('write:{"status":"skipped"}'))).toEqual(['write:{"status":"skipped"}@7', 'write:{"status":"skipped"}@7'])
    expect(h.p.status).toBe('skipped')

    const done = new SingleHost()
    done.p = { ...done.p, status: 'finished', version: 3 }
    await g().start({ mode: 'live', host: done, singleScreen: true })
    await flush()
    g().notNow()
    await flush(12)
    expect(done.calls.some((c) => c.includes('"skipped"'))).toBe(false)
    expect(done.p.status).toBe('finished')
  })

  it('the demo writes nothing, and plain Stop/Continue still only closes', async () => {
    const h = new SingleHost()
    await g().start({ mode: 'live', host: h, singleScreen: true })
    await flush()
    g().stop()
    await flush(12)
    expect(h.calls.some((c) => c.includes('"skipped"'))).toBe(false)
    await g().start({ mode: 'demo', persona: 'pip' })
    await flush()
    g().notNow()
    expect(g().run).toBeNull()
  })
})
