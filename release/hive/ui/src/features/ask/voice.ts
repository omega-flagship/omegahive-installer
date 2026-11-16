/**
 * Voice for the universal Ask (UNIVERSAL_ASK_DESIGN Phase 3, Host §6; Jon's ruling relayed by Platform, 2026-10-06).
 *
 * The order of layers: the browser's own speech recognition ON THIS DEVICE first; in-page Whisper later (not in this
 * slice); the browser's speech SERVICE (audio sent to the browser's maker) only after the person opted in, once, on
 * this device. Everything is feature-detected, nothing is assumed:
 *  - on-device: Chrome-family `SpeechRecognition.available({ langs, processLocally: true })` answering 'available'
 *    (then `processLocally = true`), or the older draft's `availableOnDevice(lang)` (then `mode = 'ondevice-only'`).
 *    A language pack the browser could download is NOT installed from here (no model download): it counts as not on
 *    this device. On-device mode is never allowed to fall back to the service silently: a refusal marks it unavailable
 *    and the next press asks the person.
 *  - otherwise the browser's service (Chrome and Edge send audio to Google or Microsoft; Safari may send it to Apple):
 *    used only after the person's explicit opt-in, kept in this browser per person.
 *  - no SpeechRecognition at all (Firefox), or an insecure page: unsupported, said plainly.
 *
 * Words only: the page never opens a microphone stream of its own, records, keeps or sends audio; the transcript goes
 * into the field (editable) and travels exactly as typed words do (the field's own submit: fast path, ask or steer).
 * A send on a natural pause happens only when the person turned it on.
 *
 * This file is framework-free so it can be tested with a fake recognition; useAskVoice is the React wrapper.
 */

export type VoiceLayer = 'on-device' | 'service'
export type VoiceState = 'idle' | 'starting' | 'listening' | 'stopping'

/** The parts of SpeechRecognition the Ask uses (Chrome/Edge/Safari; webkit-prefixed on Safari and older Chrome). */
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  processLocally?: boolean
  mode?: string
  onstart: ((e: unknown) => void) | null
  onresult: ((e: RecognitionResultEvent) => void) | null
  onerror: ((e: { error: string; message?: string }) => void) | null
  onend: ((e: unknown) => void) | null
  onspeechend?: ((e: unknown) => void) | null
  start(): void
  stop(): void
  abort(): void
}
export interface RecognitionResultEvent {
  resultIndex?: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}
export interface RecognitionCtor {
  new (): RecognitionLike
  prototype?: object
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>
  availableOnDevice?: (lang: string) => Promise<string | boolean>
}

export type VoiceSupport = { ok: true; ctor: RecognitionCtor; vendor: string } | { ok: false; why: 'no-api' | 'insecure' }

interface VoiceWindow {
  SpeechRecognition?: RecognitionCtor
  webkitSpeechRecognition?: RecognitionCtor
  isSecureContext?: boolean
  navigator?: { userAgent?: string }
}

