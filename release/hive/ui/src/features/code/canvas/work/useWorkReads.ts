/**
 * The reads behind the work stream: the project-test evidence for exactly the shown proposal (once a test on a copy
 * was asked for), and the request controller's view when the client carries that pending read (./controllerState).
 * Both poll gently with growing gaps, stop at a settled answer, and drop every answer after the subject, the work
 * context or the component changes. The context is the canvas's readContext (client identity, its signed-in person,
 * task, grant, workspace): the same binding the canvas's sandbox test request uses, so a change of person drops all.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { hiveBus } from '../../../../store/store'
import { evidenceSubjectKey, ProjectTestEvidenceReader, type EvidenceCall, type EvidenceSubject } from '../../suggestions/projectTestEvidence'
import { carriesController, readController, type ControllerRead, type ControllerState } from './controllerState'
import { testFromEvidence, type TestView } from './stages'

const EVIDENCE_GAPS = [1500, 2500, 4000, 6000, 8000]
/** how long the stream waits for a test result before pointing to the drawer (ms) */
export const TEST_WAIT_MS = 8 * 60_000
/** the fallback look when no event arrives (ms): events carry the pace */
const CONTROLLER_SLOW_MS = 15_000

const settled = (v: TestView) => v.kind === 'passed' || v.kind === 'failed' || v.kind === 'unknown' || v.kind === 'stale'

