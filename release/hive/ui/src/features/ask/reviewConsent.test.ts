import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review B1 on c81986a (SURFACE_ASK_VOICE_C81986A_REVIEW_VERDICT_20261006): consent, the pause choice, a start and a
 * queued send are fenced to the sign-in that is current at the moment of use, synchronously with the identity change,
 * before any React effect refreshes. The real useAskVoice runs under a tiny deterministic React (state slots kept per
 * render, effects run after each render when their deps change) and a controlled Ask store. Fake recognition only; no
 * microphone, no network, no model.
 */
type State = { epoch: number; bound: { principal: string } | null }
type Listener = (s: State) => void
const x = vi.hoisted(() => ({
  state: { epoch: 1, bound: { principal: 'user:A' } } as State,
  listeners: new Set<Listener>(),
  stored: {} as Record<string, string>,
}))

// ---- a tiny React: one component instance, state slots by call order, effects after render when deps change
const R = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  effects: [] as { deps?: unknown[]; cleanup?: unknown }[],
  e: 0,
  pending: [] as (() => void)[],
}))
vi.mock('react', () => {
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]))
  return {
    useRef: (v: unknown) => {
      const k = R.i++
      if (!(k in R.slots)) R.slots[k] = { current: v }
      return R.slots[k]
    },
    useState: (v: unknown) => {
      const k = R.i++
      if (!(k in R.slots)) R.slots[k] = typeof v === 'function' ? (v as () => unknown)() : v
      const set = (n: unknown) => void (R.slots[k] = typeof n === 'function' ? (n as (p: unknown) => unknown)(R.slots[k]) : n)
      return [R.slots[k], set]
    },
    useCallback: (f: unknown) => f,
    useEffect: (f: () => unknown, deps?: unknown[]) => {
      const k = R.e++
      const prev = R.effects[k]
      if (prev && same(prev.deps, deps)) return
      R.pending.push(() => {
        if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
        R.effects[k] = { deps, cleanup: f() }
      })
    },
  }
})
vi.mock('../../store/ask', () => ({
  useAskStore: Object.assign(<T,>(sel: (s: State) => T) => sel(x.state), {
    getState: () => x.state,
    subscribe: (f: Listener) => {
      x.listeners.add(f)
      return () => x.listeners.delete(f)
    },
  }),
}))
class Rec {
  static made: Rec[] = []
  lang = ''
  continuous = false
  interimResults = false
  onstart = null
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = 0
  constructor() {
    Rec.made.push(this)
  }
  start() {
    this.started++
  }
  stops = 0
  stop() {
    this.stops++
  }
  abort() {}
}
vi.stubGlobal('SpeechRecognition', Rec)
vi.stubGlobal('isSecureContext', true)
vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
vi.stubGlobal('document', { documentElement: { lang: 'en-GB' }, querySelector: () => null, addEventListener() {}, removeEventListener() {} })
vi.stubGlobal('localStorage', { getItem: (k: string) => x.stored[k] ?? null, setItem: (k: string, v: string) => void (x.stored[k] = v) })
const voiceModule = await import('./useAskVoice')
const { voiceChoices } = voiceModule
/** the hook under test, called by the tiny React's render below (not a component) */
const mountVoice = voiceModule.useAskVoice

let text = ''
const submits: string[] = []
const field = { voiceText: (v: string) => void (text = v), valueNow: () => text, submit: () => void submits.push(text) }
/** one render, then its effects (as React commits) */
function render() {
  R.i = 0
  R.e = 0
  const api = mountVoice(field, { current: null }, { current: null })
  const run = R.pending.splice(0)
  run.forEach((f) => f())
  return api
}
const flush = async () => {
  for (let k = 0; k < 6; k++) await Promise.resolve()
}
/** a synchronous sign-in change, as the store makes it: the epoch moves and subscribers run inside the change */
function signIn(bound: State['bound']) {
  x.state = { epoch: x.state.epoch + 1, bound }
  for (const l of [...x.listeners]) l(x.state)
}
/** the store as it was when the first person consented (the shape of the build under test) */
const consentOf = (who: string, vendor = 'your browser’s maker') => voiceChoices.write(who, voiceChoices.withConsent(voiceChoices.read(who), vendor))

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
  R.slots = []
  R.effects = []
  R.pending = []
  Rec.made = []
  x.listeners.clear()
  x.state = { epoch: 1, bound: { principal: 'user:A' } }
  x.stored = {}
  text = ''
  submits.length = 0
})
afterEach(() => {
  for (const e of R.effects) if (typeof e?.cleanup === 'function') (e.cleanup as () => void)()
})

