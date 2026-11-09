/**
 * SIM ONLY: First Light's demo newcomers (R0.1 fixtures, SURFACE_FIRST_LIGHT_R0_DEMO_NEWCOMER). Everything here is
 * INVENTED: Pip Lanternfield starts a hive of their own on an invented, masked key; Juno Ashdown is a guest in Hazel
 * Quillfeather's hive through a "use my hive" invite. No real person, project, key or session; no network.
 *
 * The demo host answers exactly as the live routes would, in memory, deterministically (the same story every play),
 * and nothing it does reaches a hive. The page labels it "simulated" throughout.
 */
import type { RolePath } from './host'
import { BLANK_PROGRESS, FlRefusal, type AppRef, type AskShape, type BoundWrite, type FlHost, type Hello, type HiveOwn, type LimitRequest, type MindRef, type MonthlyLimit, type Progress, type ProgressWrite, type Setup } from './host'

export type Persona = 'pip' | 'juno'

export interface DemoPerson {
  persona: Persona
  name: string
  path: 'owner' | 'guest'
  role: RolePath
  /** the look they keep in beat 2 */
  look: string
  /** owner: the key they paste, as it is shown (masked) */
  key?: { provider: string; shown: string }
  /** owner: the monthly limit they choose */
  monthly?: number
  /** guest: their host, and the limit on the invite */
  host?: string
  inviteLimit?: number
  /** the mind's own first words (R0.1 8.3 demo lines); the demo's stand-in for a model's answer */
  greeting: string
  /** guest: what the hello cost, from the host's limit */
  helloCost?: number
  /** R3 beat 6: the Ask they describe (invented) */
  ask: AskShape
}

export const DEMO_PEOPLE: Record<Persona, DemoPerson> = {
  pip: {
    persona: 'pip',
    name: 'Pip Lanternfield',
    path: 'owner',
    role: 'coder',
    look: 'cosmos',
    key: { provider: 'Anthropic', shown: 'sk-DEMO-••••••••••••••••7Q2F' },
    monthly: 20,
    ask: { name: 'Tide', how: 'Brief and practical. Show me the code first, then explain.' },
    greeting: 'Hi Pip, I’m awake. Shall we start with the tide timer you brought in? There’s a half-finished fix for the moon phase rounding.',
  },
  juno: {
    persona: 'juno',
    name: 'Juno Ashdown',
    path: 'guest',
    role: 'explorer',
    look: 'still',
    host: 'Hazel',
    inviteLimit: 5,
    greeting: 'Hi Juno, I’m awake. I’m running in Hazel’s hive, on Hazel’s key, and we have $5.00 to spend this month. Want me to show you what Hazel’s minds are working on?',
    helloCost: 0.02,
    ask: { name: 'Juniper', how: 'Friendly and patient. Plain words, one step at a time.' },
  },
}

/** R3 beat 5: the demo hive's one app ready for everyone (invented: nothing opens in the simulator). */
export const DEMO_APPS: readonly AppRef[] = [{ id: 'talk', name: 'Your assistant', tagline: 'An invented app, for the demo' }]

/** The demo's own label, shown on every First Light screen in demo mode. */
export const SIMULATED = 'Simulated: an invented newcomer on an invented hive. Nothing here is real, and nothing is sent or spent.'

/** How long the simulated mind takes to answer after Wake (the demo replays it the same every time). */
export const DEMO_GREET_MS = 2400

/** The demo hive, in memory. Also: `addKey` and `keepLook`, the person's own acts the demo plays for them. */
export class DemoHost implements FlHost {
  readonly kind = 'demo' as const
  readonly who: DemoPerson
  private now: () => number
  private p: Progress = { ...BLANK_PROGRESS }
  private keys = 0
  private ownLimit: number | null = null
  private spent = 0
  private woke: number | null = null
  private request: LimitRequest | null = null
  private how = ''
  /** the demo person's own mind (beat 6 renames it) */
  mindRef: MindRef

  constructor(persona: Persona, now: () => number = () => Date.now(), mindId = 'demo_first_light_mind') {
    this.who = DEMO_PEOPLE[persona]
    this.now = now
    this.mindRef = { id: mindId, name: this.who.name.split(' ')[0], status: 'asleep' }
  }

  /** the shown key, once "pasted" (owner) */
  get keyShown(): string | null {
    return this.keys > 0 && this.who.key ? this.who.key.shown : null
  }
  /** the demo person adds their (invented, masked) key on their keys page */
  addKey(): void {
    if (this.who.path === 'owner') this.keys = 1
  }

