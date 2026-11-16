/**
 * The page's side: a typed API over the worker's messages. Every call answers with the value and whether the change
 * is durable (`durable`), so a caller that would let another copy be deleted can require it.
 */
import type { Opened, Op, OpArgs, OpResult, Reply, Request } from './protocol'

export interface Answer<T> {
  value: T
  /** this change is in storage that survives the page closing */
  durable: boolean
  gen: number
}

export class MindSpaceError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

type Port = Pick<Worker, 'postMessage' | 'terminate'> & { onmessage: ((e: MessageEvent<Reply>) => void) | null }

export class MindSpace {
  private next = 1
  private readonly waiting = new Map<number, { resolve: (r: Reply) => void }>()

  private constructor(private readonly port: Port) {
    port.onmessage = ({ data }) => {
      const w = this.waiting.get(data.id)
      if (!w) return
      this.waiting.delete(data.id)
      w.resolve(data)
    }
  }

  /** Start the worker and open `key`'s space (one per person and hive). */
  static async open(key: string, opts: { memoryOnly?: boolean; port?: Port } = {}): Promise<{ space: MindSpace; opened: Opened }> {
    const port = opts.port ?? (new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'mind-space' }) as Port)
    const space = new MindSpace(port)
    const r = await space.send({ id: 0, open: { key, memoryOnly: opts.memoryOnly } })
    return { space, opened: r.value as Opened }
  }

  private send(req: Request): Promise<Extract<Reply, { ok: true }>> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {
        resolve: (r) => (r.ok ? resolve(r) : reject(new MindSpaceError(r.error, r.code))),
      })
      this.port.postMessage({ ...req, id })
    })
  }

  async call<O extends Op>(op: O, ...args: OpArgs<O>): Promise<Answer<OpResult<O>>> {
    const r = await this.send({ id: 0, op, args } as Request)
    return { value: r.value as OpResult<O>, durable: r.durable, gen: r.gen }
  }

  addBelief = (...a: OpArgs<'addBelief'>) => this.call('addBelief', ...a)
  reviseBelief = (...a: OpArgs<'reviseBelief'>) => this.call('reviseBelief', ...a)
  remember = (...a: OpArgs<'remember'>) => this.call('remember', ...a)
  use = (...a: OpArgs<'use'>) => this.call('use', ...a)
  forget = (...a: OpArgs<'forget'>) => this.call('forget', ...a)
  forgetAll = (...a: OpArgs<'forgetAll'>) => this.call('forgetAll', ...a)
  recall = (...a: OpArgs<'recall'>) => this.call('recall', ...a)
  explain = (...a: OpArgs<'explain'>) => this.call('explain', ...a)
  belief = (...a: OpArgs<'belief'>) => this.call('belief', ...a)
  infer = (...a: OpArgs<'infer'>) => this.call('infer', ...a)
  stats = (...a: OpArgs<'stats'>) => this.call('stats', ...a)
  /** the space as MeTTa text (versioned header) */
  export = () => this.call('export')
  /** merge a file made by `export` (union rules) */
  import = (...a: OpArgs<'import'>) => this.call('import', ...a)

  close(): void {
    this.port.terminate()
    for (const [, w] of this.waiting) w.resolve({ id: 0, ok: false, error: 'closed' })
    this.waiting.clear()
  }
}
