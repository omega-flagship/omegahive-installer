import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Voice for the universal Ask (Phase 3, browser on-device speech first; Jon's ruling relayed by Platform 2026-10-06).
 * A fake SpeechRecognition stands in for the browser's: it records what the page set and started, and plays interim
 * and final results, errors and the end of a session. Invented people and words only; no microphone, no network, no
 * model. The words leave only through the field's own path (askMind: a request, or a steer while it works).
 */
const loc = { hash: '#/', search: '', pathname: '/' }
const kv = new Map<string, string>()
const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: loc, matchMedia: () => ({ matches: false }), localStorage: storage }))
vi.stubGlobal('localStorage', storage)
vi.mock('../../lib/router', async (orig) => {
  const real = await orig<typeof import('../../lib/router')>()
  return { ...real, navigate: (r: import('../../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { AskVoice, PAUSE_MS, probeOnDevice, unsupportedWords, vendorOf, voiceErrorWords, voiceSupport } = await import('./voice')
const { voiceChoices, voiceFollowsSignIn } = await import('./useAskVoice')
const { askMind } = await import('./mind')
type VoiceHooks = import('./voice').VoiceHooks
type RecognitionCtor = import('./voice').RecognitionCtor
type AskBody = import('../../api/ask').AskBody
type AskTurnState = import('../../api/ask').AskTurnState
type HiveClient = import('../../api/client').HiveClient

// ---------------------------------------------------------------- the fake recognition

type Res = { transcript: string; isFinal: boolean }
class FakeRec {
  static made: FakeRec[] = []
  static throwOnStart = false
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  processLocally?: boolean
  mode?: string
  onstart: ((e: unknown) => void) | null = null
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: ((e: unknown) => void) | null = null
  onspeechend: ((e: unknown) => void) | null = null
  started = 0
  stopped = 0
  aborted = 0
  constructor() {
    FakeRec.made.push(this)
  }
  start() {
    if (FakeRec.throwOnStart) throw new Error('InvalidStateError')
    this.started++
  }
  stop() {
    this.stopped++
  }
  abort() {
    this.aborted++
  }
  /** the whole result list so far, as browsers send it */
  say(list: Res[]) {
    this.onresult?.({ resultIndex: 0, results: list.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })) })
  }
  fail(error: string) {
    this.onerror?.({ error })
  }
  end() {
    this.onend?.({})
  }
}
const last = () => FakeRec.made[FakeRec.made.length - 1]

/** a recognition class with the on-device question answered as `local` ('available', 'downloadable', …) */
function ctorWith(opts: { local?: string; draft?: string | boolean; throws?: boolean } = {}): RecognitionCtor & { installs: number; asked: unknown[] } {
  class R extends FakeRec {}
  const C = R as unknown as RecognitionCtor & { installs: number; asked: unknown[] }
  C.installs = 0
  C.asked = []
  if (opts.local !== undefined) {
    Object.defineProperty(R.prototype, 'processLocally', { value: false, writable: true })
    C.available = async (o) => {
      C.asked.push(o)
      if (opts.throws) throw new Error('nope')
      return opts.local!
    }
    ;(C as unknown as { install: () => Promise<boolean> }).install = async () => (C.installs++, true)
  }
  if (opts.draft !== undefined) C.availableOnDevice = async () => opts.draft!
  return C
}

/** a field as the Ask has one: words, how they were made, and its own submit */
function field(start = '') {
  const f = { text: start, sends: [] as string[], says: [] as (string | null)[], announced: [] as string[], states: [] as string[] }
  return f
}
function voice(ctor: RecognitionCtor, f = field(), o: { pause?: boolean; consented?: boolean; vendor?: string; send?: (t: string) => void } = {}) {
  const timers: { fn: () => void; at: number; id: number }[] = []
  let now = 0
  let ids = 0
  const h: VoiceHooks = {
    support: { ok: true, ctor, vendor: o.vendor ?? 'Google' },
    lang: 'en-GB',
    getText: () => f.text,
    setText: (v) => void (f.text = v),
    send: () => (f.sends.push(f.text), o.send?.(f.text)),
    autoSend: () => !!o.pause,
    consented: () => !!o.consented,
    onState: (s, l) => void f.states.push(`${s}${l ? `:${l}` : ''}`),
    announce: (m) => void f.announced.push(m),
    say: (m) => void f.says.push(m),
    timers: {
      set: (fn, ms) => {
        const id = ++ids
        timers.push({ fn, at: now + ms, id })
        return id
      },
      clear: (id) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      },
    },
  }
  const v = new AskVoice(h)
  const tick = (ms: number) => {
    now += ms
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= now && timers.includes(t)) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    }
  }
  return { v, f, h, tick, pending: () => timers.length }
}

