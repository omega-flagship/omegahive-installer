import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ExploreArrangement, ExploreFacet, ExploreGroup, ExploreGroupDef, ExploreKind, ExploreNode, ExploreResult, ExploreSpec, ExploreView } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Icon } from '../../ui/Icon'
import type { IconName } from '../../ui/iconPaths'
import { Page } from '../../ui/Page'
import { Button } from '../../ui/primitives'
import { EMPTY_ARRANGEMENT, moved, nested, ordered, pinnedFirst, toggled } from './arrange'
import { arrangementOf, DEFAULT_SPEC, exploreScreen, FACET_LABEL, grouped, groupedEarlier, isLayout, ungrouped, withFilter, withKind } from './data'
import { groupNameProblem, removeGroup, renameGroup, type GroupDeps } from './MyGroups'
import { shown } from '../../lib/displayName'
import { bindOperation, stopped, useAlive } from '../../lib/boundOperation'

const KIND_ICON: Record<ExploreKind, IconName> = { mind: 'mind', swarm: 'swarms', app: 'apps', room: 'chat' }
const STATE_TONE: Record<string, string> = {
  working: 'bg-good', running: 'bg-good', unread: 'bg-accent', resting: 'bg-accent', quiet: 'bg-ink-4/50', error: 'bg-bad',
  stopped: 'bg-ink-4', 'not started': 'bg-ink-4/50', empty: 'bg-ink-4/30',
}
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
        layout === 'grid' ? 'flex-col items-start border-line bg-tint/[0.03] p-3' : 'px-2 py-1.5')}
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
          {n.facets.tag.map((t) => <span key={t} className="rounded-full bg-tint/[0.06] px-1.5 text-[11px] text-ink-3">#{t}</span>)}
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
    <div className="mt-1 w-full basis-full space-y-3 rounded-xl border border-line bg-shade/20 p-3 text-[13px]">
      <fieldset>
        <legend className="text-[12px] text-ink-3">My groups (only you see these)</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={member(g)} onChange={() => toggleMember(g)} />{shown(g.name)}</label>
          ))}
          <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group" aria-label="New group name"
            className="w-36 rounded-lg border border-line bg-shade/25 px-2 py-1 text-ink" />
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
            className="block w-full rounded-lg border border-line bg-shade/25 px-2 py-1 text-ink" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" aria-label="Tags"
            className="block w-full rounded-lg border border-line bg-shade/25 px-2 py-1 text-ink" />
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
            className="rounded-2xl border border-line bg-tint/[0.02]">
            <div className="flex items-center gap-2 px-3 py-2">
              <span draggable onDragStart={() => startDrag(g.path, key)} className="cursor-grab text-ink-4" aria-hidden>⋮⋮</span>
              <button className="flex flex-1 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => toggleOpen(g.path)}>
                <Icon name="chevron" size={14} className={cx('text-ink-3 transition-transform', isOpen ? 'rotate-90' : '')} />
                <span className="text-[13px] text-ink-3">{FACET_LABEL[g.facet]}</span>
                <span className="text-[14px] font-medium text-ink">{g.value}</span>
                <span className="rounded-full bg-tint/[0.06] px-2 text-[12px] text-ink-2">{g.count}</span>
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
 *
 * The page and each of my groups are atoms (explore.metta) that MeTTa composes for the look being worn; this page reads
 * the hive, states the facts (data.ts), and carries out a press. Islands: what matches, arranged by hand, in groups
 * (explore-groups) or as one list (explore-items). Rows there are dragged, moved, pinned, nested as a holarchy, and
 * tagged and put in groups in place, which no block draws; MeTTa decides which of the two shows, and when.
 */
