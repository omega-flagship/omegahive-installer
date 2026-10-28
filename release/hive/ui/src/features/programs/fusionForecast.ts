import type { HiveClient, Me } from '../../api/client'
import type { ActionResult, ProgramActBody } from '../../api/types'
import { IDENTITY_CHANGED, prepareConfirm, runConfirmed } from '../../lib/hostConfirm'

export type ForecastDraft = { market: string; probability_yes: string; text: string; replaces?: string }
export type ForecastIntent = { version: 1; principal: string; swarm: string; key: string }
export type ForecastState = { phase: 'draft' | 'review' | 'sending' | 'unknown' | 'committed' | 'refused'; intent?: ForecastIntent; receipt?: string; message?: string }
type Transport = Pick<HiveClient, 'programAct' | 'me'> & Partial<Pick<HiveClient, 'confirmAct'>>
export type Journal = { read(): ForecastIntent | null; write(value: ForecastIntent): void; clear(): void }
const person = (me: Me) => {
  if (me.kind !== 'sso' || !['admin','member'].includes(me.role ?? '') || !me.person?.id || me.principal !== `user:${me.person.id}` || me.principal === 'user:operator') throw new Error('Sign in as a named person.')
  return me.principal
}
export function forecastDraft(input: ForecastDraft): ForecastDraft {
  const body = structuredClone(input)
  if (Object.keys(body).some(k => !['market','probability_yes','text','replaces'].includes(k)) || !body.market.trim() || !body.text.trim() || body.text.length > 10000 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(body.probability_yes) || (body.replaces !== undefined && !body.replaces.trim())) throw new Error('Choose a market, a probability from 0 to 1 and a forecast explanation.')
  return body
}
/** Review B1: the connection or swarm this composer was opened under changed before anything was sent. */
export class NotSentError extends Error {
  constructor() { super(IDENTITY_CHANGED) }
}
const validIntent = (v: ForecastIntent, principal: string, swarm: string) => v?.version === 1 && v.principal === principal && v.swarm === swarm && typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 120

/** Only captures/reviews explicit human intent. Never borrows a mind or auto retries.
 * Journal stores recovery metadata only, never forecast text, tokens or a grant. */