beforeEach(() => {
  FakeRec.made = []
  FakeRec.throwOnStart = false
  kv.clear()
})

// ---------------------------------------------------------------- support and layers

describe('voice: what this browser offers, found by feature detection', () => {
  it('no recognition at all (Firefox) is unsupported; an insecure page too; Safari’s webkit prefix is used', () => {
    expect(voiceSupport({})).toEqual({ ok: false, why: 'no-api' })
    expect(voiceSupport({ webkitSpeechRecognition: ctorWith(), isSecureContext: false })).toEqual({ ok: false, why: 'insecure' })
    const w = ctorWith()
    const s = voiceSupport({ webkitSpeechRecognition: w, isSecureContext: true, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } })
    expect(s.ok && s.ctor).toBe(w)
    expect(s.ok && s.vendor).toBe('Apple')
    for (const why of ['no-api', 'insecure'] as const) expect(unsupportedWords(why)).toMatch(/^[^\n]+\.$/)
  })

  it('names who runs the browser’s service from the user agent (iPhone browsers are all Apple’s engine)', () => {
    expect(vendorOf('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36')).toBe('Google')
    expect(vendorOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Microsoft')
    expect(vendorOf('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15')).toBe('Apple')
    expect(vendorOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 CriOS/141.0 Mobile/15E148 Safari/604.1')).toBe('Apple')
    expect(vendorOf('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/140.0')).toBe('your browser’s maker')
  })

  it('on device only when the browser says "available"; a downloadable pack is never installed from here', async () => {
    expect(await probeOnDevice(ctorWith({ local: 'available' }), 'en-GB')).toBe('processLocally')
    const dl = ctorWith({ local: 'downloadable' })
    expect(await probeOnDevice(dl, 'en-GB')).toBeNull()
    expect(dl.installs).toBe(0)
    expect(dl.asked).toEqual([{ langs: ['en-GB'], processLocally: true }])
    expect(await probeOnDevice(ctorWith({ draft: true }), 'en-GB')).toBe('ondevice-only')
    expect(await probeOnDevice(ctorWith({ draft: 'available' }), 'en-GB')).toBe('ondevice-only')
    expect(await probeOnDevice(ctorWith({ draft: false }), 'en-GB')).toBeNull()
    expect(await probeOnDevice(ctorWith({ local: 'available', throws: true }), 'en-GB')).toBeNull()
    expect(await probeOnDevice(ctorWith(), 'en-GB')).toBeNull()
  })
})

describe('voice: on this device first', () => {
  it('starts on device with processLocally, inside the press itself once the answer is known', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }))
    await v.probe()
    const r = v.start()
    // no await yet: the recognition already started (iOS and gesture-bound browsers need this)
    expect(last().started).toBe(1)
    expect(await r).toBe('started')
    expect(last().processLocally).toBe(true)
    expect(last().continuous).toBe(true)
    expect(last().interimResults).toBe(true)
    expect(last().lang).toBe('en-GB')
    expect(v.layer).toBe('on-device')
    expect(f.announced).toEqual(['Listening, on this device.'])
  })

  it('the older on-device draft uses ondevice-only mode', async () => {
    const { v } = voice(ctorWith({ draft: true }))
    expect(await v.start()).toBe('started')
    expect(last().mode).toBe('ondevice-only')
    expect(last().processLocally).toBeUndefined()
  })

  it('an on-device refusal is said, never silently replaced by the service; the next press asks the person', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }))
    await v.start()
    last().fail('language-not-supported')
    last().end()
    expect(f.says.filter(Boolean).at(-1)).toMatch(/On-device speech is not ready for this language here; nothing was sent anywhere\./)
    expect(FakeRec.made).toHaveLength(1)
    expect(await v.start()).toBe('needs-consent')
    expect(FakeRec.made).toHaveLength(1)
  })
})

