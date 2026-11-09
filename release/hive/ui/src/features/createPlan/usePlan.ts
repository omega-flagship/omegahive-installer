/**
 * The reads and the person's acts behind the Make bench: start from a sentence (or pick up the person's running plan:
 * GET /api/create/plans), read the plan again on each create.plan.status / .piece / .question event for it (a slow
 * timer only as a fallback), fetch the verified preview (GET …/preview) when a create.plan.preview event arrives or the
 * view names a new preview, read the file the code pane shows through the files route (cached per path and
 * checkpoint), answer a question, the one go to deploy, and the one Stop. Every write after an await belongs to the
 * identity it started under (lib/identityEpoch): a change of person drops the plan, its reads and its pending acts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hiveBus, useHive } from '../../store/store'
import { bindEpoch, currentEpoch, onIdentityChange } from '../../lib/identityEpoch'
import type { PlanClient, PlanView, PreviewFiles } from './contract'
import {
  currentFile, fileKey, fileWant, parseFileText, parsePlanList, parsePlanView, parsePreviewFiles, runningPlan,
  type CurrentFile, type FileTexts, type MindLookup, type Recent,
} from './planModel'

/** read gaps (ms), a fallback only: the plan's events carry the pace. While it moves, while it waits on the person,
 * and once its events have been heard. */
export const PLAN_GAPS = { moving: 4000, waiting: 8000, heard: 15000 }
const SETTLED = new Set(['deployed', 'stopped'])
const WAITING = new Set(['ready_to_deploy', 'needs_you', 'asking_you', 'assignee_unavailable', 'engine_error'])
/** file texts kept (per path and checkpoint); older ones are let go first */
const TEXTS_KEPT = 240

/** The plan this browser is following, for this identity only (back to the bench, and it is still there). */
let following: { epoch: number; id: string } | null = null
onIdentityChange(() => { following = null })
export function followedPlan(): string | null {
  return following && following.epoch === currentEpoch() ? following.id : null
}
export function forgetPlan(): void { following = null }

const errText = (e: unknown) => (e as { message?: string } | null)?.message || 'The hive did not answer.'

type PlanEvent = { type: string; plan_id: string; piece?: unknown }
/** whether a hive event is about this plan (create.plan.status, .piece, .question, .preview all carry plan_id) */
export function aboutPlan(e: unknown, planId: string): e is PlanEvent {
  if (!e || typeof e !== 'object') return false
  const ev = e as { type?: unknown; plan_id?: unknown }
  return typeof ev.type === 'string' && ev.type.startsWith('create.plan.') && ev.plan_id === planId
}

function bus(): { on: (fn: (e: unknown) => void) => () => void } | null {
  try {
    return (hiveBus as unknown as { on?: unknown })?.on ? (hiveBus as unknown as { on: (fn: (e: unknown) => void) => () => void }) : null
  } catch {
    return null
  }
}

export interface PlanState {
  /** this hive carries the plan routes */
  can: boolean
  /** a plan is being followed (its view may still be on its way) */
  following: boolean
  view: PlanView | null
  /** the file the code pane shows (its text through the files route), null while none */
  file: CurrentFile | null
  /** the running page: the current preview's verified files, null until there is one */
  frame: PreviewFiles | null
  starting: boolean
  startError: string | null
  /** the question being answered (its q), the deploy or the stop on its way */
  answering: string | null
  deploying: boolean
  stopping: boolean
  /** an act that did not go through, in plain words */
  alert: string | null
  /** the last read failed; the last view stays */
  stale: boolean
  start: (sentence: string) => void
  answer: (q: string, text: string) => void
  deploy: () => void
  stop: () => void
  /** begin again from an empty canvas (after a stop or an install) */
  fresh: () => void
}

