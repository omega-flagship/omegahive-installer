import type { SpeakHandlers, SpeechPort } from './machine'

/**
 * The browser's speechSynthesis, behind the runner's small port. Returns null when there is no speech
 * at all (some browsers, sandboxed frames); the tour then runs on timings with captions.
 */

export function speechSupported(): boolean {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
  } catch {
    return false
  }
}

/** Voices arrive asynchronously in Chrome. Resolve with what is there after `ms` (often none in headless browsers). */
export function loadVoices(ms = 1200): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([])
  const s = window.speechSynthesis
  const now = safeVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        s.removeEventListener('voiceschanged', finish)
      } catch {
        /* old engines */
      }
      resolve(safeVoices())
    }
    try {
      s.addEventListener('voiceschanged', finish)
    } catch {
      /* old engines */
    }
    setTimeout(finish, ms)
  })
}

function safeVoices(): SpeechSynthesisVoice[] {
  try {
    return window.speechSynthesis.getVoices() ?? []
  } catch {
    return []
  }
}

/** English voices, best first: natural/neural voices, then well-known good defaults, then the platform default. */
export function englishVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices.filter((v) => /^en([-_]|$)/i.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a))
}

export function voiceScore(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService' | 'default'>): number {
  const n = v.name.toLowerCase()
  let s = 0
  if (/natural|neural|premium|enhanced/.test(n)) s += 40
  if (/google (uk|us) english/.test(n)) s += 30
  if (/samantha|ava|allison|serena|daniel|karen|moira|aria|jenny|guy|libby|sonia|ryan/.test(n)) s += 24
  if (/^en[-_](us|gb)/i.test(v.lang)) s += 8
  if (v.default) s += 4
  if (v.localService) s += 2
  if (/novelty|whisper|bells|bad news|boing|bubbles|cellos|zarvox|trinoids|albert|jester|organ|superstar|wobble|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/.test(n)) s -= 60
  return s
}

export function pickVoice(voices: SpeechSynthesisVoice[], preferred?: string | null): SpeechSynthesisVoice | null {
  if (preferred) {
    const v = voices.find((x) => x.voiceURI === preferred)
    if (v) return v
  }
  return englishVoices(voices)[0] ?? null
}

export function browserSpeech(getVoice: () => SpeechSynthesisVoice | null): SpeechPort | null {
  if (!speechSupported()) return null
  const s = window.speechSynthesis
  return {
    speak(text: string, rate: number, h: SpeakHandlers) {
      try {
        const u = new SpeechSynthesisUtterance(text)
        const v = getVoice()
        if (v) {
          u.voice = v
          u.lang = v.lang
        } else u.lang = 'en-US'
        u.rate = Math.max(0.5, Math.min(2, rate))
        u.pitch = 1
        u.onstart = () => h.onStart()
        u.onend = () => h.onEnd()
        u.onerror = (e) => h.onError((e as SpeechSynthesisErrorEvent).error ?? 'error')
        u.onboundary = (e) => h.onBoundary?.(e.charIndex)
        // Chrome can hold a stale paused queue; make sure it is speaking
        s.cancel()
        s.resume()
        s.speak(u)
      } catch {
        h.onError('synthesis-failed')
      }
    },
    cancel() {
      try {
        s.cancel()
      } catch {
        /* nothing to cancel */
      }
    },
  }
}