describe('voice: the browser’s service only after an explicit opt-in', () => {
  it('without on-device and without the opt-in nothing is constructed or started', async () => {
    const { v, f } = voice(ctorWith({ local: 'unavailable' }))
    expect(await v.start()).toBe('needs-consent')
    expect(FakeRec.made).toHaveLength(0)
    expect(f.states.at(-1)).toBe('idle')
  })

  it('with the opt-in it listens through the service, named honestly, with no on-device flag set', async () => {
    const { v, f } = voice(ctorWith(), field(), { consented: true, vendor: 'Apple' })
    expect(await v.start()).toBe('started')
    expect(v.layer).toBe('service')
    expect(last().processLocally).toBeUndefined()
    expect(last().mode).toBeUndefined()
    expect(f.announced).toEqual(['Listening, through Apple’s speech service.'])
  })

  it('the opt-in (per maker) and send-on-pause are kept in this browser per person', () => {
    const G = { services: { Google: true as const }, pause: true }
    voiceChoices.write('user:ann', G)
    expect(voiceChoices.read('user:ann')).toEqual(G)
    expect(voiceChoices.consentedTo(voiceChoices.read('user:ann'), 'Google')).toBe(true)
    expect(voiceChoices.consentedTo(voiceChoices.read('user:ann'), 'Apple')).toBe(false)
    expect(voiceChoices.read('user:bea')).toEqual({})
    // an unknown person's choice lasts for this page and this sign-in only, never stored and never inherited
    voiceChoices.write('unknown#3', { services: { Google: true } })
    expect(voiceChoices.read('unknown#3')).toEqual({ services: { Google: true } })
    expect(voiceChoices.read('unknown#4')).toEqual({})
    voiceChoices.write(null, { services: { Google: true } })
    expect(voiceChoices.read(null)).toEqual({})
    expect(JSON.parse(kv.get(voiceChoices.key)!)).toEqual({ 'user:ann': G })
    // a stored value that is not a plain yes is not consent; an older yes that named no maker is not consent either
    kv.set(voiceChoices.key, JSON.stringify({ 'user:cy': { services: { Google: 'yes' } }, 'user:dee': { service: true } }))
    expect(voiceChoices.consentedTo(voiceChoices.read('user:cy'), 'Google')).toBe(false)
    expect(voiceChoices.consentedTo(voiceChoices.read('user:dee'), 'Google')).toBe(false)
  })
})