export default function ExplorePage() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const [initial] = useState(load)
  const [spec, setSpec] = useState<ExploreSpec>(initial.spec)
  const [arr, setArr] = useState<ExploreArrangement>(initial.arrangement)
  const [viewId, setViewId] = useState<string | null>(initial.view)
  const [views, setViews] = useState<ExploreView[]>([])
  const [opened, setOpened] = useState<string[]>([])
  const [cursor, setCursor] = useState<Record<string, number>>({})
  const [result, setResult] = useState<ExploreResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState(initial.spec.q ?? '')
  const dragging = useRef<{ id: string; key: string } | null>(null)
  const startDrag = useCallback((id: string, key: string) => { dragging.current = { id, key } }, [])
  const dragKey = useCallback(() => dragging.current?.key, [])
  const takeDrag = useCallback(() => { const d = dragging.current; dragging.current = null; return d }, [])
  const [groups, setGroups] = useState<ExploreGroupDef[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  // renaming one of my groups: which, why its new name will not do, and a write in flight
  const [renaming, setRenaming] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
  const deleteView = async () => {
    const v = views.find((x) => x.id === viewId)
    if (!v || !(await askConfirm(`Delete the view "${v.name}"? Nothing else changes.`, 'Delete'))) return
    await client?.deleteExploreView?.(v.id)
    setViews((vs) => vs.filter((x) => x.id !== v.id)); setViewId(null)
  }
  const applyView = (id: string) => {
    const v = views.find((x) => x.id === id)
    setViewId(v ? v.id : null)
    setSpec(v ? { ...DEFAULT_SPEC, ...v.spec } : DEFAULT_SPEC)
    setQ(v?.spec.q ?? '')
    setArr(arrangementOf(v, EMPTY_ARRANGEMENT))
    setOpened([])
    setCursor({})
  }
  // a change to how things are grouped closes every open group (their paths no longer exist)
  const regroup = (next: (s: ExploreSpec) => ExploreSpec) => { setSpec(next); setOpened([]) }

  // r5: every completion after an await is written through the binding made when the person acted (MyGroups.tsx)
  const groupDeps: GroupDeps = { client, setGroups, setEditing: setRenaming, onChanged: fetchNow, setBusy, toast }

  const { plan, data } = useMemo(() => {
    const can = { groups: !!client?.exploreGroups, rename: !!client?.renameExploreGroup, remove: !!client?.deleteExploreGroup }
    const { data, facts } = exploreScreen({ supported: !!client?.explore, result, error, spec, q, layout, viewId, views, groups, groupsOpen, can, renaming, problem }, compose)
    return { plan: compose('explore', facts), data }
  }, [client, result, error, spec, q, layout, viewId, views, groups, groupsOpen, renaming, problem, compose])

  const onInput = (bind: string, value: string) => {
    if (bind === 'q') setQ(value)
    else if (bind === 'layout') { if (isLayout(value)) setArr((a) => ({ ...a, layout: value })) }
    else if (bind === 'view') applyView(value)
    else if (bind === 'add-grouping') regroup((s) => grouped(s, value))
  }
  const onAction = (action: string, item: ScreenItem) => {
    const scope = Array.isArray(item.scope) ? (item.scope as unknown[]) : []
    const group = scope.length ? groups.find((g) => g.id === String(scope[0])) : undefined
    const at = Number(action.slice(-1))
    switch (action) {
      case 'retry': return fetchNow()
      case 'save-view': return void saveView(!viewId)
      case 'save-as': return void saveView(true)
      case 'delete-view': return void deleteView()
      case 'toggle-groups': return setGroupsOpen((v) => !v)
      case 'clear-filters': return setSpec((s) => ({ ...s, filters: {} }))
      case 'kind': return setSpec((s) => withKind(s, String(item.id)))
      case 'filter': return setSpec((s) => withFilter(s, item.facet as ExploreFacet, String(item.id)))
      case 'earlier-2': case 'earlier-3': return setSpec((s) => groupedEarlier(s, at))
      case 'ungroup-1': case 'ungroup-2': case 'ungroup-3': return regroup((s) => ungrouped(s, at))
      case 'rename': return void (group && (setRenaming(group.id), setProblem(null)))
      case 'rename-cancel': return void (setRenaming(null), setProblem(null))
      case 'rename-save': {
        if (!group) return
        const name = String(item.value ?? '')
        const why = groupNameProblem(name, groups, group.id)
        setProblem(why)
        if (!why) void renameGroup(groupDeps, group, name)
        return
      }
      case 'remove': return void (group && removeGroup(groupDeps, group))
    }
  }

  const islands = {
    'explore-groups': (
      <section aria-live="polite" aria-label="What matches">
        <Groups groups={result?.groups ?? []} parent="" />
      </section>
    ),
    'explore-items': (
      <section aria-live="polite" aria-label="What matches">
        <Items items={result?.items ?? []} orderKey="all" next={result?.next} path="" />
      </section>
    ),
  }

  const ctxValue: ExploreCtx = { arr, layout, opened, editing, setEditing, groups, setGroups, reorder, pin, toggleOpen, setCursor, client, toast, fetchNow, fail, startDrag, dragKey, takeDrag }
  return (
    <Ctx.Provider value={ctxValue}>
    <Page title="Explore" eyebrow={String(data['explore.eyebrow'])} label="Explore" onClose={() => navigate({ name: 'hive' })}>
      <ConfirmHost />
      <div className="mx-auto max-w-6xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{ data, framed: true, busy, islands, onInput, onAction }} />
      </div>
    </Page>
    </Ctx.Provider>
  )
}
