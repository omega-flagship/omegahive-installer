import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActionResult, WorkItem } from '../../api/types'
import { confirm as confirmGate, editGate, idempotencyKey, noteKeyDown, openGate, REFUSAL_TEXT, settle, staleAgainst, type Activation, type ConsentAction, type Envelope, type Gate, type Refusal, type SourceBinding } from './consent'
import { CONSEQUENTIAL, resolveMode } from './mode'
import { gapsOf, indexGraph, placeAll, TERRITORY, today, type TerritoryId } from './model'
import { conceal, isRevealed, remaining, resealOnLeave, reveal, sealed, tick, touch, anyRevealed, type RevealState } from './privacy'
import { BUDGETS, EXPIRIES, inspectedSource, parse, recordClosed, recordSent, serialise, withExpiry, type ScientistRequest } from './requests'
import { ATLAS_DESCRIBE, EMPTY_GRAPH, sampleGraph } from './sample'
import type { ActContext } from '../contract'
import type { LifeMapProps, Level, View } from './types'

/* ================================================================ reveal: sealed by default, re-seals on idle */

export function useReveal() {
  const [s, setS] = useState<RevealState>(() => sealed())
  const [now, setNow] = useState(() => Date.now())
  const open = anyRevealed(s)
  useEffect(() => {
    if (!open) return
    const onAct = () => setS((x) => touch(x, Date.now()))
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      setS((x) => tick(x, t))
    }, 1000)
    window.addEventListener('pointerdown', onAct, true)
    window.addEventListener('keydown', onAct, true)
    window.addEventListener('wheel', onAct, { capture: true, passive: true })
    const unreseal = resealOnLeave(window, document, () => setS((x) => conceal(x)))
    return () => {
      unreseal()
      window.clearInterval(id)
      window.removeEventListener('pointerdown', onAct, true)
      window.removeEventListener('keydown', onAct, true)
      window.removeEventListener('wheel', onAct, true)
    }
  }, [open])
  return {
    state: s,
    open,
    shown: (id: string) => isRevealed(s, id),
    reveal: (id: string | '*') => {
      const t = Date.now()
      setNow(t)
      setS((x) => reveal(x, id, t))
    },
    conceal: (id?: string) => setS((x) => conceal(x, id)),
    seconds: remaining(s, now),
  }
}
export type Reveal = ReturnType<typeof useReveal>

/* ================================================================ the consent dialog's draft */

export interface Draft {
  action: ConsentAction
  items: string[]
  worker: string
  question: string
  budget: number
  expiryMs: number
  digest?: string
  reason: string
  viaKey: boolean
  /** The revision and snapshot closure on screen when the consent opened (Review C2); kept across draft edits. */
  source?: SourceBinding
}

export function envelopeOf(d: Draft): Envelope {
  const source = d.source ? { source: d.source } : {}
  if (d.action === 'investigate') return { action: d.action, items: d.items, params: { worker_id: d.worker.trim(), question: d.question.trim(), budget_seconds: d.budget, expiry_ms: d.expiryMs }, ...source }
  return { action: d.action, items: d.items, params: { request_digest: d.digest ?? '', reason: d.reason.trim() }, ...source }
}

/**
 * Kimi next22b/23b r2 #2: exactly the params a consent sends, derived from the open envelope and its opening (the
 * consent dialog shows these same values). One source for the dialog and the send, so the person confirms what the
 * host's token binds: nothing is transformed between the consent and the act. Access ends `expiryMs` after the
 * envelope was opened or last edited (the moment the person began reviewing what they confirm).
 */
export function consentParams(d: Draft, g: Pick<Gate, 'digest' | 'openedAt'>): Record<string, string | number | undefined> {
  const env = envelopeOf(d)
  if (d.action === 'investigate')
    return {
      worker_id: env.params.worker_id,
      question: env.params.question,
      budget_seconds: d.budget,
      expires_at: Math.floor((g.openedAt + d.expiryMs) / 1000),
      idempotency_key: idempotencyKey(g),
    }
  return { request_digest: d.digest, reason: env.params.reason }
}