describe('voice: words into the field, editable, never sent unless the person sends', () => {
  it('interim words show live after what was typed; final words replace them; nothing is sent', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field('remind me'))
    await v.start()
    last().say([{ transcript: 'to water', isFinal: false }])
    expect(f.text).toBe('remind me to water')
    last().say([{ transcript: 'to water the', isFinal: false }])
    expect(f.text).toBe('remind me to water the')
    last().say([{ transcript: 'to water the plants', isFinal: true }])
    expect(f.text).toBe('remind me to water the plants')
    tick(PAUSE_MS * 3)
    expect(f.sends).toEqual([])
    v.stop()
    expect(last().stopped).toBe(1)
    last().end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('remind me to water the plants')
    expect(f.announced.at(-1)).toBe('Stopped listening.')
  })

  it('a finished phrase repeated in the result list (iOS) is not doubled; phrases join with one space', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }))
    await v.start()
    last().say([{ transcript: 'open goals', isFinal: true }])
    last().say([
      { transcript: 'open goals', isFinal: true },
      { transcript: ' for ada', isFinal: false },
    ])
    expect(f.text).toBe('open goals for ada')
  })

  it('an edit while listening wins; later speech carries on after it', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }))
    await v.start()
    last().say([{ transcript: 'show me the reserch', isFinal: true }])
    f.text = 'show me the research'
    last().say([
      { transcript: 'show me the reserch', isFinal: true },
      { transcript: 'swarm', isFinal: false },
    ])
    expect(f.text).toBe('show me the research swarm')
  })

  it('send on a natural pause only when the person turned it on: one send, through the field', async () => {
    const off = voice(ctorWith({ local: 'available' }))
    await off.v.start()
    last().say([{ transcript: 'what is ada doing', isFinal: true }])
    off.tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(0)

    const on = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await on.v.start()
    on.f.text = ''
    last().say([{ transcript: 'what is', isFinal: false }])
    on.tick(PAUSE_MS + 10)
    // interim words are never sent on a pause
    expect(last().stopped).toBe(0)
    last().say([{ transcript: 'what is ada doing', isFinal: true }])
    on.tick(PAUSE_MS - 100)
    last().say([
      { transcript: 'what is ada doing', isFinal: true },
      { transcript: 'today', isFinal: false },
    ])
    on.tick(PAUSE_MS - 100)
    expect(last().stopped).toBe(0)
    last().say([
      { transcript: 'what is ada doing', isFinal: true },
      { transcript: 'today', isFinal: true },
    ])
    on.tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(1)
    last().end()
    expect(on.f.sends).toEqual(['what is ada doing today'])
  })

  it('an error never sends, even with send-on-pause on; each error is one plain sentence', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'half a thought', isFinal: true }])
    last().fail('network')
    last().end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('half a thought')
    for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'no-speech', 'network', 'language-not-supported', 'weird']) {
      for (const layer of ['on-device', 'service', null] as const) {
        const w = voiceErrorWords(code, layer, 'Google')!
        expect(w).toMatch(/^[A-Z][^\n]*\.$/)
        expect(w.split(/\.\s/).length).toBe(1)
      }
    }
    expect(voiceErrorWords('aborted', 'service', 'Google')).toBeNull()
    expect(voiceErrorWords('not-allowed', 'service', 'Google')).toMatch(/microphone is blocked/)
    expect(voiceErrorWords('no-speech', 'service', 'Google')).toMatch(/did not hear/)
    expect(voiceErrorWords('network', 'service', 'Google')).toMatch(/Google’s speech service could not be reached/)
  })

  it('a browser that refuses to start says so and is idle again', async () => {
    FakeRec.throwOnStart = true
    const { v, f } = voice(ctorWith({ local: 'available' }))
    expect(await v.start()).toBe('unsupported')
    expect(v.state).toBe('idle')
    expect(f.says.at(-1)).toMatch(/did not start listening/)
  })

  it('unsupported: nothing starts', async () => {
    const f = field()
    const v = new AskVoice({ ...voice(ctorWith()).h, support: { ok: false, why: 'no-api' } })
    expect(await v.start()).toBe('unsupported')
    expect(FakeRec.made).toHaveLength(0)
    expect(f.states).toEqual([])
  })

  it('abort drops the session: late words never write; clear empties the field', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }), field('typed first'))
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'private words', isFinal: false }])
    v.abort({ clear: true })
    expect(rec.aborted).toBe(1)
    expect(f.text).toBe('')
    rec.say([{ transcript: 'private words later', isFinal: true }])
    rec.end()
    expect(f.text).toBe('')
    expect(f.sends).toEqual([])
    expect(v.state).toBe('idle')
  })
})

// ---------------------------------------------------------------- the same path as typing, and the sign-in fence

