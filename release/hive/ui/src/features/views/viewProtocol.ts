/**
 * Purpose: the messages between the page and one view's worker (viewSandbox.worker.ts), and the worker's side of them:
 * one request, one reply, matched by id. The worker first says whether its scope is bare (viewSandbox.ts); a worker
 * whose scope is not answers every request with that problem, so a view never runs there.
 */
import { MettaView, ViewProblem, type Press, type ViewFrame } from './mettaView'
import type { SandboxReport } from './viewSandbox'

export type ViewRequest =
  | { id: number; kind: 'open'; source: string; look: string }
  | { id: number; kind: 'replace'; source: string; look: string }
  | { id: number; kind: 'input'; key: string; text: string; look: string }
  | { id: number; kind: 'press'; press: Press; look: string }
  | { id: number; kind: 'look'; look: string }

export type ViewReply =
  | { id: number; ok: true; frame: ViewFrame }
  | { id: number; ok: false; problem: string }
  /** the worker's first message: its scope as harden left it */
  | { id: 0; ready: SandboxReport }

/** The worker's side: one view, answering each request with a frame or the view's own problem in words. */
export function viewAnswerer(sandbox: SandboxReport): (req: ViewRequest) => ViewReply {
  let view: MettaView | null = null
  return (req) => {
    try {
      if (!sandbox.ok) throw new ViewProblem(`this browser left a way out of the view's worker open (${sandbox.open.join(', ')})`)
      if (req.kind === 'open') {
        view = new MettaView()
        view.load(req.source)
        return { id: req.id, ok: true, frame: view.render(req.look) }
      }
      if (!view) throw new ViewProblem('the view was not opened')
      if (req.kind === 'replace') return { id: req.id, ok: true, frame: view.replace(req.source, req.look) }
      let says: string[] = []
      if (req.kind === 'input') view.input(req.key, req.text)
      else if (req.kind === 'press') says = view.press(req.press)
      return { id: req.id, ok: true, frame: { ...view.render(req.look), says } }
    } catch (e) {
      return { id: req.id, ok: false, problem: e instanceof ViewProblem ? e.message : `it stopped on an error: ${(e as Error)?.message ?? String(e)}` }
    }
  }
}
