import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { MyGroups } from './MyGroups'
import type { ExploreArrangement, ExploreFacet, ExploreGroup, ExploreGroupDef, ExploreKind, ExploreNode, ExploreResult, ExploreSpec, ExploreView } from '../../api/types'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Icon } from '../../ui/Icon'
import type { IconName } from '../../ui/iconPaths'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Segmented } from '../../ui/primitives'
import { EMPTY_ARRANGEMENT, moved, nested, ordered, pinnedFirst, toggled } from './arrange'
import { shown } from '../../lib/displayName'
import { bindOperation, stopped, useAlive } from '../../lib/boundOperation'

const KINDS: { value: ExploreKind; label: string }[] = [
  { value: 'mind', label: 'Minds' }, { value: 'swarm', label: 'Swarms' }, { value: 'app', label: 'Apps' }, { value: 'room', label: 'Rooms' },
]
const FACET_LABEL: Record<ExploreFacet, string> = {
  kind: 'Kind', where: 'Where', state: 'State', swarm: 'Swarm', purpose: 'Purpose', role: 'Role', owner: 'Owner',
  visibility: 'Visibility', health: 'Health', spend: 'Spend', active: 'Last active', tag: 'Tag', group: 'My groups',
}
const SIDEBAR: ExploreFacet[] = ['group', 'tag', 'state', 'where', 'kind', 'swarm', 'purpose', 'role', 'health', 'visibility', 'owner', 'active', 'spend']
const KIND_ICON: Record<ExploreKind, IconName> = { mind: 'mind', swarm: 'swarms', app: 'apps', room: 'chat' }
const STATE_TONE: Record<string, string> = {
  working: 'bg-good', running: 'bg-good', unread: 'bg-accent', resting: 'bg-accent', quiet: 'bg-ink-4/50', error: 'bg-bad',
  stopped: 'bg-ink-4', 'not started': 'bg-ink-4/50', empty: 'bg-ink-4/30',
}
const DEFAULT_SPEC: ExploreSpec = { kinds: ['mind', 'swarm', 'app', 'room'], filters: {}, q: '', group_by: ['kind'], sort: 'name' }
const STORE_KEY = 'omegahive.explore.v1'

function load(): { spec: ExploreSpec; arrangement: ExploreArrangement; view: string | null } {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* private window or blocked storage: start fresh */
  }
  return { spec: DEFAULT_SPEC, arrangement: EMPTY_ARRANGEMENT, view: null }
}

function open(n: ExploreNode, toast: (t: { tone: 'info'; title: string; body?: string }) => void) {
  if (n.kind === 'mind') navigate({ name: 'dot', id: n.id })
  else if (n.kind === 'swarm') navigate({ name: 'swarm', id: n.id })
  else if (n.kind === 'app') navigate({ name: 'program', id: n.id.replace(/^program:/, '') })
  else toast({ tone: 'info', title: n.name, body: 'Rooms open in the chat view, which is coming next.' })
}

interface ExploreCtx {
  arr: ExploreArrangement; layout: 'list' | 'grid' | 'tree'; opened: string[]; editing: string | null
  setEditing: React.Dispatch<React.SetStateAction<string | null>>; groups: ExploreGroupDef[]
  setGroups: React.Dispatch<React.SetStateAction<ExploreGroupDef[]>>
  reorder: (key: string, ids: string[], id: string, to: number) => void; pin: (id: string) => void; toggleOpen: (path: string) => void
  setCursor: React.Dispatch<React.SetStateAction<Record<string, number>>>; client: ReturnType<typeof useHive.getState>['client']
  toast: ReturnType<typeof useHive.getState>['toast']; fetchNow: () => void; fail: (what: string) => (e: unknown) => void
  startDrag: (id: string, key: string) => void; dragKey: () => string | undefined; takeDrag: () => { id: string; key: string } | null
}
// Rows, groups and the editor live outside the page so a refresh or a keystroke never remounts them (inputs keep focus).
const Ctx = createContext<ExploreCtx>(null as unknown as ExploreCtx)