it('Review: old render consent must not start service after a synchronous sign-in reset', async () => {
  consentOf('user:A')
  const api = render()
  await flush()
  signIn(null)
  // the old render's handler, before any effect refreshed
  api.toggle()
  await flush()
  expect(Rec.made).toHaveLength(0)
})

it('A’s consent is not borrowed by B, nor by an unidentified person', async () => {
  consentOf('user:A')
  const api = render()
  await flush()
  signIn({ principal: 'user:B' })
  api.toggle()
  await flush()
  expect(Rec.made).toHaveLength(0)
  render()
  signIn(null)
  render().toggle()
  await flush()
  expect(Rec.made).toHaveLength(0)
})

it('A→B→A: A’s own stored choice is A’s again; B’s press in between constructed nothing', async () => {
  consentOf('user:A')
  render()
  await flush()
  signIn({ principal: 'user:B' })
  render().toggle()
  await flush()
  expect(Rec.made).toHaveLength(0)
  signIn({ principal: 'user:A' })
  render().toggle()
  await flush()
  expect(Rec.made).toHaveLength(1)
})

it('a consent notice shown to A, pressed after the change, writes and starts nothing', async () => {
  const api0 = render()
  await flush()
  api0.toggle()
  await flush()
  const shown = render()
  expect(shown.notice?.kind).toBe('consent')
  signIn({ principal: 'user:B' })
  // the retained notice's own button
  shown.consent()
  await flush()
  expect(Rec.made).toHaveLength(0)
  expect(voiceChoices.read('user:B').services).toBeFalsy()
  expect(voiceChoices.read('user:A').services).toBeFalsy()
})

it('the pause choice drawn for A, pressed after the change, writes nothing for B', async () => {
  const api = render()
  await flush()
  signIn({ principal: 'user:B' })
  api.setAutoSend(true)
  expect(voiceChoices.read('user:B').pause).toBeFalsy()
  expect(voiceChoices.read('user:A').pause).toBeFalsy()
})

it('a start waiting on the on-device answer constructs nothing if the sign-in changed meanwhile', async () => {
  // the browser answers late: the probe is still out when the press arrives
  let answer: (v: string) => void = () => {}
  ;(Rec as unknown as { available: unknown }).available = () => new Promise<string>((r) => (answer = r))
  Object.defineProperty(Rec.prototype, 'processLocally', { value: false, writable: true, configurable: true })
  consentOf('user:A')
  const api = render()
  api.toggle()
  signIn({ principal: 'user:B' })
  answer('unavailable')
  await flush()
  expect(Rec.made).toHaveLength(0)
  delete (Rec as unknown as { available?: unknown }).available
  delete (Rec.prototype as { processLocally?: boolean }).processLocally
})

it('a send queued for after the last words is dropped if the sign-in changed before it ran', async () => {
  voiceChoices.write('user:A', { services: { 'your browser’s maker': true }, pause: true })
  const api = render()
  await flush()
  api.toggle()
  await flush()
  render()
  const rec = Rec.made[0]
  rec.onresult?.({ results: [Object.assign([{ transcript: 'A private words' }], { isFinal: true })] })
  // the person stops; the browser ends the session; the send is queued for the next render
  render().stop()
  rec.onend?.()
  signIn({ principal: 'user:B' })
  render()
  render()
  expect(submits).toEqual([])
})

it('(control) without a sign-in change the same queued send does run, once', async () => {
  voiceChoices.write('user:A', { services: { 'your browser’s maker': true }, pause: true })
  const api = render()
  await flush()
  api.toggle()
  await flush()
  render()
  const rec = Rec.made[0]
  rec.onresult?.({ results: [Object.assign([{ transcript: 'A words' }], { isFinal: true })] })
  render().stop()
  rec.onend?.()
  render()
  render()
  expect(submits).toEqual(['A words'])
})

it('Kimi 6: consent to one maker’s service (Google) does not cover another’s (Apple) in the same browser profile', async () => {
  const ua = (s: string) => vi.stubGlobal('navigator', { userAgent: s, language: 'en-GB' })
  ua('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36')
  const api = render()
  await flush()
  api.toggle()
  await flush()
  const shown = render()
  expect(shown.notice).toMatchObject({ kind: 'consent', vendor: 'Google' })
  shown.consent()
  await flush()
  expect(Rec.made).toHaveLength(1)
  // a fresh page in a browser whose service belongs to Apple
  for (const e of R.effects) if (typeof e?.cleanup === 'function') (e.cleanup as () => void)()
  R.slots = []
  R.effects = []
  ua('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15')
  const again = render()
  await flush()
  again.toggle()
  await flush()
  expect(Rec.made).toHaveLength(1)
  expect(render().notice).toMatchObject({ kind: 'consent', vendor: 'Apple' })
})

