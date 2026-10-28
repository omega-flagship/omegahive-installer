/**
 * "Test this" on the Code canvas: run the workspace's tests on exactly the saved generation (the same POST /v1/runs the
 * Test pane uses, same frozen-copy rules), read the whole output through the same byte-cursor reader, and turn it into
 * results beside the lines they name (vibe.runMarks). The full output and the raw command stay in the drawer's Tests.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeFailure } from '../suggestions/model'
import { liveRunStatus } from '../commandArgs'
import { OutputReader, type OutputPage } from '../runOutput'
import { runMarks, runTally, type RunMark } from './vibe'

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>
interface Run {
  id: string
  status: string
  exit_code?: number | null
  generation: number
}
export type TestState =
  | { kind: 'idle' }
  | { kind: 'running'; what: string }
  | { kind: 'done'; run: Run; marks: RunMark[]; tally: { passed: number; failed: number; text: string } | null; output: string; what: string }
  | { kind: 'error'; text: string; unavailable: boolean }

export const DEFAULT_TEST = ['python3', '-m', 'pytest', '-q']

export function useTestRun(call: Call | null, ws: { id: string; generation: number; tree_digest: string } | null) {
  const [state, setState] = useState<TestState>({ kind: 'idle' })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // results belong to the generation they ran on: a moved candidate keeps them, marked as earlier (see `current`)
  const run = useCallback(
    async (what: string, argv: string[] = DEFAULT_TEST) => {
      if (!call || !ws) return
      setState({ kind: 'running', what })
      try {
        let r = await call<Run>('POST', '/v1/runs', { operation_id: `run-${crypto.randomUUID()}`, workspace_id: ws.id, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, argv, timeout_seconds: 120 })
        for (let i = 0; liveRunStatus(r.status) && i < 100 && alive.current; i++) {
          await new Promise((ok) => setTimeout(ok, 1200))
          r = await call<Run>('GET', `/v1/runs/${r.id}`)
        }
        const reader = new OutputReader(r.id, ws.id)
        for (let i = 0; i < 64 && alive.current; i++) {
          const page = await call<OutputPage>('GET', `/v1/runs/${r.id}/output`, undefined, { after: String(reader.cursor), limit: '16384' })
          const step = reader.append(page)
          if (step === 'done' || step === 'wait') break
        }
        if (!alive.current) return
        setState({ kind: 'done', run: r, marks: runMarks(reader.text), tally: runTally(reader.text), output: reader.text, what })
      } catch (e) {
        if (!alive.current) return
        const f = describeFailure(e)
        setState({ kind: 'error', text: f.kind === 'unavailable' ? 'Running tests is not available through this hive yet.' : `The tests did not run: ${f.text}`, unavailable: f.kind === 'unavailable' })
      }
    },
    [call, ws],
  )
  const clear = useCallback(() => setState({ kind: 'idle' }), [])
  return { state, run, clear }
}