export class ForecastComposer {
  state: ForecastState = { phase: 'draft' }
  private busy = false
  /**
   * `needs`: whether an action takes the host confirm (§9d, from describe); unknown → true, to be safe.
   * `alive` (review B1): whether the identity this composer was opened under (client, store session and init, swarm,
   * the mounted composer) still holds. Checked before the journal is written and, inside runConfirmed, before the
   * mint, after every await and before every act; once false nothing more is minted or sent.
   */
  constructor(private client: Transport, private principal: string, private swarm: string, private journal: Journal, private key: () => string = () => crypto.randomUUID(), private needs: (action: string) => boolean = () => true, private alive: () => boolean = () => true) {
    const saved = journal.read()
    if (saved) {
      if (!validIntent(saved,principal,swarm)) throw new Error('Recovery metadata does not match this person and swarm.')
      this.state = { phase: 'unknown', intent: structuredClone(saved), message: 'Recover the previous forecast before sending another.' }
    }
  }
  private pending() {
    const saved = this.journal.read()
    if (saved) {
      if (!validIntent(saved,this.principal,this.swarm)) throw new Error('Recovery metadata changed unexpectedly.')
      this.state = { phase:'unknown',intent:structuredClone(saved),message:'Another pending forecast must be recovered first.' }
      throw new Error('Recover the pending forecast first.')
    }
  }
  private async identity() {
    if (!this.client.me || person(await this.client.me()) !== this.principal) throw new Error('The signed-in person changed. Reopen Fusion.')
  }
  async submit(input: ForecastDraft, confirm: (message: string) => Promise<boolean>): Promise<void> {
    if (this.busy || ['review','sending','unknown'].includes(this.state.phase)) throw new Error('Recover the current intent first.')
    this.busy = true
    try {
      this.pending()
      const body = forecastDraft(input)
      await this.identity()
      this.state = { phase: 'review' }
      const message = `Publish your synthetic forecast as ${this.principal} in ${this.swarm}? Market: ${body.market}. YES probability: ${body.probability_yes}. Explanation: ${body.text}${body.replaces ? ` Correct your forecast ${body.replaces}; its original is retained.` : ''} This records a forecast; it does not trade or complete a reviewed task.`
      if (!await confirm(message)) { this.state = { phase: 'draft' }; return }
      await this.identity()
      this.pending()
      if (!this.alive()) throw new NotSentError()
      const intent: ForecastIntent = { version: 1, principal: this.principal, swarm: this.swarm, key: this.key() }
      if (!validIntent(intent,this.principal,this.swarm)) throw new Error('Invalid intent key.')
      this.journal.write(structuredClone(intent)) // Durable recovery before the first effect.
      this.state = { phase: 'sending', intent }
      const request: ProgramActBody = { swarm_id: this.swarm, action: 'human-forecast', items: [], params: body, idempotency_key: intent.key }
      try { this.result(await this.send(request),false) }
      catch (e) {
        // review B1: refused before the mint (identity changed): nothing was sent, so nothing needs recovering
        if (e instanceof NotSentError) { this.journal.clear(); this.state = { phase: 'draft' }; throw e }
        this.state = { phase: 'unknown', intent, message: 'Delivery is uncertain. Recover by receipt key; do not send again.' }
      }
    } catch (e) {
      if (!this.state.intent) this.state = { phase: 'draft' }
      throw e
    } finally { this.busy = false }
  }
  /**
   * §9d: an act on a confirm action carries the host's token, minted here only because the person just confirmed (the
   * caller's confirm). Sent once: a lost answer throws (the intent becomes `unknown`; recovery asks the person again).
   * A confirm the hive refuses, or a value it cannot check, is a refusal: nothing was sent.
   */
  private async send(request: ProgramActBody): Promise<ActionResult> {
    if (!this.needs(request.action)) return this.client.programAct('omegafusion', request)
    const p = prepareConfirm('omegafusion', request, null, { key: request.idempotency_key })
    if (!p.ok) return { status: 'refused', message: p.message }
    const o = await runConfirmed(this.client, p.intent, this.alive)
    if (o.kind === 'done') return o.result
    if (o.kind === 'again' || o.kind === 'unsupported' || o.kind === 'too-large') return { status: 'refused', message: o.message }
    if (o.kind === 'stale' && !o.sent) throw new NotSentError()
    // unknown outcome (and not returned as done by the hive's recovery), or sent under an identity that has since
    // changed: never re-sent from here; the person recovers it by receipt key
    if (o.kind === 'uncertain' || o.kind === 'stale') throw new Error('Delivery is uncertain.')
    throw o.error
  }
  async reconcile(confirm?: (message: string) => Promise<boolean>): Promise<void> {
    if (this.busy || this.state.phase !== 'unknown' || !this.state.intent) throw new Error('No uncertain forecast to recover.')
    if (this.needs('human-reconcile')) {
      if (!confirm) throw new Error('Checking the receipt needs your confirmation.')
      if (!await confirm(`Check whether your synthetic forecast ${this.state.intent.key} was recorded, as ${this.principal} in ${this.swarm}? This reads its receipt; it does not send the forecast again.`)) return
    }
    this.busy = true
    try {
      await this.identity()
      const saved = this.journal.read()
      if (saved && (!validIntent(saved,this.principal,this.swarm) || saved.key !== this.state.intent.key)) throw new Error('Recovery metadata changed; reopen Fusion before checking it.')
      const intent = this.state.intent
      this.result(await this.send({swarm_id: this.swarm,action:'human-reconcile',items:[],params:{receipt_key:intent.key},idempotency_key:this.key()}),true)
    } finally { this.busy = false }
  }
  private result(result: ActionResult, recovery: boolean) {
    const intent = this.state.intent!
    if (result.status === 'refused') {
      if (recovery) { this.state = { phase:'unknown',intent,message:'Recovery was refused. Current access must be restored before checking this receipt.' }; return }
      this.journal.clear(); this.state = { phase:'refused',message:typeof result.detail === 'string' ? result.detail : result.message ?? 'The app refused this forecast.' }; return
    }
    if (result.status === 'done' && result.receipt?.state === 'committed' && result.receipt.id && result.detail?.idempotency_key === intent.key && typeof result.detail.result === 'object' && result.detail.result !== null && 'forecast_id' in result.detail.result && typeof result.detail.result.forecast_id === 'string' && !!result.detail.result.forecast_id && result.detail.mode === 'synthetic') {
      this.journal.clear(); this.state = { phase:'committed',receipt:result.receipt.id,message:'Forecast recorded. Task review and factual truth remain separate.' }; return
    }
    this.state = { phase:'unknown',intent,message:'No committed forecast is confirmed. Recover by receipt key; no resend.' }
  }
}
