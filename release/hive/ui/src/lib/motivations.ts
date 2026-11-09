/**
 * Motivations above Tasks, the shared part every experience uses (host phase 1: hive/API.md "Motivations and the
 * Tasks query"; Jon's Q1–Q7, MOTIVATIONS_TASKS_HOST_DESIGN_20261005.md).
 *
 * - A **motivation** is the why: a long-lived aim owned by a person, a team (swarm) or the mind that named it.
 * - A **task** is today's goal, unchanged underneath: every goal route, decision (GoalDecision) and event stays as it is.
 * - A task may serve several motivations (Q7): chips on the card, a filter per motivation, counted once in totals.
 * - A link is association only: it tells no mind anything (design §2). The words here never suggest otherwise.
 *
 * Everything read here belongs to the store session it was read under (Surface R): a late answer from an earlier
 * connection is dropped, never shown.
 */
import { useEffect } from 'react'
import { ApiError, type Me } from '../api/client'
import type { Agent, CreateMotivationBody, Goal, Motivation, MotivationLinkResult, MotivationRef, MotivationStatus, Swarm, TaskItem, TaskQuery, Visibility } from '../api/types'
import { useHive } from '../store/store'
import { applyMotivation, type HiveData } from '../store/reducer'
import { shown } from './displayName'

/** The words people see (design §4): the API, MCP tools, skills and events keep `goal`. */
export const WORDS = {
  motivation: 'Motivation',
  motivations: 'Motivations',
  task: 'Task',
  tasks: 'Tasks',
  subtask: 'subtask',
  unsorted: 'Unsorted',
} as const

export const STATUS_WORDS: Record<MotivationStatus, string> = { active: 'Active', paused: 'Paused', achieved: 'Achieved', retired: 'Retired' }
export const STATUS_ORDER: MotivationStatus[] = ['active', 'paused', 'achieved', 'retired']
/** Only active and paused motivations take new links (409 motivation_closed otherwise). */
export const linkable = (m: Pick<Motivation, 'status'>) => m.status === 'active' || m.status === 'paused'

/** What a link means, said once wherever a person links work (design §2: linking discloses nothing). */
export const LINK_MEANS = 'Linking only files the task under this motivation for people who can read it. Minds working on the task are not told about it.'

// ---------------------------------------------------------------- session-bound reads

function bound() {
  const { client, session } = useHive.getState()
  return { client, ok: () => useHive.getState().session === session && useHive.getState().client === client }
}