function liveHost() {
  let handle: object = {}
  let who = 'user:ann'
  const listeners = new Set<() => void>()
  const sent: { what: string; text?: string; via?: string; op?: string }[] = []
  const thread = { id: 'ses_v1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
  const client = {
    mode: 'live',
    authContext: () => handle,
    onAuthChange: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    me: async () => ({ principal: who, kind: 'sso', role: 'member', expires_at: null, person: null }),
    ask: vi.fn(async (b: AskBody): Promise<AskTurnState> => (sent.push({ what: 'ask', text: b.text, via: b.via, op: b.operation_id }), { operation_id: b.operation_id, turn_id: `t_${b.operation_id}`, thread, state: 'accepted', events: [], more: false })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string; text: string; via?: string }) => (sent.push({ what: 'steer', text: b.text, via: b.via, op }), { steer_id: b.steer_id, operation_id: op })),
    askTurn: vi.fn(async () => {
      throw new Error('no read in this test')
    }),
    askSettings: vi.fn(async () => ({ swarm_id: 'sw_x', thread_budget_usd: 0.25 })),
  } as unknown as HiveClient
  return {
    client,
    sent,
    signIn(next: string) {
      who = next
      handle = {}
      for (const fn of [...listeners]) fn()
    },
  }
}
let n = 0
function bindTo(h: ReturnType<typeof liveHost>, principal = 'user:ann') {
  useHive.setState({ client: h.client, session: `vs-${++n}`, inits: 1000 + n })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
const ctx = { route: 'hive', experience: 'classic' }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('voice: spoken words take exactly the typed path', () => {
  afterEach(() => useAskStore.getState().reset())

  it('a spoken request is a request (via voice for the audit); spoken words while it works steer the open turn', async () => {
    const h = liveHost()
    bindTo(h)
    const { v, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true, send: (t) => void askMind(t, ctx, { via: 'voice' }) })
    await v.start()
    last().say([{ transcript: 'what is vega doing', isFinal: true }])
    tick(PAUSE_MS + 10)
    last().end()
    await flush()
    expect(h.sent).toEqual([expect.objectContaining({ what: 'ask', text: 'what is vega doing', via: 'voice' })])
    const op = h.sent[0].op
    expect(useAskStore.getState().open).toBe(op)

    // while the mind works: speaking steers, as typing does (never a second turn)
    const f2 = field()
    const two = voice(ctorWith({ local: 'available' }), f2, { pause: true, send: (t) => void askMind(t, ctx, { via: 'voice' }) })
    await two.v.start()
    last().say([{ transcript: 'only the research swarm', isFinal: true }])
    two.tick(PAUSE_MS + 10)
    last().end()
    await flush()
    expect(h.sent.at(-1)).toEqual(expect.objectContaining({ what: 'steer', text: 'only the research swarm', op }))
    expect(h.sent.filter((s) => s.what === 'ask')).toHaveLength(1)
  })

  it('a typed request still says typed', async () => {
    const h = liveHost()
    bindTo(h)
    await askMind('typed words', ctx)
    expect(h.sent[0].via).toBe('typed')
  })

  it('a sign-in change while listening drops it at once: the field empties and nothing heard later writes or sends', async () => {
    const h = liveHost()
    bindTo(h)
    const { v, f } = voice(ctorWith({ local: 'available' }), field('ann typed'), { pause: true, send: (t) => void askMind(t, ctx, { via: 'voice' }) })
    let dropped = 0
    const off = voiceFollowsSignIn(v, () => dropped++)
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'ANN PRIVATE', isFinal: false }])
    h.signIn('user:bea')
    // no await: the drop is part of the change itself
    expect(rec.aborted).toBe(1)
    expect(v.state).toBe('idle')
    expect(f.text).toBe('')
    expect(dropped).toBe(1)
    rec.say([{ transcript: 'ANN PRIVATE more', isFinal: true }])
    rec.end()
    await flush()
    expect(f.text).toBe('')
    expect(h.sent).toEqual([])
    off()
  })
})

describe('Review B2 (c81986a): a recognition error never sends, whatever arrives after it', () => {
  it('Review: an error cannot re-arm automatic send while browser end is delayed', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'private incomplete thought', isFinal: true }])
    last().fail('network')
    tick(PAUSE_MS + 1)
    last().end()
    expect(f.sends).toEqual([])
  })

  it('late speechend, results and a stop after the error neither re-arm nor send; the words stay editable', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'half heard', isFinal: true }])
    rec.fail('network')
    rec.onspeechend?.({})
    rec.say([{ transcript: 'half heard more', isFinal: true }])
    tick(PAUSE_MS * 3)
    v.stop()
    tick(PAUSE_MS * 3)
    rec.end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('half heard')
    expect(v.state).toBe('idle')
  })

  it('an on-device refusal with a delayed end sends nothing either', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'on device words', isFinal: true }])
    last().fail('language-not-supported')
    tick(PAUSE_MS + 1)
    last().end()
    expect(f.sends).toEqual([])
  })
})

