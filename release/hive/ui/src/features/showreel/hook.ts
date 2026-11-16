/**
 * The Ask's door to the demo showreel, kept tiny so a real hive never loads the showreel itself: ShowreelLayer (loaded
 * only for the simulator in demo mode, App.tsx) installs the handler while it is mounted. Without it, nothing is
 * taken and the words go on to the Ask as always.
 */
type Handler = (text: string, opts: { where?: string }) => boolean
let handler: Handler | null = null

export function setShowreelWords(h: Handler | null): void {
  handler = h
}

/** True when the showreel took the words (useAskField submit asks this first). */
export function showreelWords(text: string, opts: { where?: string } = {}): boolean {
  return handler ? handler(text, opts) : false
}

/** The simulator in demo mode (api/sim/demo.ts): the only client the showreel ever loads or plays on. */
export function isDemoClient(c: unknown): boolean {
  const x = c as { mode?: string; demo?: unknown } | null
  return !!x && x.mode === 'sim' && x.demo === true
}

/** Start the showreel, loading it on first use (its store refuses on any client but the demo simulator). The demo
 *  card's "Watch it run" and the welcome dialog's share this one path. */
export function startShowreel(): Promise<boolean> {
  return import('./store').then((m) => m.useReel.getState().start())
}
