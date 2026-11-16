import { useEffect, useRef, useState } from 'react'
import type { WorkGraph, WorkSource } from '../../api/types'
import type { DecisionResult } from '../../lib/decisionGate'
import { actErrorResult } from '../actResult'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { UnsupportedError, useResource } from '../../lib/useResource'
import { useEscape } from '../../lib/hooks'
import { useHive } from '../../store/store'
import type { FormActResult, FormProps } from '../contract'
import { askBound, askDecision, GOAL_MAY_BE_POSTED, GOAL_READ_AGAIN, outcomeWords, seenOf, type Ask, type AskAction } from './gate'
import { surfaceOf, type CommonsNav } from './ask'
import { buildSky, compareSides, matches, unfold, type Filter, type Side, type Unfolded } from './model'

export interface Outcome {
  at: number
  tone: 'good' | 'bad' | 'info'
  text: string
  goal?: string
  /** Point to the swarm's goals (a goal may have been posted, but which is not known). */
  goals?: boolean
}

export interface Comparison {
  ids: string[]
  title: string
  sides: Side[]
  notes: string[]
}

let seq = 0

/**
 * One commons' state, shared by every rendering: the sky, which belief is unfolded (and its own view, read under
 * this identity), what is being compared or opened, and the decision being asked.
 *
 * Identity (Surface K1/L1): every read and every result here is bound to the client, this program, this swarm and,
 * for a belief, which belief. A different client or swarm never sees the previous one's answer.
 *
 * No manual memoization: the sky is at most 120 beliefs (the program's MAX_BELIEFS) and recomputing it is cheaper than
 * keeping it right; nothing below depends on a stable identity.
 */
export function useCommons(props: FormProps) {
  const { graph, describe, act, focus: tellHost, program, view } = props
  const scope = props.scope ?? null
  const client = useHive((s) => s.client)
  const swarmName = useHive((s) => (scope ? s.swarms[scope]?.name : undefined))
  const who = readContext(client, program.id, scope)

  const sky = buildSky(graph, describe)
  const declared = (id: string) => describe?.actions.find((a) => a.id === id) ?? null

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const visible = new Set(sky.stars.filter((s) => matches(s, filter, query)).map((s) => s.id))

  // ---------------------------------------------------------------- the unfolded belief: the program's own view
  const [openPick, setOpen] = useState<Tagged<string> | null>(null)
  const openId = taggedFor(openPick, who)
  const [tick, setTick] = useState(0)
  const detail = useResource<WorkGraph | null>(
    async () => {
      if (!openId) return null
      if (!view) throw new UnsupportedError('Unfolding a belief')
      return view(openId, 'unfold')
    },
    { context: [program.id, scope, openId], key: `${graph.revision}#${tick}` },
  )
  const fromView: Unfolded | null = openId && detail.data ? unfold(detail.data, openId, describe) : null
  // a host without view(): the belief as the overview shows it (no reports or rivals), labelled as such
  const overviewStar = openId && detail.status === 'unsupported' ? (sky.stars.find((s) => s.id === openId) ?? null) : null
  const fromOverview: Unfolded | null = overviewStar
    ? { revision: sky.revision, star: overviewStar, reports: [], origins: 0, forCount: 0, againstCount: 0, rivals: [], gaps: overviewStar.gaps, notes: [] }
    : null
  const unfolded = fromView ?? fromOverview
  const reload = () => setTick((t) => t + 1)

  const opener = useRef<HTMLElement | null>(null)
  const openBelief = (id: string, from?: HTMLElement | null) => {
    if (from) opener.current = from
    setOpen({ ctx: who, value: id })
    tellHost(id)
  }
  const closeBelief = () => {
    setOpen(null)
    tellHost(null)
    const el = opener.current
    opener.current = null
    // focus goes back to what opened it (the star, card or link), once the panel has gone
    if (el) requestAnimationFrame(() => el.isConnected && el.focus())
  }

  // ---------------------------------------------------------------- results, each tagged with the identity it was read under
  const [outcomesRaw, setOutcomes] = useState<Tagged<Outcome[]> | null>(null)
  const outcomes = taggedFor(outcomesRaw, who) ?? []
  const say = (o: Omit<Outcome, 'at'>) => {
    const at = ++seq
    setOutcomes((prev) => ({ ctx: who, value: [{ ...o, at }, ...(taggedFor(prev, who) ?? [])].slice(0, 4) }))
  }
  const dismiss = (at: number) => setOutcomes((prev) => prev && { ...prev, value: prev.value.filter((o) => o.at !== at) })

  const [sourcesRaw, setSources] = useState<Tagged<Record<string, WorkSource>> | null>(null)
  const sources = taggedFor(sourcesRaw, who) ?? {}
  const [comparedRaw, setCompared] = useState<Tagged<Comparison> | null>(null)
  const compared = taggedFor(comparedRaw, who)
  const [running, setRunning] = useState<string | null>(null)

  // `confirmed`: the person confirmed this in the form's own DecisionDialog (§9d), so the host mints at once
  const run = async (action: string, items: string[], baseRevision: string, confirmed = false): Promise<FormActResult> => {
    setRunning(`${action}:${items.join(',')}`)
    try {
      return await runAct(act, action, items, baseRevision, confirmed)
    } finally {
      setRunning(null)
    }
  }

  /** Open source (a read): the report's record, shown under it. */
  const inspect = async (reportId: string) => {
    if (!unfolded) return
    const ctx = who
    const r = await run('inspect-source', [reportId], unfolded.revision)
    const src = r.detail?.sources?.[0]
    if (r.status === 'done' && src) setSources((prev) => ({ ctx, value: { ...(taggedFor(prev, ctx) ?? {}), [reportId]: src } }))
    else {
      say(outcomeWords(r.status, r.message))
      if (r.status === 'stale') reload()
    }
  }

  /** Compare (a read): the belief and another side by side, as the program lays them out. */
  const compare = async (ids: string[]) => {
    if (!unfolded) return
    const ctx = who
    const r = await run('compare', ids, unfolded.revision)
    if (r.status === 'done' && r.graph) setCompared({ ctx, value: { ids, title: r.graph.title ?? 'Compared', sides: compareSides(r.graph, ids, describe), notes: r.graph.notes ?? [] } })
    else {
      say(outcomeWords(r.status, r.message))
      if (r.status === 'stale') reload()
    }
  }
  const clearCompare = () => setCompared(null)

  // ---------------------------------------------------------------- the decision (challenge, investigate-gap)
  const [askRaw, setAsk] = useState<Tagged<Ask> | null>(null)
  const ask = taggedFor(askRaw, who)
  const requestAsk = (action: AskAction, target: string) => {
    const seen = seenOf(unfolded, action, target)
    if (!seen || !unfolded) return
    const gap = unfolded.gaps.find((g) => g.id === target)
    setAsk({ ctx: who, value: { action, target, belief: unfolded.star.id, seen, sources: unfolded.star.sources.map((x) => x.label), gap: gap ? { label: gap.label, reason: gap.reason } : undefined, seq: ++seq } })
  }
  const closeAsk = () => setAsk(null)
  // while a decision is open, read the belief again every few seconds so drift is seen before anything is decided
  const asking = ask?.seq ?? null
  useEffect(() => {
    if (asking === null) return
    const id = window.setInterval(() => setTick((t) => t + 1), 3000)
    return () => window.clearInterval(id)
  }, [asking])
  const bound = ask ? askBound(ask, unfolded && unfolded.star.id === ask.belief ? unfolded : null) : null

  /** The confirmed decision: sent with the inspected revision, never a newer one (Review C2). */
  const decide = (): Promise<DecisionResult> => decideAsk(ask, { act: (...a) => run(...a), reload, say })

  // Navigation as state (for the host's Ask layer): what is on screen, and a way to set it without clicks
  const nav: CommonsNav = { focus: openId, filter, query }
  const setNav = (next: Partial<CommonsNav>) => {
    if (next.filter !== undefined) setFilter(next.filter)
    if (next.query !== undefined) setQuery(next.query)
    if (next.focus !== undefined) {
      if (next.focus && sky.stars.some((s) => s.id === next.focus)) openBelief(next.focus)
      else if (!next.focus && openId) closeBelief()
    }
  }
  const surface = surfaceOf(program.id, sky, nav, unfolded, describe)

  // Escape folds the unfolded belief first (an open dialog takes Escape before this)
  useEscape(closeBelief, !!openId && !ask)

  return {
    program,
    describe,
    swarmName: swarmName ?? null,
    scope,
    sky,
    filter,
    setFilter,
    query,
    setQuery,
    visible,
    openId,
    openBelief,
    closeBelief,
    detail: { status: detail.status, refreshing: detail.refreshing, error: detail.error },
    unfolded,
    partial: !!fromOverview,
    reload,
    declared,
    inspect,
    sources,
    compare,
    compared: compared && openId && compared.ids.includes(openId) ? compared : null,
    clearCompare,
    ask,
    bound,
    requestAsk,
    closeAsk,
    decide,
    running: running ?? (props.busy ? 'busy' : null),
    outcomes,
    dismiss,
    nav,
    setNav,
    surface,
  }
}

