import { personAppReason, readPersonAppOpen, type PersonAppNeed, type PersonAppReason } from '../api/personApps'
import { onIdentityChange } from './identityEpoch'

export interface PersonAppClient {
  openPersonApp?(program: string): Promise<unknown>
  resetPersonApp?(program: string): Promise<unknown>
}

/**
 * The app's helpers (its one template), beside an app that is already open in the person's own context:
 * - `none`: the app has no template; `ready`: deployed.
 * - `key`: no own key or monthly total yet: the host key card, as a banner over the open app.
 * - `consent`: the host's P2 card (PersonSwarmConsentHost, from the host card() payload) with a display-only
 *   "your space" line; one tap consents, then this opens again and P2's ensure fills the same context.
 * - `declined`: the person said not now; nothing was made. Remembered for this tab and identity, so a reload does not
 *   ask again; the banner's "Set up helpers" asks again.
 */
export type PersonAppHelpersState = 'none' | 'ready' | 'key' | 'consent' | 'declined'

/**
 * P14: what a person app's page shows while its host opens it.
 * - `opening`: asking the host (free: it never spends or wakes).
 * - `ready`: the frame opens straight into `swarmId`, always; `needs` and `helpers` show as banners, never instead.
 * - `failed`: one approved reason, with its one action.
 */
export type PersonAppState =
  | { kind: 'opening' }
  | { kind: 'ready'; swarmId: string; needs: PersonAppNeed[]; helpers: PersonAppHelpersState; spaceLine: string | null }
  | { kind: 'failed'; reason: PersonAppReason }

/** Busy answers are retried a bounded number of times, with growing waits; then the busy card stays. */
export const BUSY_RETRIES = [1000, 2000, 4000] as const

// "Not now" for this tab and identity (never durable and never the host's: declining writes nothing anywhere)
const DECLINED_KEY = 'omegahive.p14.declined'
const declinedNow = new Set<string>()
onIdentityChange(() => {
  declinedNow.clear()
  try { sessionStorage.removeItem(DECLINED_KEY) } catch { /* optional */ }
})
function declined(program: string): boolean {
  if (declinedNow.has(program)) return true
  try { return (JSON.parse(sessionStorage.getItem(DECLINED_KEY) ?? '[]') as unknown[]).includes(program) } catch { return false }
}
function remember(program: string, on: boolean): void {
  if (on) declinedNow.add(program); else declinedNow.delete(program)
  try {
    const list = (JSON.parse(sessionStorage.getItem(DECLINED_KEY) ?? '[]') as unknown[]).filter((p) => p !== program)
    sessionStorage.setItem(DECLINED_KEY, JSON.stringify(on ? [...list, program] : list))
  } catch { /* optional: the in-memory note still holds for this page */ }
}

type Listener = () => void

export class PersonAppOpener {
  private value: PersonAppState = { kind: 'opening' }
  private listeners = new Set<Listener>()
  private sequence = 0
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private client: PersonAppClient,
    private program: string,
    private current: () => boolean,
    private wait: (ms: number, run: () => void) => ReturnType<typeof setTimeout> = (ms, run) => setTimeout(run, ms),
  ) {}

  getSnapshot = (): PersonAppState => this.value
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private alive = (sequence: number): boolean => !this.disposed && this.current() && sequence === this.sequence
  private write(sequence: number, value: PersonAppState): void {
    if (!this.alive(sequence)) return
    this.value = value
    this.listeners.forEach((listener) => listener())
  }

  /** Open (or open again). `reset` is the host's "Set up again", the one way out of an unusable space. */
  async open(reset = false, attempt = 0): Promise<void> {
    if (this.disposed || !this.current()) return
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    const sequence = ++this.sequence
    if (this.value.kind !== 'ready') this.write(sequence, { kind: 'opening' })   // an open app stays on screen
    const call = reset ? this.client.resetPersonApp : this.client.openPersonApp
    if (!call) { this.write(sequence, { kind: 'failed', reason: 'space_failed' }); return }
    let raw: unknown
    try {
      raw = await call.call(this.client, this.program)
    } catch (error) {
      if (!this.alive(sequence)) return
      const reason = personAppReason(error)
      this.write(sequence, { kind: 'failed', reason })
      if (reason === 'busy' && attempt < BUSY_RETRIES.length)
        this.timer = this.wait(BUSY_RETRIES[attempt], () => { this.timer = null; if (this.alive(sequence)) void this.open(reset, attempt + 1) })
      return
    }
    const answer = readPersonAppOpen(raw, this.program)
    if (!answer) { this.write(sequence, { kind: 'failed', reason: 'space_failed' }); return }
    const helpers: PersonAppHelpersState = answer.helpers === 'consent_required' ? (declined(this.program) ? 'declined' : 'consent')
      : answer.helpers === 'key_required' ? 'key' : answer.helpers
    if (helpers === 'ready') remember(this.program, false)
    this.write(sequence, { kind: 'ready', swarmId: answer.swarm_id, needs: answer.needs, helpers, spaceLine: answer.space_line ?? null })
  }

  /** The host card's own outcome (never a frame message): saved opens again, so P2's ensure deploys. */
  settled = (kind: 'saved' | 'declined'): void => {
    const now = this.value
    if (now.kind !== 'ready' || now.helpers !== 'consent') return
    if (kind === 'saved') { remember(this.program, false); void this.open(); return }
    remember(this.program, true)
    const sequence = ++this.sequence
    this.write(sequence, { ...now, helpers: 'declined' })
  }

  /** "Set up helpers" from the declined banner: the host card again. */
  askHelpers = (): void => {
    remember(this.program, false)
    void this.open()
  }

  /** The page went away for now (an effect cleanup): nothing in flight lands and no retry runs; open() resumes. */
  stop = (): void => {
    this.sequence++
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  dispose = (): void => {
    this.disposed = true
    this.sequence++
    if (this.timer !== null) clearTimeout(this.timer)
    this.listeners.clear()
  }
}
