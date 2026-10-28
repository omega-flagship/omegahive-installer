/**
 * The door to First Light, kept tiny so a hive that never opens it never loads the journey (App.tsx mounts the lazy
 * FirstLightLayer only once it is asked for). Three ways in:
 *  - the host's own routes: #/first-light, #/first-light?beat=models (the setup list links there);
 *  - the Ask: "show me first light", "start first light", "set me up", "show me onboarding", "run first light again";
 *  - the simulator only: ?sim=1&firstlight=pip (the owner demo) or =juno (the guest demo), with &flbeat=, &flstep= and
 *    &fllook= to open one beat in one look (the render smoke).
 * On a real hive every way in plays the person's own setup; the invented newcomers play only on the simulator.
 */
import { create } from 'zustand'
import { norm } from '../guided/match'
import { FL_SCRIPT } from './script'
import type { StartOpts } from './store'

interface Door {
  asked: (StartOpts & { key: number }) | null
  open(o: StartOpts): void
  close(): void
}
let key = 0
export const useFlDoor = create<Door>()((set) => ({
  asked: null,
  open: (o) => set({ asked: { ...o, key: ++key } }),
  close: () => set({ asked: null }),
}))

export const startFirstLight = (o: StartOpts): void => useFlDoor.getState().open(o)

const TRIGGERS = new Set(FL_SCRIPT.triggers.map(norm))
const GUEST = /\b(as a guest|guest path|use my hive|juno)\b/

/** The Ask's words that start First Light (true: taken; the words go no further). */
export function firstLightWords(text: string): boolean {
  const n = norm(text)
  const base = n.replace(GUEST, '').replace(/\s+/g, ' ').trim()
  if (!TRIGGERS.has(n) && !TRIGGERS.has(base)) return false
  startFirstLight({ mode: 'live', persona: GUEST.test(n) ? 'juno' : 'pip' })
  return true
}

/** The simulator's demo request in the address (?sim=1&firstlight=pip|juno…); null on any other address. */
export function demoFromSearch(search: string): StartOpts | null {
  const q = new URLSearchParams(search)
  if (q.get('sim') !== '1') return null
  const who = q.get('firstlight')
  if (who !== 'pip' && who !== 'juno') return null
  const clean = (v: string | null, re: RegExp) => (v && re.test(v) ? v : undefined)
  return {
    mode: 'demo',
    persona: who,
    beat: clean(q.get('flbeat'), /^(arrive|look|models|apps|ask|hello)$/),
    step: clean(q.get('flstep'), /^\d\.\d[a-z]{0,2}$/),
    look: clean(q.get('fllook'), /^[a-z]{2,20}$/),
    ...(q.get('flpaused') === '1' ? { paused: true } : {}),
  }
}
