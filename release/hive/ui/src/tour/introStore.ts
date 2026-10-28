import { create } from 'zustand'
import { startShowreel } from '../features/showreel/hook'
import { KEYS, readKey, writeKey } from './storage'

/** Small and eager: whether the welcome, help sheet or tour is showing. The tour itself is a lazy chunk. */
export interface TourRequest {
  /** Start at this chapter id (default: the first). */
  chapter?: string
  /** Play just that one chapter ("Show me"). */
  only?: boolean
  /** Where to put the app back when the tour ends (default: where it was). */
  returnTo?: string
  /** Bumps on every start, so a replay remounts the player. */
  key: number
}

interface IntroState {
  welcome: boolean
  help: boolean
  tour: TourRequest | null
  /** The demo opens on the Lab, but only after the welcome has been answered. */
  afterWelcome: string | null
  showWelcome(): void
  /** 'showreel' (demo mode only; the showreel refuses on any other client): explore, with the showreel playing */
  answerWelcome(choice: 'tour' | 'explore' | 'showreel'): void
  startTour(opts?: Omit<TourRequest, 'key'>): void
  endTour(): void
  setHelp(open: boolean): void
}

let seq = 0

/** True when this browser has not answered the welcome (or cannot remember that it did). */
export function welcomeNeeded(): boolean {
  return !readKey(KEYS.welcome)
}

/**
 * Speech needs a user gesture before it may start. Call this inside the click that starts the tour:
 * a silent, empty utterance unlocks speechSynthesis for the lazy chunk that speaks a moment later.
 */
export function primeSpeech(): void {
  try {
    const s = window.speechSynthesis
    if (!s || typeof SpeechSynthesisUtterance === 'undefined') return
    const u = new SpeechSynthesisUtterance(' ')
    u.volume = 0
    s.cancel()
    s.speak(u)
  } catch {
    /* no speech here: the tour runs with captions */
  }
}

export const useIntro = create<IntroState>()((set, get) => ({
  welcome: false,
  help: false,
  tour: null,
  afterWelcome: null,
  showWelcome: () => set({ welcome: true }),
  answerWelcome(choice) {
    writeKey(KEYS.welcome, choice)
    const after = get().afterWelcome
    set({ welcome: false, afterWelcome: null })
    if (choice === 'tour') get().startTour({ returnTo: after ?? undefined })
    else if (after && window.location.hash !== after) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${after}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
    if (choice === 'showreel') void startShowreel()
  },
  startTour(opts = {}) {
    primeSpeech()
    set({ tour: { ...opts, key: ++seq }, help: false, welcome: false })
  },
  endTour: () => set({ tour: null }),
  setHelp: (help) => set({ help }),
}))