/** Who runs the browser's speech service, from the user agent (a hint for an honest sentence, never a decision). */
export function vendorOf(ua: string): string {
  // every iPhone and iPad browser is Safari's engine underneath, with Apple's speech service
  if (/iPhone|iPad|iPod/.test(ua)) return 'Apple'
  if (/Edg(e|A)?\//.test(ua)) return 'Microsoft'
  if (/OPR\/|Opera/.test(ua)) return 'your browser’s maker'
  if (/CriOS|Chrome\//.test(ua)) return 'Google'
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return 'Apple'
  return 'your browser’s maker'
}

export function voiceSupport(w: VoiceWindow = globalThis as unknown as VoiceWindow): VoiceSupport {
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!ctor) return { ok: false, why: 'no-api' }
  if (w.isSecureContext === false) return { ok: false, why: 'insecure' }
  return { ok: true, ctor, vendor: vendorOf(w.navigator?.userAgent ?? '') }
}

/** The one sentence the mic says when it cannot work here. */
export function unsupportedWords(why: 'no-api' | 'insecure'): string {
  return why === 'insecure'
    ? 'Voice needs a secure (https) connection to this hive; typing works.'
    : 'This browser has no speech recognition (Chrome, Edge and Safari do); typing works.'
}

/** Can this browser recognise `lang` on this device, without sending audio anywhere? Never installs anything. */
export async function probeOnDevice(ctor: RecognitionCtor, lang: string): Promise<'processLocally' | 'ondevice-only' | null> {
  try {
    if (typeof ctor.available === 'function' && ctor.prototype && 'processLocally' in ctor.prototype) {
      return (await ctor.available({ langs: [lang], processLocally: true })) === 'available' ? 'processLocally' : null
    }
    if (typeof ctor.availableOnDevice === 'function') {
      const r = await ctor.availableOnDevice(lang)
      return r === true || r === 'available' ? 'ondevice-only' : null
    }
  } catch {
    // a browser that throws on the question has not said yes
  }
  return null
}

/** Each recognition error in one plain sentence; null when there is nothing to say (the person stopped it). */
export function voiceErrorWords(code: string, layer: VoiceLayer | null, vendor: string): string | null {
  switch (code) {
    case 'aborted':
      return null
    case 'not-allowed':
      return 'The microphone is blocked for this page; allow it in your browser’s site settings, then try again.'
    case 'service-not-allowed':
      return layer === 'on-device'
        ? 'On-device speech is not ready for this language here; nothing was sent anywhere.'
        : 'This browser or device does not allow speech recognition here (on iPhone, Dictation must be on); typing works.'
    case 'audio-capture':
      return 'No microphone was found; check one is connected and not in use by another app.'
    case 'no-speech':
      return 'I did not hear anything; tap the microphone and speak again.'
    case 'network':
      return `${vendor === 'your browser’s maker' ? 'Your browser’s' : `${vendor}’s`} speech service could not be reached; check the connection, or type instead.`
    case 'language-not-supported':
      return layer === 'on-device' ? 'On-device speech is not ready for this language here; nothing was sent anywhere.' : 'Your browser cannot recognise this language; typing works.'
    case 'bad-grammar':
    default:
      return 'Voice stopped unexpectedly; your words so far are in the field and typing works.'
  }
}

/** A natural pause: no new words for this long after a finished phrase (only when the person turned send-on-pause on). */
export const PAUSE_MS = 1400
/** A press held at least this long is hold-to-talk (release stops); shorter is a tap (tap again to stop). */
export const HOLD_MS = 350

export type StartResult = 'started' | 'needs-consent' | 'unsupported' | 'busy' | 'blocked'

export interface VoiceHooks {
  support: VoiceSupport
  lang: string
  /** what the field shows now, and writing to it (voice words go through the field, never around it) */
  getText(): string
  setText(v: string): void
  /** send what is in the field, through the field's own submit (fast path, ask, or a steer while it works) */
  send(): void
  /** send on a natural pause: off unless the person turned it on */
  autoSend(): boolean
  /** has this person opted in to the browser's service on this device? */
  consented(): boolean
  onState(state: VoiceState, layer: VoiceLayer | null): void
  /** a sentence for screen readers (start, stop) */
  announce(msg: string): void
  /** a sentence to show (an error, with its recognition code), or null to clear */
  say(msg: string | null, code?: string): void
  /** the browser already reports the microphone denied for this page (Permissions API), read synchronously */
  micDenied?(): boolean
  /** a check that the sign-in this start began under is still current (rechecked after the async on-device probe) */
  generation?(): () => boolean
  timers?: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void }
}

/** One voice controller per Ask field. */
export class AskVoice {
  state: VoiceState = 'idle'
  layer: VoiceLayer | null = null
  /** on-device answer for this language: unknown until probed; a refusal at start marks it null */
  local: 'processLocally' | 'ondevice-only' | null | undefined = undefined
  private rec: RecognitionLike | null = null
  /** bumped on every new session or abort: events from an earlier one never write */
  private token = 0
  private prefix = ''
  private lastSet = ''
  private skip = 0
  private seen = 0
  private heard = false
  private sendOnEnd = false
  /** this session failed (an error arrived): it can never send, and nothing after the error writes (Review B2) */
  private failed = false
  /** the last result was a finished phrase (a pause may send it, if the person wants that now) */
  private lastFinal = false
  private pause: unknown = null
  private probing: Promise<void> | null = null
  /** on-device recognition refused at start for this language: a later re-ask never brings it back this page */
  private refused = false
  private readonly h: VoiceHooks
  private readonly timers: NonNullable<VoiceHooks['timers']>

