import { ApiError, type HiveClient } from '../../../api/client'
import { STALE, type EpochBinding } from '../../../lib/identityEpoch'
import { MODULES, presentFields, moduleRef, parseReasoningRead, READ_QUERY, TOOLS_APP_ID, type Envelope, type ModuleId } from './contract'

/**
 * What a viewer draws. `current` and `empty` come only from an actual host read of this mind, under the signed-in
 * person's own session. `synthetic` and `banked` are drawn only inside a guided tour (ModuleViewer's `context`); in
 * the viewer's current-state area such an answer is a contract breach and reads as unreadable.
 */
export type UnavailableWhy = 'no_reader' | 'withheld' | 'stale' | 'unreadable' | 'unspecified'
export type ViewState =
  | { kind: 'loading' }
  | { kind: 'current'; envelope: Envelope }
  | { kind: 'empty'; envelope: Envelope }
  | { kind: 'unavailable'; why: UnavailableWhy }
  | { kind: 'synthetic'; envelope: Envelope }
  | { kind: 'banked'; envelope: Envelope }

/** The minimum of the client a viewer uses: the app's description, and its declared read. */
export type ReaderClient = Pick<HiveClient, 'program'> & Partial<Pick<HiveClient, 'programRead'>>

/**
 * Does this hive's Omega Tools app declare the `reasoning-module` read? Only then is a read ever made. No client
 * read route, no app, a disabled app, or no such read: false, and every viewer says "no reader yet" with no module read
 * made. The description itself is one GET (GET /api/programs/omega-tools); only module reads are gated.
 */
export async function readerDeclared(client: ReaderClient | null): Promise<boolean> {
  if (!client?.programRead) return false
  try {
    const d = await client.program(TOOLS_APP_ID)
    return !!d.enabled && !d.error && !!d.describe?.reads?.some((r) => r.id === READ_QUERY)
  } catch {
    return false
  }
}

/** One answer as a view state (current-state area: synthetic and banked are not current, so unreadable). */
export function stateOf(raw: unknown, mindId: string, module: ModuleId): ViewState {
  const p = parseReasoningRead(raw, { mindId, module })
  if (!p.ok) return { kind: 'unavailable', why: 'unreadable' }
  const e = p.envelope
  if (e.state === 'unavailable') return { kind: 'unavailable', why: e.unavailable_reason ?? 'unspecified' }
  if (e.state !== 'current') return { kind: 'unavailable', why: 'unreadable' }
  return presentFields(e).length === 0 ? { kind: 'empty', envelope: e } : { kind: 'current', envelope: e }
}

/**
 * One answer as a GUIDED (tour) view state: the one place synthetic and banked are read and drawn, always labelled.
 * Same strict parser; only the area differs (as Root's reference check's `area='guided'`).
 */
export function tourStateOf(raw: unknown, mindId: string, module: ModuleId): ViewState {
  const p = parseReasoningRead(raw, { mindId, module })
  if (!p.ok) return { kind: 'unavailable', why: 'unreadable' }
  const e = p.envelope
  if (e.state === 'synthetic' || e.state === 'banked') return { kind: e.state, envelope: e }
  return stateOf(raw, mindId, module)
}

/**
 * A refusal as a view state. The host's uniform visibility contract (r16) answers a mind this person cannot see, and
 * one that does not exist, with the same 404/403: "not visible or withheld", never which. 404 unknown_read: no
 * reader. Anything else: unreadable.
 */
export function refusalOf(e: unknown): ViewState {
  if (e instanceof ApiError) {
    if (e.status === 404 && e.code === 'unknown_read') return { kind: 'unavailable', why: 'no_reader' }
    if (e.status === 404 || e.status === 403) return { kind: 'unavailable', why: 'withheld' }
  }
  return { kind: 'unavailable', why: 'unreadable' }
}