const inflight = new Map<string, Promise<void>>()
function once(key: string, run: () => Promise<void>): Promise<void> {
  const k = `${useHive.getState().session}:${key}`
  const cur = inflight.get(k)
  if (cur) return cur
  const p = run().finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

/**
 * Pages are read to the end (stand-in P2-3 on 61936cb): a part is never shown as the whole. MAX_PAGES only guards a
 * hive that never stops answering with a cursor; reaching it marks the read partial, and a partial read purges nothing
 * and never makes a task Unsorted.
 */
export const MAX_PAGES = 500
const PAGE = 200

// ---------------------------------------------------------------- read generations (stand-in P1-2 on 57e64ca, P1-1 on b26a46a)

/**
 * Every read that installs motivations or task links takes a generation from one counter (per store session) when it
 * starts. When a complete motivations read lands, it takes another, and what it lists becomes the **visibility
 * snapshot**: the motivations this viewer is entitled to read as of that landing.
 *
 * - Allow-list (stand-in P1-1 on b26a46a): a task answer from a read that started before the newest snapshot landed may
 *   carry only refs to motivations that snapshot lists. Every other ref is dropped, whether the store ever saw it or not.
 *   A read started after the landing was answered after the hive gave that snapshot, so its refs are kept.
 * - Titles (and whys) are shown only as a motivations read delivered them (`entitleRefs`): a task's ref to a motivation
 *   the store does not hold shows UNREAD_TITLE, never the title the task answer carried.
 * - A motivation found gone by its own read (404) is recorded as revoked at that generation: no older answer brings it back.
 * - A whole complete read that started before the newest one of its kind landed is dropped outright: it can only be older.
 * - Re-sharing: a motivations read that lists it again makes it part of the new snapshot, so it comes back.
 */
const gens = { session: '', seq: 0, motivations: 0, tasks: 0, listed: null as Set<string> | null, revoked: new Map<string, number>() }
function genState() {
  const session = useHive.getState().session
  if (gens.session !== session) Object.assign(gens, { session, seq: 0, motivations: 0, tasks: 0, listed: null, revoked: new Map<string, number>() })
  return gens
}
/** A fresh generation, for a read starting (or a complete read landing) now. */
export function beginRead(): number {
  return ++genState().seq
}
/** Refs a read started at `gen` may still show: only those the newest visibility snapshot lists, when that snapshot
 *  landed after the read began; and none to a motivation its own read found gone after the read began. */
export function keepFresh(refs: MotivationRef[], gen: number): MotivationRef[] {
  const g = genState()
  const listed = g.listed && gen < g.motivations ? g.listed : null
  if (!listed && !g.revoked.size) return refs
  const kept = refs.filter((r) => (!listed || listed.has(r.id)) && !((g.revoked.get(r.id) ?? 0) > gen))
  return kept.length === refs.length ? refs : kept
}
/** Record that, as of generation `gen`, this viewer no longer reads `id`. */
export function markRevoked(id: string, gen: number): void {
  const g = genState()
  if ((g.revoked.get(id) ?? 0) < gen) g.revoked.set(id, gen)
}

/** Shown on a task's ref to a motivation no motivations read has delivered to this viewer (yet). */
export const UNREAD_TITLE = 'A motivation'

/**
 * Every task's refs with the title and status a motivations read delivered (`motivations`), or UNREAD_TITLE where none
 * has: the title a task answer carries is never shown on its own (stand-in P1-1 on b26a46a). The same object when
 * nothing changes.
 */
export function entitleRefs(links: Record<string, MotivationRef[]>, motivations: Record<string, Pick<Motivation, 'title' | 'status'>>): Record<string, MotivationRef[]> {
  let changed = false
  const out: Record<string, MotivationRef[]> = {}
  for (const [g, refs] of Object.entries(links)) {
    let rc = false
    const next = refs.map((r) => {
      const m = motivations[r.id]
      const title = m ? m.title : UNREAD_TITLE
      const status = m ? m.status : r.status
      if (r.title === title && r.status === status) return r
      rc = true
      return { id: r.id, title, status }
    })
    if (rc) changed = true
    out[g] = rc ? next : refs
  }
  return changed ? out : links
}

/** Every motivation this viewer can read (GET /api/motivations, paged). Silent where the hive has no motivations yet.
 *  `force` reads again; a complete read replaces the list, so a motivation this viewer can no longer read is gone from it
 *  and from every task's chips (stand-in P1-1: the hive sends no event to someone who lost the right to read). */
export function loadMotivations(force = false): Promise<void> {
  const live = bound()
  const client = live.client
  if (!client?.listMotivations || (!force && useHive.getState().motivationsLoaded)) return Promise.resolve()
  return once(force ? 'motivations!' : 'motivations', async () => {
    const gen = beginRead()
    const all: Motivation[] = []
    let cursor: string | undefined
    let complete = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.listMotivations!({ limit: PAGE, ...(cursor ? { cursor } : {}) })
      if (!live.ok()) return
      all.push(...r.items)
      if (!r.cursor) {
        complete = true
        break
      }
      cursor = r.cursor
    }
    const g = genState()
    // a read that started before a newer one landed would bring back what the newer one dropped
    if (gen < g.motivations) return
    const landed = complete ? beginRead() : 0
    useHive.setState((s) => {
      if (!complete) {
        // partial: add what was read, take nothing away
        let next: HiveData = s
        for (const m of all) next = applyMotivation(next, m)
        return { motivations: next.motivations, taskLinks: entitleRefs(next.taskLinks, next.motivations), motivationsLoaded: true, motivationsPartial: true }
      }
      g.motivations = landed
      const motivations = Object.fromEntries(all.map((m) => [m.id, m]))
      g.listed = new Set(Object.keys(motivations))
      // what this read no longer lists is revoked as of its landing; what it lists again, read after a revocation, is back
      for (const id of Object.keys(s.motivations)) if (!(id in motivations)) markRevoked(id, landed)
      for (const refs of Object.values(s.taskLinks)) for (const r of refs) if (!(r.id in motivations)) markRevoked(r.id, landed)
      for (const id of Object.keys(motivations)) if ((g.revoked.get(id) ?? Infinity) < gen) g.revoked.delete(id)
      return { motivations, taskLinks: entitleRefs(purgeRefs(s.taskLinks, (id) => id in motivations), motivations), motivationsLoaded: true, motivationsPartial: false }
    })
  })
}

