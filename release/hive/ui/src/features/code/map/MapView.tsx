/**
 * #/code/map/<repo>@<sha>: Workbench Map, a "Map" mode of the Code page on one living canvas (Jon's rule: controls
 * revealed in context, no stacked panels). Reads only through api/repoMap (the Slice A routes); draws only what the
 * answers contain. Fail closed: a map the person cannot see (404 / 401 / 403), a newer format or an extractor outside
 * the pin draws nothing. The whole view is keyed by the person's identity, so nothing read for one person survives a
 * sign-in change.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EXPIRED_NOTE, failureWords, firstPage, nextPage, readAll, repoMapApi, type DriftItem, type MapFailure, type MapHeader, type MapNode, type NodeDetail, type PagedList, type Preset, type QueryResult, type Read, type Ref, type RepoMapApi, type Revision } from '../../../api/repoMap'
import { readContext } from '../../../lib/readContext'
import { navigate } from '../../../lib/router'
import { useHive } from '../../../store/store'
import { Page } from '../../../ui/Page'
import { Button, Skeleton } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { useAskFillable } from '../../ask/fields'
import { useAskView } from '../../ask/view'
import { useAskRoom } from '../canvas/askBridge'
import { useWidth } from '../../lab/useWidth'
import { planBody, planFromWords, type Plan, type Resolve } from './ask'
import { COPY, OVERVIEW_MAX_PAGES, SPACE_POLL_MAX, SPACE_WAITING, spacePollDelay, ambiguousAt, parentOf, pathOf, scopeUp, anchorRef, driftView, operationWords, overviewKinds, revisionState, short, type Anchor } from './model'
import { DriftCard, FailureCard, ItemList, MapGraph, NodeCard, Overview, Panel, PresetComposer, ProvenanceFooter, QueryCard, SourceCard, StateBand, type Focus } from './parts'

export default function MapView({ repo, sha }: { repo: string; sha: string }) {
  const client = useHive((s) => s.client)
  const ctx = readContext(client)
  const api = useMemo(() => repoMapApi(client), [client])
  return <MapRoot key={ctx} api={api} repo={repo} sha={sha} />
}

/** Failures that close the whole map: nothing of it stays on screen. */
const closesMap = (f: MapFailure) => f.kind === 'denied' || f.kind === 'not_found' || f.kind === 'not_served' || f.kind === 'newer_format' || f.kind === 'extractor_unpinned'

type Loaded<T> = { value: T } | { failure: MapFailure } | null
const loaded = <T,>(r: Read<T>): Loaded<T> => (r.ok ? { value: r.value } : { failure: r.failure })

interface Detail {
  id: string
  /** repo@sha the detail was read for */
  target: string
  read: Loaded<NodeDetail>
  edges: PagedList<NodeDetail['edges'][number]>
  neighbours: MapNode[]
}
interface Query {
  /** repo@sha the query ran against */
  target: string
  preset: string
  params: Record<string, string | number | boolean>
  result: QueryResult
  list: PagedList<MapNode>
  edges: QueryResult['edges']
}
interface Source {
  ref: Ref
  repo: string
  sha: string
  nodeId: string | null
}

export function MapRoot({ api, repo, sha }: { api: RepoMapApi; repo: string; sha: string }) {
  const [revs, setRevs] = useState<Loaded<Revision[]>>(null)
  // a closure belongs to the target it closed (r1.1, stand-in P2-1): opening another repo or revision reads it afresh
  const [closedFor, setClosed] = useState<{ target: string; f: MapFailure } | null>(null)

  useEffect(() => {
    let live = true
    void api.list().then((r) => live && setRevs(loaded(r)))
    return () => {
      live = false
    }
  }, [api])

  const pinnedRevs = revs && 'value' in revs ? revs.value.filter((r): r is Extract<Revision, { pin: null }> => r.pin === null) : []
  const forRepo = pinnedRevs.filter((r) => r.repo === repo).sort((a, b) => (b.generated_at ?? '').localeCompare(a.generated_at ?? ''))
  const resolved = sha || forRepo[0]?.sha || ''
  const target = `${repo}@${resolved}`
  // clear a closure as soon as the target changes (React's adjust-state-while-rendering pattern), so returning to the
  // closed target later reads it again instead of showing an old refusal
  const [seenTarget, setSeenTarget] = useState(target)
  if (seenTarget !== target) {
    setSeenTarget(target)
    setClosed(null)
  }
  const close = useCallback((f: MapFailure) => setClosed({ target, f }), [target])
  const closed = closedFor && closedFor.target === target ? closedFor.f : null

  if (!repo) return <MapList revs={revs} />
  if (closed) return <MapFrame repo={repo} sha={resolved}><FailureCard f={closed} /></MapFrame>
  if (!sha && revs === null) return <MapFrame repo={repo} sha=""><Skeleton className="m-6 h-40" /></MapFrame>
  if (!resolved) return <MapFrame repo={repo} sha=""><FailureCard f={revs && 'failure' in revs ? revs.failure : { kind: 'not_found' }} /></MapFrame>
  return <RevisionMap api={api} repo={repo} sha={resolved} revisions={forRepo} onClose={close} />
}