/** Poll the verified evidence for `subject` while `on`; null subject or off → null (nothing claimed). */
export function useProposalTestEvidence(call: EvidenceCall | null, context: string, subject: EvidenceSubject | null, on: boolean, waitMs = TEST_WAIT_MS): TestView | null {
  let key: string | null = null
  try {
    key = subject ? `${context}|${evidenceSubjectKey(subject)}` : null
  } catch {
    key = null
  }
  const [view, setView] = useState<{ key: string; view: TestView } | null>(null)
  useEffect(() => {
    if (!call || !subject || !key || !on) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let i = 0
    const until = Date.now() + waitMs
    const put = (v: TestView) => alive && setView({ key: key!, view: v })
    const reader = new ProjectTestEvidenceReader(call, subject, (st) => {
      if (!alive || st.pending) return
      const v: TestView = st.page ? testFromEvidence(st.page.results) : { kind: 'waiting' }
      put(v)
      if (settled(v)) return
      if (Date.now() > until) return void put({ kind: 'slow' })
      timer = setTimeout(() => void reader.load(), EVIDENCE_GAPS[Math.min(i++, EVIDENCE_GAPS.length - 1)])
    })
    void reader.load()
    return () => {
      alive = false
      reader.dispose()
      if (timer) clearTimeout(timer)
    }
    // the subject is fully named by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, key, on, waitMs])
  return view && view.key === key && on ? view.view : null
}

/** the store's event bus, where the hive's events arrive (read lazily: a page or test without the store has none) */
function bus(): { on: (fn: (e: unknown) => void) => () => void } | null {
  try {
    return (hiveBus as unknown as { on?: unknown })?.on ? (hiveBus as unknown as { on: (fn: (e: unknown) => void) => () => void }) : null
  } catch {
    return null
  }
}
/**
 * The typed R3.12 events (code.controller.status, code.controller.applied) and the earlier untyped notices
 * (code.controller, code.controller.ready: older hosts), plus request.updated.
 */
const CONTROLLER_EVENTS = new Set(['code.controller', 'code.controller.ready', 'code.controller.status', 'code.controller.applied', 'request.updated'])
/** whether a hive event is about this request (code.controller* carry request_id; request.updated a request) */
export function aboutRequest(e: unknown, requestId: string): boolean {
  if (!e || typeof e !== 'object') return false
  const ev = e as { type?: unknown; request_id?: unknown; request?: { id?: unknown } }
  if (typeof ev.type !== 'string' || !CONTROLLER_EVENTS.has(ev.type)) return false
  return ev.request_id === requestId || ev.request?.id === requestId
}

/** The person's Apply landed through the engine (code.controller.applied): which files to read again, and where. */
export interface ControllerApplied {
  candidate: string | null
  workspace_id: string
  paths: string[]
  application_id: string | null
  /** the workspace head after the apply ({ generation, tree_digest }), when the host names it */
  after: { generation: number; tree_digest: string } | null
}
/** A code.controller.applied event for exactly this request, checked field by field; anything else → null. */
export function appliedFor(e: unknown, requestId: string): ControllerApplied | null {
  if (!e || typeof e !== 'object') return null
  const ev = e as Record<string, unknown>
  if (ev.type !== 'code.controller.applied' || ev.request_id !== requestId) return null
  if (typeof ev.workspace_id !== 'string' || !ev.workspace_id || !Array.isArray(ev.paths)) return null
  const paths = ev.paths.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1024).slice(0, 500)
  const a = ev.after as { generation?: unknown; tree_digest?: unknown } | null | undefined
  const after = a && typeof a === 'object' && typeof a.generation === 'number' && Number.isSafeInteger(a.generation) && typeof a.tree_digest === 'string' && a.tree_digest ? { generation: a.generation, tree_digest: a.tree_digest } : null
  return {
    candidate: typeof ev.candidate === 'string' ? ev.candidate : null,
    workspace_id: ev.workspace_id,
    paths,
    application_id: typeof ev.application_id === 'string' ? ev.application_id : null,
    after,
  }
}

/**
 * The controller's view of `requestId` while `on`, only if the client carries the read: read once, then again on every
 * hive event about this request (the typed code.controller.status / code.controller.applied, preferred once one has
 * arrived; else the untyped code.controller / code.controller.ready of older hosts; request.updated); a slow look as a fallback
 * when no event arrives. Returns the latest read (engine / none / unknown) and `after(view)` for after a person route:
 * the view the route answered shows at once (the event re-read follows); without a trusted view it reads again.
 * `onApplied`: a code.controller.applied event for this request (once per application) — the workbench reads those
 * paths again so the editor shows the applied text; a re-read of the controller follows as for every event.
 */
export function useControllerState(client: unknown, context: string, requestId: string | null, on: boolean, slowMs = CONTROLLER_SLOW_MS, onApplied?: (applied: ControllerApplied) => void): { read: ControllerRead | null; after: (view: ControllerState | null) => void } {
  const [state, setState] = useState<{ id: string; read: ControllerRead } | null>(null)
  const [nudge, setNudge] = useState(0)
  const appliedRef = useRef(onApplied)
  useEffect(() => {
    appliedRef.current = onApplied
  })
  const id = requestId ? `${context}|${requestId}` : null
  const carries = carriesController(client)
  useEffect(() => {
    if (!carries || !requestId || !id || !on) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let seq = 0
    const seen = new Set<string>()
    // once a typed event (code.controller.status / .applied) arrived for this request, the host sends them: the untyped
    // notices it still fires alongside are not read again (no double read)
    let typed = false
    const look = async () => {
      const mine = ++seq
      if (timer) clearTimeout(timer)
      const read = await readController(client, requestId)
      if (!alive || mine !== seq) return
      setState({ id, read })
      timer = setTimeout(() => void look(), slowMs)
    }
    const off = bus()?.on((e) => {
      if (!alive || !aboutRequest(e, requestId)) return
      const type = (e as { type: string }).type
      if (type === 'code.controller.status' || type === 'code.controller.applied') typed = true
      else if (typed && (type === 'code.controller' || type === 'code.controller.ready')) return
      const applied = appliedFor(e, requestId)
      if (applied) {
        const key = applied.application_id ?? `${applied.candidate}|${applied.after?.generation ?? ''}`
        if (!seen.has(key)) {
          seen.add(key)
          try { appliedRef.current?.(applied) } catch { /* the editor's re-read reports its own trouble */ }
        }
      }
      void look()
    })
    void look()
    return () => {
      alive = false
      off?.()
      if (timer) clearTimeout(timer)
    }
  }, [client, carries, requestId, id, on, slowMs, nudge])
  const after = useCallback(
    (view: ControllerState | null) => {
      if (view && id && view.request_id === requestId) setState({ id, read: { kind: 'engine', state: view } })
      else setNudge((n) => n + 1)
    },
    [id, requestId],
  )
  return { read: carries && state && state.id === id ? state.read : null, after }
}