/** Every task's refs, keeping only those `keep` allows (the same object when nothing changes). */
export function purgeRefs(links: Record<string, MotivationRef[]>, keep: (motivationId: string) => boolean): Record<string, MotivationRef[]> {
  let changed = false
  const out: Record<string, MotivationRef[]> = {}
  for (const [g, refs] of Object.entries(links)) {
    const kept = refs.filter((r) => keep(r.id))
    if (kept.length !== refs.length) changed = true
    out[g] = kept
  }
  return changed ? out : links
}

/** Every visible task's readable links (GET /api/tasks, paged to the end). The task rows themselves also fill in the
 *  store's goals where it has none or an older copy (the same list row shape as GET /api/swarms/{id}/goals). A task the
 *  read did not reach keeps no entry, so it is never counted Unsorted (`isUnsorted`). */
export function loadTaskLinks(force = false): Promise<void> {
  const live = bound()
  const client = live.client
  if (!client?.listTasks || (!force && useHive.getState().taskLinksLoaded)) return Promise.resolve()
  return once(force ? 'tasks!' : 'tasks', async () => {
    const gen = beginRead()
    const read = await readAllTasks({})
    if (!live.ok() || !read) return
    const g = genState()
    // a full read that started before a newer one landed says nothing newer (stand-in P1-2 on 57e64ca)
    if (gen < g.tasks) return
    if (read.complete) g.tasks = beginRead()
    useHive.setState((s) => {
      const goals = { ...s.goals }
      for (const it of read.items) {
        const g = goalOf(it)
        if (!goals[g.id] || goals[g.id].updated_at <= g.updated_at) goals[g.id] = g
      }
      // refs to a motivation found revoked after this read started never come back (stand-in P1-2 on 57e64ca)
      const fresh = Object.fromEntries(read.items.map((it) => [it.id, keepFresh(it.motivations ?? [], gen)]))
      // complete: the hive's answer is the whole truth for this viewer; partial: what was read replaces only itself
      const taskLinks = entitleRefs(read.complete ? fresh : { ...s.taskLinks, ...fresh }, s.motivations)
      return { goals, taskLinks, taskLinksLoaded: true, taskLinksPartial: !read.complete }
    })
  })
}

/**
 * One motivation's tasks, as the hive answers them (GET /api/tasks?motivation=…), installed into the store: each task's
 * links and row. A task the hive no longer lists under it has lost that link for this person (only a complete read says
 * so). The read takes a generation when it starts, so an answer landing after a revocation never restores the revoked
 * refs (stand-in P1-2 on 57e64ca). Null when the hive has no Tasks query or the session changed.
 */
export async function readMotivationTasks(id: string): Promise<{ complete: boolean } | null> {
  const gen = beginRead()
  const read = await readAllTasks({ motivation: id })
  if (!read) return null
  const { items, complete } = read
  useHive.setState((s) => {
    const taskLinks = { ...s.taskLinks }
    const goals = { ...s.goals }
    for (const it of items) {
      taskLinks[it.id] = keepFresh(it.motivations ?? [], gen)
      const g = goalOf(it)
      if (!goals[g.id] || goals[g.id].updated_at <= g.updated_at) goals[g.id] = g
    }
    const listed = new Set(items.map((it) => it.id))
    if (complete) for (const [g, refs] of Object.entries(taskLinks)) if (!listed.has(g) && refs.some((r) => r.id === id)) taskLinks[g] = refs.filter((r) => r.id !== id)
    return { taskLinks: entitleRefs(taskLinks, s.motivations), goals }
  })
  return { complete }
}