function MapFrame({ repo, sha, children, actions }: { repo: string; sha: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Page title={COPY.title} eyebrow={`Code · ${repo}${sha ? `@${short(sha)}` : ''}`} label={COPY.title} onBack={() => navigate({ name: 'code', map: '' })} onClose={() => navigate({ name: 'code' })} actions={actions}>
      {children}
    </Page>
  )
}

/** #/code/map: the revisions this person can see. A revision outside the adapter pin is listed, never opened. */
function MapList({ revs }: { revs: Loaded<Revision[]> }) {
  return (
    <Page title={COPY.title} eyebrow="Code · repository revisions" label={COPY.title} onBack={() => navigate({ name: 'code' })} onClose={() => navigate({ name: 'code' })}>
      <div className="mx-auto max-w-3xl space-y-3 px-4 pt-2 pb-12 md:px-6">
        {revs === null ? (
          <Skeleton className="h-24" />
        ) : 'failure' in revs ? (
          <FailureCard f={revs.failure} />
        ) : revs.value.length === 0 ? (
          <p className="text-[13px] text-ink-3">No repository maps are visible to you here.</p>
        ) : (
          <ul className="space-y-2">
            {revs.value.map((r) => (
              <li key={`${r.repo}@${r.sha}`} className="rounded-xl border border-line px-3 py-2.5">
                {r.pin ? (
                  <div className="text-[13px] text-ink-2">
                    <span className="font-mono">{r.repo}@{short(r.sha)}</span> · <span className="text-ink-3">This map uses a newer format ({r.schema || 'unknown schema'}).</span>
                  </div>
                ) : (
                  <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => navigate({ name: 'code', map: `${r.repo}@${r.sha}` })}>
                    <span className="font-mono text-[13px] text-ink">{r.repo}@{short(r.sha)}</span>
                    <span className="text-[12px] text-ink-2">state: {r.state}</span>
                    {r.reason && <span className="text-[12px] text-ink-3">reason: {r.reason}</span>}
                    <span className="ml-auto text-[11.5px] text-ink-4">{r.generated_at ?? ''}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  )
}

export function RevisionMap({ api, repo, sha, revisions, onClose }: { api: RepoMapApi; repo: string; sha: string; revisions: Extract<Revision, { pin: null }>[]; onClose: (f: MapFailure) => void }) {
  // repo + revision: every answer is stored with the target it was read for, and shown only for that target
  const target = `${repo}@${sha}`
  const [headerRead, setHeader] = useState<{ target: string; read: Loaded<MapHeader> } | null>(null)
  // an answer for another repo or revision is never shown as this one's
  const header: Loaded<MapHeader> = headerRead && headerRead.target === target ? headerRead.read : null
  const [nodes, setNodes] = useState<{ target: string; list: PagedList<MapNode> } | { target: string; failure: MapFailure } | null>(null)
  const [presets, setPresets] = useState<Preset[] | null>(null)
  const [scope, setScope] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  const [reanchored, setAnchor] = useState<{ source: Source; target: string; anchor: Anchor } | null>(null)
  const [driftFrom, setDriftFrom] = useState<string | null>(null)
  const [drift, setDrift] = useState<{ key: string; read: Loaded<import('../../../api/repoMap').DriftResult>; note: string | null } | null>(null)
  const [query, setQuery] = useState<Query | null>(null)
  // revision-bound notes (Kimi K1/K3): each belongs to the target it was made for
  const [queryFailFor, setQueryFailFor] = useState<{ target: string; f: MapFailure } | null>(null)
  const [words, setWords] = useState('')
  // a plan is bound to the target it was made for (its node_id was resolved there; stand-in P2-2)
  const [planFor, setPlan] = useState<{ target: string; plan: Plan } | null>(null)
  const [whyFor, setWhyFor] = useState<{ target: string; text: string } | null>(null)
  const [runWhy, setRunWhy] = useState<string | null>(null)
  // busy belongs to the visit that set it (stand-in r1.1 P2): a late answer for another visit never changes it
  const [busyAt, setBusyAt] = useState<number | null>(null)
  // a plan dropped by a change of repo or revision is said, never dropped silently (Kimi r1.1 #9)
  const [planCleared, setPlanCleared] = useState<{ target: string; was: Plan } | null>(null)
  const [composer, setComposer] = useState(false)
  const [asList, setAsList] = useState(false)
  const [ref, width] = useWidth<HTMLDivElement>()
  // the first paint on a phone is already narrow (Kimi K7): before the canvas is measured, ask the media query
  const narrow = width > 0 ? width < 760 : typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 759px)').matches
  const { room, present } = useAskRoom()
  // the visit on screen now (stand-in P2-4): every change of repo or revision starts a new generation, so A→B→A is a
  // third visit, not the first one again. A continuation started under another generation is dropped: it never sets
  // state and never closes or errors the map.
  // The visit is state (so busy can be tied to it) and mirrored in a ref (so async continuations read it now). On a change
  // of target the visit-bound notes are cleared, not just hidden (stand-in r1.1 P3): returning to A never revives them.
  const [visit, setVisit] = useState<{ target: string; n: number }>({ target, n: 0 })
  if (visit.target !== target) {
    setVisit({ target, n: visit.n + 1 })
    setWhyFor(null)
    setQueryFailFor(null)
    setRunWhy(null)
    if (planFor && planFor.target !== target) setPlanCleared({ target, was: planFor.plan })
  }
  const generation = useRef(visit.n)
  useEffect(() => {
    generation.current = visit.n
  }, [visit.n])
  const current = (at: number) => generation.current === at
  const busy = busyAt !== null && busyAt === visit.n

  // header first: it carries the pin; nothing else is read for a map outside it
  useEffect(() => {
    let live = true
    void api.header(repo, sha).then((r) => {
      if (!live) return
      if (!r.ok && closesMap(r.failure)) return onClose(r.failure)
      setHeader({ target, read: loaded(r) })
    })
    return () => {
      live = false
    }
  }, [api, repo, sha, target, onClose])

  // the REVISION's state (revision_state, or the header's state before host r1.1) on every view of this revision
  // ...and never complete while its repo space is not mounted (host r1.2: the header's `space`)
  // Completeness comes from the revision's state only (Platform ruling 1 on r1.1): every map read answers from the host's
  // database rows, not the native space, so the space's mount is its own line and never marks the picture partial.
  const v = header && 'value' in header ? revisionState(header.value) : null

  // the repo space mount: while it is queued, mounting or unmounted (the header read starts an unmounted revision's
  // mount), the header is read again on a back-off (spacePollDelay), at most SPACE_POLL_MAX times per target, then the person
  // can check again. Never an endless poll.
  const [polls, setPolls] = useState<{ target: string; n: number }>({ target, n: 0 })
  const pollN = polls.target === target ? polls.n : 0
  const spaceWaiting = !!(header && 'value' in header && header.value.space && SPACE_WAITING.includes(header.value.space.status))
  const pollStopped = spaceWaiting && pollN >= SPACE_POLL_MAX
  useEffect(() => {
    if (!spaceWaiting || pollN >= SPACE_POLL_MAX) return
    let live = true
    const at = generation.current
    const t = setTimeout(() => {
      void api.header(repo, sha).then((r) => {
        // dropped when its effect was cleaned up, and when the visit moved on meanwhile (Kimi r1.1 #6)
        if (!live || !current(at)) return
        // counted when the answer is in (counting first would re-arm this effect and drop the answer)
        setPolls({ target, n: pollN + 1 })
        if (!r.ok) return closesMap(r.failure) ? onClose(r.failure) : undefined
        setHeader({ target, read: loaded(r) })
      })
    }, spacePollDelay(pollN))
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [api, repo, sha, target, spaceWaiting, pollN, onClose])

  // nodes only for a drawable map (partial, stale, ready); never for unavailable / failed / an unknown state word.
  // The overview reads the file-level kinds in full (bounded) for the top-level modules; a module's definitions are
  // read when the person opens it (path_prefix), so a 10k-node map draws from a few hundred marks at a time.
  const kindsKey = header && 'value' in header ? overviewKinds(header.value).join(',') : ''
  useEffect(() => {
    if (!v?.drawable) return
    let live = true
    const kinds = kindsKey ? kindsKey.split(',') : ['']
    void (async () => {
      const items: MapNode[] = []
      let truncated = false
      let note: string | null = null
      for (const kind of kinds) {
        const r = await readAll<MapNode>(async (cursor) => {
          const p = await api.nodes(repo, sha, { kind: kind || undefined, limit: 200, cursor })
          return p.ok ? { ok: true, value: { items: p.value.nodes, truncated: p.value.truncated, next_cursor: p.value.next_cursor } } : p
        }, OVERVIEW_MAX_PAGES)
        if (!live) return
        if (!r.ok) {
          if (closesMap(r.failure)) return onClose(r.failure)
          return setNodes({ target, failure: r.failure })
        }
        items.push(...r.value.items)
        truncated ||= r.value.truncated
        note ??= r.value.note
      }
      setNodes({ target, list: { items, truncated, next: null, note } })
    })()
    return () => {
      live = false
    }
  }, [api, repo, sha, target, v?.drawable, kindsKey, onClose])

  useEffect(() => {
    let live = true
    void api.presets(repo).then((r) => {
      if (!live) return
      if (!r.ok && (r.failure.kind === 'denied')) return onClose(r.failure)
      setPresets(r.ok ? r.value : [])
    })
    return () => {
      live = false
    }
  }, [api, repo, onClose])

  // the selected node's detail (a 404 here is that node missing at this revision: shown as unavailable, nothing else)
  useEffect(() => {
    if (!selected) return
    let live = true
    void api.node(repo, sha, selected).then((r) => {
      if (!live) return
      if (!r.ok && r.failure.kind === 'denied') return onClose(r.failure)
      setDetail({ id: selected, target, read: loaded(r), edges: r.ok ? firstPage({ items: r.value.edges, truncated: r.value.truncated, next_cursor: r.value.next_cursor }) : firstPage({ items: [], truncated: false, next_cursor: null }), neighbours: r.ok ? r.value.neighbours : [] })
    })
    return () => {
      live = false
    }
  }, [api, repo, sha, target, selected, onClose])

  // a source opened at another revision is re-anchored by its excerpt among this revision's refs for the same node
  const needsReanchor = !!source && source.repo === repo && source.sha !== sha && !!source.nodeId
  useEffect(() => {
    if (!source || !needsReanchor || !source.nodeId) return
    let live = true
    void api.node(repo, sha, source.nodeId).then((r) => {
      if (!live) return
      const refsHere = r.ok ? [...r.value.node.refs, ...r.value.edges.flatMap((e) => e.refs)] : []
      setAnchor({ source, target, anchor: anchorRef(source.ref, source.sha, sha, refsHere) })
    })
    return () => {
      live = false
    }
  }, [api, repo, sha, target, source, needsReanchor])
  const anchor: Anchor | null = !source || source.repo !== repo ? null : !needsReanchor ? anchorRef(source.ref, source.sha, sha, []) : reanchored && reanchored.source === source && reanchored.target === target ? reanchored.anchor : null

  // drift between the chosen earlier revision and this one
  const driftKey = driftFrom ? `${repo}:${driftFrom}..${sha}` : null
  useEffect(() => {
    if (!driftFrom) return
    let live = true
    void api.drift(repo, driftFrom, sha).then((r) => {
      if (!live) return
      if (!r.ok && r.failure.kind === 'denied') return onClose(r.failure)
      setDrift({ key: `${repo}:${driftFrom}..${sha}`, read: loaded(r), note: null })
    })
    return () => {
      live = false
    }
  }, [api, repo, sha, driftFrom, onClose])

  const list = nodes && nodes.target === target && 'list' in nodes ? nodes.list : null
  const amb = useMemo(() => ambiguousAt(list?.items ?? []), [list])
  const det = detail && detail.id === selected && detail.target === target ? detail : null
  const focus: Focus | null = det && det.read && 'value' in det.read ? { node: det.read.value.node, edges: det.edges.items, neighbours: det.neighbours } : null
  const curDrift = drift && drift.key === driftKey ? drift : null

  // drift paging (Kimi K2): the next page of records joins each list; a 410 reads it again from the start, once
  const moreDrift = async () => {
    if (!curDrift || !curDrift.read || !('value' in curDrift.read) || !curDrift.read.value.next_cursor || !driftFrom) return
    const d = curDrift.read.value
    const key = curDrift.key
    const at = generation.current
    setBusyAt(at)
    let r = await api.drift(repo, driftFrom, sha, { cursor: d.next_cursor })
    let note: string | null = null
    let restart = false
    if (!r.ok && r.failure.kind === 'cursor_expired') {
      r = await api.drift(repo, driftFrom, sha)
      note = EXPIRED_NOTE
      restart = true
    }
    if (!current(at)) return
    setBusyAt(null)
    if (!r.ok) return r.failure.kind === 'denied' ? onClose(r.failure) : setDrift({ key, read: { failure: r.failure }, note: null })
    const n = r.value
    const merged = restart ? n : { ...n, added: [...d.added, ...n.added], removed: [...d.removed, ...n.removed], changed: [...d.changed, ...n.changed], moved: [...d.moved, ...n.moved] }
    setDrift({ key, read: { value: merged }, note })
  }
  const moreEdges = async () => {
    if (!det) return
    const at = generation.current
    setBusyAt(at)
    let neighbours: MapNode[] = []
    const r = await nextPage(det.edges, async (cursor) => {
      const p = await api.node(repo, sha, det.id, { cursor })
      if (p.ok) neighbours = p.value.neighbours
      return p.ok ? { ok: true, value: { items: p.value.edges, truncated: p.value.truncated, next_cursor: p.value.next_cursor } } : p
    })
    if (!current(at)) return
    setBusyAt(null)
    if (!r.ok) return r.failure.kind === 'denied' ? onClose(r.failure) : setDetail({ ...det, read: { failure: r.failure } })
    const restarted = r.value.note !== null
    setDetail({ ...det, edges: r.value, neighbours: restarted ? neighbours : [...det.neighbours, ...neighbours] })
  }

  // ---- the Ask: words → a visible preset + parameters; the person edits; Run is theirs
  // a typed name → the exact node it names among what is on screen (unique label), never a guess between several
  const seen = useMemo(() => [...(list?.items ?? []), ...(det && det.read && 'value' in det.read ? [det.read.value.node, ...det.neighbours] : []), ...(query && query.target === target ? query.list.items : [])], [list, det, query, target])
  const resolve: Resolve = useCallback(
    (name: string) => {
      const ids = [...new Set(seen.filter((n) => n.label === name || n.id === name).map((n) => n.id))]
      return ids.length === 1 ? { id: ids[0] } : ids.length > 1 ? { many: ids.length } : null
    },
    [seen],
  )
  const onWords = useCallback(
    (w: string) => {
      setWords(w)
      setComposer(true)
      setRunWhy(null)
      if (!presets) return
      const p = planFromWords(w, presets, resolve)
      if (p.ok) {
        setPlan({ target, plan: p.plan })
        setWhyFor(null)
      } else setWhyFor({ target, text: p.why })
    },
    [presets, resolve, target],
  )
  // the plan on screen: the one made for this target, or (after a change of repo or revision) the person's words
  // planned again against what this revision shows. An old revision's node_id is never carried over.
  const plan: Plan | null = useMemo(() => {
    if (planFor && planFor.target === target) return planFor.plan
    if (!words.trim() || !presets) return null
    const p = planFromWords(words, presets, resolve)
    return p.ok ? p.plan : null
  }, [planFor, target, words, presets, resolve])
  const clearedNote = (() => {
    if (!planCleared || planCleared.target !== target || (planFor && planFor.target === target)) return null
    const was = planCleared.was
    const name = plan ? (plan.params.node_id ?? plan.params.path ?? '') : ''
    if (!plan) return `Plan cleared: it was made for another revision. Choose a preset again${was.params.node_id ? ` (it named ${was.params.node_id})` : ''}.`
    if (plan.note && /is a name, not a node id or path|nodes are named/.test(plan.note)) return `Plan cleared: “${name}” isn’t among this revision’s loaded nodes.`
    return 'Plan made again for this revision from your words.'
  })()
  const why = (whyFor && whyFor.target === target ? whyFor.text : null) ?? clearedNote
  const queryFail = queryFailFor && queryFailFor.target === target ? queryFailFor.f : null
  const setQueryFail = (f: MapFailure | null) => setQueryFailFor(f ? { target, f } : null)
  useAskFillable('code.map.question', 'Question about this repository revision', 'search', onWords)
  useAskView(
    'code.map',
    header && 'value' in header
      ? { title: COPY.askContext, summary: `${COPY.title} ${repo}@${short(sha)}; state ${header.value.state}${scope ? `; scope ${scope}` : ''}${selected ? `; selected ${selected}` : ''}`.slice(0, 400) }
      : null,
  )

  const run = async () => {
    // `plan` is only ever the one made (or re-made from the words) for this target: a stale node_id cannot be run
    if (!plan || !presets) return
    const b = planBody(plan, presets)
    if (!b.ok) return setRunWhy(b.why)
    setRunWhy(null)
    setQueryFail(null)
    if (b.preset === 'drift') {
      const from = String(b.params.from ?? '')
      // a full 40-character sha goes to the host as it is, listed or not: the host decides (404 → "Previous revision
      // unavailable"). A prefix must name exactly one listed revision (Kimi K6); never "the newest of several".
      if (/^[0-9a-f]{40}$/.test(from)) return setDriftFrom(from)
      const exact = revisions.find((r) => r.sha === from)
      const byPrefix = revisions.filter((r) => r.sha.startsWith(from))
      const match = exact ?? (byPrefix.length === 1 ? byPrefix[0] : null)
      if (!match) return setRunWhy(byPrefix.length > 1 ? `${byPrefix.length} revisions start with ${from}: choose the exact revision.` : `No revision of ${repo} starts with ${from}: choose the exact revision.`)
      setDriftFrom(match.sha)
      return
    }
    const at = generation.current
    setBusyAt(at)
    const r = await api.query(repo, sha, { preset: b.preset, params: b.params })
    if (!current(at)) return
    setBusyAt(null)
    if (!r.ok) return r.failure.kind === 'denied' || r.failure.kind === 'not_found' ? onClose(r.failure) : setQueryFail(r.failure)
    setQuery({ target, preset: b.preset, params: b.params, result: r.value, list: firstPage({ items: r.value.nodes, truncated: r.value.truncated, next_cursor: r.value.next_cursor }), edges: r.value.edges })
  }
  const moreQuery = async () => {
    if (!query) return
    const at = generation.current
    setBusyAt(at)
    let edges: QueryResult['edges'] = []
    const r = await nextPage(query.list, async (cursor) => {
      const p = await api.query(repo, sha, { preset: query.preset, params: query.params, cursor })
      if (p.ok) edges = p.value.edges
      return p.ok ? { ok: true, value: { items: p.value.nodes, truncated: p.value.truncated, next_cursor: p.value.next_cursor } } : p
    })
    if (!current(at)) return
    setBusyAt(null)
    if (!r.ok) return r.failure.kind === 'denied' ? onClose(r.failure) : setQueryFail(r.failure)
    setQuery({ ...query, list: r.value, edges: r.value.note ? edges : [...query.edges, ...edges] })
  }

  const select = (id: string | null) => {
    setSelected(id)
    if (id) {
      const n = seen.find((x) => x.id === id)
      const p = n ? pathOf(n) : null
      if (p) setScope(parentOf(p))
    }
  }
  const back = () => (source ? setSource(null) : selected ? setSelected(null) : scope ? setScope(scopeUp(scope)) : navigate({ name: 'code', map: '' }))
  // a drift record names nodes, not source: the 'to' side opens that node at this revision; a removed node is read
  // here too, and the detail says it is not at this revision (nothing else is opened in its place)
  const openDriftItem = (it: DriftItem, side: 'from' | 'to') => select(side === 'to' ? (it.to?.id ?? it.node?.id ?? it.id) : (it.node?.id ?? it.from?.id ?? it.id))

  const frame = (inner: React.ReactNode, actions?: React.ReactNode) => (
    <MapFrame repo={repo} sha={sha} actions={actions}>
      <div ref={ref} className="relative min-h-full" data-map-canvas data-presence-region="code-map" style={{ paddingBottom: Math.max(room, present ? (narrow ? 170 : 112) : 0) + 12 }}>
        {inner}
      </div>
    </MapFrame>
  )
  if (header === null) return frame(<Skeleton className="m-6 h-40" />)
  if ('failure' in header) return frame(<FailureCard f={header.failure} />)
  const h = header.value
  const view = v!
  const earlier = revisions.filter((r) => r.sha !== sha)

  const actions = (
    <div className="flex flex-wrap items-center gap-1.5">
      {revisions.length > 1 && (
        <label className="flex items-center gap-1 text-[12px] text-ink-3">
          <span className="sr-only md:not-sr-only">Revision</span>
          <select aria-label="Revision" value={sha} onChange={(e) => navigate({ name: 'code', map: `${repo}@${e.target.value}` })} className="min-h-9 rounded-lg border border-line bg-[var(--color-glass-2)] px-2 font-mono text-[12px] text-ink">
            {revisions.map((r) => (
              <option key={r.sha} value={r.sha}>
                {short(r.sha)} · {r.state}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex items-center gap-1 text-[12px] text-ink-3">
        <span className="sr-only md:not-sr-only">Changes since</span>
        <select aria-label="Changes since" value={driftFrom ?? ''} onChange={(e) => setDriftFrom(e.target.value || null)} className="min-h-9 rounded-lg border border-line bg-[var(--color-glass-2)] px-2 font-mono text-[12px] text-ink">
          <option value="">{earlier.length ? 'Changes since…' : COPY.previousUnavailable}</option>
          {earlier.map((r) => (
            <option key={r.sha} value={r.sha}>
              {short(r.sha)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  const crumbs = (
    <nav aria-label="Map scope" className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-ink-3">
      {(scope || selected) && (
        <button type="button" aria-label="Back" onClick={back} className="mr-1 grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:text-ink">
          <Icon name="back" size={14} />
        </button>
      )}
      <button type="button" className="hover:text-ink" onClick={() => (setSelected(null), setScope(null))}>
        Repository
      </button>
      {scope &&
        (scope.includes('/') && !scope.startsWith('(') ? scope.split('/').map((_seg, k, all) => all.slice(0, k + 1).join('/')) : [scope]).map((prefix) => (
          <span key={prefix} className="contents">
            <span>›</span>
            <button type="button" className="font-mono hover:text-ink" onClick={() => (setSelected(null), setScope(prefix))}>
              {prefix.slice(prefix.lastIndexOf('/') + 1)}
            </button>
          </span>
        ))}
      {focus && (
        <>
          <span>›</span>
          <span className="text-ink">{focus.node.label}</span>
        </>
      )}
    </nav>
  )

  const nodesFailure = nodes && nodes.target === target && 'failure' in nodes ? nodes.failure : null
  const picture = view.drawable ? (
    nodesFailure ? (
      <FailureCard f={nodesFailure} />
    ) : !list ? (
      <Skeleton className="m-6 h-64" />
    ) : list.items.length === 0 ? null : (
      <>
        {narrow || asList ? (
          <div className="p-3">
            <ItemList nodes={list.items} scope={scope} selectedId={selected} onScope={setScope} onSelect={select} />
          </div>
        ) : (
          <MapGraph nodes={list.items} scope={scope} focus={focus} selectedId={selected} onScope={setScope} onSelect={select} height={620} />
        )}
      </>
    )
  ) : null

  const ambiguousSel = !!selected && !!list?.items.some((n, i) => n.id === selected && amb.has(i))
  const side = (
    <>
      {curDrift &&
        (curDrift.read === null ? null : 'failure' in curDrift.read ? (
          <Panel label="Changes" title={COPY.previousUnavailable}>
            <p className="text-ink-3">{curDrift.read.failure.kind === 'not_found' ? `No comparison with ${short(driftFrom ?? '')} is available here.` : curDrift.read.failure.kind === 'unavailable' || curDrift.read.failure.kind === 'unreadable' ? curDrift.read.failure.message : COPY.previousUnavailable}</p>
          </Panel>
        ) : (
          <DriftCard view={driftView(curDrift.read.value)} from={curDrift.read.value.from} to={curDrift.read.value.to} note={curDrift.note} basisNote={curDrift.read.value.basis_note} opLine={operationWords('Comparison', curDrift.read.value, revisionState(h, curDrift.read.value))} onMore={curDrift.read.value.next_cursor ? () => void moreDrift() : undefined} moreBusy={busy} onOpen={openDriftItem} onClose={() => setDriftFrom(null)} />
        ))}
      {anchor && source && <SourceCard anchor={anchor} sha={anchor.state === 'unavailable' ? source.sha : sha} onClose={() => setSource(null)} />}
      {selected && det && (
        det.read && 'value' in det.read ? (
          <NodeCard node={det.read.value.node} ambiguous={ambiguousSel} kindNotes={h.coverage?.edge_basis_notes ?? null} edges={det.edges.items} neighbours={det.neighbours} truncated={det.edges.truncated} note={det.edges.note} onSelect={select} onOpenRef={(r) => setSource({ ref: r, repo, sha, nodeId: det.id })} onMore={det.edges.next ? () => void moreEdges() : undefined} moreBusy={busy} onClose={() => setSelected(null)} />
        ) : det.read && 'failure' in det.read ? (
          <Panel label="Detail" title={<span className="font-mono text-[12.5px]">{selected}</span>}>
            <p className="text-ink-3">{det.read.failure.kind === 'not_found' ? COPY.sourceUnavailable : det.read.failure.kind === 'cursor_expired' || det.read.failure.kind === 'invalid_cursor' ? 'The page marker no longer matches. Close and open this item again.' : `${failureWords(det.read.failure).title}. ${failureWords(det.read.failure).body}`}</p>
          </Panel>
        ) : null
      )}
      {query && query.target === target && <QueryCard preset={query.preset} params={query.params} basisNote={query.result.basis_note} state={query.result.state} reason={query.result.reason} opLine={operationWords('Query', query.result, revisionState(h, query.result))} nodes={query.list.items} edges={query.edges} truncated={query.list.truncated} note={query.list.note} onSelect={select} onMore={query.list.next ? () => void moreQuery() : undefined} moreBusy={busy} onClose={() => setQuery(null)} />}
      {queryFail && (
        <Panel label="Query" title="The query did not run">
          <p className="text-ink-3" data-map-query-failure={queryFail.kind}>
            {failureWords(queryFail).title}: {failureWords(queryFail).body}
          </p>
        </Panel>
      )}
    </>
  )

  const composerBox = presets && presets.length > 0 && view.drawable && (
    composer ? (
      <Panel label={COPY.askContext} actions={<button type="button" aria-label="Hide" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-ink" onClick={() => setComposer(false)}><Icon name="x" size={14} /></button>}>
        <PresetComposer words={words} onWords={onWords} plan={plan} why={why} presets={presets} onPlan={(p) => (setPlan({ target, plan: p }), setRunWhy(null))} onRun={() => void run()} busy={busy} runWhy={runWhy} />
      </Panel>
    ) : (
      <button type="button" data-map-ask-open onClick={() => setComposer(true)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line-2 px-4 text-[13px] text-ink-2 backdrop-blur-md hover:text-ink" style={{ background: 'color-mix(in srgb, var(--color-glass) 92%, transparent)' }}>
        <Icon name="search" size={14} /> {COPY.askContext}
      </button>
    )
  )

  const overview = (
    <Overview header={h} v={view} nodes={list?.items ?? null} truncated={list?.truncated ?? false} scope={scope} onScope={setScope} note={list?.note ?? null} />
  )

  return frame(
    <>
        {narrow ? (
          <div className="space-y-3 px-4 pt-1 pb-6">
            <StateBand v={view} space={h.space} recheck={{ stopped: pollStopped, onRecheck: () => setPolls({ target, n: 0 }) }} />
            {overview}
            {view.drawable && crumbs}
            {picture}
            {side}
            {composerBox}
            <ProvenanceFooter p={h} schema={h.schema} />
          </div>
        ) : (
          <div className="flex min-h-full flex-col px-6 pt-1 pb-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <StateBand v={view} space={h.space} recheck={{ stopped: pollStopped, onRecheck: () => setPolls({ target, n: 0 }) }} />
              </div>
              {view.drawable && list && list.items.length > 0 && (
                <Button variant="ghost" className="min-h-9 px-3 text-[12px]" onClick={() => setAsList(!asList)} aria-pressed={asList}>
                  <Icon name={asList ? 'graph' : 'list'} size={14} /> {asList ? 'Show as picture' : 'Show as list'}
                </Button>
              )}
            </div>
            <div className="relative mt-3 grid min-h-0 flex-1 grid-cols-[minmax(240px,300px)_minmax(0,1fr)_minmax(280px,360px)] gap-4">
              <div className="space-y-3">{overview}</div>
              <div className="flex min-w-0 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {view.drawable && crumbs}
                  {composerBox && !composer && composerBox}
                </div>
                {composer && <div className="mx-auto mt-2 w-full max-w-2xl">{composerBox}</div>}
                <div className="min-h-0 flex-1">{picture}</div>
              </div>
              <div className="space-y-3">{side}</div>
            </div>
            <div className="mt-3 border-t border-line pt-2">
              <ProvenanceFooter p={h} schema={h.schema} />
            </div>
          </div>
        )}
    </>,
    actions,
  )
}