  async progress(): Promise<Progress> {
    return { ...this.p }
  }
  async writeProgress(patch: ProgressWrite, version: number): Promise<Progress> {
    if (version !== this.p.version) throw new FlRefusal(409, 'stale_onboarding', 'Your setup changed in another window.', { current: { ...this.p } })
    const status = patch.status ?? (this.p.status === 'not_started' ? 'in_progress' : this.p.status)
    this.p = { ...this.p, ...patch, status, version: this.p.version + 1 }
    return { ...this.p }
  }
  private limit(): MonthlyLimit {
    if (this.who.path === 'guest') {
      const l = this.who.inviteLimit ?? 0
      return { done: true, enforced: true, enforced_by: 'invite', limit_usd: l, spent_usd: this.spent, chosen_usd: null, host_name: this.who.host ?? null, pending_request: this.request && this.request.status === 'pending' ? { id: this.request.id, amount_usd: this.request.amount_usd, created_at: null } : null }
    }
    const set = this.keys > 0 && this.ownLimit !== null
    return { done: set, enforced: set, enforced_by: set ? 'own' : null, limit_usd: set ? this.ownLimit : null, spent_usd: set ? this.spent : null, chosen_usd: this.p.monthly_spend_usd, host_name: null, pending_request: null }
  }
  async setup(): Promise<Setup> {
    return { own_keys: this.keys, guest: this.who.path === 'guest', limit: this.limit(), mind_awake: this.woke !== null, complete: false }
  }
  async own(): Promise<HiveOwn> {
    return this.who.path === 'guest'
      ? { owner_name: this.who.host ?? null, you_are_owner: false, your_access: 'guest', visibility: 'private', pays: 'own-key' }
      : { owner_name: this.who.name, you_are_owner: true, your_access: 'owner', visibility: 'private', pays: 'own-key' }
  }
  async personName(): Promise<string | null> {
    return this.who.name
  }
  async mind(): Promise<MindRef | null> {
    return { ...this.mindRef, status: this.woke !== null ? 'awake' : 'asleep' }
  }
  /** Pip's hive is new (only their own mind); Juno is in Hazel's, which holds others */
  otherMinds(): number | null {
    return this.who.path === 'guest' ? 6 : 0
  }
  async setOwnLimit(month: number): Promise<void> {
    if (this.keys <= 0) throw new FlRefusal(403, 'key_owner_only', 'Only the person who owns that key sets its limits.')
    this.ownLimit = month
  }
  async askForMore(amount: number): Promise<LimitRequest> {
    if (this.request?.status === 'pending') throw new FlRefusal(409, 'already_asked', 'Already asked.')
    this.request = { id: 'lr_demo_1', amount_usd: amount, status: 'pending' }
    return { ...this.request }
  }
  private hello(created: boolean): Hello | null {
    if (this.woke === null) return null
    const greeted = this.now() - this.woke >= DEMO_GREET_MS
    if (greeted && this.who.helloCost && this.spent === 0) this.spent = this.who.helloCost
    return {
      mind: { ...this.mindRef, status: 'awake' },
      state: greeted ? 'greeted' : 'waiting',
      greeting: greeted ? { id: 'm_demo_hello', text: this.who.greeting, created_at: null } : null,
      created,
      retryable: false,
      requested_at: new Date(this.woke).toISOString(),
    }
  }
  async apps(): Promise<AppRef[]> {
    return DEMO_APPS.map((a) => ({ ...a }))
  }
  async askHow(): Promise<string> {
    return this.how
  }
  async saveAsk(_mindId: string, shape: AskShape, write: BoundWrite): Promise<MindRef> {
    await write(async () => { this.mindRef = { ...this.mindRef, name: shape.name } })
    if (shape.how !== null) await write(async () => { this.how = shape.how! })
    await write(async () => undefined) // invented preferences acknowledgement, never a host write
    return { ...this.mindRef, status: this.woke !== null ? 'awake' : 'asleep' }
  }
  async helloGet(): Promise<Hello | null> {
    return this.hello(false)
  }
  async helloWake(): Promise<Hello> {
    if (this.who.path === 'owner' && this.keys <= 0) throw new FlRefusal(402, 'no_key', 'Your mind has no key for its model.')
    const first = this.woke === null
    if (first) this.woke = this.now()
    return this.hello(first)!
  }
}