/** The six, all at one state (the starting point and every "no reader" answer). */
export const allAt = (s: ViewState): Record<ModuleId, ViewState> => Object.fromEntries(MODULES.map((m) => [m, s])) as Record<ModuleId, ViewState>

/**
 * Read the six viewers for one mind. Every write after an await goes through `binding.commit` (lib/identityEpoch):
 * an answer that lands after a change of person writes nothing. Returns STALE once the identity moved.
 * Read-only: one declared read per module, nothing else; no act, no run, no filesystem or _hive path.
 */
export async function loadReasoningModules(
  client: ReaderClient | null,
  mind: { id: string; swarm_id: string | null },
  write: (module: ModuleId, s: ViewState) => void,
  binding: EpochBinding,
): Promise<void | typeof STALE> {
  const declared = await readerDeclared(client)
  if (!binding.current()) return STALE
  if (!declared || !client?.programRead || !mind.swarm_id) {
    const r = binding.commit(() => MODULES.forEach((m) => write(m, { kind: 'unavailable', why: 'no_reader' })))
    return r === STALE ? STALE : undefined
  }
  const read = client.programRead.bind(client)
  const swarm = mind.swarm_id
  const results = await Promise.all(
    MODULES.map(async (m) => {
      let s: ViewState
      try {
        const out = await read(TOOLS_APP_ID, swarm, READ_QUERY, { ref: moduleRef(mind.id, m) })
        s = out && out.program === TOOLS_APP_ID && out.query === READ_QUERY ? stateOf(out.result, mind.id, m) : { kind: 'unavailable', why: 'unreadable' }
      } catch (e) {
        s = refusalOf(e)
      }
      return binding.commit(() => write(m, s))
    }),
  )
  return results.some((r) => r === STALE) ? STALE : undefined
}

/**
 * One read batch per mounted viewer set, client, person (epoch) and mind (`key`). React StrictMode replays an effect in
 * development (setup, cleanup, setup, in one commit): the replay finds the batch it just ended still pending its cancel,
 * with the same key and client, and revives it instead of dispatching a second batch. Any other change aborts the
 * batch in flight, and a cleanup not followed by such a replay aborts it on the next task (an unmount). An aborted or
 * ended batch writes nothing: its late answers are refused (and each write is still bound to its identity epoch).
 * Nothing is cached across batches: a new person, mind or client always reads afresh.
 */
export interface ReadBatch {
  readonly id: number
  readonly key: string
  readonly client: unknown
  /** set up and not cleaned up */
  live: boolean
  /** ended for good: never writes again */
  aborted: boolean
  /** the pending abort after a cleanup (a replay clears it) */
  cancel: ReturnType<typeof setTimeout> | null
}
let batches = 0

/** The batch for this setup: the one just ended, revived (a StrictMode replay), or a new one, dispatched once. */
export function startBatch(prev: ReadBatch | null, key: string, client: unknown, dispatch: (b: ReadBatch) => void): ReadBatch {
  if (prev && !prev.aborted && prev.cancel !== null && prev.key === key && prev.client === client) {
    clearTimeout(prev.cancel)
    prev.cancel = null
    prev.live = true
    return prev
  }
  if (prev && !prev.aborted) abortBatch(prev)
  const b: ReadBatch = { id: ++batches, key, client, live: true, aborted: false, cancel: null }
  dispatch(b)
  return b
}

/** The effect's cleanup: the batch stops writing now, and is aborted on the next task unless a replay revives it. */
export function endBatch(b: ReadBatch): void {
  b.live = false
  if (b.aborted || b.cancel !== null) return
  b.cancel = setTimeout(() => abortBatch(b), 0)
}

export function abortBatch(b: ReadBatch): void {
  if (b.cancel !== null) clearTimeout(b.cancel)
  b.cancel = null
  b.live = false
  b.aborted = true
}

/** Whether a batch's answer may be written now. */
export const batchWrites = (b: ReadBatch): boolean => b.live && !b.aborted