/** What must be filled before the envelope can be confirmed (the gate refuses otherwise too). */
export function draftMissing(d: Draft): string | null {
  if (d.action === 'investigate') {
    if (!d.worker.trim()) return 'Name the provisioned Scientist worker.'
    if (d.question.trim().length < 8) return 'Write the research question.'
    return null
  }
  return d.reason.trim().length < 3 ? 'Say why, in a few words.' : null
}

export interface Outcome {
  id: number
  tone: 'good' | 'warn' | 'bad' | 'info'
  text: string
}

/* ================================================================ sample-mode stand-in for act() */

let simN = 0
export function simulateAct(graph: { items: WorkItem[] }, action: string, items: string[], params?: Record<string, unknown>): ActionResult {
  const by = new Map(graph.items.map((i) => [i.id, i]))
  const note = 'SAMPLE: simulated. Nothing left this page.'
  switch (action) {
    case 'inspect-source':
      return { status: 'done', detail: { sources: items.flatMap((i) => by.get(i)?.sources ?? []) }, message: `${note} Local provenance references; no source was fetched.` }
    case 'compare':
      return { status: 'done', message: `${note} Support and opposition remain separate.` }
    case 'investigate': {
      simN++
      const digest = `sample-${(simN * 2654435761) >>> 0}`.slice(0, 18)
      return { status: 'started', task: { id: `sample-goal-${simN}`, kind: 'goal', status: 'open' }, detail: { request_digest: digest }, message: `${note} A real request would prepare a sealed snapshot for the Scientist.` }
    }
    case 'inspect-request':
      return { status: 'done', detail: { state: 'pending', request_digest: params?.request_digest }, message: `${note} Snapshot access is pending.` }
    case 'revoke-request':
      return { status: 'done', message: `${note} Snapshot access revoked.` }
    case 'cancel-request':
      return { status: 'done', message: `${note} Scientist task cancelled.` }
    default:
      return { status: 'refused', message: `${note} This adapter exposes read-only actions.` }
  }
}

/* ================================================================ the form's state */