describe('Kimi 5: send on pause never sends over the person’s own edits', () => {
  it('an edit during the pause window cancels the automatic send; listening carries on', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'email the team', isFinal: true }])
    tick(PAUSE_MS - 200)
    f.text = 'email the research team'
    tick(400)
    expect(last().stopped).toBe(0)
    expect(v.state).toBe('listening')
    expect(f.sends).toEqual([])
    expect(f.text).toBe('email the research team')
  })

  it('an edit after the pause stopped it, before the browser ended, cancels the send too', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'book a room', isFinal: true }])
    tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(1)
    f.text = 'book a room for friday'
    last().end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('book a room for friday')
  })
})

describe('Kimi 2/3: a blocked or revoked microphone', () => {
  it('a microphone the browser already reports denied starts nothing and says how to allow it', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }))
    ;(v as unknown as { h: VoiceHooks }).h.micDenied = () => true
    expect(await v.start()).toBe('blocked')
    expect(FakeRec.made).toHaveLength(0)
    expect(f.says.at(-1)).toMatch(/microphone is blocked/)
  })

  it('a microphone revoked while listening stops at once: words kept, nothing sent, said plainly', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'before the revoke', isFinal: true }])
    v.micRevoked()
    expect(rec.aborted).toBe(1)
    expect(v.state).toBe('idle')
    tick(PAUSE_MS * 2)
    rec.end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('before the revoke')
    expect(f.says.at(-1)).toMatch(/microphone is blocked/)
  })

  it('a blocked start and the not-allowed error carry the code so the page can offer Try again', async () => {
    const codes: (string | undefined)[] = []
    const { v, h } = voice(ctorWith({ local: 'available' }))
    h.say = (_m, code) => void codes.push(code)
    await v.start()
    last().fail('not-allowed')
    expect(codes.at(-1)).toBe('not-allowed')
  })
})

describe('Kimi (blind spot): an on-device answer that changes after load is picked up', () => {
  it('after a needs-consent answer the browser is asked again in the background; the next press is on device', async () => {
    let answer = 'unavailable'
    const C = ctorWith({ local: 'unavailable' })
    C.available = async () => answer
    const { v } = voice(C)
    await v.probe()
    answer = 'available'
    expect(await v.start()).toBe('needs-consent')
    await Promise.resolve()
    await Promise.resolve()
    const r = v.start()
    expect(last()?.started).toBe(1)
    expect(await r).toBe('started')
    expect(v.layer).toBe('on-device')
  })

  it('an on-device refusal is not undone by a later re-ask (no loop back into a refusing layer)', async () => {
    const { v } = voice(ctorWith({ local: 'available' }))
    await v.start()
    last().fail('language-not-supported')
    last().end()
    expect(await v.start()).toBe('needs-consent')
    await Promise.resolve()
    await Promise.resolve()
    expect(await v.start()).toBe('needs-consent')
    expect(FakeRec.made).toHaveLength(1)
  })
})


describe('Review r2 current pause choice', () => {
 it('switching auto-send off before the pause deadline prevents sending', async () => {
  const options = {pause:true}; const {v,f,tick}=voice(ctorWith({local:'available'}),field(),options);
  await v.probe(); await v.start(); last().say([{transcript:'retained private words',isFinal:true}]);
  options.pause=false; tick(PAUSE_MS); last().end(); expect(f.sends).toEqual([]);
 });
});

