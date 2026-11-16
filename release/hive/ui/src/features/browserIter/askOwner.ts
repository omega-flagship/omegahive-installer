import type { createBrowserTurnLifecycle } from './lifecycle'

/** The existing Ask store owns operation ids/admission/recovery. The runtime owns its worker and broker history. */
export interface BrowserAskOwner {
  lifecycle: ReturnType<typeof createBrowserTurnLifecycle>
  workerReady(): boolean
  entered(operation: string): void
  fallbackStarted(operation: string, words: string): void
  fallbackAnswer(operation: string, words: string): void
  /** A host-acknowledged, sequence-checked steer, never an optimistic edit or an altered pending model body. */
  steer(operation: string, steerId: string, words: string): Promise<{ ok: true; steerId: string; duplicate?: boolean } | { ok: false; error: string }>
  /** Disarm worker/RPC immediately, before the host Stop await; retain uncertain pending records. */
  stopping(operation: string): void
  /** Called once only after the exact host operation is confirmed terminal. */
  closed(operation: string): void
  /** Synchronously disarm the worker/port. Pending durable records remain the restoration owner's responsibility. */
  dispose(): void
}