/** Under no motivation this viewer can read: only for a task whose links were read (never for one the read missed). */
export const isUnsorted = (links: Record<string, MotivationRef[]>, goalId: string): boolean => links[goalId] !== undefined && links[goalId].length === 0

/** All pages of one Tasks query (to the end, or MAX_PAGES), or null when the hive has no Tasks query or the session
 *  changed. `complete` is false only when the guard stopped it with a cursor still to read. */
export async function readAllTasks(q: TaskQuery, maxPages = MAX_PAGES): Promise<{ items: TaskItem[]; complete: boolean } | null> {
  const live = bound()
  const client = live.client
  if (!client?.listTasks) return null
  const out: TaskItem[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const r = await client.listTasks({ ...q, limit: PAGE, ...(cursor ? { cursor } : {}) })
    if (!live.ok()) return null
    out.push(...r.items)
    if (!r.cursor) return { items: out, complete: true }
    cursor = r.cursor
  }
  return { items: out, complete: false }
}

let lastRevalidate = { session: '', at: 0 }

/** Read motivations and task links again, in full: what this viewer may no longer read leaves the store. `minGapMs`
 *  skips a read when one started that recently in this session (a view opening, many chips mounting at once). */
export function revalidateMotivations(minGapMs = 0): Promise<void> {
  const s = useHive.getState()
  if (!s.motivationsLoaded && !s.taskLinksLoaded) return Promise.resolve()
  const now = Date.now()
  if (minGapMs > 0 && lastRevalidate.session === s.session && now - lastRevalidate.at < minGapMs) return Promise.resolve()
  lastRevalidate = { session: s.session, at: now }
  return Promise.all([loadMotivations(true), loadTaskLinks(true)]).then(() => undefined)
}

/** A view opening re-reads at most this often (focus, showing the page and the timer always do). */
export const REVALIDATE_ON_OPEN_MS = 5_000

/** How often an open hive re-reads motivations while nothing else prompts it (focus and showing the page do too). */
export const REVALIDATE_MS = 60_000

/**
 * Stand-in P1-1 on 61936cb: a person who loses the right to read a motivation gets no event about it, so whatever is
 * already on their screen is checked again: when the window regains focus, when the page is shown again, and every
 * REVALIDATE_MS. Mounted once for the whole app (every experience reads the same store). Returns stop.
 */
export function watchMotivations(target: EventTarget, everyMs = REVALIDATE_MS, doc?: { visibilityState?: string } & EventTarget): () => void {
  const run = () => void revalidateMotivations().catch(() => undefined)
  const onShow = () => {
    if (!doc || doc.visibilityState === 'visible') run()
  }
  target.addEventListener('focus', run)
  doc?.addEventListener('visibilitychange', onShow)
  const timer = setInterval(run, everyMs)
  return () => {
    target.removeEventListener('focus', run)
    doc?.removeEventListener('visibilitychange', onShow)
    clearInterval(timer)
  }
}

/** The app's one watcher (App.tsx). */
export function useMotivationWatch(): void {
  useEffect(() => (typeof window === 'undefined' || typeof window.addEventListener !== 'function' ? undefined : watchMotivations(window, REVALIDATE_MS, typeof document === 'undefined' ? undefined : document)), [])
}

/** A Tasks item as a plain goal (the store keeps goal rows only). */
export function goalOf(it: TaskItem): Goal {
  const { motivations: _m, requests: _r, ...g } = it
  return g as Goal
}

/** Load motivations and task links once for the views that show them (and again when asked). */
export function useMotivationData(): { supported: boolean; loaded: boolean } {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const loaded = useHive((s) => s.motivationsLoaded && s.taskLinksLoaded)
  const supported = !!client?.listMotivations && !!client?.listTasks
  useEffect(() => {
    if (!supported) return
    // first read, or (data already held) a fresh full read as this view opens: nothing revoked stays on screen
    if (useHive.getState().motivationsLoaded) void revalidateMotivations(REVALIDATE_ON_OPEN_MS).catch(() => undefined)
    else {
      void loadMotivations().catch(() => undefined)
      void loadTaskLinks().catch(() => undefined)
    }
  }, [supported, session])
  return { supported, loaded }
}