export function usePlan(): PlanState {
  const client = useHive((s) => s.client) as unknown as PlanClient | null
  const agents = useHive((s) => s.agents) as Record<string, { name?: string; hue?: number }> | undefined
  const binding = useMemo(() => bindEpoch(), [])
  const can = !!client?.createPlanStart && !!client?.createPlan
  const [id, setId] = useState<string | null>(() => followedPlan())
  const [view, setView] = useState<PlanView | null>(null)
  const [texts, setTexts] = useState<FileTexts>({})
  const [recent, setRecent] = useState<Recent>({})
  const [frame, setFrame] = useState<PreviewFiles | null>(null)
  const [previewNudge, setPreviewNudge] = useState(0)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [answering, setAnswering] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [nudge, setNudge] = useState(0)
  const status = useRef<string | null>(null)
  const minds = useRef<MindLookup>(() => null)
  useEffect(() => {
    minds.current = (mid) => {
      const a = agents?.[mid]
      return a && typeof a.name === 'string' ? { name: a.name, hue: typeof a.hue === 'number' ? a.hue : 0 } : null
    }
  }, [agents])

  /** a view an act or a read answered, for this plan only */
  const take = useCallback((raw: unknown, planId: string) => {
    const v = parsePlanView(raw, minds.current)
    if (!v || v.plan_id !== planId) return false
    binding.commit(() => {
      status.current = v.status
      setView(v)
      setStale(false)
    })
    return true
  }, [binding])

  // the person's running plan, picked up again when the bench opens with none followed
  useEffect(() => {
    if (id || !client?.createPlans) return
    let alive = true
    void client.createPlans().then((raw) => {
      if (!alive) return
      const run = runningPlan(parsePlanList(raw))
      if (!run) return
      binding.commit(() => {
        if (following && following.epoch === binding.epoch) return
        following = { epoch: binding.epoch, id: run.plan_id }
        setId((now) => now ?? run.plan_id)
      })
    }, () => undefined)
    return () => { alive = false }
    // once, when the bench opens (a later fresh start never resumes the old plan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    if (!id || !client?.createPlan) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let seq = 0
    // once the hive's events about this plan arrive they carry the pace; reading on a timer becomes a slower fallback
    let heard = false
    const look = async () => {
      const mine = ++seq
      if (timer) clearTimeout(timer)
      try {
        const raw = await client.createPlan!(id)
        if (!alive || mine !== seq) return
        if (!take(raw, id)) binding.commit(() => setStale(true))
      } catch {
        if (!alive || mine !== seq) return
        binding.commit(() => setStale(true))
      }
      if (!alive || !binding.current()) return
      const st = status.current ?? ''
      if (SETTLED.has(st)) return
      timer = setTimeout(() => void look(), heard ? PLAN_GAPS.heard : WAITING.has(st) ? PLAN_GAPS.waiting : PLAN_GAPS.moving)
    }
    const off = bus()?.on((e) => {
      if (!alive || !aboutPlan(e, id)) return
      heard = true
      if (e.type === 'create.plan.preview') {
        binding.commit(() => setPreviewNudge((n) => n + 1))
        return
      }
      if (e.type === 'create.plan.piece' && typeof e.piece === 'string') {
        const piece = e.piece
        binding.commit(() => setRecent((r) => ({ ...r, [piece]: Date.now() })))
      }
      void look()
    })
    void look()
    return () => {
      alive = false
      off?.()
      if (timer) clearTimeout(timer)
    }
  }, [id, client, binding, take, nudge])

  // the running page: the verified preview, fetched for each new preview the view names or an event announces
  const pv = id && view?.plan_id === id ? view.preview : null
  const wantPreview = pv ? `${pv.ref ?? ''}@${pv.ckpt}` : null
  const previewAsked = useRef<{ key: string | null; nudge: number }>({ key: null, nudge: 0 })
  useEffect(() => {
    if (!id || !client?.createPlanPreview || (!wantPreview && !previewNudge)) return
    if (previewAsked.current.key === wantPreview && previewAsked.current.nudge === previewNudge) return
    previewAsked.current = { key: wantPreview, nudge: previewNudge }
    let alive = true
    void client.createPlanPreview(id).then((raw) => {
      const f = parsePreviewFiles(raw)
      if (!alive || !f) return
      // the view naming this same preview later asks nothing more
      previewAsked.current = { key: `${f.ref}@${f.ckpt}`, nudge: previewAsked.current.nudge }
      binding.commit(() => setFrame(f))
    }, () => undefined) // none yet, or not verified: the last verified page stays
    return () => { alive = false }
  }, [id, client, binding, wantPreview, previewNudge])

  // the code pane's text: the next file it needs, read through the files route (one at a time, cached)
  const live = id && view?.plan_id === id ? view : null
  const want = live ? fileWant(live, texts, recent) : null
  const wantKey = want ? fileKey(want.ckpt, want.path) : null
  useEffect(() => {
    if (!id || !want || !wantKey || !client?.createPlanFile) return
    let alive = true
    const keep = (text: string | null) => binding.commit(() => setTexts((t) => {
      const keys = Object.keys(t)
      const kept = keys.length >= TEXTS_KEPT ? Object.fromEntries(keys.slice(keys.length - TEXTS_KEPT + 1).map((k) => [k, t[k]])) : t
      return { ...kept, [wantKey]: text }
    }))
    void client.createPlanFile(id, want.path, want.ckpt).then(
      (raw) => { if (alive) keep(parseFileText(raw)) },
      () => { if (alive) keep(null) }, // not there at that checkpoint: the next file of the piece is tried
    )
    return () => { alive = false }
    // the key names the read exactly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, client, binding, wantKey])
  const file = useMemo(() => (live ? currentFile(live, texts, recent) : null), [live, texts, recent])

  const start = useCallback((sentence: string) => {
    const s = sentence.trim()
    if (!s || starting || !client?.createPlanStart) return
    setStarting(true)
    setStartError(null)
    void client.createPlanStart(s).then(
      (raw) => {
        const v = parsePlanView(raw, minds.current)
        binding.commit(() => {
          setStarting(false)
          if (!v) return setStartError('The hive answered with something this page cannot read.')
          following = { epoch: binding.epoch, id: v.plan_id }
          status.current = v.status
          setView(v)
          setId(v.plan_id)
        })
      },
      (e: unknown) => binding.commit(() => { setStarting(false); setStartError(errText(e)) }),
    )
  }, [client, binding, starting])

  const act = useCallback((run: () => Promise<unknown>, set: (on: boolean) => void, planId: string) => {
    set(true)
    setAlert(null)
    void run().then(
      (raw) => binding.commit(() => { set(false); if (!take(raw, planId)) setNudge((n) => n + 1) }),
      (e: unknown) => binding.commit(() => { set(false); setAlert(errText(e)) }),
    )
  }, [binding, take])

  const answer = useCallback((q: string, text: string) => {
    const t = text.trim()
    if (!id || !t || answering || !client?.createPlanAnswer) return
    act(() => client.createPlanAnswer!(id, q, t), (on) => setAnswering(on ? q : null), id)
  }, [id, client, answering, act])
  const deploy = useCallback(() => {
    if (!id || deploying || !client?.createPlanDeploy) return
    act(() => client.createPlanDeploy!(id), setDeploying, id)
  }, [id, client, deploying, act])
  const stop = useCallback(() => {
    if (!id || stopping || !client?.createPlanStop) return
    act(() => client.createPlanStop!(id), setStopping, id)
  }, [id, client, stopping, act])
  const fresh = useCallback(() => {
    following = null
    status.current = null
    previewAsked.current = { key: null, nudge: 0 }
    setId(null)
    setView(null)
    setTexts({})
    setRecent({})
    setFrame(null)
    setPreviewNudge(0)
    setAlert(null)
    setStartError(null)
  }, [])

  return {
    can, following: !!id, view: id ? view : null, file: id ? file : null, frame: id ? frame : null,
    starting, startError, answering, deploying, stopping, alert, stale, start, answer, deploy, stop, fresh,
  }
}