export function useAtlas(props: LifeMapProps) {
  const { viewer, act, focus, program } = props
  const [sampleChosen, setSample] = useState(false)
  const { mode, reason } = resolveMode(props.graph, viewer, sampleChosen)
  const sample = useMemo(() => (mode === 'sample' ? sampleGraph() : null), [mode])
  const graph = mode === 'owner' ? props.graph : mode === 'sample' ? sample! : EMPTY_GRAPH
  const describe = mode === 'sample' ? ATLAS_DESCRIBE : (props.describe ?? ATLAS_DESCRIBE)
  const ix = useMemo(() => indexGraph(graph, describe), [graph, describe])
  const place = useMemo(() => placeAll(ix), [ix])
  const summary = useMemo(() => today(ix, place), [ix, place])
  const gaps = useMemo(() => gapsOf(ix, place), [ix, place])

  const [view, setView] = useState<View>('today')
  const [level, setLevel] = useState<Level>(0)
  const [territory, setTerritory] = useState<TerritoryId | null>(null)
  const [selectedPick, setSelected] = useState<string | null>(null)
  const selected = selectedPick && ix.byId.has(selectedPick) ? selectedPick : null
  const [asOf, setAsOf] = useState<string | null>(null)
  const [panel, setPanel] = useState<'ask' | 'ledger' | 'capture' | null>(null)
  const revealer = useReveal()

  /* ---- requests: persisted for the owner (digests and ids only), in memory for the sample */
  const storeKey = `atlas-form.requests.v1.${program?.id ?? 'atlas'}`
  const [ownerRequests, setOwnerRequests] = useState<ScientistRequest[]>(() => (typeof localStorage !== 'undefined' ? parse(localStorage.getItem(storeKey)) : []))
  const [sampleRequests, setSampleRequests] = useState<ScientistRequest[]>([])
  const requestsRaw = mode === 'sample' ? sampleRequests : ownerRequests
  const setRequests = mode === 'sample' ? setSampleRequests : setOwnerRequests
  useEffect(() => {
    if (mode === 'owner' && typeof localStorage !== 'undefined') localStorage.setItem(storeKey, serialise(ownerRequests))
  }, [mode, ownerRequests, storeKey])
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const requests = useMemo(() => withExpiry(requestsRaw, clock), [requestsRaw, clock])

  /* ---- outcomes (a quiet, polite live region) */
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const outN = useRef(0)
  const say = useCallback((tone: Outcome['tone'], text: string) => {
    const id = ++outN.current
    setOutcomes((o) => [{ id, tone, text }, ...o].slice(0, 3))
    window.setTimeout(() => setOutcomes((o) => o.filter((x) => x.id !== id)), 9000)
  }, [])

  const run = useCallback(
    async (action: string, items: string[], params?: Record<string, unknown>, ctx?: ActContext): Promise<ActionResult> => {
      if (mode === 'sample') return simulateAct(graph, action, items, params)
      if (mode !== 'owner') return { status: 'refused', message: 'Only the owner can act on this Atlas.' }
      try {
        return await (ctx ? act(action, items, params, ctx) : act(action, items, params))
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    },
    [mode, graph, act],
  )

  const select = useCallback(
    (id: string | null) => {
      setSelected(id)
      if (mode === 'owner') focus(id)
    },
    [mode, focus],
  )

  /* ---- the consent gate */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [gate, setGate] = useState<Gate | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  const openConsent = useCallback(
    (d: Omit<Draft, 'worker' | 'question' | 'budget' | 'expiryMs' | 'reason'> & Partial<Draft>) => {
      const item = ix.byId.get(d.items[0])
      const full: Draft = {
        worker: mode === 'sample' ? 'scientist-sample' : '',
        question: item ? `Does the recorded evidence bear on: “${item.label}”? What would test it best?` : '',
        budget: BUDGETS[1].seconds,
        expiryMs: EXPIRIES[1].ms,
        reason: '',
        ...d,
        source: inspectedSource(graph, d.action, d.items),
      }
      setDraft(full)
      setGate(openGate(envelopeOf(full), Date.now()))
      setRefusal(null)
    },
    [ix, mode, graph],
  )
  const editDraft = useCallback(
    (patch: Partial<Draft>) => {
      if (!draft) return
      const next = { ...draft, ...patch }
      setDraft(next)
      setGate((g) => (g ? editGate(g, envelopeOf(next), Date.now()) : g))
      setRefusal(null)
    },
    [draft],
  )
  /** A fresh, non-repeat confirming key that began inside the open dialog arms keyboard confirm. */
  const armKey = useCallback((e: { key: string; repeat: boolean }) => setGate((g) => (g ? noteKeyDown(g, e, Date.now()) : g)), [])
  const closeConsent = useCallback(() => {
    setDraft(null)
    setGate(null)
    setRefusal(null)
  }, [])

  /**
   * Review C2: the consent is stale once the record it was given on changes (revision or snapshot closure). Derived on
   * every render: a stale consent says so in place and can never send; only opening the request again (a fresh review
   * of what the record now holds) gives a new consent. Draft edits keep the original source, so they cannot revive it.
   */
  const currentSource = useMemo(() => (draft ? inspectedSource(graph, draft.action, draft.items) : undefined), [graph, draft])
  const stale = !!gate && gate.phase === 'open' && staleAgainst(gate, currentSource)

  const submitConsent = useCallback(
    async (a: Activation) => {
      if (!gate || !draft) return
      // checked at the moment of confirming too, whatever has or has not rendered yet
      if (staleAgainst(gate, inspectedSource(graph, draft.action, draft.items))) {
        setRefusal('stale')
        say('warn', REFUSAL_TEXT.stale)
        return
      }
      const missing = draftMissing(draft)
      if (missing) {
        setRefusal(null)
        say('warn', missing)
        return
      }
      const r = confirmGate(gate, a, Date.now())
      if (!r.ok) {
        setRefusal(r.reason)
        return
      }
      setGate(r.gate)
      const env = envelopeOf(draft)
      // the host is given the revision that was inspected, never the session's newest
      // §9d: this consent envelope is the person's full-context confirm, so the host mints at once (no second dialog);
      // it sends exactly the params the dialog showed (consentParams), never values made after the confirm
      const ctx: ActContext = { ...(env.source ? { baseRevision: env.source.revision } : {}), confirmed: true }
      const params = consentParams(draft, r.gate)
      let result: ActionResult
      if (draft.action === 'investigate') {
        const expiresAt = r.gate.openedAt + draft.expiryMs
        result = await run('investigate', draft.items, params, ctx)
        setRequests((l) => recordSent(l, { items: draft.items, worker: String(env.params.worker_id), expiresAt, budgetSeconds: draft.budget, simulated: mode === 'sample' }, result, Date.now()))
      } else {
        result = await run(draft.action, draft.items, params, ctx)
        setRequests((l) => recordClosed(l, draft.digest ?? '', draft.action as 'revoke-request' | 'cancel-request', result))
      }
      const ok = result.status === 'done' || result.status === 'started'
      setGate((g) => (g ? settle(g, ok) : g))
      say(ok ? 'good' : result.status === 'refused' ? 'warn' : 'bad', result.message ?? (ok ? 'Done.' : `Not done (${result.status}).`))
      if (ok) window.setTimeout(closeConsent, 900)
    },
    [gate, draft, graph, run, setRequests, mode, say, closeConsent],
  )

  /** Plain actions (inspect-source, compare, inspect-request) run at once; consequential ones need the gate. */
  const request = useCallback(
    async (action: string, items: string[], params?: Record<string, unknown>, viaKey = false) => {
      if (CONSEQUENTIAL.has(action)) {
        if (action === 'investigate') openConsent({ action: 'investigate', items, viaKey })
        else openConsent({ action: action as ConsentAction, items, digest: String(params?.request_digest ?? ''), viaKey })
        return null
      }
      const result = await run(action, items, params)
      say(result.status === 'done' ? 'info' : 'warn', result.message ?? result.status)
      return result
    },
    [openConsent, run, say],
  )

  const enterSample = useCallback(() => {
    setSample(true)
    setSelected(null)
    setView('today')
    setLevel(0)
    setTerritory(null)
    setAsOf(null)
    revealer.conceal()
  }, [revealer])
  const leaveSample = useCallback(() => {
    setSample(false)
    setSelected(null)
    setView('today')
    setTerritory(null)
    setAsOf(null)
    revealer.conceal()
    closeConsent()
  }, [revealer, closeConsent])

  const focusTerritory = useCallback((t: TerritoryId | null) => {
    setTerritory(t)
    if (t) setLevel((l) => (l === 0 ? 1 : l))
  }, [])

  return {
    mode,
    reason,
    canLeaveSample: resolveMode(props.graph, viewer, false).mode === 'owner',
    graph,
    describe,
    ix,
    place,
    summary,
    gaps,
    view,
    setView,
    level,
    setLevel,
    territory,
    focusTerritory,
    territoryName: territory ? TERRITORY[territory].label : null,
    selected,
    select,
    asOf,
    setAsOf,
    panel,
    setPanel,
    revealer,
    requests,
    now: clock,
    request,
    run,
    draft,
    gate,
    /** The open consent no longer matches the record it was given on (Review C2). */
    stale,
    refusal: stale ? ('stale' as const) : refusal,
    editDraft,
    armKey,
    setRefusal,
    closeConsent,
    submitConsent,
    outcomes,
    say,
    enterSample,
    leaveSample,
    busy: !!props.busy,
  }
}

export type Atlas = ReturnType<typeof useAtlas>