// ---------------------------------------------------------------- outcomes in plain words

/** The hive's refusals, by error.code, in words a person can act on. */
export function refusalWords(err: unknown): string {
  const code = err instanceof ApiError ? err.code : ''
  switch (code) {
    case 'not_found':
      return 'That is not there for you: it may have been made private, or it no longer exists.'
    case 'motivation_changed':
      return 'This motivation changed since you opened it. It has been read again; look, then try once more.'
    case 'motivation_closed':
      return 'Only active or paused motivations take new tasks.'
    case 'link_changed':
      return 'Someone changed these links meanwhile. Nothing was changed; it has been read again.'
    case 'scope_mismatch':
      return "That task belongs to a swarm this motivation doesn't cover."
    case 'swarm_archived':
      return 'That swarm is archived, so its motivations and tasks are read-only.'
    case 'cascade_refused':
      return 'A subtask could not be included, so nothing was changed.'
    case 'operation_conflict':
      return 'That change was already used for something different. Nothing was changed.'
    case 'owner_only':
      return "Only the swarm's owner or an admin can make a swarm motivation; you can make your own."
    case 'bad_scope':
      return 'A motivation belongs to a person or a swarm. The hive password is not a person: sign in to have your own.'
    case 'parent_disabled':
      return 'Motivations inside motivations are switched off on this hive for now.'
    case 'bad_visibility':
      return 'Choose who can see it: only you, the people you name, or everyone who can see the swarm.'
  }
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; why: string; lost?: boolean }

function lostAnswer(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status === 0 || err.status >= 500
}

/** Create a motivation. The hive decides who may (Jon Q6: a person their own; a team's owner or an admin a team's). */
export async function createMotivation(body: CreateMotivationBody): Promise<Outcome<Motivation>> {
  const live = bound()
  const client = live.client
  if (!client?.createMotivation) return { ok: false, why: 'This hive does not have motivations yet.' }
  try {
    const m = await client.createMotivation(body)
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    useHive.setState((s) => applyMotivation(s, m))
    return { ok: true, value: m }
  } catch (err) {
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    if (lostAnswer(err)) {
      void loadMotivations(true).catch(() => undefined)
      return { ok: false, why: 'We could not confirm whether it was made. The list has been read again: check it before trying again.', lost: true }
    }
    return { ok: false, why: refusalWords(err) }
  }
}

/** Edit what it says or its status, against the revision this person saw. */
export async function editMotivation(seen: Motivation, change: { title?: string; why?: string; status?: MotivationStatus }): Promise<Outcome<Motivation>> {
  const live = bound()
  const client = live.client
  if (!client?.patchMotivation) return { ok: false, why: 'This hive does not have motivations yet.' }
  try {
    const m = await client.patchMotivation(seen.id, { ...change, expected_rev: seen.rev })
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    useHive.setState((s) => applyMotivation(s, m))
    return { ok: true, value: m }
  } catch (err) {
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    void refreshMotivation(seen.id)
    if (lostAnswer(err)) return { ok: false, why: 'We could not confirm whether this happened. It has been read again: check it before trying again.', lost: true }
    return { ok: false, why: refusalWords(err) }
  }
}

/**
 * Save an edit draft against the motivation as it was when editing began (stand-in P1-2 on 61936cb): only the fields
 * the person changed are sent, with that revision. A change someone made meanwhile is refused (motivation_changed) and
 * read again, never overwritten.
 */
export function saveDraft(seen: Motivation, draft: { title: string; why: string }): Promise<Outcome<Motivation>> {
  const title = draft.title.trim()
  const change = { ...(title !== seen.title ? { title } : {}), ...(draft.why !== seen.why ? { why: draft.why } : {}) }
  if (!Object.keys(change).length) return Promise.resolve({ ok: true, value: seen })
  return editMotivation(seen, change)
}

