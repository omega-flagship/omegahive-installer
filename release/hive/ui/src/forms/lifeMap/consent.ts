/**
 * The consent gate for consequential actions (investigate, revoke-request, cancel-request).
 * Review R2: confirm only with the full envelope in view. Review R3: no carried focus, reject key repeat, and
 * require a fresh, intentional activation that began after the dialog opened. One opening authorizes one
 * submission of exactly the envelope that was reviewed.
 */
export type ConsentAction = 'investigate' | 'revoke-request' | 'cancel-request'

export interface Envelope {
  action: ConsentAction
  items: string[]
  params: Record<string, string | number>
  /**
   * Review C2: what was inspected. The graph revision on screen and the exact record ids the sealed snapshot would
   * hold (the premise closure shown as "Sealed snapshot"). Part of the digest, so a consent given on one revision or
   * scope can never authorize another; the host is given this revision, never a newer one.
   */
  source?: SourceBinding
}

export interface SourceBinding {
  revision: string
  scope: string[]
}

/** The same inspected source: same revision and the same closure (order-free). */
export function sameSource(a: SourceBinding | undefined, b: SourceBinding | undefined): boolean {
  if (!a || !b) return a === b
  if (a.revision !== b.revision || a.scope.length !== b.scope.length) return false
  const x = [...a.scope].sort()
  const y = [...b.scope].sort()
  return x.every((v, i) => v === y[i])
}

export interface Gate {
  phase: 'open' | 'submitting' | 'done' | 'refused'
  envelope: Envelope
  digest: string
  openedAt: number
  /** When a non-repeat confirming keydown began inside the open dialog. */
  keyArmedAt: number | null
  consumed: boolean
}

/** Minimum time the envelope is on screen before it can be confirmed. */
export const MIN_DWELL_MS = 700

/** FNV-1a over canonical JSON: binds the confirm to exactly what was shown. */
export function digestOf(e: Envelope): string {
  const base: unknown[] = [e.action, [...e.items].sort(), Object.keys(e.params).sort().map((k) => [k, e.params[k]])]
  if (e.source) base.push(['source', e.source.revision, [...e.source.scope].sort()])
  const canon = JSON.stringify(base)
  let h = 0x811c9dc5
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function openGate(envelope: Envelope, now: number): Gate {
  return { phase: 'open', envelope, digest: digestOf(envelope), openedAt: now, keyArmedAt: null, consumed: false }
}

/** Editing anything re-opens review: new digest, dwell restarts, any armed key is dropped. */
export function editGate(g: Gate, envelope: Envelope, now: number): Gate {
  return { ...g, envelope, digest: digestOf(envelope), openedAt: now, keyArmedAt: null }
}

export function noteKeyDown(g: Gate, e: { key: string; repeat: boolean }, now: number): Gate {
  if (g.phase !== 'open' || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return g
  return { ...g, keyArmedAt: now }
}

export interface Activation {
  kind: 'pointer' | 'key'
  repeat?: boolean
  /** The digest the confirm button was rendered against. */
  digest: string
}

export type Refusal = 'repeat' | 'too-soon' | 'not-armed' | 'changed' | 'consumed' | 'closed' | 'stale'

export function canConfirm(g: Gate, a: Activation, now: number): Refusal | null {
  if (g.phase !== 'open') return 'closed'
  if (g.consumed) return 'consumed'
  if (a.repeat) return 'repeat'
  if (a.digest !== g.digest) return 'changed'
  if (now - g.openedAt < MIN_DWELL_MS) return 'too-soon'
  if (a.kind === 'key' && (g.keyArmedAt == null || g.keyArmedAt < g.openedAt)) return 'not-armed'
  return null
}

export function confirm(g: Gate, a: Activation, now: number): { gate: Gate; ok: boolean; reason: Refusal | null } {
  const reason = canConfirm(g, a, now)
  if (reason) return { gate: g, ok: false, reason }
  return { gate: { ...g, phase: 'submitting', consumed: true }, ok: true, reason: null }
}

export const settle = (g: Gate, ok: boolean): Gate => ({ ...g, phase: ok ? 'done' : 'refused' })

/** A stable retry identity for one opening of the dialog. */
export const idempotencyKey = (g: Pick<Gate, 'digest' | 'openedAt'>) => `atlas-form-${g.digest}-${g.openedAt.toString(36)}`

export const REFUSAL_TEXT: Record<Refusal, string> = {
  repeat: 'Held key ignored. Release it and press once, deliberately.',
  'too-soon': 'Read the envelope first; confirm becomes available in a moment.',
  'not-armed': 'Press confirm afresh: a key press that began before this dialog does not count.',
  changed: 'The envelope changed. Review it again before confirming.',
  consumed: 'This envelope was already sent. Open a new request to send another.',
  closed: 'This dialog is closed.',
  stale: 'The record changed while this was open. Nothing was sent; open the request again to review what it now holds.',
}

/**
 * Review C2: a consent is for the source that was inspected. If the graph revision or the snapshot closure differs
 * now, the consent is stale: refuse, send nothing, and require a fresh review.
 */
export function staleAgainst(g: Gate, current: SourceBinding | undefined): boolean {
  return !!g.envelope.source && !sameSource(g.envelope.source, current)
}
