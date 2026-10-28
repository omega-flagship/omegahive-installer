import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewLook } from '../../shell/uiVariant'
import { DEMO_GREET_MS, DemoHost } from './demo'
import { BLANK_PROGRESS, FlRefusal, liveHost, type AppRef, type AskShape, type BoundWrite, type FlClient, type FlHost, type Hello, type HiveOwn, type MonthlyLimit, type Progress, type ProgressWrite, type Setup } from './host'
import { useHive } from '../../store/store'
import { autoHeld, setFlScreen, stepOf, useFirstLight, type FlScreen } from './store'
import { askToSave } from './host'

/** A live-shaped host with scripted answers; it records every call (nothing reaches a hive). */
class FakeHost implements FlHost {
  readonly kind = 'live' as const
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
    return write(async () => {
      if (shape.how !== null) this.how = shape.how
      return { id: mindId, name: shape.name, status: 'asleep' }
    })
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
