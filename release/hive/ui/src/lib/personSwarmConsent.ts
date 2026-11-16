import { ApiError } from '../api/client'
import { readPersonSwarmCard, shownPersonSwarm, singlePersonSwarm, type PersonSwarmCard, type PersonSwarmShown } from '../api/personSwarms'
import { accepts } from './decisionGate'

export interface PersonSwarmClient {
  program(id: string): Promise<{ person_swarm?: unknown }>
  appSwarmCard?(program: string, template: string): Promise<PersonSwarmCard>
  consentAppSwarm?(program: string, template: string, shown: PersonSwarmShown): Promise<PersonSwarmCard>
}

export type PersonSwarmState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'asking'; card: PersonSwarmCard; openedAt: number; releaseDigest: string; busy: boolean }
  | { kind: 'changed'; card: PersonSwarmCard; updated: PersonSwarmCard | null; fields: string[] }
  | { kind: 'unavailable'; message: string }
  | { kind: 'unknown' }
  | { kind: 'saved' }

type Listener = () => void
const shownFields = ['template_digest', 'key_id', 'month_usd', 'consent_revision', 'authority_revision'] as const

/** One mounted host generation. All callbacks re-check this lifetime after every await and before each send. */
export class PersonSwarmConsent {
  private value: PersonSwarmState = { kind: 'hidden' }
  private listeners = new Set<Listener>()
  private sequence = 0
  private disposed = false
  /** P14: the page opening a person app hears this card's own outcome (saved: open again; declined: helpers off). */
  onSettle: ((kind: 'saved' | 'declined') => void) | null = null

  constructor(
    private client: PersonSwarmClient,
    private program: string,
    private current: () => boolean,
    private clock: () => number = () => performance.now(),
    private log: (message: string) => void = (message) => console.info(message),
  ) {}

  getSnapshot = (): PersonSwarmState => this.value
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private alive = (sequence: number): boolean => !this.disposed && this.current() && sequence === this.sequence
  private write(sequence: number, value: PersonSwarmState): void {
    if (!this.alive(sequence)) return
    this.value = value
    this.listeners.forEach((listener) => listener())
  }

  /** `force` is a host-observed result of this person's act, never a frame message or a supplied card. */
  async check(force = false): Promise<void> {
    if (this.disposed || !this.current() || this.value.kind === 'asking' && this.value.busy) return
    const sequence = ++this.sequence
    this.write(sequence, { kind: 'loading' })
    try {
      if (!this.alive(sequence)) return
      const detail = await this.client.program(this.program)
      if (!this.alive(sequence)) return
      const template = singlePersonSwarm(detail.person_swarm)
      if (!template) {
        this.log(`P2 helpers not offered for ${this.program}: the pinned manifest must declare exactly one person-swarm template.`)
        this.write(sequence, { kind: 'hidden' })
        return
      }
      if (!this.client.appSwarmCard || !this.client.consentAppSwarm) {
        this.write(sequence, { kind: 'unavailable', message: "I can't set up helpers from here yet." })
        return
      }
      if (!this.alive(sequence)) return
      const raw = await this.client.appSwarmCard(this.program, template.templateId)
      if (!this.alive(sequence)) return
      const card = readPersonSwarmCard(raw, this.program, template.templateId)
      if (!card || card.template_digest !== template.templateDigest) throw new Error('Invalid P2 card')
      if (card.key_id === null || card.month_usd === null) {
        this.write(sequence, { kind: 'unavailable', message: 'Your own key and a monthly total are needed before helpers can be offered.' })
        return
      }
      this.write(sequence, card.consent_current && !force ? { kind: 'hidden' } : {
        kind: 'asking', card, openedAt: this.clock(), releaseDigest: template.releaseDigest, busy: false,
      })
    } catch {
      this.write(sequence, { kind: 'unavailable', message: "I can't set up helpers from here yet." })
    }
  }

  async accept(event: { repeat?: boolean; at: number }): Promise<void> {
    const shown = this.value
    // The host clock is authoritative; a caller-supplied event timestamp cannot bypass arming.
    if (shown.kind !== 'asking' || shown.busy || !accepts({ repeat: event.repeat, at: this.clock() }, shown.openedAt) || !this.current() || this.disposed) return
    const sequence = this.sequence
    const card = readPersonSwarmCard(shown.card, this.program, shown.card.template_id)
    if (!card || !this.client.consentAppSwarm) return
    this.write(sequence, { ...shown, busy: true })
    try {
      if (!this.alive(sequence)) return
      await this.client.consentAppSwarm(this.program, card.template_id, shownPersonSwarm(card))
      // POST only records consent. Neither this response nor `consent_current` claims that helpers were created.
      this.write(sequence, { kind: 'saved' })
      if (this.alive(sequence)) this.onSettle?.('saved')
    } catch (error) {
      if (!this.alive(sequence)) return
      if (error instanceof ApiError && error.status === 409 && error.code === 'card_changed') {
        const env = error.envelope
        const updated = readPersonSwarmCard(env?.card, this.program, card.template_id)
        const fields = updated ? shownFields.filter((field) => JSON.stringify(updated[field]) !== JSON.stringify(card[field])) : []
        this.write(sequence, { kind: 'changed', card, updated, fields: [...fields] })
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        this.write(sequence, { kind: 'unavailable', message: 'Your hive could not accept this setup. Nothing has been set up here.' })
      } else {
        // Lost/unreadable answers may have saved consent. Do not claim a refusal, resend, or manufacture a readback.
        this.write(sequence, { kind: 'unknown' })
      }
    }
  }

  lookAgain = (): Promise<void> => this.check(true)
  decline = (): void => {
    if (this.value.kind === 'asking' && this.value.busy) return
    const asked = this.value.kind === 'asking' || this.value.kind === 'changed'
    this.sequence++
    if (this.disposed || !this.current()) return
    this.value = { kind: 'hidden' }
    this.listeners.forEach((listener) => listener())
    if (asked) this.onSettle?.('declined')
  }
  dispose = (): void => { this.disposed = true; this.sequence++; this.listeners.clear() }
}