function Item({ n, list, orderKey, depth = 0 }: { n: ExploreNode; list: string[]; orderKey: string; depth?: number }) {
  const { arr, layout, editing, setEditing, reorder, pin, toast, startDrag, dragKey, takeDrag } = useContext(Ctx)
  const pinned = (arr.pinned ?? []).includes(n.id)
  const index = list.indexOf(n.id)
  return (
    <li
      draggable
      onDragStart={() => startDrag(n.id, orderKey)}
      onDragOver={(e) => { if (dragKey() === orderKey) e.preventDefault() }}
      onDrop={() => { const d = takeDrag(); if (d && d.key === orderKey && d.id !== n.id) reorder(orderKey, list, d.id, index) }}
      className={cx('group flex flex-wrap items-center gap-2 rounded-xl border border-transparent hover:border-line',
        layout === 'grid' ? 'flex-col items-start border-line bg-white/[0.03] p-3' : 'px-2 py-1.5')}
      style={layout === 'tree' ? { paddingLeft: 8 + depth * 18 } : undefined}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => open(n, toast)}>
        <Icon name={KIND_ICON[n.kind]} size={15} className="shrink-0 text-ink-3" />
        <span className={cx('h-2 w-2 shrink-0 rounded-full', STATE_TONE[n.facets.state] ?? 'bg-ink-4')} title={n.facets.state} />
        <span className="truncate text-[13.5px] text-ink">{shown(n.name)}</span>
        <span className="hidden truncate text-[12px] text-ink-4 sm:inline">
          {n.facets.state}{n.kind === 'mind' && n.facets.swarm !== '(none)' ? ` · ${n.facets.swarm}` : ''}{n.facets.purpose !== '(none)' && n.kind !== 'mind' ? ` · ${n.facets.purpose}` : ''}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
        <button className="rounded px-1 text-[12px] text-ink-3 hover:text-ink" aria-label={`Move ${n.name} up`} disabled={index <= 0} onClick={() => reorder(orderKey, list, n.id, index - 1)}>↑</button>
        <button className="rounded px-1 text-[12px] text-ink-3 hover:text-ink" aria-label={`Move ${n.name} down`} disabled={index < 0 || index >= list.length - 1} onClick={() => reorder(orderKey, list, n.id, index + 1)}>↓</button>
        <button className={cx('rounded px-1 text-[12px]', pinned ? 'text-accent' : 'text-ink-3 hover:text-ink')} aria-pressed={pinned} aria-label={pinned ? `Unpin ${n.name}` : `Pin ${n.name}`} onClick={() => pin(n.id)}>
          {pinned ? '★' : '☆'}
        </button>
        <button className="rounded px-1 text-[12px] text-ink-3 hover:text-ink" aria-expanded={editing === n.id} aria-label={`Groups and tags for ${n.name}`}
          onClick={() => setEditing((e) => (e === n.id ? null : n.id))}>⋯</button>
      </span>
      {(n.facets.tag.length > 0 || n.facets.group.length > 0) && editing !== n.id && (
        <span className="hidden flex-wrap gap-1 md:flex">
          {n.facets.group.map((g) => <span key={`g${g}`} className="rounded-full border border-accent/40 px-1.5 text-[11px] text-accent">{g}</span>)}
          {n.facets.tag.map((t) => <span key={t} className="rounded-full bg-white/[0.06] px-1.5 text-[11px] text-ink-3">#{t}</span>)}
        </span>
      )}
      {editing === n.id && <Editor n={n} />}
    </li>
  )
}

function Editor({ n }: { n: ExploreNode }) {
  const { setEditing, groups, setGroups, client, fetchNow, fail } = useContext(Ctx)
  const [tags, setTags] = useState(n.facets.tag.join(', '))
  const [purpose, setPurpose] = useState(n.facets.purpose === '(none)' ? '' : n.facets.purpose)
  const [newGroup, setNewGroup] = useState('')
  const alive = useAlive()
  const shared = n.kind === 'mind' || n.kind === 'swarm'
  const member = (g: ExploreGroupDef) => g.members.includes(n.id)
  const toggleMember = (g: ExploreGroupDef) =>
    void client?.exploreGroupMembers?.(g.id, member(g) ? { remove: [n.id] } : { add: [n.id] })
      .then((ng) => { setGroups((gs) => gs.map((x) => (x.id === ng.id ? ng : x))); fetchNow() }).catch(fail('change the group'))
  return (
    <div className="mt-1 w-full basis-full space-y-3 rounded-xl border border-line bg-black/20 p-3 text-[13px]">
      <fieldset>
        <legend className="text-[12px] text-ink-3">My groups (only you see these)</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={member(g)} onChange={() => toggleMember(g)} />{shown(g.name)}</label>
          ))}
          <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group" aria-label="New group name"
            className="w-36 rounded-lg border border-line bg-black/25 px-2 py-1 text-ink" />
          <Button variant="subtle" disabled={!newGroup.trim()} onClick={() => {
            // professional-release r1.2: make the group, then add this one to it, both under the sign-in that asked
            const op = bindOperation(alive)
            if (!client?.createExploreGroup) return
            void op.write(() => client.createExploreGroup!(newGroup.trim()))
              .then((g) => op.write(() => client.exploreGroupMembers!(g.id, { add: [n.id] })))
              .then((g) => { if (!op.current()) return; setGroups((gs) => [...gs, g].sort((a, b) => a.name.localeCompare(b.name))); setNewGroup(''); fetchNow() })
              .catch((e: unknown) => { if (!stopped(e) && op.current()) fail('make the group')(e) })
          }}>Add</Button>
        </div>
      </fieldset>
      {shared && (
        <fieldset className="space-y-2">
          <legend className="text-[12px] text-ink-3">Purpose and tags (everyone who can see this {n.kind} sees them; its owner or an admin edits)</legend>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What it is for" aria-label="Purpose"
            className="block w-full rounded-lg border border-line bg-black/25 px-2 py-1 text-ink" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" aria-label="Tags"
            className="block w-full rounded-lg border border-line bg-black/25 px-2 py-1 text-ink" />
          <Button variant="primary" onClick={() => void client?.setNodeMeta?.(n.id, { purpose, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })
            .then(() => { setEditing(null); fetchNow() }).catch(fail('save the tags'))}>Save</Button>
        </fieldset>
      )}
    </div>
  )
}