/** Who can see it, against the revision this person saw (a stale choice never overrides a newer one). */
export async function setMotivationVisibility(seen: Motivation, visibility: Motivation['visibility'], sharedWith: string[] = []): Promise<Outcome<Motivation>> {
  const live = bound()
  const client = live.client
  if (!client?.setMotivationVisibility) return { ok: false, why: 'This hive does not have motivations yet.' }
  try {
    const m = await client.setMotivationVisibility(seen.id, { visibility, ...(visibility === 'shared' ? { shared_with: normalPeople(sharedWith) } : {}), expected_rev: seen.rev })
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    useHive.setState((s) => applyMotivation(s, m))
    return { ok: true, value: m }
  } catch (err) {
    if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
    void refreshMotivation(seen.id)
    if (lostAnswer(err)) return { ok: false, why: 'We could not confirm whether this happened. It has been read again: check it before trying again.', lost: true }
    return { ok: false, why: refusalWords(err) }
  }
}

/** Read one motivation again (after a refusal or a lost answer); a 404 drops it from this viewer's list. */
export async function refreshMotivation(id: string): Promise<Motivation | null> {
  const live = bound()
  const client = live.client
  if (!client?.getMotivation) return null
  const gen = beginRead()
  try {
    const m = await client.getMotivation(id)
    if (!live.ok()) return null
    // an answer from before a revocation landed is older than it: it neither restores the motivation nor clears the record
    const g = genState()
    const revokedAt = g.revoked.get(id)
    if (revokedAt !== undefined && revokedAt > gen) return null
    // nor does an answer from a read that began before the newest snapshot, which did not list it (stand-in P1-1 on b26a46a)
    if (g.listed && gen < g.motivations && !g.listed.has(id)) return null
    genState().revoked.delete(id)
    useHive.setState((s) => applyMotivation(s, m))
    return m
  } catch (err) {
    if (live.ok() && err instanceof ApiError && err.status === 404) {
      markRevoked(id, Math.max(gen, beginRead()))
      useHive.setState((s) => {
        const motivations = { ...s.motivations }
        delete motivations[id]
        return { motivations, taskLinks: Object.fromEntries(Object.entries(s.taskLinks).map(([g, refs]) => [g, refs.filter((r) => r.id !== id)])) }
      })
    }
    return null
  }
}

let opSeq = 0
/** A fresh operation id for one person's choice: a retry of the same choice sends the same id (idempotent on the hive). */
export const operationId = (): string => `ui.${Date.now().toString(36)}.${(++opSeq).toString(36)}.${Math.random().toString(36).slice(2, 8)}`

/**
 * Link or unlink tasks, as one operation on the hive (all or nothing). `cascade` takes each task's subtasks along.
 * After a lost answer the same operation id is sent once more: the hive answers a replay exactly as the first call.
 */
export async function changeLinks(seen: Motivation, op: 'link' | 'unlink', goalIds: string[], cascade: boolean): Promise<Outcome<MotivationLinkResult>> {
  const live = bound()
  const client = live.client
  if (!client?.linkMotivation) return { ok: false, why: 'This hive does not have motivations yet.' }
  const body = { operation_id: operationId(), op, goal_ids: goalIds, cascade, expected_to_rev: seen.rev }
  const apply = (r: MotivationLinkResult) => {
    useHive.setState((s) => {
      const st = applyMotivation(s, r.motivation)
      const ref = { id: r.motivation.id, title: r.motivation.title, status: r.motivation.status }
      const taskLinks = { ...st.taskLinks }
      for (const g of [...r.applied, ...r.unchanged]) {
        const rest = (taskLinks[g] ?? []).filter((x) => x.id !== ref.id)
        taskLinks[g] = op === 'link' ? [...rest, ref].sort((a, b) => a.id.localeCompare(b.id)) : rest
      }
      return { ...st, taskLinks, linksSeq: st.linksSeq + 1 }
    })
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await client.linkMotivation(seen.id, body)
      if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
      apply(r)
      return { ok: true, value: r }
    } catch (err) {
      if (!live.ok()) return { ok: false, why: 'The connection to the hive changed before it answered.', lost: true }
      if (lostAnswer(err) && attempt === 0) continue
      void refreshMotivation(seen.id)
      void loadTaskLinks(true).catch(() => undefined)
      if (lostAnswer(err)) return { ok: false, why: 'We could not confirm whether the links changed. They have been read again: check before trying again.', lost: true }
      return { ok: false, why: refusalWords(err) }
    }
  }
  return { ok: false, why: 'We could not confirm whether the links changed.', lost: true }
}