  constructor(h: VoiceHooks) {
    this.h = h
    this.timers = h.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }
  }

  /** Ask the browser once whether this language works on this device (cached, so a later press starts in the gesture). */
  probe(): Promise<void> {
    if (!this.h.support.ok) return Promise.resolve()
    if (this.local !== undefined) return Promise.resolve()
    const ctor = this.h.support.ctor
    this.probing ??= probeOnDevice(ctor, this.h.lang).then((r) => {
      if (this.local === undefined) this.local = r
    })
    return this.probing
  }

  /**
   * Ask the browser again in the background (a language pack may have arrived since load): the answer is cached for the
   * NEXT press, which then still starts inside the gesture. Never after an on-device refusal.
   */
  reprobe(): void {
    if (!this.h.support.ok || this.refused || typeof this.h.support.ctor.available !== 'function') return
    void probeOnDevice(this.h.support.ctor, this.h.lang).then((r) => {
      if (!this.refused && this.state === 'idle') this.local = r
    })
  }

  /** The microphone permission was revoked while listening: stop now, keep the words, never send, say so. */
  micRevoked(): void {
    if (!this.active) return
    const layer = this.layer
    this.abort()
    this.h.say(voiceErrorWords('not-allowed', layer, this.vendor), 'not-allowed')
  }

  get active(): boolean {
    return this.state !== 'idle'
  }

  /**
   * Start listening. Synchronous whenever the on-device answer is known (iOS Safari only starts inside the tap itself),
   * so the browser sees the person's gesture. Resolves to what happened.
   */
  async start(): Promise<StartResult> {
    const s = this.h.support
    if (!s.ok) return 'unsupported'
    if (this.state !== 'idle') return 'busy'
    const same = this.h.generation?.() ?? (() => true)
    if (this.local === undefined) {
      this.state = 'starting'
      this.h.onState('starting', null)
      const t = ++this.token
      await this.probe()
      if (t !== this.token) return 'busy'
      this.state = 'idle'
      // a sign-in change while the browser answered: this press belonged to the earlier person
      if (!same()) {
        this.h.onState('idle', null)
        return 'busy'
      }
    }
    if (this.h.micDenied?.()) {
      this.h.onState('idle', null)
      this.h.say(voiceErrorWords('not-allowed', null, this.vendor), 'not-allowed')
      return 'blocked'
    }
    // consent is read now, for whoever is signed in now, just before anything is constructed
    if (!this.local && !this.h.consented()) {
      this.h.onState('idle', null)
      this.reprobe()
      return 'needs-consent'
    }
    return this.begin(s.ctor, this.local ? 'on-device' : 'service')
  }

  private begin(ctor: RecognitionCtor, layer: VoiceLayer): StartResult {
    const t = ++this.token
    let rec: RecognitionLike
    try {
      rec = new ctor()
    } catch {
      this.h.say(voiceErrorWords('other', layer, this.vendor))
      return 'unsupported'
    }
    rec.lang = this.h.lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    if (layer === 'on-device') {
      if (this.local === 'processLocally') rec.processLocally = true
      else rec.mode = 'ondevice-only'
    }
    const text = this.h.getText()
    this.prefix = text && !/\s$/.test(text) ? `${text} ` : text
    this.lastSet = text
    this.skip = 0
    this.seen = 0
    this.heard = false
    this.sendOnEnd = false
    this.failed = false
    this.lastFinal = false
    this.clearPause()
    rec.onresult = (e) => t === this.token && this.onResult(e)
    rec.onerror = (e) => t === this.token && this.onError(e.error, layer)
    rec.onend = () => t === this.token && this.onEnd()
    rec.onspeechend = () => {
      // only while listening: a speechend after the person (or the pause) already stopped arms nothing (Kimi r3 #5)
      // and only on finished words: interim words are never sent automatically (stand-in r4 P1 #2)
      if (t === this.token && this.state === 'listening' && !this.failed && this.heard && this.lastFinal && this.h.autoSend()) this.armPause()
    }
    this.rec = rec
    this.layer = layer
    this.state = 'listening'
    try {
      rec.start()
    } catch {
      // already started elsewhere, or the browser refused outside a gesture
      this.token++
      this.rec = null
      this.state = 'idle'
      this.layer = null
      this.h.onState('idle', null)
      this.h.say('The browser did not start listening; tap the microphone again.')
      return 'unsupported'
    }
    this.h.say(null)
    this.h.onState('listening', layer)
    this.h.announce(layer === 'on-device' ? 'Listening, on this device.' : `Listening, through ${this.vendor}’s speech service.`)
    return 'started'
  }

  private get vendor(): string {
    return this.h.support.ok ? this.h.support.vendor : 'your browser’s maker'
  }

  private onResult(e: RecognitionResultEvent) {
    // after an error the words heard so far stay in the field, editable; nothing later writes
    if (this.failed) return
    const results = e.results
    // the person edited the field while it listened: their words win, and later speech carries on after them
    const now = this.h.getText()
    if (now !== this.lastSet) {
      this.prefix = now && !/\s$/.test(now) ? `${now} ` : now
      this.skip = this.seen
    }
    this.seen = results.length
    const parts: string[] = []
    let lastFinal = false
    // the whole list each time (iOS repeats finished phrases when appended): never duplicated
    for (let i = this.skip; i < results.length; i++) {
      const w = results[i][0]?.transcript?.trim()
      if (w) parts.push(w)
      lastFinal = results[i].isFinal
    }
    const spoken = parts.join(' ')
    if (spoken) this.heard = true
    this.lastFinal = lastFinal && !!spoken
    const v = spoken ? `${this.prefix}${spoken}` : this.prefix
    this.lastSet = v
    this.h.setText(v)
    this.clearPause()
    if (lastFinal && spoken && this.h.autoSend()) this.armPause()
  }

  /**
   * The person changed send-on-pause (Review r2). Off: any pending automatic send is withdrawn now (the timer, and a
   * stop already on its way to the end); the words stay and listening carries on. On: a finished phrase the person has
   * not edited may be sent after a fresh pause.
   */
  autoSendChanged(on: boolean): void {
    if (!on) {
      this.clearPause()
      this.sendOnEnd = false
      return
    }
    if (this.state === 'listening' && !this.failed && this.heard && this.lastFinal && !this.edited()) this.armPause()
  }

  /** the field no longer holds exactly what voice last wrote: the person edited it */
  private edited(): boolean {
    return this.h.getText() !== this.lastSet
  }

  private armPause() {
    this.clearPause()
    if (this.state !== 'listening') return
    this.pause = this.timers.set(() => {
      this.pause = null
      // the person's choice NOW, not when the pause was armed (Review r2): off withdraws the automatic send
      if (this.state !== 'listening' || this.failed || !this.h.autoSend()) return
      // the person typed since the last words: their edit is theirs to send (Kimi 5); keep listening
      if (this.edited()) return
      this.sendOnEnd = true
      this.state = 'stopping'
      this.rec?.stop()
    }, PAUSE_MS)
  }

  private clearPause() {
    if (this.pause !== null) this.timers.clear(this.pause)
    this.pause = null
  }

  private onError(code: string, layer: VoiceLayer) {
    if (layer === 'on-device' && (code === 'language-not-supported' || code === 'service-not-allowed')) {
      this.local = null
      this.refused = true
    }
    // irreversible for this session: the pending pause is cancelled and no later event can arm a send again
    this.failed = true
    this.clearPause()
    this.sendOnEnd = false
    this.h.say(voiceErrorWords(code, layer, this.vendor), code)
  }

  private onEnd() {
    // every automatic send re-reads the person's current choice: turned off since, nothing is sent (Review r2)
    // every automatic path ends here: only finished words (the last result final) are ever sent (stand-in r4 P1 #2)
    const send = this.sendOnEnd && !this.failed && this.heard && this.lastFinal && !this.edited() && this.h.autoSend() && !!this.h.getText().trim()
    this.finish('Stopped listening.')
    if (send) this.h.send()
  }

  private finish(words: string) {
    this.clearPause()
    this.token++
    this.rec = null
    this.state = 'idle'
    this.layer = null
    this.h.onState('idle', null)
    this.h.announce(words)
  }

  /** The person stopped (tap again, release a hold, Esc, blur, page hidden): the words stay; sends only with send-on-pause. */
  stop(): void {
    if (this.state === 'starting') {
      this.token++
      this.state = 'idle'
      this.h.onState('idle', null)
      return
    }
    if (this.state !== 'listening') return
    this.sendOnEnd = !this.failed && this.heard && this.h.autoSend()
    this.state = 'stopping'
    this.clearPause()
    try {
      this.rec?.stop()
    } catch {
      this.finish('Stopped listening.')
    }
  }

  /**
   * Drop the session now: nothing that arrives later writes. `clear` empties the field too (a different person signed
   * in: the earlier person's words are not kept).
   */
  abort(opts: { clear?: boolean } = {}): void {
    const was = this.state !== 'idle'
    const rec = this.rec
    this.token++
    this.rec = null
    this.clearPause()
    this.sendOnEnd = false
    try {
      rec?.abort()
    } catch {
      // already ended
    }
    if (opts.clear) this.h.setText('')
    if (was) this.finish('Stopped listening.')
  }
}
