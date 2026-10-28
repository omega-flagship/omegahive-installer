/** The worker's messages: one request, one reply, matched by `id`. */
import type { MindCore } from './core'

/** The operations the worker answers (MindCore's API). */
export const OPS = ['addBelief', 'reviseBelief', 'remember', 'use', 'forget', 'forgetAll', 'import', 'recall', 'explain', 'belief', 'infer', 'export', 'stats'] as const
export type Op = (typeof OPS)[number]
/** Operations that change the space, and are written to storage before they are answered. */
export const MUTATING: ReadonlySet<Op> = new Set<Op>(['addBelief', 'reviseBelief', 'remember', 'use', 'forget', 'forgetAll', 'import'])

export type OpArgs<O extends Op> = Parameters<MindCore[O]>
export type OpResult<O extends Op> = ReturnType<MindCore[O]>

export interface OpenRequest {
  id: number
  open: { key: string; memoryOnly?: boolean }
}
export interface OpRequest<O extends Op = Op> {
  id: number
  op: O
  args: OpArgs<O>
}
export type Request = OpenRequest | OpRequest

export interface Opened {
  storage: 'indexeddb' | 'memory'
  durable: boolean
  gen: number
  /** worker spin-up to ready: engine, libs and the saved space loaded (ms) */
  coldMs: number
}

/** `durable`: this change is in storage that survives the page closing (false: memory only, or not written). */
export type Reply =
  | { id: number; ok: true; value: unknown; durable: boolean; gen: number }
  | { id: number; ok: false; error: string; code?: string }