// ---------------------------------------------------------------- who owns it, who made it

export type OwnerKind = 'person' | 'team' | 'mind'
export const ownerKind = (owner: string): OwnerKind => (owner.startsWith('swarm:') ? 'team' : owner.startsWith('agent:') ? 'mind' : 'person')

/** Plain words for a principal: "you", a mind's or team's name, a person's name where known, else their id. */
export function principalName(p: string, ctx: { me?: Pick<Me, 'principal'> | null; agents: Record<string, Agent>; swarms: Record<string, Swarm>; people?: Record<string, string> }): string {
  if (ctx.me && p === ctx.me.principal) return 'you'
  if (p === 'user:operator') return 'the operator'
  if (p.startsWith('agent:')) return shown(ctx.agents[p.slice(6)]?.name) || 'a mind'
  if (p.startsWith('swarm:')) return shown(ctx.swarms[p.slice(6)]?.name) || 'a swarm'
  return ctx.people?.[p] || p.replace(/^user:/, '')
}

/** "Lyra's team", "Vega (a mind)", "Ada" / "you": who the motivation belongs to. */
export function ownerLine(m: Pick<Motivation, 'owner' | 'swarm_id'>, ctx: Parameters<typeof principalName>[1]): string {
  const kind = ownerKind(m.owner)
  const name = principalName(m.owner, ctx)
  if (kind === 'team') return `${name} (swarm)`
  if (kind === 'mind') return `${name} (a mind), in ${principalName(`swarm:${m.swarm_id ?? ''}`, ctx)}`
  if (!m.swarm_id) return name === 'you' ? 'you, across swarms' : `${name}, across swarms`
  return `${name}, in ${principalName(`swarm:${m.swarm_id}`, ctx)}`
}

/** Jon Q2: people see who created it, a person or a mind. */
export function creatorLine(m: Pick<Motivation, 'created_by'>, ctx: Parameters<typeof principalName>[1]): string {
  const who = principalName(m.created_by, ctx)
  return m.created_by.startsWith('agent:') ? `named by ${who}, a mind` : `created by ${who}`
}

export const VISIBILITY_WORDS: Record<Motivation['visibility'], { personal: string; team: string }> = {
  private: { personal: 'Only you', team: "Only the swarm's owner" },
  shared: { personal: 'You and the people you name', team: "The people named, and the swarm's owner" },
  public: { personal: 'Everyone who can see it', team: 'Everyone who can see the swarm' },
}

// ---------------------------------------------------------------- shared with named people (stand-in P2-3 on 57e64ca)

/** The three choices, in order: only the owner, the people named, everyone who can see it. */
export const VISIBILITY_CHOICES: readonly Visibility[] = ['private', 'shared', 'public']

/** Recipients as the hive keeps them (hive/core/visibility.py `clean`: `user:` principals, unique, sorted), so what is
 *  sent is exactly what is read back. */
export function normalPeople(people: readonly string[]): string[] {
  return [...new Set(people.map((p) => p.trim()).filter((p) => p.startsWith('user:') && p.length <= 80))].sort()
}

/** Why a visibility choice cannot be saved yet, or null: shared needs at least one person named. */
export function visibilityProblem(visibility: Visibility, people: readonly string[]): string | null {
  return visibility === 'shared' && !normalPeople(people).length ? 'Name at least one person to share it with.' : null
}

/** The create body for the form (POST /api/motivations `{title, why?, owner?, swarm_id?, visibility?, shared_with?}`).
 *  `whose`: 'me' (mine, across teams), 'me:<swarm>' (mine, in one team) or 'team:<swarm>'. Shared stays shared. */