function Items({ items, orderKey, next, path }: { items: ExploreNode[]; orderKey: string; next?: number | null; path: string }) {
  const { arr, layout, setCursor } = useContext(Ctx)
  const sorted = ordered(items, arr.order?.[orderKey])
  const { pinned, rest } = pinnedFirst(sorted, arr.pinned)
  const all = [...pinned, ...rest]
  const ids = all.map((x) => x.id)
  const rows = layout === 'tree' ? nested(all) : all.map((node) => ({ node, depth: 0 }))
  return (
    <>
      <ul className={cx(layout === 'grid' ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-0.5')}>
        {rows.map(({ node, depth }) => <Item key={node.id} n={node} list={ids} orderKey={orderKey} depth={depth} />)}
      </ul>
      {next != null && (
        <Button className="mt-2" variant="subtle" onClick={() => setCursor((c) => ({ ...c, [path]: next }))}>Show more</Button>
      )}
    </>
  )
}

function Groups({ groups, parent }: { groups: ExploreGroup[]; parent: string }) {
  const { arr, opened, reorder, toggleOpen, startDrag, dragKey, takeDrag } = useContext(Ctx)
  const key = `groups:${parent}`
  const list = ordered(groups.map((g) => ({ ...g, id: g.path })), arr.order?.[key])
  const ids = list.map((g) => g.id)
  return (
    <ul className="space-y-2">
      {list.map((g, i) => {
        const isOpen = opened.includes(g.path)
        return (
          <li key={g.path}
            onDragOver={(e) => { if (dragKey() === key) e.preventDefault() }}
            onDrop={() => { const d = takeDrag(); if (d && d.key === key && d.id !== g.path) reorder(key, ids, d.id, i) }}
            className="rounded-2xl border border-line bg-white/[0.02]">
            <div className="flex items-center gap-2 px-3 py-2">
              <span draggable onDragStart={() => startDrag(g.path, key)} className="cursor-grab text-ink-4" aria-hidden>⋮⋮</span>
              <button className="flex flex-1 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => toggleOpen(g.path)}>
                <Icon name="chevron" size={14} className={cx('text-ink-3 transition-transform', isOpen ? 'rotate-90' : '')} />
                <span className="text-[13px] text-ink-3">{FACET_LABEL[g.facet]}</span>
                <span className="text-[14px] font-medium text-ink">{g.value}</span>
                <span className="rounded-full bg-white/[0.06] px-2 text-[12px] text-ink-2">{g.count}</span>
              </button>
              <button className="px-1 text-[12px] text-ink-3" aria-label={`Move group ${g.value} up`} disabled={i === 0} onClick={() => reorder(key, ids, g.path, i - 1)}>↑</button>
              <button className="px-1 text-[12px] text-ink-3" aria-label={`Move group ${g.value} down`} disabled={i === list.length - 1} onClick={() => reorder(key, ids, g.path, i + 1)}>↓</button>
            </div>
            {isOpen && (
              <div className="border-t border-line px-2 py-2">
                {g.groups ? <Groups groups={g.groups} parent={g.path} />
                  : g.items ? <Items items={g.items} orderKey={g.path} next={g.next} path={g.path} />
                    : <p className="px-2 text-[12.5px] text-ink-4">Loading…</p>}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * #/explore (R19): everything in the hive, filtered and grouped the way this person wants, arranged by hand.
 * The hive does the filtering and grouping and sends counts; a closed group costs one number, an opened one a page.
 * Arrangements (order, pins, collapsed groups, layout) are personal and never change the real structure.
 */
export default function ExplorePage() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [initial] = useState(load)
  const [spec, setSpec] = useState<ExploreSpec>(initial.spec)
  const [arr, setArr] = useState<ExploreArrangement>(initial.arrangement)
  const [viewId, setViewId] = useState<string | null>(initial.view)
  const [views, setViews] = useState<ExploreView[]>([])
  const [opened, setOpened] = useState<string[]>([])
  const [cursor, setCursor] = useState<Record<string, number>>({})
  const [result, setResult] = useState<ExploreResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [facetsOpen, setFacetsOpen] = useState(false)
  const [q, setQ] = useState(initial.spec.q ?? '')
  const dragging = useRef<{ id: string; key: string } | null>(null)
  const startDrag = useCallback((id: string, key: string) => { dragging.current = { id, key } }, [])
  const dragKey = useCallback(() => dragging.current?.key, [])
  const takeDrag = useCallback(() => { const d = dragging.current; dragging.current = null; return d }, [])
  const [groups, setGroups] = useState<ExploreGroupDef[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  useEffect(() => {
    void client?.exploreGroups?.().then(setGroups).catch(() => setGroups([]))
  }, [client])
  const fail = (what: string) => (e: unknown) => toast({ tone: 'error', title: `Could not ${what}`, body: e instanceof Error ? e.message : String(e) })

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ spec, arrangement: arr, view: viewId }))
    } catch {
      /* storage unavailable: the arrangement simply is not remembered on this device */
    }
  }, [spec, arr, viewId])

  useEffect(() => {
    const t = setTimeout(() => setSpec((s) => (s.q === q ? s : { ...s, q })), 250)
    return () => clearTimeout(t)
  }, [q])

  const fetchNow = useCallback(() => {
    if (!client?.explore) return
    client.explore({ ...spec, open: opened, cursor, limit: 60 }).then((r) => { setResult(r); setError(null) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [client, spec, opened, cursor])
  useEffect(() => {
    fetchNow()
    const t = setInterval(fetchNow, 20000)
    return () => clearInterval(t)
  }, [fetchNow])
  useEffect(() => {
    void client?.exploreViews?.().then(setViews).catch(() => setViews([]))
  }, [client])

  const groupBy = spec.group_by ?? []
  const setFilter = (facet: ExploreFacet, value: string) =>
    setSpec((s) => {
      const cur = s.filters?.[facet] ?? []
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
      const filters = { ...s.filters, [facet]: next }
      if (!next.length) delete filters[facet]
      return { ...s, filters }
    })
  const toggleOpen = (path: string) => {
    setOpened((o) => (o.includes(path) ? o.filter((p) => p !== path && !p.startsWith(path + '/')) : [...o, path]))
    setArr((a) => ({ ...a, collapsed: toggled(a.collapsed, path) }))
  }
  const reorder = (key: string, ids: string[], id: string, to: number) =>
    setArr((a) => ({ ...a, order: { ...a.order, [key]: moved(ordered(ids.map((x) => ({ id: x })), a.order?.[key]).map((x) => x.id), id, to) } }))
  const pin = (id: string) => setArr((a) => ({ ...a, pinned: toggled(a.pinned, id) }))
  const layout = arr.layout ?? 'list'

  const saveView = async (asNew: boolean) => {
    if (!client?.saveExploreView) return
    const current = views.find((v) => v.id === viewId)
    const name = asNew || !current ? window.prompt('Name this view', current ? `${current.name} copy` : 'My view')?.trim() : current.name
    if (!name) return
    try {
      const v = await client.saveExploreView({ name, spec, arrangement: arr }, asNew ? undefined : current?.id)
      setViews((vs) => [...vs.filter((x) => x.id !== v.id), v].sort((a, b) => a.name.localeCompare(b.name)))
      setViewId(v.id)
      toast({ tone: 'success', title: `Saved "${v.name}"` })
    } catch (e) {
      toast({ tone: 'error', title: 'Could not save the view', body: e instanceof Error ? e.message : String(e) })
    }
  }
  const applyView = (id: string) => {
    const v = views.find((x) => x.id === id)
    setViewId(v ? v.id : null)
    setSpec(v ? { ...DEFAULT_SPEC, ...v.spec } : DEFAULT_SPEC)
    setQ(v?.spec.q ?? '')
    setArr(v ? { ...EMPTY_ARRANGEMENT, ...v.arrangement } : EMPTY_ARRANGEMENT)
    setOpened([])
    setCursor({})
  }

  const facetPanel = result && (
    <div className="space-y-4">
      {SIDEBAR.map((f) => {
        const values = Object.entries(result.facets[f] ?? {})
        if (!values.length || (values.length === 1 && values[0][0] === '(none)')) return null
        const chosen = spec.filters?.[f] ?? []
        return (
          <fieldset key={f}>
            <legend className="mb-1 text-[12px] font-medium tracking-wide text-ink-3 uppercase">{FACET_LABEL[f]}</legend>
            <div className="space-y-0.5">
              {values.slice(0, 12).map(([v, n]) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-white/[0.04]">
                  <input type="checkbox" checked={chosen.includes(v)} onChange={() => setFilter(f, v)} />
                  <span className="flex-1 truncate text-ink-2">{v}</span>
                  <span className="text-[12px] text-ink-4">{n}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )
      })}
    </div>
  )

  const unused = (result?.facet_names ?? []).filter((f) => !groupBy.includes(f))
  const filterCount = Object.values(spec.filters ?? {}).reduce((n, v) => n + (v?.length ?? 0), 0)

  const ctxValue: ExploreCtx = { arr, layout, opened, editing, setEditing, groups, setGroups, reorder, pin, toggleOpen, setCursor, client, toast, fetchNow, fail, startDrag, dragKey, takeDrag }
  return (
    <Ctx.Provider value={ctxValue}>
    <Page title="Explore" eyebrow={result ? `${result.total} shown` : 'Everything in this hive'} label="Explore" onClose={() => navigate({ name: 'hive' })}>
      <ConfirmHost />
      <div className="mx-auto max-w-6xl space-y-4 px-4 pt-2 pb-12 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, purposes, ids" aria-label="Search"
            className="min-w-[200px] flex-1 rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" />
          <Segmented label="Layout" value={layout} onChange={(v) => setArr((a) => ({ ...a, layout: v }))}
            options={[{ value: 'list', label: 'List' }, { value: 'grid', label: 'Grid' }, { value: 'tree', label: 'Holarchy' }]} />
          <select aria-label="Saved views" value={viewId ?? ''} onChange={(e) => applyView(e.target.value)}
            className="rounded-xl border border-line bg-black/25 px-3 py-2 text-[13px] text-ink">
            <option value="">Unsaved view</option>
            {views.map((v) => <option key={v.id} value={v.id}>{shown(v.name)}</option>)}
          </select>
          <Button variant="subtle" onClick={() => void saveView(!viewId)}>{viewId ? 'Save' : 'Save view'}</Button>
          {viewId && <Button variant="subtle" onClick={() => void saveView(true)}>Save as…</Button>}
          {client?.exploreGroups && <Button data-my-groups-toggle variant="subtle" aria-expanded={groupsOpen} onClick={() => setGroupsOpen((v) => !v)}>My groups</Button>}
          {viewId && (
            <Button variant="subtle" onClick={() => void (async () => {
              const v = views.find((x) => x.id === viewId)
              if (!v || !(await askConfirm(`Delete the view "${v.name}"? Nothing else changes.`, 'Delete'))) return
              await client?.deleteExploreView?.(v.id)
              setViews((vs) => vs.filter((x) => x.id !== v.id)); setViewId(null)
            })()}>Delete view</Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {KINDS.map((k) => {
            const on = (spec.kinds ?? []).includes(k.value)
            return (
              <button key={k.value} aria-pressed={on} onClick={() => setSpec((s) => {
                const kinds = on ? (s.kinds ?? []).filter((x) => x !== k.value) : [...(s.kinds ?? []), k.value]
                return { ...s, kinds: kinds.length ? kinds : s.kinds }
              })} className={cx('rounded-full border px-3 py-1', on ? 'border-control bg-white/[0.09] text-ink' : 'border-line text-ink-3')}>
                {k.label}{result ? ` ${result.facets.kind?.[k.value] ?? 0}` : ''}
              </button>
            )
          })}
          <span className="mx-1 text-ink-4">|</span>
          <span className="text-ink-3">Group by</span>
          {groupBy.map((g, i) => (
            <span key={g} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-ink-2">
              {i > 0 && <button aria-label={`Group by ${FACET_LABEL[g]} earlier`} onClick={() => setSpec((s) => ({ ...s, group_by: moved(groupBy, g, i - 1) as ExploreFacet[] }))}>←</button>}
              {FACET_LABEL[g]}
              <button aria-label={`Stop grouping by ${FACET_LABEL[g]}`} onClick={() => { setSpec((s) => ({ ...s, group_by: groupBy.filter((x) => x !== g) })); setOpened([]) }}>×</button>
            </span>
          ))}
          {groupBy.length < 3 && (
            <select aria-label="Add a grouping" value="" onChange={(e) => { if (e.target.value) { setSpec((s) => ({ ...s, group_by: [...groupBy, e.target.value as ExploreFacet] })); setOpened([]) } }}
              className="rounded-full border border-line bg-black/25 px-2 py-0.5 text-[13px] text-ink-3">
              <option value="">+ add</option>
              {unused.map((f) => <option key={f} value={f}>{FACET_LABEL[f]}</option>)}
            </select>
          )}
          <button className="ml-auto rounded-full border border-line px-3 py-1 text-ink-3 lg:hidden" aria-expanded={facetsOpen} onClick={() => setFacetsOpen((v) => !v)}>
            Filters{filterCount ? ` (${filterCount})` : ''}
          </button>
          {filterCount > 0 && <button className="text-ink-3 underline" onClick={() => setSpec((s) => ({ ...s, filters: {} }))}>Clear filters</button>}
        </div>

        {client?.exploreGroups && groupsOpen && <MyGroups groups={groups} setGroups={setGroups} onChanged={fetchNow} />}
        <div className="flex gap-6">
          <aside className={cx('w-56 shrink-0', facetsOpen ? 'block' : 'hidden lg:block')} aria-label="Filters">{facetPanel}</aside>
          <section className="min-w-0 flex-1" aria-live="polite">
            {error && <EmptyState icon="alert" title="Could not load" body={error} action={<Button onClick={fetchNow}>Try again</Button>} />}
            {!client?.explore && <EmptyState icon="ban" title="Not available here" body="This hive does not offer the explorer yet." />}
            {client?.explore && !error && !result && <p className="text-[13px] text-ink-4">Loading…</p>}
            {result && result.total === 0 && <EmptyState icon="search" title="Nothing matches" body="Try fewer filters or another search." />}
            {result && result.total > 0 && (result.groups
              ? <Groups groups={result.groups} parent="" />
              : <Items items={result.items ?? []} orderKey="all" next={result.next} path="" />)}
            <p className="mt-4 text-[12px] text-ink-4">
              Drag (or use ↑ ↓) to arrange, ☆ to pin. Your arrangement is yours alone and never changes how the hive is organised.
            </p>
          </section>
        </div>
      </div>
    </Page>
    </Ctx.Provider>
  )
}