describe('Kimi 4: on touch, listening starts on the tap itself (click), never on pointerdown', () => {
  type Btn = { onPointerDown: (e: unknown) => void; onPointerUp: (e: unknown) => void; onClick: (e: unknown) => void }
  const down = (t: string) => ({ button: 0, pointerType: t })
  it('a touch press constructs nothing until the tap completes; the tap starts it; a long touch is still a tap', async () => {
    consentOf('user:A')
    const b = render().button as unknown as Btn
    await flush()
    b.onPointerDown(down('touch'))
    await flush()
    expect(Rec.made).toHaveLength(0)
    b.onPointerUp(down('touch'))
    b.onClick({ detail: 1 })
    await flush()
    expect(Rec.made).toHaveLength(1)
    expect(Rec.made[0].started).toBe(1)
  })
  it('(control) a mouse press still starts at once: hold-to-talk with a fine pointer', async () => {
    consentOf('user:A')
    const b = render().button as unknown as Btn
    await flush()
    b.onPointerDown(down('mouse'))
    await flush()
    expect(Rec.made).toHaveLength(1)
    // the click that follows a mouse press does not toggle it off again
    b.onPointerUp(down('mouse'))
    b.onClick({ detail: 1 })
    await flush()
    expect(Rec.made).toHaveLength(1)
  })
})

describe('Kimi 1/2/3 in the page', () => {
  const onDevice = () => {
    ;(Rec as unknown as { available: unknown }).available = async () => 'available'
    Object.defineProperty(Rec.prototype, 'processLocally', { value: false, writable: true, configurable: true })
  }
  const offDevice = () => {
    delete (Rec as unknown as { available?: unknown }).available
    delete (Rec.prototype as { processLocally?: boolean }).processLocally
  }
  afterEach(offDevice)

  it('Kimi 1: the first listening on device says the microphone is in use and nothing leaves the device', async () => {
    onDevice()
    const api = render()
    await flush()
    api.toggle()
    await flush()
    const now = render()
    expect(now.notice).toMatchObject({ kind: 'info' })
    expect((now.notice as { text: string }).text).toMatch(/microphone/i)
    expect((now.notice as { text: string }).text).toMatch(/nothing is sent/i)
    expect(now.micOn).toBe(true)
    expect(now.layerWords).toBe('on this device')
  })

  it('Kimi 2: after a not-allowed error the notice offers Try again, and it starts again from that press', async () => {
    onDevice()
    const api = render()
    await flush()
    api.toggle()
    await flush()
    render()
    Rec.made[0].onerror?.({ error: 'not-allowed' })
    Rec.made[0].onend?.()
    const shown = render()
    expect(shown.notice).toMatchObject({ kind: 'say', retry: true })
    shown.retry()
    await flush()
    expect(Rec.made).toHaveLength(2)
  })

  it('Kimi 3: a microphone permission that flips to denied while listening stops it', async () => {
    onDevice()
    const status: { state: string; onchange: (() => void) | null } = { state: 'granted', onchange: null }
    vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB', permissions: { query: async () => status } })
    const api = render()
    await flush()
    api.toggle()
    await flush()
    render()
    status.state = 'denied'
    status.onchange?.()
    expect(render().state).toBe('idle')
    expect(render().notice).toMatchObject({ kind: 'say' })
  })
})