export function createBody(form: { title: string; why: string; whose: string; visibility: Visibility; sharedWith?: readonly string[] }): CreateMotivationBody {
  const [kind, sid] = form.whose.split(':')
  const scope = kind === 'team' ? { owner: `swarm:${sid}`, swarm_id: sid } : sid ? { swarm_id: sid } : {}
  return { title: form.title.trim(), why: form.why.trim(), ...scope, visibility: form.visibility, ...(form.visibility === 'shared' ? { shared_with: normalPeople(form.sharedWith ?? []) } : {}) }
}

// ---------------------------------------------------------------- counts from a partial read (stand-in P2-4 on 57e64ca)

/** Said beside any count made from a read the hive did not finish. */
export const PARTIAL_WORDS = 'may be short: the hive did not finish listing everything'

/** True while either read stopped at the paging guard: every count of tasks under motivations may be short. */
export const countsPartial = (s: { motivationsPartial: boolean; taskLinksPartial: boolean }): boolean => s.motivationsPartial || s.taskLinksPartial
export function useCountsPartial(): boolean {
  return useHive(countsPartial)
}

/** A count, marked as a floor when the read behind it was partial ("3+"). */
export const atLeast = (n: number, partial: boolean): string => (partial ? `${n}+` : String(n))

// ---------------------------------------------------------------- who may create (Jon Q6)

export interface CreateRights {
  /** A person may have their own; the hive password (the operator) is not a person. */
  personal: { may: boolean; why?: string }
  /** Teams this person may make a team motivation for: admins any open team; otherwise teams they own. */
  teams: Swarm[]
}
export function createRights(me: Me | undefined, swarms: Record<string, Swarm>): CreateRights {
  const admin = !!me && (me.kind === 'password' || me.role === 'admin')
  const open = Object.values(swarms).filter((s) => !s.archived_at)
  const personal = !me
    ? { may: false, why: 'Sign in to have your own motivations.' }
    : me.principal === 'user:operator'
      ? { may: false, why: 'The hive password is not a person. Sign in to have your own motivations; swarm motivations work from here.' }
      : { may: true }
  return { personal, teams: me ? open.filter((s) => admin || (s.owner && s.owner === me.principal)).sort((a, b) => a.name.localeCompare(b.name)) : [] }
}

// ---------------------------------------------------------------- progress, counted once

export interface Progress {
  total: number
  open: number
  working: number
  review: number
  done: number
  failed: number
  cancelled: number
  /** done / (tasks − cancelled), so failures show (design §6.1); null with nothing to count. */
  ratio: number | null
}
/** Progress over a set of task ids (each counted once however many motivations it serves), by each task's live status. */
export function progressOf(ids: Iterable<string>, goals: Record<string, Pick<Goal, 'status'>>, fallback: Record<string, Pick<Goal, 'status'>> = {}): Progress {
  const p: Progress = { total: 0, open: 0, working: 0, review: 0, done: 0, failed: 0, cancelled: 0, ratio: null }
  for (const id of new Set(ids)) {
    const st = (goals[id] ?? fallback[id])?.status
    if (!st) continue
    p.total++
    if (st === 'open' || st === 'stalled') p.open++
    else if (st === 'claimed' || st === 'waiting') p.working++
    else if (st === 'submitted') p.review++
    else if (st === 'done') p.done++
    else if (st === 'failed') p.failed++
    else if (st === 'cancelled') p.cancelled++
  }
  const base = p.total - p.cancelled
  p.ratio = base > 0 ? p.done / base : null
  return p
}

/** Task ids under one motivation, from the readable links this viewer holds. */
export function tasksOf(motivationId: string, links: Record<string, { id: string }[]>): string[] {
  return Object.entries(links)
    .filter(([, refs]) => refs.some((r) => r.id === motivationId))
    .map(([g]) => g)
}

/** Sorted for reading: active first, then paused, achieved, retired; newest first within each. */
export function sortMotivations(list: Motivation[]): Motivation[] {
  return [...list].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.created_at.localeCompare(a.created_at))
}

// radio groups live in lib/radio.ts (no store), re-exported here for the pages that already import them
export { nextRadio, radioProps } from './radio'
