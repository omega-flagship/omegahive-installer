import type { AskAccepted, AskBody, BrowserOutcome } from '../../api/ask'
import type { BrowserMindGateway } from './gateway'

export type { BrowserOutcome } from '../../api/ask'
export interface IterBroker {
  readonly turn: { id: string; closed: boolean; parked?: unknown } | null
  resume(): Promise<unknown[]>
  startTurn(id: string, owner: 'iter', words: string): unknown
  endTurn(id: string): Promise<boolean>
  llm(id: string, body: object): Promise<unknown>
}

/** Owns admission ordering and the host close handshake. Worker readiness is supplied by its actual boot owner. */
export function createBrowserTurnLifecycle(opts: {
  broker: IterBroker
  gateway: BrowserMindGateway
  current(): boolean
  workerReady(): boolean
  admit(body: AskBody): Promise<AskAccepted>
  done(operation: string, outcome: BrowserOutcome): Promise<{ operation_id: string; state?: string }>
}) {
  let phase: 'restoring' | 'ready' | 'admitting' | 'running' | 'parked' | 'closing' | 'cleanup' | 'disposed' = 'restoring'
  let closedAnswer: { operation_id: string; state?: string } | null = null
  let operation: string | null = null
  let hostTurn: string | null = null
  let restoration: Promise<unknown[]> | null = null
  const current = () => {
    if (phase === 'disposed' || !opts.current()) throw new Error('browser turn identity changed')
  }
  const accept = (answer: AskAccepted) => {
    current()
    if (phase !== 'admitting' || answer.operation_id !== operation || answer.route !== 'browser_mind' || answer.state !== 'browser' || typeof answer.turn_id !== 'string' || !answer.turn_id) {
      throw new Error('unconfirmed browser admission')
    }
    return answer
  }
  let admittedWords = ''
  const attach = (answer: AskAccepted) => {
    current()
    if (phase === 'running' && answer.operation_id === operation && answer.turn_id === hostTurn && answer.route === 'browser_mind' && answer.state === 'browser') return answer
    accept(answer)
    opts.broker.startTurn(operation!, 'iter', admittedWords)
    admittedWords = ''
    hostTurn = answer.turn_id
    phase = 'running'
    return answer
  }
  return {
    /** The same immutable identity binding supplied before restoration; attachment cannot rebind it. */
    isCurrent() { return phase !== 'disposed' && opts.current() },
    get phase() { return phase },
    get operation() { return operation },
    restore(): Promise<unknown[]> {
      current()
      if (restoration) return restoration
      restoration = (async () => {
        const minted = await opts.gateway.prepare()
        current()
        if (minted !== true) throw new Error(minted === 'rate-limited' ? 'mind sign-in rate limited' : 'mind sign-in unavailable')
        const results = await opts.broker.resume()
        current()
        const turn = opts.broker.turn
        if (turn && !turn.closed) {
          operation = turn.id
          phase = turn.parked ? 'parked' : 'running'
          const interrupted = results.some(value => {
            const r = value as { turnId?: unknown; interrupted?: unknown } | null
            return r?.turnId === turn.id && r.interrupted === true
          })
          if (interrupted) {
            // No worker may resume a between-step interruption. Close the broker now; retain the host operation
            // until finish('incomplete') confirms its close and retries any pending device cleanup.
            phase = 'parked'
            await opts.broker.endTurn(turn.id)
            current()
          }
        } else phase = 'ready'
        return results
      })().catch(error => { restoration = null; throw error })
      return restoration
    },
    async begin(body: AskBody) {
      current()
      if (phase !== 'ready' || !opts.workerReady()) throw new Error('browser mind is not ready for a new turn')
      // Reserve before the await: two clicks can never admit two browser-owned turns.
      phase = 'admitting'
      operation = body.operation_id
      admittedWords = body.text
      const answer = await opts.admit({ ...body, answer_in: 'browser' })
      // An unknown/lost answer intentionally leaves the operation reserved. The Ask owner reconciles that same id.
      return attach(answer)
    },
    reconcile: attach,
    /** Only the Ask admission owner, after the host confirmed refusal of this exact operation, may release it. */
    confirmedRefusal(id: string) {
      current()
      if (phase !== 'admitting' || operation !== id) throw new Error('not this pending admission')
      operation = null
      hostTurn = null
      admittedWords = ''
      phase = 'ready'
    },
    /** A lost admission's exact host readback is already terminal; this worker never started the turn. */
    reconcileClosed(answer: Pick<AskAccepted, 'operation_id' | 'route' | 'state'>) {
      current()
      if (phase !== 'admitting' || operation !== answer.operation_id || answer.route !== 'browser_mind' || (answer.state !== 'done' && answer.state !== 'refused')) throw new Error('unconfirmed browser close before start')
      operation = null
      hostTurn = null
      admittedWords = ''
      phase = 'ready'
    },
    async request(body: object) {
      current()
      if (phase !== 'running' || !operation) throw new Error('no running browser turn')
      const id = operation
      const result = await opts.broker.llm(id, body)
      current()
      if (operation !== id || phase !== 'running') throw new Error('late browser turn answer')
      return result
    },
    async finish(outcome: BrowserOutcome) {
      current()
      if ((phase !== 'running' && phase !== 'parked' && phase !== 'cleanup') || !operation) throw new Error('no browser turn to finish')
      const id = operation
      const previous = phase
      phase = 'closing'
      try {
        const answer = closedAnswer ?? await opts.done(id, outcome)
        current()
        if (answer.operation_id !== id || (answer.state !== 'done' && answer.state !== 'refused')) throw new Error('unconfirmed browser close')
        closedAnswer = answer
        const cleaned = await opts.broker.endTurn(id)
        current()
        if (!cleaned) { phase = 'cleanup'; throw new Error('browser turn cleanup incomplete; retry before navigation') }
        closedAnswer = null
        operation = null
        phase = 'ready'
        return answer
      } catch (error) {
        if (phase === 'closing' && opts.current()) phase = closedAnswer ? 'cleanup' : previous
        throw error
      }
    },
    async dispose() {
      const id = operation
      admittedWords = ''
      phase = 'disposed'
      const cleaned = id ? await opts.broker.endTurn(id) : true
      if (cleaned) operation = null
      return cleaned
    },
  }
}