export type CommonsState = ReturnType<typeof useCommons>

/** One act, never thrown: a thrown act is read by forms/actResult (`unknown` when it may have been delivered). */
export async function runAct(act: FormProps['act'], action: string, items: string[], baseRevision: string, confirmed = false): Promise<FormActResult> {
  try {
    return await act(action, items, {}, confirmed ? { baseRevision, confirmed: true } : { baseRevision })
  } catch (e) {
    return actErrorResult(e)
  }
}

export interface DecideDeps {
  /** The act with the running state around it (useCommons.run); runAct semantics. */
  act: (action: string, items: string[], baseRevision: string, confirmed: boolean) => Promise<FormActResult>
  /** Read the unfolded belief again. */
  reload: () => void
  say: (o: Omit<Outcome, 'at'>) => void
}

/**
 * The confirmed challenge or investigate-gap, sent with the inspected revision (Review C2), and what the dialog shows
 * for it (Review B1, f0818d8: gate.askDecision). Posted: an outcome with the goal. A known no: its words ("Nothing
 * changed" is true then). Not known whether it posted: the belief is read again, an outcome points to the swarm's goals,
 * and the dialog says the goal may have been posted, with "Check again" (another read) and no plain retry.
 */
export async function decideAsk(ask: Ask | null, deps: DecideDeps): Promise<DecisionResult> {
  if (!ask) return 'Nothing to decide.'
  const r = await deps.act(ask.action, [ask.target], ask.seen['commons revision'], true)
  if (r.status === 'started' || r.status === 'done') deps.say({ ...outcomeWords(r.status, r.message), goal: r.task?.kind === 'goal' ? r.task.id : undefined })
  else if (r.unknown) deps.say({ tone: 'info', text: r.message ? `${GOAL_MAY_BE_POSTED} (${r.message})` : GOAL_MAY_BE_POSTED, goals: true })
  if (r.status === 'stale' || r.unknown) deps.reload()
  return askDecision(r, async () => {
    deps.reload()
    return { unsettled: GOAL_READ_AGAIN }
  })
}
