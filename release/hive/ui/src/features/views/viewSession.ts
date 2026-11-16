/**
 * Purpose: the page's side of one view's worker (viewSandbox.worker.ts): requests answered by id, the worker's report
 * on its own scope, and a watchdog. A view's MeTTa runs on a step budget, so a reply that does not come within
 * STOP_AFTER_MS means something no budget counts (a single step that never ends); the worker is then ended, and every
 * waiting request is refused with ViewStopped, so the page can say the view stopped and offer to start it again.
 */
import type { ViewFrame } from './mettaView'
import type { ViewReply, ViewRequest } from './viewProtocol'
import type { SandboxReport } from './viewSandbox'

/** Far beyond what a view's composition takes on a slow phone, and short enough that a person is not left guessing. */
export const STOP_AFTER_MS = 10_000

/** The worker as the session uses it: a real Worker, or one answering in this thread for tests. */
export interface ViewPort {
  postMessage(message: ViewRequest): void
  terminate(): void
  onmessage: ((event: { data: ViewReply }) => void) | null
  onerror?: ((event: unknown) => void) | null
}

/** The view's worker ended: it stopped answering, failed to start, or the view was closed. */
export class ViewStopped extends Error {}
/** The view's own mistake, as the worker put it (mettaView.ts ViewProblem). */
export class ViewBroken extends Error {}

export type ViewAsk =
  | { kind: 'open'; source: string; look: string }
  | { kind: 'replace'; source: string; look: string }
  | { kind: 'input'; key: string; text: string; look: string }
  | { kind: 'press'; press: Extract<ViewRequest, { kind: 'press' }>['press']; look: string }
  | { kind: 'look'; look: string }

export class ViewSession {
  private next = 1
  private stopped: ViewStopped | null = null
  private readonly waiting = new Map<number, { resolve: (f: ViewFrame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** refuses `ready` when the worker ends before it reports */
  private failReady: (e: Error) => void = () => undefined
  /** the wait for the worker's first message */
  private readonly startup: ReturnType<typeof setTimeout>
  /** what the worker found in its own scope; a view is drawn only when it is ok */
  readonly ready: Promise<SandboxReport>

  constructor(private readonly port: ViewPort, private readonly stopAfterMs = STOP_AFTER_MS) {
    let settle: (r: SandboxReport) => void = () => undefined
    this.ready = new Promise<SandboxReport>((resolve, reject) => { settle = resolve; this.failReady = reject })
    this.ready.catch(() => undefined)   // a session nobody waits on still ends quietly
    this.startup = setTimeout(() => this.stop(new ViewStopped('the view did not start')), stopAfterMs)
    port.onmessage = ({ data }) => {
      if ('ready' in data) { clearTimeout(this.startup); settle(data.ready); return }
      const w = this.waiting.get(data.id)
      if (!w) return
      this.waiting.delete(data.id)
      clearTimeout(w.timer)
      if (data.ok) w.resolve(data.frame)
      else w.reject(new ViewBroken(data.problem))
    }
    port.onerror = () => this.stop(new ViewStopped('the view stopped on an error'))
  }

  /** Ask the worker; the answer is the next frame, a ViewBroken with the view's mistake, or ViewStopped. */
  ask(ask: ViewAsk): Promise<ViewFrame> {
    if (this.stopped) return Promise.reject(this.stopped)
    const id = this.next++
    return new Promise<ViewFrame>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new ViewStopped('the view stopped responding')), this.stopAfterMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.port.postMessage({ ...ask, id } as ViewRequest)
    })
  }

  /** End the worker and refuse whatever is still waiting. */
  stop(why = new ViewStopped('the view was closed')): void {
    if (this.stopped) return
    this.stopped = why
    this.port.onmessage = null
    this.port.terminate()
    clearTimeout(this.startup)
    this.failReady(why)
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(why) }
    this.waiting.clear()
  }

  get isStopped(): boolean {
    return this.stopped !== null
  }
}

/** A real worker for one view, built from viewSandbox.worker.ts. */
export function viewWorker(): ViewPort {
  return new Worker(new URL('./viewSandbox.worker.ts', import.meta.url), { type: 'module', name: 'view' }) as unknown as ViewPort
}
