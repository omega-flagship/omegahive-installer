/**
 * Storage for the intro, hints and tour settings. Every access is wrapped: the artifact frame, private
 * windows and blocked site data can make localStorage throw or come back empty. When it does, the
 * person simply sees the welcome (or a hint) again next time.
 */
export const KEYS = {
  welcome: 'omegadots.intro.welcome.v1',
  hint: (view: string) => `omegadots.intro.hint.${view}`,
  voice: 'omegadots.tour.voice',
  rate: 'omegadots.tour.rate',
  captions: 'omegadots.tour.captions',
  muted: 'omegadots.tour.muted',
} as const

export function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: remembered for this page only */
  }
}