describe('r3: a deferred automatic send follows the current pause choice; manual Enter is untouched', () => {
  const queueSend = async () => {
    voiceChoices.write('user:A', { services: { 'your browser’s maker': true }, pause: true })
    const api = render()
    await flush()
    api.toggle()
    await flush()
    render()
    const rec = Rec.made[0]
    rec.onresult?.({ results: [Object.assign([{ transcript: 'queued words' }], { isFinal: true })] })
    const shown = render()
    shown.stop()
    rec.onend?.()
    // the send is queued for the next commit; this render's toggle is what the person can still press
    return shown
  }
  it('auto-send turned off after the send was queued, before it ran: dropped, words kept', async () => {
    const shown = await queueSend()
    // the person's toggle, drawn in the render on screen, pressed before the queued send ran
    shown.setAutoSend(false)
    render()
    render()
    expect(submits).toEqual([])
    expect(text).toBe('queued words')
  })
  it('(control) left on, the queued send runs once', async () => {
    await queueSend()
    render()
    render()
    expect(submits).toEqual(['queued words'])
  })
  it('(control) manual Enter with auto-send off: the field’s own Enter still sends (voice only stops listening)', async () => {
    voiceChoices.write('user:A', { services: { 'your browser’s maker': true }, pause: false })
    const api = render()
    await flush()
    api.toggle()
    await flush()
    const now = render()
    Rec.made[0].onresult?.({ results: [Object.assign([{ transcript: 'send by hand' }], { isFinal: true })] })
    let prevented = false
    const handled = now.onFieldKey({ key: 'Enter', preventDefault: () => (prevented = true) } as never)
    // not handled by voice: the field's own key handler goes on to submit exactly as typed
    expect(handled).toBe(false)
    expect(prevented).toBe(false)
    expect(render().state).toBe('idle')
    field.submit()
    expect(submits).toEqual(['send by hand'])
  })
})

describe('Kimi r3 #2: a press stops listening on every pointer, and its click does not toggle again', () => {
  type Btn = { onPointerDown: (e: unknown) => void; onPointerUp: (e: unknown) => void; onClick: (e: unknown) => void }
  for (const kind of ['touch', 'pen', 'mouse']) {
    it(`${kind}: pointerdown on the mic while listening stops at once; a swallowed click leaves it stopped; a delivered click does not restart`, async () => {
      consentOf('user:A')
      const api = render()
      await flush()
      api.toggle()
      await flush()
      expect(Rec.made).toHaveLength(1)
      const rec = Rec.made[0]
      const b = render().button as unknown as Btn
      b.onPointerDown({ button: 0, pointerType: kind })
      // the press alone (its click may never arrive) already asked the browser to stop
      expect(rec.stops).toBe(1)
      rec.onend?.()
      render()
      b.onPointerUp({ button: 0, pointerType: kind })
      b.onClick({ detail: 1 })
      await flush()
      expect(Rec.made).toHaveLength(1)
      expect(render().state).toBe('idle')
    })
  }
})

describe('Kimi r3 #4: an unknown person’s page-only choice never outlives their sign-in, even if an epoch number recurs', () => {
  it('pause chosen while unidentified at epoch 5 is gone after a sign-in, even back at epoch 5 unidentified', async () => {
    x.state = { epoch: 5, bound: null }
    const api = render()
    await flush()
    api.setAutoSend(true)
    expect(render().autoSend).toBe(true)
    signIn({ principal: 'user:A' })
    render()
    // the store re-created (HMR, an error boundary): the epoch counter starts over and recurs
    x.state = { epoch: 5, bound: null }
    for (const l of [...x.listeners]) l(x.state)
    expect(render().autoSend).toBe(false)
  })
})

describe('Stand-in r4 P1 #1: a sign-in change clears the earlier person’s draft, even while the mic is idle', () => {
  it('stand-in witness: A speaks, stops (send on pause off), then A→B: A’s spoken words leave the field', async () => {
    consentOf('user:A')
    const api = render()
    await flush()
    api.toggle()
    await flush()
    render()
    const rec = Rec.made[0]
    rec.onresult?.({ results: [Object.assign([{ transcript: 'A private spoken draft' }], { isFinal: true })] })
    render().stop()
    rec.onend?.()
    render()
    expect(text).toBe('A private spoken draft')
    signIn({ principal: 'user:B' })
    expect(text).toBe('')
    render()
    expect(text).toBe('')
  })

  it('stand-in witness: A’s typed draft, idle microphone, A→B: the draft leaves the field', async () => {
    render()
    await flush()
    text = 'A private typed draft'
    signIn({ principal: 'user:B' })
    expect(text).toBe('')
  })

  it('A→nobody (sign-out) clears too', async () => {
    render()
    await flush()
    text = 'A typed before signing out'
    signIn(null)
    expect(text).toBe('')
  })

  it('(control) the page learning who is signed in for the first time keeps what was typed meanwhile', async () => {
    x.state = { epoch: 1, bound: null }
    render()
    await flush()
    text = 'typed while the page loaded'
    // bind(): a reset with nobody bound yet, then the person
    x.state = { epoch: 2, bound: null }
    for (const l of [...x.listeners]) l(x.state)
    x.state = { epoch: 2, bound: { principal: 'user:A' } }
    for (const l of [...x.listeners]) l(x.state)
    expect(text).toBe('typed while the page loaded')
  })
})