describe('r3: the pause choice is the person’s current one at every automatic step', () => {
  it('off during the pause (the page tells the controller): the timer is withdrawn, words kept, still listening', async () => {
    const o = { pause: true }
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), o)
    await v.start()
    last().say([{ transcript: 'keep these words', isFinal: true }])
    o.pause = false
    v.autoSendChanged(false)
    tick(PAUSE_MS * 3)
    expect(last().stopped).toBe(0)
    expect(v.state).toBe('listening')
    last().end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('keep these words')
  })

  it('off then on again within the pause: on is current, so the pause sends once', async () => {
    const o = { pause: true }
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), o)
    await v.start()
    last().say([{ transcript: 'changed my mind twice', isFinal: true }])
    o.pause = false
    v.autoSendChanged(false)
    tick(500)
    o.pause = true
    v.autoSendChanged(true)
    tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(1)
    last().end()
    expect(f.sends).toEqual(['changed my mind twice'])
  })

  it('off after the pause stopped it, before the browser ended: the end sends nothing', async () => {
    const o = { pause: true }
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), o)
    await v.start()
    last().say([{ transcript: 'almost sent', isFinal: true }])
    tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(1)
    o.pause = false
    last().end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('almost sent')
  })

  it('off after the person stopped with auto on, before the end: nothing sends', async () => {
    const o = { pause: true }
    const { v, f } = voice(ctorWith({ local: 'available' }), field(), o)
    await v.start()
    last().say([{ transcript: 'stopped by hand', isFinal: true }])
    v.stop()
    o.pause = false
    last().end()
    expect(f.sends).toEqual([])
  })
})

describe('Kimi r3 #1: a steer carries how the words were made, as a request does', () => {
  afterEach(() => useAskStore.getState().reset())
  it('spoken words mid-turn steer with via voice; typed words with via typed', async () => {
    const h = liveHost()
    bindTo(h)
    await askMind('first request', ctx, { via: 'voice' })
    await flush()
    await askMind('spoken while it works', ctx, { via: 'voice' })
    await askMind('typed while it works', ctx)
    await flush()
    const steers = h.sent.filter((x) => x.what === 'steer')
    expect(steers).toEqual([expect.objectContaining({ text: 'spoken while it works', via: 'voice' }), expect.objectContaining({ text: 'typed while it works', via: 'typed' })])
  })
})

describe('Kimi r3 #5: speechend landing between stop() and onend', () => {
  it('send on pause off: the person stops, speechend arrives, then the end: no send, no pause armed', async () => {
    const { v, f, tick, pending } = voice(ctorWith({ local: 'available' }))
    await v.start()
    last().say([{ transcript: 'stop here', isFinal: true }])
    v.stop()
    last().onspeechend?.({})
    expect(pending()).toBe(0)
    tick(PAUSE_MS * 3)
    last().end()
    expect(f.sends).toEqual([])
    expect(pending()).toBe(0)
  })
  it('send on pause on: the pause stops it, speechend arrives, then the end: exactly one send, no pause re-armed', async () => {
    const { v, f, tick, pending } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    last().say([{ transcript: 'one send only', isFinal: true }])
    tick(PAUSE_MS + 10)
    expect(last().stopped).toBe(1)
    last().onspeechend?.({})
    expect(pending()).toBe(0)
    tick(PAUSE_MS * 3)
    expect(last().stopped).toBe(1)
    last().end()
    expect(f.sends).toEqual(['one send only'])
    expect(pending()).toBe(0)
  })
})

describe('Stand-in r4 P1 #2: automatic send only ever sends finished words', () => {
  it('stand-in witness: interim result → speechend → pause → onend sends nothing', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'only half heard', isFinal: false }])
    rec.onspeechend?.({})
    tick(PAUSE_MS + 10)
    rec.end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('only half heard')
  })

  it('the person stopping with only interim words (send on pause on) sends nothing; the words stay', async () => {
    const { v, f } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'still being said', isFinal: false }])
    v.stop()
    rec.end()
    expect(f.sends).toEqual([])
    expect(f.text).toBe('still being said')
  })

  it('a finished phrase followed by interim words: the pause sends nothing while the tail is interim', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'first part', isFinal: true }, { transcript: 'and a tail', isFinal: false }])
    rec.onspeechend?.({})
    tick(PAUSE_MS + 10)
    rec.end()
    expect(f.sends).toEqual([])
  })

  it('(control) a finished phrase, speechend, pause: one send', async () => {
    const { v, f, tick } = voice(ctorWith({ local: 'available' }), field(), { pause: true })
    await v.start()
    const rec = last()
    rec.say([{ transcript: 'all of it', isFinal: true }])
    rec.onspeechend?.({})
    tick(PAUSE_MS + 10)
    rec.end()
    expect(f.sends).toEqual(['all of it'])
  })
})
